/**
 * CharacterSceneController — worker-side owner of the WebGL scene.
 *
 * This is the worker-side analog of `src/visual/characterScenePreview.ts`,
 * minus everything DOM-coupled (event listeners, presence HUD, damage
 * floaters, container resize observer, body class toggles, audio playback).
 * Each public method maps 1:1 to a `WorkerMessage` variant in
 * `./protocol.ts` and to the same-named method on the legacy
 * `CharacterScenePreview` so the migration is mechanical.
 *
 * **Phase 3.x / Steps 4–5:** `initWebGL(projectJson)` builds dock environment,
 * terrain/water, forest phases, vanguard hero + staff orb, post-processing, GPU warm;
 * each `update()` writes live avatar / camera / staff tip / water bank / tone
 * exposure / gameplay flags into `SharedRenderState` (gather clip fields stubbed
 * until worker plays gather animations).
 *
 * **Still deferred:** equipment props, gather rig + clip progress — see
 *   `docs/WORKER_MIGRATION_PHASE_3X.md` Step 6+.
 *
 * **Why ship the scaffold now**: Phase 3's full migration is multi-session
 * work. Shipping the scaffold means:
 *   - The host (`characterSceneHost.ts`) compiles + runs end-to-end against
 *     a real worker behind `?worker=1`.
 *   - The default path stays on legacy `CharacterScenePreview` (no risk).
 *   - Future incremental builds populate stub methods one at a time, each
 *     visibly improving worker-mode parity, without touching the host
 *     surface or message protocol.
 */

import * as THREE from 'three';
import { PostProcessingStack } from 'empire-engine/render/PostProcessingStack';
import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';
import type { GraphicsBudget } from '../engine/graphicsTier';
import { graphicsBudgetForWorkerTier } from '../engine/graphicsTier';
import { createNightGradePass, syncNightGradeUniforms } from '../engine/nightGradePass';
import {
  applyPostProcessingOptionsToStack,
  getEffectivePostProcessingOptionsForPreview,
  isPostProcessingEnabled,
} from '../engine/postProcessingFromProject';
import { getEffectiveRendererDisplay } from '../engine/rendererDisplaySettings';
import { createRendererAsync } from '../engine/createIdleWebGLRenderer';
import type { IdleCraftDockEnvironment } from '../world/idleCraftDockEnvironment';
import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import {
  type WorkerMessage,
  type MainMessage,
  type PointerEventMessage,
} from './protocol';
import { SharedRenderState, FLAG } from './sharedState';
import {
  yieldToEventLoop,
  schedulePostTaskCancellable,
  type CancellablePostTask,
} from '../util/mainThreadYield';
import { attachDockForestBackdropForestPhases } from '../visual/forestEnvironment';
import {
  runDockGameplayAttachShared,
  disposeDockGameplayAttachHandles,
  type DockExtendedPreloadHandles,
  type DockGameplayAttachFreeRoamFields,
} from '../engine/dockGameplayAttachShared';
import { readDockSpawn } from '../world/idleCraftWorldTypes';
import { attachWorkerDockHeroLpcaSlice } from './attachWorkerDockHeroLpcaSlice';
import {
  attachWorkerDockTerrainWaterSlice,
  bootstrapDockEnvironmentAndSky,
} from './bootstrapDockSceneSlice';
import type { VanguardStaffOrbVfxHandle } from '../visual/vanguardStaffOrbVfx';
import { waterGatherBankXZ } from '../world/idleCraftHeightfield';
import { applySoloDockCameraFraming } from '../world/dockSoloCameraFraming';
import { WorkerAwakenedLocomotion } from './workerAwakenedLocomotion';
import { attachAwakenedMobs, type AwakenedMobsHandle } from '../world/awakenedMobs';
import { createWorkerAwakenedMobAuthorityStore } from './workerAwakenedMobAuthorityStore';

interface WorkerSelfMin {
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

export class CharacterSceneController {
  /* ----- Owned resources ----- */
  private readonly canvas: OffscreenCanvas;
  private readonly sharedState: SharedRenderState;
  /**
   * Post a message back to main. Phase 3 scaffold doesn't yet emit any
   * worker→main events; Phase 3.x wires audio SFX, gather completion,
   * and window CustomEvent re-dispatch through this.
   */
  private readonly postMain: (msg: MainMessage) => void;
  /** Initial tier from worker `init`; updated by `setGraphicsTier` for post-stack + budget parity. */
  private graphicsTier: 'low' | 'perf' | 'balanced' | 'cinematic';

  /* ----- Scene + GL ----- */
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer | null = null;
  private glInited = false;

  /** Step 4 — dock sky + day/night environment + terrain + forest + hero. */
  private dockEnvironment: IdleCraftDockEnvironment | null = null;
  private dockHemi: THREE.HemisphereLight | null = null;
  private ambientFill: THREE.AmbientLight | null = null;
  private dockKeyLight: THREE.DirectionalLight | null = null;
  private cameraFillLight: THREE.DirectionalLight | null = null;
  private mapRadius = 5.5;
  private empireProject: IdleEmpireProjectFile | null = null;
  /** Forest strata / crystal / night-magic tickers from {@link attachDockForestBackdropForestPhases}. */
  private forestSceneTickers: ((dt: number) => void)[] = [];
  private forestSceneDisposers: (() => void)[] = [];
  /** Populated after terrain + forest phases — feeds {@link runDockGameplayAttachShared}. */
  private dockFreeRoamForGameplayAttach: DockGameplayAttachFreeRoamFields | null = null;
  private gameplayAttachHandles: DockExtendedPreloadHandles | null = null;
  private gameplayAttachInFlight = false;
  private gameplayAttachAwaiters = 0;
  /** Dream-mode wave for worker mob spawn mix — mirrored from main via {@link syncPveWaveForWorker}. */
  private authorityPveWave = 0;
  private mobsHandle: AwakenedMobsHandle | null = null;
  private workerMobAuthority: ReturnType<typeof createWorkerAwakenedMobAuthorityStore> | null = null;
  private dockAvatar: THREE.Group | null = null;
  private vanguardWizardStaffRoot: THREE.Object3D | null = null;
  private staffOrbVfx: VanguardStaffOrbVfxHandle | null = null;
  private readonly _camForwardScratch = new THREE.Vector3();
  private readonly _staffTipScratch = new THREE.Vector3();
  private postProcessing: PostProcessingStack | null = null;
  private nightGradePass: ShaderPass | null = null;
  /** Matches {@link CharacterScenePreview.applyDockRendererDisplay} bake (`exposureRaw * 0.93`). */
  private baseToneMappingExposure = 0.82;
  /** Deferred shader warm — {@link CharacterScenePreview.deferDockGpuWarm} / `scheduleWarmRenderPipeline`. */
  private dockWarmDeferTask: CancellablePostTask | null = null;
  private dockWarmTask: CancellablePostTask | null = null;

  /* ----- Per-frame state ----- */
  private rafHandle = 0;
  private disposed = false;
  private lastFrameTime = 0;
  /** Increments each frame so SharedState liveness check moves. */
  private frameCount = 0;

  /* ----- State mirrors (populated as message handlers are wired) ----- */
  private currentPresetId: string | null = null;
  private equippedWeapon: string | null = null;
  private equippedPick: string | null = null;
  private equippedShield: string | null = null;
  private pageContext: string = 'home';
  private freeRoamAirborne = false;
  private cameraLockActive = false;
  private awakenedFreeRoam = false;
  private clipSpeedMultiplier = 1;
  /** Wheel zoom — smoothed like {@link CharacterScenePreview} dock camera. */
  private userCameraZoom = 1;
  private userCameraZoomTarget = 1;
  private static readonly DOCK_ZOOM_MIN = 0.2;
  private static readonly DOCK_ZOOM_MAX = 2.35;
  private static readonly DOCK_CAM_SMOOTH_RATE_ZOOM = 16;
  /** Orbit: same as {@link CharacterScenePreview.DOCK_CAM_SMOOTH_RATE_ORBIT} — display lerps to target. */
  private static readonly DOCK_CAM_SMOOTH_RATE_ORBIT = 22;
  /** FOV baseline before `(0.92 + 0.08 * zoom)` factor. */
  private dockCameraBaseFovDeg = 45;
  /**
   * Third-person orbit — mirrors `CharacterScenePreview` dockCamYaw / dockCamPitch
   * (smoothed display) and dockCamYawTarget / dockCamPitchTarget (LMB mutates
   * targets; {@link setCameraYawPitch} snaps all four for mouselock / lock).
   */
  private dockOrbitYaw = 0;
  private dockOrbitPitch = 0;
  private dockOrbitYawTarget = 0;
  private dockOrbitPitchTarget = 0;
  private orbitDrag = false;
  private orbitLastX = 0;
  private orbitLastY = 0;
  private static readonly DOCK_ORBIT_YAW_PER_PX = 0.0055;
  private static readonly DOCK_ORBIT_PITCH_PER_PX = 0.0045;
  /** Wave 0: SAB-driven movement when {@link awakenedFreeRoam} is true. */
  private readonly awakenedLocomotion = new WorkerAwakenedLocomotion();

  constructor(
    canvas: OffscreenCanvas,
    sharedState: SharedRenderState,
    graphicsTier: 'low' | 'perf' | 'balanced' | 'cinematic',
    postMain: (msg: MainMessage) => void,
  ) {
    this.canvas = canvas;
    this.sharedState = sharedState;
    this.graphicsTier = graphicsTier;
    this.postMain = postMain;

    /* Minimal scene + camera so the rAF loop has something to render once
     * the renderer is wired. Real construction (lights, environment,
     * character rig) lands in the Phase 3.x scene-attach pass. */
    this.scene = new THREE.Scene();
    /* Match {@link CharacterScenePreview} constructor: default 44° vertical, far plane
     * must clear skydome (~12k) + star shell — 200 clips the entire sky on worker. */
    this.camera = new THREE.PerspectiveCamera(44, canvas.width / Math.max(1, canvas.height), 0.1, 50000);
    this.dockCameraBaseFovDeg = this.camera.fov;
    this.camera.position.set(0, 1.2, 3.5);
    this.camera.lookAt(0, 1.0, 0);

    /* Mark worker-ready bit in shared state so main's liveness check sees
     * the controller is alive even before the renderer comes online. */
    this.sharedState.setFlags(FLAG.WORKER_READY);
  }

  /**
   * Create `WebGLRenderer` on the transferred `OffscreenCanvas`. Safe to call
   * from worker — `createIdleWebGLRenderer` has no DOM dependencies.
   * Idempotent: second call no-ops.
   *
   * @param projectJson — same payload as `InitMessage.projectJson`; drives dock environment + fog radii.
   */
  async initWebGL(projectJson: string): Promise<void> {
    if (this.glInited || this.disposed) return;

    let project: IdleEmpireProjectFile | null = null;
    try {
      project = JSON.parse(projectJson) as IdleEmpireProjectFile;
    } catch {
      project = null;
    }
    this.empireProject = project;

    const graphics = graphicsBudgetForWorkerTier(this.graphicsTier);
    const { dockEnvironment, hemi, mapRadius } = bootstrapDockEnvironmentAndSky(
      this.scene,
      project,
      graphics,
    );
    this.dockEnvironment = dockEnvironment;
    this.dockHemi = hemi;
    this.mapRadius = mapRadius;

    const terrainSlice = attachWorkerDockTerrainWaterSlice(
      this.scene,
      project,
      graphics,
      this.dockEnvironment,
    );
    await yieldToEventLoop();
    const dockPhases = await attachDockForestBackdropForestPhases(
      this.scene,
      project,
      graphics,
      this.dockEnvironment,
      terrainSlice.ground,
      terrainSlice.mapRadius,
      terrainSlice.resolved,
      terrainSlice.getHeightAt,
    );
    this.forestSceneTickers = dockPhases.sceneTickers;
    this.forestSceneDisposers = dockPhases.sceneDisposers;

    const dockSpawn = readDockSpawn(project);
    this.dockFreeRoamForGameplayAttach = {
      getTerrainHeight: terrainSlice.getHeightAt,
      mapRadius: terrainSlice.mapRadius,
      crystalSpotsXZ: dockPhases.crystalSpotsXZ,
      crystalClusters: dockPhases.crystalClusters,
      forestStaticObstacles: dockPhases.staticObstacles,
      resolvedCreeks: terrainSlice.resolved,
      dockXZ: { x: dockSpawn.homeX, z: dockSpawn.homeZ },
    };

    const { renderer } = await createRendererAsync({
      canvas: this.canvas,
      antialias: this.graphicsTier !== 'low',
      preferWebGPU: false,
    });
    this.renderer = renderer;
    renderer.setPixelRatio(1);
    renderer.setSize(this.canvas.width, this.canvas.height, false);
    renderer.shadowMap.enabled = true;

    this.attachDockKeyLighting(graphics);
    const heroSlice = attachWorkerDockHeroLpcaSlice(
      this.scene,
      this.camera,
      project,
      graphics,
      terrainSlice.getHeightAt,
      this.dockKeyLight,
    );
    this.dockAvatar = heroSlice.avatar;
    this.vanguardWizardStaffRoot = heroSlice.vanguardWizardStaffRoot;
    this.staffOrbVfx = heroSlice.staffOrbVfx;
    this.dockEnvironment.attachIbl(renderer);
    this.dockEnvironment.attachGodRays();
    this.attachCameraFillLight();
    if (this.cameraFillLight) {
      this.dockEnvironment.bindCameraFillLight(this.cameraFillLight);
    }
    this.applyDockRendererDisplay();
    this.dockEnvironment.update(0, project, this.camera);
    this.applyDockPostProcessing();

    this.glInited = true;
    this.deferWorkerGpuWarm();
  }

  /**
   * WebGL `compile` + one draw — {@link CharacterScenePreview.finalWarmCompileAndRender}.
   * Does not include craft/torch LPCA warm (worker dock omits those meshes).
   */
  private finalWarmCompileAndRender(): void {
    if (this.disposed || !this.renderer) return;
    const r = this.renderer as THREE.WebGLRenderer & { compile?: (s: THREE.Scene, c: THREE.Camera) => void };
    try {
      if (typeof r.compile === 'function') r.compile(this.scene, this.camera);
    } catch {
      /* WebGL2-only or unsupported */
    }
    try {
      if (this.postProcessing) this.postProcessing.render();
      else this.renderer.render(this.scene, this.camera);
    } catch {
      /* ignore */
    }
  }

  private cancelWorkerGpuWarm(which: 'defer' | 'pass' | 'both'): void {
    if (which === 'defer' || which === 'both') {
      this.dockWarmDeferTask?.cancel();
      this.dockWarmDeferTask = null;
    }
    if (which === 'pass' || which === 'both') {
      this.dockWarmTask?.cancel();
      this.dockWarmTask = null;
    }
  }

  /**
   * Offload shader compile off the init stack — {@link CharacterScenePreview.deferDockGpuWarm}
   * (`schedulePostTaskCancellable` background priority).
   */
  private deferWorkerGpuWarm(): void {
    if (this.disposed || !this.renderer) return;
    this.cancelWorkerGpuWarm('both');
    this.dockWarmDeferTask = schedulePostTaskCancellable(() => {
      this.dockWarmDeferTask = null;
      if (this.disposed) return;
      this.scheduleWorkerWarmRenderPipeline();
    }, 'background');
  }

  /**
   * Low tier: one warm pass. Other tiers: two passes in separate background tasks
   * (matches spread intent of {@link CharacterScenePreview.scheduleWarmRenderPipeline} without craft/torch builds).
   */
  private scheduleWorkerWarmRenderPipeline(): void {
    if (this.disposed || !this.renderer) return;
    const tier = graphicsBudgetForWorkerTier(this.graphicsTier).tier;
    if (tier === 'low') {
      this.finalWarmCompileAndRender();
      return;
    }
    const scheduleNext = (cb: () => void): void => {
      this.dockWarmTask = schedulePostTaskCancellable(() => {
        this.dockWarmTask = null;
        if (this.disposed) return;
        cb();
      }, 'background');
    };
    let pass = 0;
    const step = (): void => {
      if (this.disposed || !this.renderer) return;
      if (pass === 0) {
        this.finalWarmCompileAndRender();
        pass = 1;
        scheduleNext(step);
      } else {
        this.finalWarmCompileAndRender();
      }
    };
    scheduleNext(step);
  }

  /** Tone mapping, exposure, output color space, dock light multipliers — same data as legacy {@link CharacterScenePreview.applyDockRendererDisplay}. */
  private applyDockRendererDisplay(): void {
    if (!this.renderer || !this.dockEnvironment) return;
    const cfg = (this.empireProject?.config ?? {}) as Record<string, unknown>;
    const d = getEffectiveRendererDisplay(cfg);
    this.renderer.toneMapping = d.toneMapping;
    this.renderer.outputColorSpace = d.outputColorSpace;
    this.baseToneMappingExposure = d.exposureRaw * 0.93;
    this.dockEnvironment.setLightingMultipliers({
      sun: d.sunIntensity,
      ambient: d.ambientBrightness,
      hemi: d.hemisphereFill,
      moon: d.moonlightStrength,
      cameraFill: d.cameraFill,
      nightGrade: d.nightGradeStrength,
      sunShafts: d.sunShafts,
      envIntensity: d.envReflections,
    });
    this.renderer.toneMappingExposure =
      this.baseToneMappingExposure * (this.dockEnvironment.getExposureMultiplier() ?? 1);
  }

  /**
   * Post stack + night-grade pass — mirrors {@link CharacterScenePreview.applyDockPostProcessing}
   * (preview drawable size → worker canvas pixel size).
   */
  private applyDockPostProcessing(): void {
    if (!this.renderer || this.disposed) return;
    const cfg = (this.empireProject?.config ?? {}) as Record<string, unknown>;
    const graphics = graphicsBudgetForWorkerTier(this.graphicsTier);
    let opts = getEffectivePostProcessingOptionsForPreview(cfg, graphics.tier);
    const tier = getEffectiveRendererDisplay(cfg).awakenedQuality;
    if (tier === 'perf') {
      opts = {
        ...opts,
        bloom: true,
        ssao: false,
        bloomStrength: 0.18,
        bloomRadius: 0.18,
        bloomThreshold: 0.94,
      };
    } else if (tier === 'balanced') {
      opts = {
        ...opts,
        ssao: true,
        ssaoResolutionScale: 0.35,
        ssaoKernelSize: 8,
      };
    }
    const w = this.canvas.width;
    const h = this.canvas.height;
    const pr = this.renderer.getPixelRatio();
    if (!isPostProcessingEnabled(opts)) {
      this.postProcessing?.getComposer().dispose();
      this.postProcessing = null;
      this.nightGradePass = null;
      return;
    }
    if (!this.postProcessing) {
      this.postProcessing = new PostProcessingStack(this.renderer, this.scene, this.camera, opts);
    } else {
      applyPostProcessingOptionsToStack(this.postProcessing, opts, { width: w, height: h });
    }
    this.postProcessing.setSize(w, h, pr);
    this.ensureNightGradePass();
  }

  private ensureNightGradePass(): void {
    if (!this.postProcessing) {
      this.nightGradePass = null;
      return;
    }
    if (this.nightGradePass) return;
    const composer = this.postProcessing.getComposer();
    const pass = createNightGradePass();
    const passes = composer.passes;
    const vignetteIdx = passes.findIndex(
      (p) =>
        (p as { name?: string }).name === 'VignetteShader' ||
        ((p as { material?: { uniforms?: Record<string, unknown> } }).material?.uniforms?.['offset'] !==
          undefined &&
          (p as { material?: { uniforms?: Record<string, unknown> } }).material?.uniforms?.['darkness'] !==
            undefined),
    );
    if (vignetteIdx >= 0) composer.insertPass(pass, vignetteIdx);
    else composer.addPass(pass);
    this.nightGradePass = pass;
  }

  private syncPostProcessingDrawSize(): void {
    if (!this.renderer || !this.postProcessing) return;
    this.postProcessing.setSize(this.canvas.width, this.canvas.height, this.renderer.getPixelRatio());
  }

  private attachDockKeyLighting(graphics: GraphicsBudget): void {
    if (!this.dockEnvironment) return;
    const ambientFill = new THREE.AmbientLight(0x6a7a72, 0.4);
    this.scene.add(ambientFill);
    this.ambientFill = ambientFill;

    const sunDir = this.dockEnvironment.getSunDirection(new THREE.Vector3());
    const key = new THREE.DirectionalLight(0xfff2dd, 1.52);
    key.position.copy(sunDir.clone().multiplyScalar(6));
    key.target.position.set(0, 0.1, 0);
    this.scene.add(key.target);
    key.castShadow = true;
    const sm = graphics.shadowMapSizeKey;
    key.shadow.mapSize.set(sm, sm);
    key.shadow.camera.near = 0.4;
    key.shadow.camera.far = Math.max(32, this.mapRadius * 0.45);
    const sh = Math.max(9, this.mapRadius * 0.32);
    key.shadow.camera.left = -sh;
    key.shadow.camera.right = sh;
    key.shadow.camera.top = sh;
    key.shadow.camera.bottom = -sh;
    key.shadow.bias = -0.00012;
    key.shadow.radius = 2.8;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    this.dockKeyLight = key;
    this.dockEnvironment.bindKeyLight(key);
    this.dockEnvironment.bindAmbient(ambientFill);
  }

  private attachCameraFillLight(): void {
    if (!this.dockEnvironment || this.cameraFillLight) return;
    const fill = new THREE.DirectionalLight(0xffffff, 0);
    fill.castShadow = false;
    fill.position.set(1.4, 0.6, 0);
    fill.target.position.set(0, 0, -10);
    this.camera.add(fill);
    this.camera.add(fill.target);
    this.cameraFillLight = fill;
  }

  /**
   * Start the per-frame rAF loop. Worker-side `requestAnimationFrame` is
   * available because we're bound to an OffscreenCanvas whose source canvas
   * is in the document.
   *
   * The current loop is a SCAFFOLD that just keeps the SharedState
   * liveness counter advancing. Phase 3.x will route the real
   * `CharacterScenePreview.loop` body in here.
   */
  private tickUserCameraZoom(dt: number): void {
    const dtClamped = Math.max(0.001, Math.min(0.1, dt));
    const kZoom = 1 - Math.exp(-CharacterSceneController.DOCK_CAM_SMOOTH_RATE_ZOOM * dtClamped);
    this.userCameraZoom += (this.userCameraZoomTarget - this.userCameraZoom) * kZoom;
  }

  /** Match {@link CharacterScenePreview.tickCameraSmoothing} — orbit only (pan not used on worker). */
  private tickDockOrbitSmoothing(dt: number): void {
    const dtClamped = Math.max(0.001, Math.min(0.1, dt));
    const kOrbit = 1 - Math.exp(-CharacterSceneController.DOCK_CAM_SMOOTH_RATE_ORBIT * dtClamped);
    this.dockOrbitYaw += (this.dockOrbitYawTarget - this.dockOrbitYaw) * kOrbit;
    this.dockOrbitPitch += (this.dockOrbitPitchTarget - this.dockOrbitPitch) * kOrbit;
  }

  private handlePointerEvent(msg: PointerEventMessage): void {
    /* Dream (`realmMode` deck) and awakened both use LMB orbit + dblclick reset.
     * The old `!awakenedFreeRoam` early return broke deck entirely: no orbit events
     * and no `applySoloDockCameraFraming` (that path lived only in locomotion). */
    if (this.cameraLockActive) {
      if (msg.event === 'pointerup' || msg.event === 'pointercancel' || msg.event === 'lostpointercapture') {
        this.orbitDrag = false;
      }
      return;
    }
    const LEFT = 1;
    switch (msg.event) {
      case 'dblclick':
        this.dockOrbitYaw = 0;
        this.dockOrbitPitch = 0;
        this.dockOrbitYawTarget = 0;
        this.dockOrbitPitchTarget = 0;
        this.orbitDrag = false;
        return;
      case 'pointerdown':
        if ((msg.buttons & LEFT) !== 0) {
          this.orbitDrag = true;
          this.orbitLastX = msg.x;
          this.orbitLastY = msg.y;
        }
        return;
      case 'pointermove':
        if (this.orbitDrag && (msg.buttons & LEFT) !== 0) {
          const dx = msg.x - this.orbitLastX;
          const dy = msg.y - this.orbitLastY;
          this.orbitLastX = msg.x;
          this.orbitLastY = msg.y;
          this.dockOrbitYawTarget += dx * CharacterSceneController.DOCK_ORBIT_YAW_PER_PX;
          this.dockOrbitPitchTarget += dy * CharacterSceneController.DOCK_ORBIT_PITCH_PER_PX;
          this.dockOrbitPitchTarget = Math.max(-1.12, Math.min(1.55, this.dockOrbitPitchTarget));
        } else if ((msg.buttons & LEFT) === 0) {
          this.orbitDrag = false;
        }
        return;
      case 'pointerup':
      case 'pointercancel':
      case 'lostpointercapture':
        this.orbitDrag = false;
        return;
      default:
        return;
    }
  }

  private applyWheelZoom(deltaY: number, deltaMode: number): void {
    let dy = deltaY;
    if (deltaMode === 1) dy *= 16;
    if (deltaMode === 2) dy *= 100;
    if (dy === 0) return;
    const factor = dy > 0 ? 1.06 : 0.94;
    this.userCameraZoomTarget = Math.max(
      CharacterSceneController.DOCK_ZOOM_MIN,
      Math.min(
        CharacterSceneController.DOCK_ZOOM_MAX,
        this.userCameraZoomTarget * factor,
      ),
    );
  }

  start(): void {
    if (this.rafHandle !== 0) return; /* idempotent */
    this.lastFrameTime = performance.now();
    const tick = (now: number): void => {
      if (this.disposed) return;
      const dt = Math.max(0, Math.min(0.1, (now - this.lastFrameTime) / 1000));
      this.lastFrameTime = now;
      this.update(dt);
      /* Schedule next frame. `requestAnimationFrame` exists in worker scope
       * when an OffscreenCanvas is bound. */
      this.rafHandle = (globalThis as { requestAnimationFrame: (cb: (t: number) => void) => number }).requestAnimationFrame(tick);
    };
    this.rafHandle = (globalThis as { requestAnimationFrame: (cb: (t: number) => void) => number }).requestAnimationFrame(tick);
  }

  private update(dt: number): void {
    this.frameCount++;
    this.tickUserCameraZoom(dt);
    this.tickDockOrbitSmoothing(dt);
    for (const forestTick of this.forestSceneTickers) forestTick(dt);
    /* Bouncy-mushroom internal clock + squash — awakened only (matches
     * `mountApp`); must run before locomotion's `onPlayerLanded` for chain timing. */
    if (this.awakenedFreeRoam) {
      this.gameplayAttachHandles?.bouncyMushroomsHandle?.update(dt);
    }

    if (
      this.awakenedFreeRoam &&
      this.dockAvatar &&
      this.dockFreeRoamForGameplayAttach &&
      !this.disposed
    ) {
      const free = this.dockFreeRoamForGameplayAttach;
      const mush = this.gameplayAttachHandles?.bouncyMushroomsHandle ?? null;
      this.awakenedLocomotion.step({
        sharedState: this.sharedState,
        avatar: this.dockAvatar,
        camera: this.camera,
        baseCameraFovDeg: this.dockCameraBaseFovDeg,
        cameraZoom: this.userCameraZoom,
        orbitYaw: this.dockOrbitYaw,
        orbitPitch: this.dockOrbitPitch,
        getTerrainHeight: free.getTerrainHeight,
        mapRadius: free.mapRadius,
        collisionWorld: this.gameplayAttachHandles?.collisionWorld ?? null,
        cameraLockActive: this.cameraLockActive,
        bouncyMushrooms: mush,
        onMushroomBounceSfx: (impactSpeed) => {
          const intensity = Math.max(0.4, Math.min(1.2, 0.5 + impactSpeed / 18));
          this.postMain({ type: 'audioSfx', kind: 'mushroomBounce', intensity });
        },
        dt,
      });
      this.freeRoamAirborne = this.awakenedLocomotion.getAirborne();
    }

    if (
      this.awakenedFreeRoam &&
      this.mobsHandle &&
      this.dockAvatar &&
      this.gameplayAttachHandles &&
      !this.disposed
    ) {
      const p = this.dockAvatar.position;
      this.mobsHandle.update(dt, { x: p.x, y: p.y, z: p.z });
      this.gameplayAttachHandles.projectilesHandle.update(dt);
      this.workerMobAuthority?.postAuthoritySnapshot();
    }

    this.gameplayAttachHandles?.dockForestHandle?.update(dt);
    this.gameplayAttachHandles?.harvestHandle?.update(dt);

    this.staffOrbVfx?.update(dt);
    if (
      !this.awakenedFreeRoam
      && this.dockAvatar
      && this.dockFreeRoamForGameplayAttach
    ) {
      const free = this.dockFreeRoamForGameplayAttach;
      const zoom = Math.max(0.2, Math.min(2.35, this.userCameraZoom));
      applySoloDockCameraFraming({
        camera: this.camera,
        avatarX: this.dockAvatar.position.x,
        avatarY: this.dockAvatar.position.y,
        avatarZ: this.dockAvatar.position.z,
        dockCamYaw: this.dockOrbitYaw,
        dockCamPitch: this.dockOrbitPitch,
        userCameraZoom: zoom,
        cameraLockActive: this.cameraLockActive,
        baseFovDeg: this.dockCameraBaseFovDeg,
        projectFovScale: 1,
        getTerrainHeight: free.getTerrainHeight,
      });
    }
    this.dockEnvironment?.update(dt, this.empireProject, this.camera);

    if (this.nightGradePass && this.dockEnvironment) {
      const nightMix = this.dockEnvironment.getNightMix();
      const strength = this.dockEnvironment.getNightGradeStrength();
      syncNightGradeUniforms(
        this.nightGradePass,
        nightMix * strength,
        this.dockEnvironment.getMoonIllum(),
      );
    }

    if (this.renderer) {
      const exp = this.dockEnvironment?.getExposureMultiplier() ?? 1;
      this.renderer.toneMappingExposure = this.baseToneMappingExposure * exp;
      if (this.postProcessing) this.postProcessing.render();
      else this.renderer.render(this.scene, this.camera);
    }

    this.syncSharedRenderState();
    this.sharedState.incrementFrameCounter();
    this.sharedState.setLastRenderAtMs(Math.floor(performance.now()));
  }

  /**
   * Publish hot per-frame state for main-thread `CharacterSceneHost` getters
   * (damage floaters, reticle, store) — must run after render so tone exposure
   * matches the frame that was drawn.
   */
  private syncSharedRenderState(): void {
    const av = this.dockAvatar;
    if (av) {
      this.sharedState.setAvatarPosition(av.position.x, av.position.y, av.position.z);
    } else {
      this.sharedState.setAvatarPosition(0, 0, 0);
    }

    const yaw = this.camera.rotation.y;
    const pitch = this.camera.rotation.x;
    const zoom = this.userCameraZoom;
    this.camera.getWorldDirection(this._camForwardScratch);
    const fx = this._camForwardScratch.x;
    const fz = this._camForwardScratch.z;
    const flatLen = Math.hypot(fx, fz);
    const forwardX = flatLen > 1e-8 ? fx / flatLen : 0;
    const forwardZ = flatLen > 1e-8 ? fz / flatLen : -1;
    this.sharedState.setCameraState(yaw, pitch, zoom, forwardX, forwardZ);
    /* {@link CharacterSceneHost.getCameraYawPitch} / legacy: targets (mouselock deltas
     * accumulate on target; display is what framing renders). */
    this.sharedState.setDockOrbit(this.dockOrbitYawTarget, this.dockOrbitPitchTarget);
    this.sharedState.setCameraWorldPose(
      this.camera.position.x,
      this.camera.position.y,
      this.camera.position.z,
      this.camera.fov,
      Math.max(1e-6, this.camera.aspect),
    );

    const staff = this.vanguardWizardStaffRoot;
    if (staff && staff.visible) {
      this._staffTipScratch.set(0, 1.103, 0);
      staff.localToWorld(this._staffTipScratch);
      this.sharedState.setStaffTip(this._staffTipScratch.x, this._staffTipScratch.y, this._staffTipScratch.z);
    } else if (av) {
      this.sharedState.setStaffTip(av.position.x, av.position.y + 1.2, av.position.z);
    } else {
      this.sharedState.setStaffTip(0, 1.5, 0);
    }

    /* Gather clip progress — stub until worker runs harvest/clip LPCA (parity with legacy). */
    this.sharedState.setGatherProgress(0, 1000, 200);

    const bank = waterGatherBankXZ(this.empireProject);
    this.sharedState.setWaterBank(bank.x, bank.z);

    if (this.renderer) {
      this.sharedState.setToneMappingExposure(this.renderer.toneMappingExposure);
    } else {
      this.sharedState.setToneMappingExposure(this.baseToneMappingExposure);
    }

    if (this.freeRoamAirborne) this.sharedState.setFlags(FLAG.AIRBORNE);
    else this.sharedState.clearFlags(FLAG.AIRBORNE);
    if (this.cameraLockActive) this.sharedState.setFlags(FLAG.CAMERA_LOCKED);
    else this.sharedState.clearFlags(FLAG.CAMERA_LOCKED);
    if (this.awakenedFreeRoam) this.sharedState.setFlags(FLAG.AWAKENED);
    else this.sharedState.clearFlags(FLAG.AWAKENED);
  }

  /* ============================================================================
   * Message handlers (Phase 3 stubs — populate in subsequent migration passes).
   * Each maps 1:1 to a method on the legacy CharacterScenePreview, so Phase
   * 3.x is "copy method body, replace DOM/audio side-effects with
   * postToMain calls."
   * ============================================================================ */

  /**
   * Entry from `renderWorker` for `attachGameplayLayers` messages. Not routed
   * through {@link handleMessage} because it is async and posts completion messages.
   */
  attachGameplayLayersFromMain(): void {
    if (this.disposed) return;
    if (this.gameplayAttachHandles) {
      this.postMain({ type: 'gameplayAttachDone', ok: true });
      return;
    }
    this.gameplayAttachAwaiters++;
    if (this.gameplayAttachInFlight) return;
    void this.runGameplayAttachPipeline();
  }

  private async runGameplayAttachPipeline(): Promise<void> {
    this.gameplayAttachInFlight = true;
    let ok = false;
    let error: string | undefined;
    try {
      if (!this.renderer || !this.dockFreeRoamForGameplayAttach) {
        throw new Error('Worker GL or dock free-roam snapshot not ready');
      }
      const handles = await runDockGameplayAttachShared(
        { scene: this.scene, camera: this.camera, renderer: this.renderer },
        this.dockFreeRoamForGameplayAttach,
        (fraction, phase) => {
          this.postMain({ type: 'gameplayAttachProgress', fraction, phase });
        },
      );
      this.gameplayAttachHandles = handles;
      this.attachWorkerAwakenedMobs(handles);
      const free = this.dockFreeRoamForGameplayAttach;
      if (free) {
        this.postMain({
          type: 'freeRoamWorldForMain',
          mapRadius: free.mapRadius,
          crystalSpotsXZ: free.crystalSpotsXZ,
          forestStaticObstacles: free.forestStaticObstacles,
          resolvedCreeks: free.resolvedCreeks,
          dockXZ: free.dockXZ,
          crystalClusterPlaceholders: free.crystalClusters.map((c, index) => ({
            x: c.x,
            y: c.group.position.y,
            z: c.z,
            index,
          })),
        });
      }
      ok = true;
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
      this.disposeWorkerAwakenedMobsOnly();
      if (this.gameplayAttachHandles) {
        disposeDockGameplayAttachHandles(this.gameplayAttachHandles);
        this.gameplayAttachHandles = null;
      }
    } finally {
      this.gameplayAttachInFlight = false;
      const n = this.gameplayAttachAwaiters;
      this.gameplayAttachAwaiters = 0;
      for (let i = 0; i < n; i++) {
        this.postMain({ type: 'gameplayAttachDone', ok, ...(error ? { error } : {}) });
      }
    }
  }

  private disposeWorkerAwakenedMobsOnly(): void {
    if (this.gameplayAttachHandles) {
      try {
        this.gameplayAttachHandles.projectilesHandle.setProjectileAudio(null);
      } catch {
        /* ignore */
      }
    }
    if (this.mobsHandle) {
      try {
        this.mobsHandle.dispose();
      } catch {
        /* ignore */
      }
      this.mobsHandle = null;
    }
    this.workerMobAuthority = null;
  }

  private attachWorkerAwakenedMobs(handles: DockExtendedPreloadHandles): void {
    const free = this.dockFreeRoamForGameplayAttach;
    if (!free || !this.renderer) throw new Error('attachWorkerAwakenedMobs: missing free-roam or renderer');
    this.disposeWorkerAwakenedMobsOnly();
    this.workerMobAuthority = createWorkerAwakenedMobAuthorityStore({
      postMain: (m) => this.postMain(m),
      getPveWave: () => this.authorityPveWave,
    });
    this.mobsHandle = attachAwakenedMobs({
      scene: this.scene,
      getTerrainHeight: free.getTerrainHeight,
      mapRadius: free.mapRadius,
      store: this.workerMobAuthority.store,
      collisionWorld: handles.collisionWorld,
      mobAudio: {
        playFootstep: (kind, vol) => {
          this.postMain({ type: 'audioSfx', kind: 'mobFootstep', awakenedMobKind: kind, intensity: vol });
        },
        playDeath: (kind, vol) => {
          this.postMain({ type: 'audioSfx', kind: 'mobDeath', awakenedMobKind: kind, intensity: vol });
        },
      },
      onMobDamaged: (mob, amount, killed, source) => {
        this.postMain({
          type: 'awakenedMobDamaged',
          mob: { ...mob },
          amount,
          killed,
          ...(source ? { source } : {}),
        });
      },
    });
    this.mobsHandle.warmShaders(this.renderer, this.camera);
    handles.projectilesHandle.setMobs(this.mobsHandle);
    handles.projectilesHandle.setProjectileAudio({
      playMagicImpact: (scale) => {
        this.postMain({ type: 'audioSfx', kind: 'magicImpact', intensity: scale });
      },
      playMobHit: (kind, scale) => {
        this.postMain({ type: 'audioSfx', kind: 'mobHit', awakenedMobKind: kind, intensity: scale });
      },
    });
  }

  handleMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case 'init':
      case 'dispose':
        /* Lifecycle messages handled in renderWorker.ts before reaching here. */
        return;
      case 'attachGameplayLayers':
        /* Handled in renderWorker via `attachGameplayLayersFromMain`. */
        return;
      case 'resize':
        this.canvas.width = Math.max(1, Math.floor(msg.width * msg.devicePixelRatio));
        this.canvas.height = Math.max(1, Math.floor(msg.height * msg.devicePixelRatio));
        this.camera.aspect = this.canvas.width / Math.max(1, this.canvas.height);
        this.camera.updateProjectionMatrix();
        if (this.renderer) {
          this.renderer.setSize(this.canvas.width, this.canvas.height, false);
        }
        this.syncPostProcessingDrawSize();
        return;
      case 'applyCharacterPreset':
        this.currentPresetId = msg.presetId;
        return;
      case 'syncEquipment':
        this.equippedWeapon = msg.weapon;
        this.equippedPick = msg.pick;
        this.equippedShield = msg.shield;
        return;
      case 'setPageContext':
        this.pageContext = msg.page;
        return;
      case 'setFreeRoamAirborne':
        if (this.awakenedFreeRoam) return;
        this.freeRoamAirborne = msg.airborne;
        return;
      case 'setCameraLockActive':
        this.cameraLockActive = msg.active;
        if (msg.active) this.orbitDrag = false;
        return;
      case 'setAwakenedFreeRoam':
        if (!msg.active) {
          this.workerMobAuthority?.clear();
          this.mobsHandle?.clearAll();
          this.awakenedLocomotion.disposeFromCollision(
            this.gameplayAttachHandles?.collisionWorld ?? null,
          );
          this.awakenedLocomotion.reset();
        }
        this.awakenedFreeRoam = msg.active;
        return;
      case 'syncPveWaveForWorker':
        this.authorityPveWave = msg.pveWave;
        return;
      case 'applyAwakenedMobDamageFromMain':
        if (this.mobsHandle) {
          this.mobsHandle.damage(msg.id, msg.amount, { x: 0, z: 0 }, msg.source ?? 'melee');
          this.workerMobAuthority?.postAuthoritySnapshot();
        }
        return;
      case 'skinAwakenedCorpseOnWorker': {
        if (!this.mobsHandle || !this.workerMobAuthority) return;
        const mob = this.workerMobAuthority.store
          .getActiveAwakenedMobs()
          .find((m) => m.id === msg.id && m.state === 'corpse');
        if (!mob) return;
        const { x, y, z } = mob;
        const loot = this.mobsHandle.skinCorpse(msg.id);
        if (loot) {
          this.postMain({
            type: 'awakenedCorpseSkinLoot',
            id: msg.id,
            kind: loot.kind,
            meat: loot.meat,
            x,
            y,
            z,
          });
        }
        this.workerMobAuthority.postAuthoritySnapshot();
        return;
      }
      case 'clearAwakenedMobsOnWorker':
        this.mobsHandle?.clearAll();
        this.workerMobAuthority?.clear();
        this.workerMobAuthority?.postAuthoritySnapshot();
        return;
      case 'syncCabinPiecesFromMain':
        this.gameplayAttachHandles?.cabinHandle.syncFromState(msg.pieces);
        return;
      case 'syncCraftStationsFromMain':
        this.gameplayAttachHandles?.craftStationHandle.syncFromState(msg.stations);
        return;
      case 'applyDockForestHitOnWorker': {
        const df = this.gameplayAttachHandles?.dockForestHandle;
        if (!df) return;
        const node = df.getNodeByIndex(msg.nodeIndex);
        if (!node || node.kind !== msg.kind) return;
        df.applyHit(node, msg.hitsMult);
        return;
      }
      case 'applyFreeRoamHarvestHitOnWorker': {
        const hh = this.gameplayAttachHandles?.harvestHandle;
        if (!hh) return;
        const node = hh.nodes.find((n) => n.kind === msg.kind && n.index === msg.nodeIndex);
        if (!node) return;
        hh.applyHit(node, msg.hitsMult);
        return;
      }
      case 'setUserCameraZoomEnabled':
        if (!msg.enabled) {
          this.userCameraZoom = 1;
          this.userCameraZoomTarget = 1;
        }
        return;
      case 'resetDockCameraView':
        this.userCameraZoom = 1;
        this.userCameraZoomTarget = 1;
        this.dockOrbitYaw = 0;
        this.dockOrbitPitch = 0;
        this.dockOrbitYawTarget = 0;
        this.dockOrbitPitchTarget = 0;
        this.orbitDrag = false;
        return;
      case 'wheelEvent':
        this.applyWheelZoom(msg.deltaY, msg.deltaMode);
        return;
      case 'setClipSpeedMultiplier':
        this.clipSpeedMultiplier = msg.multiplier;
        return;
      case 'setCameraYawPitch': {
        /* Same as {@link CharacterScenePreview.setCameraYawPitch}: snap display + target
         * (bypasses orbit smoothing for 1:1 mouselock feel). */
        const p = Math.max(-1.12, Math.min(1.55, msg.pitch));
        this.dockOrbitYaw = msg.yaw;
        this.dockOrbitPitch = p;
        this.dockOrbitYawTarget = msg.yaw;
        this.dockOrbitPitchTarget = p;
        return;
      }
      case 'pointerEvent':
        this.handlePointerEvent(msg);
        return;
      case 'cancelCameraDrag':
        this.orbitDrag = false;
        return;
      /* All other state-mutation messages are stubbed: their fields aren't
       * used yet because there's no scene to mutate. They land silently
       * until Phase 3.x wires the corresponding scene/material code. */
      case 'setAwakenedRenderBudget':
        this.applyDockPostProcessing();
        return;
      case 'setGraphicsTier':
        this.graphicsTier = msg.tier;
        this.applyDockRendererDisplay();
        this.applyDockPostProcessing();
        return;
      case 'applyDockRendererDisplay':
        this.applyDockRendererDisplay();
        return;
      case 'applyDockPostProcessing':
        this.applyDockPostProcessing();
        return;
      case 'setTorchInventory':
      case 'setCraftDecorAvailability':
      case 'syncGatherRpgVisuals':
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
      case 'relevelAvatarFeetAfterEquipmentSync':
        return;
      default: {
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  }

  /* ============================================================================
   * Lifecycle
   * ============================================================================ */

  dispose(): void {
    if (this.disposed) return;
    this.awakenedLocomotion.disposeFromCollision(
      this.gameplayAttachHandles?.collisionWorld ?? null,
    );
    this.awakenedLocomotion.reset();
    this.disposed = true;
    if (this.rafHandle !== 0) {
      const cancel = (globalThis as { cancelAnimationFrame?: (h: number) => void }).cancelAnimationFrame;
      if (cancel) cancel(this.rafHandle);
      this.rafHandle = 0;
    }
    this.cancelWorkerGpuWarm('both');
    this.sharedState.clearFlags(FLAG.WORKER_READY);

    this.disposeWorkerAwakenedMobsOnly();
    if (this.gameplayAttachHandles) {
      disposeDockGameplayAttachHandles(this.gameplayAttachHandles);
      this.gameplayAttachHandles = null;
    }
    this.dockFreeRoamForGameplayAttach = null;

    for (const d of this.forestSceneDisposers) {
      try {
        d();
      } catch {
        /* best-effort teardown */
      }
    }
    this.forestSceneDisposers = [];
    this.forestSceneTickers = [];

    this.staffOrbVfx?.dispose();
    this.staffOrbVfx = null;
    this.dockAvatar = null;
    this.vanguardWizardStaffRoot = null;

    this.postProcessing?.getComposer().dispose();
    this.postProcessing = null;
    this.nightGradePass = null;

    this.dockEnvironment?.dispose();
    this.dockEnvironment = null;

    if (this.cameraFillLight) {
      this.camera.remove(this.cameraFillLight.target);
      this.camera.remove(this.cameraFillLight);
      this.cameraFillLight = null;
    }
    if (this.dockKeyLight) {
      this.scene.remove(this.dockKeyLight.target);
      this.scene.remove(this.dockKeyLight);
      this.dockKeyLight = null;
    }
    if (this.ambientFill) {
      this.scene.remove(this.ambientFill);
      this.ambientFill = null;
    }
    if (this.dockHemi) {
      this.scene.remove(this.dockHemi);
      this.dockHemi = null;
    }

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
    this.glInited = false;
    /* Scene disposal — walk objects and release geometries/materials. */
    this.scene.traverse((obj) => {
      if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
      const mat = (obj as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
  }

  /* ============================================================================
   * Read-only accessors (used by the worker's pre-frame fallback so unused
   * fields don't trigger noUnusedLocals errors and to support future
   * debug overlays).
   * ============================================================================ */

  getCurrentPresetId(): string | null {
    return this.currentPresetId;
  }

  getEquipment(): { weapon: string | null; pick: string | null; shield: string | null } {
    return { weapon: this.equippedWeapon, pick: this.equippedPick, shield: this.equippedShield };
  }

  getPageContext(): string {
    return this.pageContext;
  }

  isFreeRoamAirborne(): boolean {
    return this.freeRoamAirborne;
  }

  isCameraLockActive(): boolean {
    return this.cameraLockActive;
  }

  isAwakenedFreeRoam(): boolean {
    return this.awakenedFreeRoam;
  }

  getClipSpeedMultiplier(): number {
    return this.clipSpeedMultiplier;
  }

  getGraphicsTier(): 'low' | 'perf' | 'balanced' | 'cinematic' {
    return this.graphicsTier;
  }

  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Emit a worker→main message. Used by future scene code to route audio
   * SFX (`{type: 'audioSfx', kind, ...}`), gather completion, and custom
   * window events back to main where the DOM/Audio APIs live.
   *
   * Phase 3 scaffold exposes this as a public method so the renderWorker
   * dispatcher can route worker-originated events without circular imports;
   * callers in Phase 3.x (footstep ticker, gather clip controller) will
   * use this instead of holding their own postMain reference.
   */
  emit(msg: MainMessage): void {
    this.postMain(msg);
  }
}

/**
 * Tiny helper so renderWorker.ts can avoid importing the WorkerSelf cast
 * pattern twice. Returns a minimal post-to-main function bound to
 * `self.postMessage`.
 */
export function makePostMain(workerSelf: WorkerSelfMin): (msg: MainMessage) => void {
  return (msg) => workerSelf.postMessage(msg);
}
