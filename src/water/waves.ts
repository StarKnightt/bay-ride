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
/**
 * The field with a smooth cubic B-spline filter (four bilinear taps): arrival-time contours on the
 * flat swash slope must not show the texel grid.
 */
vec4 wFieldS(vec2 xz){
  vec2 uv = (xz - uDepthXf.xy) * uDepthXf.z;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec4(-40.0, 0.0, 0.0, 0.0);
  vec2 ts = vec2(textureSize(uDepthTex, 0));
  vec2 st = uv * ts - 0.5;
  vec2 i = floor(st), fr = st - i;
  vec2 fr2 = fr * fr, fr3 = fr2 * fr;
  vec2 w0 = (1.0 - 3.0 * fr + 3.0 * fr2 - fr3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * fr2 + 3.0 * fr3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * fr + 3.0 * fr2 - 3.0 * fr3) / 6.0;
  vec2 w3 = fr3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 0.5 + w1 / g0) / ts, h1 = (i + 1.5 + w3 / g1) / ts;
  return (texture(uDepthTex, vec2(h0.x, h0.y)) * g0.x + texture(uDepthTex, vec2(h1.x, h0.y)) * g1.x) * g0.y
       + (texture(uDepthTex, vec2(h0.x, h1.y)) * g0.x + texture(uDepthTex, vec2(h1.x, h1.y)) * g1.x) * g1.y;
}
float wPeriod(int k){ return k == 0 ? W_P0 : W_P1; }
vec2 wDir(int k){ return k == 0 ? W_DIR0 : W_DIR1; }
float wTravel(vec2 xz, vec4 F, int k){ return dot(xz, wDir(k)) / W_CDEEP + (k == 0 ? F.g : F.b); }
float wEmit(int n, int k){ float P = wPeriod(k); return float(n) * P + (wH(n, 11 + k) - 0.5) * 0.5 * P; }
/** Deep-water height of wave n: the main train comes in sets (two or three big waves, then a lull, ~30 s). */
float wH0(int n, int k){
  if (k == 0) { float g = 0.5 + 0.5 * sin(float(n) * 1.62 + 0.4); return 0.16 + 0.78 * g * g + 0.12 * wH(n, 3); }
  return 0.1 + 0.1 * wH(n, 23);
}
float wAlong(vec2 xz){ return xz.y + 0.2 * xz.x; }
/** Alongshore height and arrival-time wobble of one wave (peaks and low sections, no two crests alike). */
float wMod(float along, int n, int k){ return (0.3 + 0.95 * wVn(along / 42.0, n, 31 + k)) * (0.7 + 0.6 * wVn(along / 13.0, n, 33 + k)); }
float wWob(float along, int n, int k){ return (wVn(along / 64.0, n, 41 + k) - 0.5) * 1.6; }
/** Per-section readiness to break: some stretches of a crest spill early, others stay green. */
float wBrkVar(float along, int n, int k){ float v = wVn(along / 21.0, n, 51 + k); return 0.6 + 0.85 * v * v * (3.0 - 2.0 * v); }

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
  beta = Hs / (0.78 * max(hh, 0.02)) * wBrkVar(along, n, k);
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

/** Distance to the nearest bubble centre, in units of that bubble's own size (sizes vary). */
float wBub(vec2 p, float ph){
  vec2 i = floor(p), fr = fract(p); float d = 8.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 g = vec2(float(x), float(y));
    vec2 hh = vec2(hash12(i + g), hash12(i + g + 17.3));
    vec2 o = 0.5 + 0.4 * sin(ph + 6.2831 * hh);
    float rad = 0.55 + 0.45 * hash12(i + g + 41.7);
    d = min(d, length(g + o - fr) / rad);
  }
  return d;
}

/**
 * Painted foam lace at density dens (1 = nearly solid white, 0.4 = open lace with holes and clumps,
 * 0.1 = scattered scraps, 0 = none). It is foam with bubble holes punched in it: the holes grow as
 * the foam thins, so the strands break into scraps instead of forming a closed net. p in metres in
 * the foam's own (advected) frame; px = metres per pixel (far away it melts to its coverage).
 */
float wLace(vec2 p, float dens, float seed, float px){
  if (dens < 0.02) return 0.0;
  // Bubble cells ~0.4 m with finer holes inside; the edge softness follows the pixel footprint.
  const float F1 = 2.4, F2 = 5.5;
  float far = smoothstep(0.25, 0.7, px * F1);
  float cov = pow(clamp(dens, 0.0, 1.0), 1.4) * 0.85;
  if (far > 0.99) return cov;
  vec2 q = p + vec2(seed * 13.7, seed * 5.3);
  q += (vec2(vnoise(q * 0.45), vnoise(q * 0.45 + 7.0)) - 0.5) * 1.8 + (vec2(vnoise(q * 1.7 + 3.0), vnoise(q * 1.7 + 9.0)) - 0.5) * 0.35;
  // Clumps and open gaps.
  float d = clamp(dens * (0.45 + 1.1 * vnoise(q * 0.23 + 11.0)), 0.0, 1.0);
  float aa = 0.06 + px * F1 * 1.4;
  float r1 = mix(0.95, 0.15, d);
  float b1 = wBub(q * F1, seed);
  float f1 = smoothstep(r1 - aa, r1 + aa, b1);
  float r2 = mix(0.9, 0.2, d);
  float f2 = smoothstep(r2 - aa * 2.0, r2 + aa * 2.0, wBub(q * F2 + 3.0, seed * 2.0));
  float l = f1 * mix(1.0, f2, 0.5);
  // Thick and thin strokes: a soft second pass thickens some strands.
  l = max(l, 0.6 * smoothstep(r1 - 0.25 - aa, r1 - 0.25 + aa, b1) * smoothstep(0.55, 0.75, vnoise(q * 1.6 + 2.0)) * d);
  return mix(l, cov, far);
}

/** Water colour kept cool: warm presets only tint it, never turn it khaki. */
vec3 wCool(vec3 c){
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, l * vec3(0.62, 1.06, 1.04), smoothstep(-0.05, 0.1, c.r - c.b) * 0.75);
}

/**
 * Foam colour: near-white tinted by the key light (warm white-gold at low sun). At night it is only
 * a little lighter than the water under it, brighter just inside the moon's glitter path.
 */
vec3 wFoamColor(vec3 N, vec2 q, vec3 under, float glintPath){
  // Lit foam is the brightest thing on the water: near-white with only a hint of the key's hue.
  vec3 hue = uSunColor / max(max(uSunColor.r, max(uSunColor.g, uSunColor.b)), 0.05);
  vec3 key = mix(vec3(1.0), hue, 0.3);
  float ft = smoothstep(-0.45, 0.2, dot(N, uSunDir) + 0.25 * (vnoise(q * 1.7) - 0.5));
  vec3 lit = key * 0.96 + uSkyMid * 0.04;
  vec3 sh = mix(mix(uShadowTint, uSkyMid, 0.4), key, 0.35) * 0.82;
  float lum = dot(uSunColor, vec3(0.2126, 0.7152, 0.0722));
  vec3 day = mix(sh, lit, ft) * mix(1.0, clamp(lum, 0.0, 1.0), uNight);
  vec3 nite = under * 1.3 + uSunColor * 0.05 + uGlintCol * uGlint * glintPath * 0.5;
  return mix(day, nite, uNight * 0.85);
}

struct WSurf {
  float eta;      // elevation above mean sea level
  vec2 grad;      // d(eta)/dx, d(eta)/dz
  float foam;     // foam cover 0..1 (lace applied)
  float crest;    // unbroken crest height share 0..1 (light through the wave lip)
  float brk;      // how broken the surf is here
  float h;        // still-water depth
  float rock;     // rock cover from the field
  float swell;    // unbroken swell crest line (-1 trough .. 1 crest), for painted crest highlights
  float pulse;    // a crest has just passed (0..1): drives foam bursts on rocks and shores
  vec2 dir;       // local wave travel direction (refracted)
};

/** Full surface state for shading (gradient, foam lace per wave). */
WSurf wSurface(vec2 xz, float t, float px){
  WSurf s;
  vec4 F = wFieldS(xz);
  const float e = 1.2;
  vec4 Fx0 = wField(xz - vec2(e, 0.0)), Fx1 = wField(xz + vec2(e, 0.0));
  vec4 Fz0 = wField(xz - vec2(0.0, e)), Fz1 = wField(xz + vec2(0.0, e));
  vec2 gA = vec2(Fx1.g - Fx0.g, Fz1.g - Fz0.g) / (2.0 * e);
  vec2 gB = vec2(Fx1.b - Fx0.b, Fz1.b - Fz0.b) / (2.0 * e);
  float h = W_SEA - F.r;
  s.h = h; s.rock = F.a;
  float along = wAlong(xz);
  s.eta = 0.0; s.grad = vec2(0.0); s.foam = 0.0; s.crest = 0.0; s.brk = 0.0; s.swell = 0.0; s.pulse = 0.0;
  vec2 g0 = wDir(0) / W_CDEEP + gA;
  s.dir = normalize(g0 + 1e-6);
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
      // Painted swell lines: light crests, darker troughs ahead of them.
      float sw = smoothstep(0.08, 0.45, sz) * (1.0 - brk);
      s.swell += sw * (exp(-pow(tau / 0.9, 2.0)) - 0.45 * exp(-pow((tau + 2.2) / 1.3, 2.0)));
      s.pulse = max(s.pulse, smoothstep(0.1, 0.5, sz) * smoothstep(-0.6, 0.0, tau) * exp(-max(tau, 0.0) / 2.2));
      // Foam that belongs to this wave: the crest whitens where its section starts to spill, then a
      // foam band rides the bore, opening into lace and scraps behind it.
      float onset = smoothstep(0.72, 1.0, beta);
      float crestF = onset * exp(-pow((tau - 0.05) / 0.38, 2.0));
      float bore = brk * (tau > -0.08 ? exp(-max(tau, 0.0) / 1.1) : exp(-pow((tau + 0.08) / 0.1, 2.0)));
      float resid = brk * step(0.0, tau) * 0.32 * exp(-tau / 4.0);
      float dens = max(crestF * 0.95, max(bore, resid)) * smoothstep(0.06, 0.22, sz) * smoothstep(-0.05, 0.12, h);
      if (dens > 0.02) {
        vec2 fp = vec2(along * 0.9, tau * 2.4 + along * 0.05);
        s.foam = max(s.foam, wLace(fp, dens, float((n + 65536) % 97) + float(k) * 0.37, px));
      }
    }
  }
  s.swell = clamp(s.swell, -1.0, 1.0);
  return s;
}

/**
 * Swash on the beach at a sand point zs metres above mean sea level: each arriving bore turns into
 * a thin sheet that runs up the slope in tongues, slows, stops at its own run-up height, then thins
 * and drains back over a few seconds. Where it has been, the sand stays dark and glossy and slowly
 * dries; each run-up leaves a faint high-water line.
 */
struct WSwash {
  float cover;  // water film present 0..1
  float film;   // film thickness (m)
  float foam;   // lace cover 0..1
  float wet;    // fresh wetness 0..1 (dark, dries in ~10 s)
  float mem;    // longer damp memory of recent run-ups 0..1
  float sheen;  // glossy film left behind 0..1
  float line;   // high-water line 0..1
};

WSwash wSwash(vec2 xz, float zs, float t, float px){
  WSwash o;
  o.cover = 0.0; o.film = 0.0; o.foam = 0.0; o.wet = 0.0; o.mem = 0.0; o.sheen = 0.0; o.line = 0.0;
  vec4 F = wFieldS(xz);
  float along = wAlong(xz);
  // Frothy, never-straight outline (vertical metres; the swash slope rises ~4.5 cm per metre).
  float lobeF = (vnoise(xz * vec2(1.6, 2.2) + 3.0) - 0.5) * 0.012 + (vnoise(xz * 5.0) - 0.5) * 0.004;
  float ew = 0.004 + px * 0.03;
  for (int k = 0; k < 2; k++) {
    float T = wTravel(xz, F, k);
    float P = wPeriod(k);
    int n0 = int(floor((t - T) / P)) + 1;
    int cnt = k == 0 ? 8 : 5;
    for (int i = 0; i < 8; i++) {
      if (i >= cnt) break;
      int n = n0 - i;
      float tau = t - wEmit(n, k) - T - wWob(along, n, k);
      if (tau < 0.0) continue;
      float A = wH0(n, k) * wMod(along, n, k);
      float R = (0.02 + 0.13 * A) * (0.65 + 0.7 * wVn(along / 7.0, n, 61 + k));
      // Tongues and cusps: the sheet runs further in some places than others.
      float z = zs - ((wVn(along / 3.2, n, 63 + k) - 0.5) * 0.55 + (wVn(along / 9.0, n, 65 + k) - 0.5) * 0.4) * R - lobeF;
      if (z > R + 0.02) continue;
      float Tu = 1.8 + 6.0 * R, Td = 1.6 * Tu;
      float zr = clamp(z / R, 0.0, 1.0);
      float tLeave = Tu + Td * pow(1.0 - zr, 1.0 / 1.6);
      float sb = clamp((tau - Tu) / Td, 0.0, 1.0);
      bool up = tau < Tu;
      float zf = up ? R * (1.0 - (1.0 - tau / Tu) * (1.0 - tau / Tu)) : R * (1.0 - pow(sb, 1.6));
      float ez = zf - z;
      float seed = float((n + 65536) % 89) + float(k) * 0.61;
      if (ez > -ew && tau < Tu + Td) {
        float cov = smoothstep(-ew, ew, ez) * (up ? 1.0 : 1.0 - 0.35 * sb);
        o.cover = max(o.cover, cov);
        o.film = max(o.film, clamp(ez, 0.0, 0.25) * 0.22 * (up ? 1.0 : 1.0 - 0.75 * sb) * cov);
        // Foam: a bubbly front of varying width, lace behind it, scraps sliding back down.
        float fw = 0.01 + 0.03 * vnoise(vec2(along * 0.35, float(n) * 3.1));
        float ezp = max(ez, 0.0);
        float clump = 0.45 + 0.75 * vnoise(vec2(along * 0.55 + float(n) * 1.7, ezp * 9.0));
        float d = up ? max(0.95 * clump * exp(-ezp / fw), 0.5 * exp(-ezp / 0.06)) * (1.0 - 0.35 * tau / Tu)
                     : 0.55 * exp(-sb * 1.5) * (0.55 + 0.45 * exp(-ezp / 0.03));
        d *= smoothstep(-ew, 0.5 * ew, ez) * smoothstep(0.04, 0.2, A);
        // The lace moves with the water: up with the sheet, back down with the backwash.
        vec2 fp = vec2(along, (z - 0.8 * zf) / 0.045);
        o.foam = max(o.foam, wLace(fp, d, seed, px));
        o.wet = max(o.wet, cov); o.sheen = max(o.sheen, cov);
      } else if (tau >= tLeave) {
        float age = tau - tLeave;
        // Soft top edge: the damp fades out over the last few centimetres of the run-up.
        float top = smoothstep(R + 0.012, R - 0.006, z);
        o.wet = max(o.wet, exp(-age / 9.0) * top);
        o.mem = max(o.mem, exp(-age / 45.0) * top);
        o.sheen = max(o.sheen, exp(-age / 5.5) * top);
        // High-water line at this run-up's top: a thin damp edge with a few stranded foam flecks
        // (both melt away with distance instead of aliasing into a dotted line).
        float near = 1.0 - smoothstep(0.04, 0.16, px);
        float hw = exp(-pow((z - R) / 0.008, 2.0));
        o.line = max(o.line, hw * exp(-age / 40.0) * near);
        float hf = exp(-pow((z - R) / 0.004, 2.0)) * 0.55 * exp(-age / 6.0) * smoothstep(0.35, 0.6, wVn(along / 1.3, n, 71)) * smoothstep(0.08, 0.25, A) * near;
        if (hf > 0.02) o.foam = max(o.foam, wLace(vec2(along, z / 0.045), hf, seed + 0.5, px));
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
    const g = 0.5 + 0.5 * Math.sin(n * 1.62 + 0.4);
    return 0.16 + 0.78 * g * g + 0.12 * hw(n, 3);
  }
  return 0.1 + 0.1 * hw(n, 23);
}
const along = (x: number, z: number) => z + 0.2 * x;
const wmod = (a: number, n: number, k: number) => (0.3 + 0.95 * vn(a / 42, n, 31 + k)) * (0.7 + 0.6 * vn(a / 13, n, 33 + k));
const brkVar = (a: number, n: number, k: number) => {
  const v = vn(a / 21, n, 51 + k);
  return 0.6 + 0.85 * v * v * (3 - 2 * v);
};
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
  const beta = (Hs / (0.78 * Math.max(hh, 0.02))) * brkVar(a, n, k);
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

/** Water elevation above mean sea level at (x, z), time t (as the surf band mesh: flat at the shore). */
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
  return eta * smooth(0, 0.8, h);
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
    for (let i = 0; i < (k === 0 ? 8 : 5); i++) {
      const n = n0 - i;
      const tau = t - emit(n, k) - T - wob(a, n, k);
      if (tau < 0) continue;
      const A = h0(n, k) * wmod(a, n, k);
      const R = (0.02 + 0.13 * A) * (0.65 + 0.7 * vn(a / 7, n, 61 + k));
      const z = zs - ((vn(a / 3.2, n, 63 + k) - 0.5) * 0.55 + (vn(a / 9, n, 65 + k) - 0.5) * 0.4) * R;
      if (z > R) continue;
      const Tu = 1.8 + 6 * R, Td = 1.6 * Tu;
      const zr = Math.min(1, Math.max(0, z / R));
      const tLeave = Tu + Td * Math.pow(1 - zr, 1 / 1.6);
      const sb = Math.min(1, Math.max(0, (tau - Tu) / Td));
      const up = tau < Tu;
      const zf = up ? R * (1 - (1 - tau / Tu) ** 2) : R * (1 - Math.pow(sb, 1.6));
      const ez = zf - z;
      if (ez > 0 && tau < Tu + Td) {
        film = Math.max(film, Math.min(ez, 0.25) * 0.22 * (up ? 1 : 1 - 0.75 * sb), 0.003);
        wet = 1;
      } else if (tau >= tLeave) wet = Math.max(wet, Math.exp(-(tau - tLeave) / 9));
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
