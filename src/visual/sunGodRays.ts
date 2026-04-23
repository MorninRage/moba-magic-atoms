/**
 * Cheap soft god-rays (Phase 8h lighting plan §6).
 *
 * **2026-04 fix.** Original implementation used a `MeshBasicMaterial` with
 * a flat alpha — the player saw the cone as a HARD-EDGED shape angling
 * across the scene ("two different shades, inside vs outside the cone").
 * The recipe needs to be soft on every boundary so the cone reads as
 * "atmospheric light" rather than "translucent geometry."
 *
 * The new shader fades opacity on three axes:
 *   1. **Radial fade** — fully transparent at the cone's outer edge,
 *      strongest along the central axis. Kills the hard silhouette.
 *   2. **Length fade** — strongest near the apex (sun side), trailing off
 *      toward the base (ground side). Makes the shaft feel like light
 *      "spilling from" the sun, not a colored cone hanging in space.
 *   3. **Time-of-day fade** — `sunDirectFrac` gates the whole thing so
 *      it disappears at night. Storm reduces it further.
 *
 * Cost is essentially the same as before — one mesh, additive transparent
 * shader, depth-write off, no shadow casting. The fragment shader does a
 * couple of `smoothstep`s and a `mix` — well below 1ms even at 1080p.
 *
 * **Constraint compliance unchanged:** no new lights, no shader hash
 * thrashing (one program, compiled once on attach), no point-light count
 * change. Custom `ShaderMaterial` so the cache key is stable per project
 * lifetime.
 */
import * as THREE from 'three';

export interface SunGodRaysHandle {
  /** Per-frame: orient cone toward sun, sync opacity + color uniforms. */
  update(opts: {
    sunDir: THREE.Vector3;
    sunDirectFrac: number;
    sunWarmth: number;
    storm: number;
  }): void;
  dispose(): void;
}

export function attachSunGodRays(scene: THREE.Scene): SunGodRaysHandle {
  /* Open cone — wide base, narrow at sun apex. The cone is built with its
   * apex at +Y and base at -Y (default ConeGeometry orientation), so we
   * position the apex at (0, height, 0) and let the orientation logic
   * rotate it to point at the sun.
   *
   * Dimensions chosen for the dock map's typical scale (~50 m radius):
   *   - height 80: spans the playable area top-to-bottom with margin.
   *   - radius 22 at base: wide enough to feel atmospheric.
   *   - 32 radial segments: shader needs enough triangles for the radial
   *     fade to look smooth.
   *
   * Geometry-side UVs: ConeGeometry's default UVs go 0..1 around radial,
   * 0..1 along height. We use the second component for the length fade
   * and compute radial distance from local position in the shader. */
  const geo = new THREE.ConeGeometry(22, 80, 32, 1, true /* openEnded */);
  /* Translate so the apex is at world Y=0 and the base extends upward. */
  geo.translate(0, 40, 0);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(0xfff2c8) },
      uOpacityScale: { value: 0 },
      /* Cone radius at the BASE (used to normalize radial distance in
       * shader fragment). Geometry constructor's first arg. */
      uBaseRadius: { value: 22 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocalPos;
      varying float vHeight01;   /* 0 at apex, 1 at base */
      void main() {
        vLocalPos = position;
        /* Cone in local space goes from y=0 (apex after translate) to y=80
         * (base after translate). Normalize to 0..1 for the length fade. */
        vHeight01 = clamp(position.y / 80.0, 0.0, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacityScale;
      uniform float uBaseRadius;
      varying vec3 vLocalPos;
      varying float vHeight01;
      void main() {
        if (uOpacityScale < 0.001) discard;
        /* Radial distance from cone's central axis (Y axis in local space). */
        float r = length(vec2(vLocalPos.x, vLocalPos.z));
        /* Cone radius at this height (linearly tapers from 0 at apex to
         * uBaseRadius at base). */
        float coneR = uBaseRadius * vHeight01;
        if (coneR < 0.001) discard;
        float r01 = clamp(r / coneR, 0.0, 1.0);
        /* Radial fade: center solid, edges fully transparent. Squared
         * smoothstep gives a soft volumetric falloff (matches a Gaussian
         * cross-section closely enough for the eye). */
        float radial = 1.0 - smoothstep(0.0, 1.0, r01);
        radial *= radial;
        /* Length fade: brightest near the apex (sun side), trailing off
         * toward the ground. */
        float length01 = 1.0 - vHeight01;
        float lengthFade = smoothstep(0.0, 0.85, length01);
        /* Final alpha — base 0.18 multiplied by all the gates. The base is
         * pre-multiplied with uOpacityScale (which is sunDirectFrac × ~0.5
         * × storm) for the day/night/weather drive. */
        float alpha = 0.18 * radial * lengthFade * uOpacityScale;
        gl_FragColor = vec4(uColor * alpha, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'SunGodRays';
  mesh.frustumCulled = false;         /* always potentially visible */
  mesh.renderOrder = -50;             /* behind UI but after opaque scene */
  scene.add(mesh);

  /* Reusable scratch quaternion for orientation. */
  const _scratchQuat = new THREE.Quaternion();
  const _scratchUp = new THREE.Vector3(0, 1, 0);
  const _scratchTmpCol = new THREE.Color();
  const _peachColor = new THREE.Color(0xffd49a);
  const _neutralColor = new THREE.Color(0xfff2c8);

  function update(opts: {
    sunDir: THREE.Vector3;
    sunDirectFrac: number;
    sunWarmth: number;
    storm: number;
  }): void {
    /* Orient the cone so its +Y axis (apex direction) matches the sun
     * direction. */
    if (opts.sunDir.lengthSq() > 1e-6) {
      _scratchQuat.setFromUnitVectors(_scratchUp, opts.sunDir);
      mesh.quaternion.copy(_scratchQuat);
    }
    /* Opacity scale: drives the shader's alpha multiplier. The shader
     * applies a base 0.18 × radial × length fade × this gate, so the
     * total visible peak is 0.18 × ~0.4 × ~0.7 × ~0.5 ≈ 0.025 — gentle
     * atmospheric haze, not a colored cone shape. Storm dims it further. */
    const opacityScale = opts.sunDirectFrac * 0.5 * (1 - opts.storm * 0.6);
    (mat.uniforms.uOpacityScale as { value: number }).value = opacityScale;
    /* Color: warm at sunset/dawn (sunWarmth high), neutral at noon. */
    _scratchTmpCol.copy(_neutralColor).lerp(_peachColor, opts.sunWarmth);
    (mat.uniforms.uColor.value as THREE.Color).copy(_scratchTmpCol);
  }

  function dispose(): void {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { update, dispose };
}
