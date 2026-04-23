/**
 * Vanguard wizard staff tip — one glassy shell + orbiting glitter.
 * Avoids a second transparent sphere inside the shell: same-center transparent meshes get unstable
 * depth sort and read as a strobing whole-orb flash. No per-frame material edits — only instance motion.
 */
import * as THREE from 'three';
import type { GraphicsTier } from '../engine/graphicsTier';

const _tmpPal = new THREE.Color();
const _blend = new THREE.Color(0xf7c948);
const _dummy = new THREE.Object3D();

export type VanguardStaffOrbVfxHandle = {
  update: (dt: number) => void;
  setActive: (v: boolean) => void;
  syncPalette: (hairHex: number, trimHex: number) => void;
  dispose: () => void;
};

export function createVanguardStaffOrbVfx(opts: {
  staffRoot: THREE.Group;
  tier: GraphicsTier;
}): VanguardStaffOrbVfxHandle {
  const { staffRoot, tier } = opts;
  const glitterCount = tier === 'low' ? 22 : 38;
  const GLITTER_EMISSIVE_I = 0.28;
  const OUTER_EMISSIVE_I = 0.44;

  const orbRoot = new THREE.Group();
  orbRoot.name = 'idlecraft-vanguard-staff-orb';
  const attachY = (staffRoot.userData.staffOrbAttachY as number | undefined) ?? 0.93;
  orbRoot.position.set(0, attachY, 0);
  staffRoot.add(orbRoot);

  /* One translucent shell only — avoids transparent sort fights with an inner sphere. */
  const outerMat = new THREE.MeshPhysicalMaterial({
    color: 0xffe6a8,
    emissive: 0xffaa44,
    emissiveIntensity: OUTER_EMISSIVE_I,
    metalness: 0.08,
    roughness: 0.3,
    transparent: true,
    opacity: 0.96,
    transmission: 0.22,
    thickness: 0.09,
    ior: 1.46,
    envMapIntensity: 0.55,
  });
  const outer = new THREE.Mesh(new THREE.SphereGeometry(0.056, 22, 18), outerMat);
  outer.castShadow = false;
  orbRoot.add(outer);

  /* Very soft fill — emissive on outer carries most of the read; strong point lights + glass = pumping highlights. */
  const rim = new THREE.PointLight(0xffcc88, 0.22, 3.2, 2.2);
  orbRoot.add(rim);

  /* —— Suspended glitter: small faceted meshes, LPCA-style PBR —— */
  const glitterGeo = new THREE.IcosahedronGeometry(0.0055, 0);
  const glitterMat = new THREE.MeshPhysicalMaterial({
    color: 0xffe8c0,
    emissive: 0xffb040,
    emissiveIntensity: GLITTER_EMISSIVE_I,
    metalness: 0.62,
    roughness: 0.16,
    envMapIntensity: 0.52,
    transmission: 0.18,
    thickness: 0.05,
    ior: 1.52,
    transparent: true,
    opacity: 1,
    clearcoat: 0.55,
    clearcoatRoughness: 0.12,
    iridescence: 0.18,
    iridescenceIOR: 1.45,
    iridescenceThicknessRange: [80, 320],
    side: THREE.DoubleSide,
  });

  const glitter = new THREE.InstancedMesh(glitterGeo, glitterMat, glitterCount);
  glitter.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  glitter.frustumCulled = false;
  glitter.castShadow = false;
  glitter.receiveShadow = false;
  glitter.renderOrder = 1;
  orbRoot.add(glitter);

  const phases = new Float32Array(glitterCount);
  const speeds = new Float32Array(glitterCount);
  const radii = new Float32Array(glitterCount);
  const seed = (s: number) => {
    const x = Math.sin(s * 12.9898) * 43758.5453;
    return x - Math.floor(x);
  };
  for (let i = 0; i < glitterCount; i++) {
    phases[i] = seed(i) * Math.PI * 2;
    speeds[i] = 0.85 + seed(i + 17) * 1.15;
    radii[i] = 0.062 + seed(i + 31) * 0.052;
  }

  let active = true;

  const syncPalette = (hairHex: number, trimHex: number): void => {
    _tmpPal.setHex(trimHex);
    _blend.setHex(hairHex);
    _tmpPal.lerp(_blend, 0.35);
    outerMat.emissive.copy(_tmpPal);
    outerMat.emissiveIntensity = OUTER_EMISSIVE_I;
    outerMat.color.copy(_tmpPal).lerp(new THREE.Color(0xffffff), 0.52);
    rim.color.copy(_tmpPal).lerp(new THREE.Color(0xffddaa), 0.22);
    glitterMat.emissive.copy(_tmpPal).lerp(new THREE.Color(0xffcc66), 0.25);
    glitterMat.emissiveIntensity = GLITTER_EMISSIVE_I;
    glitterMat.color.copy(_tmpPal).lerp(new THREE.Color(0xfff0d0), 0.45);
  };

  syncPalette(0x3d2818, 0xc9a227);

  const setActive = (v: boolean): void => {
    active = v;
    orbRoot.visible = v;
  };

  const update = (dt: number): void => {
    if (!active) return;
    const shell = 1;
    for (let i = 0; i < glitterCount; i++) {
      phases[i] += dt * speeds[i] * 0.55;
      const ph = phases[i];
      const r0 = radii[i]! * shell;
      const u = (i / glitterCount) * Math.PI * 2 + ph * 0.15;
      const v = ph * 1.1 + i * 0.37;
      const x = r0 * Math.cos(u) * Math.sin(v);
      const y = r0 * Math.sin(u) * 0.55 + 0.012 * Math.sin(ph * 2.4);
      const z = r0 * Math.cos(v);
      _dummy.position.set(x, y, z);
      const s = 0.9 + 0.1 * (0.5 + 0.5 * Math.sin(ph * 1.15 + i));
      _dummy.scale.setScalar(s);
      _dummy.rotation.set(ph * 2.2 + i * 0.2, ph * 1.7, ph * 1.4);
      _dummy.updateMatrix();
      glitter.setMatrixAt(i, _dummy.matrix);
    }
    glitter.instanceMatrix.needsUpdate = true;
  };

  const dispose = (): void => {
    staffRoot.remove(orbRoot);
    glitterGeo.dispose();
    glitterMat.dispose();
    outer.geometry.dispose();
    outerMat.dispose();
  };

  setActive(false);

  return { update, setActive, syncPalette, dispose };
}
