import * as THREE from "three";
import { COMMON, G, OUT } from "../render/materials";
import { ID } from "../world/geo";

/**
 * Flora shading: tall meadow grass (instanced clumps), tree and shrub canopies (leaf cards with
 * sphere-projected normals) and flower clusters (instanced, petal shapes cut in the shader). All
 * share the scene's light, shadow, fog and output layout (COMMON / OUT), so they sit in the same
 * painted world as the uber toon surfaces, at a fraction of its cost.
 */

/** Tunables shared by the flora materials (the GPU pass tunes these live through __ride.world). */
export const FLORA = {
  /** Grass density falloff: full to x m, ~35% by y, ~12% by z, none past w. */
  uGrassFar: { value: new THREE.Vector4(22, 50, 100, 140) },
  /** Quality multiplier on grass density (tiers). */
  uGrassK: { value: 1 },
  /** Flowers shrink away between x and y metres. */
  uFlowerFar: { value: new THREE.Vector2(70, 95) },
  /** Canopy palette: deep pocket multiplier, lit (lime) multiplier, highlight strength. */
  uLeafDeep: { value: new THREE.Vector3(0.2, 0.4, 0.42) },
  uLeafLit: { value: new THREE.Vector3(1.55, 1.5, 0.78) },
  uLeafHi: { value: 0.6 },
  /** Grass: translucency toward the sun and the wind-band lift of the tips. */
  uGrassBack: { value: 0.55 },
  uGrassWave: { value: 0.34 },
};

/**
 * Wind (vertex): the uber's coherent field (same travelling bands, so verge grass, meadow and
 * flowers lean together), a slower broad gust wave rolling across the fields, and her parting push.
 */
export const WIND_GLSL = /* glsl */ `
vec3 windOffset(vec3 wp, float w){
  vec2 d = uWindDir;
  float along = dot(wp.xz, d);
  float wave = sin(along * 0.22 - uTime * 2.1) * 0.5 + 0.5;
  wave = wave * wave;
  float flutter = sin(uTime * 3.3 + dot(wp.xz, vec2(1.7, 2.3))) * 0.12;
  float gust = vnoise(wp.xz * 0.03 - d * uTime * 0.35);
  float k = 0.22 + wave * 0.55 + gust * 0.35 + flutter;
  vec3 o = vec3(d.x, 0.0, d.y) * k * w * 0.34;
  o.y = -w * k * k * 0.08;
  return o;
}
// Broad gust waves rolling across a field (~70 m apart, ~6 m/s, bent by noise): 0..1.
float fieldWave(vec2 xz){
  float along = dot(xz, uWindDir);
  float across = dot(xz, vec2(-uWindDir.y, uWindDir.x));
  float w = sin(along * 0.09 - uTime * 0.55 + vnoise(vec2(across * 0.025, along * 0.01)) * 3.0);
  return smoothstep(0.2, 1.0, w);
}
vec3 pushOffset(vec3 wp, float w){
  if (uPush.w <= 0.0) return vec3(0.0);
  vec2 pd = wp.xz - uPush.xy;
  float pl = length(pd);
  float pf = (1.0 - smoothstep(uPush.z * 0.35, uPush.z, pl)) * uPush.w * min(w, 1.0);
  return vec3(pd.x / max(pl, 1e-3) * pf * 0.45, -pf * 0.12, pd.y / max(pl, 1e-3) * pf * 0.45);
}
`;

const FLORA_UNI = /* glsl */ `
uniform vec4 uGrassFar;
uniform float uGrassK;
uniform vec2 uFlowerFar;
uniform vec3 uLeafDeep;
uniform vec3 uLeafLit;
uniform float uLeafHi;
uniform float uGrassBack;
uniform float uGrassWave;
`;

// ------------------------------------------------------------------ meadow grass

const MEADOW_VS = /* glsl */ `
${COMMON}
${FLORA_UNI}
${WIND_GLSL}
in vec2 aEdge;
in vec4 aOff;   // world x, y, z, yaw
in vec4 aVar;   // height (m), width scale, hue 0..1, rank 0..1
out vec3 vWPos;
out vec3 vN;
out vec3 vCol;
out float vTip;
out float vHue;
out float vWave;
void main(){
  vec3 root = aOff.xyz;
  float d = distance(root, cameraPosition);
  // Density by distance: an instance whose rank is above the local density folds into the ground.
  float dens = uGrassK * (1.0 - 0.65 * smoothstep(uGrassFar.x, uGrassFar.y, d)
                              - 0.23 * smoothstep(uGrassFar.y, uGrassFar.z, d)
                              - 0.12 * smoothstep(uGrassFar.z, uGrassFar.w, d));
  float keep = smoothstep(aVar.w, aVar.w + 0.07, dens) * smoothstep(0.4, 1.3, d);
  float h = aVar.x * keep;
  // Thinned far off, so the blades that stay grow wider and keep the field's cover.
  float wd = aVar.y * (1.0 + d * 0.022);
  float c = cos(aOff.w), s = sin(aOff.w);
  mat2 rot = mat2(c, s, -s, c);
  vec3 q = position * h;
  q.xz += aEdge * h * wd;
  q.xz = rot * q.xz;
  vec3 wp = root + q;
  float tip = clamp(position.y, 0.0, 1.0);
  float w = pow(tip, 1.5) * h;
  float fw = fieldWave(root.xz);
  wp += windOffset(wp, w) * (1.0 + fw * 0.9) + vec3(uWindDir.x, 0.0, uWindDir.y) * fw * w * 0.12;
  wp += pushOffset(wp, w * 2.0);
  vec2 nxz = rot * normal.xz;
  vN = normalize(vec3(nxz.x, normal.y, nxz.y));
  vWPos = wp;
  vCol = color;
  vTip = tip;
  vHue = aVar.z;
  vWave = fw;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (keep < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const MEADOW_FS = /* glsl */ `
${COMMON}
${OUT}
${FLORA_UNI}
in vec3 vWPos;
in vec3 vN;
in vec3 vCol;
in float vTip;
in float vHue;
in float vWave;
void main(){
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  // Soft up-facing normals: the field shades as painted drifts, not blade by blade.
  vec3 Ns = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.55));
  vec3 base = vCol * mix(vec3(0.86, 1.0, 1.1), vec3(1.2, 1.1, 0.7), vHue);
  // Big painted drifts: warmer yellow-green swathes and cooler blue-green hollows.
  float pn = vnoise(vWPos.xz * 0.045 + 3.1);
  base *= mix(vec3(0.92, 1.0, 1.08), vec3(1.12, 1.06, 0.8), smoothstep(0.35, 0.75, pn));
  // Travelling gust bands lift the leaning tips.
  float wv = sin(dot(vWPos.xz, uWindDir) * 0.22 - uTime * 2.1) * 0.5 + 0.5;
  base *= 1.0 + (smoothstep(0.55, 1.0, wv) * 0.6 + vWave) * vTip * uGrassWave;
  gFastShadow = true;
  float sv = shadowVis(vWPos, Ns);
  float ndl = dot(Ns, uSunDir);
  float lit = smoothstep(-0.12, 0.2, ndl + (vTip - 0.5) * 0.3) * sv;
  // A low sun warms the tips; the blades' body keeps its green (the light's level, part of its hue).
  float sunL = dot(uSunColor, vec3(0.2126, 0.7152, 0.0722));
  vec3 cLit = base * mix(vec3(sunL), uSunColor, 0.38 + 0.55 * vTip * vTip);
  vec3 cSh = base * uShadowTint * vec3(0.92, 1.0, 1.05);
  vec3 col = mix(cSh, cLit, lit);
  // Darker down among the roots, bright tips.
  col *= mix(0.5, 1.0, smoothstep(0.0, 0.6, vTip));
  col += base * uSkyMid * 0.08;
  // Sunlight through the blades when looking toward the sun (tips glow yellow-green).
  vec3 V = normalize(cameraPosition - vWPos);
  float back = pow(max(dot(-V, uSunDir), 0.0), 3.0);
  col += base * uSunColor * vec3(0.95, 1.0, 0.42) * back * vTip * uGrassBack * sv;
  col *= 1.0 - 0.2 * uNight;
  col = applyFog(col, vWPos);
  writeOut(col, Ns, -1.0);
}
`;

// ------------------------------------------------------------------ the field under and beyond the grass

/**
 * The grass-covered terrain (the hill, the headland tops): the meadow's own drifts continued past
 * the blades' reach, broad cool hollows and lime swathes that read from the bay, brush strokes
 * along the contours at two scales (faded by pixel footprint), and the meadow's lighting, so the
 * greens keep their hue under a low sun (only the lit ridges take its warmth).
 */
const GROUND_VS = /* glsl */ `
${COMMON}
out vec3 vWPos;
out vec3 vN;
out vec3 vCol;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vCol = color;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GROUND_FS = /* glsl */ `
${COMMON}
${OUT}
${FLORA_UNI}
in vec3 vWPos;
in vec3 vN;
in vec3 vCol;
void main(){
  gFoot = max(length(dFdx(vWPos)), length(dFdy(vWPos)));
  vec3 N = normalize(vN);
  vec3 base = vCol;
  // Worn footpaths are painted warm into the vertex colour: they keep it.
  float pathK = smoothstep(-0.01, 0.06, base.r - base.g);
  float pn = vnoise(vWPos.xz * 0.045 + 3.1);
  vec3 g = base * mix(vec3(0.92, 1.0, 1.08), vec3(1.12, 1.06, 0.8), smoothstep(0.35, 0.75, pn));
  float big = vnoise(vWPos.xz * 0.011 + 7.0) * 0.65 + vnoise(vWPos.xz * 0.027 + 2.0) * 0.35;
  g *= mix(vec3(0.56, 0.72, 0.86), vec3(1.1, 1.08, 0.78), smoothstep(0.3, 0.7, big));
  float mid = vnoise(vWPos.xz * 0.06 + 1.7);
  g *= mix(vec3(0.8, 0.88, 0.95), vec3(1.05, 1.04, 0.92), smoothstep(0.25, 0.75, mid));
  // Strokes along the contour (the slope's level direction), small near and broad far.
  vec2 ct = normalize(vec2(-N.z, N.x) + vec2(0.25, 0.05));
  vec2 q = vec2(dot(vWPos.xz, ct), dot(vWPos.xz, vec2(-ct.y, ct.x)));
  float s1 = vnoise(q * vec2(0.42, 2.1));
  float s2 = vnoise(q * vec2(0.08, 0.42) + 11.0);
  float k1 = 1.0 - smoothstep(0.12, 0.5, gFoot);
  float k2 = 1.0 - smoothstep(1.2, 4.0, gFoot);
  float st = (s1 - 0.5) * 0.42 * k1 + (s2 - 0.5) * 0.36 * k2;
  g *= 1.0 + st;
  // Flecks of lime tips and dark tufts where the blades thin out.
  float fl = vnoise(vWPos.xz * 1.3 + vec2(s1 * 1.5, 0.0));
  g = mix(g, g * vec3(1.22, 1.2, 0.78), smoothstep(0.7, 0.8, fl) * k1 * 0.5);
  g = mix(g, g * vec3(0.62, 0.74, 0.82), smoothstep(0.3, 0.2, fl) * k1 * 0.5);
  g = mix(g, base * (0.9 + 0.2 * s1), pathK);
  // Full shadow filtering only where a pixel is small enough to show its stair steps.
  gFastShadow = gFoot > 0.12;
  float sv = shadowVis(vWPos, N);
  float ndl = dot(N, uSunDir);
  float lit = smoothstep(-0.06, 0.22, ndl + st * 0.4) * sv;
  float sunL = dot(uSunColor, vec3(0.2126, 0.7152, 0.0722));
  vec3 cLit = g * mix(vec3(sunL), uSunColor, mix(0.38, 1.0, pathK)) * mix(0.86, 1.0, pathK);
  cLit += g * uSunColor * 0.22 * smoothstep(0.45, 0.85, ndl) * (1.0 - pathK);
  vec3 cSh = g * uShadowTint * vec3(0.86, 1.0, 1.12);
  vec3 col = mix(cSh, cLit, lit);
  col += g * uSkyMid * 0.1 * (N.y * 0.5 + 0.5);
  col *= 1.0 - 0.15 * uNight;
  col = applyFog(col, vWPos);
  writeOut(col, N, uMask);
}
`;

// ------------------------------------------------------------------ canopies

const FOLIAGE_VS = /* glsl */ `
${COMMON}
in float aMat;
in float aWind;
out vec3 vWPos;
out vec3 vN;
out vec3 vCol;
out vec2 vUv;
flat out int vMat;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  int mt = int(aMat + 0.5);
  if (aWind > 0.0) {
    // The crown sways as a whole with the gusts; leaf cards flutter on top of that.
    float ph = dot(wp.xz, vec2(0.11, 0.07));
    float gust = vnoise(wp.xz * 0.02 - uWindDir * uTime * 0.3);
    float sway = sin(uTime * 1.1 + ph) * 0.55 + sin(uTime * 2.3 + ph * 1.7) * 0.2 + gust * 0.85;
    wp.xz += uWindDir * sway * aWind * 0.14;
    float card = (mt == 17 || mt == 21) ? 1.0 : 0.0;
    float fp = dot(wp.xyz, vec3(2.1, 1.3, 1.7));
    wp.xyz += vec3(sin(uTime * 4.7 + fp), sin(uTime * 5.3 + fp * 1.3), cos(uTime * 4.1 + fp * 0.7)) * aWind * 0.022 * card;
  }
  vWPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vCol = color;
  vUv = uv;
  vMat = mt;
  gl_Position = projectionMatrix * viewMatrix * wp;
  if (mt == 21 && uNoFringe > 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FOLIAGE_FS = /* glsl */ `
${COMMON}
${OUT}
${FLORA_UNI}
in vec3 vWPos;
in vec3 vN;
in vec3 vCol;
in vec2 vUv;
flat in int vMat;
void main(){
  gFoot = max(length(dFdx(vWPos)), length(dFdy(vWPos)));
  vec3 N = normalize(vN);
  vec3 base = vCol;
  if (vMat == 9) {
    // Bark: vertical streaks, inked like the other wood.
    if (!gl_FrontFacing) N = -N;
    base *= 0.85 + 0.3 * vnoise(vec2(vWPos.x * 3.0 + vWPos.z * 3.0, vWPos.y * 0.8));
    vec3 c = toon(base, N, vWPos, 0.0, 1.1, 0.3, 0.03);
    writeOut(applyFog(c, vWPos), N, 1.0);
    return;
  }
  float tone = 0.32, lvar = 0.5;
  if (vMat == 17 || vMat == 21) {
    vec4 lt = texture(uLeafTex, vUv);
    float a = clamp((lt.a - 0.5) / max(fwidth(lt.a), 1e-3) + 0.5, 0.0, 1.0);
    if (a < 0.02) discard;
    // Cards brushing past the lens fade out through coverage.
    gAlpha = a * smoothstep(0.3, 1.0, distance(vWPos, cameraPosition));
    tone = lt.r;
    lvar = lt.g;
  } else if (!gl_FrontFacing) N = -N;
  gFastShadow = true;
  float sv = shadowVis(vWPos, N);
  float ndl = dot(N, uSunDir);
  float t = ndl + (tone - 0.5) * 0.55 + (lvar - 0.5) * 0.16;
  float lit = smoothstep(-0.02, 0.14, t) * sv;
  float mid = smoothstep(-0.6, -0.32, t);
  // Painted volume: dark teal-green pockets, a mid green, lime on the sunlit shell.
  vec3 cDeep = vec3(base.r * uLeafDeep.x, base.g * uLeafDeep.y, base.g * uLeafDeep.z + base.b * 0.25);
  vec3 cMid = base * vec3(0.8, 0.92, 0.96);
  float sunL = dot(uSunColor, vec3(0.2126, 0.7152, 0.0722));
  vec3 cLit = base * uLeafLit * mix(vec3(sunL), uSunColor, 0.42);
  vec3 col = mix(cDeep, cMid, mid);
  col = mix(col, cLit, lit);
  // Each leaf's sunlit edge: a crisp bright touch on the light side of the crown.
  float hi = lit * smoothstep(0.7, 0.95, tone) * smoothstep(0.2, 0.7, ndl);
  col = mix(col, base * uLeafLit * vec3(1.35, 1.35, 1.2) * uSunColor, hi * uLeafHi);
  // Sunlight through the leaves at the silhouette, looking toward the sun.
  vec3 V = normalize(cameraPosition - vWPos);
  float back = pow(max(dot(-V, uSunDir), 0.0), 4.0) * (1.0 - smoothstep(0.1, 0.8, ndl));
  col += base * vec3(0.6, 0.8, 0.2) * uSunColor * back * 0.6 * sv;
  // Sky fill on the upper shell, a touch of warm bounce underneath.
  col += base * uSkyMid * 0.1 * max(N.y, 0.0) + base * vec3(0.05, 0.035, 0.0) * max(-N.y, 0.0);
  col *= 1.0 - 0.15 * uNight;
  col = applyFog(col, vWPos);
  writeOut(col, N, -1.0);
}
`;

// ------------------------------------------------------------------ flowers

/**
 * Flower parts (aPart): 0 stem / leaf blade, 1 daisy, 2 cup bloom (poppy, cosmos), 3 floret
 * (lavender, thrift spike), 4 pom (thrift head, hydrangea), 5 star (buttercup, tansy), 6 leaf card.
 */
const FLOWER_VS = /* glsl */ `
${COMMON}
${FLORA_UNI}
${WIND_GLSL}
in float aPart;
in float aWind;
in vec4 aOff;   // world x, y, z, yaw
in vec4 aTint;  // petal tint rgb, scale
out vec3 vWPos;
out vec3 vN;
out vec3 vCol;
out vec2 vUv;
flat out int vPart;
void main(){
  float d = distance(aOff.xyz, cameraPosition);
  float k = aTint.w * (1.0 - smoothstep(uFlowerFar.x, uFlowerFar.y, d)) * smoothstep(0.25, 0.8, d);
  float c = cos(aOff.w), s = sin(aOff.w);
  mat2 rot = mat2(c, s, -s, c);
  vec3 q = position * k;
  q.xz = rot * q.xz;
  vec3 wp = aOff.xyz + q;
  float w = aWind * k;
  wp += windOffset(wp, w) * 0.85 + pushOffset(wp, w * 2.5);
  vec2 nxz = rot * normal.xz;
  vN = normalize(vec3(nxz.x, normal.y, nxz.y));
  vWPos = wp;
  int part = int(aPart + 0.5);
  vCol = (part >= 1 && part <= 5) ? color * aTint.rgb : color;
  vUv = uv;
  vPart = part;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (k < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FLOWER_FS = /* glsl */ `
${COMMON}
${OUT}
${FLORA_UNI}
in vec3 vWPos;
in vec3 vN;
in vec3 vCol;
in vec2 vUv;
flat in int vPart;
// Petal outline of each bloom kind: > 0 inside (in uv units), r = distance from the centre.
float petalEdge(int p, vec2 d, out float r){
  r = length(d);
  float th = atan(d.y, d.x);
  if (p == 1) return 0.2 + 0.26 * pow(abs(cos(th * 6.0)), 0.55) - r;
  if (p == 2) return 0.34 + 0.12 * cos(th * 5.0) - r;
  if (p == 3) return 0.28 + 0.16 * cos(th * 4.0) - r;
  if (p == 4) return 0.4 + 0.05 * sin(th * 9.0) + 0.03 * sin(th * 23.0) - r;
  return 0.09 + 0.38 * pow(0.5 + 0.5 * cos(th * 5.0), 2.6) - r;
}
void main(){
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 base = vCol;
  int p = vPart;
  float petal = 0.0;
  if (p == 6) {
    vec4 lt = texture(uLeafTex, vUv);
    float a = clamp((lt.a - 0.5) / max(fwidth(lt.a), 1e-3) + 0.5, 0.0, 1.0);
    if (a < 0.02) discard;
    gAlpha = a;
    base *= mix(0.55, 1.35, lt.r);
  } else if (p >= 1) {
    vec2 d = vUv - 0.5;
    float r;
    float e = petalEdge(p, d, r);
    float a = clamp(e / max(fwidth(e), 1e-4) + 0.5, 0.0, 1.0);
    if (a < 0.02) discard;
    gAlpha = a;
    petal = 1.0;
    // Painted petals: lighter toward the rim, a darker throat; daisies and stars get a golden eye.
    base *= 0.8 + 0.35 * smoothstep(0.05, 0.4, r);
    if (p == 1 || p == 5) base = mix(vec3(0.95, 0.55, 0.05), base, smoothstep(0.08, 0.115, r));
    if (p == 2) base = mix(vec3(0.07, 0.03, 0.03), base, smoothstep(0.05, 0.09, r));
    if (p == 4) base *= 0.85 + 0.3 * hash12(floor(vUv * 9.0));
    N = normalize(mix(N, vec3(0.0, 1.0, 0.0), 0.5));
  }
  gFastShadow = true;
  float sv = shadowVis(vWPos, N);
  float ndl = dot(N, uSunDir);
  float lit = smoothstep(-0.2, 0.25, ndl) * sv;
  vec3 cSh = base * uShadowTint * mix(1.0, 1.15, petal);
  vec3 col = mix(cSh, base * uSunColor, lit);
  col += base * uSkyMid * 0.1;
  vec3 V = normalize(cameraPosition - vWPos);
  col += base * uSunColor * pow(max(dot(-V, uSunDir), 0.0), 3.0) * 0.4 * sv;
  if (p == 0) col *= mix(0.6, 1.0, smoothstep(0.0, 0.3, vUv.y));
  col *= 1.0 - 0.2 * uNight;
  col = applyFog(col, vWPos);
  writeOut(col, N, -1.0);
}
`;

const uniforms = () => ({ ...G, ...FLORA, uId: { value: 0 }, uMask: { value: -1 } });

export function meadowMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...uniforms(), uId: { value: ID.grass } },
    vertexShader: MEADOW_VS,
    fragmentShader: MEADOW_FS,
    vertexColors: true,
    side: THREE.DoubleSide,
  });
  m.name = "meadow";
  return m;
}

export function fieldMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...uniforms(), uId: { value: ID.ground }, uMask: { value: 0.6 } },
    vertexShader: GROUND_VS,
    fragmentShader: GROUND_FS,
    vertexColors: true,
  });
  m.name = "field";
  return m;
}

export function foliageMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...uniforms(), uId: { value: ID.tree } },
    vertexShader: FOLIAGE_VS,
    fragmentShader: FOLIAGE_FS,
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
  });
  m.name = "foliage";
  return m;
}

export function flowerMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...uniforms(), uId: { value: ID.flower } },
    vertexShader: FLOWER_VS,
    fragmentShader: FLOWER_FS,
    vertexColors: true,
    side: THREE.DoubleSide,
    alphaToCoverage: true,
  });
  m.name = "flowers";
  return m;
}
