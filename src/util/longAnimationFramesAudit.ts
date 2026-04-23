/**
 * Long Animation Frames API diagnostic — opt-in via `?perf=audit` URL param.
 *
 * Replaces the older `longtask` PerformanceObserver entries (>50 ms-ish task
 * threshold, no source attribution) with the newer `long-animation-frame`
 * entries (frame-aligned, with script-level attribution: which file, which
 * function, how long blocked the rendering pipeline, how long blocked input).
 *
 * Off by default — instrumentation cost is small but the console noise during
 * preload would drown out actual error logs. Enable from a Vibe Jam audit
 * session via `?perf=audit` and watch DevTools Console for the per-LoAF rows.
 *
 * Citations:
 *  - https://web.dev/articles/long-animation-frames
 *  - https://developer.mozilla.org/docs/Web/API/PerformanceLongAnimationFrameTiming
 *
 * @see docs/SESSION_2026_04_21_PRELOAD_ROUND_4.md (research Tier 2 net-new since 2024)
 */

interface LoAFScriptAttribution {
  invoker?: string;
  invokerType?: string;
  sourceURL?: string;
  sourceFunctionName?: string;
  sourceCharPosition?: number;
  duration?: number;
  startTime?: number;
}
interface LongAnimationFrameTimingLike extends PerformanceEntry {
  renderStart: number;
  styleAndLayoutStart: number;
  blockingDuration: number;
  scripts: LoAFScriptAttribution[];
}

let installed = false;

/**
 * Wire a `PerformanceObserver` for `long-animation-frame` entries. Idempotent.
 * No-op if the URL doesn't carry `?perf=audit` or if the API isn't supported.
 *
 * The observer logs each LoAF entry with: total duration, blocking duration,
 * rendering duration, and the top-3 contributing scripts (file + function +
 * char position). All readable in DevTools Console without any DevTools-side
 * setup — useful for screen-share triage with a remote tester.
 */
export function installLongAnimationFramesAuditIfRequested(): void {
  if (installed) return;
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return;
  /* Gate on URL param so the audit overhead never lands in production traffic.
   * Use the same `?perf=audit` convention as the existing graphics-tier
   * override in `graphicsTier.ts` (`?perf=low | high`). */
  let optedIn = false;
  try {
    const p = new URLSearchParams(window.location.search).get('perf');
    optedIn = p === 'audit';
  } catch {
    return;
  }
  if (!optedIn) return;

  /* Feature-detect via the static `supportedEntryTypes` list. Older browsers
   * (incl. Safari pre-17) don't have `long-animation-frame` and would throw
   * inside `observe()` with `entryTypes`. */
  const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes ?? [];
  if (!supported.includes('long-animation-frame')) {
    console.info('[idle-craft][perf:audit] Long Animation Frames API unavailable in this browser');
    return;
  }

  installed = true;

  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const loaf = entry as LongAnimationFrameTimingLike;
        const renderMs = loaf.renderStart > 0 ? loaf.duration - (loaf.renderStart - loaf.startTime) : 0;
        const topScripts = (loaf.scripts ?? [])
          .slice()
          .sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))
          .slice(0, 3)
          .map((s) => `${(s.duration ?? 0).toFixed(1)}ms ${s.sourceFunctionName || s.invoker || '<anon>'} @ ${s.sourceURL || '?'}:${s.sourceCharPosition ?? '?'}`);
        console.warn(
          `[idle-craft][perf:audit] LoAF ${loaf.duration.toFixed(1)}ms (block ${loaf.blockingDuration.toFixed(1)}ms, render ${renderMs.toFixed(1)}ms) @ ${loaf.startTime.toFixed(0)}ms`,
          topScripts.length ? '\n  ' + topScripts.join('\n  ') : '',
        );
      }
    });
    observer.observe({ type: 'long-animation-frame', buffered: true });
    console.info('[idle-craft][perf:audit] Long Animation Frames observer installed (entries logged via console.warn during preload)');
  } catch (err) {
    console.warn('[idle-craft][perf:audit] LoAF observer install failed:', err);
  }
}

/* =============================================================================
 * Named-block measurement scaffold (round 5 phase A)
 *
 * Wrap candidate sync/async blocks with `measureBlock` / `measureBlockAsync` to
 * collect millisecond cost into the `performance.measure()` buffer. When
 * `?perf=audit` is set, `dumpRound5Measures()` (called near the end of
 * `bootIntroExperience`) tabulates the matching entries to the console.
 *
 * The measures are collected unconditionally so production traces (e.g.
 * Chrome DevTools Performance recording) also pick them up, but only get
 * console-tabulated under the audit flag.
 * ============================================================================= */

/** Prefix used for every measure name created by this module. Consumers should
 * pass the suffix only (e.g. `'forest.bakeGround'`); we add the prefix so the
 * dumper can filter cleanly without matching unrelated UA-emitted measures. */
const MEASURE_PREFIX = 'idle-craft:';

function isPerformanceAvailable(): boolean {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function' && typeof performance.measure === 'function';
}

export function measureBlock<T>(name: string, fn: () => T): T {
  if (!isPerformanceAvailable()) return fn();
  const measureName = `${MEASURE_PREFIX}${name}`;
  const startMark = `${measureName}::start`;
  performance.mark(startMark);
  try {
    return fn();
  } finally {
    try {
      performance.measure(measureName, startMark);
    } catch {
      /* swallow — measures are diagnostic, must never break production */
    }
    try {
      performance.clearMarks(startMark);
    } catch {
      /* idem */
    }
  }
}

export async function measureBlockAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (!isPerformanceAvailable()) return fn();
  const measureName = `${MEASURE_PREFIX}${name}`;
  const startMark = `${measureName}::start`;
  performance.mark(startMark);
  try {
    return await fn();
  } finally {
    try {
      performance.measure(measureName, startMark);
    } catch {
      /* swallow */
    }
    try {
      performance.clearMarks(startMark);
    } catch {
      /* idem */
    }
  }
}

/**
 * Console-tabulate every `idle-craft:*` measure collected so far, in start-time
 * order. No-op unless `?perf=audit` is set.
 *
 * Call near the end of `bootIntroExperience` (after the staged forest preload
 * resolves) to capture the round-5 candidate blocks in one place.
 */
export function dumpRound5Measures(): void {
  if (typeof window === 'undefined' || typeof performance === 'undefined') return;
  let optedIn = false;
  try {
    optedIn = new URLSearchParams(window.location.search).get('perf') === 'audit';
  } catch {
    return;
  }
  if (!optedIn) return;
  let entries: PerformanceEntryList = [];
  try {
    entries = performance.getEntriesByType('measure');
  } catch {
    return;
  }
  const rows = entries
    .filter((e) => e.name.startsWith(MEASURE_PREFIX))
    .sort((a, b) => a.startTime - b.startTime)
    .map((e) => ({
      block: e.name.slice(MEASURE_PREFIX.length),
      'duration_ms': Number(e.duration.toFixed(1)),
      'startTime_ms': Number(e.startTime.toFixed(0)),
    }));
  if (rows.length === 0) {
    console.info('[idle-craft][perf:audit] no round-5 named-block measures captured yet');
    return;
  }
  console.info('[idle-craft][perf:audit] round-5 named-block measures (sorted by startTime):');
  /* Use console.table for a readable matrix; console.info as the surrounding
   * label so a single scroll-back finds both. */
  console.table(rows);
}
