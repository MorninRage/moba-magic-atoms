import * as THREE from 'three';

/** Far-disc moon: lit by direction from moon toward sun (world space). */
export function createIdleCraftMoonMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(1, 0.3, 0.2).normalize() },
      uStorm: { value: 0 },
      uSkyZenith: { value: new THREE.Vector3(0.04, 0.06, 0.14) },
      uSkyHorizon: { value: new THREE.Vector3(0.12, 0.16, 0.24) },
      uSkyMid: { value: new THREE.Vector3(0.08, 0.1, 0.18) },
      /** 0–1 fade so the disc doesn’t pop on/off at twilight thresholds. */
      uOpacity: { value: 1 },
    },
    vertexShader: `
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 uSunDir;
      uniform float uStorm;
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform vec3 uSkyMid;
      uniform float uOpacity;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vec3 N = normalize(vWorldNormal);
        vec3 L = normalize(uSunDir);
        vec3 V = normalize(cameraPosition - vWorldPos);
        float diff = max(dot(N, L), 0.0);
        float night = max(0.0, -dot(N, L));
        float earthshine = night * (0.11 - uStorm * 0.05);
        float n1 = sin(dot(vWorldPos, vec3(3.1, 2.7, 1.9)) * 0.018);
        float n2 = sin(dot(N, vec3(7.2, 4.1, 2.8)) * 2.1);
        vec3 maria = mix(vec3(0.62, 0.66, 0.82), vec3(0.42, 0.46, 0.58), 0.5 + 0.38 * n1 + 0.12 * n2);
        vec3 rim = vec3(0.78, 0.82, 1.0);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 2.4);
        vec3 base = mix(maria, rim, fres * 0.38);
        float vy = V.y;
        vec3 skyTint = mix(uSkyHorizon, uSkyMid, smoothstep(-0.45, 0.25, vy));
        skyTint = mix(skyTint, uSkyZenith, smoothstep(0.1, 0.72, vy));
        skyTint *= 1.0 + earthshine * 0.55;
        float litW = smoothstep(-0.04, 0.16, diff);
        vec3 surface = base * (diff * 1.02 + earthshine * 0.22);
        surface *= 1.0 - uStorm * 0.35;
        vec3 col = mix(skyTint, surface, litW);
        float glint = pow(max(dot(N, normalize(V + L)), 0.0), 96.0) * smoothstep(0.08, 0.22, diff);
        col += vec3(0.95, 0.97, 1.0) * glint * 0.82;
        gl_FragColor = vec4(col, uOpacity);
      }
    `,
    transparent: true,
    fog: false,
    toneMapped: false,
    /* Write depth off (alpha disc), but **test** depth so near geometry (trees, terrain) occludes the moon. */
    depthWrite: false,
    depthTest: true,
  });
}

/** Additive plasma disc; plane faces +Z in local space, orient in TS with quaternion. */
export function createIdleCraftPlasmaSunMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uStrength: { value: 1 },
      uStorm: { value: 0 },
      /** World-space sun direction Y (altitude); clip below horizon so disc never shows through terrain. */
      uSunElevation: { value: 1 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uStrength;
      uniform float uStorm;
      uniform float uSunElevation;
      void main() {
        vec2 p = vUv - 0.5;
        /* r: 0 at center, 1 at disc edge — matches a full circular silhouette like the moon mesh. */
        float r = length(p) * 2.0;
        float a = atan(p.y, p.x);
        /* Limb mask: soft edge near r≈1 so the visible disc matches moon angular diameter. */
        float limb = 1.0 - smoothstep(0.88, 1.02, r);
        /* Center-bright + gentle limb darkening (sphere-like), not a tiny inner hotspot. */
        float centerHot = mix(0.72, 1.0, exp(-r * r * 2.8));
        float core = limb * centerHot;
        float corona = exp(-max(0.0, r - 0.35) * 3.2) * 0.62 * limb;
        float fil = sin(a * 9.0 + uTime * 0.55 + sin(r * 22.0 - uTime * 0.12)) * 0.5 + 0.5;
        fil = pow(fil, 2.4) * exp(-(r - 0.45) * (r - 0.45) * 5.5) * 0.38 * limb;
        float cells = abs(sin(a * 6.0 + r * 14.0 + uTime * 0.08));
        cells = smoothstep(0.35, 0.65, cells) * exp(-(r - 0.55) * (r - 0.55) * 8.0) * 0.2 * limb;
        float rimPulse = 0.5 + 0.5 * sin(uTime * 0.09 + a * 5.0);
        vec3 cCore = mix(vec3(1.0, 0.94, 0.78), vec3(0.52, 0.9, 1.0), smoothstep(0.0, 0.55, r));
        vec3 cCor = mix(vec3(1.0, 0.42, 0.28), vec3(0.38, 0.58, 1.0), rimPulse);
        vec3 rgb = cCore * core + cCor * corona * (0.52 + 0.48 * fil) + cCor * cells;
        float att = uStrength * (1.0 - uStorm * 0.48);
        rgb *= att;
        float alpha = clamp(core * 1.05 + corona * 0.95 + fil * 0.42 + cells, 0.0, 1.0);
        /*
         * Horizon fade widened (0.12 -> 0.28 wide) so the plasma disc crossfades with the sky
         * tint, key intensity, and cloud haze across the whole twilight - no sharp pop when
         * the sun transits y=0. Paired with the env's wider sunDirectFrac so the visible
         * disc and the directional light contribution go dark together.
         */
        float horiz = smoothstep(-0.12, 0.16, uSunElevation);
        alpha *= horiz;
        rgb *= horiz;
        gl_FragColor = vec4(rgb * alpha, alpha);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    /* Same as moon: must respect depth so the disc doesn’t draw over nearby foliage when the camera is low. */
    depthTest: true,
    toneMapped: false,
    fog: false,
  });
}

export function createPlasmaSunMesh(material: THREE.ShaderMaterial): THREE.Mesh {
  const geo = new THREE.CircleGeometry(1, 64);
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'idlecraft_plasma_sun';
  mesh.frustumCulled = false;
  mesh.renderOrder = -490;
  mesh.scale.set(1, 1, 1);
  return mesh;
}
