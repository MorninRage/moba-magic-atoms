/**
 * Dock forest LOD — aligned with Empire Engine {@link createVegetationLODRecipe} / {@link evaluateLODTier}.
 * Idle Craft uses a **split merge** (near vs far) at the tier-0 distance for shadow casting; full mesh
 * swaps per tier can follow the same recipe distances.
 */
import { createVegetationLODRecipe, evaluateLODTier, type LODRecipe } from 'empire-engine';

/** Vegetation LOD recipe for the dock biome (editor-compatible preset). */
export const DOCK_FOREST_LOD_RECIPE: LODRecipe = createVegetationLODRecipe(
  'idle_craft_dock',
  22,
  52,
  96,
  720,
);

/**
 * World-space radius from the dock camp: trees inside cast shadows (merged near mesh);
 * world strata beyond use a no-shadow merged mesh (GoE / ShadowSystem pattern).
 */
export function dockForestShadowNearM(mapRadius: number): number {
  const d0 = DOCK_FOREST_LOD_RECIPE.tiers[1]?.distance ?? 22;
  return Math.min(Math.max(d0 * 1.2, 14), mapRadius * 0.44);
}

export { evaluateLODTier, type LODRecipe };
