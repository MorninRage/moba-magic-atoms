/**
 * Wrap a DOM swap in `document.startViewTransition()` for a snapshot-then-animate
 * cross-fade. Falls back to executing the swap immediately on browsers without
 * the API (Firefox <144 lacks the type — Level 2 still pending).
 *
 * **Browser support (2026-04):** Baseline newly available since Oct 14 2025
 * (Chrome, Edge, Safari, Firefox 144+). The fallback path is exercised on
 * older Firefox + outdated Chromium.
 *
 * **Perceived-latency win, not actual:** Chrome's case-studies post is explicit
 * — the API masks the swap latency by animating across snapshots, it does not
 * reduce the underlying work. For our cutscene→title and splash→cutscene
 * crossings the user feels a 200 ms fade as faster than a 50 ms hard cut.
 *
 * **Returns a Promise that resolves AFTER the update callback has run.**
 * The View Transitions API invokes the update callback ASYNCHRONOUSLY (after
 * the old snapshot is captured), so callers MUST `await` this if any
 * following code touches the same DOM region — otherwise the followup
 * mutations land BEFORE the swap and the swap then wipes them. Resolves
 * immediately on the no-API fallback path (the swap ran synchronously).
 *
 * **WebGL canvas snapshot caveat:** When the OUTGOING DOM contains a
 * fullscreen WebGL canvas, the snapshot captures the rendered frame at
 * swap-time and freezes it for the transition duration (~200 ms). Caller is
 * responsible for either (a) disposing the canvas before the swap, or (b)
 * skipping `withViewTransition` for canvas-heavy crossings. See
 * `mountApp.ts` `renderPage` which already skips this API in realm-awakened
 * mode for exactly this reason.
 *
 * Round 5 prior-art: see `docs/SESSION_2026_04_21_PRELOAD_ROUND_5.md` (#1).
 */

/* TS DOM lib (5.x+) types `Document.startViewTransition` as REQUIRED, but the
 * runtime presence is optional (Firefox <144 lacks it). Cast to a permissive
 * shape for the feature-detect; this matches the convention used elsewhere
 * in the repo for partially-supported DOM APIs. */
type DocumentMaybeViewTransition = Document & {
  startViewTransition?: Document['startViewTransition'];
};

export function withViewTransition(swap: () => void): Promise<void> {
  if (typeof document === 'undefined') {
    swap();
    return Promise.resolve();
  }
  const start = (document as DocumentMaybeViewTransition).startViewTransition;
  if (typeof start !== 'function') {
    swap();
    return Promise.resolve();
  }
  try {
    const transition = start.call(document, swap);
    /* Swallow `finished` rejection so an aborted transition (e.g. a second
     * startViewTransition() lands before this one settles) doesn't surface
     * as an unhandled-rejection warning. */
    transition.finished?.catch(() => {});
    /* Return the promise that resolves when the update callback has run.
     * Callers await this so any following code sees the post-swap DOM
     * state. If `updateCallbackDone` is missing (older browsers exposing
     * `startViewTransition` without Level-2 promises), fall back to
     * `ready`, then to a resolved promise. */
    const done: Promise<unknown> | undefined =
      transition.updateCallbackDone ?? transition.ready;
    return done ? done.then(() => undefined).catch(() => undefined) : Promise.resolve();
  } catch {
    /* Defensive — a stray DOMException (e.g. doc not active yet) must not
     * leave the UI in a half-swapped state. Run the swap synchronously. */
    swap();
    return Promise.resolve();
  }
}
