/**
 * Persistent character preview: LPCA-style procedural avatar, PBR materials, gather + page actions,
 * equipment attachments. Environmental props are parented to the avatar so grounding stays consistent.
 */
import { createRendererAsync, fetchEmpireProject, type IdleEmpireProjectFile } from '../engine/idleCraftEngine';
import { getGraphicsBudget, resolveGraphicsTier, type GraphicsBudget } from '../engine/graphicsTier';
import { getEffectiveRendererDisplay } from '../engine/rendererDisplaySettings';
import { dockPerfBegin, dockPerfEnd, dockPerfMark } from '../engine/dockInitPerformance';
import {
  applyPostProcessingOptionsToStack,
  getEffectivePostProcessingOptionsForPreview,
  isPostProcessingEnabled,
} from '../engine/postProcessingFromProject';
import { PostProcessingStack } from 'empire-engine/render/PostProcessingStack';
import { createNightGradePass, syncNightGradeUniforms } from '../engine/nightGradePass';
import { installHalfLambertOnMaterial } from './halfLambertLighting';
import * as THREE from 'three';
import { cardById } from '../data/content';
import { playFootstepSound } from '../audio/audioBridge';
import { CHARACTER_PRESETS, getCharacterPreset } from '../data/characterPresets';
import type { CharacterBuildKind } from '../data/characterPresets';
import type { CharacterPresetId, CraftStation, EquipmentState } from '../core/types';
import type { RemotePresenceEntry, RoomPlayerPublic } from '../net/roomTypes';
import { createArtisanHairPhysicalBase } from './artisanFemaleLPCA';
import { buildDockHeroLpca } from './dockHeroFigureLPCA';
import { createVanguardStaffOrbVfx, type VanguardStaffOrbVfxHandle } from './vanguardStaffOrbVfx';
import { applyDockIdleBodyLayer } from '../data/dockCharacterMotion';
import type { DockAmbientPageContext } from '../data/dockCharacterMotion';
import {
  buildAxeMesh,
  buildPickMesh,
  buildShieldMesh,
  buildSwordMesh,
  disposeGroupContents,
  isAxeWeaponId,
  isSwordWeaponId,
} from './characterEquipment';
import { attachForestBackdrop } from './forestEnvironment';
import { shouldSkipFrameForFpsCap } from '../ui/fpsMonitor';
import {
  schedulePostTaskCancellable,
  yieldToEventLoop,
  type CancellablePostTask,
} from '../util/mainThreadYield';
import type { IdleCraftDockEnvironment } from '../world/idleCraftDockEnvironment';
import {
  isDockVisualLowBudget,
  setDockCraftVisualBusy,
  setDockTravelGatherClipActive,
} from '../world/idleCraftDockInteractionBudget';
import { createDockPreviewProbe } from '../debug/idleCraftDockFrameProbe';
import {
  DOCK_SOLO_CAM_OFFSET_X,
  DOCK_SOLO_CAM_OFFSET_Y,
  DOCK_SOLO_CAM_OFFSET_Z,
  dockSoloIdleFaceYawRad,
} from '../world/idleCraftDockCameraCompass';
import { readDockSpawn } from '../world/idleCraftWorldTypes';
import { waterGatherBankXZ } from '../world/idleCraftHeightfield';
import { IDLE_CRAFT_GATHER_XZ } from '../world/idleCraftGatherWorld';
import {
  actionIdToHarvestKind,
  allHarvestSlotPositions,
  HARVEST_NODE_KINDS,
  type HarvestNodeKind,
} from '../world/idleCraftHarvestNodes';
import {
  createCampfireLPCA,
  createHandTorchLPCA,
  createWorkbenchLPCA,
  type CampfireLPCA,
  type HandTorchLPCA,
  type WorkbenchLPCA,
} from './craftStationDecorLPCA';
import { createPveEnemyLPCA, type PveBattleRig } from './pveEnemyLPCA';
import { buildLobbyDockHeroFromPreset, LOBBY_DOCK_HERO_WORLD_SCALE } from './lobbyDockHeroFromPreset';
import { createPlasmaPortalLPCA, type PlasmaPortalLPCA } from './plasmaPortalLPCA';
import {
  buildIdleCraftAppleTree,
  buildIdleCraftBerryBush,
  buildIdleCraftFiberGrass,
  buildIdleCraftGardenBed,
} from './goeStyleHarvestLPCA';
import { getDockGatherClipDurationMs, getDockGatherSfxDelayMs } from './dockGatherClipDurations';
import { computeSoloCameraClipFloorY } from '../world/dockSoloCameraFraming';

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

/** Inverse of {@link easeInOut} on [0,1] — maps eased phase (e.g. TR_WALK1) to linear clip progress. */
function inverseEaseInOut(y: number): number {
  const x = Math.max(0, Math.min(1, y));
  if (x < 0.5) return Math.sqrt(x / 2);
  return 1 - Math.sqrt((1 - x) / 2);
}

/** Canonical gather centers — ring slots derived in {@link CharacterScenePreview.harvestSlotByKind}. */
const GATHER_WORLD = IDLE_CRAFT_GATHER_XZ;

const GATHER_STANDOFF = 0.34;

/**
 * CSS-pixel size of the preview box. Returned values feed `renderer.setSize(w, h, false)`,
 * `camera.aspect = w / h`, and `postProcessing.setSize(w, h, ...)` — so they MUST match the
 * displayed canvas aspect ratio exactly, otherwise the browser stretches the buffer to fill
 * the CSS box and the rendered scene reads as horizontally / vertically squashed.
 *
 * **No internal width / height cap.** The legacy `min(1680, w)` cap broke aspect ratio in
 * fullscreen awakened mode (where the canvas is `100vw × 100vh` on screens > 1680px wide):
 * width clamped to 1680 while height stayed full, giving a buffer that the browser then
 * stretched horizontally to fill the wider CSS box. The right place to cap fragment work is
 * `computeEffectivePixelRatio` (which scales the *render multiplier* down while preserving
 * the buffer's aspect), not this CSS-size lookup. Deck-mode `.character-preview-root` already
 * enforces `max-width: 1680px` in CSS, so removing the JS cap is a no-op for the preview box
 * and a fix for the awakened-mode fullscreen path.
 *
 * `clientWidth` + hand-rolled 16:9 can disagree with `aspect-ratio` by ~1px; some Chromium
 * builds (Brave fullscreen) then show a bright seam — fall through to the `getBoundingClientRect`
 * path first so the buffer matches the actual rendered box.
 */
function dockPreviewDrawSize(container: HTMLElement): { w: number; h: number } {
  const r = container.getBoundingClientRect();
  let w = Math.round(r.width);
  let h = Math.round(r.height);
  if (w >= 8 && h >= 8) {
    return { w: Math.max(64, w), h: Math.max(64, h) };
  }
  const cw = container.clientWidth;
  const ch = container.clientHeight;
  if (cw >= 8 && ch >= 8) {
    return { w: Math.max(64, Math.round(cw)), h: Math.max(64, Math.round(ch)) };
  }
  if (cw >= 8) {
    const ww = Math.max(64, Math.round(cw));
    return { w: ww, h: Math.max(64, Math.round((ww * 9) / 16)) };
  }
  return { w: 960, h: 540 };
}

function presetForSession(sid: string): CharacterPresetId {
  let h = 0;
  for (let i = 0; i < sid.length; i++) h = (h * 31 + sid.charCodeAt(i)) >>> 0;
  return CHARACTER_PRESETS[h % CHARACTER_PRESETS.length]!.id;
}

/**
 * PvE face-off: enemy rest is **offset from player rest** (`travelHomeX/Z`), not absolute world  - 
 * dock/home moved in project.json; fixed XZ used to leave the rat far from the avatar.
 */
const BATTLE_ENEMY_OFFSET_X = 0.605;
const BATTLE_ENEMY_OFFSET_Z = 0.275;
const BATTLE_PLAYER_LUNGE = 0.175;
const BATTLE_ENEMY_LUNGE = 0.14;

function gatherApproachPoint(
  hx: number,
  hz: number,
  tx: number,
  tz: number,
  standOff: number,
): { x: number; z: number } {
  const dx = tx - hx;
  const dz = tz - hz;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len;
  const uz = dz / len;
  return { x: tx - ux * standOff, z: tz - uz * standOff };
}

/** Y rotation so local +Z faces the target on XZ (Three.js default forward). */
function gatherFaceY(hx: number, hz: number, tx: number, tz: number): number {
  return Math.atan2(tx - hx, tz - hz);
}

/** Lerp yaw the short way (clean turn-back toward home / camera without a long wrap). */
function lerpYaw(a: number, b: number, t: number): number {
  let d = b - a;
  d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return a + d * t;
}

function bloodSmoothstep(edge0: number, edge1: number, x: number): number {
  const d = edge1 - edge0 || 1;
  const t = Math.max(0, Math.min(1, (x - edge0) / d));
  return t * t * (3 - 2 * t);
}

function bloodMix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Organic alpha + color in one map: deep brown-red rim, brighter crimson core (pooled / wet film).
 * Reads as liquid with clearcoat + low roughness, not hard primitives.
 */
function createBloodLiquidTexture(seed: number): THREE.CanvasTexture {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const rnd = (i: number): number => {
    const s = Math.sin(seed * 127.1 + i * 311.7) * 43758.5453123;
    return s - Math.floor(s);
  };
  const img = ctx.createImageData(size, size);
  const data = img.data;
  const cx = size * 0.5;
  const cy = size * 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / (size * 0.41);
      const dy = (y - cy) / (size * 0.41);
      const ang = Math.atan2(dy, dx);
      const dist = Math.hypot(dx, dy);
      const irreg =
        0.68 +
        rnd(Math.floor(ang * 24) + 3) * 0.32 +
        Math.sin(ang * 7 + seed * 0.55) * 0.11 +
        Math.cos(ang * 4 - seed * 0.3) * 0.07;
      const edge = Math.max(0.35, irreg);
      let a = 1 - bloodSmoothstep(edge * 0.74, edge * 1.08, dist);
      if (dist > edge * 1.02) a = 0;
      a *= 0.86 + rnd(x + y * size) * 0.14;
      const core = Math.max(0, 1 - dist / edge);
      const wet = Math.pow(core, 0.42);
      const r = bloodMix(44, 168, wet);
      const g = bloodMix(3, 22, Math.pow(core, 0.52));
      const b = bloodMix(6, 30, Math.pow(core, 0.48));
      const idx = (y * size + x) * 4;
      data[idx] = Math.floor(r);
      data[idx + 1] = Math.floor(g);
      data[idx + 2] = Math.floor(b);
      data[idx + 3] = Math.floor(Math.min(255, a * 255));
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function createBattleBloodPhysicalMaterial(
  map: THREE.CanvasTexture,
  roughness: number,
  clearcoat: number,
): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    roughness,
    metalness: 0.03,
    clearcoat,
    clearcoatRoughness: 0.12,
    ior: 1.42,
    side: THREE.DoubleSide,
    toneMapped: true,
    polygonOffset: true,
    polygonOffsetFactor: -1.1,
    polygonOffsetUnits: -1.1,
    emissive: new THREE.Color(0x3a080c),
    emissiveIntensity: 0.07,
  });
}

/** Phase splits: turn → walk out → work → turn at spot toward home → walk forward home → face camera */
const TR_TURN1 = 0.11;
const TR_WALK1 = 0.38;
const TR_WORK = 0.72;
const TR_TURN_BACK = 0.79;
const TR_WALK_HOME = 0.93;

function stdMat(opts: {
  color: number;
  metalness?: number;
  roughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: opts.color,
    metalness: opts.metalness ?? 0.08,
    roughness: opts.roughness ?? 0.72,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 0,
  });
}

type ClipId =
  | 'idle'
  | 'stone_hands'
  | 'wood'
  | 'mine'
  | 'fiber'
  | 'water'
  | 'berries'
  | 'hunt'
  | 'garden'
  | 'magic'
  | 'craft_hammer'
  | 'equip_adjust'
  | 'battle_strike'
  | 'battle_cast'
  | 'battle_enemy_strike'
  | 'battle_enemy_death'
  | 'battle_player_death'
  | 'hire_wave'
  | 'eat_meat'
  | 'eat_berries'
  | 'drink_consume'
  | 'bandage_apply'
  | 'stim_inject'
  | 'repair_item'
  | 'portal_enter';

const TRAVEL_GATHER_CLIPS: ReadonlySet<ClipId> = new Set([
  'stone_hands',
  'wood',
  'mine',
  'fiber',
  'berries',
  'water',
  'garden',
  'hunt',
]);

const CLIP_DURATION: Record<Exclude<ClipId, 'idle'>, number> = {
  stone_hands: 4.25,
  wood: 5.15,
  mine: 4.25,
  fiber: 4.15,
  water: 4.05,
  berries: 4.15,
  hunt: 4.15,
  garden: 4.35,
  magic: 1.15,
  craft_hammer: 0.78,
  equip_adjust: 0.5,
  battle_strike: 0.58,
  battle_cast: 0.62,
  battle_enemy_strike: 0.56,
  battle_enemy_death: 1.12,
  battle_player_death: 1.22,
  hire_wave: 0.72,
  eat_meat: 0.75,
  eat_berries: 0.65,
  drink_consume: 0.7,
  bandage_apply: 0.85,
  stim_inject: 0.55,
  repair_item: 0.8,
  portal_enter: 3.45,
};

/**
 * Target wall-clock duration (seconds) for awakened-mode in-place harvest swings.
 * The work motion (axe swing, bucket dip, pick arc, hand pluck, etc.) plays in this
 * many seconds regardless of the underlying clip's full duration.
 *
 * Previous design used `1 / (TR_WORK - TR_WALK1)` ≈ 2.94× boost which produced
 * ~1.75 s wall-clock for `wood` (5.15 s clip × 0.34) — players reported the loop
 * "took too long" between presses. 0.55 s feels snappy without looking frantic and
 * matches the natural cadence of `battle_strike` (0.58 s).
 */
const IN_PLACE_HARVEST_TARGET_SEC = 0.55;

/**
 * Wall-clock duration (seconds) for the smooth pose blend after a clip ends.
 * The captured limb pose at clip-end (axe-overhead, bucket-dip, pickaxe-arc,
 * etc.) lerps toward the idle / walking pose over this window so the avatar
 * doesn't visibly leap from harvest pose to neutral on the very next frame.
 *
 * 0.30 s feels punchy: the clip's last visual beat (axe coming down) settles
 * into rest within ~5 frames at 60 FPS, fast enough that the player isn't left
 * staring at a "lazy unwind" but slow enough to read as a deliberate transition
 * rather than a snap. Matches `IN_PLACE_HARVEST_TARGET_SEC` (0.55) in spirit:
 * both prioritise snappy gameplay cadence over animation polish.
 */
const POST_CLIP_BLEND_DURATION_SEC = 0.30;

/**
 * World units/sec for dock idle routing — matches {@link applyTravelGather} outbound leg for wood
 * (same distance / same eased time slice as the gather clip).
 */
function computeDockWalkSpeedMatchWoodGather(homeX: number, homeZ: number): number {
  const tw = GATHER_WORLD.woodTree;
  const dest = gatherApproachPoint(homeX, homeZ, tw.x, tw.z, GATHER_STANDOFF);
  const dist = Math.hypot(dest.x - homeX, dest.z - homeZ);
  const u0 = inverseEaseInOut(TR_TURN1);
  const u1 = inverseEaseInOut(TR_WALK1);
  const walkSec = Math.max(0.08, (u1 - u0) * CLIP_DURATION.wood);
  const v = dist / walkSec;
  return Math.max(0.55, Math.min(6.5, v));
}

export type AppPageContext =
  | 'gather'
  | 'craft'
  | 'inventory'
  | 'decks'
  | 'idle'
  | 'rpg'
  | 'battle'
  | 'hire'
  | 'portal';

function actionIdToClip(id: string): ClipId {
  switch (id) {
    case 'stone':
      return 'stone_hands';
    case 'wood':
      return 'wood';
    case 'mine_iron_ore':
    case 'mine_coal':
    case 'mine_copper_ore':
    case 'mine_tin_ore':
    case 'mine_zinc_ore':
    case 'mine_silver_ore':
    case 'mine_gold_ore':
    case 'mine_platinum_ore':
      return 'mine';
    case 'fiber':
      return 'fiber';
    case 'water':
      return 'water';
    case 'berries':
      return 'berries';
    case 'hunt':
      return 'hunt';
    case 'skin':
      /* Awakened-mode mob-corpse skinning — re-use the kneeling stone-hands clip
       * as the placeholder body motion (kneel + reach + work). The clip's
       * existing pose reads as "doing manual work in place" which is close
       * enough to skinning that the player gets clear visual feedback. A custom
       * `skin` clip with a knife prop + radial cut motion is a future polish
       * pass — wire here so that work doesn't require touching this dispatch
       * map again, just `'skin'` -> `'<new_clip_id>'`. */
      return 'stone_hands';
    case 'tend_garden':
      return 'garden';
    case 'ley_residue':
      return 'magic';
    default:
      return 'idle';
  }
}

function oreAccentForMineAction(id: string): number {
  switch (id) {
    case 'stone':
      return 0x8a8a92;
    case 'mine_coal':
      return 0x2a2a30;
    case 'mine_copper_ore':
      return 0xb87333;
    case 'mine_tin_ore':
      return 0xc5c5ce;
    case 'mine_zinc_ore':
      return 0x9a9a88;
    case 'mine_silver_ore':
      return 0xd0dae2;
    case 'mine_gold_ore':
      return 0xd4af37;
    case 'mine_platinum_ore':
      return 0xe4e0ea;
    default:
      return 0x6e7a88;
  }
}

function resourceKeyToAccent(key: string): number {
  if (key.includes('wood')) return 0x6b4423;
  if (key.includes('stone')) return 0x7a7a82;
  if (key.includes('coal')) return 0x333338;
  if (key.includes('copper')) return 0xb87333;
  if (key.includes('tin')) return 0xc0c0c8;
  if (key.includes('zinc')) return 0xa8a898;
  if (key.includes('silver')) return 0xd0dae2;
  if (key.includes('gold')) return 0xd4af37;
  if (key.includes('platinum')) return 0xe4e0ea;
  if (key.includes('iron')) return 0x5c6b7a;
  if (key.includes('berry') || key.includes('herb')) return 0xc45c8e;
  if (key.includes('meat') || key.includes('food')) return 0xc45c3e;
  if (key.includes('water')) return 0x4488cc;
  if (key.includes('magic') || key.includes('dust')) return 0x6b5cff;
  if (key.includes('fiber')) return 0x5a8f5a;
  return 0x556070;
}

export class CharacterScenePreview {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  private readonly avatar = new THREE.Group();
  /** Preset-driven PBR materials — colors updated in applyCharacterPreset. */
  private readonly avatarSkinMat: THREE.MeshStandardMaterial;
  private readonly avatarUndertunicMat: THREE.MeshStandardMaterial;
  private readonly avatarJerkinMat: THREE.MeshStandardMaterial;
  private readonly avatarTrimMat: THREE.MeshStandardMaterial;
  private readonly avatarPantsMat: THREE.MeshStandardMaterial;
  private readonly avatarBootMat: THREE.MeshStandardMaterial;
  private readonly avatarHairMat: THREE.MeshStandardMaterial;
  private readonly avatarHatBandMat: THREE.MeshStandardMaterial;
  private readonly avatarHatTopMat: THREE.MeshStandardMaterial;
  private readonly avatarHatBrimMat: THREE.MeshStandardMaterial;
  /** Frontier hat — toggled vs smith bandana per preset. */
  private hatGroup!: THREE.Group;
  /** Artisan bandana — LPCA strip + knot. */
  private smithBandanaGroup!: THREE.Group;
  private activeCharacterPresetId: CharacterPresetId = 'vanguard';
  /* === 2026-04-22 first-call sentinel for idempotency early-return ===
   *
   * `activeCharacterPresetId` defaults to `'vanguard'` as a placeholder so
   * the field type stays non-nullable, but the constructor does NOT call
   * `applyCharacterPreset` — visibility toggles for vanguard-specific
   * geometry (`vanguardWizardRobeRoot`, `vanguardWizardBeardRoot`,
   * `vanguardWizardHatRoot`, `vanguardWizardStaffRoot`) only run inside
   * `applyCharacterPreset`'s build-switch.
   *
   * Without this flag, the early-return guard at the top of
   * `applyCharacterPreset` would skip the function body the first time it
   * was called with `id === 'vanguard'` (matching the placeholder), leaving
   * the wizard parts at their `buildDockHeroLpca` default visibility — the
   * "wizard is gone" bug from the first idempotency landing. */
  private presetApplied = false;
  /* Same first-call sentinel for `syncEquipment`. The equipment fields
   * default to `null`; a fresh save with all-null equipment matches the
   * defaults, which would skip the body INCLUDING the trailing
   * `updateVanguardWizardAttachmentVisibility()` call. The flag forces the
   * first call to run the full body. */
  private equipmentApplied = false;
  private activeCharacterBuild: CharacterBuildKind = 'vanguard_wizard';
  private lpcaShPadL!: THREE.Mesh;
  private lpcaShPadR!: THREE.Mesh;
  private lpcaNeck!: THREE.Mesh;
  private lpcaCranium!: THREE.Mesh;
  private lpcaJaw!: THREE.Mesh;
  private lpcaChin!: THREE.Mesh;
  private lpcaCheekL!: THREE.Mesh;
  private lpcaCheekR!: THREE.Mesh;
  private lpcaDefaultHair!: THREE.Mesh;
  private lpcaArtisanHair!: THREE.Group;
  private readonly artisanHairPrimaryMat: THREE.MeshPhysicalMaterial;
  private readonly artisanHairStreakMat: THREE.MeshPhysicalMaterial;
  /** Male dock trunk lathes — hidden when forge-wife torso is active. */
  private trunkUnderMesh!: THREE.Mesh;
  private trunkJerkinMesh!: THREE.Mesh;
  private glassesGroup!: THREE.Group;
  /** Male dock face primitives (hidden for `artisan_female`; forge-wife head replaces). */
  private maleDockFaceList!: THREE.Object3D[];
  private forgeWifeHeadRoot!: THREE.Group;
  private forgeWifeTorsoRoot!: THREE.Group;
  private forgeWifeOverlayRoot!: THREE.Group;
  private forgeWifeLipMat!: THREE.MeshPhysicalMaterial;
  private forgeWifeIrisMat!: THREE.MeshStandardMaterial;
  /** Vanguard wizard LPCA — procedural robe / hat / staff (default preset). */
  private vanguardWizardRobeRoot!: THREE.Group;
  private vanguardWizardBeardRoot!: THREE.Group;
  private vanguardWizardHatRoot!: THREE.Group;
  private vanguardWizardStaffRoot!: THREE.Group;
  private vanguardStaffWoodMat!: THREE.MeshStandardMaterial;
  private vanguardStaffGemMat!: THREE.MeshPhysicalMaterial;
  /** Staff tip orb + point light + gold dust trail (vanguard wizard). */
  private vanguardStaffOrbVfx!: VanguardStaffOrbVfxHandle;
  private readonly faceNeutral = {
    jaw: new THREE.Vector3(),
    chin: new THREE.Vector3(),
    cheek: new THREE.Vector3(),
    cranium: new THREE.Vector3(),
    shPad: new THREE.Vector3(),
  };
  private torso!: THREE.Group;
  private headRoot!: THREE.Group;
  private armL!: THREE.Group;
  private armR!: THREE.Group;
  private legLMesh!: THREE.Mesh;
  private legRMesh!: THREE.Mesh;
  private footLMesh!: THREE.Mesh;
  private footRMesh!: THREE.Mesh;
  private readonly handL = new THREE.Group();
  private readonly handR = new THREE.Group();
  /** Right-hand carry during idle: weapon, or pick if no weapon */
  private readonly heldInRightHand = new THREE.Group();
  /** Pick in left hand when weapon + pick (no shield) */
  private readonly pickLeftHand = new THREE.Group();
  /** Pick mesh only during mine clip — consistent grip; hides belt/left/held picks */
  private readonly minePickRight = new THREE.Group();
  /** Pick on belt when both weapon + pick equipped */
  private readonly pickOnBelt = new THREE.Group();
  private readonly prop = new THREE.Group();
  private readonly logMesh: THREE.Mesh;
  private readonly propAxeGroup = new THREE.Group();
  private readonly bucketMesh: THREE.Group;
  private readonly bushMesh: THREE.Group;
  private readonly meatMesh: THREE.Mesh;
  private readonly plantMesh: THREE.Group;
  private readonly orbMesh: THREE.Mesh;
  private readonly battleSpark: THREE.Mesh;
  private readonly rockMesh: THREE.Mesh;
  private readonly stonePileMesh: THREE.Group;
  private readonly fiberBundleMesh: THREE.Group;
  /** Target tree for wood gather (behind character, toward -Z). */
  private woodTreeMesh!: THREE.Group;
  private readonly rockOreMat: THREE.MeshPhysicalMaterial;
  private readonly rim: THREE.PointLight;

  /** World-space gather props on character's +X (their right; camera faces them from the front) */
  private readonly interactionRoot = new THREE.Group();
  private readonly rationMesh: THREE.Mesh;
  private readonly berrySnackMesh: THREE.Mesh;
  private readonly waterskinMesh: THREE.Group;
  private readonly bandageMesh: THREE.Group;
  private readonly stimMesh: THREE.Mesh;

  private readonly shieldMount = new THREE.Group();

  private readonly enemyRoot = new THREE.Group();
  /** Humanoid enemy arms/head/torso for strike animation; null for rat/wolf. */
  private enemyBattleRig: PveBattleRig | null = null;
  private readonly battleBloodRoot = new THREE.Group();
  /** Face-hit splatter + vertical drips before ground pool (player punch-up or deserter struck). */
  private readonly battleBloodFaceRoot = new THREE.Group();
  private readonly bloodDripMeshes: THREE.Mesh[] = [];
  private readonly bloodFaceBurstMeshes: THREE.Mesh[] = [];
  private readonly bloodFaceSnapshotWorld = new THREE.Vector3();
  /** Shirt / pants decals parented to victim torso during face-hit cascade. */
  private readonly battleBloodShirtRoot = new THREE.Group();
  private readonly battleBloodPantsRoot = new THREE.Group();
  private readonly bloodShirtStainMeshes: THREE.Mesh[] = [];
  private readonly bloodShirtDripMeshes: THREE.Mesh[] = [];
  private readonly bloodPantsStainMeshes: THREE.Mesh[] = [];
  private bloodBodyStainVictim: 'player' | 'enemy' | null = null;
  private bloodDripFallDist = 0.35;
  private bloodDripElapsed = 0;
  private static readonly BLOOD_DRIP_DURATION = 0.58;
  /** Human face cascade (player + deserter): trigger earlier than rat / leg gore. */
  private static readonly BLOOD_IMPACT_MIN = 0.12;
  private static readonly BLOOD_FACE_IMPACT_MIN = 0.045;
  /** First paint stays readable while strike curve is still ramping. */
  private static readonly BLOOD_FACE_PEAK_FLOOR = 0.52;
  /** Pretend elapsed time so face/shirt phases start on the hit frame (not one tick late). */
  private static readonly BLOOD_FACE_DRIP_HEAD_START = 0.22;
  private readonly bloodBlobMeshes: THREE.Mesh[] = [];
  private readonly bloodStreakMeshes: THREE.Mesh[] = [];
  private readonly bloodSplatMeshes: THREE.Mesh[] = [];
  private readonly tmpHitWorld = new THREE.Vector3();
  private readonly tmpStreakPos = new THREE.Vector3();
  private readonly tmpOpponentDelta = new THREE.Vector3();
  /** Active PvE id for battle clips (`e_rat`, `e_wolf`, default deserter), or `pvp_rival`. */
  private battleEnemyId: string | null = null;
  /** Preset for online PvP rival dock figure when {@link battleEnemyId} is `pvp_rival`. */
  private pvpRivalDockPreset: CharacterPresetId | null = null;
  /** Skip rebuilding the enemy group when the id is unchanged (keeps defeat pose on victory). */
  private syncedBattleEnemyId: string | null = null;
  /** After a lethal player attack, play `battle_enemy_death` when the strike/cast clip ends. */
  private pendingEnemyDeathAfterStrike = false;
  /** Enemy is in fallen corpse pose until the next encounter or dock reset. */
  private battleEnemyCorpseFallen = false;
  private playerDeathAnimStarted = false;
  /** Gore stays in world space and fades after hits (seconds). */
  private bloodLifeRemaining = 0;
  private bloodPeakSnapshot = 0;
  private bloodFadePreset:
    | 'default'
    | 'player_face_spew'
    | 'player_leg'
    | 'enemy_rat_torso'
    | 'enemy_human_face_drip' = 'default';
  private readonly bloodAnchorWorld = new THREE.Vector3();
  /** Scene floor Y for battle splatter (avatar/enemy rest on y=0). */
  private static readonly BLOOD_GROUND_Y = 0.004;
  private static readonly BLOOD_LINGER_TOTAL = 1.95;
  private static readonly BLOOD_HOLD_FRAC = 0.22;
  private readonly portalVfx = new THREE.Group();
  private portalPlasma: PlasmaPortalLPCA | null = null;
  private readonly craftDecorGroup = new THREE.Group();
  private readonly craftCampfireSlot = new THREE.Group();
  private readonly craftBenchSlot = new THREE.Group();
  private campfireLPCA: CampfireLPCA | null = null;
  private workbenchLPCA: WorkbenchLPCA | null = null;
  /**
   * Phantom PointLights kept on the scene from boot for the entire session, parked at the
   * campfire pit's world position with `intensity = 0`. The campfire LPCA reuses these via
   * `CampfireLPCAOptions` instead of creating fresh PointLights at craft-time, which would
   * flip `numPointLights` and force a synchronous shader recompile of every lit material in
   * the scene — same root pattern as the first-sunset shadow-light freeze in `LEARNINGS.md`.
   */
  private campfirePhantomFireLight: THREE.PointLight | null = null;
  private campfirePhantomHotLight: THREE.PointLight | null = null;
  /**
   * Phantom PointLight kept parented to the avatar's right hand from boot for the entire
   * session, with `intensity = 0` until a torch is shown. The torch LPCA reuses this via
   * `HandTorchLPCAOptions` instead of creating a fresh PointLight at show-time — same
   * root cause as the campfire freeze (toggling a fresh PointLight visible flips
   * `numPointLights` and forces a scene-wide shader recompile, ~5+ s freeze on first
   * use). The phantom is always counted by Three.js's lighting state so torch-show /
   * torch-hide cycles never change the program hash. See LEARNINGS.md "Campfire 5-second
   * freeze — point-light count churn (2026-04-17)" for the full pattern.
   */
  private handTorchPhantomFireLight: THREE.PointLight | null = null;
  /**
   * `'awakened'` disables all the dock-mode auto-routing in `applyIdle` (snap-back to
   * camp, idle-rotate-to-face-camp) so WASD-driven movement isn't fought every frame
   * by the dock's "return home" routing. Camera stays the dock's existing solo follow
   * framing — left-click-drag still orbits, wheel still zooms, double-click still resets.
   * Set via `setAwakenedFreeRoam()` from `mountApp` on `realmMode` flip.
   */
  private awakenedFreeRoam = false;
  /**
   * Set to true by `mountApp` (which polls `freeRoamHandle.isAirborne()`) while the
   * player is mid-jump in awakened mode. The per-frame `syncAvatarFeetToTerrain` snap
   * is skipped while this is true so the jump's vertical velocity doesn't get cancelled
   * back to terrain Y every frame. Reset to false on landing (or when realm flips back).
   */
  private freeRoamAirborne = false;
  /**
   * Optional provider returning the surface Y the player is currently standing
   * on (terrain Y, OR top of a foundation / floor / stair / rock the player
   * walked onto). Returns null when grounded on bare terrain or while airborne.
   *
   * Wired by `mountApp` via `setSurfaceYProvider(freeRoamHandle.getGroundedSurfaceY)`.
   * `syncAvatarFeetToTerrain` consults this in awakened mode so the per-frame
   * foot-snap stops yanking the player back down to terrain when they're standing
   * on a 0.55 m stair / 0.15 m foundation / 0.05 m floor piece.
   */
  private surfaceYProvider: (() => number | null) | null = null;
  /**
   * When true, `harvestXZ` returns the avatar's CURRENT position (not the dock's
   * hardcoded harvest slot for that kind) — and `travelHomeX/Z` is also held to current.
   * Result: the gather clip's walk-to-target / walk-back lerps collapse to no-op (lerp
   * from current → current → current), only the WORK phase visibly does anything (axe
   * swing, bucket dip, etc.). Lets awakened-mode players see the harvest animation in
   * place without the deck-mode "walk to resource and back" choreography. Cleared
   * automatically when the gather clip ends (in `loop()`).
   */
  private inPlaceHarvestActive = false;
  /**
   * Optional callback fired when the current in-place harvest clip ends. Used by callers
   * (e.g. mob-corpse skinning in `mountApp`) to defer side-effects (corpse despawn, loot
   * grant, damage floater) until the kneel/work animation finishes — without this hook
   * the corpse vanishes the instant E is pressed, making the animation read as "nothing
   * happened" because the visual target is already gone. Cleared automatically when fired
   * OR when a new in-place clip starts (the new clip replaces the pending callback).
   */
  private inPlaceCompleteCb: (() => void) | null = null;
  /**
   * Transient build-context populated during the staged preload pipeline (`create()`'s
   * `await drainBuildPhases()` chain). Holds intermediate values (sun direction from
   * `attachForestBackdrop`, the `cfg` record for post-processing config, the constructed
   * key + ambient lights pre-binding) that need to flow between phases without polluting
   * the long-term field surface. Cleared once `_phaseStartRenderLoop()` runs so we don't
   * keep references to one-shot build vars alive for the session.
   */
  private buildCtx: {
    cfg: Record<string, unknown>;
    w: number;
    h: number;
    sunDirection: THREE.Vector3 | null;
    keyLight: THREE.DirectionalLight | null;
    ambientFill: THREE.AmbientLight | null;
  } | null = null;
  /** Craft tab props only after player has built that station (inventory). */
  private hasCraftCampfire = false;
  private hasCraftWorkbench = false;
  private handTorchLPCA: HandTorchLPCA | null = null;
  /** Hysteresis for dock torch visibility — avoids flicker and shader churn around dusk (single 0.38 cut). */
  private torchNightCarryHysteresis = false;
  private hasTorchInventory = false;
  /** Mirrors {@link GameState.torchEquipped} — L key + HUD refresh. */
  private torchEquipped = true;
  private readonly huntPreyGroup = new THREE.Group();

  private raf = 0;
  private lastTime = performance.now();
  private clip: ClipId = 'idle';
  private clipTime = 0;
  private playing = false;
  private idlePhase = 0;
  /** Drives short walk cycle when lerping between dock home and craft stands (non-gather idle). */
  private dockRouteWalkT = 0;
  /**
   * Awakened-mode walk cycle phase accumulator. Independent of `dockRouteWalkT`
   * (which is gated off in awakened mode) so the WASD walk animation can run without
   * being entangled with deck-mode auto-routing state. Reset to 0 when the avatar
   * stops moving.
   */
  private awakenedWalkT = 0;
  /**
   * Footstep cadence tracker — number of step contacts fired so far. Each integer
   * increment on `awakenedWalkT * 2` corresponds to one foot landing (left at even
   * counts, right at odd). Comparing the floored value frame-over-frame triggers exactly
   * one footstep SFX per step contact regardless of frame rate. Reset when motion stops.
   */
  private awakenedLastStepCount = 0;
  /**
   * Smoothed walk-pose amplitude (0..1). Exponentially eases toward a
   * `smoothstep(speed, 0.05, 1.5)` target so the limb-swing pose blends
   * gracefully in and out of motion. Without this, the awakened walk-cycle had
   * a hard `> 0.2` speed gate — players visibly saw legs/arms SNAP from
   * mid-stride to neutral the frame their velocity decayed past the threshold
   * (the user-reported "snaps to a different position like his start position
   * when I stop"). Symmetric on the press side: pose now grows from rest into
   * stride instead of popping in mid-cycle.
   */
  private awakenedWalkAmp = 0;
  /**
   * Post-clip pose-blend state. When a gather / harvest clip ends, the avatar's
   * limbs are mid-pose (axe overhead, bucket dipped, pickaxe arc, etc.) and the
   * very next frame the idle pose snaps them to neutral — a visible "leap."
   *
   * To smooth that, at clip-end we capture the current limb rotations + torso
   * pose into `postClipCaptured`, then for `POST_CLIP_BLEND_DURATION_SEC` of
   * wall-clock time we lerp the displayed pose back from that captured snapshot
   * toward whatever `applyIdle` is computing this frame. Sentinel `-1` = no
   * blend active.
   */
  private postClipBlendT = -1;
  private readonly postClipCaptured = {
    torsoY: 0,
    torsoRotX: 0, torsoRotY: 0, torsoRotZ: 0,
    headRotX: 0, headRotY: 0, headRotZ: 0,
    armLRotX: 0, armLRotY: 0, armLRotZ: 0,
    armRRotX: 0, armRRotY: 0, armRRotZ: 0,
    legLRotX: 0, legLRotY: 0, legLRotZ: 0,
    legRRotX: 0, legRRotY: 0, legRRotZ: 0,
  };
  /** Last frame's avatar XZ — used to detect WASD-driven motion in awakened idle. */
  private awakenedLastAvatarX = 0;
  private awakenedLastAvatarZ = 0;
  private hoverAccent = 0x88aaff;
  private pageContext: AppPageContext = 'gather';
  /** After portal_enter completes, keep VFX off until user leaves Portal tab (avoids flash before redirect). */
  private portalExitPending = false;

  /** Hunter / bracket duel: face-off layout vs default PvE dock. */
  private pvpDockLayout: 'off' | 'duel' | 'bracket' = 'off';
  /** In online duels, non-host mirrors to +X like Hunter camp so battle seating matches pre-fight. */
  private pvpDuelGuestSeat = false;
  private bracketAliveCount = 2;
  /** Hunter 1v1 outside battle: duel-style spacing + always-visible peer. */
  private hunterSharedWorldActive = false;
  /** When true, local survivor sits on the +X side facing the host (non-host client only). */
  private hunterDuoGuestSeat = false;
  private readonly peerDuoRoot = new THREE.Group();
  /** Cached full-torso hunter peer (rebuilt when rival session or preset changes). */
  private hunterPeerFig: THREE.Group | null = null;
  private hunterPeerFigKey = '';
  /** Network target XZ + face point for hunter peer (smoothed in {@link smoothHunterPeerFigure}). */
  private hunterPeerTargetX = 0;
  private hunterPeerTargetZ = 0;
  private hunterPeerFaceTx = 0;
  private hunterPeerFaceTz = 0;
  private hunterPeerSmoothReady = false;
  private static readonly HUNTER_PEER_SMOOTH_PER_SEC = 22;
  private static readonly HUNTER_PEER_SNAP_DIST = 0.85;
  /** Co-op awakened world peers — same shared XZ frame as local free-roam. */
  private static readonly AWAKEN_COOP_PEER_SMOOTH_PER_SEC = 18;
  private static readonly AWAKEN_COOP_PEER_SNAP_DIST = 2.2;
  private readonly presenceGhostRoot = new THREE.Group();
  private readonly awakenedCoopPeerRoot = new THREE.Group();
  private readonly awakenCoopPeerFigs = new Map<string, THREE.Group>();
  private readonly awakenCoopPeerFigKeys = new Map<string, string>();
  private readonly awakenCoopPeerTargets = new Map<string, { x: number; y: number; z: number; yaw: number }>();
  private readonly awakenCoopPeerSmoothReady = new Map<string, boolean>();
  private readonly presenceHud = document.createElement('div');
  private readonly framingCamPos = new THREE.Vector3(
    DOCK_SOLO_CAM_OFFSET_X,
    DOCK_SOLO_CAM_OFFSET_Y,
    DOCK_SOLO_CAM_OFFSET_Z,
  );
  private readonly framingLookAt = new THREE.Vector3(-0.05, 0.4, 0.02);
  private framingFov = 44;
  /** Scales layout FOVs vs legacy 44Â° baseline when `graphics.fov` is set in project.json. */
  private readonly projectFovScale: number;
  private readonly renderScale: number;
  private postProcessing: PostProcessingStack | null = null;
  /**
   * Awakened-mode active flag. `true` while the player is in awakened/free-roam realm,
   * `false` in deck mode. Drives the per-frame budget evaluation in
   * `computeEffectivePixelRatio` and `applyDockPostProcessing` — both of those check
   * the current AwakenedQualityTier (see {@link getEffectiveRendererDisplay}) which the
   * player picks in the Esc menu.
   *
   * **Why it's a tier, not a binary:** awakened mode goes from a small embedded preview
   * (~200-400 K pixels/frame) to fullscreen HiDPI (~8 M pixels/frame). Without trimming,
   * frame time at fullscreen goes from ~10 ms to 25-40 ms (30-40 FPS) on integrated GPUs.
   * The tier lets the player pick the tradeoff:
   *   - `'perf'`     — DPR cap 1.0 + bloom OFF + SSAO OFF.   Best FPS.
   *   - `'balanced'` — DPR cap 1.0 + bloom ON  + SSAO OFF.   Magic glows back, modest cost.
   *   - `'full'`     — no DPR cap + bloom ON  + SSAO ON.    Pristine on dedicated GPUs.
   *
   * The Phase 8h lighting overhaul (PMREM IBL, camera fill, half-Lambert, night grade,
   * horizon fog, god-rays, eye-adapt) keeps running identically across all three tiers
   * — the budget only trims legacy heavy passes that were the dominant frame-time
   * contributors. */
  private awakenedRenderBudget = false;
  /** Distance multiplier vs layout default (wheel zoom). Smoothed toward `userCameraZoomTarget`. */
  private userCameraZoom = 1;
  private userCameraZoomTarget = 1;
  /**
   * Awakened-mode camera-lock flag (Phase 1.5 — see `cameraLockController.ts` +
   * `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §12). When true:
   *   - The orbit drag handler short-circuits (the lock controller writes yaw/pitch
   *     directly via `setCameraYawPitch`).
   *   - The double-click camera-reset handler short-circuits (Esc reset would fight
   *     the locked framing).
   *   - WASD + jump physics still work normally.
   * Set via `setCameraLockActive()`. Defaults to false (free-cursor mode).
   */
  private cameraLockActive = false;
  /**
   * Over-the-shoulder offset, world units, applied ONLY while `cameraLockActive` is
   * true. Applied to BOTH the camera position AND the look-at point so the view
   * direction stays parallel to the unmodified "behind-the-back" framing — this
   * keeps the screen-center reticle pointed where the projectile will fly (accurate
   * trajectory) while moving the avatar off-center.
   *
   * Tuning: avatar is ~1.8 m tall. The Y bump (1.55 m) raises the reticle by almost
   * the full character height — the screen-center ray now passes just above the
   * avatar's shoulder rather than through their chest, so the reticle is genuinely
   * "over the shoulder" in world space, not behind it. The X shift (0.4 m) is small
   * — the avatar stays near screen-center horizontally; the lift does most of the
   * work to clear them out of the line-of-sight.
   *
   * Earlier values (0.85 right / 0.18 up) put the avatar in the LEFT third of the
   * screen but kept the reticle at chest height — the player reported the reticle
   * still felt "on" the player. The lift solves that without making the avatar
   * shift sideways too aggressively.
   */
  private static readonly SHOULDER_OFFSET_RIGHT = 0.4;
  private static readonly SHOULDER_OFFSET_UP = 1.55;
  /** Extra yaw/pitch (rad) applied around the layout look-at pivot.
   *
   * **Smoothing model (2026-04-20 pan-smoothness fix):** pointer / wheel
   * handlers write to the `*Target` fields below; the displayed `dockCamYaw`
   * / `dockCamPitch` / `dockCamPan` / `userCameraZoom` are exponentially
   * smoothed toward those targets every frame inside `tickCameraSmoothing`
   * (called from `loop()` before `applyCameraFraming`). This decouples
   * pointer-event frequency (often 120-240 Hz on modern devices) from the
   * per-frame camera apply (60 Hz typical) and removes the "raw delta"
   * jitter that made orbit/pan feel sticky. Smoothing rate uses
   * `1 - exp(-rate * dt)` so the feel is identical at 30 Hz and 144 Hz. */
  private dockCamYaw = 0;
  private dockCamPitch = 0;
  /** World-space shift of orbit pivot (camera + target move together before orbit). */
  private readonly dockCamPan = new THREE.Vector3();
  /** Smoothing targets — pointer/wheel handlers write here, render loop lerps current toward these. */
  private dockCamYawTarget = 0;
  private dockCamPitchTarget = 0;
  private readonly dockCamPanTarget = new THREE.Vector3();
  private dockCamDragging = false;
  private dockCamDragKind: 'orbit' | 'pan' | null = null;
  private dockCamLastX = 0;
  private dockCamLastY = 0;
  /** Exponential smoothing rate (1/s). Higher = snappier. ~22 → reach 90% in ~100ms. */
  private static readonly DOCK_CAM_SMOOTH_RATE_ORBIT = 22;
  private static readonly DOCK_CAM_SMOOTH_RATE_PAN = 25;
  private static readonly DOCK_CAM_SMOOTH_RATE_ZOOM = 16;
  /** Lower = closer to character (wheel zoom in). */
  private static readonly DOCK_ZOOM_MIN = 0.2;
  private static readonly DOCK_ZOOM_MAX = 2.35;
  private static readonly DOCK_PAN_MAX = 5.7;
  /** Dock idle: walk speed (world units/s) — set in ctor to match wood gather outbound pace. */
  private dockRouteWalkSpeed: number;
  /** Start craft_hammer once within this distance of the stand point. */
  private static readonly DOCK_ARRIVE_EPS = 0.052;
  /** Orbit: radians per pixel (screen-style: drag up → look up). */
  private static readonly DOCK_ORBIT_YAW_PER_PX = 0.0055;
  private static readonly DOCK_ORBIT_PITCH_PER_PX = 0.0045;
  /** Pan: world-ish feel; horizontal matches screen X, vertical inverted so drag-down pulls view down. */
  private static readonly DOCK_PAN_PER_PX = 0.0075;
  /** Solo dock: look-at chest offset from avatar root (camera XZ from `idleCraftDockCameraCompass`). */
  private static readonly DOCK_FRAME_LOOK_DX = 0.01;
  private static readonly DOCK_FRAME_LOOK_DY = 0.4;
  private static readonly DOCK_FRAME_LOOK_DZ = 0.02;
  private readonly onWheelCamera = (e: WheelEvent): void => {
    e.preventDefault();
    const dy = e.deltaY;
    const factor = dy > 0 ? 1.06 : 0.94;
    /* Write the zoom TARGET — `tickCameraSmoothing` lerps `userCameraZoom`
     * toward it next frame so consecutive wheel events feel smooth instead
     * of step-wise. */
    this.userCameraZoomTarget = Math.max(
      CharacterScenePreview.DOCK_ZOOM_MIN,
      Math.min(CharacterScenePreview.DOCK_ZOOM_MAX, this.userCameraZoomTarget * factor),
    );
  };
  private readonly onDockPointerDown = (e: PointerEvent): void => {
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const pan = e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey);
    this.dockCamDragging = true;
    this.dockCamDragKind = pan ? 'pan' : 'orbit';
    this.dockCamLastX = e.clientX;
    this.dockCamLastY = e.clientY;
    /* `setPointerCapture` throws InvalidStateError if the pointer isn't
     * "active" anymore (e.g., the pointerdown event was synthesized, the
     * pointer was already released by the time this handler runs, or the
     * canvas isn't currently in the DOM tree because of a fast-mount race).
     * The capture is a nice-to-have for drag-out-of-canvas tracking, not
     * required for the basic orbit/pan to work — silently fall back to the
     * default behaviour rather than throwing into the console. */
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* pointer not capturable in current state — drag still works without */
    }
    (e.currentTarget as HTMLElement).style.cursor = pan ? 'grabbing' : 'grab';
  };
  private readonly onDockPointerMove = (e: PointerEvent): void => {
    if (!this.dockCamDragging || !this.dockCamDragKind) return;
    const dx = e.clientX - this.dockCamLastX;
    const dy = e.clientY - this.dockCamLastY;
    this.dockCamLastX = e.clientX;
    this.dockCamLastY = e.clientY;
    if (this.dockCamDragKind === 'orbit') {
      /* Camera-lock mode owns yaw/pitch via mouse-look (`cameraLockController`); the
       * orbit drag here would fight those writes, so short-circuit while locked. */
      if (this.cameraLockActive) return;
      /* Screen-oriented orbit (Sketchfab / many game viewers): drag right → orbit right; drag up → tilt up.
       * Writes to TARGET — `tickCameraSmoothing` lerps the visible yaw/pitch
       * toward the target each frame, decoupling pointer rate (often >120 Hz)
       * from render rate so motion reads silky instead of jittery. */
      this.dockCamYawTarget += dx * CharacterScenePreview.DOCK_ORBIT_YAW_PER_PX;
      this.dockCamPitchTarget += dy * CharacterScenePreview.DOCK_ORBIT_PITCH_PER_PX;
    } else {
      this.camera.updateMatrixWorld(true);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion);
      const k = CharacterScenePreview.DOCK_PAN_PER_PX;
      /* Drag right → pivot + camera slide right on screen; drag down → pull scene down (intuitive map grab). */
      this.dockCamPanTarget.add(right.multiplyScalar(-dx * k));
      this.dockCamPanTarget.add(up.multiplyScalar(-dy * k));
      const pl = this.dockCamPanTarget.length();
      if (pl > CharacterScenePreview.DOCK_PAN_MAX) {
        this.dockCamPanTarget.multiplyScalar(CharacterScenePreview.DOCK_PAN_MAX / pl);
      }
    }
  };

  /**
   * Frame-rate-independent exponential smoothing of dock camera state toward
   * the targets set by pointer / wheel handlers. Called at the top of each
   * `loop()` frame, before `applyCameraFraming` reads the displayed values.
   *
   * Uses `1 - exp(-rate * dt)` so the time to reach 90% of a step input is
   * the same at 30 Hz and 144 Hz: ~`2.3 / rate` seconds (e.g. ~104 ms for
   * the orbit rate of 22). Cheaper than Hermite / spring math and stable
   * under variable dt (which we have due to the FPS cap and load adapt).
   *
   * Pan smoothing operates on each component independently so a brief
   * change in drag direction doesn't cause an unwanted Z-component drift.
   */
  private tickCameraSmoothing(dt: number): void {
    const dtClamped = Math.max(0.001, Math.min(0.1, dt));
    const kOrbit = 1 - Math.exp(-CharacterScenePreview.DOCK_CAM_SMOOTH_RATE_ORBIT * dtClamped);
    const kPan = 1 - Math.exp(-CharacterScenePreview.DOCK_CAM_SMOOTH_RATE_PAN * dtClamped);
    const kZoom = 1 - Math.exp(-CharacterScenePreview.DOCK_CAM_SMOOTH_RATE_ZOOM * dtClamped);
    this.dockCamYaw += (this.dockCamYawTarget - this.dockCamYaw) * kOrbit;
    this.dockCamPitch += (this.dockCamPitchTarget - this.dockCamPitch) * kOrbit;
    this.dockCamPan.x += (this.dockCamPanTarget.x - this.dockCamPan.x) * kPan;
    this.dockCamPan.y += (this.dockCamPanTarget.y - this.dockCamPan.y) * kPan;
    this.dockCamPan.z += (this.dockCamPanTarget.z - this.dockCamPan.z) * kPan;
    this.userCameraZoom += (this.userCameraZoomTarget - this.userCameraZoom) * kZoom;
  }
  private readonly endDockPointerDrag = (target: HTMLElement): void => {
    this.dockCamDragging = false;
    this.dockCamDragKind = null;
    target.style.cursor = '';
  };

  private readonly onDockPointerUp = (e: PointerEvent): void => {
    this.endDockPointerDrag(e.currentTarget as HTMLElement);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  private readonly onDockLostCapture = (e: Event): void => {
    this.endDockPointerDrag(e.currentTarget as HTMLElement);
  };
  private readonly onDockContextMenu = (e: Event): void => {
    e.preventDefault();
  };
  private readonly onDockDblClick = (): void => {
    /* Skip while camera-lock is active — resetting would yank the player out of
     * their aimed framing right after they finish a fight or place a piece. The user
     * can deactivate lock with Q to restore double-click reset. */
    if (this.cameraLockActive) return;
    this.resetDockCameraView();
  };

  /** Avatar XZ + Y rotation when a travel gather clip starts (restored after clip). */
  private travelHomeX = 0;
  private travelHomeZ = 0;
  private travelHomeRotY = 0;
  /** Enemy rest position when an enemy-strike clip starts (lunges toward player then restores). */
  private enemyStrikeAnchorX = 0;
  private enemyStrikeAnchorZ = 0;

  private clipSpeedMultiplier = 1;

  private equippedWeapon: string | null = null;
  private equippedPick: string | null = null;
  /** Set in syncEquipment — used for battle-page shield visibility. */
  private equippedShield: string | null = null;
  /** Weapon + pick: pick rides on belt */
  private showPickOnBelt = false;
  /** Weapon + pick, no shield: pick shown in left hand */
  private showPickInLeftHand = false;

  private baseTorsoY = 0;
  private container: HTMLElement;
  private readonly empireProject: IdleEmpireProjectFile | null;
  private dockEnvironment: IdleCraftDockEnvironment | null = null;
  /** Per-frame updaters for animated forest props (e.g. spinning sky-crystal seal).
   * Sourced from `attachForestBackdrop` and called inside the render loop with `dt`. */
  private sceneTickers: ((dt: number) => void)[] = [];
  /** Disposers paired with `sceneTickers` — called from the dispose path so animated
   * props release GPU resources cleanly. */
  private sceneDisposers: (() => void)[] = [];
  /** Night torch waits until a few WebGL frames complete so first visibility does not stack with skydome + shader compile. */
  private previewCompletedRenders = 0;
  /**
   * When set, {@link loop} still advances clips / idle / env tickers (main-thread deck logic)
   * but skips WebGL `render` / composer present. Used when a hidden companion preview coexists
   * with {@link CharacterSceneHost} owning the visible dock (Phase 3.x-C shadow diet).
   */
  private suppressPresentation = false;
  /**
   * Stagger revealing campfire / workbench slots (GPU: emissive flames + point lights) so they do not
   * compile in the same frame as the hand torch. Frames count down once per {@link loop}.
   */
  private craftCampfireRevealHold = 0;
  private craftWorkbenchRevealHold = 0;
  /** After decor slots finish their reveal hold, extra frames before allowing a newly-lit torch (shader compile spacing). */
  private torchAfterHeavyDecorFrames = 0;
  private craftDecorBuildRaf = 0;
  /**
   * Deferred shader warm-up handle — cancelled on {@link dispose}. Round 5
   * phase F1: holds a {@link CancellablePostTask} (was a numeric rIC/timeout
   * handle) so we can route through `scheduler.postTask({priority:'background'})`
   * on Chrome/Edge/FF and still cancel cleanly across all backend paths.
   */
  private dockWarmTask: CancellablePostTask | null = null;
  /** Two-frame defer before GPU warm so first paint + audio can interleave (see {@link deferDockGpuWarm}). */
  private dockWarmDeferTask: CancellablePostTask | null = null;
  private craftDecorBuildGeneration = 0;
  /** True while a deferred {@link buildCraftDecor} is in flight — avoids overlapping queues from repeated refreshHud. */
  private craftDecorMeshAwaiting = false;
  /** Coalesce rapid {@link refreshHud} calls so craft unlock does not stack main-thread work. */
  private craftDecorHudRaf = 0;
  private pendingCraftCampfire = false;
  private pendingCraftWorkbench = false;
  /** Set when {@link playCraftHammer} runs — limits fire snap / torch-cook pose to campfire recipes. */
  private craftHammerStation: CraftStation | null = null;
  /** Campfire / workbench: walk to stand first, then {@link startClip}('craft_hammer'). */
  private pendingDockCraft: CraftStation | null = null;
  /** After hammer at campfire/workbench, walk back to {@link craftCentralStandXZ} before the next craft. */
  private craftReturnToHub = false;
  /** Moving average frame ms — drives {@link IdleCraftDockEnvironment.setPerfStressScale}. */
  private dockPerfEmaMs = 17;
  private dockPerfScale = 1;
  private containerResizeObs: ResizeObserver | null = null;
  /** Baked neutral exposure; multiplied each frame by {@link IdleCraftDockEnvironment.getExposureMultiplier}. */
  private baseToneMappingExposure = 0.82;
  private dockKeyLight: THREE.DirectionalLight | null = null;
  /**
   * Camera-relative fill light (Phase 8h lighting plan §2 — third-person
   * "softbox"). A low-intensity DirectionalLight parented to the camera so
   * it tracks the player's view. Stops the avatar from going silhouette-flat
   * when their back is to the sun. Color tracks the sky so it never reads
   * as a "fake studio light." Driven per-frame from the dock environment's
   * day-mix curve via {@link syncCameraFillLightFromDock}.
   *
   * **Constraint compliance:** allocated ONCE at attach (phantom-light slot),
   * intensity scaled to 0 when not needed, `castShadow = false` so it
   * doesn't add to the shadow-light count. */
  private cameraFillLight: THREE.DirectionalLight | null = null;
  /** Injected night-grade post pass (Phase 8h §4). Null when post stack is off. */
  private nightGradePass: import('three/examples/jsm/postprocessing/ShaderPass.js').ShaderPass | null = null;
  private mapRadius = 44;
  private readonly dockHomeX: number;
  private readonly dockHomeZ: number;
  /** River-bank XZ for manual water gather (from project hydrology + dock). */
  private readonly gatherWaterXZ: { x: number; z: number };
  /** Ring offsets per harvest kind — rebuilt from {@link gatherWaterXZ}. */
  private harvestSlotByKind!: Record<HarvestNodeKind, { x: number; z: number }[]>;
  /** Slot index chosen for the current / last manual gather clip (matches game store reservation). */
  private activeHarvestSlotIndex = 0;
  /** 0-0.5 lerp from ring slot toward camp per kind (RPG pathfinding mastery). */
  private gatherTravelTowardHome01: Partial<Record<HarvestNodeKind, number>> = {};
  /** Multiplier on travel-gather clip duration per kind (shorter walk at high pathfinding). */
  private gatherClipDurationByKind: Partial<Record<HarvestNodeKind, number>> = {};
  private getTerrainHeight: ((x: number, z: number) => number) | null = null;
  /**
   * World-space XZ of the existing on-map crystal scatter (`scatterIdleCraftCrystalProps`).
   * Free-roam harvest mode uses these so crystal-mining happens at the SAME positions the
   * visual crystals sit at, rather than spawning a parallel set. Populated by `_phaseForest`.
   */
  private crystalSpotsXZ: { x: number; z: number }[] = [];
  /**
   * Per-cluster Group references for the on-map crystal scatter, aligned 1:1 with
   * `crystalSpotsXZ` order. Free-roam harvest module uses these to shrink/hide individual
   * crystal clusters when fully harvested. Populated by `_phaseForest`.
   */
  private crystalClusters: { x: number; z: number; group: THREE.Group }[] = [];
  /**
   * Universal-collision static obstacles captured during the forest scatter — every
   * dock forest tree, understory shrub, and berry bush. Consumed by `mountApp.ts`
   * which bulk-registers them with the awakened-mode `collisionWorld` so the player
   * + mobs can't walk through the visual forest. See `forestEnvironment.ts`
   * `ForestStaticObstacle` for the field semantics. Populated by `_phaseForest`.
   */
  private forestStaticObstacles: import('./forestEnvironment').ForestStaticObstacle[] = [];
  /** Resolved creek polylines from the forest backdrop — exposed via {@link getFreeRoamHandles}
   * for downstream awakened systems (e.g. bouncy-mushroom scatter) that need to reject
   * spawn candidates on water. Empty until `_phaseForest` runs. */
  private resolvedCreeks: import('../world/idleCraftHeightfield').ResolvedCreek[] = [];
  /** Mobile / low-power quality path — drives DPR, shadows, terrain, night FX, vegetation wind. */
  private readonly graphicsBudget: GraphicsBudget;

  /** Bootstraps the dock viewport through EmpireEngine's renderer factory (WebGL today; WebGPU when enabled in engine options). */
  static async create(
    container: HTMLElement,
    opts?: {
      onProgress?: (fraction: number, phase: string) => void;
      /**
       * When the preview is built into an offscreen container (the dock preload
       * path), there is no visible loading veil to paint, so the historical
       * 2-frame yield before the constructor is pure dead time. Pass `true` to
       * skip those ~32ms. The inline-fallback path inside `mountApp` (no preload)
       * leaves it as `false` so the loading veil still gets a chance to paint.
       */
      runHeadless?: boolean;
    },
  ): Promise<CharacterScenePreview> {
    dockPerfBegin('preview-bootstrap');
    const p = opts?.onProgress ?? (() => {});
    p(0, 'Starting graphics...');
    const { w, h } = dockPreviewDrawSize(container);
    const canvas = document.createElement('canvas');
    const tier = resolveGraphicsTier();
    const graphicsBudget = getGraphicsBudget(tier);
    p(0.12, 'Creating WebGL renderer...');
    /* Parallel: WebGL context + project JSON (no dependency between them). The JSON fetch is
     * cached in `fetchEmpireProject`, so if `main.ts` or a preload already started it, this
     * awaits a resolved promise instead of a second network trip. */
    dockPerfBegin('preview-renderer');
    dockPerfBegin('preview-project');
    const [{ renderer }, project] = await Promise.all([
      createRendererAsync({
        canvas,
        antialias: graphicsBudget.rendererAntialias,
        preferWebGPU: false,
      }),
      fetchEmpireProject(),
    ]);
    dockPerfEnd('preview-renderer');
    dockPerfEnd('preview-project');
    p(0.4, 'Building procedural scene — base setup...');
    /* See `runHeadless` comment above. Skip the 2-RAF yield in offscreen preload. */
    if (!opts?.runHeadless) {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    }
    dockPerfBegin('preview-constructor');
    /* Constructor now does only the cheap, synchronous setup that gates everything else
     * (renderer config, canvas/DOM, event listeners, camera, avatar materials, hand-prop
     * meshes, scene root attaches, blood VFX pool, craft-decor scaffolding, phantom point
     * lights). The heavy phases — forest, avatar rig, lights binding, post-processing,
     * GPU warm — are extracted into `_phase*` methods drained below with yields between
     * each so no single phase blocks the main thread for more than ~50-150ms. This lets
     * the preload run during cutscene playback without freezing the video / overlay UI. */
    const preview = new CharacterScenePreview(container, renderer, w, h, project, graphicsBudget);
    dockPerfEnd('preview-constructor');
    /* === 2026-04-22 inter-phase yields trimmed after cutscene removal ===
     *
     * Pre-cutscene-removal this had 5× `yieldToEventLoop` between every
     * phase to keep video decoder + cutscene overlay UI responsive. With
     * no video to protect, the only yields that earn their keep are:
     *
     *   - BEFORE `_phaseForest` — that phase is the heaviest single block
     *     (~150-300ms) so we want to give the title-screen first paint a
     *     frame to settle before the spike.
     *   - BEFORE `_phaseStartRenderLoop` (full `yieldAnimationFrame`) —
     *     that phase calls `loop()` which schedules the first `rAF(frame)`,
     *     so pairing the yield with a paint slot lets the postProcessing
     *     setup actually paint to a frame before the render loop kicks
     *     off. Same discriminator from round 2: paint-sync only when work
     *     between yields produces a visual change.
     *
     * The other phases (avatar rig ~5ms, lighting ~10ms, spawn/camera
     * ~3ms, postProcessing ~30ms) are all sub-frame and produce no visible
     * intermediate state — yielding between them was pure dead wait
     * (~1ms per `yieldToEventLoop` × 4 = ~4ms baseline, plus the V8
     * inlining boundary cost). */
    p(0.5, 'Building procedural scene — forest & terrain...');
    await yieldToEventLoop();
    await preview._phaseForest();
    p(0.65, 'Building procedural scene — avatar rig...');
    preview._phaseAvatar();
    p(0.78, 'Building procedural scene — lights & shadows...');
    preview._phaseLighting();
    p(0.85, 'Building procedural scene — spawn & camera...');
    preview._phaseSpawnAndCamera();
    p(0.92, 'Building procedural scene — post-processing...');
    preview._phasePostProcessing();
    /* === 2026-04-22 dropped yieldAnimationFrame (win #3) ===
     *
     * Was `await yieldAnimationFrame()` (~16 ms full paint frame) "so the
     * postProcessing setup paints to a frame before the render loop kicks."
     * But the offscreen container that holds this preview during boot is
     * `visibility: hidden` + positioned at `left: -99999px` (see
     * `dockPreload.ts:createOffscreenContainer`) — there's NOTHING visible
     * to paint here. The full paint-frame wait was ~16 ms of pure dead
     * time on every preload. Sub-ms `yieldToEventLoop()` gives input +
     * microtasks a slot before the render loop kicks without waiting a
     * paint frame.
     *
     * Note: when `CharacterScenePreview.create()` is called from the
     * INLINE-fallback path in `mountApp` (rare — preload never started),
     * the container IS visible. Even then, a single sub-ms drain is
     * sufficient because mountApp's forging veil already covers any
     * intermediate frame; the canvas paints beneath it via the next rAF
     * naturally. */
    await yieldToEventLoop();
    preview._phaseStartRenderLoop();
    dockPerfEnd('preview-bootstrap');
    dockPerfMark('preview-ready');
    p(1, 'Dock ready');
    return preview;
  }

  private constructor(
    container: HTMLElement,
    renderer: THREE.WebGLRenderer,
    w: number,
    h: number,
    project: IdleEmpireProjectFile | null,
    graphicsBudget: GraphicsBudget,
  ) {
    this.graphicsBudget = graphicsBudget;
    const cfg = (project?.config ?? {}) as Record<string, unknown>;
    const fovCfg = cfg['graphics.fov'];
    this.projectFovScale = typeof fovCfg === 'number' && fovCfg > 0 ? fovCfg / 44 : 1;
    const rsRaw = cfg['graphics.renderScale'];
    this.renderScale = typeof rsRaw === 'number' && rsRaw > 0 ? rsRaw : 1;
    this.empireProject = project;
    const dockSpawn = readDockSpawn(project);
    this.dockHomeX = dockSpawn.homeX;
    this.dockHomeZ = dockSpawn.homeZ;
    this.dockRouteWalkSpeed = computeDockWalkSpeedMatchWoodGather(this.dockHomeX, this.dockHomeZ);
    this.gatherWaterXZ = waterGatherBankXZ(project);
    this.rebuildHarvestSlotTable();

    this.container = container;
    this.renderer = renderer;
    this.renderer.setPixelRatio(this.computeEffectivePixelRatio(w, h));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(0xa8daf8, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = graphicsBudget.useBasicShadowMap
      ? THREE.BasicShadowMap
      : THREE.PCFSoftShadowMap;
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.margin = '0';
    canvas.style.padding = '0';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    this.presenceHud.className = 'character-presence-hud';
    this.presenceHud.hidden = true;
    container.appendChild(this.presenceHud);
    canvas.addEventListener('wheel', this.onWheelCamera, { passive: false });
    canvas.addEventListener('pointerdown', this.onDockPointerDown);
    canvas.addEventListener('pointermove', this.onDockPointerMove);
    canvas.addEventListener('pointerup', this.onDockPointerUp);
    canvas.addEventListener('pointercancel', this.onDockPointerUp);
    canvas.addEventListener('lostpointercapture', this.onDockLostCapture);
    canvas.addEventListener('contextmenu', this.onDockContextMenu);
    canvas.addEventListener('dblclick', this.onDockDblClick);

    this.camera = new THREE.PerspectiveCamera(44, w / h, 0.1, 50000);

    /* Forest backdrop — `attachForestBackdrop` is the single heaviest synchronous build
     * (~150-300ms: terrain grid, creek ribbons, hundreds of LPCA trees + shrubs + grasses
     * + sky + dock environment). Deferred to `_phaseForest()`, drained from `create()` with
     * a yield before it so the cutscene / title can paint a fresh frame first. The forest
     * fields it populates (`dockEnvironment`, `mapRadius`, `getTerrainHeight`,
     * `sceneTickers`, `sceneDisposers`) are nullable / pre-defaulted so reads before the
     * phase runs return safe sentinels. The dependent `_phaseLighting` reads `sunDirection`
     * via `buildCtx`, which is populated in `_phaseForest()` before any consumer runs. */
    this.buildCtx = {
      cfg,
      w,
      h,
      sunDirection: null,
      keyLight: null,
      ambientFill: null,
    };

    /* Solo dock camera + key target follow avatar after spawn — see refreshSoloDockFramingFromAvatar */

    /* Skin / cloth — instance mats so applyCharacterPreset can remap LPCA palette */
    this.avatarSkinMat = stdMat({ color: 0xd4a373, metalness: 0, roughness: 0.8 });
    this.avatarUndertunicMat = stdMat({ color: 0xc4b8a8, metalness: 0, roughness: 0.82 });
    this.avatarJerkinMat = stdMat({ color: 0x2d4a66, metalness: 0.04, roughness: 0.76 });
    this.avatarTrimMat = stdMat({ color: 0x8b6914, roughness: 0.65, metalness: 0.15 });
    this.avatarPantsMat = stdMat({ color: 0x252030, roughness: 0.86 });
    this.avatarBootMat = stdMat({ color: 0x2e241c, roughness: 0.88 });
    this.avatarHairMat = stdMat({ color: 0x3d2817, roughness: 0.92 });
    this.avatarHatBandMat = stdMat({ color: 0x3d2810, roughness: 0.78 });
    this.avatarHatTopMat = stdMat({ color: 0x4a3220, roughness: 0.72 });
    this.avatarHatBrimMat = stdMat({ color: 0x352010, roughness: 0.75 });
    this.artisanHairPrimaryMat = createArtisanHairPhysicalBase(0x3d2818);
    this.artisanHairStreakMat = createArtisanHairPhysicalBase(0x6b4428);

    /* Half-Lambert wrap on player avatar materials (Phase 8h §3) so the
     * shadow side reads as soft cool grey, not pitch black. The avatar is
     * the player's anchor in the scene — reading sharply at every angle is
     * the single biggest "ground-level lighting feels good" win. WeakSet
     * dedup makes this idempotent across the (many) re-equip / cosmetic
     * change paths that re-touch these materials. */
    for (const m of [
      this.avatarSkinMat, this.avatarUndertunicMat, this.avatarJerkinMat,
      this.avatarTrimMat, this.avatarPantsMat, this.avatarBootMat,
      this.avatarHairMat, this.avatarHatBandMat, this.avatarHatTopMat,
      this.avatarHatBrimMat, this.artisanHairPrimaryMat, this.artisanHairStreakMat,
    ]) {
      installHalfLambertOnMaterial(m);
    }

    /* Avatar rig — `buildDockHeroLpca` is the second-heaviest synchronous build (~50-150ms:
     * vanguard wizard or artisan female LPCA mesh, hat / beard / staff / robe roots). Plus
     * the staff-orb VFX which depends on the staff root the rig produces. Deferred to
     * `_phaseAvatar()`. All rig-populated fields use `!:` definite-assignment so reading
     * them before the phase runs returns `undefined`-typed but the only readers are page-
     * context handlers / clips that don't fire until the render loop starts in the final
     * phase, by which point everything is populated. Hand-prop attachments to `handR` /
     * `handL` (which are pre-initialised empty Groups) below in this constructor are safe
     * — they cascade through to the rig once `_phaseAvatar()` re-parents `handR` to `armR`
     * and `torso` to `avatar`. */

    this.logMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.07, 0.28, 10),
      stdMat({ color: 0x5c3d1e, roughness: 0.9 }),
    );
    this.logMesh.rotation.z = Math.PI / 2;
    this.logMesh.castShadow = true;
    this.logMesh.visible = false;
    this.handR.add(this.logMesh);

    this.propAxeGroup.visible = false;
    this.handR.add(this.propAxeGroup);

    /* Phantom torch fire light — created at boot, parented to handR, always visible
     * (counted by Three.js's lighting state) but `intensity = 0` until a torch is
     * actually shown. See `handTorchPhantomFireLight` field comment for the full
     * recompile-freeze rationale. Position matches the in-torch light coords from the
     * legacy `createHandTorchLPCA` impl so the lit visuals are identical. */
    this.handTorchPhantomFireLight = new THREE.PointLight(0xff9038, 0, 3.15, 1.35);
    this.handTorchPhantomFireLight.position.set(0.035, 0.485, 0.105);
    this.handR.add(this.handTorchPhantomFireLight);
    this.handTorchLPCA = createHandTorchLPCA({
      ...(this.handTorchPhantomFireLight ? { fireLight: this.handTorchPhantomFireLight } : {}),
    });
    this.handTorchLPCA.group.position.set(0.02, -0.085, 0.055);
    this.handTorchLPCA.group.rotation.set(0.48, 0.1, 0.2);
    this.handTorchLPCA.group.visible = false;
    this.handR.add(this.handTorchLPCA.group);

    this.bucketMesh = new THREE.Group();
    const pailMetal = stdMat({ color: 0x7a8598, metalness: 0.62, roughness: 0.36 });
    const pailOuter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.108, 0.086, 0.132, 22, 1, true),
      pailMetal,
    );
    pailOuter.position.y = 0.018;
    pailOuter.castShadow = true;
    const pailBottom = new THREE.Mesh(new THREE.CircleGeometry(0.086, 22), pailMetal);
    pailBottom.rotation.x = -Math.PI / 2;
    pailBottom.position.y = -0.048;
    pailBottom.receiveShadow = true;
    const pailLip = new THREE.Mesh(
      new THREE.TorusGeometry(0.11, 0.007, 8, 28),
      stdMat({ color: 0x8a95a8, metalness: 0.58, roughness: 0.34 }),
    );
    pailLip.rotation.x = Math.PI / 2;
    pailLip.position.y = 0.084;
    const waterInner = new THREE.Mesh(
      new THREE.CylinderGeometry(0.096, 0.082, 0.088, 20, 1, false),
      new THREE.MeshPhysicalMaterial({
        color: 0x3d8ec4,
        metalness: 0.02,
        roughness: 0.12,
        transmission: 0.78,
        thickness: 0.12,
        ior: 1.33,
        transparent: true,
        opacity: 0.94,
      }),
    );
    waterInner.position.y = -0.008;
    const waterTop = new THREE.Mesh(
      new THREE.CircleGeometry(0.092, 24),
      new THREE.MeshStandardMaterial({
        color: 0x5ab8e0,
        roughness: 0.22,
        metalness: 0.08,
        emissive: 0x224466,
        emissiveIntensity: 0.08,
        transparent: true,
        opacity: 0.88,
      }),
    );
    waterTop.rotation.x = -Math.PI / 2;
    waterTop.position.y = 0.036;
    const bail = new THREE.Mesh(
      new THREE.TorusGeometry(0.068, 0.01, 8, 20),
      stdMat({ color: 0x555c68, metalness: 0.72, roughness: 0.28 }),
    );
    bail.rotation.x = Math.PI / 2;
    bail.position.set(0, 0.09, 0);
    this.bucketMesh.add(pailOuter, pailBottom, waterInner, waterTop, pailLip, bail);
    this.bucketMesh.visible = false;
    this.handR.add(this.bucketMesh);

    this.rationMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.045, 0.055),
      stdMat({ color: 0x5c3828, roughness: 0.72 }),
    );
    this.rationMesh.visible = false;
    this.rationMesh.castShadow = true;
    this.handL.add(this.rationMesh);

    this.berrySnackMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.038, 8, 6),
      stdMat({ color: 0xc42d4e, roughness: 0.38 }),
    );
    this.berrySnackMesh.visible = false;
    this.handL.add(this.berrySnackMesh);

    this.waterskinMesh = new THREE.Group();
    const ws = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 10, 8),
      stdMat({ color: 0x4a3828, roughness: 0.68 }),
    );
    ws.scale.set(0.95, 1.15, 0.62);
    ws.castShadow = true;
    this.waterskinMesh.add(ws);
    const wsCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.026, 0.04, 8),
      stdMat({ color: 0x5a4a38, roughness: 0.55, metalness: 0.35 }),
    );
    wsCap.position.set(0, 0.06, 0.02);
    this.waterskinMesh.add(wsCap);
    this.waterskinMesh.visible = false;
    this.handL.add(this.waterskinMesh);

    this.bandageMesh = new THREE.Group();
    const bandBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.028, 0.045),
      stdMat({ color: 0xf2f0ea, roughness: 0.55 }),
    );
    bandBody.castShadow = true;
    this.bandageMesh.add(bandBody);
    const bandRoll = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.04, 0.05, 10),
      stdMat({ color: 0xe8e6e0, roughness: 0.5 }),
    );
    bandRoll.rotation.z = Math.PI / 2;
    bandRoll.position.set(0.05, 0, 0);
    this.bandageMesh.add(bandRoll);
    this.bandageMesh.visible = false;
    this.handL.add(this.bandageMesh);

    this.stimMesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.024, 0.09, 4, 8),
      stdMat({ color: 0x228844, roughness: 0.42, metalness: 0.25 }),
    );
    this.stimMesh.visible = false;
    this.stimMesh.castShadow = true;
    this.handR.add(this.stimMesh);

    this.bushMesh = buildIdleCraftBerryBush(mulberry32(90210));
    {
      const p = this.harvestXZ('berries', 0);
      this.bushMesh.position.set(p.x, 0.02, p.z);
    }
    this.bushMesh.scale.setScalar(1.02);

    this.bushMesh.visible = false;

    this.meatMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.06, 0.1),
      stdMat({ color: 0x8b4518, roughness: 0.55 }),
    );
    this.meatMesh.visible = false;
    this.handR.add(this.meatMesh);

    this.plantMesh = buildIdleCraftGardenBed(mulberry32(27182));
    {
      const p = this.harvestXZ('garden', 0);
      this.plantMesh.position.set(p.x, 0.01, p.z);
    }
    this.plantMesh.visible = false;

    this.orbMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.09, 1),
      stdMat({
        color: 0x6b5cff,
        roughness: 0.22,
        metalness: 0.15,
        emissive: 0x4422cc,
        emissiveIntensity: 0.85,
      }),
    );
    this.orbMesh.visible = false;
    this.prop.add(this.orbMesh);

    this.battleSpark = new THREE.Mesh(
      new THREE.SphereGeometry(0.055, 12, 10),
      stdMat({
        color: 0xa07cff,
        roughness: 0.2,
        metalness: 0.2,
        emissive: 0x5533cc,
        emissiveIntensity: 0.9,
      }),
    );
    this.battleSpark.visible = false;
    this.prop.add(this.battleSpark);

    this.rockOreMat = new THREE.MeshPhysicalMaterial({
      color: 0x6e7a88,
      metalness: 0.42,
      roughness: 0.45,
      clearcoat: 0.28,
      clearcoatRoughness: 0.4,
      envMapIntensity: 1.05,
    });
    this.rockMesh = new THREE.Mesh(new THREE.DodecahedronGeometry(0.2, 2), this.rockOreMat);
    {
      const p = this.harvestXZ('mine', 0);
      this.rockMesh.position.set(p.x, 0.08, p.z);
    }
    this.rockMesh.castShadow = true;
    this.rockMesh.visible = false;
    this.rockMesh.scale.setScalar(1.15);

    this.stonePileMesh = new THREE.Group();
    const pebblePts: [number, number, number, number][] = [
      [0, 0.022, 0, 0.052],
      [0.055, 0.018, 0.035, 0.048],
      [-0.045, 0.02, 0.04, 0.045],
      [0.028, 0.024, -0.025, 0.05],
    ];
    for (let i = 0; i < pebblePts.length; i++) {
      const [x, y, z, r] = pebblePts[i]!;
      const pebble = new THREE.Mesh(
        new THREE.DodecahedronGeometry(r, 0),
        stdMat({ color: i > 1 ? 0x7a7a82 : 0x6a6e78, roughness: 0.9 }),
      );
      pebble.position.set(x, y, z);
      pebble.rotation.set(i * 0.5, i * 0.25, 0);
      pebble.castShadow = true;
      this.stonePileMesh.add(pebble);
    }
    {
      const p = this.harvestXZ('stone', 0);
      this.stonePileMesh.position.set(p.x, 0.02, p.z);
    }
    this.stonePileMesh.scale.setScalar(1.35);
    this.stonePileMesh.visible = false;

    this.fiberBundleMesh = buildIdleCraftFiberGrass(mulberry32(31415));
    {
      const p = this.harvestXZ('fiber', 0);
      this.fiberBundleMesh.position.set(p.x, 0.02, p.z);
    }
    this.fiberBundleMesh.visible = false;

    /* Slightly under forest apple scale so gather framing still fits the dock. */
    this.woodTreeMesh = buildIdleCraftAppleTree(mulberry32(4242), 0.84);
    {
      const p = this.harvestXZ('wood', 0);
      this.woodTreeMesh.position.set(p.x, 0, p.z);
    }
    this.woodTreeMesh.visible = false;

    this.interactionRoot.add(
      this.woodTreeMesh,
      this.bushMesh,
      this.stonePileMesh,
      this.fiberBundleMesh,
      this.plantMesh,
      this.rockMesh,
    );
    this.scene.add(this.interactionRoot);

    this.huntPreyGroup.visible = false;
    this.buildHuntPreyFigure();
    {
      const p = this.harvestXZ('hunt', 0);
      this.huntPreyGroup.position.set(p.x, 0, p.z);
    }
    this.interactionRoot.add(this.huntPreyGroup);

    const erInit = this.getEnemyRestXZ();
    this.enemyRoot.position.set(erInit.x, 0, erInit.z);
    this.enemyRoot.rotation.y = 0;
    this.enemyRoot.visible = false;
    this.scene.add(this.enemyRoot);
    this.scene.add(this.presenceGhostRoot);
    this.awakenedCoopPeerRoot.visible = false;
    this.scene.add(this.awakenedCoopPeerRoot);
    this.peerDuoRoot.visible = false;
    this.scene.add(this.peerDuoRoot);

    const bt0 = createBloodLiquidTexture(2.17);
    const bt1 = createBloodLiquidTexture(19.44);
    const bt2 = createBloodLiquidTexture(37.91);
    const bMaps = [bt0, bt1, bt2];
    for (let i = 0; i < 16; i++) {
      const rough = 0.14 + (i % 4) * 0.05;
      const cc = 0.78 + (i % 3) * 0.06;
      const mat = createBattleBloodPhysicalMaterial(bMaps[i % 3]!, rough, cc);
      const pool = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      pool.rotation.x = -Math.PI / 2;
      pool.castShadow = false;
      pool.receiveShadow = true;
      this.bloodBlobMeshes.push(pool);
      this.battleBloodRoot.add(pool);
    }
    for (let i = 0; i < 12; i++) {
      const rough = 0.2 + (i % 3) * 0.07;
      const mat = createBattleBloodPhysicalMaterial(bMaps[(i + 1) % 3]!, rough, 0.72);
      const splat = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      splat.rotation.x = -Math.PI / 2;
      splat.castShadow = false;
      splat.receiveShadow = true;
      this.bloodSplatMeshes.push(splat);
      this.battleBloodRoot.add(splat);
    }
    for (let i = 0; i < 9; i++) {
      const rough = 0.16 + (i % 3) * 0.06;
      const mat = createBattleBloodPhysicalMaterial(bMaps[(i + 2) % 3]!, rough, 0.8);
      const smear = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      smear.rotation.x = -Math.PI / 2;
      smear.castShadow = false;
      smear.receiveShadow = true;
      this.bloodStreakMeshes.push(smear);
      this.battleBloodRoot.add(smear);
    }
    this.battleBloodRoot.visible = false;
    this.scene.add(this.battleBloodRoot);

    for (let i = 0; i < 11; i++) {
      const mat = createBattleBloodPhysicalMaterial(bMaps[i % 3]!, 0.11 + (i % 2) * 0.05, 0.84);
      const strip = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      strip.rotation.y = (i - 5) * 0.095;
      strip.position.x = (i - 5) * 0.0105;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
      this.bloodDripMeshes.push(strip);
      this.battleBloodFaceRoot.add(strip);
    }
    for (let i = 0; i < 9; i++) {
      const mat = createBattleBloodPhysicalMaterial(bMaps[(i + 1) % 3]!, 0.09, 0.88);
      const burst = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      burst.rotation.set(0.34 + (i % 4) * 0.14, (i - 4) * 0.28, 0.1 + (i % 3) * 0.12);
      burst.position.set((i - 4) * 0.02, 0.008 + (i % 3) * 0.007, 0.014 + (i % 4) * 0.005);
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
      this.bloodFaceBurstMeshes.push(burst);
      this.battleBloodFaceRoot.add(burst);
    }
    this.battleBloodFaceRoot.visible = false;
    this.scene.add(this.battleBloodFaceRoot);

    for (let i = 0; i < 11; i++) {
      const mat = createBattleBloodPhysicalMaterial(bMaps[i % 3]!, 0.24 + (i % 2) * 0.07, 0.72);
      const st = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      st.rotation.set(-0.07 + (i % 4) * 0.045, (i - 5) * 0.095, (i % 2) * 0.055);
      st.position.set((i - 5) * 0.019, (i % 4) * 0.01 - 0.02, 0.006 + (i % 3) * 0.004);
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
      this.bloodShirtStainMeshes.push(st);
      this.battleBloodShirtRoot.add(st);
    }
    for (let i = 0; i < 7; i++) {
      const mat = createBattleBloodPhysicalMaterial(bMaps[(i + 1) % 3]!, 0.13, 0.82);
      const dr = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      dr.rotation.y = (i - 3) * 0.14;
      dr.position.x = (i - 3) * 0.013;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
      this.bloodShirtDripMeshes.push(dr);
      this.battleBloodShirtRoot.add(dr);
    }
    for (let i = 0; i < 9; i++) {
      const mat = createBattleBloodPhysicalMaterial(bMaps[(i + 2) % 3]!, 0.26 + (i % 2) * 0.06, 0.7);
      const pt = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      pt.rotation.set(0.035 + (i % 3) * 0.038, (i - 4) * 0.13, (i % 3) * 0.048);
      pt.position.set((i - 4) * 0.026, (i % 2) * 0.009 - 0.014, 0.005 + (i % 2) * 0.004);
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
      this.bloodPantsStainMeshes.push(pt);
      this.battleBloodPantsRoot.add(pt);
    }
    this.battleBloodShirtRoot.visible = false;
    this.battleBloodPantsRoot.visible = false;
    this.scene.add(this.battleBloodShirtRoot);
    this.scene.add(this.battleBloodPantsRoot);

    /* Between avatar (near z=0) and backdrop — walk target is toward -Z into the plasma */
    this.portalVfx.position.set(0.01, 0.48, -0.36);
    this.portalVfx.visible = false;
    this.buildPortalVfx();
    this.scene.add(this.portalVfx);

    this.craftDecorGroup.position.set(-0.42, 0, -0.38);
    this.craftDecorGroup.visible = false;
    this.craftCampfireSlot.position.set(-0.06, 0, 0.04);
    this.craftBenchSlot.position.set(0.34, 0, -0.03);
    this.craftDecorGroup.add(this.craftCampfireSlot, this.craftBenchSlot);
    /* Campfire / workbench LPCA meshes load on first inventory unlock (see setCraftDecorAvailability) — avoids boot + torch pile-up. */
    this.scene.add(this.craftDecorGroup);

    /* Park two permanent PointLights at the campfire pit's world position with intensity 0
     * — see `campfirePhantomFireLight` field comment for full rationale. They sit directly
     * on the scene (not under `craftDecorGroup` whose `.visible` toggles with availability),
     * so `numPointLights` stays constant from boot through every craft / dispose cycle. */
    const campfireWorldX = this.craftDecorGroup.position.x + this.craftCampfireSlot.position.x;
    const campfireWorldZ = this.craftDecorGroup.position.z + this.craftCampfireSlot.position.z;
    this.campfirePhantomFireLight = new THREE.PointLight(0xff8833, 0, 2.4, 1.35);
    this.campfirePhantomFireLight.position.set(campfireWorldX, 0.2, campfireWorldZ);
    this.scene.add(this.campfirePhantomFireLight);
    this.campfirePhantomHotLight = new THREE.PointLight(0xffcc66, 0, 1.2, 1.8);
    this.campfirePhantomHotLight.position.set(campfireWorldX + 0.04, 0.26, campfireWorldZ + 0.04);
    this.scene.add(this.campfirePhantomHotLight);

    /* Subtle inventory hover accent only — no standing fill lights on the ground (GoE parity).
     * Construct here (cheap) so the readonly field is assigned in the constructor; positioning
     * + scene attach happens in `_phaseLighting()` alongside the other lights. */
    this.rim = new THREE.PointLight(0xaaccff, 0, 6);

    /* Lighting + dockEnvironment binding + spawn / camera framing + post-processing + GPU
     * warm + render loop start are all extracted into `_phase*` methods below, drained by
     * `create()` with `await yieldAnimationFrame()` between each. This breaks what was a
     * single ~300-500ms synchronous block into 4-5 frames of 30-150ms each, letting cutscene
     * playback or title-screen interactions update between phases. See the docstring on
     * `_phaseLighting` / `_phaseSpawnAndCamera` / `_phasePostProcessing` /
     * `_phaseStartRenderLoop` for the per-phase rationale. */
  }

  /**
   * **Phase 1** of the staged preload — forest backdrop (terrain, creek ribbons, trees,
   * shrubs, grasses, sky, dock environment).
   *
   * Was the single heaviest synchronous build (~150-300 ms freeze). After the
   * 2026-04-20 Tier B refactor, `attachForestBackdrop` is **async** and yields
   * 4 times internally (after terrain, after scatter, after crystals, after
   * merge), so the freeze is split into ~30-80 ms chunks with sub-ms event-loop
   * drains between. Run via `create()`'s drain loop which `await`s this method
   * + a `yieldToEventLoop()` before, so the surrounding cutscene / title can
   * paint a fresh frame before each chunk.
   *
   * Populates the nullable forest fields (`dockEnvironment`, `mapRadius`, `getTerrainHeight`,
   * `sceneTickers`, `sceneDisposers`) and stashes `sunDirection` on `buildCtx` for the
   * lighting phase to read.
   */
  private async _phaseForest(): Promise<void> {
    if (!this.buildCtx) return;
    /* === 2026-04-20 Tier B — staged async backdrop ===
     *
     * `attachForestBackdrop` was rewritten to async with 4 internal
     * `await yieldToEventLoop()` boundaries (terrain → scatter → crystals
     * → merge → night-magic). The single 150-300 ms freeze that previously
     * landed here is now ~4× ~30-80 ms tasks with sub-ms drains between,
     * keeping every chunk well under Chromium's 50 ms long-task threshold.
     * Caller (`create()`'s drain loop) already `await`s this method. */
    const forest = await attachForestBackdrop(this.scene, this.empireProject, this.graphicsBudget);
    this.buildCtx.sunDirection = forest.sunDirection;
    this.dockEnvironment = forest.dockEnvironment;
    this.mapRadius = forest.mapRadius;
    this.getTerrainHeight = forest.getHeightAt;
    this.sceneTickers = forest.sceneTickers;
    this.sceneDisposers = forest.sceneDisposers;
    this.crystalSpotsXZ = forest.crystalSpotsXZ;
    this.crystalClusters = forest.crystalClusters;
    this.forestStaticObstacles = forest.staticObstacles;
    this.resolvedCreeks = forest.resolvedCreeks;
  }

  /**
   * **Phase 2** of the staged preload — avatar rig (`buildDockHeroLpca` builds the LPCA
   * vanguard / artisan body, hat, beard, staff, robe roots) and the staff-orb VFX that
   * needs the staff root. ~50-150ms. After this runs, `handR` / `handL` (already populated
   * by hand-prop attaches in the constructor body) cascade into the body via the rig's
   * arm groups, and the avatar appears at `dockHomeX`/`Z` (set in `_phaseSpawnAndCamera`).
   */
  private _phaseAvatar(): void {
    const rig = buildDockHeroLpca({
      mats: {
        skin: this.avatarSkinMat,
        undertunic: this.avatarUndertunicMat,
        jerkin: this.avatarJerkinMat,
        trim: this.avatarTrimMat,
        pants: this.avatarPantsMat,
        boots: this.avatarBootMat,
        hair: this.avatarHairMat,
        hatBand: this.avatarHatBandMat,
        hatTop: this.avatarHatTopMat,
        hatBrim: this.avatarHatBrimMat,
      },
      handR: this.handR,
      handL: this.handL,
      heldInRightHand: this.heldInRightHand,
      minePickRight: this.minePickRight,
      shieldMount: this.shieldMount,
      pickLeftHand: this.pickLeftHand,
      pickOnBelt: this.pickOnBelt,
      faceNeutral: this.faceNeutral,
      artisanHairPrimaryMat: this.artisanHairPrimaryMat,
      artisanHairStreakMat: this.artisanHairStreakMat,
    });
    this.torso = rig.torso;
    this.headRoot = rig.headRoot;
    this.hatGroup = rig.hatGroup;
    this.smithBandanaGroup = rig.smithBandanaGroup;
    this.glassesGroup = rig.glassesGroup;
    this.maleDockFaceList = rig.maleDockFaceList;
    this.trunkUnderMesh = rig.trunkUnderMesh;
    this.trunkJerkinMesh = rig.trunkJerkinMesh;
    this.forgeWifeLipMat = rig.forgeWifeLipMat;
    this.forgeWifeIrisMat = rig.forgeWifeIrisMat;
    this.forgeWifeTorsoRoot = rig.forgeWifeTorsoRoot;
    this.forgeWifeOverlayRoot = rig.forgeWifeOverlayRoot;
    this.lpcaShPadL = rig.lpcaShPadL;
    this.lpcaShPadR = rig.lpcaShPadR;
    this.lpcaNeck = rig.lpcaNeck;
    this.lpcaCranium = rig.lpcaCranium;
    this.lpcaJaw = rig.lpcaJaw;
    this.lpcaChin = rig.lpcaChin;
    this.lpcaCheekL = rig.lpcaCheekL;
    this.lpcaCheekR = rig.lpcaCheekR;
    this.lpcaDefaultHair = rig.lpcaDefaultHair;
    this.lpcaArtisanHair = rig.lpcaArtisanHair;
    this.vanguardStaffWoodMat = rig.vanguardStaffWoodMat;
    this.vanguardStaffGemMat = rig.vanguardStaffGemMat;
    this.vanguardWizardRobeRoot = rig.vanguardWizardRobeRoot;
    this.vanguardWizardBeardRoot = rig.vanguardWizardBeardRoot;
    this.vanguardWizardHatRoot = rig.vanguardWizardHatRoot;
    this.vanguardWizardStaffRoot = rig.vanguardWizardStaffRoot;
    this.forgeWifeHeadRoot = rig.forgeWifeHeadRoot;
    this.legLMesh = rig.legLMesh;
    this.legRMesh = rig.legRMesh;
    this.footLMesh = rig.footLMesh;
    this.footRMesh = rig.footRMesh;
    this.armL = rig.armL;
    this.armR = rig.armR;

    this.torso.position.set(0, 0.42, 0);
    this.baseTorsoY = 0.42;

    this.torso.add(this.prop);
    this.avatar.add(this.torso);
    this.scene.add(this.avatar);

    this.vanguardStaffOrbVfx = createVanguardStaffOrbVfx({
      staffRoot: this.vanguardWizardStaffRoot,
      tier: this.graphicsBudget.tier,
    });
  }

  /**
   * **Phase 3** of the staged preload — sun-aligned directional key light (with shadow map
   * config), ambient fill, dockEnvironment binding (so day/night cycle drives both lights),
   * inventory rim accent positioning + scene attach. ~30-80ms. Depends on
   * `buildCtx.sunDirection` populated by `_phaseForest()`.
   */
  private _phaseLighting(): void {
    if (!this.buildCtx) return;
    const { cfg, sunDirection } = this.buildCtx;
    const sunDir = sunDirection ?? new THREE.Vector3(0.4, 0.85, 0.3).normalize();
    const ambientFill = new THREE.AmbientLight(0x6a7a72, 0.4);
    this.scene.add(ambientFill);
    const key = new THREE.DirectionalLight(0xfff2dd, 1.52);
    /* Matches initial sun offset before IdleCraftDockEnvironment.update (direction only; distance ≠ brightness). */
    key.position.copy(sunDir.clone().multiplyScalar(6));
    /* Aim through mid-body toward the floor so grazing ground gets more key — avoids "floating" dark turf vs solo enemy slot */
    key.target.position.set(0, 0.1, 0);
    this.scene.add(key.target);
    key.castShadow = true;
    const sm = this.graphicsBudget.shadowMapSizeKey;
    key.shadow.mapSize.set(sm, sm);
    key.shadow.camera.near = 0.4;
    key.shadow.camera.far = Math.max(32, this.mapRadius * 0.45);
    const shadowDist = cfg['graphics.shadowDistance'];
    if (typeof shadowDist === 'number' && shadowDist > 1) {
      key.shadow.camera.far = shadowDist;
      key.shadow.camera.updateProjectionMatrix();
    }
    const sh = Math.max(9, this.mapRadius * 0.32);
    key.shadow.camera.left = -sh;
    key.shadow.camera.right = sh;
    key.shadow.camera.top = sh;
    key.shadow.camera.bottom = -sh;
    /* === 2026-04-22 reverted to round-3 shadow values (player report) ===
     *
     * Phase D (earlier same day) loosened bias -0.00012 → -0.0005, bumped
     * radius 2.8 → 5.5, and bumped normalBias 0.02 → 0.045 in pursuit of
     * "softer shadows." Player report: shadows now look like "voxel blocks"
     * / Minecraft-style. Diagnosis: a 5.5-texel PCF kernel on a 2048 shadow
     * map covering ±14 units (texel = 14mm world) reads as visible
     * banding/blocks at shadow boundaries on edge-of-frustum trees, where
     * shadow texel density is lowest. Combined with Phase E6.6 re-enabling
     * far-tree shadows, the shadow map was overcommitted and the soft PCF
     * filter wrapped across visibly-quantized texel boundaries.
     *
     * Reverted to the round-3 values (radius 2.8, bias -0.00012,
     * normalBias 0.02) which had been working since 2026-04-19 lighting
     * overhaul without complaint. Tighter bias might re-introduce
     * peter-panning on very-low-angle sun, but that's the lesser visual
     * issue vs visible shadow texel banding.
     *
     * Far-tree shadows also reverted to unconditional false — see
     * `forestEnvironment.ts:920`. */
    key.shadow.bias = -0.00012;
    key.shadow.radius = 2.8;
    key.shadow.normalBias = 0.02;
    this.scene.add(key);
    this.dockKeyLight = key;
    this.dockEnvironment?.bindKeyLight(key);
    this.dockEnvironment?.bindAmbient(ambientFill);
    /* Attach PMREM IBL (Phase 8h lighting plan §1) so PBR materials get
     * environment-map specular sampled from the current sky tones.
     * Idempotent — first call builds, subsequent calls no-op. */
    this.dockEnvironment?.attachIbl(this.renderer);
    /* Attach cheap cone-geometry god-rays (Phase 8h lighting plan §6).
     * Subtle daytime sun shaft — additive cone, no new lights, free
     * shader (program already in cache from existing additive VFX). */
    this.dockEnvironment?.attachGodRays();
    /* === Camera-relative fill light (Phase 8h lighting plan §2) ===
     *
     * Phantom DirectionalLight parented to the camera. Position is
     * "right shoulder, slightly above" relative to camera-local axes;
     * target is "in front." Both move with the camera so the fill is
     * always over-the-shoulder regardless of where the player aims.
     * Per-frame intensity + color sync happens via the dockEnvironment
     * update loop (see syncCameraFillLightFromDock below). */
    if (!this.cameraFillLight) {
      const fill = new THREE.DirectionalLight(0xffffff, 0);
      fill.castShadow = false;
      fill.position.set(1.4, 0.6, 0);   /* right shoulder, slightly above eye-line */
      fill.target.position.set(0, 0, -10); /* aim forward */
      this.camera.add(fill);
      this.camera.add(fill.target);
      this.cameraFillLight = fill;
    }
    this.dockEnvironment?.bindCameraFillLight(this.cameraFillLight);
    this.dockEnvironment?.update(0, this.empireProject, this.camera);
    this.buildCtx.keyLight = key;
    this.buildCtx.ambientFill = ambientFill;

    this.rim.position.set(-0.72, 1.05, 0.52);
    this.scene.add(this.rim);
  }

  /**
   * **Phase 4** of the staged preload — avatar to camp spawn, terrain feet relevel, camera
   * to solo dock framing, key-light target follows avatar. Cheap (~10-30ms) but ordered
   * after lighting because `dockKeyLight` is read for the target update.
   */
  private _phaseSpawnAndCamera(): void {
    /* Camp spawn: near creek + tree arc (see project `dock` / readDockSpawn). */
    this.avatar.position.x = this.dockHomeX;
    this.avatar.position.z = this.dockHomeZ;
    this.relevelAvatarFeet();
    this.relevelGatherPropsToTerrain();
    this.travelHomeX = this.avatar.position.x;
    this.travelHomeZ = this.avatar.position.z;
    this.travelHomeRotY = dockSoloIdleFaceYawRad();
    this.avatar.rotation.set(0, this.travelHomeRotY, 0);

    this.refreshSoloDockFramingFromAvatar();
    this.camera.position.copy(this.framingCamPos);
    this.camera.lookAt(this.framingLookAt);
    if (this.dockKeyLight) {
      this.dockKeyLight.target.position.set(
        this.avatar.position.x,
        this.avatar.position.y + 0.12,
        this.avatar.position.z,
      );
    }
  }

  /**
   * **Phase 5** of the staged preload — `PostProcessingStack` (effect composer + FXAA / SSAO
   * / bloom passes per project config + tier). ~50-150ms. Depends on the full scene graph
   * being in place so `applyDockPostProcessing` can pick safe defaults.
   *
   * Routes through `applyDockPostProcessing()` (same path the awakened-flip + Esc-menu
   * listeners use) so the `awakenedQuality` tier trim (`perf` drops bloom + SSAO,
   * `balanced` drops SSAO) is applied on first paint — previously the boot path created
   * the stack with raw project options, so dream-mode bloom was visibly heavier until the
   * first awaken-flip or Esc-menu change ran `applyDockPostProcessing`. Also injects the
   * night-grade pass on boot (was previously deferred until first apply).
   */
  private _phasePostProcessing(): void {
    if (!this.buildCtx) return;
    this.applyDockPostProcessing();
  }

  /**
   * **Phase 6** of the staged preload — apply renderer display flags, schedule the GPU
   * shader-warm pipeline, attach window resize listener + `ResizeObserver`, kick the render
   * loop. Cheap setup (~5ms); the warm pipeline it schedules runs in its own `rIC` slots
   * later (see `scheduleWarmRenderPipeline`). Final phase — clears `buildCtx` so we don't
   * keep one-shot build refs alive for the session.
   */
  private _phaseStartRenderLoop(): void {
    this.applyDockRendererDisplay();
    this.deferDockGpuWarm();

    window.addEventListener('resize', this.onResize);
    if (typeof ResizeObserver !== 'undefined') {
      this.containerResizeObs = new ResizeObserver(() => this.onResize());
      this.containerResizeObs.observe(this.container);
    }
    this.loop();
    this.buildCtx = null;
  }

  /**
   * One compile + one draw — shared by warm-up paths.
   *
   * Both directional lights (sun / moon) keep `castShadow = true` for the session, so
   * `numDirLightShadows` is constant → one program hash for lit materials, one warm pass.
   */
  private finalWarmCompileAndRender(): void {
    const r = this.renderer as THREE.WebGLRenderer & { compile?: (s: THREE.Scene, c: THREE.Camera) => void };
    try {
      if (typeof r.compile === 'function') r.compile(this.scene, this.camera);
    } catch {
      /* non-WebGL or compile unsupported */
    }
    try {
      if (this.postProcessing) this.postProcessing.render();
      else this.renderer.render(this.scene, this.camera);
    } catch {
      /* ignore */
    }
  }

  /**
   * Push shader warm off the constructor stack — pairs with audio decode / first paint so one long task
   * does not become "audio RMS + GPU compile" back-to-back.
   *
   * **Spread policy:** the warm pipeline is now scheduled via `requestIdleCallback` (with a
   * generous timeout fallback to `setTimeout`) so each compile pass — synchronous WebGL
   * `compile()` work that the browser cannot split — runs only when the main thread is
   * genuinely idle. Critical when the preload runs during cutscene playback or while the
   * title screen is interactive: the warm waits its turn instead of stalling video frames /
   * input handlers.
   */
  private deferDockGpuWarm(): void {
    /* Round 5 phase F1 — `scheduler.postTask({priority:'background'})` on
     * Chrome/Edge/FF; falls back to `requestIdleCallback({timeout:1500})` on
     * Safari per the helper's background-fallback branch. The cancellable
     * variant returns a handle whose `.cancel()` works across both backends. */
    this.cancelDockWarmHandle('defer');
    const kickWarm = (): void => {
      this.dockWarmDeferTask = null;
      this.scheduleWarmRenderPipeline();
    };
    this.dockWarmDeferTask = schedulePostTaskCancellable(kickWarm, 'background');
  }

  /**
   * Cancel a previously scheduled warm handle. Round 5 phase F1: handles are
   * now {@link CancellablePostTask} instances (was raw numeric handles from
   * rIC / setTimeout); their `.cancel()` aborts across all backend paths.
   */
  private cancelDockWarmHandle(which: 'defer' | 'pass' | 'both'): void {
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
   * Low tier: skip decor/torch multi-pass shader warm-up (reduces main-thread freeze); first craft may hitch slightly.
   * High tier: spread craft warm and torch+compile across two **idle slots** (rIC) so each
   * compile pass only runs when the main thread is unused — no cutscene / title freeze.
   */
  private scheduleWarmRenderPipeline(): void {
    const tier = this.graphicsBudget.tier;
    dockPerfBegin('dock-warm-total');
    if (tier === 'low') {
      dockPerfBegin('dock-warm-minimal');
      this.finalWarmCompileAndRender();
      dockPerfEnd('dock-warm-minimal');
      dockPerfEnd('dock-warm-total');
      return;
    }
    /* Round 5 phase F1 — `background` priority via the tagged scheduler.
     * Each pass is GPU-driver-side shader compile, fundamentally interleavable
     * with input + paint; `background` is the right tag. */
    const scheduleNext = (cb: () => void): void => {
      this.dockWarmTask = schedulePostTaskCancellable(() => {
        this.dockWarmTask = null;
        cb();
      }, 'background');
    };
    let pass = 0;
    const step = (): void => {
      if (pass === 0) {
        dockPerfBegin('dock-warm-craft');
        this.warmCraftDecorShadersForGpu();
        dockPerfEnd('dock-warm-craft');
        pass = 1;
        scheduleNext(step);
      } else {
        dockPerfBegin('dock-warm-torch-final');
        this.stagedWarmTorchShaders();
        this.finalWarmCompileAndRender();
        dockPerfEnd('dock-warm-torch-final');
        dockPerfEnd('dock-warm-total');
      }
    };
    scheduleNext(step);
  }

  /**
   * Build campfire + workbench LPCA briefly (if not already owned) so shader programs compile during load,
   * not on first craft — then restore. Reduces hitches when crafting torch/campfire at night.
   */
  private warmCraftDecorShadersForGpu(): void {
    const ownsDecor = this.hasCraftCampfire || this.hasCraftWorkbench;
    if (ownsDecor) return;
    const hadMeshes = !!this.campfireLPCA;
    if (!hadMeshes) this.buildCraftDecor();
    const prevGroupVis = this.craftDecorGroup.visible;
    const prevTorchVis = this.handTorchLPCA?.group.visible ?? false;
    this.craftDecorGroup.visible = true;
    if (this.handTorchLPCA) this.handTorchLPCA.group.visible = true;
    const r = this.renderer as THREE.WebGLRenderer & { compile?: (s: THREE.Scene, c: THREE.Camera) => void };
    for (let i = 0; i < 2; i++) {
      try {
        if (typeof r.compile === 'function') r.compile(this.scene, this.camera);
        if (this.postProcessing) this.postProcessing.render();
        else this.renderer.render(this.scene, this.camera);
      } catch {
        /* ignore */
      }
    }
    this.craftDecorGroup.visible = prevGroupVis;
    if (this.handTorchLPCA) {
      this.handTorchLPCA.group.visible = prevTorchVis;
      this.applyTorchCarryOverride();
    }
    if (!hadMeshes && !ownsDecor) this.disposeCraftDecorMeshes();
  }

  /** Extra compile passes for hand-torch flame (covers "already have decor" boot path where decor warm-up skips). */
  private stagedWarmTorchShaders(): void {
    if (!this.handTorchLPCA) return;
    const prev = this.handTorchLPCA.group.visible;
    this.handTorchLPCA.group.visible = true;
    const r = this.renderer as THREE.WebGLRenderer & { compile?: (s: THREE.Scene, c: THREE.Camera) => void };
    for (let i = 0; i < 2; i++) {
      try {
        if (typeof r.compile === 'function') r.compile(this.scene, this.camera);
      } catch {
        /* ignore */
      }
    }
    this.handTorchLPCA.group.visible = prev;
    this.applyTorchCarryOverride();
  }

  /** Same plague-rat LPCA as battle dock (`e_rat`), facing toward default camp walk origin. */
  private buildHuntPreyFigure(): void {
    while (this.huntPreyGroup.children.length) {
      const ch = this.huntPreyGroup.children[0]!;
      this.huntPreyGroup.remove(ch);
      const disposeLpca = ch.userData.disposePveEnemy as (() => void) | undefined;
      if (disposeLpca) disposeLpca();
      else {
        ch.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const m = obj.material;
            if (Array.isArray(m)) m.forEach((x) => x.dispose());
            else (m as THREE.Material).dispose();
          }
        });
      }
    }
    const h0 = this.harvestXZ('hunt', 0);
    const hx = h0.x;
    const hz = h0.z;
    /* Face toward camp origin so host (-X) and guest (+X) duel layouts both look toward survivors. */
    const faceY = gatherFaceY(hx, hz, 0, 0);
    const fig = createPveEnemyLPCA('e_rat', { overrideRootYawRad: faceY });
    fig.group.userData.disposePveEnemy = fig.dispose;
    this.huntPreyGroup.add(fig.group);
  }

  private buildPortalVfx(): void {
    while (this.portalVfx.children.length) {
      const ch = this.portalVfx.children[0]!;
      this.portalVfx.remove(ch);
    }
    this.portalPlasma?.dispose();
    this.portalPlasma = createPlasmaPortalLPCA();
    this.portalVfx.add(this.portalPlasma.group);
  }

  private disposeCraftDecorMeshes(): void {
    this.campfireLPCA?.dispose();
    this.workbenchLPCA?.dispose();
    this.campfireLPCA = null;
    this.workbenchLPCA = null;
    while (this.craftCampfireSlot.children.length) {
      this.craftCampfireSlot.remove(this.craftCampfireSlot.children[0]!);
    }
    while (this.craftBenchSlot.children.length) {
      this.craftBenchSlot.remove(this.craftBenchSlot.children[0]!);
    }
  }

  private buildCraftDecor(): void {
    this.disposeCraftDecorMeshes();
    /* Reuse the scene-permanent phantom lights (see `campfirePhantomFireLight`) so crafting a
     * campfire animates `intensity` instead of adding new PointLights — `numPointLights`
     * stays constant, no synchronous shader recompile, no 5-second freeze. */
    this.campfireLPCA = createCampfireLPCA({
      ...(this.campfirePhantomFireLight ? { fireLight: this.campfirePhantomFireLight } : {}),
      ...(this.campfirePhantomHotLight ? { hotLight: this.campfirePhantomHotLight } : {}),
    });
    this.craftCampfireSlot.add(this.campfireLPCA.group);
    this.workbenchLPCA = createWorkbenchLPCA();
    this.craftBenchSlot.add(this.workbenchLPCA.group);
  }

  private cancelCraftDecorMeshBuild(): void {
    if (this.craftDecorBuildRaf) {
      cancelAnimationFrame(this.craftDecorBuildRaf);
      this.craftDecorBuildRaf = 0;
    }
    this.craftDecorBuildGeneration++;
  }

  /** Defer mesh creation by 2 rAFs so it leaves the craft/HUD handler and spreads vs torch/skydome. */
  private queueCraftDecorMeshBuild(): void {
    if (this.craftDecorMeshAwaiting) return;
    this.craftDecorMeshAwaiting = true;
    this.cancelCraftDecorMeshBuild();
    const gen = this.craftDecorBuildGeneration;
    const finishAwaiting = (): void => {
      this.craftDecorMeshAwaiting = false;
    };
    const step = (remaining: number): void => {
      this.craftDecorBuildRaf = requestAnimationFrame(() => {
        if (gen !== this.craftDecorBuildGeneration) {
          finishAwaiting();
          return;
        }
        if (remaining > 0) {
          step(remaining - 1);
        } else {
          this.craftDecorBuildRaf = 0;
          if (!this.hasCraftCampfire && !this.hasCraftWorkbench) {
            finishAwaiting();
            return;
          }
          if (this.campfireLPCA) {
            finishAwaiting();
            return;
          }
          this.buildCraftDecor();
          this.craftCampfireRevealHold = this.hasCraftCampfire ? 12 : 0;
          this.craftWorkbenchRevealHold = this.hasCraftWorkbench ? 12 : 0;
          finishAwaiting();
        }
      });
    };
    /* Extra frame vs HUD/craft click so WebGL compile stays off the input handler critical path. */
    step(2);
  }

  private dockHeavyVisualStaggerActive(): boolean {
    return (
      this.craftCampfireRevealHold > 0 ||
      this.craftWorkbenchRevealHold > 0 ||
      this.torchAfterHeavyDecorFrames > 0
    );
  }

  /**
   * Campfire / workbench meshes in the craft tab only appear after the player has those items.
   * Debounced to one rAF so rapid {@link refreshHud} during craft does not pile up mesh builds.
   */
  setCraftDecorAvailability(campfire: boolean, workbench: boolean): void {
    this.pendingCraftCampfire = campfire;
    this.pendingCraftWorkbench = workbench;
    if (this.craftDecorHudRaf) return;
    this.craftDecorHudRaf = requestAnimationFrame(() => {
      this.craftDecorHudRaf = 0;
      this.flushCraftDecorAvailability(this.pendingCraftCampfire, this.pendingCraftWorkbench);
    });
  }

  private flushCraftDecorAvailability(campfire: boolean, workbench: boolean): void {
    const prevC = this.hasCraftCampfire;
    const prevW = this.hasCraftWorkbench;
    this.hasCraftCampfire = campfire;
    this.hasCraftWorkbench = workbench;

    if (!campfire && !workbench) {
      this.craftCampfireRevealHold = 0;
      this.craftWorkbenchRevealHold = 0;
      this.torchAfterHeavyDecorFrames = 0;
      this.craftDecorMeshAwaiting = false;
      this.cancelCraftDecorMeshBuild();
      this.disposeCraftDecorMeshes();
      return;
    }

    const needMesh = campfire || workbench;
    if (!this.campfireLPCA && needMesh) {
      if (!this.craftDecorMeshAwaiting) this.queueCraftDecorMeshBuild();
      return;
    }

    if (campfire && !prevC) this.craftCampfireRevealHold = 12;
    if (workbench && !prevW) this.craftWorkbenchRevealHold = 12;
    if (!campfire) this.craftCampfireRevealHold = 0;
    if (!workbench) this.craftWorkbenchRevealHold = 0;
  }

  /** At least one crafted torch — shown in hand at night on dock pages (not battle). */
  setTorchInventory(hasTorch: boolean): void {
    this.hasTorchInventory = hasTorch;
    this.applyTorchCarryOverride();
  }

  setTorchEquipped(equipped: boolean): void {
    this.torchEquipped = equipped;
    this.applyTorchCarryOverride();
  }

  /** World XZ of the campfire pit (dock space) for facing / hammer clips */
  private campfireWorldXZ(): { x: number; z: number } {
    return {
      x: this.craftDecorGroup.position.x + this.craftCampfireSlot.position.x,
      z: this.craftDecorGroup.position.z + this.craftCampfireSlot.position.z,
    };
  }

  /** Stand point near the fire (from dock home), same idea as gather approach. */
  private craftCampfireStandXZ(): { x: number; z: number } {
    const { x: fx, z: fz } = this.campfireWorldXZ();
    return gatherApproachPoint(this.dockHomeX, this.dockHomeZ, fx, fz, GATHER_STANDOFF);
  }

  /** World XZ of the workbench (dock space). */
  private workbenchWorldXZ(): { x: number; z: number } {
    return {
      x: this.craftDecorGroup.position.x + this.craftBenchSlot.position.x,
      z: this.craftDecorGroup.position.z + this.craftBenchSlot.position.z,
    };
  }

  /** Stand point in front of the bench (from dock home). */
  private craftWorkbenchStandXZ(): { x: number; z: number } {
    const { x: wx, z: wz } = this.workbenchWorldXZ();
    return gatherApproachPoint(this.dockHomeX, this.dockHomeZ, wx, wz, GATHER_STANDOFF);
  }

  /** Midpoint between campfire and workbench — "craft yard" focal point. */
  private craftCentralPivotXZ(): { x: number; z: number } {
    const f = this.campfireWorldXZ();
    const w = this.workbenchWorldXZ();
    return { x: (f.x + w.x) * 0.5, z: (f.z + w.z) * 0.5 };
  }

  /**
   * Central craft stance: between stations so opening the Craft tab is a single walk here; short walks
   * then go to campfire/workbench when you start a recipe there.
   */
  private craftCentralStandXZ(): { x: number; z: number } {
    const p = this.craftCentralPivotXZ();
    return gatherApproachPoint(this.dockHomeX, this.dockHomeZ, p.x, p.z, GATHER_STANDOFF);
  }

  /** Gather / non-craft dock rest — always project spawn in solo (fixes stale {@link travelHomeX} after clips). */
  private gatherRestXZ(): { x: number; z: number } {
    if (this.hunterSharedWorldActive) {
      return { x: this.travelHomeX, z: this.travelHomeZ };
    }
    return { x: this.dockHomeX, z: this.dockHomeZ };
  }

  /** Local wheel zoom for online gather / battle dock (not synced). */
  /** Reset wheel zoom, orbit, and pan to layout defaults (also on double-click canvas).
   *
   * Also resets the smoothing TARGETS so a reset doesn't trigger a swooping
   * lerp from the prior orbit position back to the layout default — both
   * displayed and target snap to defaults together. */
  resetDockCameraView(): void {
    this.userCameraZoom = 1;
    this.userCameraZoomTarget = 1;
    this.dockCamYaw = 0;
    this.dockCamYawTarget = 0;
    this.dockCamPitch = 0;
    this.dockCamPitchTarget = 0;
    this.dockCamPan.set(0, 0, 0);
    this.dockCamPanTarget.set(0, 0, 0);
  }

  /** @deprecated No longer gates controls — solo and online always allow dock camera. Pass false to reset view. */
  setUserCameraZoomEnabled(on: boolean): void {
    if (!on) this.resetDockCameraView();
  }

  /**
   * Hunter 1v1 camp: you and your rival share the viewport (duel spacing) while not in battle.
   * Host keeps the default -X "home" seat; guest mirrors to +X so each player sees themselves on their own side facing the rival.
   */
  setHunterSharedWorldActive(active: boolean, guestSeat = false): void {
    const wasHunterShared = this.hunterSharedWorldActive;
    this.hunterSharedWorldActive = active;
    this.hunterDuoGuestSeat = active && guestSeat;
    if (!active) {
      this.peerDuoRoot.visible = false;
      this.disposeHunterPeerFigure();
      while (this.peerDuoRoot.children.length) {
        const ch = this.peerDuoRoot.children[0]!;
        this.peerDuoRoot.remove(ch);
        const disp = ch.userData.disposeGhost as (() => void) | undefined;
        if (disp) disp();
        else {
          ch.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry.dispose();
              const m = obj.material;
              if (Array.isArray(m)) m.forEach((x) => x.dispose());
              else (m as THREE.Material).dispose();
            }
          });
        }
      }
      /**
       * Solo `renderPage` calls this with false every time — only snap back to project spawn when
       * **leaving** Hunter shared camp, not on redundant false→false (avoids craft/gather teleport).
       */
      if (this.pvpDockLayout === 'off' && wasHunterShared) {
        this.travelHomeX = this.dockHomeX;
        this.travelHomeZ = this.dockHomeZ;
        this.travelHomeRotY = dockSoloIdleFaceYawRad();
        if (!this.playing || this.clip === 'idle') {
          this.avatar.position.x = this.travelHomeX;
          this.avatar.position.z = this.travelHomeZ;
          this.avatar.rotation.y = this.travelHomeRotY;
        }
        this.refreshSoloDockFramingFromAvatar();
        this.framingFov = 44;
      }
      return;
    }
    const duelHomeX = this.hunterDuoGuestSeat ? 0.38 : -0.38;
    const duelHomeZ = 0;
    const duelHomeRy = this.hunterDuoGuestSeat
      ? gatherFaceY(0.38, 0, -0.38, 0)
      : 0.22;
    this.travelHomeX = duelHomeX;
    this.travelHomeZ = duelHomeZ;
    this.travelHomeRotY = duelHomeRy;
    if (!this.playing || this.clip === 'idle') {
      this.avatar.position.x = this.travelHomeX;
      this.avatar.position.z = this.travelHomeZ;
      this.avatar.rotation.y = this.travelHomeRotY;
    }
    this.framingCamPos.set(0, 0.86, 2.78);
    this.framingLookAt.set(0, 0.38, 0);
    this.framingFov = 48;
  }

  /**
   * Face-off layout for online duels (`duel` = Hunter 1v1, `bracket` = wider 3v3 dock).
   * `aliveInRoom` drives progressive camera pull-back for large parties.
   * `duelGuestSeat`: non-host sits on +X facing -X (same rule as Hunter shared camp).
   */
  setPvpDuelDockLayout(mode: 'off' | 'duel' | 'bracket', aliveInRoom = 2, duelGuestSeat = false): void {
    const prevMode = this.pvpDockLayout;
    this.pvpDockLayout = mode;
    this.pvpDuelGuestSeat = mode !== 'off' && duelGuestSeat;
    this.bracketAliveCount = Math.max(2, aliveInRoom);
    const duelHomeX = this.pvpDuelGuestSeat ? 0.36 : -0.36;
    const duelHomeZ = 0;
    const duelHomeRy = gatherFaceY(duelHomeX, duelHomeZ, this.pvpDuelGuestSeat ? -0.36 : 0.36, 0);
    if (mode === 'off') {
      /**
       * `applyOnlineCharacterDockVisuals` passes `off` on every solo render — only restore solo spawn when
       * actually leaving duel/bracket layout, not off→off (same teleport bug as Hunter shared).
       */
      if (!this.hunterSharedWorldActive && prevMode !== 'off') {
        this.travelHomeX = this.dockHomeX;
        this.travelHomeZ = this.dockHomeZ;
        this.travelHomeRotY = dockSoloIdleFaceYawRad();
        this.avatar.position.x = this.travelHomeX;
        this.avatar.position.z = this.travelHomeZ;
        this.avatar.rotation.y = this.travelHomeRotY;
        this.refreshSoloDockFramingFromAvatar();
        this.framingFov = 44;
      }
      this.applyEnemyDockRestFromLayout();
      return;
    }
    this.travelHomeX = duelHomeX;
    this.travelHomeZ = duelHomeZ;
    this.travelHomeRotY = duelHomeRy;
    if (!this.playing || this.clip === 'idle') {
      this.avatar.position.x = this.travelHomeX;
      this.avatar.position.z = this.travelHomeZ;
      this.avatar.rotation.y = this.travelHomeRotY;
    }
    const wide = mode === 'bracket' || this.bracketAliveCount > 3;
    const pull = wide ? 1.12 + Math.min(0.28, (this.bracketAliveCount - 2) * 0.05) : 1;
    this.framingCamPos.set(0, 0.86, 2.55 * pull);
    this.framingLookAt.set(0, 0.38, 0);
    this.framingFov = wide ? 50 : 46;
    this.applyEnemyDockRestFromLayout();
  }

  private getEnemyRestXZ(): { x: number; z: number } {
    if (this.pvpDockLayout === 'duel' || this.pvpDockLayout === 'bracket') {
      return this.pvpDuelGuestSeat ? { x: -0.38, z: 0.06 } : { x: 0.38, z: 0.06 };
    }
    return {
      x: this.travelHomeX + BATTLE_ENEMY_OFFSET_X,
      z: this.travelHomeZ + BATTLE_ENEMY_OFFSET_Z,
    };
  }

  private applyEnemyDockRestFromLayout(): void {
    const { x, z } = this.getEnemyRestXZ();
    this.enemyRoot.position.set(x, 0, z);
    if (!this.enemyRoot.visible || !this.battleEnemyId) return;
    this.enemyRoot.rotation.y = gatherFaceY(x, z, this.travelHomeX, this.travelHomeZ);
  }

  private isSoloForestDockFraming(): boolean {
    return this.pvpDockLayout === 'off' && !this.hunterSharedWorldActive;
  }

  /**
   * Solo dock: camera **south-east** of avatar (see `idleCraftDockCameraCompass`) so noon sun from ~south
   * gives short lighting vs view; look-at chest — tracks avatar on terrain.
   */
  private refreshSoloDockFramingFromAvatar(): void {
    const ax = this.avatar.position.x;
    const ay = this.avatar.position.y;
    const az = this.avatar.position.z;
    this.framingLookAt.set(
      ax + CharacterScenePreview.DOCK_FRAME_LOOK_DX,
      ay + CharacterScenePreview.DOCK_FRAME_LOOK_DY,
      az + CharacterScenePreview.DOCK_FRAME_LOOK_DZ,
    );
    this.framingCamPos.set(ax + DOCK_SOLO_CAM_OFFSET_X, ay + DOCK_SOLO_CAM_OFFSET_Y, az + DOCK_SOLO_CAM_OFFSET_Z);
  }

  private applyCameraFraming(): void {
    const lx0 = this.framingLookAt.x + this.dockCamPan.x;
    const ly0 = this.framingLookAt.y + this.dockCamPan.y;
    const lz0 = this.framingLookAt.z + this.dockCamPan.z;
    const fx0 = this.framingCamPos.x + this.dockCamPan.x;
    const fy0 = this.framingCamPos.y + this.dockCamPan.y;
    const fz0 = this.framingCamPos.z + this.dockCamPan.z;
    let dx = fx0 - lx0;
    let dy = fy0 - ly0;
    let dz = fz0 - lz0;
    const dist0 = Math.hypot(dx, dy, dz) || 1;
    const yaw0 = Math.atan2(dx, dz);
    const pitch0 = Math.asin(THREE.MathUtils.clamp(dy / dist0, -1, 1));
    const yaw = yaw0 + this.dockCamYaw;
    const pitch = THREE.MathUtils.clamp(pitch0 + this.dockCamPitch, -1.12, 1.55);
    const dist = dist0 * this.userCameraZoom;
    const cosP = Math.cos(pitch);
    const ax = Math.sin(yaw) * cosP * dist;
    const ay = Math.sin(pitch) * dist;
    const az = Math.cos(yaw) * cosP * dist;
    /* === Over-the-shoulder offset (camera-lock only) ===
     *
     * GoW/Resident-Evil style: shift BOTH camera position AND look-at by the same
     * lateral amount so the view direction stays unchanged (camera-forward ray =
     * still going where the player aimed). The shift moves the avatar to the LEFT
     * of screen-center, putting the reticle (always at screen center) over the
     * player's RIGHT shoulder. Trajectory stays accurate because forward = (lookAt
     * - camPos), and adding the same vector to both leaves forward unchanged.
     *
     * Camera-RIGHT vector in world XZ for our framing math: with the camera at
     * `(lx + sin(yaw)·dist, *, lz + cos(yaw)·dist)` looking at `(lx, *, lz)`, the
     * camera's forward XZ is `(-sin(yaw), -cos(yaw))`. Right = forward rotated 90°
     * CW around +Y = `(-cos(yaw), +sin(yaw))`.
     *
     * Wait — a sanity check at yaw=0 (camera at +Z looking -Z): right vector should
     * be +X. Formula gives `(-cos(0), +sin(0)) = (-1, 0) = -X`. WRONG.
     * The issue is that `dockCamYaw` flipped the convention (see `cameraLockController`),
     * so the camera actually sits at the OPPOSITE side of what naive yaw math suggests.
     * Empirically: at `dockCamYaw = 0`, `framingCamPos` is south-east of the avatar
     * (DOCK_SOLO_CAM_OFFSET_X/Z constants), so `yaw0` lands somewhere in (0, π/2)
     * and the camera's actual right is `(+cos(yaw), -sin(yaw))`.
     *
     * Use `(+cos(yaw), -sin(yaw))` so right-shoulder cam puts the avatar on the LEFT
     * of screen as desired. */
    let shoulderDx = 0;
    let shoulderDy = 0;
    let shoulderDz = 0;
    if (this.cameraLockActive) {
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      shoulderDx = rightX * CharacterScenePreview.SHOULDER_OFFSET_RIGHT;
      shoulderDz = rightZ * CharacterScenePreview.SHOULDER_OFFSET_RIGHT;
      shoulderDy = CharacterScenePreview.SHOULDER_OFFSET_UP;
    }
    this.camera.position.set(lx0 + ax + shoulderDx, ly0 + ay + shoulderDy, lz0 + az + shoulderDz);
    /* === Terrain floor clamp (PARALLEL-TRANSLATE — preserves camera-forward) ===
     *
     * Stay above terrain so panning / zooming / standing in valleys doesn't
     * drive the camera through the ground.
     *
     * **2026-04 fix.** The previous version bumped ONLY `camera.position.y`
     * but left `lookAt` at avatar height — that rotated the camera-forward
     * vector toward the avatar, breaking the rule that "screen-center =
     * world point under reticle." Symptoms the user reported:
     *
     *   - **Zoom out misses the target.** Zooming out increases orbit `dist`,
     *     pushing camera Y down (especially at downward pitch). Floor clamp
     *     kicks in, lookAt unchanged → reticle aim tilts up vs the player's
     *     actual mouse pitch, so harvest/magic lands somewhere other than
     *     where the crosshair appears to be on screen.
     *   - **Magic shot drifts left when high in a tree.** The camera orbit
     *     for an avatar at Y=5 + downward pitch puts the camera Y BELOW the
     *     ground at the camera's XZ (which is the flat ground beside the
     *     tree, not the tree top). Clamp bumps Y up; lookAt stays at tree-
     *     top avatar height → camera-forward tilts UP, and combined with the
     *     right-shoulder offset, the muzzle-to-aim convergence drifts the
     *     impact point off-axis.
     *
     * Fix: when we have to bump position.y by `deltaY`, apply the SAME
     * `deltaY` to the lookAt target. That's a parallel translate of the
     * entire eye frame upward — camera-forward direction is mathematically
     * unchanged, so screen-center keeps pointing at the same world ray.
     * The visible side-effect is just that the avatar slides slightly down
     * on screen (camera is higher relative to it) which reads as "tall
     * camera" rather than "tilted camera." Same idiom we already use for
     * the right-shoulder offset (shift both ends of the eye frame, not
     * one). */
    let lookAtBumpY = 0;
    if (this.isSoloForestDockFraming() && this.getTerrainHeight) {
      const h = this.getTerrainHeight;
      const margin = 0.42;
      const floorY = computeSoloCameraClipFloorY(
        h,
        this.camera.position.x,
        this.camera.position.z,
        margin,
      );
      if (this.camera.position.y < floorY) {
        lookAtBumpY = floorY - this.camera.position.y;
        this.camera.position.y = floorY;
      }
    }
    this.camera.fov =
      this.framingFov * this.projectFovScale * (0.92 + 0.08 * this.userCameraZoom);
    /* CRITICAL: lookAt MUST shift by the same shoulder vector AND by the
     * same Y bump applied to the camera, otherwise the camera-forward ray
     * rotates and the reticle no longer points where projectiles fly. Same-
     * shift = parallel translate of the eye-frame = avatar moves off center
     * but aim is preserved. */
    this.camera.lookAt(lx0 + shoulderDx, ly0 + shoulderDy + lookAtBumpY, lz0 + shoulderDz);
    this.camera.updateProjectionMatrix();
  }

  /**
   * Online presence: optional gather mini-ghosts (co-op / bracket), Hunter 1v1 shared-world peer figure,
   * or awakened co-op world peers (continuous pose replication).
   */
  syncOnlinePresence(
    presence: ReadonlyMap<string, RemotePresenceEntry>,
    selfSessionId: string | null,
    roster: readonly RoomPlayerPublic[],
    opts: { gatherMiniGhosts: boolean; hunterDuoWorld: boolean; awakenCoopPeers: boolean },
  ): void {
    while (this.presenceGhostRoot.children.length) {
      const ch = this.presenceGhostRoot.children[0]!;
      this.presenceGhostRoot.remove(ch);
      const disp = ch.userData.disposeGhost as (() => void) | undefined;
      if (disp) disp();
      else {
        ch.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const m = obj.material;
            if (Array.isArray(m)) m.forEach((x) => x.dispose());
            else (m as THREE.Material).dispose();
          }
        });
      }
    }
    if (!opts.hunterDuoWorld) {
      this.disposeHunterPeerFigure();
      while (this.peerDuoRoot.children.length) {
        const ch = this.peerDuoRoot.children[0]!;
        this.peerDuoRoot.remove(ch);
        const disp = ch.userData.disposeGhost as (() => void) | undefined;
        if (disp) disp();
        else {
          ch.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry.dispose();
              const m = obj.material;
              if (Array.isArray(m)) m.forEach((x) => x.dispose());
              else (m as THREE.Material).dispose();
            }
          });
        }
      }
    }

    const nameBySession = new Map(roster.map((p) => [p.sessionId, p.displayName] as const));

    this.applyAwakenCoopPeersFromPresence(presence, selfSessionId, roster, opts.awakenCoopPeers);

    if (opts.hunterDuoWorld && selfSessionId) {
      const other = roster.find((p) => p.sessionId !== selfSessionId);
      if (!other) {
        this.disposeHunterPeerFigure();
        this.peerDuoRoot.visible = false;
        this.presenceHud.hidden = true;
        return;
      }
      const pr = presence.get(other.sessionId);
      /* Canonical duel seats (same world on every client): host -X, guest +X — peer is always "them". */
      const restX = this.hunterDuoGuestSeat ? -0.38 : 0.38;
      const restZ = 0;
      let px = restX;
      let pz = restZ;
      let faceTx = this.travelHomeX;
      let faceTz = this.travelHomeZ;
      if (pr?.page === 'gather' && pr.gatherKey) {
        const anchor = this.resolveGatherAnchorXZ(pr.gatherKey);
        if (anchor) {
          const u = pr.progress01 == null ? 1 : Math.max(0, Math.min(1, pr.progress01));
          /* Match local {@link applyTravelGather}: walk stops at approach ring, not raw node center. */
          const approach = gatherApproachPoint(restX, restZ, anchor.x, anchor.z, GATHER_STANDOFF);
          px = THREE.MathUtils.lerp(restX, approach.x, u);
          pz = THREE.MathUtils.lerp(restZ, approach.z, u);
          faceTx = anchor.x;
          faceTz = anchor.z;
        }
      }
      this.hunterPeerTargetX = px;
      this.hunterPeerTargetZ = pz;
      this.hunterPeerFaceTx = faceTx;
      this.hunterPeerFaceTz = faceTz;
      const nextKey = `${other.sessionId}\0${other.characterPresetId}`;
      if (this.hunterPeerFigKey !== nextKey || !this.hunterPeerFig) {
        this.disposeHunterPeerFigure();
        this.hunterPeerFig = this.buildFullTorsoPeerFigure(other.characterPresetId);
        this.hunterPeerFigKey = nextKey;
        this.peerDuoRoot.add(this.hunterPeerFig);
        const fig0 = this.hunterPeerFig;
        const peerY0 = (fig0.userData.peerGroundY as number | undefined) ?? 0;
        fig0.position.set(this.hunterPeerTargetX, peerY0, this.hunterPeerTargetZ);
        fig0.rotation.y = gatherFaceY(
          this.hunterPeerTargetX,
          this.hunterPeerTargetZ,
          this.hunterPeerFaceTx,
          this.hunterPeerFaceTz,
        );
        this.hunterPeerSmoothReady = true;
      }
      this.peerDuoRoot.visible = true;

      const act =
        pr?.page === 'gather' && pr.gatherKey
          ? `gathering ${pr.gatherKey}`
          : pr?.page
            ? `on ${pr.page}`
            : 'online';
      this.presenceHud.hidden = false;
      this.presenceHud.replaceChildren();
      const title = document.createElement('span');
      title.className = 'character-presence-hud__title';
      title.textContent = 'Hunter duel — shared view';
      this.presenceHud.appendChild(title);
      const line = document.createElement('span');
      line.className = 'character-presence-hud__item';
      line.textContent = `${other.displayName}: ${act}`;
      this.presenceHud.appendChild(line);
      return;
    }

    this.peerDuoRoot.visible = false;

    if (!opts.gatherMiniGhosts || !selfSessionId || presence.size === 0) {
      this.presenceHud.hidden = true;
      return;
    }
    const parts: string[] = [];
    for (const [sid, pr] of presence) {
      if (sid === selfSessionId) continue;
      if (pr.page !== 'gather') continue;
      const anchor = this.resolveGatherAnchorXZ(pr.gatherKey);
      if (!anchor) continue;
      const u = pr.progress01 == null ? 1 : Math.max(0, Math.min(1, pr.progress01));
      const hx = this.dockHomeX;
      const hz = this.dockHomeZ;
      const gx = THREE.MathUtils.lerp(hx, anchor.x, u);
      const gz = THREE.MathUtils.lerp(hz, anchor.z, u);
      const slot = (sid.charCodeAt(0) + sid.length * 13) % 5;
      const ox = ((slot % 3) - 1) * 0.07;
      const oz = (Math.floor(slot / 3) - 0.5) * 0.06;
      const mini = buildLobbyDockHeroFromPreset(presetForSession(sid), 0, 0.78);
      mini.position.set(gx + ox, 0, gz + oz);
      mini.rotation.y = gatherFaceY(gx + ox, gz + oz, anchor.x, anchor.z);
      this.presenceGhostRoot.add(mini);
      const nm = nameBySession.get(sid);
      if (nm && pr.gatherKey) {
        parts.push(`${nm} @ ${pr.gatherKey}`);
      }
    }
    if (parts.length === 0) {
      this.presenceHud.hidden = true;
      return;
    }
    this.presenceHud.hidden = false;
    this.presenceHud.replaceChildren();
    const title = document.createElement('span');
    title.className = 'character-presence-hud__title';
    title.textContent = 'Party nearby';
    this.presenceHud.appendChild(title);
    const list = document.createElement('span');
    list.className = 'character-presence-hud__list';
    for (const p of parts) {
      const it = document.createElement('span');
      it.className = 'character-presence-hud__item';
      it.textContent = p;
      list.appendChild(it);
    }
    this.presenceHud.appendChild(list);
  }

  private disposeAwakenCoopPeerFigs(): void {
    for (const sid of [...this.awakenCoopPeerFigs.keys()]) {
      const fig = this.awakenCoopPeerFigs.get(sid)!;
      this.awakenedCoopPeerRoot.remove(fig);
      const disp = fig.userData.disposeGhost as (() => void) | undefined;
      if (disp) disp();
      else {
        fig.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const m = obj.material;
            if (Array.isArray(m)) m.forEach((x) => x.dispose());
            else (m as THREE.Material).dispose();
          }
        });
      }
      this.awakenCoopPeerFigs.delete(sid);
      this.awakenCoopPeerFigKeys.delete(sid);
      this.awakenCoopPeerTargets.delete(sid);
      this.awakenCoopPeerSmoothReady.delete(sid);
    }
    this.awakenedCoopPeerRoot.visible = false;
  }

  private applyAwakenCoopPeersFromPresence(
    presence: ReadonlyMap<string, RemotePresenceEntry>,
    selfSessionId: string | null,
    roster: readonly RoomPlayerPublic[],
    enabled: boolean,
  ): void {
    if (!enabled || !selfSessionId) {
      this.disposeAwakenCoopPeerFigs();
      return;
    }
    const rosterBySid = new Map(roster.map((p) => [p.sessionId, p] as const));
    const active = new Set<string>();
    for (const [sid, pr] of presence) {
      if (sid === selfSessionId) continue;
      if (pr.realm !== 'awakened') continue;
      if (pr.wx == null || pr.wy == null || pr.wz == null || pr.wyaw == null) continue;
      active.add(sid);
      this.awakenCoopPeerTargets.set(sid, { x: pr.wx, y: pr.wy, z: pr.wz, yaw: pr.wyaw });
      const pl = rosterBySid.get(sid);
      const preset = pl?.characterPresetId ?? 'vanguard';
      const team = pl?.team === 1 ? 1 : 0;
      const key = `${sid}\0${preset}`;
      const existing = this.awakenCoopPeerFigs.get(sid);
      if (!existing || this.awakenCoopPeerFigKeys.get(sid) !== key) {
        if (existing) {
          this.awakenedCoopPeerRoot.remove(existing);
          const d0 = existing.userData.disposeGhost as (() => void) | undefined;
          if (d0) d0();
          else {
            existing.traverse((obj) => {
              if (obj instanceof THREE.Mesh) {
                obj.geometry.dispose();
                const m = obj.material;
                if (Array.isArray(m)) m.forEach((x) => x.dispose());
                else (m as THREE.Material).dispose();
              }
            });
          }
        }
        const fig = buildLobbyDockHeroFromPreset(preset, team, LOBBY_DOCK_HERO_WORLD_SCALE);
        this.awakenCoopPeerFigs.set(sid, fig);
        this.awakenCoopPeerFigKeys.set(sid, key);
        fig.position.set(pr.wx, pr.wy, pr.wz);
        fig.rotation.y = pr.wyaw;
        this.awakenCoopPeerSmoothReady.set(sid, false);
        this.awakenedCoopPeerRoot.add(fig);
      }
    }
    for (const sid of [...this.awakenCoopPeerFigs.keys()]) {
      if (!active.has(sid)) {
        const fig = this.awakenCoopPeerFigs.get(sid)!;
        this.awakenedCoopPeerRoot.remove(fig);
        const disp = fig.userData.disposeGhost as (() => void) | undefined;
        if (disp) disp();
        else {
          fig.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry.dispose();
              const m = obj.material;
              if (Array.isArray(m)) m.forEach((x) => x.dispose());
              else (m as THREE.Material).dispose();
            }
          });
        }
        this.awakenCoopPeerFigs.delete(sid);
        this.awakenCoopPeerFigKeys.delete(sid);
        this.awakenCoopPeerTargets.delete(sid);
        this.awakenCoopPeerSmoothReady.delete(sid);
      }
    }
    this.awakenedCoopPeerRoot.visible = active.size > 0;
  }

  private smoothAwakenCoopPeers(dt: number): void {
    if (this.awakenCoopPeerFigs.size === 0) return;
    for (const [sid, fig] of this.awakenCoopPeerFigs) {
      const tgt = this.awakenCoopPeerTargets.get(sid);
      if (!tgt) continue;
      const tx = tgt.x;
      const ty = tgt.y;
      const tz = tgt.z;
      const targetRy = tgt.yaw;
      const ready = this.awakenCoopPeerSmoothReady.get(sid);
      if (!ready) {
        fig.position.set(tx, ty, tz);
        fig.rotation.y = targetRy;
        this.awakenCoopPeerSmoothReady.set(sid, true);
        continue;
      }
      const dx = tx - fig.position.x;
      const dy = ty - fig.position.y;
      const dz = tz - fig.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > CharacterScenePreview.AWAKEN_COOP_PEER_SNAP_DIST || Math.abs(dy) > 3) {
        fig.position.set(tx, ty, tz);
        fig.rotation.y = targetRy;
        continue;
      }
      const k = CharacterScenePreview.AWAKEN_COOP_PEER_SMOOTH_PER_SEC;
      const a = 1 - Math.exp(-k * dt);
      fig.position.x = THREE.MathUtils.lerp(fig.position.x, tx, a);
      fig.position.y = THREE.MathUtils.lerp(fig.position.y, ty, a);
      fig.position.z = THREE.MathUtils.lerp(fig.position.z, tz, a);
      fig.rotation.y = lerpYaw(fig.rotation.y, targetRy, Math.min(1, a * 1.12));
    }
  }

  /** Set rival survivor look for online PvP / 3v3 dock duels (call before {@link syncBattleContext} with `pvp_rival`). */
  syncPvpDockRivalPreset(id: CharacterPresetId): void {
    this.pvpRivalDockPreset = id;
  }

  /** Show / rebuild PvE enemy model for the Battle tab (null = hidden). */
  syncBattleContext(enemyId: string | null): void {
    if (enemyId != null && enemyId === this.syncedBattleEnemyId) {
      return;
    }
    if (
      enemyId === null &&
      this.syncedBattleEnemyId === null &&
      this.enemyRoot.children.length === 0
    ) {
      return;
    }
    this.syncedBattleEnemyId = enemyId;
    this.enemyBattleRig = null;
    this.battleEnemyId = enemyId;
    this.battleEnemyCorpseFallen = false;
    if (!enemyId) {
      this.pendingEnemyDeathAfterStrike = false;
      this.pvpRivalDockPreset = null;
    } else if (enemyId !== 'pvp_rival') {
      this.pvpRivalDockPreset = null;
    }
    while (this.enemyRoot.children.length) {
      const ch = this.enemyRoot.children[0]!;
      this.enemyRoot.remove(ch);
      const disposeLpca = ch.userData.disposePveEnemy as (() => void) | undefined;
      if (disposeLpca) disposeLpca();
      else {
        ch.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const m = obj.material;
            if (Array.isArray(m)) m.forEach((x) => x.dispose());
            else (m as THREE.Material).dispose();
          }
        });
      }
    }
    /* Death clip mutates enemyRoot; children are replaced above but the parent Group keeps rotation/position. */
    this.enemyRoot.rotation.order = 'XYZ';
    this.enemyRoot.rotation.set(0, 0, 0);
    const rest = this.getEnemyRestXZ();
    this.enemyRoot.position.set(rest.x, 0, rest.z);
    this.enemyRoot.visible = !!enemyId;
    if (!enemyId) return;
    if (enemyId === 'pvp_rival') {
      const presetId = this.pvpRivalDockPreset ?? 'vanguard';
      const fig = this.buildFullTorsoPeerFigure(presetId);
      fig.scale.multiplyScalar(1.02);
      fig.userData.disposePveEnemy = () => {
        fig.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry.dispose();
            const m = obj.material;
            if (Array.isArray(m)) m.forEach((x) => x.dispose());
            else (m as THREE.Material).dispose();
          }
        });
      };
      this.enemyBattleRig = null;
      this.enemyRoot.add(fig);
      this.enemyRoot.rotation.y = gatherFaceY(
        this.enemyRoot.position.x,
        this.enemyRoot.position.z,
        this.travelHomeX,
        this.travelHomeZ,
      );
      return;
    }
    const fig = createPveEnemyLPCA(enemyId);
    fig.group.userData.disposePveEnemy = fig.dispose;
    this.enemyBattleRig = fig.battleRig ?? null;
    this.enemyRoot.add(fig.group);
  }

  /**
   * Hide WebGL present for worker-visible dock paths — see {@link suppressPresentation}.
   * Safe to toggle multiple times (e.g. return-to-title rebuild).
   */
  setSuppressPresentation(on: boolean): void {
    this.suppressPresentation = on;
  }

  /**
   * Move the WebGL canvas + presence HUD into a new container (used by the boot-time preload
   * flow: scene built in an offscreen div while the title screen is up, then reparented into
   * `#character-preview-root` when the user clicks "Enter world"). The WebGL context stays
   * bound to the same canvas element, so no pipeline rebuild is needed.
   */
  reparent(newContainer: HTMLElement): void {
    if (newContainer === this.container) return;
    const canvas = this.renderer.domElement;
    newContainer.appendChild(canvas);
    newContainer.appendChild(this.presenceHud);
    this.container = newContainer;
    if (this.containerResizeObs) {
      this.containerResizeObs.disconnect();
      this.containerResizeObs = new ResizeObserver(() => this.onResize());
      this.containerResizeObs.observe(newContainer);
    }
    this.onResize();
  }

  /** Floating combat numbers over the WebGL dock (HTML overlay). */
  showDamageFloater(text: string, kind: 'enemy' | 'player'): void {
    const el = document.createElement('div');
    el.className = `character-dmg-floater character-dmg-floater--${kind}`;
    el.textContent = text;
    this.container.appendChild(el);
    requestAnimationFrame(() => el.classList.add('character-dmg-floater--lift'));
    setTimeout(() => el.remove(), 950);
  }

  private onResize = (): void => {
    const { w, h } = dockPreviewDrawSize(this.container);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.computeEffectivePixelRatio(w, h));
    this.renderer.setSize(w, h, false);
    this.postProcessing?.setSize(w, h, this.renderer.getPixelRatio());
  };

  /**
   * Public wrapper to re-apply the current effective pixel ratio + post-stack
   * size. Called from the system menu when the player flips the awakened-
   * quality tier so the new DPR cap takes effect immediately without a full
   * window resize. Cheap — same path the resize observer uses. */
  refreshPixelRatio(): void {
    this.onResize();
  }

  /**
   * Render-buffer pixel ratio (multiplied with canvas CSS size to get the actual pixel
   * count rasterized). Inputs:
   *   1. `window.devicePixelRatio` — what the OS reports (HiDPI laptop ≈ 2.0).
   *   2. `graphicsBudget.maxDevicePixelRatio` — tier cap (high tier = 2.25, low = 1.15).
   *   3. `renderScale * graphicsBudget.renderScaleMul` — project + tier multipliers.
   *   4. **Awakened-mode total-pixel budget** — tier-aware ceiling on `cssW * cssH * dpr²`.
   *      Scales `dpr` down further when the natural buffer would exceed the budget so
   *      fragment work stays bounded as the canvas grows (windowed → fullscreen, 1080p
   *      → 4K, large external monitors). Preserves aspect ratio because both buffer
   *      dimensions get the SAME multiplier — the browser does the (free) upscale to
   *      the displayed CSS box.
   *
   * Awakened-mode shrink:
   *   - **DPR hard-cap at 1.0** when the player hasn't picked the `'full'` tier. On a
   *     1080p × DPR 2 laptop that shrinks the buffer from 7.95 MP to 2.07 MP per frame
   *     (4× less shading work). Visual regression is minimal because (a) the camera is
   *     moving in awakened mode (motion masks aliasing), (b) FXAA stays in the post
   *     stack to soften any introduced jaggies, and (c) most consumer panels don't
   *     actually display sub-CSS-pixel detail anyway.
   *   - **Total-pixel budget** kicks in when the CSS canvas is bigger than ~1080p
   *     (fullscreen on a 1440p / 4K monitor, or a maximised window on an ultrawide).
   *     Tier-aware target: `'perf'` ≈ 2.07 MP (1920×1080), `'balanced'` ≈ 3.1 MP
   *     (1.5× headroom for the bloom pass), `'full'` no cap. Round-3 (2026-04-18) only
   *     capped DPR — which works at 1080p because DPR=1.0 yields ≤ 2.07 MP — but on
   *     larger CSS boxes the pixel count balloons without bound. Round 4 (2026-04-20)
   *     adds the area-aware DPR shrink on top so the windowed-mode FPS extends to
   *     ANY canvas size.
   *
   * Pass `cssW` / `cssH` (CSS pixels of the preview / awakened canvas) when available.
   * Without them the area cap is skipped and only the DPR cap applies — safe fallback
   * for paths that haven't fetched container dimensions yet.
   */
  private computeEffectivePixelRatio(cssW?: number, cssH?: number): number {
    const devCap = this.graphicsBudget.maxDevicePixelRatio;
    /* Tier-based DPR + pixel-area cap. The `awakenedQuality` setting now
     * applies UNIFORMLY in both dream (deck) and awakened mode — Phase 8l
     * deferred the dream-mode application, but the player observed the dock
     * preview running at higher quality than awakened and asked for parity.
     * `'full'` tier opts both out (matches the legacy dream-mode behaviour
     * for users on dedicated GPUs / power-users with `awakenedFullQuality = '1'`).
     * Read tier fresh each call so Esc-menu changes apply immediately
     * without a renderer rebuild. */
    let tierCap = devCap;
    let pixelBudget = Number.POSITIVE_INFINITY;
    const tier = getEffectiveRendererDisplay(
      (this.empireProject?.config ?? {}) as Record<string, unknown>,
    ).awakenedQuality;
    /* === 2026-04-22 tier hierarchy reshaped (player report) ===
     *
     * Earlier same day: bumped `'balanced'` to DPR 1.5 + 4.10 MP to fix
     * "blur on distant trees." Player follow-up: that drops FPS to 30-40
     * (too low) — even though it "looks amazing." The DPR jump 1.0 → 1.5
     * is 2.25× fragment work; combined with the 1.32× pixel budget bump
     * that's ~3× more fragment cost, which most GPUs can't sustain at 60+.
     *
     * New tier hierarchy keeps `'perf'` and `'balanced'` on the SAME
     * buffer size (DPR 1.0 + 2.07 MP) — the only difference between them
     * is post-processing intensity:
     *   - `'perf'`     → cheap bloom (low strength/radius), no SSAO
     *   - `'balanced'` → full bloom (default strength/radius), no SSAO
     *   - `'full'`     → full bloom + SSAO + uncapped DPR + no pixel budget
     *
     * The visual gap between `'perf'` and `'balanced'` is now "soft glow
     * vs strong glow on emissives" instead of "blurry buffer + no glow vs
     * sharp buffer + glow." Players get bloom on the FPS-safe default;
     * those who explicitly want more glow can opt up to `'balanced'`
     * without paying the buffer-size cost; `'full'` remains the
     * uncapped power-user tier. */
    if (tier !== 'full') tierCap = 1.0;
    if (tier === 'perf' || tier === 'balanced') {
      pixelBudget = 1920 * 1080; // ~2.07 MP — DPR-1.0-at-1080p baseline.
    }
    const cap = Math.min(devCap, tierCap);
    let dpr = Math.min(window.devicePixelRatio, cap) *
      this.renderScale *
      this.graphicsBudget.renderScaleMul;
    if (
      Number.isFinite(pixelBudget) &&
      cssW !== undefined &&
      cssH !== undefined &&
      cssW > 0 &&
      cssH > 0 &&
      dpr > 0
    ) {
      const naturalPixels = cssW * cssH * dpr * dpr;
      if (naturalPixels > pixelBudget) {
        /* Both dimensions get the same scale factor → buffer aspect stays
         * exactly equal to CSS aspect → no distortion when the browser
         * upscales the buffer to the displayed canvas box. */
        dpr *= Math.sqrt(pixelBudget / naturalPixels);
      }
    }
    return dpr;
  }

  /**
   * Apply or remove the awakened free-roam render budget (DPR cap + post-stack trim).
   * Idempotent — safe to call repeatedly with the same value. Triggers a renderer pixel
   * ratio recompute + post-stack rebuild only when state actually changes. Called from
   * `setAwakenedFreeRoam` on realm flip; can also be invoked directly from system menu /
   * dev console for A/B testing.
   */
  setAwakenedRenderBudget(awakened: boolean): void {
    if (this.awakenedRenderBudget === awakened) return;
    this.awakenedRenderBudget = awakened;
    /* Re-apply pixel ratio for the new effective DPR cap. */
    this.onResize();
    /* Re-apply post-stack so bloom + SSAO are dropped (or restored on flip back to deck). */
    this.applyDockPostProcessing();
  }

  /** Tone mapping, exposure, output color space, and dock light multipliers (Esc / project). */
  applyDockRendererDisplay(): void {
    const cfg = (this.empireProject?.config ?? {}) as Record<string, unknown>;
    const d = getEffectiveRendererDisplay(cfg);
    this.renderer.toneMapping = d.toneMapping;
    this.renderer.outputColorSpace = d.outputColorSpace;
    this.baseToneMappingExposure = d.exposureRaw * 0.93;
    this.dockEnvironment?.setLightingMultipliers({
      sun: d.sunIntensity,
      ambient: d.ambientBrightness,
      hemi: d.hemisphereFill,
      moon: d.moonlightStrength,
      /* Phase 8h overhaul knobs (Esc-tunable). */
      cameraFill: d.cameraFill,
      nightGrade: d.nightGradeStrength,
      sunShafts: d.sunShafts,
      envIntensity: d.envReflections,
    });
    this.renderer.toneMappingExposure =
      this.baseToneMappingExposure * (this.dockEnvironment?.getExposureMultiplier() ?? 1);
  }

  /** Recreate or update post-processing after Esc menu / `localStorage` / awakened-flip changes. */
  applyDockPostProcessing(): void {
    const cfg = (this.empireProject?.config ?? {}) as Record<string, unknown>;
    let opts = getEffectivePostProcessingOptionsForPreview(cfg, this.graphicsBudget.tier);
    /* Tier-based post-stack trim, applied UNIFORMLY in dream + awakened modes
     * (un-gated from `awakenedRenderBudget` 2026-04-20 — player asked for
     * dream-mode parity so the dock preview doesn't run at higher quality
     * than awakened). Bloom + SSAO are the two heaviest fragment-shader passes:
     *   - SSAO   = multiple kernel taps per pixel × ssaoResolutionScale (heaviest).
     *   - Bloom  = 5+ downscale + blur passes (mid-cost; cheaper at the new 0.85
     *              threshold from Phase 8h since most pixels fail the threshold).
     * FXAA + vignette + Phase 8h night-grade always stay (each negligible).
     *
     *   - `perf`     tier → CHEAP BLOOM ON (low strength + tight radius) + SSAO OFF.
     *                       2026-04-22 update: was "drop both" but bloom is the single
     *                       biggest visual feature `'balanced'` adds, and a cheap bloom
     *                       config (strength 0.18, radius 0.18, threshold 0.94) costs
     *                       ~3-5 ms on integrated GPU vs 5-8 ms for the default config —
     *                       roughly half the cost of the `'balanced'` bloom while
     *                       providing 70 % of the visual lift. Magic projectiles +
     *                       mushroom caps + lanterns + emissive props now glow softly
     *                       on the FPS-protective tier too.
     *   - `balanced` tier → keep bloom (default strength) + drop SSAO.
     *   - `full`     tier → no trim. Matches legacy dream-mode at full perf cost.
     *
     * Tier read fresh each rebuild so Esc-menu changes apply on the next post-stack
     * apply (which `applyPostProcessingOptionsToStack` calls when sliders change). */
    const tier = getEffectiveRendererDisplay(cfg).awakenedQuality;
    if (tier === 'perf') {
      /* Cheap bloom: weak strength + tight radius + high threshold so only
       * the brightest emissive pixels (magic orbs, mushroom caps, lanterns)
       * actually bloom. Most fragments fail the threshold and skip the
       * downscale pyramid — keeps the cost bounded. */
      opts = {
        ...opts,
        bloom: true,
        ssao: false,
        bloomStrength: 0.18,
        bloomRadius: 0.18,
        bloomThreshold: 0.94,
      };
    } else if (tier === 'balanced') {
      /* Cheap SSAO via reduced resolution scale: project.json has
       * `ssaoResolutionScale: 1.0` (full buffer res — expensive); on
       * `'balanced'` we override to 0.35 (~12% of buffer pixels) which
       * costs ~3-5 ms on integrated GPU vs ~12-18 ms at full res. The
       * visual difference between 0.35 and 1.0 SSAO is barely perceptible
       * because the SSAO buffer is blurred + composited on top of the
       * shaded scene anyway. Plus tighter `ssaoKernelSize: 8` (project
       * default 12) for further savings. */
      opts = {
        ...opts,
        ssao: true,
        ssaoResolutionScale: 0.35,
        ssaoKernelSize: 8,
      };
    }
    /* `full` tier: no trim. */
    const { w, h } = dockPreviewDrawSize(this.container);
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
    this.postProcessing.setSize(w, h, this.renderer.getPixelRatio());
    /* Inject the night-grade pass (Phase 8h §4) ONCE per stack lifetime.
     * Composer rebuilds (e.g. on tier change) trigger re-injection because
     * `nightGradePass` is reset to null when `postProcessing` is null. */
    this.ensureNightGradePass();
  }

  /**
   * Inject the night-grade post-process pass into the composer if not yet
   * present. Phase 8h lighting plan §4 — desaturate + cool-tint + gamma
   * crush so night reads as moonlight instead of "blue daytime."
   *
   * The pass is added BEFORE vignette so vignette darkens the already-graded
   * night image (vignette + crush together sell "lights at the edges" night
   * feel). FXAA stays last to anti-alias the final composite.
   */
  private ensureNightGradePass(): void {
    if (!this.postProcessing) {
      this.nightGradePass = null;
      return;
    }
    if (this.nightGradePass) return; /* already injected for this composer */
    const composer = this.postProcessing.getComposer();
    const pass = createNightGradePass();
    /* Insert before the vignette pass if present, else just append.
     * EffectComposer's `passes` array is public; we splice in the right slot. */
    const passes = composer.passes;
    const vignetteIdx = passes.findIndex((p) =>
      (p as { name?: string }).name === 'VignetteShader'
      || (p as { material?: { uniforms?: Record<string, unknown> } })
        .material?.uniforms?.['offset'] !== undefined
        && (p as { material?: { uniforms?: Record<string, unknown> } })
        .material?.uniforms?.['darkness'] !== undefined,
    );
    if (vignetteIdx >= 0) {
      composer.insertPass(pass, vignetteIdx);
    } else {
      composer.addPass(pass);
    }
    this.nightGradePass = pass;
  }

  /**
   * LPCA survivor preset: palette, silhouette (torso/head scale), headwear swap, then foot relevel.
   * Grounding uses world AABB delta (not y = -min.y) so we never stack offsets.
   */
  applyCharacterPreset(id: CharacterPresetId): void {
    /* === 2026-04-22 idempotency early-return (with first-call sentinel) ===
     *
     * Pre-applied during the title flow via `bindGameStoreToDockPreview`
     * (in `engine/dockPreload.ts`), so by the time mountApp's enter-game
     * call lands here, the active preset already matches. Skipping the
     * full material-color sweep + scale write + headwear toggle saves
     * ~5-30 ms off the click → game critical path on the warm path.
     *
     * `presetApplied` MUST gate the early-return because the constructor
     * sets `activeCharacterPresetId = 'vanguard'` as a placeholder without
     * actually applying the preset. Without the flag, a player whose
     * stored preset matches the placeholder would have the function skip
     * the visibility-toggle block (`vanguardWizardRobeRoot.visible = true`
     * etc.) on the very first call — manifests as "wizard is gone, wrong
     * character appears" because the visibility flags stay at whatever
     * `buildDockHeroLpca` constructed them as. */
    if (this.presetApplied && this.activeCharacterPresetId === id) return;
    this.presetApplied = true;
    this.activeCharacterPresetId = id;
    const def = getCharacterPreset(id);
    const pal = def.palette;
    this.avatarSkinMat.color.setHex(pal.skin);
    this.avatarUndertunicMat.color.setHex(pal.undertunic);
    this.avatarJerkinMat.color.setHex(pal.jerkin);
    this.avatarTrimMat.color.setHex(pal.trim);
    this.avatarPantsMat.color.setHex(pal.pants);
    this.avatarBootMat.color.setHex(pal.boot);
    this.avatarHairMat.color.setHex(pal.hair);
    this.avatarHatBandMat.color.setHex(pal.hatBand);
    this.avatarHatTopMat.color.setHex(pal.hatTop);
    this.avatarHatBrimMat.color.setHex(pal.hatBrim);
    if (pal.lipRose !== undefined) {
      this.forgeWifeLipMat.color.setHex(pal.lipRose);
    }
    if (pal.eyeIris !== undefined) {
      this.forgeWifeIrisMat.color.setHex(pal.eyeIris);
    }
    this.vanguardStaffWoodMat.color.setHex(pal.jerkin);
    this.vanguardStaffGemMat.color.setHex(pal.trim);

    const sx = this.hunterSharedWorldActive ? this.travelHomeX : this.dockHomeX;
    const sz = this.hunterSharedWorldActive ? this.travelHomeZ : this.dockHomeZ;
    const ry = this.hunterSharedWorldActive ? this.travelHomeRotY : dockSoloIdleFaceYawRad();
    this.avatar.scale.setScalar(def.avatarScale);
    this.torso.scale.set(def.torsoScale.x, def.torsoScale.y, def.torsoScale.z);
    this.headRoot.scale.setScalar(def.headScale);
    this.hatGroup.visible = def.headwear === 'frontier_hat';
    this.smithBandanaGroup.visible = false;

    const build: CharacterBuildKind = def.characterBuild ?? 'default';
    this.activeCharacterBuild = build;
    this.artisanHairPrimaryMat.color.setHex(pal.hair);
    if (pal.hairStreak !== undefined) {
      this.artisanHairStreakMat.color.setHex(pal.hairStreak);
    }
    if (build === 'artisan_female') {
      this.avatarJerkinMat.side = THREE.FrontSide;
      this.avatarUndertunicMat.side = THREE.FrontSide;
      this.lpcaDefaultHair.visible = false;
      this.lpcaArtisanHair.visible = true;
      this.glassesGroup.visible = false;
      for (const o of this.maleDockFaceList) o.visible = false;
      this.forgeWifeHeadRoot.visible = true;
      this.trunkUnderMesh.visible = false;
      this.trunkJerkinMesh.visible = false;
      this.forgeWifeTorsoRoot.visible = true;
      this.forgeWifeOverlayRoot.visible = true;
      this.vanguardWizardRobeRoot.visible = false;
      this.vanguardWizardBeardRoot.visible = false;
      this.vanguardWizardHatRoot.visible = false;
      this.vanguardWizardStaffRoot.visible = false;
      this.lpcaJaw.scale.copy(this.faceNeutral.jaw);
      this.lpcaChin.scale.copy(this.faceNeutral.chin);
      this.lpcaCheekL.scale.copy(this.faceNeutral.cheek);
      this.lpcaCheekR.scale.copy(this.faceNeutral.cheek);
      this.lpcaCranium.scale.copy(this.faceNeutral.cranium);
      this.lpcaShPadL.scale.set(
        this.faceNeutral.shPad.x * 0.76,
        this.faceNeutral.shPad.y * 0.92,
        this.faceNeutral.shPad.z * 0.78,
      );
      this.lpcaShPadR.scale.copy(this.lpcaShPadL.scale);
      this.lpcaNeck.scale.set(0.9, 0.97, 0.9);
    } else if (build === 'vanguard_wizard') {
      this.lpcaDefaultHair.visible = true;
      this.lpcaArtisanHair.visible = false;
      this.glassesGroup.visible = true;
      for (const o of this.maleDockFaceList) o.visible = true;
      this.forgeWifeHeadRoot.visible = false;
      /* Keep stock torso LPCA under the wizard shell — robe is an outer layer, not a replacement body. */
      this.trunkUnderMesh.visible = true;
      this.trunkJerkinMesh.visible = true;
      this.forgeWifeTorsoRoot.visible = false;
      this.forgeWifeOverlayRoot.visible = false;
      this.hatGroup.visible = false;
      this.avatarJerkinMat.side = THREE.DoubleSide;
      this.avatarUndertunicMat.side = THREE.DoubleSide;
      this.vanguardWizardRobeRoot.visible = true;
      this.vanguardWizardBeardRoot.visible = true;
      this.vanguardWizardHatRoot.visible = true;
      this.vanguardWizardStaffRoot.visible = true;
      this.lpcaJaw.scale.copy(this.faceNeutral.jaw);
      this.lpcaChin.scale.copy(this.faceNeutral.chin);
      this.lpcaCheekL.scale.copy(this.faceNeutral.cheek);
      this.lpcaCheekR.scale.copy(this.faceNeutral.cheek);
      this.lpcaCranium.scale.copy(this.faceNeutral.cranium);
      this.lpcaShPadL.scale.copy(this.faceNeutral.shPad);
      this.lpcaShPadR.scale.copy(this.faceNeutral.shPad);
      this.lpcaNeck.scale.set(1, 1, 1);
    } else {
      this.avatarJerkinMat.side = THREE.FrontSide;
      this.avatarUndertunicMat.side = THREE.FrontSide;
      this.lpcaDefaultHair.visible = true;
      this.lpcaArtisanHair.visible = false;
      this.glassesGroup.visible = true;
      for (const o of this.maleDockFaceList) o.visible = true;
      this.forgeWifeHeadRoot.visible = false;
      this.trunkUnderMesh.visible = true;
      this.trunkJerkinMesh.visible = true;
      this.forgeWifeTorsoRoot.visible = false;
      this.forgeWifeOverlayRoot.visible = false;
      this.vanguardWizardRobeRoot.visible = false;
      this.vanguardWizardBeardRoot.visible = false;
      this.vanguardWizardHatRoot.visible = false;
      this.vanguardWizardStaffRoot.visible = false;
      this.lpcaJaw.scale.copy(this.faceNeutral.jaw);
      this.lpcaChin.scale.copy(this.faceNeutral.chin);
      this.lpcaCheekL.scale.copy(this.faceNeutral.cheek);
      this.lpcaCheekR.scale.copy(this.faceNeutral.cheek);
      this.lpcaCranium.scale.copy(this.faceNeutral.cranium);
      this.lpcaShPadL.scale.copy(this.faceNeutral.shPad);
      this.lpcaShPadR.scale.copy(this.faceNeutral.shPad);
      this.lpcaNeck.scale.set(1, 1, 1);
    }

    this.updateVanguardWizardAttachmentVisibility();
    if (build === 'vanguard_wizard') {
      this.vanguardStaffOrbVfx.syncPalette(pal.hair, pal.trim);
    }
    this.refreshVanguardStaffOrbVfx();
    this.avatar.rotation.y = ry;
    this.avatar.position.x = sx;
    this.avatar.position.z = sz;
    this.relevelAvatarFeet();
  }

  /** Orb VFX only when vanguard staff is the visible right-hand prop. */
  private refreshVanguardStaffOrbVfx(): void {
    const show =
      this.activeCharacterBuild === 'vanguard_wizard' &&
      this.vanguardWizardRobeRoot.visible &&
      this.vanguardWizardStaffRoot.visible;
    this.vanguardStaffOrbVfx.setActive(show);
  }

  /**
   * Force the Vanguard's silver wizard staff to stay visible regardless of what
   * else is in the right hand. Set true when an offensive spell is equipped in
   * awakened mode — the player needs to SEE the staff that's channeling their
   * spell, even if they also have a crafted axe / sword equipped. mountApp
   * subscribes to spell equip / realm changes and toggles this flag.
   */
  private staffPriorityVisible = false;

  setStaffPriorityVisible(on: boolean): void {
    if (this.staffPriorityVisible === on) return;
    this.staffPriorityVisible = on;
    this.updateVanguardWizardAttachmentVisibility();
  }

  /**
   * Procedural staff vs axe/sword/pick in {@link heldInRightHand} or mining pick in {@link minePickRight}.
   * Inventory sets `heldInRightHand.visible` true for “full loadout” even when the group is empty
   * (wizard has no sword mesh) — only hide staff when a prop mesh is actually parented there.
   *
   * `staffPriorityVisible` (set by `setStaffPriorityVisible`) overrides the hide path
   * so the staff stays out during awakened-mode casting even when an axe is also held.
   * Without this override, equipping an offensive spell + holding any melee weapon
   * meant the player saw their axe but cast invisible magic — visual disconnect that
   * the user reported as "the staff isn't shooting magic."
   */
  private updateVanguardWizardAttachmentVisibility(): void {
    const def = getCharacterPreset(this.activeCharacterPresetId);
    if (def.characterBuild !== 'vanguard_wizard') return;
    if (!this.vanguardWizardRobeRoot.visible) return;
    const hasHeldProp = this.heldInRightHand.visible && this.heldInRightHand.children.length > 0;
    const hasMinePick = this.minePickRight.visible && this.minePickRight.children.length > 0;
    this.vanguardWizardStaffRoot.visible = this.staffPriorityVisible || (!hasHeldProp && !hasMinePick);
    this.refreshVanguardStaffOrbVfx();
  }

  /**
   * Lowest point that should touch the ground. Wizard robe extends below the feet; using the full
   * avatar AABB would plant the hem on the terrain and float the body — feet meshes are the reference.
   */
  private getAvatarGroundContactWorldY(): number {
    this.avatar.updateMatrixWorld(true);
    if (this.activeCharacterBuild === 'vanguard_wizard' && this.vanguardWizardRobeRoot.visible) {
      const b = new THREE.Box3();
      b.union(new THREE.Box3().setFromObject(this.footLMesh));
      b.union(new THREE.Box3().setFromObject(this.footRMesh));
      if (!b.isEmpty()) return b.min.y;
    }
    const box = new THREE.Box3().setFromObject(this.avatar);
    return box.isEmpty() ? 0 : box.min.y;
  }

  /**
   * Place feet on terrain (Game of Empires pattern: `terrainY - getGroundOffset()` via AABB foot height).
   */
  private relevelAvatarFeet(): void {
    const footY = this.getAvatarGroundContactWorldY();
    this.avatar.position.y -= footY;
    if (this.getTerrainHeight) {
      this.avatar.position.y += this.getTerrainHeight(this.avatar.position.x, this.avatar.position.z);
    }
  }

  /**
   * Per-frame foot plant on displaced terrain (see `NPC.snapToGround` in Game of
   * Empires). When a `surfaceYProvider` is wired (awakened-mode collision world),
   * this uses the SURFACE Y under the player — terrain OR top of a foundation /
   * floor / stair / rock the player walked onto. Without that, the snap would
   * yank the player back down to terrain even while standing on a 0.55 m stair.
   */
  private syncAvatarFeetToTerrain(): void {
    if (!this.getTerrainHeight) return;
    const footWorldY = this.getAvatarGroundContactWorldY();
    const terrainY = this.getTerrainHeight(this.avatar.position.x, this.avatar.position.z);
    /* Surface override only used in awakened mode — deck mode keeps the simple
     * terrain-only behavior. The provider returns null when the player is
     * grounded on bare terrain (or airborne), in which case we fall through to
     * the terrain sample. */
    let groundY = terrainY;
    if (this.awakenedFreeRoam && this.surfaceYProvider) {
      const s = this.surfaceYProvider();
      if (s !== null && s !== undefined) groundY = s;
    }
    this.avatar.position.y += groundY - footWorldY;
  }

  private rebuildHarvestSlotTable(): void {
    this.harvestSlotByKind = allHarvestSlotPositions(this.gatherWaterXZ);
  }

  private harvestXZ(kind: HarvestNodeKind, slot: number): { x: number; z: number } {
    /* Awakened in-place harvest — return current avatar XZ so the clip's walk-to-target
     * lerp stays at the current position and only the work phase visibly animates. */
    if (this.inPlaceHarvestActive) {
      return { x: this.avatar.position.x, z: this.avatar.position.z };
    }
    const ring = this.harvestSlotByKind[kind];
    const i = Math.max(0, Math.min(ring.length - 1, slot));
    const raw = ring[i] ?? ring[0]!;
    const t = Math.max(0, Math.min(0.5, this.gatherTravelTowardHome01[kind] ?? 0));
    return {
      x: raw.x + (this.dockHomeX - raw.x) * t,
      z: raw.z + (this.dockHomeZ - raw.z) * t,
    };
  }

  /** Sync dock gather prop positions + clip length from {@link GameStore} harvest mastery. */
  syncGatherRpgVisuals(
    towardHome01: Partial<Record<HarvestNodeKind, number>>,
    clipFactor: Partial<Record<HarvestNodeKind, number>>,
  ): void {
    for (const k of HARVEST_NODE_KINDS) {
      const th = towardHome01[k];
      if (th !== undefined) this.gatherTravelTowardHome01[k] = th;
      const cf = clipFactor[k];
      if (cf !== undefined) this.gatherClipDurationByKind[k] = cf;
    }
    this.relevelGatherPropsToTerrain();
  }

  /** Move the prop for this action to the reserved ring slot (XZ only; Y from terrain relevel). */
  private applyActiveGatherPropPositions(actionId: string, slot: number): void {
    const kind = actionIdToHarvestKind(actionId);
    if (!kind) return;
    const { x, z } = this.harvestXZ(kind, slot);
    const yKeep = (obj: THREE.Object3D): number => obj.position.y;
    switch (kind) {
      case 'wood':
        this.woodTreeMesh.position.set(x, yKeep(this.woodTreeMesh), z);
        break;
      case 'stone':
        this.stonePileMesh.position.set(x, yKeep(this.stonePileMesh), z);
        break;
      case 'fiber':
        this.fiberBundleMesh.position.set(x, yKeep(this.fiberBundleMesh), z);
        break;
      case 'berries':
        this.bushMesh.position.set(x, yKeep(this.bushMesh), z);
        break;
      case 'mine':
        this.rockMesh.position.set(x, yKeep(this.rockMesh), z);
        break;
      case 'garden':
        this.plantMesh.position.set(x, yKeep(this.plantMesh), z);
        break;
      case 'hunt':
        this.huntPreyGroup.position.set(x, yKeep(this.huntPreyGroup), z);
        break;
      case 'water':
        break;
    }
  }

  /** Snap manual-gather prop roots to the heightfield (same space as {@link relevelAvatarFeet}). */
  private relevelGatherPropsToTerrain(): void {
    const h = this.getTerrainHeight;
    if (!h) return;
    const ground = (obj: THREE.Object3D, x: number, z: number, dy: number): void => {
      obj.position.y = h(x, z) + dy;
    };
    const b0 = this.harvestXZ('berries', 0);
    const g0 = this.harvestXZ('garden', 0);
    const m0 = this.harvestXZ('mine', 0);
    const s0 = this.harvestXZ('stone', 0);
    const f0 = this.harvestXZ('fiber', 0);
    const w0 = this.harvestXZ('wood', 0);
    const h0 = this.harvestXZ('hunt', 0);
    ground(this.bushMesh, b0.x, b0.z, 0.02);
    ground(this.plantMesh, g0.x, g0.z, 0.01);
    ground(this.rockMesh, m0.x, m0.z, 0.08);
    ground(this.stonePileMesh, s0.x, s0.z, 0.02);
    ground(this.fiberBundleMesh, f0.x, f0.z, 0.02);
    ground(this.woodTreeMesh, w0.x, w0.z, 0);
    ground(this.huntPreyGroup, h0.x, h0.z, 0);
  }

  /** Map gather action ids to manual-gather anchor XZ (presence ghosts + travel). */
  private resolveGatherAnchorXZ(actionId: string | null): { x: number; z: number } | null {
    if (!actionId) return null;
    const kind = actionIdToHarvestKind(actionId);
    if (!kind) return null;
    return { ...this.harvestXZ(kind, 0) };
  }

  private deepCloneMeshMaterials(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        const m = o.material;
        o.material = Array.isArray(m) ? m.map((x) => x.clone()) : m.clone();
      }
    });
  }

  private flattenObjectTree(root: THREE.Object3D): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    root.traverse((x) => out.push(x));
    return out;
  }

  private applyPeerPaletteFromOriginalMeshes(
    origFlat: THREE.Object3D[],
    cloneFlat: THREE.Object3D[],
    pal: ReturnType<typeof getCharacterPreset>['palette'],
  ): void {
    const n = Math.min(origFlat.length, cloneFlat.length);
    for (let i = 0; i < n; i++) {
      const o = origFlat[i];
      const c = cloneFlat[i];
      if (!(o instanceof THREE.Mesh) || !(c instanceof THREE.Mesh)) continue;
      const om = o.material;
      if (Array.isArray(om)) continue;
      const cm = c.material as THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial;
      if (om === this.avatarSkinMat) cm.color.setHex(pal.skin);
      else if (om === this.avatarUndertunicMat) cm.color.setHex(pal.undertunic);
      else if (om === this.avatarJerkinMat) cm.color.setHex(pal.jerkin);
      else if (om === this.avatarTrimMat) cm.color.setHex(pal.trim);
      else if (om === this.avatarPantsMat) cm.color.setHex(pal.pants);
      else if (om === this.avatarBootMat) cm.color.setHex(pal.boot);
      else if (om === this.avatarHairMat) cm.color.setHex(pal.hair);
      else if (om === this.avatarHatBandMat) cm.color.setHex(pal.hatBand);
      else if (om === this.avatarHatTopMat) cm.color.setHex(pal.hatTop);
      else if (om === this.avatarHatBrimMat) cm.color.setHex(pal.hatBrim);
      else if (om === this.forgeWifeLipMat && pal.lipRose !== undefined) cm.color.setHex(pal.lipRose);
      else if (om === this.forgeWifeIrisMat && pal.eyeIris !== undefined) cm.color.setHex(pal.eyeIris);
      else if (om === this.artisanHairPrimaryMat) cm.color.setHex(pal.hair);
      else if (om === this.artisanHairStreakMat && pal.hairStreak !== undefined) {
        cm.color.setHex(pal.hairStreak);
      } else if (om === this.vanguardStaffWoodMat) {
        cm.color.setHex(pal.jerkin);
      } else if (om === this.vanguardStaffGemMat) {
        cm.color.setHex(pal.trim);
      }
    }
  }

  private applyPeerTorsoTopologyFromPreset(
    presetId: CharacterPresetId,
    origFlat: THREE.Object3D[],
    cloneFlat: THREE.Object3D[],
  ): void {
    const def = getCharacterPreset(presetId);
    const build: CharacterBuildKind = def.characterBuild ?? 'default';
    const at = (ref: THREE.Object3D): THREE.Object3D | null => {
      const ix = origFlat.indexOf(ref);
      return ix >= 0 ? cloneFlat[ix]! : null;
    };

    const torsoC = at(this.torso);
    if (torsoC) torsoC.scale.set(def.torsoScale.x, def.torsoScale.y, def.torsoScale.z);
    const headC = at(this.headRoot);
    if (headC) headC.scale.setScalar(def.headScale);
    const hatC = at(this.hatGroup);
    if (hatC) hatC.visible = def.headwear === 'frontier_hat';
    const bandanaC = at(this.smithBandanaGroup);
    if (bandanaC) bandanaC.visible = false;

    if (build === 'artisan_female') {
      const dh0 = at(this.lpcaDefaultHair);
      if (dh0) dh0.visible = false;
      const ah0 = at(this.lpcaArtisanHair);
      if (ah0) ah0.visible = true;
      const gl0 = at(this.glassesGroup);
      if (gl0) gl0.visible = false;
      for (const o of this.maleDockFaceList) {
        const x = at(o);
        if (x) x.visible = false;
      }
      const fwh = at(this.forgeWifeHeadRoot);
      if (fwh) fwh.visible = true;
      const tu = at(this.trunkUnderMesh);
      if (tu) tu.visible = false;
      const tj = at(this.trunkJerkinMesh);
      if (tj) tj.visible = false;
      const fwt = at(this.forgeWifeTorsoRoot);
      if (fwt) fwt.visible = true;
      const fwo = at(this.forgeWifeOverlayRoot);
      if (fwo) fwo.visible = true;
      const vwR = at(this.vanguardWizardRobeRoot);
      if (vwR) vwR.visible = false;
      const vwB = at(this.vanguardWizardBeardRoot);
      if (vwB) vwB.visible = false;
      const vwH = at(this.vanguardWizardHatRoot);
      if (vwH) vwH.visible = false;
      const vwS = at(this.vanguardWizardStaffRoot);
      if (vwS) vwS.visible = false;
      const jaw = at(this.lpcaJaw);
      if (jaw) jaw.scale.copy(this.faceNeutral.jaw);
      const chin = at(this.lpcaChin);
      if (chin) chin.scale.copy(this.faceNeutral.chin);
      const chL = at(this.lpcaCheekL);
      if (chL) chL.scale.copy(this.faceNeutral.cheek);
      const chR = at(this.lpcaCheekR);
      if (chR) chR.scale.copy(this.faceNeutral.cheek);
      const cr = at(this.lpcaCranium);
      if (cr) cr.scale.copy(this.faceNeutral.cranium);
      const shL = at(this.lpcaShPadL);
      if (shL) {
        shL.scale.set(
          this.faceNeutral.shPad.x * 0.76,
          this.faceNeutral.shPad.y * 0.92,
          this.faceNeutral.shPad.z * 0.78,
        );
      }
      const shR = at(this.lpcaShPadR);
      if (shR && shL) shR.scale.copy(shL.scale);
      const neck = at(this.lpcaNeck);
      if (neck) neck.scale.set(0.9, 0.97, 0.9);
    } else if (build === 'vanguard_wizard') {
      const dh0 = at(this.lpcaDefaultHair);
      if (dh0) dh0.visible = false;
      const ah0 = at(this.lpcaArtisanHair);
      if (ah0) ah0.visible = false;
      const gl0 = at(this.glassesGroup);
      if (gl0) gl0.visible = true;
      for (const o of this.maleDockFaceList) {
        const x = at(o);
        if (x) x.visible = true;
      }
      const fwh = at(this.forgeWifeHeadRoot);
      if (fwh) fwh.visible = false;
      const tu = at(this.trunkUnderMesh);
      if (tu) tu.visible = true;
      const tj = at(this.trunkJerkinMesh);
      if (tj) tj.visible = true;
      const fwt = at(this.forgeWifeTorsoRoot);
      if (fwt) fwt.visible = false;
      const fwo = at(this.forgeWifeOverlayRoot);
      if (fwo) fwo.visible = false;
      const hatP = at(this.hatGroup);
      if (hatP) hatP.visible = false;
      const vwR = at(this.vanguardWizardRobeRoot);
      if (vwR) vwR.visible = true;
      const vwB = at(this.vanguardWizardBeardRoot);
      if (vwB) vwB.visible = true;
      const vwH = at(this.vanguardWizardHatRoot);
      if (vwH) vwH.visible = true;
      const vwS = at(this.vanguardWizardStaffRoot);
      if (vwS) vwS.visible = true;
      const jaw = at(this.lpcaJaw);
      if (jaw) jaw.scale.copy(this.faceNeutral.jaw);
      const chin = at(this.lpcaChin);
      if (chin) chin.scale.copy(this.faceNeutral.chin);
      const chL = at(this.lpcaCheekL);
      if (chL) chL.scale.copy(this.faceNeutral.cheek);
      const chR = at(this.lpcaCheekR);
      if (chR) chR.scale.copy(this.faceNeutral.cheek);
      const cr = at(this.lpcaCranium);
      if (cr) cr.scale.copy(this.faceNeutral.cranium);
      const shL = at(this.lpcaShPadL);
      if (shL) shL.scale.copy(this.faceNeutral.shPad);
      const shR = at(this.lpcaShPadR);
      if (shR) shR.scale.copy(this.faceNeutral.shPad);
      const neck = at(this.lpcaNeck);
      if (neck) neck.scale.set(1, 1, 1);
    } else {
      const dh1 = at(this.lpcaDefaultHair);
      if (dh1) dh1.visible = true;
      const ah1 = at(this.lpcaArtisanHair);
      if (ah1) ah1.visible = false;
      const gl1 = at(this.glassesGroup);
      if (gl1) gl1.visible = true;
      for (const o of this.maleDockFaceList) {
        const x = at(o);
        if (x) x.visible = true;
      }
      const fwh2 = at(this.forgeWifeHeadRoot);
      if (fwh2) fwh2.visible = false;
      const tu2 = at(this.trunkUnderMesh);
      if (tu2) tu2.visible = true;
      const tj2 = at(this.trunkJerkinMesh);
      if (tj2) tj2.visible = true;
      const fwt2 = at(this.forgeWifeTorsoRoot);
      if (fwt2) fwt2.visible = false;
      const fwo2 = at(this.forgeWifeOverlayRoot);
      if (fwo2) fwo2.visible = false;
      const vwR2 = at(this.vanguardWizardRobeRoot);
      if (vwR2) vwR2.visible = false;
      const vwB2 = at(this.vanguardWizardBeardRoot);
      if (vwB2) vwB2.visible = false;
      const vwH2 = at(this.vanguardWizardHatRoot);
      if (vwH2) vwH2.visible = false;
      const vwS2 = at(this.vanguardWizardStaffRoot);
      if (vwS2) vwS2.visible = false;
      const jaw = at(this.lpcaJaw);
      if (jaw) jaw.scale.copy(this.faceNeutral.jaw);
      const chin = at(this.lpcaChin);
      if (chin) chin.scale.copy(this.faceNeutral.chin);
      const chL = at(this.lpcaCheekL);
      if (chL) chL.scale.copy(this.faceNeutral.cheek);
      const chR = at(this.lpcaCheekR);
      if (chR) chR.scale.copy(this.faceNeutral.cheek);
      const cr = at(this.lpcaCranium);
      if (cr) cr.scale.copy(this.faceNeutral.cranium);
      const shL = at(this.lpcaShPadL);
      if (shL) shL.scale.copy(this.faceNeutral.shPad);
      const shR = at(this.lpcaShPadR);
      if (shR) shR.scale.copy(this.faceNeutral.shPad);
      const neck = at(this.lpcaNeck);
      if (neck) neck.scale.set(1, 1, 1);
    }

    const hideRefs: THREE.Object3D[] = [
      this.prop,
      this.heldInRightHand,
      this.pickOnBelt,
      this.pickLeftHand,
      this.shieldMount,
      this.minePickRight,
      this.logMesh,
      this.propAxeGroup,
    ];
    for (const r of hideRefs) {
      const ix = origFlat.indexOf(r);
      if (ix >= 0) cloneFlat[ix]!.visible = false;
    }
  }

  /** Full dock survivor (torso subtree) for hunter peer / PvP rival — matches local LPCA preset pipeline. */
  private buildFullTorsoPeerFigure(presetId: CharacterPresetId): THREE.Group {
    const def = getCharacterPreset(presetId);
    const body = this.torso.clone(true) as THREE.Group;
    this.deepCloneMeshMaterials(body);
    const origFlat = this.flattenObjectTree(this.torso);
    const cloneFlat = this.flattenObjectTree(body);
    if (origFlat.length !== cloneFlat.length) {
      console.warn('CharacterScenePreview: torso clone DFS mismatch', origFlat.length, cloneFlat.length);
    }
    this.applyPeerPaletteFromOriginalMeshes(origFlat, cloneFlat, def.palette);
    this.applyPeerTorsoTopologyFromPreset(presetId, origFlat, cloneFlat);
    const wrap = new THREE.Group();
    wrap.add(body);
    wrap.scale.setScalar(def.avatarScale);
    wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap);
    if (!box.isEmpty()) wrap.position.y -= box.min.y;
    wrap.userData.peerGroundY = wrap.position.y;
    return wrap;
  }

  private disposeHunterPeerFigure(): void {
    this.hunterPeerSmoothReady = false;
    if (!this.hunterPeerFig) {
      this.hunterPeerFigKey = '';
      return;
    }
    this.peerDuoRoot.remove(this.hunterPeerFig);
    this.hunterPeerFig.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
    this.hunterPeerFig = null;
    this.hunterPeerFigKey = '';
  }

  /**
   * Exponential smoothing toward last presence target (same shared XZ frame on all clients:
   * room host -X, guest +X). Hides network quantisation / jitter when watching the other gather.
   */
  private smoothHunterPeerFigure(dt: number): void {
    if (!this.hunterPeerFig || !this.peerDuoRoot.visible || !this.hunterSharedWorldActive) return;
    const fig = this.hunterPeerFig;
    const peerY = (fig.userData.peerGroundY as number | undefined) ?? 0;
    const tx = this.hunterPeerTargetX;
    const tz = this.hunterPeerTargetZ;
    const fx = this.hunterPeerFaceTx;
    const fz = this.hunterPeerFaceTz;

    if (!this.hunterPeerSmoothReady) {
      fig.position.set(tx, peerY, tz);
      fig.rotation.y = gatherFaceY(tx, tz, fx, fz);
      this.hunterPeerSmoothReady = true;
      return;
    }

    const dx = tx - fig.position.x;
    const dz = tz - fig.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > CharacterScenePreview.HUNTER_PEER_SNAP_DIST) {
      fig.position.set(tx, peerY, tz);
      fig.rotation.y = gatherFaceY(tx, tz, fx, fz);
      return;
    }

    const k = CharacterScenePreview.HUNTER_PEER_SMOOTH_PER_SEC;
    const a = 1 - Math.exp(-k * dt);
    const nx = THREE.MathUtils.lerp(fig.position.x, tx, a);
    const nz = THREE.MathUtils.lerp(fig.position.z, tz, a);
    fig.position.set(nx, peerY, nz);
    const targetRy = gatherFaceY(nx, nz, fx, fz);
    fig.rotation.y = lerpYaw(fig.rotation.y, targetRy, Math.min(1, a * 1.15));
  }

  syncEquipment(eq: EquipmentState): void {
    /* === 2026-04-22 idempotency early-return (with first-call sentinel) ===
     *
     * Pre-applied during the title flow via `bindGameStoreToDockPreview`
     * (in `engine/dockPreload.ts`), so by the time mountApp's enter-game
     * call lands here, the active equipment already matches. Skipping the
     * 4× `disposeGroupContents` + 1-3× LPCA weapon-mesh build saves
     * ~10-100 ms off the click → game critical path on the warm path —
     * the single biggest item that used to live there.
     *
     * `equipmentApplied` MUST gate the early-return because all three
     * equipped fields default to `null`. A fresh save with all-null
     * equipment matches the defaults, and without the flag the function
     * would skip its body — INCLUDING the trailing
     * `updateVanguardWizardAttachmentVisibility()` call — on the very
     * first call. The signature compare itself is `===` on item IDs
     * (interned string literals from the equipment-id unions, plus null);
     * no deep compare needed once the first call has run. */
    if (
      this.equipmentApplied &&
      this.equippedWeapon === eq.weapon &&
      this.equippedPick === eq.pick &&
      this.equippedShield === eq.shield
    ) {
      return;
    }
    this.equipmentApplied = true;
    this.equippedWeapon = eq.weapon;
    this.equippedPick = eq.pick;
    this.equippedShield = eq.shield;
    this.showPickOnBelt = false;
    this.showPickInLeftHand = false;

    disposeGroupContents(this.heldInRightHand);
    disposeGroupContents(this.pickOnBelt);
    disposeGroupContents(this.pickLeftHand);
    disposeGroupContents(this.shieldMount);

    const w = eq.weapon;
    const p = eq.pick;
    const hasWeapon = !!(w && (isAxeWeaponId(w) || isSwordWeaponId(w)));

    if (w && isAxeWeaponId(w)) {
      const ax = buildAxeMesh(w);
      ax.scale.setScalar(0.88);
      ax.position.set(0.02, -0.1, 0.05);
      ax.rotation.set(0.45, 0.15, 0.5);
      this.heldInRightHand.add(ax);
    } else if (w && isSwordWeaponId(w)) {
      const sw = buildSwordMesh(w);
      sw.scale.setScalar(0.85);
      /* Grip at palm — blade runs +Y in mesh space (upright / ready guard). */
      sw.position.set(0.02, -0.1, 0.045);
      sw.rotation.set(0.1, -0.06, 0.05);
      this.heldInRightHand.add(sw);
    }

    if (p) {
      if (hasWeapon && eq.shield) {
        const pk = buildPickMesh(p);
        pk.scale.setScalar(0.7);
        pk.position.set(0.04, -0.02, -0.02);
        pk.rotation.set(0.55, 0.35, 0.25);
        this.pickOnBelt.add(pk);
        this.showPickOnBelt = true;
      } else if (hasWeapon && !eq.shield) {
        const pk = buildPickMesh(p);
        pk.scale.setScalar(0.78);
        /* Left palm — origin = haft bottom */
        pk.position.set(-0.02, -0.045, 0.05);
        pk.rotation.set(0.42, -0.2, -0.38);
        this.pickLeftHand.add(pk);
        this.showPickInLeftHand = true;
      } else {
        const pk = buildPickMesh(p);
        pk.scale.setScalar(0.82);
        pk.position.set(0.02, -0.045, 0.055);
        pk.rotation.set(0.35, 0.1, 0.4);
        this.heldInRightHand.add(pk);
      }
    }

    if (eq.shield === 'wooden_shield') {
      const sh = buildShieldMesh('wooden_shield');
      sh.scale.setScalar(0.95);
      this.shieldMount.add(sh);
    }
    this.updateVanguardWizardAttachmentVisibility();
  }

  setPageContext(p: AppPageContext): void {
    const prev = this.pageContext;
    this.pageContext = p;
    if (prev === 'craft' && p !== 'craft') {
      this.pendingDockCraft = null;
      this.craftReturnToHub = false;
    }
    if (p !== 'portal') this.portalExitPending = false;
    if (p === 'portal' && prev !== 'portal' && !this.playing) {
      this.startClip('portal_enter');
    }
  }

  /** Milliseconds until the preview clip for this gather action ends — use to grant loot after the animation. */
  getGatherClipDurationMs(actionId: string): number {
    return getDockGatherClipDurationMs(actionId, this.clipSpeedMultiplier, this.gatherClipDurationByKind);
  }

  /** 0-1 while a travel gather clip is playing — drives live peer position in Hunter 1v1. */
  getGatherClipProgress01(): number | null {
    if (!this.playing || this.clip === 'idle') return null;
    if (!TRAVEL_GATHER_CLIPS.has(this.clip)) return null;
    const dur = CLIP_DURATION[this.clip];
    return Math.max(0, Math.min(1, this.clipTime / dur));
  }

  /**
   * Delay before gather world SFX should play — when travel-to-node finishes and the work phase begins
   * ({@link applyTravelGather} reaches TR_WALK1 on the eased timeline), not when loot is granted at clip end.
   */
  getGatherSfxDelayMs(actionId: string): number {
    return getDockGatherSfxDelayMs(actionId, this.clipSpeedMultiplier, this.gatherClipDurationByKind);
  }

  /**
   * Values above 1 speed up preview clips; {@link getGatherClipDurationMs} matches so rewards stay synced.
   */
  setClipSpeedMultiplier(m: number): void {
    this.clipSpeedMultiplier = Math.max(0.25, Math.min(4, m));
  }

  playGatherAction(actionId: string, harvestSlot = 0): void {
    const next = actionIdToClip(actionId);
    if (next === 'idle') return;
    this.activeHarvestSlotIndex = harvestSlot;
    this.applyActiveGatherPropPositions(actionId, harvestSlot);
    if (next === 'mine') {
      this.applyRockGatherVisuals(actionId);
    }
    this.startClip(next);
  }

  /**
   * Awakened-mode harvest animation — same body / hand-prop choreography as
   * `playGatherAction` (axe swing, bucket dip, pickaxe arc, etc.) but pinned to the
   * avatar's current XZ. The deck-mode "walk to resource → work → walk back" travel
   * collapses to no-op because we set both the travel home AND the harvest target to
   * current. The work phase still plays so the player visibly sees the bucket lift /
   * axe swing / etc. at their current spot. `inPlaceHarvestActive` is auto-cleared in
   * the loop when the clip ends.
   */
  playGatherActionInPlace(actionId: string, onComplete?: () => void): void {
    const next = actionIdToClip(actionId);
    if (next === 'idle') {
      /* Defensive: fire the callback immediately if the clip can't actually play, so
       * callers don't end up with a corpse that never despawns. */
      if (onComplete) onComplete();
      return;
    }
    /* Snap travel home to wherever the avatar currently stands so the clip's walk-home
     * lerp is also a no-op. (`harvestXZ` returns current XZ via the override below so
     * the walk-to-target side is also collapsed.) */
    this.travelHomeX = this.avatar.position.x;
    this.travelHomeZ = this.avatar.position.z;
    this.inPlaceHarvestActive = true;
    /* Replace any pending callback from a previous (still-running) in-place clip. The
     * old side-effects are dropped — preferable to firing them mid-clip on the wrong
     * target. */
    this.inPlaceCompleteCb = onComplete ?? null;
    /* World props (apple tree, bush, fiber bundle, stone pile) are a deck-mode
     * affordance — they spawn at the harvest slot to give the player something to
     * "walk to". In awakened mode the player is harvesting REAL world objects (the
     * scattered nodes from `freeRoamHarvestNodes` or the existing crystal scatter), so
     * we skip the prop spawn — `applyActiveGatherPropPositions` would otherwise drop a
     * second tree right at the player's feet. Hand props (bucket, axe, log) still
     * appear because they're attached to the rig's hand, not to the harvest slot. */
    this.activeHarvestSlotIndex = 0;
    if (next === 'mine') {
      this.applyRockGatherVisuals(actionId);
    }
    this.startClip(next);
  }

  /** River bank center (matches hydrology); pass into {@link GameStore.reserveHarvestSlot}. */
  getGatherWaterBankXZ(): { x: number; z: number } {
    return { x: this.gatherWaterXZ.x, z: this.gatherWaterXZ.z };
  }

  getAvatarGroundXZ(): { x: number; z: number } {
    return { x: this.avatar.position.x, z: this.avatar.position.z };
  }

  /**
   * World-space pose for co-op presence while in awakened free-roam (sent to peers).
   */
  getAwakenPresencePose(): { x: number; y: number; z: number; yaw: number } | null {
    if (!this.awakenedFreeRoam) return null;
    return {
      x: this.avatar.position.x,
      y: this.avatar.position.y,
      z: this.avatar.position.z,
      yaw: this.avatar.rotation.y,
    };
  }

  /**
   * Live handles for the free-roam controls module (`src/world/freeRoamControls.ts`,
   * Phase C). Exposes the canvas + avatar group + terrain sampler + map radius so the
   * controls can attach event listeners and integrate WASD movement without us needing
   * to push a parallel API surface up to `mountApp`.
   */
  getFreeRoamHandles(): {
    canvas: HTMLCanvasElement;
    avatar: THREE.Group;
    getTerrainHeight: (x: number, z: number) => number;
    mapRadius: number;
    /** XZ of the existing visible crystals on the map; harvest module reuses these. */
    crystalSpotsXZ: { x: number; z: number }[];
    /**
     * Per-cluster Group references for the same crystal scatter, aligned with
     * `crystalSpotsXZ` order. Harvest module shrinks/hides these on full break.
     */
    crystalClusters: { x: number; z: number; group: THREE.Group }[];
    /**
     * Returns true if the given XZ position is on water (uses dockEnvironment's existing
     * `isWaterAt` which checks against the resolved creek polylines + bank widths).
     * Free-roam mode uses this for "stand near the river, press E to fill bucket".
     */
    isWaterAt: (x: number, z: number) => boolean;
    /**
     * Universal-collision static obstacles captured during the forest scatter (see
     * `forestEnvironment.ts` `ForestStaticObstacle`). Consumed by `mountApp.ts` to
     * bulk-register each one as a collision footprint on awakened-mode entry so the
     * player + mobs can't walk through visual trees / shrubs / berry bushes.
     */
    forestStaticObstacles: import('./forestEnvironment').ForestStaticObstacle[];
    /** Resolved creek polylines — used by spawn-rejection in awakened systems
     * (e.g. bouncy-mushroom scatter rejects candidates within ~2 m of a creek). */
    resolvedCreeks: import('../world/idleCraftHeightfield').ResolvedCreek[];
    /** Dock home XZ — same `dockHomeX/Z` the avatar spawns at. */
    dockXZ: { x: number; z: number };
  } {
    return {
      canvas: this.renderer.domElement,
      avatar: this.avatar,
      /* `getTerrainHeight` is populated by `_phaseForest()`; if a caller hits this before
       * forest finished building, return 0 so the avatar rests at sea level rather than
       * NaN-falling through the world. */
      getTerrainHeight: this.getTerrainHeight ?? (() => 0),
      mapRadius: this.mapRadius,
      crystalSpotsXZ: this.crystalSpotsXZ,
      crystalClusters: this.crystalClusters,
      isWaterAt: this.dockEnvironment
        ? (x, z) => this.dockEnvironment!.isWaterAt(x, z)
        : () => false,
      forestStaticObstacles: this.forestStaticObstacles,
      resolvedCreeks: this.resolvedCreeks,
      dockXZ: { x: this.dockHomeX, z: this.dockHomeZ },
    };
  }

  /**
   * Toggle awakened free-roam mode. When `true`:
   *   - `applyIdle`'s per-frame walk-toward-routeTarget is skipped (no snap-back).
   *   - `applyIdle`'s per-frame rotate-toward-camp-center is skipped (player keeps facing).
   *   - `travelHomeX/Z` is updated to the avatar's current position so the dock's
   *     gather-clip / battle-lunge math reads from where the player actually is.
   *   - On enter, snap the avatar to face away from the camera so the third-person view
   *     starts with the camera behind the player.
   *
   * Reverse (back to `false`) restores the dock auto-routing — the avatar will smoothly
   * walk back to its dock home on the next idle frame.
   */
  /**
   * Tell the dock whether the player is currently airborne (mid-jump). Wired from
   * `mountApp`'s per-frame loop via `freeRoamHandle.isAirborne()`. Skipped in deck mode.
   */
  setFreeRoamAirborne(on: boolean): void {
    this.freeRoamAirborne = on;
  }

  /**
   * Wire the surface-Y provider used by `syncAvatarFeetToTerrain` in awakened
   * mode. The provider returns the surface Y under the player's feet (terrain OR
   * top of a foundation / floor / stair / rock they walked onto), or null when
   * grounded on bare terrain / airborne. Pass `null` to clear (back to terrain-
   * only foot snap, which is what deck mode wants).
   */
  setSurfaceYProvider(provider: (() => number | null) | null): void {
    this.surfaceYProvider = provider;
  }

  /**
   * Awakened-mode camera-lock toggle (Phase 1.5 — see `world/cameraLockController.ts`
   * + `docs/BASE_BUILDING_AND_SURVIVAL_PLAN.md` §12). When `on`, the orbit drag handler
   * + double-click camera-reset short-circuit so the camera lock controller can write
   * yaw/pitch directly via `setCameraYawPitch` without being fought by user input.
   */
  setCameraLockActive(on: boolean): void {
    this.cameraLockActive = on;
    /* Defensive: cancel any in-flight camera drag so the orbit handler doesn't keep
     * applying deltas in the next frame after we've taken over yaw/pitch. */
    if (on) this.cancelCameraDrag();
  }

  /** Read current orbit yaw + pitch — used by the camera lock controller's snapshot path.
   *
   * Returns the TARGET (not the smoothed display value) so successive
   * mouse-look deltas accumulate cleanly: the controller does
   * `setCameraYawPitch(getCameraYawPitch().yaw + delta, ...)` and would
   * otherwise read a partially-lerped value, fighting its own write.
   */
  getCameraYawPitch(): { yaw: number; pitch: number } {
    return { yaw: this.dockCamYawTarget, pitch: this.dockCamPitchTarget };
  }

  /** Direct write of orbit yaw + pitch — used by camera lock controller's mouse-look.
   *
   * **Snaps both target AND displayed values** (bypasses dock-orbit smoothing).
   * The camera-lock controller is the awakened-mode mouse-look path; the player
   * expects 1:1 mouse input → yaw with no perceptible lag (any lag reads as
   * "broken/sticky aim"). Snapping here also prevents a feedback loop where
   * the smoothing pass would lerp `dockCamYaw` back toward an unchanged
   * `dockCamYawTarget` while the controller keeps writing fresh values from
   * `getCameraYawPitch()` — symptom: character appears stuck facing forward
   * because every frame's delta is immediately pulled back by smoothing.
   */
  setCameraYawPitch(yaw: number, pitch: number): void {
    this.dockCamYaw = yaw;
    this.dockCamYawTarget = yaw;
    this.dockCamPitch = pitch;
    this.dockCamPitchTarget = pitch;
  }

  /**
   * World position of the staff/wand tip — used as the magic projectile spawn origin
   * (Phase 1.5 — see `world/magicProjectiles.ts`).
   *
   * **2026-04 fix.** The previous implementation just took `handR.getWorldPosition()`
   * and added a flat `+0.4 m` upward offset. That spawned the orb at the avatar's
   * WRIST, not at the glowing finial — visibly wrong (the bolt left from the hand,
   * not the staff tip), and the wrong origin Y also tilted the bolt's flight vector
   * downward enough to read as "magic landing below where I'm aiming" at long range.
   *
   * The Vanguard's wizard staff (`vanguardWizardLPCA.ts`) is parented to `handR`
   * with `position(0.02, -0.12, 0.045)` and the magical-tip orb sits at staff-local
   * Y ≈ 1.103 (`crownBaseY 1.018 + 0.085`). So the actual tip's world position is
   * `staffRoot.localToWorld(0, 1.103, 0)` — which correctly accounts for the staff's
   * tilt + the avatar's hand orientation per frame.
   *
   * Falls back to the legacy hand+offset path when the wizard staff root isn't
   * available (e.g., during boot before the rig finishes assembling, or in any
   * future avatar variant that doesn't carry the vanguard staff). The fallback
   * still produces a sane "near the hand" origin so cast attempts don't NaN.
   */
  getStaffTipWorldPosition(): { x: number; y: number; z: number } {
    const v = new THREE.Vector3();
    if (this.vanguardWizardStaffRoot) {
      /* Staff-local tip position. Magic number matches the orb-center Y in
       * `vanguardWizardLPCA.ts` — see the `orbCenterY = crownBaseY + 0.085`
       * computation that places the magical-tip layers (`vw_staff_tip_body`
       * / `vw_staff_tip_glim` / `vw_staff_tip_halo`) at the finial. The
       * world transform of the staff root accounts for handR's per-frame
       * pose (idle sway, cast clip arm raise, sprint arm swing), so the
       * spawn origin tracks the visible glow even during animation. */
      v.set(0, 1.103, 0);
      this.vanguardWizardStaffRoot.localToWorld(v);
      return { x: v.x, y: v.y, z: v.z };
    }
    this.handR.getWorldPosition(v);
    v.y += 0.4;
    return { x: v.x, y: v.y, z: v.z };
  }

  /**
   * Awakened-mode in-place combat clip dispatcher (Phase 1.5). Plays `battle_strike`
   * (melee swing) or `battle_cast` (magic) at the avatar's current XZ without the
   * usual teleport-to-target. Re-uses the existing `inPlaceHarvestActive` machinery
   * generalized as `inPlaceCombatActive`.
   */
  playInPlaceCombatClip(kind: 'cast' | 'strike'): void {
    /* The clip-dispatcher consumes `inPlaceHarvestActive` to skip walk-to-target +
     * teleport-back. We reuse the same flag for combat — it gates the same code paths
     * either way (the avatar plays the work animation in place). */
    this.inPlaceHarvestActive = true;
    this.startClip(kind === 'cast' ? 'battle_cast' : 'battle_strike');
  }

  /**
   * Force-release the dock's camera-drag state. Call from `mountApp` whenever an overlay
   * (Tab menu, system menu) opens, so a drag-in-flight can't persist past the overlay
   * mount and continue applying yaw/pitch/pan deltas after the player releases the mouse
   * over the overlay (whose mouseup never reaches the canvas's pointerup handler).
   */
  cancelCameraDrag(): void {
    if (!this.dockCamDragging) return;
    /* Clearing dragging + dragKind makes `onDockPointerMove` early-return on any further
     * pointermove events — even if the underlying pointer-capture is stuck (mouseup went
     * to an overlay so the canvas's pointerup never fired), no yaw/pitch/pan deltas will
     * be applied. The cursor reset keeps the canvas's grabbing cursor from persisting. */
    this.dockCamDragging = false;
    this.dockCamDragKind = null;
    this.renderer.domElement.style.cursor = '';
  }

  setAwakenedFreeRoam(on: boolean): void {
    if (this.awakenedFreeRoam === on) return;
    this.awakenedFreeRoam = on;
    /* Clear any dream-mode blood VFX still in flight when flipping into
     * awakened so it doesn't linger as a stuck splatter at the (now wrong)
     * dream-enemy slot position. The blood system is dream-only per the
     * gate at the top of `updateBattleBlood`. */
    if (on) {
      this.bloodLifeRemaining = 0;
      this.bloodPeakSnapshot = 0;
      this.bloodFadePreset = 'default';
      this.clearBattleBloodVisuals();
    }
    /* Realm-flip warm (Phase 8j preload optimization). Flipping into awakened
     * triggers a post-stack rebuild via `setAwakenedRenderBudget` below,
     * which can JIT-compile new program variants (night-grade pass with
     * different enabled flag, bloom rebuilt at the awakened tier, etc.).
     * Without an explicit warm at flip time, the first cast / first mob
     * hit / first damage floater after entering awakened pays the compile
     * cost mid-gameplay — visible as a 100-400ms hitch on the player's
     * first attack.
     *
     * Schedule the warm AFTER setAwakenedRenderBudget so the new post-stack
     * is in place. Wrapped in rAF so the visible "Awakening..." transition
     * (handled by mountApp) gets at least one paint frame to show before
     * the warm starts blocking the main thread. */
    requestAnimationFrame(() => {
      try {
        this.finalWarmCompileAndRender();
      } catch {
        /* compile/render is best-effort during transitions. */
      }
    });
    /* Awakened mode goes from a small embedded preview canvas to FULLSCREEN — pixel
     * fillrate jumps 20-40× and the GPU becomes fragment-bound. Apply the awakened render
     * budget (DPR cap to 1.0, drop bloom + SSAO) so fullscreen runs at 100+ fps instead
     * of 30-40 fps on integrated/laptop GPUs. The Phase 8h lighting passes (PMREM IBL,
     * camera fill, half-Lambert, night grade, god-rays, eye-adapt) all keep running and
     * are visually identical between dream and awakened — the budget only trims the
     * legacy heavy passes. Power users on beefy desktop GPUs opt out via
     * `idleCraft.awakenedFullQuality = '1'`. */
    this.setAwakenedRenderBudget(on);
    if (!on) {
      this.freeRoamAirborne = false;
      /* Restore default Three.js Euler order so deck-mode rotations behave as before. */
      this.avatar.rotation.order = 'XYZ';
      this.avatar.rotation.x = 0;
    }
    if (on) {
      /* Lock travel-home to wherever the avatar currently stands so subsequent dock
       * routing math doesn't try to pull it back to the original spawn coordinate. */
      this.travelHomeX = this.avatar.position.x;
      this.travelHomeZ = this.avatar.position.z;
      /* Reset camera deltas to default so we start with the canonical dock framing
       * (south-east of avatar) and put the avatar facing AWAY from that direction
       * (camera ends up behind the avatar). Targets reset together so the
       * smoothing pass doesn't lerp back from a prior orbit. */
      this.dockCamYaw = 0;
      this.dockCamYawTarget = 0;
      this.dockCamPitch = 0;
      this.dockCamPitchTarget = 0;
      this.dockCamPan.set(0, 0, 0);
      this.dockCamPanTarget.set(0, 0, 0);
      this.userCameraZoom = 1;
      this.userCameraZoomTarget = 1;
      const offX = DOCK_SOLO_CAM_OFFSET_X;
      const offZ = DOCK_SOLO_CAM_OFFSET_Z;
      /* Avatar should face OPPOSITE the camera-from-avatar vector → camera is then behind
       * (looking at the avatar's back). atan2(x, z) is Three.js's yaw convention. */
      this.avatar.rotation.y = Math.atan2(-offX, -offZ);
      this.travelHomeRotY = this.avatar.rotation.y;
      /* Set Euler order to 'YXZ' so the jump-flip's `rotation.x` is interpreted in
       * BODY-LOCAL space (applied AFTER yaw). With the default 'XYZ' order, rotation.x
       * is a world-X rotation, which means a flip at yaw=π would visually be a backflip
       * instead of a forward flip. 'YXZ' guarantees the flip always reads as
       * "head-over-heels forward" regardless of which way the body is facing. */
      this.avatar.rotation.order = 'YXZ';
      this.avatar.rotation.x = 0;
      /* Seed the awakened walk-cycle motion tracker so the first frame's delta is 0,
       * not (avatar.x - 0) which would falsely register as fast motion. */
      this.awakenedLastAvatarX = this.avatar.position.x;
      this.awakenedLastAvatarZ = this.avatar.position.z;
      this.awakenedWalkT = 0;
      this.awakenedLastStepCount = 0;
    }
  }

  /**
   * Camera's forward direction projected onto the XZ ground plane (unit vector).
   * Used by free-roam WASD so pressing W walks toward where the camera is looking,
   * not toward the avatar's local +Z. Returned as `{x, z}` to avoid leaking THREE
   * types up to the controls module.
   */
  getCameraForwardXZ(): { x: number; z: number } {
    const dx = this.framingLookAt.x - this.camera.position.x;
    const dz = this.framingLookAt.z - this.camera.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return { x: 0, z: 1 };
    return { x: dx / len, z: dz / len };
  }

  playCraftHammer(station?: CraftStation, recipeId?: string): void {
    this.craftReturnToHub = false;
    let st = station ?? null;
    /* Torch / field crafts stay at the central craft yard — never treat as campfire approach. */
    if (recipeId === 'r_torch') st = 'hand';
    this.craftHammerStation = st;
    /* Awakened free-roam: ALL crafts happen in place at the avatar's current XZ — no
     * walk-to-camp routing (which is disabled in awakened mode anyway, and would leave
     * the craft stuck waiting forever if we set `pendingDockCraft`). The craft_hammer
     * clip dispatcher already skips its teleport-to-station snap when awakenedFreeRoam
     * is true, so the animation plays in place at the avatar's current pose. */
    const walkFirst = !this.awakenedFreeRoam && (st === 'campfire' || st === 'workbench');
    if (!walkFirst) {
      this.pendingDockCraft = null;
      this.startClip('craft_hammer');
      return;
    }
    const { x: tx, z: tz } =
      st === 'campfire' ? this.craftCampfireStandXZ() : this.craftWorkbenchStandXZ();
    const ax = this.avatar.position.x;
    const az = this.avatar.position.z;
    if (Math.hypot(tx - ax, tz - az) <= CharacterScenePreview.DOCK_ARRIVE_EPS) {
      this.pendingDockCraft = null;
      this.startClip('craft_hammer');
      return;
    }
    this.pendingDockCraft = st;
  }

  private getDockRouteTarget(): { x: number; z: number } {
    if (this.pageContext !== 'craft') {
      return this.gatherRestXZ();
    }
    if (this.pendingDockCraft === 'campfire') {
      return this.craftCampfireStandXZ();
    }
    if (this.pendingDockCraft === 'workbench') {
      return this.craftWorkbenchStandXZ();
    }
    return this.craftCentralStandXZ();
  }

  private getDockFaceWorldXZ(): { x: number; z: number } {
    if (this.pageContext !== 'craft') {
      return this.gatherRestXZ();
    }
    if (this.pendingDockCraft === 'campfire') {
      return this.campfireWorldXZ();
    }
    if (this.pendingDockCraft === 'workbench') {
      return this.workbenchWorldXZ();
    }
    return this.craftCentralPivotXZ();
  }

  private tryConsumePendingDockCraft(): void {
    const st = this.pendingDockCraft;
    if (st !== 'campfire' && st !== 'workbench') return;
    if (this.pageContext !== 'craft' || this.playing || this.clip !== 'idle') return;
    const { x: tx, z: tz } =
      st === 'campfire' ? this.craftCampfireStandXZ() : this.craftWorkbenchStandXZ();
    const d = Math.hypot(this.avatar.position.x - tx, this.avatar.position.z - tz);
    if (d > CharacterScenePreview.DOCK_ARRIVE_EPS) return;
    this.craftHammerStation = st;
    this.startClip('craft_hammer');
  }

  /** Short shoulder roll after equipping gear */
  playEquipAdjust(): void {
    this.startClip('equip_adjust');
  }

  playBattleAction(cardId: string): void {
    const c = cardById.get(cardId);
    const mana = c?.battle?.manaCost ?? 0;
    if (mana > 0) this.startClip('battle_cast');
    else this.startClip('battle_strike');
  }

  /** Enemy turn: lunge toward player, contact, then snap back (paired with battleEndTurn in UI). */
  playBattleEnemyStrike(): void {
    this.startClip('battle_enemy_strike');
  }

  /** Call after a player card resolves with lethal damage — chains death fall + blood after strike/cast. */
  queueBattleEnemyDeathAfterKill(): void {
    this.pendingEnemyDeathAfterStrike = true;
  }

  /**
   * Play once per defeat; permadeath wipe should run on `battle-player-death-done`.
   */
  playBattlePlayerDeath(): void {
    if (this.playerDeathAnimStarted) return;
    this.playerDeathAnimStarted = true;
    this.startClip('battle_player_death');
  }

  /** Reset dock pose after permadeath wipe (new run). */
  resetDockAfterPermadeath(): void {
    setDockTravelGatherClipActive(false);
    setDockCraftVisualBusy(false);
    this.pendingDockCraft = null;
    this.craftReturnToHub = false;
    this.pendingEnemyDeathAfterStrike = false;
    this.battleEnemyCorpseFallen = false;
    this.playerDeathAnimStarted = false;
    /* Next sync(null) must tear down any leftover enemy mesh */
    this.syncedBattleEnemyId = '__reset__';
    this.clip = 'idle';
    this.clipTime = 0;
    this.playing = false;
    this.idlePhase = 0;
    this.avatar.scale.set(1, 1, 1);
    this.avatar.rotation.set(0, 0, 0);
    /* Same home as constructor: battle/gather dock — avoids stale travelHome after death clip */
    this.travelHomeX = this.dockHomeX;
    this.travelHomeZ = this.dockHomeZ;
    this.travelHomeRotY = dockSoloIdleFaceYawRad();
    this.avatar.position.x = this.travelHomeX;
    this.avatar.position.z = this.travelHomeZ;
    this.torso.position.y = this.baseTorsoY;
    this.resetPose();
    this.resetEnemyBattlePose();
    this.applyCharacterPreset(this.activeCharacterPresetId);
    this.enemyRoot.rotation.order = 'XYZ';
    this.enemyRoot.rotation.set(0, 0, 0);
    const r0 = this.getEnemyRestXZ();
    this.enemyRoot.position.set(r0.x, 0, r0.z);
  }

  /** Recompute feet on y=0 after equipment meshes change (call after `renderPage` / `syncEquipment`). */
  relevelAvatarFeetAfterEquipmentSync(): void {
    this.relevelAvatarFeet();
  }

  playHireWave(): void {
    this.startClip('hire_wave');
  }

  playDeckUnlock(): void {
    this.startClip('equip_adjust');
  }

  playEatCookedMeat(): void {
    this.startClip('eat_meat');
  }

  playEatBerriesSnack(): void {
    this.startClip('eat_berries');
  }

  playDrinkWater(): void {
    this.startClip('drink_consume');
  }

  playBandage(): void {
    this.startClip('bandage_apply');
  }

  playStim(): void {
    this.startClip('stim_inject');
  }

  playRepairItem(): void {
    this.startClip('repair_item');
  }

  /** Ore/chunk look for mine clip — PBR presets per resource. */
  private applyRockGatherVisuals(actionId: string): void {
    const m = this.rockOreMat;
    m.emissive.setHex(0x000000);
    m.emissiveIntensity = 0;
    m.iridescence = 0;
    m.sheen = 0;
    m.clearcoat = 0.28;
    m.clearcoatRoughness = 0.42;
    m.envMapIntensity = 1.05;
    switch (actionId) {
      case 'mine_coal': {
        m.color.setHex(0x1c1e24);
        m.metalness = 0.06;
        m.roughness = 0.9;
        m.clearcoat = 0.1;
        m.sheen = 0.45;
        m.sheenRoughness = 0.72;
        m.sheenColor.setHex(0x2a2c32);
        break;
      }
      case 'mine_iron_ore':
      case 'stone': {
        m.color.setHex(0x697480);
        m.metalness = 0.58;
        m.roughness = 0.36;
        m.clearcoat = 0.38;
        break;
      }
      case 'mine_copper_ore': {
        m.color.setHex(0xb87333);
        m.metalness = 0.78;
        m.roughness = 0.3;
        m.clearcoat = 0.48;
        m.emissive.setHex(0x2a1508);
        m.emissiveIntensity = 0.04;
        break;
      }
      case 'mine_tin_ore': {
        m.color.setHex(0xc8ccd6);
        m.metalness = 0.68;
        m.roughness = 0.26;
        m.clearcoat = 0.52;
        break;
      }
      case 'mine_zinc_ore': {
        m.color.setHex(0xa8aca4);
        m.metalness = 0.62;
        m.roughness = 0.34;
        m.clearcoat = 0.32;
        break;
      }
      case 'mine_silver_ore': {
        m.color.setHex(0xd8e2ea);
        m.metalness = 0.9;
        m.roughness = 0.2;
        m.clearcoat = 0.68;
        break;
      }
      case 'mine_gold_ore': {
        m.color.setHex(0xd4af37);
        m.metalness = 0.94;
        m.roughness = 0.18;
        m.clearcoat = 0.58;
        m.emissive.setHex(0x3a2808);
        m.emissiveIntensity = 0.08;
        break;
      }
      case 'mine_platinum_ore': {
        m.color.setHex(0xe8eaef);
        m.metalness = 0.95;
        m.roughness = 0.16;
        m.clearcoat = 0.75;
        m.iridescence = 0.12;
        m.iridescenceIOR = 1.35;
        break;
      }
      default: {
        m.color.setHex(oreAccentForMineAction(actionId));
        m.metalness = 0.48;
        m.roughness = 0.46;
      }
    }
  }

  private startClip(next: Exclude<ClipId, 'idle'>): void {
    this.pendingDockCraft = null;
    if (next !== 'craft_hammer') this.craftHammerStation = null;
    if (next !== 'mine') {
      disposeGroupContents(this.minePickRight);
      this.minePickRight.visible = false;
    }
    this.clip = next;
    this.clipTime = 0;
    this.playing = true;
    this.hideAllProps();
    if (TRAVEL_GATHER_CLIPS.has(next)) {
      setDockTravelGatherClipActive(true);
      this.travelHomeX = this.avatar.position.x;
      this.travelHomeZ = this.avatar.position.z;
      this.travelHomeRotY = this.avatar.rotation.y;
    }
    if (next === 'portal_enter') {
      this.portalExitPending = false;
      this.travelHomeX = this.avatar.position.x;
      this.travelHomeZ = this.avatar.position.z;
      this.travelHomeRotY = this.avatar.rotation.y;
    }
    if (next === 'battle_strike' || next === 'battle_cast') {
      this.travelHomeX = this.avatar.position.x;
      this.travelHomeZ = this.avatar.position.z;
      this.travelHomeRotY = this.avatar.rotation.y;
      this.bloodPeakSnapshot = 0;
      this.bloodLifeRemaining = 0;
    }
    if (next === 'battle_enemy_strike') {
      this.travelHomeX = this.avatar.position.x;
      this.travelHomeZ = this.avatar.position.z;
      this.travelHomeRotY = this.avatar.rotation.y;
      this.enemyStrikeAnchorX = this.enemyRoot.position.x;
      this.enemyStrikeAnchorZ = this.enemyRoot.position.z;
      this.bloodPeakSnapshot = 0;
      this.bloodLifeRemaining = 0;
    }
    if (next === 'battle_enemy_death') {
      this.travelHomeX = this.avatar.position.x;
      this.travelHomeZ = this.avatar.position.z;
      this.travelHomeRotY = this.avatar.rotation.y;
      this.updateBattleBlood(1, 'enemy', this.enemyDeathBloodPreset());
      this.bloodLifeRemaining = Math.max(
        this.bloodLifeRemaining,
        CharacterScenePreview.BLOOD_LINGER_TOTAL * 1.45,
      );
    }
    if (next === 'battle_player_death') {
      this.travelHomeX = this.avatar.position.x;
      this.travelHomeZ = this.avatar.position.z;
      this.travelHomeRotY = this.avatar.rotation.y;
      const preset = this.battleEnemyId === 'e_rat' ? 'player_leg' : 'player_face_spew';
      this.updateBattleBlood(0.94, 'player', preset);
      this.bloodLifeRemaining = Math.max(
        this.bloodLifeRemaining,
        CharacterScenePreview.BLOOD_LINGER_TOTAL * 1.55,
      );
    }
    if (next === 'mine' && this.equippedPick) {
      disposeGroupContents(this.minePickRight);
      const pk = buildPickMesh(this.equippedPick);
      pk.scale.setScalar(0.86);
      /* Origin = haft bottom; aim bit toward rock */
      pk.position.set(0.02, -0.06, 0.07);
      pk.rotation.set(0.52, 0.06, 0.38);
      this.minePickRight.add(pk);
      this.minePickRight.visible = true;
    }
    if (next === 'wood' && this.woodUsesEquippedAxe()) {
      disposeGroupContents(this.propAxeGroup);
      const ax = buildAxeMesh(this.equippedWeapon!);
      ax.scale.setScalar(0.95);
      this.propAxeGroup.add(ax);
    }
    if (next === 'battle_strike') {
      disposeGroupContents(this.propAxeGroup);
      const w = this.equippedWeapon;
      if (w && isSwordWeaponId(w)) {
        const sw = buildSwordMesh(w);
        sw.scale.setScalar(0.92);
        this.propAxeGroup.add(sw);
      } else if (w && isAxeWeaponId(w)) {
        const ax = buildAxeMesh(w);
        ax.scale.setScalar(0.95);
        this.propAxeGroup.add(ax);
      }
    }
  }

  setResourceHover(resourceKey: string): void {
    this.hoverAccent = resourceKeyToAccent(resourceKey);
    this.rim.color.setHex(this.hoverAccent);
    this.rim.intensity = resourceKey.length > 0 ? 0.2 : 0;
  }

  dispose(): void {
    this.disposeAwakenCoopPeerFigs();
    setDockTravelGatherClipActive(false);
    cancelAnimationFrame(this.raf);
    /* `dockWarmDeferTask` / `dockWarmTask` carry CancellablePostTask handles
     * (Round 5 phase F1); `cancelDockWarmHandle` aborts both via the tagged
     * scheduler's signal / rIC fallback / setTimeout fallback as appropriate. */
    this.cancelDockWarmHandle('both');
    if (this.craftDecorHudRaf) {
      cancelAnimationFrame(this.craftDecorHudRaf);
      this.craftDecorHudRaf = 0;
    }
    window.removeEventListener('resize', this.onResize);
    this.containerResizeObs?.disconnect();
    this.containerResizeObs = null;
    setDockCraftVisualBusy(false);
    this.pendingDockCraft = null;
    this.craftReturnToHub = false;
    const canvas = this.renderer.domElement;
    canvas.removeEventListener('wheel', this.onWheelCamera);
    canvas.removeEventListener('pointerdown', this.onDockPointerDown);
    canvas.removeEventListener('pointermove', this.onDockPointerMove);
    canvas.removeEventListener('pointerup', this.onDockPointerUp);
    canvas.removeEventListener('pointercancel', this.onDockPointerUp);
    canvas.removeEventListener('lostpointercapture', this.onDockLostCapture);
    canvas.removeEventListener('contextmenu', this.onDockContextMenu);
    canvas.removeEventListener('dblclick', this.onDockDblClick);
    this.portalPlasma?.dispose();
    this.portalPlasma = null;
    this.scene.remove(this.portalVfx);
    if (this.handTorchLPCA) {
      this.handR.remove(this.handTorchLPCA.group);
      this.handTorchLPCA.dispose();
      this.handTorchLPCA = null;
    }
    this.vanguardStaffOrbVfx.dispose();
    this.craftDecorMeshAwaiting = false;
    this.cancelCraftDecorMeshBuild();
    this.disposeCraftDecorMeshes();
    this.scene.remove(this.craftDecorGroup);
    this.postProcessing?.getComposer().dispose();
    this.postProcessing = null;
    this.nightGradePass = null;
    this.dockEnvironment?.dispose();
    this.dockEnvironment = null;
    for (const d of this.sceneDisposers) d();
    this.sceneDisposers = [];
    this.sceneTickers = [];
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    });
  }

  private hideAllProps(): void {
    if (this.meatMesh.parent !== this.handR) {
      this.handL.remove(this.meatMesh);
      this.handR.add(this.meatMesh);
    }
    this.woodTreeMesh.visible = false;
    this.logMesh.visible = false;
    this.propAxeGroup.visible = false;
    this.bucketMesh.visible = false;
    this.bushMesh.visible = false;
    this.meatMesh.visible = false;
    this.plantMesh.visible = false;
    this.orbMesh.visible = false;
    this.battleSpark.visible = false;
    this.rockMesh.visible = false;
    this.stonePileMesh.visible = false;
    this.fiberBundleMesh.visible = false;
    this.rationMesh.visible = false;
    this.berrySnackMesh.visible = false;
    this.waterskinMesh.visible = false;
    this.bandageMesh.visible = false;
    this.stimMesh.visible = false;
    this.huntPreyGroup.visible = false;
  }

  private hideGearForClip(): void {
    const keepGatherTorch = this.pageContext === 'gather' && this.gatherTorchNightEligible();
    const keepCraftCookTorch =
      this.clip === 'craft_hammer' &&
      this.pageContext === 'craft' &&
      this.craftHammerStation === 'campfire' &&
      this.torchDockNightEligible();
    const consumeClip =
      this.clip === 'eat_meat' || this.clip === 'eat_berries' || this.clip === 'drink_consume';
    const keepTorchWithConsume = consumeClip && this.torchDockNightEligible();
    if (this.handTorchLPCA && !keepGatherTorch && !keepTorchWithConsume && !keepCraftCookTorch) {
      this.handTorchLPCA.group.visible = false;
    }
    if (keepTorchWithConsume || keepCraftCookTorch) {
      this.resetTorchToRightHandGrip();
      this.handTorchLPCA!.group.visible = true;
    }
    this.shieldMount.visible = false;
    this.pickOnBelt.visible = false;
    this.pickLeftHand.visible = false;
    this.heldInRightHand.visible = false;
    this.minePickRight.visible = false;
    this.updateVanguardWizardAttachmentVisibility();
  }

  /**
   * Idle carry: Inventory = full loadout. Battle = combat only (weapon + shield, no picks/tools).
   * Gather and other tabs = empty hands at idle until a gather clip shows the right tool.
   */
  private showIdleGear(): void {
    const ctx = this.pageContext;
    if (ctx === 'inventory') {
      this.shieldMount.visible = true;
      this.pickOnBelt.visible = this.showPickOnBelt;
      this.pickLeftHand.visible = this.showPickInLeftHand;
      this.heldInRightHand.visible = true;
      this.minePickRight.visible = false;
    } else if (ctx === 'battle') {
      const hasMeleeWeapon = !!(
        this.equippedWeapon &&
        (isAxeWeaponId(this.equippedWeapon) || isSwordWeaponId(this.equippedWeapon))
      );
      this.shieldMount.visible = this.equippedShield === 'wooden_shield';
      this.pickOnBelt.visible = false;
      this.pickLeftHand.visible = false;
      this.heldInRightHand.visible = hasMeleeWeapon;
      this.minePickRight.visible = false;
    } else {
      this.shieldMount.visible = false;
      this.pickOnBelt.visible = false;
      this.pickLeftHand.visible = false;
      this.heldInRightHand.visible = false;
      this.minePickRight.visible = false;
    }
    this.applyTorchCarryOverride();
    this.updateVanguardWizardAttachmentVisibility();
  }

  /**
   * Torch "night" band with hysteresis (on above 0.40, off below 0.34) to reduce dusk transition hitches.
   */
  private torchNightBandForCarry(): boolean {
    const dayMix = this.dockEnvironment?.getOutdoorDayMix() ?? 1;
    const nightW = 1 - dayMix;
    const onAbove = 0.4;
    const offBelow = 0.34;
    if (this.torchNightCarryHysteresis) {
      if (nightW < offBelow) this.torchNightCarryHysteresis = false;
    } else {
      if (nightW > onAbove) this.torchNightCarryHysteresis = true;
    }
    return this.torchNightCarryHysteresis;
  }

  private torchNightEnvironmentReady(): boolean {
    if (!this.hasTorchInventory) return false;
    if (!this.torchNightBandForCarry()) return false;
    if (this.previewCompletedRenders < 3) return false;
    return true;
  }

  private torchPlayerWantsLit(): boolean {
    return this.torchNightEnvironmentReady() && this.torchEquipped;
  }

  /** Night + torch in bag + player wants it out — idle carry on dock pages (not battle). */
  private applyTorchCarryOverride(): void {
    if (!this.handTorchLPCA) return;
    const ctx = this.pageContext;
    if (ctx === 'battle' || ctx === 'portal') {
      this.handTorchLPCA.group.visible = false;
      this.resetTorchToRightHandGrip();
      return;
    }
    const nightEligible =
      this.torchPlayerWantsLit() &&
      (!this.dockHeavyVisualStaggerActive() || this.handTorchLPCA.group.visible);
    const eligible = nightEligible;
    this.handTorchLPCA.group.visible = eligible;
    if (eligible) {
      this.resetTorchToRightHandGrip();
      this.heldInRightHand.visible = false;
      this.pickOnBelt.visible = false;
      this.pickLeftHand.visible = false;
      this.minePickRight.visible = false;
    } else {
      this.resetTorchToRightHandGrip();
    }
  }

  private gatherTorchNightEligible(): boolean {
    if (this.pageContext !== 'gather' || !this.handTorchLPCA) return false;
    if (!this.torchPlayerWantsLit()) return false;
    if (this.dockHeavyVisualStaggerActive()) return this.handTorchLPCA.group.visible;
    return true;
  }

  /**
   * Lit torch for dock clips (campfire hammer, eating at night) — uses night band only,
   * not {@link torchEquipped}, so cooking/eating can still read clearly when unequipped.
   */
  private torchDockNightEligible(): boolean {
    if (!this.handTorchLPCA) return false;
    if (this.pageContext === 'battle' || this.pageContext === 'portal') return false;
    if (!this.torchNightEnvironmentReady()) return false;
    if (this.dockHeavyVisualStaggerActive()) return this.handTorchLPCA.group.visible;
    return true;
  }

  /** Bucket / pick / log / axe use right hand during gather — torch moves to left. */
  private gatherTorchClipUsesLeftHand(): boolean {
    return (
      this.clip === 'wood' ||
      this.clip === 'water' ||
      this.clip === 'mine' ||
      this.clip === 'hunt'
    );
  }

  private resetTorchToRightHandGrip(): void {
    if (!this.handTorchLPCA) return;
    const g = this.handTorchLPCA.group;
    if (g.parent !== this.handR) {
      this.handL.remove(g);
      this.handR.add(g);
      g.position.set(0.02, -0.085, 0.055);
      g.rotation.set(0.48, 0.1, 0.2);
    }
  }

  private syncGatherTorchHandParent(): void {
    if (!this.handTorchLPCA) return;
    const g = this.handTorchLPCA.group;
    if (this.gatherTorchClipUsesLeftHand()) {
      if (g.parent !== this.handL) {
        this.handR.remove(g);
        this.handL.add(g);
        g.position.set(-0.02, -0.085, 0.055);
        g.rotation.set(0.48, -0.1, -0.22);
      }
    } else {
      this.resetTorchToRightHandGrip();
    }
  }

  private resetPose(): void {
    this.torso.position.y = this.baseTorsoY;
    this.torso.rotation.set(0, 0, 0);
    this.headRoot.rotation.set(0, 0, 0);
    this.armL.rotation.set(0, 0, 0);
    this.armR.rotation.set(0, 0, 0);
    this.prop.position.set(0, 0, 0);
    this.prop.rotation.set(0, 0, 0);
    this.bucketMesh.position.set(0, 0, 0);
    this.bucketMesh.rotation.set(0, 0, 0);
    this.logMesh.position.set(0, 0, 0);
    this.logMesh.rotation.set(0, 0, Math.PI / 2);
    this.propAxeGroup.position.set(0, 0, 0);
    this.propAxeGroup.rotation.set(0, 0, 0);
    this.orbMesh.position.set(0, 0, 0);
    this.meatMesh.position.set(0, 0, 0);
    this.meatMesh.rotation.set(0, 0, 0);
    this.rationMesh.position.set(0, 0, 0);
    this.rationMesh.rotation.set(0, 0, 0);
    this.berrySnackMesh.position.set(0, 0, 0);
    this.berrySnackMesh.rotation.set(0, 0, 0);
    this.waterskinMesh.position.set(0, 0, 0);
    this.waterskinMesh.rotation.set(0, 0, 0);
    this.bandageMesh.position.set(0, 0, 0);
    this.bandageMesh.rotation.set(0, 0, 0);
    this.stimMesh.position.set(0, 0, 0);
    this.stimMesh.rotation.set(0, 0, 0);
    this.legLMesh.rotation.set(0, 0, 0);
    this.legRMesh.rotation.set(0, 0, 0);
    this.legLMesh.position.set(-0.08, -0.02, 0);
    this.legRMesh.position.set(0.08, -0.02, 0);
    this.footLMesh.position.set(0, -0.14, 0.05);
    this.footRMesh.position.set(0, -0.14, 0.05);
  }

  private resetEnemyBattlePose(): void {
    const r = this.enemyBattleRig;
    if (!r) return;
    r.armL.rotation.set(0, 0, 0);
    r.armR.rotation.set(0, 0, 0);
    r.headRoot.rotation.set(0, 0, 0);
    r.torso.rotation.set(0, 0, 0);
  }

  private enemyDeathBloodPreset(): 'enemy_rat_torso' | 'enemy_human_face_drip' {
    if (this.battleEnemyId === 'e_rat' || this.battleEnemyId === 'e_wolf') return 'enemy_rat_torso';
    if (this.battleEnemyId === 'pvp_rival') return 'enemy_human_face_drip';
    return this.enemyBattleRig ? 'enemy_human_face_drip' : 'enemy_rat_torso';
  }

  /** Return shirt/pants stain groups to scene and hide (torso attachment is battle-only). */
  private parkBloodBodyStains(): void {
    for (const m of this.bloodShirtStainMeshes) {
      const mat = m.material as THREE.MeshPhysicalMaterial;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
    }
    for (const m of this.bloodShirtDripMeshes) {
      const mat = m.material as THREE.MeshPhysicalMaterial;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
    }
    for (const m of this.bloodPantsStainMeshes) {
      const mat = m.material as THREE.MeshPhysicalMaterial;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
    }
    this.battleBloodShirtRoot.removeFromParent();
    this.battleBloodPantsRoot.removeFromParent();
    this.scene.add(this.battleBloodShirtRoot);
    this.scene.add(this.battleBloodPantsRoot);
    this.battleBloodShirtRoot.visible = false;
    this.battleBloodPantsRoot.visible = false;
    this.bloodBodyStainVictim = null;
  }

  private attachBloodBodyStains(victim: 'player' | 'enemy'): void {
    const torso = victim === 'player' ? this.torso : this.enemyBattleRig?.torso;
    if (!torso) return;
    this.parkBloodBodyStains();
    this.battleBloodShirtRoot.visible = true;
    this.battleBloodPantsRoot.visible = true;
    torso.add(this.battleBloodShirtRoot);
    torso.add(this.battleBloodPantsRoot);
    this.battleBloodShirtRoot.position.set(0.014, 0.204, 0.098);
    this.battleBloodShirtRoot.rotation.set(-0.34, 0, 0);
    this.battleBloodPantsRoot.position.set(0, 0.026, 0.072);
    this.battleBloodPantsRoot.rotation.set(-0.13, 0, 0);
    this.bloodBodyStainVictim = victim;
  }

  private clearBattleBloodVisuals(): void {
    this.battleBloodRoot.visible = false;
    this.battleBloodFaceRoot.visible = false;
    this.bloodDripElapsed = 0;
    for (const m of this.bloodBlobMeshes) {
      const mat = m.material as THREE.MeshPhysicalMaterial;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
    }
    for (const s of this.bloodStreakMeshes) {
      const mat = s.material as THREE.MeshPhysicalMaterial;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
    }
    for (const s of this.bloodSplatMeshes) {
      const mat = s.material as THREE.MeshPhysicalMaterial;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
    }
    for (const d of this.bloodDripMeshes) {
      const mat = d.material as THREE.MeshPhysicalMaterial;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
    }
    for (const b of this.bloodFaceBurstMeshes) {
      const mat = b.material as THREE.MeshPhysicalMaterial;
      mat.opacity = 0;
      mat.emissiveIntensity = 0.04;
    }
    this.parkBloodBodyStains();
  }

  /**
   * Awakened-mode world-space gore. Reuses the dream-mode face-spew → ground-
   * drip animation (the same one that fires on a player kill in dream battle)
   * but positions it at the mob's actual face/feet in world space instead of
   * the dream-rig's `enemyRoot.headRoot`. The result is identical: a face
   * burst at the hit point, drip strips falling down the body's path, and a
   * ground pool that grows in as the drips reach the floor.
   *
   * Call this ONLY from confirmed-hit codepaths (e.g. `onMobDamaged` with
   * `amount > 0`, future PvP-hit confirmation). DO NOT call it from the
   * swing-button press itself — that produced the original "blood every time
   * I swing" bug. The strict "blood = damage applied" rule keeps the visual
   * honest: gore on screen always means a target took damage.
   *
   * Parameters:
   *  - `(x, z)` is the mob's ground footprint (used for the floor pool).
   *  - `faceY` is the WORLD-Y of the mob's face/head — drip strips fall from
   *    this height down to `BLOOD_GROUND_Y` so a tall wanderer leaves a long
   *    drip trail and a low rat leaves a short one.
   *  - `intensity` clamps to [0, 1]: 1.0 = killing-blow gore, ~0.3 = light hit.
   *
   * Body/cloth stains are skipped — those reference the dream avatar/enemy
   * rig's specific bones (shirt/pants meshes parented to skinned-mesh
   * sockets). Awakened mobs have no equivalent rig surface for cloth-stain
   * projection, so we omit that layer; the face-burst + drip + floor pool
   * remain visible from every camera angle and read clearly on rats, wolves,
   * and wanderers alike.
   */
  spawnAwakenedHitBlood(x: number, faceY: number, z: number, intensity: number): void {
    if (!this.awakenedFreeRoam) return;
    const impact = Math.min(1, Math.max(0, intensity));
    if (impact < CharacterScenePreview.BLOOD_FACE_IMPACT_MIN) return;
    /* Floor pool anchor at the mob's feet on the ground plane. The pool/
     * splat/streak meshes are positioned RELATIVE to `battleBloodRoot`
     * (which `renderBattleBloodLayer` parks at `bloodAnchorWorld`), so this
     * places them at the mob's footprint. */
    this.bloodAnchorWorld.set(x, CharacterScenePreview.BLOOD_GROUND_Y, z);
    /* Face-burst + drip strips anchor at the mob's face. `battleBloodFaceRoot`
     * is parked here in the face-drip branch of `renderBattleBloodLayer`,
     * and drip strips dangle DOWN from this point a distance of
     * `bloodDripFallDist` (which we size to match face → ground below). */
    this.bloodFaceSnapshotWorld.set(x, faceY, z);
    this.bloodDripFallDist = Math.max(
      0.18,
      faceY - CharacterScenePreview.BLOOD_GROUND_Y,
    );
    /* Start the drip animation slightly into its lifecycle so the face burst
     * and an immediate proto-drip read on the very first frame (no "blink in"
     * pop). Same head-start the dream system uses on player-death blood. */
    this.bloodDripElapsed = CharacterScenePreview.BLOOD_FACE_DRIP_HEAD_START;
    /* Force cloth-stain layer off — no dream rig to attach the shirt/pants
     * meshes to in awakened mode. `renderBattleBloodLayer` honors
     * `bloodBodyStainVictim === null` by leaving those roots invisible. */
    this.bloodBodyStainVictim = null;
    this.battleBloodShirtRoot.visible = false;
    this.battleBloodPantsRoot.visible = false;
    /* `enemy_human_face_drip` preset = face burst + drip strips falling down +
     * ground pool melding in as drips reach floor. The same animation the
     * dream system plays on a melee kill against a humanoid enemy — proven
     * to read well at any camera angle. Reusing it for awakened mobs keeps
     * a single visual language for "this thing got hit". */
    this.bloodFadePreset = 'enemy_human_face_drip';
    const peak = Math.min(
      1,
      Math.max(impact * 1.25, CharacterScenePreview.BLOOD_FACE_PEAK_FLOOR),
    );
    this.bloodPeakSnapshot = Math.max(this.bloodPeakSnapshot, peak);
    this.bloodLifeRemaining = CharacterScenePreview.BLOOD_LINGER_TOTAL;
    this.renderBattleBloodLayer(1);
  }

  /**
   * Strong hit refreshes linger timer; gore stays in world space and fades via {@link tickBattleBlood}.
   * Weak/no hit does not clear existing splatter.
   *
   * **Awakened-mode gate (2026-04-19 fix).** This blood VFX system was designed for
   * the dream-mode turn-based battle where there's a single fixed `enemyRoot` slot.
   * In awakened free-roam combat there's no such slot — mobs are dynamic and there
   * can be many at once. The shared `battle_cast` / `battle_strike` /
   * `battle_enemy_death` clips fire in BOTH modes (awakened combat reuses dream
   * clips via `playInPlaceCombatClip`). Without this gate, every awakened attack
   * dumped blood at the dream `enemyRoot` position (wherever it was last parked
   * in the world), producing the user-reported "blood appears anywhere on the
   * map after a kill" bug.
   *
   * Awakened mode now has its own world-space hit blood via
   * {@link spawnAwakenedHitBlood}, called from the actual mob-damage callback
   * in `mountApp.ts onMobDamaged`. That path bypasses this gate by design —
   * see the doc comment on {@link spawnAwakenedHitBlood}. */
  private updateBattleBlood(
    impact: number,
    victim: 'player' | 'enemy',
    preset:
      | 'default'
      | 'player_face_spew'
      | 'player_leg'
      | 'enemy_rat_torso'
      | 'enemy_human_face_drip' = 'default',
  ): void {
    if (this.awakenedFreeRoam) return;
    const isFaceBlood = preset === 'player_face_spew' || preset === 'enemy_human_face_drip';
    const impactMin = isFaceBlood
      ? CharacterScenePreview.BLOOD_FACE_IMPACT_MIN
      : CharacterScenePreview.BLOOD_IMPACT_MIN;
    if (impact < impactMin) return;

    this.avatar.updateMatrixWorld(true);
    this.enemyRoot.updateMatrixWorld(true);

    if (victim === 'player') {
      if (preset === 'player_leg') {
        this.footLMesh.getWorldPosition(this.tmpHitWorld);
      } else {
        this.headRoot.getWorldPosition(this.tmpHitWorld);
      }
    } else if (preset === 'enemy_rat_torso') {
      this.enemyRoot.getWorldPosition(this.tmpHitWorld);
    } else if (this.enemyBattleRig) {
      this.enemyBattleRig.headRoot.getWorldPosition(this.tmpHitWorld);
    } else {
      this.enemyRoot.getWorldPosition(this.tmpHitWorld);
    }

    /* Pool sits on the floor under the hit; slide slightly toward opponent so it reads between fighters. */
    if (victim === 'player') {
      this.enemyRoot.getWorldPosition(this.tmpStreakPos);
    } else {
      this.avatar.getWorldPosition(this.tmpStreakPos);
    }
    this.tmpOpponentDelta.set(
      this.tmpStreakPos.x - this.tmpHitWorld.x,
      0,
      this.tmpStreakPos.z - this.tmpHitWorld.z,
    );
    const oppLen = Math.hypot(this.tmpOpponentDelta.x, this.tmpOpponentDelta.z) || 1;
    this.tmpOpponentDelta.multiplyScalar(1 / oppLen);
    const slide =
      (preset === 'player_face_spew'
        ? 0.11
        : preset === 'player_leg'
          ? 0.035
          : preset === 'enemy_rat_torso'
            ? 0.055
            : preset === 'enemy_human_face_drip'
              ? 0.056
              : 0.065) * Math.min(1, impact * 1.35);
    this.bloodAnchorWorld.set(
      this.tmpHitWorld.x + this.tmpOpponentDelta.x * slide,
      CharacterScenePreview.BLOOD_GROUND_Y,
      this.tmpHitWorld.z + this.tmpOpponentDelta.z * slide,
    );
    if (preset === 'enemy_human_face_drip' || preset === 'player_face_spew') {
      this.bloodFaceSnapshotWorld.copy(this.tmpHitWorld);
      this.bloodDripFallDist = Math.max(0.14, this.tmpHitWorld.y - CharacterScenePreview.BLOOD_GROUND_Y);
      this.bloodDripElapsed = CharacterScenePreview.BLOOD_FACE_DRIP_HEAD_START;
      this.attachBloodBodyStains(victim);
    }
    this.bloodFadePreset = preset;
    const peak = Math.min(
      1,
      Math.max(impact * 1.25, isFaceBlood ? CharacterScenePreview.BLOOD_FACE_PEAK_FLOOR : 0),
    );
    this.bloodPeakSnapshot = Math.max(this.bloodPeakSnapshot, peak);
    this.bloodLifeRemaining = CharacterScenePreview.BLOOD_LINGER_TOTAL;

    const holdFade = 1;
    this.renderBattleBloodLayer(holdFade);
  }

  private tickBattleBlood(dt: number): void {
    if (this.bloodLifeRemaining <= 0) {
      if (this.battleBloodRoot.visible) this.clearBattleBloodVisuals();
      this.bloodPeakSnapshot = 0;
      return;
    }
    this.bloodLifeRemaining -= dt;
    const t = CharacterScenePreview.BLOOD_LINGER_TOTAL;
    const hold = t * CharacterScenePreview.BLOOD_HOLD_FRAC;
    let lifeFade = 1;
    if (this.bloodLifeRemaining <= t - hold) {
      lifeFade = Math.max(0, this.bloodLifeRemaining / (t - hold));
    }
    if (this.bloodLifeRemaining <= 0 || this.bloodPeakSnapshot <= 0.02) {
      this.clearBattleBloodVisuals();
      this.bloodPeakSnapshot = 0;
      return;
    }
    if (
      this.bloodFadePreset === 'enemy_human_face_drip' ||
      this.bloodFadePreset === 'player_face_spew'
    ) {
      this.bloodDripElapsed += dt;
    }
    this.renderBattleBloodLayer(lifeFade);
  }

  /** `lifeFade` 1 = full hold, then eases to 0 for dissipation. */
  private renderBattleBloodLayer(lifeFade: number): void {
    const preset = this.bloodFadePreset;
    const facePool = preset === 'player_face_spew';
    const faceDrip = preset === 'enemy_human_face_drip' || preset === 'player_face_spew';
    const peak = this.bloodPeakSnapshot * lifeFade;
    if (peak < 0.04) {
      this.clearBattleBloodVisuals();
      return;
    }

    const dur = CharacterScenePreview.BLOOD_DRIP_DURATION;
    const dripPGround = faceDrip ? Math.min(1, this.bloodDripElapsed / dur) : 1;
    /* Body phases advance faster than the floor pool so deserter / player face gore matches rat "snap". */
    const dripPBody = faceDrip ? Math.min(1, (this.bloodDripElapsed + 0.06) / dur) : 1;
    const dripEaseBody = 1 - (1 - dripPBody) ** 2;
    const poolMeld = faceDrip ? bloodSmoothstep(0.52, 0.96, dripPGround) : 1;
    const shirtT = faceDrip ? bloodSmoothstep(0.06, 0.55, dripPBody) : 0;
    const pantsT = faceDrip ? bloodSmoothstep(0.26, 0.8, dripPBody) : 0;

    if (!faceDrip) {
      if (this.bloodBodyStainVictim !== null) {
        this.parkBloodBodyStains();
      }
      this.battleBloodFaceRoot.visible = false;
      for (const d of this.bloodDripMeshes) {
        const dm = d.material as THREE.MeshPhysicalMaterial;
        dm.opacity = 0;
      }
      for (const b of this.bloodFaceBurstMeshes) {
        const bm = b.material as THREE.MeshPhysicalMaterial;
        bm.opacity = 0;
      }
    }

    this.battleBloodRoot.position.copy(this.bloodAnchorWorld);
    this.battleBloodRoot.visible = true;

    const blobScale = facePool
      ? 2.45
      : preset === 'player_leg'
        ? 1.28
        : preset === 'enemy_rat_torso'
          ? 1.12
          : preset === 'enemy_human_face_drip'
            ? 1.52
            : 1.65;
    const blobOpac = facePool ? 0.9 : 0.59;
    const groundMeld = faceDrip ? poolMeld : 1;

    for (let i = 0; i < this.bloodBlobMeshes.length; i++) {
      const m = this.bloodBlobMeshes[i]!;
      const mat = m.material as THREE.MeshPhysicalMaterial;
      mat.opacity = Math.min(0.98, peak * blobOpac * (0.5 + (i % 5) * 0.075) * groundMeld);
      mat.clearcoat = 0.72 + (i % 3) * 0.08;
      mat.emissiveIntensity = 0.035 + peak * 0.09;
      const rad = (0.095 + peak * 0.145) * blobScale;
      const wobble = Math.sin((i + peak * 11) * 1.7) * 0.038;
      m.position.set(
        Math.cos(i * 0.89) * rad + wobble,
        0.0008 + (i % 5) * 0.00035 + Math.abs(wobble) * 0.012,
        Math.sin(i * 0.53) * rad * 0.95 + wobble,
      );
      const wx = 0.1 + (i % 4) * 0.028;
      const wz = 0.095 + (i % 3) * 0.03;
      m.rotation.set(
        -Math.PI / 2 + (i % 5) * 0.018 - 0.012,
        (i * 0.37 + peak) * 0.22,
        (i % 4) * 0.055,
      );
      m.scale.set(
        blobScale * wx * (0.95 + (i % 2) * 0.14) * peak,
        blobScale * wz * (0.9 + (i % 3) * 0.11) * peak,
        1,
      );
    }

    for (let i = 0; i < this.bloodSplatMeshes.length; i++) {
      const sp = this.bloodSplatMeshes[i]!;
      const sm = sp.material as THREE.MeshPhysicalMaterial;
      sm.opacity = Math.min(
        0.95,
        peak * (facePool ? 0.68 : 0.48) * (0.5 - (i % 5) * 0.05) * groundMeld,
      );
      sm.emissiveIntensity = 0.03 + peak * 0.08;
      sm.clearcoat = 0.68 + (i % 2) * 0.1;
      const spr = (0.045 + peak * 0.085) * blobScale;
      sp.position.set(
        Math.cos(i * 1.07) * spr * 1.22,
        0.0006 + (i % 3) * 0.00025,
        Math.sin(i * 0.69) * spr * 1.08,
      );
      sp.rotation.set(
        -Math.PI / 2 + (i % 4) * 0.014,
        (i * 2.41 + peak * 0.55) % (Math.PI * 2),
        (i % 3) * 0.1,
      );
      const ell = 0.08 + (i % 4) * 0.026 + peak * 0.038;
      sp.scale.set(
        ell * (1.08 + (i % 2) * 0.22),
        ell * (0.72 + (i % 3) * 0.16),
        1,
      );
    }

    for (let i = 0; i < this.bloodStreakMeshes.length; i++) {
      const s = this.bloodStreakMeshes[i]!;
      const sm = s.material as THREE.MeshPhysicalMaterial;
      const len = facePool
        ? 0.34 + (i % 4) * 0.07
        : preset === 'enemy_rat_torso'
          ? 0.11
          : preset === 'enemy_human_face_drip'
            ? 0.2
            : 0.23;
      const thick = 0.028 + (i % 3) * 0.009;
      sm.opacity = Math.max(
        0,
        (facePool ? peak * (0.68 - i * 0.05) : peak * (0.36 - i * 0.026)) * groundMeld,
      );
      sm.emissiveIntensity = 0.03 + peak * 0.07;
      sm.clearcoat = 0.75;
      const spread = (i - 3.5) * 0.054;
      s.position.set(Math.cos(i * 1.13) * spread, 0.0007, Math.sin(i * 0.67) * spread);
      s.rotation.set(-Math.PI / 2 + (i % 3) * 0.012, i * 0.88 + peak * 0.14, Math.sin(i * 0.7) * 0.25);
      s.scale.set(thick, len, 1);
    }

    if (faceDrip) {
      this.battleBloodFaceRoot.position.copy(this.bloodFaceSnapshotWorld);
      this.battleBloodFaceRoot.visible = true;
      const burstK = 1 - bloodSmoothstep(0.05, 0.52, this.bloodDripElapsed);
      for (let i = 0; i < this.bloodFaceBurstMeshes.length; i++) {
        const b = this.bloodFaceBurstMeshes[i]!;
        const bm = b.material as THREE.MeshPhysicalMaterial;
        bm.opacity = Math.min(0.99, peak * burstK * Math.max(0.12, 0.9 - i * 0.085));
        bm.emissiveIntensity = 0.055 + peak * burstK * 0.16;
        bm.clearcoat = 0.86;
        const bs = 0.042 * (0.96 + peak * 0.45) * (0.92 + burstK * 0.08);
        b.scale.set(bs * (1.14 + (i % 2) * 0.22), bs * (0.88 + (i % 3) * 0.14), 1);
      }
      const dripVis = 1;
      const fall = this.bloodDripFallDist * Math.max(0.26, dripEaseBody);
      const nFaceDrips = this.bloodDripMeshes.length;
      const runner0 = Math.max(5, nFaceDrips - 4);
      for (let i = 0; i < nFaceDrips; i++) {
        const strip = this.bloodDripMeshes[i]!;
        const mat = strip.material as THREE.MeshPhysicalMaterial;
        /* Staggered max reach; base reach immediate on hit so blood reads at contact. */
        const chestHold =
          0.24 + bloodSmoothstep(0, 0.28, dripPBody) * (0.12 + (i % 2) * 0.05);
        const shirtRun =
          shirtT * (0.24 + (i % 3) * 0.06 + (i < Math.ceil(nFaceDrips * 0.42) ? 0.1 : 0.02));
        const pantRun =
          pantsT *
          (0.1 +
            (i % 3) * 0.04 +
            (i >= 2 ? 0.11 : 0) +
            (i >= nFaceDrips - 3 ? 0.14 : 0));
        let floorWt = 0;
        if (i >= nFaceDrips - 1) floorWt = 0.28;
        else if (i >= nFaceDrips - 2) floorWt = 0.19;
        else if (i >= nFaceDrips - 3) floorWt = 0.11;
        else if (i >= nFaceDrips - 4) floorWt = 0.05;
        const floorChase = bloodSmoothstep(0.45, 0.98, dripPBody) * floorWt;
        const reachFrac = Math.min(0.98, chestHold + shirtRun + pantRun + floorChase);
        const len = Math.max(0.026, fall * reachFrac * (0.52 + (i % 3) * 0.1));
        const w = (0.013 + (i % 2) * 0.0048) * (i >= runner0 ? 0.91 : 1.08);
        strip.scale.set(w, len, 1);
        strip.position.y = -len * 0.47;
        const shortBright = 0.78 + 0.22 * shirtT;
        const runnerBright = 0.42 + 0.48 * pantsT + 0.18 * bloodSmoothstep(0.45, 0.9, dripPBody);
        const stripLight = i >= runner0 ? runnerBright : shortBright;
        mat.opacity = Math.min(0.96, peak * dripVis * Math.max(0.08, 0.72 - i * 0.048) * stripLight);
        mat.emissiveIntensity = 0.05 + peak * 0.09;
        mat.clearcoat = 0.82;
      }

      if (this.bloodBodyStainVictim !== null) {
        this.battleBloodShirtRoot.visible = true;
        this.battleBloodPantsRoot.visible = true;
      }

      const shirtDripLen =
        0.048 +
        0.085 * shirtT * dripEaseBody +
        0.11 * pantsT * dripEaseBody +
        0.034 * shirtT * pantsT;
      const shirtShow = 0.62 + 0.38 * shirtT;
      const pantsShow = 0.4 + 0.6 * pantsT;
      for (let i = 0; i < this.bloodShirtStainMeshes.length; i++) {
        const st = this.bloodShirtStainMeshes[i]!;
        const sm = st.material as THREE.MeshPhysicalMaterial;
        const g =
          0.042 *
          (0.88 + (i % 3) * 0.13) *
          (0.55 + 0.45 * shirtT) *
          peak *
          (1 + 0.14 * pantsT);
        st.scale.set(g * (1.1 + (i % 2) * 0.18), g * (0.76 + (i % 2) * 0.14), 1);
        sm.opacity = Math.min(0.96, peak * shirtShow * (0.62 - i * 0.045));
        sm.emissiveIntensity = 0.05 + peak * shirtShow * 0.12;
        sm.clearcoat = 0.74;
      }
      for (let i = 0; i < this.bloodShirtDripMeshes.length; i++) {
        const sd = this.bloodShirtDripMeshes[i]!;
        const sm = sd.material as THREE.MeshPhysicalMaterial;
        const len = shirtDripLen * (0.7 + (i % 2) * 0.3);
        const ww = 0.011 + (i % 2) * 0.004;
        sd.scale.set(ww, Math.max(0.028, len), 1);
        sd.position.y = -0.02 - len * 0.42;
        const shirtPhaseOp = 0.55 * shirtShow + 0.45 * shirtT * pantsT;
        sm.opacity = Math.min(0.92, peak * shirtPhaseOp * 0.74 * (0.76 - i * 0.085));
        sm.emissiveIntensity = 0.048 + peak * 0.09;
        sm.clearcoat = 0.8;
      }
      for (let i = 0; i < this.bloodPantsStainMeshes.length; i++) {
        const pt = this.bloodPantsStainMeshes[i]!;
        const pm = pt.material as THREE.MeshPhysicalMaterial;
        const pg =
          0.044 * (0.82 + (i % 3) * 0.11) * (0.45 + 0.55 * pantsT) * peak;
        pt.scale.set(pg * (1.1 + (i % 2) * 0.16), pg * (0.72 + (i % 2) * 0.12), 1);
        pm.opacity = Math.min(0.94, peak * pantsShow * (0.56 - i * 0.045));
        pm.emissiveIntensity = 0.045 + peak * pantsShow * 0.1;
        pm.clearcoat = 0.72;
      }
    }
  }

  /**
   * Awakened-mode footstep SFX + walk-cycle phase integrator. Called from the per-frame
   * loop BEFORE the playing/idle dispatch so it fires regardless of clip state — the
   * player walking around / away from a tree they're chopping needs to hear footsteps
   * over the chop SFX. (The original implementation lived inside `applyIdle` which is
   * skipped while a clip plays; that suppressed footsteps for the entire chop window
   * and made it sound like the harvest interrupted them.)
   *
   * Side effects:
   *   - Updates `awakenedLastAvatarX/Z` (so callers don't read stale deltas).
   *   - Smooths `awakenedWalkAmp` toward `smoothstep(speed, 0.05, 1.5)` so the
   *     body-pose walk cycle in `applyIdle` blends in/out of motion without a
   *     hard threshold snap.
   *   - Integrates `awakenedWalkT` and fires `playFootstepSound()` on each step contact.
   *
   * Reset-on-stop is critical: when speed drops below the threshold we ZERO the walk
   * timer so the next step starts on the downbeat. Without this, the integrator would
   * resume mid-cycle and fire a footstep instantly on resume, which sounds like a
   * "double step" (the catch-up step the user reported).
   */
  private tickAwakenedFootsteps(dt: number): void {
    if (!this.awakenedFreeRoam || this.freeRoamAirborne) {
      this.awakenedWalkT = 0;
      this.awakenedLastStepCount = 0;
      this.awakenedWalkAmp = 0;
      return;
    }
    const ax = this.avatar.position.x;
    const az = this.avatar.position.z;
    const moved = Math.hypot(ax - this.awakenedLastAvatarX, az - this.awakenedLastAvatarZ);
    this.awakenedLastAvatarX = ax;
    this.awakenedLastAvatarZ = az;
    const speed = dt > 0 ? moved / dt : 0;
    /* Walk-pose amplitude: smoothstep maps speed in [0.05, 1.5] m/s → [0, 1]
     * full-walk pose. Exponential lerp (rate ≈ 12 → ~190 ms time constant) so
     * the pose smoothly ramps in on press and decays out on release instead of
     * snapping. See `awakenedWalkAmp` field doc for context. */
    const targetAmp = THREE.MathUtils.smoothstep(speed, 0.05, 1.5);
    const k = 1 - Math.exp(-12 * Math.max(0.001, Math.min(0.1, dt)));
    this.awakenedWalkAmp += (targetAmp - this.awakenedWalkAmp) * k;
    if (speed > 0.2) {
      /* Walk-cycle frequency scales with movement speed. 0.22 × speed cycles/sec means
       * each integer increment of (awakenedWalkT × 2) = one step contact. */
      const cyclesPerSec = 0.22 * speed;
      this.awakenedWalkT += dt * cyclesPerSec;
      const stepCount = Math.floor(this.awakenedWalkT * 2);
      if (stepCount > this.awakenedLastStepCount) {
        /* Cap at one SFX per frame: even if FPS hitches dropped enough steps to make
         * `stepCount` jump by more than 1, we only fire ONE step (no audible burst when
         * resuming from a pause / tab-switch). Even = LEFT foot (lower pitch), odd =
         * RIGHT foot (higher pitch) — alternation reads as two-legged walking. */
        this.awakenedLastStepCount = stepCount;
        playFootstepSound(stepCount % 2 === 0 ? 'L' : 'R');
      }
    } else {
      /* Standing still — zero the cycle so the next step starts cleanly on the
       * downbeat instead of mid-cycle (would otherwise fire a footstep instantly on
       * resume even though the leg hadn't fully come up yet). */
      this.awakenedWalkT = 0;
      this.awakenedLastStepCount = 0;
    }
  }

  private applyIdle(dt: number): void {
    this.hideAllProps();
    this.resetPose();
    if (!this.battleEnemyCorpseFallen) this.resetEnemyBattlePose();
    this.showIdleGear();
    this.idlePhase += dt;
    const t = this.idlePhase;
    applyDockIdleBodyLayer(t, this.pageContext as DockAmbientPageContext, {
      torso: this.torso,
      headRoot: this.headRoot,
      armL: this.armL,
      armR: this.armR,
    });
    this.rim.color.setHex(this.hoverAccent);
    /* Campfire / workbench stay in the dock everywhere except Portal (webring /
     * exit clip) AND awakened mode. In awakened mode the player places stations
     * anywhere via Build mode (rendered by `craftStationBuilder.ts`); the fixed
     * dock-yard slot is dream-mode-only flavor. Keeping both visible would put
     * a "phantom" campfire at the dock-yard centre while the player's real
     * placed campfire sits elsewhere on the map. */
    const showDockCampDecor =
      (this.hasCraftCampfire || this.hasCraftWorkbench)
      && this.pageContext !== 'portal'
      && !this.awakenedFreeRoam;
    this.craftDecorGroup.visible = showDockCampDecor;
    this.craftCampfireSlot.visible =
      this.hasCraftCampfire &&
      this.campfireLPCA != null &&
      this.craftCampfireRevealHold === 0 &&
      !this.awakenedFreeRoam;
    this.craftBenchSlot.visible =
      this.hasCraftWorkbench &&
      this.workbenchLPCA != null &&
      this.craftWorkbenchRevealHold === 0 &&
      !this.awakenedFreeRoam;
    if (this.enemyRoot.visible && !this.battleEnemyCorpseFallen) {
      const er = this.getEnemyRestXZ();
      this.enemyRoot.position.set(er.x, 0, er.z);
      this.enemyRoot.rotation.z = 0;
    }
    if (this.pageContext === 'battle' && this.enemyRoot.visible) {
      const ax = this.avatar.position.x;
      const az = this.avatar.position.z;
      const ex = this.enemyRoot.position.x;
      const ez = this.enemyRoot.position.z;
      this.avatar.rotation.y = gatherFaceY(ax, az, ex, ez);
      if (!this.battleEnemyCorpseFallen) {
        this.enemyRoot.rotation.y = gatherFaceY(ex, ez, ax, az);
      }
    } else if (!this.playing && this.clip === 'idle' && this.pageContext === 'craft' && !this.awakenedFreeRoam) {
      /* Deck-mode craft page only — auto-face the campfire/workbench/central pivot so
       * the player sees the avatar oriented toward the station they just opened the
       * Craft tab to interact with. Awakened mode SKIPS this entirely: even when the
       * awakened menu overlay opens the Craft sub-page (pageContext flips to 'craft'),
       * the player's WASD-driven facing stays the source of truth — they didn't walk
       * across the world just to be snap-rotated back at the campfire every frame.
       * (Bug fix 2026-04-18: previously fired in awakened mode whenever the campfire
       * was crafted.) */
      const { x: fx, z: fz } = this.getDockFaceWorldXZ();
      this.avatar.rotation.y = gatherFaceY(this.avatar.position.x, this.avatar.position.z, fx, fz);
    } else if (!this.playing && this.clip === 'idle' && this.pageContext !== 'battle' && !this.awakenedFreeRoam) {
      /* Awakened free-roam: skip the auto-rotate-to-camp behavior so the player keeps the
       * facing they earned via WASD. The dock-mode auto-rotate is what made the avatar
       * snap to face origin every frame after WASD release. */
      const ax = this.avatar.position.x;
      const az = this.avatar.position.z;
      const gr = this.gatherRestXZ();
      const dHome = Math.hypot(ax - gr.x, az - gr.z);
      if (dHome > 0.042) {
        this.avatar.rotation.y = gatherFaceY(ax, az, gr.x, gr.z);
      } else {
        this.avatar.rotation.y = this.hunterSharedWorldActive ? this.travelHomeRotY : dockSoloIdleFaceYawRad();
      }
    }

    /* ---- Awakened-mode body-pose walk cycle ----
     *
     * Drives torso/arm/leg swing while the avatar is moving AND no clip is playing.
     * Reads `awakenedWalkT` which `tickAwakenedFootsteps` (called from the per-frame
     * loop, REGARDLESS of clip state) is already integrating, so the visual swing
     * stays phase-coherent with the audio cadence. */
    /* Awakened walk-cycle pose. Gated on `awakenedWalkAmp` (smoothed, decoupled
     * from the hard speed threshold in `tickAwakenedFootsteps`) so the limbs
     * fade between rest and stride over ~190 ms instead of snapping mid-pose
     * when speed crosses a threshold.
     *
     * **Blend pattern:** for any limb whose rest-pose value is set by the
     * preceding `applyIdle` → `applyDockPageAmbient` chain (arm shoulder
     * splay, torso z-sway), we read the current value as the rest baseline
     * then `lerp(rest, walkValue, amp)`. At amp=0 the limb is back at the
     * exact rest value the page-ambient set — no snap when the gate kicks
     * the block out. For limbs the rest layer doesn't touch (legs,
     * head x-bob, torso bob-y), we just use `rest + walkValue * amp` (rest
     * = whatever resetPose left them at, almost always 0).
     *
     * The earlier "= walkValue * amp" pattern was buggy: at amp ≈ 0.001 the
     * walk-pose set arm.z ≈ 0; then the gate (amp < 0.001) cut the block
     * out and arm.z reverted to page-ambient's 0.1 — a ~5° snap ~1 second
     * after the player stopped. */
    if (
      this.awakenedFreeRoam &&
      !this.playing &&
      this.clip === 'idle' &&
      !this.freeRoamAirborne &&
      this.awakenedWalkAmp > 0.001
    ) {
      const amp = this.awakenedWalkAmp;
      const walkPhase = this.awakenedWalkT * Math.PI * 2;
      const swing = Math.sin(walkPhase) * 0.33 * amp;
      /* Bob (no rest baseline beyond `baseTorsoY` which resetPose set). */
      this.torso.position.y = this.baseTorsoY + Math.abs(Math.sin(walkPhase * 2)) * 0.017 * amp;
      /* torso z-sway: page-ambient may have set this; blend so amp=0 returns to it. */
      const restTorsoZ = this.torso.rotation.z;
      this.torso.rotation.z = restTorsoZ + (Math.sin(walkPhase) * 0.034 - restTorsoZ) * amp;
      /* Arms: shoulder splay (.z) blends FROM page-ambient value; .x is purely additive
       * swing on top of whatever idle/page-ambient left it at. */
      this.armL.rotation.x += swing;
      this.armR.rotation.x -= swing;
      const restArmLZ = this.armL.rotation.z;
      const restArmRZ = this.armR.rotation.z;
      this.armL.rotation.z = restArmLZ + (0.1 - restArmLZ) * amp;
      this.armR.rotation.z = restArmRZ + (-0.1 - restArmRZ) * amp;
      this.headRoot.rotation.x += Math.sin(walkPhase * 0.5) * 0.038 * amp;
      /* Legs: rest pose is 0 (resetPose); no page-ambient touches legs. */
      this.legLMesh.rotation.x = Math.sin(walkPhase) * 0.11 * amp;
      this.legRMesh.rotation.x = -Math.sin(walkPhase) * 0.11 * amp;
    }

    /* Dock routing: constant-speed walk to craft stand(s) or home — includes first campfire before decor unlock.
     * Awakened free-roam disables this entirely; the WASD integrator owns avatar XZ instead. */
    if (!this.playing && this.clip === 'idle' && this.pageContext !== 'battle' && this.pageContext !== 'portal' && !this.awakenedFreeRoam) {
      const { x: routeTx, z: routeTz } = this.getDockRouteTarget();
      const ax = this.avatar.position.x;
      const az = this.avatar.position.z;
      const dx = routeTx - ax;
      const dz = routeTz - az;
      const dist = Math.hypot(dx, dz);
      if (dist > 1e-5) {
        const maxStep = this.dockRouteWalkSpeed * dt;
        const ramp = Math.min(1, dist / 0.2);
        const step = Math.min(dist, maxStep * (0.38 + 0.62 * ramp));
        this.avatar.position.x += (dx / dist) * step;
        this.avatar.position.z += (dz / dist) * step;
      }

      if (
        this.pageContext === 'craft' &&
        this.craftReturnToHub &&
        this.pendingDockCraft == null
      ) {
        const { x: hx, z: hz } = this.craftCentralStandXZ();
        if (
          Math.hypot(hx - this.avatar.position.x, hz - this.avatar.position.z) <=
          CharacterScenePreview.DOCK_ARRIVE_EPS
        ) {
          this.craftReturnToHub = false;
        }
      }

      const rem = Math.hypot(routeTx - this.avatar.position.x, routeTz - this.avatar.position.z);
      const walkThreshold = 0.028;
      if (rem > walkThreshold) {
        this.dockRouteWalkT += dt * (2.35 + Math.min(2.4, rem * 11));
        const walkPhase = this.dockRouteWalkT * Math.PI * 2;
        const swing = Math.sin(walkPhase) * 0.33;
        this.torso.position.y = this.baseTorsoY + Math.abs(Math.sin(walkPhase * 2)) * 0.017;
        this.torso.rotation.z = Math.sin(walkPhase) * 0.034;
        this.armL.rotation.x += swing;
        this.armR.rotation.x -= swing;
        this.armL.rotation.z = 0.1;
        this.armR.rotation.z = -0.1;
        this.headRoot.rotation.x += Math.sin(walkPhase * 0.5) * 0.038;
        this.legLMesh.rotation.x = Math.sin(walkPhase) * 0.11;
        this.legRMesh.rotation.x = -Math.sin(walkPhase) * 0.11;
      } else {
        this.dockRouteWalkT = 0;
      }
    } else {
      this.dockRouteWalkT = 0;
    }

    /* === Post-clip pose blend ===
     *
     * If a clip just ended (within `POST_CLIP_BLEND_DURATION_SEC`), lerp the
     * fully-computed-this-frame idle/walk pose back toward the snapshot of the
     * pose the clip left the avatar in. As the timer elapses, the snapshot's
     * weight fades to 0 via smoothstep and the displayed pose is the pure
     * idle/walk pose. Without this, the avatar visibly leaps from harvest
     * mid-pose (axe overhead, bucket dipped, etc.) to neutral the very next
     * frame. */
    if (this.postClipBlendT >= 0) {
      this.postClipBlendT += dt;
      const progress = Math.min(1, this.postClipBlendT / POST_CLIP_BLEND_DURATION_SEC);
      /* Smoothstep S-curve so the held pose lingers briefly at the start
       * (no instant abandonment of the swing's held frame), the middle
       * transitions quickly, and the settle into idle is gentle. */
      const w = 1 - (progress * progress * (3 - 2 * progress));
      const c = this.postClipCaptured;
      this.torso.position.y += (c.torsoY - this.torso.position.y) * w;
      this.torso.rotation.x += (c.torsoRotX - this.torso.rotation.x) * w;
      this.torso.rotation.y += (c.torsoRotY - this.torso.rotation.y) * w;
      this.torso.rotation.z += (c.torsoRotZ - this.torso.rotation.z) * w;
      this.headRoot.rotation.x += (c.headRotX - this.headRoot.rotation.x) * w;
      this.headRoot.rotation.y += (c.headRotY - this.headRoot.rotation.y) * w;
      this.headRoot.rotation.z += (c.headRotZ - this.headRoot.rotation.z) * w;
      this.armL.rotation.x += (c.armLRotX - this.armL.rotation.x) * w;
      this.armL.rotation.y += (c.armLRotY - this.armL.rotation.y) * w;
      this.armL.rotation.z += (c.armLRotZ - this.armL.rotation.z) * w;
      this.armR.rotation.x += (c.armRRotX - this.armR.rotation.x) * w;
      this.armR.rotation.y += (c.armRRotY - this.armR.rotation.y) * w;
      this.armR.rotation.z += (c.armRRotZ - this.armR.rotation.z) * w;
      this.legLMesh.rotation.x += (c.legLRotX - this.legLMesh.rotation.x) * w;
      this.legLMesh.rotation.y += (c.legLRotY - this.legLMesh.rotation.y) * w;
      this.legLMesh.rotation.z += (c.legLRotZ - this.legLMesh.rotation.z) * w;
      this.legRMesh.rotation.x += (c.legRRotX - this.legRMesh.rotation.x) * w;
      this.legRMesh.rotation.y += (c.legRRotY - this.legRMesh.rotation.y) * w;
      this.legRMesh.rotation.z += (c.legRRotZ - this.legRMesh.rotation.z) * w;
      if (progress >= 1) this.postClipBlendT = -1;
    }
  }

  /**
   * Snapshot the avatar's current limb rotations + torso pose into
   * `postClipCaptured` so `applyIdle`'s post-clip blend pass can lerp from
   * here toward the idle pose over `POST_CLIP_BLEND_DURATION_SEC`. Called at
   * the moment a clip ends, BEFORE the first `applyIdle(dt)` of the new idle
   * window overwrites the limbs.
   */
  private captureCurrentPoseForPostClipBlend(): void {
    const c = this.postClipCaptured;
    c.torsoY = this.torso.position.y;
    c.torsoRotX = this.torso.rotation.x;
    c.torsoRotY = this.torso.rotation.y;
    c.torsoRotZ = this.torso.rotation.z;
    c.headRotX = this.headRoot.rotation.x;
    c.headRotY = this.headRoot.rotation.y;
    c.headRotZ = this.headRoot.rotation.z;
    c.armLRotX = this.armL.rotation.x;
    c.armLRotY = this.armL.rotation.y;
    c.armLRotZ = this.armL.rotation.z;
    c.armRRotX = this.armR.rotation.x;
    c.armRRotY = this.armR.rotation.y;
    c.armRRotZ = this.armR.rotation.z;
    c.legLRotX = this.legLMesh.rotation.x;
    c.legLRotY = this.legLMesh.rotation.y;
    c.legLRotZ = this.legLMesh.rotation.z;
    c.legRRotX = this.legRMesh.rotation.x;
    c.legRRotY = this.legRMesh.rotation.y;
    c.legRRotZ = this.legRMesh.rotation.z;
  }

  private woodUsesEquippedAxe(): boolean {
    const w = this.equippedWeapon;
    return !!w && isAxeWeaponId(w);
  }

  /**
   * Turn toward target, walk out, work, turn at resource to face home, walk forward home, then face camera.
   * Avatar Y is unchanged; snapshot home at clip start via {@link startClip}.
   */
  private applyTravelGather(
    p: number,
    targetX: number,
    targetZ: number,
    work: (w: number) => void,
  ): void {
    /* Awakened in-place harvest — skip the turn / walk-out / walk-home / face-camera
     * phases entirely. Just run the work callback across the full clip duration so the
     * player only sees the actual harvest motion (axe swing, bucket dip, pick swing,
     * etc.) at their current spot. Avatar XZ + facing are left untouched so WASD-set
     * heading is preserved. Torso/head/non-work limbs reset to neutral so we don't
     * inherit a half-completed walk-cycle pose from a previous clip. */
    if (this.inPlaceHarvestActive) {
      const w = easeInOut(p);
      this.torso.position.y = this.baseTorsoY;
      this.torso.rotation.set(0, 0, 0);
      this.headRoot.rotation.set(0, 0, 0);
      work(w);
      return;
    }

    const hx = this.travelHomeX;
    const hz = this.travelHomeZ;
    const homeRotY = this.travelHomeRotY;
    const dest = gatherApproachPoint(hx, hz, targetX, targetZ, GATHER_STANDOFF);
    const faceY = gatherFaceY(hx, hz, targetX, targetZ);
    /* From gather spot, local +Z should point toward home so the return walk is forward, not backward */
    const faceReturnY = gatherFaceY(dest.x, dest.z, hx, hz);

    if (p < TR_TURN1) {
      const t = easeInOut(p / TR_TURN1);
      this.avatar.rotation.y = lerpYaw(homeRotY, faceY, t);
      this.torso.position.y = this.baseTorsoY;
      this.armL.rotation.set(0.06, 0, 0.08);
      this.armR.rotation.set(0.06, 0, -0.08);
      this.torso.rotation.set(0, 0, 0);
      this.headRoot.rotation.set(0, 0, 0);
    } else if (p < TR_WALK1) {
      const rawT = (p - TR_TURN1) / (TR_WALK1 - TR_TURN1);
      const t = easeInOut(rawT);
      this.avatar.rotation.y = faceY;
      this.avatar.position.x = THREE.MathUtils.lerp(hx, dest.x, t);
      this.avatar.position.z = THREE.MathUtils.lerp(hz, dest.z, t);
      const bob = Math.sin(rawT * Math.PI * 7) * 0.016;
      this.torso.position.y = this.baseTorsoY + bob;
      const swing = Math.sin(rawT * Math.PI * 9) * 0.42;
      this.armL.rotation.x = 0.22 + swing;
      this.armR.rotation.x = 0.22 - swing;
      this.armL.rotation.z = 0.1;
      this.armR.rotation.z = -0.1;
      this.torso.rotation.x = 0.04;
      this.torso.rotation.y = 0;
      this.torso.rotation.z = Math.sin(rawT * Math.PI * 6) * 0.03;
      this.headRoot.rotation.set(0, 0, 0);
    } else if (p < TR_WORK) {
      const w = easeInOut((p - TR_WALK1) / (TR_WORK - TR_WALK1));
      this.avatar.position.x = dest.x;
      this.avatar.position.z = dest.z;
      this.avatar.rotation.y = faceY;
      this.torso.position.y = this.baseTorsoY;
      this.torso.rotation.set(0, 0, 0);
      this.headRoot.rotation.set(0, 0, 0);
      work(w);
    } else if (p < TR_TURN_BACK) {
      const t = easeInOut((p - TR_WORK) / (TR_TURN_BACK - TR_WORK));
      this.avatar.position.x = dest.x;
      this.avatar.position.z = dest.z;
      this.avatar.rotation.y = lerpYaw(faceY, faceReturnY, t);
      this.torso.position.y = this.baseTorsoY;
      this.armL.rotation.set(0.06, 0, 0.08);
      this.armR.rotation.set(0.06, 0, -0.08);
      this.torso.rotation.set(0, 0, 0);
      this.headRoot.rotation.set(0, 0, 0);
    } else if (p < TR_WALK_HOME) {
      const rawT = (p - TR_TURN_BACK) / (TR_WALK_HOME - TR_TURN_BACK);
      const t = easeInOut(rawT);
      this.avatar.rotation.y = faceReturnY;
      this.avatar.position.x = THREE.MathUtils.lerp(dest.x, hx, t);
      this.avatar.position.z = THREE.MathUtils.lerp(dest.z, hz, t);
      const bob = Math.sin(rawT * Math.PI * 7) * 0.016;
      this.torso.position.y = this.baseTorsoY + bob;
      const swing = Math.sin(rawT * Math.PI * 9) * 0.42;
      this.armL.rotation.x = 0.22 + swing;
      this.armR.rotation.x = 0.22 - swing;
      this.armL.rotation.z = 0.1;
      this.armR.rotation.z = -0.1;
      this.torso.rotation.x = 0.04;
      this.torso.rotation.y = 0;
      this.torso.rotation.z = Math.sin(rawT * Math.PI * 6) * 0.03;
      this.headRoot.rotation.set(0, 0, 0);
    } else {
      const t = easeInOut((p - TR_WALK_HOME) / (1 - TR_WALK_HOME));
      this.avatar.position.x = hx;
      this.avatar.position.z = hz;
      this.avatar.rotation.y = lerpYaw(faceReturnY, homeRotY, t);
      this.torso.position.y = this.baseTorsoY;
      this.armL.rotation.set(0.06, 0, 0.08);
      this.armR.rotation.set(0.06, 0, -0.08);
      this.torso.rotation.set(0, 0, 0);
      this.headRoot.rotation.set(0, 0, 0);
    }
  }

  private applyClipProgress(raw: number): void {
    const linearU = Math.max(0, Math.min(1, raw));
    const p = easeInOut(linearU);
    this.resetPose();
    this.resetEnemyBattlePose();
    this.hideAllProps();

    const isActionClip =
      this.clip === 'stone_hands' ||
      this.clip === 'wood' ||
      this.clip === 'mine' ||
      this.clip === 'water' ||
      this.clip === 'hunt' ||
      this.clip === 'magic' ||
      this.clip === 'fiber' ||
      this.clip === 'berries' ||
      this.clip === 'garden' ||
      this.clip === 'craft_hammer' ||
      this.clip === 'equip_adjust' ||
      this.clip === 'battle_strike' ||
      this.clip === 'battle_cast' ||
      this.clip === 'battle_enemy_strike' ||
      this.clip === 'battle_enemy_death' ||
      this.clip === 'battle_player_death' ||
      this.clip === 'hire_wave' ||
      this.clip === 'eat_meat' ||
      this.clip === 'eat_berries' ||
      this.clip === 'drink_consume' ||
      this.clip === 'bandage_apply' ||
      this.clip === 'stim_inject' ||
      this.clip === 'repair_item' ||
      this.clip === 'portal_enter';
    if (isActionClip) {
      if (this.clip === 'equip_adjust' || this.clip === 'battle_enemy_strike') {
        /* Equip / enemy turn — player holds combat idle, no hide */
        this.showIdleGear();
      } else if (this.clip === 'mine' && this.equippedPick) {
        this.shieldMount.visible = false;
        this.pickOnBelt.visible = false;
        this.pickLeftHand.visible = false;
        this.heldInRightHand.visible = false;
        this.minePickRight.visible = true;
        this.updateVanguardWizardAttachmentVisibility();
      } else {
        this.hideGearForClip();
      }
    }

    switch (this.clip) {
      case 'stone_hands': {
        this.stonePileMesh.visible = linearU > 0.05;
        {
          const t = this.harvestXZ('stone', this.activeHarvestSlotIndex);
          this.applyTravelGather(linearU, t.x, t.z, (w) => {
            this.stonePileMesh.visible = true;
            this.torso.rotation.x = 0.1 + w * 0.08;
            this.torso.rotation.y = 0.06 + w * 0.05;
            this.torso.rotation.z = -0.03 - w * 0.02;
            this.armR.rotation.x = -0.1 - w * 0.88;
            this.armR.rotation.y = -0.2 - w * 0.12;
            this.armR.rotation.z = -0.05 - w * 0.05;
            this.armL.rotation.x = 0.06 + w * 0.1;
            this.armL.rotation.y = 0;
            this.armL.rotation.z = 0.1;
            this.headRoot.rotation.x = 0.06 + w * 0.05;
            this.headRoot.rotation.y = 0.12 + w * 0.05;
          });
        }
        break;
      }
      case 'wood': {
        /* Keep target visible for the whole clip so the turn/walk reads clearly */
        this.woodTreeMesh.visible = true;
        {
          const t = this.harvestXZ('wood', this.activeHarvestSlotIndex);
          this.applyTravelGather(linearU, t.x, t.z, (w) => {
          /* Shallow lean + chin-up so the head clears the trunk; arms match stone-style forward reach (-armR.x), not +x back-swing */
          if (this.woodUsesEquippedAxe()) {
            this.propAxeGroup.visible = true;
            this.torso.rotation.x = 0.05 + w * 0.07;
            this.torso.rotation.y = 0.04;
            this.torso.rotation.z = -0.02;
            this.headRoot.rotation.x = -0.1 - w * 0.14;
            this.headRoot.rotation.y = 0.06;
            /* Base forward shoulder flexion + moderate chop arc (stays negative like stone) */
            this.armR.rotation.x = -0.14 - w * 0.62 + Math.sin(w * Math.PI) * 0.36;
            this.armR.rotation.y = -0.16 - w * 0.1;
            this.armR.rotation.z = -0.14 - w * 0.06;
            this.armL.rotation.x = 0.05 + w * 0.08;
            this.armL.rotation.z = 0.1;
            /* Strike zone lower / more in front of chest, not face height */
            this.propAxeGroup.position.set(0.04, -0.1, 0.11);
            this.propAxeGroup.rotation.set(-0.42 + w * 0.68, 0.12, 0.32);
          } else {
            this.logMesh.visible = true;
            this.torso.rotation.x = 0.06 + w * 0.08;
            this.torso.rotation.y = 0.05;
            this.torso.rotation.z = -0.02;
            this.headRoot.rotation.x = -0.08 - w * 0.12;
            this.headRoot.rotation.y = 0.05;
            this.armR.rotation.x = -0.1 - w * 0.82;
            this.armR.rotation.y = -0.18 - w * 0.1;
            this.armR.rotation.z = -0.06 - w * 0.05;
            this.armL.rotation.x = 0.06 + w * 0.1;
            this.armL.rotation.y = 0;
            this.armL.rotation.z = 0.1;
            const lift = w < 0.5 ? w / 0.5 : 1;
            /* Log held waist-chest high, forward, away from head */
            this.logMesh.position.set(0.03 + w * 0.02, -0.08 + lift * 0.05, 0.09 + w * 0.03);
            this.logMesh.rotation.set(0.08 * w, 0.12 * w, Math.PI / 2 - 0.15 * w);
          }
        });
        }
        break;
      }
      case 'mine': {
        this.rockMesh.visible = linearU > 0.05;
        {
          const t = this.harvestXZ('mine', this.activeHarvestSlotIndex);
          this.applyTravelGather(linearU, t.x, t.z, (w) => {
          this.rockMesh.visible = true;
          const hasPick = !!this.equippedPick;
          if (hasPick) {
            this.armR.rotation.x = w < 0.35 ? -0.75 - w * 1.8 : -1.35 + (w - 0.35) * 3.6;
            this.armR.rotation.z = -0.24;
            this.torso.rotation.y = 0.08 + Math.sin(w * Math.PI) * 0.08;
            this.torso.rotation.x = 0.08 + w * 0.1;
          } else {
            this.armR.rotation.x = -0.08 - w * 0.82;
            this.armR.rotation.y = -0.18 - w * 0.1;
            this.armR.rotation.z = -0.04;
            this.armL.rotation.x = 0.14 + w * 0.28;
            this.armL.rotation.z = 0.16;
            this.torso.rotation.x = 0.1 + w * 0.1;
            this.torso.rotation.y = 0.12 + Math.sin(w * Math.PI) * 0.05;
          }
          if (w > 0.45) {
            this.rockMesh.scale.setScalar(1 - (w - 0.45) * 0.35);
          } else {
            this.rockMesh.scale.setScalar(1);
          }
        });
        }
        break;
      }
      case 'fiber': {
        this.fiberBundleMesh.visible = linearU > 0.05;
        {
          const t = this.harvestXZ('fiber', this.activeHarvestSlotIndex);
          this.applyTravelGather(linearU, t.x, t.z, (w) => {
          this.fiberBundleMesh.visible = true;
          this.torso.rotation.x = 0.1 + w * 0.1;
          this.torso.rotation.y = 0.08 + w * 0.04;
          this.torso.rotation.z = -0.04;
          this.armR.rotation.x = -0.1 - w * 0.78;
          this.armR.rotation.y = -0.19 - w * 0.1;
          this.armR.rotation.z = -0.04;
          this.armL.rotation.x = 0.08 + w * 0.2;
          this.armL.rotation.z = 0.12;
          this.headRoot.rotation.y = 0.1;
        });
        }
        break;
      }
      case 'water': {
        {
          const t = this.harvestXZ('water', this.activeHarvestSlotIndex);
          this.applyTravelGather(linearU, t.x, t.z, (w) => {
          this.bucketMesh.visible = true;
          this.armR.rotation.x = -0.32 + w * 0.38;
          this.armR.rotation.z = -0.26;
          this.torso.rotation.z = Math.sin(w * Math.PI) * 0.04;
          this.torso.rotation.y = 0.04;
          this.bucketMesh.position.set(0.06, -0.05, 0.09);
          this.bucketMesh.rotation.set(0.38 + Math.sin(w * Math.PI) * 0.22, -0.1, 0.14);
        });
        }
        break;
      }
      case 'berries': {
        this.bushMesh.visible = linearU > 0.05;
        {
          const t = this.harvestXZ('berries', this.activeHarvestSlotIndex);
          this.applyTravelGather(linearU, t.x, t.z, (w) => {
          this.bushMesh.visible = true;
          this.torso.rotation.y = 0.1 + w * 0.05;
          this.torso.rotation.x = 0.09 + w * 0.09;
          this.torso.rotation.z = -0.04;
          this.armR.rotation.x = -0.12 - w * 0.85;
          this.armR.rotation.y = -0.2 - w * 0.1;
          this.armR.rotation.z = -0.04;
          this.armL.rotation.x = 0.06 + w * 0.16;
          this.armL.rotation.z = 0.12;
          this.headRoot.rotation.y = 0.12;
        });
        }
        break;
      }
      case 'hunt': {
        {
          const t = this.harvestXZ('hunt', this.activeHarvestSlotIndex);
          this.applyTravelGather(linearU, t.x, t.z, (w) => {
          this.huntPreyGroup.visible = w < 0.82;
          if (w < 0.34) {
            this.huntPreyGroup.rotation.y = Math.sin(w * 22) * 0.14;
            this.torso.rotation.y = -0.08;
            this.armR.rotation.x = -0.38;
            this.armR.rotation.z = -0.1;
            this.armL.rotation.x = -0.32;
            this.armL.rotation.z = 0.08;
          } else if (w < 0.68) {
            this.huntPreyGroup.rotation.y = 0;
            this.armR.rotation.x = -0.82 + Math.sin((w - 0.34) * 9) * 0.42;
            this.armR.rotation.z = -0.12;
            this.torso.rotation.x = 0.1;
            this.torso.rotation.y = 0.06;
          } else {
            this.meatMesh.visible = true;
            this.meatMesh.position.set(0.05, -0.05, 0.06);
            this.armR.rotation.x = -0.52 - (w - 0.68) * 0.9;
            this.armR.rotation.z = -0.14;
            this.huntPreyGroup.visible = w < 0.92;
          }
        });
        }
        break;
      }
      case 'garden': {
        this.plantMesh.visible = linearU > 0.05;
        {
          const t = this.harvestXZ('garden', this.activeHarvestSlotIndex);
          this.applyTravelGather(linearU, t.x, t.z, (w) => {
            this.plantMesh.visible = true;
            /* Squat + hip hinge only — do not lower torso.y (that drove feet through the ground). */
            const u = Math.max(0, Math.min(1, w));
            const knee = 0.1 + u * 0.42;
            this.legLMesh.rotation.x = knee;
            this.legRMesh.rotation.x = knee;
            this.footLMesh.rotation.x = -knee * 0.62;
            this.footRMesh.rotation.x = -knee * 0.62;
            this.torso.rotation.x = 0.06 + u * 0.34;
            this.torso.rotation.y = 0.07;
            this.headRoot.rotation.x = -0.05 - u * 0.2;
            this.headRoot.rotation.y = 0.04;
            this.armL.rotation.x = 0.48 + u * 0.22;
            this.armL.rotation.z = 0.12;
            this.armL.rotation.y = 0.05;
            this.armR.rotation.x = 0.52 + u * 0.26;
            this.armR.rotation.y = -0.1;
            this.armR.rotation.z = -0.1;
          });
        }
        break;
      }
      case 'magic': {
        this.orbMesh.visible = true;
        this.armL.rotation.x = -0.2 - p * 1.25;
        this.armR.rotation.x = -0.2 - p * 1.25;
        this.orbMesh.position.set(0, 0.55 + Math.sin(p * Math.PI * 2) * 0.04, 0.1);
        const mat = this.orbMesh.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0.5 + p * 1.2;
        break;
      }
      case 'craft_hammer': {
        const atCraftCampfire = this.craftHammerStation === 'campfire';
        const atCraftWorkbench = this.craftHammerStation === 'workbench';
        const atHandFieldCraft = this.craftHammerStation === 'hand';
        const cookWithTorch = atCraftCampfire && this.torchDockNightEligible();
        /* Awakened free-roam: skip the teleport-to-camp + face-station snap entirely.
         * In free-roam the player crafts WHEREVER THEY ARE — they walked across the
         * map, opened the menu, picked a recipe, and we shouldn't yank them back to
         * the camp slot every craft (or rotate their facing away from the direction
         * they were heading). The crafting animation plays in place at the avatar's
         * current XZ and current yaw. Same UX rule we already apply to the Craft-page
         * idle face-the-station rotation (gated on `!this.awakenedFreeRoam`). */
        if (!this.awakenedFreeRoam) {
          if (atCraftCampfire) {
            const { x: sx, z: sz } = this.craftCampfireStandXZ();
            this.avatar.position.x = sx;
            this.avatar.position.z = sz;
            const { x: fx, z: fz } = this.campfireWorldXZ();
            this.avatar.rotation.y = gatherFaceY(sx, sz, fx, fz);
          } else if (atCraftWorkbench) {
            const { x: sx, z: sz } = this.craftWorkbenchStandXZ();
            this.avatar.position.x = sx;
            this.avatar.position.z = sz;
            const { x: wx, z: wz } = this.workbenchWorldXZ();
            this.avatar.rotation.y = gatherFaceY(sx, sz, wx, wz);
          } else if (atHandFieldCraft) {
            /* Campfire kit, torch, etc. — same central stance as the Craft tab idle hub (no walk to fire). */
            const { x: sx, z: sz } = this.craftCentralStandXZ();
            this.avatar.position.x = sx;
            this.avatar.position.z = sz;
            const { x: px, z: pz } = this.craftCentralPivotXZ();
            this.avatar.rotation.y = gatherFaceY(sx, sz, px, pz);
          }
        }
        if (cookWithTorch) {
          /* Torch in right hand — left hand tends food toward the flames */
          this.resetTorchToRightHandGrip();
          this.armR.rotation.x = -0.26 + Math.sin(p * Math.PI * 2) * 0.05;
          this.armR.rotation.y = 0.1;
          this.armR.rotation.z = -0.2;
          this.armL.rotation.x = -0.4 + Math.sin(p * Math.PI * 2) * 0.38;
          this.armL.rotation.y = -0.06;
          this.armL.rotation.z = 0.16;
          if (this.meatMesh.parent !== this.handL) {
            this.handR.remove(this.meatMesh);
            this.handL.add(this.meatMesh);
          }
          this.meatMesh.visible = true;
          this.meatMesh.position.set(-0.05, -0.06 + Math.sin(p * Math.PI * 2) * 0.02, 0.11);
          this.meatMesh.rotation.set(-0.62 - p * 0.12, 0.12, 0.18);
        } else {
          this.armR.rotation.x = -0.48 + Math.sin(p * Math.PI * 2) * 0.48;
          this.armR.rotation.y = 0.04;
          this.armR.rotation.z = -0.16;
          this.armL.rotation.x = 0.06;
          this.armL.rotation.z = 0.1;
        }
        this.torso.rotation.x = 0.1 + Math.sin(p * Math.PI) * 0.05;
        /* Keep torso square to the station when working at it */
        this.torso.rotation.y =
          atCraftCampfire || atCraftWorkbench ? 0 : Math.sin(p * Math.PI) * 0.06;
        break;
      }
      case 'equip_adjust': {
        this.torso.rotation.z = Math.sin(p * Math.PI) * 0.08;
        this.armL.rotation.x = 0.08 + p * 0.38;
        this.armL.rotation.z = 0.1;
        this.armR.rotation.x = 0.1 + p * 0.34;
        this.armR.rotation.y = 0.05;
        this.armR.rotation.z = -0.18 + p * 0.12;
        break;
      }
      case 'battle_strike': {
        const contact = Math.sin(linearU * Math.PI);
        /* AWAKENED MODE: do NOT touch avatar.position or avatar.rotation.y. The player
         * drives both via free-roam (WASD + mouse-look). Snapping to `travelHomeX/Z` +
         * facing the dream-enemy slot would yank the avatar to a fixed XZ AND yaw to
         * face an invisible dream enemy every time the player swung — exactly the
         * "snap to a different posture / always face that direction when hitting" bug
         * the player reported. Only the limb/torso pose animates in awakened mode.
         * `tx`/`tz` (the dream-enemy rest spot) are also scoped to this block since
         * the dream-enemy positioning further down only runs in dream mode. */
        let tx = 0;
        let tz = 0;
        if (!this.awakenedFreeRoam) {
          const ax = this.travelHomeX;
          const az = this.travelHomeZ;
          const restXZ = this.getEnemyRestXZ();
          tx = restXZ.x;
          tz = restXZ.z;
          const dx = tx - ax;
          const dz = tz - az;
          const dist = Math.hypot(dx, dz) || 1;
          const ux = dx / dist;
          const uz = dz / dist;
          this.avatar.position.x = ax + ux * contact * BATTLE_PLAYER_LUNGE;
          this.avatar.position.z = az + uz * contact * BATTLE_PLAYER_LUNGE;
          this.avatar.rotation.y = gatherFaceY(this.avatar.position.x, this.avatar.position.z, tx, tz);
        }
        const strike = contact;
        this.torso.rotation.y = 0;
        const hasWeapon = this.propAxeGroup.children.length > 0;
        const kickRat = !hasWeapon && this.battleEnemyId === 'e_rat';

        if (kickRat) {
          /* Foot is parented to leg — swing toward enemy (+Z) with negative X pitch on right leg */
          this.torso.rotation.x = 0.1 + strike * 0.12;
          this.torso.rotation.z = -0.06 * strike;
          this.legRMesh.rotation.x = -0.28 - strike * 1.05;
          this.legRMesh.rotation.z = 0.06 * strike;
          this.legLMesh.rotation.x = 0.08 * strike;
          this.armL.rotation.x = 0.34 + strike * 0.26;
          this.armL.rotation.z = 0.17;
          this.armR.rotation.x = 0.4 + strike * 0.12;
          this.armR.rotation.y = 0.11;
          this.armR.rotation.z = -0.11;
        } else {
          this.torso.rotation.x = 0.06 + strike * 0.12;
          if (hasWeapon) {
            this.propAxeGroup.visible = true;
            if (this.equippedWeapon && isSwordWeaponId(this.equippedWeapon)) {
              this.propAxeGroup.position.set(0.02, -0.11, 0.12 + strike * 0.04);
              this.propAxeGroup.rotation.set(-0.55 + strike * 1.05, 0.22, 0.38);
            } else {
              this.propAxeGroup.position.set(0.03, -0.09, 0.11 + strike * 0.05);
              this.propAxeGroup.rotation.set(-0.62 + strike * 1.12, 0.14, 0.32);
            }
            this.armL.rotation.x = 0.08 + strike * 0.22;
            this.armL.rotation.z = 0.14;
            this.armR.rotation.x = -0.28 + strike * 0.35;
            this.armR.rotation.y = 0.06;
            this.armR.rotation.z = -0.14;
          } else {
            this.armR.rotation.x = -0.15 - strike * 0.95;
            this.armR.rotation.y = 0.04;
            this.armR.rotation.z = -0.1;
            this.armL.rotation.x = 0.06 + strike * 0.28;
            this.armL.rotation.z = 0.12;
          }
        }
        /* Dream-mode enemy positioning + rig flinch — only meaningful in dream battles
         * where the dream enemy is on screen. Skipped in awakened mode (no dream
         * enemyRoot to position; mob hit feedback comes from awakenedMobs.ts +
         * damageFloaters instead). */
        if (!this.awakenedFreeRoam && this.enemyRoot.visible) {
          this.enemyRoot.position.set(tx, 0, tz);
          this.enemyRoot.rotation.y = gatherFaceY(tx, tz, this.avatar.position.x, this.avatar.position.z);
          if (this.battleEnemyId === 'e_rat') {
            this.enemyRoot.rotation.z = Math.sin(strike * Math.PI) * 0.18;
          } else {
            this.enemyRoot.rotation.z = 0;
          }
        }
        const hitPeak = strike * strike;
        if (!this.awakenedFreeRoam && this.enemyBattleRig) {
          const er = this.enemyBattleRig;
          er.headRoot.rotation.x = 0.2 * hitPeak + 0.08 * strike;
          er.headRoot.rotation.z = -0.11 * hitPeak;
          er.headRoot.rotation.y = 0.06 * strike;
          er.torso.rotation.z = -0.07 * strike;
          er.armL.rotation.x = 0.06 + strike * 0.14;
          er.armL.rotation.z = 0.1;
        }
        const enemyBloodPreset =
          this.battleEnemyId === 'e_rat'
            ? 'enemy_rat_torso'
            : this.enemyBattleRig
              ? 'enemy_human_face_drip'
              : 'default';
        this.updateBattleBlood(hitPeak, 'enemy', enemyBloodPreset);
        break;
      }
      case 'battle_cast': {
        const contact = Math.sin(linearU * Math.PI);
        /* AWAKENED MODE: same gating as battle_strike — no position teleport, no yaw
         * snap. The casting motion comes through arms + battleSpark only; the avatar
         * stays where the player put it, facing where the player is looking. `tx`/`tz`
         * carry through to the enemyRoot block but only meaningful in dream mode. */
        let tx = 0;
        let tz = 0;
        if (!this.awakenedFreeRoam) {
          const ax = this.travelHomeX;
          const az = this.travelHomeZ;
          const restXZ = this.getEnemyRestXZ();
          tx = restXZ.x;
          tz = restXZ.z;
          const dx = tx - ax;
          const dz = tz - az;
          const dist = Math.hypot(dx, dz) || 1;
          const ux = dx / dist;
          const uz = dz / dist;
          const castLunge = BATTLE_PLAYER_LUNGE * 0.72;
          this.avatar.position.x = ax + ux * contact * castLunge;
          this.avatar.position.z = az + uz * contact * castLunge;
          this.avatar.rotation.y = gatherFaceY(this.avatar.position.x, this.avatar.position.z, tx, tz);
        }
        this.battleSpark.visible = true;
        this.armL.rotation.x = -0.42 - p * 0.32;
        this.armL.rotation.z = 0.12;
        this.armR.rotation.x = -0.42 - p * 0.32;
        this.armR.rotation.z = -0.12;
        this.battleSpark.position.set(
          0.04 + contact * 0.08,
          0.44 + contact * 0.06,
          0.2 + contact * 0.1,
        );
        const sm = this.battleSpark.material as THREE.MeshStandardMaterial;
        sm.emissiveIntensity = 0.6 + p * 1.4;
        this.torso.rotation.y = 0;
        this.torso.rotation.x = 0.04 + p * 0.06;
        /* Dream-only enemy positioning — skipped in awakened mode (no dream enemyRoot). */
        if (!this.awakenedFreeRoam && this.enemyRoot.visible) {
          this.enemyRoot.position.set(tx, 0, tz);
          this.enemyRoot.rotation.y = gatherFaceY(tx, tz, this.avatar.position.x, this.avatar.position.z);
        }
        break;
      }
      case 'battle_enemy_strike': {
        /* Enemy lunges toward player's rest spot; player stays at travel home */
        const contact = Math.sin(linearU * Math.PI);
        const px = this.travelHomeX;
        const pz = this.travelHomeZ;
        const ex0 = this.enemyStrikeAnchorX;
        const ez0 = this.enemyStrikeAnchorZ;
        const dx = px - ex0;
        const dz = pz - ez0;
        const dist = Math.hypot(dx, dz) || 1;
        const ux = dx / dist;
        const uz = dz / dist;
        this.enemyRoot.position.x = ex0 + ux * contact * BATTLE_ENEMY_LUNGE;
        this.enemyRoot.position.z = ez0 + uz * contact * BATTLE_ENEMY_LUNGE;
        this.enemyRoot.rotation.y = gatherFaceY(
          this.enemyRoot.position.x,
          this.enemyRoot.position.z,
          px,
          pz,
        );
        this.avatar.position.x = px;
        this.avatar.position.z = pz;
        this.avatar.rotation.y = gatherFaceY(px, pz, this.enemyRoot.position.x, this.enemyRoot.position.z);
        const punch = contact;
        const peak = punch * punch;

        if (this.battleEnemyId === 'e_rat') {
          /* Bite on lead leg — foot follows leg; rotation-only flinch */
          this.torso.rotation.x = -0.14 * peak - 0.05 * punch;
          this.torso.rotation.z = 0.08 * punch;
          this.legLMesh.rotation.x = 0.52 * peak + 0.22 * punch;
          this.legLMesh.rotation.z = -0.06 * peak;
          this.headRoot.rotation.x = 0.14 * peak + 0.05 * punch;
          this.headRoot.rotation.y = -0.07 * punch;
          this.headRoot.rotation.z = 0.05 * punch;
          this.armL.rotation.x = 0.52 * peak + 0.1 * punch;
          this.armL.rotation.z = 0.24;
          this.armR.rotation.x = 0.18 + 0.15 * punch;
          this.armR.rotation.z = -0.12;
        } else {
          this.torso.rotation.x = contact * 0.07;
          this.torso.rotation.z = -contact * 0.05;
          if (this.enemyBattleRig) {
            const er = this.enemyBattleRig;
            er.armR.rotation.x = -0.18 - punch * 1.02;
            er.armR.rotation.y = 0.07;
            er.armR.rotation.z = -0.13;
            er.armL.rotation.x = 0.12 + punch * 0.18;
            er.armL.rotation.z = 0.12;
            er.torso.rotation.x = punch * 0.06;
          }
          /* Deserter / wolf melee to face */
          this.headRoot.rotation.x = -0.38 * peak - 0.12 * punch;
          this.headRoot.rotation.z = 0.14 * peak;
          this.headRoot.rotation.y = -0.09 * punch;
        }

        const playerBloodPreset =
          this.battleEnemyId === 'e_rat' ? 'player_leg' : 'player_face_spew';
        this.updateBattleBlood(peak, 'player', playerBloodPreset);
        break;
      }
      case 'battle_enemy_death': {
        this.hideGearForClip();
        const ax = this.travelHomeX;
        const az = this.travelHomeZ;
        const { x: tx, z: tz } = this.getEnemyRestXZ();
        this.avatar.position.x = ax;
        this.avatar.position.z = az;
        this.avatar.rotation.y = gatherFaceY(ax, az, tx, tz);
        const fall = easeInOut(bloodSmoothstep(0.06, 0.94, linearU));
        const thud = bloodSmoothstep(0.48, 1, linearU);
        if (this.enemyRoot.visible) {
          const facePlayer = gatherFaceY(tx, tz, ax, az);
          this.enemyRoot.rotation.order = 'YXZ';
          this.enemyRoot.rotation.y = facePlayer;
          if (this.battleEnemyId === 'e_rat' || this.battleEnemyId === 'e_wolf') {
            /* Roll onto side (barrel around long axis) — avoid large pitch that buries snout in floor */
            const roll = fall * 1.12;
            const tip = fall * 0.22;
            this.enemyRoot.rotation.x = tip;
            this.enemyRoot.rotation.z = roll + Math.sin(linearU * Math.PI * 1.5) * 0.05;
            this.enemyRoot.position.set(tx, 0.022 * thud, tz);
          } else {
            this.enemyRoot.position.set(tx, -0.032 * thud, tz);
            this.enemyRoot.rotation.x = fall * 1.06;
            this.enemyRoot.rotation.z = (-0.24 - fall * 0.26) * (1 - 0.18 * Math.cos(linearU * Math.PI));
          }
          if (this.enemyBattleRig) {
            const er = this.enemyBattleRig;
            const limp = fall;
            er.torso.rotation.x = limp * 0.2;
            er.torso.rotation.z = limp * 0.14;
            er.headRoot.rotation.x = limp * 0.64;
            er.headRoot.rotation.z = limp * 0.3;
            er.headRoot.rotation.y = limp * -0.2;
            er.armL.rotation.x = limp * 0.74;
            er.armL.rotation.z = limp * 0.1;
            er.armR.rotation.x = -limp * 0.58;
            er.armR.rotation.z = -limp * 0.22;
          }
        }
        const goreRamp = Math.max(0.22, bloodSmoothstep(0.1, 0.78, linearU) * 0.92 + 0.1);
        this.updateBattleBlood(goreRamp, 'enemy', this.enemyDeathBloodPreset());
        this.torso.rotation.x = 0.04 + fall * 0.06;
        this.torso.rotation.z = -fall * 0.04;
        this.armL.rotation.x = 0.08 + fall * 0.05;
        this.armL.rotation.z = 0.1;
        this.armR.rotation.x = 0.1 + fall * 0.04;
        this.armR.rotation.z = -0.08;
        this.headRoot.rotation.x = fall * 0.05;
        break;
      }
      case 'battle_player_death': {
        this.hideGearForClip();
        const px = this.travelHomeX;
        const pz = this.travelHomeZ;
        const { x: ex, z: ez } = this.getEnemyRestXZ();
        this.avatar.position.x = px;
        this.avatar.position.z = pz;
        this.avatar.rotation.y = gatherFaceY(px, pz, ex, ez);
        const fall = easeInOut(bloodSmoothstep(0.05, 0.96, linearU));
        const slump = fall * fall;
        this.torso.rotation.x = fall * 1.02;
        this.torso.rotation.z = -fall * 0.14;
        this.headRoot.rotation.x = slump * 0.42;
        this.headRoot.rotation.z = fall * 0.26;
        this.headRoot.rotation.y = -fall * 0.12;
        this.legLMesh.rotation.x = fall * 0.88;
        this.legRMesh.rotation.x = -fall * 0.42;
        this.legLMesh.rotation.z = fall * 0.1;
        this.legRMesh.rotation.z = -fall * 0.06;
        this.armL.rotation.x = fall * 0.58;
        this.armL.rotation.z = 0.12;
        this.armR.rotation.x = -fall * 0.32;
        this.armR.rotation.z = -fall * 0.18;
        if (this.enemyRoot.visible) {
          this.enemyRoot.position.set(ex, 0, ez);
          this.enemyRoot.rotation.order = 'YXZ';
          this.enemyRoot.rotation.x = 0;
          this.enemyRoot.rotation.z = 0;
          this.enemyRoot.rotation.y = gatherFaceY(ex, ez, px, pz);
          if (this.enemyBattleRig) {
            const er = this.enemyBattleRig;
            const relax = fall;
            er.armR.rotation.x = -0.16 - relax * 0.12;
            er.armR.rotation.z = -0.12;
            er.armL.rotation.x = 0.1 + relax * 0.08;
            er.torso.rotation.x = relax * 0.04;
          }
        }
        const gore = bloodSmoothstep(0.12, 0.75, linearU);
        const preset = this.battleEnemyId === 'e_rat' ? 'player_leg' : 'player_face_spew';
        this.updateBattleBlood(0.28 + gore * 0.7, 'player', preset);
        break;
      }
      case 'hire_wave': {
        this.armR.rotation.x = -0.85 + Math.sin(p * Math.PI * 2) * 0.35;
        this.armR.rotation.z = -0.55;
        this.headRoot.rotation.y = Math.sin(p * Math.PI) * 0.1;
        this.torso.rotation.z = Math.sin(p * Math.PI) * 0.06;
        break;
      }
      case 'eat_meat': {
        /* Left hand — torch stays on right at night */
        this.rationMesh.visible = true;
        this.rationMesh.position.set(-0.04, -0.05 + p * 0.07, 0.055);
        this.rationMesh.rotation.set(-0.35 * p, -0.15 * p, -0.08);
        this.armL.rotation.x = -0.52 - p * 0.42;
        this.armL.rotation.z = 0.2;
        this.armR.rotation.x = 0.06;
        this.armR.rotation.z = -0.1;
        this.headRoot.rotation.x = 0.1 + p * 0.2;
        break;
      }
      case 'eat_berries': {
        this.berrySnackMesh.visible = true;
        this.berrySnackMesh.position.set(-0.03, -0.04 + p * 0.05, 0.065);
        this.armL.rotation.x = -0.42 - p * 0.38;
        this.armL.rotation.z = 0.15;
        this.armR.rotation.x = 0.06;
        this.armR.rotation.z = -0.1;
        this.headRoot.rotation.x = 0.08 + p * 0.14;
        break;
      }
      case 'drink_consume': {
        this.waterskinMesh.visible = true;
        this.waterskinMesh.position.set(-0.02, -0.1 + p * 0.05, 0.075);
        this.waterskinMesh.rotation.set(-0.45 - p * 0.35, -0.1, -0.12);
        this.armL.rotation.x = -0.48 - p * 0.48;
        this.armL.rotation.z = 0.22;
        this.armR.rotation.x = 0.06;
        this.armR.rotation.z = -0.1;
        this.headRoot.rotation.x = 0.06 + p * 0.12;
        break;
      }
      case 'bandage_apply': {
        this.bandageMesh.visible = true;
        /* Left hand — wrap toward torso */
        this.bandageMesh.position.set(0.04, -0.06 + p * 0.04, 0.05);
        this.bandageMesh.rotation.set(-0.15 * p, 0.2 * p, 0.35);
        this.armL.rotation.x = -0.2 - p * 0.62;
        this.armL.rotation.z = 0.42 - p * 0.08;
        this.torso.rotation.y = -0.08;
        this.headRoot.rotation.y = -0.06;
        break;
      }
      case 'stim_inject': {
        this.stimMesh.visible = true;
        this.stimMesh.position.set(0.05, -0.08, 0.065);
        this.stimMesh.rotation.set(0.2, 0, -0.35);
        this.armR.rotation.x = -0.38 - p * 0.5;
        this.armR.rotation.z = -0.22;
        this.torso.rotation.x = 0.05;
        break;
      }
      case 'repair_item': {
        this.armR.rotation.x = -0.52 + Math.sin(p * Math.PI * 2) * 0.52;
        this.armR.rotation.z = -0.32;
        this.torso.rotation.x = 0.1 + Math.sin(p * Math.PI) * 0.07;
        this.torso.rotation.y = Math.sin(p * Math.PI) * 0.08;
        break;
      }
      case 'portal_enter': {
        this.hideGearForClip();
        /* Walk toward -Z into the plasma gate (camera sits at +Z). Plasma animates via loop(). */
        const tgtX = 0.012;
        const tgtZ = -0.3;
        const faceY = gatherFaceY(this.travelHomeX, this.travelHomeZ, tgtX, tgtZ);
        const step = easeInOut(Math.min(1, linearU / 0.9));
        const turnEnd = 0.16;
        if (linearU < turnEnd) {
          const tt = easeInOut(linearU / turnEnd);
          this.avatar.rotation.y = lerpYaw(this.travelHomeRotY, faceY, tt);
        } else {
          this.avatar.rotation.y = faceY;
        }
        this.avatar.position.x = THREE.MathUtils.lerp(this.travelHomeX, tgtX, step);
        this.avatar.position.z = THREE.MathUtils.lerp(this.travelHomeZ, tgtZ, step);
        const walkPhase = step * Math.PI * 11;
        const swing = Math.sin(walkPhase) * 0.46;
        this.torso.position.y = this.baseTorsoY + Math.abs(Math.sin(walkPhase * 2)) * 0.026;
        this.torso.rotation.x = 0.045;
        this.torso.rotation.z = Math.sin(walkPhase) * 0.042;
        this.armL.rotation.x = 0.26 + swing;
        this.armR.rotation.x = 0.26 - swing;
        this.armL.rotation.z = 0.11;
        this.armR.rotation.z = -0.1;
        this.headRoot.rotation.x = Math.sin(walkPhase * 0.5) * 0.055;
        if (linearU > 0.74) {
          const shrinkT = (linearU - 0.74) / 0.26;
          const sc = 1 - easeInOut(shrinkT) * 0.92;
          this.avatar.scale.setScalar(Math.max(0.04, sc));
        } else {
          this.avatar.scale.setScalar(1);
        }
        break;
      }
      default:
        break;
    }

    const craftCookTorchActive =
      this.clip === 'craft_hammer' &&
      this.pageContext === 'craft' &&
      this.craftHammerStation === 'campfire' &&
      this.playing &&
      this.torchDockNightEligible();
    if (
      (this.pageContext === 'gather' && this.playing && this.gatherTorchNightEligible()) ||
      craftCookTorchActive
    ) {
      this.handTorchLPCA!.group.visible = true;
      if (craftCookTorchActive) this.resetTorchToRightHandGrip();
      else this.syncGatherTorchHandParent();
    }
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    /* User-configurable FPS cap (set via the ESC menu Performance section). When the
     * cap is hit, skip the entire render — RAF loop continues so we re-check next
     * paint. lastTime is NOT updated on skipped frames so the next frame's dt
     * accurately reflects the elapsed time since the last actual render. */
    if (shouldSkipFrameForFpsCap(now)) return;
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;

    const frameMs = dt * 1000;
    this.dockPerfEmaMs = this.dockPerfEmaMs * 0.88 + frameMs * 0.12;
    if (this.dockPerfEmaMs > 26) this.dockPerfScale = Math.max(0.62, this.dockPerfScale - 0.014);
    else if (this.dockPerfEmaMs < 17.5) this.dockPerfScale = Math.min(1, this.dockPerfScale + 0.009);

    const prevCampfireHold = this.craftCampfireRevealHold;
    const prevWorkbenchHold = this.craftWorkbenchRevealHold;
    const prevTorchAfterDecor = this.torchAfterHeavyDecorFrames;

    if (this.craftCampfireRevealHold > 0) this.craftCampfireRevealHold--;
    if (this.craftWorkbenchRevealHold > 0) this.craftWorkbenchRevealHold--;

    const hadHoldBeforeDec = prevCampfireHold > 0 || prevWorkbenchHold > 0;
    const hasHoldNow = this.craftCampfireRevealHold > 0 || this.craftWorkbenchRevealHold > 0;
    if (hadHoldBeforeDec && !hasHoldNow) {
      this.torchAfterHeavyDecorFrames = Math.max(this.torchAfterHeavyDecorFrames, 10);
    }

    if (this.torchAfterHeavyDecorFrames > 0) this.torchAfterHeavyDecorFrames--;

    if (prevTorchAfterDecor > 0 && this.torchAfterHeavyDecorFrames === 0) {
      this.applyTorchCarryOverride();
    }

    setDockCraftVisualBusy(
      (this.playing && this.clip === 'craft_hammer') ||
        this.pendingDockCraft != null ||
        this.dockHeavyVisualStaggerActive(),
    );
    let stress = this.dockPerfScale;
    if (isDockVisualLowBudget()) stress = Math.min(stress, 0.86);
    if (this.dockEnvironment?.isTwilightBlendHeavy()) stress = Math.min(stress, 0.91);
    if (isDockVisualLowBudget() && this.dockEnvironment?.isTwilightBlendHeavy()) {
      stress = Math.min(stress, 0.78);
    }
    this.dockEnvironment?.setPerfStressScale(stress);

    /* Awakened-mode footstep SFX — fires REGARDLESS of clip state so footsteps keep
     * sounding while a chop / mine / pluck animation plays. Lives here (above the
     * playing/idle dispatch) instead of inside `applyIdle` (which is skipped during a
     * clip) — fixes the "harvest interrupts footsteps then catches up with a double
     * step on clip end" issue. The body-pose walk cycle still lives in `applyIdle`
     * because those bones are owned by the clip while it plays. */
    this.tickAwakenedFootsteps(dt);

    if (this.playing && this.clip !== 'idle') {
      const dur = CLIP_DURATION[this.clip];
      /* In-place harvest skips the walk-out / walk-back phases entirely (handled in
       * `applyTravelGather` line ~5648) — only the work motion matters. We boost the
       * clip advancement so the FULL clip duration collapses to
       * `IN_PLACE_HARVEST_TARGET_SEC` of wall-clock time, regardless of the underlying
       * clip length. Previously this used a fixed 1/0.34 ≈ 2.94× boost which left
       * `wood` (5.15 s clip) playing in ~1.75 s — the user-reported "loop takes too
       * long" feel. Now every harvest swing finishes in ~0.55 s and the player can
       * mash E for a satisfying chop / mine / pick cadence. */
      const inPlaceBoost = this.inPlaceHarvestActive
        ? dur / IN_PLACE_HARVEST_TARGET_SEC
        : 1;
      this.clipTime += dt * this.clipSpeedMultiplier * inPlaceBoost;
      const u = this.clipTime / dur;
      if (u >= 1) {
        const endedClip = this.clip;
        if (
          (endedClip === 'battle_strike' || endedClip === 'battle_cast') &&
          this.pendingEnemyDeathAfterStrike
        ) {
          this.pendingEnemyDeathAfterStrike = false;
          this.clipTime = 0;
          this.startClip('battle_enemy_death');
        } else {
          const endedMine = endedClip === 'mine';
          const endedPortal = endedClip === 'portal_enter';
          const endedPlayerBattle =
            endedClip === 'battle_strike' || endedClip === 'battle_cast';
          const endedEnemyBattle = endedClip === 'battle_enemy_strike';
          const endedEnemyDeath = endedClip === 'battle_enemy_death';
          const endedPlayerDeath = endedClip === 'battle_player_death';
          const endedCraftStation = endedClip === 'craft_hammer' ? this.craftHammerStation : null;

          /* Capture before we clear `inPlaceHarvestActive` — used below to skip the
           * end-of-clip "snap avatar back to travelHomeX/Z" teleport, since WASD may have
           * moved the player during the (short) work animation and we don't want to yank
           * them back to where they pressed E. */
          const endedInPlace = this.inPlaceHarvestActive;
          this.playing = false;
          this.clip = 'idle';
          this.clipTime = 0;
          /* Clear awakened-mode in-place override so subsequent deck-mode gathers (e.g.
           * after returning to the dream-prison) read real harvest slot positions again. */
          this.inPlaceHarvestActive = false;
          /* Fire and clear the in-place callback (corpse despawn, loot grant, etc.) AFTER
           * the work animation has finished. We snapshot + clear before invoking so a
           * callback that triggers another clip doesn't accidentally re-fire itself. */
          if (endedInPlace && this.inPlaceCompleteCb) {
            const cb = this.inPlaceCompleteCb;
            this.inPlaceCompleteCb = null;
            try {
              cb();
            } catch (err) {
              console.error('[scenePreview] in-place harvest onComplete threw:', err);
            }
          }
          if (endedClip === 'craft_hammer') this.craftHammerStation = null;
          if (TRAVEL_GATHER_CLIPS.has(endedClip)) {
            setDockTravelGatherClipActive(false);
          }
          this.rockMesh.scale.setScalar(1);
          if (endedMine) {
            disposeGroupContents(this.minePickRight);
            this.minePickRight.visible = false;
          }
          if (endedPortal) {
            this.portalExitPending = true;
            this.portalVfx.visible = false;
            this.avatar.scale.set(1, 1, 1);
            this.avatar.position.x = this.travelHomeX;
            this.avatar.position.z = this.travelHomeZ;
            this.avatar.rotation.y = this.travelHomeRotY;
            /* Official Vibe Jam 2026 exit: hub picks next game; listener in main.ts calls location.assign. */
            window.dispatchEvent(new CustomEvent('vibejam-portal-exit'));
            return;
          }
          if (endedEnemyDeath) {
            this.battleEnemyCorpseFallen = true;
          }
          if (endedPlayerDeath) {
            window.dispatchEvent(new CustomEvent('battle-player-death-done'));
          } else {
            if (endedPlayerBattle || endedEnemyBattle) {
              this.travelHomeRotY = this.hunterSharedWorldActive ? 0 : dockSoloIdleFaceYawRad();
            }
            if (
              endedClip === 'craft_hammer' &&
              this.pageContext === 'craft' &&
              (endedCraftStation === 'campfire' || endedCraftStation === 'workbench')
            ) {
              this.craftReturnToHub = true;
            }
            /* craft_hammer / equip_adjust keep the avatar where the clip left them so dock idle can walk to stations or home. */
            const keepPoseAfterClip = endedClip === 'craft_hammer' || endedClip === 'equip_adjust';
            /* In-place awakened harvest also keeps current pose — WASD may have moved
             * the avatar during the brief work animation; snapping back would yank them
             * to where they pressed E. */
            if (!keepPoseAfterClip && !endedInPlace) {
              this.avatar.position.x = this.travelHomeX;
              this.avatar.position.z = this.travelHomeZ;
              this.avatar.rotation.y = this.travelHomeRotY;
            }
            if (this.enemyRoot.visible && (endedPlayerBattle || endedEnemyBattle)) {
              const erb = this.getEnemyRestXZ();
              this.enemyRoot.position.set(erb.x, 0, erb.z);
            }
            /* Snapshot the limb pose the just-ended clip left the avatar in,
             * then start the post-clip blend timer. `applyIdle(dt)` (called
             * immediately below + every subsequent frame until the timer
             * elapses) will lerp from this snapshot toward the computed idle
             * pose so the harvest → idle transition reads as a smooth settle
             * instead of a single-frame snap. */
            this.captureCurrentPoseForPostClipBlend();
            this.postClipBlendT = 0;
            this.applyIdle(dt);
          }
        }
      } else {
        this.applyClipProgress(u);
        /* Awakened in-place harvest — clip dispatchers eagerly toggle WORLD props
         * (stonePile, woodTree, rock, fiberBundle, bush, plant, huntPrey) on so they're
         * visible during the deck-mode "walk to target" leg. Those meshes live at the
         * deck-mode harvest-slot XZ (often near the dock home), so in awakened mode they
         * suddenly POP into view somewhere off-screen / behind the avatar — reads as a
         * blur / phantom motion in the background. Force them hidden after each frame's
         * dispatch so only the hand-attached props (bucket, axe, log, pick, meat, orb)
         * remain visible. */
        if (this.inPlaceHarvestActive) {
          this.stonePileMesh.visible = false;
          this.woodTreeMesh.visible = false;
          this.rockMesh.visible = false;
          this.fiberBundleMesh.visible = false;
          this.bushMesh.visible = false;
          this.plantMesh.visible = false;
          this.huntPreyGroup.visible = false;
        }
      }
    } else {
      this.applyIdle(dt);
    }

    if (!this.playing && this.clip === 'idle') {
      this.tryConsumePendingDockCraft();
    }

    this.smoothHunterPeerFigure(dt);
    this.smoothAwakenCoopPeers(dt);
    this.tickBattleBlood(dt);

    const onPortalPage = this.pageContext === 'portal';
    const inPortalClip = this.playing && this.clip === 'portal_enter';
    const showPortal = (onPortalPage || inPortalClip) && !this.portalExitPending;
    this.portalVfx.visible = showPortal;
    const portalProgress = inPortalClip
      ? Math.min(1, this.clipTime / CLIP_DURATION.portal_enter)
      : onPortalPage
        ? 0.14
        : 0;
    if (showPortal && this.portalPlasma) {
      this.portalPlasma.tick(now * 0.001, portalProgress);
    }

    if (this.craftDecorGroup.visible && this.hasCraftCampfire && this.campfireLPCA) {
      this.campfireLPCA.tick(now * 0.001);
    }
    if (this.handTorchLPCA?.group.visible) {
      this.handTorchLPCA.tick(now * 0.001);
    }

    this.vanguardStaffOrbVfx.update(dt);

    /* Skip the per-frame foot-snap while the player is mid-jump in awakened mode —
     * `freeRoamControls` owns avatar.y during the jump arc and the snap would otherwise
     * cancel the jump's vertical velocity every frame (Space appearing to do nothing). */
    if (!(this.awakenedFreeRoam && this.freeRoamAirborne)) {
      this.syncAvatarFeetToTerrain();
    }
    if (this.isSoloForestDockFraming()) {
      this.refreshSoloDockFramingFromAvatar();
      if (this.dockKeyLight) {
        this.dockKeyLight.target.position.set(
          this.avatar.position.x,
          this.avatar.position.y + 0.12,
          this.avatar.position.z,
        );
      }
    }
    /* Smooth camera state (orbit/pan/zoom targets → displayed values) BEFORE
     * applyCameraFraming reads them, so each frame's camera pose reflects the
     * most up-to-date smoothed value. See `tickCameraSmoothing` for the math. */
    this.tickCameraSmoothing(dt);
    this.applyCameraFraming();
    const dockPreviewProbe = createDockPreviewProbe();
    this.dockEnvironment?.update(dt, this.empireProject, this.camera);
    /* Sync the night-grade post pass (Phase 8h §4) to the day/night state
     * the dock env just computed. setPassEnabled toggle keeps the program
     * cached when not actively grading. The Esc-tunable `nightGradeMul`
     * multiplies the effective `nightMix` so a value of 0 disables the
     * grade entirely, 0.5 makes nights subtler, 1.5 cranks the moonlight
     * stylization. */
    if (this.nightGradePass && this.dockEnvironment) {
      const nightMix = this.dockEnvironment.getNightMix();
      const strength = this.dockEnvironment.getNightGradeStrength();
      syncNightGradeUniforms(
        this.nightGradePass,
        nightMix * strength,
        this.dockEnvironment.getMoonIllum(),
      );
    }
    /* Animated forest props (sky-crystal seal rotation, etc). */
    for (const tick of this.sceneTickers) tick(dt);
    dockPreviewProbe?.split('envUpdate');
    if (!this.suppressPresentation) {
      this.renderer.toneMappingExposure =
        this.baseToneMappingExposure * (this.dockEnvironment?.getExposureMultiplier() ?? 1);
      dockPreviewProbe?.split('toneExposure');
      if (this.postProcessing) {
        this.postProcessing.render();
        dockPreviewProbe?.split('postStackRender');
      } else {
        this.renderer.render(this.scene, this.camera);
        dockPreviewProbe?.split('directRender');
      }
    }
    dockPreviewProbe?.finish();
    this.previewCompletedRenders++;
    if (this.previewCompletedRenders === 3) {
      this.applyTorchCarryOverride();
    }
  };
}
