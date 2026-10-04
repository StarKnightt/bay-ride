import * as THREE from "three";
import { COMMON, G, REFL } from "../render/materials";
import { ID } from "../world/geo";
import { SEA_Y, roadX } from "../world/bay/road";
import { waterlineU } from "../world/bay/terrain";
import { DEPTH, DEPTH_GLSL } from "./depthMap";
import { WAVES_GLSL } from "./waves";
import { SKIRT_MAX, rockSkirts } from "./rocks";

const OUT = /* glsl */ `
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormal;
uniform float uId;
uniform float uMask;
`;

/** The surf band: a dense displaced strip along the beach, from just above the waterline out to sea. */
export const BAND = { z0: -320, z1: 300, outer: -150, inner: 3 };

/** Coast shape in GLSL (must match road.ts roadX and terrain.ts waterlineU). */
export const COAST_GLSL = /* glsl */ `
float coastRoadX(float z){ return 45.0 * cos(clamp((z + 30.0) / 200.0, -1.0, 1.0) * 1.5707963); }
float coastWaterU(float z){ return -28.0 - 4.0 * sin(z * 0.021 + 0.6) - 2.0 * sin(z * 0.057); }
`;

const VS = /* glsl */ `
  ${COMMON}
  ${DEPTH_GLSL}
  ${WAVES_GLSL}
  in float aEdge;
  out vec3 vWPos;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
#ifdef BAND_MESH
    // The surface settles flat into the last metre of depth and tucks just under the sand: on the
    // beach itself the swash sheet takes over (beach.ts), so the sea never floods the sand.
    float hv = W_SEA - wField(wp.xz).r;
    // The tuck depth wanders along the shore so the meeting line with the sand is never ruled.
    float tuck = 0.035 + 0.05 * vnoise(wp.xz * vec2(0.09, 0.23));
    wp.y += wEta(wp.xz, uTime) * aEdge * smoothstep(0.0, 0.8, hv) - tuck * (1.0 - smoothstep(0.0, 1.0, hv));
#endif
    vWPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const FS = /* glsl */ `
  ${COMMON}
  ${OUT}
  ${DEPTH_GLSL}
  ${WAVES_GLSL}
  ${COAST_GLSL}
  uniform sampler2D uRefl;
  uniform mat4 uReflMat;
  uniform float uReflOn;
  uniform float uReflY;
  uniform vec4 uRocks[${SKIRT_MAX}];
  in vec3 vWPos;

  // Painted caustics on the seabed: wobbly bright filaments where two drifting ridged noises meet
  // (no cells, so they never read like the foam).
  float caustic(vec2 p, float t){
    vec2 w = p * 0.9 + (vec2(vnoise(p * 0.3 + t * 0.2), vnoise(p * 0.3 - t * 0.17 + 5.0)) - 0.5) * 2.4;
    float a = 1.0 - abs(2.0 * vnoise(w + vec2(t * 0.25, -t * 0.1)) - 1.0);
    float b = 1.0 - abs(2.0 * vnoise(w * 1.7 + vec2(-t * 0.3, t * 0.2) + 9.0) - 1.0);
    return pow(a * b, 5.0);
  }

  // Surf on rocks: bursts on the side the waves come from, pulsing as each crest hits, ragged
  // skirts, and streaks trailing off the lee side.
  float rockFoam(vec2 q, vec2 dir, float pulse, float t, float px){
    float f = 0.0;
    vec2 side = vec2(-dir.y, dir.x);
    for (int i = 0; i < ${SKIRT_MAX}; i++) {
      vec4 R = uRocks[i];
      vec2 d = q - R.xy;
      float L = length(d);
      float dd = L - R.z;
      if (dd > 10.0 || R.z <= 0.0) continue;
      vec2 n = d / max(L, 1e-3);
      float face = dot(n, -dir);
      float flank = 1.0 - abs(face);
      float rag = 0.45 + 1.0 * vnoise(vec2(atan(n.y, n.x) * 2.6 + R.w * 7.0, t * 0.5 + R.w));
      // Wide burst on the face the waves hit, wrapping round the flanks, thin on the lee.
      float w = (0.15 + 2.4 * max(face, 0.0) + 0.6 * flank) * (0.3 + 1.4 * pulse) * rag * (0.7 + 0.16 * min(R.z, 5.0));
      float skirt = exp(-max(dd, 0.0) / max(w, 0.05)) * smoothstep(-0.25, 0.05, dd);
      float ax = dot(d, dir), sd = dot(d, side);
      // Streaks trailing off the lee side, drifting shoreward with the water.
      float lee = smoothstep(0.0, R.z, ax) * exp(-max(dd, 0.0) / 7.0) * (1.0 - smoothstep(R.z * 0.5, R.z * 1.6, abs(sd)));
      float st = smoothstep(0.38, 0.72, vnoise(vec2(sd * 1.6 + R.w, ax * 0.3 - t * 0.8)));
      f = max(f, max(skirt * (0.55 + 0.7 * pulse), lee * st * (0.4 + 0.55 * pulse)));
    }
    return f;
  }

  void main(){
#ifdef DISC
    {
      float u = vWPos.x - coastRoadX(vWPos.z) - coastWaterU(vWPos.z);
      if (vWPos.z > ${BAND.z0.toFixed(1)} && vWPos.z < ${BAND.z1.toFixed(1)} && u > ${(BAND.outer + 0.4).toFixed(1)}) discard;
    }
#endif
    vec2 q = vWPos.xz;
    vec3 V = normalize(vWPos - cameraPosition);
    float dist = length(vWPos - cameraPosition);
    float px = sqrt(length(dFdx(q)) * length(dFdy(q)));
    WSurf s = wSurface(q, uTime, px);
    vec3 cW = wCool(uWaterShallow);

    // Painted ripples on top of the swell, calmed with distance so they never alias, and smoothed
    // out inside the foam.
    float near = 1.0 - smoothstep(40.0, 500.0, dist);
    vec2 r1 = vec2(vnoise(q * 0.31 + vec2(uTime * 0.21, uTime * 0.08)), vnoise(q * 0.27 - vec2(uTime * 0.15, -uTime * 0.19) + 7.0)) - 0.5;
    vec2 r2 = vec2(vnoise(q * 1.2 + uTime * 0.45), vnoise(q * 1.05 - uTime * 0.38 + 3.0)) - 0.5;
    vec2 rip = (r1 * (0.06 + 0.1 * near) + r2 * 0.08 * near * near) * (1.0 - 0.6 * s.foam);
    vec2 sl = s.grad * (1.0 - smoothstep(150.0, 900.0, dist) * 0.7);
    vec3 Nw = normalize(vec3(-sl.x + rip.x, 1.0, -sl.y + rip.y));

    float surfY = W_SEA + s.eta;
    // Clear shallows: the seabed seen through the surface, displaced by refraction (the deeper the
    // water and the more the surface tilts, the further the floor shifts).
    float hs = max(surfY - (W_SEA - s.h), 0.0);
    vec3 Rr = refract(V, Nw, 0.75);
    vec2 pb = q + Rr.xz / max(-Rr.y, 0.3) * min(hs, 5.0);
    vec4 Fb = wField(pb);
    float hd = max(surfY - Fb.r, 0.0);
    float seeBed = 1.0 - smoothstep(5.0, 13.0, hd);
    vec3 bed = vec3(0.0);
    if (seeBed > 0.0) {
      float rkeep = 1.0 - smoothstep(0.03, 0.12, px);
      vec3 alb = mix(vec3(0.43, 0.365, 0.23), vec3(0.62, 0.55, 0.33), smoothstep(0.15, 1.2, hd));
      // Sand ripples along the shore (lit crests, shaded troughs), scattered stones and pebbles,
      // patchy weed further out, rocks.
      float rp = sin(dot(pb, vec2(1.0, 0.18)) * 6.5 + vnoise(pb * 0.45) * 7.0);
      alb *= 1.0 + (0.1 * rp + 0.12 * (smoothstep(0.4, 0.9, rp) - 0.3)) * rkeep * smoothstep(0.08, 0.5, hd);
      alb *= 0.88 + 0.24 * vnoise(pb * 0.11);
      float stoneK = smoothstep(0.05, 0.3, hd) * (1.0 - smoothstep(0.06, 0.2, px));
      vec2 sc = floor(pb * 0.7);
      vec2 so = fract(pb * 0.7) - 0.5 - (vec2(hash12(sc + 2.3), hash12(sc + 9.1)) - 0.5) * 0.6;
      float stone = step(0.86, hash12(sc + 5.5)) * (1.0 - smoothstep(0.12, 0.2 + 0.06 * vnoise(pb * 6.0), length(so * vec2(1.0, 1.4))));
      alb = mix(alb, vec3(0.2, 0.2, 0.17) * (0.8 + 0.4 * hash12(sc)), stone * stoneK);
      vec2 sc2 = floor(pb * 2.3);
      vec2 so2 = fract(pb * 2.3) - 0.5 - (vec2(hash12(sc2 + 1.7), hash12(sc2 + 6.2)) - 0.5) * 0.5;
      float peb = step(0.8, hash12(sc2 + 3.3)) * (1.0 - smoothstep(0.1, 0.18, length(so2 * vec2(1.0, 1.3))));
      alb = mix(alb, vec3(0.3, 0.27, 0.21) * (0.7 + 0.5 * hash12(sc2)), peb * stoneK * (1.0 - smoothstep(0.03, 0.08, px)));
      float weed = smoothstep(0.6, 0.7, fbm2(pb * 0.05 + 4.0)) * smoothstep(1.2, 3.0, hd);
      alb = mix(alb, vec3(0.13, 0.17, 0.08), weed * 0.55);
      float rk = smoothstep(0.9, 0.99, Fb.a);
      alb = mix(alb, vec3(0.16, 0.17, 0.13) * (0.75 + 0.5 * vnoise(pb * 1.7)), rk);
      vec3 lit = toonT(alb, vec3(0.0, 1.0, 0.0), vec3(pb.x, Fb.r, pb.y), 0.0, 0.25, 0.0, 0.05, uShadowTint);
      float sunUp = clamp(uSunDir.y * 3.0, 0.0, 1.0) * (1.0 - uNight);
      // Caustics as flat painted filaments of warm light.
      float ca = smoothstep(0.1, 0.24, caustic(pb, uTime)) * smoothstep(0.05, 0.3, hd) * exp(-hd * 0.35) * sunUp * (1.0 - rk * 0.6) * (1.0 - smoothstep(0.08, 0.3, px));
      lit += mix(alb, vec3(1.0, 0.95, 0.75), 0.5) * uSunColor * ca * 0.5;
      bed = lit;
    }
    // Depth colour: sand plain at the edge, yellow-green by ~1 m, the shallow colour, then deep blue.
    float depthK = 1.0 - exp(-hd * 0.2);
    float kb = depthK * 5.0 + vnoise(q * 0.04);
    depthK = mix(depthK, (floor(kb) + smoothstep(0.25, 0.75, fract(kb))) / 5.0, 0.22);
    vec3 bodyCol = mix(cW, uWaterDeep, smoothstep(0.03, 0.95, depthK));
    vec3 tint = cW / max(max(cW.r, max(cW.g, cW.b)), 0.05);
    // Painted stages over the bed, as flat bands with wobbly edges: nearly clear at the edge, a
    // yellow-green stage, then green, then the shallow-water colour. Low sun keeps them cool so
    // the warm light never turns the shallows khaki.
    float warmK = smoothstep(0.08, 0.35, uSunColor.r - uSunColor.b);
    float hw = hd + 0.12 * (vnoise(q * 0.09) - 0.5);
    float f1 = smoothstep(0.05, 0.11, hw), f2 = smoothstep(0.55, 0.7, hw), f3 = smoothstep(1.5, 1.8, hw);
    vec3 st1 = mix(vec3(0.86, 1.0, 0.56), tint * vec3(0.8, 1.0, 0.86), 0.65 * warmK);
    vec3 st2 = tint * vec3(0.78, 1.0, 0.8);
    vec3 wt = mix(mix(mix(vec3(0.97, 1.0, 0.95), st1, f1), st2, f2), tint * 0.88, f3);
    vec3 seen = bed * wt;
    seen = mix(seen, wCool(seen), 0.45 * warmK);
    float clarity = exp(-hd * 0.38) * seeBed;
    vec3 col = mix(bodyCol, seen, clarity);
    // Wave faces turned to the light read a shade lighter, backs a shade darker.
    vec2 Ls = normalize(uSunDir.xz + 1e-5);
    col *= 1.0 + clamp(dot(-sl, Ls) * 2.0, -0.16, 0.16) * (1.0 - uNight * 0.5);
    // Painted swell lines offshore: lighter crests, darker troughs (they show the swell bending).
    float offs = smoothstep(1.5, 5.0, s.h);
    float swk = offs * (1.0 - 0.6 * uNight) * (1.0 - 0.65 * smoothstep(250.0, 1100.0, dist));
    col *= 1.0 + s.swell * 0.2 * swk;
    col = mix(col, cW * 1.12 + 0.04, smoothstep(0.5, 0.95, s.swell) * 0.25 * swk);
    // Light through the thin lip of a steepening crest.
    col = mix(col, cW * 1.3 * mix(vec3(1.0), uSunColor, 0.5) + 0.02, s.crest * 0.55);

    // Mirror: the real scene above the water (sky, clouds, hills, island), broken up by the waves.
    vec3 refl;
    vec2 tilt = rip + sl * 0.6;
    if (uReflOn > 0.5) {
      vec4 rp = uReflMat * vec4(vWPos.x, uReflY, vWPos.z, 1.0);
      vec2 ruv = rp.xy / rp.w + tilt * vec2(0.05, 0.08) * (0.25 + 0.75 * near);
      refl = texture(uRefl, clamp(ruv, 0.001, 0.999)).rgb;
      // In the surf zone the breaking crests stand between the water and distant land, so the
      // shallows mirror only the sky.
      float surfK = 1.0 - smoothstep(2.0, 5.0, s.h);
      if (surfK > 0.0) {
        vec3 R = reflect(V, normalize(vec3(tilt.x * 0.4, 1.0, tilt.y * 0.4)));
        R.y = max(R.y, 0.02);
        refl = mix(refl, skyColor(normalize(R)) * uWorldTint, surfK);
      }
    } else {
      vec3 R = reflect(V, normalize(vec3(tilt.x * 0.4, 1.0, tilt.y * 0.4)));
      R.y = max(R.y, 0.02);
      refl = skyColor(normalize(R)) * uWorldTint;
    }
    float rl = dot(refl, vec3(0.2126, 0.7152, 0.0722));
    refl = mix(vec3(rl), refl, 1.15) * uWaterRefl * mix(0.9, 0.68, uNight);
    refl /= max(uWorldTint, vec3(0.05));
    refl = mix(refl, wCool(refl), 0.55 * (1.0 - smoothstep(0.5, 3.0, s.h)));
    float cosT = max(dot(-V, Nw), 0.0);
    float fres = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
    // Wave faces and the churned surf zone show their own body; the clear shallows let the bed through.
    float rk = (1.0 - s.foam) * (1.0 - 0.85 * clamp(length(sl) * 3.0, 0.0, 1.0)) * (1.0 - 0.75 * s.brk) * mix(0.6, 1.0, smoothstep(0.8, 4.0, s.h));
    // Water a few centimetres deep shows the sand rather than the sky, so the sea fades into the
    // beach's swash sheet with no seam.
    rk *= mix(0.2, 1.0, smoothstep(0.04, 0.5, hd));
    col = mix(col, refl, fres * 0.92 * rk);

    // Glitter path under the sun or moon (see the sky system).
    vec3 Ld = normalize(uGlintDir);
    vec3 H = normalize(Ld - V);
    float c2 = H.y * H.y;
    float tan2 = (1.0 - c2) / max(c2, 1e-4);
    float sig = uGlintShape.x;
    float path = exp(-tan2 / (2.0 * sig * sig)) * smoothstep(-0.02, 0.04, Ld.y);
    vec2 fwd = normalize(V.xz + 1e-5);
    vec2 sq = vec2(dot(q, vec2(-fwd.y, fwd.x)), dot(q, fwd)) / (0.4 + dist * 0.01);
    float dn = vnoise(sq * vec2(0.55, 3.2) + vec2(uTime * 0.5, -uTime * 1.1)) * 0.6
             + vnoise(sq * vec2(1.3, 7.0) + vec2(-uTime * 0.7, uTime * 0.6) + 5.0) * 0.4;
    float th = 1.0 - path * 0.42;
    float dash = smoothstep(th, th + 0.04, dn);
    col += uGlintCol * uGlint * (dash * (0.7 + 1.6 * path) + path * uGlintShape.y) * (1.0 - s.foam) * mix(0.35, 1.0, smoothstep(0.8, 4.0, s.h));

    // Foam: white water of the breaking waves, surf on the rocks, and a skirt of surf where the
    // swell meets the island and headland shores (the beach has its own bores and swash).
    float rf = rockFoam(q, s.dir, s.pulse, uTime, px);
    float u = q.x - coastRoadX(q.y) - coastWaterU(q.y);
    float offBeach = 1.0 - (1.0 - smoothstep(${(BAND.z1 - 60).toFixed(1)}, ${(BAND.z1 - 30).toFixed(1)}, abs(q.y))) * smoothstep(-90.0, -70.0, u);
    float skirt = (1.0 - smoothstep(0.15, 3.2, s.h)) * smoothstep(-0.3, 0.05, s.h) * (0.45 + 0.75 * s.pulse) * offBeach;
    skirt *= 0.6 + 0.8 * vnoise(q * 0.12 + vec2(0.0, uTime * 0.05));
    // Thick on shores facing the swell, a thin trickle in the lee.
    skirt *= mix(0.2, 1.5, smoothstep(-0.5, 0.6, dot(wDir(0), s.up))) * mix(0.5, 1.0, s.expose);
    vec2 fq = q - s.dir * uTime * 0.5;
    float fskirt = wLace(fq * 0.9, skirt, 9.0, px);
    float frock = wLace(vec2(dot(q, s.dir) - uTime * 0.6, dot(q, vec2(-s.dir.y, s.dir.x))) * 1.2, clamp(rf * 1.6, 0.0, 1.0), 5.0, px);
    float foam = max(s.foam, max(frock, fskirt));
    // The last half metre of depth hands over to the beach's swash foam, so the lace carries on
    // across the waterline instead of stopping at it.
#ifdef BAND_MESH
    float hA = 0.02 + max(-u, 0.0) * 0.07;
    if (hA < 0.6 && s.rock < 0.2) {
      WSwash sw = wSwash(q, -s.h, uTime, px);
      foam = mix(sw.foam, foam, max(smoothstep(0.15, 0.6, hA), smoothstep(0.0, 0.2, s.rock)));
    }
#endif
    vec3 Nf = normalize(Nw + vec3(0.0, 1.2, 0.0));
    vec3 foamCol = wFoamColor(normalize(Nf - vec3(0.0, 0.3 * s.crest, 0.0)), q, col, path);
    col = mix(col, foamCol, foam);

    // Lighthouse beam brushing across the water as it turns (open water is a later system).
    if (uBeam > 0.0) {
      vec2 rel = q - uLampPos.xz;
      float rlen = length(rel);
      float al = dot(rel / max(rlen, 1e-3), uBeamDir);
      float sweep = smoothstep(0.975, 0.998, al) * exp(-rlen * 0.004) * smoothstep(8.0, 40.0, rlen);
      col += vec3(1.0, 0.88, 0.62) * sweep * 0.22 * uBeam * (1.0 + foam);
    }
    col = applyFog(col, vWPos);
    // The far sea melts into the horizon haze: sky and sea meet at a soft light line.
    col = mix(col, skyColor(normalize(vec3(V.x, 0.004, V.z))), smoothstep(1800.0, 3800.0, dist) * 0.85);
    gColor = vec4(col, 1.0);
    vec3 vn = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
    gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, 0.0);
  }`;

const SKIRTS = { value: rockSkirts() };

function material(defines: Record<string, string>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, ...DEPTH, ...REFL, uRocks: SKIRTS, uId: { value: ID.water }, uMask: { value: 0 } },
    defines,
    vertexShader: VS,
    fragmentShader: FS,
  });
}

function steps(a: number, b: number, d: number): number[] {
  const out: number[] = [];
  const n = Math.max(1, Math.round((b - a) / d));
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

/** The surf band mesh: rows along the beach, fine across the surf zone, coarser out to sea. */
function buildBand(): THREE.Mesh {
  const offs = [...steps(BAND.outer, -80, 3), ...steps(-80, -45, 0.8), ...steps(-45, BAND.inner, 0.3), BAND.inner];
  const zs = [...steps(BAND.z0, BAND.z1, 0.8), BAND.z1];
  const no = offs.length, nz = zs.length;
  const pos = new Float32Array(no * nz * 3);
  const edge = new Float32Array(no * nz);
  const sm = (a: number, b: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    const x0 = roadX(z) + waterlineU(z);
    for (let i = 0; i < no; i++) {
      const k = j * no + i;
      pos[k * 3] = x0 + offs[i];
      pos[k * 3 + 1] = SEA_Y;
      pos[k * 3 + 2] = z;
      edge[k] = sm(BAND.outer, BAND.outer + 30, offs[i]) * sm(BAND.z0, BAND.z0 + 30, z) * sm(BAND.z1, BAND.z1 - 30, z);
    }
  }
  const idx = new Uint32Array((no - 1) * (nz - 1) * 6);
  let q = 0;
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < no - 1; i++) {
      const a = j * no + i, b = a + 1, c = a + no, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aEdge", new THREE.BufferAttribute(edge, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g, material({ BAND_MESH: "1" }));
  m.frustumCulled = false;
  return m;
}

/**
 * The sea: the surf band along the beach (breaking waves, foam, clear shallows) and a wide disc
 * for the rest of the bay with the same shading (the swell, refracted round the island, breaks
 * on its shore too). Open-water detail is a later system.
 */
export function buildSea(): THREE.Group {
  const grp = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(4000, 96).rotateX(-Math.PI / 2), material({ DISC: "1" }));
  disc.geometry.setAttribute("aEdge", new THREE.BufferAttribute(new Float32Array(disc.geometry.attributes.position.count), 1));
  disc.position.y = SEA_Y;
  disc.frustumCulled = false;
  grp.add(disc, buildBand());
  return grp;
}
