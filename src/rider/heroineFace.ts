import * as THREE from "three";
import { COMMON, G, OUT, SKIN_VS } from "../render/materials";

/**
 * The heroine's face, head, neck and chest skin: the game's skin toon (one clean cel step, warm
 * shade, soft cast shadows) with her features painted in face-plane coordinates (glTF head-local
 * metres: x her left, y up, z toward the front). Large almond eyes with a deep-blue to turquoise
 * iris, a dark limbal ring, a pupil and three catch lights; a winged upper lash line with fine
 * lashes, a lower lash line and lid crease; soft natural brows; a small nose shade; coral lips;
 * blush; a painted shade under the jaw; the sunglass lenses tinting what is seen through them (the
 * ray from the eye through the lens plane). Every stroke is filtered by its pixel footprint.
 */

export interface FaceLayout {
  headC: [number, number, number];
  eye: { x: number; y: number; hw: number; hh: number; tilt: number; irx: number; iry: number };
  brow: { x0: number; x1: number; y: number; arch: number; drop: number };
  nose: { y: number; yb: number };
  mouth: { y: number; hw: number };
  blush: { x: number; y: number; rx: number; ry: number };
  jaw: { menton: number; gx: number; lift: number; p: number; zk: number; lower: number };
  lens: { x: number; y: number; hw: number; hh: number; n: number; flare: number; wrap: number; tilt: number; z: number };
}

/** Live face controls shared by the material. */
export const FACE_U = {
  uGaze: { value: new THREE.Vector2() },
  uBlink: { value: 0 },
  uSmile: { value: 0.35 },
  /** 0 = no sunglasses (lens tint off), 1 = worn. */
  uLens: { value: 1 },
  /** Painted shade of the hat brim over the upper face (0 = no hat). */
  uHatShade: { value: 1 },
};

const lin = (hex: string) => {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`;
};
const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

function vs(): string {
  return /* glsl */ `
${COMMON}
${SKIN_VS}
uniform vec3 uHeadC;
out vec3 vWPos; out vec3 vN; out vec3 vF; out vec3 vCol; out vec3 vDirB; out vec3 vRight;
void main(){
  vec3 p = position, n = normal;
  vF = position - uHeadC;
  skinPN(p, n);
  // The head bone's rotation (her face is rigid on it): skin three axes through the origin.
  vec3 o = vec3(0.0), rx = vec3(1.0, 0.0, 0.0), q2 = vec3(0.0), ry = vec3(0.0, 1.0, 0.0), q3 = vec3(0.0), rz = vec3(0.0, 0.0, 1.0);
  skinPN(o, rx); skinPN(q2, ry); skinPN(q3, rz);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  vRight = normalize(mat3(modelMatrix) * rx);
  vCol = color;
  // View ray (camera to this point) in the head's bind frame.
  vDirB = transpose(mat3(modelMatrix) * mat3(normalize(rx), normalize(ry), normalize(rz))) * (wp.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
}

function fs(L: FaceLayout): string {
  const e = L.eye, b = L.brow, l = L.lens;
  return /* glsl */ `
${COMMON}
${OUT}
uniform vec2 uGaze;
uniform float uBlink, uSmile, uLens, uHatShade;
in vec3 vWPos; in vec3 vN; in vec3 vF; in vec3 vCol; in vec3 vDirB; in vec3 vRight;

void over(inout vec3 c, vec3 k, float a){ c = mix(c, k, clamp(a, 0.0, 1.0)); }
float cov(float sd, float pw){ return 1.0 - smoothstep(-pw, pw, sd); }
float capsule(vec2 p, vec2 a, vec2 b, float ra, float rb){
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

const float EX = ${f(e.x)}, EY = ${f(e.y)}, HW = ${f(e.hw)}, HH = ${f(e.hh)}, TILT = ${f(e.tilt)};
const float IRX = ${f(e.irx)}, IRY = ${f(e.iry)};
// Upper lid: an almond arch peaking a little toward the inner side, sweeping down to a lifted
// outer corner; lower lid flatter.
float lidTop(float u){ float k = max(0.0, 1.0 - u * u); return HH * pow(k, 0.46) * (1.0 - 0.16 * u) + TILT * u; }
float lidBot(float u){ float k = max(0.0, 1.0 - u * u); return -0.62 * HH * pow(k, 0.7) * (1.0 + 0.1 * u) + TILT * u + 0.0005 * u; }

// One eye painted into c. p = face-plane point, sd = +1 her left eye (+x), -1 her right eye.
void paintEye(inout vec3 c, vec2 p, float sd, vec3 Le, float pw){
  vec2 e = vec2((p.x - sd * EX) * sd, p.y - EY);   // x toward the outer corner
  float u = e.x / HW;
  float open = 1.0 - uBlink;
  float uc = clamp(u, -1.0, 1.0);
  float t0 = lidTop(uc), b0 = lidBot(uc);
  float top = mix(mix(t0, b0, 0.82), t0, open);
  // Soft rosy-peach lid wash, deeper toward the outer corner.
  float crease = t0 + 0.0040 + 0.0007 * u;
  float lidA = smoothstep(-1.2, 0.3, u) * (1.0 - smoothstep(1.0, 1.32, u)) * smoothstep(crease + 0.0032, top, e.y) * step(top - 0.0004, e.y);
  over(c, c * ${lin("#e2988a")} * 1.18, lidA * 0.34);
  // Lid crease: a fine warm line over the middle of the lid.
  float dc = abs(e.y - crease) - 0.00024;
  float crA = cov(dc, pw) * smoothstep(-0.55, -0.25, u) * (1.0 - smoothstep(0.8, 1.02, u)) * (1.0 - smoothstep(0.0012, 0.003, pw));
  over(c, c * ${lin("#a66b5d")}, crA * 0.6);
  // The opening.
  float dIn = min(min(top - e.y, e.y - b0), (1.0 - abs(u)) * HW * 0.32);
  float inA = cov(-dIn, pw * 0.8);
  if (inA > 0.001) {
    vec3 sc = ${lin("#fbf7f1")};
    // Upper lid casts a soft cool shade over the white; the corners are pinker.
    float lidSh = smoothstep(0.0052, 0.0, top - e.y);
    sc = mix(sc, ${lin("#a9b4cc")}, lidSh * 0.85);
    sc = mix(sc, ${lin("#e8c9c3")}, smoothstep(0.55, 1.0, abs(u)) * 0.55);
    // Iris: a tall oval, deep blue at the top, luminous turquoise below, fine radial streaks.
    vec2 ic = vec2(0.0003 + uGaze.x * sd, 0.0010 + uGaze.y);
    vec2 q = (e - ic) / vec2(IRX, IRY);
    float r = length(q);
    float irA = cov((r - 1.0) * IRX, pw * 0.8);
    vec3 ir = mix(${lin("#2f7fd0")}, ${lin("#14306a")}, smoothstep(-0.2, 0.78, q.y));
    ir = mix(ir, ${lin("#57c6ef")}, smoothstep(0.0, -0.85, q.y) * 0.88);
    float glow = 1.0 - smoothstep(0.2, 0.95, length((q - vec2(0.0, -0.5)) / vec2(0.82, 0.42)));
    ir = mix(ir, ${lin("#bff3ff")}, glow * 0.55 * (1.0 - 0.7 * uNight));
    float ang = atan(q.y, q.x);
    float fineK = 1.0 - smoothstep(0.0005, 0.0015, pw);
    float streak = vnoise(vec2(ang * 10.0, r * 2.2)) - 0.5;
    ir *= 1.0 + streak * 0.38 * smoothstep(0.28, 0.62, r) * fineK;
    // Dark limbal ring and pupil, with a darker collar.
    ir = mix(ir, ${lin("#0b1838")}, smoothstep(0.68, 0.97, r) * 0.95);
    float pr = length((q - vec2(0.0, 0.07)) / vec2(0.36, 0.40));
    ir = mix(ir, ir * 0.6, (1.0 - smoothstep(0.9, 1.55, pr)) * 0.6);
    ir = mix(ir, ${lin("#08112a")}, cov((pr - 1.0) * 0.0026, pw * 0.8));
    // The upper lid's shadow across the top of the iris.
    ir *= mix(1.0, 0.48, smoothstep(0.0058, 0.0, top - e.y));
    vec3 ec = mix(sc, ir, irA);
    // Catch lights, on the same screen side in both eyes: a big soft one up and toward the
    // light side, a small one opposite below, a tiny sparkle on the lower rim.
    vec2 icF = vec2(sd * EX + ic.x * sd, EY + ic.y);
    float catchK = 1.0 - smoothstep(0.0016, 0.0045, pw);
    vec2 h1 = mat2(0.94, -0.34, 0.34, 0.94) * (p - (icF + vec2(-0.0026, 0.0032)));
    float c1 = cov((length(h1 / vec2(0.0019, 0.0025)) - 1.0) * 0.0019, pw * 0.7);
    float c2 = cov(length(p - (icF + vec2(0.0026, -0.0030))) - 0.0009, pw * 0.7);
    float c3 = cov(length(p - (icF + vec2(-0.0011, -0.0054))) - 0.0004, pw * 0.7) * fineK;
    over(ec, vec3(1.0), (c1 * 0.97 + c2 * 0.9 + c3 * 0.75) * catchK * (0.25 + 0.75 * open));
    over(c, ec * Le, inA);
  }
  // Upper lash line: fine at the inner corner, thickening outward, a small winged flick, and a
  // few fine lashes fanning up and out.
  float th = 0.0006 + 0.0028 * smoothstep(-0.8, 0.95, u);
  float dl = max(top - 0.0003 - e.y, e.y - (top + th));
  dl = max(dl, (abs(u) - 1.0) * HW);
  vec2 w0 = vec2(0.88 * HW, lidTop(0.88) + 0.0008), w1 = vec2(1.36 * HW, lidTop(0.88) + 0.0046 + 0.001 * (1.0 - open));
  dl = min(dl, capsule(e, w0, w1, 0.0015, 0.00018));
  float lashFine = 1.0 - smoothstep(0.0007, 0.0018, pw);
  for (int k = 0; k < 5; k++) {
    float fk = float(k);
    float uk = 0.18 + 0.18 * fk;
    vec2 a = vec2(uk * HW, mix(lidTop(uk), b0, 1.0 - open) + th * 0.5);
    vec2 dir = normalize(vec2(0.35 + 0.32 * fk, 1.0));
    float len = 0.0016 + 0.00055 * fk;
    dl = min(dl, capsule(e, a, a + dir * len, 0.00034, 0.00005) + (1.0 - lashFine) * 0.01);
  }
  over(c, ${lin("#23130e")} * min(Le, vec3(1.0)), cov(dl, pw * 0.8) * 0.97);
  // Lower lashes: a fine warm line on the outer two thirds, a soft shade under it.
  float bl = abs(e.y - (b0 - 0.0003)) - (0.00024 + 0.00036 * smoothstep(0.2, 0.95, u));
  float blA = cov(bl, pw * 0.8) * smoothstep(-0.15, 0.35, u) * (1.0 - smoothstep(0.98, 1.1, u));
  over(c, c * ${lin("#7a4a3e")}, blA * 0.85);
  float under = smoothstep(0.0030, 0.0, b0 - 0.0003 - e.y) * step(e.y, b0) * smoothstep(-0.4, 0.4, u) * (1.0 - smoothstep(0.9, 1.1, u));
  over(c, c * ${lin("#e6b2a6")}, under * 0.3);
}

// Brows: soft, natural, a little fuller at the inner end, arching at about two thirds out.
void paintBrow(inout vec3 c, vec2 p, float sd, float pw){
  float x = p.x * sd;
  float v = (x - ${f(b.x0)}) / ${f(b.x1 - b.x0)};
  if (v < -0.1 || v > 1.1) return;
  float vc = clamp(v, 0.0, 1.0);
  float yc = ${f(b.y)} + ${f(b.arch)} * sin(3.14159 * min(1.0, vc * 1.15)) - ${f(b.drop)} * vc * vc;
  float sl = (${f(b.arch)} * 3.14159 * 1.15 * cos(3.14159 * min(1.0, vc * 1.15)) * step(vc * 1.15, 1.0) - 2.0 * ${f(b.drop)} * vc) / ${f(b.x1 - b.x0)};
  float th = (0.00045 + 0.00135 * pow(1.0 - vc, 0.75)) * smoothstep(-0.06, 0.14, v);
  float d = abs(p.y - yc) / sqrt(1.0 + sl * sl) - th;
  d = max(d, (abs(v - 0.5) - 0.5) * ${f(b.x1 - b.x0)});
  vec3 bc = mix(${lin("#8a5c4c")}, ${lin("#5a3a2c")}, smoothstep(0.05, 0.4, vc));
  // Softer at the inner end, crisp toward the tail.
  float a = mix(0.62, 0.92, smoothstep(0.0, 0.35, vc));
  over(c, bc, cov(d, pw * 0.8 + 0.00025 * (1.0 - vc)) * a);
}

// Sunglass lens (the frames share this outline): where the ray from this face point toward the
// eye crosses the lens plane. Returns coverage; lq = lens coordinates (-1..1).
const float LX = ${f(l.x)}, LY = ${f(l.y)}, LHW = ${f(l.hw)}, LHH = ${f(l.hh)}, LN = ${f(l.n)}, LFL = ${f(l.flare)}, LWR = ${f(l.wrap)}, LTI = ${f(l.tilt)}, LZ = ${f(l.z)};
float lens(vec3 fp, vec3 dB, float pw, out vec2 lq){
  lq = vec2(9.0);
  float s = fp.x >= 0.0 ? 1.0 : -1.0;
  vec3 n = vec3(LWR * s, -LTI, 1.0);
  vec3 D = -normalize(dB);
  float dn = dot(n, D);
  if (abs(dn) < 1e-4) return 0.0;
  float t = dot(n, vec3(s * LX, LY, LZ) - fp) / dn;
  if (t <= 0.0) return 0.0;
  vec3 h = fp + D * t;
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
  gHer = 1.0;
  vec3 shT = herShade(vec3(0.9, 0.75, 0.7));
  vec3 col = toonT(base, N, vWPos, 0.34, 0.0, 0.5, 0.065, shT);
  vec3 Lgt = col / max(base, vec3(0.02));
  float Lm = max(Lgt.r, max(Lgt.g, Lgt.b));
  vec3 Le = mix(Lgt, vec3(Lm), 0.35) * 0.95 + 0.05 * uSunColor;
  vec3 fp = vF;
  vec3 shade = toonT(base, -normalize(uSunDir), vWPos, 0.34, 0.0, 0.0, 0.065, shT);
  // Hat brim: a soft painted shade over the upper face, lower when the sun is high.
  float line = 0.058 - 0.07 * clamp(uSunDir.y, 0.0, 1.0) + 0.003 * sin(fp.x * 180.0);
  float hat = smoothstep(line - 0.012, line + 0.012, fp.y) * uHatShade * (1.0 - 0.85 * uNight);
  col = mix(col, mix(col, shade, 0.8), hat * 0.62);
  // Under the jaw: the chin's soft painted shade on the throat (anime neck shadow), its edge
  // following the jaw line and dropping lower when the sun is high.
  float ax = abs(fp.x);
  float jaw = ${f(L.jaw.menton)} + ${f(L.jaw.lift)} * pow(min(ax / ${f(L.jaw.gx)}, 1.45), ${f(L.jaw.p)});
  jaw = ${f(L.jaw.zk)} + (jaw - ${f(L.jaw.zk)}) / ${f(L.jaw.lower)};
  float drop = 0.008 + 0.022 * clamp(uSunDir.y, 0.0, 1.0) + 0.003 * sin(fp.x * 140.0);
  float neckSh = smoothstep(jaw - drop - 0.004, jaw - drop + 0.003, fp.y) * (1.0 - smoothstep(jaw - 0.0005, jaw + 0.0035, fp.y));
  neckSh *= smoothstep(-0.04, 0.0, fp.z) * (1.0 - smoothstep(0.06, 0.085, ax));
  col = mix(col, mix(shade, col * vec3(0.84, 0.76, 0.76), 0.55), neckSh * 0.85 * (1.0 - 0.6 * uNight));
  float pw = length(fwidth(fp.xy)) * 0.7 + 1e-6;
  if (fp.z > 0.035) {
    vec2 p = fp.xy;
    // Blush: soft rose ovals with three faint diagonal strokes.
    for (int s = 0; s < 2; s++) {
      float sd = s == 0 ? 1.0 : -1.0;
      vec2 bq = (p - vec2(sd * ${f(L.blush.x)}, ${f(L.blush.y)})) / vec2(${f(L.blush.rx)}, ${f(L.blush.ry)});
      float bA = 1.0 - smoothstep(0.15, 1.0, length(bq));
      over(col, col * ${lin("#f39b90")} * 1.22, bA * 0.45);
      vec2 hq = mat2(0.86, 0.5, -0.5, 0.86) * vec2((p.x - sd * ${f(L.blush.x)}) * sd, p.y - ${f(L.blush.y)});
      float hatch = cov(abs(fract(hq.x / 0.0042 + 0.5) - 0.5) * 0.0042 - 0.00017, pw * 0.6) * (1.0 - smoothstep(0.45, 0.85, length(bq))) * (1.0 - smoothstep(0.0006, 0.0014, pw));
      over(col, col * ${lin("#e2847c")}, hatch * 0.28);
    }
    if (p.y > EY - 0.03 && p.y < EY + 0.04) {
      paintEye(col, p, 1.0, Le, pw);
      paintEye(col, p, -1.0, Le, pw);
      paintBrow(col, p, 1.0, pw);
      paintBrow(col, p, -1.0, pw);
    }
    // Nose: a short soft shade on the side away from the light, the tip's shade below it,
    // nostril hints, a small highlight on the tip.
    float ny = ${f(L.nose.y)}, nb = ${f(L.nose.yb)};
    float ns = dot(vRight, uSunDir) > 0.0 ? -1.0 : 1.0;
    float nd = capsule(p, vec2(ns * 0.0040, ny + 0.010), vec2(ns * 0.0047, ny - 0.001), 0.00018, 0.00048);
    over(col, col * ${lin("#d99a8b")}, cov(nd, pw * 1.4) * 0.38);
    over(col, col * ${lin("#d8938a")}, (1.0 - smoothstep(0.2, 1.0, length((p - vec2(0.0, nb - 0.0006)) / vec2(0.0052, 0.0014)))) * 0.45);
    for (int s = 0; s < 2; s++) {
      float sd = s == 0 ? 1.0 : -1.0;
      float nn = capsule(p, vec2(sd * 0.0017, nb + 0.0002), vec2(sd * 0.0040, nb + 0.0011), 0.00042, 0.0002);
      over(col, col * ${lin("#bf7769")}, cov(nn, pw) * 0.42);
    }
    over(col, mix(col, Le * base * 1.08, 0.5), (1.0 - smoothstep(0.2, 1.0, length((p - vec2(0.0012, ny + 0.0012)) / vec2(0.0018, 0.0012)))) * 0.25 * (1.0 - smoothstep(0.001, 0.002, pw)));
    // Mouth: a soft upper lip line lifting at the corners, coral lips, a small highlight.
    float ym = ${f(L.mouth.y)};
    float xm = p.x / ${f(L.mouth.hw)};
    if (abs(xm) < 1.45 && abs(p.y - ym) < 0.011) {
      float yl = ym + 0.0007 * xm * xm * (1.0 + 1.6 * uSmile) + 0.0011 * uSmile * pow(abs(xm), 3.0) - 0.0003 * exp(-xm * xm * 30.0);
      float tl = (0.00048 * (1.0 - 0.65 * xm * xm) + 0.00012) * step(abs(xm), 1.0);
      float ld = max(abs(p.y - yl) - tl, (abs(xm) - 1.0) * ${f(L.mouth.hw)});
      // Upper lip: a bow (two soft lobes either side of a dip at the philtrum).
      vec2 uq = (p - vec2(0.0, ym + 0.0019)) / vec2(0.0098, 0.0019);
      float upA = (1.0 - smoothstep(0.4, 1.0, length(uq))) * (1.0 - 0.45 * exp(-xm * xm * 40.0) * smoothstep(0.0, 0.6, uq.y));
      over(col, ${lin("#d86a5c")} * Le, upA * 0.78);
      float lo = 1.0 - smoothstep(0.35, 1.0, length((p - vec2(0.0, ym - 0.0033)) / vec2(0.0088, 0.0031)));
      over(col, ${lin("#ea7d6c")} * Le, lo * 0.9);
      over(col, mix(col, Le, 0.65), (1.0 - smoothstep(0.2, 1.0, length((p - vec2(-0.0016, ym - 0.0034)) / vec2(0.0030, 0.0008)))) * 0.38 * (1.0 - smoothstep(0.001, 0.002, pw)));
      over(col, ${lin("#8f4038")} * Le, cov(ld, pw * 0.8) * 0.85);
      for (int s = 0; s < 2; s++) {
        float sd = s == 0 ? 1.0 : -1.0;
        over(col, col * ${lin("#b8645a")}, cov(length(p - vec2(sd * ${f(L.mouth.hw * 1.03)}, ym + 0.0009 + 0.0009 * uSmile)) - 0.00045, pw) * 0.55);
      }
      over(col, col * ${lin("#dcb0a2")}, (1.0 - smoothstep(0.3, 1.0, length((p - vec2(0.0, ym - 0.0080)) / vec2(0.0062, 0.0017)))) * 0.25);
    }
  }
  // Tinted lenses: a light, even warm-brown tint (the same density across the lens) and one clean
  // white reflection streak, so her eyes read clearly through them at every time of day.
  if (uLens > 0.5 && fp.z > 0.0) {
    vec2 lq;
    float lA = lens(fp, vDirB, pw, lq);
    if (lA > 0.0) {
      // Clear glass with a light, even tint: what is seen through it keeps its value but sheds
      // part of the scene light's hue, so the lens reads the same at noon, golden and night.
      float cl = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 hueFree = col * (dot(Le, vec3(0.2126, 0.7152, 0.0722)) / max(Le, vec3(0.03)));
      vec3 seen = mix(col, mix(hueFree, vec3(cl), 0.2), 0.45);
      col = mix(col, seen * ${lin("#f1e3d6")}, lA * 0.8);
      // One thin reflection along the upper-outer rim of each lens (lens x is mirrored, + = outer):
      // above the lash line and the iris, tapering at both ends, half transparent.
      float ang = atan(lq.y, lq.x);
      float rr = pow(pow(abs(lq.x), LN) + pow(abs(lq.y), LN), 1.0 / LN);
      float along = smoothstep(0.84, 0.98, ang) * (1.0 - smoothstep(1.22, 1.4, ang));
      float streak = cov((abs(rr - 0.9) - 0.035 * along) * LHH, pw * 0.8) * along;
      over(col, vec3(1.0) * mix(1.0, 0.6, uNight) * max(Le, vec3(0.6)), streak * 0.6 * lA);
    }
  }
  col = applyFog(col, vWPos);
  writeOut(col, N, 1.0);
}`;
}

/** Her face/skin material (skinned, outline id 19 = crisp painted features, no cast shadows on it:
 * the hat's shade is painted). */
export function heroineFaceMaterial(layout: FaceLayout, id: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      ...G,
      ...FACE_U,
      uHeadC: { value: new THREE.Vector3(...layout.headC) },
      uShadowOn: { value: 0 },
      uCharShadowOn: { value: 0 },
      uId: { value: id },
      uMask: { value: 1 },
    },
    vertexShader: vs(),
    fragmentShader: fs(layout),
    vertexColors: true,
  });
}
