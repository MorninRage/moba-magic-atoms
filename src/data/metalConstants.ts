/**
 * Pick precedence (best first). Must match item ids in content / inventory.
 */
/** Best pick first: stone < copper < bronze < brass < iron < steel < silver < gold < platinum */
export const PICK_TIER_ORDER: readonly string[] = [
  'platinum_pickaxe',
  'gold_pickaxe',
  'silver_pickaxe',
  'steel_pickaxe',
  'iron_pickaxe',
  'brass_pickaxe',
  'bronze_pickaxe',
  'copper_pickaxe',
  'pickaxe',
];

/** Multiplier for iron/coal/copper/tin/zinc/silver/gold/platinum ore gathers (bare hands use ORE_BARE_HANDS_MULT in gameStore) */
export const PICK_ORE_YIELD_MULT: Record<string, number> = {
  platinum_pickaxe: 2.22,
  gold_pickaxe: 2.02,
  silver_pickaxe: 1.82,
  steel_pickaxe: 1.62,
  iron_pickaxe: 1.42,
  brass_pickaxe: 1.38,
  bronze_pickaxe: 1.22,
  copper_pickaxe: 1.1,
  pickaxe: 1,
};

/** Stone gather: absolute scale (legacy pickaxe ≈ 1.98× base 0.46) */
export const PICK_STONE_YIELD_MULT: Record<string, number> = {
  platinum_pickaxe: 4.35,
  gold_pickaxe: 4.05,
  silver_pickaxe: 3.78,
  steel_pickaxe: 3.48,
  iron_pickaxe: 3.2,
  brass_pickaxe: 3.12,
  bronze_pickaxe: 2.78,
  copper_pickaxe: 2.45,
  pickaxe: 1.98,
};

export const PICK_WEAR_FACTOR: Record<string, number> = {
  platinum_pickaxe: 0.62,
  gold_pickaxe: 0.66,
  silver_pickaxe: 0.7,
  steel_pickaxe: 0.78,
  iron_pickaxe: 0.92,
  brass_pickaxe: 0.84,
  bronze_pickaxe: 0.88,
  copper_pickaxe: 0.96,
  pickaxe: 1,
};

/** Equipped weapon → flat PvE damage bonus (fist/weapon cards) */
export const WEAPON_DAMAGE_BONUS: Record<string, number> = {
  platinum_sword: 15,
  gold_sword: 12,
  silver_sword: 9,
  steel_sword: 7,
  bronze_sword: 5,
  iron_sword: 4,
  steel_axe: 4,
  brass_axe: 3,
  bronze_axe: 3,
  copper_axe: 2,
  iron_axe: 2,
  axe: 1,
};

/** Equipped axe → wood gather multiplier (× base 0.52) */
export const AXE_WOOD_MULT: Record<string, number> = {
  steel_axe: 3.45,
  iron_axe: 2.95,
  brass_axe: 2.45,
  bronze_axe: 2.25,
  copper_axe: 2.05,
  axe: 1.9,
};

/** Per swing durability loss for swords in PvE */
export const SWORD_BATTLE_WEAR: Record<string, number> = {
  platinum_sword: 0.22,
  gold_sword: 0.28,
  silver_sword: 0.34,
  steel_sword: 0.42,
  bronze_sword: 0.46,
  iron_sword: 0.5,
};

export const AXE_BATTLE_WEAR: Record<string, number> = {
  steel_axe: 0.55,
  iron_axe: 0.65,
  brass_axe: 0.7,
  bronze_axe: 0.74,
  copper_axe: 0.78,
  axe: 0.8,
};

/** Best axe in bag for hunt wear (first owned). */
export const AXE_TIER_ORDER: readonly string[] = [
  'steel_axe',
  'iron_axe',
  'brass_axe',
  'bronze_axe',
  'copper_axe',
  'axe',
];
