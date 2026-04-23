/**
 * Persistent manual-gather slots: fixed world positions per resource kind, timer respawn, no per-click mesh spawn.
 */
import { IDLE_CRAFT_GATHER_XZ } from './idleCraftGatherWorld';

export const HARVEST_SLOT_COUNT = 5;

export type HarvestNodeKind =
  | 'wood'
  | 'stone'
  | 'fiber'
  | 'berries'
  | 'hunt'
  | 'garden'
  | 'water'
  | 'mine';

export type HarvestPatchNodeState = {
  depleted: boolean;
  respawnAtMs: number;
};

const KINDS: HarvestNodeKind[] = [
  'wood',
  'stone',
  'fiber',
  'berries',
  'hunt',
  'garden',
  'water',
  'mine',
];

/** All harvest kinds that share world nodes / mastery (for UI + preview sync). */
export const HARVEST_NODE_KINDS: readonly HarvestNodeKind[] = KINDS;

export type HarvestPatchBlock = {
  nodes: HarvestPatchNodeState[];
  /** No more respawns for this vein until a new camp / permadeath reset. */
  sealed?: boolean;
  /** Builds toward vein seal cap (see `SEAL_STRAIN_CAP` in rpgHarvestMastery). */
  strain?: number;
};

export type HarvestPatchesState = Record<string, HarvestPatchBlock>;

/** Per-kind respawn delay after a successful gather (ms). */
export const HARVEST_RESPAWN_MS: Record<HarvestNodeKind, number> = {
  wood: 38_000,
  stone: 32_000,
  fiber: 28_000,
  berries: 34_000,
  hunt: 40_000,
  garden: 36_000,
  water: 30_000,
  mine: 35_000,
};

export function actionIdToHarvestKind(actionId: string): HarvestNodeKind | null {
  switch (actionId) {
    case 'wood':
      return 'wood';
    case 'stone':
      return 'stone';
    case 'fiber':
      return 'fiber';
    case 'berries':
      return 'berries';
    case 'water':
      return 'water';
    case 'hunt':
      return 'hunt';
    case 'tend_garden':
      return 'garden';
    default:
      if (actionId.startsWith('mine_')) return 'mine';
      return null;
  }
}

function ringOffsets(n: number, radius: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.15;
    out.push({ x: Math.cos(a) * radius, z: Math.sin(a) * radius });
  }
  return out;
}

function baseXZForKind(kind: HarvestNodeKind, waterBank: { x: number; z: number }): { x: number; z: number } {
  const g = IDLE_CRAFT_GATHER_XZ;
  switch (kind) {
    case 'wood':
      return { ...g.woodTree };
    case 'stone':
      return { ...g.stone };
    case 'fiber':
      return { ...g.fiber };
    case 'berries':
      return { ...g.berries };
    case 'mine':
      return { ...g.mine };
    case 'garden':
      return { ...g.garden };
    case 'hunt':
      return { ...g.hunt };
    case 'water':
      return { ...waterBank };
  }
}

export function harvestSlotPositionsForKind(
  kind: HarvestNodeKind,
  waterBank: { x: number; z: number },
): { x: number; z: number }[] {
  const n = HARVEST_SLOT_COUNT;
  const r = kind === 'wood' || kind === 'hunt' ? 0.2 : kind === 'mine' ? 0.14 : 0.18;
  const base = baseXZForKind(kind, waterBank);
  const offs = ringOffsets(n, r);
  return offs.map((o) => ({ x: base.x + o.x, z: base.z + o.z }));
}

export function allHarvestSlotPositions(
  waterBank: { x: number; z: number },
): Record<HarvestNodeKind, { x: number; z: number }[]> {
  const o = {} as Record<HarvestNodeKind, { x: number; z: number }[]>;
  for (const k of KINDS) {
    o[k] = harvestSlotPositionsForKind(k, waterBank);
  }
  return o;
}

export function createInitialHarvestPatches(): HarvestPatchesState {
  const out: HarvestPatchesState = {};
  for (const k of KINDS) {
    out[k] = {
      nodes: Array.from({ length: HARVEST_SLOT_COUNT }, () => ({ depleted: false, respawnAtMs: 0 })),
      sealed: false,
      strain: 0,
    };
  }
  return out;
}

/**
 * Repair saves where `harvestPatches` is missing, empty, or missing per-kind keys (would break gather).
 */
export function normalizeHarvestPatches(raw: unknown): HarvestPatchesState {
  const fresh = createInitialHarvestPatches();
  if (raw == null || typeof raw !== 'object') return fresh;
  const r = raw as Record<string, unknown>;
  const out: HarvestPatchesState = {};
  for (const k of Object.keys(fresh)) {
    const incoming = r[k];
    if (!incoming || typeof incoming !== 'object' || !Array.isArray((incoming as { nodes?: unknown }).nodes)) {
      out[k] = fresh[k]!;
      continue;
    }
    const nodesRaw = (incoming as { nodes: unknown[] }).nodes;
    const nodes: HarvestPatchNodeState[] = [];
    for (let i = 0; i < HARVEST_SLOT_COUNT; i++) {
      const n = nodesRaw[i];
      if (n && typeof n === 'object' && 'depleted' in n) {
        const depleted = !!(n as { depleted?: unknown }).depleted;
        const rm = (n as { respawnAtMs?: unknown }).respawnAtMs;
        const respawnAtMs = typeof rm === 'number' && Number.isFinite(rm) ? rm : 0;
        nodes.push({ depleted, respawnAtMs });
      } else {
        nodes.push({ depleted: false, respawnAtMs: 0 });
      }
    }
    const inc = incoming as { sealed?: unknown; strain?: unknown };
    const sealed = !!inc.sealed;
    const strRaw = inc.strain;
    const strain =
      typeof strRaw === 'number' && Number.isFinite(strRaw) ? Math.max(0, strRaw) : 0;
    out[k] = { nodes, sealed, strain };
  }
  return out;
}

export function harvestNodeReady(n: HarvestPatchNodeState, now: number): boolean {
  if (!n.depleted) return true;
  return n.respawnAtMs > 0 && now >= n.respawnAtMs;
}
