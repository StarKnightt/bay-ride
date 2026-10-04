/**
 * Open-bay wind chop, layered on the swell trains of waves.ts.
 *
 * A light onshore sea breeze raises short-crested chop: eight directional wave trains spread
 * around the wind, each with deep-water dispersion (longer waves run faster), broken into short
 * crests by slow envelopes along the crest and a domain warp, so the pattern never repeats. The
 * chop dies out over the shallows (the surf model owns the last few metres of depth), so the
 * shoreline is untouched. The four longest trains also move the mesh and the gameplay height
 * query; the rest only shade the surface, and each one fades out once it is smaller than a few
 * pixels (its lost slope becomes roughness for the glitter).
 */

const G = 9.81;
/** Wind travel direction (x, z): from the open sea toward the beach. */
const WIND_A = Math.atan2(0.28, 0.96);
/** Wavelength (m), direction offset from the wind (deg), steepness k*a, phase. */
const TRAINS: [number, number, number, number][] = [
  [17.0, -16, 0.04, 0.3],
  [11.3, 23, 0.045, 2.1],
  [7.6, -31, 0.05, 4.4],
  [5.1, 9, 0.055, 1.2],
  [3.4, 37, 0.06, 5.6],
  [2.3, -12, 0.06, 3.3],
  [1.55, 28, 0.055, 0.8],
  [1.05, -39, 0.05, 2.7],
];
/** Trains that move the mesh and the height query (the rest are shading only). */
export const CHOP_GEOM = 4;

interface Train { dx: number; dz: number; k: number; a: number; w: number; ph: number; ka: number }
const T: Train[] = TRAINS.map(([L, off, ka, ph]) => {
  const k = (2 * Math.PI) / L;
  const ang = WIND_A + (off * Math.PI) / 180;
  return { dx: Math.cos(ang), dz: Math.sin(ang), k, a: ka / k, w: Math.sqrt(G * k), ph, ka };
});

export const WIND = { x: Math.cos(WIND_A), z: Math.sin(WIND_A) };

const g = (v: number) => v.toFixed(5);

export const OPEN_GLSL = /* glsl */ `
const vec2 O_WIND = vec2(${g(WIND.x)}, ${g(WIND.z)});
const vec4 O_T[8] = vec4[8](${T.map((t) => `vec4(${g(t.dx)}, ${g(t.dz)}, ${g(t.k)}, ${g(t.a)})`).join(", ")});
const vec3 O_P[8] = vec3[8](${T.map((t) => `vec3(${g(t.w)}, ${g(t.ph)}, ${g(t.ka)})`).join(", ")});

/** Open water starts a few metres deep: no chop in the surf zone. */
float oDeep(float h){ return smoothstep(1.5, 8.0, h); }
/** Slow incommensurate warp of the chop's coordinates (no straight endless crests). */
vec2 oWarp(vec2 q){
  return q + 5.0 * vec2(sin(q.y * 0.023 + 1.7) + 0.6 * sin(q.x * 0.041 - q.y * 0.017 + 0.4),
                        sin(q.x * 0.019 + 2.9) + 0.6 * sin(q.y * 0.037 + q.x * 0.013 + 5.1));
}
/** Envelope along the crest of train i: crests come in short segments. */
float oEnv(vec2 q, int i){
  vec4 T = O_T[i];
  float s = dot(q, vec2(-T.y, T.x)) * T.z * 0.11 + O_P[i].y * 3.0;
  return 0.55 + 0.45 * sin(s) * sin(s * 0.37 + dot(q, T.xy) * T.z * 0.05);
}
/** Height of the chop trains that move the mesh (matches chopEta on the CPU). */
float oChopEta(vec2 q, float t){
  vec2 w = oWarp(q);
  float e = 0.0;
  for (int i = 0; i < ${CHOP_GEOM}; i++) {
    vec4 T = O_T[i]; vec3 P = O_P[i];
    e += T.w * oEnv(q, i) * sin(dot(w, T.xy) * T.z - P.x * t + P.y);
  }
  return e;
}
/**
 * Chop slope for shading. gust scales the short trains (wind patches); px = metres per pixel
 * along the view; resVar / lostVar = slope variance drawn / faded out.
 */
vec2 oChopGrad(vec2 q, float t, float px, float gust, out float resVar, out float lostVar){
  vec2 w = oWarp(q);
  vec2 gr = vec2(0.0);
  resVar = 0.0; lostVar = 0.0;
  for (int i = 0; i < 8; i++) {
    vec4 T = O_T[i]; vec3 P = O_P[i];
    float L = 6.2831853 / T.z;
    float lod = 1.0 - smoothstep(0.07 * L, 0.22 * L, px);
    float gk = mix(1.0, gust, smoothstep(2.0, 6.0, float(i)));
    // A train faded out entirely counts with its envelope's mean square (0.594 rms), so the far
    // water skips the envelope.
    if (lod <= 0.0) { float vl = P.z * gk * 0.594; lostVar += 0.5 * vl * vl; continue; }
    float v = P.z * gk * oEnv(q, i);
    lostVar += (1.0 - lod * lod) * 0.5 * v * v;
    resVar += lod * lod * 0.5 * v * v;
    gr += T.xy * (v * lod * cos(dot(w, T.xy) * T.z - P.x * t + P.y));
  }
  return gr;
}
`;

const wx = (x: number, z: number) => x + 5 * (Math.sin(z * 0.023 + 1.7) + 0.6 * Math.sin(x * 0.041 - z * 0.017 + 0.4));
const wz = (x: number, z: number) => z + 5 * (Math.sin(x * 0.019 + 2.9) + 0.6 * Math.sin(z * 0.037 + x * 0.013 + 5.1));

/** CPU mirror of oChopEta: chop height (m) at (x, z), time t, before the depth fade. */
export function chopEta(x: number, z: number, t: number): number {
  const px = wx(x, z), pz = wz(x, z);
  let e = 0;
  for (let i = 0; i < CHOP_GEOM; i++) {
    const r = T[i];
    const s = (-r.dz * x + r.dx * z) * r.k * 0.11 + r.ph * 3;
    const env = 0.55 + 0.45 * Math.sin(s) * Math.sin(s * 0.37 + (r.dx * x + r.dz * z) * r.k * 0.05);
    e += r.a * env * Math.sin((px * r.dx + pz * r.dz) * r.k - r.w * t + r.ph);
  }
  return e;
}

/** CPU mirror of oDeep. */
export function openDeep(h: number): number {
  const k = Math.min(1, Math.max(0, (h - 1.5) / 6.5));
  return k * k * (3 - 2 * k);
}
