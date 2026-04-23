/**
 * IDLE-CRAFT — Crystal cluster scatter props.
 *
 * Reuses the same gem PBR materials and hex-prism-point geometry as the wizard's staff
 * (`vanguardWizardLPCA.ts`) but adapted for ground-scale natural crystal formations
 * scattered around the dock. Three size tiers:
 *
 *   - Small  (~0.4–0.6 units) — chest-high glowing accents nestled in the underbrush
 *   - Medium (~0.8–1.2 units) — waist-to-shoulder formations marking landmarks
 *   - Large  (~2.0–3.0 units) — towering monoliths visible from across the map
 *
 * Each formation is a procedurally-built CLUSTER (1 main central crystal + 3–5 smaller
 * side crystals tilted outward), using one of 8 gem palettes (amethyst, emerald,
 * sapphire, ruby, citrine, aquamarine, rose quartz, topaz).
 *
 * Materials are flat-shaded with iridescence + sheen + emissive bloom for the dark-fantasy
 * "glowing magical crystal" look.
 */
import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';

/* ============ MATERIALS ============ */

type GemDef = { color: number; accent: number; ior: number };

const CRYSTAL_PALETTE: readonly GemDef[] = [
  { color: 0xb060ff, accent: 0x6020c0, ior: 1.55 }, // amethyst
  { color: 0x40e070, accent: 0x10a040, ior: 1.55 }, // emerald
  { color: 0x4080ff, accent: 0x1040d0, ior: 1.77 }, // sapphire
  { color: 0xff3050, accent: 0xc01030, ior: 1.77 }, // ruby
  { color: 0xffc028, accent: 0xc07000, ior: 1.62 }, // citrine
  { color: 0x40e0d8, accent: 0x10a8a0, ior: 1.55 }, // aquamarine
  { color: 0xff80b0, accent: 0xc03878, ior: 1.55 }, // rose quartz
  { color: 0xffae40, accent: 0xc06000, ior: 1.62 }, // topaz
];

/**
 * Bright-glowing gem PBR. Same recipe as the wizard staff crystals (clearcoat +
 * iridescence + sheen + emissive) but with `emissiveIntensity` dialed lower (`0.65`
 * vs the staff's `1.4`) because ground crystals are 30–200× larger and would
 * otherwise overpower the bloom pass.
 */
function createCrystalGemMat(def: GemDef): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(def.color),
    metalness: 0.0,
    roughness: 0.05,
    ior: def.ior,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    emissive: new THREE.Color(def.color),
    emissiveIntensity: 0.65,
    iridescence: 0.55,
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [200, 600],
    sheen: 0.5,
    sheenColor: new THREE.Color(def.accent),
    sheenRoughness: 0.3,
    flatShading: true,
  });
}

/* ============ GEOMETRY HELPERS ============ */

/**
 * Single hex-prism-point quartz crystal. `size` controls the overall extent — total
 * height ≈ `size * 1.5`. Crystal points along its local +Y axis with the base at y=0.
 */
function buildCrystalShape(size: number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const r = size * 0.36;
  const prismH = size * 0.55;
  const pointH = size * 0.95;
  const prism = new THREE.Mesh(
    new THREE.CylinderGeometry(r * 0.95, r * 1.08, prismH, 6, 1, false),
    mat,
  );
  prism.position.y = prismH / 2;
  prism.castShadow = true;
  prism.receiveShadow = true;
  g.add(prism);
  const point = new THREE.Mesh(
    new THREE.ConeGeometry(r * 0.95, pointH, 6, 1, false),
    mat,
  );
  point.position.y = prismH + pointH / 2;
  point.castShadow = true;
  g.add(point);
  return g;
}

/* Cheap deterministic LCG so crystal cluster shapes are stable across loads/seeds. */
function makeSeededRng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 0x100000000) / 0x100000000;
  };
}

/**
 * 3–6 crystal cluster — main central crystal + side crystals tilted outward.
 *
 * The cluster is built in a local frame with +Y up; the caller positions the GROUP at
 * terrain height. Both the main and side crystals are EMBEDDED slightly below the
 * group origin (`-size * 0.08` for main, `-sideSize * 0.10` for sides) so when placed
 * on the ground their bases punch into the soil instead of resting on top — this
 * eliminates the floating-base issue on sloped terrain.
 */
function buildCrystalCluster(size: number, mat: THREE.Material, seed: number): THREE.Group {
  const g = new THREE.Group();
  const rng = makeSeededRng(seed);
  const main = buildCrystalShape(size, mat);
  /* Sink the main crystal ~8% of its size into the ground so the hex base never floats
   * on uneven terrain. The visible portion is still tall enough to read as the central
   * spire of the cluster. */
  main.position.y = -size * 0.08;
  g.add(main);
  const sideCount = 3 + Math.floor(rng() * 3); // 3–5
  for (let i = 0; i < sideCount; i++) {
    const az = (i / sideCount) * Math.PI * 2 + rng() * 0.6;
    const sideSize = size * (0.32 + rng() * 0.28);
    const dx = Math.cos(az) * size * 0.30;
    const dz = Math.sin(az) * size * 0.30;
    const tiltAmt = 0.25 + rng() * 0.30;
    const side = buildCrystalShape(sideSize, mat);
    /* Side crystals also sink ~10% of their size into the ground. Outward tilt is
     * still applied via rotation.set so they appear to grow radially from a buried
     * common base. */
    side.position.set(dx, -sideSize * 0.10, dz);
    side.rotation.set(Math.cos(az) * tiltAmt, rng() * Math.PI * 2, -Math.sin(az) * tiltAmt);
    g.add(side);
  }
  return g;
}

/* ============ SCATTER PLACEMENT ============ */

/*
 * Layout authored by hand. Coordinates are in `ringMul` units relative to the dock
 * spawn (same convention as `forestEnvironment.ts` shrubRing/rockGroup):
 *   - Inner ring   ~1.5–2.5 ringMul    : small chest-high accents around the dock
 *   - Mid ring     ~3–5 ringMul        : medium waist-high formations
 *   - Outer ring   ~5–8 ringMul        : large/landmark towering monoliths
 *
 * Distributed all 8 gem colors across the rings so no single hue dominates the area.
 * Seed values stay distinct so cluster shape variation is reproducible.
 */
type CrystalSpot = {
  rx: number; // x in ringMul units
  rz: number; // z in ringMul units
  size: number; // crystal cluster size (world units; total height ≈ size * 1.5)
  paletteIdx: number; // index into CRYSTAL_PALETTE
  seed: number;
};

const CRYSTAL_SPOTS: readonly CrystalSpot[] = [
  /* Foreground close-to-character ring (0.5–1.5 ringMul). 14 small crystals spread
   * around the character so the foreground is full of magical color from any camera
   * angle. Avoids 0.0–0.5 ringMul to leave room for the dock structure / spawn pad. */
  { rx: -0.8, rz: -1.0, size: 0.30, paletteIdx: 0, seed: 1 },
  { rx: 1.1, rz: -0.7, size: 0.32, paletteIdx: 4, seed: 2 },
  { rx: -1.3, rz: 0.6, size: 0.28, paletteIdx: 2, seed: 3 },
  { rx: 1.2, rz: 1.0, size: 0.34, paletteIdx: 1, seed: 4 },
  { rx: -0.5, rz: 1.4, size: 0.26, paletteIdx: 5, seed: 5 },
  { rx: 0.7, rz: -1.4, size: 0.30, paletteIdx: 7, seed: 6 },
  { rx: -1.4, rz: -0.4, size: 0.28, paletteIdx: 6, seed: 7 },
  { rx: 1.5, rz: 0.3, size: 0.32, paletteIdx: 3, seed: 8 },
  /* Six more even tighter (0.55–1.1 ringMul, ~3–6 world units) — small singles dotted
   * near the dock so foreground always has glowing color regardless of view angle. */
  { rx: -0.6, rz: 0.2, size: 0.22, paletteIdx: 1, seed: 9 },
  { rx: 0.5, rz: 0.7, size: 0.20, paletteIdx: 2, seed: 10 },
  { rx: -0.9, rz: -0.6, size: 0.24, paletteIdx: 3, seed: 12 },
  { rx: 0.9, rz: -0.3, size: 0.22, paletteIdx: 5, seed: 13 },
  { rx: -0.3, rz: -1.1, size: 0.26, paletteIdx: 6, seed: 14 },
  { rx: 0.3, rz: 1.1, size: 0.24, paletteIdx: 7, seed: 15 },

  /* Inner ring — small accent crystals around the dock */
  { rx: -2.4, rz: -1.8, size: 0.42, paletteIdx: 0, seed: 11 },
  { rx: 2.6, rz: -1.5, size: 0.50, paletteIdx: 4, seed: 22 },
  { rx: -1.1, rz: -2.8, size: 0.38, paletteIdx: 2, seed: 33 },
  { rx: 3.0, rz: 1.2, size: 0.46, paletteIdx: 1, seed: 44 },
  { rx: -2.8, rz: 1.6, size: 0.42, paletteIdx: 3, seed: 55 },
  { rx: 1.8, rz: 2.6, size: 0.40, paletteIdx: 6, seed: 66 },
  { rx: -1.6, rz: 2.2, size: 0.48, paletteIdx: 5, seed: 77 },
  { rx: 0.5, rz: -3.0, size: 0.44, paletteIdx: 7, seed: 88 },

  /* Mid ring — medium formations */
  { rx: -4.2, rz: 2.8, size: 0.78, paletteIdx: 0, seed: 99 },
  { rx: 4.5, rz: -2.1, size: 0.85, paletteIdx: 2, seed: 110 },
  { rx: 1.2, rz: -4.0, size: 0.72, paletteIdx: 1, seed: 121 },
  { rx: -3.0, rz: -3.8, size: 0.80, paletteIdx: 4, seed: 132 },
  { rx: 4.8, rz: 3.0, size: 0.92, paletteIdx: 3, seed: 143 },
  { rx: -1.5, rz: 4.5, size: 0.74, paletteIdx: 5, seed: 154 },
  { rx: 3.6, rz: -4.2, size: 0.88, paletteIdx: 6, seed: 165 },
  { rx: -4.8, rz: -1.4, size: 0.82, paletteIdx: 7, seed: 176 },

  /*
   * Outer ring — LARGE landmark monoliths visible from across the map.
   *
   * IMPORTANT: distance from the dock center (sqrt(rx² + rz²)) MUST stay below ~5.2
   * so the crystal sits within the terrain heightfield. The map radius is `R` and
   * `ringMul = R / 5.5`, so a crystal at distance `d` ringMul lands at `d/5.5 × R`
   * world units from center. Anything past `5.5` ringMul = past the terrain edge,
   * and `getHeightAt` returns the edge height (or 0) for those XZ — the crystal
   * appears to float because there's no ground there. Previous values like
   * `(-7, -4.5)` (8.3 ringMul = 1.51 R) put the ruby completely off the map.
   *
   * All 6 landmarks now sit at 4.5–5.0 ringMul — comfortably inside the map but
   * far enough from the dock to read as horizon landmarks.
   */
  { rx: -4.8, rz: 0.8, size: 2.10, paletteIdx: 0, seed: 211 }, // huge amethyst
  { rx: 4.4, rz: -2.2, size: 2.55, paletteIdx: 1, seed: 222 }, // huge emerald
  { rx: 2.6, rz: 4.2, size: 1.95, paletteIdx: 6, seed: 233 }, // huge rose quartz
  { rx: -3.0, rz: 3.8, size: 2.30, paletteIdx: 2, seed: 244 }, // huge sapphire
  { rx: -4.2, rz: -2.6, size: 2.75, paletteIdx: 3, seed: 255 }, // huge ruby
  { rx: 3.6, rz: 3.2, size: 2.20, paletteIdx: 5, seed: 266 }, // huge aquamarine
];

/**
 * Dark-stone PBR for the rubble bases under large crystals. Reused across all rubble
 * meshes so it batches into fewer draw calls.
 */
const RUBBLE_MAT = new THREE.MeshPhysicalMaterial({
  color: new THREE.Color(0x2a2630),
  roughness: 0.92,
  metalness: 0.04,
  flatShading: true,
});

/**
 * Build and add all crystal cluster props to the scene around the dock spawn point.
 *
 * Large clusters (size ≥ 1.0) get TWO extras to keep them grounded:
 *   1. Terrain min-sampling — the placement Y uses the lowest perimeter point around
 *      the cluster footprint, so even on slopes the upslope corners punch into the
 *      ground instead of leaving a downslope corner floating.
 *   2. Rubble base — 5–8 small dark stones scattered around the cluster footprint,
 *      hiding any remaining hex-base seam against the soil and reading as bedrock the
 *      crystal pushed up through.
 */
/**
 * World-space XZ of every crystal cluster (no `getHeightAt` lookup — the harvest module
 * does its own ground-snap when it needs Y). Used by free-roam mode so the awakened
 * player can mine crystals at the SAME positions the visual scatter sits at, instead
 * of the harvest module spawning a parallel set of crystals. See
 * `docs/AWAKENING_AND_FREE_ROAM_PLAN.md` §6 (locked: "we have ground crystals on map
 * we can just use those").
 */
export function getIdleCraftCrystalWorldPositions(
  dockCx: number,
  dockCz: number,
  ringMul: number,
): { x: number; z: number }[] {
  return CRYSTAL_SPOTS.map((spot) => ({
    x: dockCx + spot.rx * ringMul,
    z: dockCz + spot.rz * ringMul,
  }));
}

/**
 * Per-cluster handle returned by `scatterIdleCraftCrystalProps`. The `group` is the
 * merged-by-material crystal cluster (gem geometry only — the surrounding rubble bed
 * lives in a separate static merged mesh). The harvest module hides / animates these
 * groups when the player fully harvests a crystal node.
 *
 * Order matches `getIdleCraftCrystalWorldPositions()` so callers can pair `clusterGroups[i]`
 * with `crystalSpotsXZ[i]` directly.
 */
export interface CrystalClusterHandle {
  /** World-space XZ of the cluster center (matches `getIdleCraftCrystalWorldPositions`). */
  x: number;
  z: number;
  /** Top-level cluster Group — toggle `.visible` / scale to hide/animate on harvest. */
  group: THREE.Group;
}

export function scatterIdleCraftCrystalProps(
  scene: THREE.Scene,
  dockCx: number,
  dockCz: number,
  ringMul: number,
  getHeightAt: (x: number, z: number) => number,
): CrystalClusterHandle[] {
  /* One material per palette entry — shared across all crystals using that color so
   * the renderer batches them into fewer draw calls. */
  const matCache = CRYSTAL_PALETTE.map(createCrystalGemMat);

  /* Per-cluster Group references returned to callers (so the harvest module can
   * shrink/hide individual clusters when fully harvested). Aligned 1:1 with the order
   * of `CRYSTAL_SPOTS` and `getIdleCraftCrystalWorldPositions()`. */
  const clusterHandles: CrystalClusterHandle[] = [];

  /**
   * Rubble-only root — shoulder boulders + perimeter scatter + dust pebbles all share
   * `RUBBLE_MAT` and are static after placement, so we collect them into one Group and
   * call `mergeByMaterial` once at the end (same single-draw consolidation we used to
   * have for the full scatter).
   *
   * Crystals are SEPARATED from this so the harvest module can toggle individual
   * cluster visibility — see `CrystalClusterHandle` doc. Trade-off: ~30 extra draw
   * calls (one per cluster) vs the old fully-merged-everything approach. Modern WebGL
   * handles this comfortably; the alternative (InstancedMesh per palette+size variant)
   * would require a large refactor of the procedural cluster builder for marginal gain.
   */
  const rubbleRoot = new THREE.Group();
  rubbleRoot.name = 'idlecraft-crystal-rubble';

  for (const spot of CRYSTAL_SPOTS) {
    const wx = dockCx + spot.rx * ringMul;
    const wz = dockCz + spot.rz * ringMul;
    const isLarge = spot.size >= 1.0;
    /*
     * Cluster footprint radius — used by the rubble loops below to spread stones
     * around the cluster perimeter.
     *
     * Y placement: cluster sits AT local terrain height. The cluster builder already
     * sinks the central crystal by `size * 0.08` below the group origin (and side
     * crystals by `sideSize * 0.10`), so the hex bases are buried slightly without
     * any external bury depth. This keeps the crystal AND all surrounding rubble on
     * the same terrain reference — no floating boulders, no over-burying.
     */
    const footprintR = spot.size * 0.65;
    const y0 = getHeightAt(wx, wz);
    const mat = matCache[spot.paletteIdx]!;
    const cluster = buildCrystalCluster(spot.size, mat, spot.seed);
    cluster.position.set(wx, y0, wz);
    /* Per-cluster rotation: Y for facet variety + small X/Z tilts so the cluster leans
     * naturally instead of standing perfectly perpendicular to flat ground. */
    const seedRng = makeSeededRng(spot.seed);
    cluster.rotation.y = seedRng() * Math.PI * 2;
    cluster.rotation.x = (seedRng() - 0.5) * 0.28;
    cluster.rotation.z = (seedRng() - 0.5) * 0.28;
    /* Per-cluster internal merge — collapses the cluster's hex faces (1 main + 3-5 side
     * crystals) into ONE merged mesh per cluster (since they all share `mat`). The
     * cluster Group becomes the per-cluster handle the harvest module animates. */
    cluster.updateMatrixWorld(true);
    const mergedCluster = mergeByMaterial(cluster);
    /* Restore the world position+rotation on the wrapping Group so harvest-side scale
     * tweens pivot around the cluster base instead of around world origin. */
    mergedCluster.position.copy(cluster.position);
    mergedCluster.rotation.copy(cluster.rotation);
    /* `mergeByMaterial` baked the world matrices into vertex positions, so the merged
     * children sit at world coords. Strip the wrapping group's transform back out — we'll
     * re-apply it via the Group transform so per-cluster scale animation works. */
    mergedCluster.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry) return;
      /* Translate baked vertices back into local cluster space. */
      m.geometry.translate(-cluster.position.x, -cluster.position.y, -cluster.position.z);
    });
    mergedCluster.name = `idlecraft-crystal-cluster-${clusterHandles.length}`;
    scene.add(mergedCluster);
    clusterHandles.push({ x: wx, z: wz, group: mergedCluster });

    /* Large crystals get a TWO-tier rubble bed: a few SHOULDER boulders right at the
     * cluster base (large, semi-buried — these read as the bedrock chunk the crystal
     * pushed through), then a ring of smaller scatter stones around the perimeter to
     * blend the outline back into terrain. The shoulder boulders also visually "hold"
     * the crystal in place so even if the hex base is slightly raised, the eye reads
     * the boulders and crystal as one unified rocky outcrop. */
    if (isLarge) {
      const stoneRng = makeSeededRng(spot.seed + 9000);

      /* SHOULDER boulders — 3–4 large rocks tucked tight against the cluster base. */
      const shoulderCount = 3 + Math.floor(stoneRng() * 2);
      for (let s = 0; s < shoulderCount; s++) {
        const sang = (s / shoulderCount) * Math.PI * 2 + stoneRng() * 0.4;
        const sdist = footprintR * (0.4 + stoneRng() * 0.25);
        const sx = wx + Math.cos(sang) * sdist;
        const sz = wz + Math.sin(sang) * sdist;
        const sy = getHeightAt(sx, sz);
        const stoneR = spot.size * (0.22 + stoneRng() * 0.10);
        const stone = new THREE.Mesh(
          new THREE.DodecahedronGeometry(stoneR, 0),
          RUBBLE_MAT,
        );
        stone.position.set(sx, sy - stoneR * 0.25, sz);
        stone.scale.set(
          0.9 + stoneRng() * 0.4,
          0.7 + stoneRng() * 0.3,
          0.9 + stoneRng() * 0.4,
        );
        stone.rotation.set(
          stoneRng() * Math.PI,
          stoneRng() * Math.PI,
          stoneRng() * Math.PI,
        );
        stone.castShadow = true;
        stone.receiveShadow = true;
        rubbleRoot.add(stone);
      }

      /* SCATTER stones — 6–10 smaller rocks around the perimeter for ground blend. */
      const scatterCount = 6 + Math.floor(stoneRng() * 5);
      for (let s = 0; s < scatterCount; s++) {
        const sang = stoneRng() * Math.PI * 2;
        const sdist = footprintR * (0.85 + stoneRng() * 0.65);
        const sx = wx + Math.cos(sang) * sdist;
        const sz = wz + Math.sin(sang) * sdist;
        const sy = getHeightAt(sx, sz);
        const stoneR = spot.size * (0.06 + stoneRng() * 0.06);
        const stone = new THREE.Mesh(
          new THREE.DodecahedronGeometry(stoneR, 0),
          RUBBLE_MAT,
        );
        stone.position.set(sx, sy - stoneR * 0.4, sz);
        stone.rotation.set(
          stoneRng() * Math.PI,
          stoneRng() * Math.PI,
          stoneRng() * Math.PI,
        );
        stone.castShadow = false;
        stone.receiveShadow = true;
        rubbleRoot.add(stone);
      }
    }
  }

  /*
   * Rubble merge: all shoulder + scatter stones share `RUBBLE_MAT`, so this collapses
   * to a single draw call regardless of how many spots have rubble beds. Crystals
   * themselves are NOT in this group — each cluster is its own merged Group (already
   * pushed to the scene above + tracked in `clusterHandles`) so the harvest module can
   * shrink/hide them individually on break.
   *
   * Safe because: every rubble stone is STATIC after placement (no per-frame transform
   * updates). `mergeByMaterial` bakes world matrices into vertex positions; animated
   * objects (the sky-crystal seal in `attachIdleCraftSkyCrystalSeal` below) stay
   * separate and are NOT merged.
   */
  scene.add(mergeByMaterial(rubbleRoot));
  return clusterHandles;
}

/* ============ SKY CRYSTAL SEAL ============ */

/**
 * Plasma halo shell material — shares the gem's CURRENT emissive color so all halo
 * shells stay color-coherent with the core as the gem cycles through its palette.
 *
 * Key uniforms:
 *   uPrimary      gem's current emissive color, written each frame from the host
 *   uNoiseAmount  0..1 — how strongly the plasma noise pattern shows. Inner shells
 *                 use high values (0.7+) for vibrant cells; outer shells use low
 *                 values (0.1–0.3) for a smooth diffuse glow that fades into space.
 *   uIntensity    overall brightness multiplier — drops aggressively from inner to
 *                 outer shells so the corona reads as ONE halo with smooth falloff
 *                 rather than three discrete shells.
 *   uFresnelEdge  0..1 — how much extra brightness to give silhouette edges (uses
 *                 view-space normal Z so the halo silhouette glows softer than the
 *                 center). 0 = flat shell, 1 = strong rim glow.
 *
 * In the fragment shader we derive 2 secondary colors from uPrimary (a hot
 * highlight at 1.5× and a soft shadow at 0.6×), then blend between them using the
 * plasma noise pattern. This keeps the entire halo locked to the gem's current
 * color while still giving organic flowing variation.
 */
function createSealPlasmaShellMaterial(
  noiseAmount: number,
  baseIntensity: number,
  fresnelEdge: number,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPrimary: { value: new THREE.Color(0xc060ff) },
      uNoiseAmount: { value: noiseAmount },
      uIntensity: { value: baseIntensity },
      uFresnelEdge: { value: fresnelEdge },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vViewNormal;
      void main() {
        vUv = uv;
        vViewNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform float uTime;
      uniform vec3 uPrimary;
      uniform float uNoiseAmount;
      uniform float uIntensity;
      uniform float uFresnelEdge;
      varying vec2 vUv;
      varying vec3 vViewNormal;
      void main() {
        float lat = vUv.y;
        float lon = vUv.x;
        /* Five octaves of sin-noise — finer texture, plasma reads as flowing
         * misty cells instead of obvious sin patterns. Different time scales for
         * each octave so the noise drifts at different speeds across the surface. */
        float n1 = sin(lon * 6.0 + uTime * 0.32) * 0.5 + 0.5;
        float n2 = sin(lat * 5.0 - uTime * 0.41) * 0.5 + 0.5;
        float n3 = sin((lon + lat * 0.5) * 11.0 - uTime * 0.55) * 0.5 + 0.5;
        float n4 = sin((lat + lon * 0.7) * 17.0 + uTime * 0.7) * 0.5 + 0.5;
        float n5 = sin((lon * 0.3 + lat * 0.5) * 22.0 - uTime * 0.9) * 0.5 + 0.5;
        float plasma = n1 * 0.34 + n2 * 0.26 + n3 * 0.20 + n4 * 0.12 + n5 * 0.08;
        /* Derive a hot highlight and a soft shadow from the primary. Reduced range
         * compared to v1 (was 1.55× / 0.55×) so cells are subtler — reads as misty
         * gradients of the same hue instead of bright/dark splotches. */
        vec3 hot = min(uPrimary * 1.40, vec3(1.0));
        vec3 shadow = uPrimary * 0.65;
        vec3 base = mix(uPrimary, hot, smoothstep(0.55, 0.95, plasma));
        vec3 col = mix(base, shadow, smoothstep(0.0, 0.40, 1.0 - plasma) * 0.4);
        /* Apply noise contrast — inner shells get full plasma, outer shells get a
         * smoothed (toward primary) version so they read as soft diffuse glow. */
        col = mix(uPrimary, col, uNoiseAmount);
        /* Fresnel-like edge brightening: silhouette glows more than center. Higher
         * exponent (3.0) sharpens the rim into a clean halo ring on outer shells,
         * while inner shells with low uFresnelEdge stay mostly body-lit. */
        float edge = pow(1.0 - abs(vViewNormal.z), 3.0);
        /* Smoother intensity envelope — narrower plasma contribution to brightness
         * so cells modulate gently instead of stripping the shell to dark patches. */
        float intensity = uIntensity * (0.78 + plasma * 0.30) *
          mix(1.0, 1.8, uFresnelEdge * edge) *
          (0.94 + 0.08 * sin(uTime * 0.5));
        /* Independent alpha-modulation noise — uses a DIFFERENT pattern than the
         * color noise so the shell appears to wisp in and out organically across
         * its surface. Breaks the perfect-circle silhouette into a soft cloudy
         * boundary that BLENDS with adjacent shells instead of stacking as
         * concentric rings. */
        float aN1 = sin(lon * 4.5 + lat * 2.8 + uTime * 0.22) * 0.5 + 0.5;
        float aN2 = sin((lat - lon * 0.4) * 9.0 - uTime * 0.36) * 0.5 + 0.5;
        float alphaMod = 0.45 + 0.55 * (aN1 * 0.6 + aN2 * 0.4);
        gl_FragColor = vec4(col * intensity, intensity * 0.55 * alphaMod);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    toneMapped: false,
    side: THREE.BackSide,
    fog: false,
  });
}

/**
 * THE SEAL — a giant slowly-spinning sci-fi-dark-fantasy crystal hovering high above
 * the dock, locking the wizard inside the idle-deck dream-prison (`LORE.md` §4–§6).
 *
 * Plasma-style composition matching the depth of the plasma sun / moon disc. No
 * geometric rings, orbiting crystals, or hanging chains — pure plasma corona around
 * a faceted gem core, with all halo shells locked to the gem's current emissive
 * color so the whole artifact reads as ONE color-cycling magical body:
 *
 *   1. Gem core            — vertically elongated octahedron with PBR iridescence +
 *                            COLOR-CYCLING emissive (violet → magenta → cyan → green)
 *   2. Inner energy core   — smaller additive icosahedron pulsing inside the gem
 *   3. SIX plasma shells   — custom-shader additive sphere shells with noise-driven
 *                            organic alpha so adjacent shells wisp into each other
 *                            instead of stacking as concentric rings. ALL share the
 *                            gem's current emissive via a `uPrimary` uniform updated
 *                            each frame, so the entire corona color-cycles in
 *                            lockstep with the gem. Smooth gaussian-ish intensity
 *                            falloff (1.65 → 0.22) and progressive Fresnel rim so
 *                            the corona reads as one cloudy halo, not 6 rings.
 *   4. 6 orbiting shards   — small faceted octahedra orbiting WITHIN the halo cloud
 *                            (3 equatorial + 3 polar planes for true 3D motion),
 *                            sharing `sealMat` so they color-cycle with the gem.
 *   5. Particle aura       — 14 tiny additive motes drifting around the seal axis
 */
export type IdleCraftSkyCrystalSealHandle = {
  update(dt: number): void;
  dispose(): void;
};

export function attachIdleCraftSkyCrystalSeal(
  scene: THREE.Scene,
  dockCx: number,
  dockCz: number,
  options?: { y?: number; size?: number },
): IdleCraftSkyCrystalSealHandle {
  const skyY = options?.y ?? 32;
  const sizeMul = options?.size ?? 1.0;

  const root = new THREE.Group();
  root.name = 'idlecraft-sky-crystal-seal';
  root.position.set(dockCx, skyY, dockCz);
  scene.add(root);

  /* ====== SEAL GEM CORE ====== */
  /* Vibrant violet body with PBR iridescence; emissive color CYCLES across 4
   * magical hues over time so the gem reads as a living, shifting magical artifact. */
  const sealMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x6a30a0),
    metalness: 0.0,
    roughness: 0.05,
    ior: 1.77,
    clearcoat: 1.0,
    clearcoatRoughness: 0.03,
    emissive: new THREE.Color(0xc060ff),
    emissiveIntensity: 1.8,
    iridescence: 0.95,
    iridescenceIOR: 1.55,
    iridescenceThicknessRange: [200, 900],
    sheen: 0.85,
    sheenColor: new THREE.Color(0x40ff80),
    sheenRoughness: 0.25,
    flatShading: true,
  });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(2.4 * sizeMul, 0), sealMat);
  core.scale.set(1, 1.6, 1);
  root.add(core);

  /* ====== INNER ENERGY CORE ====== */
  /* Smaller additive icosahedron inside the gem — reads as a glowing heart, with
   * pulsing opacity sympathetic to the core's emissive breath. */
  const innerCoreMat = new THREE.MeshBasicMaterial({
    color: 0xff80ff,
    transparent: true,
    opacity: 0.65,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const innerCore = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.55 * sizeMul, 2),
    innerCoreMat,
  );
  innerCore.scale.set(1, 1.55, 1);
  root.add(innerCore);

  /* ====== PLASMA HALO SHELLS (6) ======
   *
   * Six sphere shells at very fine progressive radii (2.9 → 6.4). Combined with
   * the noise-driven alpha modulation in the shader, the shells wisp in and out
   * organically across their surfaces — adjacent shells overlap and blend into
   * each other as one cloudy corona instead of stacking as discrete concentric
   * rings. All shells share the gem's current emissive color via `uPrimary`.
   *
   * Smooth GAUSSIAN-ish falloff: intensity drops aggressively from inner to outer
   * (1.65 → 0.18) so outer shells contribute mostly at silhouette via Fresnel.
   *
   *   #1  r=2.9   noise=0.85  intensity=1.65  fresnel=0.18   vibrant gem-hugger
   *   #2  r=3.4   noise=0.70  intensity=1.30  fresnel=0.32
   *   #3  r=4.0   noise=0.50  intensity=0.95  fresnel=0.50
   *   #4  r=4.7   noise=0.32  intensity=0.65  fresnel=0.70
   *   #5  r=5.5   noise=0.18  intensity=0.42  fresnel=0.88
   *   #6  r=6.4   noise=0.08  intensity=0.22  fresnel=1.00   bloom-catch outer rim
   */
  type PlasmaShell = {
    radius: number;
    noise: number;
    intensity: number;
    fresnel: number;
    segW: number;
    segH: number;
  };
  const shellSpecs: readonly PlasmaShell[] = [
    { radius: 2.9, noise: 0.85, intensity: 1.65, fresnel: 0.18, segW: 32, segH: 24 },
    { radius: 3.4, noise: 0.70, intensity: 1.30, fresnel: 0.32, segW: 32, segH: 24 },
    { radius: 4.0, noise: 0.50, intensity: 0.95, fresnel: 0.50, segW: 30, segH: 22 },
    { radius: 4.7, noise: 0.32, intensity: 0.65, fresnel: 0.70, segW: 30, segH: 22 },
    { radius: 5.5, noise: 0.18, intensity: 0.42, fresnel: 0.88, segW: 28, segH: 20 },
    { radius: 6.4, noise: 0.08, intensity: 0.22, fresnel: 1.00, segW: 28, segH: 20 },
  ];
  const plasmaShells: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; spinX: number; spinY: number; spinZ: number; pulseFreq: number }[] = [];
  for (let i = 0; i < shellSpecs.length; i++) {
    const s = shellSpecs[i]!;
    const mat = createSealPlasmaShellMaterial(s.noise, s.intensity, s.fresnel);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(s.radius * sizeMul, s.segW, s.segH), mat);
    root.add(mesh);
    plasmaShells.push({
      mesh,
      mat,
      /* Each shell drifts on different axes at different rates so the plasma noise
       * patterns never stack into stripes. */
      spinX: 0.04 + i * 0.018 * (i % 2 === 0 ? 1 : -1),
      spinY: 0.05 - i * 0.012 * (i % 2 === 0 ? -1 : 1),
      spinZ: 0.025 + i * 0.011 * (i % 2 === 0 ? 1 : -1),
      pulseFreq: 0.7 + i * 0.13,
    });
  }

  /* ====== ORBITING SHARD CRYSTALS ======
   *
   * 6 small faceted crystal shards orbiting WITHIN the halo cloud (radii 3.5–5.6,
   * which sits between the inner-vibrant and outer-rim plasma shells). Visible
   * through the additive shells as solid faceted bodies catching the halo light,
   * which gives the halo cloud something concrete to wrap around.
   *
   * Same `sealMat` as the gem core so they color-cycle in lockstep with the gem
   * AND the halo shells — the entire seal reads as one color-shifting system.
   *
   * Two orbital planes: 3 equatorial (mostly horizontal) + 3 polar (vertical
   * sweep) for true 3D motion that doesn't all happen on the same flat ring.
   * Sized smaller (0.40–0.55) than the v1 orbiters so they don't dominate.
   */
  type Orbit = {
    mesh: THREE.Mesh;
    orbitR: number;
    orbitYBase: number;
    orbitYAmp: number;
    yOscFreq: number;
    angVel: number;
    phase: number;
    spinX: number;
    spinY: number;
    polar: boolean;
  };
  const orbits: Orbit[] = [];
  for (let i = 0; i < 6; i++) {
    const polar = i >= 3;
    const localI = polar ? i - 3 : i;
    const orb = new THREE.Mesh(
      new THREE.OctahedronGeometry((0.40 + (i % 3) * 0.07) * sizeMul, 0),
      sealMat,
    );
    orb.scale.set(0.85, 1.4, 0.85);
    root.add(orb);
    orbits.push({
      mesh: orb,
      orbitR: (3.6 + localI * 0.65) * sizeMul,
      orbitYBase: (polar ? 0 : (localI - 1) * 0.5) * sizeMul,
      orbitYAmp: (polar ? 3.4 : 0.4) * sizeMul,
      yOscFreq: polar ? 0.45 + localI * 0.07 : 0.65 + localI * 0.13,
      angVel: (polar ? 0.30 : 0.46) + localI * 0.07,
      phase: (i / 6) * Math.PI * 2,
      spinX: 1.1 + i * 0.18,
      spinY: 0.65 + i * 0.13,
      polar,
    });
  }

  /* ====== PARTICLE AURA — 14 tiny additive motes around the seal ====== */
  const moteMat = new THREE.MeshBasicMaterial({
    color: 0xffe0ff,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const moteGroup = new THREE.Group();
  moteGroup.name = 'idlecraft-seal-aura-motes';
  for (let m = 0; m < 14; m++) {
    const seed = m * 7919 + 13;
    const mRng = makeSeededRng(seed);
    const az = mRng() * Math.PI * 2;
    const elev = (mRng() - 0.5) * Math.PI * 0.7;
    const r = (5.5 + mRng() * 3.5) * sizeMul;
    const cx = Math.cos(elev) * r;
    const mote = new THREE.Mesh(new THREE.IcosahedronGeometry(0.07 * sizeMul, 1), moteMat);
    mote.position.set(Math.cos(az) * cx, Math.sin(elev) * r, Math.sin(az) * cx);
    moteGroup.add(mote);
  }
  root.add(moteGroup);

  /* ====== EMISSIVE COLOR-CYCLE PALETTE ======
   * The gem's emissive interpolates between these 4 colors over time so the seal
   * never reads as a single static hue. Reusable scratch color for the lerp. */
  const cycleColors: readonly THREE.Color[] = [
    new THREE.Color(0xc060ff), // violet
    new THREE.Color(0xff60c0), // hot pink magenta
    new THREE.Color(0x60d0ff), // cyan
    new THREE.Color(0x80ff80), // green witch-fire
  ];
  const tmpColor = new THREE.Color();

  let t = 0;
  let disposed = false;

  return {
    update(dt: number): void {
      if (disposed) return;
      t += dt;

      /* Core gem — slow Y spin + tiny X wobble. Emissive intensity breathes; emissive
       * COLOR cycles through 4 magical hues over a ~25-second loop. */
      core.rotation.y = t * 0.22;
      core.rotation.x = Math.sin(t * 0.31) * 0.06;
      const breath = 0.5 + 0.5 * Math.sin(t * 0.55);
      sealMat.emissiveIntensity = 1.5 + breath * 0.8;

      const cyclePeriod = 25.0;
      const cyclePos = ((t % cyclePeriod) / cyclePeriod) * cycleColors.length;
      const idxA = Math.floor(cyclePos) % cycleColors.length;
      const idxB = (idxA + 1) % cycleColors.length;
      const tFrac = cyclePos - Math.floor(cyclePos);
      tmpColor.copy(cycleColors[idxA]!).lerp(cycleColors[idxB]!, tFrac);
      sealMat.emissive.copy(tmpColor);

      /* Inner energy core — counter-spin + scale pulse + opacity breath. */
      innerCore.rotation.y = -t * 0.45;
      innerCore.rotation.x = t * 0.27;
      innerCore.scale.setScalar(1 + Math.sin(t * 1.4) * 0.08);
      innerCoreMat.opacity = 0.55 + 0.20 * breath;

      /* Plasma shells — drive uTime so noise advances, AND copy the gem's CURRENT
       * emissive color into each shell's uPrimary so all halo layers stay locked to
       * the gem's color cycle. Each shell drifts on its own axes so noise patterns
       * never stack into visible stripes; outermost shell also breathes on scale. */
      for (let i = 0; i < plasmaShells.length; i++) {
        const s = plasmaShells[i]!;
        (s.mat.uniforms.uTime as { value: number }).value = t;
        (s.mat.uniforms.uPrimary as { value: THREE.Color }).value.copy(tmpColor);
        s.mesh.rotation.x = Math.sin(t * 0.11 + i) * 0.18 + t * s.spinX;
        s.mesh.rotation.y = t * s.spinY;
        s.mesh.rotation.z = t * s.spinZ;
      }
      /* Subtle scale pulse on outermost plasma — breathes with the core. */
      const outerShell = plasmaShells[plasmaShells.length - 1]!;
      outerShell.mesh.scale.setScalar(1.0 + Math.sin(t * 0.8) * 0.04);

      /* Orbiting shard crystals — equatorial vs polar planes for 3D motion that
       * stays nestled inside the halo cloud. They share `sealMat` so they color-
       * cycle with the gem automatically. */
      for (const o of orbits) {
        const a = t * o.angVel + o.phase;
        if (o.polar) {
          o.mesh.position.set(
            Math.cos(a) * o.orbitR,
            o.orbitYBase + Math.sin(a) * o.orbitYAmp,
            Math.sin(a * 0.7) * o.orbitR * 0.4,
          );
        } else {
          o.mesh.position.set(
            Math.cos(a) * o.orbitR,
            o.orbitYBase + Math.sin(t * o.yOscFreq + o.phase) * o.orbitYAmp,
            Math.sin(a) * o.orbitR,
          );
        }
        o.mesh.rotation.x = a * o.spinX;
        o.mesh.rotation.y = a * o.spinY;
      }

      /* Mote aura — slow drift around seal Y axis, opacity twinkles. */
      moteGroup.rotation.y = t * 0.09;
      moteMat.opacity = 0.42 + 0.18 * (0.5 + 0.5 * Math.sin(t * 1.3));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      scene.remove(root);
      core.geometry.dispose();
      innerCore.geometry.dispose();
      for (const s of plasmaShells) {
        s.mesh.geometry.dispose();
        s.mat.dispose();
      }
      for (const o of orbits) o.mesh.geometry.dispose();
      moteGroup.traverse((n) => {
        if ((n as THREE.Mesh).isMesh) (n as THREE.Mesh).geometry.dispose();
      });
      sealMat.dispose();
      innerCoreMat.dispose();
      moteMat.dispose();
    },
  };
}
