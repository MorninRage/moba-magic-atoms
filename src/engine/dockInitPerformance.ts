/**
 * Performance marks/measures for dock WebGL bootstrap (CharacterScenePreview, lobby stage).
 * Enable verbose logging: URL `?debugPerf=dock` or `localStorage.setItem('idleCraft.debugPerf', 'dock')`.
 */

const PREFIX = 'idlecraft-dock';

export function isDockPerfDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('debugPerf') === 'dock') return true;
    if (localStorage.getItem('idleCraft.debugPerf') === 'dock') return true;
  } catch {
    /* ignore */
  }
  return false;
}

function perfOk(): boolean {
  return typeof performance !== 'undefined' && typeof performance.mark === 'function';
}

/** Start a named phase (pairs with {@link dockPerfEnd}). */
export function dockPerfBegin(phase: string): void {
  if (!perfOk()) return;
  try {
    performance.mark(`${PREFIX}:${phase}:begin`);
  } catch {
    /* ignore */
  }
}

/** End phase, record a PerformanceMeasure, optional debug log. */
export function dockPerfEnd(phase: string): void {
  if (!perfOk()) return;
  const b = `${PREFIX}:${phase}:begin`;
  const e = `${PREFIX}:${phase}:end`;
  const name = `${PREFIX}:${phase}`;
  try {
    performance.mark(e);
    performance.measure(name, b, e);
  } catch {
    /* ignore */
  }
  if (isDockPerfDebugEnabled()) {
    const entries = performance.getEntriesByName(name, 'measure');
    const last = entries[entries.length - 1];
    if (last) console.debug(`[idleCraft dock] ${phase}: ${last.duration.toFixed(1)}ms`);
  }
}

/** Single mark (e.g. timeline alignment in DevTools Performance panel). */
export function dockPerfMark(label: string): void {
  if (!perfOk()) return;
  try {
    performance.mark(`${PREFIX}:${label}`);
  } catch {
    /* ignore */
  }
}

/**
 * Dump every recorded `idlecraft-dock:*` measure to the console as a sortable table.
 * Call from DevTools console: `window.__idleCraftPerf?.()`. Always available (small
 * cost — just a global function), but only useful for diagnosing preload timing.
 *
 * Output columns: `phase` (the name passed to `dockPerfBegin/End`) and `duration_ms`
 * (the most recent recorded measure for that phase, rounded to 1 decimal).
 */
function dumpDockPerf(): void {
  if (!perfOk()) {
    console.log('[idleCraft dock perf] performance API unavailable');
    return;
  }
  const entries = performance.getEntriesByType('measure') as PerformanceMeasure[];
  const rows = entries
    .filter((e) => e.name.startsWith(`${PREFIX}:`))
    .map((e) => ({ phase: e.name.slice(PREFIX.length + 1), duration_ms: Number(e.duration.toFixed(1)) }))
    .sort((a, b) => b.duration_ms - a.duration_ms);
  if (rows.length === 0) {
    console.log('[idleCraft dock perf] no measures recorded yet');
    return;
  }
  console.table(rows);
}

if (typeof window !== 'undefined') {
  /* Globally exposed so any console session can call it without imports. */
  (window as unknown as { __idleCraftPerf?: () => void }).__idleCraftPerf = dumpDockPerf;
}
