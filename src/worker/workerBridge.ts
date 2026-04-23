/**
 * WorkerBridge — main-thread facade for the render worker.
 *
 * Wraps `new Worker(...)` + the typed message protocol from
 * `./protocol.ts`. Call sites use this class as a higher-level analog of
 * the old `CharacterScenePreview` class — every state-mutation method
 * forwards to a `WorkerMessage` over postMessage, and live getters read
 * from the `SharedRenderState` directly (zero IPC).
 *
 * **Phase 2 status (current)**: this module ships the bridge plumbing —
 * worker spawn, message dispatch, ready-promise, audio-event routing,
 * window-event re-dispatch. It is NOT yet wired into `CharacterScenePreview`
 * (Phase 3 builds `characterSceneHost.ts` which actually constructs the
 * bridge + transfers the canvas).
 *
 * Why ship the bridge before the host: keeps the postMessage protocol
 * surface flat and reviewable, lets Phase 3 focus purely on the
 * DOM-shell-vs-worker-controller split, and lets us test the bridge in
 * isolation via a `?workerBridge=smoke` URL flag (TBD).
 *
 * **Lifecycle**:
 *   1. `WorkerBridge.create(canvas, projectJson, opts)` — spawns the worker,
 *      transfers `canvas.transferControlToOffscreen()`, allocates the
 *      shared state, posts `init`, awaits `ready`.
 *   2. Caller drives state mutations via the typed setter methods (e.g.
 *      `bridge.applyCharacterPreset('vanguard')`).
 *   3. Caller reads live state via `bridge.sharedState.getAvatarX()` etc.
 *      No await — direct memory read.
 *   4. `bridge.dispose()` — posts `dispose` and `worker.terminate()`s.
 */

import {
  type WorkerMessage,
  type MainMessage,
  type InitMessage,
  type AudioSfxMessage,
  type WorkerMobAuthorityMessage,
  type FreeRoamWorldForMainPayload,
} from './protocol';
import type { PlacedCabinPiece, PlacedCraftStation } from '../core/types';
import { SharedRenderState } from './sharedState';
import { registerMainThreadDockSharedState, unregisterMainThreadDockSharedState } from './dockSharedRenderReadback';

/* ============================================================================
 * Audio routing — main consumes worker's audio events.
 *
 * The worker can't touch `AudioContext` (Web Audio is main-thread). Instead
 * it posts `{type: 'audioSfx', kind, ...}` messages; the bridge invokes the
 * registered handler, which the audio bridge supplies on construction.
 * ============================================================================ */

export type AudioSfxHandler = (msg: AudioSfxMessage) => void;

export type WorkerMobAuthorityHandler = (msg: WorkerMobAuthorityMessage) => void;

/* ============================================================================
 * Window event routing — main re-dispatches worker-originated CustomEvents.
 *
 * Some legacy listeners (vibejam-portal-exit, battle-player-death-done) live
 * on `window` and were dispatched from inside `CharacterScenePreview.loop`.
 * Worker can't reach `window`, so it posts a `windowCustomEvent` message
 * and main re-dispatches.
 * ============================================================================ */

export type WindowEventHandler = (eventName: string, detail: unknown) => void;

/** Default wait for worker `ready` after `init` — full `initWebGL` can exceed 5s on cold JIT / mobile. */
export const WORKER_READY_TIMEOUT_MS_DEFAULT = 90_000;

/* ============================================================================
 * Bridge construction options.
 * ============================================================================ */

export interface WorkerBridgeOptions {
  /** Initial canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio at boot. */
  devicePixelRatio: number;
  /** Resolved graphics tier (`graphicsTier.ts` output). */
  graphicsTier: 'low' | 'perf' | 'balanced' | 'cinematic';
  /** True if the worker should defer starting its rAF loop. */
  runHeadless?: boolean;
  /** Audio-event sink. */
  onAudioSfx?: AudioSfxHandler;
  /** CustomEvent re-dispatch sink (forwards to `window.dispatchEvent`). */
  onWindowEvent?: WindowEventHandler;
  /** Worker-emitted log lines. */
  onLog?: (level: 'info' | 'warn' | 'error', text: string) => void;
  /** Called once when the worker emits `contextLost`. */
  onContextLost?: () => void;
  /**
   * Maximum time (ms) to wait for worker `ready` after sending `init`.
   * Default {@link WORKER_READY_TIMEOUT_MS_DEFAULT} — `initWebGL` builds terrain,
   * forest phases, renderer, hero, and post stack before posting `ready`.
   */
  readyTimeoutMs?: number;
}

/* ============================================================================
 * WorkerBridge
 * ============================================================================ */

export class WorkerBridge {
  private worker: Worker;
  readonly sharedState: SharedRenderState;
  private readonly opts: WorkerBridgeOptions;
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private disposed = false;

  /** Map completionToken → callback for in-place gather actions. */
  private gatherInPlaceCompletions = new Map<number, () => void>();
  private nextCompletionToken = 1;

  private gameplayAttachPending: Promise<void> | null = null;
  private gameplayAttachResolve: (() => void) | null = null;
  private gameplayAttachReject: ((err: Error) => void) | null = null;
  private gameplayAttachOnProgress: ((f: number, phase: string) => void) | undefined;
  private mobAuthoritySink: WorkerMobAuthorityHandler | null = null;

  /**
   * Last {@link FreeRoamWorldForMainMessage} from the worker (after gameplay attach).
   * Drives `CharacterSceneHost.getFreeRoamHandles` on main without a shadow scene.
   */
  private freeRoamWorldForMain: FreeRoamWorldForMainPayload | null = null;

  /**
   * Spawn the worker, transfer the canvas, allocate shared state, post init.
   *
   * Caller responsibility: pass an `OffscreenCanvas` obtained via
   * `htmlCanvas.transferControlToOffscreen()`. The HTMLCanvas itself remains
   * on main and acts as the DOM surface; only its rendering control moves
   * to the worker.
   */
  static async create(
    offscreenCanvas: OffscreenCanvas,
    projectJson: string,
    opts: WorkerBridgeOptions,
  ): Promise<WorkerBridge> {
    const sharedState = SharedRenderState.create();
    const bridge = new WorkerBridge(sharedState, opts);
    await bridge.boot(offscreenCanvas, projectJson);
    registerMainThreadDockSharedState(sharedState);
    return bridge;
  }

  private constructor(sharedState: SharedRenderState, opts: WorkerBridgeOptions) {
    this.sharedState = sharedState;
    this.opts = opts;
    /* Spawn the worker module. Vite handles the chunking via
     * `worker: { format: 'es' }` in vite.config.ts. The `import.meta.url`
     * resolution is the canonical Vite pattern — it gets rewritten at build
     * time to the hashed dist URL. */
    this.worker = new Worker(new URL('./renderWorker.ts', import.meta.url), {
      type: 'module',
      name: 'moba-magic-atoms-render-worker',
    });
    this.worker.onmessage = (e: MessageEvent<MainMessage>) => this.handleMainMessage(e.data);
    this.worker.onerror = (event) => {
      /* Worker spawn / parse failures land here. If we haven't resolved
       * `ready` yet, fail it explicitly so callers see the error (not just
       * a hang on the timeout). */
      const err = new Error(`worker.onerror: ${event.message ?? 'unknown'}`);
      console.error('[WorkerBridge]', err);
      if (this.rejectReady) this.rejectReady(err);
    };
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
  }

  /**
   * Send the init message and await `ready`. Times out per
   * `opts.readyTimeoutMs` to surface stuck worker bootstraps.
   */
  private async boot(canvas: OffscreenCanvas, projectJson: string): Promise<void> {
    const initMsg: InitMessage = {
      type: 'init',
      canvas,
      sab: this.sharedState.sab,
      width: this.opts.width,
      height: this.opts.height,
      devicePixelRatio: this.opts.devicePixelRatio,
      projectJson,
      graphicsTier: this.opts.graphicsTier,
      runHeadless: this.opts.runHeadless,
    };
    /* Transfer list MUST include the OffscreenCanvas — without it, the
     * canvas would be structuredCloned, which throws (canvases aren't
     * cloneable) or produces a useless detached object. */
    this.worker.postMessage(initMsg, [canvas]);

    const timeoutMs = this.opts.readyTimeoutMs ?? WORKER_READY_TIMEOUT_MS_DEFAULT;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`WorkerBridge: ready timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    await Promise.race([this.readyPromise, timeoutPromise]);
  }

  /* ============================================================================
   * Worker → main message dispatch
   * ============================================================================ */

  private handleMainMessage(msg: MainMessage): void {
    switch (msg.type) {
      case 'ready':
        this.resolveReady();
        return;
      case 'audioSfx':
        this.opts.onAudioSfx?.(msg);
        return;
      case 'awakenedMobsAuthoritySnapshot':
      case 'awakenedMobDamaged':
      case 'awakenedPlayerDamaged':
      case 'awakenedCorpseSkinLoot':
        this.mobAuthoritySink?.(msg);
        return;
      case 'gatherActionInPlaceComplete': {
        const cb = this.gatherInPlaceCompletions.get(msg.completionToken);
        if (cb) {
          this.gatherInPlaceCompletions.delete(msg.completionToken);
          cb();
        }
        return;
      }
      case 'windowCustomEvent': {
        let detail: unknown = undefined;
        if (msg.detailJson) {
          try {
            detail = JSON.parse(msg.detailJson);
          } catch {
            /* malformed — drop detail, still dispatch event */
          }
        }
        this.opts.onWindowEvent?.(msg.eventName, detail);
        return;
      }
      case 'contextLost':
        this.opts.onContextLost?.();
        return;
      case 'log': {
        const sink = this.opts.onLog;
        if (sink) {
          sink(msg.level, msg.text);
        } else {
          /* Default sink: forward to console with prefix so worker logs
           * are distinguishable from main. */
          const prefix = '[render-worker]';
          if (msg.level === 'error') console.error(prefix, msg.text);
          else if (msg.level === 'warn') console.warn(prefix, msg.text);
          else console.info(prefix, msg.text);
        }
        return;
      }
      case 'gameplayAttachProgress':
        this.gameplayAttachOnProgress?.(msg.fraction, msg.phase);
        return;
      case 'freeRoamWorldForMain': {
        const { type: _t, ...rest } = msg;
        this.freeRoamWorldForMain = rest;
        return;
      }
      case 'gameplayAttachDone': {
        const resolve = this.gameplayAttachResolve;
        const reject = this.gameplayAttachReject;
        this.gameplayAttachResolve = null;
        this.gameplayAttachReject = null;
        if (msg.ok) resolve?.();
        else reject?.(new Error(msg.error ?? 'gameplay attach failed'));
        return;
      }
      default: {
        /* Exhaustiveness — adding a new MainMessage variant in protocol.ts
         * fails the build here until a case is added. */
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  /** World snapshot for main-thread gameplay systems when the worker owns the GL scene. */
  getFreeRoamWorldForMain(): FreeRoamWorldForMainPayload | null {
    return this.freeRoamWorldForMain;
  }

  /* ============================================================================
   * State mutation — typed wrappers around postMessage.
   *
   * Each maps 1:1 to a method on the old CharacterScenePreview class so the
   * Phase 3 host can be a near-mechanical rename. Order mirrors protocol.ts.
   * ============================================================================ */

  resize(width: number, height: number, devicePixelRatio: number): void {
    this.send({ type: 'resize', width, height, devicePixelRatio });
  }

  /** Dream-mode wave for worker mob spawn weighting (`pickMobKind`). */
  syncPveWaveForWorker(pveWave: number): void {
    this.send({ type: 'syncPveWaveForWorker', pveWave });
  }

  applyAwakenedMobDamageFromMain(id: number, amount: number, source?: 'melee' | 'magic'): void {
    this.send({
      type: 'applyAwakenedMobDamageFromMain',
      id,
      amount,
      ...(source ? { source } : {}),
    });
  }

  skinAwakenedCorpseOnWorker(id: number): void {
    this.send({ type: 'skinAwakenedCorpseOnWorker', id });
  }

  clearAwakenedMobsOnWorker(): void {
    this.send({ type: 'clearAwakenedMobsOnWorker' });
  }

  /** Mirror main `GameStore` cabin placements into the worker gameplay scene. */
  syncCabinPiecesFromMain(pieces: ReadonlyArray<PlacedCabinPiece>): void {
    this.send({ type: 'syncCabinPiecesFromMain', pieces: [...pieces] });
  }

  /** Mirror main `GameStore` craft stations into the worker gameplay scene. */
  syncCraftStationsFromMain(stations: ReadonlyArray<PlacedCraftStation>): void {
    this.send({ type: 'syncCraftStationsFromMain', stations: [...stations] });
  }

  /** Mirror dock-forest universal harvest onto the worker-visible BatchedMesh forest. */
  applyDockForestHitOnWorker(kind: string, nodeIndex: number, hitsMult: number): void {
    this.send({ type: 'applyDockForestHitOnWorker', kind, nodeIndex, hitsMult });
  }

  /** Mirror free-roam scatter harvest hits onto the worker scene. */
  applyFreeRoamHarvestHitOnWorker(kind: string, nodeIndex: number, hitsMult: number): void {
    this.send({ type: 'applyFreeRoamHarvestHitOnWorker', kind, nodeIndex, hitsMult });
  }

  /** Optional sink for worker-owned awakened mob roster + combat events (Wave 1). */
  setMobAuthoritySink(handler: WorkerMobAuthorityHandler | null): void {
    this.mobAuthoritySink = handler;
  }

  applyCharacterPreset(presetId: string): void {
    this.send({ type: 'applyCharacterPreset', presetId });
  }

  syncEquipment(weapon: string | null, pick: string | null, shield: string | null): void {
    this.send({ type: 'syncEquipment', weapon, pick, shield });
  }

  setTorchInventory(hasTorch: boolean, torchEquipped = true): void {
    this.send({ type: 'setTorchInventory', hasTorch, torchEquipped });
  }

  setCraftDecorAvailability(campfire: boolean, workbench: boolean): void {
    this.send({ type: 'setCraftDecorAvailability', campfire, workbench });
  }

  setPageContext(page: 'gather' | 'craft' | 'portal' | 'home' | 'battle' | 'lobby'): void {
    this.send({ type: 'setPageContext', page });
  }

  setUserCameraZoomEnabled(enabled: boolean): void {
    this.send({ type: 'setUserCameraZoomEnabled', enabled });
  }

  resetDockCameraView(): void {
    this.send({ type: 'resetDockCameraView' });
  }

  setCameraYawPitch(yaw: number, pitch: number): void {
    this.send({ type: 'setCameraYawPitch', yaw, pitch });
  }

  setCameraLockActive(active: boolean): void {
    this.send({ type: 'setCameraLockActive', active });
  }

  setFreeRoamAirborne(airborne: boolean): void {
    this.send({ type: 'setFreeRoamAirborne', airborne });
  }

  setAwakenedFreeRoam(active: boolean): void {
    this.send({ type: 'setAwakenedFreeRoam', active });
  }

  setAwakenedRenderBudget(awakened: boolean): void {
    this.send({ type: 'setAwakenedRenderBudget', awakened });
  }

  setGraphicsTier(tier: 'low' | 'perf' | 'balanced' | 'cinematic'): void {
    this.send({ type: 'setGraphicsTier', tier });
  }

  applyDockRendererDisplay(): void {
    this.send({ type: 'applyDockRendererDisplay' });
  }

  applyDockPostProcessing(): void {
    this.send({ type: 'applyDockPostProcessing' });
  }

  syncGatherRpgVisuals(towardHome01: number, clipFactor: number): void {
    this.send({ type: 'syncGatherRpgVisuals', towardHome01, clipFactor });
  }

  setClipSpeedMultiplier(multiplier: number): void {
    this.send({ type: 'setClipSpeedMultiplier', multiplier });
  }

  playGatherAction(actionId: string, harvestSlot?: number): void {
    this.send({ type: 'playGatherAction', actionId, harvestSlot });
  }

  /**
   * Play in-place gather + register a completion callback. Worker echoes
   * back `gatherActionInPlaceComplete` with the matching token; the
   * callback is invoked once and unregistered.
   */
  playGatherActionInPlace(actionId: string, onComplete?: () => void): void {
    const completionToken = this.nextCompletionToken++;
    if (onComplete) {
      this.gatherInPlaceCompletions.set(completionToken, onComplete);
    }
    this.send({ type: 'playGatherActionInPlace', actionId, completionToken });
  }

  playInPlaceCombatClip(clip: 'cast' | 'strike'): void {
    this.send({ type: 'playInPlaceCombatClip', clip });
  }

  playCraftHammer(station?: string, recipeId?: string): void {
    this.send({ type: 'playCraftHammer', station, recipeId });
  }

  playBattleAction(cardId: string): void {
    this.send({ type: 'playBattleAction', cardId });
  }

  playBattleEnemyStrike(): void {
    this.send({ type: 'playBattleEnemyStrike' });
  }

  queueBattleEnemyDeathAfterKill(): void {
    this.send({ type: 'queueBattleEnemyDeathAfterKill' });
  }

  playBattlePlayerDeath(): void {
    this.send({ type: 'playBattlePlayerDeath' });
  }

  resetDockAfterPermadeath(): void {
    this.send({ type: 'resetDockAfterPermadeath' });
  }

  playOneShot(
    clip:
      | 'hireWave'
      | 'deckUnlock'
      | 'eatCookedMeat'
      | 'eatBerriesSnack'
      | 'drinkWater'
      | 'bandage'
      | 'stim'
      | 'repairItem'
      | 'equipAdjust',
  ): void {
    this.send({ type: 'playOneShot', clip });
  }

  setResourceHover(resourceKey: string | null): void {
    this.send({ type: 'setResourceHover', resourceKey });
  }

  spawnAwakenedHitBlood(x: number, faceY: number, z: number, intensity: number): void {
    this.send({ type: 'spawnAwakenedHitBlood', x, faceY, z, intensity });
  }

  syncBattleContext(enemyId: string | null): void {
    this.send({ type: 'syncBattleContext', enemyId });
  }

  syncOnlinePresence(presence: unknown, selfSessionId: string, roster: unknown, opts: unknown): void {
    /* Stringify to flatten — structuredClone of the live presence shape
     * (with proxies, methods, deeply-nested rosters) is significantly more
     * expensive than JSON serialize on this size of payload. */
    this.send({
      type: 'syncOnlinePresence',
      presenceJson: JSON.stringify(presence),
      selfSessionId,
      rosterJson: JSON.stringify(roster),
      optsJson: JSON.stringify(opts),
    });
  }

  syncPvpDockRivalPreset(presetId: string): void {
    this.send({ type: 'syncPvpDockRivalPreset', presetId });
  }

  setHunterSharedWorldActive(active: boolean, guestSeat?: number): void {
    this.send({ type: 'setHunterSharedWorldActive', active, guestSeat });
  }

  setPvpDuelDockLayout(mode: string, aliveInRoom?: number, duelGuestSeat?: number): void {
    this.send({ type: 'setPvpDuelDockLayout', mode, aliveInRoom, duelGuestSeat });
  }

  setStaffPriorityVisible(visible: boolean): void {
    this.send({ type: 'setStaffPriorityVisible', visible });
  }

  cancelCameraDrag(): void {
    this.send({ type: 'cancelCameraDrag' });
  }

  relevelAvatarFeetAfterEquipmentSync(): void {
    this.send({ type: 'relevelAvatarFeetAfterEquipmentSync' });
  }

  /* ============================================================================
   * Pointer / wheel forwarding from main canvas listeners.
   *
   * Keyboard goes through SharedRenderState.setKeyDown/setKeyUp directly
   * (hot path, called per event by main listener — see Phase 5 for the
   * input refactor).
   * ============================================================================ */

  forwardPointerEvent(
    event: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | 'lostpointercapture' | 'contextmenu' | 'dblclick',
    pointerId: number,
    x: number,
    y: number,
    buttons: number,
    captured: boolean,
  ): void {
    this.send({ type: 'pointerEvent', event, pointerId, x, y, buttons, captured });
  }

  forwardWheelEvent(x: number, y: number, deltaX: number, deltaY: number, deltaMode: number): void {
    this.send({ type: 'wheelEvent', x, y, deltaX, deltaY, deltaMode });
  }

  /**
   * Run the same gameplay-layer attach as title-screen `dockExtendedPreload`
   * inside the worker scene. Resolves when the worker posts `gameplayAttachDone`.
   * Concurrent calls return the same in-flight promise.
   */
  attachGameplayLayers(onProgress?: (fraction: number, phase: string) => void): Promise<void> {
    if (this.gameplayAttachPending) return this.gameplayAttachPending;
    this.gameplayAttachOnProgress = onProgress;
    this.gameplayAttachPending = new Promise<void>((resolve, reject) => {
      this.gameplayAttachResolve = resolve;
      this.gameplayAttachReject = reject;
      this.send({ type: 'attachGameplayLayers' });
    }).finally(() => {
      this.gameplayAttachPending = null;
      this.gameplayAttachOnProgress = undefined;
    });
    return this.gameplayAttachPending;
  }

  /* ============================================================================
   * Lifecycle
   * ============================================================================ */

  /**
   * Tell the worker to dispose its scene + GPU resources, then terminate.
   * Idempotent — safe to call multiple times.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    unregisterMainThreadDockSharedState(this.sharedState);
    this.mobAuthoritySink = null;
    this.disposed = true;
    try {
      this.send({ type: 'dispose' });
      /* Give the worker a moment to dispose GPU handles cleanly before we
       * yank the postMessage channel. 100ms is generous; in practice
       * dispose runs synchronously. */
      await new Promise<void>((r) => setTimeout(r, 100));
    } catch {
      /* worker may already be dead */
    }
    this.worker.terminate();
  }

  /**
   * Internal send helper. Drops messages after dispose() so late callers
   * don't crash on a terminated worker.
   */
  private send(msg: WorkerMessage): void {
    if (this.disposed) return;
    this.worker.postMessage(msg);
  }
}
