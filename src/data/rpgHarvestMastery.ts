/**
 * Harvest RPG: per-vein mastery (travel / yield / regrowth), vein strain, and seal at expedition cap.
 */
import type { HarvestNodeKind } from '../world/idleCraftHarvestNodes';
import { HARVEST_NODE_KINDS } from '../world/idleCraftHarvestNodes';

export const HARVEST_MASTERY_MAX_TIER = 5;

export type MasteryBranch = 'travel' | 'yield' | 'regrowth';

export type PerKindHarvestMastery = {
  travel: number;
  yield: number;
  regrowth: number;
};

export type HarvestMasteryState = Record<string, PerKindHarvestMastery>;

/** Strain at or above this seals the vein (no respawns until new camp). */
export const SEAL_STRAIN_CAP = 620;

export function createInitialHarvestMastery(): HarvestMasteryState {
  const out: HarvestMasteryState = {};
  for (const k of HARVEST_NODE_KINDS) {
    out[k] = { travel: 0, yield: 0, regrowth: 0 };
  }
  return out;
}

function clampTier(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(HARVEST_MASTERY_MAX_TIER, Math.floor(v)));
}

export function normalizeHarvestMastery(raw: unknown): HarvestMasteryState {
  const fresh = createInitialHarvestMastery();
  if (raw == null || typeof raw !== 'object') return fresh;
  const r = raw as Record<string, unknown>;
  const out: HarvestMasteryState = {};
  for (const k of HARVEST_NODE_KINDS) {
    const inc = r[k];
    if (!inc || typeof inc !== 'object') {
      out[k] = { ...fresh[k]! };
      continue;
    }
    const o = inc as Record<string, unknown>;
    out[k] = {
      travel: clampTier(o.travel),
      yield: clampTier(o.yield),
      regrowth: clampTier(o.regrowth),
    };
  }
  return out;
}

/** Lerp factor toward camp stand: 0 = raw ring slot, 0.5 = halfway (max mastery). */
export function travelTowardHome01(tier: number): number {
  const t = Math.max(0, Math.min(HARVEST_MASTERY_MAX_TIER, tier));
  return (t / HARVEST_MASTERY_MAX_TIER) * 0.5;
}

/** Multiplier on full gather clip length (travel + work). */
export function gatherClipDurationFactor(tier: number): number {
  const t = Math.max(0, Math.min(HARVEST_MASTERY_MAX_TIER, tier));
  return Math.max(0.5, 1 - 0.1 * t);
}

export function harvestYieldMultiplier(tier: number): number {
  const t = Math.max(0, Math.min(HARVEST_MASTERY_MAX_TIER, tier));
  return 1 + 0.12 * t;
}

/** Multiplier on base respawn delay (lower = faster return). */
export function regrowthTimeMultiplier(tier: number): number {
  const t = Math.max(0, Math.min(HARVEST_MASTERY_MAX_TIER, tier));
  return Math.max(0.42, 1 - 0.1 * t);
}

export function masteryUpgradeCost(branch: MasteryBranch, currentTier: number): number {
  if (currentTier >= HARVEST_MASTERY_MAX_TIER) return Infinity;
  const bases: Record<MasteryBranch, number> = { travel: 32, yield: 48, regrowth: 38 };
  return Math.floor(bases[branch] * Math.pow(1.52, currentTier));
}

/** Strain added each successful gather; travel + regrowth mastery reduce wear on the vein. */
export function veinStrainPerGather(travelTier: number, regrowthTier: number): number {
  const tr = Math.max(0, Math.min(HARVEST_MASTERY_MAX_TIER, travelTier));
  const rg = Math.max(0, Math.min(HARVEST_MASTERY_MAX_TIER, regrowthTier));
  return Math.max(4, Math.round(15 - tr * 2.2 - rg * 1.3));
}

export const HARVEST_KIND_LABEL: Record<HarvestNodeKind, string> = {
  wood: 'Woodline',
  stone: 'Stone scatter',
  fiber: 'Fiber stands',
  berries: 'Berry brush',
  hunt: 'Hunt trails',
  garden: 'Garden bed',
  water: 'Waterbank',
  mine: 'Ore strike',
};

export const MASTERY_BRANCH_BLURB: Record<MasteryBranch, { title: string; body: string }> = {
  travel: {
    title: 'Pathfinding',
    body: 'Resource props sit closer to camp; your character walks less and the gather clip finishes sooner.',
  },
  yield: {
    title: 'Bounty',
    body: 'Each successful gather grants more of that vein’s resources.',
  },
  regrowth: {
    title: 'Regrowth sense',
    body: 'Depleted nodes come back faster and each harvest strains the vein slightly less.',
  },
};

/** Roadmap copy for the RPG tab (not yet simulated in game logic). */
export const RPG_ROADMAP_IDEAS: string[] = [
    'Combat: crit chance, armor pen, spell haste tied to magic dust spend.',
    'Crafting: station mastery for faster crafts and bonus outputs.',
    'Survival: hunger/thirst decay reduction and spoilage resistance.',
    'Idle: small multipliers to automation lines per deck “attunement”.',
    'Co-op: aura buffs that share a slice of your mastery with party members.',
    'Meta: expedition perks chosen at run start that twist strain / seal rules.',
  ];
