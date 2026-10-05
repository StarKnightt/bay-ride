import * as THREE from "three";

/**
 * The boat's wake, drawn by the sea shader from a short trail of past bow positions (a ring buffer
 * sampled every WAKE_DT seconds, newest first). For each water pixel the nearest point on that
 * trail gives the distance behind the bow along the track (x), the offset across it (y), the age
 * of the water there and the speed the boat had when it passed.
 *
 * From those: the Kelvin pattern (transverse and diverging waves inside a 19.5° half-angle V, with
 * the cusp lines along its arms), a churned propeller trail behind the outboard that spreads and
 * fades, the aerated and glassy band it leaves, foam feathers along the arms, and foam and a dark
 * contact line where the hull meets the water. The waves also move the mesh a little.
 */

export const WAKE_N = 32;
/** Seconds between trail points (the trail covers WAKE_N - 1 of these). */
export const WAKE_DT = 0.4;
/** Visual scale of the Kelvin wavelength (2πv²/g is ~40 m at planing speed, too long to read). */
const VIS = 0.33;

export interface TrailPoint {
  /** Bow position (world). */
  x: number;
  z: number;
  /** Odometer (m travelled by the bow) when it passed. */
  odo: number;
  /** Seconds since it passed. */
  age: number;
  /** Speed (m/s) then, and how hard the propeller churned (0…1). */
  speed: number;
  churn: number;
}

export const WAKE_U = {
  uWake: { value: Array.from({ length: WAKE_N }, () => new THREE.Vector4()) },
  uWakeE: { value: Array.from({ length: WAKE_N }, () => new THREE.Vector4()) },
  /** count, odometer now, speed now, k0 (visual Kelvin wavenumber). */
  uWakeInfo: { value: new THREE.Vector4() },
  /** Trail bounding box (xmin, zmin, xmax, zmax), padded by the V's reach. */
  uWakeBox: { value: new THREE.Vector4(1e5, 1e5, -1e5, -1e5) },
  /** Boat centre x, z, yaw, forward speed. */
  uBoat: { value: new THREE.Vector4(1e5, 1e5, 0, 0) },
  /** Waterline half length, half beam, throttle, hull present (1/0). */
  uBoatB: { value: new THREE.Vector4(1.67, 0.7, 0, 0) },
};

/** Upload the trail (newest first) and the hull's pose. */
export function setWake(
  trail: TrailPoint[],
  boat: { x: number; z: number; yaw: number; speed: number; throttle: number; odo: number },
  hull: { halfLen: number; halfBeam: number },
): void {
  const n = Math.min(trail.length, WAKE_N);
  let x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (let i = 0; i < n; i++) {
    const p = trail[i];
    WAKE_U.uWake.value[i].set(p.x, p.z, p.odo, p.age);
    WAKE_U.uWakeE.value[i].set(p.speed, p.churn, 0, 0);
    x0 = Math.min(x0, p.x);
    z0 = Math.min(z0, p.z);
    x1 = Math.max(x1, p.x);
    z1 = Math.max(z1, p.z);
  }
  const reach = n ? Math.min(48, 0.38 * (boat.odo - trail[n - 1].odo) + 6) : 0;
  WAKE_U.uWakeBox.value.set(x0 - reach, z0 - reach, x1 + reach, z1 + reach);
  const v = Math.max(Math.abs(boat.speed), 1.6);
  WAKE_U.uWakeInfo.value.set(n, boat.odo, Math.abs(boat.speed), 9.81 / (v * v * VIS));
  WAKE_U.uBoat.value.set(boat.x, boat.z, boat.yaw, boat.speed);
  WAKE_U.uBoatB.value.set(hull.halfLen, hull.halfBeam, boat.throttle, 1);
}

const MAX_AGE = ((WAKE_N - 1) * WAKE_DT).toFixed(2);

/** Shared by the sea's vertex and fragment shaders (needs vnoise; the fragment part needs wLace). */
export const WAKE_GLSL = /* glsl */ `
#define WAKE_N ${WAKE_N}
uniform vec4 uWake[WAKE_N];
uniform vec4 uWakeE[WAKE_N];
uniform vec4 uWakeInfo;
uniform vec4 uWakeBox;
uniform vec4 uBoat;
uniform vec4 uBoatB;

struct WakeP { float x; float y; float age; float spd; float churn; float odo; vec2 T; };

/** Nearest point on the trail (false outside its box). */
bool wakeFind(vec2 q, out WakeP w){
  w.x = 0.0; w.y = 0.0; w.age = 1e3; w.spd = 0.0; w.churn = 0.0; w.odo = 0.0; w.T = vec2(0.0, 1.0);
  if (q.x < uWakeBox.x || q.y < uWakeBox.y || q.x > uWakeBox.z || q.y > uWakeBox.w) return false;
  int n = int(uWakeInfo.x);
  // Coarse pass over every fourth point, then the segments around the nearest one.
  float cb = 1e12; int ci = 0;
  for (int i = 0; i < WAKE_N; i += 4) {
    if (i >= n) break;
    vec2 e = q - uWake[i].xy;
    float d2 = dot(e, e);
    if (d2 < cb) { cb = d2; ci = i; }
  }
  int i0 = max(ci - 5, 0), i1 = min(ci + 5, n - 1);
  float best = 1e12; int bi = 0; float bu = 0.0;
  for (int k = 0; k < 10; k++) {
    int i = i0 + k;
    if (i >= i1) break;
    vec2 a = uWake[i].xy, ab = uWake[i + 1].xy - a;
    float u = clamp(dot(q - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    vec2 d = q - a - ab * u;
    float d2 = dot(d, d);
    if (d2 < best) { best = d2; bi = i; bu = u; }
  }
  vec4 A = uWake[bi], B = uWake[bi + 1];
  vec2 ab = B.xy - A.xy;
  float l = length(ab);
  w.T = l > 1e-3 ? ab / l : vec2(sin(uBoat.z), cos(uBoat.z));
  vec2 d = q - A.xy - ab * bu;
  w.y = d.x * w.T.y - d.y * w.T.x;
  w.odo = mix(A.z, B.z, bu);
  w.x = uWakeInfo.y - w.odo + ((bu <= 0.0 || bu >= 1.0) ? dot(d, w.T) : 0.0);
  w.age = mix(A.w, B.w, bu);
  w.spd = mix(uWakeE[bi].x, uWakeE[bi + 1].x, bu);
  w.churn = mix(uWakeE[bi].y, uWakeE[bi + 1].y, bu);
  return true;
}

/**
 * Kelvin wake height (m) and slope at trail coords; pxm = metres per pixel (shorter waves fade).
 * info = (transverse phase, diverging phase, transverse share, diverging share).
 */
float wakeKelvin(WakeP w, float pxm, out vec2 grad, out vec4 info){
  grad = vec2(0.0);
  info = vec4(0.0);
  float x = w.x;
  float ay = abs(w.y);
  if (x <= 0.05 || ay > 0.6 * x) return 0.0;
  float S = smoothstep(0.8, 4.5, w.spd) * mix(1.0, 0.7, smoothstep(5.5, 8.5, w.spd));
  float H = 0.12 * S * inversesqrt(1.0 + x / 7.0) * exp(-w.age / 16.0) * (1.0 - smoothstep(${MAX_AGE} * 0.7, ${MAX_AGE}, w.age)) * smoothstep(0.3, 3.5, x);
  if (H < 1e-4) return 0.0;
  float k0 = uWakeInfo.w;
  float r = ay / x, r2 = r * r;
  // Stationary-phase crest families: sin^2 of the wave angle on the transverse and diverging branch.
  float D = sqrt(max(1.0 - 8.0 * r2, 0.0));
  float den = 2.0 * (1.0 + r2);
  float uT = (1.0 - 2.0 * r2 - D) / den;
  float uD = (1.0 - 2.0 * r2 + D) / den;
  float cT = sqrt(1.0 - uT), cD = sqrt(max(1.0 - uD, 0.02));
  float phT = k0 * x / (cT * (1.0 + uT));
  float phD = k0 * x / (cD * (1.0 + uD));
  // Energy piles up along the cusp lines (the arms of the V) and dies away outside them.
  float cusp = 1.0 + 1.1 * (1.0 - smoothstep(0.0, 0.45, D));
  float outV = exp(-max(r - 0.3536, 0.0) * 28.0);
  float tN = (1.0 - smoothstep(0.28, 0.37, r)) * mix(1.0, 0.4, smoothstep(4.0, 8.0, uWakeInfo.z)) * cusp;
  float dN = smoothstep(0.05, 0.24, r) * cusp * outV * 1.15;
  float lT = 6.2831853 * cT * cT / k0, lD = 6.2831853 * cD * cD / k0;
  tN *= smoothstep(3.0 * pxm, 6.0 * pxm, lT);
  dN *= smoothstep(3.0 * pxm, 6.0 * pxm, lD);
  float aT = H * tN, aD = H * dN;
  vec2 No = vec2(w.T.y, -w.T.x) * sign(w.y);
  float kT = k0 / (cT * cT), kD = k0 / (cD * cD);
  grad = -aT * sin(phT) * kT * (cT * w.T + sqrt(uT) * No) - aD * sin(phD) * kD * (cD * w.T + sqrt(uD) * No);
  float gl = length(grad);
  if (gl > 0.4) grad *= 0.4 / gl;
  info = vec4(phT, phD, tN, dN);
  return aT * cos(phT) + aD * cos(phD);
}

/** Mesh displacement from the wake (vertex shader). */
float hullDist(vec2 q, out float tt, out float f, out float s);
float wakeHeight(vec2 q, float pxm){
  WakeP w;
  if (!wakeFind(q, w)) return 0.0;
  vec2 g; vec4 inf;
  // Calm right against the hull, so the waterline stays on the planking.
  float tt, f, s;
  float near = smoothstep(0.2, 2.2, hullDist(q, tt, f, s));
  return wakeKelvin(w, pxm, g, inf) * near;
}

/**
 * Waterline footprint of the hull in its own frame: f forward of amidships, s to starboard.
 * Returns the distance (m) outside the hull's waterline (negative inside), tt = 0 transom … 1 bow.
 */
float hullDist(vec2 q, out float tt, out float f, out float s){
  vec2 rel = q - uBoat.xy;
  float cy = cos(uBoat.z), sy = sin(uBoat.z);
  f = dot(rel, vec2(-sy, -cy));
  s = dot(rel, vec2(cy, -sy));
  float L = 2.0 * uBoatB.x;
  tt = (f + uBoatB.x * 1.1) / L;
  float bw = uBoatB.y * (1.0 - pow(max(tt - 0.35, 0.0) / 0.65, 1.7)) * (0.86 + 0.14 * smoothstep(0.0, 0.3, tt));
  return max(abs(s) - max(bw, 0.0), max(-tt, tt - 1.0) * L);
}
`;

/** Fragment-shader part: foam, slick, aeration, hull contact (needs wLace from waves.ts). */
export const WAKE_FS_GLSL = /* glsl */ `
struct Wake { float h; vec2 grad; float foam; float slick; float aer; float contact; float crest; };

Wake wakeShade(vec2 q, float px, float pxm){
  Wake o;
  o.h = 0.0; o.grad = vec2(0.0); o.foam = 0.0; o.slick = 0.0; o.aer = 0.0; o.contact = 0.0; o.crest = 0.0;
  if (uBoatB.w < 0.5) return o;
  WakeP w;
  // Beyond the widest part of the pattern (the aerated band and the V's outer edge) nothing shows.
  if (wakeFind(q, w) && w.x > -3.0 && abs(w.y) < 0.62 * max(w.x, 0.0) + 3.0) {
    vec4 inf;
    o.h = wakeKelvin(w, pxm, o.grad, inf);
    float x = w.x, ay = abs(w.y);
    float S = smoothstep(0.8, 4.5, w.spd);
    // Metres behind the transom.
    float xs = x - 2.0 * uBoatB.x * 1.05;
    // Propeller trail: churned white water behind the outboard, spreading and fading with age.
    float wP = (0.26 + 0.05 * max(xs, 0.0) + 0.1 * w.age) * (0.75 + 0.5 * vnoise(vec2(w.odo * 0.35, sign(w.y) * 3.0)));
    float lat = ay / wP;
    float churn = w.churn * exp(-w.age / 2.6) * smoothstep(-0.6, 0.3, xs);
    float prop = churn * exp(-lat * lat * 1.3) * (0.55 + 0.6 * exp(-max(xs, 0.0) / 3.0));
    prop *= 0.75 + 0.5 * vnoise(vec2(w.y * 1.3, w.odo * 0.35));
    // Aerated water under the trail: a lighter band that outlives the foam; and the glassy slick
    // where the churn has flattened the ripples.
    float wA2 = wP * 1.7 + 0.35;
    o.aer = w.churn * exp(-w.age / 9.0) * exp(-ay * ay / (wA2 * wA2)) * smoothstep(-0.6, 0.6, xs);
    float wS = 1.0 + 0.11 * max(xs, 0.0);
    o.slick = max(w.churn, S * 0.6) * 0.6 * exp(-w.age / 8.0) * exp(-ay * ay / (wS * wS)) * smoothstep(-1.0, 1.0, xs);
    // Painted streaks tied to the water (odometer along the track, offset across it): a solid core
    // where the churn is thick, breaking into lengthwise strokes toward its edges and as it ages.
    float fine = 1.0 - smoothstep(0.04, 0.14, px);
    float nP = vnoise(vec2(w.y * 2.0, w.odo * 0.15)) * mix(1.0, 0.62, fine) + vnoise(vec2(w.y * 4.6 + 7.0, w.odo * 0.42)) * 0.38 * fine;
    float dP = clamp(prop * 1.05, 0.0, mix(0.9, 0.6, smoothstep(1.0, 8.0, xs)));
    float pf = smoothstep(1.0 - dP, 1.0 - dP + 0.1 + px * 0.5, nP) * smoothstep(0.03, 0.12, dP);
    // The arms of the V: foam where the diverging waves pile up along the cusp lines, broken into
    // feathers by the diverging crests, strongest by the bow and dissolving aft.
    float yA = uBoatB.y * 0.85 + 0.3536 * x + (0.25 + 0.03 * x) * (vnoise(vec2(w.odo * 0.12, sign(w.y) * 5.0)) - 0.5);
    float wArm = 0.2 + 0.035 * x;
    float da = (ay - yA) / wArm;
    float arm = exp(-da * da) * S * exp(-x / 17.0) * exp(-w.age / 8.0) * smoothstep(0.2, 2.0, x);
    float cD = cos(inf.y);
    // Feathers: short diagonal strokes along the arm, at a fraction of the diverging wavelength.
    float fe = cos(inf.y * 2.4 + 1.3 * vnoise(vec2(w.odo * 0.3, w.y)));
    arm *= mix(0.1 + 0.9 * smoothstep(-0.35, 0.6, fe), 0.55, smoothstep(0.12, 0.45, pxm));
    // White tops on the steep diverging crests close behind the bow, inside the arms.
    float crestW = smoothstep(0.55, 0.95, cD) * inf.w * S * exp(-x / 8.0) * exp(-w.age / 5.0) * smoothstep(0.1, 0.25, ay / max(x, 0.1));
    float aDens = clamp(max(arm * 1.05, crestW * 0.6), 0.0, 0.8);
    // Feathered strokes along the arm (long down the track, narrow across it).
    float nA = vnoise(vec2(da * 1.6 + 3.0, w.odo * 0.2)) * mix(1.0, 0.6, fine) + vnoise(vec2(da * 3.8 + 9.0, w.odo * 0.55)) * 0.4 * fine;
    float af = aDens > 0.02 ? smoothstep(1.0 - aDens, 1.0 - aDens + 0.1 + px * 0.5, nA) * smoothstep(0.02, 0.1, aDens) : 0.0;
    o.foam = max(pf, af);
    // Painted crest tone: lighter crests, darker troughs (waves only, scaled to their height).
    float aMax = 0.12 * S * inversesqrt(1.0 + x / 7.0) * exp(-w.age / 16.0) * smoothstep(0.3, 3.5, x);
    o.crest = clamp((cos(inf.x) * inf.z + cD * inf.w) * smoothstep(0.0, 0.05, aMax), -1.0, 1.0) * smoothstep(0.01, 0.06, aMax);
  }
  // The hull: a thin foam collar where it meets the water, a bow wave climbing it at speed, and the
  // darker water in its shadow. (The sea inside the open boat is hidden by its depth-only lid.)
  float tt, f, s;
  float d = hullDist(q, tt, f, s);
  if (d < 3.0) {
    float spd = clamp(abs(uBoat.w) / 7.5, 0.0, 1.0);
    float bowK = smoothstep(0.25, 0.95, tt);
    float wF = 0.06 + spd * (0.07 + 0.22 * bowK) + 0.02 * uBoatB.z;
    float hf = exp(-max(d, 0.0) / wF) * smoothstep(-0.14, -0.02, d);
    hf *= mix(0.45 + 0.55 * vnoise(vec2(atan(s, f) * 6.0, uTime * 0.8)), 1.0, spd);
    // Strokes that slide aft along the hull as she moves (tied to the water via the odometer).
    float fineH = 1.0 - smoothstep(0.03, 0.1, px);
    float nH = vnoise(vec2((f + uWakeInfo.y) * 1.1, d * 4.0 + 2.0)) * mix(1.0, 0.65, fineH) + vnoise(vec2((f + uWakeInfo.y) * 2.6, d * 9.0)) * 0.35 * fineH;
    float dH = clamp(hf * 0.9, 0.0, 0.85);
    float hl = smoothstep(1.0 - dH, 1.0 - dH + 0.1 + px * 0.5, nH) * smoothstep(0.03, 0.1, dH);
    o.foam = max(o.foam, max(hl, hf * 0.6 * smoothstep(0.02, 0.06, px)));
    o.contact = (1.0 - smoothstep(0.0, 0.35 + 0.25 * spd, d)) * smoothstep(-0.14, -0.04, d);
  }
  return o;
}
`;
