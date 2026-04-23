import * as THREE from 'three';

const _axis = new THREE.Vector3();
const _axis2 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Phase in [0,1): 0 new, 0.25 first quarter, 0.5 full, 0.75 last.
 * Each full24h in `totalSimHours` advances by 1 / cycleDays of the loop.
 */
export function lunarPhaseFromTotalHours(totalSimHours: number, cycleDays: number, phase0: number): number {
  const frac = totalSimHours / (24 * cycleDays) + phase0;
  return THREE.MathUtils.euclideanModulo(frac, 1);
}

/**
 * Illuminated fraction of the lunar disk in [0, 1]: 0 at new moon, 1 at full moon.
 * `phase` uses the same [0, 1) convention as {@link lunarPhaseFromTotalHours}.
 */
export function lunarIllumination01(phase: number): number {
  return 0.5 * (1 - Math.cos(2 * Math.PI * phase));
}

/**
 * Moon direction from Earth-center convention: phase 0 aligns with sun (new),
 * phase 0.5 opposite (full). Optional small tilt breaks coplanar motion.
 */
export function moonDirectionFromSunAndPhase(
  sunDir: THREE.Vector3,
  lunarPhase: number,
  eclipticTiltDeg: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  _axis.crossVectors(sunDir, _up);
  if (_axis.lengthSq() < 1e-12) _axis.set(1, 0, 0);
  else _axis.normalize();
  out.copy(sunDir).applyAxisAngle(_axis, lunarPhase * Math.PI * 2);
  const tilt = THREE.MathUtils.degToRad(eclipticTiltDeg);
  if (Math.abs(tilt) > 1e-6) {
    _axis2.crossVectors(out, _up);
    if (_axis2.lengthSq() > 1e-12) {
      _axis2.normalize();
      out.applyAxisAngle(_axis2, tilt);
    }
  }
  return out.normalize();
}
