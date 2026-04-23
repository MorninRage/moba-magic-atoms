/**
 * LPCA plasma portal — layered procedural construction (no textures).
 * Standing vertical gateway (opening faces +Z / walk-through along −Z); toruses stay in XY plane.
 * Build: outer corona → counter-torus → inner veil ring → transmission core → depth tunnel → rim arcs → lights.
 */
import * as THREE from 'three';

export type PlasmaPortalLPCA = {
  group: THREE.Group;
  dispose: () => void;
  tick: (timeSec: number, clipProgress01: number) => void;
};

function phys(opts: THREE.MeshPhysicalMaterialParameters): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    roughness: 0.26,
    metalness: 0.1,
    envMapIntensity: 1.12,
    ...opts,
  });
}

export function createPlasmaPortalLPCA(): PlasmaPortalLPCA {
  const group = new THREE.Group();
  /* Slight oval: classic “magic mirror” standing portal, not a floor halo */
  group.scale.set(1, 1.16, 1);

  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];

  const outerGeo = new THREE.TorusGeometry(0.4, 0.056, 28, 96);
  geos.push(outerGeo);
  const outerMat = phys({
    color: 0x140a22,
    emissive: 0x8b3dff,
    emissiveIntensity: 1.22,
    iridescence: 0.92,
    iridescenceIOR: 1.48,
    iridescenceThicknessRange: [90, 480],
    clearcoat: 0.62,
    clearcoatRoughness: 0.18,
  });
  mats.push(outerMat);
  const outer = new THREE.Mesh(outerGeo, outerMat);
  group.add(outer);

  const midGeo = new THREE.TorusGeometry(0.29, 0.024, 18, 80);
  geos.push(midGeo);
  const midMat = phys({
    color: 0x001828,
    emissive: 0x22f0ff,
    emissiveIntensity: 1.02,
    transparent: true,
    opacity: 0.9,
    transmission: 0.28,
    thickness: 0.16,
  });
  mats.push(midMat);
  const mid = new THREE.Mesh(midGeo, midMat);
  group.add(mid);

  const veilGeo = new THREE.RingGeometry(0.12, 0.21, 72);
  geos.push(veilGeo);
  const veilMat = phys({
    color: 0x0a0618,
    emissive: 0xff6ec7,
    emissiveIntensity: 0.88,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    transmission: 0.35,
    thickness: 0.08,
  });
  mats.push(veilMat);
  const veil = new THREE.Mesh(veilGeo, veilMat);
  veil.position.z = 0.012;
  group.add(veil);

  const coreGeo = new THREE.CircleGeometry(0.2, 72);
  geos.push(coreGeo);
  const coreMat = phys({
    color: 0x000c14,
    emissive: 0x7af8ff,
    emissiveIntensity: 1.55,
    transmission: 0.78,
    thickness: 0.58,
    ior: 1.2,
    transparent: true,
    opacity: 0.93,
    side: THREE.DoubleSide,
  });
  mats.push(coreMat);
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.z = 0.024;
  group.add(core);

  /* Receding tunnel — BackSide reads as infinite magical depth behind the membrane */
  const tunnelGeo = new THREE.CylinderGeometry(0.17, 0.2, 0.32, 56, 1, true);
  geos.push(tunnelGeo);
  const tunnelMat = phys({
    color: 0x020008,
    emissive: 0x4a0a8c,
    emissiveIntensity: 0.55,
    side: THREE.BackSide,
    roughness: 0.48,
    metalness: 0.06,
  });
  mats.push(tunnelMat);
  const tunnel = new THREE.Mesh(tunnelGeo, tunnelMat);
  tunnel.rotation.x = Math.PI / 2;
  tunnel.position.z = -0.16;
  group.add(tunnel);

  const arcMeshes: THREE.Mesh[] = [];
  const arcCount = 12;
  for (let i = 0; i < arcCount; i++) {
    const arcGeo = new THREE.TorusGeometry(0.375 + (i % 3) * 0.012, 0.0065, 8, 40, Math.PI * 0.42);
    geos.push(arcGeo);
    const hue = i % 3;
    const arcMat = phys({
      color: 0x060618,
      emissive: hue === 0 ? 0xff4dd8 : hue === 1 ? 0x66f0ff : 0xc9a6ff,
      emissiveIntensity: 0.82,
      transparent: true,
      opacity: 0.55,
    });
    mats.push(arcMat);
    const arc = new THREE.Mesh(arcGeo, arcMat);
    arc.rotation.z = (i / arcCount) * Math.PI * 2 + (i % 2) * 0.09;
    arc.position.z = 0.004 * (i % 4);
    group.add(arc);
    arcMeshes.push(arc);
  }

  const pl = new THREE.PointLight(0xd4a8ff, 2.55, 5.5, 1.15);
  pl.position.set(0, 0.06, 0.12);
  group.add(pl);

  const fill = new THREE.PointLight(0x66fff6, 0.95, 3.8, 1.45);
  fill.position.set(-0.14, -0.08, 0.08);
  group.add(fill);

  const rimGlow = new THREE.PointLight(0xffb8f0, 0.55, 2.8, 1.8);
  rimGlow.position.set(0.18, 0.14, 0.06);
  group.add(rimGlow);

  function dispose(): void {
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  }

  function tick(timeSec: number, u: number): void {
    const pulse = 0.88 + Math.sin(timeSec * 3.2) * 0.14;
    const twinkle = 0.92 + Math.sin(timeSec * 5.7) * 0.08;
    const surge = 0.62 + u * 1.42;
    outer.rotation.z = timeSec * 0.38;
    mid.rotation.z = -timeSec * 0.72;
    veil.rotation.z = timeSec * 0.24;
    core.rotation.z = timeSec * 0.15;
    tunnel.rotation.z = timeSec * 0.08;

    outerMat.emissiveIntensity = (1.08 * pulse + u * 1.02) * surge;
    midMat.emissiveIntensity = (0.88 * pulse + u * 1.08) * surge;
    veilMat.emissiveIntensity = (0.72 * twinkle + u * 1.15 + Math.sin(timeSec * 4.1) * 0.12) * surge;
    coreMat.emissiveIntensity = (1.28 + u * 1.45 + Math.sin(timeSec * 5.2) * 0.2) * surge;
    tunnelMat.emissiveIntensity = 0.42 + u * 0.62 + Math.sin(timeSec * 2.4) * 0.1;

    pl.intensity = 2.2 + u * 3.4 + Math.sin(timeSec * 4.1) * 0.5;
    fill.intensity = 0.75 + u * 1.15 + Math.sin(timeSec * 3.3) * 0.12;
    rimGlow.intensity = 0.42 + u * 0.85 + Math.sin(timeSec * 6.2) * 0.18;

    arcMeshes.forEach((a, i) => {
      a.rotation.z += 0.011 * (i % 2 === 0 ? 1 : -1);
      const m = a.material as THREE.MeshPhysicalMaterial;
      m.emissiveIntensity = (0.58 + u * 0.98 + 0.18 * Math.sin(timeSec * 3.1 + i * 0.7)) * surge;
    });
  }

  return { group, dispose, tick };
}
