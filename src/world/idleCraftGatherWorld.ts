/**
 * World XZ anchors for manual gather props (same space as {@link CharacterScenePreview} / dock).
 * Used to bias night bioluminescence around the material-gather play area.
 */
import type { IdleEmpireProjectFile } from '../engine/fetchEmpireProject';
import { waterGatherBankXZ } from './idleCraftHeightfield';

/** Ground XZ for each gather prop — must stay in sync with `GATHER_WORLD` in characterScenePreview.ts */
export const IDLE_CRAFT_GATHER_XZ = {
  woodTree: { x: -0.02, z: -1.08 },
  stone: { x: -0.52, z: 0.14 },
  fiber: { x: 0.38, z: 0.52 },
  berries: { x: 0.52, z: -0.34 },
  mine: { x: 0.38, z: 0.22 },
  garden: { x: 0.48, z: 0.14 },
  hunt: { x: -0.06, z: -1.02 },
} as const;

export type GatherAnchor = { x: number; z: number; kind?: string };

/** All gather hotspots + a short arc “behind” the avatar stand (+Z from typical framing). */
export function getIdleCraftGatherAnchors(project: IdleEmpireProjectFile | null): GatherAnchor[] {
  const w = waterGatherBankXZ(project);
  const g = IDLE_CRAFT_GATHER_XZ;
  const core: GatherAnchor[] = [
    { x: g.woodTree.x, z: g.woodTree.z, kind: 'wood' },
    { x: g.stone.x, z: g.stone.z, kind: 'stone' },
    { x: g.fiber.x, z: g.fiber.z, kind: 'fiber' },
    { x: g.berries.x, z: g.berries.z, kind: 'berries' },
    { x: g.mine.x, z: g.mine.z, kind: 'mine' },
    { x: g.garden.x, z: g.garden.z, kind: 'garden' },
    { x: g.hunt.x, z: g.hunt.z, kind: 'hunt' },
    { x: w.x, z: w.z, kind: 'water' },
  ];
  return core;
}

/** Samples behind / beside the dock home (+Z band and flanks) so glow wraps the character. */
export function gatherSurroundOffsets(ringMul: number): { x: number; z: number }[] {
  const s = Math.min(1.05, ringMul * 0.024);
  return [
    { x: 0, z: 0.26 * s },
    { x: 0, z: 0.48 * s },
    { x: 0.2 * s, z: 0.36 * s },
    { x: -0.24 * s, z: 0.34 * s },
    { x: 0.16 * s, z: 0.58 * s },
    { x: -0.2 * s, z: 0.54 * s },
    { x: 0.34 * s, z: 0.18 * s },
    { x: -0.36 * s, z: 0.15 * s },
  ];
}
