/**
 * Half-Lambert wrap diffuse for `MeshStandardMaterial` / `MeshPhysicalMaterial`
 * (Phase 8h lighting plan §3 — stylized soft-form fill).
 *
 * Patches the lighting model so the diffuse `dot(N, L)` term becomes a
 * smoothed wrap: `(dot(N, L) * 0.5 + 0.5) ^ 2`. The shadow side never goes
 * pitch-black — it falls off softly toward 0.25 (after squaring), giving
 * characters and props "form" even when fully facing away from the key
 * light. This is the cheapest fake-GI you can ship and is the foundation
 * under most stylized-PBR hybrids (Valve Source 2004 → BotW → Genshin →
 * every stylized indie).
 *
 * Specular stays physical — the `geometry.dotNL` value used by the
 * specular path is not touched. Metals still read.
 *
 * **Pattern:** mirrors `installVegetationWindOnMaterial` — WeakSet dedup,
 * chained `onBeforeCompile`, bumped `customProgramCacheKey` so Three.js
 * doesn't share a program with the un-patched version. Same proven
 * invariant-respecting plumbing the project already uses.
 *
 * **What it patches:** Three's PBR direct-lighting path computes
 * `irradiance = dotNL * directLight.color` inside
 * `RE_Direct_Physical` / `<lights_fragment_begin>` chunks. We intercept
 * `dotNL` in the lighting accumulation by replacing the canonical
 * `vec3 irradiance = dotNL * directLight.color;` line with a half-Lambert
 * variant. Only the irradiance gate changes; specular keeps `geometry.dotNL`.
 *
 * Apply selectively — hero / mob / staff / cabin band materials. Don't
 * apply to terrain / water / fog (those work better with standard Lambert).
 */
import * as THREE from 'three';

const halfLambertPatched = new WeakSet<THREE.Material>();

/**
 * Patch a `MeshStandardMaterial` (or `MeshPhysicalMaterial`) to use the
 * half-Lambert wrap on its direct-light diffuse term. Idempotent — second
 * call on the same material is a no-op.
 */
export function installHalfLambertOnMaterial(mat: THREE.MeshStandardMaterial): void {
  if (halfLambertPatched.has(mat)) return;
  halfLambertPatched.add(mat);
  /* Default Material.customProgramCacheKey uses `this.onBeforeCompile` — bind
   * the prior key before we replace the function so chains compose. */
  const prevCompileBound = mat.onBeforeCompile.bind(mat);
  const prevKeyBound = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = function halfLambertCacheKey(): string {
    return prevKeyBound() + ':halfLambertV1';
  };
  mat.onBeforeCompile = function halfLambertOnBeforeCompile(shader, renderer) {
    prevCompileBound(shader, renderer);
    /* The PBR fragment chain computes `vec3 irradiance = dotNL * directLight.color;`
     * inside the per-light loop (`<lights_fragment_begin>` expansion). We
     * replace just that line with a wrap variant. The `dotNL` local stays
     * in scope for the specular path that follows. Three.js may emit this
     * line in either of two forms across versions; cover both. */
    const wrapExpr =
      'vec3 irradiance = (pow(dotNL * 0.5 + 0.5, 2.0)) * directLight.color';
    if (shader.fragmentShader.includes('vec3 irradiance = dotNL * directLight.color;')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 irradiance = dotNL * directLight.color;',
        wrapExpr + ';',
      );
    } else if (shader.fragmentShader.includes('irradiance = dotNL * directLight.color;')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        'irradiance = dotNL * directLight.color;',
        'irradiance = (pow(dotNL * 0.5 + 0.5, 2.0)) * directLight.color;',
      );
    }
    /* If neither match was found (Three.js shader changed in a future
     * version), the patch is a no-op and the material renders with stock
     * Lambert. Better than throwing — visual regression to baseline is the
     * graceful failure mode. */
  };
  /* Force shader recompile if material was already in use. */
  mat.needsUpdate = true;
}

/**
 * Convenience: walk a Group / Mesh tree and patch every Standard/Physical
 * material in it. Safe to call multiple times — WeakSet handles dedup.
 *
 * Use sparingly — only on hero meshes (avatar, mobs, staff, cabin pieces).
 * Don't blanket-apply to the whole scene.
 */
export function installHalfLambertOnTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.material) return;
    const mat = m.material as THREE.Material;
    if (Array.isArray(mat)) {
      for (const sub of mat) {
        if (
          (sub as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
          (sub as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial
        ) {
          installHalfLambertOnMaterial(sub as THREE.MeshStandardMaterial);
        }
      }
      return;
    }
    if (
      (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial ||
      (mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial
    ) {
      installHalfLambertOnMaterial(mat as THREE.MeshStandardMaterial);
    }
  });
}
