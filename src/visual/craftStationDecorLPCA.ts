/**
 * LPCA craft station props — layered procedural only (no textures).
 * Campfire: stone ring → log crib → ember bed → flame column (multi cones + core) → flicker light.
 * Hand torch: char stake → iron collar → resin wick → multi-lick flame + ember + flicker lights.
 * Workbench: slab top → splayed legs → apron → peg rail → simple tool silhouettes.
 */
import * as THREE from 'three';
import { mergeByMaterial } from 'empire-engine/lpca';

export type CampfireLPCA = {
  group: THREE.Group;
  dispose: () => void;
  tick: (timeSec: number) => void;
};

/**
 * Optional pre-existing PointLights for the campfire to drive instead of creating its own.
 *
 * **Why this matters:** Three.js's `WebGLPrograms` hashes lit-material shader programs by
 * `numPointLights`. If `createCampfireLPCA()` adds 2 fresh PointLights to the scene at
 * craft-time, the count flips from N → N+2 and **every existing lit material in the scene
 * (terrain, trees, rocks, fungi, water, vegetation, avatar, equipment, …) is recompiled
 * synchronously on the main thread**. Same root pattern as the first-sunset shadow-light
 * freeze documented in `LEARNINGS.md`.
 *
 * The fix is for the host scene to keep two permanent phantom PointLights at the campfire's
 * eventual world position with `intensity = 0` from boot onwards — `numPointLights` is then
 * constant for the session. Pass them into this builder; we drive their intensity / color in
 * `tick()` and reset them to `intensity = 0` in `dispose()` (we never dispose the lights
 * themselves — they stay alive on the scene).
 */
export type CampfireLPCAOptions = {
  fireLight?: THREE.PointLight;
  hotLight?: THREE.PointLight;
};

export type HandTorchLPCA = {
  group: THREE.Group;
  dispose: () => void;
  tick: (timeSec: number) => void;
};

/**
 * Same phantom-light pattern as `CampfireLPCAOptions` (see header comment block above).
 * The torch's flame `PointLight` is toggled from invisible → visible when the player
 * pulls the torch out, which would flip `numPointLights` and trigger a scene-wide
 * shader recompile freeze (5+ s on first use). The fix: host scene parks a permanent
 * `PointLight` on the right hand at boot with `intensity = 0`. `createHandTorchLPCA`
 * reuses it, animates intensity in `tick()`, resets to 0 in `dispose()`. The light is
 * always counted by Three.js's lighting state — no recompile when torch becomes visible.
 */
export type HandTorchLPCAOptions = {
  fireLight?: THREE.PointLight;
};

export type WorkbenchLPCA = {
  group: THREE.Group;
  dispose: () => void;
};

function stdWood(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x5c4330,
    roughness: 0.88,
    metalness: 0.02,
  });
}

function charWood(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x3a2820,
    roughness: 0.92,
    metalness: 0.02,
  });
}

function stoneMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x6a6a62,
    roughness: 0.78,
    metalness: 0.04,
  });
}

export function createCampfireLPCA(opts?: CampfireLPCAOptions): CampfireLPCA {
  const group = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const reusingLights = !!opts?.fireLight && !!opts?.hotLight;

  /* L1 — compact ash pan */
  const ashGeo = new THREE.CylinderGeometry(0.2, 0.22, 0.028, 18);
  geos.push(ashGeo);
  const ashMat = new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.95 });
  mats.push(ashMat);
  const ash = new THREE.Mesh(ashGeo, ashMat);
  ash.position.y = 0.014;
  group.add(ash);

  /* L2 — stone collar */
  const nStone = 9;
  for (let i = 0; i < nStone; i++) {
    const ang = (i / nStone) * Math.PI * 2;
    const sg = new THREE.DodecahedronGeometry(0.038 + (i % 3) * 0.01, 0);
    geos.push(sg);
    const sm = stoneMat();
    mats.push(sm);
    const rock = new THREE.Mesh(sg, sm);
    const r = 0.2 + (i % 2) * 0.02;
    rock.position.set(Math.sin(ang) * r, 0.04 + (i % 2) * 0.015, Math.cos(ang) * r);
    rock.rotation.set(0.2 + i * 0.15, ang, 0.1);
    rock.scale.setScalar(0.85 + (i % 3) * 0.12);
    group.add(rock);
  }

  /* L3 — log crib (crossed) */
  const logMat = charWood();
  mats.push(logMat);
  for (let i = 0; i < 4; i++) {
    const lg = new THREE.CylinderGeometry(0.034, 0.042, 0.22, 8);
    geos.push(lg);
    const log = new THREE.Mesh(lg, logMat);
    const a = (i / 4) * Math.PI;
    log.rotation.z = Math.PI / 2;
    log.rotation.y = a;
    log.position.y = 0.08;
    group.add(log);
  }

  /* L4 — ember bed (glow) */
  const emberGeo = new THREE.CircleGeometry(0.11, 24);
  geos.push(emberGeo);
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0x1a0804,
    emissive: 0xff5522,
    emissiveIntensity: 1.1,
    roughness: 0.9,
  });
  mats.push(emberMat);
  const ember = new THREE.Mesh(emberGeo, emberMat);
  ember.rotation.x = -Math.PI / 2;
  ember.position.y = 0.032;
  group.add(ember);

  /* L5 — flame column: inner hot core + three licks */
  const flames: THREE.Mesh[] = [];

  const coreGeo = new THREE.SphereGeometry(0.055, 14, 12);
  geos.push(coreGeo);
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xffcc44,
    emissive: 0xffaa22,
    emissiveIntensity: 2.2,
    transparent: true,
    opacity: 0.88,
    roughness: 0.35,
  });
  mats.push(coreMat);
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.y = 0.14;
  group.add(core);
  flames.push(core);

  const coneSpecs = [
    { r: 0.07, h: 0.22, y: 0.12, x: 0, z: 0, rx: 0.08 },
    { r: 0.055, h: 0.2, y: 0.11, x: 0.05, z: 0.03, rx: 0.12, rz: 0.2 },
    { r: 0.052, h: 0.18, y: 0.1, x: -0.045, z: -0.02, rx: 0.1, rz: -0.25 },
  ];
  for (const s of coneSpecs) {
    const cg = new THREE.ConeGeometry(s.r, s.h, 10);
    geos.push(cg);
    const cm = new THREE.MeshStandardMaterial({
      color: 0xff6620,
      emissive: 0xff3300,
      emissiveIntensity: 1.45,
      transparent: true,
      opacity: 0.82,
      roughness: 0.42,
    });
    mats.push(cm);
    const fl = new THREE.Mesh(cg, cm);
    fl.position.set(s.x, s.y + s.h * 0.5, s.z);
    fl.rotation.x = s.rx;
    fl.rotation.z = s.rz ?? 0;
    group.add(fl);
    flames.push(fl);
  }

  /**
   * If the host scene supplied phantom lights (recommended path — see
   * `CampfireLPCAOptions`), reuse them; otherwise fall back to creating fresh
   * lights and adding them to this group (legacy / standalone path; will trigger
   * the program-recompile freeze on first use). Reused lights stay parented to
   * the scene so their world position is fixed at the campfire pit.
   */
  const fireLight = opts?.fireLight ?? new THREE.PointLight(0xff8833, 2.2, 2.4, 1.35);
  const hotLight = opts?.hotLight ?? new THREE.PointLight(0xffcc66, 0.65, 1.2, 1.8);
  if (!reusingLights) {
    fireLight.position.set(0, 0.2, 0);
    hotLight.position.set(0.04, 0.26, 0.04);
    group.add(fireLight);
    group.add(hotLight);
  }

  function dispose(): void {
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    /* Reused lights belong to the scene, not us — return them to the dormant
     * `intensity = 0` state so they keep counting toward `numPointLights`
     * without contributing any visible light, ready for the next craft. */
    if (reusingLights) {
      fireLight.intensity = 0;
      hotLight.intensity = 0;
    }
  }

  function tick(timeSec: number): void {
    const f = 0.92 + Math.sin(timeSec * 11.2) * 0.08 + Math.sin(timeSec * 23.7) * 0.04;
    const s = 1 + Math.sin(timeSec * 7.3) * 0.07;
    fireLight.intensity = 1.85 + Math.sin(timeSec * 14) * 0.45;
    hotLight.intensity = 0.5 + Math.sin(timeSec * 18) * 0.22;
    emberMat.emissiveIntensity = 0.95 + Math.sin(timeSec * 9) * 0.18;
    flames.forEach((mesh, i) => {
      const m = mesh.material as THREE.MeshStandardMaterial;
      const wave = Math.sin(timeSec * (10 + i * 2.1) + i);
      m.emissiveIntensity = (1.2 + i * 0.25 + wave * 0.2) * f;
      mesh.scale.set(1 + wave * 0.04 * (i + 1), s + wave * 0.06, 1 + wave * 0.04 * (i + 1));
    });
  }

  return { group, dispose, tick };
}

function ironBandMat(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: 0x4a4a52,
    metalness: 0.62,
    roughness: 0.38,
  });
}

/**
 * Held survival torch — same spirit as {@link createCampfireLPCA}: layered mesh +
 * emissive + tick flicker, plus an optional reuse-host-light path (see
 * `HandTorchLPCAOptions`) so the torch's flame light doesn't trigger a scene-wide
 * shader recompile freeze the first time the player pulls the torch out.
 */
export function createHandTorchLPCA(opts?: HandTorchLPCAOptions): HandTorchLPCA {
  const group = new THREE.Group();
  const mats: THREE.Material[] = [];
  const reusingLight = !!opts?.fireLight;

  /* L1 — charred haft (tapered stake) */
  const haftGeo = new THREE.CylinderGeometry(0.022, 0.038, 0.42, 10);
  const haftMat = new THREE.MeshStandardMaterial({
    color: 0x2a1810,
    roughness: 0.91,
    metalness: 0.02,
  });
  mats.push(haftMat);
  const haft = new THREE.Mesh(haftGeo, haftMat);
  haft.position.y = 0.21;
  haft.castShadow = true;
  group.add(haft);

  /* L2 — fiber grip wraps (merged draw) */
  const wrapMat = new THREE.MeshStandardMaterial({
    color: 0x4a3828,
    roughness: 0.92,
    metalness: 0.02,
  });
  mats.push(wrapMat);
  const wrapStaging = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const wg = new THREE.TorusGeometry(0.036 + i * 0.006, 0.008, 6, 12);
    const w = new THREE.Mesh(wg, wrapMat);
    w.rotation.x = Math.PI / 2;
    w.position.y = 0.08 + i * 0.095;
    w.scale.set(1, 1, 0.72);
    wrapStaging.add(w);
  }
  wrapStaging.updateMatrixWorld(true);
  group.add(mergeByMaterial(wrapStaging));

  /* L3 — forged collar + rivet bumps (merged draw) */
  const collarGeo = new THREE.CylinderGeometry(0.044, 0.04, 0.028, 12);
  const im = ironBandMat();
  mats.push(im);
  const ironStaging = new THREE.Group();
  const collar = new THREE.Mesh(collarGeo, im);
  collar.position.y = 0.395;
  collar.castShadow = true;
  ironStaging.add(collar);
  for (let i = 0; i < 4; i++) {
    const rg = new THREE.SphereGeometry(0.012, 8, 6);
    const riv = new THREE.Mesh(rg, im);
    const a = (i / 4) * Math.PI * 2;
    riv.position.set(Math.cos(a) * 0.038, 0.402, Math.sin(a) * 0.038);
    ironStaging.add(riv);
  }
  ironStaging.updateMatrixWorld(true);
  group.add(mergeByMaterial(ironStaging));

  /* L4 — pitch-soaked wick (merged lumps — shared mat, tick animates intensity only) */
  const wickMat = new THREE.MeshStandardMaterial({
    color: 0x1a1410,
    roughness: 0.88,
    emissive: 0x331100,
    emissiveIntensity: 0.35,
  });
  mats.push(wickMat);
  const wickStaging = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const wg = new THREE.DodecahedronGeometry(0.028 + (i % 2) * 0.01, 0);
    const lump = new THREE.Mesh(wg, wickMat);
    const ang = (i / 3) * Math.PI * 2;
    lump.position.set(Math.cos(ang) * 0.02, 0.455 + i * 0.018, Math.sin(ang) * 0.02);
    lump.rotation.set(0.4 + i * 0.2, ang, 0.15);
    wickStaging.add(lump);
  }
  wickStaging.updateMatrixWorld(true);
  group.add(mergeByMaterial(wickStaging));

  /* L5 — ember disc under flame */
  const emberGeo = new THREE.CircleGeometry(0.048, 20);
  const emberMat = new THREE.MeshStandardMaterial({
    color: 0x140804,
    emissive: 0xff5518,
    emissiveIntensity: 1.05,
    roughness: 0.9,
  });
  mats.push(emberMat);
  const ember = new THREE.Mesh(emberGeo, emberMat);
  ember.rotation.x = -Math.PI / 2;
  ember.position.y = 0.428;
  group.add(ember);

  /* L6 — flame stack */
  const flames: THREE.Mesh[] = [];
  const coreGeo = new THREE.SphereGeometry(0.042, 12, 10);
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0xffcc55,
    emissive: 0xff9911,
    emissiveIntensity: 2.05,
    transparent: true,
    opacity: 0.9,
    roughness: 0.32,
  });
  mats.push(coreMat);
  const core = new THREE.Mesh(coreGeo, coreMat);
  core.position.y = 0.52;
  group.add(core);
  flames.push(core);

  const coneSpecs = [
    { r: 0.055, h: 0.18, y: 0.48, x: 0, z: 0, rx: 0.06 },
    { r: 0.046, h: 0.15, y: 0.468, x: 0.032, z: 0.018, rx: 0.095, rz: 0.16 },
  ];
  for (const s of coneSpecs) {
    const cg = new THREE.ConeGeometry(s.r, s.h, 10);
    const cm = new THREE.MeshStandardMaterial({
      color: 0xff6620,
      emissive: 0xff2200,
      emissiveIntensity: 1.55,
      transparent: true,
      opacity: 0.84,
      roughness: 0.4,
    });
    mats.push(cm);
    const fl = new THREE.Mesh(cg, cm);
    fl.position.set(s.x, s.y + s.h * 0.5, s.z);
    fl.rotation.x = s.rx;
    fl.rotation.z = s.rz ?? 0;
    group.add(fl);
    flames.push(fl);
  }

  /* Phantom-light reuse path (recommended) — same pattern as `createCampfireLPCA`.
   * When the host scene supplies a permanent `fireLight` parented to the right hand
   * at boot, we just animate its intensity in `tick()`. This keeps `numPointLights`
   * constant from boot through every torch show/hide cycle, avoiding the scene-wide
   * shader recompile freeze (5+ s) the original "create light at use time" code path
   * triggered when the player pulled a torch out for the first time at night. */
  const fireLight = opts?.fireLight ?? new THREE.PointLight(0xff9038, 2.15, 3.15, 1.35);
  if (!reusingLight) {
    fireLight.position.set(0.015, 0.57, 0.04);
    group.add(fireLight);
  }

  function dispose(): void {
    group.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    mats.forEach((m) => m.dispose());
    /* Reused light belongs to the host scene; reset to dormant so it keeps counting
     * toward `numPointLights` without contributing visible light, ready for next use. */
    if (reusingLight) {
      fireLight.intensity = 0;
    }
  }

  function tick(timeSec: number): void {
    const f = 0.9 + Math.sin(timeSec * 12.4) * 0.09 + Math.sin(timeSec * 27.1) * 0.05;
    const s = 1 + Math.sin(timeSec * 8.1) * 0.08;
    fireLight.intensity = (1.75 + Math.sin(timeSec * 15.2) * 0.38) * (0.94 + 0.06 * f);
    emberMat.emissiveIntensity = 0.92 + Math.sin(timeSec * 10.3) * 0.22;
    wickMat.emissiveIntensity = 0.28 + Math.sin(timeSec * 11) * 0.12;
    flames.forEach((mesh, i) => {
      const m = mesh.material as THREE.MeshStandardMaterial;
      const wave = Math.sin(timeSec * (11 + i * 2.4) + i * 0.7);
      m.emissiveIntensity = (1.15 + i * 0.22 + wave * 0.18) * f;
      mesh.scale.set(1 + wave * 0.045 * (i + 1), s + wave * 0.055, 1 + wave * 0.045 * (i + 1));
    });
  }

  return { group, dispose, tick };
}

export function createWorkbenchLPCA(): WorkbenchLPCA {
  const group = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const wood = stdWood();
  const dark = new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 0.9 });
  const iron = new THREE.MeshStandardMaterial({
    color: 0x4a4a52,
    metalness: 0.55,
    roughness: 0.42,
  });
  mats.push(wood, dark, iron);

  /* Top slab */
  const topGeo = new THREE.BoxGeometry(0.52, 0.045, 0.28);
  geos.push(topGeo);
  const top = new THREE.Mesh(topGeo, wood);
  top.position.y = 0.42;
  top.castShadow = true;
  group.add(top);

  /* Apron / skirt */
  const apronGeo = new THREE.BoxGeometry(0.48, 0.08, 0.22);
  geos.push(apronGeo);
  const apron = new THREE.Mesh(apronGeo, dark);
  apron.position.set(0, 0.36, -0.02);
  group.add(apron);

  /* Legs — slight splay (clone geometry per leg for clean dispose) */
  const legPos = [
    [-0.2, 0.17, 0.1],
    [0.2, 0.17, 0.1],
    [-0.18, 0.17, -0.1],
    [0.18, 0.17, -0.1],
  ] as const;
  for (const [lx, ly, lz] of legPos) {
    const legGeo = new THREE.BoxGeometry(0.055, 0.34, 0.055);
    geos.push(legGeo);
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(lx, ly, lz);
    leg.rotation.z = lx < 0 ? 0.06 : -0.06;
    leg.castShadow = true;
    group.add(leg);
  }

  /* Peg rail */
  const railGeo = new THREE.BoxGeometry(0.44, 0.06, 0.02);
  geos.push(railGeo);
  const rail = new THREE.Mesh(railGeo, dark);
  rail.position.set(0, 0.62, -0.12);
  group.add(rail);

  for (let i = 0; i < 5; i++) {
    const pegGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.04, 8);
    geos.push(pegGeo);
    const peg = new THREE.Mesh(pegGeo, wood);
    peg.rotation.z = Math.PI / 2;
    peg.position.set(-0.16 + i * 0.08, 0.58, -0.12);
    group.add(peg);
  }

  /* Tool hints on top */
  const chiselGeo = new THREE.BoxGeometry(0.14, 0.018, 0.022);
  geos.push(chiselGeo);
  const chisel = new THREE.Mesh(chiselGeo, iron);
  chisel.position.set(-0.06, 0.448, 0.04);
  chisel.rotation.y = 0.35;
  group.add(chisel);

  const handleGeo = new THREE.CylinderGeometry(0.022, 0.026, 0.12, 8);
  geos.push(handleGeo);
  const handle = new THREE.Mesh(handleGeo, wood);
  handle.rotation.z = Math.PI / 2;
  handle.position.set(0.12, 0.448, -0.02);
  group.add(handle);

  function dispose(): void {
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
  }

  return { group, dispose };
}
