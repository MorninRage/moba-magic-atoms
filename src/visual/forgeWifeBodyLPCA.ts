/**
 * IDLE-CRAFT — Forge-wife torso: female lathe silhouette (waist / bust / hip) + jerkin shell.
 * Replaces the male trunk lathes when visible — not a uniform scale of the male mesh.
 */
import * as THREE from 'three';

function torsoLathe(
  material: THREE.MeshStandardMaterial,
  radii: number[],
  zScale: number,
): THREE.Mesh {
  const pts = radii.map((rad, i) => {
    const t = i / (radii.length - 1);
    const y = t * 0.25;
    return new THREE.Vector2(rad, y);
  });
  const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 38), material);
  mesh.scale.set(1, 1, zScale);
  mesh.position.set(0, 0.055, 0);
  mesh.castShadow = true;
  return mesh;
}

/**
 * Female dress-form: narrower waist, fuller bust line, hip flare at hem.
 */
export function createForgeWifeTorsoLPCA(mats: {
  undertunic: THREE.MeshStandardMaterial;
  jerkin: THREE.MeshStandardMaterial;
}): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-forge-wife-torso';
  /* Waist 0.124 → bust 0.178 → upper chest 0.168 → rib 0.152 → hip flare 0.138 */
  const underR = [0.124, 0.148, 0.175, 0.178, 0.162, 0.138, 0.102];
  const under = torsoLathe(mats.undertunic, underR, 0.66);
  g.add(under);

  const jerR = [0.132, 0.152, 0.182, 0.186, 0.168, 0.145, 0.108];
  const jer = torsoLathe(mats.jerkin, jerR, 0.69);
  jer.position.z = 0.007;
  g.add(jer);

  return g;
}

/** Chest + hip read in jerkin/undertunic materials (layered on lathe). */
export function createForgeWifeFigureOverlay(mats: {
  undertunic: THREE.MeshStandardMaterial;
  jerkin: THREE.MeshStandardMaterial;
}): THREE.Group {
  const g = new THREE.Group();
  g.name = 'idlecraft-forge-wife-overlay';

  const bustL = new THREE.Mesh(new THREE.SphereGeometry(0.056, 18, 16), mats.undertunic);
  bustL.position.set(-0.074, 0.198, 0.042);
  bustL.scale.set(1, 1.12, 0.82);
  bustL.castShadow = true;
  g.add(bustL);
  const bustR = bustL.clone();
  bustR.position.x = 0.074;
  g.add(bustR);

  const jerkinDrapeL = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 12), mats.jerkin);
  jerkinDrapeL.position.set(-0.068, 0.192, 0.055);
  jerkinDrapeL.scale.set(0.95, 1.05, 0.72);
  jerkinDrapeL.castShadow = true;
  g.add(jerkinDrapeL);
  const jerkinDrapeR = jerkinDrapeL.clone();
  jerkinDrapeR.position.x = 0.068;
  g.add(jerkinDrapeR);

  const hip = new THREE.Mesh(new THREE.TorusGeometry(0.128, 0.032, 12, 36), mats.jerkin);
  hip.rotation.x = Math.PI / 2;
  hip.position.set(0, 0.112, -0.018);
  hip.scale.set(1.14, 1, 1.08);
  hip.castShadow = true;
  g.add(hip);

  return g;
}
