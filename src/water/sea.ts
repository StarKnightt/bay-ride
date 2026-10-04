import * as THREE from "three";
import { COMMON, G, REFL } from "../render/materials";
import { ID } from "../world/geo";
import { SEA_Y, roadX } from "../world/bay/road";
import { waterlineU } from "../world/bay/terrain";
import { DEPTH, DEPTH_GLSL } from "./depthMap";
import { WAVES_GLSL } from "./waves";
import { SKIRT_MAX, rockSkirts } from "./rocks";
import { BUOY_MAX, BUOY_U } from "./buoys";

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

/** Open-sea grid: follows the camera in steps of this many metres. */
const GRID_SNAP = 8;
const GRID_UNIFORM = { value: new THREE.Vector2() };

const VS = /* glsl */ `
  ${COMMON}
  ${DEPTH_GLSL}
  ${WAVES_GLSL}
  uniform vec2 uGridO;
  out vec3 vWPos;
  out vec2 vFoc;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
#ifdef DISC
    wp.xz += uGridO;
    wp.y = W_SEA;
#endif
    // The swell and the longer chop move the surface (the same height the water query returns);
    // far out the mesh is too coarse to carry them and the shading alone draws the waves.
    float camK = 1.0 - smoothstep(280.0, 650.0, length(wp.xz - cameraPosition.xz));
    float hv = W_SEA - wField(wp.xz).r;
#ifdef BAND_MESH
    // The surface settles flat into the last metre of depth and tucks just under the sand: on the
    // beach itself the swash sheet takes over (beach.ts), so the sea never floods the sand.
    // The tuck depth wanders along the shore so the meeting line with the sand is never ruled.
    float tuck = 0.035 + 0.05 * vnoise(wp.xz * vec2(0.09, 0.23)) + 0.22 * smoothstep(0.25, 0.85, vnoise(vec2(wp.z * 0.03, wp.x * 0.05 + 2.0))) + 0.08 * vnoise(vec2(wp.z * 0.09, 4.0));
    wp.y += wEta(wp.xz, uTime) * camK * smoothstep(0.0, 0.8, hv) - tuck * (1.0 - smoothstep(0.0, 1.0, hv));
#else
    if (camK > 0.0) wp.y += wEta(wp.xz, uTime) * camK * smoothstep(0.0, 0.8, hv);
#endif
    vWPos = wp.xyz;
    vFoc = vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
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
  uniform vec4 uBuoys[${BUOY_MAX}];
  in vec3 vWPos;
  in vec2 vFoc;

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

  // Foam round the buoys: a thin collar that swells as they heave, and a short broken streak
  // trailing downwind.
  // Also returns rings: light ripple rings spreading as the buoy bobs, and contact: the darker
  // water right at the waterline.
  float buoyFoam(vec2 q, float t, out float rings, out float contact){
    float f = 0.0;
    rings = 0.0; contact = 0.0;
    vec2 side = vec2(-O_WIND.y, O_WIND.x);
    for (int i = 0; i < ${BUOY_MAX}; i++) {
      vec4 B = uBuoys[i];
      vec2 d = q - B.xy;
      float L = length(d);
      if (L > 7.0 || B.z <= 0.0) continue;
      float an = atan(d.y, d.x);
      float ring = exp(-max(L - B.z, 0.0) / (0.3 + 0.45 * abs(B.w))) * smoothstep(B.z - 0.12, B.z + 0.02, L);
      ring *= 0.55 + 0.6 * vnoise(vec2(an * 2.2 + float(i) * 5.0, t * 0.7));
      contact = max(contact, 1.0 - smoothstep(B.z, B.z + 0.6, L));
      // Two or three rings travelling out from the hull, fading as they spread.
      float r = L - B.z;
      float ph = fract(r / 1.3 - t * 0.55 + float(i) * 0.37);
      float rr = (1.0 - smoothstep(0.0, 0.12, abs(ph - 0.5))) * (1.0 - smoothstep(0.5, 4.5, r)) * smoothstep(0.1, 0.4, r);
      rings = max(rings, rr * smoothstep(0.3, 0.6, vnoise(vec2(an * 3.0 + float(i), r * 0.6 - t * 0.4))));
      float ax = dot(d, O_WIND), sd = dot(d, side);
      float lee = smoothstep(0.2, 1.2, ax) * exp(-ax / 3.0) * (1.0 - smoothstep(0.4, 1.0, abs(sd) / (B.z + 0.18 * ax)));
      lee *= smoothstep(0.35, 0.7, vnoise(vec2(sd * 3.0 + float(i), ax * 0.9 - t * 1.1)));
      f = max(f, max(ring, lee * 0.6));
    }
    return f;
  }

  // View-anchored cells over the water: rows by depression angle (somewhat narrower toward the horizon),
  // a whole number of columns round the viewer in each row, so the ring closes with no seam.
  // Painted marks drawn in them keep a steady on-screen shape and stay put when the camera turns.
  // Returns the continuous cell coordinates (fract = position in the cell) and the cell id.
  vec2 oFan(vec3 V, float rowH, float colW, float scroll, out vec2 id){
    float dep = max(-V.y, 1e-4) / max(length(V.xz), 1e-4);
    float v = pow(dep, 0.75) / rowH + scroll;
    float row = floor(v);
    float rc = pow(max((row - scroll + 0.5) * rowH, rowH * 0.5), 1.0 / 3.0);
    float N = max(floor(6.2831853 / (colW * rc)), 3.0);
    float a = (atan(V.z, V.x) / 6.2831853 + 0.5) * N;
    float col = floor(a);
    if (col >= N) col -= N;
    id = vec2(col, row);
    return vec2(a, v);
  }
  // A flat lens-shaped dab in a cell (pointed ends left and right). r = half size in cell units.
  float oLens(vec2 f, vec2 c, vec2 r, vec2 aa){
    vec2 d = (f - c) / r;
    float w = max(aa.x / r.x, aa.y / r.y) * 0.9 + 0.03;
    float e = abs(d.y) - (1.0 - d.x * d.x);
    return 1.0 - smoothstep(-w, w, max(e, abs(d.x) - 1.0));
  }
  // Painted ripple marks on water whose chop is too fine to draw: sparse lens dabs that open and
  // close over a few seconds, mostly darker (facets turned to the viewer show the higher sky and
  // the water body), a few lighter. Signed: + dark, - light.
  float oFanDabs(vec3 V, float t, float gust){
    float s = 0.0;
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      vec2 id;
      vec2 F = oFan(V, k == 0 ? 0.034 : 0.021, k == 0 ? 0.5 : 0.32, 0.0, id);
      vec2 aa = vec2(fwidth(F.x), fwidth(F.y));
      vec2 f = fract(F);
      float per = 4.5 + 3.5 * hash12(id + 1.7 + fk * 9.0);
      float cyc = t / per + hash12(id + 4.1 + fk * 9.0) * 9.0;
      float n = floor(cyc), life = fract(cyc);
      vec2 hid = id + n * vec2(3.17, 1.91) + fk * 13.0;
      if (hash12(hid) > 0.2 + 0.2 * gust) continue;
      vec2 c = vec2(0.32 + 0.36 * hash12(hid + 2.0), 0.36 + 0.28 * hash12(hid + 5.0));
      float g = sin(3.14159 * life);
      vec2 r = vec2(0.16 + 0.18 * hash12(hid + 7.0), 0.09 + 0.07 * hash12(hid + 8.0)) * (0.45 + 0.55 * g);
      float m = oLens(f, c, r, aa) * smoothstep(0.0, 0.25, g);
      s += m * (hash12(hid + 11.0) < 0.3 ? 0.6 : -1.0) * (1.0 - 0.25 * fk);
    }
    return clamp(s, -1.0, 1.0);
  }
  // Stochastic glitter where the chop is too fine to draw: each cell is one wave facet with a
  // random slope (spread sig round the mean slope g0) that turns slowly; it flashes as a flat dab
  // when it mirrors the light (needed slope sH) into the eye.
  float oFanGlint(vec3 V, float t, vec2 g0, vec2 sH, float sig, float rad){
    float best = 0.0;
    for (int k = 0; k < 3; k++) {
      vec2 id;
      vec2 F = oFan(V, k == 0 ? 0.016 : k == 1 ? 0.0105 : 0.0072, k == 0 ? 0.17 : k == 1 ? 0.115 : 0.08, -t * (0.3 + 0.12 * float(k)), id);
      vec2 aa = vec2(fwidth(F.x), fwidth(F.y));
      vec2 f = fract(F);
      vec2 hid = id + float(k) * 31.0;
      float h1 = hash12(hid + 0.5), h2 = hash12(hid + 3.3), h3 = hash12(hid + 6.1), h4 = hash12(hid + 9.7);
      vec2 gs = sqrt(-2.0 * log(max(h1, 1e-4))) * vec2(cos(6.2831853 * h2), sin(6.2831853 * h2));
      float ph = t * (0.2 + 0.4 * h4) + h3 * 6.2831853;
      gs = mat2(cos(ph), sin(ph), -sin(ph), cos(ph)) * gs;
      float e = length(g0 + gs * sig - sH);
      float m = 1.0 - smoothstep(rad * 0.45, rad, e);
      if (m <= 0.0) continue;
      vec2 c = vec2(0.3 + 0.4 * h3, 0.36 + 0.28 * h4);
      vec2 r = vec2(0.16 + 0.12 * h1, 0.2 + 0.12 * h2) * (0.5 + 0.5 * m);
      best = max(best, m * oLens(f, c, r, aa));
    }
    return best;
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
    vec2 dqx = dFdx(q), dqy = dFdy(q);
    float px = sqrt(length(dqx) * length(dqy));
    float pxM = max(length(dqx), length(dqy));
    WSurf s = wSurface(q, uTime, px);
    vec3 cW = wCool(uWaterShallow);
    vec2 fwd = normalize(V.xz + 1e-5);
    vec2 side = vec2(-fwd.y, fwd.x);

    // Open water: wind chop over the swell, fading out over the surf zone (the breakers own it).
    float deepK = oDeep(s.h);
    // Away from the beach (harbour, island shores) the chop's painted strokes carry on over the
    // shallows; only the surf in front of the beach stays free of it.
    float u = q.x - coastRoadX(q.y) - coastWaterU(q.y);
    float offBeach = 1.0 - (1.0 - smoothstep(${(BAND.z1 - 60).toFixed(1)}, ${(BAND.z1 - 30).toFixed(1)}, abs(q.y))) * smoothstep(-90.0, -70.0, u);
    float chopK = max(deepK, smoothstep(0.6, 2.5, s.h) * (1.0 - smoothstep(0.05, 0.3, s.brk + s.foam)) * offBeach * 0.75);
    // Near the eye the chop is drawn bolder; far off it melts into one smooth reflective band.
    float nearK = 1.0 - smoothstep(25.0, 160.0, dist);
    float farK = smoothstep(260.0, 1000.0, dist);
    // Gusts roughen the chop in slow drifting patches with glassier water between them.
    vec2 gq = q - O_WIND * uTime * 2.5;
    float gust = 0.4 + 1.0 * smoothstep(0.3, 0.72, vnoise(gq * 0.0045 + 3.0) * 0.65 + vnoise(gq * 0.013 + 7.0) * 0.35);
    float resV, lostV;
    vec2 gC = oChopGrad(q, uTime, pxM, gust, resV, lostV) * chopK * (1.0 + 0.7 * nearK);
    resV *= chopK * chopK; lostV *= chopK * chopK;
    float sigR = sqrt(resV);
    float lostF = lostV / max(lostV + resV, 1e-6);

    // Painted ripples on top of the swell in the shallows, calmed with distance so they never
    // alias, and smoothed out inside the foam.
    float near = 1.0 - smoothstep(40.0, 500.0, dist);
    vec2 r1 = vec2(vnoise(q * 0.31 + vec2(uTime * 0.21, uTime * 0.08)), vnoise(q * 0.27 - vec2(uTime * 0.15, -uTime * 0.19) + 7.0)) - 0.5;
    vec2 r2 = vec2(vnoise(q * 1.2 + uTime * 0.45), vnoise(q * 1.05 - uTime * 0.38 + 3.0)) - 0.5;
    vec2 rip = (r1 * (0.06 + 0.1 * near) + r2 * 0.08 * near * near) * (1.0 - 0.6 * s.foam) * (1.0 - 0.8 * deepK);
    vec2 sl = s.grad * (1.0 - smoothstep(150.0, 900.0, dist) * 0.7);
    // Painted chop: the slope toward the viewer is flattened into three tones with soft clean
    // edges, so the facets read as brushed strokes rather than a noisy normal map.
    float tv = dot(gC, fwd) / max(sigR, 0.004);
    float aw = fwidth(tv) * 1.5 + 0.1;
    // Tones wider than the filter can hold fade to flat instead of shimmering.
    float tone = (smoothstep(0.55 - aw, 0.55 + aw, tv) - smoothstep(0.55 - aw, 0.55 + aw, -tv)) * (1.0 - smoothstep(0.6, 1.4, aw)) * (1.0 - farK);
    vec2 gU = mix(gC, fwd * tone * sigR * 1.3 + side * dot(gC, side) * 0.6, 0.7) * (1.0 - farK);
    // Near the eye, short horizontal ripple bands break the mirrored sky into strokes.
    float band = 0.0;
    float bandK = (1.0 - smoothstep(60.0, 420.0, dist)) * (1.0 - smoothstep(0.35, 1.1, pxM)) * chopK;
    if (bandK > 0.0) {
      vec2 rq = q - cameraPosition.xz;
      float bn = vnoise(vec2(dot(rq, side) * 0.22, dot(rq, fwd) * 1.7) + vec2(uTime * 0.15, -uTime * 0.5));
      band = (smoothstep(0.58, 0.66, bn) - 0.7 * smoothstep(0.34, 0.26, bn)) * bandK * (0.6 + 0.4 * gust);
      gU += fwd * band * 0.05 * nearK;
    }
    // Mid-distance, where the chop is too fine to draw, sparse painted comma strokes stand in for
    // it; they are gone before the far band, which stays one smooth gradient.
    float dabs = 0.0;
    float dabK = chopK * mix(0.6, 1.0, lostF) * smoothstep(0.012, 0.03, -V.y) * (1.0 - smoothstep(320.0, 900.0, dist));
    if (dabK > 0.01) dabs = oFanDabs(V, uTime, gust) * dabK;
    gU += fwd * dabs * 0.06;
    vec3 Nw = normalize(vec3(-(sl.x + gU.x) + rip.x, 1.0, -(sl.y + gU.y) + rip.y));

    float surfY = W_SEA + s.eta;
    // Clear shallows: the seabed seen through the surface, displaced by refraction (the deeper the
    // water and the more the surface tilts, the further the floor shifts).
    float hs = max(surfY - (W_SEA - s.h), 0.0);
    vec3 Rr = refract(V, Nw, 0.75);
    vec2 pb = q + Rr.xz / max(-Rr.y, 0.3) * min(hs, 5.0);
    vec4 Fb = wField(pb);
    float hd = max(surfY - Fb.r, 0.0);
    float seeBed = 1.0 - smoothstep(4.0, 9.0, hd);
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
      // The thin water at the edge matches the beach's clear film over wet sand; the bed brightens
      // steadily as the water deepens.
      alb *= mix(vec3(0.52, 0.5, 0.47), vec3(1.0), smoothstep(0.03, 0.6, hd + 0.2 * (vnoise(pb * 0.12) - 0.5)));
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
    // Depth colour, in painted stages: the clear shallows, turquoise over a few metres of sand,
    // then the preset's deep blue offshore.
    // The depth used for colour wanders by a quarter either way in broad patches, so the stage
    // edges are soft and irregular rather than following one contour.
    float hdc = hd * (0.75 + 0.5 * vnoise(q * 0.018 + 11.0)) + 1.5 * (vnoise(q * 0.07 + 4.0) - 0.5);
    float depthK = 1.0 - exp(-max(hdc, 0.0) * 0.12);
    float kb = depthK * 5.0 + vnoise(q * 0.04);
    depthK = mix(depthK, (floor(kb) + smoothstep(0.2, 0.8, fract(kb))) / 5.0, 0.12);
    vec3 turq = mix(cW, uWaterDeep, 0.25);
    turq = max(mix(vec3(dot(turq, vec3(0.2126, 0.7152, 0.0722))), turq, 1.05), 0.0) * vec3(0.94, 1.02, 1.02);
    vec3 teal = mix(turq, uWaterDeep, 0.5) * vec3(0.95, 1.03, 1.0);
    vec3 bodyCol = mix(mix(mix(cW, turq, smoothstep(0.02, 0.35, depthK)), teal, smoothstep(0.3, 0.65, depthK)), uWaterDeep, smoothstep(0.6, 0.97, depthK));
    // The low sun and the warm sky tint the whole body, whichever way the view looks.
    float warmSky = smoothstep(0.08, 0.35, uSunColor.r - uSunColor.b) * (1.0 - uNight);
    vec3 sunHue = uSunColor / max(max(uSunColor.r, max(uSunColor.g, uSunColor.b)), 0.05);
    bodyCol = mix(bodyCol, bodyCol * mix(vec3(1.0), sunHue * 1.2, 0.75), warmSky);
    vec3 tint = cW / max(max(cW.r, max(cW.g, cW.b)), 0.05);
    // Painted stages over the bed, as flat bands with wobbly edges: nearly clear at the edge, a
    // yellow-green stage, then green, then the shallow-water colour. Low sun keeps them cool so
    // the warm light never turns the shallows khaki.
    float warmK = smoothstep(0.08, 0.35, uSunColor.r - uSunColor.b);
    float hw = hd + 0.12 * (vnoise(q * 0.09) - 0.5);
    // Clear over the darkened sand at the very edge (as the beach's film), yellow-green once deeper.
    float f1 = smoothstep(0.12, 0.32, hw + 0.2 * (vnoise(q * 0.04 + 3.0) - 0.5)), f2 = smoothstep(0.55, 0.7, hw), f3 = smoothstep(1.5, 1.8, hw);
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
    float swk = offs * (1.0 - 0.6 * uNight) * (1.0 - 0.6 * smoothstep(900.0, 2200.0, dist)) * smoothstep(0.008, 0.04, -V.y);
    col *= 1.0 + s.swell * 0.4 * swk;
    col = mix(col, cW * 1.15 + 0.05, smoothstep(0.35, 0.85, s.swell) * 0.45 * swk);
    // Light through the thin lip of a steepening crest.
    col = mix(col, cW * 1.3 * mix(vec3(1.0), uSunColor, 0.5) + 0.02, s.crest * 0.55);
    // Ripple marks and the chop's painted tones also shade the body a touch (facets turned to the
    // viewer deeper, the backs paler).
    col *= 1.0 - 0.12 * dabs - 0.07 * tone * deepK * (1.0 - lostF);

    // Mirror: the real scene above the water (sky, clouds, hills, island, buoys), broken up by
    // the waves.
    vec3 skyH = skyColor(normalize(vec3(V.x, 0.004, V.z)));
    vec3 refl;
    vec3 streak = vec3(0.0);
    vec2 tilt = rip + sl * 0.6 + gU;
    float grazing = 1.0 - smoothstep(0.02, 0.35, -V.y);
    float rough = sqrt(resV + lostV) * gust;
    if (uReflOn > 0.5) {
      vec4 rp = uReflMat * vec4(vWPos.x, uReflY, vWPos.z, 1.0);
      vec2 ruv = rp.xy / rp.w;
      // Shallow-water distortion as before; offshore a facet tilted by g turns the mirrored ray by
      // 2g, so the image shifts by that angle on screen: mostly up and down (reflections stretch
      // into broken vertical bands), painted gentler than the physics so they stay readable.
      vec2 dS = tilt * vec2(0.05, 0.08) * (0.25 + 0.75 * near);
      vec2 dO = vec2(vFoc.x * dot(tilt, side) * 0.25, vFoc.y * dot(tilt, fwd)) * 0.3 * (1.0 - 0.85 * farK);
      // Near the eye the chop would shear the mirror into vertical slivers; there it is shifted
      // by the horizontal ripple bands instead.
      vec2 tB = rip + sl * 0.6 + fwd * band * 0.06;
      // Close to the eye a few metres of water span many rows of the mirror, so the swell's tilt
      // is eased there or it would stretch tall objects apart (a gap under the lantern).
      vec2 dB = vec2(vFoc.x * dot(tB, side) * 0.25, vFoc.y * dot(tB, fwd) * mix(0.2, 1.0, smoothstep(5.0, 60.0, dist))) * 0.3;
      ruv += mix(dS, mix(dO, dB, 1.0 - smoothstep(60.0, 400.0, dist)), chopK);
      // Brushed softness: taps down the screen, longer where the water is rougher and at
      // grazing angles. At night a light's brightest tap wins, so lit windows, lamps and the
      // lighthouse smear into wobbly vertical streaks.
      float span = (0.002 + 0.018 * clamp(rough * 5.0, 0.0, 1.0)) * (0.35 + 0.65 * grazing) * chopK;
      vec3 acc = vec3(0.0), mx = vec3(0.0);
      float ws = 0.0;
      float wph = vnoise(vec2(ruv.y * 160.0, uTime * 1.1)) * 6.2831853;
      float wam = 0.0015 * chopK;
      vec3 skyFill = skyH * uWorldTint;
      // Beyond the mirrored horizon the texture holds only the underside of the sky dome (dark):
      // no tap may cross it, so the far water never picks up dark patches.
      vec4 rh = uReflMat * vec4(cameraPosition.x + V.x * 2e4, uReflY, cameraPosition.z + V.z * 2e4, 1.0);
      float hy = rh.y / rh.w - 0.002;
      for (int i = -2; i <= 2; i++) {
        float fi = float(i) * 0.5;
        float wob = sin(wph + fi * 2.7) * wam;
        vec2 tu = ruv + vec2(wob, fi * span);
        tu.y = min(tu.y, hy);
        vec4 c4 = textureLod(uRefl, clamp(tu, 0.001, 0.999), 0.0);
        vec3 c = mix(skyFill, c4.rgb, clamp(c4.a, 0.0, 1.0));
        float w = 1.0 - 0.6 * abs(fi);
        acc += c * w; ws += w;
        mx = max(mx, c);
      }
      refl = acc / ws;
      // Night: each light is smeared into a long streak toward the eye (several times its own
      // height), broken into horizontal dashes by the chop and wobbling sideways.
      if (uNight > 0.3) {
        float sl2 = (0.07 + 0.14 * grazing) * chopK;
        vec2 rq = q - cameraPosition.xz;
        float dn2 = vnoise(vec2(dot(rq, side) * 0.9, dot(rq, fwd) * 2.6 - uTime * 1.2));
        // The taps start at a different point on each ripple row, so a small light smears into
        // one streak instead of separate copies.
        float jit = fract(dn2 * 3.7 + dot(rq, fwd) * 0.9);
        for (int i = 0; i < 6; i++) {
          float fi = (float(i) + jit) / 6.0;
          float wob = (vnoise(vec2(ruv.y * 28.0 + fi * 2.0, uTime * 0.7)) - 0.5) * 0.007 * chopK;
          vec2 tu = ruv + vec2(wob, fi * sl2);
          tu.y = min(tu.y, hy);
          vec3 c = textureLod(uRefl, clamp(tu, 0.001, 0.999), 0.0).rgb;
          mx = max(mx, c * (1.0 - 0.55 * fi));
        }
        float dash = smoothstep(0.38, 0.62, dn2 + 0.6 * tone * (1.0 - lostF) + 0.3 * dabs);
        mx = mix(refl, mx, 0.25 + 0.75 * dash);
      }
      float lift = dot(mx - refl, vec3(0.2126, 0.7152, 0.0722));
      streak = max(mx - refl, 0.0) * clamp(uNight, 0.0, 1.0) * smoothstep(0.012, 0.1, lift);
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
    refl = mix(refl, wCool(refl), 0.55 * (1.0 - smoothstep(0.3, 1.5, s.h)));
    float cosT = max(dot(-V, Nw), 0.0);
    // Offshore the balance is painted: the mirror takes over toward grazing angles, the water's
    // own colour looking down.
    // At night and in low sun the mirror carries more of the scene (sky gradient, hill and roof
    // silhouettes), so the water is never one flat field.
    float fres = mix(0.04 + 0.96 * pow(1.0 - cosT, 5.0), 0.06 + 0.9 * pow(1.0 - cosT, 3.0), chopK);
    fres = max(fres, (0.32 * uNight + 0.32 * warmSky) * chopK);
    // Wave faces and the churned surf zone show their own body; the clear shallows let the bed through.
    float rk = (1.0 - s.foam) * (1.0 - mix(0.85, 0.25, deepK) * clamp(length(sl) * 3.0, 0.0, 1.0)) * (1.0 - 0.75 * s.brk) * mix(0.6, 1.0, smoothstep(0.8, 4.0, s.h));
    // Water a few centimetres deep shows the sand rather than the sky, so the sea fades into the
    // beach's swash sheet with no seam.
    rk *= mix(0.04, 1.0, smoothstep(0.5, 1.4, hd + 0.3 * (vnoise(q * 0.12) - 0.5)));
    col = mix(col, refl, fres * 0.92 * rk);
    // Night: broad moonlit and sky-lit swells of tone over the water body.
    col *= 1.0 + uNight * chopK * (0.35 * (vnoise(q * 0.006 + uTime * 0.01) - 0.5) + 0.12 * s.swell * offs - 0.1 * tone);
    // Far off the sea is one smooth band brightening toward the horizon, taken from the sky.
    float hK = smoothstep(0.06, 0.004, -V.y) * smoothstep(150.0, 700.0, dist) * offs;
    col = mix(col, mix(col, skyH * uWaterRefl * mix(0.82, 0.6, uNight), 0.5 + 0.4 * smoothstep(0.03, 0.004, -V.y)), hK);
    // Lights stretched by the ripples are bright facets, not a faint mirror: they read at any angle.
    col += streak * uWaterRefl * rk * 1.1;
    // Painted ripple marks: dark ones show more of the water body, light ones catch more sky.
    col = mix(col, bodyCol * 0.85 + refl * 0.25, 0.16 * max(dabs, 0.0) * (1.0 - s.foam));
    col += refl * 0.16 * max(-dabs, 0.0);

    // Glitter path under the sun or moon: a broken column of flat painted dabs. Each wave facet
    // flashes when it mirrors the light into the eye, so the column is as wide as the water is
    // rough (the chop, its gusts and each preset's spread) and follows the swell's tilt.
    vec3 Ld = normalize(uGlintDir);
    vec3 H = normalize(Ld - V);
    vec2 sH = -H.xz / max(H.y, 0.05);
    float lightUp = smoothstep(-0.02, 0.04, Ld.y);
    float spread = uGlintShape.x / 0.15;
    // The column narrows toward the horizon and widens toward the eye.
    float colW = 0.55 + 0.45 * smoothstep(0.0, 0.14, -V.y);
    float sigT = mix(uGlintShape.x, sqrt(resV * 0.5 + lostV) * spread * 2.6 + 0.02, deepK) * colW;
    vec2 dH = sH - sl * 0.6;
    float path = exp(-dot(dH, dH) / (2.0 * sigT * sigT)) * lightUp;
    // A soft glow under the low sun or the moon, tinted by the light (pale gold, orange-pink).
    float glowS = sigT * 2.4;
    float glow = exp(-dot(dH, dH) / (2.0 * glowS * glowS)) * lightUp * chopK;
    vec3 gCol = mix(uGlintCol, uGlintCol * mix(vec3(1.0), sunHue, 0.6), warmSky);
    // Shallows: the old soft dashes.
    float dn = 0.0;
    {
      vec2 sq = vec2(dot(q, side), dot(q, fwd)) / (1.5 + dist * 0.012);
      dn = vnoise(sq * vec2(0.7, 1.8) + vec2(uTime * 0.4, -uTime * 0.8)) * 0.65
         + vnoise(sq * vec2(1.5, 3.2) + vec2(-uTime * 0.5, uTime * 0.45) + 5.0) * 0.35;
      float th = 1.0 - path * 0.32;
      dn = smoothstep(th, th + 0.07, dn) * smoothstep(0.04, 0.3, path) * 1.8 * path;
    }
    // Open water: resolved facets near, stochastic facets in view-anchored cells further out.
    float glit = 0.0;
    if (deepK > 0.0 && path > 0.015) {
      vec2 e2 = sl * 0.6 + gC * spread - sH;
      float rN = sigR * spread * 0.22 + 0.003;
      float aN = fwidth(length(e2)) + 1e-4;
      // Broken into dabs so the resolved facets never draw continuous slope contours.
      float gN = (1.0 - smoothstep(rN - aN, rN + aN, length(e2))) * smoothstep(0.45, 0.7, vnoise(q * 0.45 + O_WIND * uTime * 1.5));
      // Every facet is a mix of the drawn chop and finer ripples, so the cells sit on the chop.
      float sigF = sqrt(resV * 0.5 + lostV) * spread * 2.6 + 0.02;
      float gF = oFanGlint(V, uTime, sl * 0.6 + gC * spread * 0.6, sH, sigF, sigF);
      glit = max(gN * 0.6 * (1.0 - lostF), gF);
    }
    float glitter = mix(dn, glit * 1.6 + dn * 0.6, deepK) + path * uGlintShape.y;
    float gk = uGlint * lightUp * (1.0 - s.foam) * mix(0.35, 1.0, smoothstep(0.8, 4.0, s.h));
    col += gCol * glitter * gk;
    col += gCol * glow * gk * (0.05 + 0.32 * warmSky + 0.1 * uNight);

    // Foam: white water of the breaking waves, surf on the rocks, and a skirt of surf where the
    // swell meets the island and headland shores (the beach has its own bores and swash).
    float rf = rockFoam(q, s.dir, s.pulse, uTime, px);
    float skirt = (1.0 - smoothstep(0.15, 3.2, s.h)) * smoothstep(-0.3, 0.05, s.h) * (0.45 + 0.75 * s.pulse) * offBeach;
    skirt *= 0.6 + 0.8 * vnoise(q * 0.12 + vec2(0.0, uTime * 0.05));
    // Thick on shores facing the swell, a thin trickle in the lee.
    skirt *= mix(0.2, 1.5, smoothstep(-0.5, 0.6, dot(wDir(0), s.up))) * mix(0.5, 1.0, s.expose);
    // Every island and headland waterline keeps a thin broken wash, even in the lee.
    skirt = max(skirt, (1.0 - smoothstep(0.05, 0.9, s.h)) * smoothstep(-0.3, 0.02, s.h) * offBeach * (0.35 + 0.5 * vnoise(q * 0.3 + vec2(uTime * 0.2, 0.0))) * (0.6 + 0.5 * s.pulse));
    vec2 fq = q - s.dir * uTime * 0.5;
    float fskirt = wLace(fq * 0.9, skirt, 9.0, px);
    float frock = wLace(vec2(dot(q, s.dir) - uTime * 0.6, dot(q, vec2(-s.dir.y, s.dir.x))) * 1.2, clamp(rf * 1.6, 0.0, 1.0), 5.0, px);
    float foam = max(s.foam, max(frock, fskirt));
    // Sparse whitecaps offshore, as fits a light breeze: a short crest spills in a gust, then
    // thins into a streak drifting downwind and fades. One per cell at most, so a few in view.
    // Irregular sizes and lifetimes, a broken crest of two or three ragged dabs, a short trail
    // left upwind as the crest runs on, fewer near the eye and fading out with distance.
    float wcK = deepK * smoothstep(30.0, 90.0, dist) * (1.0 - smoothstep(500.0, 1300.0, dist));
    if (wcK > 0.01) {
      vec2 f = vec2(dot(q, O_WIND), dot(q, vec2(-O_WIND.y, O_WIND.x)));
      vec2 cs = vec2(34.0, 26.0);
      vec2 cid = floor(f / cs);
      vec2 fl = f - cid * cs;
      float per = 5.0 + 8.0 * hash12(cid + 3.0);
      float cyc = uTime / per + hash12(cid + 17.0) * 13.0;
      float n = floor(cyc), life = fract(cyc);
      vec2 hid = cid + n * vec2(1.37, 2.71);
      if (hash12(hid + 0.3) < 0.07 + 0.12 * smoothstep(0.8, 1.3, gust)) {
        float sz = 0.45 + 1.1 * hash12(hid + 2.2) * hash12(hid + 4.4);
        vec2 c = vec2(6.0 + 14.0 * hash12(hid + 5.1), 6.0 + 12.0 * hash12(hid + 8.3));
        float run = life * per * 0.5;
        vec2 d = fl - c - vec2(run, 0.0);
        float L = (1.0 + 2.2 * hash12(hid + 6.6)) * sz;
        float grow = smoothstep(0.0, 0.08, life), die = 1.0 - smoothstep(0.08, 0.5, life);
        // The crest: ragged dabs strung along it, gaps between them.
        float rag = vnoise(vec2(d.y * 1.6 / sz, d.x * 2.2) + n * 3.1) - 0.5;
        float along = d.y / L;
        float seg = 0.5 + 0.5 * sin(along * (3.0 + 3.0 * hash12(hid + 9.9)) + hash12(hid + 1.1) * 6.28);
        float crest = length(vec2(along, (d.x + 0.1) / (0.35 * sz))) + rag * 0.55 - seg * 0.35;
        float dens = (1.0 - smoothstep(0.45, 0.85, crest)) * grow * die;
        // The trail: thin broken streaks behind the crest, dissolving as they age.
        float back = -d.x;
        float tl = (1.0 + 4.0 * hash12(hid + 3.7)) * sz * smoothstep(0.0, 0.4, life);
        float trail = smoothstep(-0.2, 0.3, back) * (1.0 - smoothstep(tl * 0.5, tl, back))
                    * (1.0 - smoothstep(0.4, 1.0, abs(along) + rag * 0.4))
                    * smoothstep(0.45, 0.75, vnoise(vec2(d.y * 2.4 / sz, back * 0.7) + n))
                    * (1.0 - smoothstep(0.3, 1.0, life)) * 0.75;
        dens = max(dens, trail) * wcK;
        vec2 lp = vec2(f.y * 1.1, (f.x - run) * 1.4) + cid * 7.3;
        foam = max(foam, wLace(lp, dens, 3.0 + mod(n, 17.0), px) * (1.0 - smoothstep(0.25, 0.8, px)));
      }
    }
    // Foam round the buoys.
    float bRing, bDark;
    float bf = buoyFoam(q, uTime, bRing, bDark);
    if (bf > 0.02) foam = max(foam, wLace((q - O_WIND * uTime * 0.25) * 1.7, clamp(bf, 0.0, 1.0), 21.0, px));
    col *= 1.0 - 0.3 * bDark;
    col = mix(col, refl * 1.1 + 0.04, bRing * 0.45 * (1.0 - smoothstep(0.05, 0.25, px)));
    // The last half metre of depth hands over to the beach's swash foam, so the lace carries on
    // across the waterline instead of stopping at it.
#ifdef BAND_MESH
    float hA = 0.02 + max(-u, 0.0) * 0.07;
    if (hA < 0.6 && s.rock < 0.2) {
      WSwash sw = wSwash(q, -s.h, uTime, px);
      foam = mix(sw.foam, foam, max(smoothstep(0.15, 0.6, hA), smoothstep(0.0, 0.2, s.rock)));
    }
#endif
    if (foam > 0.002) {
      vec3 Nf = normalize(Nw + vec3(0.0, 1.2, 0.0));
      col = mix(col, wFoamColor(normalize(Nf - vec3(0.0, 0.3 * s.crest, 0.0)), q, col, path), foam);
    }

    // Lighthouse beams sweeping over the water: as each turns, a long soft band of light fans out
    // across the bay from the island, and the wave facets inside it catch the lamp as sparkles.
    if (uBeam > 0.0) {
      vec2 rel = q - uLampPos.xz;
      float rlen = length(rel);
      vec2 rd = rel / max(rlen, 1e-3);
      float al = dot(rd, uBeamDir);
      float cr = dot(rd, vec2(-uBeamDir.y, uBeamDir.x)) * sign(al);
      float wob = 0.014 * (vnoise(vec2(rlen * 0.03, uTime * 0.4)) - 0.5);
      // A soft feathered wedge (no hard edge), brightest along its axis.
      float cx = abs(cr + wob * 2.0);
      float wedge = exp(-cx * cx / (2.0 * 0.085 * 0.085)) * smoothstep(0.5, 0.9, abs(al));
      float fall = smoothstep(14.0, 60.0, rlen) * exp(-rlen / 260.0);
      float bk = wedge * fall;
      if (bk > 0.002) {
        vec3 Lb = normalize(uLampPos - vWPos);
        vec3 Hb = normalize(Lb - V);
        vec2 sHb = -Hb.xz / max(Hb.y, 0.05);
        float sb = sqrt(resV + lostV) * 1.4 + 0.03;
        float gb = oFanGlint(V, uTime * 1.3 + 7.0, sl * 0.6, sHb, sb, sb * 1.1);
        // Broken up by the chop like the moon path: the facets turned to the lamp catch more.
        float br = 0.7 + 0.3 * tone * (1.0 - lostF) - 0.25 * dabs + 0.25 * (vnoise(q * 0.08 + uTime * 0.1) - 0.5);
        col += vec3(1.0, 0.86, 0.6) * uBeam * bk * (0.55 * br + 1.2 * gb + 0.3 * foam);
      }
    }
    col = applyFog(col, vWPos);
    // The far sea melts into the horizon haze: sky and sea meet at a soft light line.
    col = mix(col, skyH, smoothstep(1800.0, 3800.0, dist) * 0.85);
    gColor = vec4(col, 1.0);
    vec3 vn = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
    gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, 0.0);
  }`;

const SKIRTS = { value: rockSkirts() };

function material(defines: Record<string, string>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, ...DEPTH, ...REFL, uRocks: SKIRTS, uBuoys: BUOY_U, uGridO: GRID_UNIFORM, uId: { value: ID.water }, uMask: { value: 0 } },
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
  for (let j = 0; j < nz; j++) {
    const z = zs[j];
    const x0 = roadX(z) + waterlineU(z);
    for (let i = 0; i < no; i++) {
      const k = j * no + i;
      pos[k * 3] = x0 + offs[i];
      pos[k * 3 + 1] = SEA_Y;
      pos[k * 3 + 2] = z;
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
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g, material({ BAND_MESH: "1" }));
  m.frustumCulled = false;
  return m;
}

/**
 * The open sea: a polar grid round the camera (rings ~4.5% apart, from 0.5 m to 4 km), moved with
 * the camera in whole snap steps so the displaced surface never swims.
 */
function buildOpenGrid(): THREE.Mesh {
  const seg = 192;
  const rings: number[] = [0];
  // Rings tighten only where the swell moves the mesh; past the displacement fade the sea is flat,
  // and thin far rings would cost quad overshading at grazing angles.
  for (let r = 0.5; r < 4000; r *= r < 280 ? 1.045 : r < 650 ? 1.09 : 1.6) rings.push(r);
  rings.push(4000);
  const nr = rings.length;
  const pos = new Float32Array(nr * seg * 3);
  for (let j = 0; j < nr; j++)
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, k = (j * seg + i) * 3;
      pos[k] = Math.cos(a) * rings[j];
      pos[k + 2] = Math.sin(a) * rings[j];
    }
  const idx = new Uint32Array((nr - 1) * seg * 6);
  let q = 0;
  for (let j = 0; j < nr - 1; j++)
    for (let i = 0; i < seg; i++) {
      const i2 = (i + 1) % seg;
      const a = j * seg + i, b = j * seg + i2, c = (j + 1) * seg + i, d = (j + 1) * seg + i2;
      idx[q++] = a; idx[q++] = b; idx[q++] = c;
      idx[q++] = b; idx[q++] = d; idx[q++] = c;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g, material({ DISC: "1" }));
  m.frustumCulled = false;
  return m;
}

/** Keep the open-sea grid centred under the camera (call once per frame before rendering). */
export function followSea(cam: THREE.Vector3): void {
  GRID_UNIFORM.value.set(Math.round(cam.x / GRID_SNAP) * GRID_SNAP, Math.round(cam.z / GRID_SNAP) * GRID_SNAP);
}

/**
 * The sea: the surf band along the beach (breaking waves, foam, clear shallows) and the open-sea
 * grid for the rest of the bay with the same shading (the swell, refracted round the island,
 * breaks on its shore too; wind chop, glitter and reflections offshore).
 */
export function buildSea(): THREE.Group {
  const grp = new THREE.Group();
  grp.add(buildOpenGrid(), buildBand());
  // Drawn after the land, so the hills and the island hide the water before it is shaded.
  for (const m of grp.children) m.renderOrder = 1;
  return grp;
}
