import type {
  AwakenedMobInstance,
  AwakenedMobKind,
  PlacedCabinPiece,
  PlacedCraftStation,
} from '../core/types';
import type { ForestStaticObstacle } from '../visual/forestEnvironment';
import type { ResolvedCreek } from '../world/idleCraftHeightfield';

/**
 * Typed message protocol for the render worker.
 *
 * This module defines the OFFICIAL contract between the main thread and the
 * render worker. Both sides import these types, ensuring type-safe payloads
 * across the postMessage boundary.
 *
 * Two discriminated unions are exported:
 *
 *   - {@link WorkerMessage} — sent from MAIN → WORKER. Covers worker
 *     bootstrap (`init`), every state-mutating method previously on
 *     `CharacterScenePreview` (e.g. `applyCharacterPreset`, `syncEquipment`,
 *     `playGatherAction`), and lifecycle (`dispose`, `resize`).
 *
 *   - {@link MainMessage} — sent from WORKER → MAIN. Covers
 *     worker-originated events that need DOM/audio side-effects on main:
 *     footstep SFX, gather completion, custom DOM events, log lines.
 *
 * **Design rule**: NO ad-hoc `postMessage(anyObject)`. Every message must
 * be a member of one of these unions. The bridge handlers on each side
 * exhaustively switch on `type`, so adding a new variant fails the
 * TypeScript build until both sides are updated.
 *
 * **Frequency budget**: postMessage is ~50-200µs per round-trip on a
 * modern desktop. Anything called per-frame from the per-frame loop should
 * NOT use postMessage — use the SharedArrayBuffer in `sharedState.ts`
 * instead. Reserve postMessage for event-shaped traffic (player actions,
 * rare state updates, lifecycle).
 */

/* ============================================================================
 * MAIN → WORKER
 * ============================================================================ */

/**
 * Boot message — the very first message main sends after spawning the worker.
 * Carries the OffscreenCanvas (transferred), the SAB backing
 * `SharedRenderState`, and the resolved project config the worker needs to
 * stand up the scene.
 */
export interface InitMessage {
  type: 'init';
  /** OffscreenCanvas transferred from `<canvas>.transferControlToOffscreen()`. */
  canvas: OffscreenCanvas;
  /** Shared state buffer (see `sharedState.ts` for slot layout). */
  sab: SharedArrayBuffer;
  /** Initial canvas size in CSS pixels. */
  width: number;
  height: number;
  /** Device pixel ratio at boot. Worker can re-read after `resize` messages. */
  devicePixelRatio: number;
  /**
   * Stringified project config — same shape as `fetchEmpireProject()`
   * returns. Worker re-parses to avoid main forwarding live object refs that
   * would force structuredClone of large nested data each call.
   */
  projectJson: string;
  /**
   * Resolved graphics tier at boot. Worker re-evaluates over time when main
   * sends `setGraphicsTier`.
   */
  graphicsTier: 'low' | 'perf' | 'balanced' | 'cinematic';
  /** True if the worker should NOT start its rAF loop (used in headless preload paths). */
  runHeadless?: boolean;
}

/** Container resize from main's ResizeObserver. */
export interface ResizeMessage {
  type: 'resize';
  width: number;
  height: number;
  devicePixelRatio: number;
}

/** Tear down the scene, dispose GPU resources, exit rAF loop. */
export interface DisposeMessage {
  type: 'dispose';
}

/* ----------------------------------------------------------------------------
 * Scene state mutations (mirrors CharacterScenePreview public API)
 * Order roughly groups by concern: character, equipment, environment, gameplay.
 * Each variant maps 1:1 to a method on CharacterSceneController.
 * ---------------------------------------------------------------------------- */

export interface ApplyCharacterPresetMessage {
  type: 'applyCharacterPreset';
  presetId: string;
}

export interface SyncEquipmentMessage {
  type: 'syncEquipment';
  weapon: string | null;
  pick: string | null;
  shield: string | null;
}

export interface SetTorchInventoryMessage {
  type: 'setTorchInventory';
  hasTorch: boolean;
  /** Player toggle (L key); omitted treated as true for older senders. v25+. */
  torchEquipped?: boolean;
}

export interface SetCraftDecorAvailabilityMessage {
  type: 'setCraftDecorAvailability';
  campfire: boolean;
  workbench: boolean;
}

export interface SetPageContextMessage {
  type: 'setPageContext';
  page: 'gather' | 'craft' | 'portal' | 'home' | 'battle' | 'lobby';
}

export interface SetUserCameraZoomEnabledMessage {
  type: 'setUserCameraZoomEnabled';
  enabled: boolean;
}

export interface ResetDockCameraViewMessage {
  type: 'resetDockCameraView';
}

export interface SetCameraYawPitchMessage {
  type: 'setCameraYawPitch';
  yaw: number;
  pitch: number;
}

export interface SetCameraLockActiveMessage {
  type: 'setCameraLockActive';
  active: boolean;
}

export interface SetFreeRoamAirborneMessage {
  type: 'setFreeRoamAirborne';
  airborne: boolean;
}

export interface SetAwakenedFreeRoamMessage {
  type: 'setAwakenedFreeRoam';
  active: boolean;
}

export interface SetAwakenedRenderBudgetMessage {
  type: 'setAwakenedRenderBudget';
  awakened: boolean;
}

export interface SetGraphicsTierMessage {
  type: 'setGraphicsTier';
  tier: 'low' | 'perf' | 'balanced' | 'cinematic';
}

export interface ApplyDockRendererDisplayMessage {
  type: 'applyDockRendererDisplay';
}

export interface ApplyDockPostProcessingMessage {
  type: 'applyDockPostProcessing';
}

export interface SyncGatherRpgVisualsMessage {
  type: 'syncGatherRpgVisuals';
  towardHome01: number;
  clipFactor: number;
}

export interface SetClipSpeedMultiplierMessage {
  type: 'setClipSpeedMultiplier';
  multiplier: number;
}

export interface PlayGatherActionMessage {
  type: 'playGatherAction';
  actionId: string;
  harvestSlot?: number;
}

export interface PlayGatherActionInPlaceMessage {
  type: 'playGatherActionInPlace';
  actionId: string;
  /** Worker echoes back a `gatherActionInPlaceComplete` message when done. */
  completionToken: number;
}

export interface PlayInPlaceCombatClipMessage {
  type: 'playInPlaceCombatClip';
  clip: 'cast' | 'strike';
}

export interface PlayCraftHammerMessage {
  type: 'playCraftHammer';
  station?: string;
  recipeId?: string;
}

export interface PlayBattleActionMessage {
  type: 'playBattleAction';
  cardId: string;
}

export interface PlayBattleEnemyStrikeMessage {
  type: 'playBattleEnemyStrike';
}

export interface QueueBattleEnemyDeathMessage {
  type: 'queueBattleEnemyDeathAfterKill';
}

export interface PlayBattlePlayerDeathMessage {
  type: 'playBattlePlayerDeath';
}

export interface ResetDockAfterPermadeathMessage {
  type: 'resetDockAfterPermadeath';
}

/** One-shot animation clips with no parameters. */
export interface PlayOneShotMessage {
  type: 'playOneShot';
  clip:
    | 'hireWave'
    | 'deckUnlock'
    | 'eatCookedMeat'
    | 'eatBerriesSnack'
    | 'drinkWater'
    | 'bandage'
    | 'stim'
    | 'repairItem'
    | 'equipAdjust';
}

export interface SetResourceHoverMessage {
  type: 'setResourceHover';
  resourceKey: string | null;
}

export interface SpawnAwakenedHitBloodMessage {
  type: 'spawnAwakenedHitBlood';
  x: number;
  faceY: number;
  z: number;
  intensity: number;
}

export interface SyncBattleContextMessage {
  type: 'syncBattleContext';
  enemyId: string | null;
}

export interface SyncOnlinePresenceMessage {
  type: 'syncOnlinePresence';
  /** Stringified to avoid expensive structuredClone of the live presence shape. */
  presenceJson: string;
  selfSessionId: string;
  rosterJson: string;
  optsJson: string;
}

export interface SyncPvpDockRivalPresetMessage {
  type: 'syncPvpDockRivalPreset';
  presetId: string;
}

export interface SetHunterSharedWorldActiveMessage {
  type: 'setHunterSharedWorldActive';
  active: boolean;
  guestSeat?: number;
}

export interface SetPvpDuelDockLayoutMessage {
  type: 'setPvpDuelDockLayout';
  mode: string;
  aliveInRoom?: number;
  duelGuestSeat?: number;
}

export interface SetStaffPriorityVisibleMessage {
  type: 'setStaffPriorityVisible';
  visible: boolean;
}

export interface CancelCameraDragMessage {
  type: 'cancelCameraDrag';
}

export interface RelevelAvatarFeetMessage {
  type: 'relevelAvatarFeetAfterEquipmentSync';
}

/* ----------------------------------------------------------------------------
 * Pointer / wheel events forwarded from main canvas listeners.
 * Keyboard input goes through SharedRenderState bitmask, NOT here — keyboard
 * is hot-polled per frame; pointer events are sparse (drag start/end + wheel).
 * ---------------------------------------------------------------------------- */

export interface PointerEventMessage {
  type: 'pointerEvent';
  event:
    | 'pointerdown'
    | 'pointermove'
    | 'pointerup'
    | 'pointercancel'
    | 'lostpointercapture'
    | 'contextmenu'
    | 'dblclick';
  pointerId: number;
  /** CSS pixel coordinates relative to canvas. */
  x: number;
  y: number;
  buttons: number;
  /** True while pointer is captured to the canvas (for drag tracking). */
  captured: boolean;
}

export interface WheelEventMessage {
  type: 'wheelEvent';
  /** CSS pixel coordinates relative to canvas. */
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

/**
 * Build collision + dock forest + harvest + cabin + craft + projectiles +
 * ward + mushrooms into the worker-owned scene (same pipeline as
 * `dockExtendedPreload` on main). Idempotent once handles exist.
 */
export interface AttachGameplayLayersMessage {
  type: 'attachGameplayLayers';
}

/**
 * Dream-mode wave index for awakened mob kind weighting (`pickMobKind` in
 * `awakenedMobs.ts`). Forwarded from main `GameStore` so worker-spawned mobs
 * match the player's progression.
 */
export interface SyncPveWaveForWorkerMessage {
  type: 'syncPveWaveForWorker';
  pveWave: number;
}

/** Main-thread magic / melee hit — worker-owned mob sim applies HP + callbacks. */
export interface ApplyAwakenedMobDamageFromMainMessage {
  type: 'applyAwakenedMobDamageFromMain';
  id: number;
  amount: number;
  source?: 'melee' | 'magic';
}

/** E-skin corpse — worker despawns + posts {@link AwakenedCorpseSkinLootMessage}. */
export interface SkinAwakenedCorpseOnWorkerMessage {
  type: 'skinAwakenedCorpseOnWorker';
  id: number;
}

/** Clear mob visuals + authority buffer (permadeath / realm flip). */
export interface ClearAwakenedMobsOnWorkerMessage {
  type: 'clearAwakenedMobsOnWorker';
}

/** Keep worker-visible cabin meshes aligned with `GameStore` (shadow-diet path). */
export interface SyncCabinPiecesFromMainMessage {
  type: 'syncCabinPiecesFromMain';
  pieces: PlacedCabinPiece[];
}

/** Keep worker-visible craft stations aligned with `GameStore`. */
export interface SyncCraftStationsFromMainMessage {
  type: 'syncCraftStationsFromMain';
  stations: PlacedCraftStation[];
}

/**
 * Mirror a dock-forest harvest hit onto the worker BatchedMesh forest so the
 * visible dock matches the hidden companion's game logic (same `nodeIndex` when
 * both scenes scatter from identical `ForestStaticObstacle[]`).
 */
export interface ApplyDockForestHitOnWorkerMessage {
  type: 'applyDockForestHitOnWorker';
  kind: string;
  nodeIndex: number;
  hitsMult: number;
}

/**
 * Mirror a free-roam scatter harvest hit (ore / herbs / crystals) onto the
 * worker scene so visuals match main-thread game logic.
 */
export interface ApplyFreeRoamHarvestHitOnWorkerMessage {
  type: 'applyFreeRoamHarvestHitOnWorker';
  kind: string;
  nodeIndex: number;
  hitsMult: number;
}

/* ----------------------------------------------------------------------------
 * Discriminated union — exhaustive switch in worker's onmessage handler.
 * ---------------------------------------------------------------------------- */

export type WorkerMessage =
  | InitMessage
  | ResizeMessage
  | DisposeMessage
  | ApplyCharacterPresetMessage
  | SyncEquipmentMessage
  | SetTorchInventoryMessage
  | SetCraftDecorAvailabilityMessage
  | SetPageContextMessage
  | SetUserCameraZoomEnabledMessage
  | ResetDockCameraViewMessage
  | SetCameraYawPitchMessage
  | SetCameraLockActiveMessage
  | SetFreeRoamAirborneMessage
  | SetAwakenedFreeRoamMessage
  | SetAwakenedRenderBudgetMessage
  | SetGraphicsTierMessage
  | ApplyDockRendererDisplayMessage
  | ApplyDockPostProcessingMessage
  | SyncGatherRpgVisualsMessage
  | SetClipSpeedMultiplierMessage
  | PlayGatherActionMessage
  | PlayGatherActionInPlaceMessage
  | PlayInPlaceCombatClipMessage
  | PlayCraftHammerMessage
  | PlayBattleActionMessage
  | PlayBattleEnemyStrikeMessage
  | QueueBattleEnemyDeathMessage
  | PlayBattlePlayerDeathMessage
  | ResetDockAfterPermadeathMessage
  | PlayOneShotMessage
  | SetResourceHoverMessage
  | SpawnAwakenedHitBloodMessage
  | SyncBattleContextMessage
  | SyncOnlinePresenceMessage
  | SyncPvpDockRivalPresetMessage
  | SetHunterSharedWorldActiveMessage
  | SetPvpDuelDockLayoutMessage
  | SetStaffPriorityVisibleMessage
  | CancelCameraDragMessage
  | RelevelAvatarFeetMessage
  | PointerEventMessage
  | WheelEventMessage
  | AttachGameplayLayersMessage
  | SyncPveWaveForWorkerMessage
  | ApplyAwakenedMobDamageFromMainMessage
  | SkinAwakenedCorpseOnWorkerMessage
  | ClearAwakenedMobsOnWorkerMessage
  | SyncCabinPiecesFromMainMessage
  | SyncCraftStationsFromMainMessage
  | ApplyDockForestHitOnWorkerMessage
  | ApplyFreeRoamHarvestHitOnWorkerMessage;

/* ============================================================================
 * WORKER → MAIN
 * ============================================================================ */

/**
 * Worker has finished its bootstrap phase (renderer + scene + first render
 * frame issued). Main waits for this before resolving its
 * `CharacterScenePreview.create()` analog.
 */
export interface ReadyMessage {
  type: 'ready';
}

/**
 * Worker requests an audio SFX play. The audio bus lives on main.
 * `kind` lets `audioBridge` route to the right player (footstep, magic
 * impact, etc.).
 */
export interface AudioSfxMessage {
  type: 'audioSfx';
  kind:
    | 'footstep'
    | 'magicImpact'
    | 'mobHit'
    | 'gatherWater'
    | 'consume'
    | 'mobFootstep'
    | 'mobDeath'
    | 'mushroomBounce';
  /** Optional intensity / variant — interpreted by audioBridge per kind. */
  intensity?: number;
  /** Set for `mobFootstep`, `mobDeath`, and `mobHit` when kind is known. */
  awakenedMobKind?: AwakenedMobKind;
  /** Optional world position for spatialization (currently unused; reserved). */
  worldX?: number;
  worldY?: number;
  worldZ?: number;
}

/**
 * Acknowledgement that an in-place gather started via
 * {@link PlayGatherActionInPlaceMessage} has completed. `completionToken`
 * matches the request so main can dispatch to the correct callback.
 */
export interface GatherActionInPlaceCompleteMessage {
  type: 'gatherActionInPlaceComplete';
  completionToken: number;
}

/**
 * Worker emitted a custom DOM event that main should re-dispatch on `window`.
 * Used for `vibejam-portal-exit` and `battle-player-death-done` — listeners
 * for these live on main (UI flow).
 */
export interface WindowCustomEventMessage {
  type: 'windowCustomEvent';
  eventName: string;
  /** Stringified detail payload, parsed on main before dispatch. */
  detailJson?: string;
}

/**
 * Worker WebGL context was lost. Main should warn the user and may attempt
 * to recreate the canvas + worker.
 */
export interface ContextLostMessage {
  type: 'contextLost';
}

/** Diagnostic log line — surfaces in main's console with worker prefix. */
export interface LogMessage {
  type: 'log';
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** Sub-progress while worker runs {@link AttachGameplayLayersMessage}. */
export interface GameplayAttachProgressMessage {
  type: 'gameplayAttachProgress';
  fraction: number;
  phase: string;
}

/** Worker finished (or skipped) gameplay attach — one per `attachGameplayLayers` request. */
export interface GameplayAttachDoneMessage {
  type: 'gameplayAttachDone';
  ok: boolean;
  error?: string;
}

/**
 * Serializable free-roam world fields after worker gameplay attach — lets main
 * build {@link CharacterSceneHost.getFreeRoamHandles} without a second
 * `CharacterScenePreview` (shadow) scene.
 */
export interface FreeRoamWorldForMainMessage {
  type: 'freeRoamWorldForMain';
  mapRadius: number;
  crystalSpotsXZ: { x: number; z: number }[];
  forestStaticObstacles: ForestStaticObstacle[];
  resolvedCreeks: ResolvedCreek[];
  dockXZ: { x: number; z: number };
  crystalClusterPlaceholders: { x: number; y: number; z: number; index: number }[];
}

/** Data-only payload (no discriminant) — stored on {@link WorkerBridge} after the message. */
export type FreeRoamWorldForMainPayload = Omit<FreeRoamWorldForMainMessage, 'type'>;

/**
 * Full mob roster mirror for main `GameStore` / HUD when the worker owns
 * awakened combat simulation (Wave 1 migration).
 */
export interface AwakenedMobsAuthoritySnapshotMessage {
  type: 'awakenedMobsAuthoritySnapshot';
  mobs: AwakenedMobInstance[];
  mobCounter: number;
}

/** Worker mob AI / combat notified main of a player-originated hit (floaters, loot). */
export interface AwakenedMobDamagedMessage {
  type: 'awakenedMobDamaged';
  mob: AwakenedMobInstance;
  amount: number;
  killed: boolean;
  source?: 'melee' | 'magic';
}

/** Mob melee hit applied on worker — main applies block reduction + vitals. */
export interface AwakenedPlayerDamagedMessage {
  type: 'awakenedPlayerDamaged';
  amount: number;
  sourceKind: string;
}

/** Worker finished skinning — main grants meat + floaters (mirrors melee loot path). */
export interface AwakenedCorpseSkinLootMessage {
  type: 'awakenedCorpseSkinLoot';
  id: number;
  kind: AwakenedMobKind;
  meat: number;
  x: number;
  y: number;
  z: number;
}

export type WorkerMobAuthorityMessage =
  | AwakenedMobsAuthoritySnapshotMessage
  | AwakenedMobDamagedMessage
  | AwakenedPlayerDamagedMessage
  | AwakenedCorpseSkinLootMessage;

export type MainMessage =
  | ReadyMessage
  | AudioSfxMessage
  | GatherActionInPlaceCompleteMessage
  | WindowCustomEventMessage
  | ContextLostMessage
  | LogMessage
  | GameplayAttachProgressMessage
  | GameplayAttachDoneMessage
  | FreeRoamWorldForMainMessage
  | AwakenedMobsAuthoritySnapshotMessage
  | AwakenedMobDamagedMessage
  | AwakenedPlayerDamagedMessage
  | AwakenedCorpseSkinLootMessage;

/* ============================================================================
 * Exhaustiveness helper
 * ============================================================================ */

/**
 * Use this in default branches of switch statements over WorkerMessage /
 * MainMessage to fail the TypeScript build if a new variant is added without
 * a handler.
 *
 * @example
 *   switch (msg.type) {
 *     case 'init': handleInit(msg); break;
 *     // ...
 *     default: assertNever(msg);
 *   }
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled message variant: ${JSON.stringify(value)}`);
}
