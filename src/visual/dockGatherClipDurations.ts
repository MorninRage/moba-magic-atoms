/**
 * Shared gather-clip wall-clock math for {@link CharacterScenePreview} and
 * {@link CharacterSceneHost} (worker dock) — keeps loot / SFX timing consistent
 * when main does not run a second preview scene.
 */
import { actionIdToHarvestKind, type HarvestNodeKind } from '../world/idleCraftHarvestNodes';

const TR_WALK1 = 0.38;

function inverseEaseInOut(y: number): number {
  const x = Math.max(0, Math.min(1, y));
  if (x < 0.5) return Math.sqrt(x / 2);
  return 1 - Math.sqrt((1 - x) / 2);
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
      return 'stone_hands';
    case 'tend_garden':
      return 'garden';
    case 'ley_residue':
      return 'magic';
    default:
      return 'idle';
  }
}

/**
 * @param gatherDurationByKind — optional per-kind multipliers; defaults to 1.
 */
export function getDockGatherClipDurationMs(
  actionId: string,
  clipSpeedMultiplier: number,
  gatherDurationByKind?: Partial<Record<HarvestNodeKind, number>>,
): number {
  const next = actionIdToClip(actionId);
  if (next === 'idle') return 0;
  const baseMs = (CLIP_DURATION[next] * 1000) / clipSpeedMultiplier;
  const kind = actionIdToHarvestKind(actionId);
  const f = kind ? gatherDurationByKind?.[kind] ?? 1 : 1;
  return baseMs * f;
}

export function getDockGatherSfxDelayMs(
  actionId: string,
  clipSpeedMultiplier: number,
  gatherDurationByKind?: Partial<Record<HarvestNodeKind, number>>,
): number {
  const next = actionIdToClip(actionId);
  if (next === 'idle' || !TRAVEL_GATHER_CLIPS.has(next)) return 0;
  const kind = actionIdToHarvestKind(actionId);
  const f = kind ? gatherDurationByKind?.[kind] ?? 1 : 1;
  const totalMs = ((CLIP_DURATION[next] * 1000) / clipSpeedMultiplier) * f;
  return totalMs * inverseEaseInOut(TR_WALK1);
}
