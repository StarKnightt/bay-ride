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
/**
 * Visual scale of the Kelvin wavelength (2πv²/g is ~40 m at planing speed, too long to read): a
 * few transverse crests fit between the transom and the bottom of the chase view.
 */
const VIS = 0.16;

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
  // Diverging crests only as short broken feathers near the arms: carried inward to the track they
  // would be long straight lines fanning from the bow across the calm water.
  float dN = smoothstep(0.17, 0.3, r) * cusp * outV * 1.15 * (0.35 + 0.65 * smoothstep(0.35, 0.65, vnoise(vec2(w.odo * 0.35, ay * 1.3))));
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
struct Wake { float h; vec2 grad; float foam; float slick; float aer; float contact; float crest; float near; float brk; };

/**
 * Streamwise wake lace at density dens: p = (across, along) the track in metres. Cells drawn out
 * along the flow and of mixed sizes, joined by long thin threads; as the density falls the cells
 * open, merge and leave only threads and scraps. Far off it melts into its average coverage.
 */
float wakeLace(vec2 p, float dens, float seed, float px, float threads){
  if (dens < 0.02) return 0.0;
  float cov = pow(clamp(dens, 0.0, 1.0), 1.3) * 0.8;
  float far = smoothstep(0.05, 0.16, px);
  if (far > 0.99) return cov;
  vec2 q = p + seed * vec2(7.3, 19.1);
  // Warped mostly sideways and slowly along the track, so the threads meander.
  vec2 wq = vec2(q.x * 1.6, q.y * 0.35);
  q.x += (vnoise(wq + 3.1) - 0.5) * 0.4 + (vnoise(wq * 2.3 + 8.7) - 0.5) * 0.15;
  q.y += (vnoise(wq * 1.3 + 5.2) - 0.5) * 1.0;
  // Cells ~0.15-0.4 m across and 0.4-1 m along, three octaves of mixed sizes.
  float fine = 1.0 - smoothstep(0.012, 0.035, px);
  float c = vnoise(vec2(q.x * 3.8, q.y * 1.15)) * 0.5
          + vnoise(vec2(q.x * 8.0, q.y * 2.5) + 4.0) * 0.32
          + (vnoise(vec2(q.x * 16.0, q.y * 5.0) + 9.0) - 0.5) * 0.18 * fine + 0.09;
  // Threads: ridges of a streamwise noise, thin filaments joining the cells.
  // Broken into short meandering pieces, so none runs on straight across many cells.
  float r = (1.0 - abs(vnoise(vec2(q.x * 6.0, q.y * 2.1) + 2.0) * 2.0 - 1.0)) * smoothstep(0.3, 0.55, vnoise(vec2(q.x * 2.2, q.y * 0.9) + 13.0));
  float d = clamp(dens, 0.0, 1.0);
  // Holes stay open even in the densest boil. Up close the edges are soft and torn and bubble
  // holes open inside the thicker clumps: a solid flat-edged blob reads as a paper cut-out.
  float hn = vnoise(vec2(q.x * 9.0, q.y * 3.2) + seed * 3.1 + 17.0);
  float th = mix(0.76, 0.32, d) + 0.09 * (hn - 0.5) * fine;
  float aa = 0.012 + px * 5.0;
  float aaP = aa + 0.05 * (1.0 - smoothstep(0.004, 0.02, px));
  float patchM = smoothstep(th - aaP, th + aaP, c);
  patchM *= 1.0 - 0.85 * smoothstep(0.6, 0.72, hn) * smoothstep(th, th + 0.22, c) * fine;
  float tw = mix(0.94, 0.82, d);
  float thread = smoothstep(tw - aa * 3.0, tw + aa * 3.0, r) * smoothstep(th - 0.25, th - 0.05, c) * (1.0 - smoothstep(0.012, 0.03, px)) * threads;
  return mix(max(patchM, thread * 0.9), cov, far);
}

Wake wakeShade(vec2 q, float px, float pxm){
  Wake o;
  o.h = 0.0; o.grad = vec2(0.0); o.foam = 0.0; o.slick = 0.0; o.aer = 0.0; o.contact = 0.0; o.crest = 0.0; o.near = 0.0; o.brk = 0.0;
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
    // The bow wave stands out from the stem past the gunwale's flare, so seen from astern the arm
    // runs the whole length of her side instead of appearing at the quarters.
    float hb = uBoatB.y * 1.15 * sqrt(clamp(x / 1.4, 0.0, 1.0)) + 0.1 * smoothstep(0.0, 0.6, x);
    float wob = (0.06 + 0.025 * x) * (vnoise(vec2(w.odo * 0.09, sd * 5.0)) - 0.5) * smoothstep(0.5, 3.0, x);
    float yA = max(0.34 * x + 0.03, hb + 0.05) + wob;
    float wA = 0.1 + 0.045 * x + 0.05 * w.age;
    float wE = max(wA, pxW);
    float da = (ay - yA) / wE;
    // A crisp outer edge and a long ragged tail inward where the broken crest spills back. The
    // edge itself wanders in and out along the arm, so it never draws a ruled line.
    float daR = da + (vnoise(vec2(w.odo * 0.45, sd * 4.0)) - 0.5) * 1.4 + (vnoise(vec2(w.odo * 1.7, ay * 0.8)) - 0.5) * 0.7;
    float prof = daR > 0.0 ? exp(-daR * daR * 3.0) : exp(-daR * daR * 0.8);
    float amp = S * exp(-x / 34.0) * exp(-w.age / 9.0) * smoothstep(-0.1, 0.5, x) * fade;
    // Feathers: the diverging crests cross the arm as short chevrons; once they are only a few
    // pixels apart they average out into an even band.
    float lamD = 4.19 / max(uWakeInfo.w, 0.05);
    float fe = smoothstep(-0.25, 0.75, cos(inf.y + 1.4 * (vnoise(vec2(w.odo * 0.22, ay * 0.6)) - 0.5)));
    fe = mix(fe, 0.6, 1.0 - smoothstep(4.0, 9.0, lamD / pxm));
    // Where the bow wave climbs into the arm, it is a dense crest of white.
    float feed = 1.0 + 0.5 * exp(-x / 2.2);
    float dens = amp * prof * feed * mix(sqrt(wA / wE), 1.0, keep) * mix(0.5, 1.0, fe) * (1.0 + 1.8 * smoothstep(0.05, 0.4, pxL));
    // Its outer edge breaks harder than its core.
    dens *= mix(1.0, 0.7 + 0.3 * vnoise(vec2(w.odo * 0.6, ay * 3.0) + sd * 3.0), smoothstep(0.0, 1.2, da));
    // White belongs to the inner arms by the boat: further out the arm is clear water carrying
    // its crest line, with only scattered patches. Far off the thinning is left to the lace's
    // own averaging, so the distant V keeps its weight.
    float gapA = smoothstep(0.25, 0.6, vnoise(vec2(w.odo * 0.3, sd * 11.0 + ay * 0.15)));
    float gapB = smoothstep(0.35, 0.65, vnoise(vec2(w.odo * 1.1 + sd * 5.0, ay * 0.7)));
    float latF = mix(1.0, (0.05 + 0.45 * gapA) * gapB, smoothstep(0.85, 2.2, ay)) * mix(1.0, gapA, 0.5 * smoothstep(1.5, 4.0, x))
               * mix(1.0, 0.3 + 0.7 * gapB, smoothstep(0.0, 1.0, daR));
    dens *= mix(latF, 1.0, smoothstep(0.25, 0.8, pxL));
    float arm = wakeLace(vec2(w.y, w.odo), clamp(dens * 0.85, 0.0, 1.0), 2.0 + sd, pxL, 1.0);

    // Transverse crests curving across between the arms, from just aft of the transom: painted
    // tone (lighter crests, darker troughs) and broken white along the first one or two.
    float r = ay / max(x, 0.05);
    float inV = 1.0 - smoothstep(yA - wE, yA, ay);
    float tVis = (1.0 - smoothstep(0.24, 0.36, r)) * S * exp(-max(x - xT, 0.0) / 26.0) * exp(-w.age / 12.0)
               * smoothstep(xT - 1.0, xT + 2.0, x) * fade;
    float lamT = 6.2831853 / max(uWakeInfo.w, 0.05);
    float tRes = smoothstep(3.0, 7.0, lamT / pxm);
    float cTr = cos(inf.x);
    float tTone = (smoothstep(0.35, 0.9, cTr) - 0.7 * smoothstep(-0.2, -0.85, cTr)) * tVis * tRes;
    float tC = smoothstep(0.6, 0.95, cTr) * tVis * tRes * exp(-max(x - xT, 0.0) / (1.3 * lamT)) * inV;
    float trans = wakeLace(vec2(w.y + 9.0, w.odo * 1.6), clamp(tC * 0.38, 0.0, 1.0), 7.0, pxL, 0.0);

    // The propeller: a boil about the beam's width right behind the transom for a boat length or
    // two, narrowing and breaking into patches and scraps by ~12 m, a paler aerated band that
    // outlives it a little, and a smooth calm slick beyond with no white at all.
    float xs = x - xT;
    float behind = smoothstep(-0.5, 0.4, xs);
    float wP = (0.42 + 0.14 * smoothstep(0.0, 2.5, xs)) * (1.0 - 0.45 * smoothstep(3.0, 14.0, xs));
    float wPe = max(wP, pxW);
    float lat = ay / wPe;
    float stage = exp(-max(xs - 1.0, 0.0) / 4.0) * exp(-w.age / 6.0);
    float boil = w.churn * behind * exp(-lat * lat * 1.6) * stage * mix(sqrt(wP / wPe), 1.0, keep) * (1.0 + 0.8 * smoothstep(0.05, 0.4, pxL));
    boil *= (0.6 + 0.6 * vnoise(vec2(w.odo * 0.3, w.y * 1.4))) * (1.0 + 0.9 * exp(-max(xs, 0.0) / 1.5));
    float boilF = wakeLace(vec2(w.y * 1.2, w.odo) + vec2(0.0, w.age * 0.5), clamp(boil * 0.8, 0.0, 1.0), 5.0, pxL, 1.0);
    float wA2 = wPe * 1.5 + 0.25;
    // The aerated band and the slick have soft edges that wander in and out along the track,
    // never a ruled boundary, and the slick is patchy: calm lanes with chop creeping back in.
    float edgeN = vnoise(vec2(w.odo * 0.22, sd * 3.0)) - 0.5, edgeF = vnoise(vec2(w.odo * 0.9, w.y * 0.6 + 4.0)) - 0.5;
    float ayA = max(ay + edgeN * 0.5 * wA2 + edgeF * 0.25 * wA2, 0.0);
    // Patchy, so the band astern is broken pale water and never one flat wedge.
    o.aer = w.churn * behind * exp(-max(xs, 0.0) / 9.0) * exp(-ayA * ayA / (wA2 * wA2)) * (0.45 + 0.7 * smoothstep(0.25, 0.7, vnoise(vec2(w.y * 0.8, w.odo * 0.5)))) * fade;
    float wS = max((0.75 + 0.05 * max(xs, 0.0)) * (0.75 + 0.5 * vnoise(vec2(w.odo * 0.12, sd * 7.0))), pxW);
    float ayS = max(ay + (edgeN * 0.7 + edgeF * 0.35) * wS, 0.0);
    o.slick = max(w.churn, S * 0.6) * 0.75 * exp(-w.age / 10.0) * exp(-ayS * ayS / (wS * wS)) * smoothstep(-1.0, 1.0, xs) * fade
            * (0.55 + 0.45 * smoothstep(0.25, 0.65, vnoise(vec2(w.odo * 0.35, w.y * 0.9) + 2.0)));
    o.foam = max(arm, max(boilF, trans));
    // The slick is glassy: the wake's waves lie flat across it.
    o.grad *= 1.0 - 0.75 * clamp(o.slick * 1.3, 0.0, 1.0);

    // Churned water holds no mirror image: behind the transom, a band a little wider than her
    // beam, fading as the water settles into the slick.
    float lB = ay / (uBoatB.y * 1.25 + 0.06 * max(xs, 0.0));
    o.brk = clamp(w.churn * smoothstep(-0.6, 0.2, xs) * exp(-lB * lB * 1.4) * exp(-max(xs, 0.0) / 9.0) * 1.4 + boil + amp * prof * 0.7, 0.0, 1.0);

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
    // Near the eye a soft crest spans the whole V: broken into patches, its sides fraying out
    // irregularly short of the arms, and its light side held down, so it never lays a pale
    // straight-edged sheet between them.
    float brkC = 0.3 + 0.7 * smoothstep(0.2, 0.7, vnoise(vec2(w.odo * 0.35, w.y * 0.6) + 6.0));
    float edgeC = 1.0 - smoothstep(0.45, 0.95, ay / max(yA, 0.05) + edgeN * 0.6 + edgeF * 0.3);
    float nearC = 1.0 - smoothstep(0.06, 0.3, pxm);
    float breakC = mix(1.0, brkC * edgeC, nearC);
    o.crest *= breakC * (o.crest > 0.0 ? 1.0 - 0.45 * nearC : 1.0);
    tTone *= breakC * (tTone > 0.0 ? 1.0 - 0.45 * nearC : 1.0);
    // The arms' own swell: a darker line just outside the foam (the wave's face turned to the
    // eye) and a lighter one on it. Thin and soft near; far off, where the waves can no longer be
    // drawn, it is what carries the V (at least a couple of pixels wide).
    // Seen low across the water from afar the arms are long lines catching the light: a bright
    // crest on the arm with its dark face just outside, kept at least a few pixels wide and as
    // long-lived as the far trail.
    float graze = smoothstep(0.12, 0.5, pxm) * keep;
    float wL = max(0.25 + 0.03 * x, pxW * mix(0.8, 1.3, graze));
    float dO = (ay - yA - wE * 0.6 - wL * 0.6) / wL;
    float dC = (ay - yA) / wL;
    float swA = S * exp(-x / mix(60.0, 110.0, graze)) * exp(-w.age / mix(14.0, 30.0, graze)) * smoothstep(0.5, 3.0, x) * fade;
    // On the side facing the eye the arm opens toward the viewer as a fan of separate parallel
    // crest lines inside it: spaced a few pixels apart down the screen (the foreshortened
    // direction), each broken along its length, fading inward and with age.
    float fan = 0.0;
    if (graze > 0.01 && dot(cameraPosition.xz - q, vec2(w.T.y, -w.T.x)) * w.y > 0.0) {
      float spF = max(0.6 + 0.03 * x, 3.6 * pxm), wFn = max(0.12 + 0.008 * x, 0.75 * pxm);
      for (int n = 1; n <= 4; n++) {
        float fn = float(n);
        float yn = yA - fn * spF;
        float dn = (ay - yn) / wFn;
        float brk = smoothstep(0.3, 0.55, vnoise(vec2(w.odo * 0.08 + fn * 3.7, fn)));
        fan += exp(-dn * dn) * (1.0 - 0.17 * fn) * brk * smoothstep(0.15 * yA, 0.4 * yA, yn);
      }
      fan *= graze * swA * smoothstep(2.0, 8.0, x);
    }
    o.crest = clamp(o.crest - mix(0.9, 1.3, graze) * swA * exp(-dO * dO) + 0.5 * swA * prof * smoothstep(0.05, 0.3, pxm)
                    + 2.4 * graze * swA * exp(-dC * dC * 1.2) + 3.0 * fan + 0.75 * tTone * inV, -1.0, 1.0);  }
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
    // Under throttle the stern settles onto its own wave: a heaped ring of broken white round the
    // transom and its corners, churned by the prop.
    float thr = clamp(uBoatB.z, 0.0, 1.0);
    float ring = thr * (1.0 - smoothstep(0.02, 0.22, tt)) * exp(-max(d, 0.0) / (0.14 + 0.16 * thr)) * smoothstep(-0.12, -0.02, d);
    hf = max(hf, ring * (0.45 + 0.35 * vnoise(vec2(s * 4.0, uTime * 2.0))));
    o.brk = max(o.brk, ring);
    // Laced in the boat's own frame: the hull distance has corners and creases that would draw
    // nested outlines of the hull across the water.
    vec2 cq = vec2(s * 1.6, f + uWakeInfo.y + uTime * 0.3);
    o.foam = max(o.foam, wakeLace(cq, clamp(hf * 1.1, 0.0, 1.0), 11.0, px, 0.0));
    o.contact = (1.0 - smoothstep(0.0, 0.1 + 0.1 * spd, d)) * smoothstep(-0.08, -0.01, d) * sternK * (1.0 - smoothstep(0.1, 0.3, px));
  }
  return o;
}
`;
