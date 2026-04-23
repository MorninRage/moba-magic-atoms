import * as THREE from 'three';
import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';
import type { ResolvedCreek } from './idleCraftHeightfield';
import { computeDayPeriodState, horizonBeltWeight } from './idleCraftDayPeriods';
import {
  createIdleCraftMoonMaterial,
  createIdleCraftPlasmaSunMaterial,
  createPlasmaSunMesh,
} from './idleCraftCelestialMaterials';
import {
  CELESTIAL_MOON_APPARENT_RADIUS,
  CELESTIAL_MOON_SHELL_DISTANCE,
  CELESTIAL_SUN_SHELL_DISTANCE,
  horizonDiskParallaxScale,
  moonDirectionTopocentric,
  sunDirectionTopocentric,
} from './idleCraftCelestialMechanics';
import { lunarIllumination01, lunarPhaseFromTotalHours } from './idleCraftLunarPhase';
import { skydomeBandColorsForMoon } from './idleCraftSkyPaint';
import { attachSunGodRays, type SunGodRaysHandle } from '../visual/sunGodRays';
import { readEnvironmentConfig, type IdleCraftEnvironmentConfig } from './idleCraftWorldTypes';
import type { IdleCraftNightMagicField } from '../visual/idleCraftNightMagicLPCA';
import { SKY_RENDER_STARS } from '../visual/idleCraftSkyStack';
import type { GraphicsBudget } from '../engine/graphicsTier';
import { updateVegetationWind } from '../visual/idleCraftVegetationWind';
import { schedulePostTask } from '../util/mainThreadYield';
import { isDockVisualLowBudget } from './idleCraftDockInteractionBudget';
import { createDockEnvProbe, type DockEnvProbe } from '../debug/idleCraftDockFrameProbe';

/**
 * Fog + key / hemi / ambient + GoE-style surface water + procedural water scroll +
 * day periods, stars, dynamic skydome, random weather bursts, exposure hint.
 */
export class IdleCraftDockEnvironment {
  private readonly scene: THREE.Scene;
  private readonly envCfg: Required<IdleCraftEnvironmentConfig>;
  private simHour: number;
  private surfaceWater = 0.12;
  private stormDim = 0;
  private projectStormDim = 0;
  private projectSurfaceWater = 0;
  private keyLight: THREE.DirectionalLight | null = null;
  /** Optional camera-relative fill light (Phase 8h §2). See {@link bindCameraFillLight}. */
  private cameraFillLight: THREE.DirectionalLight | null = null;
  /** Reusable scratch color for the camera fill's per-frame sky-tracked tint. */
  private readonly _tmpFillCol = new THREE.Color();
  /** Optional cheap cone-geo god-rays (Phase 8h §6). Attached lazily; null when not in use. */
  private godRays: SunGodRaysHandle | null = null;
  private readonly moonLight: THREE.DirectionalLight;
  private readonly moonPoint: THREE.PointLight;
  private readonly moonDisc: THREE.Mesh;
  private ambientLight: THREE.AmbientLight | null = null;
  private hemi: THREE.HemisphereLight;
  private waterMaterial: THREE.MeshPhysicalMaterial | null = null;
  private waterMeshes: THREE.Mesh[] = [];
  private waterRoot = new THREE.Group();
  private readonly dayFogNear: number;
  private readonly dayFogFar: number;
  private readonly dayBg: THREE.Color;
  private readonly nightFogColor: THREE.Color;
  /**
   * Horizon-tinted fog colors (Phase 8h lighting plan — atmospheric perspective).
   * Far objects desaturate toward HORIZON colors, not zenith — that's how
   * landscape painting + every modern stylized fantasy game (BotW, Genshin,
   * A Short Hike) sells "deep distance + character pop." `dayBg` is the
   * zenith blue; the warm/cool horizon colors below are blended in based on
   * sun elevation so dusk/dawn show their warm bands and night shows the
   * cool one. Drives the avatar to read sharply against a more atmospheric
   * background. */
  private readonly horizonWarm = new THREE.Color(0xf3c6a0);  /* peach near sun-at-horizon */
  private readonly horizonCool = new THREE.Color(0x2a3a5c);  /* deep cool blue at night horizon */
  private readonly _tmpHorizonFog = new THREE.Color();
  private flowScroll = new THREE.Vector2(0, 0);
  private readonly flowDir = new THREE.Vector2(0.06, 0.095);
  private resolvedCreeks: ResolvedCreek[] = [];
  private readonly colWarm = new THREE.Color(0xfff2dd);
  private readonly colCool = new THREE.Color(0xb8c8f0);
  private readonly colAmbDay = new THREE.Color(0x6a7a72);
  private readonly colAmbNight = new THREE.Color(0x3a4550);
  private readonly colHemiSkyDay = new THREE.Color(0xb8d8f0);
  private readonly colHemiSkyNight = new THREE.Color(0x4a5a72);
  /** Day ground bounce — slightly lifted so turf + feet read (GoE: compensate with hemi/ambient, not foot lamps). */
  private readonly colHemiGrDay = new THREE.Color(0x5c5648);
  private readonly colHemiGrNight = new THREE.Color(0x2a2520);
  private readonly colMoonBase = new THREE.Color(0xb8c8e8);
  private readonly colMoonEdge = new THREE.Color(0xe8f0ff);
  private readonly colAmbMoon = new THREE.Color(0x4a5a68);
  private lastOutdoorDayMix = 1;
  /** Real-time EMA toward raw clock dayMix — removes visible snaps in fog, key/hemi/ambient, exposure. */
  private lightingDayMixSmoothed = 1;
  /** Same EMA as day mix — sunset/dusk/warmth/stars were raw before and stepped while fog base was smooth. */
  private lightingSunsetMixSmoothed = 0;
  private lightingDuskMixSmoothed = 0;
  private lightingSunWarmthSmoothed = 0;
  private lightingStarOpacitySmoothed = 0;
  /** EMA toward {@link horizonDiskParallaxScale} so plasma disc squash doesn’t fight smooth lighting at the horizon. */
  private sunParallaxSmoothed = { x: 1 as number, y: 1 as number };

  /* === 2026-04-22 weather runtime removed (player request) ===
   * The `IdleCraftWeatherRuntime` random clear/rain cycle was deleted —
   * it darkened the sky + grayed the fog every ~50-130 s for 30-60 s but
   * had no actual rain particle visualization, no audio cue, no narrative
   * payoff. `stormDim` is now permanently 0 in the update loop below;
   * sky / moon / fog / vegetation-wind shaders that read `uStorm` simply
   * see 0 and never apply the storm look. The shader uniforms themselves
   * are kept in case a future storm system (with real rain particles)
   * wants to drive them. */
  private readonly starsBright: THREE.Points;
  private readonly starsDim: THREE.Points;
  private readonly starsMilky: THREE.Points;
  private readonly starsSparkle: THREE.Points;
  private readonly starMatBright: THREE.PointsMaterial;
  private readonly starMatDim: THREE.PointsMaterial;
  private readonly starMatMilky: THREE.PointsMaterial;
  private readonly starMatSparkle: THREE.PointsMaterial;
  private nightMagicField: IdleCraftNightMagicField | null = null;
  /** Eased 0–1 so biolum / fairies ramp instead of tracking raw nightMix × starOpacity (reduces hitches). */
  private nightMagicVisSmooth = 0;
  private celestialTime = 0;
  /** 0.55–1 from dock frame-time governor; scales stars + night magic cost. */
  private perfStressScale = 1;
  /** Esc / project.json — GoE-style light multipliers (default 1). */
  private lightMul = { sun: 1, ambient: 1, hemi: 1, moon: 1 };
  /** Phase 8h overhaul knobs — see {@link setLightingMultipliers}. Defaults = ship defaults. */
  private cameraFillMul = 1;
  private nightGradeMul = 1;
  private sunShaftsMul = 1;
  private envIntensityMul = 1;

  private skyDomeMesh: THREE.Mesh | null = null;
  private skyDomeMat: THREE.ShaderMaterial | null = null;
  /** Updated each {@link update} — twilight band for predictive perf (previous frame semantics at governor call site). */
  private lastTwilightBlendHeavy = false;
  /** After moon takes shadow cast, frustum is copied once — avoids `updateProjectionMatrix` every frame at twilight (hitch). */
  private moonShadowFrustumSynced = false;
  /** Monotonic sim hours (fractional) for lunar phase; drives wrapped `simHour` when time advances. */
  private totalSimHours = 0;
  /** [0,1) lunar phase; updated each frame. */
  private lunarPhase = 0;
  private readonly moonShaderMat: THREE.ShaderMaterial;
  private readonly plasmaSun: THREE.Mesh | null;

  /* === IBL / PMREM (Phase 8h lighting plan §1) ===
   *
   * Built lazily via {@link attachIbl} once the renderer is available
   * (CharacterScenePreview owns the renderer, calls attachIbl after
   * binding the dock environment). When attached, every IBL_REGEN_INTERVAL_MS
   * the env scene's gradient sphere uniforms are synced to the current
   * sky/horizon/sun colors and PMREM-prefilters into a new env target;
   * `scene.environment` swaps to the new texture. The previous target is
   * disposed AFTER the swap.
   *
   * **Why a 3-color gradient sphere instead of cloning the actual skydome:**
   * the actual skydome has a complex multi-band shader with cloud occlusion
   * and the cloud dome is a separate transparent layer. Cloning that into
   * an env scene would risk material-state desync. The gradient sphere
   * captures the ~5 most important colors (zenith / horizon / nadir +
   * sun glow direction + sun color) which is more than enough for IBL
   * specular — IBL's job is "what's the dominant color at each direction
   * in the sky" not "render the sky exactly." */
  private iblPmrem: THREE.PMREMGenerator | null = null;
  private iblEnvScene: THREE.Scene | null = null;
  private iblSkyMat: THREE.ShaderMaterial | null = null;
  private iblCurrentTarget: THREE.WebGLRenderTarget | null = null;
  private iblLastRegenMs = 0;
  /** Coalesces multiple `updateIbl` due-firings into one queued idle slot. */
  private iblRegenScheduled = false;
  /** ms between PMREM regenerations (every ~4 s). Cheap (~2-5 ms per regen). */
  private static readonly IBL_REGEN_INTERVAL_MS = 4000;

  constructor(
    scene: THREE.Scene,
    project: IdleEmpireProjectFile | null,
    hemi: THREE.HemisphereLight,
    mapRadius: number,
    graphics?: GraphicsBudget,
  ) {
    this.scene = scene;
    this.hemi = hemi;
    this.envCfg = readEnvironmentConfig(project?.environment);
    const t0 = typeof project?.time === 'number' ? project.time : 12;
    const hour0 = ((t0 % 24) + 24) % 24;
    this.totalSimHours = this.envCfg.lunarDayIndex * 24 + hour0;
    this.simHour = THREE.MathUtils.euclideanModulo(this.totalSimHours, 24);
    this.lunarPhase = lunarPhaseFromTotalHours(
      this.totalSimHours,
      this.envCfg.lunarCycleDays,
      this.envCfg.lunarPhase0,
    );
    /* === 2026-04-20 daytime haze fix ===
     *
     * Near distance was `mapRadius * 0.55` (~24m on the default map). On a small
     * dock area where the player is ~5–10m from most props, this had fog start
     * lerping mid-foreground objects toward the sky color, reading as a "milky"
     * haze that flattened depth. Bumped to `0.85` (~37m) so foreground stays
     * crisp and atmospheric perspective only kicks in for genuinely distant
     * trees/sky transition. Far is unchanged so distant horizon still fades. */
    /* Fog near pushed 0.85 → 1.4 (mapRadius units) 2026-04-22 — matches
     * `forestEnvironment.ts` initial-fog-set. Keeps foreground + dock-disk
     * trees crisp; only `treeWorldFar` strata + horizon pick up fog. See
     * the matching comment in `forestEnvironment.ts:643`. */
    this.dayFogNear = mapRadius * 1.4;
    this.dayFogFar = mapRadius * 2.85;
    this.dayBg = new THREE.Color(0xa8daf8);
    this.nightFogColor = new THREE.Color(0x1a2840);
    scene.add(this.waterRoot);
    if (scene.fog instanceof THREE.Fog) {
      scene.background = scene.fog.color;
    }
    this.syncProjectWeather(project);

    const sun0 = this.computeSunDirection(new THREE.Vector3(), this.simHour);
    const period0 = computeDayPeriodState(this.simHour, sun0.y);
    this.lightingDayMixSmoothed = period0.dayMix;
    this.lightingSunsetMixSmoothed = period0.sunsetMix;
    this.lightingDuskMixSmoothed = period0.duskMix;
    this.lightingSunWarmthSmoothed = period0.sunWarmth;
    this.lightingStarOpacitySmoothed = period0.starOpacity;
    horizonDiskParallaxScale(sun0, this.envCfg.horizonParallaxStrength, _sunParallaxXy);
    this.sunParallaxSmoothed.x = _sunParallaxXy.x;
    this.sunParallaxSmoothed.y = _sunParallaxXy.y;
    this.lastOutdoorDayMix = period0.dayMix;

    /**
     * Both directional lights keep `castShadow = true` for the whole session so
     * `numDirLightShadows` never changes (was 1 → 0 → 1 at sunset → full lit-material recompile,
     * a multi-second hard freeze). Below-horizon shadow contributions are invisible because
     * `intensity → 0` and shadow factor is multiplied by light contribution.
     * Cost: one extra 1024² depth pass per frame (~1 ms). See {@link bindKeyLight}.
     */
    this.moonLight = new THREE.DirectionalLight(0xd0e4f8, 0);
    this.moonLight.castShadow = true;
    this.moonLight.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.moonLight);
    this.scene.add(this.moonLight.target);

    this.moonPoint = new THREE.PointLight(0xd0e4ff, 0, 0, 2);
    this.moonPoint.decay = 2;
    this.scene.add(this.moonPoint);

    const moonSegW = graphics?.moonSphereW ?? 28;
    const moonSegH = graphics?.moonSphereH ?? 20;
    const moonGeo = new THREE.SphereGeometry(1, moonSegW, moonSegH);
    this.moonShaderMat = createIdleCraftMoonMaterial();
    this.moonDisc = new THREE.Mesh(moonGeo, this.moonShaderMat);
    this.moonDisc.name = 'preview_moon_disc';
    this.moonDisc.renderOrder = -500;
    this.moonDisc.frustumCulled = false;
    this.moonDisc.scale.setScalar(CELESTIAL_MOON_APPARENT_RADIUS);
    /**
     * Always visible so the shader program is compiled on first render (warm-up), not on the
     * first twilight frame. `uOpacity` from {@link moonDiscAlpha} gates what you see.
     * Matches the stars / plasma sun / night-magic pattern (no `visible` toggles at thresholds).
     */
    this.moonDisc.visible = true;
    this.scene.add(this.moonDisc);

    if (this.envCfg.plasmaSunEnabled) {
      const sunMat = createIdleCraftPlasmaSunMaterial();
      this.plasmaSun = createPlasmaSunMesh(sunMat);
      this.scene.add(this.plasmaSun);
    } else {
      this.plasmaSun = null;
    }

    const Rstars = mapRadius * 265;
    const sb = graphics?.starsBright ?? 380;
    const sd = graphics?.starsDim ?? 1100;
    const sm = graphics?.starsMilky ?? 1650;
    const ss = graphics?.starsSparkle ?? 42;
    const layers = createStarField(Rstars, sb, sd, sm, ss);
    this.starsBright = layers.bright;
    this.starsDim = layers.dim;
    this.starsMilky = layers.milky;
    this.starsSparkle = layers.sparkle;
    this.starMatBright = layers.matB;
    this.starMatDim = layers.matD;
    this.starMatMilky = layers.matM;
    this.starMatSparkle = layers.matS;
    this.scene.add(this.starsBright);
    this.scene.add(this.starsDim);
    this.scene.add(this.starsMilky);
    this.scene.add(this.starsSparkle);
    const starRo = SKY_RENDER_STARS;
    this.starsBright.renderOrder = starRo;
    this.starsDim.renderOrder = starRo;
    this.starsMilky.renderOrder = starRo;
    this.starsSparkle.renderOrder = starRo;
  }

  registerNightMagic(field: IdleCraftNightMagicField): void {
    this.nightMagicField = field;
  }

  /** Detail-budget style scale (GoE DetailBudgetManager pattern) — lowers night FX when FPS dips. */
  setPerfStressScale(scale: number): void {
    this.perfStressScale = THREE.MathUtils.clamp(scale, 0.55, 1);
  }

  /** True when sunset/dusk/generic twilight — used with {@link isDockVisualLowBudget} to clamp star/fairy cost early. */
  isTwilightBlendHeavy(): boolean {
    return this.lastTwilightBlendHeavy;
  }

  /** Single procedural sky mesh from {@link attachForestBackdrop} (full sphere, fused clouds). */
  registerSkyDome(skyDome: THREE.Mesh): void {
    this.skyDomeMesh = skyDome;
    this.skyDomeMat = skyDome.material as THREE.ShaderMaterial;
  }

  /**
   * Attach IBL environment-map machinery (Phase 8h lighting plan §1).
   *
   * Builds a tiny gradient-sky env scene (sphere with a 3-color shader:
   * zenith / horizon / nadir + sun-glow lobe), wraps it with PMREM, and
   * assigns a prefiltered cubemap to `scene.environment`. Per-frame
   * `update()` syncs the gradient uniforms to the current sky colors and
   * regenerates the env target every ~4 s — far cheaper than per-frame and
   * well below the rate at which the sky's dominant tone visibly shifts.
   *
   * **Why this matters:** many materials in the project carry
   * `envMapIntensity` values (PVE enemies, harvest plants, projectiles,
   * staff orb, witch wands) but `scene.environment` was previously null.
   * Those uniforms were dead — PBR materials only got direct lighting,
   * losing the entire environment-reflection term and reading "plasticky"
   * or "muddy" depending on view angle. This method gives them a real
   * per-time-of-day env to sample.
   *
   * Idempotent — calling twice is safe (second call is a no-op).
   */
  attachIbl(renderer: THREE.WebGLRenderer): void {
    if (this.iblPmrem) return;
    this.iblPmrem = new THREE.PMREMGenerator(renderer);
    this.iblPmrem.compileEquirectangularShader();

    /* Tiny env scene with a single inside-out gradient sphere. The PMREM
     * generator renders this scene as the source of irradiance/specular
     * cubemaps. Since the sphere is inside-out (BackSide) and surrounds
     * the origin, the PMREM camera at origin sees the gradient colors in
     * every direction. */
    const envScene = new THREE.Scene();
    const skyGeo = new THREE.SphereGeometry(50, 24, 16);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uZenith: { value: new THREE.Color(0xa8daf8) },
        uHorizon: { value: new THREE.Color(0xe8c8a0) },
        uNadir: { value: new THREE.Color(0x3a3024) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunGlow: { value: new THREE.Color(0xffe4b5) },
      },
      vertexShader: `
        varying vec3 vWorldDir;
        void main() {
          vWorldDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uZenith;
        uniform vec3 uHorizon;
        uniform vec3 uNadir;
        uniform vec3 uSunDir;
        uniform vec3 uSunGlow;
        varying vec3 vWorldDir;
        void main() {
          vec3 d = normalize(vWorldDir);
          /* Hemisphere blend: zenith above, nadir below, both wrap to horizon. */
          float t = d.y;
          vec3 col;
          if (t > 0.0) {
            col = mix(uHorizon, uZenith, smoothstep(0.0, 0.7, t));
          } else {
            col = mix(uHorizon, uNadir, smoothstep(0.0, 0.5, -t));
          }
          /* Sun-direction glow lobe — sells warm/cool key direction in IBL
           * specular reflections (e.g. sunset peach catches on a brass band). */
          float sunDot = max(0.0, dot(d, normalize(uSunDir)));
          float glow = pow(sunDot, 16.0);
          col += uSunGlow * glow * 0.6;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const sphere = new THREE.Mesh(skyGeo, skyMat);
    envScene.add(sphere);

    this.iblEnvScene = envScene;
    this.iblSkyMat = skyMat;
    /* Force a regen on the next update so frame 1 of player view has IBL. */
    this.iblLastRegenMs = 0;
  }

  /**
   * Per-frame IBL refresh (called from {@link update}). Cheap when not due
   * for regen — just uniform writes that won't take effect until the next
   * PMREM pass. Throttled to {@link IBL_REGEN_INTERVAL_MS}.
   *
   * **2026-04-20 spike fix:** the actual `iblPmrem.fromScene(...)` regen is
   * a 2-5ms synchronous burst that previously landed in the middle of a
   * gameplay frame — causing a periodic stutter every ~4s. Now scheduled
   * via `requestIdleCallback` (fallback `setTimeout(0)`) so the browser
   * runs it in an idle slot between frames; the regen still happens at
   * roughly the same cadence but no longer competes with the rAF render.
   * Multiple due-firings within a single rIC window are coalesced via
   * `iblRegenScheduled` so we don't queue a backlog.
   */
  private updateIbl(opts: {
    zenith: THREE.Color;
    horizon: THREE.Color;
    nadir: THREE.Color;
    sunDir: THREE.Vector3;
    sunGlow: THREE.Color;
  }): void {
    if (!this.iblPmrem || !this.iblEnvScene || !this.iblSkyMat) return;
    /* Always sync the gradient uniforms — cheap, and means the next regen
     * uses the latest colors. */
    const u = this.iblSkyMat.uniforms;
    u.uZenith.value.copy(opts.zenith);
    u.uHorizon.value.copy(opts.horizon);
    u.uNadir.value.copy(opts.nadir);
    u.uSunDir.value.copy(opts.sunDir);
    u.uSunGlow.value.copy(opts.sunGlow);
    /* Throttle expensive PMREM regen. */
    const now = performance.now();
    if (now - this.iblLastRegenMs < IdleCraftDockEnvironment.IBL_REGEN_INTERVAL_MS) return;
    if (this.iblRegenScheduled) return;
    this.iblLastRegenMs = now;
    this.iblRegenScheduled = true;
    /* Defer the heavy `fromScene` PMREM render to an idle slot. Worst case
     * the browser fires the rIC slot ~50ms later than the throttle target,
     * which is invisible at 4-second cadence but eliminates the rAF-frame
     * spike. Safari (no rIC) gets `setTimeout(0)` which still moves the
     * work off the current rAF callback. */
    const fire = (): void => {
      this.iblRegenScheduled = false;
      this.runIblPmremRegen();
    };
    /* Round 5 phase F1 — `background` priority via tagged scheduler. PMREM
     * regen is genuinely background work; sky tint changes drive a 4 s
     * throttle so a slot-fire delay of 50-150 ms is invisible. */
    schedulePostTask(fire, 'background');
  }

  /** Synchronous PMREM regen + scene.environment swap. Called from idle slot — see `updateIbl`. */
  private runIblPmremRegen(): void {
    if (!this.iblPmrem || !this.iblEnvScene) return;
    /* Render env scene → prefiltered env target → assign to scene.environment.
     * Dispose previous target AFTER swap so any in-flight render finishes
     * sampling the old texture cleanly. */
    const newTarget = this.iblPmrem.fromScene(this.iblEnvScene, 0, 0.1, 100);
    const prevTarget = this.iblCurrentTarget;
    this.iblCurrentTarget = newTarget;
    this.scene.environment = newTarget.texture;
    /* Re-apply the Esc-tunable env-intensity multiplier on the new env so
     * a recent slider change survives the swap. (Three r155+ feature.) */
    const sceneAny = this.scene as THREE.Scene & { environmentIntensity?: number };
    sceneAny.environmentIntensity = this.envIntensityMul;
    if (prevTarget) prevTarget.dispose();
  }

  getOutdoorDayMix(): number {
    return this.lastOutdoorDayMix;
  }

  /** 1 - dayMix (eased). 0 = noon, 1 = full night. Drives night-grade post pass (Phase 8h §4). */
  getNightMix(): number {
    return 1 - this.lastOutdoorDayMix;
  }

  /** Lunar disc illumination 0-1 (0 = new moon, 1 = full moon). Drives the
   * "easing" of the night-grade pass — full-moon nights stay readable, new-
   * moon nights are the "mysterious dark" extreme. */
  getMoonIllum(): number {
    return lunarIllumination01(this.lunarPhase);
  }

  /** Esc-tunable strength multiplier for the night-grade post pass (Phase 8h §4 knob). */
  getNightGradeStrength(): number {
    return this.nightGradeMul;
  }

  /**
   * Multiply renderer `toneMappingExposure` (1 = neutral vs baked base in CharacterScenePreview).
   *
   * **Phase 8h §7 — eye-adaptation lite.** Returns the SMOOTHED exposure value
   * that asymmetrically eases toward the per-time-of-day target. Eyes adapt
   * fast TO bright (pinching down quickly when the player walks into noon
   * sun) and slow FROM bright (lingering glow when stepping into shade).
   * Smoothing is driven by `tickEyeAdaptation` from the per-frame update
   * loop. Initial value tracks the target so frame 1 has the correct exposure
   * (no boot-time jump). */
  getExposureMultiplier(): number {
    return this.adaptedExposure;
  }
  /** Smoothed-toward-target exposure (Phase 8h §7). Initial value matches the
   * target formula so the first render has no perceptible "wake-up" exposure
   * jump. Updated each frame in `tickEyeAdaptation`. */
  private adaptedExposure = 1.0;

  setResolvedCreeks(creeks: ResolvedCreek[]): void {
    this.resolvedCreeks = creeks;
  }

  /** Sun / ambient / hemisphere / moon — multiplied on top of day/night solve (GoE lighting table).
   *
   * **Phase 8h overhaul knobs (2026-04-19)** also flow through this method:
   *   - `cameraFill`  → multiplier on the camera-relative fill light intensity.
   *   - `nightGrade`  → multiplier on the night-grade post-pass strength.
   *   - `sunShafts`   → multiplier on the cone-geometry god-rays opacity.
   *   - `envIntensity` → applied directly to `scene.environmentIntensity` (Three r155+).
   *
   * All `0` = feature off. `1` = ship default. `> 1` boosts. */
  setLightingMultipliers(p: Partial<{
    sun: number; ambient: number; hemi: number; moon: number;
    cameraFill: number; nightGrade: number; sunShafts: number; envIntensity: number;
  }>): void {
    for (const k of ['sun', 'ambient', 'hemi', 'moon'] as const) {
      const v = p[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) this.lightMul[k] = v;
    }
    /* Phase 8h overhaul knobs — accept 0 (off) too, so unlike sun/ambient
     * the gate is `>= 0` rather than `> 0`. */
    if (typeof p.cameraFill === 'number' && Number.isFinite(p.cameraFill) && p.cameraFill >= 0) {
      this.cameraFillMul = p.cameraFill;
    }
    if (typeof p.nightGrade === 'number' && Number.isFinite(p.nightGrade) && p.nightGrade >= 0) {
      this.nightGradeMul = p.nightGrade;
    }
    if (typeof p.sunShafts === 'number' && Number.isFinite(p.sunShafts) && p.sunShafts >= 0) {
      this.sunShaftsMul = p.sunShafts;
    }
    if (typeof p.envIntensity === 'number' && Number.isFinite(p.envIntensity) && p.envIntensity >= 0) {
      this.envIntensityMul = p.envIntensity;
      /* Three r155+: scene.environmentIntensity scales all PMREM IBL contribution. */
      const sceneAny = this.scene as THREE.Scene & { environmentIntensity?: number };
      sceneAny.environmentIntensity = p.envIntensity;
    }
  }

  bindKeyLight(light: THREE.DirectionalLight): void {
    this.keyLight = light;
    const prev = this.moonLight.target;
    if (prev !== light.target) this.scene.remove(prev);
    this.moonLight.target = light.target;
  }

  /**
   * Legacy warm-up hook — kept so the character-preview warm pipeline still links.
   *
   * Previously, this flipped the moon caster state to warm an alternate lit-material variant.
   * Now both directional lights keep `castShadow = true` for the entire session, so there is
   * only **one** program hash to warm and no "night variant" to produce.
   *
   * Returns a no-op restore callback. Safe to remove in a future cleanup.
   */
  warmCelestialPrograms(): () => void {
    return () => {
      /* no-op */
    };
  }

  bindAmbient(light: THREE.AmbientLight): void {
    this.ambientLight = light;
  }

  /**
   * Bind the camera-relative fill light (Phase 8h lighting plan §2). The
   * dock environment will drive its intensity + color per frame. The light
   * itself is owned + parented by CharacterScenePreview (lives under the
   * camera so it tracks the player's view); the dock environment just
   * computes the per-time-of-day brightness + sky-matched tint.
   *
   * Pure data wire-up; no shadows, no camera reparenting here. */
  bindCameraFillLight(light: THREE.DirectionalLight): void {
    this.cameraFillLight = light;
  }

  /**
   * Attach cheap cone-geometry god-rays (Phase 8h lighting plan §6).
   * Idempotent — second call is a no-op. Driven per-frame from the same
   * sun direction the lighting calc uses, so the cone visibly tracks
   * the sun arc through the day.
   *
   * Stylized fantasy "sun shaft" — additive cone that costs nothing
   * (program already cached from existing additive VFX). Visible during
   * day, faded at night, color-warmed at sunset/dawn. */
  attachGodRays(): void {
    if (this.godRays) return;
    this.godRays = attachSunGodRays(this.scene);
  }

  registerWater(meshes: THREE.Mesh[], material: THREE.MeshPhysicalMaterial): void {
    this.waterMaterial = material;
    this.waterMeshes = meshes;
    for (const m of meshes) this.waterRoot.add(m);
  }

  getSunDirection(out: THREE.Vector3): THREE.Vector3 {
    return this.computeSunDirection(out, this.simHour);
  }

  getMoonDirection(out: THREE.Vector3): THREE.Vector3 {
    return moonDirectionTopocentric(
      this.simHour,
      this.totalSimHours / 24,
      this.lunarPhase,
      this.envCfg.observerLatitudeDeg,
      this.envCfg.axialTiltDeg,
      this.envCfg.celestialYearDays,
      this.envCfg.moonInclinationDeg,
      out,
    );
  }

  /** @param hour — same clock as `simHour` (0–24). */
  private computeSunDirection(out: THREE.Vector3, hour: number): THREE.Vector3 {
    return sunDirectionTopocentric(
      hour,
      this.totalSimHours / 24,
      this.envCfg.observerLatitudeDeg,
      this.envCfg.axialTiltDeg,
      this.envCfg.celestialYearDays,
      out,
    );
  }

  private syncProjectWeather(project: IdleEmpireProjectFile | null): void {
    const w = project?.weather as { type?: string; intensity?: number } | undefined;
    const ty = w?.type ?? 'clear';
    const inten = typeof w?.intensity === 'number' ? w.intensity : 0;
    if (ty === 'rain' || ty === 'storm' || ty === 'snow') {
      this.projectSurfaceWater = this.envCfg.surfaceWaterWet * (0.55 + inten * 0.45);
      this.projectStormDim = 0.25 + inten * 0.55;
    } else if (ty === 'cloudy' || ty === 'overcast') {
      this.projectSurfaceWater = this.envCfg.surfaceWaterDry + inten * 0.12;
      this.projectStormDim = 0.12 + inten * 0.28;
    } else {
      this.projectSurfaceWater = this.envCfg.surfaceWaterDry;
      this.projectStormDim = inten * 0.08;
    }
  }

  update(dt: number, project: IdleEmpireProjectFile | null, camera?: THREE.Camera | null): void {
    const perf = createDockEnvProbe();
    try {
      this.runDockEnvironmentUpdate(dt, project, perf, camera ?? null);
    } finally {
      perf?.finish();
    }
  }

  private runDockEnvironmentUpdate(
    dt: number,
    project: IdleEmpireProjectFile | null,
    perf: DockEnvProbe | null,
    camera: THREE.Camera | null,
  ): void {
    if (this.envCfg.hourPerRealSecond > 0) {
      /* === 2026-04-20 night-dwell stretch ===
       *
       * Players spend more meaningful real time in the visually-rich night
       * scene by slowing sim-hour advance when `nightMix` is high. The hour
       * curves themselves are unchanged (sun/moon position still match the
       * clock), so dawn/dusk look identical — there are just MORE real
       * seconds spent in the deep-night band. Speed scaler:
       *   - day (nightMix = 0): full speed (`hourPerRealSecond`).
       *   - full night (nightMix = 1): speed / `nightDurationMul`.
       *   - twilight: smoothly interpolated (no cadence "click" at dawn/dusk).
       *
       * Uses last frame's `lightingDayMixSmoothed` since we don't have a
       * fresh `nightMix` until later in this same update — one-frame lag
       * is invisible at sub-1 Hz cadence changes. */
      const lastNightMix = 1 - this.lightingDayMixSmoothed;
      const nightSlowdown = 1 + (this.envCfg.nightDurationMul - 1) * lastNightMix;
      const effectiveSpeed = this.envCfg.hourPerRealSecond / Math.max(1, nightSlowdown);
      this.totalSimHours += dt * effectiveSpeed;
      this.simHour = THREE.MathUtils.euclideanModulo(this.totalSimHours, 24);
    } else if (project && typeof project.time === 'number') {
      this.simHour = ((project.time % 24) + 24) % 24;
      this.totalSimHours = this.envCfg.lunarDayIndex * 24 + this.simHour;
    }

    this.lunarPhase = lunarPhaseFromTotalHours(
      this.totalSimHours,
      this.envCfg.lunarCycleDays,
      this.envCfg.lunarPhase0,
    );

    this.syncProjectWeather(project);
    /* === 2026-04-22 storm runtime removed === stormDim permanently 0;
     * surfaceWater driven only by project's static weather config (which
     * is `'clear'` by default → `surfaceWaterDry`). See class-level comment
     * on the deleted weatherRuntime field for rationale. */
    this.stormDim = this.projectStormDim;
    this.surfaceWater = THREE.MathUtils.clamp(
      this.projectSurfaceWater,
      this.envCfg.surfaceWaterDry * 0.85,
      Math.max(this.envCfg.surfaceWaterWet, this.projectSurfaceWater) * 1.08,
    );

    const sun = this.computeSunDirection(_tmpSun, this.simHour);
    const sunH = sun.y;
    const period = computeDayPeriodState(this.simHour, sunH);
    const {
      dayMix: dayMixTarget,
      sunsetMix: sunsetMixTarget,
      duskMix: duskMixTarget,
      starOpacity: starOpacityTarget,
      sunWarmth: sunWarmthTarget,
    } = period;
    const twilightLighting =
      (dayMixTarget > 0.035 && dayMixTarget < 0.965) ||
      (sunsetMixTarget > 0.04 && sunsetMixTarget < 0.92) ||
      (duskMixTarget > 0.03 && duskMixTarget < 0.9);
    const belt = horizonBeltWeight(sunH);
    /*
     * EMA tau values in seconds. Bumped further (was 11+16*belt -> 25+30*belt) so the
     * full day -> night transition takes substantially more real time. With more visible
     * seconds spent crossing each color stop the eye perceives a continuous slide rather
     * than detectable steps - addresses player report of "color/tone jumps" through dusk.
     */
    const tauToNight = twilightLighting ? 25 + belt * 30 : 6.5;
    const tauToDay = twilightLighting ? 22 + belt * 26 : 5.8;
    const tau = dayMixTarget < this.lightingDayMixSmoothed ? tauToNight : tauToDay;
    const dtCl = Math.min(Math.max(dt, 1e-4), 0.12);
    const kBlend = 1 - Math.exp(-dtCl / tau);
    this.lightingDayMixSmoothed += (dayMixTarget - this.lightingDayMixSmoothed) * kBlend;
    this.lightingSunsetMixSmoothed += (sunsetMixTarget - this.lightingSunsetMixSmoothed) * kBlend;
    this.lightingDuskMixSmoothed += (duskMixTarget - this.lightingDuskMixSmoothed) * kBlend;
    this.lightingSunWarmthSmoothed += (sunWarmthTarget - this.lightingSunWarmthSmoothed) * kBlend;
    this.lightingStarOpacitySmoothed += (starOpacityTarget - this.lightingStarOpacitySmoothed) * kBlend;

    const dayMix = this.lightingDayMixSmoothed;
    const nightMix = 1 - dayMix;
    const sunsetMix = this.lightingSunsetMixSmoothed;
    const duskMix = this.lightingDuskMixSmoothed;
    const sunWarmth = this.lightingSunWarmthSmoothed;
    const starOpacity = this.lightingStarOpacitySmoothed;

    this.celestialTime += dt;
    updateVegetationWind(this.celestialTime, this.stormDim);
    perf?.split('blendClock');
    this.lastOutdoorDayMix = dayMix;

    /* === Eye-adaptation lite (Phase 8h §7) ===
     *
     * Asymmetric exposure smoothing toward the per-time-of-day target.
     * `tau` is shorter when GOING brighter (eyes pinch fast) and longer
     * when GOING darker (eyes adapt slowly to shadow). Kills the
     * perceptible exposure step at dawn/dusk that the legacy direct-lerp
     * path produced.
     *
     * On the very first tick (`adaptedExposure === 1.0` sentinel which
     * happens to match noon target), we snap to target so the first frame
     * doesn't dramatic-fade from "neutral" to "noon." */
    const exposureTarget = (0.82 + dayMix * 0.34) * (1 - this.stormDim * 0.22);
    if (this.adaptedExposure === 1.0 && Math.abs(exposureTarget - 1.0) > 0.01) {
      /* First-tick snap so boot-time isn't a slow lerp from "neutral" to actual. */
      this.adaptedExposure = exposureTarget;
    } else {
      const goingBrighter = exposureTarget > this.adaptedExposure;
      const tau = goingBrighter ? 0.3 : 1.2;        /* seconds */
      const k = 1 - Math.exp(-Math.min(dt, 0.1) / tau);
      this.adaptedExposure += (exposureTarget - this.adaptedExposure) * k;
    }

    const storm = this.stormDim * (0.85 + 0.15 * nightMix);

    const moon = moonDirectionTopocentric(
      this.simHour,
      this.totalSimHours / 24,
      this.lunarPhase,
      this.envCfg.observerLatitudeDeg,
      this.envCfg.axialTiltDeg,
      this.envCfg.celestialYearDays,
      this.envCfg.moonInclinationDeg,
      _tmpMoon,
    );
    /* === 2026-04-20 day/night transition smoothness fix ===
     *
     * Previously `moonElev = Math.max(0, moon.y)` introduced a derivative
     * discontinuity right when the moon crossed the horizon — `moonStrength`
     * (which gates ambient + hemi + camera fill at night) suddenly stopped
     * decreasing as `moon.y` went negative, reading as a visible brightness
     * "snap" at moonrise / moonset. Smoothstep'd the transition so the moon
     * elevation factor eases from 0 over a small below-horizon band before
     * climbing — no kink, smooth derivative through 0. */
    const moonElev = Math.max(0, moon.y);
    const moonUp = THREE.MathUtils.smoothstep(moon.y, -0.06, 0.42);
    const moonStrength = nightMix * moonUp * (1 - storm * 0.22);
    const moonDiskIllum = lunarIllumination01(this.lunarPhase);
    /*
     * Moon phase multiplier dampened: full moon used to be ~3x (0.11 + 1.0 * 2.85 ≈ 2.96),
     * which at peak elevation flooded ambient/hemi and the moon DirectionalLight — the
     * scene visibly lit up and the "dark magic" (stars, aurora, Milky Way) lost contrast.
     * Full moon now caps at ~1.3x so the moon is still clearly the light source but the
     * scene stays dark enough to enjoy the night layers through the whole moon arc.
     */
    const moonPhaseBrightMul = 0.18 + moonDiskIllum * 1.1;

    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.lerpColors(this.nightFogColor, this.dayBg, dayMix);
      /* Tightened night fog band (0.28 → 0.42 near, 0.35 → 0.55 far) so distant
       * objects desaturate harder at night — atmospheric perspective sells
       * "I am the player on the bright spot, that is the dark world out there."
       * Daytime fog band unchanged. (Phase 8h lighting plan §5.) */
      this.scene.fog.near = this.dayFogNear * (0.82 + nightMix * 0.42);
      this.scene.fog.far = this.dayFogFar * (0.9 + nightMix * 0.55);
    }
    if (this.scene.fog instanceof THREE.Fog) {
      /* === Horizon-tinted fog (Phase 8h lighting plan §5) ===
       *
       * Far objects in landscape painting desaturate toward the HORIZON
       * gradient (peach near sun-at-horizon, deep cool blue at night), NOT
       * the zenith. Idle-craft was lerping fog toward `dayBg` (zenith blue)
       * which made distant trees match the sky at noon but read flat /
       * disconnected from the warm sunset / cool moonlit horizon bands.
       *
       * `horizonInfluence` rises as the sun approaches the horizon (smoothstep
       * sun.y from 0.45 → 0.0) so the warm/cool tint only kicks in during
       * dusk/dawn/night when it's atmospherically motivated. At noon the
       * tint is ~0 and the sky-zenith match is preserved. */
      const horizonInfluence = 1.0 - THREE.MathUtils.smoothstep(sun.y, 0.0, 0.45);
      if (horizonInfluence > 0.02) {
        this._tmpHorizonFog
          .copy(this.horizonCool)
          .lerp(this.horizonWarm, sunWarmth);
        this.scene.fog.color.lerp(this._tmpHorizonFog, horizonInfluence * 0.55);
      }
      this.scene.fog.color.lerp(_tmpGray.setHex(0x6a7588), storm * 0.42);
      /* No threshold gate: the lerp factor at small dusk/sunset values is tiny anyway,
       * but gating it with `if > X` created a visible on/off when the EMA crossed the
       * threshold. Letting it always compute makes the transition perfectly continuous. */
      this.scene.fog.color.lerp(_tmpDuskFog.setRGB(0.12, 0.08, 0.18), duskMix * 0.35);
      this.scene.fog.color.lerp(_tmpSunsetFog.setRGB(0.22, 0.1, 0.08), sunsetMix * 0.22);
    }

    /* === IBL gradient sky update (Phase 8h §1) ===
     *
     * Sync the env-map gradient sphere to the current sky tones so PMREM
     * regeneration produces a per-time-of-day environment. Cheap when not
     * due for regen — just uniform writes. Throttled to ~4 s.
     *
     * Color choices:
     *   - zenith   = lerp(nightFog, dayBg, dayMix) — matches the actual sky-top blend.
     *   - horizon  = horizon fog color we just computed (warm at dusk, cool at night).
     *   - nadir    = ground-bounce darker (~hemi groundColor flavour) so up-facing
     *                normals sample a tinted-dark "earth" while down-facing normals
     *                sample the "sky."
     *   - sunDir   = current sun direction so the IBL specular has a directional bias.
     *   - sunGlow  = warm sunset color × sunWarmth (so the glow lobe is invisible at noon
     *                and prominent at dusk/dawn — exactly when stylized fantasy benefits). */
    if (this.iblPmrem) {
      const ze = _tmpFogZenith.copy(this.nightFogColor).lerp(this.dayBg, dayMix);
      const ho = _tmpFogHorizon
        .copy(this.horizonCool)
        .lerp(this.horizonWarm, sunWarmth)
        .lerp(this.scene.fog instanceof THREE.Fog ? this.scene.fog.color : ze, 0.25);
      const na = _tmpFogNadir.copy(this.nightFogColor).multiplyScalar(0.55);
      const glow = _tmpFogSunGlow.copy(this.colWarm).multiplyScalar(0.6 + sunWarmth * 0.8);
      this.updateIbl({
        zenith: ze,
        horizon: ho,
        nadir: na,
        sunDir: sun,
        sunGlow: glow,
      });
    }

    /**
     * Light intensities (no shadow toggling). Both lights keep `castShadow = true`;
     * below-horizon contributions are zeroed by `sunKeyIntensity` / `moonStrength`, so the
     * shadow pass runs with zero light contribution and is invisible.
     *
     * `sunDirectFrac` band widened again (0.07 → 0.15 → 0.34 units). The old narrow bands
     * made the critical sunset switch snap in ~3–5 seconds before the sun reached the
     * horizon (key intensity + warmth + plasma horizon fade all dropping together in a
     * tight window). Wide band + smoothstep easing = the sun's direct contribution now
     * falls through the whole twilight, finishing near `sun.y = -0.18` instead of −0.09.
     */
    /* Wider band (was −0.18 → 0.16, width 0.34) so the sun's direct
     * contribution easesin/out across the full twilight instead of finishing
     * abruptly. Wider equals slower ramp = no perceived "snap" at sunrise /
     * sunset, paired with the matching widening on `horizonFade` below. */
    const sunDirectFrac = THREE.MathUtils.smoothstep(sun.y, -0.22, 0.22);
    const sunKeyIntensity =
      dayMix * (0.24 + 1.52 * (1 - storm * 0.25)) * sunDirectFrac;

    /* God-rays sun-shaft cone (Phase 8h §6) — orient toward sun + sync
     * opacity from the same `sunDirectFrac` the directional key uses,
     * so the visible shaft fades exactly when the sun stops contributing
     * to direct lighting. Cheap; one mesh + uniform writes. */
    if (this.godRays) {
      /* `sunShaftsMul` is the Esc-tunable multiplier (Phase 8h §6 knob).
       * Folded into `sunDirectFrac` so the shader's whole opacity ladder
       * scales — `0` makes the shafts invisible, `2` doubles them, etc. */
      this.godRays.update({
        sunDir: sun,
        sunDirectFrac: sunDirectFrac * this.sunShaftsMul,
        sunWarmth,
        storm,
      });
    }

    if (this.keyLight) {
      /* Directional light: only **direction** (here → origin) affects shading; distance does not attenuate.
         Keep a modest offset so shadow cameras sit near the scene (same ray as celestial sun). */
      this.keyLight.position.copy(sun).multiplyScalar(6);
      _tmpSunCol.lerpColors(this.colCool, this.colWarm, dayMix * (1 - storm * 0.35));
      /* Always compute warm overlay - lerp factor goes to ~0 when sunWarmth is small,
       * so the visual change is minimal but the function is now continuous. */
      _tmpWarmSun.setRGB(1, 0.82 - sunWarmth * 0.12, 0.62 - sunWarmth * 0.18);
      _tmpSunCol.lerp(_tmpWarmSun, sunWarmth * (0.55 + sunsetMix * 0.35));
      this.keyLight.color.copy(_tmpSunCol);
      this.keyLight.intensity = sunKeyIntensity * this.lightMul.sun;
    }
    /* Threshold gate removed - was `if (sunWarmth > 0.02)` above; replaced with
     * always-compute below using the value directly. Avoids on/off snap when the
     * EMA-smoothed sunWarmth crossed 0.02. */

    this.moonLight.position.copy(moon).multiplyScalar(16);
    _tmpMoonCol.copy(this.colMoonBase);
    _tmpMoonCol.lerp(this.colMoonEdge, 0.22 + moonElev * 0.35);
    this.moonLight.color.copy(_tmpMoonCol);
    /* Moon directional intensity dampened (0.62 -> 0.34). The moon should tint and subtly
     * rim-light the scene, not flood it. Aurora, Milky Way, and stars retain contrast. */
    this.moonLight.intensity = moonStrength * 0.34 * moonPhaseBrightMul * this.lightMul.moon;

    /* === Camera-relative fill light (Phase 8h §2) ===
     *
     * Soft third-person "softbox" — invisible to the player but stops the
     * avatar from going silhouette-flat when their back is to the sun.
     * Intensity follows day/night so it reads as ambient sky bounce, not
     * a fake studio light. Color lerps with the sun warmth so dusk tints
     * the avatar's lit side peach (matches what the world is actually doing).
     *
     * Numbers: ~0.18 of base ambient at noon, fading to ~0.08 × moon
     * strength at night (just enough to keep face/chest readable in the
     * dark while moonlight keeps its mystery). Modulated by `lightMul.ambient`
     * so the player's "Ambient brightness" Esc setting affects it. */
    if (this.cameraFillLight) {
      const fillBase = 0.20 * dayMix + 0.10 * nightMix * moonStrength;
      /* `cameraFillMul` is the Esc-tunable multiplier (Phase 8h §2 knob).
       * Multiplied through `lightMul.ambient` so the existing "Ambient
       * brightness" slider still scales the fill in addition to the new
       * dedicated "Camera fill" slider. */
      this.cameraFillLight.intensity = fillBase * this.lightMul.ambient * this.cameraFillMul;
      this._tmpFillCol
        .copy(this.colCool)
        .lerp(this.colWarm, sunWarmth * (1 - storm * 0.4))
        .lerp(this.colMoonBase, nightMix * 0.55);
      this.cameraFillLight.color.copy(this._tmpFillCol);
    }

    /* Copy key light's shadow frustum once so moon shadows match sun shadow framing. */
    if (!this.moonShadowFrustumSynced && this.keyLight) {
      this.moonLight.shadow.camera.copy(this.keyLight.shadow.camera);
      this.moonLight.shadow.bias = this.keyLight.shadow.bias;
      this.moonLight.shadow.normalBias = this.keyLight.shadow.normalBias;
      this.moonLight.shadow.radius = this.keyLight.shadow.radius;
      this.moonLight.shadow.camera.updateProjectionMatrix();
      this.moonShadowFrustumSynced = true;
    }

    if (camera) {
      _tmpCelestialOffset.copy(moon).multiplyScalar(72).add(camera.position);
      this.moonPoint.position.copy(_tmpCelestialOffset);
    } else {
      this.moonPoint.position.copy(moon).multiplyScalar(72);
    }
    /* Moon point-light intensity dampened (1.15 -> 0.55). Was adding a dome-sized bright
     * halo around the moon direction that lifted scene-adjacent surfaces; now a soft kiss. */
    this.moonPoint.intensity =
      moonStrength * 0.55 * (0.08 + moonElev * 0.35) * moonPhaseBrightMul * this.lightMul.moon;
    this.moonPoint.distance = 95;
    this.moonPoint.color.copy(_tmpMoonCol);

    if (camera) {
      _tmpCelestialOffset.copy(moon).multiplyScalar(CELESTIAL_MOON_SHELL_DISTANCE).add(camera.position);
      this.moonDisc.position.copy(_tmpCelestialOffset);
    } else {
      this.moonDisc.position.copy(moon).multiplyScalar(CELESTIAL_MOON_SHELL_DISTANCE);
    }
    _moonToSun.copy(sun).sub(moon);
    if (_moonToSun.lengthSq() > 1e-14) _moonToSun.normalize();
    else _moonToSun.copy(sun).normalize();
    this.moonShaderMat.uniforms.uSunDir.value.copy(_moonToSun);
    this.moonShaderMat.uniforms.uStorm.value = storm;
    const skyBands = skydomeBandColorsForMoon({
      dayMix,
      sunsetMix,
      duskMix,
      stormDim: this.stormDim,
    });
    this.moonShaderMat.uniforms.uSkyZenith.value.copy(skyBands.zenith);
    this.moonShaderMat.uniforms.uSkyHorizon.value.copy(skyBands.horizon);
    this.moonShaderMat.uniforms.uSkyMid.value.copy(skyBands.mid);

    if (camera) {
      /* Infinite-sky parity: shells centered on the viewer (was world-origin → “coin” wrap + wrong horizon). */
      this.skyDomeMesh?.position.copy(camera.position);
      this.starsBright.position.copy(camera.position);
      this.starsDim.position.copy(camera.position);
      this.starsMilky.position.copy(camera.position);
      this.starsSparkle.position.copy(camera.position);

      if (this.skyDomeMat) {
        const u = this.skyDomeMat.uniforms;
        u.uZenith.value.copy(skyBands.zenith);
        u.uSkyMid.value.copy(skyBands.mid);
        u.uHorizon.value.copy(skyBands.horizon);
        u.uSunDir.value.copy(sun).normalize();
        u.uSunsetMix.value = sunsetMix;
        u.uCameraPosition.value.copy(camera.position);
        u.uNightMix.value = nightMix;
        u.uDuskMix.value = duskMix;
        u.uStorm.value = this.stormDim;
        u.uSunElevation.value = sun.y;
        u.uTime.value = this.celestialTime;
        const uDay = u.uDayMix as { value: number } | undefined;
        if (uDay) uDay.value = dayMix;
        /* Moon direction for the sky shader's moon-occlusion cone on clouds (keeps the disc
         * reading on top of haze during the brief twilight overlap window). */
        const uMoon = u.uMoonDir as { value: THREE.Vector3 } | undefined;
        if (uMoon) uMoon.value.copy(moon).normalize();
      }
    }

    /*
     * Bands widened (0.05..0.26 → 0.04..0.20) so the moon disc crossfades in during twilight
     * rather than appearing only after deep night — matches the widened `sunDirectFrac` and
     * aurora `nightRamp` so the whole transition breathes together at the critical point.
     */
    const moonDiscAlpha =
      THREE.MathUtils.smoothstep(nightMix, 0.04, 0.2) *
      THREE.MathUtils.smoothstep(moonElev, -0.12, 0.03) *
      THREE.MathUtils.smoothstep(moon.y, -0.22, -0.09);
    this.moonShaderMat.uniforms.uOpacity.value = THREE.MathUtils.clamp(moonDiscAlpha, 0, 1);
    /* Visibility stays true — `uOpacity=0` hides the disc in-shader; toggling `visible` at the 0.004
     * threshold forces a first-use compile + state churn at twilight (same problem solved for stars). */

    if (this.plasmaSun) {
      this.plasmaSun.position.copy(_sunNorm.copy(sun).normalize()).multiplyScalar(CELESTIAL_SUN_SHELL_DISTANCE);
      if (camera) this.plasmaSun.position.add(camera.position);
      this.plasmaSun.quaternion.setFromUnitVectors(_zFwd.set(0, 0, 1), _sunNorm.copy(sun).normalize().negate());
      const baseR =
        this.moonDisc.scale.x * (CELESTIAL_SUN_SHELL_DISTANCE / CELESTIAL_MOON_SHELL_DISTANCE);
      horizonDiskParallaxScale(sun, this.envCfg.horizonParallaxStrength, _sunParallaxXy);
      const kPar = 1 - Math.exp(-Math.min(dt, 0.12) * 7.2);
      this.sunParallaxSmoothed.x += (_sunParallaxXy.x - this.sunParallaxSmoothed.x) * kPar;
      this.sunParallaxSmoothed.y += (_sunParallaxXy.y - this.sunParallaxSmoothed.y) * kPar;
      this.plasmaSun.scale.set(
        baseR * this.sunParallaxSmoothed.x,
        baseR * this.sunParallaxSmoothed.y,
        1,
      );
      /* Replaced the piecewise `sunsetMix < 0.85 ? 1 : max(0, …)` cliff with
       * a smoothstep on `sunsetMix` so the plasma sun disc fades through the
       * sunset peak without a corner at 0.85 (visible "snap" right when the
       * sky was at peak orange). Curve: full visible until sunsetMix = 0.78,
       * fully hidden at sunsetMix = 0.96 — same effective range, just C¹.
       *
       * Also widened `horizonFade` band to match the extended `sunDirectFrac`
       * band above so the disc and the directional key fade together with no
       * desync. Previous narrow (−0.06 → 0.05) made the disc "pop off" while
       * the key still contributed. */
      const sunsetTail = 1 - THREE.MathUtils.smoothstep(sunsetMix, 0.78, 0.96);
      const sunDiskVis = dayMix * (1 - storm * 0.55) * sunsetTail;
      const horizonFade = THREE.MathUtils.smoothstep(sun.y, -0.18, 0.12);
      const sunDiskVisEff = sunDiskVis * horizonFade;
      const pMat = this.plasmaSun.material as THREE.ShaderMaterial;
      pMat.uniforms.uTime.value = this.celestialTime;
      /* Strength multiplier reduced from 1.35 to 0.7 so the shader's max output stays
       * below the post-stack bloom threshold (0.92). Previously the plasma sun's bright
       * pixels exceeded the threshold and bloom spread a wide halo around the sun that
       * looked like a "dome chasing the sun" across the sky. The disc still reads as
       * the sun visually; the bloom-driven halo is gone. */
      pMat.uniforms.uStrength.value = sunDiskVisEff * 0.7;
      pMat.uniforms.uStorm.value = storm;
      pMat.uniforms.uSunElevation.value = sun.y;
      /* Keep mesh always on the graph — visibility toggles were a suspected hitch source. Below-horizon
       * kill is entirely in the plasma shader (alpha × horizon) + sunKeyIntensity × sunDirectFrac. */
      this.plasmaSun.visible = true;
    }

    this.hemi.color.lerpColors(this.colHemiSkyNight, this.colHemiSkyDay, dayMix);
    this.hemi.groundColor.lerpColors(this.colHemiGrNight, this.colHemiGrDay, dayMix);
    /* Always compute dusk overlay - tiny lerp factor at small duskMix, but no on/off snap. */
    this.hemi.color.lerp(_tmpHemiDusk.setRGB(0.32, 0.24, 0.42), duskMix * 0.4);
    /* Hemisphere moon contribution dampened (0.06 -> 0.025) so peak-moon doesn't lift the
     * sky-vs-ground hemi fill. Preserves deep-night contrast when the moon is at zenith. */
    this.hemi.intensity =
      (0.32 + dayMix * 0.56 + moonStrength * 0.025 * moonPhaseBrightMul) * this.lightMul.hemi;

    if (this.ambientLight) {
      this.ambientLight.color.lerpColors(this.colAmbNight, this.colAmbDay, dayMix);
      _tmpAmbNight
        .copy(this.colAmbNight)
        .lerp(this.colAmbMoon, moonStrength * 0.55 * (0.35 + 0.65 * moonDiskIllum));
      this.ambientLight.color.lerpColors(_tmpAmbNight, this.colAmbDay, dayMix);
      /* Ambient moon contribution dampened (0.12 -> 0.05). Was the biggest offender —
       * ambient light multiplies across every lit material uniformly, so peak-moon's
       * contribution was globally flattening the scene. Now the moon can shine through
       * the whole lunar arc without the scene visibly brightening. */
      this.ambientLight.intensity =
        (0.26 + dayMix * 0.4 + nightMix * (0.1 + moonStrength * 0.05 * moonPhaseBrightMul)) *
        this.lightMul.ambient;
    }

    const rise = this.surfaceWater * 0.055;
    this.waterRoot.position.y = rise;

    if (this.waterMaterial?.normalMap) {
      this.flowScroll.addScaledVector(this.flowDir, dt * (0.35 + this.surfaceWater * 0.9));
      this.waterMaterial.normalMap.offset.copy(this.flowScroll);
    }

    const tw = 0.86 + 0.14 * Math.sin(this.celestialTime * 2.05);
    const tw2 = 0.82 + 0.18 * Math.sin(this.celestialTime * 1.37 + 1.1);
    const starVis = starOpacity * (1 - storm * 0.55) * this.perfStressScale;
    this.starMatBright.opacity = starVis * 0.98 * tw;
    this.starMatDim.opacity = starVis * 0.58 * tw2;
    this.starMatMilky.opacity = starVis * 0.42 * (0.9 + 0.1 * tw);
    /* Lower amplitude so deep night doesn’t read as dome “flicker” (sparkle is additive). */
    this.starMatSparkle.opacity = starVis * (0.92 + 0.08 * Math.sin(this.celestialTime * 3.2));
    /* Always submit draws — opacity gates visibility. Toggling `visible` at ~0.02 caused one-frame stalls at dawn/dusk. */
    this.starsBright.visible = true;
    this.starsDim.visible = true;
    this.starsMilky.visible = true;
    this.starsSparkle.visible = true;
    perf?.split('lightsPlasmaStars');

    /* Stronger floor so fungi / foxfire read through the night; star + moon gates avoid a single spike only at dawn/dusk. */
    const magicVisRaw =
      nightMix *
      (1 - storm * 0.42) *
      (0.32 + 0.68 * starOpacity * (0.5 + 0.5 * moonStrength));
    const magicVisRiseK = 1 - Math.exp(-dt * 0.85);
    const magicVisFallK = 1 - Math.exp(-dt * 1.05);
    const k = magicVisRaw > this.nightMagicVisSmooth ? magicVisRiseK : magicVisFallK;
    let nextMagic = THREE.MathUtils.lerp(this.nightMagicVisSmooth, magicVisRaw, k);
    /* Cap how fast the field can ramp (tab back / clock jump won’t spike one frame). */
    const refDt = 1 / 60;
    const visualBusy = isDockVisualLowBudget();
    const inTwilight =
      (sunsetMix > 0.05 && sunsetMix < 0.9) ||
      (duskMix > 0.04 && duskMix < 0.88) ||
      (dayMix > 0.07 && dayMix < 0.93 && nightMix > 0.07 && nightMix < 0.93) ||
      Math.abs(sunH) < 0.28 ||
      (dayMix > 0.012 && dayMix < 0.16);
    this.lastTwilightBlendHeavy = inTwilight;
    const maxUp = (visualBusy ? 0.034 : 0.072) * (dt / refDt);
    const maxDown = (visualBusy ? 0.09 : 0.11) * (dt / refDt);
    const dMag = nextMagic - this.nightMagicVisSmooth;
    if (dMag > maxUp) nextMagic = this.nightMagicVisSmooth + maxUp;
    else if (dMag < -maxDown) nextMagic = this.nightMagicVisSmooth - maxDown;
    this.nightMagicVisSmooth = nextMagic;
    this.nightMagicField?.update(dt, this.nightMagicVisSmooth, {
      interactionLowBudget: visualBusy,
      perfScale: this.perfStressScale,
    });
    perf?.split('nightMagic');

    perf?.split('skydome');
  }

  dispose(): void {
    /* Tear down IBL machinery before scene-level disposal so the env
     * texture release happens cleanly. */
    if (this.iblCurrentTarget) {
      this.iblCurrentTarget.dispose();
      this.iblCurrentTarget = null;
    }
    if (this.scene.environment) this.scene.environment = null;
    if (this.iblPmrem) {
      this.iblPmrem.dispose();
      this.iblPmrem = null;
    }
    if (this.iblSkyMat) {
      this.iblSkyMat.dispose();
      this.iblSkyMat = null;
    }
    this.iblEnvScene = null;
    if (this.godRays) {
      this.godRays.dispose();
      this.godRays = null;
    }
    this.nightMagicField?.dispose();
    this.nightMagicField = null;
    this.scene.remove(this.starsBright);
    this.scene.remove(this.starsDim);
    this.scene.remove(this.starsMilky);
    this.scene.remove(this.starsSparkle);
    this.starsBright.geometry.dispose();
    this.starsDim.geometry.dispose();
    this.starsMilky.geometry.dispose();
    this.starsSparkle.geometry.dispose();
    this.starMatBright.dispose();
    this.starMatDim.dispose();
    this.starMatMilky.dispose();
    this.starMatSparkle.dispose();

    this.scene.remove(this.moonPoint);

    this.scene.remove(this.moonDisc);
    this.moonDisc.geometry.dispose();
    this.moonShaderMat.dispose();
    if (this.plasmaSun) {
      this.scene.remove(this.plasmaSun);
      this.plasmaSun.geometry.dispose();
      (this.plasmaSun.material as THREE.Material).dispose();
    }
    this.scene.remove(this.moonLight);
    if (this.moonLight.target !== this.keyLight?.target) {
      this.scene.remove(this.moonLight.target);
    }
    for (const m of this.waterMeshes) {
      m.geometry.dispose();
      this.waterRoot.remove(m);
    }
    this.waterMeshes = [];
    this.waterMaterial = null;
    this.scene.remove(this.waterRoot);
    if (this.skyDomeMesh) {
      this.scene.remove(this.skyDomeMesh);
      this.skyDomeMesh.geometry.dispose();
      this.skyDomeMat?.dispose();
      this.skyDomeMesh = null;
      this.skyDomeMat = null;
    }
  }

  isWaterAt(x: number, z: number): boolean {
    if (!this.resolvedCreeks.length) return false;
    for (const c of this.resolvedCreeks) {
      const pts = c.points;
      const hw = c.halfWidth * 1.35;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        const d = distToSeg2D(x, z, a[0], a[1], b[0], b[1]);
        if (d < hw) return true;
      }
    }
    return false;
  }
}

function createStarField(
  radius: number,
  countBright: number,
  countDim: number,
  countMilky: number,
  countSparkle: number,
): {
  bright: THREE.Points;
  dim: THREE.Points;
  milky: THREE.Points;
  sparkle: THREE.Points;
  matB: THREE.PointsMaterial;
  matD: THREE.PointsMaterial;
  matM: THREE.PointsMaterial;
  matS: THREE.PointsMaterial;
} {
  const posB = new Float32Array(countBright * 3);
  const posD = new Float32Array(countDim * 3);
  const posM = new Float32Array(countMilky * 3);
  const colM = new Float32Array(countMilky * 3);
  const posS = new Float32Array(countSparkle * 3);
  fillUpperHemisphere(posB, radius, 9_211);
  fillUpperHemisphere(posD, radius * 1.02, 42_337);
  fillMilkyWayBand(posM, colM, radius * 0.99, 77_011);
  fillUpperHemisphere(posS, radius * 1.04, 12_359);

  const geoB = new THREE.BufferGeometry();
  geoB.setAttribute('position', new THREE.BufferAttribute(posB, 3));
  const geoD = new THREE.BufferGeometry();
  geoD.setAttribute('position', new THREE.BufferAttribute(posD, 3));
  const geoM = new THREE.BufferGeometry();
  geoM.setAttribute('position', new THREE.BufferAttribute(posM, 3));
  geoM.setAttribute('color', new THREE.BufferAttribute(colM, 3));
  const geoS = new THREE.BufferGeometry();
  geoS.setAttribute('position', new THREE.BufferAttribute(posS, 3));

  const matB = new THREE.PointsMaterial({
    color: 0xf0f8ff,
    size: Math.max(2.1, radius * 0.00125),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });
  const matD = new THREE.PointsMaterial({
    color: 0xa8b8e8,
    size: Math.max(1.15, radius * 0.00068),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });
  /**
   * Milky Way stars reinforce the shader wash — per-vertex color (warm gold near the
   * galactic core direction, cold violet-blue in the arms) so the point layer reads as
   * part of the galaxy, not a flat blue haze. Aligned to the same pole axis as the wash.
   */
  const matM = new THREE.PointsMaterial({
    color: 0xffffff,
    vertexColors: true,
    size: Math.max(0.92, radius * 0.00048),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });
  const matS = new THREE.PointsMaterial({
    color: 0xffffff,
    size: Math.max(5.5, radius * 0.0032),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
    fog: false,
    toneMapped: false,
  });

  return {
    bright: new THREE.Points(geoB, matB),
    dim: new THREE.Points(geoD, matD),
    milky: new THREE.Points(geoM, matM),
    sparkle: new THREE.Points(geoS, matS),
    matB,
    matD,
    matM,
    matS,
  };
}

/**
 * Dense Milky Way band aligned to the shader wash's galactic pole + core directions.
 *
 * Pole axis (perpendicular to galactic plane) and core direction are the same constants the
 * sky fragment uses (`mwPole`, `mwCore`) so point stars sit **inside** the procedural wash.
 * Stars are distributed in a tight band (small distance from the plane) with upper-hemisphere
 * bias so most are visible. Per-vertex color uses the warm-to-cold gradient.
 */
const MW_POLE: [number, number, number] = (() => {
  const x = 0.28,
    y = 0.82,
    z = 0.5;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
})();
const MW_CORE: [number, number, number] = (() => {
  const x = -0.46,
    y = 0.12,
    z = 0.88;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
})();

function fillMilkyWayBand(
  outPos: Float32Array,
  outCol: Float32Array,
  radius: number,
  seed: number,
): void {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const [px, py, pz] = MW_POLE;
  const [cx, cy, cz] = MW_CORE;
  const warmColor: [number, number, number] = [0.95, 0.78, 0.5];
  const pinkColor: [number, number, number] = [0.82, 0.5, 0.72];
  const violetColor: [number, number, number] = [0.52, 0.4, 0.78];
  const coldColor: [number, number, number] = [0.42, 0.56, 0.92];
  const n = outPos.length / 3;
  let written = 0;
  let attempt = 0;
  while (written < n && attempt < n * 24) {
    attempt++;
    /* Uniform point on the unit sphere (Marsaglia). */
    let ux = 0,
      uy = 0,
      uz = 0;
    for (let k = 0; k < 16; k++) {
      const x = rand() * 2 - 1;
      const y = rand() * 2 - 1;
      const z = rand() * 2 - 1;
      const l2 = x * x + y * y + z * z;
      if (l2 < 1e-6 || l2 > 1) continue;
      const l = Math.sqrt(l2);
      ux = x / l;
      uy = y / l;
      uz = z / l;
      break;
    }
    /* Reject if below the horizon — keeps the band visible from a forest dock at night. */
    if (uy < 0.05) continue;
    /* Distance from the galactic plane via `|dot(dir, pole)|`; keep stars close to plane so
     * the Points layer sits inside the wash band, not scattered across the sphere. */
    const planeDist = Math.abs(ux * px + uy * py + uz * pz);
    const bandBias = planeDist < 0.12 ? 1 : planeDist < 0.3 ? 0.35 : 0.08;
    if (rand() > bandBias) continue;
    outPos[written * 3] = ux * radius;
    outPos[written * 3 + 1] = uy * radius;
    outPos[written * 3 + 2] = uz * radius;
    /* Color: warm gold near the galactic core direction, pink/violet in the middle, cold blue
     * in the far arms. Mixes with a tiny jitter so no two stars are identical. */
    const coreT = Math.max(0, Math.min(1, (ux * cx + uy * cy + uz * cz + 0.1) / 1.05));
    const jitter = (rand() - 0.5) * 0.08;
    const t = Math.max(0, Math.min(1, coreT + jitter));
    let r: number, g: number, b: number;
    if (t >= 0.7) {
      const k = (t - 0.7) / 0.3;
      r = pinkColor[0] + (warmColor[0] - pinkColor[0]) * k;
      g = pinkColor[1] + (warmColor[1] - pinkColor[1]) * k;
      b = pinkColor[2] + (warmColor[2] - pinkColor[2]) * k;
    } else if (t >= 0.4) {
      const k = (t - 0.4) / 0.3;
      r = violetColor[0] + (pinkColor[0] - violetColor[0]) * k;
      g = violetColor[1] + (pinkColor[1] - violetColor[1]) * k;
      b = violetColor[2] + (pinkColor[2] - violetColor[2]) * k;
    } else {
      const k = t / 0.4;
      r = coldColor[0] + (violetColor[0] - coldColor[0]) * k;
      g = coldColor[1] + (violetColor[1] - coldColor[1]) * k;
      b = coldColor[2] + (violetColor[2] - coldColor[2]) * k;
    }
    outCol[written * 3] = r;
    outCol[written * 3 + 1] = g;
    outCol[written * 3 + 2] = b;
    written++;
  }
  /* If rejection sampling produced fewer stars than requested (unlikely with these bias
   * values), leave the tail as zeros — they'll sit at origin with black color, invisible. */
}

function fillUpperHemisphere(out: Float32Array, radius: number, seed: number): void {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const n = out.length / 3;
  for (let i = 0; i < n; i++) {
    let nx = 0;
    let ny = 1;
    let nz = 0;
    for (let tries = 0; tries < 48; tries++) {
      const x = rand() * 2 - 1;
      const y = rand() * 2 - 1;
      const z = rand() * 2 - 1;
      const len = Math.hypot(x, y, z);
      if (len < 1e-6) continue;
      nx = x / len;
      ny = y / len;
      nz = z / len;
      if (ny < 0.04) continue;
      break;
    }
    out[i * 3] = nx * radius;
    out[i * 3 + 1] = ny * radius;
    out[i * 3 + 2] = nz * radius;
  }
}

const _tmpSun = new THREE.Vector3();
const _tmpMoon = new THREE.Vector3();
const _tmpCelestialOffset = new THREE.Vector3();
const _moonToSun = new THREE.Vector3();
const _sunNorm = new THREE.Vector3();
const _zFwd = new THREE.Vector3();
const _sunParallaxXy = { x: 1, y: 1 };
const _tmpGray = new THREE.Color();
const _tmpMoonCol = new THREE.Color();
const _tmpAmbNight = new THREE.Color();
const _tmpSunCol = new THREE.Color();
const _tmpWarmSun = new THREE.Color();
const _tmpDuskFog = new THREE.Color();
const _tmpSunsetFog = new THREE.Color();
const _tmpHemiDusk = new THREE.Color();
/* IBL gradient sphere uniform scratch (Phase 8h §1) — module-level so the
 * per-frame env-color compute path doesn't allocate. */
const _tmpFogZenith = new THREE.Color();
const _tmpFogHorizon = new THREE.Color();
const _tmpFogNadir = new THREE.Color();
const _tmpFogSunGlow = new THREE.Color();

function distToSeg2D(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const apx = px - ax;
  const apz = pz - az;
  const ab2 = abx * abx + abz * abz || 1;
  let t = (apx * abx + apz * abz) / ab2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + abx * t;
  const qz = az + abz * t;
  return Math.hypot(px - qx, pz - qz);
}
