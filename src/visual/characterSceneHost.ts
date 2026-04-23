/**
 * CharacterSceneHost — main-thread shell for the worker-rendered scene.
 *
 * This is the main-thread analog of `CharacterScenePreview`. It:
 *
 *   - Owns the actual `<canvas>` in the DOM.
 *   - Transfers rendering control to the worker via `transferControlToOffscreen`.
 *   - Forwards container resize events to the worker.
 *   - Forwards canvas pointer/wheel events to the worker via `WorkerBridge`.
 *   - Hosts DOM overlays that previously lived inside `CharacterScenePreview`
 *     (damage floaters, presence HUD, magical reticle) — these read from
 *     `SharedRenderState` for camera/avatar projection.
 *   - Exposes the same public API surface as `CharacterScenePreview` so
 *     existing callers (`mountApp.ts`, `dockPreload.ts`, etc.) can be
 *     swapped over with a one-line factory change.
 *
 * **Status:** This host is used only when the app opts into the worker dock
 * (`?worker=1` + `isWorkerRenderCapable()`; see `capabilityGate.ts` and
 * `docs/WORKER_VS_LEGACY_PATH.md`). Default product behavior is legacy
 * `CharacterScenePreview` on the main thread. `?dockGame=0` can force legacy-style
 * consume when the worker preview path is enabled.
 *
 * **Lifecycle**:
 *   1. `await CharacterSceneHost.create(container, { ... })`
 *   2. Use the returned host's methods (forwards to worker).
 *   3. `host.dispose()` — disposes worker + DOM.
 */

import * as THREE from 'three';
import type { EquipmentState, PlacedCabinPiece, PlacedCraftStation } from '../core/types';
import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';
import { WorkerBridge } from '../worker/workerBridge';
import { SharedRenderState, FLAG, KEY_BIT } from '../worker/sharedState';
import { fillPerspectiveCameraFromSharedState } from '../worker/dockSharedRenderReadback';
import { isWorkerRenderCapable } from '../worker/capabilityGate';
import type { WorkerInputForwarderHandle } from '../world/workerInputForwarder';
import type { AudioSfxMessage } from '../worker/protocol';
import type { WorkerMobAuthorityHandler } from '../worker/workerBridge';
import { createHeightSampler, isWaterAtFromResolvedCreeks } from '../world/idleCraftHeightfield';
import { parseWorldFromProject } from '../world/idleCraftWorldTypes';
import { getDockGatherClipDurationMs, getDockGatherSfxDelayMs } from './dockGatherClipDurations';
import type { ForestStaticObstacle } from './forestEnvironment';
import type { AppPageContext } from './characterScenePreview';
import type { HarvestNodeKind } from '../world/idleCraftHarvestNodes';
import type { ResolvedCreek } from '../world/idleCraftHeightfield';

/** Mirrors {@link CharacterScenePreview.getFreeRoamHandles} return shape. */
export type CharacterSceneHostFreeRoam = {
  canvas: HTMLCanvasElement;
  avatar: THREE.Group;
  getTerrainHeight: (x: number, z: number) => number;
  mapRadius: number;
  crystalSpotsXZ: { x: number; z: number }[];
  crystalClusters: { x: number; z: number; group: THREE.Group }[];
  isWaterAt: (x: number, z: number) => boolean;
  forestStaticObstacles: ForestStaticObstacle[];
  resolvedCreeks: ResolvedCreek[];
  dockXZ: { x: number; z: number };
};

export interface CharacterSceneHostOptions {
  /** Resolved graphics tier from `graphicsTier.ts`. */
  graphicsTier: 'low' | 'perf' | 'balanced' | 'cinematic';
  /** Stringified empire-engine project (matches what worker expects). */
  projectJson: string;
  /** Optional audio sink — use {@link routeWorkerAudioSfx} for worker SFX. */
  onAudioSfx?: (msg: AudioSfxMessage) => void;
  /** True if worker should defer starting its rAF loop. */
  runHeadless?: boolean;
  /**
   * When true, attach `window` keyboard + pointer-lock mouse-move listeners that
   * write into {@link SharedRenderState} (Step 7 forwarder). Detached in {@link dispose}.
   * Use for title worker dock; disable if another layer owns the same listeners.
   */
  attachWindowKeyboardMouseForwarders?: boolean;
}

export class CharacterSceneHost {
  private torchInventoryHas = false;
  private torchEquippedPref = true;

  /** The DOM canvas (kept on main; rendering control transferred to worker). */
  readonly canvas: HTMLCanvasElement;
  /** The container element this host was mounted into. */
  private container: HTMLElement;
  private bridge: WorkerBridge;
  /** Live state read from worker via SAB — no postMessage round-trip. */
  readonly sharedState: SharedRenderState;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  /** Bound canvas event handlers (kept as fields so we can remove them on dispose). */
  private onPointerDown: (e: PointerEvent) => void;
  private onPointerMove: (e: PointerEvent) => void;
  private onPointerUp: (e: PointerEvent) => void;
  private onPointerCancel: (e: PointerEvent) => void;
  private onWheel: (e: WheelEvent) => void;
  private onContextMenu: (e: MouseEvent) => void;
  private onDblClick: (e: MouseEvent) => void;
  private inputForwarderHandle: WorkerInputForwarderHandle | null = null;
  private readonly projectJson: string;
  private clipSpeedMultiplier = 1;
  private utilityRenderer: THREE.WebGLRenderer | null = null;
  private freeRoamHandlesCache: CharacterSceneHostFreeRoam | null = null;

  /**
   * Main-thread `THREE.Scene` for gameplay layers (cabin, harvest, dock-forest, …)
   * while the visible dock is worker-rendered.
   */
  readonly scene: THREE.Scene;
  /** For shader warm + ray helpers — pose syncs from SAB in `fillProjectionCamera` callers. */
  readonly camera: THREE.PerspectiveCamera;
  /** Seeded at origin; `mountApp` syncs from worker SAB each frame when `workerOwnsAvatarMovement`. */
  readonly avatarProxy: THREE.Group;

  /**
   * Create + boot the host. Spawns the worker, transfers the canvas, awaits
   * worker `ready`. Throws if the browser is not worker-capable; callers
   * MUST gate on `isWorkerRenderCapable()` before calling.
   */
  static async create(
    container: HTMLElement,
    opts: CharacterSceneHostOptions,
  ): Promise<CharacterSceneHost> {
    if (!isWorkerRenderCapable()) {
      throw new Error(
        'CharacterSceneHost: browser lacks OffscreenCanvas + SharedArrayBuffer + crossOriginIsolated. ' +
          'Caller MUST check isWorkerRenderCapable() before invoking CharacterSceneHost.create.',
      );
    }
    const canvas = document.createElement('canvas');
    /* CSS sizing matches container; backing store sized by worker on resize. */
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    container.appendChild(canvas);

    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;

    const offscreen = canvas.transferControlToOffscreen();
    const bridge = await WorkerBridge.create(offscreen, opts.projectJson, {
      width,
      height,
      devicePixelRatio: dpr,
      graphicsTier: opts.graphicsTier,
      runHeadless: opts.runHeadless,
      onAudioSfx: opts.onAudioSfx,
      onWindowEvent: (eventName, detail) => {
        /* Re-dispatch worker-originated CustomEvents on main's window so
         * existing listeners (vibejam-portal-exit, battle-player-death-done)
         * still fire. */
        try {
          window.dispatchEvent(new CustomEvent(eventName, { detail }));
        } catch (err) {
          console.warn('[CharacterSceneHost] failed to re-dispatch', eventName, err);
        }
      },
      onContextLost: () => {
        console.error('[CharacterSceneHost] worker WebGL context lost');
        /* Phase 3.x: trigger main-side recovery — recreate canvas, respawn
         * worker. For scaffold we just log. */
      },
    });

    const host = new CharacterSceneHost(container, canvas, bridge, opts.projectJson);
    if (opts.attachWindowKeyboardMouseForwarders) {
      const { attachWorkerInputForwarders } = await import('../world/workerInputForwarder');
      host.inputForwarderHandle = attachWorkerInputForwarders(host);
    }
    return host;
  }

  private constructor(
    container: HTMLElement,
    canvas: HTMLCanvasElement,
    bridge: WorkerBridge,
    projectJson: string,
  ) {
    this.container = container;
    this.canvas = canvas;
    this.bridge = bridge;
    this.sharedState = bridge.sharedState;
    this.projectJson = projectJson;
    this.scene = new THREE.Scene();
    this.avatarProxy = new THREE.Group();
    this.scene.add(this.avatarProxy);
    this.camera = new THREE.PerspectiveCamera(44, 1, 0.1, 50000);
    this.fillProjectionCamera(this.camera);

    /* Container resize → worker resize (see {@link bindResizeObserverToContainer}). */
    this.bindResizeObserverToContainer(container);

    /* === Canvas pointer/wheel forwarding ===
     * Each handler converts the DOM event to a typed message via
     * `bridge.forwardPointerEvent` / `forwardWheelEvent`. These are EVENT
     * messages (sparse — only fires on actual interaction), so postMessage
     * latency doesn't matter. Hot per-frame keyboard state goes through
     * `SharedRenderState` instead (Phase 5). */
    this.onPointerDown = (e: PointerEvent) => this.forwardPointer('pointerdown', e);
    this.onPointerMove = (e: PointerEvent) => this.forwardPointer('pointermove', e);
    this.onPointerUp = (e: PointerEvent) => this.forwardPointer('pointerup', e);
    this.onPointerCancel = (e: PointerEvent) => this.forwardPointer('pointercancel', e);
    this.onWheel = (e: WheelEvent) => {
      const r = canvas.getBoundingClientRect();
      this.bridge.forwardWheelEvent(e.clientX - r.left, e.clientY - r.top, e.deltaX, e.deltaY, e.deltaMode);
    };
    this.onContextMenu = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      this.bridge.forwardPointerEvent('contextmenu', -1, e.clientX - r.left, e.clientY - r.top, e.buttons, false);
    };
    this.onDblClick = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      this.bridge.forwardPointerEvent('dblclick', -1, e.clientX - r.left, e.clientY - r.top, e.buttons, false);
    };

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('wheel', this.onWheel, { passive: true });
    canvas.addEventListener('contextmenu', this.onContextMenu);
    canvas.addEventListener('dblclick', this.onDblClick);
  }

  /** Worker backing-store size tracks the observed element's content box. */
  private bindResizeObserverToContainer(el: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.disposed) return;
      const rect = this.container.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;
      this.bridge.resize(w, h, dpr);
    });
    this.resizeObserver.observe(el);
  }

  private forwardPointer(
    type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
    e: PointerEvent,
  ): void {
    const r = this.canvas.getBoundingClientRect();
    this.bridge.forwardPointerEvent(
      type,
      e.pointerId,
      e.clientX - r.left,
      e.clientY - r.top,
      e.buttons,
      this.canvas.hasPointerCapture(e.pointerId),
    );
  }

  /* ============================================================================
   * Public API — forwards to bridge. Mirrors `CharacterScenePreview`.
   *
   * State mutations (setters) → postMessage forward.
   * Live getters → SharedState read (no IPC).
   * ============================================================================ */

  /* ----- Live getters (SAB-backed; zero IPC) ----- */

  getAvatarGroundXZ(): { x: number; z: number } {
    return { x: this.sharedState.getAvatarX(), z: this.sharedState.getAvatarZ() };
  }

  /**
   * Match {@link CharacterScenePreview.getCameraYawPitch}: orbit offsets in free-cursor
   * mode; live camera yaw/pitch when pointer-lock (camera-lock) is active — so lock-on
   * and camera-lock math match legacy semantics.
   */
  getCameraYawPitch(): { yaw: number; pitch: number } {
    /* Match {@link CharacterScenePreview.getCameraYawPitch}: always orbit targets, including
     * when Q-lock is on — `cameraLockController` integrates deltas into the same field the
     * solo framing pass reads (not display Euler on the perspective camera). */
    return {
      yaw: this.sharedState.getDockOrbitYaw(),
      pitch: this.sharedState.getDockOrbitPitch(),
    };
  }

  getCameraForwardXZ(): { x: number; z: number } {
    return { x: this.sharedState.getCameraForwardX(), z: this.sharedState.getCameraForwardZ() };
  }

  getStaffTipWorldPosition(): { x: number; y: number; z: number } {
    return {
      x: this.sharedState.getStaffTipX(),
      y: this.sharedState.getStaffTipY(),
      z: this.sharedState.getStaffTipZ(),
    };
  }

  getGatherClipProgress01(): number {
    return this.sharedState.getGatherProgress01();
  }

  getGatherWaterBankXZ(): { x: number; z: number } {
    return { x: this.sharedState.getWaterBankX(), z: this.sharedState.getWaterBankZ() };
  }

  isAirborne(): boolean {
    return this.sharedState.hasFlag(FLAG.AIRBORNE);
  }

  /**
   * Fill a throwaway `PerspectiveCamera` from SAB — same pose the worker used
   * for the last frame. For DOM overlays (`damageFloaters`) when no main-thread
   * `scenePreview.camera` exists.
   */
  fillProjectionCamera(cam: THREE.PerspectiveCamera): void {
    fillPerspectiveCameraFromSharedState(this.sharedState, cam);
  }

  /**
   * Tiny offscreen GL for `warmShaders` / `compile` — the visible frame is
   * rendered in the worker; this is compile-target only.
   */
  get renderer(): THREE.WebGLRenderer {
    if (!this.utilityRenderer) {
      const c = document.createElement('canvas');
      c.width = 2;
      c.height = 2;
      const r = new THREE.WebGLRenderer({ canvas: c, antialias: false, alpha: true });
      r.setPixelRatio(1);
      this.utilityRenderer = r;
    }
    return this.utilityRenderer;
  }

  getFreeRoamHandles(): CharacterSceneHostFreeRoam {
    if (this.freeRoamHandlesCache) return this.freeRoamHandlesCache;
    const w = this.bridge.getFreeRoamWorldForMain();
    if (!w) {
      throw new Error(
        '[CharacterSceneHost] free-roam world snapshot missing — is gameplay attach still running?',
      );
    }
    const project: IdleEmpireProjectFile = JSON.parse(this.projectJson);
    const { terrain } = parseWorldFromProject(project);
    const getTerrainHeight = createHeightSampler(terrain, w.resolvedCreeks);
    const isWaterAt = (x: number, z: number) => isWaterAtFromResolvedCreeks(x, z, w.resolvedCreeks);
    const crystalClusters: { x: number; z: number; group: THREE.Group }[] = [];
    for (const ph of w.crystalClusterPlaceholders) {
      const g = new THREE.Group();
      g.position.set(ph.x, ph.y, ph.z);
      g.userData.dockCrystalIndex = ph.index;
      this.scene.add(g);
      crystalClusters.push({ x: ph.x, z: ph.z, group: g });
    }
    this.freeRoamHandlesCache = {
      canvas: this.canvas,
      avatar: this.avatarProxy,
      getTerrainHeight,
      mapRadius: w.mapRadius,
      crystalSpotsXZ: w.crystalSpotsXZ,
      crystalClusters,
      isWaterAt,
      forestStaticObstacles: w.forestStaticObstacles,
      resolvedCreeks: w.resolvedCreeks,
      dockXZ: w.dockXZ,
    };
    return this.freeRoamHandlesCache;
  }

  getGatherClipDurationMs(actionId: string): number {
    return getDockGatherClipDurationMs(actionId, this.clipSpeedMultiplier);
  }

  getGatherSfxDelayMs(actionId: string): number {
    return getDockGatherSfxDelayMs(actionId, this.clipSpeedMultiplier);
  }

  getAwakenPresencePose(): { x: number; y: number; z: number; yaw: number } | null {
    if (!this.sharedState.hasFlag(FLAG.AWAKENED)) return null;
    return {
      x: this.sharedState.getAvatarX(),
      y: this.sharedState.getAvatarY(),
      z: this.sharedState.getAvatarZ(),
      /* Body yaw is not on SAB yet — camera yaw is a serviceable stand-in for co-op culling. */
      yaw: this.sharedState.getCameraYaw(),
    };
  }

  showDamageFloater(text: string, kind: 'enemy' | 'player'): void {
    const el = document.createElement('div');
    el.className = `character-dmg-floater character-dmg-floater--${kind}`;
    el.textContent = text;
    this.container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('character-dmg-floater--lift'));
    setTimeout(() => el.remove(), 950);
  }

  /** No-op for worker dock — foot snap is owned by the worker's locomotion. */
  setSurfaceYProvider(_provider: (() => number | null) | null): void {}

  /* ----- Setters → postMessage forward (mirror CharacterScenePreview API) ----- */

  applyCharacterPreset(presetId: string): void {
    this.bridge.applyCharacterPreset(presetId);
  }

  syncEquipment(eq: EquipmentState): void {
    this.bridge.syncEquipment(eq.weapon, eq.pick, eq.shield);
  }

  setTorchInventory(hasTorch: boolean): void {
    this.torchInventoryHas = hasTorch;
    this.bridge.setTorchInventory(hasTorch, this.torchEquippedPref);
  }

  setTorchEquipped(equipped: boolean): void {
    this.torchEquippedPref = equipped;
    this.bridge.setTorchInventory(this.torchInventoryHas, equipped);
  }

  setCraftDecorAvailability(campfire: boolean, workbench: boolean): void {
    this.bridge.setCraftDecorAvailability(campfire, workbench);
  }

  setPageContext(page: AppPageContext | (string & {})): void {
    const m: Record<AppPageContext, 'gather' | 'craft' | 'portal' | 'home' | 'battle' | 'lobby'> = {
      gather: 'gather',
      craft: 'craft',
      portal: 'portal',
      battle: 'battle',
      inventory: 'home',
      decks: 'home',
      idle: 'home',
      rpg: 'home',
      hire: 'home',
    };
    if (page === 'awakening') {
      this.bridge.setPageContext('home');
      return;
    }
    const key = page as AppPageContext;
    this.bridge.setPageContext(m[key] ?? 'home');
  }

  setUserCameraZoomEnabled(enabled: boolean): void {
    this.bridge.setUserCameraZoomEnabled(enabled);
  }

  resetDockCameraView(): void {
    this.bridge.resetDockCameraView();
  }

  setCameraYawPitch(yaw: number, pitch: number): void {
    this.bridge.setCameraYawPitch(yaw, pitch);
  }

  setCameraLockActive(active: boolean): void {
    this.bridge.setCameraLockActive(active);
    /* Reflect into SharedState immediately so the worker's input reader
     * sees the change without waiting for the postMessage to land. */
    if (active) this.sharedState.setFlags(FLAG.CAMERA_LOCKED);
    else this.sharedState.clearFlags(FLAG.CAMERA_LOCKED);
  }

  setFreeRoamAirborne(airborne: boolean): void {
    this.bridge.setFreeRoamAirborne(airborne);
    if (airborne) this.sharedState.setFlags(FLAG.AIRBORNE);
    else this.sharedState.clearFlags(FLAG.AIRBORNE);
  }

  setAwakenedFreeRoam(active: boolean): void {
    this.bridge.setAwakenedFreeRoam(active);
    if (active) this.sharedState.setFlags(FLAG.AWAKENED);
    else this.sharedState.clearFlags(FLAG.AWAKENED);
  }

  setAwakenedRenderBudget(awakened: boolean): void {
    this.bridge.setAwakenedRenderBudget(awakened);
  }

  applyDockPostProcessing(): void {
    this.bridge.applyDockPostProcessing();
  }

  applyDockRendererDisplay(): void {
    this.bridge.applyDockRendererDisplay();
  }

  syncGatherRpgVisuals(
    _toward: Partial<Record<HarvestNodeKind, number>>,
    _clip: Partial<Record<HarvestNodeKind, number>>,
  ): void {
    /* Per-kind maps are not on the wire yet; deck gather parity is main `CharacterScenePreview`. */
  }

  setClipSpeedMultiplier(multiplier: number): void {
    this.clipSpeedMultiplier = Math.max(0.25, Math.min(4, multiplier));
    this.bridge.setClipSpeedMultiplier(multiplier);
  }

  playGatherAction(actionId: string, harvestSlot?: number): void {
    this.bridge.playGatherAction(actionId, harvestSlot);
  }

  playGatherActionInPlace(actionId: string, onComplete?: () => void): void {
    this.bridge.playGatherActionInPlace(actionId, onComplete);
  }

  playInPlaceCombatClip(clip: 'cast' | 'strike'): void {
    this.bridge.playInPlaceCombatClip(clip);
  }

  /* ============================================================================
   * SharedState input forwarding helpers (Phase 5 will re-house in
   * freeRoamControls/cameraLockController; exposing them here lets the
   * scaffolded worker path receive keyboard immediately).
   * ============================================================================ */

  /** Map a keyboard event's `code` to a KEY_BIT and write to SharedState. */
  setKeyDownByCode(code: string): void {
    const bit = keyCodeToBit(code);
    if (bit !== 0) this.sharedState.setKeyDown(bit);
  }

  setKeyUpByCode(code: string): void {
    const bit = keyCodeToBit(code);
    if (bit !== 0) this.sharedState.setKeyUp(bit);
  }

  /** `window.blur` handler — drop all key state to prevent stuck-key bugs. */
  clearAllKeys(): void {
    this.sharedState.clearAllKeys();
  }

  /** Pointer-lock movement deltas accumulate; worker drains per frame. */
  addMouseLookDelta(dx: number, dy: number): void {
    this.sharedState.addMouseDelta(dx, dy);
  }

  setPointerLockActive(active: boolean): void {
    this.sharedState.setPointerLockActive(active);
  }

  /**
   * Move the canvas into a new container (same contract as
   * {@link CharacterScenePreview.reparent} for dock preload → mountApp handoff).
   */
  reparent(newContainer: HTMLElement): void {
    if (this.disposed || newContainer === this.container) return;
    newContainer.appendChild(this.canvas);
    this.container = newContainer;
    this.bindResizeObserverToContainer(newContainer);
    const rect = this.container.getBoundingClientRect();
    this.bridge.resize(
      Math.max(1, Math.floor(rect.width)),
      Math.max(1, Math.floor(rect.height)),
      window.devicePixelRatio || 1,
    );
  }

  /**
   * Worker-side gameplay attach (collision, dock forest batch, harvest, cabin,
   * craft, projectiles, ward, mushrooms) — mirrors `dockExtendedPreload` on main.
   */
  attachGameplayLayers(onProgress?: (fraction: number, phase: string) => void): Promise<void> {
    return this.bridge.attachGameplayLayers(onProgress);
  }

  /**
   * Forward dream-mode `pveWave` for worker mob spawn mix (`pickMobKind`).
   * Safe to call every store tick; cheap postMessage.
   */
  syncPveWaveForMobs(pveWave: number): void {
    if (this.disposed) return;
    this.bridge.syncPveWaveForWorker(pveWave);
  }

  /** Mob proxy + other main→worker gameplay helpers (`mountApp` worker dock path). */
  getWorkerBridge(): WorkerBridge {
    return this.bridge;
  }

  /**
   * Keep worker-scene cabin build meshes in sync with {@link GameStore} while a
   * hidden main-thread companion preview still runs deck choreography (Phase 3.x-C shadow diet).
   */
  syncCabinPiecesFromMain(pieces: ReadonlyArray<PlacedCabinPiece>): void {
    if (this.disposed) return;
    this.bridge.syncCabinPiecesFromMain(pieces);
  }

  /** Same as {@link syncCabinPiecesFromMain} for craft stations. */
  syncCraftStationsFromMain(stations: ReadonlyArray<PlacedCraftStation>): void {
    if (this.disposed) return;
    this.bridge.syncCraftStationsFromMain(stations);
  }

  applyDockForestHitOnWorker(kind: string, nodeIndex: number, hitsMult: number): void {
    if (this.disposed) return;
    this.bridge.applyDockForestHitOnWorker(kind, nodeIndex, hitsMult);
  }

  applyFreeRoamHarvestHitOnWorker(kind: string, nodeIndex: number, hitsMult: number): void {
    if (this.disposed) return;
    this.bridge.applyFreeRoamHarvestHitOnWorker(kind, nodeIndex, hitsMult);
  }

  /** Parity with {@link CharacterScenePreview.spawnAwakenedHitBlood} — worker VFX TBD. */
  spawnAwakenedHitBlood(x: number, faceY: number, z: number, intensity: number): void {
    if (this.disposed) return;
    this.bridge.spawnAwakenedHitBlood(x, faceY, z, intensity);
  }

  /** Re-read DPR + backing-store size (system menu tier / window moves). */
  refreshPixelRatio(): void {
    if (this.disposed) return;
    const rect = this.container.getBoundingClientRect();
    this.bridge.resize(
      Math.max(1, Math.floor(rect.width)),
      Math.max(1, Math.floor(rect.height)),
      window.devicePixelRatio || 1,
    );
  }

  /**
   * Receive worker-owned awakened mob roster sync + hit / player-damage events.
   * Set to `null` to detach.
   */
  setWorkerMobAuthoritySink(handler: WorkerMobAuthorityHandler | null): void {
    this.bridge.setMobAuthoritySink(handler);
  }

  playCraftHammer(station?: string, recipeId?: string): void {
    this.bridge.playCraftHammer(station, recipeId);
  }

  playBattleAction(cardId: string): void {
    this.bridge.playBattleAction(cardId);
  }

  playBattleEnemyStrike(): void {
    this.bridge.playBattleEnemyStrike();
  }

  queueBattleEnemyDeathAfterKill(): void {
    this.bridge.queueBattleEnemyDeathAfterKill();
  }

  playBattlePlayerDeath(): void {
    this.bridge.playBattlePlayerDeath();
  }

  resetDockAfterPermadeath(): void {
    this.bridge.resetDockAfterPermadeath();
  }

  setResourceHover(resourceKey: string | null): void {
    this.bridge.setResourceHover(resourceKey);
  }

  syncBattleContext(enemyId: string | null): void {
    this.bridge.syncBattleContext(enemyId);
  }

  syncOnlinePresence(
    presence: unknown,
    selfSessionId: string | null,
    roster: unknown,
    opts: unknown,
  ): void {
    this.bridge.syncOnlinePresence(presence, selfSessionId ?? '', roster, opts);
  }

  syncPvpDockRivalPreset(presetId: string): void {
    this.bridge.syncPvpDockRivalPreset(presetId);
  }

  setHunterSharedWorldActive(active: boolean, guestSeat = false): void {
    this.bridge.setHunterSharedWorldActive(active, guestSeat ? 1 : 0);
  }

  setPvpDuelDockLayout(
    mode: 'off' | 'duel' | 'bracket',
    aliveInRoom = 2,
    duelGuestSeat = false,
  ): void {
    this.bridge.setPvpDuelDockLayout(
      mode,
      aliveInRoom,
      typeof duelGuestSeat === 'boolean' ? (duelGuestSeat ? 1 : 0) : duelGuestSeat,
    );
  }

  setStaffPriorityVisible(visible: boolean): void {
    this.bridge.setStaffPriorityVisible(visible);
  }

  cancelCameraDrag(): void {
    this.bridge.cancelCameraDrag();
  }

  relevelAvatarFeetAfterEquipmentSync(): void {
    this.bridge.relevelAvatarFeetAfterEquipmentSync();
  }

  playEquipAdjust(): void {
    this.bridge.playOneShot('equipAdjust');
  }

  playEatCookedMeat(): void {
    this.bridge.playOneShot('eatCookedMeat');
  }

  playEatBerriesSnack(): void {
    this.bridge.playOneShot('eatBerriesSnack');
  }

  playDrinkWater(): void {
    this.bridge.playOneShot('drinkWater');
  }

  playBandage(): void {
    this.bridge.playOneShot('bandage');
  }

  playStim(): void {
    this.bridge.playOneShot('stim');
  }

  playRepairItem(): void {
    this.bridge.playOneShot('repairItem');
  }

  playHireWave(): void {
    this.bridge.playOneShot('hireWave');
  }

  playDeckUnlock(): void {
    this.bridge.playOneShot('deckUnlock');
  }

  /* ============================================================================
   * Lifecycle
   * ============================================================================ */

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.freeRoamHandlesCache = null;
    this.utilityRenderer?.dispose();
    this.utilityRenderer = null;
    this.bridge.setMobAuthoritySink(null);
    this.inputForwarderHandle?.detach();
    this.inputForwarderHandle = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancel);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('dblclick', this.onDblClick);

    await this.bridge.dispose();
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }
}

/**
 * KeyboardEvent.code → KEY_BIT lookup. Centralized here so both Phase 3
 * scaffold (above) and Phase 5 input refactor share the same mapping.
 *
 * Returns 0 for keys not tracked by gameplay (UI keys like Escape, Tab
 * stay handled by main listeners separately).
 */
export function keyCodeToBit(code: string): number {
  switch (code) {
    case 'KeyW':
      return KEY_BIT.W;
    case 'KeyA':
      return KEY_BIT.A;
    case 'KeyS':
      return KEY_BIT.S;
    case 'KeyD':
      return KEY_BIT.D;
    case 'Space':
      return KEY_BIT.SPACE;
    case 'ShiftLeft':
    case 'ShiftRight':
      return KEY_BIT.SHIFT;
    case 'KeyE':
      return KEY_BIT.E;
    case 'KeyQ':
      return KEY_BIT.Q;
    case 'KeyR':
      return KEY_BIT.R;
    case 'KeyF':
      return KEY_BIT.F;
    case 'ArrowUp':
      return KEY_BIT.ARROW_UP;
    case 'ArrowDown':
      return KEY_BIT.ARROW_DOWN;
    case 'ArrowLeft':
      return KEY_BIT.ARROW_LEFT;
    case 'ArrowRight':
      return KEY_BIT.ARROW_RIGHT;
    default:
      return 0;
  }
}
