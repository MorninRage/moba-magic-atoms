/**
 * Spatial-tile merge — `mergeByMaterial` variant that buckets a staging Group into N×N
 * world-XZ tiles before merging. Each tile's merge produces a tight per-tile bounding
 * sphere so Three.js's auto frustum culling can drop tiles that aren't on-screen.
 *
 * **Why this matters for awakened-mode FPS.** A single `mergeByMaterial(treeWorldNear)`
 * collapses every tree in the disk into a few merged meshes, but the bounding sphere of
 * each merged mesh covers the **entire** disk — so the frustum check trivially passes
 * every frame and the GPU rasterizes / vertex-shades every tree on both sides of the
 * avatar even though only ~25-40% of the disk is in the camera frustum.
 *
 * Tiling fixes that. With a 3×3 grid over the dock disk:
 *   - 9 sub-merges per group (instead of 1 monolithic merge),
 *   - each sub-merge's bounding sphere covers ~1/9 of the disk,
 *   - typically 2-4 tiles intersect the camera frustum per frame,
 *   - vertex shader work for vegetation drops by ~60-75% (~3× speedup on the wind shader),
 *   - the shadow-camera frustum (covers ~half the disk around the avatar target) culls
 *     ~half the tiles too, so the depth pass also gets cheaper.
 *
 * Draw-call count goes UP (~9× per group worst case) but only a fraction are submitted
 * per frame — and the modern WebGL bottleneck on integrated/laptop GPUs is fragment +
 * vertex SHADING, not draw count. Net frame time drops substantially.
 *
 * **Material identity preserved across tiles.** `mergeByMaterial` buckets by material
 * reference. Because we tile BEFORE merging (each tile's staging children still hold
 * their original material references — typically shared cached singletons from the LPCA
 * builders or an upstream `cloneMaterialsForVegetationWind` pass), the same material
 * appears in multiple tiles' merge results. The vegetation wind shader's per-material
 * `installVegetationWindOnMaterial` patch is WeakSet-gated, so it's still applied once
 * per material across all tiles. Per-frame `updateVegetationWind` writes to a single
 * shared uniform — tile count doesn't multiply uniform writes.
 *
 * **Safe replacement for `mergeByMaterial`.** The returned Group has the same .name + the
 * same set of merged Mesh children (just split across tiles), and follows the same
 * `castShadow` / `receiveShadow` semantics. Callers that traverse the result for material
 * inspection (vegetation wind clone + install) still work unchanged.
 */
import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';

/**
 * Tile-bucket children of `staging` into `gridSize × gridSize` world-XZ tiles centered on
 * (`originX`, `originZ`) with each tile being `cellSize` wide, then run `mergeByMaterial`
 * per tile. The returned Group contains one merged sub-Group per non-empty tile.
 *
 * @param staging  Group whose immediate children carry world-XZ in their `.position`.
 * @param gridSize Number of tiles per axis. 3 → 9 tiles total. Use 2-4 in practice.
 * @param originX  Center X of the tile grid in world space (typically the dock spawn X).
 * @param originZ  Center Z of the tile grid in world space (typically the dock spawn Z).
 * @param cellSize World-space width of one tile. Total grid extent = `cellSize * gridSize`
 *                 around (originX, originZ). Pick `cellSize` so the grid covers the
 *                 furthest possible child position (e.g. dock map radius × 2 / gridSize).
 */
export function mergeByMaterialTiled(
  staging: THREE.Group,
  gridSize: number,
  originX: number,
  originZ: number,
  cellSize: number,
): THREE.Group {
  /* Move every child into the tile bucket whose XZ contains the child's position.
   * Children outside the grid get clamped into the nearest edge tile (rare — happens for
   * inner-ring trees placed exactly at origin). */
  const halfExtent = (cellSize * gridSize) / 2;
  const tiles = new Map<string, THREE.Group>();
  /* Snapshot the children list because we'll be removing as we iterate. */
  const children = staging.children.slice();
  for (const child of children) {
    const localX = child.position.x - originX + halfExtent;
    const localZ = child.position.z - originZ + halfExtent;
    let tx = Math.floor(localX / cellSize);
    let tz = Math.floor(localZ / cellSize);
    if (tx < 0) tx = 0;
    else if (tx >= gridSize) tx = gridSize - 1;
    if (tz < 0) tz = 0;
    else if (tz >= gridSize) tz = gridSize - 1;
    const key = `${tx}|${tz}`;
    let tile = tiles.get(key);
    if (!tile) {
      tile = new THREE.Group();
      tile.name = `${staging.name || 'tile'}_${tx}_${tz}`;
      tiles.set(key, tile);
    }
    /* Reparent — preserves world transform because each child is at a world-XZ position
     * with its parent (`staging`) at the world origin. */
    staging.remove(child);
    tile.add(child);
  }

  const root = new THREE.Group();
  root.name = staging.name ? `${staging.name}_tiled` : 'tiled';
  for (const tile of tiles.values()) {
    /* Bake world matrices into vertex positions then collapse by material per tile. */
    tile.updateMatrixWorld(true);
    const merged = mergeByMaterial(tile);
    root.add(merged);
  }
  return root;
}
