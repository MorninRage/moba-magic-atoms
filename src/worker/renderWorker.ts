/**
 * Render worker entrypoint.
 *
 * Spawned by `src/visual/characterSceneHost.ts` on the main thread via
 * `new Worker(new URL('./renderWorker.ts', import.meta.url), { type: 'module' })`.
 *
 * **Phase 0 status (current)**: this file is a SKELETON. It receives the
 * `init` message, stores the OffscreenCanvas + SAB references, and posts
 * `ready` back to main without rendering anything. Phase 3 will populate
 * the `CharacterSceneController` and start the render loop.
 *
 * Why a skeleton ships now:
 *   - Lets main-thread `WorkerBridge` integration land + typecheck against a
 *     real worker module URL (Vite HMR + bundle split need this).
 *   - COOP/COEP + `SharedArrayBuffer` capability gate can be smoke-tested
 *     end-to-end without waiting on the 3-4 week scene migration.
 *   - Future incremental phases can ship behind `?worker=1` URL flag without
 *     blocking the default path on full parity.
 *
 * See `src/worker/AGENTS.md` for the hard rules every file in this folder
 * must follow (no DOM, no Web Audio, no localStorage, no GameStore).
 */

import {
  type WorkerMessage,
  type MainMessage,
  assertNever,
} from './protocol';
import { SharedRenderState, FLAG } from './sharedState';
import { CharacterSceneController } from './characterSceneController';

/**
 * Minimal local declaration of the dedicated-worker global. The project's
 * `tsconfig.json` ships with `lib: ["DOM", ...]` (so the rest of the app
 * sees `window`/`document`), and adding `WebWorker` to the lib list would
 * conflict on `self`/`postMessage` signatures. Declaring exactly the surface
 * THIS file uses keeps the worker file self-contained without forking the
 * whole app's tsconfig.
 *
 * Note: at runtime the worker IS a `DedicatedWorkerGlobalScope`. The cast
 * below to `WorkerSelf` is purely a type fix.
 */
interface WorkerSelf {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerMessage>) => void) | null;
  onmessageerror: ((e: MessageEvent) => void) | null;
  onerror: ((event: Event | string) => unknown) | null;
}
const workerSelf = self as unknown as WorkerSelf;

/* ============================================================================
 * Worker-local state
 * ============================================================================ */

let canvas: OffscreenCanvas | null = null;
let sharedState: SharedRenderState | null = null;
let controller: CharacterSceneController | null = null;
let disposed = false;

/* ============================================================================
 * postMessage helpers
 * ============================================================================ */

function postToMain(msg: MainMessage, transfer?: Transferable[]): void {
  /* `self.postMessage` in a DedicatedWorkerGlobalScope sends to the spawning
   * thread. The transfer list is only used for ArrayBuffer / OffscreenCanvas
   * etc. — almost all our messages are plain structured-cloneable JSON. */
  if (transfer && transfer.length > 0) {
    workerSelf.postMessage(msg, transfer);
  } else {
    workerSelf.postMessage(msg);
  }
}

function logToMain(level: 'info' | 'warn' | 'error', text: string): void {
  postToMain({ type: 'log', level, text });
}

/* ============================================================================
 * Message handlers
 * ============================================================================ */

function handleInit(msg: Extract<WorkerMessage, { type: 'init' }>): void {
  if (canvas) {
    logToMain('warn', 'init received twice; ignoring duplicate');
    return;
  }
  canvas = msg.canvas;
  sharedState = new SharedRenderState(msg.sab);
  /* Size the offscreen canvas to match main's CSS-px × DPR. */
  canvas.width = Math.max(1, Math.floor(msg.width * msg.devicePixelRatio));
  canvas.height = Math.max(1, Math.floor(msg.height * msg.devicePixelRatio));

  controller = new CharacterSceneController(canvas, sharedState, msg.graphicsTier, postToMain);

  /* WebGL + rAF must complete BEFORE `ready` — main's WorkerBridge awaits it.
   * `runHeadless` skips GL (parity with legacy preload's headless create). */
  void (async () => {
    try {
      if (!msg.runHeadless) {
        await controller!.initWebGL(msg.projectJson);
        controller!.start();
      }
      logToMain(
        'info',
        `worker init OK — canvas ${msg.width}x${msg.height} @ DPR ${msg.devicePixelRatio.toFixed(2)}, ` +
          `tier ${msg.graphicsTier}, project bytes ${msg.projectJson.length}, headless=${msg.runHeadless ?? false}`,
      );
      sharedState!.setLastRenderAtMs(Math.floor(performance.now()));
      postToMain({ type: 'ready' });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      logToMain('error', `worker initWebGL failed: ${text}`);
      postToMain({ type: 'contextLost' });
      controller?.dispose();
      controller = null;
      canvas = null;
      sharedState = null;
    }
  })();
}

function handleResize(msg: Extract<WorkerMessage, { type: 'resize' }>): void {
  if (!controller) {
    logToMain('warn', 'resize before init; ignoring');
    return;
  }
  controller.handleMessage(msg);
}

function handleDispose(): void {
  if (disposed) return;
  disposed = true;
  if (controller) {
    controller.dispose();
    controller = null;
  }
  if (sharedState) {
    sharedState.clearFlags(FLAG.WORKER_READY);
  }
  canvas = null;
  sharedState = null;
}

/* ============================================================================
 * onmessage dispatcher — exhaustive switch per protocol.ts.
 *
 * Handlers for state-mutation messages will be wired to
 * CharacterSceneController in Phase 3. For now they no-op + log so the
 * postMessage protocol is end-to-end testable from main.
 * ============================================================================ */

workerSelf.onmessage = (e: MessageEvent<WorkerMessage>): void => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      handleInit(msg);
      return;
    case 'resize':
      handleResize(msg);
      return;
    case 'dispose':
      handleDispose();
      return;
    case 'attachGameplayLayers':
      controller?.attachGameplayLayersFromMain();
      return;
    /* All other state-mutation messages route to the controller. The
     * controller's exhaustive switch handles each variant; if a new
     * WorkerMessage variant is added without a controller case, the
     * controller's `_exhaustive: never` line fails the build. */
    case 'applyCharacterPreset':
    case 'syncEquipment':
    case 'setTorchInventory':
    case 'setCraftDecorAvailability':
    case 'setPageContext':
    case 'setUserCameraZoomEnabled':
    case 'resetDockCameraView':
    case 'setCameraYawPitch':
    case 'setCameraLockActive':
    case 'setFreeRoamAirborne':
    case 'setAwakenedFreeRoam':
    case 'setAwakenedRenderBudget':
    case 'setGraphicsTier':
    case 'applyDockRendererDisplay':
    case 'applyDockPostProcessing':
    case 'syncGatherRpgVisuals':
    case 'setClipSpeedMultiplier':
    case 'playGatherAction':
    case 'playGatherActionInPlace':
    case 'playInPlaceCombatClip':
    case 'playCraftHammer':
    case 'playBattleAction':
    case 'playBattleEnemyStrike':
    case 'queueBattleEnemyDeathAfterKill':
    case 'playBattlePlayerDeath':
    case 'resetDockAfterPermadeath':
    case 'playOneShot':
    case 'setResourceHover':
    case 'spawnAwakenedHitBlood':
    case 'syncBattleContext':
    case 'syncOnlinePresence':
    case 'syncPvpDockRivalPreset':
    case 'setHunterSharedWorldActive':
    case 'setPvpDuelDockLayout':
    case 'setStaffPriorityVisible':
    case 'cancelCameraDrag':
    case 'relevelAvatarFeetAfterEquipmentSync':
    case 'syncPveWaveForWorker':
    case 'applyAwakenedMobDamageFromMain':
    case 'skinAwakenedCorpseOnWorker':
    case 'clearAwakenedMobsOnWorker':
    case 'syncCabinPiecesFromMain':
    case 'syncCraftStationsFromMain':
    case 'applyDockForestHitOnWorker':
    case 'applyFreeRoamHarvestHitOnWorker':
    case 'pointerEvent':
    case 'wheelEvent':
      controller?.handleMessage(msg);
      return;
    default:
      assertNever(msg);
  }
};

/* ============================================================================
 * Global error capture — surface worker exceptions on main's console where
 * the developer is actually looking.
 * ============================================================================ */

workerSelf.onerror = (event: Event | string): void => {
  const text = typeof event === 'string' ? event : `worker error: ${(event as ErrorEvent).message ?? 'unknown'}`;
  logToMain('error', text);
  /* Allow default handling too. */
  return undefined;
};

workerSelf.onmessageerror = (e: MessageEvent): void => {
  logToMain('error', `messageerror: ${String(e.data)}`);
};
