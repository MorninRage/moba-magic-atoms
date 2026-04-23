import * as THREE from 'three';

/** Baked before {@link mergeByMaterial}: height above terrain at plant root (invariant after world bake). */
export const VEGETATION_WIND_HEIGHT_ATTR = 'vegetationWindH';

/**
 * After placing a plant group at `(x, terrainY, z)`, call this so wind uses **height above ground**, not world `y`.
 * Without this, merged meshes use absolute elevation and low trunk vertices sway like canopy — seams “float” off stumps.
 */
export function bakeVegetationWindHeightAboveGround(root: THREE.Object3D, terrainY: number): void {
  root.updateWorldMatrix(true, true);
  const v = new THREE.Vector3();
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    /* InstancedMesh + BatchedMesh are also skipped here because their geometries are
     * shared across instances — baking once is fine in principle, but the height
     * value would be the SAME for every instance (since position is local-space,
     * unaffected by per-instance matrix). For InstancedMesh / BatchedMesh templates
     * the caller bakes the attribute on the unit-scale template BEFORE wrapping in
     * the InstancedMesh / BatchedMesh, so this skip is harmless: it just avoids
     * re-baking on the wrapper. */
    if ((obj as THREE.InstancedMesh).isInstancedMesh) return;
    if ((obj as { isBatchedMesh?: boolean }).isBatchedMesh) return;
    const mesh = obj as THREE.Mesh;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    const arr = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      mesh.localToWorld(v);
      arr[i] = Math.max(0, v.y - terrainY);
    }
    geo.setAttribute(VEGETATION_WIND_HEIGHT_ATTR, new THREE.BufferAttribute(arr, 1));
  });
}

/**
 * Bake the wind-height attribute on a TEMPLATE Group at unit scale (use this for
 * InstancedMesh / BatchedMesh templates). Differs from
 * {@link bakeVegetationWindHeightAboveGround} only in that the "height above
 * terrain" is taken as the vertex's local-space Y (the template's local origin is
 * the trunk base / plant root, so local-Y == height-above-ground). Per-instance
 * scale is folded into the matrix (instance / batching matrix), so the baked value
 * stays correct across every instance regardless of the per-instance scale.
 */
export function bakeVegetationWindHeightForTemplate(root: THREE.Object3D): void {
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    if ((obj as THREE.InstancedMesh).isInstancedMesh) return;
    if ((obj as { isBatchedMesh?: boolean }).isBatchedMesh) return;
    const mesh = obj as THREE.Mesh;
    const geo = mesh.geometry;
    const pos = geo.attributes.position;
    /* Use mesh.matrixWorld to handle the case where the mesh is offset within the
     * group (e.g. canopy at y = 1.5 within an apple-tree template). */
    const mat = mesh.matrixWorld;
    const arr = new Float32Array(pos.count);
    const v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      v.applyMatrix4(mat);
      arr[i] = Math.max(0, v.y);
    }
    geo.setAttribute(VEGETATION_WIND_HEIGHT_ATTR, new THREE.BufferAttribute(arr, 1));
  });
}

/**
 * Shared uniforms for merged forest meshes (vertices are **world-space** after {@link mergeByMaterial}).
 * Gentle breeze + optional gust from weather; flex is per-material.
 */
const uWind = {
  uVegetationWindTime: { value: 0 },
  uVegetationWindGust: { value: 0 },
};

const windPatched = new WeakSet<THREE.Material>();

export type VegetationWindInstallOptions = {
  flexMul?: number;
  /** Herbs / ground cover: stronger motion low on the plant (vs tall trees). */
  understory?: boolean;
};

/** Standard + Physical (foliage uses {@link THREE.MeshPhysicalMaterial} — same vertex entry as Standard). */
function isWindableStandardMat(m: THREE.Material): m is THREE.MeshStandardMaterial {
  return (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true;
}

/**
 * Call each frame from {@link IdleCraftDockEnvironment.update} (or any dock loop).
 */
export function updateVegetationWind(timeSeconds: number, stormGust01: number): void {
  uWind.uVegetationWindTime.value = timeSeconds;
  uWind.uVegetationWindGust.value = THREE.MathUtils.clamp(stormGust01, 0, 1);
}

/**
 * Injects vertex displacement into Standard/Physical materials (chains prior `onBeforeCompile`).
 * Requires {@link VEGETATION_WIND_HEIGHT_ATTR} on geometry (bake before merge).
 */
export function installVegetationWindOnMaterial(
  mat: THREE.MeshStandardMaterial,
  opts?: VegetationWindInstallOptions,
): void {
  if (windPatched.has(mat)) return;
  windPatched.add(mat);
  const flexUniform = { value: opts?.flexMul ?? 1 };
  const groundModeUniform = { value: opts?.understory === true ? 1 : 0 };
  mat.userData.vegetationWindFlex = flexUniform;
  mat.userData.vegetationWindGroundMode = groundModeUniform;
  /* Default Material.customProgramCacheKey uses `this.onBeforeCompile` — must call prior key bound to mat. */
  const prevCompileBound = mat.onBeforeCompile.bind(mat);
  const prevKeyBound = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = function vegetationWindCacheKey(): string {
    /* Bumped to vegWind4 when the path-aware (USE_BATCHING / USE_INSTANCING / merged)
     * world-space phase derivation was added — invalidates older cached programs. */
    return prevKeyBound() + ':vegWind4';
  };

  mat.onBeforeCompile = function vegetationWindOnBeforeCompile(shader, renderer) {
    prevCompileBound(shader, renderer);
    shader.uniforms.uVegetationWindTime = uWind.uVegetationWindTime;
    shader.uniforms.uVegetationWindGust = uWind.uVegetationWindGust;
    shader.uniforms.uVegetationWindFlex = flexUniform;
    shader.uniforms.uVegetationWindGroundMode = groundModeUniform;
    /* `shader.uniforms` alone does not emit GLSL `uniform` lines in the vertex shader — without this,
     * injected code hits "undeclared identifier" (Three r182 WebGL path). */
    if (!shader.vertexShader.includes('uVegetationWindTime')) {
      const withPars = shader.vertexShader.replace(
        '#include <common>',
        `#include <common>
uniform float uVegetationWindTime;
uniform float uVegetationWindGust;
uniform float uVegetationWindFlex;
uniform float uVegetationWindGroundMode;
attribute float ${VEGETATION_WIND_HEIGHT_ATTR};`,
      );
      shader.vertexShader =
        withPars !== shader.vertexShader
          ? withPars
          : `uniform float uVegetationWindTime;
uniform float uVegetationWindGust;
uniform float uVegetationWindFlex;
uniform float uVegetationWindGroundMode;
attribute float ${VEGETATION_WIND_HEIGHT_ATTR};
${shader.vertexShader}`;
    }
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
#include <begin_vertex>
{
  float _t = uVegetationWindTime;
  float _gust = 1.0 + uVegetationWindGust * 0.62;
  /* Path-aware world-space phase derivation.
   *
   * - **USE_BATCHING (BatchedMesh):** vertices are local-space; per-instance transform
   *   lives in batchingMatrix (loaded by the standard <batching_vertex> chunk that runs
   *   AFTER this <begin_vertex> injection). We replicate the matrix retrieval here using
   *   the helper functions declared in <batching_pars_vertex> (which IS in the parsing
   *   block, available globally) so phase reads the per-instance world position even
   *   though Three.js hasn't yet declared 'batchingMatrix' as a local at this point.
   * - **USE_INSTANCING (InstancedMesh):** vertices are local-space; instanceMatrix is
   *   declared at file scope by Three.js — we can use it directly.
   * - **Merged mesh (no instancing):** vertices are already in WORLD space because
   *   mergeByMaterial bakes the transform into the buffer. transformed == world pos.
   *
   * In all three cases _pw ends up in world coordinates -> phase varies per
   * instance / per merged-tree position, looks organic. */
#ifdef USE_BATCHING
  mat4 _windBM = getBatchingMatrix(getIndirectIndex(gl_DrawID));
  vec3 _pw = (modelMatrix * _windBM * vec4(transformed, 1.0)).xyz;
#else
#ifdef USE_INSTANCING
  vec3 _pw = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vec3 _pw = transformed;
#endif
#endif
  float _ph = _pw.x * 0.357 + _pw.z * 0.293 + _pw.y * 0.071;
  float _sw =
    sin(_t * 1.06 + _ph) * 0.58 +
    sin(_t * 1.79 + _ph * 1.17 + 1.09) * 0.34 +
    sin(_t * 2.48 + _ph * 0.41) * 0.12;
  /* Height above **local ground** (baked) — not world Y (terrain breaks trunk vs stump). */
  float _hRel = max(0.0, ${VEGETATION_WIND_HEIGHT_ATTR});
  float _folTree = pow(smoothstep(0.2, 3.65, _hRel), 1.36);
  float _folUnder = pow(smoothstep(0.028, 0.82, _hRel), 0.74);
  float _fol = mix(_folTree, _folUnder, uVegetationWindGroundMode);
  float _stemTree = pow(smoothstep(0.0, 0.68, _hRel), 3.05) * 0.055;
  float _stemUnder = pow(smoothstep(0.0, 0.32, _hRel), 2.05) * 0.12;
  float _stem = mix(_stemTree, _stemUnder, uVegetationWindGroundMode);
  float _amp = uVegetationWindFlex * _gust * (0.056 * _fol + _stem);
  if (uVegetationWindGroundMode > 0.5) _amp *= 1.32;
  float _cz = cos(_t * 0.89 + _ph * 0.86 + 0.31);
  transformed.x += _sw * _amp;
  transformed.z += _cz * _amp * 0.9;
}
`,
    );
  };
  mat.needsUpdate = true;
}

/**
 * Clone every mesh material under `root` before {@link installVegetationWindOnMergedGroup}.
 * `mergeByMaterial` keeps material references; {@link goeStyleHarvestLPCA} uses shared singletons
 * (`STD_BARK`, cached stdLit, …) also used by gather props in {@link CharacterScenePreview}. Patching
 * those for wind poisons every user and can yield `VALIDATE_STATUS false` / broken preview.
 */
export function cloneMaterialsForVegetationWind(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const m = mesh.material;
    if (Array.isArray(m)) {
      mesh.material = m.map((mat) => (mat ? mat.clone() : mat)) as THREE.Material[];
    } else if (m) {
      mesh.material = m.clone();
    }
    const applied = mesh.material;
    if (Array.isArray(applied)) {
      for (const x of applied) if (x) x.needsUpdate = true;
    } else if (applied) {
      applied.needsUpdate = true;
    }
  });
}

/**
 * Apply breeze to every Standard/Physical material on meshes under `root`. Works on
 * merged meshes, `THREE.InstancedMesh`, AND `THREE.BatchedMesh` — the shader patch
 * itself is path-aware (`USE_BATCHING` / `USE_INSTANCING` / merged branches in
 * `installVegetationWindOnMaterial`) so the same patch handles all three cases.
 *
 * Materials flagged `userData.skipVegetationWind = true` (e.g. fairy PBR bodies that
 * have their own custom `onBeforeCompile` chain) are still skipped — that opt-out is
 * how non-foliage vegetation wind shaders coexist with their own custom shaders.
 */
export function installVegetationWindOnMergedGroup(
  root: THREE.Object3D,
  opts?: VegetationWindInstallOptions,
): void {
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const raw of mats) {
      if (!raw || !isWindableStandardMat(raw)) continue;
      if (raw.userData.skipVegetationWind === true) continue;
      installVegetationWindOnMaterial(raw, opts);
    }
  });
}
