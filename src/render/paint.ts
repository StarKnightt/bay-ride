import * as THREE from "three";
import { FullScreenQuad } from "three/addons/postprocessing/Pass.js";
import { SAFE_GLSL } from "./materials";

/**
 * Painterly filter: an anisotropic Kuwahara pass that flattens surfaces into brush patches that
 * follow the local structure while edges stay crisp (the published anisotropic Kuwahara with
 * polynomial sector weights: no weight texture, one tap per kernel texel).
 *
 *   1. structure tensor of the scene colour (Sobel), half resolution
 *   2. tensor smoothing, half resolution
 *   3. 8-sector elliptical Kuwahara oriented by the tensor's eigenvector, half resolution (each tap
 *      reads the full-resolution colour bilinearly between 2x2 texels: a free box prefilter)
 *   4. full-resolution composite: depth-aware 4-tap upsample, then blended over the scene by
 *      `strength`, with her face kept unfiltered, the rest of her and the boat softer, the sea and
 *      the swash beach at about half strength with their glitter and foam highlights kept
 *      wherever they are brighter than the paint, and wires untouched
 *
 * Cost at 1920x1080 (518k half-res pixels): 8 + 9 taps for the tensor, ~28 taps x 8 sectors at the
 * default radius for the Kuwahara (~45 loop steps), 7 taps per full-res pixel for the composite;
 * estimated 0.4-0.7 ms on an RTX 4060.
 */

const VS = /* glsl */ `out vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON_FS = /* glsl */ `
${SAFE_GLSL}
in vec2 vUv;
layout(location = 0) out vec4 o;
float lum(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

const TENSOR = /* glsl */ `
${COMMON_FS}
uniform sampler2D tColor;
uniform vec2 uStep;  // one half-res texel in uv
uniform vec2 uS, uMaxF;
vec3 tap(vec2 d){ vec3 c = safe3(textureLod(tColor, min(vUv * uS + d * uStep, uMaxF), 0.0).rgb); return c / (1.0 + c); }
void main(){
  vec3 a = tap(vec2(-1.0, -1.0)), b = tap(vec2(0.0, -1.0)), c = tap(vec2(1.0, -1.0));
  vec3 d = tap(vec2(-1.0, 0.0)), f = tap(vec2(1.0, 0.0));
  vec3 g = tap(vec2(-1.0, 1.0)), h = tap(vec2(0.0, 1.0)), i = tap(vec2(1.0, 1.0));
  vec3 sx = (c + 2.0 * f + i - a - 2.0 * d - g) * 0.25;
  vec3 sy = (g + 2.0 * h + i - a - 2.0 * b - c) * 0.25;
  o = vec4(dot(sx, sx), dot(sx, sy), dot(sy, sy), 1.0);
}
`;

const BLUR = /* glsl */ `
${COMMON_FS}
uniform sampler2D tTensor;
uniform vec2 uStep;
uniform vec2 uS, uMaxH;
void main(){
  // 3x3 bilinear taps 1.5 texels apart: a ~6x6 Gaussian-ish footprint for 9 fetches.
  vec4 s = vec4(0.0);
  float wsum = 0.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    float w = (i == 0 ? 2.0 : 1.0) * (j == 0 ? 2.0 : 1.0);
    s += textureLod(tTensor, min(vUv * uS + vec2(float(i), float(j)) * 1.5 * uStep, uMaxH), 0.0) * w;
    wsum += w;
  }
  o = s / wsum;
}
`;

const KUWAHARA = /* glsl */ `
${COMMON_FS}
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform sampler2D tTensor;
uniform vec2 uFull;    // one full-res texel in uv
uniform float uRadius; // kernel radius in half-res texels
uniform float uQ, uHard, uZero;
uniform float uNear, uFar;
uniform vec2 uS, uMaxF, uMaxH;
float linz(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
vec3 src(vec2 uv){ return sqrt(clamp(safe3(textureLod(tColor, min(uv, uMaxF), 0.0).rgb), 0.0, 16.0)); }
void main(){
  // One exact full-res texel under this half-res pixel (a bilinear read would blend the ids).
  ivec2 fp = ivec2(gl_FragCoord.xy * 2.0);
  float dz = linz(texelFetch(tDepth, fp, 0).r);
  float id = floor(texelFetch(tNormal, fp, 0).z * 32.0 + 0.5);
  // Her face stays as painted; her hair, skin and clothes and the skiff take a smaller brush.
  // The sea is left alone (its glitter and strokes are painted crisp already); grass, leaves,
  // flowers and stone take a broader brush.
  float rk = (id == 19.0 || id == 2.0) ? 0.0 : (id == 13.0 || id == 14.0 || id == 18.0 || (id >= 20.0 && id <= 24.0)) ? 0.45
           : (id == 3.0 || id == 6.0 || id == 16.0) ? 1.35 : 1.0;
  float R = uRadius * rk;
  vec2 uv0 = vUv * uS;
  vec3 c0 = src(uv0);
  if (R < 0.6) { o = vec4(c0 * c0, dz); return; }
  vec3 g = textureLod(tTensor, min(uv0, uMaxH), 0.0).xyz;
  float disc = sqrt(max((g.x - g.z) * (g.x - g.z) + 4.0 * g.y * g.y, 0.0));
  float l1 = 0.5 * (g.x + g.z + disc), l2 = 0.5 * (g.x + g.z - disc);
  // t: the minor eigenvector, along the local stroke; the kernel stretches along it.
  vec2 v = vec2(l1 - g.x, -g.y);
  vec2 t = dot(v, v) > 1e-12 ? normalize(v) : vec2(0.0, 1.0);
  float phi = atan(t.y, t.x);
  float A = l1 + l2 > 1e-9 ? (l1 - l2) / (l1 + l2) : 0.0;
  float a = R * clamp(1.0 + A, 0.1, 2.0);
  float b = R * clamp(1.0 / (1.0 + A), 0.1, 2.0);
  float cp = cos(phi), sp = sin(phi);
  mat2 SR = mat2(0.5 / a, 0.0, 0.0, 0.5 / b) * mat2(cp, -sp, sp, cp);
  int mx = int(sqrt(a * a * cp * cp + b * b * sp * sp));
  int my = int(sqrt(a * a * sp * sp + b * b * cp * cp));
  mx = min(mx, 7);
  my = min(my, 7);
  // Sector overlap: zeta = 1 / radius, eta from a zero crossing at uZero rad (0.58 ~ 33 deg).
  float zeta = 1.0 / max(R, 1.0);
  float eta = (zeta + cos(uZero)) / max(sin(uZero) * sin(uZero), 1e-3);
  vec4 m[8];
  vec3 s[8];
  for (int k = 0; k < 8; k++) { m[k] = vec4(0.0); s[k] = vec3(0.0); }
  vec2 step2 = uFull * 2.0;
  for (int j = -my; j <= my; j++) {
    for (int i = -mx; i <= mx; i++) {
      vec2 off = vec2(float(i), float(j));
      vec2 w2 = SR * off;
      if (dot(w2, w2) > 0.25) continue;
      vec3 c = src(uv0 + off * step2);
      float w[8];
      float sum = 0.0, z, vxx, vyy;
      vxx = zeta - eta * w2.x * w2.x;
      vyy = zeta - eta * w2.y * w2.y;
      z = max(0.0, w2.y + vxx); w[0] = z * z;
      z = max(0.0, -w2.x + vyy); w[2] = z * z;
      z = max(0.0, -w2.y + vxx); w[4] = z * z;
      z = max(0.0, w2.x + vyy); w[6] = z * z;
      vec2 r2 = 0.70710678 * vec2(w2.x - w2.y, w2.x + w2.y);
      vxx = zeta - eta * r2.x * r2.x;
      vyy = zeta - eta * r2.y * r2.y;
      z = max(0.0, r2.y + vxx); w[1] = z * z;
      z = max(0.0, -r2.x + vyy); w[3] = z * z;
      z = max(0.0, -r2.y + vxx); w[5] = z * z;
      z = max(0.0, r2.x + vyy); w[7] = z * z;
      for (int k = 0; k < 8; k++) sum += w[k];
      float gk = exp(-3.125 * dot(w2, w2)) / max(sum, 1e-6);
      for (int k = 0; k < 8; k++) {
        float wk = w[k] * gk;
        m[k] += vec4(c * wk, wk);
        s[k] += c * c * wk;
      }
    }
  }
  vec4 acc = vec4(0.0);
  for (int k = 0; k < 8; k++) {
    if (m[k].w <= 1e-6) continue;
    vec3 mean = m[k].rgb / m[k].w;
    vec3 var = abs(s[k] / m[k].w - mean * mean);
    float sig = var.r + var.g + var.b;
    float wk = 1.0 / (1.0 + pow(uHard * 1000.0 * sig, 0.5 * uQ));
    acc += vec4(mean * wk, wk);
  }
  vec3 p = acc.w > 1e-6 ? acc.rgb / acc.w : c0;
  if (badF3(p)) p = c0;
  o = vec4(p * p, dz);
}
`;

const COMPOSITE = /* glsl */ `
${COMMON_FS}
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform sampler2D tPaint;
uniform vec2 uHalf;    // half-res texture size in texels
uniform float uStrength;
uniform float uNear, uFar;
uniform vec2 uS, uMaxH;
float linz(float d){ float z = d * 2.0 - 1.0; return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear)); }
void main(){
  ivec2 fp = ivec2(gl_FragCoord.xy);
  vec3 col = safe3(texelFetch(tColor, fp, 0).rgb);
  vec4 nrm = texelFetch(tNormal, fp, 0);
  float id = floor(nrm.z * 32.0 + 0.5);
  // The sea (id 2) stays exactly as drawn: the filter would smear its glitter into a glow and lift
  // its tone. The swash beach (ground id with no ink mask) only settles a little.
  bool wet = id == 1.0 && abs(nrm.a) < 0.05;
  float w = uStrength * (wet ? 0.25 : (id == 3.0 || id == 4.0 || id == 6.0 || id == 16.0) ? 1.15 : 1.0);
  if (id == 19.0 || id == 2.0 || w <= 0.0) { o = vec4(col, 1.0); return; }
  // Depth-aware upsample: the four nearest half-res texels, weighted by how close their depth is
  // to this pixel's (no background paint bleeding onto a silhouette, or the reverse).
  float dz = linz(texelFetch(tDepth, fp, 0).r);
  vec2 hp = vUv * uS * uHalf - 0.5;
  vec2 b = floor(hp), f = hp - b;
  vec4 acc = vec4(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec4 p = textureLod(tPaint, min((b + vec2(float(i), float(j)) + 0.5) / uHalf, uMaxH), 0.0);
    float bw = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float dw = exp(-abs(p.a - dz) / max(dz * 0.04, 0.02) * 2.0);
    float ww = bw * dw + 1e-5;
    acc += vec4(safe3(p.rgb) * ww, ww);
  }
  vec3 paint = acc.rgb / acc.w;
  // Her hair, skin and clothes and the skiff: a softer touch on top of the smaller brush.
  if (id == 13.0 || id == 14.0 || id == 18.0 || (id >= 20.0 && id <= 24.0)) w *= 0.6;
  // Thin things a sector filter would erase: wires (they carry no ink line of their own), birds,
  // butterflies and fish (a few pixels), poles, rails and signs (inked, but keep their paint).
  if (id == 9.0) w = 0.0;
  else if (id == 17.0) w *= 0.15;
  else if (id == 8.0 || id == 10.0 || id == 11.0) w *= 0.5;
  float lp = lum(paint), lc = lum(col);
  // The water's glitter stays crisp wherever it outshines the paint; elsewhere any HDR point light
  // (fireflies, lamp heads, sparkles) that the sectors would average away.
  if (wet) w *= 1.0 - smoothstep(lp * 1.15 + 0.02, lp * 1.6 + 0.06, lc);
  else w *= 1.0 - smoothstep(1.0, 1.4, lc) * smoothstep(lp * 1.4 + 0.1, lp * 1.9 + 0.2, lc);
  vec3 outc = mix(col, paint, clamp(w, 0.0, 1.0));
  o = vec4(badF3(outc) ? col : outc, 1.0);
}
`;

const rt = (w: number, h: number) =>
  new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });

function quad(fs: string, uniforms: Record<string, THREE.IUniform>): FullScreenQuad {
  const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms, vertexShader: VS, fragmentShader: fs, depthTest: false, depthWrite: false });
  return new FullScreenQuad(m);
}

export class Paint {
  /** Blend of the painted image over the scene: 0 = off (no passes run), 1 = full. */
  strength = 0.85;
  /** Kernel radius in half-resolution texels at 1080p (scaled with the frame height). */
  radius = 3.0;
  readonly output: THREE.WebGLRenderTarget;
  private readonly tA: THREE.WebGLRenderTarget;
  private readonly tB: THREE.WebGLRenderTarget;
  private readonly kw: THREE.WebGLRenderTarget;
  private readonly tensor: FullScreenQuad;
  private readonly blur: FullScreenQuad;
  private readonly kuwa: FullScreenQuad;
  private readonly comp: FullScreenQuad;
  private H = 1080;
  private W = 1920;
  /** Share of the frame the scene is drawn at (see Post.setScale); the passes run on the same sub-rectangle. */
  private scale = 1;
  readonly uS = { value: new THREE.Vector2(1, 1) };
  private readonly uMaxF = { value: new THREE.Vector2(1, 1) };
  private readonly uMaxH = { value: new THREE.Vector2(1, 1) };

  constructor(W: number, H: number, mrt: THREE.WebGLRenderTarget) {
    const hw = Math.max(1, Math.floor(W / 2)), hh = Math.max(1, Math.floor(H / 2));
    this.tA = rt(hw, hh);
    this.tB = rt(hw, hh);
    this.kw = rt(hw, hh);
    this.output = rt(W, H);
    this.output.texture.name = "painted";
    const color = mrt.textures[0], normal = mrt.textures[1], depth = mrt.depthTexture;
    const { uS, uMaxF, uMaxH } = this;
    this.tensor = quad(TENSOR, { tColor: { value: color }, uStep: { value: new THREE.Vector2() }, uS, uMaxF });
    this.blur = quad(BLUR, { tTensor: { value: this.tA.texture }, uStep: { value: new THREE.Vector2() }, uS, uMaxH });
    this.kuwa = quad(KUWAHARA, {
      tColor: { value: color }, tNormal: { value: normal }, tDepth: { value: depth }, tTensor: { value: this.tB.texture },
      uFull: { value: new THREE.Vector2() }, uRadius: { value: 3 }, uQ: { value: 8 }, uHard: { value: 8 },
      uZero: { value: 0.58 }, uNear: { value: 0.15 }, uFar: { value: 4200 }, uS, uMaxF, uMaxH,
    });
    this.comp = quad(COMPOSITE, {
      tColor: { value: color }, tNormal: { value: normal }, tDepth: { value: depth }, tPaint: { value: this.kw.texture },
      uHalf: { value: new THREE.Vector2(hw, hh) }, uStrength: { value: this.strength }, uNear: { value: 0.15 }, uFar: { value: 4200 }, uS, uMaxH,
    });
    this.setSize(W, H);
  }

  get materials(): THREE.ShaderMaterial[] {
    return [this.tensor, this.blur, this.kuwa, this.comp].map((q) => q.material as THREE.ShaderMaterial);
  }

  setSize(W: number, H: number): void {
    const hw = Math.max(1, Math.floor(W / 2)), hh = Math.max(1, Math.floor(H / 2));
    for (const t of [this.tA, this.tB, this.kw]) t.setSize(hw, hh);
    this.output.setSize(W, H);
    this.H = H;
    this.W = W;
    this.setScale(this.scale);
    (this.tensor.material as THREE.ShaderMaterial).uniforms.uStep.value.set(1 / hw, 1 / hh);
    (this.blur.material as THREE.ShaderMaterial).uniforms.uStep.value.set(1 / hw, 1 / hh);
    (this.kuwa.material as THREE.ShaderMaterial).uniforms.uFull.value.set(1 / W, 1 / H);
    (this.comp.material as THREE.ShaderMaterial).uniforms.uHalf.value.set(hw, hh);
  }

  /**
   * Draw on the lower-left `s` of every target (the scene was drawn there at the same scale): no
   * reallocation, only viewports and uniforms change.
   */
  setScale(s: number): void {
    this.scale = s;
    const sw = s >= 1 ? this.W : 2 * Math.max(1, Math.round((this.W * s) / 2));
    const sh = s >= 1 ? this.H : 2 * Math.max(1, Math.round((this.H * s) / 2));
    const hw = Math.max(1, Math.floor(this.W / 2)), hh = Math.max(1, Math.floor(this.H / 2));
    this.uS.value.set(sw / this.W, sh / this.H);
    this.uMaxF.value.set((sw - 0.5) / this.W, (sh - 0.5) / this.H);
    this.uMaxH.value.set((sw / 2 - 0.5) / hw, (sh / 2 - 0.5) / hh);
    for (const t of [this.tA, this.tB, this.kw]) t.viewport.set(0, 0, Math.ceil(sw / 2), Math.ceil(sh / 2));
    this.output.viewport.set(0, 0, sw, sh);
  }

  setNear(n: number): void {
    (this.kuwa.material as THREE.ShaderMaterial).uniforms.uNear.value = n;
    (this.comp.material as THREE.ShaderMaterial).uniforms.uNear.value = n;
  }

  /** Run the passes (reads the scene MRT, writes `output`). Returns false when switched off. */
  render(renderer: THREE.WebGLRenderer): boolean {
    if (this.strength <= 0) return false;
    const k = this.kuwa.material as THREE.ShaderMaterial;
    k.uniforms.uRadius.value = Math.min(7, this.radius * Math.max(0.5, this.H / 1080) * this.uS.value.y);
    (this.comp.material as THREE.ShaderMaterial).uniforms.uStrength.value = Math.min(1, this.strength);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.tA);
    this.tensor.render(renderer);
    renderer.setRenderTarget(this.tB);
    this.blur.render(renderer);
    renderer.setRenderTarget(this.kw);
    this.kuwa.render(renderer);
    renderer.setRenderTarget(this.output);
    this.comp.render(renderer);
    renderer.setRenderTarget(prev);
    return true;
  }
}
