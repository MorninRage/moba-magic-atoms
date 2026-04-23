/**
 * Break up long main-thread work so the first paint, input, and WebGL can interleave
 * with audio decode / RMS passes (reduces "double hitch" when those stack).
 */
export function yieldAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Sub-millisecond yield to the event loop — drains pending input + paint tasks
 * without waiting an entire animation frame (~16 ms).
 *
 * Use this when chaining many small-to-medium phases where `yieldAnimationFrame`
 * would add per-phase 16 ms latency. Use {@link yieldAnimationFrame} when the
 * caller specifically needs frame alignment (e.g. before / after a render).
 *
 * Implementation:
 *   - Prefers `scheduler.yield()` (Chromium 129+, native task-yielding API that
 *     guarantees the continuation runs as a fresh task at the same priority,
 *     letting input + paint drain in between).
 *   - Falls back to `MessageChannel` postMessage which posts a microtask-adjacent
 *     macrotask — drains pending tasks in ~1 ms and is faster than `setTimeout(0)`
 *     which is clamped to 4 ms after a few nested calls.
 *   - `setTimeout(0)` final fallback for environments without `MessageChannel`
 *     (effectively never — every modern browser has it).
 */
const _yieldChannel: MessageChannel | null =
  typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
const _yieldQueue: (() => void)[] = [];
if (_yieldChannel) {
  _yieldChannel.port1.onmessage = () => {
    const cb = _yieldQueue.shift();
    if (cb) cb();
  };
}

export function yieldToEventLoop(): Promise<void> {
  /* Native scheduler.yield where available — guaranteed input/paint drain. */
  const sched = (
    globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }
  ).scheduler;
  if (sched && typeof sched.yield === 'function') {
    return sched.yield();
  }
  if (_yieldChannel) {
    return new Promise<void>((resolve) => {
      _yieldQueue.push(resolve);
      _yieldChannel.port2.postMessage(null);
    });
  }
  return new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

/**
 * Run `perItem` over each element of `items`, yielding to the event loop whenever
 * the per-chunk wall-clock budget (default 16 ms — one paint frame at 60 Hz) is
 * exhausted. Frame-spread upload pattern — keeps individual main-thread tasks
 * short enough that input + paint can interleave with scene-build work.
 *
 * Use for hot inner loops that exceed ~16 ms when run in one shot:
 *   - Scattering thousands of foliage instances onto a heightfield
 *   - Baking vertex colors / tangents over a dense terrain mesh
 *   - Writing many `setMatrixAt` slots on an `InstancedMesh` / `BatchedMesh`
 *
 * The yield uses {@link yieldToEventLoop} (scheduler.yield → MessageChannel →
 * setTimeout(0) cascade) so each "chunk break" is sub-millisecond — the goal
 * is to hand a paint frame back to the browser, not to wait for the next rAF.
 *
 * **2026-04-22 budget bump (8 → 16 ms):** the original 8 ms budget was tuned
 * to keep cutscene video decode happy (8 ms = half the 60 Hz paint budget,
 * leaves room for video frame decode + paint). With cutscenes removed, 16 ms
 * is the right target — one full paint frame between yields, so the browser
 * gets to paint exactly once per chunk instead of leaving fractional budget
 * on the floor. Halves the yield count and the `performance.now()` polling
 * overhead inside the hot loop.
 *
 * Round 5 prior-art: see `docs/SESSION_2026_04_21_PRELOAD_ROUND_5.md` (#8).
 */
export async function chunkedYieldingLoop<T>(
  items: ReadonlyArray<T>,
  perItem: (item: T, index: number) => void,
  opts?: { chunkBudgetMs?: number; label?: string },
): Promise<void> {
  const budget = opts?.chunkBudgetMs ?? 16;
  const len = items.length;
  if (len === 0) return;
  let chunkStart = performance.now();
  for (let i = 0; i < len; i++) {
    perItem(items[i], i);
    if (performance.now() - chunkStart >= budget) {
      await yieldToEventLoop();
      chunkStart = performance.now();
    }
  }
}

/**
 * Index-only variant of {@link chunkedYieldingLoop}: avoids constructing an
 * intermediate `items` array when the caller already iterates by integer index
 * (very common for `setMatrixAt`, vertex bakes, etc.).
 */
export async function chunkedYieldingRange(
  count: number,
  perIndex: (index: number) => void,
  opts?: { chunkBudgetMs?: number; label?: string },
): Promise<void> {
  const budget = opts?.chunkBudgetMs ?? 16;
  if (count <= 0) return;
  let chunkStart = performance.now();
  for (let i = 0; i < count; i++) {
    perIndex(i);
    if (performance.now() - chunkStart >= budget) {
      await yieldToEventLoop();
      chunkStart = performance.now();
    }
  }
}

/**
 * Run an array of async tasks with a maximum concurrency cap. Used to tame
 * boot-time parse-storms (e.g. a 7-way dynamic-import `Promise.all` that
 * floods the main thread with parse work). Preserves output order.
 *
 * The Babylon.js / Unity LZ4 lesson: never let the boot path issue bulk-
 * parallel asset requests; cap concurrency and prefer fast-decompress
 * formats. See `docs/SESSION_2026_04_21_PRELOAD_ROUND_5.md` (#5).
 */
export async function withConcurrencyLimit<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  if (tasks.length === 0) return results;
  const effectiveLimit = Math.max(1, Math.min(limit, tasks.length));
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < effectiveLimit; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = next++;
          if (i >= tasks.length) return;
          results[i] = await tasks[i]();
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/**
 * Tagged scheduler: prefer `scheduler.postTask({ priority })` (Chrome 94+,
 * Firefox 142+; no Safari) over `requestIdleCallback` / `setTimeout` so the
 * browser orders work correctly under load.
 *
 * Fallbacks:
 *   - `background` priority → `requestIdleCallback` with 1500 ms timeout
 *     (matches the existing rIC convention in `main.ts` boot).
 *   - `user-blocking` → `setTimeout(0)` so it lands on the next macrotask
 *     boundary without rIC throttling.
 *   - `user-visible` → `setTimeout(50)` mid-priority compromise.
 *
 * Round 5 prior-art: see `docs/SESSION_2026_04_21_PRELOAD_ROUND_5.md` (#7).
 */
export type PostTaskPriority = 'user-blocking' | 'user-visible' | 'background';

interface SchedulerPostTaskOptions {
  priority: PostTaskPriority;
  signal?: AbortSignal;
}

interface SchedulerWithPostTask {
  postTask?: (cb: () => void, opts: SchedulerPostTaskOptions) => unknown;
}

/**
 * Cancellable handle returned by {@link schedulePostTaskCancellable}.
 * Calling `.cancel()` aborts the pending task across all backend paths
 * (`scheduler.postTask` AbortController / `cancelIdleCallback` / `clearTimeout`).
 * Idempotent — second + later calls are no-ops.
 */
export interface CancellablePostTask {
  cancel(): void;
}

export function schedulePostTask(fn: () => void, priority: PostTaskPriority): void {
  const s = (globalThis as { scheduler?: SchedulerWithPostTask }).scheduler;
  if (s?.postTask) {
    try {
      s.postTask(fn, { priority });
      return;
    } catch {
      /* fall through to legacy fallbacks */
    }
  }
  if (priority === 'background' && typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: 1500 });
    return;
  }
  if (priority === 'user-blocking') {
    globalThis.setTimeout(fn, 0);
    return;
  }
  globalThis.setTimeout(fn, 50);
}

/**
 * Cancellable variant of {@link schedulePostTask}. Use when the caller may
 * need to abort the pending work (e.g. teardown / cleanup of a render loop
 * before the rIC slot fires). Returns a handle whose `.cancel()` works
 * across all backend paths.
 */
export function schedulePostTaskCancellable(
  fn: () => void,
  priority: PostTaskPriority,
): CancellablePostTask {
  const s = (globalThis as { scheduler?: SchedulerWithPostTask }).scheduler;
  if (s?.postTask && typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    let cancelled = false;
    try {
      s.postTask(
        () => {
          if (!cancelled) fn();
        },
        { priority, signal: controller.signal },
      );
      return {
        cancel(): void {
          if (cancelled) return;
          cancelled = true;
          try {
            controller.abort();
          } catch {
            /* ignore */
          }
        },
      };
    } catch {
      /* fall through to legacy fallbacks */
    }
  }
  if (priority === 'background' && typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(fn, { timeout: 1500 });
    return {
      cancel(): void {
        if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle);
      },
    };
  }
  const timeoutHandle = globalThis.setTimeout(fn, priority === 'user-blocking' ? 0 : 50);
  return {
    cancel(): void {
      globalThis.clearTimeout(timeoutHandle);
    },
  };
}
