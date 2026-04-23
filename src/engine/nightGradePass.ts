/**
 * Night-grade post-process pass (Phase 8h lighting plan §4).
 *
 * Screen-space colour grade applied at night so the scene reads as
 * "moonlight" instead of "dim daytime in blue tint." Industry recipe
 * (BotW / Genshin / Skyrim — see
 * `docs/GROUND_LEVEL_LIGHTING_OVERHAUL_PLAN.md` for the citation):
 *
 *   1. Desaturate the frame (mix toward grey by ~45% at full night).
 *   2. Cool tint (multiply RGB by `(0.85, 0.92, 1.08)`).
 *   3. Crush mid-shadows with a gamma curve (`pow(rgb, 1.25)`).
 *
 * The blend strength scales with `u_nightMix` (0 = day = pass-through,
 * 1 = full night). `u_moonIllum` (0..1) softens the grade slightly under
 * a full moon — full-moon nights stay readable, new-moon nights are the
 * "mysterious dark" extreme.
 *
 * **Why not just dim the moon directional?** Industry research is unanimous:
 * making the moon brighter just produces "blue daytime." The brain reads a
 * scene as night because of the desaturation + curve + cool cast IN the
 * frame, not because the dominant light is dim and blue. Moonlight serves
 * as the directional + key cool tint; the SCREEN-SPACE grade tells the brain
 * "this is night."
 *
 * **Constraint compliance:** ShaderPass is a single fragment program; once
 * compiled (warmed via the existing post-stack rebuild path) it doesn't
 * change shader hashes. Toggling enabled vs disabled keeps the program in
 * cache (per LEARNINGS post-stack invariant).
 */
import * as THREE from 'three';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

export const NightGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 0 = day (pass-through), 1 = full night (max grade). */
    u_nightMix: { value: 0 },
    /** 0 = new moon (max grade), 1 = full moon (eased grade). */
    u_moonIllum: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float u_nightMix;
    uniform float u_moonIllum;
    varying vec2 vUv;

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      /* Effective grade strength: scales with night, softened by full moon.
       * Full moon lifts only ~30% of the grade so moonlit terrain stays
       * legible; new moon delivers the full effect. */
      float n = u_nightMix * (1.0 - u_moonIllum * 0.30);
      if (n > 0.001) {
        /* (1) Desaturate up to ~45% at full grade. */
        float gray = dot(c, vec3(0.299, 0.587, 0.114));
        c = mix(c, vec3(gray), n * 0.45);
        /* (2) Cool tint — slightly suppress red/green, lift blue. */
        vec3 coolTint = vec3(0.85, 0.92, 1.08);
        c *= mix(vec3(1.0), coolTint, n);
        /* (3) Mid-shadow crush via gamma curve. Lifts contrast in shadows
         * without clipping highlights — keeps stars + lanterns readable. */
        c = pow(c, vec3(mix(1.0, 1.25, n)));
      }
      gl_FragColor = vec4(c, src.a);
    }
  `,
};

export function createNightGradePass(): ShaderPass {
  const pass = new ShaderPass(NightGradeShader);
  /* Pass starts disabled; enabled flag is toggled per frame from the dock
   * env's `nightMix` (only ON when nightMix > ~0.05). */
  pass.enabled = false;
  return pass;
}

/**
 * Sync the pass's uniforms from the dock environment's day/night state.
 * Call from CharacterScenePreview's per-frame loop AFTER the dock env update.
 */
export function syncNightGradeUniforms(
  pass: ShaderPass,
  nightMix: number,
  moonIllum: number,
): void {
  const u = pass.uniforms as Record<string, { value: number }>;
  u['u_nightMix']!.value = nightMix;
  u['u_moonIllum']!.value = moonIllum;
  /* Only run the pass when night has any meaningful weight — at noon
   * `nightMix ≈ 0` and the program would be a wasted full-screen copy.
   * `setPassEnabled` keeps the program in the cache (no first-use compile
   * freeze) per LEARNINGS post-stack invariant. */
  pass.enabled = nightMix > 0.05;
}
