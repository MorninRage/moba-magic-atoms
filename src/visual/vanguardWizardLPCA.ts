/**
 * IDLE-CRAFT — Vanguard sage wizard (LPCA: layered robes, deep hood, long beard, tall staff).
 * Design: docs/VANGUARD_WIZARD_SCHEMATIC.md + docs/VANGUARD_WIZARD_INGAME_BLUEPRINT.md
 * Legacy cone-hat wizard: `legacyVanguardWizardLPCA.ts`
 */
import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';

export type VanguardWizardLpcaMaterials = {
  robeOuter: THREE.MeshStandardMaterial;
  robeInner: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  hat: THREE.MeshStandardMaterial;
  hatBrim: THREE.MeshStandardMaterial;
  staffWood: THREE.MeshStandardMaterial;
  staffMetal: THREE.MeshStandardMaterial;
  staffGem: THREE.MeshPhysicalMaterial;
};

function tagMesh(mesh: THREE.Mesh, lpcaId: string): void {
  mesh.name = lpcaId;
  mesh.userData.lpcaId = lpcaId;
}

/**
 * DARK-FANTASY layered bell robe + mantle panels + belt + magical hem trim.
 *
 * Materials upgraded to MeshPhysicalMaterial locally — clearcoat for outer fabric depth,
 * subtle sheen for the inner lining (suggesting silk/satin under wool), and polished
 * gold for the metalwork.
 */
export function createVanguardWizardRobeLPCA(m: VanguardWizardLpcaMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-vanguard-wizard-robe';

  /* Static after build — collapse all robe parts into one merged group per material at
   * the end. ~17 sources (3 lathes, collar, 2 epaulets, 2 rims, cape, hood gather, 3
   * fold lobes, 2 hem glow rings, cape hem glow, belt, buckle) sharing ~5 materials
   * (robeOuter, robeInner, trimGold, capeFelt, hemGlow) → ~5 final draw calls. */
  const staticBuild = new THREE.Group();

  /*
   * LOCAL PHYSICAL MATERIALS — same color sources as the standard avatar materials, but
   * upgraded with PBR features for the dark-fantasy look. Re-created on every robe build
   * so palette swaps stay in sync (the wizard rebuilds when the preset changes).
   */
  const robeOuterMat = new THREE.MeshPhysicalMaterial({
    color: m.robeOuter.color.clone(),
    roughness: 0.55,
    metalness: 0.03,
    clearcoat: 0.45,
    clearcoatRoughness: 0.35,
    sheen: 0.45,
    sheenColor: new THREE.Color(0x3a1c5e),
    sheenRoughness: 0.5,
  });
  const robeInnerMat = new THREE.MeshPhysicalMaterial({
    color: m.robeInner.color.clone(),
    roughness: 0.38,
    metalness: 0.02,
    clearcoat: 0.55,
    clearcoatRoughness: 0.18,
    sheen: 0.55,
    sheenColor: new THREE.Color(0x6c3aa2),
    sheenRoughness: 0.35,
  });
  const trimGoldMat = new THREE.MeshPhysicalMaterial({
    color: m.trim.color.clone(),
    metalness: 1.0,
    roughness: 0.18,
    clearcoat: 0.85,
    clearcoatRoughness: 0.08,
    emissive: m.trim.color.clone(),
    emissiveIntensity: 0.05,
  });

  const outerProfile = [
    new THREE.Vector2(0.048, 0.302),
    new THREE.Vector2(0.095, 0.255),
    new THREE.Vector2(0.142, 0.188),
    new THREE.Vector2(0.175, 0.098),
    new THREE.Vector2(0.205, -0.018),
    new THREE.Vector2(0.245, -0.152),
    new THREE.Vector2(0.298, -0.262),
  ];
  const outer = new THREE.Mesh(new THREE.LatheGeometry(outerProfile, 52), robeOuterMat);
  outer.castShadow = true;
  outer.receiveShadow = true;
  tagMesh(outer, 'vw_robe_outer');
  staticBuild.add(outer);

  const innerProfile = outerProfile.map(
    (p) => new THREE.Vector2(p.x * 0.88, p.y * 0.988 + 0.014),
  );
  const inner = new THREE.Mesh(new THREE.LatheGeometry(innerProfile, 52), robeInnerMat);
  inner.castShadow = true;
  inner.receiveShadow = true;
  tagMesh(inner, 'vw_robe_inner');
  staticBuild.add(inner);

  const midProfile = outerProfile.map(
    (p) => new THREE.Vector2(p.x * 0.94, p.y * 0.992 + 0.008),
  );
  const mid = new THREE.Mesh(new THREE.LatheGeometry(midProfile, 48), robeOuterMat);
  mid.scale.set(1.02, 1, 1.02);
  mid.position.y = 0.008;
  mid.castShadow = true;
  mid.receiveShadow = true;
  tagMesh(mid, 'vw_robe_mid');
  staticBuild.add(mid);

  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.112, 0.016, 10, 44), trimGoldMat);
  collar.rotation.x = Math.PI / 2;
  collar.position.set(0, 0.282, 0.022);
  collar.scale.set(1, 1, 0.9);
  collar.castShadow = true;
  tagMesh(collar, 'vw_collar');
  staticBuild.add(collar);

  /*
   * EPAULETS — small dome caps that nestle on top of the shoulders, replacing the big
   * horizontal cylinders that were giving the wizard a linebacker silhouette. These
   * are upper hemispheres (thetaLength = PI/2) ~0.07 rad, sitting just above the chest
   * at shoulder height, with a thin gold trim ring at the base for ceremonial detail.
   */
  const epauletGeo = new THREE.SphereGeometry(0.072, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const epauletL = new THREE.Mesh(epauletGeo, robeOuterMat);
  epauletL.position.set(-0.135, 0.250, 0.012);
  epauletL.castShadow = true;
  tagMesh(epauletL, 'vw_shoulder_L');
  staticBuild.add(epauletL);
  const epauletR = new THREE.Mesh(epauletGeo, robeOuterMat);
  epauletR.position.set(0.135, 0.250, 0.012);
  epauletR.castShadow = true;
  tagMesh(epauletR, 'vw_shoulder_R');
  staticBuild.add(epauletR);

  /* Gold trim ring at the base of each epaulet. */
  const epauletRimGeo = new THREE.TorusGeometry(0.070, 0.0045, 6, 24);
  const epauletRimL = new THREE.Mesh(epauletRimGeo, trimGoldMat);
  epauletRimL.rotation.x = Math.PI / 2;
  epauletRimL.position.set(-0.135, 0.250, 0.012);
  epauletRimL.castShadow = true;
  tagMesh(epauletRimL, 'vw_shoulder_rim_L');
  staticBuild.add(epauletRimL);
  const epauletRimR = new THREE.Mesh(epauletRimGeo, trimGoldMat);
  epauletRimR.rotation.x = Math.PI / 2;
  epauletRimR.position.set(0.135, 0.250, 0.012);
  epauletRimR.castShadow = true;
  tagMesh(epauletRimR, 'vw_shoulder_rim_R');
  staticBuild.add(epauletRimR);

  /*
   * CAPE — partial LatheGeometry hanging from the shoulders down past the robe hem,
   * AT THE BACK ONLY. The phi cutout at the front (centered on +Z) leaves a ~100 deg
   * opening so the front of the wizard (chest, belt, beard) is fully visible while a
   * proper back-anchored cape drapes behind. As the camera orbits, the cape stays
   * ATTACHED TO THE BACK of the character — it doesn't follow the camera.
   *
   * Three.js LatheGeometry phi convention: vertex.x = pts.x*sin(phi), pts.x*cos(phi).
   * phi=0 -> +Z (front). To leave a front-opening of width `openingWidth`, we sweep
   * from phi = openingWidth/2 to phi = 2*PI - openingWidth/2 (going around the back).
   *
   * Profile is wider than the robe at every height so the cape clearly drapes OUTSIDE
   * the robe rather than overlapping it.
   */
  const capeProfile = [
    new THREE.Vector2(0.205, 0.262), // shoulder anchor
    new THREE.Vector2(0.220, 0.180),
    new THREE.Vector2(0.240, 0.060),
    new THREE.Vector2(0.262, -0.060),
    new THREE.Vector2(0.292, -0.180),
    new THREE.Vector2(0.330, -0.300), // past the robe hem
  ];
  const capeOpeningWidth = 1.8; // ~103 deg opening at the front
  const capePhiStart = capeOpeningWidth / 2;
  const capePhiLen = Math.PI * 2 - capeOpeningWidth;
  /* Cape material — dark felt with double-sided rendering so the inside surface (visible
   * from a side angle through the front opening) also shades correctly. Slightly less
   * sheen than the main robe so it reads as a heavier outer cloak. */
  const capeMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x050308),
    roughness: 0.62,
    metalness: 0.02,
    clearcoat: 0.35,
    clearcoatRoughness: 0.4,
    side: THREE.DoubleSide,
  });
  const cape = new THREE.Mesh(
    new THREE.LatheGeometry(capeProfile, 56, capePhiStart, capePhiLen),
    capeMat,
  );
  cape.castShadow = true;
  cape.receiveShadow = true;
  tagMesh(cape, 'vw_cape');
  staticBuild.add(cape);

  /*
   * HOOD GATHER — extra fabric mass at the top of the cape that reads as a real hood
   * pulled DOWN onto the shoulders (not over the head, since the witch hat lives there).
   * Same partial-lathe approach as the cape so it stays anchored at the back/sides only.
   *
   * Profile bulges OUTWARD before tapering up — that outward bulge is what reads as
   * gathered/folded hood fabric instead of a plain rounded collar. Top radius (0.165) is
   * comfortably wider than the head/neck (~0.10) so the hood sits BEHIND the head, never
   * clipping into it.
   */
  const hoodGatherProfile = [
    new THREE.Vector2(0.205, 0.262), // matches cape top exactly (no seam)
    new THREE.Vector2(0.235, 0.282), // begins to bulge outward
    new THREE.Vector2(0.260, 0.306), // outer bulge max — gathered fabric volume
    new THREE.Vector2(0.272, 0.330), // widest point, mid-hood
    new THREE.Vector2(0.260, 0.355),
    new THREE.Vector2(0.232, 0.378),
    new THREE.Vector2(0.198, 0.394), // upper edge, tapering inward
    new THREE.Vector2(0.165, 0.398), // top of hood gather (still wider than head)
  ];
  const hoodGather = new THREE.Mesh(
    new THREE.LatheGeometry(hoodGatherProfile, 56, capePhiStart, capePhiLen),
    capeMat,
  );
  hoodGather.castShadow = true;
  hoodGather.receiveShadow = true;
  tagMesh(hoodGather, 'vw_cape_hood_gather');
  staticBuild.add(hoodGather);

  /*
   * FOLD LOBES — three asymmetric fabric bunches stuck onto the hood gather, breaking
   * the perfectly-revolved silhouette and reading as natural cloth folds. One straight
   * back, two at the back-quarters.
   */
  const makeFoldLobe = (azimuth: number, scale: THREE.Vector3, name: string): THREE.Mesh => {
    const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 12), capeMat);
    /* Place on the hood surface at y=0.330 (widest point), pushed slightly outward. */
    const lobeR = 0.275;
    const lobeY = 0.328;
    lobe.position.set(lobeR * Math.sin(azimuth), lobeY, lobeR * Math.cos(azimuth));
    lobe.scale.copy(scale);
    /* Orient the lobe so its long axis follows the surface tangent (azimuth direction). */
    lobe.rotation.y = azimuth;
    lobe.castShadow = true;
    tagMesh(lobe, name);
    return lobe;
  };
  /* Back-center lobe slightly larger; two side lobes a touch smaller and asymmetric. */
  staticBuild.add(makeFoldLobe(Math.PI, new THREE.Vector3(1.4, 1.0, 0.55), 'vw_cape_hood_fold_back'));
  staticBuild.add(
    makeFoldLobe(Math.PI - 0.85, new THREE.Vector3(1.2, 0.9, 0.55), 'vw_cape_hood_fold_l'),
  );
  staticBuild.add(
    makeFoldLobe(Math.PI + 0.95, new THREE.Vector3(1.25, 0.95, 0.55), 'vw_cape_hood_fold_r'),
  );

  /* Magical hem ring on the cape (matches the robe hem glow ribbons). */
  const capeHemMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xffd47a),
    metalness: 1.0,
    roughness: 0.16,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    emissive: new THREE.Color(0xffa838),
    emissiveIntensity: 0.45,
  });
  /* TorusGeometry doesn't support partial sweeps via constructor args, so the cape
   * hem trim is implemented as a partial torus by manually building a tube along an
   * arc curve in the same XZ ring as the cape hem. */
  const capeHemY = -0.290;
  const capeHemR = 0.330;
  const hemPts: THREE.Vector3[] = [];
  const hemSamples = 64;
  for (let i = 0; i <= hemSamples; i++) {
    const t = i / hemSamples;
    const phi = capePhiStart + t * capePhiLen;
    hemPts.push(new THREE.Vector3(capeHemR * Math.sin(phi), capeHemY, capeHemR * Math.cos(phi)));
  }
  const hemCurve = new THREE.CatmullRomCurve3(hemPts);
  const capeHem = new THREE.Mesh(
    new THREE.TubeGeometry(hemCurve, 96, 0.003, 6, false),
    capeHemMat,
  );
  capeHem.castShadow = true;
  tagMesh(capeHem, 'vw_cape_hem_glow');
  staticBuild.add(capeHem);

  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.038, 0.22), trimGoldMat);
  belt.position.set(0, -0.268, 0.02);
  belt.castShadow = true;
  tagMesh(belt, 'vw_belt');
  staticBuild.add(belt);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.032, 0.024), trimGoldMat);
  buckle.position.set(0, -0.268, 0.128);
  buckle.castShadow = true;
  tagMesh(buckle, 'vw_buckle');
  staticBuild.add(buckle);

  /*
   * MAGICAL HEM TRIM. Two slim glowing-gold ribbons running around the outer robe just
   * above the hem (z-rings via TorusGeometry). Reads as enchanted embroidery without
   * the floating-rectangle problem the old vertical panels had.
   */
  const hemGlowMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xffd47a),
    metalness: 1.0,
    roughness: 0.16,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    emissive: new THREE.Color(0xffa838),
    emissiveIntensity: 0.45,
  });
  const hemRing1 = new THREE.Mesh(new THREE.TorusGeometry(0.290, 0.0028, 6, 64), hemGlowMat);
  hemRing1.rotation.x = Math.PI / 2;
  hemRing1.position.y = -0.232;
  hemRing1.castShadow = true;
  tagMesh(hemRing1, 'vw_robe_hem_glow_top');
  staticBuild.add(hemRing1);
  const hemRing2 = new THREE.Mesh(new THREE.TorusGeometry(0.296, 0.0028, 6, 64), hemGlowMat);
  hemRing2.rotation.x = Math.PI / 2;
  hemRing2.position.y = -0.252;
  hemRing2.castShadow = true;
  tagMesh(hemRing2, 'vw_robe_hem_glow_bot');
  staticBuild.add(hemRing2);

  /* Merge: ~17 sources collapse to ~5 final draw calls (one per material). The
   * `root.scale` below is applied to the merged children's transforms automatically. */
  root.add(mergeByMaterial(staticBuild));
  root.scale.set(1.034, 1.022, 1.034);
  return root;
}

/** Deterministic 0–1 hash for strand jitter (no Math.random — stable across loads). */
function strandJitter(i: number, j: number): number {
  const x = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function addBeardStrand(
  root: THREE.Group,
  mat: THREE.Material,
  points: THREE.Vector3[],
  radius: number,
  tubular: number,
  id: string,
): void {
  const curve = new THREE.CatmullRomCurve3(points);
  const mesh = new THREE.Mesh(
    new THREE.TubeGeometry(curve, tubular, radius, 6, false),
    mat,
  );
  mesh.castShadow = true;
  tagMesh(mesh, id);
  root.add(mesh);
}

/**
 * Long beard — soft under-chin volume + many thin strands (reads as hair, not a solid blob or box).
 * Peer palette: still uses `robeOuter` / jerkin slot.
 */
export function createVanguardWizardBeardLPCA(m: VanguardWizardLpcaMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-vanguard-wizard-beard';

  /* All beard parts are static after build (no per-frame transform updates) and share
   * a single material — perfect mergeByMaterial candidate. ~36 strand tubes + volume
   * sphere collapse to ONE merged mesh. Build into a staging group, then merge into
   * the returned root at the end. */
  const staticBuild = new THREE.Group();
  const bMat = m.robeOuter;

  /*
   * All beard parts shifted DOWN by ~0.045 so the mustache sits at the MOUTH (not eyes).
   * Reference: cranium center is the headRoot origin. Mouth is roughly y = -0.04, chin
   * is y = -0.09, jaw locks land on the chest at y = -0.30 for a long sage beard.
   */
  const BEARD_Y_BIAS = -0.04;

  /* Subtle fill behind strands: flattened sphere, not a revolved "beaver tail". */
  const volume = new THREE.Mesh(new THREE.SphereGeometry(0.086, 20, 16), bMat);
  volume.scale.set(1.05, 1.18, 0.62);
  volume.position.set(0, -0.135 + BEARD_Y_BIAS * 0.5, 0.060);
  volume.rotation.x = 0.38;
  volume.castShadow = true;
  tagMesh(volume, 'vw_beard_volume');
  staticBuild.add(volume);

  /* Mustache / upper lip: two tapered tubes anchored at the mouth, not the cheekbones. */
  const stacheL = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.01, -0.030, 0.108),
    new THREE.Vector3(-0.038, -0.048, 0.102),
    new THREE.Vector3(-0.072, -0.064, 0.088),
  ]);
  const stacheR = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.01, -0.030, 0.108),
    new THREE.Vector3(0.038, -0.048, 0.102),
    new THREE.Vector3(0.072, -0.064, 0.088),
  ]);
  addBeardStrand(staticBuild, bMat, stacheL.getPoints(5), 0.009, 10, 'vw_beard_stache_l');
  addBeardStrand(staticBuild, bMat, stacheR.getPoints(5), 0.009, 10, 'vw_beard_stache_r');

  /* Grid of chin / jaw strands: top row at the chin, rows extend down to the chest. */
  let strandIdx = 0;
  for (let row = 0; row < 5; row++) {
    const ty = -0.045 - row * 0.055;
    const z0 = 0.092 - row * 0.006;
    for (let col = -3; col <= 3; col++) {
      const j = strandJitter(row, col + 9);
      const tx = col * 0.026 + (j - 0.5) * 0.012;
      const midX = tx * 1.35 + (j - 0.5) * 0.025;
      const midY = ty - 0.11 - row * 0.02;
      const midZ = z0 - 0.02;
      const botX = midX * 1.05;
      const botY = midY - 0.1 - j * 0.04;
      const botZ = midZ - 0.035 + Math.abs(col) * 0.008;
      const rad = 0.0065 + strandJitter(row, col) * 0.0045;
      addBeardStrand(
        staticBuild,
        bMat,
        [
          new THREE.Vector3(tx, ty, z0),
          new THREE.Vector3(midX, midY, midZ),
          new THREE.Vector3(botX, botY, botZ),
        ],
        rad,
        14,
        `vw_beard_strand_${strandIdx}`,
      );
      strandIdx += 1;
    }
  }

  /* Heavier anchor locks at jaw corners (still tubes, slightly thicker). */
  addBeardStrand(
    staticBuild,
    bMat,
    [
      new THREE.Vector3(-0.055, -0.080, 0.085),
      new THREE.Vector3(-0.092, -0.180, 0.068),
      new THREE.Vector3(-0.085, -0.300, 0.042),
    ],
    0.012,
    18,
    'vw_beard_lock_l',
  );
  addBeardStrand(
    staticBuild,
    bMat,
    [
      new THREE.Vector3(0.055, -0.080, 0.085),
      new THREE.Vector3(0.092, -0.180, 0.068),
      new THREE.Vector3(0.085, -0.300, 0.042),
    ],
    0.012,
    18,
    'vw_beard_lock_r',
  );

  /* Single shared material → single merged mesh (~36 sources collapsed to 1). */
  root.add(mergeByMaterial(staticBuild));
  return root;
}

/**
 * DARK-FANTASY WITCH HAT — purpose-built, no hood. Parts:
 *
 *   1. Brim           - wide closed-loop LatheGeometry disc with an UPTURNED outer rim.
 *   2. Cone (lower)   - tapered LatheGeometry from brim base up to MID-HEIGHT (y=0.42).
 *                       The cone DOESN'T continue to a point — it terminates mid-air and
 *                       hands off to the curl.
 *   3. Tip curl       - long bent TubeGeometry from the cone-end up, BACK, and DOWN in
 *                       an S-curve arc — much more dramatic than a tip-only flick. Starts
 *                       at radius matching the cone end (0.050) so the seam is hidden.
 *   4. Tip star       - small jeweled bobble at the very end of the curl.
 *   5. Hat band       - open CylinderGeometry ring around the cone base, in gold trim.
 *   6. Buckle         - gold BoxGeometry on the FRONT of the band, dark inset as window.
 *   7. Magical streaks- 4 spiraling TubeGeometry strands of glowing gold that twist down
 *                       the cone surface from the curl base to the band — these are the
 *                       hat's "rune lines", the dark-fantasy magical accent.
 *
 * Materials use MeshPhysicalMaterial locally (clearcoat + sheen) so the felt reads as a
 * deep magical black with subtle reflective highlights, and the gold reads as polished
 * inlay rather than flat paint.
 */
export function createVanguardWizardHatLPCA(_m: VanguardWizardLpcaMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-vanguard-wizard-hat';

  /*
   * MATERIAL UPGRADE — local MeshPhysicalMaterial instances so we can use clearcoat for
   * the magical-black look and proper PBR gold for the brim/band/streaks. The `_m`
   * parameter is kept for signature compatibility with the rest of the LPCA helpers but
   * no longer consumed — colors are now authored directly in this function so the hat
   * always reads as true black + polished gold regardless of preset palette drift.
   */

  /*
   * HAT FELT — TRUE BLACK. Color overridden to deep neutral black (NOT sourced from
   * palette) so it reads unambiguously black regardless of the preset's hatTop hex.
   * Subtle clearcoat for a magical sheen, but NO sheenColor — sheen with a tinted color
   * was making the black look purple at grazing angles. Pure clearcoat keeps it black.
   */
  const feltMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x040406),
    roughness: 0.48,
    metalness: 0.02,
    clearcoat: 0.7,
    clearcoatRoughness: 0.18,
    side: THREE.DoubleSide,
  });

  /*
   * BRIM GOLD — POLISHED PBR GOLD. Standalone material for the brim disc so it pops
   * against the black felt cone. Higher reflectivity than the band, with a subtle
   * iridescence sheen for that "cursed gold" magical quality.
   */
  const brimGoldMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xe8b85a),
    metalness: 1.0,
    roughness: 0.12,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    iridescence: 0.35,
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [120, 380],
    emissive: new THREE.Color(0x6a4818),
    emissiveIntensity: 0.04,
    side: THREE.DoubleSide,
  });

  /* BAND / BUCKLE — slightly warmer matte gold so the band reads distinct from the
   * highly polished brim, and the buckle has its own metalwork character. */
  const trimMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xc9954a),
    metalness: 1.0,
    roughness: 0.22,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
    emissive: new THREE.Color(0x6a4418),
    emissiveIntensity: 0.05,
  });

  /* MAGICAL STREAK GOLD — brightest, most emissive. Reads as enchanted runes. */
  const streakMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xffd47a),
    metalness: 1.0,
    roughness: 0.14,
    clearcoat: 1.0,
    clearcoatRoughness: 0.04,
    emissive: new THREE.Color(0xffa838),
    emissiveIntensity: 0.6,
  });

  /* All hat parts live inside hatGroup so we can tilt the whole assembly as one. */
  const hatGroup = new THREE.Group();
  hatGroup.name = 'idlecraft-vanguard-wizard-hat-group';

  /*
   * BRIM. Closed-loop cross-section profile — going CCW around the cross-section from
   * inner-top, over the top surface, around the upturned outer rim, and back along the
   * underside. LatheGeometry revolves this loop around Y to make a brim disc with a
   * proper upturned outer edge (not a flat frisbee).
   *
   *   Cross-section (radius right, +Y up). The loop closes — last point repeats first.
   *
   *      ___---^^^---___        <- top surface curving up to rim
   *    /                   \
   *   |   inner             |   <- outer upturn
   *    \___              ___/
   *        ^^^^---___ ---^^^    <- underside
   */
  const brimProfile = [
    new THREE.Vector2(0.110, 0.020), // inner top edge (where cone meets brim)
    new THREE.Vector2(0.180, 0.012), // top surface, gently sloping out
    new THREE.Vector2(0.255, 0.005),
    new THREE.Vector2(0.305, 0.014), // start of upturn
    new THREE.Vector2(0.335, 0.034), // outer rim peak
    new THREE.Vector2(0.345, 0.052), // tip of upturn
    new THREE.Vector2(0.336, 0.060),
    new THREE.Vector2(0.310, 0.054), // back over the upturn (top side of curl)
    new THREE.Vector2(0.270, 0.034),
    new THREE.Vector2(0.220, 0.005),
    new THREE.Vector2(0.180, -0.010), // outer underside
    new THREE.Vector2(0.140, -0.014), // underside center
    new THREE.Vector2(0.115, -0.010),
    new THREE.Vector2(0.110, 0.000),
    new THREE.Vector2(0.110, 0.020), // close loop
  ];
  /* Brim is now POLISHED PBR GOLD (not felt). */
  const brim = new THREE.Mesh(new THREE.LatheGeometry(brimProfile, 56), brimGoldMat);
  brim.castShadow = true;
  brim.receiveShadow = true;
  tagMesh(brim, 'vw_hat_brim');
  hatGroup.add(brim);

  /*
   * CONE (lower half only). Tapered LatheGeometry from brim base (y=0.020, r=0.108) up
   * to MID-HEIGHT (y=0.420, r=0.050). The cone DOESN'T continue to a tip — the curl
   * picks up from the cone-end ring at radius 0.050 and arcs back from there.
   */
  const coneProfile = [
    new THREE.Vector2(0.108, 0.020), // base, snug to brim opening
    new THREE.Vector2(0.106, 0.045), // band area top
    new THREE.Vector2(0.100, 0.085),
    new THREE.Vector2(0.090, 0.150),
    new THREE.Vector2(0.078, 0.230),
    new THREE.Vector2(0.064, 0.320),
    new THREE.Vector2(0.050, 0.420), // CONE TERMINATES — curl starts here
  ];
  const cone = new THREE.Mesh(new THREE.LatheGeometry(coneProfile, 40), feltMat);
  cone.castShadow = true;
  cone.receiveShadow = true;
  tagMesh(cone, 'vw_hat_cone');
  hatGroup.add(cone);

  /*
   * HAT BAND. Thin open cylinder around the cone base, in gold trim. Sits just above
   * the brim so the band reads as a continuous strip.
   */
  const band = new THREE.Mesh(
    new THREE.CylinderGeometry(0.110, 0.110, 0.034, 40, 1, true),
    trimMat,
  );
  band.position.set(0, 0.040, 0);
  band.castShadow = true;
  tagMesh(band, 'vw_hat_band');
  hatGroup.add(band);

  /*
   * BUCKLE. Gold rectangular frame on the FRONT of the band (+Z). Inside it sits a
   * smaller dark box that reads as the buckle's open window.
   */
  const buckleFrame = new THREE.Mesh(new THREE.BoxGeometry(0.046, 0.038, 0.014), trimMat);
  buckleFrame.position.set(0, 0.040, 0.110);
  buckleFrame.castShadow = true;
  tagMesh(buckleFrame, 'vw_hat_buckle_frame');
  hatGroup.add(buckleFrame);

  const buckleHole = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.020, 0.022), feltMat);
  buckleHole.position.set(0, 0.040, 0.110);
  tagMesh(buckleHole, 'vw_hat_buckle_hole');
  hatGroup.add(buckleHole);

  /*
   * MID-CONE TIP CURL. Long S-curve TubeGeometry that picks up from the cone end
   * (0, 0.420, 0) at the matching cone-end radius, arcs UP and BACK over the head,
   * then DROOPS DOWN behind the head. Way more dramatic than a tip-only flick — the
   * top half of the cone is replaced by this curling fabric tail.
   *
   *   Control points (left = vertical, second = depth back, third = side drift):
   *     start  (0,    0.420,  0   )  cone-end seam
   *     up     (0,    0.490, -0.04)  begins to lean back
   *     mid    (0.01, 0.560, -0.16)  rising toward arc peak
   *     peak   (0.02, 0.600, -0.30)  highest + farthest back
   *     drop   (0.025,0.560, -0.42)  starting to droop
   *     hang   (0.028,0.460, -0.50)  hanging behind
   *     tip    (0.025,0.340, -0.50)  drooped tip near nape height
   */
  const curlPts = [
    new THREE.Vector3(0, 0.420, 0),
    new THREE.Vector3(0, 0.490, -0.04),
    new THREE.Vector3(0.010, 0.560, -0.16),
    new THREE.Vector3(0.020, 0.600, -0.30),
    new THREE.Vector3(0.025, 0.560, -0.42),
    new THREE.Vector3(0.028, 0.460, -0.50),
    new THREE.Vector3(0.025, 0.340, -0.50),
  ];
  const curlCurve = new THREE.CatmullRomCurve3(curlPts);
  /* Tube radius = 0.050 matches cone-end radius so the seam is hidden. */
  const tipCurl = new THREE.Mesh(
    new THREE.TubeGeometry(curlCurve, 64, 0.045, 12, false),
    feltMat,
  );
  tipCurl.castShadow = true;
  tagMesh(tipCurl, 'vw_hat_tip_curl');
  hatGroup.add(tipCurl);

  /* Smaller secondary tube tapers the curl over the last third toward the tip. */
  const taperPts = [
    new THREE.Vector3(0.025, 0.460, -0.50),
    new THREE.Vector3(0.024, 0.380, -0.510),
    new THREE.Vector3(0.022, 0.300, -0.510),
    new THREE.Vector3(0.020, 0.240, -0.500),
    new THREE.Vector3(0.018, 0.200, -0.490),
  ];
  const taperCurve = new THREE.CatmullRomCurve3(taperPts);
  const tipTaper = new THREE.Mesh(
    new THREE.TubeGeometry(taperCurve, 28, 0.022, 10, false),
    feltMat,
  );
  tipTaper.castShadow = true;
  tagMesh(tipTaper, 'vw_hat_tip_taper');
  hatGroup.add(tipTaper);

  /* TIP STAR. Small jeweled gold bobble at the very end of the curl. */
  const tipStar = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 10), trimMat);
  tipStar.position.copy(taperPts[taperPts.length - 1]!);
  tipStar.castShadow = true;
  tagMesh(tipStar, 'vw_hat_tip_star');
  hatGroup.add(tipStar);

  /*
   * MAGICAL STREAKS. Four spiraling tubes of glowing gold that twist down the cone
   * surface from the curl base (y=0.42) to the hat band (y=0.045). They sit at +0.004
   * above the cone surface so they read as inlaid runes, not as floating wires.
   *
   * Each streak twists half a turn around the cone (twists=0.5) so they sweep across
   * different facets as they descend. Streaks are evenly spaced at 90 degrees in
   * starting azimuth.
   */
  const coneRadiusAt = (y: number): number => {
    if (y <= coneProfile[0]!.y) return coneProfile[0]!.x;
    if (y >= coneProfile[coneProfile.length - 1]!.y)
      return coneProfile[coneProfile.length - 1]!.x;
    for (let i = 0; i < coneProfile.length - 1; i++) {
      const a = coneProfile[i]!;
      const b = coneProfile[i + 1]!;
      if (y >= a.y && y <= b.y) {
        const t = (y - a.y) / (b.y - a.y);
        return a.x + (b.x - a.x) * t;
      }
    }
    return coneProfile[coneProfile.length - 1]!.x;
  };

  const makeStreak = (startAz: number, name: string): THREE.Mesh => {
    const samples = 22;
    const yTop = 0.405;
    const yBot = 0.050;
    const twists = 0.5;
    const surfaceLift = 0.005;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const y = yTop - t * (yTop - yBot);
      const r = coneRadiusAt(y) + surfaceLift;
      const az = startAz + t * Math.PI * 2 * twists;
      pts.push(new THREE.Vector3(r * Math.cos(az), y, r * Math.sin(az)));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, samples * 2, 0.0035, 6, false),
      streakMat,
    );
    mesh.castShadow = true;
    tagMesh(mesh, name);
    return mesh;
  };

  hatGroup.add(makeStreak(0, 'vw_hat_streak_0'));
  hatGroup.add(makeStreak(Math.PI * 0.5, 'vw_hat_streak_1'));
  hatGroup.add(makeStreak(Math.PI, 'vw_hat_streak_2'));
  hatGroup.add(makeStreak(Math.PI * 1.5, 'vw_hat_streak_3'));

  /* Cock the hat back ~19 deg — sits jauntily angled, front brim lifted, curl tip
   * pointing back-and-up over the shoulders. */
  hatGroup.rotation.x = -0.34;
  /* Drop further so the felt nestles around the temples / sits across the brow line.
   * y=0.072 puts the brim plane at ~y=0.092 (just over the temples) — combined with
   * the backward tilt the back rim drops onto the back of the head while the front
   * rim lifts off the eyes. */
  hatGroup.position.set(0, 0.072, -0.030);
  /* Merge hat sub-meshes by material — collapses ~12+ static parts (brim, cone, band,
   * buckle, tip curl, taper, star, 4 magical streaks, etc.) into ~5 final draw calls.
   * `mergeByMaterial` bakes hatGroup's tilt + position into vertex coords, so the
   * resulting merged mesh sits correctly on the head bone. Safe because every hat
   * part is static after build (no per-frame transform updates). */
  root.add(mergeByMaterial(hatGroup));

  return root;
}

/**
 * MAGICAL DIAMOND WILLOW STAFF.
 *
 * Real diamond willow has dark red-brown heartwood with cream "diamond" sapwood patches
 * (fungal scars) along the length, and a gnarled organic character. We model this with
 * PBR materials and primitives:
 *
 *   - Heartwood shaft        - tapered CylinderGeometry, polished PBR red-brown wood
 *   - Diamond inlays         - 5 flattened cream-wood ovoids stuck to the shaft surface
 *   - Knot accents           - tiny darker burls between inlays for natural variation
 *   - Wrapped leather grip   - dark cylinder + 4 cord wrap toruses (TorusGeometry)
 *   - Crown branches         - 3 organic TubeGeometry "talons" curving up to hold the orb
 *   - Magical tip            - 3-layer fairy-style orb (faceted glass-emissive core +
 *                              two additive halo shells), tuned dimmer than night fairies
 *
 * The `_m` parameter is kept for signature compatibility but not consumed — all colors
 * are authored locally for the diamond-willow + magical-tip look.
 */
export function createVanguardWizardStaffLPCA(_m: VanguardWizardLpcaMaterials): THREE.Group {
  const root = new THREE.Group();
  root.name = 'idlecraft-vanguard-wizard-staff';

  /* All staff parts are STATIC after build (no per-frame transform updates). The staff
   * orb VFX (`vanguardStaffOrbVfx.ts`) attaches LATER as a sibling of the merged mesh
   * via `staffRoot.add(orbRoot)` — and reads `staffRoot.userData.staffOrbAttachY` set
   * at the bottom of this function. By keeping `root` untouched and only merging its
   * descendants, both contracts are preserved.
   *
   * ~95 source meshes (shaft, grip + 4 wraps, 3 talons, crown collar, 6 wire-wrap
   * crystals × 13 parts each = 78, tip body + glim + halo) collapse to ~14 final
   * draw calls (one per material — heartwood, grip, gold/silver wires, 8 gem
   * variants, 3 tip layers). */
  const staticBuild = new THREE.Group();

  /* ============ MATERIALS ============ */

  /* Heartwood — rich red-brown body of the staff. PBR with clearcoat for the "polished
   * walking-stick" finish; subtle warm sheen suggests oiled grain. */
  const heartwoodMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x4a2818),
    roughness: 0.42,
    metalness: 0.04,
    clearcoat: 0.55,
    clearcoatRoughness: 0.16,
    sheen: 0.35,
    sheenColor: new THREE.Color(0x7a3a1c),
    sheenRoughness: 0.45,
  });

  /* Leather wrap on the grip area. */
  const gripMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0x2a1810),
    roughness: 0.78,
    metalness: 0.04,
  });

  /*
   * MAGICAL TIP — vibrant orange flame-bobble. Compact, focused glow (NOT a sprawling
   * lightbulb). Shape is a small upward-tapering teardrop/finial like the witch-hat
   * tip-star, with tight additive glow shells right around it. Same fairy-tech layering
   * (additive MeshBasicMaterial, no depthWrite, no toneMapping) but with vibrant orange
   * palette and much tighter halos so the silhouette stays a defined "magical bobble"
   * instead of a glowing bulb.
   */

  /* Body — solid PBR core with VIBRANT ORANGE emissive. High emissive intensity makes
   * the surface itself glow brightly, leaning on the bloom pass for the magical pop. */
  const tipBodyMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xa84818),
    emissive: new THREE.Color(0xff7218),
    emissiveIntensity: 2.4,
    roughness: 0.28,
    metalness: 0.0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
  });

  /* Glim — tight additive bright blob, very close to body radius. */
  const tipGlimMat = new THREE.MeshBasicMaterial({
    color: 0xff9430,
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  /* Halo — modest secondary glow, NOT a wide bulb halo. */
  const tipHaloMat = new THREE.MeshBasicMaterial({
    color: 0xffae54,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });

  /*
   * Helper: displace an icosahedron's vertices outward by sin-noise so the blob shape
   * is organic and asymmetric, not a perfect sphere. Mirrors `displaceGlowBlob` from the
   * fairy system (idleCraftNightMagicLPCA.ts).
   */
  const displaceGlowBlob = (geo: THREE.BufferGeometry, strength: number): void => {
    const pos = geo.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const len = Math.sqrt(x * x + y * y + z * z) || 1;
      const n =
        Math.sin(x * 31.2 + y * 19.7 + z * 27.4) * 0.55 +
        Math.sin(x * 12.1 - z * 18.3) * 0.35;
      const disp = n * strength;
      pos.setXYZ(
        i,
        x + (x / len) * disp,
        y + (y / len) * disp * 0.82,
        z + (z / len) * disp,
      );
    }
    geo.computeVertexNormals();
  };

  /* ============ SHAFT ============ */
  const shaftLen = 1.04;
  const shaftBaseR = 0.024;
  const shaftTopR = 0.018;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(shaftTopR, shaftBaseR, shaftLen, 18, 1),
    heartwoodMat,
  );
  shaft.position.y = 0.52;
  shaft.castShadow = true;
  shaft.receiveShadow = true;
  tagMesh(shaft, 'vw_staff_shaft');
  staticBuild.add(shaft);

  /* Helper: shaft radius at height y (linear taper from base to top). */
  const shaftRadiusAt = (y: number): number => {
    const t = THREE.MathUtils.clamp(y / shaftLen, 0, 1);
    return THREE.MathUtils.lerp(shaftBaseR, shaftTopR, t);
  };

  /*
   * WIRE-WRAPPED CRYSTAL ACCENTS — vibrant colored gemstones lashed to the staff with
   * gold/silver wire bindings. The shaft is now decorated entirely with these (no more
   * diamond willow inlays — those didn't read well).
   *
   * 10 wraps spread along the shaft, alternating between TRUE GEMS (transmissive PBR
   * with strong color + emissive boost — read as glowing crystal) and METAL CRYSTALS
   * (gold/silver/copper with high reflection). Eight gem colors total: amethyst,
   * emerald, sapphire, ruby, citrine, aquamarine, rose quartz, topaz.
   *
   * Build per accent:
   *   1) Crystal     - OctahedronGeometry (8 faces, quartz-point shape) sticking
   *                    radially outward from the staff surface.
   *   2) Wire cage   - 3 TubeGeometry arcs (horizontal / vertical / diagonal) holding
   *                    the crystal in place, terminating at small anchor caps.
   *   3) Anchor caps - tiny metal spheres where the wires meet the staff surface.
   */

  /*
   * GEM MATERIAL — bright magical crystal PBR. The scene has no environment map, so
   * `transmission` would just sample the dark background and the gems would look dull
   * and dark. Instead we use a "self-lit polished crystal" approach:
   *
   *   emissive + emissiveIntensity (1.4)  bright vibrant inner glow — gem reads as the
   *                                       light source itself, independent of scene lighting
   *   clearcoat: 1.0                      mirror coating on each facet
   *   clearcoatRoughness: 0.03            razor-sharp clearcoat reflections
   *   roughness: 0.05                     polished base
   *   iridescence: 0.55                   thin-film color shift on facets — proper "gem"
   *                                       shimmer that shifts when viewed from different
   *                                       angles (oil-slick effect on jewelry)
   *   iridescenceIOR + thicknessRange     control the iridescence color sweep
   *   sheen + sheenColor                  subtle inner-tint glow
   *   flatShading: true                   hard-edge facets (real crystal look, not soft)
   *
   * Result: each gem is a vibrant glowing colored crystal that catches light at its
   * facets with iridescent rainbow shifts. Works in dim or bright scene lighting.
   */
  const gemMat = (
    color: number,
    accent: number,
    ior = 1.55,
  ): THREE.MeshPhysicalMaterial =>
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      metalness: 0.0,
      roughness: 0.05,
      ior,
      clearcoat: 1.0,
      clearcoatRoughness: 0.03,
      emissive: new THREE.Color(color),
      emissiveIntensity: 1.4,
      iridescence: 0.55,
      iridescenceIOR: 1.45,
      iridescenceThicknessRange: [200, 600],
      sheen: 0.5,
      sheenColor: new THREE.Color(accent),
      sheenRoughness: 0.3,
      flatShading: true,
    });

  /* Polished-metal PBR — same flat-shaded faceted look for the gold/silver crystals. */
  const metalMat = (
    color: number,
    roughness: number,
    emissive: number,
    emissiveIntensity = 0.04,
  ): THREE.MeshPhysicalMaterial =>
    new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      metalness: 1.0,
      roughness,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      emissive: new THREE.Color(emissive),
      emissiveIntensity,
      flatShading: true,
    });

  /*
   * Build a single hex-prism-point quartz crystal — the iconic "single-terminated"
   * crystal shape. Hexagonal CylinderGeometry body + hexagonal ConeGeometry point cap.
   * The crystal points along its local +Y axis with the base at y=0; total height is
   * `prismH + pointH = 1.5 * size`.
   *
   * Six radial segments give crystal-correct hexagonal cross-section. Combined with
   * `flatShading: true` on the material, each face renders flat — no smoothed gradients,
   * proper polished-stone facet look.
   */
  const buildQuartzCrystal = (size: number, mat: THREE.Material): THREE.Group => {
    const g = new THREE.Group();
    const r = size * 0.55;
    const prismH = size * 0.55;
    const pointH = size * 0.95;
    const prism = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, prismH, 6, 1, false),
      mat,
    );
    prism.position.y = prismH / 2;
    prism.castShadow = true;
    prism.receiveShadow = true;
    g.add(prism);
    const point = new THREE.Mesh(
      new THREE.ConeGeometry(r, pointH, 6, 1, false),
      mat,
    );
    point.position.y = prismH + pointH / 2;
    point.castShadow = true;
    g.add(point);
    return g;
  };

  /*
   * Build a 3-crystal cluster — main central crystal flanked by two smaller side
   * crystals tilted outward. Side crystals stay TIGHT to the main so the whole
   * cluster fits cleanly inside the surrounding wire cage.
   */
  const buildCrystalCluster = (size: number, mat: THREE.Material): THREE.Group => {
    const g = new THREE.Group();
    const main = buildQuartzCrystal(size, mat);
    g.add(main);
    const sideL = buildQuartzCrystal(size * 0.55, mat);
    sideL.position.set(-size * 0.22, size * 0.02, 0);
    sideL.rotation.z = 0.35;
    g.add(sideL);
    const sideR = buildQuartzCrystal(size * 0.58, mat);
    sideR.position.set(size * 0.22, size * 0.04, 0);
    sideR.rotation.z = -0.32;
    g.add(sideR);
    return g;
  };

  const goldWireMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xd9a850),
    metalness: 1.0,
    roughness: 0.22,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
  });
  const silverWireMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(0xd0d4dc),
    metalness: 1.0,
    roughness: 0.18,
    clearcoat: 0.7,
    clearcoatRoughness: 0.10,
  });

  type Wrap = {
    y: number;
    az: number;
    size: number;
    crystal: THREE.MeshPhysicalMaterial;
    wire: 'gold' | 'silver';
    cluster?: boolean;
  };
  /* 10 wraps along the shaft. Mix of single tall crystals and 3-crystal clusters for
   * visual variety. Gem ior tuned per gem type (sapphire/ruby ≈ 1.77, quartz ≈ 1.55,
   * topaz ≈ 1.62). */
  const wraps: Wrap[] = [
    /* Bottom half — denser warm/cool mix */
    { y: 0.16, az: 0.40, size: 0.014, crystal: gemMat(0xb060ff, 0x6020c0, 1.55), wire: 'gold' },
    { y: 0.25, az: 2.20, size: 0.015, crystal: metalMat(0xe2b04a, 0.16, 0x6a4818), wire: 'gold' },
    { y: 0.34, az: 3.90, size: 0.018, crystal: gemMat(0x40e070, 0x10a040, 1.55), wire: 'silver', cluster: true },
    { y: 0.42, az: 5.50, size: 0.014, crystal: gemMat(0x4080ff, 0x1040d0, 1.77), wire: 'silver' },
    /* Mid-shaft — vivid */
    { y: 0.51, az: 1.00, size: 0.018, crystal: gemMat(0xff3050, 0xc01030, 1.77), wire: 'gold', cluster: true },
    { y: 0.60, az: 2.80, size: 0.014, crystal: gemMat(0xffc028, 0xc07000, 1.62), wire: 'gold' },
    /* Upper half */
    { y: 0.68, az: 4.60, size: 0.015, crystal: metalMat(0xdce0e8, 0.10, 0x303848), wire: 'silver' },
    { y: 0.76, az: 0.20, size: 0.018, crystal: gemMat(0x40e0d8, 0x10a8a0, 1.55), wire: 'silver', cluster: true },
    { y: 0.83, az: 1.90, size: 0.014, crystal: gemMat(0xff80b0, 0xc03878, 1.55), wire: 'gold' },
    { y: 0.91, az: 3.70, size: 0.015, crystal: gemMat(0xffae40, 0xc06000, 1.62), wire: 'gold' },
  ];

  /*
   * Build a single wire arc that goes from the staff surface on one side of the
   * crystal, peaks over the crystal at a higher radius, and lands on the staff surface
   * on the other side. Three of these per crystal at different orientations form a
   * wire cage.
   */
  const makeWireArc = (
    centerAz: number,
    centerY: number,
    radialPeak: number,
    deltaAz: number,
    deltaY: number,
    mat: THREE.Material,
    name: string,
  ): THREE.Mesh => {
    const startAz = centerAz - deltaAz;
    const endAz = centerAz + deltaAz;
    const startY = centerY - deltaY;
    const endY = centerY + deltaY;
    const startR = shaftRadiusAt(startY) + 0.0008;
    const endR = shaftRadiusAt(endY) + 0.0008;
    const pts: THREE.Vector3[] = [
      new THREE.Vector3(Math.sin(startAz) * startR, startY, Math.cos(startAz) * startR),
      new THREE.Vector3(Math.sin(centerAz) * radialPeak, centerY, Math.cos(centerAz) * radialPeak),
      new THREE.Vector3(Math.sin(endAz) * endR, endY, Math.cos(endAz) * endR),
    ];
    const curve = new THREE.CatmullRomCurve3(pts);
    const arc = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 16, 0.0011, 5, false),
      mat,
    );
    arc.castShadow = true;
    tagMesh(arc, name);
    return arc;
  };

  /* Reused vector for radial orientation (avoids per-iteration allocations). */
  const _radialDir = new THREE.Vector3();
  const _yAxis = new THREE.Vector3(0, 1, 0);

  wraps.forEach((w, i) => {
    const crystalMat = w.crystal;
    const wireMat = w.wire === 'gold' ? goldWireMat : silverWireMat;
    const surfaceR = shaftRadiusAt(w.y);

    /* Crystal base sits AT the staff surface; the prism+point extends radially outward. */
    const cx = Math.sin(w.az) * surfaceR;
    const cz = Math.cos(w.az) * surfaceR;

    /* Build either a single hex-prism crystal or a 3-crystal cluster (for variety). */
    const crystal = w.cluster
      ? buildCrystalCluster(w.size, crystalMat)
      : buildQuartzCrystal(w.size, crystalMat);
    crystal.position.set(cx, w.y, cz);

    /* Orient the crystal's local +Y axis toward the radial direction so the prism
     * extends straight out from the staff surface. setFromUnitVectors handles the
     * shortest rotation between the two unit vectors. */
    _radialDir.set(Math.sin(w.az), 0, Math.cos(w.az));
    crystal.quaternion.setFromUnitVectors(_yAxis, _radialDir);

    /* Add a small twist around the radial axis (so each crystal catches light at a
     * different angle) and a slight forward/back tilt for organic asymmetry. */
    crystal.rotateOnAxis(_radialDir, i * 0.7);
    crystal.rotateZ(0.12 * (i % 2 === 0 ? 1 : -1));

    crystal.name = `vw_staff_crystal_${i}`;
    crystal.userData.lpcaId = `vw_staff_crystal_${i}`;
    staticBuild.add(crystal);

    /*
     * Wire cage — 4 arcs forming a tight cradle around the crystal:
     *   horizontal:    around the equator (left/right anchors)
     *   vertical:      top/bottom anchors
     *   diagonal A:    upper-left to lower-right
     *   diagonal B:    upper-right to lower-left
     *
     * `peakR` is set well past the crystal's outer extent (1.5*size for single,
     * up to ~1.7*size for clusters) so the wire passes OVER the crystal apex
     * rather than clipping through it.
     */
    const peakR = surfaceR + w.size * 1.85;
    const hAz = 0.5; // horizontal arc azimuth half-width
    const vDy = w.size * 1.7; // vertical arc half-height
    const dAz = 0.36;
    const dDy = w.size * 1.2;

    staticBuild.add(
      makeWireArc(w.az, w.y, peakR, hAz, 0, wireMat, `vw_staff_wire_h_${i}`),
    );
    staticBuild.add(
      makeWireArc(w.az, w.y, peakR, 0, vDy, wireMat, `vw_staff_wire_v_${i}`),
    );
    staticBuild.add(
      makeWireArc(w.az, w.y, peakR, dAz, dDy, wireMat, `vw_staff_wire_d1_${i}`),
    );
    staticBuild.add(
      makeWireArc(w.az, w.y, peakR, -dAz, dDy, wireMat, `vw_staff_wire_d2_${i}`),
    );

    /* Anchor caps — tiny metal spheres at each of the 8 wire endpoints. */
    const anchorPositions: { az: number; y: number }[] = [
      { az: w.az - hAz, y: w.y },
      { az: w.az + hAz, y: w.y },
      { az: w.az, y: w.y - vDy },
      { az: w.az, y: w.y + vDy },
      { az: w.az - dAz, y: w.y - dDy },
      { az: w.az + dAz, y: w.y + dDy },
      { az: w.az + dAz, y: w.y - dDy },
      { az: w.az - dAz, y: w.y + dDy },
    ];
    anchorPositions.forEach((a, j) => {
      const ar = shaftRadiusAt(a.y) + 0.0008;
      const anchor = new THREE.Mesh(new THREE.SphereGeometry(0.0024, 8, 6), wireMat);
      anchor.position.set(Math.sin(a.az) * ar, a.y, Math.cos(a.az) * ar);
      anchor.castShadow = true;
      tagMesh(anchor, `vw_staff_wire_anchor_${i}_${j}`);
      staticBuild.add(anchor);
    });
  });

  /* ============ LEATHER GRIP ============ */
  const gripY = 0.10;
  const grip = new THREE.Mesh(
    new THREE.CylinderGeometry(0.028, 0.030, 0.16, 16, 1),
    gripMat,
  );
  grip.position.y = gripY;
  grip.castShadow = true;
  tagMesh(grip, 'vw_staff_grip');
  staticBuild.add(grip);

  /* Cord wraps around the grip — 4 thin toruses for cinch detail. */
  for (let i = 0; i < 4; i++) {
    const wrap = new THREE.Mesh(
      new THREE.TorusGeometry(0.030, 0.0028, 6, 22),
      gripMat,
    );
    wrap.rotation.x = Math.PI / 2;
    wrap.position.y = gripY - 0.06 + i * 0.035;
    wrap.castShadow = true;
    tagMesh(wrap, `vw_staff_grip_wrap_${i}`);
    staticBuild.add(wrap);
  }

  /* ============ CROWN — 3 organic talons holding the orb ============ */
  const crownBaseY = 1.018;

  /* Crown collar — thin tapered cylinder where the talons emerge. */
  const crownCollar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.020, 0.022, 0.026, 14),
    heartwoodMat,
  );
  crownCollar.position.y = crownBaseY;
  crownCollar.castShadow = true;
  tagMesh(crownCollar, 'vw_staff_crown_collar');
  staticBuild.add(crownCollar);

  /* 3 curving wood talons, evenly spaced around the collar, that arc UP and INWARD
   * to cradle the orb. */
  const orbCenterY = crownBaseY + 0.085;
  for (let i = 0; i < 3; i++) {
    const az = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const sx = Math.sin(az);
    const sz = Math.cos(az);
    const talonPts = [
      new THREE.Vector3(sx * 0.022, crownBaseY + 0.013, sz * 0.022),
      new THREE.Vector3(sx * 0.034, crownBaseY + 0.040, sz * 0.034),
      new THREE.Vector3(sx * 0.040, crownBaseY + 0.068, sz * 0.040),
      new THREE.Vector3(sx * 0.034, crownBaseY + 0.092, sz * 0.034),
      new THREE.Vector3(sx * 0.022, crownBaseY + 0.108, sz * 0.022),
    ];
    const talonCurve = new THREE.CatmullRomCurve3(talonPts);
    const talon = new THREE.Mesh(
      new THREE.TubeGeometry(talonCurve, 18, 0.0055, 6, false),
      heartwoodMat,
    );
    talon.castShadow = true;
    tagMesh(talon, `vw_staff_talon_${i}`);
    staticBuild.add(talon);
  }

  /* ============ MAGICAL TIP — compact orange flame-bobble ============
   *
   * Three layers ONLY (no sprawling outer halo or wisps that made the previous tip
   * read as a lightbulb):
   *   1) Body — small upward-tapered displaced icosahedron, PBR orange emissive
   *   2) Glim — TIGHT additive shell, only slightly larger than the body
   *   3) Halo — modest additive halo (NOT a wide bulb)
   *
   * Body is scaled vertically so the silhouette is a small finial / flame-tip shape
   * rather than a round ball — matches the witch-hat tip-star's compact character.
   */

  /* Body — small, vertically tapered, with downward-stretched bottom and pointed top
   * for a finial/flame-tip silhouette. Scale (0.85, 1.55, 0.85) elongates it. */
  const bodyGeo = new THREE.IcosahedronGeometry(0.016, 2);
  bodyGeo.scale(0.85, 1.55, 0.85);
  displaceGlowBlob(bodyGeo, 0.0025);
  const tipBody = new THREE.Mesh(bodyGeo, tipBodyMat);
  tipBody.position.y = orbCenterY;
  tagMesh(tipBody, 'vw_staff_tip_body');
  staticBuild.add(tipBody);

  /* Glim — tight additive shell hugging the body so the magical glow reads as the
   * bobble itself, not a separate bulb around it. */
  const glimGeo = new THREE.IcosahedronGeometry(0.020, 2);
  glimGeo.scale(0.9, 1.5, 0.9);
  displaceGlowBlob(glimGeo, 0.003);
  const tipGlim = new THREE.Mesh(glimGeo, tipGlimMat);
  tipGlim.position.y = orbCenterY;
  tagMesh(tipGlim, 'vw_staff_tip_glim');
  staticBuild.add(tipGlim);

  /* Halo — modest secondary, slightly bigger but still tip-shaped. */
  const haloGeo = new THREE.IcosahedronGeometry(0.030, 1);
  haloGeo.scale(0.95, 1.45, 0.95);
  displaceGlowBlob(haloGeo, 0.005);
  const tipHalo = new THREE.Mesh(haloGeo, tipHaloMat);
  tipHalo.position.y = orbCenterY;
  tagMesh(tipHalo, 'vw_staff_tip_halo');
  staticBuild.add(tipHalo);

  /* Merge — collapses ~95 staff source meshes to ~14 final draw calls. The orb VFX
   * (added later via `staffRoot.add(orbRoot)`) attaches as a SIBLING of the merged
   * group, so its independent animation continues to work. */
  root.add(mergeByMaterial(staticBuild));
  root.userData.staffOrbAttachY = orbCenterY + 0.005;
  return root;
}
