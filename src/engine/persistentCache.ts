/**
 * Service worker registration + persistent storage grant.
 *
 * **Why:** Vibe Jam judging is refresh-heavy. The SW (built by `vite-plugin-pwa`,
 * configured in `vite.config.ts`) precaches the hashed JS/CSS/HTML/font asset
 * shell + runtime-caches the cutscenes + music. Combined with
 * `Cache-Control: ... immutable` on `/assets/*` (set by `netlify.toml`), every
 * revisit becomes a network-free start (only gated by SW boot + JS parse).
 *
 * Without `navigator.storage.persist()` the runtime cache is first in line for
 * eviction when the browser feels storage pressure (Chrome evicts LRU per
 * origin) — a judge who plays one other PWA between visits could lose our
 * 30 MB of cutscenes. With it, IndexedDB + Cache API are exempt from
 * automatic eviction.
 *
 * **Why not register from `index.html`?** Two reasons: (1) SW install grabs
 * compute that competes with cutscene `<video>` decode + `dockPreload` chunk
 * parse during the curse-cutscene window — visible as a 100-300ms hitch in
 * the cutscene's first second; (2) `navigator.storage.persist()` shows a
 * permission prompt on Firefox if called before the user has interacted with
 * the page. Showing it during cutscene 1 looks like a virus warning to a
 * judge. Both are fixed by deferring to the existing `requestIdleCallback`
 * slot in `main.ts`'s `deferredBootSecondaries`.
 *
 * @see docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md
 */

/// <reference types="vite-plugin-pwa/client" />

/* `vite-plugin-pwa` exposes a typed virtual module that wraps the underlying
 * `navigator.serviceWorker.register` call, handles `autoUpdate` semantics, and
 * resolves the `ServiceWorkerRegistration` once it's ready. The module is
 * generated at build time + dev-mode-mocked when `devOptions.enabled` is false.
 */
import { registerSW } from 'virtual:pwa-register';

let swRegistrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

/**
 * Register the IDLE-CRAFT service worker. Idempotent — second call returns the
 * cached promise from the first. Resolves with `null` if the browser doesn't
 * support service workers, if registration fails, or if the SW virtual module
 * is unavailable (dev mode without `devOptions.enabled`).
 *
 * Should be called from a `requestIdleCallback` slot or equivalent post-paint
 * hook — never during HTML parse or cutscene playback.
 */
export function registerIdleCraftServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (swRegistrationPromise) return swRegistrationPromise;
  swRegistrationPromise = (async () => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      return null;
    }
    try {
      /* `registerSW` from vite-plugin-pwa returns an `updateSW(reload?)` function,
       * NOT the registration directly. The `onRegisteredSW` callback is what
       * fires with the live registration once the browser activates the worker. */
      const registrationReady = new Promise<ServiceWorkerRegistration | null>((resolve) => {
        try {
          registerSW({
            immediate: true,
            onRegisteredSW(_swUrl, registration) {
              resolve(registration ?? null);
            },
            onRegisterError(err) {
              console.warn('[idle-craft] SW registration failed:', err);
              resolve(null);
            },
          });
        } catch (err) {
          console.warn('[idle-craft] SW register threw:', err);
          resolve(null);
        }
      });
      /* If the registration callback never fires (e.g. another SW is in
       * control + ours is queued), don't hang forever — the persist grant
       * downstream still happens, just without the SW-readiness signal. */
      const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 5000));
      return await Promise.race([registrationReady, timeout]);
    } catch (err) {
      console.warn('[idle-craft] SW registration threw:', err);
      return null;
    }
  })();
  return swRegistrationPromise;
}

let persistRequestPromise: Promise<boolean> | null = null;

/**
 * Request persistent storage AFTER the SW has activated + the runtime caches
 * exist. Idempotent — second call returns cached promise.
 *
 * **Quota guard:** if `navigator.storage.estimate()` reports `quota - usage <
 * 200 MB`, skip the persist request entirely. The user is on a low-storage
 * device (typically iPhone with full Photos library) and asking for
 * persistence would only confirm an eviction we can't prevent. The cutscene
 * runtime cache may itself fail to populate (the SW install does not fail);
 * judges on those devices get the network-fetch path on every visit.
 *
 * **Browser behavior:**
 *  - Chrome/Edge: grants automatically without a prompt for sites the user
 *    has interacted with (the rIC slot guarantees first-paint + at least one
 *    tick, which counts as interaction).
 *  - Safari 15.2+: grants automatically.
 *  - Firefox: shows a one-time permission prompt. Bounded acceptable cost.
 *
 * Returns `true` if persistence was granted (or already was), `false`
 * otherwise. The return value is informational only — callers don't gate
 * behavior on it.
 */
export function requestPersistentStorageOnceSWReady(): Promise<boolean> {
  if (persistRequestPromise) return persistRequestPromise;
  persistRequestPromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.storage) {
      return false;
    }
    try {
      /* Don't fire the persist request until the SW is registered — otherwise
       * the grant applies to a CacheStorage that has nothing of value yet. The
       * SW registration timeout (5s) bounds the wait. */
      await registerIdleCraftServiceWorker().catch(() => null);

      /* If already persisted from a prior visit, no-op. The `persisted()` query
       * is cheap and avoids re-prompting on Firefox. */
      if (typeof navigator.storage.persisted === 'function') {
        const already = await navigator.storage.persisted().catch(() => false);
        if (already) return true;
      }

      /* Quota guard. If we'd be requesting persistence for a cache we can't
       * fill (low headroom), skip — the persist grant is irrelevant. The
       * 200 MB threshold is generous: the full cutscene + audio runtime cache
       * is ~62 MB, app shell + JS chunks are ~5 MB, leaving 130+ MB headroom
       * for other PWA storage. Anything below 200 MB total free means the
       * device is genuinely under storage pressure. */
      if (typeof navigator.storage.estimate === 'function') {
        try {
          const { quota = 0, usage = 0 } = await navigator.storage.estimate();
          const headroom = quota - usage;
          if (quota > 0 && headroom < 200 * 1024 * 1024) {
            console.info(
              `[idle-craft] storage quota tight (${(headroom / 1024 / 1024).toFixed(1)} MB free of ${(quota / 1024 / 1024).toFixed(1)} MB) — skipping persist request`,
            );
            return false;
          }
        } catch {
          /* `estimate()` failed — fall through to attempt persist anyway. */
        }
      }

      if (typeof navigator.storage.persist === 'function') {
        const granted = await navigator.storage.persist().catch(() => false);
        if (granted) {
          console.info('[idle-craft] persistent storage granted — cache survives quota pressure');
        }
        return granted;
      }
      return false;
    } catch (err) {
      console.warn('[idle-craft] persist request threw:', err);
      return false;
    }
  })();
  return persistRequestPromise;
}
