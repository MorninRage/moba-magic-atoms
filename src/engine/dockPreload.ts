/**
 * Boot-time **dock preload** — single-pass pipeline that builds EVERYTHING the game
 * needs from a fresh scene during the title screen, then hands it off to mountApp
 * in one consume call. Eliminates the previous race-prone "base preload → chained
 * extended preload" split (see 2026-04-20 LEARNINGS for the bug surface area that
 * design produced).
 *
 * **What runs here, in phase order:**
 *
 *   1. `CharacterScenePreview.create` — WebGL context + project JSON + procedural
 *      forest backdrop + LPCA avatar + post-stack + GPU warm. The "scene foundation."
 *   2. Gameplay attach (`dockExtendedPreload.ts`) — collisionWorld, dock forest,
 *      harvest, cabin + warm, craft stations, mob shader warm, projectiles + warm,
 *      defensive ward, bouncy mushrooms + warm.
 *
 * **Why one pipeline?** The previous two-stage design had base preload + chained
 * extended preload as separate state machines with separate `.then` chains. Player
 * could click Begin between them, mountApp's adoption check would see one stage
 * "ready" but the other "idle" or in-flight, and end up building duplicate handles
 * inline (visible to the player as ghost meshes that you could walk through).
 * The fix here: one promise, one state machine, one consume.
 *
 * Non-goals: this module does not load audio, HUD, or tutorial — those are cheap
 * and belong to {@link ../ui/mountApp}. It only handles the expensive scene work.
 */

import { CharacterScenePreview } from '../visual/characterScenePreview';
import { CharacterSceneHost } from '../visual/characterSceneHost';
import { routeWorkerAudioSfx } from '../audio/workerAudioRouter';
import type { DockExtendedPreloadHandles } from './dockExtendedPreload';
import type { GameStore } from '../core/gameStore';
import { fetchEmpireProject } from './fetchEmpireProject';
import { resolveGraphicsTier, type GraphicsTier } from './graphicsTier';
import { isWorkerDockPreviewEnabled } from '../worker/capabilityGate';

/** Dock viewport implemented either on the main thread (legacy) or via worker GL (opt-in). */
export type CharacterDockPreview = CharacterScenePreview | CharacterSceneHost;

function mapLegacyGraphicsTierForWorker(
  t: GraphicsTier,
): 'low' | 'perf' | 'balanced' | 'cinematic' {
  return t === 'low' ? 'low' : 'balanced';
}

/** What `consumeIdleCraftDockPreload` returns to mountApp — the full bundle. */
export interface IdleCraftDockBundle {
  preview: CharacterDockPreview;
  /** All save-independent gameplay handles attached to `preview.scene` during
   *  preload. May be `null` if the extended-attach phase failed (rare); mountApp
   *  falls back to its inline ensure* path then. */
  gameplayHandles: DockExtendedPreloadHandles | null;
}

type PreloadState =
  | { status: 'idle' }
  | { status: 'pending'; promise: Promise<IdleCraftDockBundle>; offscreen: HTMLElement }
  | {
      status: 'ready';
      bundle: IdleCraftDockBundle;
      offscreen: HTMLElement;
      /** Legacy (`worker=0`): gameplay attach still in flight — {@link consumeIdleCraftDockPreload} awaits this before reparent. */
      legacyGameplayAttachPromise?: Promise<DockExtendedPreloadHandles | null>;
    }
  | { status: 'failed'; error: unknown };

/**
 * After `consume`, state returns to `idle` — the preview + handles are now owned
 * by whoever consumed it (usually {@link ../ui/mountApp}) and their lifecycle
 * follows the game shell (disposed on return-to-title via
 * `disposeIdleCraftDockScene`). Keeping the preload state 'consumed' would risk
 * returning a disposed preview on the next preload attempt.
 */
let state: PreloadState = { status: 'idle' };

export type IdleCraftDockPreloadProgress = {
  /** 0–1 overall pipeline progress (base preload + extended attach combined). */
  fraction: number;
  /** Human-readable phase label (same strings the loading veil shows). */
  phase: string;
  /**
   * `true` once the offscreen dock preview exists and can receive character/equipment sync
   * ({@link bindGameStoreToDockPreview}). On legacy preload, gameplay layers may still be
   * building in the background until fraction reaches 1 — {@link consumeIdleCraftDockPreload}
   * always awaits that attach before reparenting.
   */
  ready: boolean;
};

const progressListeners = new Set<(p: IdleCraftDockPreloadProgress) => void>();
let latestProgress: IdleCraftDockPreloadProgress = {
  fraction: 0,
  phase: '',
  ready: false,
};

function emitProgress(next: IdleCraftDockPreloadProgress): void {
  latestProgress = next;
  for (const listener of progressListeners) listener(next);
}

/**
 * Subscribe to preload progress updates. Fires immediately with the current snapshot
 * so the subscriber can render "already ready" or "in-flight" states without a race.
 */
export function subscribeIdleCraftDockPreloadProgress(
  listener: (p: IdleCraftDockPreloadProgress) => void,
): () => void {
  progressListeners.add(listener);
  listener(latestProgress);
  return () => {
    progressListeners.delete(listener);
  };
}

export function getIdleCraftDockPreloadProgress(): IdleCraftDockPreloadProgress {
  return latestProgress;
}

/**
 * The offscreen container must be **in the DOM** (not `display: none`) so
 * `getBoundingClientRect` returns real dimensions — otherwise the preview's
 * sizing logic falls back to a fixed 960×540. `visibility: hidden` + off-screen
 * position keeps it invisible without removing layout.
 */
function createOffscreenContainer(): HTMLElement {
  const c = document.createElement('div');
  c.setAttribute('aria-hidden', 'true');
  c.setAttribute('data-dock-preload-offscreen', '');
  c.style.position = 'fixed';
  c.style.left = '-99999px';
  c.style.top = '0';
  c.style.width = `${Math.min(1280, Math.max(640, Math.round(window.innerWidth * 0.55)))}px`;
  c.style.height = `${Math.min(720, Math.max(360, Math.round(window.innerHeight * 0.5)))}px`;
  c.style.pointerEvents = 'none';
  c.style.visibility = 'hidden';
  document.body.appendChild(c);
  return c;
}

/**
 * Phase weighting for the unified progress bar. CharacterScenePreview.create's
 * own `onProgress` reports 0..1 across its internal phases — we squeeze it into
 * the 0..0.55 range. The extended attach phase reports 0.55..1.0.
 */
const BASE_PRELOAD_BAR_END = 0.55;

/**
 * Start the unified preload if it hasn't already been started. Safe to call
 * multiple times — subsequent calls return the same promise. Call this right
 * after the start flow has painted (one `rAF` tick) so it does not compete
 * with the title's first paint for main-thread time.
 */
export function startIdleCraftDockPreload(
  onProgress?: (fraction: number, phase: string) => void,
): Promise<IdleCraftDockBundle> {
  if (state.status === 'pending') return state.promise;
  if (state.status === 'ready') return Promise.resolve(state.bundle);
  if (state.status === 'failed') return Promise.reject(state.error);

  emitProgress({ fraction: 0, phase: 'Preparing your expedition…', ready: false });
  const offscreen = createOffscreenContainer();

  /* === 2026-04-20 unified-preload pipeline ===
   *
   * Phase 1 builds the scene preview. Phase 2 builds gameplay layers into that scene.
   * Legacy (`worker=0`): Phase 2 runs in parallel after Phase 1 returns so title + bind
   * can use the preview early; {@link consumeIdleCraftDockPreload} always awaits Phase 2
   * before reparent. Worker path still awaits both in-series. */
  let legacyGameplayAttachPromise: Promise<DockExtendedPreloadHandles | null> | undefined;

  const promise = (async (): Promise<IdleCraftDockBundle> => {
    let preview: CharacterDockPreview;
    let gameplayHandles: DockExtendedPreloadHandles | null = null;

    if (isWorkerDockPreviewEnabled()) {
      /* Worker GL title: one host, one gameplay attach (worker). Main-thread
       * `getFreeRoamHandles` + logical scene are fed by `freeRoamWorldForMain` — no
       * parallel `CharacterScenePreview` + second extended preload. */
      const hostProgressStart = 0.05;
      onProgress?.(hostProgressStart, 'Loading expedition data…');
      emitProgress({ fraction: hostProgressStart, phase: 'Loading expedition data…', ready: false });
      const project = await fetchEmpireProject();
      if (!project) {
        throw new Error('[dockPreload] fetchEmpireProject returned null — cannot boot CharacterSceneHost');
      }
      const legacyTier = resolveGraphicsTier();
      const hostMount = document.createElement('div');
      hostMount.style.width = '100%';
      hostMount.style.height = '100%';
      offscreen.appendChild(hostMount);

      const bumpTo = (f: number, phase: string): void => {
        const scaled = Math.min(
          BASE_PRELOAD_BAR_END,
          hostProgressStart + f * (BASE_PRELOAD_BAR_END - hostProgressStart),
        );
        onProgress?.(scaled, phase);
        emitProgress({ fraction: scaled, phase, ready: false });
      };

      preview = await CharacterSceneHost.create(hostMount, {
        graphicsTier: mapLegacyGraphicsTierForWorker(legacyTier),
        projectJson: JSON.stringify(project),
        runHeadless: false,
        attachWindowKeyboardMouseForwarders: true,
        onAudioSfx: routeWorkerAudioSfx,
      });
      bumpTo(0.5, 'Worker dock ready…');
      const workerGameplayAttach = preview.attachGameplayLayers((subFraction, subPhase) => {
        const scaled = BASE_PRELOAD_BAR_END + subFraction * (1 - BASE_PRELOAD_BAR_END);
        onProgress?.(scaled, subPhase);
        emitProgress({ fraction: scaled, phase: subPhase, ready: false });
      });
      try {
        await workerGameplayAttach;
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[dockPreload] worker gameplay attach failed; mountApp will try inline-attach', err);
      }
      /* `runDockGameplayAttachShared` already built forest + harvest + … into the
       * **worker** scene. We cannot return those handles to main (separate
       * WebGL context + thread), so `gameplayHandles` stays null; mountApp's
       * `ensureHarvestNodesAttached` + `ensureDockForestAttached` re-build
       * gameplay layers on {@link CharacterSceneHost.scene} for raycast/collision
       * / store-driven UX. That duplicates large BatchedMesh/instanced geometry on
       * the main thread — a major FPS cost and the main dedupe target for Phase 3.x. */
      gameplayHandles = null;
      return { preview, gameplayHandles };
    } else {
      /* Overlap Phase 2 chunk work with Phase 1: while WebGL + forest backdrop build,
       * prefetch `dockExtendedPreload` and gameplay world modules so parse/compile is
       * less serial after `create` resolves (same bundle graph, no feature loss). */
      const extendedModPromise = import('./dockExtendedPreload');
      const worldModulesWarmPromise = import('./dockGameplayAttachShared').then((m) =>
        m.warmDockGameplayWorldModules(),
      );

      /* Phase 1 — scene preview (foundation). Reports 0..0.55 of the bar. */
      preview = await CharacterScenePreview.create(offscreen, {
        onProgress: (fraction, phase) => {
          const scaled = Math.min(BASE_PRELOAD_BAR_END, fraction * BASE_PRELOAD_BAR_END);
          onProgress?.(scaled, phase);
          emitProgress({ fraction: scaled, phase, ready: false });
        },
        runHeadless: true,
      });

      /* Phase 2 — gameplay layer attach. Reports 0.55..1.0 of the bar. */
      const [ext] = await Promise.all([extendedModPromise, worldModulesWarmPromise]);
      /* Staged preload (legacy only): do not await extended attach here — gameplay layers
       * build in parallel with the title flow, so `startIdleCraftDockPreload` resolves after
       * scene foundation only and `enterGame`'s first await is much shorter when the player
       * does not rush past the title. {@link consumeIdleCraftDockPreload} always awaits
       * `legacyGameplayAttachPromise` before reparent so the dock scene is fully wired. */
      legacyGameplayAttachPromise = ext.startDockExtendedPreload(preview, (subFraction, subPhase) => {
        const scaled = BASE_PRELOAD_BAR_END + subFraction * (1 - BASE_PRELOAD_BAR_END);
        onProgress?.(scaled, subPhase);
        emitProgress({ fraction: scaled, phase: subPhase, ready: false });
      });
      void legacyGameplayAttachPromise
        .then((handles) => {
          if (state.status === 'ready' && state.bundle.preview === preview) {
            state.bundle.gameplayHandles = handles;
            emitProgress({ fraction: 1, phase: 'Expedition ready', ready: true });
          }
        })
        .catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn('[dockPreload] extended attach failed; mountApp will inline-attach', err);
          if (state.status === 'ready' && state.bundle.preview === preview) {
            state.bundle.gameplayHandles = null;
            emitProgress({ fraction: 1, phase: 'Expedition ready', ready: true });
          }
        });
      gameplayHandles = null;
    }

    return { preview, gameplayHandles };
  })()
    .then((bundle) => {
      const readyState: PreloadState = {
        status: 'ready',
        bundle,
        offscreen,
        ...(legacyGameplayAttachPromise ? { legacyGameplayAttachPromise } : {}),
      };
      state = readyState;
      if (legacyGameplayAttachPromise) {
        emitProgress({
          fraction: BASE_PRELOAD_BAR_END,
          phase: 'Building expedition layers…',
          ready: true,
        });
      } else {
        emitProgress({ fraction: 1, phase: 'Expedition ready', ready: true });
      }
      return bundle;
    })
    .catch((err: unknown) => {
      state = { status: 'failed', error: err };
      offscreen.remove();
      throw err;
    });

  state = { status: 'pending', promise, offscreen };
  return promise;
}

/**
 * Consume the preloaded bundle into the real dock mount. If the preload is still
 * pending, this awaits it. If it was never started or failed, returns `null` so
 * the caller can fall back to building a fresh preview inline (same code path as
 * before the preload existed).
 */
export async function consumeIdleCraftDockPreload(
  target: HTMLElement,
): Promise<IdleCraftDockBundle | null> {
  const snapshot = state;
  if (snapshot.status === 'idle' || snapshot.status === 'failed') return null;
  if (snapshot.status === 'pending') {
    try {
      await snapshot.promise;
    } catch {
      return null;
    }
  }
  /* Re-read after any await; the `then` in `startIdleCraftDockPreload` has now flipped state. */
  const settled = state;
  if (settled.status !== 'ready') return null;
  const { bundle, offscreen, legacyGameplayAttachPromise } = settled;
  if (bundle.gameplayHandles == null && legacyGameplayAttachPromise) {
    try {
      bundle.gameplayHandles = await legacyGameplayAttachPromise;
    } catch {
      bundle.gameplayHandles = null;
    }
  }
  bundle.preview.reparent(target);
  offscreen.remove();
  state = { status: 'idle' };
  return bundle;
}

/** True if a preload is running or done — useful for callers that want to gate progress UI. */
export function isIdleCraftDockPreloadActive(): boolean {
  return state.status === 'pending' || state.status === 'ready';
}

/**
 * Returns the live offscreen preview if the preload has finished and not yet
 * been consumed; `null` otherwise. The state machine flips back to `idle` the
 * moment {@link consumeIdleCraftDockPreload} reparents the preview into
 * mountApp, so callers querying through this getter automatically stop seeing
 * the preview at consume time — no manual teardown needed.
 *
 * Used by {@link bindGameStoreToDockPreview} to pre-apply equipment + character
 * preset against the offscreen preview during the title flow, eliminating the
 * `applyCharacterPreset` + `syncEquipment` cost from mountApp's click → game
 * critical path.
 */
export function getIdleCraftDockPreviewIfReady(): CharacterDockPreview | null {
  return state.status === 'ready' ? state.bundle.preview : null;
}

/** @deprecated No separate main-thread game preview; worker host is the sole preload preview. */
export function getIdleCraftDockGamePreviewIfReady(): CharacterScenePreview | null {
  return null;
}

/**
 * Pre-apply the player's character preset + equipped weapon/pick/shield to the
 * offscreen dock preview during the title flow, so by the time mountApp's
 * enter-game pass runs, the preview is already in sync and `applyCharacterPreset`
 * + `syncEquipment` short-circuit via their idempotency guards.
 *
 * **Why this exists.** `syncEquipment` disposes 4 hand-group meshes + rebuilds
 * 1-3 LPCA weapon meshes (axe / sword / pick / shield). On the cold path it
 * costs ~10-100 ms and used to land on the click → game critical path while
 * the forging veil was up. The equipment + preset state lives in the
 * `GameStore`, which is alive during the title flow. The offscreen preview is
 * also alive during the title flow. Wiring them together moves the cost into
 * title-screen idle time.
 *
 * **Lifecycle.**
 *   - On call: snapshots the current store state and applies once if a preview
 *     is already ready (covers warm-cache visits where preload finishes before
 *     `mountStartFlow` paints).
 *   - Subscribes to `subscribeIdleCraftDockPreloadProgress` so the apply also
 *     fires the moment a fresh preload becomes ready (covers cold visits +
 *     post-`returnToTitle` re-preloads).
 *   - Subscribes to `store.subscribe` so any equipment / preset change in the
 *     title flow's character picker (or in-game gear swaps) propagates.
 *   - All three callbacks route through `getIdleCraftDockPreviewIfReady()`,
 *     which returns `null` after consume — so post-consume firings cleanly
 *     skip without needing an explicit teardown.
 *
 * **Safe to call once at boot.** No teardown is returned because the binding
 * is page-lifetime and self-skips when there's no preview to bind to. Per-store-
 * update cost when preview is null: one branch + one return. When preview is
 * present and state matches: two `===` checks each in the early-return guards.
 */
export function bindGameStoreToDockPreview(store: GameStore): void {
  const sync = (): void => {
    const preview = getIdleCraftDockPreviewIfReady();
    if (!preview) return;
    const s = store.getStateRef();
    preview.applyCharacterPreset(s.characterPresetId);
    preview.syncEquipment(s.equipment);
    if (preview instanceof CharacterSceneHost) {
      preview.syncPveWaveForMobs(s.pveWave);
    }
  };
  /* Initial sync — covers the case where preload finished BEFORE this binding
   * was installed (rare on first boot, common on `returnToTitle` re-binds). */
  sync();
  /* Fires the moment a fresh preload becomes ready. The listener also fires
   * immediately with the current snapshot per the helper's contract, so the
   * `sync()` call above and this subscription are functionally redundant on
   * the warm path — but the redundancy is the point: whichever path resolves
   * first triggers the apply, and the second is a no-op via the early-returns. */
  subscribeIdleCraftDockPreloadProgress(() => {
    if (getIdleCraftDockPreviewIfReady()) sync();
  });
  /* Title-flow character-picker changes + any in-game equipment swap. The
   * idempotency early-returns inside `applyCharacterPreset` + `syncEquipment`
   * keep the per-emit cost at ~5 µs when nothing relevant changed. */
  store.subscribe(sync);
}

/**
 * Tear down a preloaded-but-never-consumed bundle (e.g. user returns to title
 * before ever entering the game, or Vibe Jam portal exit fires from the title).
 * Disposes WebGL resources and clears the cache so a fresh start can be attempted
 * later. Safe to call at any state.
 */
export function disposeUnusedIdleCraftDockPreload(): void {
  if (state.status === 'ready') {
    const b = state.bundle;
    if (b.preview instanceof CharacterScenePreview) {
      b.preview.dispose();
    } else {
      void b.preview.dispose();
    }
    state.offscreen.remove();
  } else if (state.status === 'pending') {
    /* Defer: once the promise resolves, dispose the bundle and remove its container. */
    const pending = state;
    void pending.promise
      .then((bundle) => {
        /* Only dispose if no consumer claimed it in the meantime. */
        if (state === pending) {
          if (bundle.preview instanceof CharacterScenePreview) {
            bundle.preview.dispose();
          } else {
            void bundle.preview.dispose();
          }
          pending.offscreen.remove();
          state = { status: 'idle' };
        }
      })
      .catch(() => {
        /* failed state already carries the error; nothing to clean up beyond the offscreen div. */
      });
    return;
  }
  state = { status: 'idle' };
}
