import * as THREE from "three";
import { COMMON, G, OUT, SKIN_VS } from "../render/materials";
import { M } from "../world/geo";
import { V } from "./rig";
import { SKIN, part, smooth, table, type Geo } from "./body";
import type { WeightFn } from "./rig";

/**
 * Her head: a sculpted oval (a slightly long, adult face, soft cheekbones, a clean jaw tapering to
 * a small chin, a refined nose) carried by the head bone. The face is painted in its own shader
 * in face-plane coordinates: almond eyes with luminous blue irises, a dark limbal ring, catch
 * lights, a winged upper lash line, lower lashes and a lid crease; slim brows; a small nose shade;
 * soft coral lips; blush. Every stroke is filtered by its pixel footprint, so it is crisp up close
 * and settles into clean shapes at gameplay distance.
 */

/** Head centre in the bind pose (walker space). Face-plane coordinates are relative to it. */
export const HEAD_C = V(0, 1.56, 0.0);

/** Cross-sections (y from the centre): half-width, front depth, back depth. */
const HEADT: number[][] = [
  [-0.104, 0.0, 0.064, -0.042],
  [-0.1, 0.021, 0.07, -0.036],
  [-0.093, 0.032, 0.076, -0.02],
  [-0.084, 0.042, 0.081, 0.004],
  [-0.073, 0.05, 0.084, 0.03],
  [-0.061, 0.0565, 0.086, 0.055],
  [-0.048, 0.061, 0.087, 0.075],
  [-0.033, 0.0685, 0.088, 0.089],
  [-0.014, 0.0712, 0.089, 0.097],
  [0.01, 0.0725, 0.0885, 0.1005],
  [0.04, 0.0715, 0.086, 0.1],
  [0.07, 0.065, 0.078, 0.092],
  [0.095, 0.052, 0.062, 0.074],
  [0.112, 0.036, 0.042, 0.052],
  [0.122, 0.0, 0.0, 0.0],
];
const TOP = 0.122, CHIN = -0.104;
const _h = [0, 0, 0];
function inHead(x: number, y: number, z: number): boolean {
  if (y > TOP || y < CHIN) return false;
  const [W, F, B] = table(HEADT, y, _h);
  if (W <= 1e-5 || F + B <= 1e-5) return false;
  const D = (F + B) / 2;
  const v = (z - (B - F) / 2) / D, u = Math.abs(x) / W;
  // Front: a flatter face plate above, a V-taper toward the chin below (clean jaw line).
  const pf = y > -0.03 ? 2.45 : 2.45 - 0.55 * smooth(-0.03, -0.098, y);
  const p = v < 0 ? pf : 2.15;
  return Math.pow(u, p) + v * v < 1;
}
/** Soft sculpted features (radial offsets): nose bridge and tip, lips, cheekbones, brow ridge. */
function bumps(d: THREE.Vector3, r: number): number {
  if (d.z > -0.2) return 0;
  const x = d.x * r, y = d.y * r;
  let b = 0;
  // Nose: a narrow bridge from between the eyes to a small rounded tip.
  b += 0.0068 * Math.exp(-((x / 0.0068) ** 2) - ((y + 0.04) / 0.0085) ** 2);
  b += 0.0024 * Math.exp(-((x / 0.0055) ** 2)) * smooth(-0.004, -0.034, y) * smooth(-0.048, -0.034, y);
  // Under the nose a soft dip, the upper lip rise, lower lip, chin pad.
  b -= 0.0016 * Math.exp(-((x / 0.012) ** 2) - ((y + 0.053) / 0.0045) ** 2);
  b += 0.0015 * Math.exp(-((x / 0.011) ** 2) - ((y + 0.0618) / 0.003) ** 2);
  b += 0.0014 * Math.exp(-((x / 0.0095) ** 2) - ((y + 0.0695) / 0.0035) ** 2);
  b -= 0.001 * Math.exp(-((x / 0.012) ** 2) - ((y + 0.077) / 0.0035) ** 2);
  b += 0.0012 * Math.exp(-((x / 0.013) ** 2) - ((y + 0.091) / 0.008) ** 2);
  // Eye sockets sit a touch flatter; cheekbones round out below and beside them.
  for (const s of [-1, 1]) {
    b -= 0.0016 * Math.exp(-(((x - s * 0.0298) / 0.017) ** 2) - ((y + 0.008) / 0.01) ** 2);
    b += 0.0022 * Math.exp(-(((x - s * 0.047) / 0.016) ** 2) - ((y + 0.031) / 0.014) ** 2);
  }
  b += 0.0012 * Math.exp(-((x / 0.04) ** 2) - ((y - 0.018) / 0.01) ** 2);
  return b;
}
/** Radius of the head surface along unit direction d (from HEAD_C). */
export function headR(d: THREE.Vector3): number {
  let lo = 0, hi = 0.2;
  for (let it = 0; it < 20; it++) {
    const t = (lo + hi) / 2;
    if (inHead(d.x * t, d.y * t, d.z * t)) lo = t;
    else hi = t;
  }
  const r = (lo + hi) / 2;
  return r + bumps(d, r);
}

/** Front surface depth (z, negative = forward) of the face at (x, y) from HEAD_C. */
export function faceZ(x: number, y: number): number {
  let lo = -0.16, hi = 0;
  for (let it = 0; it < 24; it++) {
    const z = (lo + hi) / 2;
    if (inHead(x, y, z)) hi = z;
    else lo = z;
  }
  const d = _fz.set(x, y, hi), r = d.length();
  return hi - bumps(d.normalize(), r);
}
const _fz = new THREE.Vector3();

/** Sunglasses lens layout (face-plane metres from HEAD_C): shared by the frames and the face tint. */
export const LENS = { x: 0.031, y: -0.0074, hw: 0.0218, hh: 0.0148, n: 2.6, flare: 0.08, gap: 0.0125, wrap: 0.3, tilt: 0.12 };
/** Lens plane depth at the lens centre (side s), clear of the lashes, brow and cheek. */
export function lensZ(): number {
  let z = 0;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const x = LENS.x + Math.cos(a) * LENS.hw * 0.9, y = LENS.y + Math.sin(a) * LENS.hh * 0.9;
    z = Math.min(z, faceZ(x, y) - 0.006 + LENS.wrap * (x - LENS.x) - LENS.tilt * (y - LENS.y));
  }
  return Math.min(z, faceZ(LENS.x, LENS.y) - LENS.gap);
}
/** Lens outline point (side s, angle a), on its plane. */
export function lensPt(s: number, a: number, zc: number, grow = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(a), sn = Math.sin(a), e = 2 / LENS.n;
  const y = (LENS.hh + grow) * Math.sign(sn) * Math.abs(sn) ** e;
  const x = (LENS.hw + grow) * Math.sign(c) * Math.abs(c) ** e * (1 + LENS.flare * (y / LENS.hh));
  const X = LENS.x + x, Y = LENS.y + y;
  return out.set(s * X, Y, zc + LENS.wrap * (X - LENS.x) - LENS.tilt * (Y - LENS.y)).add(HEAD_C);
}

/** The head mesh (bind pose, walker space), rigid on the head bone. */
export function headGeo(w: WeightFn): Geo {
  const g = new THREE.SphereGeometry(1, 96, 72);
  g.deleteAttribute("uv");
  g.deleteAttribute("normal");
  const pa = g.attributes.position;
  const d = new THREE.Vector3();
  for (let i = 0; i < pa.count; i++) {
    d.fromBufferAttribute(pa, i).normalize();
    d.multiplyScalar(headR(d)).add(HEAD_C);
    pa.setXYZ(i, d.x, d.y, d.z);
  }
  const m = mergeV(g);
  return part(m, SKIN, M.skin, w);
}
function mergeV(g: Geo): Geo {
  // Weld the sphere seam so normals are smooth across it.
  const pos = g.attributes.position;
  const map = new Map<string, number>();
  const remap: number[] = [];
  const np: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    let j = map.get(k);
    if (j === undefined) {
      j = np.length / 3;
      map.set(k, j);
      np.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    remap.push(j);
  }
  const src = g.index!.array;
  const idx: number[] = [];
  for (let k = 0; k < src.length; k += 3) {
    const a = remap[src[k]], b = remap[src[k + 1]], c = remap[src[k + 2]];
    if (a !== b && b !== c && a !== c) idx.push(a, b, c);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.Float32BufferAttribute(np, 3));
  out.setIndex(idx);
  out.computeVertexNormals();
  return out;
}

const lin = (hex: string) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};

/** Live face controls (shared by the material). */
export const FACE = {
  uGaze: { value: new THREE.Vector2() },
  uBlink: { value: 0 },
  uHatShade: { value: 1 },
  uHeadC: { value: HEAD_C.clone() },
  uSmile: { value: 0.3 },
};

/** Eye layout (face-plane metres): centre, half width, half opening, iris radii. */
const E = { x: 0.0298, y: -0.0088, hw: 0.0156, hh: 0.0109, tilt: 0.0014, irx: 0.0079, iry: 0.0095 };

const FACE_VS = /* glsl */ `
${COMMON}
${SKIN_VS}
uniform vec3 uHeadC;
out vec3 vWPos; out vec3 vN; out vec3 vF; out vec3 vCol; out vec3 vRight; out vec3 vDirB;
void main(){
  vec3 p = position, n = normal;
  vec3 q = vec3(0.0), r = vec3(1.0, 0.0, 0.0);
  vF = position - uHeadC;
  skinPN(p, n);
  skinPN(q, r);
  vec3 ry = vec3(0.0, 1.0, 0.0), rz = vec3(0.0, 0.0, 1.0), q2 = vec3(0.0), q3 = vec3(0.0);
  skinPN(q2, ry);
  skinPN(q3, rz);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  vRight = normalize(mat3(modelMatrix) * r);
  vCol = color;
  vDirB = transpose(mat3(modelMatrix) * mat3(r, ry, rz)) * (wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FACE_FS = /* glsl */ `
${COMMON}
${OUT}
uniform vec2 uGaze;
uniform float uBlink;
uniform float uHatShade;
uniform float uSmile;
in vec3 vWPos; in vec3 vN; in vec3 vF; in vec3 vCol; in vec3 vRight; in vec3 vDirB;

// Over-composite a painted layer.
void over(inout vec3 c, vec3 k, float a){ c = mix(c, k, clamp(a, 0.0, 1.0)); }
// Coverage of a signed distance (negative inside) at pixel size pw.
float cov(float sd, float pw){ return 1.0 - smoothstep(-pw, pw, sd); }
// Tapered capsule from a (radius ra) to b (radius rb).
float capsule(vec2 p, vec2 a, vec2 b, float ra, float rb){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}
float ellipse(vec2 p, vec2 c, vec2 r){ vec2 q = (p - c) / r; return (length(q) - 1.0) * min(r.x, r.y); }

const float EX = ${E.x}, EY = ${E.y}, HW = ${E.hw}, HH = ${E.hh}, TILT = ${E.tilt};
float lidTop(float u){ float k = max(0.0, 1.0 - u * u); return HH * pow(k, 0.5) * (1.0 - 0.14 * u) + TILT * u; }
float lidBot(float u){ float k = max(0.0, 1.0 - u * u); return -0.7 * HH * pow(k, 0.72) + TILT * u + 0.0006 * u; }

// One eye, painted into c. p = face-plane point, sd = +1 her right eye (+x), -1 her left.
void paintEye(inout vec3 c, vec2 p, float sd, vec3 Le, float pw){
  vec2 e = vec2((p.x - sd * EX) * sd, p.y - EY);
  float u = e.x / HW;
  float open = 1.0 - uBlink;
  float t0 = lidTop(clamp(u, -1.0, 1.0)), b0 = lidBot(clamp(u, -1.0, 1.0));
  float top = mix(mix(t0, b0, 0.8), t0, open);
  // Eyeshadow: warm rose wash over the lid, deeper toward the outer corner.
  float crease = t0 + 0.0037 + 0.0006 * u;
  float lidA = smoothstep(-1.15, 0.2, u) * (1.0 - smoothstep(1.0, 1.3, u)) * smoothstep(crease + 0.003, top, e.y) * step(top - 0.0004, e.y);
  over(c, c * ${lin("#d98c80")} * 1.25, lidA * 0.28);
  // Crease line.
  float dc = abs(e.y - crease) - 0.00026;
  float crA = cov(dc, pw) * smoothstep(-0.5, -0.3, u) * (1.0 - smoothstep(0.85, 1.0, u)) * (1.0 - smoothstep(0.0012, 0.003, pw));
  over(c, c * ${lin("#a46a5c")}, crA * 0.55);
  // Opening.
  float dIn = min(min(top - e.y, e.y - b0), (1.0 - abs(u)) * HW * 0.3);
  float inA = cov(-dIn, pw * 0.8);
  if (inA > 0.001) {
    vec3 sc = ${lin("#fbf8f3")};
    float lidSh = smoothstep(0.0048, 0.0, top - e.y);
    sc = mix(sc, ${lin("#aab6cf")}, lidSh * 0.85);
    sc = mix(sc, ${lin("#d7c8c6")}, smoothstep(0.55, 1.0, abs(u)) * 0.5);
    // Iris: tall oval, deep blue at the top, luminous turquoise below, fine radial streaks.
    vec2 ic = vec2(0.0004, 0.0011) + vec2(uGaze.x * sd, uGaze.y);
    vec2 q = (e - ic) / vec2(${E.irx}, ${E.iry});
    float r = length(q);
    float irA = cov((r - 1.0) * ${E.irx}, pw * 0.8);
    vec3 ir = mix(${lin("#2f78c8")}, ${lin("#152c5e")}, smoothstep(-0.15, 0.75, q.y));
    ir = mix(ir, ${lin("#5cc4ee")}, smoothstep(0.05, -0.8, q.y) * 0.85);
    float glow = 1.0 - smoothstep(0.25, 0.95, length((q - vec2(0.0, -0.5)) / vec2(0.85, 0.42)));
    ir = mix(ir, ${lin("#b4f0ff")}, glow * 0.55 * (1.0 - 0.7 * uNight));
    float ang = atan(q.y, q.x);
    float streak = vnoise(vec2(ang * 9.0, r * 2.0)) - 0.5;
    float fineK = 1.0 - smoothstep(0.0006, 0.0016, pw);
    ir *= 1.0 + streak * 0.35 * smoothstep(0.25, 0.6, r) * fineK;
    // Dark limbal ring and pupil (with a darker collar round it).
    ir = mix(ir, ${lin("#0c1a3a")}, smoothstep(0.66, 0.96, r) * 0.95);
    float pr = length((q - vec2(0.0, 0.06)) / vec2(0.37, 0.4));
    ir = mix(ir, ir * 0.62, (1.0 - smoothstep(0.9, 1.5, pr)) * 0.6);
    ir = mix(ir, ${lin("#0a1430")}, cov((pr - 1.0) * 0.0026, pw * 0.8));
    // Upper lid's shadow across the top of the iris.
    ir *= mix(1.0, 0.5, smoothstep(0.0055, 0.0, top - e.y));
    vec3 ec = mix(sc, ir, irA);
    // Catch lights (same screen side in both eyes): a big soft one up toward her right, a small
    // one opposite, and a tiny sparkle on the lower rim.
    vec2 pf = vec2(p.x, p.y);
    vec2 icF = vec2(sd * EX + ic.x * sd, EY + ic.y);
    float catchK = 1.0 - smoothstep(0.0016, 0.0042, pw);
    vec2 h1 = pf - (icF + vec2(0.0025, 0.0031));
    h1 = mat2(0.94, -0.34, 0.34, 0.94) * h1;
    float c1 = cov((length(h1 / vec2(0.00175, 0.0023)) - 1.0) * 0.00175, pw * 0.7);
    float c2 = cov(length(pf - (icF + vec2(-0.0024, -0.0031))) - 0.00085, pw * 0.7);
    float c3 = cov(length(pf - (icF + vec2(0.0012, -0.0052))) - 0.00038, pw * 0.7) * fineK;
    over(ec, vec3(1.0), (c1 * 0.97 + c2 * 0.9 + c3 * 0.7) * catchK * (0.25 + 0.75 * open));
    over(c, ec * Le, inA);
  }
  // Upper lash line: thin at the inner corner, thickening outward, then a small winged flick and
  // a few fine lashes fanning up and out.
  float th = 0.0007 + 0.0026 * smoothstep(-0.75, 0.95, u);
  float dl = max(top - 0.00035 - e.y, e.y - (top + th));
  dl = max(dl, (abs(u) - 1.0) * HW);
  vec2 w0 = vec2(0.9 * HW, lidTop(0.9) + 0.0008), w1 = vec2(1.34 * HW, lidTop(0.9) + 0.0042 + 0.0008 * (1.0 - open));
  dl = min(dl, capsule(e, w0, w1, 0.0014, 0.0002));
  float lashFine = 1.0 - smoothstep(0.0007, 0.0018, pw);
  for (int k = 0; k < 4; k++) {
    float fk = float(k);
    float uk = 0.25 + 0.2 * fk;
    vec2 a = vec2(uk * HW, lidTop(uk) + th * 0.5);
    vec2 dir = normalize(vec2(0.45 + 0.35 * fk, 1.0));
    float len = 0.0017 + 0.0005 * fk;
    dl = min(dl, capsule(e, a, a + dir * len, 0.00034, 0.00005) + (1.0 - lashFine) * 0.01);
  }
  over(c, ${lin("#24140f")} * min(Le, vec3(1.0)), cov(dl, pw * 0.8) * 0.96);
  // Lower lashes: a fine warm line on the outer two thirds, with a soft shade under it.
  float bl = abs(e.y - (b0 - 0.0003)) - (0.00026 + 0.00034 * smoothstep(0.2, 0.95, u));
  float blA = cov(bl, pw * 0.8) * smoothstep(-0.1, 0.35, u) * (1.0 - smoothstep(0.98, 1.08, u));
  over(c, c * ${lin("#7e4c3f")}, blA * 0.85);
  float under = smoothstep(0.0028, 0.0, b0 - 0.0003 - e.y) * step(e.y, b0) * smoothstep(-0.4, 0.4, u) * (1.0 - smoothstep(0.9, 1.1, u));
  over(c, c * ${lin("#e2b0a4")}, under * 0.3);
}

void paintBrow(inout vec3 c, vec2 p, float sd, float pw){
  float x = p.x * sd;
  float v = (x - 0.0102) / 0.037;
  if (v < -0.1 || v > 1.1) return;
  float vc = clamp(v, 0.0, 1.0);
  float yc = 0.0098 + 0.005 * sin(3.14159 * min(1.0, vc * 1.12)) - 0.0026 * vc * vc;
  float sl = (0.005 * 3.14159 * 1.12 * cos(3.14159 * min(1.0, vc * 1.12)) * step(vc * 1.12, 1.0) - 0.0052 * vc) / 0.037;
  float th = (0.00042 + 0.00125 * pow(1.0 - vc, 0.8)) * smoothstep(-0.06, 0.12, v);
  float d = abs(p.y - yc) / sqrt(1.0 + sl * sl) - th;
  d = max(d, (abs(v - 0.5) - 0.5) * 0.037);
  vec3 bc = mix(${lin("#7a5240")}, ${lin("#4e3124")}, smoothstep(0.0, 0.35, vc));
  over(c, bc, cov(d, pw * 0.8) * 0.9);
}

// Sunglasses lens (same outline as the frames): where the ray from the eye to this point crosses
// the lens plane. Returns coverage; lq = lens coordinates (-1..1).
const float LX = ${LENS.x}, LY = ${LENS.y}, LHW = ${LENS.hw}, LHH = ${LENS.hh}, LN = ${LENS.n}, LFL = ${LENS.flare}, LWR = ${LENS.wrap}, LTI = ${LENS.tilt}, LZC = ${lensZ().toFixed(5)};
float lens(vec3 f, vec3 dB, float pw, out vec2 lq){
  lq = vec2(9.0);
  float s = f.x >= 0.0 ? 1.0 : -1.0;
  vec3 n = vec3(-LWR * s, LTI, 1.0);
  vec3 D = -normalize(dB);
  float dn = dot(n, D);
  if (abs(dn) < 1e-4) return 0.0;
  float t = dot(n, vec3(s * LX, LY, LZC) - f) / dn;
  if (t <= 0.0) return 0.0;
  vec3 h = f + D * t;
  float y = h.y - LY, x = (s * h.x - LX) / (1.0 + LFL * y / LHH);
  lq = vec2(x / LHW, y / LHH);
  float F = pow(abs(lq.x), LN) + pow(abs(lq.y), LN);
  return cov((pow(F, 1.0 / LN) - 1.0) * LHH, pw * 1.5);
}

void main(){
  gFoot = max(length(dFdx(vWPos)), length(dFdy(vWPos)));
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 base = vCol;
  gSoftCast = 1.0;
  vec3 shT = vec3(0.9, 0.75, 0.7);
  vec3 col = toonT(base, N, vWPos, 0.34, 0.0, 0.5, 0.065, shT);
  vec3 L = col / max(base, vec3(0.02));
  float Lm = max(L.r, max(L.g, L.b));
  vec3 Le = mix(L, vec3(Lm), 0.35) * 0.95 + 0.05 * uSunColor;
  vec3 f = vF;
  // Hat brim: a soft painted shade over the upper face, lower when the sun is high.
  float line = 0.075 - 0.075 * clamp(uSunDir.y, 0.0, 1.0) + 0.004 * sin(f.x * 180.0);
  float hat = smoothstep(line - 0.014, line + 0.014, f.y) * uHatShade * (1.0 - 0.85 * uNight);
  vec3 shade = toonT(base, -normalize(uSunDir), vWPos, 0.34, 0.0, 0.0, 0.065, shT);
  col = mix(col, mix(col, shade, 0.8), hat * 0.7);
  float pw = length(fwidth(f.xy)) * 0.7 + 1e-6;
  if (f.z < -0.03) {
    vec2 p = f.xy;
    // Blush: soft rose ovals with three faint diagonal strokes.
    for (int s = 0; s < 2; s++) {
      float sd = s == 0 ? 1.0 : -1.0;
      vec2 bq = (p - vec2(sd * 0.0405, -0.0305)) / vec2(0.0145, 0.0078);
      float bA = (1.0 - smoothstep(0.2, 1.0, length(bq)));
      over(col, col * ${lin("#f29a90")} * 1.25, bA * 0.42);
      vec2 hq = mat2(0.86, 0.5, -0.5, 0.86) * vec2((p.x - sd * 0.0405) * sd, p.y + 0.0305);
      float hatch = cov(abs(fract(hq.x / 0.0042 + 0.5) - 0.5) * 0.0042 - 0.00018, pw * 0.6) * (1.0 - smoothstep(0.5, 0.9, length(bq))) * (1.0 - smoothstep(0.0006, 0.0014, pw));
      over(col, col * ${lin("#e2847c")}, hatch * 0.3);
    }
    if (p.y > -0.03) {
      paintEye(col, p, 1.0, Le, pw);
      paintEye(col, p, -1.0, Le, pw);
      paintBrow(col, p, 1.0, pw);
      paintBrow(col, p, -1.0, pw);
    }
    // Nose: a short shade stroke on the side away from the light, nostril hints, a tip highlight.
    float ns = dot(vRight, uSunDir) > 0.0 ? -1.0 : 1.0;
    float nd = capsule(p, vec2(ns * 0.0038, -0.031), vec2(ns * 0.0043, -0.0412), 0.0002, 0.00045);
    over(col, col * ${lin("#d89a8a")}, cov(nd, pw * 1.4) * 0.35);
    for (int s = 0; s < 2; s++) {
      float sd = s == 0 ? 1.0 : -1.0;
      float nn = capsule(p, vec2(sd * 0.0016, -0.0468), vec2(sd * 0.0038, -0.0458), 0.0004, 0.0002);
      over(col, col * ${lin("#c27a6c")}, cov(nn, pw) * 0.4);
    }
    over(col, col * ${lin("#dc9a8e")}, (1.0 - smoothstep(0.2, 1.0, length((p - vec2(0.0, -0.0482)) / vec2(0.0046, 0.0013)))) * 0.4);
    // Mouth: soft upper lip line lifting at the corners, coral lips, a small highlight.
    float ym = -0.0656;
    float xm = p.x / 0.0118;
    if (abs(xm) < 1.4 && abs(p.y - ym) < 0.01) {
      float yl = ym + 0.0007 * xm * xm * (1.0 + 1.5 * uSmile) + 0.0011 * uSmile * pow(abs(xm), 3.0) - 0.0003 * exp(-xm * xm * 30.0);
      float tl = (0.0005 * (1.0 - 0.65 * xm * xm) + 0.00012) * step(abs(xm), 1.0);
      float ld = max(abs(p.y - yl) - tl, (abs(xm) - 1.0) * 0.0118);
      float upA = 1.0 - smoothstep(0.35, 1.0, length((p - vec2(0.0, ym + 0.0015)) / vec2(0.0088, 0.0013)));
      over(col, ${lin("#d26e62")} * Le, upA * 0.55);
      float lo = 1.0 - smoothstep(0.3, 1.0, length((p - vec2(0.0, ym - 0.0029)) / vec2(0.0079, 0.0024)));
      over(col, ${lin("#e8806f")} * Le, lo * 0.75);
      over(col, mix(col, Le, 0.6), (1.0 - smoothstep(0.2, 1.0, length((p - vec2(0.0018, ym - 0.0027)) / vec2(0.0024, 0.0006)))) * 0.3 * (1.0 - smoothstep(0.001, 0.002, pw)));
      over(col, ${lin("#8e4038")} * Le, cov(ld, pw * 0.8) * 0.85);
      for (int s = 0; s < 2; s++) {
        float sd = s == 0 ? 1.0 : -1.0;
        over(col, col * ${lin("#b8645a")}, cov(length(p - vec2(sd * 0.0122, ym + 0.0009 + 0.0009 * uSmile)) - 0.00045, pw) * 0.55);
      }
      over(col, col * ${lin("#dcb0a2")}, (1.0 - smoothstep(0.3, 1.0, length((p - vec2(0.0, ym - 0.0078)) / vec2(0.0062, 0.0017)))) * 0.25);
    }
  }
  // Tinted lenses: warm brown, darker at the top, a soft diagonal sheen of the sky.
  vec2 lq;
  float lA = lens(f, vDirB, pw, lq);
  if (lA > 0.0) {
    vec3 tint = mix(${lin("#c4a896")}, ${lin("#94735f")}, smoothstep(-0.7, 0.8, lq.y));
    col = mix(col, col * tint, lA);
    float band = 1.0 - smoothstep(0.0, 0.16, abs(lq.x * 0.55 + lq.y * 0.85 - 0.3));
    band += 0.6 * (1.0 - smoothstep(0.0, 0.06, abs(lq.x * 0.55 + lq.y * 0.85 - 0.62)));
    over(col, Le * ${lin("#d6e2e6")} * (0.7 - 0.45 * uNight), band * 0.28 * lA);
  }
  col = applyFog(col, vWPos);
  writeOut(col, N, 1.0);
}`;

let faceMat: THREE.ShaderMaterial | null = null;
/** Her face material (skinned, id 19 = crisp painted features; no cast shadows: the hat shade is painted). */
export function faceMaterial(id: number): THREE.ShaderMaterial {
  faceMat ??= new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    // No cast shadows at all (her own map included): the hat's shade is painted, softly.
    uniforms: { ...G, ...FACE, uShadowOn: { value: 0 }, uCharShadowOn: { value: 0 }, uId: { value: id }, uMask: { value: 1 } },
    vertexShader: FACE_VS,
    fragmentShader: FACE_FS,
    vertexColors: true,
  });
  return faceMat;
}
