import { SEA_Y } from "../world/bay/road";

/**
 * Shoreline wave model, shared by the water surface, the swash on the sand and gameplay queries.
 *
 * Waves are discrete numbered events in two swell trains (a main train and a weaker cross train
 * from another angle). Each wave n of train k leaves the open sea at time `emit(n, k)` and reaches
 * a point after the travel time T(x, z) baked over the seabed (slower in shallow water, so crests
 * bend round to follow the shore). Every wave carries its own height, an alongshore height and
 * timing wobble, its own break point (where its height outgrows the depth), its own foam and its
 * own run-up on the sand. Everything is a pure function of the clock, so a frozen time freezes the
 * whole surf, and the GLSL and TypeScript versions agree.
 */

export const WAVE = {
  /** Deep-water crest speed (m/s); shallower water is slower: sqrt(g h). */
  cDeep: 12,
  /** Mean period (s), and propagation direction (x, z; toward the beach) of each train. */
  period: [7.4, 11.3] as const,
  dir: [norm(0.97, -0.24), norm(0.93, 0.37)] as const,
};

function norm(x: number, z: number): [number, number] {
  const l = Math.hypot(x, z);
  return [x / l, z / l];
}

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** Water-model GLSL. Needs COMMON (vnoise, hash12) and DEPTH_GLSL (uDepthTex, uDepthXf) first. */
export const WAVES_GLSL = /* glsl */ `
const float W_SEA = ${f(SEA_Y)};
const float W_CDEEP = ${f(WAVE.cDeep)};
const vec2 W_DIR0 = vec2(${WAVE.dir[0][0]}, ${WAVE.dir[0][1]});
const vec2 W_DIR1 = vec2(${WAVE.dir[1][0]}, ${WAVE.dir[1][1]});
const float W_P0 = ${f(WAVE.period[0])};
const float W_P1 = ${f(WAVE.period[1])};

uint wIh(uint x){ x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
float wH(int n, int s){ return float(wIh(uint(n + 65536) * 0x9E3779B1u + uint(s) * 0x85EBCA77u) >> 8u) * (1.0 / 16777216.0); }
float wH2(int a, int b, int s){ return float(wIh((uint(a + 65536) * 0x9E3779B1u) ^ wIh(uint(b + 65536) * 0x85EBCA77u + uint(s))) >> 8u) * (1.0 / 16777216.0); }
float wVn(float x, int n, int s){ float i = floor(x); float t = x - i; t = t * t * (3.0 - 2.0 * t); int ii = int(i); return mix(wH2(ii, n, s), wH2(ii + 1, n, s), t); }

/** (seabed y, travel-time offset of train 0, of train 1, rock cover 0..1) at xz. */
vec4 wField(vec2 xz){
  vec2 uv = (xz - uDepthXf.xy) * uDepthXf.z;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(-40.0, 0.0, 0.0, 0.0);
  return texture(uDepthTex, uv);
}
float wPeriod(int k){ return k == 0 ? W_P0 : W_P1; }
vec2 wDir(int k){ return k == 0 ? W_DIR0 : W_DIR1; }
float wTravel(vec2 xz, vec4 F, int k){ return dot(xz, wDir(k)) / W_CDEEP + (k == 0 ? F.g : F.b); }
float wEmit(int n, int k){ float P = wPeriod(k); return float(n) * P + (wH(n, 11 + k) - 0.5) * 0.5 * P; }
/** Deep-water height of wave n: the main train comes in sets of bigger waves. */
float wH0(int n, int k){
  if (k == 0) { float g = 0.5 + 0.5 * sin(float(n) * 0.9666 + 0.4); return 0.28 + 0.5 * g * g + 0.16 * wH(n, 3); }
  return 0.14 + 0.12 * wH(n, 23);
}
float wAlong(vec2 xz){ return xz.y + 0.2 * xz.x; }
/** Alongshore height and arrival-time wobble of one wave (no two crests share a shape). */
float wMod(float along, int n, int k){ return 0.6 + 0.8 * wVn(along / 48.0, n, 31 + k); }
float wWob(float along, int n, int k){ return (wVn(along / 64.0, n, 41 + k) - 0.5) * 1.6; }

/**
 * One wave at a point of water depth h: elevation, d(eta)/d(tau), and its state. tau = seconds
 * since its crest passed (negative: still coming). Before breaking: a swell pulse that steepens
 * (short front, long back) as it shoals. Once its height outgrows ~0.78 h it spills: a bore with
 * a steep foaming front whose height is limited by the depth, fading to nothing at the waterline.
 */
float wOne(int k, int n, float T, float along, float h, float t, out float dEdTau, out float tau, out float beta, out float size){
  float P = wPeriod(k);
  tau = t - wEmit(n, k) - T - wWob(along, n, k);
  size = wH0(n, k) * wMod(along, n, k);
  float hh = max(h, 0.0);
  float Hs = size * pow(10.0 / max(hh, 0.5), 0.25);
  beta = Hs / (0.78 * max(hh, 0.02));
  float brk = smoothstep(0.8, 1.05, beta);
  float H = min(Hs, 0.7 * hh);
  float a = clamp(beta, 0.0, 1.0);
  float wf = P * (0.2 - 0.12 * a), wb = P * (0.3 + 0.12 * a);
  float w = tau < 0.0 ? wf : wb;
  float x = tau / w;
  float g = exp(-2.0 * x * x);
  float dg = -4.0 * x * g / w;
  float fF = 0.05 * P + 0.15, fB = 0.22 * P;
  float bo = tau < 0.0 ? exp(-(tau * tau) / (fF * fF)) : exp(-tau / fB);
  float dbo = tau < 0.0 ? -2.0 * tau / (fF * fF) * bo : -bo / fB;
  dEdTau = H * mix(dg, dbo, brk);
  return H * (mix(g, bo, brk) - 0.1);
}

/** Water elevation above mean sea level (vertex displacement). */
float wEta(vec2 xz, float t){
  vec4 F = wField(xz);
  float h = W_SEA - F.r;
  float along = wAlong(xz);
  float eta = 0.0, d, tau, beta, sz;
  for (int k = 0; k < 2; k++) {
    float T = wTravel(xz, F, k);
    int n0 = int(floor((t - T) / wPeriod(k)));
    for (int i = -2; i <= 1; i++) eta += wOne(k, n0 + i, T, along, h, t, d, tau, beta, sz);
  }
  return eta;
}

/** F2 - F1 of a jittered cell grid: 0 on the cell borders. Feature points sway with ph. */
float wCellEdge(vec2 p, float ph){
  vec2 i = floor(p), fr = fract(p); float d1 = 8.0, d2 = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 hh = vec2(hash12(i + g), hash12(i + g + 17.3));
    vec2 o = 0.5 + 0.42 * sin(ph + 6.2831 * hh);
    vec2 r = g + o - fr; float dd = dot(r, r);
    if (dd < d1) { d2 = d1; d1 = dd; } else if (dd < d2) d2 = dd;
  }
  return sqrt(d2) - sqrt(d1);
}

/**
 * Painted foam lace at density dens (1 = solid white sheet, 0.3 = a web of thin lines, 0 = none).
 * p in metres in the foam's own frame, px = metres per pixel (far away it melts to its coverage).
 */
float wLace(vec2 p, float dens, float seed, float px){
  if (dens < 0.02) return 0.0;
  float far = smoothstep(0.12, 0.45, px);
  float th = dens * (0.1 + 0.5 * dens);
  float cov = min(th * 2.2, 1.0);
  if (far > 0.99) return cov;
  vec2 q = p + vec2(seed * 13.7, seed * 5.3);
  q += (vec2(vnoise(q * 0.5), vnoise(q * 0.5 + 7.0)) - 0.5) * 1.4;
  float e1 = wCellEdge(q * 1.5, seed);
  float e2 = wCellEdge(q * 3.6 + 3.0, seed * 2.0);
  float e = min(e1, e2 * 0.8 + 0.05);
  float aa = 0.02 + px * 2.5;
  float l = 1.0 - smoothstep(th - aa, th + aa, e);
  return mix(l, cov, far);
}

struct WSurf {
  float eta;      // elevation above mean sea level
  vec2 grad;      // d(eta)/dx, d(eta)/dz
  float foam;     // foam cover 0..1 (lace applied)
  float crest;    // unbroken crest height share 0..1 (light through the wave lip)
  float brk;      // how broken the surf is here
  float h;        // still-water depth
  float rock;     // rock cover from the field
};

/** Full surface state for shading (gradient, foam lace per wave). */
WSurf wSurface(vec2 xz, float t, float px){
  WSurf s;
  vec4 F = wField(xz);
  const float e = 1.2;
  vec4 Fx0 = wField(xz - vec2(e, 0.0)), Fx1 = wField(xz + vec2(e, 0.0));
  vec4 Fz0 = wField(xz - vec2(0.0, e)), Fz1 = wField(xz + vec2(0.0, e));
  vec2 gA = vec2(Fx1.g - Fx0.g, Fz1.g - Fz0.g) / (2.0 * e);
  vec2 gB = vec2(Fx1.b - Fx0.b, Fz1.b - Fz0.b) / (2.0 * e);
  float h = W_SEA - F.r;
  s.h = h; s.rock = F.a;
  float along = wAlong(xz);
  s.eta = 0.0; s.grad = vec2(0.0); s.foam = 0.0; s.crest = 0.0; s.brk = 0.0;
  for (int k = 0; k < 2; k++) {
    float T = wTravel(xz, F, k);
    vec2 gT = wDir(k) / W_CDEEP + (k == 0 ? gA : gB);
    int n0 = int(floor((t - T) / wPeriod(k)));
    for (int i = -2; i <= 1; i++) {
      int n = n0 + i;
      float dE, tau, beta, sz;
      s.eta += wOne(k, n, T, along, h, t, dE, tau, beta, sz);
      s.grad -= dE * gT;
      float brk = smoothstep(0.8, 1.05, beta);
      s.brk = max(s.brk, brk * exp(-max(tau, 0.0) / 3.0) * step(-0.5, tau));
      // Light through the lip of a steep unbroken crest.
      s.crest = max(s.crest, smoothstep(0.45, 0.85, beta) * (1.0 - brk) * exp(-pow((tau + 0.15) / 0.45, 2.0)) * smoothstep(0.08, 0.3, sz));
      // Foam that belongs to this wave: the crest whitens as it starts to spill, then a foam band
      // rides the bore, thinning to lace behind it.
      float onset = smoothstep(0.72, 1.0, beta);
      float crestF = onset * exp(-pow((tau - 0.05) / 0.38, 2.0));
      float bore = brk * (tau > -0.08 ? exp(-max(tau, 0.0) / 1.1) : exp(-pow((tau + 0.08) / 0.1, 2.0)));
      float resid = brk * step(0.0, tau) * 0.3 * exp(-tau / 4.0);
      float dens = max(crestF * 0.95, max(bore, resid)) * smoothstep(0.06, 0.22, sz) * smoothstep(-0.05, 0.12, h);
      if (dens > 0.02) {
        vec2 fp = vec2(along * 0.9, tau * 2.4 + along * 0.05);
        s.foam = max(s.foam, wLace(fp, dens, float((n + 65536) % 97) + float(k) * 0.37, px));
      }
    }
  }
  return s;
}

/**
 * Swash on the beach at a sand point zs metres above mean sea level: each arriving bore turns into
 * a thin sheet that runs up the slope, slows, stops at its own run-up height and slides back down
 * faster and thinner. Where it has been, the sand stays dark and glossy and slowly dries.
 */
struct WSwash {
  float cover;  // water film present 0..1
  float film;   // film thickness (m)
  float foam;   // lace cover 0..1
  float wet;    // sand wetness 0..1 (memory of recent run-ups)
  float sheen;  // glossy film left behind 0..1
};

WSwash wSwash(vec2 xz, float zs, float t, float px){
  WSwash o;
  o.cover = 0.0; o.film = 0.0; o.foam = 0.0; o.wet = 0.0; o.sheen = 0.0;
  vec4 F = wField(xz);
  float along = wAlong(xz);
  // Lobed edge: the sheet runs up in tongues and cusps, never a ruled line.
  float lobe = (vnoise(xz * vec2(0.3, 0.42)) - 0.5) * 0.05 + (vnoise(xz * 1.5 + 5.0) - 0.5) * 0.016;
  for (int k = 0; k < 2; k++) {
    float T = wTravel(xz, F, k);
    float P = wPeriod(k);
    int n0 = int(floor((t - T) / P)) + 1;
    int cnt = k == 0 ? 7 : 4;
    for (int i = 0; i < 7; i++) {
      if (i >= cnt) break;
      int n = n0 - i;
      float tau = t - wEmit(n, k) - T - wWob(along, n, k);
      if (tau < 0.0) continue;
      float A = wH0(n, k) * wMod(along, n, k);
      float R = 0.07 + 0.6 * A;
      float z = zs + lobe * (0.5 + R) + (wVn(along / 7.0, n, 61 + k) - 0.5) * 0.06 * R;
      if (z > R) continue;
      float Tu = 1.3 + 3.0 * R, Td = 0.72 * Tu;
      float zr = clamp(z / R, 0.0, 1.0);
      float tReach = z <= 0.0 ? 0.0 : Tu * (1.0 - sqrt(1.0 - zr));
      float tLeave = Tu + Td * pow(1.0 - zr, 1.0 / 1.4);
      bool up = tau < Tu;
      float zf = up ? R * (1.0 - (1.0 - tau / Tu) * (1.0 - tau / Tu)) : R * (1.0 - pow(min((tau - Tu) / Td, 1.0), 1.4));
      if (tau >= tReach && tau < tLeave) {
        o.cover = 1.0;
        float ez = max(zf - z, 0.0);
        o.film = max(o.film, ez * (up ? 0.3 : 0.16));
        float d = up ? max(exp(-ez / 0.015), 0.32 * exp(-ez / 0.05)) : 0.5 * exp(-(tau - Tu) / 1.3) * (0.4 + 0.6 * exp(-ez / 0.06));
        d *= smoothstep(0.03, 0.15, A);
        vec2 fp = vec2(along * 0.9, up ? ez * 13.0 + float(n) * 2.7 : (R - z) * 13.0 + float(n) * 2.7);
        o.foam = max(o.foam, wLace(fp, d, float((n + 65536) % 89) + float(k) * 0.61, px));
        o.wet = 1.0; o.sheen = 1.0;
      } else if (tau >= tLeave) {
        float age = tau - tLeave;
        o.wet = max(o.wet, exp(-age / 24.0));
        o.sheen = max(o.sheen, exp(-age / 2.4));
        // The run-up leaves a thin stranded foam line at its highest reach for a moment.
        float line = 0.55 * exp(-pow((z - R * 0.96) / 0.007, 2.0)) * exp(-(tau - Tu) / 2.2) * smoothstep(0.1, 0.25, A);
        o.foam = max(o.foam, line * smoothstep(0.42, 0.62, wVn(along / 1.6, n, 71)));
      }
    }
  }
  // Below the mean waterline the sand is always under water or freshly drained.
  float under = smoothstep(0.03, -0.03, zs);
  o.cover = max(o.cover, under);
  o.wet = max(o.wet, smoothstep(0.1, -0.02, zs));
  o.sheen = max(o.sheen, under);
  return o;
}
`;

// ------------------------------------------------------------------ CPU mirror (gameplay queries)

function ih(x: number): number {
  x >>>= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}
function hw(n: number, s: number): number {
  return (ih((Math.imul(n + 65536, 0x9e3779b1) + Math.imul(s, 0x85ebca77)) >>> 0) >>> 8) / 16777216;
}
function hw2(a: number, b: number, s: number): number {
  const inner = ih((Math.imul(b + 65536, 0x85ebca77) + s) >>> 0);
  return (ih((Math.imul(a + 65536, 0x9e3779b1) ^ inner) >>> 0) >>> 8) / 16777216;
}
function vn(x: number, n: number, s: number): number {
  const i = Math.floor(x);
  let t = x - i;
  t = t * t * (3 - 2 * t);
  return hw2(i, n, s) + (hw2(i + 1, n, s) - hw2(i, n, s)) * t;
}
const period = (k: number) => WAVE.period[k];
const emit = (n: number, k: number) => n * period(k) + (hw(n, 11 + k) - 0.5) * 0.5 * period(k);
function h0(n: number, k: number): number {
  if (k === 0) {
    const g = 0.5 + 0.5 * Math.sin(n * 0.9666 + 0.4);
    return 0.28 + 0.5 * g * g + 0.16 * hw(n, 3);
  }
  return 0.14 + 0.12 * hw(n, 23);
}
const along = (x: number, z: number) => z + 0.2 * x;
const wmod = (a: number, n: number, k: number) => 0.6 + 0.8 * vn(a / 48, n, 31 + k);
const wob = (a: number, n: number, k: number) => (vn(a / 64, n, 41 + k) - 0.5) * 1.6;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Field sampler: (seabed y, travel-time offset 0, offset 1, rock). Set by the depth bake. */
export type FieldSampler = (x: number, z: number, out: Float32Array) => Float32Array;
let sampleField: FieldSampler | null = null;
export function setFieldSampler(fn: FieldSampler): void {
  sampleField = fn;
}
const F = new Float32Array(4);

function travel(x: number, z: number, k: number): number {
  const d = WAVE.dir[k];
  return (x * d[0] + z * d[1]) / WAVE.cDeep + (k === 0 ? F[1] : F[2]);
}

function one(k: number, n: number, T: number, a: number, h: number, t: number): number {
  const P = period(k);
  const tau = t - emit(n, k) - T - wob(a, n, k);
  const size = h0(n, k) * wmod(a, n, k);
  const hh = Math.max(h, 0);
  const Hs = size * Math.pow(10 / Math.max(hh, 0.5), 0.25);
  const beta = Hs / (0.78 * Math.max(hh, 0.02));
  const brk = smooth(0.8, 1.05, beta);
  const H = Math.min(Hs, 0.7 * hh);
  const al = Math.min(1, Math.max(0, beta));
  const w = tau < 0 ? P * (0.2 - 0.12 * al) : P * (0.3 + 0.12 * al);
  const x = tau / w;
  const g = Math.exp(-2 * x * x);
  const fF = 0.05 * P + 0.15, fB = 0.22 * P;
  const bo = tau < 0 ? Math.exp(-(tau * tau) / (fF * fF)) : Math.exp(-tau / fB);
  return H * (g + (bo - g) * brk - 0.1);
}

/** Water elevation above mean sea level at (x, z), time t (same maths as the shader). */
export function waveEta(x: number, z: number, t: number): number {
  if (!sampleField) return 0;
  sampleField(x, z, F);
  const h = SEA_Y - F[0];
  const a = along(x, z);
  let eta = 0;
  for (let k = 0; k < 2; k++) {
    const T = travel(x, z, k);
    const n0 = Math.floor((t - T) / period(k));
    for (let i = -2; i <= 1; i++) eta += one(k, n0 + i, T, a, h, t);
  }
  return eta;
}

export interface WaterAt {
  /** Water surface height (world y), or NaN where the ground is dry. */
  y: number;
  /** Water depth over the ground (m), 0 when dry. */
  depth: number;
  /** 0…1 how wet the sand is (beach only; 1 under water). */
  wet: number;
}

/**
 * Water at (x, z) for gameplay (rider ripples and footprints, boat, buoys): the sea surface offshore,
 * or the swash sheet on the beach. `ground` = ground height there.
 */
export function waterAt(x: number, z: number, t: number, ground: number, out: WaterAt = { y: NaN, depth: 0, wet: 0 }): WaterAt {
  const sea = SEA_Y + waveEta(x, z, t);
  if (ground < sea - 0.002) {
    out.y = sea;
    out.depth = sea - ground;
    out.wet = 1;
    return out;
  }
  // On the sand: the swash sheet (no lobes: a gameplay-grade version of the shader's front).
  const zs = ground - SEA_Y;
  const a = along(x, z);
  let film = 0, wet = zs < 0.1 ? 1 : 0;
  for (let k = 0; k < 2; k++) {
    const T = travel(x, z, k);
    const n0 = Math.floor((t - T) / period(k)) + 1;
    for (let i = 0; i < (k === 0 ? 7 : 4); i++) {
      const n = n0 - i;
      const tau = t - emit(n, k) - T - wob(a, n, k);
      if (tau < 0) continue;
      const A = h0(n, k) * wmod(a, n, k);
      const R = 0.07 + 0.6 * A;
      if (zs > R) continue;
      const Tu = 1.3 + 3 * R, Td = 0.72 * Tu;
      const zr = Math.min(1, Math.max(0, zs / R));
      const tReach = zs <= 0 ? 0 : Tu * (1 - Math.sqrt(1 - zr));
      const tLeave = Tu + Td * Math.pow(1 - zr, 1 / 1.4);
      const up = tau < Tu;
      const zf = up ? R * (1 - (1 - tau / Tu) ** 2) : R * (1 - Math.pow(Math.min((tau - Tu) / Td, 1), 1.4));
      if (tau >= tReach && tau < tLeave) {
        film = Math.max(film, Math.max(zf - zs, 0) * (up ? 0.3 : 0.16), 0.004);
        wet = 1;
      } else if (tau >= tLeave) wet = Math.max(wet, Math.exp(-(tau - tLeave) / 16));
    }
  }
  out.y = film > 0 ? ground + film : NaN;
  out.depth = film;
  out.wet = wet;
  return out;
}

/**
 * Shore events near a listener, for syncing sound or effects: "break" when a main-train wave starts
 * spilling offshore of the listener, "runup" when its swash starts up the sand. Dispatched on
 * window as CustomEvent("shorewave", { detail: { kind, size, wave, x, z } }).
 */
export class ShoreEvents {
  private last = Number.NaN;

  update(t: number, shoreX: number, shoreZ: number): void {
    if (!sampleField) return;
    const prev = this.last;
    this.last = t;
    if (!(t > prev) || t - prev > 1) return;
    // The waterline point and a point ~12 m out, where the main train usually breaks.
    const d = WAVE.dir[0];
    const bx = shoreX - d[0] * 12, bz = shoreZ - d[1] * 12;
    for (const [kind, x, z] of [["break", bx, bz], ["runup", shoreX, shoreZ]] as const) {
      sampleField(x, z, F);
      const a = along(x, z);
      const T = travel(x, z, 0);
      const n0 = Math.floor((t - T) / period(0));
      for (let n = n0 - 1; n <= n0 + 1; n++) {
        const at = emit(n, 0) + T + wob(a, n, 0);
        if (at > prev && at <= t) {
          const size = h0(n, 0) * wmod(a, n, 0);
          window.dispatchEvent(new CustomEvent("shorewave", { detail: { kind, size, wave: n, x, z } }));
        }
      }
    }
  }
}
