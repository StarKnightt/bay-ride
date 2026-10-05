import * as THREE from "three";

/**
 * The boat's wake, drawn by the sea shader from a short trail of past bow positions (a ring buffer
 * sampled every WAKE_DT seconds, newest first). For each water pixel the nearest point on that
 * trail gives the distance behind the bow along the track (x), the offset across it (y), the age
 * of the water there and the speed the boat had when it passed.
 *
 * From those: the Kelvin pattern (transverse and diverging waves inside a 19.5° half-angle V, with
 * the cusp lines along its arms), lacy foam arms that leave the bow and widen and break up aft,
 * the propeller's boil behind the transom, the paler aerated band and the long smooth slick it
 * leaves, and a thin broken collar where the hull meets the water. The waves also move the mesh
 * a little and tilt the mirror and the glitter.
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
  /** Heading then (rad): the track's smooth tangent, so the pattern bends without kinks. */
  yaw: number;
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
  uBoatB: { value: new THREE.Vector4(1.8, 0.74, 0, 0) },
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
    WAKE_U.uWakeE.value[i].set(p.speed, p.churn, Math.sin(p.yaw), Math.cos(p.yaw));
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
  // The heading interpolated along the segment (pointing aft): continuous across the joints, so
  // offsets and distances measured with it never step where one segment hands over to the next.
  vec2 Ts = mix(uWakeE[bi].zw, uWakeE[bi + 1].zw, bu);
  float lt = length(Ts);
  w.T = lt > 1e-3 ? Ts / lt : vec2(sin(uBoat.z), cos(uBoat.z));
  vec2 d = q - A.xy - ab * bu;
  w.y = d.x * w.T.y - d.y * w.T.x;
  w.odo = mix(A.z, B.z, bu);
  w.x = uWakeInfo.y - w.odo + dot(d, w.T);
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
struct Wake { float h; vec2 grad; float foam; float slick; float aer; float contact; float crest; float near; };

Wake wakeShade(vec2 q, float px, float pxm){
  Wake o;
  o.h = 0.0; o.grad = vec2(0.0); o.foam = 0.0; o.slick = 0.0; o.aer = 0.0; o.contact = 0.0; o.crest = 0.0; o.near = 0.0;
  if (uBoatB.w < 0.5) return o;
  WakeP w;
  // Beyond the widest part of the pattern (the aerated band and the V's outer edge) nothing shows.
  if (wakeFind(q, w) && w.x > -3.0 && abs(w.y) < 0.62 * max(w.x, 0.0) + 4.0) {
    vec4 inf;
    o.h = wakeKelvin(w, pxm, o.grad, inf);
    float x = w.x, ay = abs(w.y), sd = sign(w.y);
    float S = smoothstep(0.8, 4.5, w.spd);
    float fade = 1.0 - smoothstep(${MAX_AGE} * 0.6, ${MAX_AGE}, w.age);
    // Far off, anything narrower than about a pixel and a half would break into dots: it is
    // widened to that and thinned to keep the same weight, so the V still reads as lines.
    float pxW = 2.4 * pxm;
    // The lace resolves by the longer axis of the pixel's footprint, so at a grazing angle a
    // foreshortened trail turns into solid painted line instead of a row of holes.
    float pxL = max(px, pxm * 0.9);
    // Widening keeps a feature's weight where the pixel is blurred both ways; where it is only
    // stretched (low across the water) the widened band is still a thin line on screen and keeps
    // its full strength.
    float keep = smoothstep(1.5, 4.0, pxm / max(px, 1e-4));
    float xT = 2.06 * uBoatB.x;

    // The arms: they leave the stem, hug the hull's flare, then run out along the cusp lines,
    // widening and breaking up with distance and age.
    float hb = uBoatB.y * sqrt(clamp(x / 1.7, 0.0, 1.0));
    float wob = (0.12 + 0.025 * x) * (vnoise(vec2(w.odo * 0.09, sd * 5.0)) - 0.5);
    float yA = max(0.34 * x + 0.03, hb + 0.05) + wob;
    float wA = 0.1 + 0.045 * x + 0.05 * w.age;
    float wE = max(wA, pxW);
    float da = (ay - yA) / wE;
    // A crisp outer edge and a long ragged tail inward where the broken crest spills back.
    float prof = da > 0.0 ? exp(-da * da * 3.0) : exp(-da * da * 0.8);
    float amp = S * exp(-x / 34.0) * exp(-w.age / 9.0) * smoothstep(-0.1, 0.5, x) * fade;
    // Feathers: the diverging crests cross the arm as short chevrons; once they are only a few
    // pixels apart they average out into an even band.
    float lamD = 4.19 / max(uWakeInfo.w, 0.05);
    float fe = smoothstep(-0.25, 0.75, cos(inf.y + 1.4 * (vnoise(vec2(w.odo * 0.22, ay * 0.6)) - 0.5)));
    fe = mix(fe, 0.6, 1.0 - smoothstep(4.0, 9.0, lamD / pxm));
    float dens = amp * prof * mix(sqrt(wA / wE), 1.0, keep) * mix(0.5, 1.0, fe) * (1.0 + 1.8 * smoothstep(0.05, 0.4, pxL));
    // Strokes drawn out along the track, so the lace reads as streaming threads, not as holes.
    // Where the arm is thin it still holds together as a broken line rather than lone islands.
    float densL = dens * 0.75 + 0.2 * smoothstep(0.12, 0.45, dens);
    float arm = wLace(vec2(w.y * 1.8, w.odo * 0.32), clamp(densL, 0.0, 1.0), 2.0 + sd, pxL);

    // Between the arms just behind the stern: broken white along the transverse crests.
    float inV = 1.0 - smoothstep(yA - wE, yA, ay);
    float tC = smoothstep(0.55, 0.95, cos(inf.x)) * inf.z * S * exp(-max(x - xT, 0.0) / 9.0) * exp(-w.age / 4.0)
             * smoothstep(xT - 0.5, xT + 1.5, x) * inV * fade;
    float trans = wLace(vec2(w.y * 1.4 + 9.0, w.odo * 0.8), clamp(tC * 0.55, 0.0, 1.0), 7.0, pxL);

    // The propeller: a boil of broken white right behind the transom that churns as it ages and
    // is gone within ~15 m, a paler aerated band that outlives it, and a long smooth slick.
    float xs = x - xT;
    float behind = smoothstep(-0.5, 0.4, xs);
    float wP = 0.3 + 0.05 * max(xs, 0.0) + 0.05 * w.age;
    float wPe = max(wP, pxW);
    float lat = ay / wPe;
    float boil = w.churn * behind * exp(-lat * lat * 1.5) * exp(-max(xs, 0.0) / 7.0) * exp(-w.age / 3.2) * mix(sqrt(wP / wPe), 1.0, keep) * (1.0 + 1.5 * smoothstep(0.05, 0.4, pxL));
    boil *= (0.5 + 0.7 * vnoise(vec2(w.odo * 0.35, w.y * 1.2))) * (1.0 + 0.8 * exp(-max(xs, 0.0) / 1.5));
    float boilF = wLace(vec2(w.y * 2.0, w.odo * 0.6) + vec2(0.0, w.age * 0.7), clamp(boil * 0.9, 0.0, 1.0), 5.0, pxL);
    float wA2 = wPe * 1.6 + 0.3;
    o.aer = w.churn * behind * exp(-w.age / 7.0) * exp(-ay * ay / (wA2 * wA2)) * (0.75 + 0.5 * vnoise(vec2(w.y * 0.8, w.odo * 0.15))) * fade;
    float wS = max(0.7 + 0.08 * max(xs, 0.0) + 0.05 * w.age, pxW);
    o.slick = max(w.churn, S * 0.6) * 0.75 * exp(-w.age / 10.0) * exp(-ay * ay / (wS * wS)) * smoothstep(-1.0, 1.0, xs) * fade;
    o.foam = max(arm, max(boilF, trans));

    // Broken water roughs up the mirror and the glitter (fades before it could shimmer).
    float rough = clamp(amp * prof * 1.2 + boil + o.aer * 0.35, 0.0, 1.0) * (1.0 - smoothstep(0.1, 0.4, pxm));
    o.grad += (vec2(vnoise(q * 1.7), vnoise(q * 1.7 + 5.0)) - 0.5) * 0.4 * rough;

    // Painted crest tone: thin light crest lines and darker troughs where they are wide enough
    // to draw, a soft swell of tone where they are not.
    float aMax = 0.12 * S * inversesqrt(1.0 + x / 7.0) * exp(-w.age / 16.0) * smoothstep(0.3, 3.5, x) * fade;
    float cT = cos(inf.x), cD = cos(inf.y);
    float sharpT = smoothstep(0.5, 0.95, cT) - 0.55 * smoothstep(-0.4, -0.95, cT);
    float sharpD = smoothstep(0.5, 0.95, cD) - 0.55 * smoothstep(-0.4, -0.95, cD);
    float sk = smoothstep(8.0, 16.0, lamD / pxm);
    o.crest = clamp(mix(cT, sharpT, sk) * inf.z + mix(cD, sharpD, sk) * inf.w, -1.0, 1.0) * smoothstep(0.005, 0.05, aMax);
    // The arms' own swell: a darker line just outside the foam (the wave's face turned to the
    // eye) and a lighter one on it. Thin and soft near; far off, where the waves can no longer be
    // drawn, it is what carries the V (at least a couple of pixels wide).
    float wL = max(0.25 + 0.03 * x, pxW * 0.8);
    float dO = (ay - yA - wE * 0.6 - wL * 0.6) / wL;
    float swA = S * exp(-x / 60.0) * exp(-w.age / 14.0) * smoothstep(0.5, 3.0, x) * fade;
    o.crest = clamp(o.crest - 0.9 * swA * exp(-dO * dO) + 0.5 * swA * prof * smoothstep(0.05, 0.3, pxm), -1.0, 1.0);
  }
  // The hull: a thin broken collar of foam hugging the waterline, piled up at the bow when she
  // moves, and a faint darker line right against the planking. Nothing reaches past about a
  // metre, and the stern is left to the propeller's boil.
  float tt, f, s;
  float d = hullDist(q, tt, f, s);
  o.near = 1.0 - smoothstep(3.0, 9.0, d);
  if (d < 1.2) {
    float spd = clamp(abs(uBoat.w) / 7.0, 0.0, 1.0);
    float bowK = smoothstep(0.5, 1.0, tt);
    float sternK = smoothstep(0.02, 0.25, tt);
    float wF = 0.05 + 0.05 * spd + 0.22 * spd * bowK;
    float wFe = max(wF, 0.8 * pxm);
    float hf = exp(-max(d, 0.0) / wFe) * smoothstep(-0.1, -0.01, d) * (1.0 - smoothstep(0.5, 1.1, d)) * sternK * (1.0 - smoothstep(0.97, 1.04, tt));
    hf *= mix(0.5, 1.0, max(spd, bowK)) * (wF / wFe);
    vec2 cq = vec2((f + uWakeInfo.y + uTime * 0.3) * 1.6, d * 5.0 + step(s, 0.0) * 11.0);
    o.foam = max(o.foam, wLace(cq, clamp(hf * 1.1, 0.0, 1.0), 11.0, px));
    o.contact = (1.0 - smoothstep(0.0, 0.1 + 0.1 * spd, d)) * smoothstep(-0.08, -0.01, d) * sternK * (1.0 - smoothstep(0.1, 0.3, px));
  }
  return o;
}
`;
