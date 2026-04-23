import * as THREE from 'three';
import type { GraphicsBudget } from '../engine/graphicsTier';

/**
 * Idle Craft — **one** procedural sky mesh: full sphere (BackSide), camera-centered.
 * The fragment treats directions below the horizon as `uHorizon` so there is no “open bowl” hole
 * or second layer — avoids rim seams vs `scene.background` and map-edge masking.
 *
 * Aurora uses 3D noise only (no `atan` azimuth) to remove the vertical night seam.
 */

export const SKY_RENDER_SKY_DOME = -1100;
export const SKY_RENDER_STARS = -800;

/** Upper hemisphere only (legacy helpers / tests). Prefer {@link createFullSphereSkyGeometry} for the dock sky. */
export function createUpperHemisphereDomeGeometry(widthSeg: number, heightSeg: number): THREE.SphereGeometry {
  return new THREE.SphereGeometry(1, widthSeg, heightSeg, 0, Math.PI * 2, 0, Math.PI / 2);
}

/** Full sphere: interior is the sky vault; lower half is shaded as horizon in the fragment shader. */
export function createFullSphereSkyGeometry(widthSeg: number, heightSeg: number): THREE.SphereGeometry {
  return new THREE.SphereGeometry(1, widthSeg, heightSeg);
}

const skyVert = /* glsl */ `
varying vec3 vWorldPosition;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPosition = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

/** Gradient + sun glow + seam-free aurora + clouds; lower elevation lerp to horizon (full-sphere mesh). */
const unifiedSkyFrag = /* glsl */ `
precision mediump float;
uniform vec3 uSunDir;
/** Normalized moon direction — used to carve a soft cone around the moon where clouds are suppressed so the disc reads on top of the sky paint. */
uniform vec3 uMoonDir;
uniform vec3 uZenith;
uniform vec3 uSkyMid;
uniform vec3 uHorizon;
uniform float uSunsetMix;
uniform vec3 uCameraPosition;
uniform float uNightMix;
uniform float uDuskMix;
uniform float uStorm;
uniform float uSunElevation;
uniform float uTime;
uniform float uDayMix;
varying vec3 vWorldPosition;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.52;
  mat2 rot = mat2(0.86, 0.5, -0.5, 0.86);
  for (int i = 0; i < 4; i++) {
    v += a * noise2(p);
    p = rot * p * 2.02;
    a *= 0.5;
  }
  return v;
}
float triFbm(vec3 d, float sc, vec2 flow) {
  vec3 a = abs(d);
  float s = a.x + a.y + a.z + 0.001;
  vec3 w = a / s;
  vec2 xy = d.xy * sc + flow;
  vec2 yz = d.yz * sc + flow * vec2(1.07, 0.96);
  vec2 xz = d.xz * sc + flow * vec2(0.93, 1.04);
  return fbm(xy) * w.z + fbm(yz) * w.x + fbm(xz) * w.y;
}

/*
 * Fair-weather haze: fbm on tilted 2D projections of view dir (not XY/YZ/XZ triplanar).
 * Axis-aligned triplanar plus latitude smoothsteps produced obvious onion rings on the dome.
 */
float cloudHaze(vec3 d, vec2 flow) {
  vec2 u1 = vec2(dot(d, vec3(0.649, -0.757, 0.082)), dot(d, vec3(0.124, 0.572, 0.811)));
  vec2 u2 = vec2(dot(d, vec3(-0.531, 0.114, 0.839)), dot(d, vec3(0.428, 0.887, -0.171)));
  float a = fbm(u1 * 2.85 + flow);
  float b = fbm(u2 * 2.5 - flow * vec2(0.94, 1.06));
  float n = a * 0.52 + b * 0.48;
  /* Wide soft threshold = soft blobs, not sharp latitude contours */
  return smoothstep(0.22, 0.88, n);
}

/*
 * Seam-free aurora band (no atan, no sin(dir.y)) with a 3D-noise azimuthal mask so the band
 * is **not a symmetric cone ring** around the zenith — reads as organic sheets and curtains
 * (user intent: "everywhere but not symmetrical in a cone fashion").
 */
float auroraBand(vec3 dir, float altLo, float altHi, float sc, float seed) {
  float band = smoothstep(altLo, altHi, dir.y) * (1.0 - smoothstep(altHi, min(altHi + 0.24, 0.95), dir.y));
  /*
   * Tight azimuthal mask → discrete curtains, not a wide haze over the whole dome.
   * Previously smoothstep(0.18, 0.72, az) covered ~50% of the sky and read as "clouds
   * at night". Raised lower + upper bounds and subtracted a second low-frequency FBM so the
   * final mask is near-zero across most directions, with sharp reveals where curtains live.
   */
  float az = 0.5 + 0.5 * triFbm(dir * 1.15 + vec3(seed * 0.3, seed * 0.1, -seed * 0.2),
                                1.05,
                                vec2(uTime * 0.009 + seed * 0.1, -uTime * 0.007));
  float azBreak = triFbm(dir * 0.45 + vec3(seed * 0.25, 0.0, seed * 0.11),
                         0.65,
                         vec2(-uTime * 0.004, uTime * 0.003 + seed * 0.05));
  float azMask = smoothstep(0.58, 0.9, az - 0.18 * azBreak);
  vec3 p = dir * (1.35 + seed * 0.04) + vec3(seed * 0.2, seed * 0.1, -seed * 0.15);
  float n1 = triFbm(p, sc, vec2(uTime * 0.017, uTime * 0.012 + seed));
  float n2 = triFbm(p * 1.9 + vec3(0.4, -0.2, 0.3), sc * 1.35, vec2(-uTime * 0.011, uTime * 0.019));
  float wave = (0.5 + 0.5 * n1) * (0.5 + 0.5 * n2);
  float ph = (n1 + n2) * 7.2 + uTime * (0.42 + seed * 0.05) + triFbm(p, 2.0, vec2(uTime * 0.014)) * 2.0;
  wave *= sin(ph) * 0.5 + 0.5;
  return band * wave * azMask;
}

void main() {
  vec3 dir = normalize(vWorldPosition - uCameraPosition);
  float he = dir.y;
  /* Vault mask: under-horizon directions on the lower sphere lerp to fog horizon (no open rim). */
  float vault = smoothstep(-0.22, 0.08, he);

  float tRaw = he * 0.5 + 0.5;
  float t = pow(max(0.001, tRaw), 0.88);
  vec3 col = mix(uHorizon, uSkyMid, smoothstep(0.04, 0.46, t));
  col = mix(col, uZenith, smoothstep(0.34, 0.96, t));
  float twi = smoothstep(-0.14, 0.12, uSunElevation);
  float civilGlow = (1.0 - twi) * smoothstep(-0.32, -0.06, uSunElevation);
  vec3 twilightTint = mix(vec3(0.42, 0.18, 0.38), vec3(0.95, 0.35, 0.22), uSunsetMix);
  col += twilightTint * civilGlow * (0.55 + 0.45 * uDuskMix) * vault;
  float sunDot = max(0.0, dot(dir, normalize(uSunDir)));
  /* Tight halo around the sun only - was pow(sunDot, 3.2) * 1.15 which gave a very wide
   * radial gradient that read as a "polar grid centered on the sun, growing from the top
   * and converging to a point of light" as the sun moved through the sky. New: pow 24
   * confines the warm tint to a few degrees around the sun, strength halved. */
  col += vec3(0.48, 0.16, 0.1) * uSunsetMix * pow(sunDot, 24.0) * 0.5 * vault;
  col = mix(col, col * vec3(1.06, 1.02, 1.18), uDuskMix * 0.28 * vault);
  /* Very subtle night tint — was vec3(0.04, 0.06, 0.14) which lifted the whole upper dome. */
  col += vec3(0.012, 0.02, 0.05) * uNightMix * (1.0 - uStorm) * smoothstep(0.35, 0.98, tRaw) * vault;

  /*
   * Aurora / Milky Way staged reveal. Instead of one smoothstep from civil twilight to
   * deep night, the reveal happens in two stages so the night layers brighten in
   * matching phases with the twilight-phase dayMix cap:
   *   Stage A (~civil -> nautical):   first 55% brightness by nightMix ~= 0.35
   *   Stage B (~astronomical -> deep): final 45% by nightMix ~= 0.8
   * Blended into a single nightRamp. Gate by sun elevation so twilight still leads.
   */
  /* Hold off until sun is below horizon so aurora/MW don't fade in while sun is still
   * visually setting (was 0.18 - that made aurora ramp on while sun was 5-10 sec from
   * the horizon and read like a glowing canvas taking over the screen). */
  float nightGate = smoothstep(0.0, -0.22, uSunElevation);
  float stageA = smoothstep(0.05, 0.35, uNightMix);
  float stageB = smoothstep(0.4, 0.8, uNightMix);
  float nightRamp = 0.55 * stageA + 0.45 * stageB;
  float nm = uNightMix * (1.0 - uStorm * 0.88) * nightGate * nightRamp * vault;
  /*
   * Moon-direction cone mask: aurora and clouds never paint across the moon disc so
   * the moon always reads as the nearest layer. Wider cone than the cloud mask
   * (0.94 vs 0.98) because aurora patches are larger and need a bigger clearance.
   */
  float moonConeWide = smoothstep(0.94, 0.998, dot(dir, normalize(uMoonDir)));
  float auroraMoonMask = mix(1.0, 0.05, moonConeWide);
  float omni = 0.72 + 0.28 * (0.5 + 0.5 * triFbm(dir, 1.55, vec2(uTime * 0.022, uTime * 0.014)));
  float a1 = auroraBand(dir, 0.04, 0.22, 2.05, 0.0);
  float a2 = auroraBand(dir, 0.14, 0.42, 2.35, 2.2);
  float a3 = auroraBand(dir, 0.32, 0.62, 2.65, 4.5);
  float a4 = auroraBand(dir, 0.48, 0.82, 2.2, 6.8);
  float au = (a1 * 1.15 + a2 * 1.35 + a3 * 1.05 + a4 * 0.85) * nm * omni * auroraMoonMask;
  /*
   * Northern-lights palette — saturated but in-range (no HDR overshoot) so bloom doesn't
   * spread the curtains into a screen-filling canvas. Discrete curtain shape stays clear.
   *
   *   auroraA - vibrant emerald green (dominant base)
   *   auroraB - vivid cyan-teal (cooler transition)
   *   auroraC - hot magenta / pink (upper edge tips)
   *   auroraD - rich violet (rare highest band)
   */
  vec3 auroraA = vec3(0.06, 0.95, 0.40);
  vec3 auroraB = vec3(0.12, 0.78, 0.78);
  vec3 auroraC = vec3(0.95, 0.30, 0.65);
  vec3 auroraD = vec3(0.55, 0.22, 0.92);
  float w1 = 0.5 + 0.5 * triFbm(dir, 2.8, vec2(uTime * 0.05, 1.1));
  float w2 = 0.5 + 0.5 * triFbm(dir, 3.2, vec2(0.6, uTime * 0.044));
  /* Bias toward green: green-cyan is more likely than pink-violet (matches real aurora). */
  float greenBias = 0.65 + 0.35 * triFbm(dir, 1.9, vec2(uTime * 0.032, 0.3));
  vec3 lowAur = mix(auroraA, auroraB, w1);
  vec3 hiAur = mix(auroraC, auroraD, w2);
  vec3 aur = mix(hiAur, lowAur, greenBias);
  /* Vivid in-range curtains - bright sheets without HDR overshoot, so bloom doesn't
   * spread the aurora into a screen-filling canvas. Discrete curtain shape preserved. */
  float auSoft = pow(max(0.0, au), 1.55);
  col += aur * auSoft * 0.85;

  /*
   * Milky Way wash — arching seam-free horizon-to-horizon band with filaments, dust lanes,
   * and a warm galactic-core bulge. Purely 3D (no atan seams). Gated by the same night +
   * twilight envelope as the aurora so it ramps in with the sky, not over it.
   */
  vec3 mwPole = normalize(vec3(0.28, 0.82, 0.5));
  vec3 mwCore = normalize(vec3(-0.46, 0.12, 0.88));
  float poleDist = abs(dot(dir, mwPole));
  float bandCore = 1.0 - smoothstep(0.02, 0.24, poleDist);
  float bandWide = 1.0 - smoothstep(0.0, 0.58, poleDist);
  float coreDot = max(0.0, dot(dir, mwCore));
  float coreBulge = pow(coreDot, 7.0);
  float filFine = triFbm(dir * 3.4 + vec3(0.4, -0.2, 0.1), 1.8, vec2(uTime * 0.0045, uTime * 0.0031));
  float filBroad = triFbm(dir * 1.6 + vec3(-1.1, 0.3, 0.7), 0.95, vec2(-uTime * 0.0028, uTime * 0.0022));
  float dustLanesRaw = triFbm(dir * 2.1 + vec3(0.7, -0.4, 0.2), 1.25, vec2(uTime * 0.0018, -uTime * 0.0012));
  float dustLanes = smoothstep(0.36, 0.78, dustLanesRaw);
  float mwBody = bandCore * (0.28 + 0.72 * filFine) * (0.5 + 0.5 * filBroad);
  float mwHalo = bandWide * (0.3 + 0.7 * filBroad) * 0.35;
  float mwCoreGlow = bandWide * coreBulge * 1.6;
  float mwDust = 1.0 - 0.65 * dustLanes * bandCore;
  float mwDensity = (mwBody + mwHalo + mwCoreGlow) * mwDust;
  vec3 mwArm = vec3(0.16, 0.24, 0.46);
  vec3 mwViolet = vec3(0.28, 0.18, 0.46);
  vec3 mwPink = vec3(0.46, 0.26, 0.4);
  vec3 mwWarm = vec3(0.58, 0.44, 0.28);
  float coreT = smoothstep(-0.1, 0.95, dot(dir, mwCore));
  vec3 mwColor = mix(mwArm, mwViolet, smoothstep(0.0, 0.35, coreT));
  mwColor = mix(mwColor, mwPink, smoothstep(0.25, 0.65, coreT));
  mwColor = mix(mwColor, mwWarm, smoothstep(0.55, 0.98, coreT));
  float mwGate = nightRamp * nightGate * (1.0 - uStorm * 0.88) * vault;
  col += mwColor * mwDensity * mwGate * 0.62;

  /*
   * Daytime cloud system DISABLED.
   *
   * The FBM noise pattern in cloudHaze() created what the player kept describing as a
   * "grey dome over the top half of the sky in a polar grid pattern that follows the
   * sun". The pattern came from FBM contours projected onto two view-direction planes
   * combined with the near-sun darkening (cloudCol darkened by block * nearSun), which
   * read as a sun-tracking grey halo over the upper hemisphere.
   *
   * Pipeline values are zero'd so storm code paths still link but contribute nothing.
   * The cloudHaze function and storm grey wash code are kept in place for future use;
   * if we want clouds back later we re-enable the lines below and pick a noise that
   * does not show contour-grid artifacts.
   */
  vec2 flow = vec2(uTime * 0.011, uTime * 0.008);
  float dens = 0.0;
  vec3 sunN = normalize(uSunDir);
  float mu = max(0.0, dot(dir, sunN));
  float nearSun = pow(mu, 320.0);
  float block = 0.0;
  vec3 cloudBase = vec3(0.94, 0.96, 1.0);
  vec3 cloudCol = cloudBase;
  float cloudA = 0.0;
  /* Moon occlusion guard: cone around moon dir drops cloud alpha to 5% so the moon
   * disc reads clearly in front of any cloud haze — never behind. */
  float moonCone = smoothstep(0.97, 0.9995, dot(dir, normalize(uMoonDir)));
  cloudA *= mix(1.0, 0.05, moonCone);
  col = mix(col, cloudCol, cloudA);

  col = mix(uHorizon, col, vault);

  float dith = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (dith - 0.5) * 0.006;
  gl_FragColor = vec4(col, 1.0);
}
`;

function skyDomeSegments(graphics: GraphicsBudget): { w: number; h: number } {
  /* Higher tessellation removes a pinched “cone” at the zenith on low budgets. */
  const w = Math.max(graphics.skydomeSphereW, 52);
  const h = Math.max(graphics.skydomeSphereH, 26);
  return { w, h };
}

/** Single sky mesh: full sphere, fused clouds, seam-free night aurora. */
export function createUnifiedSkyDomeMesh(graphics: GraphicsBudget, baseRadius: number): THREE.Mesh {
  const { w, h } = skyDomeSegments(graphics);
  const geo = createFullSphereSkyGeometry(w, h);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      /** Initialized opposite the sun so the moon-cone mask starts harmlessly on day 1. */
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uZenith: { value: new THREE.Vector3() },
      uSkyMid: { value: new THREE.Vector3() },
      uHorizon: { value: new THREE.Vector3() },
      uSunsetMix: { value: 0 },
      uCameraPosition: { value: new THREE.Vector3() },
      uNightMix: { value: 0 },
      uDuskMix: { value: 0 },
      uStorm: { value: 0 },
      uSunElevation: { value: 0.5 },
      uTime: { value: 0 },
      uDayMix: { value: 1 },
    },
    vertexShader: skyVert,
    fragmentShader: unifiedSkyFrag,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'idlecraft_sky_dome';
  mesh.renderOrder = SKY_RENDER_SKY_DOME;
  mesh.frustumCulled = false;
  mesh.scale.setScalar(baseRadius);
  return mesh;
}
