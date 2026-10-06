import * as THREE from "three";
import { COMMON, G, REFL } from "../render/materials";
import { ID } from "../world/geo";
import { SEA_Y, roadX, smooth } from "../world/bay/road";
import { ISLAND, waterlineU } from "../world/bay/terrain";
import { PIER, PIER_LAMPS, PIER_POSTS } from "../world/bay/pier";
import { DEPTH, DEPTH_GLSL } from "./depthMap";
import { WAVES_GLSL } from "./waves";
import { SKIRT_MAX, rockSkirts } from "./rocks";
import { BUOY_MAX, BUOY_U } from "./buoys";
import { WAKE_FS_GLSL, WAKE_GLSL, WAKE_U } from "./wake";
import { WATER_TOD } from "./look";

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

/** Island waterline radius (before its outline wobble): where terrain.ts islandH's dome and shoulder cross sea level. */
const ISLAND_R0 = (() => {
  const f = (r: number) => 18 * Math.pow(1 - smooth(4, ISLAND.r, r), 0.6) - 10 * smooth(ISLAND.r - 4, ISLAND.r + 26, r);
  let lo = 4, hi = 80;
  for (let i = 0; i < 40; i++) {
    const m = 0.5 * (lo + hi);
    if (f(m) > 0) lo = m;
    else hi = m;
  }
  return lo;
})();

/** Open-sea grid: follows the camera in steps of this many metres. */
const GRID_SNAP = 8;
const GRID_UNIFORM = { value: new THREE.Vector2() };
/** The pier's lamp heads for their light on the water (w = 1 once the pier is built). */
const PIER_LAMP_U = { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] };
let pierLampsSet = false;

const VS = /* glsl */ `
  ${COMMON}
  ${DEPTH_GLSL}
  ${WAVES_GLSL}
  ${WAKE_GLSL}
  uniform vec2 uGridO;
  uniform float uBand;
  out vec3 vWPos;
  out vec2 vFoc;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    if (uBand < 0.5) {
      wp.xz += uGridO;
      wp.y = W_SEA;
    }
    // The swell and the longer chop move the surface (the same height the water query returns);
    // far out the mesh is too coarse to carry them and the shading alone draws the waves.
    float camK = 1.0 - smoothstep(280.0, 650.0, length(wp.xz - cameraPosition.xz));
    float hv = W_SEA - wField(wp.xz).r;
    if (uBand > 0.5) {
      // The surface settles flat into the last metre of depth and tucks just under the sand: on the
      // beach itself the swash sheet takes over (beach.ts), so the sea never floods the sand.
      // The tuck depth wanders along the shore so the meeting line with the sand is never ruled,
      // down to a few metres (the last term), so it never draws a straight seam across the shallows.
      float tuck = 0.035 + 0.05 * vnoise(wp.xz * vec2(0.09, 0.23)) + 0.22 * smoothstep(0.25, 0.85, vnoise(vec2(wp.z * 0.03, wp.x * 0.05 + 2.0))) + 0.08 * vnoise(vec2(wp.z * 0.09, 4.0))
                 + 0.07 * (vnoise(vec2(wp.z * 0.26, wp.x * 0.21 + 7.0)) - 0.3);
      wp.y += wEta(wp.xz, uTime) * camK * smoothstep(0.0, 0.8, hv) - tuck * (1.0 - smoothstep(0.0, 1.0, hv));
    } else if (camK > 0.0) wp.y += wEta(wp.xz, uTime) * camK * smoothstep(0.0, 0.8, hv);
    // The boat's wake lifts the surface a little near the eye.
    float cd = length(wp.xz - cameraPosition.xz);
    if (cd < 260.0) wp.y += wakeHeight(wp.xz, max(0.02, cd * 0.0009)) * (1.0 - smoothstep(150.0, 260.0, cd)) * smoothstep(0.3, 1.5, hv);
    vWPos = wp.xyz;
    vFoc = vec2(projectionMatrix[0][0], projectionMatrix[1][1]);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const FS = /* glsl */ `
  ${COMMON}
  ${OUT}
  ${DEPTH_GLSL}
  ${WAVES_GLSL}
  ${WAKE_GLSL}
  ${WAKE_FS_GLSL}
  ${COAST_GLSL}
  uniform sampler2D uRefl;
  uniform mat4 uReflMat;
  uniform float uReflOn;
  uniform float uReflY;
  uniform vec4 uRocks[${SKIRT_MAX}];
  uniform vec4 uBuoys[${BUOY_MAX}];
  // The pier's lamp heads (xyz) and whether each is there (w).
  uniform vec4 uPierLamps[3];
  // 1 on the surf band along the beach, 0 on the open-sea grid round the camera (one program for both).
  uniform float uBand;
  // 1 at dusk (water/look.ts).
  uniform float uDusk;
  in vec3 vWPos;
  in vec2 vFoc;

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
  float buoyFoam(vec2 q, float t, vec2 dqx, vec2 dqy, float px, out float rings, out float contact){
    float f = 0.0;
    rings = 0.0; contact = 0.0;
    vec2 side = vec2(-O_WIND.y, O_WIND.x);
    for (int i = 0; i < ${BUOY_MAX}; i++) {
      vec4 B = uBuoys[i];
      vec2 d = q - B.xy;
      float L = length(d);
      if (L > 7.0 + 12.0 * length(dqx) * length(q - cameraPosition.xz) / max(cameraPosition.y - uReflY, 0.3) || B.z <= 0.0) continue;
      float an = atan(d.y, d.x);
      float ring = exp(-max(L - B.z, 0.0) / (0.3 + 0.45 * abs(B.w))) * smoothstep(B.z - 0.12, B.z + 0.02, L);
      ring *= 0.55 + 0.6 * vnoise(vec2(an * 2.2 + float(i) * 5.0, t * 0.7));
      // Far off the collar is held to a few pixels round the hull, so it still reads as a ring.
      // It swells as the buoy heaves and thins as it rides up.
      if (px > 0.02) {
        // Pixel footprint from the camera geometry (across and along the view), steady at a
        // grazing angle where the screen derivatives are not.
        vec2 cq = q - cameraPosition.xz;
        float cl = max(length(cq), 1e-3);
        vec2 fw = cq / cl;
        float hM = length(dqx);
        float dM = max(hM * cl / max(cameraPosition.y - uReflY, 0.3), hM);
        vec2 dp = vec2(dot(d, vec2(-fw.y, fw.x)) / hM, dot(d, fw) / dM);
        vec2 bp = B.z / vec2(hM, dM);
        float pul = 1.0 + 0.4 * abs(B.w);
        // A collar in proportion to the hull on screen: a few pixels round a far float, never a
        // disc many times its size.
        vec2 ex = min(vec2(10.0, 7.5), bp * vec2(1.1, 0.8) + vec2(1.5, 1.0));
        float e = length(dp / (bp + ex * pul * (0.8 + 0.4 * vnoise(vec2(an * 3.0 + float(i) * 4.0, t * 0.6)))));
        ring = max(ring, (1.0 - smoothstep(0.75, 1.0, e)) * smoothstep(0.02, 0.08, px) * (0.7 + 0.4 * vnoise(vec2(an * 4.0 + float(i), t * 0.9))));
      }
      contact = max(contact, 1.0 - smoothstep(B.z, B.z + 0.6, L));
      // Two or three rings travelling out from the hull, fading as they spread.
      float r = L - B.z;
      float ph = fract(r / 1.3 - t * 0.55 + float(i) * 0.37);
      float rr = (1.0 - smoothstep(0.0, 0.12, abs(ph - 0.5))) * (1.0 - smoothstep(0.5, 4.5, r)) * smoothstep(0.1, 0.4, r);
      // Rings and the lee streak are too fine to read far off: gone by a few hundred metres.
      float farB = 1.0 - smoothstep(200.0, 320.0, length(q - cameraPosition.xz));
      rings = max(rings, rr * farB * smoothstep(0.3, 0.6, vnoise(vec2(an * 3.0 + float(i), r * 0.6 - t * 0.4))));
      float ax = dot(d, O_WIND), sd = dot(d, side);
      // Gone well inside the 7 m search radius: a faint tail cut there leaves a lone straight-edged
      // scrap of foam on open water metres from the buoy.
      float lee = smoothstep(0.2, 1.2, ax) * exp(-ax / 3.0) * (1.0 - smoothstep(0.4, 1.0, abs(sd) / (B.z + 0.18 * ax))) * (1.0 - smoothstep(3.5, 5.5, L));
      lee *= smoothstep(0.35, 0.7, vnoise(vec2(sd * 3.0 + float(i), ax * 0.9 - t * 1.1))) * mix(0.25, 1.0, farB);
      f = max(f, max(ring, lee * 0.6));
    }
    return f;
  }

  // View-anchored cells over the water: rows by depression angle (somewhat narrower toward the horizon),
  // a whole number of columns round the viewer in each row, so the ring closes with no seam.
  // Painted marks drawn in them keep a steady on-screen shape and stay put when the camera turns.
  // Returns the continuous cell coordinates (fract = position in the cell) and the cell id.
  // fd: depression^0.75 and the azimuth turn fraction 0..1 (shared by every layer).
  vec2 oFanD(vec3 V){
    float dep = max(-V.y, 1e-4) / max(length(V.xz), 1e-4);
    return vec2(pow(dep, 0.75), atan(V.z, V.x) / 6.2831853 + 0.5);
  }
  vec2 oFan(vec2 fd, float rowH, float colW, float scroll, out vec2 id){
    float v = fd.x / rowH + scroll;
    float row = floor(v);
    float rc = pow(max((row - scroll + 0.5) * rowH, rowH * 0.5), 1.0 / 3.0);
    float N = max(floor(6.2831853 / (colW * rc)), 3.0);
    // Each row starts at its own phase, so the columns never line up from row to row.
    float a = fd.y * N + hash12(vec2(row, colW * 17.0)) * N;
    id = vec2(mod(floor(a), N), row);
    return vec2(a, v);
  }
  // A painted brush stroke in a cell: long and flat, bowed a little, one end fuller than the
  // other (a comma), soft at both ends and along its edges; length, width, bow and taper vary
  // per stroke. g opens it (0..1), lenK scales its length.
  float oBrush(vec2 f, vec2 hid, float g, vec2 aa, float lenK, float widK){
    float h1 = hash12(hid + 7.0), h2 = fract(h1 * 41.37 + 0.13), h3 = fract(h1 * 73.11 + 0.57), h4 = fract(h2 * 59.3 + 0.71), h5 = fract(h3 * 37.7 + 0.29);
    float len = (0.16 + 0.3 * h1 * h1 + 0.1 * h2) * lenK * (0.6 + 0.4 * g);
    float wid = (0.055 + 0.075 * h2) * (0.5 + 0.5 * g) * mix(1.15, 0.8, h1) * widK;
    vec2 c = vec2(len + 0.03 + max(1.0 - 2.0 * len - 0.06, 0.0) * h3, 0.5 + (0.4 - min(wid, 0.3)) * (h4 - 0.5) * 2.0);
    vec2 d = f - c;
    float x = d.x / len;
    float bow = (h5 - 0.5) * 1.6 * wid;
    float tail = (fract(h5 * 7.3) - 0.5) * 1.5;
    float w = wid * sqrt(max(1.0 - x * x, 0.0)) * clamp(1.0 + tail * x, 0.25, 1.6);
    float soft = max(aa.y * 0.8, wid * 0.4);
    float m = smoothstep(-soft, soft, w - abs(d.y - bow * (x * x - 0.35)));
    return m * (1.0 - smoothstep(0.45, 1.0, abs(x))) * (1.0 - smoothstep(0.0, 1.5, aa.x / len - 0.3));
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
  float oFanDabs(vec2 fd, float t, float gust){
    float s = 0.0;
    for (int k = 0; k < 2; k++) {
      float fk = float(k);
      vec2 id;
      vec2 F = oFan(fd, k == 0 ? 0.034 : 0.021, k == 0 ? 0.5 : 0.32, 0.0, id);
      vec2 aa = vec2(fwidth(F.x), fwidth(F.y));
      vec2 f = fract(F);
      float per = 4.5 + 3.5 * hash12(id + 1.7 + fk * 9.0);
      float cyc = t / per + hash12(id + 4.1 + fk * 9.0) * 9.0;
      float n = floor(cyc), life = fract(cyc);
      vec2 hid = id + n * vec2(3.17, 1.91) + fk * 13.0;
      if (hash12(hid) > 0.2 + 0.2 * gust) continue;
      float g = sin(3.14159 * life);
      float m = oBrush(f, hid, g, aa, 1.15, 0.95) * smoothstep(0.0, 0.25, g) * (0.6 + 0.4 * hash12(hid + 3.9));
      s += m * (hash12(hid + 11.0) < 0.3 ? -0.85 : 0.9) * (1.0 - 0.25 * fk);
    }
    return clamp(s, -1.0, 1.0);
  }
  // Stochastic glitter where the chop is too fine to draw: each cell is one wave facet with a
  // random slope that turns slowly; it flashes as a flat dab when it mirrors a light into the eye.
  // Two lights in one pass over the cells: x = the sun or moon (needed slope sH, spread sig round
  // the mean slope g0), y = the lighthouse lamp (sH1, sig1 round g1). A needed slope of 100 is off.
  vec2 oFanGlint2(vec2 fd, float t, vec2 g0, vec2 sH, float sig, float rad, vec2 g1, vec2 sH1, float sig1, float rad1){
    vec2 best = vec2(0.0);
    for (int k = 0; k < 3; k++) {
      vec2 id;
      vec2 F = oFan(fd, k == 0 ? 0.016 : k == 1 ? 0.0105 : 0.0072, k == 0 ? 0.17 : k == 1 ? 0.115 : 0.08, -t * (0.3 + 0.12 * float(k)), id);
      vec2 aa = vec2(fwidth(F.x), fwidth(F.y));
      vec2 f = fract(F);
      vec2 hid = id + float(k) * 31.0;
      float h1 = hash12(hid + 0.5), h2 = hash12(hid + 3.3), h3 = hash12(hid + 6.1), h4 = hash12(hid + 9.7);
      // A random facet slope (Box-Muller) turning slowly: one angle for both.
      float ph = 6.2831853 * (h2 - h3) - t * (0.2 + 0.4 * h4);
      vec2 gs = sqrt(-2.0 * log(max(h1, 1e-4))) * vec2(cos(ph), sin(ph));
      vec2 mm = vec2(1.0 - smoothstep(rad * 0.45, rad, length(g0 + gs * sig - sH)), 1.0 - smoothstep(rad1 * 0.45, rad1, length(g1 + gs * sig1 - sH1)));
      float m = max(mm.x, mm.y);
      if (m <= 0.0) continue;
      vec2 c = vec2(0.3 + 0.4 * h3, 0.36 + 0.28 * h4);
      vec2 r = vec2(0.16 + 0.12 * h1, 0.2 + 0.12 * h2) * (0.5 + 0.5 * m);
      // Broken into two or three uneven flecks with ragged rims, so a flash is never one smooth
      // oval however large the cell is on screen.
      float u = (f.x - c.x) / r.x;
      float brk = smoothstep(0.4, 0.6, vnoise(vec2(u * 2.6 + h2 * 17.0, (f.y - c.y) / r.y * 1.1 + h3 * 9.0)) + 0.1 * (1.0 - abs(u)));
      vec2 cj = c + vec2(0.0, (h3 - 0.5) * 0.7 * r.y * u);
      vec2 rr = r * (0.8 + 0.4 * vnoise(f * vec2(9.0, 3.0) + hid));
      // A cell many pixels tall on screen (near the eye, or a steep view) would show a filled
      // oval: there the flash is one or two flat, broken horizontal flecks, wider than it is
      // far off (kept inside its cell, so no edge is cut square).
      float big = smoothstep(0.06, 0.025, aa.y);
      rr.y *= mix(1.0, 0.6, big);
      rr.x = min(rr.x * mix(1.0, 1.3, big), 1.05 * min(c.x, 1.0 - c.x));
      float vy = (f.y - cj.y) / rr.y;
      float lines = big > 0.0 ? smoothstep(0.2, 0.6, sin(vy * 4.2 + h1 * 6.28 + 2.0 * vnoise(vec2(u * 3.0, h4 * 9.0)))) : 1.0;
      best = max(best, mm * (oLens(f, cj, rr, aa) * brk * mix(1.0, lines, big)));
    }
    return best;
  }
  // Painted near chop: short horizontal tonal dashes, a few pixels tall and several times as wide,
  // in view-anchored rows of equal log depression (so they shrink and crowd toward the horizon),
  // drifting toward the eye and opening and closing over a few seconds. Signed: + dark, - light.
  float oStrokes(vec3 V, float t, float gust){
    float dep = max(-V.y, 1e-4) / max(length(V.xz), 1e-4);
    const float rowH = 0.072;
    float sc = t * 0.12;
    float v = log(dep) / rowH + sc;
    float row = floor(v);
    // Column width a few times the row height at that depression, in azimuth.
    float dr = exp((row - sc + 0.5) * rowH);
    float N = max(floor(6.2831853 / (5.0 * rowH * dr)), 3.0);
    // World azimuth (the strokes stay put when the camera turns); N is whole, so the ring closes.
    float a = (atan(V.z, V.x) / 6.2831853 + 0.5) * N + hash12(vec2(row, 0.7)) * 7.0;
    vec2 F = vec2(a, v);
    vec2 aa = vec2(fwidth(F.x), fwidth(F.y));
    vec2 id = vec2(mod(floor(a), N), row);
    vec2 f = fract(F);
    float per = 2.5 + 3.0 * hash12(id + 2.7);
    float cyc = t / per + hash12(id + 8.3) * 7.0;
    float n = floor(cyc), life = fract(cyc);
    vec2 hid = id + n * vec2(2.13, 3.71);
    if (hash12(hid) > 0.55 + 0.25 * (gust - 0.9)) return 0.0;
    float g = sin(3.14159 * life);
    float m = oBrush(f, hid, g, aa, 1.25, 1.9) * smoothstep(0.0, 0.3, g) * (0.6 + 0.4 * hash12(hid + 3.9));
    return m * (hash12(hid + 9.2) < 0.3 ? -0.8 : 1.0);
  }
  // Wave break bands across the mirror: irregular horizontal bands spaced by log distance (so
  // they crowd toward the horizon), of uneven width and spacing, drifting toward the eye with
  // the swell; their ends wander. x: broad bands 0..1, y: thin ripple lines 0..1, z: sideways
  // offset -1..1.
  // Azimuth measured from the camera's heading, so the noise seam sits behind the viewer.
  float oAz(vec3 V){
    vec2 cf = normalize(-vec2(viewMatrix[0][2], viewMatrix[2][2]) + 1e-5);
    return atan(dot(V.xz, vec2(-cf.y, cf.x)), dot(V.xz, cf));
  }
  vec3 oBreak(vec2 rq, vec3 V, float t, float flr){
    float lr = log(max(length(rq), 1.0));
    float az = oAz(V);
    float bw = vnoise(vec2(az * 1.0 + 5.0, lr * 0.8 - t * 0.03));
    float bA = vnoise(vec2(az * 1.3 + bw * 1.2, lr * 2.3 + t * 0.07));
    float bB = vnoise(vec2(az * 1.6 + 2.0, lr * 6.5 + t * 0.16 + bw * 1.5));
    float wide = smoothstep(0.56, 0.68, bA) * (1.0 - smoothstep(0.8, 0.92, bA) * 0.5);
    float lw = max(0.035 + 0.03 * bw, flr * 6.5 * 1.8);
    float line = (1.0 - smoothstep(0.0, lw, abs(bB - 0.62))) * smoothstep(0.3, 0.5, bw + 0.2) * min(1.0, 0.05 / lw);
    // The thin lines belong to the mirrored scene further out; near the eye the strokes take over.
    line *= smoothstep(4.0, 5.0, lr);
    return vec3(wide, line, (vnoise(vec2(az * 3.0, lr * 9.0 - t * 0.3) + 9.0) - 0.5) * 2.0);
  }

  void main(){
    if (uBand < 0.5) {
      float u = vWPos.x - coastRoadX(vWPos.z) - coastWaterU(vWPos.z);
      if (vWPos.z > ${BAND.z0.toFixed(1)} && vWPos.z < ${BAND.z1.toFixed(1)} && u > ${(BAND.outer + 0.4).toFixed(1)}) discard;
    }
    vec2 q = vWPos.xz;
    vec3 V = normalize(vWPos - cameraPosition);
    float dist = length(vWPos - cameraPosition);
    vec2 dqx = dFdx(q), dqy = dFdy(q);
    float px = sqrt(length(dqx) * length(dqy));
    float pxM = max(length(dqx), length(dqy));
    Wake wk = wakeShade(q, px, pxM);
    WSurf s = wSurface(q, uTime, px);
    vec3 cW = wShallowCol();
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
    vec2 sl = s.grad * (1.0 - smoothstep(150.0, 900.0, dist) * 0.7) + wk.grad * 1.5;
    // Painted chop: the slope toward the viewer is flattened into three tones with soft clean
    // edges, so the facets read as brushed strokes rather than a noisy normal map.
    float tv = dot(gC, fwd) / max(sigR, 0.004);
    float aw = fwidth(tv) * 1.5 + 0.1;
    // Tones wider than the filter can hold fade to flat instead of shimmering.
    float tone = (smoothstep(0.55 - aw, 0.55 + aw, tv) - smoothstep(0.55 - aw, 0.55 + aw, -tv)) * (1.0 - smoothstep(0.6, 1.4, aw)) * (1.0 - farK);
    vec2 gU = mix(gC, fwd * tone * sigR * 1.3 + side * dot(gC, side) * 0.6, 0.7) * (1.0 - farK) * (1.0 - 0.75 * wk.slick);
    // Near the eye, short horizontal ripple bands break the mirrored sky into strokes.
    float band = 0.0;
    // Faded before its rows (~0.6 m) get thinner than a pixel, or they alias into hairlines.
    float bandK = (1.0 - smoothstep(60.0, 420.0, dist)) * (1.0 - smoothstep(0.08, 0.2, pxM)) * chopK;
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
    vec2 fanD = oFanD(V);
    // Swell crests gather more chop than the troughs.
    float crestK = mix(0.55, 1.25, smoothstep(-0.3, 0.5, s.swell));
    if (dabK > 0.01) {
      // The rows wander (a warp continuous round the viewer), so the marks never sit on a grid.
      vec2 vd = V.xz / max(length(V.xz), 1e-4);
      vec2 fw = fanD + vec2(0.006 * (sin(vd.x * 23.0 + fanD.x * 41.0) + sin(vd.y * 37.0 - fanD.x * 67.0 + 1.3)), 0.0);
      dabs = oFanDabs(fw, uTime, gust) * dabK * crestK * (1.0 - 0.6 * wk.slick);
    }
    gU += fwd * dabs * 0.06;
    // Near the eye the chop is painted as readable strokes, so the water never reads as glass.
    float strokes = 0.0;
    // The bay in front of the beach is chopped too once it is past the surf.
    float stC = max(chopK, smoothstep(1.5, 4.0, s.h) * (1.0 - smoothstep(0.05, 0.3, s.brk + s.foam)) * 0.85);
    float stK = stC * (1.0 - smoothstep(90.0, 260.0, dist)) * smoothstep(0.02, 0.05, -V.y) * (1.0 - 0.4 * uNight);
    // The slick keeps a sparser set of strokes: calmer water, not a painted-over sheet.
    if (stK > 0.01) strokes = oStrokes(V, uTime, gust) * stK * crestK * (1.0 - 0.6 * wk.slick);
    gU += fwd * strokes * 0.05;
    // Where those marks are gone (far off, or low across the water past a few tens of metres) a
    // faint layer of small painted dashes carries on out to the haze: one sparse dab per
    // view-anchored cell in rows of a fixed screen height (so they never alias), each opening and
    // closing over a few seconds, softened to its footprint. Signed: + dark, - light.
    float farM = 0.0;
    float fmK = chopK * (1.0 - smoothstep(0.012, 0.03, -V.y) * (1.0 - smoothstep(320.0, 900.0, dist))) * smoothstep(0.0025, 0.008, -V.y)
              * (1.0 - smoothstep(1800.0, 2800.0, dist)) * (1.0 - 0.5 * uNight) * (1.0 - 0.6 * wk.slick);
    vec2 fmId;
    vec2 fmF = oFan(fanD, 0.0125, 0.12, -uTime * 0.08, fmId);
    vec2 fmA = vec2(fwidth(fmF.x), fwidth(fmF.y));
    if (fmK > 0.01) {
      float per = 4.0 + 4.0 * hash12(fmId + 2.9);
      float cyc = uTime / per + hash12(fmId + 6.7) * 5.0;
      vec2 hid = fmId + floor(cyc) * vec2(2.71, 1.37);
      float g = sin(3.14159 * fract(cyc));
      float h2 = hash12(hid + 8.1);
      float m = oLens(fract(fmF), vec2(0.3 + 0.4 * h2, 0.5), vec2((0.14 + 0.14 * fract(h2 * 7.3)) * (0.6 + 0.4 * g), 0.16), fmA) * smoothstep(0.0, 0.3, g) * step(hash12(hid + 3.7), 0.3);
      farM = m * (hash12(hid + 1.9) < 0.35 ? -0.75 : 1.0) * fmK * crestK;
    }
    // Break bands across the mirror (open water only), animated with the swell.
    // Only where the mirror shows at a grazing angle; looking steeply down it is not seen.
    vec3 brkB = vec3(0.0);
    float brkK = chopK * (1.0 - 0.6 * farK) * (1.0 - smoothstep(0.08, 0.14, -V.y)) * (1.0 - smoothstep(1000.0, 1600.0, dist));
    if (brkK > 0.01) brkB = oBreak(q - cameraPosition.xz, V, uTime, pxM / max(length(q - cameraPosition.xz), 1.0)) * brkK;
    // The wake's waves and broken water tilt the painted facets too, so they break the mirror
    // and the glitter rather than lying on top as a decal.
    gU += wk.grad * 0.7 * (1.0 - farK);
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
    float nq9 = vnoise(q * 0.09);
    vec3 seen = vec3(0.0);
    // Past ~7.5 m the bed adds under 1% (clarity), so it is skipped.
    if (seeBed > 0.0 && hd < 7.5) {
      // Sand, ripples, stones, the wet-sand edge, caustics and the painted stages as the beach
      // paints its strip under the water (waves.ts), so the two meet in one colour; patchy weed
      // further out and the rocks are the sea's own.
      vec3 alb = wBedAlb(pb, hd, px);
      if (hd > 1.2) alb = mix(alb, vec3(0.13, 0.17, 0.08), smoothstep(0.6, 0.7, fbm2(pb * 0.05 + 4.0)) * smoothstep(1.2, 3.0, hd) * 0.55);
      float rk = smoothstep(0.9, 0.99, Fb.a);
      alb = mix(alb, vec3(0.16, 0.17, 0.13) * (0.75 + 0.5 * vnoise(pb * 1.7)), rk);
      vec3 lit = toonT(alb, vec3(0.0, 1.0, 0.0), vec3(pb.x, Fb.r, pb.y), 0.0, 0.25, 0.0, 0.05, uShadowTint);
      seen = wBedSeen(lit, alb, pb, q, hd, px, rk, cW, nq9);
    }
    // Depth colour, in painted stages: the clear shallows, turquoise over a few metres of sand,
    // then the preset's deep blue offshore.
    // The depth used for colour wanders by a quarter either way in broad patches, so the stage
    // edges are soft and irregular rather than following one contour.
    // Broad patches and a ragged edge, so no stage follows one contour round the island.
    float hdc = hd * (0.6 + 0.8 * vnoise(q * 0.012 + 11.0)) + 2.5 * (vnoise(q * 0.035 + 4.0) - 0.5) + 1.2 * (nq9 - 0.5);
    float depthK = 1.0 - exp(-max(hdc, 0.0) * 0.16);
    float kb = depthK * 5.0 + vnoise(q * 0.04);
    depthK = mix(depthK, (floor(kb) + smoothstep(0.2, 0.8, fract(kb))) / 5.0, 0.12);
    vec3 turq = mix(cW, uWaterDeep, 0.32);
    turq = max(mix(vec3(dot(turq, vec3(0.2126, 0.7152, 0.0722))), turq, 0.84), 0.0) * vec3(0.94, 1.02, 1.0);
    // Open water: the preset's deep blue at full saturation.
    vec3 deepS = max(mix(vec3(dot(uWaterDeep, vec3(0.2126, 0.7152, 0.0722))), uWaterDeep, 1.2), 0.0);
    vec3 teal = mix(turq, deepS, 0.55) * vec3(0.95, 1.03, 1.0);
    float tealE = depthK + 0.08 * (nq9 - 0.5);
    vec3 bodyCol = mix(mix(mix(cW, turq, smoothstep(0.02, 0.3, depthK)), teal, smoothstep(0.3, 0.48, tealE)), deepS, smoothstep(0.5, 0.82, tealE));
    // The shallow cyan calms toward teal with distance.
    bodyCol = mix(bodyCol, teal, smoothstep(40.0, 300.0, dist) * 0.35 * (1.0 - smoothstep(0.4, 0.8, depthK)));
    vec3 coolBody = bodyCol;
    // The low sun and the warm sky tint the whole body, whichever way the view looks.
    float warmSky = smoothstep(0.08, 0.35, uSunColor.r - uSunColor.b) * (1.0 - uNight);
    // 1 under a low sun (morning, golden hour, sunset), 0 at noon and at night: then the sea keeps a
    // cool slate and blue-green body, with the warmth on the crests, the mirror's bright facets and
    // the glitter, never one milky field.
    float lowSun = smoothstep(0.3, 0.6, uSunColor.r - uSunColor.b) * (1.0 - uNight);
    vec3 sunHue = uSunColor / max(max(uSunColor.r, max(uSunColor.g, uSunColor.b)), 0.05);
    // The night's darker mirror, eased at dusk: the twilight sky still lights the water.
    float nDim = uNight * (1.0 - 0.7 * uDusk);
    bodyCol = mix(bodyCol, bodyCol * mix(vec3(1.0), sunHue * 1.1, 0.35 * (1.0 - 0.75 * lowSun)), warmSky);
    // Ankle-deep water is wholly clear: the bed reads through the last decimetres as it does through
    // the beach's strip under the water.
    float clarity = mix(1.0, exp(-hd * 0.38), smoothstep(0.1, 0.6, hd)) * seeBed;
    vec3 col = mix(bodyCol, seen, clarity);
    // Aerated water under the propeller trail: a paler band of the water's own colour, taking the
    // light's hue at a low sun (warm grey-gold, never slate); the slick beyond it a touch darker
    // and glassier.
    float colL = dot(col, vec3(0.2126, 0.7152, 0.0722));
    vec3 aerC = mix(vec3(colL), col, 0.75) * mix(1.06, 1.2, warmSky) + 0.01 * (1.0 - uNight);
    aerC = mix(aerC, colL * 1.25 * sunHue + 0.02, 0.6 * warmSky * (1.0 - 0.45 * lowSun));
    col = mix(col, aerC, max(wk.aer * 0.55, wk.brk * 0.65));
    col *= 1.0 - 0.07 * wk.slick * (1.0 - wk.aer);
    // Wave faces turned to the light read a shade lighter, backs a shade darker; not in the last
    // decimetres, which match the beach's strip under the water.
    vec2 Ls = normalize(uSunDir.xz + 1e-5);
    col *= 1.0 + clamp(dot(-sl, Ls) * 2.0, -0.16, 0.16) * (1.0 - uNight * 0.5) * smoothstep(0.1, 0.6, hd);
    // Painted swell lines offshore: lighter crests, darker troughs (they show the swell bending),
    // fading well before the far haze.
    float offs = smoothstep(1.5, 5.0, s.h);
    float swk = offs * (1.0 - 0.6 * uNight * (1.0 - 0.5 * uDusk)) * (1.0 - 0.8 * smoothstep(500.0, 1800.0, dist)) * smoothstep(0.008, 0.04, -V.y);
    col *= 1.0 + s.swell * 0.4 * swk;
    // Under a low sun the crests catch its warm light; at dusk the afterglow's last warmth (rose).
    vec3 crestC = mix(cW, cW * 0.5 + sunHue * 0.45, lowSun) * 1.15 + 0.05;
    crestC = mix(crestC, uSkyHorizon * 0.3 / max(uWorldTint, vec3(0.05)), 0.6 * uDusk);
    col = mix(col, crestC, smoothstep(0.35, 0.85, s.swell) * 0.45 * swk);
    // Light through the thin lip of a steepening crest.
    col = mix(col, cW * 1.3 * mix(vec3(1.0), uSunColor, 0.5) + 0.02, s.crest * 0.55);
    // Ripple marks and the chop's painted tones also shade the body a touch (facets turned to the
    // viewer deeper, the backs paler).
    col *= 1.0 - 0.07 * tone * deepK * (1.0 - lostF);

    // Mirror: the real scene above the water (sky, clouds, hills, island, buoys), broken up by
    // the waves.
    vec3 skyH = skyColor(normalize(vec3(V.x, 0.004, V.z)));
    vec3 refl;
    vec3 streak = vec3(0.0);
    vec2 tilt = rip + sl * 0.6 + gU;
    float grazing = 1.0 - smoothstep(0.02, 0.35, -V.y);
    float rough = sqrt(resV + lostV) * gust;
    // The night look on the water, held off the boat's own mirror image (warm wood and her skin
    // are no lights); the lamps' own reflections (pre-divided by the world tint, as light) and
    // the lighthouse lamp's column, which also gathers its sparkles in the glitter below.
    float nK = smoothstep(0.35, 0.7, uNight) * (1.0 - wk.near);
    vec3 lampAdd = vec3(0.0);
    float lampCol = 0.0;
    if (uReflOn > 0.5) {
      vec4 rp = uReflMat * vec4(vWPos.x, uReflY, vWPos.z, 1.0);
      vec2 ruv = rp.xy / rp.w;
      // Shallow-water distortion as before; offshore a facet tilted by g turns the mirrored ray by
      // 2g, so the image shifts by that angle on screen: mostly up and down (reflections stretch
      // into broken vertical bands), painted gentler than the physics so they stay readable.
      // At night less sideways zig-zag, so lit windows streak instead of squiggling.
      vec2 dS = tilt * vec2(0.05 * (1.0 - 0.5 * uNight), 0.08) * (0.25 + 0.75 * near);
      vec2 dO = vec2(vFoc.x * dot(tilt, side) * 0.25, vFoc.y * dot(tilt, fwd)) * 0.3 * (1.0 - 0.85 * farK);
      // Near the eye the chop would shear the mirror into vertical slivers; there it is shifted
      // by the horizontal ripple bands instead.
      vec2 tB = rip + sl * 0.6 + fwd * band * 0.06;
      // Close to the eye a few metres of water span many rows of the mirror, so the swell's tilt
      // is eased there or it would stretch tall objects apart (a gap under the lantern).
      vec2 dB = vec2(vFoc.x * dot(tB, side) * 0.25, vFoc.y * dot(tB, fwd) * mix(0.2, 1.0, smoothstep(5.0, 60.0, dist))) * 0.3;
      ruv += mix(dS, mix(dO, dB, 1.0 - smoothstep(60.0, 400.0, dist)), chopK);
      // Churned water behind the boat scatters what little mirror is left into fragments.
      if (wk.brk > 0.002) ruv += (vec2(vnoise(q * 2.3 + uTime), vnoise(q * 2.3 - uTime + 4.0)) - 0.5) * 0.05 * wk.brk;
      // Inside a break band the facets look further up the scene (sky shows through a dark
      // reflection), the band's ends shifted sideways; the strokes jog the image up and down.
      ruv += vec2(brkB.z * brkB.x * 0.006, -brkB.x * (0.01 + 0.02 * grazing) - strokes * 0.006 - dabs * 0.004);
      // Beyond the mirrored horizon the texture holds only the underside of the sky dome (dark):
      // no tap may cross it, so the far water never picks up dark patches.
      vec4 rh = uReflMat * vec4(cameraPosition.x + V.x * 2e4, uReflY, cameraPosition.z + V.z * 2e4, 1.0);
      float hy = rh.y / rh.w - 0.002;
      // Brushed softness: taps down the screen, longer where the water is rougher, at grazing
      // angles and inside the break bands. A reflection also blurs with its distance from what it
      // mirrors: the far edge of a reflected hill (well below the mirrored horizon) blends into the
      // sky over tens of pixels, while the houses and the island at the waterline stay crisp.
      float farR = (1.0 - uNight) * grazing * smoothstep(0.06, 0.14, hy - ruv.y);
      // ...and its far edge wanders with large smooth noise, so no single contour runs across.
      float blurD = 0.0;
      if (farR > 0.001) {
        ruv.y += (vnoise(q * 0.012 + 7.0) - 0.5) * 0.035 * farR;
        blurD = 0.1 * (1.0 - uNight) * grazing * clamp(hy - ruv.y - 0.08, 0.0, 0.25) * (0.6 + 0.8 * vnoise(q * 0.02 + 3.0));
      }
      float span = (0.004 + 0.018 * clamp(rough * 5.0, 0.0, 1.0) + 0.012 * brkB.x) * (0.35 + 0.65 * grazing) * chopK + blurD;
      // Her own image is a soft painted band, never the half-res texture's stepped edges.
      span = max(span, 0.004 * wk.near);
      vec3 acc = vec3(0.0), mx = vec3(0.0);
      float ws = 0.0;
      float wph = vnoise(vec2(ruv.y * 70.0 + brkB.z, uTime * 0.8)) * 6.2831853;
      float wam = 0.0015 * chopK;
      vec3 skyFill = skyH * uWorldTint;
      // Taps jittered per pixel, so a wide blur is a smooth ramp and not five stacked steps.
      float tj = (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5) * 0.5 * smoothstep(0.002, 0.008, blurD);
      // Under about a texel of spread (steep views) one tap is the same image.
      int nT = span > 0.0025 ? 2 : 0;
      for (int i = -nT; i <= nT; i++) {
        float fi = float(i) * 0.5 + tj;
        float wob = sin(wph + fi * 2.7) * wam;
        vec2 tu = ruv + vec2(wob, fi * span);
        tu.y = min(tu.y, hy);
        vec4 c4 = textureLod(uRefl, clamp(tu, 0.001, 0.999), 0.0);
        // At night reflected land and roofs are a darker band than the sky they stand against.
        vec3 c = mix(skyFill, c4.rgb * (1.0 - 0.4 * nDim), clamp(c4.a, 0.0, 1.0));
        float w = 1.0 - 0.6 * abs(fi);
        acc += c * w; ws += w;
        mx = max(mx, c);
      }
      refl = acc / ws;
      float lift = dot(mx - refl, vec3(0.2126, 0.7152, 0.0722));
      // Only at night: at sunset the brightest tap would drag the sun's halo into needles.
      streak = max(mx - refl, 0.0) * smoothstep(0.35, 0.7, uNight) * smoothstep(0.012, 0.1, lift);
      // Under a low sun the mirror's darker parts (reflected land, the higher sky) sit a step below
      // the bright horizon they stand against, so the mirrored hills keep their weight.
      refl *= 1.0 - 0.2 * lowSun * smoothstep(0.02, 0.12, dot(skyFill - refl, vec3(0.2126, 0.7152, 0.0722)));
      // Night: only the lights (windows, lamps, the lantern) smear into long streaks toward the
      // eye, three to six times their own height, tapering away from the light; the dark
      // reflections of the hills and the island stay whole. The streaks break into dashes of
      // uneven length and gap from noise in log distance and azimuth, and wobble sideways.
      if (uNight > 0.35) {
        // Taps about one small light's height apart, so a window smears into one continuous
        // streak (no copies, no ladder) several times its own height.
        float sl2 = (0.08 + 0.09 * grazing) * max(chopK, 0.75);
        vec2 rq = q - cameraPosition.xz;
        float lr = log(max(length(rq), 1.0));
        float az = oAz(V);
        // Long dashes with uneven gaps (a few short breaks), not a row of short squiggles.
        float dn2 = vnoise(vec2(az * 30.0, lr * 3.2 - uTime * 0.4)) * 0.6 + vnoise(vec2(az * 60.0 + 3.0, lr * 8.0 + uTime * 0.7)) * 0.4;
        // Taps closer together than a window is tall, so the smear is continuous: fewer would
        // print a ladder of window copies, and dithering them reads as hatching.
        vec3 lm = vec3(0.0);
        float lmB = 0.0, fB = 0.0, lcB = 0.0;
        float wph2 = vnoise(vec2(ruv.y * 22.0, uTime * 0.6 + az * 9.0)) * 6.2831853;
        for (int i = 0; i < 16; i++) {
          float fi = (float(i) + 0.5) / 16.0;
          float wob = sin(wph2 + fi * 4.3) * 0.002 * chopK * (0.5 + fi);
          vec2 tu = ruv + vec2(wob, fi * sl2);
          tu.y = min(tu.y, hy);
          vec3 c = textureLod(uRefl, clamp(tu, 0.001, 0.999), 0.0).rgb;
          float lc = dot(c, vec3(0.2126, 0.7152, 0.0722));
          // Lamps and windows are warm; the pale tower, the sky and the moon are not. Relative, as
          // a lamp's over-bright core is nearly white.
          float wm = max(smoothstep(0.04, 0.12, (c.r - c.b) / (c.r + 0.05)), smoothstep(0.9, 1.6, lc) * step(c.b, c.r * 1.02));
          vec3 ct = c * smoothstep(0.1, 0.3, lc) * wm * (1.0 - 0.4 * fi);
          float cl = dot(ct, vec3(0.2126, 0.7152, 0.0722));
          if (cl > lmB) { lmB = cl; fB = fi; lcB = lc; }
          lm = max(lm, ct);
        }
        float dash = smoothstep(0.24, 0.36, dn2 + 0.2 * brkB.x - 0.15 * brkB.y + 0.1 * strokes);
        // A light's own mirror image is broken by the same dashes and held below the light: warm,
        // never clipped to white (the lantern is far brighter than the tone curve can show).
        vec3 warmL = vec3(1.0, 0.56, 0.24);
        float lumR = dot(refl, vec3(0.2126, 0.7152, 0.0722));
        // Dim, broad light (the beams' haze in the mirror) is broken by the chop into uneven
        // patches with a few sparkles at their edges, never a smooth band or a chain of puffs.
        float bz = vnoise(q * 0.05 + vec2(uTime * 0.07, 0.0)) * 0.55 + vnoise(q * 0.17 - vec2(0.0, uTime * 0.11) + 4.0) * 0.3 + vnoise(q * 0.6 + 9.0) * 0.15;
        float bP = smoothstep(0.38, 0.62, bz);
        float bS = step(0.955, hash12(floor(gl_FragCoord.xy * 0.5) + floor(uTime * 3.0))) * smoothstep(0.2, 0.5, bz) * (1.0 - bP);
        float bBrk = 0.2 + 1.0 * bP + 1.6 * bS;
        // Whatever the mirror shows above the sky's own level (the beam haze, the pale tower)
        // breaks into those patches too.
        vec3 exS = max(refl - skyFill, 0.0);
        refl -= exS * (1.0 - mix(1.0, bBrk, 0.85)) * nK;
        // Wide enough to take the window's anti-aliased rim too, or hollow frames are left behind.
        // Also the near-white lamp room: bright and not blue (the moon and the sky are).
        float hk = smoothstep(0.06, 0.2, lumR) * max(smoothstep(-0.02, 0.05, refl.r - refl.b), smoothstep(0.3, 0.6, lumR) * step(refl.b, refl.r * 1.05)) * nK;
        refl = mix(refl, min(refl, skyFill * 0.45), hk);
        // Dashes measured in log distance along the water (smooth down the streak), uneven lengths
        // and gaps from the noise, wider gaps further from the light. One field for every light, so
        // a lamp's dim rim and bright core break together (two would leave a hollow outline).
        float dashS = smoothstep(0.27 + 0.3 * fB, 0.38 + 0.3 * fB, vnoise(vec2(az * 22.0 + 5.0, lr * 9.0 - uTime * 0.5)) * 0.7 + 0.3 * vnoise(vec2(az * 47.0 + 9.0, lr * 23.0 + uTime * 0.9)));
        dash = mix(dashS, dash * dashS, 0.3);
        // Unbroken at the light itself: its own image stays whole, the gaps open further down.
        dash = max(dash, 1.0 - smoothstep(0.03, 0.15, fB));
        vec3 sk = max(lm - refl, 0.0);
        float skL = dot(sk, vec3(0.2126, 0.7152, 0.0722));
        // Capped first, dashed after, so the gaps stay gaps however bright the light.
        // Light, not paint: a warm glow added over the dark water, a bright soft-shouldered core
        // (never clipped), dark water in the gaps, fading down the streak.
        // Soft shoulder: the light's own falloff survives instead of a flat plateau, and the red
        // stays below where the tone curve would bleach it pink-grey.
        float lampK = smoothstep(1.2, 3.0, lcB);
        float skC = skL / (skL + mix(0.6, 3.0, lampK));
        float fade = (1.0 - 0.55 * fB) * (0.75 + 0.25 * vnoise(vec2(az * 140.0, ruv.y * 90.0)));
        // Lights far brighter than a window glow gold rather than grey: more gain, deeper orange.
        sk = mix(vec3(1.0, 0.55, 0.2) * 0.85, vec3(1.0, 0.5, 0.16) * 1.5, lampK) * skC * dash * fade;
        float dimK = 1.0 - smoothstep(0.2, 0.45, lcB);
        sk *= mix(1.0, bBrk, dimK);
        // The lighthouse lantern and the pier lamps get their own reflections below: they are left
        // out of the smear, which copied the lamp room's hard outline down the water as flat blocks
        // (and in the clear shallows, where the mirror is gone, left one floating on its own).
        vec2 tuB = vec2(ruv.x, min(ruv.y + fB * sl2, hy));
        vec2 asp = vec2(vFoc.y / vFoc.x, 1.0);
        float exL = 1.0;
        vec4 luv = uReflMat * vec4(uLampPos, 1.0);
        if (luv.w > 0.0) {
          float rL = 0.5 * vFoc.y * 3.4 / max(distance(cameraPosition, uLampPos), 1.0);
          exL = smoothstep(rL * 0.7, rL * 1.5, length((tuB - luv.xy / luv.w) * asp));
        }
        for (int i = 0; i < 3; i++) {
          vec4 Lp = uPierLamps[i];
          if (Lp.w < 0.5) continue;
          vec4 puv = uReflMat * vec4(Lp.xyz, 1.0);
          if (puv.w <= 0.0) continue;
          float rP = 0.5 * vFoc.y * 0.8 / max(distance(cameraPosition, Lp.xyz), 1.0);
          exL = min(exL, smoothstep(rP * 0.7, rP * 1.5, length((tuB - puv.xy / puv.w) * asp)));
        }
        // Replaces the brushed-taps streak, which has no dashes.
        streak = mix(streak, sk * exL, nK);

        // The lamps' reflections come from the water's own slopes: the facets that send a lamp's
        // light to the eye. A bright core where the lamp's image lies, and a long soft column
        // round it toward the eye and away, wobbling with the ripples and the chop and breaking
        // into dashes away from the core; the pier lamps also lay a soft warm pool on the water
        // round their feet. They thin out in the last half metre of depth, where the water shows
        // the sand rather than the sky, so nothing is cut off at the shore.
        vec3 Pw = vec3(vWPos.x, surfY, vWPos.z);
        vec2 mG = sl * 0.6 + (gU - rip) * 0.35;
        // A long, fairly narrow column (a lamp is no moon) and a small core, even on choppy water.
        float sgU = sqrt(resV * 0.5 + lostV);
        float sgG = 0.025 + 0.65 * sgU, sgC = 0.01 + 0.15 * sgU;
        float dashL = smoothstep(0.3, 0.52, dn2 + 0.12 * brkB.y - 0.1 * strokes);
        float shL = smoothstep(0.04, 0.45, hd + 0.25 * (vnoise(q * 0.12) - 0.5)) * (1.0 - s.foam) * (1.0 - 0.6 * s.brk);
        {
          vec3 Hl = normalize(normalize(uLampPos - Pw) - V + vec3(0.0, 1e-4, 0.0));
          vec2 el = -Hl.xz / max(Hl.y, 0.05) - mG;
          float ee = dot(el, el);
          float gL = exp(-ee / (2.0 * sgG * sgG)), cL = exp(-ee / (2.0 * sgC * sgC));
          float onL = smoothstep(0.0, 0.5, uBeam);
          lampCol = sqrt(sqrt(gL)) * onL * shL;
          lampAdd += vec3(1.0, 0.64, 0.3) * (0.16 * gL * mix(dashL, 1.0, cL) + 0.6 * cL) * onL;
        }
        for (int i = 0; i < 3; i++) {
          vec4 Lp = uPierLamps[i];
          if (Lp.w < 0.5) continue;
          vec3 Hp = normalize(normalize(Lp.xyz - Pw) - V + vec3(0.0, 1e-4, 0.0));
          vec2 ep = -Hp.xz / max(Hp.y, 0.05) - mG;
          float ee = dot(ep, ep);
          float gP = exp(-ee / (2.0 * sgG * sgG)), cP = exp(-ee / (2.0 * sgC * sgC));
          vec3 toL = Lp.xyz - cameraPosition;
          float nearP = 1.0 / (1.0 + dot(toL, toL) / 3600.0);
          vec2 dq = q - Lp.xz;
          float pool = exp(-dot(dq, dq) / 50.0) * (0.55 + 0.45 * bP);
          lampAdd += vec3(1.0, 0.6, 0.26) * ((0.14 * gP * mix(dashL, 1.0, cP) + 0.5 * cP) * nearP + 0.075 * pool);
        }
        lampAdd *= nK * shL;
      }
      // In the surf zone the breaking crests stand between the water and distant land, so the
      // shallows mirror only the sky.
      // At night the dark hills and roofs show across the top of the water instead.
      float surfK = (1.0 - smoothstep(2.0, 5.0, s.h)) * (1.0 - 0.95 * uNight);
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
    // Churned water holds no image, but its broken facets still scatter the sky's broad colour,
    // so the boil stays in the scene's light (gold at a low sun) instead of the cool body.
    refl = mix(refl, skyH * uWorldTint, clamp(wk.brk * 1.2, 0.0, 1.0));
    vec3 reflRaw = refl;
    // The boat's own mirror image sits under her slightly darker and greyer, in her own hues: it
    // is not tinted by the sky's mirror colour nor washed into the blue water.
    float objR = wk.near * smoothstep(0.06, 0.22, length(reflRaw - skyH * uWorldTint));
    vec3 reflB = mix(vec3(dot(reflRaw, vec3(0.2126, 0.7152, 0.0722))), reflRaw, 0.8) * 0.8 / max(uWorldTint, vec3(0.05));
    float rl = dot(refl, vec3(0.2126, 0.7152, 0.0722));
    // In low sun the warmth comes from the bright sky in the mirror, not from the body; under a low
    // sun the preset's warm reflection tint is half neutral, as that sky is gold already.
    vec3 wRefl = mix(uWaterRefl, vec3(dot(uWaterRefl, vec3(0.3333))), 0.5 * lowSun);
    refl = mix(vec3(rl), refl, 1.15) * wRefl * mix(0.9, 0.68, nDim) * (1.0 + 0.12 * warmSky * (1.0 - lowSun));
    refl /= max(uWorldTint, vec3(0.05));
    // At dusk the dark mirrored hills and roofs take the deep water's blue-violet at their own value:
    // a soft darker band in twilight water, never a brown hole. The bright afterglow keeps its warmth.
    float rlD = dot(refl, vec3(0.2126, 0.7152, 0.0722));
    vec3 deepHue = mix(vec3(1.0), uWaterDeep / max(dot(uWaterDeep, vec3(0.2126, 0.7152, 0.0722)), 1e-3), 0.5);
    refl = mix(refl, rlD * deepHue, 0.6 * uDusk * (1.0 - smoothstep(0.08, 0.3, rlD)));
    refl = mix(refl, wCool(refl), 0.55 * (1.0 - smoothstep(0.3, 1.5, s.h)));
    refl = mix(refl, reflB, objR);
    float cosT = max(dot(-V, Nw), 0.0);
    // Offshore the balance is painted: the mirror takes over toward grazing angles, the water's
    // own colour looking down.
    // At night and in low sun the mirror carries more of the scene (sky gradient, hill and roof
    // silhouettes), so the water is never one flat field.
    float fres = mix(0.04 + 0.96 * pow(1.0 - cosT, 5.0), 0.06 + 0.9 * pow(1.0 - cosT, 3.0), chopK);
    // Under a low sun only a little: looking down the water shows its cool body, not the gold sky.
    fres = max(fres, 0.32 * uNight * max(chopK, 0.5 * offs) + 0.42 * warmSky * chopK * (1.0 - 0.6 * lowSun));
    // Wave faces and the churned surf zone show their own body; the clear shallows let the bed through.
    float rk = (1.0 - s.foam) * (1.0 - mix(0.85, 0.25, deepK) * clamp(length(sl) * 3.0, 0.0, 1.0)) * (1.0 - 0.75 * s.brk) * mix(0.6, 1.0, smoothstep(0.8, 4.0, s.h));
    // Water a few centimetres deep shows the sand rather than the sky, so the sea fades into the
    // beach's swash sheet with no seam.
    rk *= mix(0.04, 1.0, smoothstep(0.5, 1.4, hd + 0.3 * (vnoise(q * 0.12) - 0.5)));
    // Inside churned water the mirror is only that scattered sky, and weaker.
    rk *= 1.0 - 0.5 * wk.brk;
    // Under her image the blue body is greyed first: a part blend of red paint into blue water
    // would print violet.
    col = mix(col, vec3(dot(col, vec3(0.2126, 0.7152, 0.0722))), objR * 0.7);
    col = mix(col, refl, fres * 0.92 * rk);
    col = mix(col, reflB, objR * rk * 0.85);
    // Sun shadows cast near the boat (her own, a buoy's) darken the water body a shade, warm-violet,
    // never revealing anything brighter.
    // One bilinear 2x2 tap: the full PCF would bloat the whole sea shader for a soft tint.
    if (wk.near > 0.01 && uNight < 0.9 && uShadowOn > 0.5) {
      vec4 sc = uShadowMat * vec4(vWPos.x, surfY + 0.05, vWPos.z, 1.0) + vec4(uSunDir * 0.04, 0.0);
      vec3 sp = sc.xyz / sc.w;
      if (sp.x > 0.0 && sp.x < 1.0 && sp.y > 0.0 && sp.y < 1.0 && sp.z < 1.0) {
        vec2 tc = sp.xy / uShadowTexel - 0.5, ff = fract(tc), b0 = (floor(tc) + 0.5) * uShadowTexel;
        float z0 = sp.z - 0.0008;
        float l00 = step(z0, textureLod(uShadowMap, b0, 0.0).r), l10 = step(z0, textureLod(uShadowMap, b0 + vec2(uShadowTexel.x, 0.0), 0.0).r);
        float l01 = step(z0, textureLod(uShadowMap, b0 + vec2(0.0, uShadowTexel.y), 0.0).r), l11 = step(z0, textureLod(uShadowMap, b0 + uShadowTexel, 0.0).r);
        float shd = (1.0 - mix(mix(l00, l10, ff.x), mix(l01, l11, ff.x), ff.y)) * wk.near * (1.0 - uNight);
        col *= mix(vec3(1.0), vec3(0.78, 0.7, 0.76), shd);
      }
    }
    // Her own shadow comes from her map (she is not in the bay's): wading, or beside the skiff.
    if (uCharShadowOn > 0.5 && uNight < 0.9) {
      float shc = (1.0 - charShadow(vec3(vWPos.x, surfY + 0.02, vWPos.z))) * (1.0 - uNight);
      col *= mix(vec3(1.0), vec3(0.78, 0.7, 0.76), shc);
    }
    // The troughs and darker strokes keep the cool body, so warm water never reads as sand.
    col = mix(col, coolBody * 0.9, (0.35 + 0.2 * lowSun) * warmSky * clamp(smoothstep(0.1, 0.7, -s.swell) * offs + 0.3 * brkB.x, 0.0, 1.0) * rk);
    // Under a low sun the chop's facets turned to the eye mirror the higher, cooler sky: painted as
    // slate and blue-green strokes between the gold of the facets that mirror the low sky, so the
    // sea is never one milky field (the far band, where the chop is too fine to draw, stays gold).
    vec3 coolSky = mix(coolBody, uSkyZenith * 0.95 / max(uWorldTint, vec3(0.05)), 0.6);
    col = mix(col, coolSky, 0.85 * lowSun * chopK * smoothstep(0.15, 0.85, tone) * rk);
    // Thin ripple lines of the break bands catch a little more light, broken along their length.
    col *= 1.0 + 0.08 * brkB.y * rk * smoothstep(0.35, 0.6, vnoise(q * 0.21 + 3.0));
    // Night: broad moonlit and sky-lit swells of tone over the water body.
    col *= 1.0 + uNight * chopK * (0.35 * (vnoise(q * 0.006 + uTime * 0.01) - 0.5) + 0.12 * s.swell * offs - 0.1 * tone);
    // Far off the sea is one smooth band brightening toward the horizon, taken from the sky.
    float hK = smoothstep(0.06, 0.004, -V.y) * smoothstep(150.0, 700.0, dist) * offs;
    col = mix(col, mix(col, skyH * uWaterRefl * mix(0.82, 0.6, nDim), 0.5 + 0.4 * smoothstep(0.03, 0.004, -V.y)), hK);
    // Lights stretched by the ripples are bright facets, not a faint mirror: they read at any angle.
    // Lit windows streak right up to the shore: only foam and broken surf hide them.
    // Light, not lit surface: undo the world tint applied later, or the warm streaks go tan-grey.
    vec3 stA = streak * uWaterRefl * (1.0 - s.foam) * (1.0 - 0.5 * s.brk) * 1.1 / max(uWorldTint, vec3(0.05));
    col += stA + lampAdd / max(uWorldTint, vec3(0.05));
    // Painted ripple marks: dark ones show more of the water body, light ones catch more sky.
    // Painted chop marks and near strokes are darker or lighter versions of the local colour
    // (never a fixed grey): dark ones a shade deeper, light ones lifted toward the sky they catch.
    // Light ones only a little above the local value (they never paint the sky over a reflection).
    // Under a low sun the dark ones are the cool body showing through the warm mirror.
    float mD = (0.2 * max(dabs, 0.0) + 0.24 * max(strokes, 0.0) + 0.12 * max(farM, 0.0)) * (1.0 - s.foam);
    float mL = (0.15 * max(-dabs, 0.0) + 0.18 * max(-strokes, 0.0) + 0.1 * max(-farM, 0.0)) * (1.0 - s.foam);
    col = mix(col, coolSky * 0.9, clamp(mD * 2.2 * lowSun, 0.0, 1.0));
    col *= (1.0 - mD) * (1.0 + mL);

    // The lighthouse beams' wedge on the water, and the facet slope that mirrors the lamp into the
    // eye (its sparkles come from the same pass over the facet cells as the glitter below).
    float bk = 0.0, sb = 0.03;
    vec2 sHb = vec2(100.0);
    if (uBeam > 0.0) {
      vec2 rel = q - uLampPos.xz;
      float rlen = length(rel);
      vec2 rd = rel / max(rlen, 1e-3);
      float al = dot(rd, uBeamDir);
      float cr = dot(rd, vec2(-uBeamDir.y, uBeamDir.x)) * sign(al);
      // Uneven in both directions (2D noise over the water), so the edge never wiggles regularly.
      float wob = 0.03 * (vnoise(q * 0.018 + vec2(uTime * 0.05, 0.0)) - 0.5) + 0.012 * (vnoise(q * 0.07 + 5.0) - 0.5);
      // A soft feathered wedge (no hard edge), brightest along its axis, its rims eaten unevenly,
      // fading along its length well before it can lay one long grey band across the bay.
      float cx = abs(cr + wob);
      float bw = 0.085 * (0.75 + 0.5 * vnoise(q * 0.025 + 11.0));
      float wedge = exp(-cx * cx / (2.0 * bw * bw)) * smoothstep(0.5, 0.9, abs(al));
      wedge *= mix(1.0, smoothstep(0.25, 0.65, vnoise(q * 0.09 + vec2(0.0, uTime * 0.1))), smoothstep(0.4, 1.4, cx / bw));
      bk = wedge * smoothstep(14.0, 60.0, rlen) * exp(-rlen / 170.0);
      vec3 Hb = normalize(normalize(uLampPos - vWPos) - V + vec3(0.0, 1e-4, 0.0));
      sHb = -Hb.xz / max(Hb.y, 0.05);
      sb = sqrt(resV + lostV) * 1.4 + 0.03;
    }

    // Glitter path under the sun or moon: a broken column of flat painted dabs. Each wave facet
    // flashes when it mirrors the light into the eye, so the column is as wide as the water is
    // rough (the chop, its gusts and each preset's spread) and follows the swell's tilt.
    vec3 Ld = normalize(uGlintDir);
    vec3 H = normalize(Ld - V);
    vec2 sH = -H.xz / max(H.y, 0.05);
    // Under a low sun the facets that send it to the eye near the viewer would have to be
    // steeper than the chop; the path is painted on down to the foreground instead.
    float lowL = 1.0 - smoothstep(0.1, 0.45, Ld.y);
    vec2 sH0 = sH;
    sH -= fwd * dot(sH, fwd) * 0.8 * lowL;
    float lightUp = smoothstep(-0.02, 0.04, Ld.y);
    float spread = uGlintShape.x / 0.15;
    // The column narrows toward the horizon and widens toward the eye.
    float colW = 0.55 + 0.45 * smoothstep(0.0, 0.14, -V.y) + 0.35 * lowL * smoothstep(0.05, 0.4, -V.y);
    float sigT = mix(uGlintShape.x, sqrt(resV * 0.5 + lostV) * spread * 2.6 + 0.02, deepK) * colW;
    // The wake's slopes fan out from the boat; tilting the broad path and glow with them draws
    // bright rays from the stern, so only the facets below follow them.
    vec2 dH = sH - (sl - wk.grad * 1.35) * 0.6;
    float path = exp(-dot(dH, dH) / (2.0 * sigT * sigT)) * lightUp;
    // A soft glow under the low sun or the moon, tinted by the light (pale gold, orange-pink).
    float glowS = sigT * 2.4;
    float glow = exp(-dot(dH, dH) / (2.0 * glowS * glowS)) * lightUp * chopK;
    vec3 gCol = mix(uGlintCol, uGlintCol * mix(vec3(1.0), sunHue, 0.6), warmSky);
    // Shallows: the old soft dashes.
    float dn = 0.0;
    if (path > 0.04) {
      // A frame fixed for the whole frame (the camera heading): one turning with each pixel's view
      // sweeps the world position across the noise and draws radial needles.
      vec2 cf = normalize(-vec2(viewMatrix[0][2], viewMatrix[2][2]) + 1e-5);
      vec2 sq = vec2(dot(q, vec2(-cf.y, cf.x)), dot(q, cf)) / (1.5 + dist * 0.012);
      dn = vnoise(sq * vec2(0.7, 1.8) + vec2(uTime * 0.4, -uTime * 0.8)) * 0.65
         + vnoise(sq * vec2(1.5, 3.2) + vec2(-uTime * 0.5, uTime * 0.45) + 5.0) * 0.35;
      float th = 1.0 - path * 0.32;
      dn = smoothstep(th, th + 0.07, dn) * smoothstep(0.04, 0.3, path) * 1.8 * path;
    }
    // Open water: resolved facets near, stochastic facets in view-anchored cells further out. One
    // pass over the cells serves the sun or moon path and the lighthouse lamp (column and beams).
    float glit = 0.0, lampG = 0.0;
    bool gA = deepK > 0.0 && path > 0.04;
    bool gB = deepK > 0.0 && max(bk, lampCol * nK) > 0.002;
    if (gA || gB) {
      // Where the chop is all too fine to draw there are no resolved facets.
      float gN = 0.0;
      if (gA && lostF < 0.97) {
        vec2 e2 = sl * 0.6 + gC * spread - sH0;
        float rN = sigR * spread * 0.22 + 0.003;
        float aN = fwidth(length(e2)) + 1e-4;
        // Broken into dabs so the resolved facets never draw continuous slope contours.
        gN = (1.0 - smoothstep(rN - aN, rN + aN, length(e2))) * smoothstep(0.45, 0.7, vnoise(q * 0.45 + O_WIND * uTime * 1.5));
      }
      // Every facet is a mix of the drawn chop and finer ripples, so the cells sit on the chop.
      float sigF = sqrt(resV * 0.5 + lostV) * spread * 2.6 + 0.02;
      vec2 gF = oFanGlint2(fanD, uTime, sl * 0.6 + gC * spread * 0.6, gA ? sH : vec2(100.0), sigF, sigF, sl * 0.6, gB ? sHb : vec2(100.0), sb, sb * 1.1);
      // The glassy slick behind the boat holds a smooth, unbroken streak of light instead.
      glit = max(gN * 0.6 * (1.0 - lostF), gF.x) * (1.0 - 0.6 * wk.slick);
      lampG = gF.y;
    }
    // Under a low sun the path is crisp broken sparkle dabs over a gentle glow: the dabs brighter and
    // near-white, the sheen and the glow held down so the dabs outshine them (and the paint filter
    // keeps them), and capped below the blown white that the bloom would smear into a soft column.
    float glitter = mix(dn, glit * (1.6 + 1.2 * lowSun) + dn * 0.6, deepK) + path * uGlintShape.y * (1.0 - 0.6 * lowSun);
    // No sun flakes on the boat's own mirror image or right round her, where a lone white dab
    // reads as a stray scrap floating off the hull.
    float gk = uGlint * lightUp * (1.0 - s.foam) * mix(0.35, 1.0, smoothstep(0.8, 4.0, s.h)) * (1.0 - wk.brk) * (1.0 - objR * rk) * (1.0 - 0.6 * wk.near);
    // Never a blown white with a bloom halo under a high sun; the low sun's path may burn brighter.
    vec3 gAdd = mix(gCol, vec3(1.0, 0.97, 0.9), 0.4 * lowSun) * glitter * gk;
    gAdd *= min(1.0, mix(0.3, mix(4.0, 1.9, lowSun), max(lowL, uNight)) / max(max(gAdd.r, max(gAdd.g, gAdd.b)), 1e-4));
    col += gAdd;
    col += gCol * glow * gk * (0.05 + 0.32 * warmSky * (1.0 - 0.65 * lowSun) + 0.1 * uNight);
    // The lighthouse lamp's own sparkles in its column on the water.
    col += vec3(1.0, 0.72, 0.42) * lampG * lampCol * nK * 0.9 / max(uWorldTint, vec3(0.05));

    // Foam: white water of the breaking waves, surf on the rocks, and a skirt of surf where the
    // swell meets the island and headland shores (the beach has its own bores and swash).
    // The rocks stand in shallow water: the deep sea skips the loop over them.
    float rf = s.h < 12.0 ? rockFoam(q, s.dir, s.pulse, uTime, px) : 0.0;
    float skirt = (1.0 - smoothstep(0.15, 3.2, s.h)) * smoothstep(-0.3, 0.05, s.h) * (0.45 + 0.75 * s.pulse) * offBeach;
    skirt *= 0.6 + 0.8 * vnoise(q * 0.12 + vec2(0.0, uTime * 0.05));
    // Thick on shores facing the swell, a thin trickle in the lee.
    skirt *= mix(0.2, 1.5, smoothstep(-0.5, 0.6, dot(wDir(0), s.up))) * mix(0.5, 1.0, s.expose);
    // Every island and headland waterline keeps a thin broken wash, even in the lee.
    skirt = max(skirt, (1.0 - smoothstep(0.05, 0.9, s.h)) * smoothstep(-0.3, 0.02, s.h) * offBeach * (0.35 + 0.5 * vnoise(q * 0.3 + vec2(uTime * 0.2, 0.0))) * (0.6 + 0.5 * s.pulse));
    // Far off a waterline a metre wide is less than a pixel: the island and headland skirts are
    // held to a few pixels of broken foam, measured in screen space from the depth's slope.
    float pxd = s.h / max(fwidth(s.h), 1e-4);
    float skPx = 0.0;
    if (px > 0.06 && pxd < 6.0 && s.h < 3.0) {
      skPx = (1.0 - smoothstep(2.0, 5.5, pxd)) * smoothstep(-0.2, 0.02, s.h) * offBeach * smoothstep(0.06, 0.25, px);
      skPx *= smoothstep(0.3, 0.6, vnoise(q * 0.07 + vec2(uTime * 0.12, 0.0)) + 0.25 * s.pulse) * 0.6 + 0.4 * vnoise(q * 0.3 + 5.0);
      skirt = max(skirt, skPx);
    }
    // The island's own shore is too steep for the smoothed depth field, so its skirt is measured
    // from the island's outline: a few pixels of broken surf wherever it meets the water.
    {
      vec2 di = q - vec2(${ISLAND.x.toFixed(1)}, ${ISLAND.z.toFixed(1)});
      float lI = length(di);
      // One pixel's footprint across the outline, from the camera geometry: fwidth jumps from
      // pixel to pixel at a grazing view.
      vec2 uI = di / max(lI, 1e-3);
      float hM = length(dqx);
      float dM = hM * dist / max(cameraPosition.y - uReflY, 0.3);
      float fI = max(abs(dot(fwd, uI)) * dM + abs(dot(side, uI)) * hM, 1e-3);
      // At a grazing view one pixel row spans metres, so the band is held in pixels, not metres.
      if (lI - ${(ISLAND_R0 * 1.21).toFixed(1)} < min(80.0, 40.0 * fI + 0.6)) {
        float an = atan(di.y, di.x);
        float dI = lI - ${ISLAND_R0.toFixed(2)} * (1.0 + 0.14 * sin(3.0 * an + 1.0) + 0.07 * sin(7.0 * an + 2.2));
        float pI = (dI - 0.6) / fI;
        // Lumpy where the swell meets the shore, a thinner wash in the lee, and the band
        // breathes with the swell.
        float exI = smoothstep(-0.4, 0.7, dot(wDir(0), -di / lI));
        // Uneven lumps (noise, not a regular ripple): narrow wash in the lee, bulging surf on the
        // exposed side, a ragged outer edge, and gaps where the band breaks.
        float lumpI = vnoise(vec2(an * 18.0, uTime * 0.25)) * 0.65 + vnoise(vec2(an * 47.0 + 3.0, uTime * 0.4)) * 0.35;
        float wI = mix(7.0, 15.0, exI) * (0.4 + 1.5 * lumpI * (0.6 + 0.8 * exI)) * (0.9 + 0.2 * s.pulse);
        wI *= 0.8 + 0.4 * vnoise(vec2(an * 90.0, pI * 0.4 + uTime * 0.5));
        float sI = (1.0 - smoothstep(wI * 0.6, wI, pI)) * smoothstep(-7.0, -3.0, dI);
        sI *= smoothstep(0.18, 0.42, vnoise(vec2(an * 34.0 + 5.0, pI * 0.12 - uTime * 0.3)) + 0.25 * exI + 0.2 * s.pulse);
        // Wet, shadowed water right at the rock: the sky the waves lift into view there would
        // otherwise read as one even pale line, and the foam lumps show against it.
        float cI = (1.0 - smoothstep(0.5, 4.0, pI)) * smoothstep(-7.0, -3.0, dI);
        col *= 1.0 - 0.45 * cI;
        skPx = max(skPx, sI);
        skirt = max(skirt, sI);
      }
    }
    vec2 fq = q - s.dir * uTime * 0.5;
    float fskirt = wLace(fq * 0.9, skirt, 9.0, px);
    float frock = wLace(vec2(dot(q, s.dir) - uTime * 0.6, dot(q, vec2(-s.dir.y, s.dir.x))) * 1.2, clamp(rf * 1.6, 0.0, 1.0), 5.0, px);
    // Lace a few pixels wide is mostly holes: the far skirt keeps its broken body.
    float foam = max(max(s.foam, max(frock, fskirt)), skPx * 0.8);
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
        // Far off (a few pixels per metre) the crest thins and splits into more, shorter dashes.
        float fk = smoothstep(0.08, 0.35, px);
        float seg = 0.5 + 0.5 * sin(along * (3.0 + 3.0 * hash12(hid + 9.9)) * mix(1.0, 1.7, fk) + hash12(hid + 1.1) * 6.28);
        // Two or three uneven dabs with soft ragged rims and patchy tone inside, never a solid
        // white oval.
        float crest = length(vec2(along, (d.x + 0.1) / (0.35 * sz * mix(1.0, 0.45, fk)))) + rag * 0.7 - seg * mix(0.6, 1.1, fk);
        float inner = 0.5 + 0.5 * vnoise(vec2(d.y * 1.3 / sz, d.x * 2.0) + n * 1.7 + 3.0);
        float dens = (1.0 - smoothstep(0.2, 0.9, crest)) * grow * die * inner;
        // The trail: thin broken streaks behind the crest, dissolving as they age.
        float back = -d.x;
        float tl = (1.0 + 4.0 * hash12(hid + 3.7)) * sz * smoothstep(0.0, 0.4, life);
        float trail = smoothstep(-0.2, 0.3, back) * (1.0 - smoothstep(tl * 0.5, tl, back))
                    * (1.0 - smoothstep(0.4, 1.0, abs(along) + rag * 0.4))
                    * mix(smoothstep(0.45, 0.75, vnoise(vec2(d.y * 2.4 / sz, back * 0.7) + n)), 0.2, smoothstep(0.15, 0.5, px))
                    * (1.0 - smoothstep(0.3, 1.0, life)) * 0.75;
        dens = max(dens, trail) * wcK;
        // Lumps sized to the crest itself, so far off, where the lace is solid, a cap is still
        // three or four broken dabs and never one smooth oval.
        float lump = vnoise(vec2(along * 4.0, d.x / (0.32 * sz)) + n * 5.3 + cid * 1.7) + 0.12 * rag;
        dens *= smoothstep(0.38, 0.52, lump + 0.2 * seg - 0.1);
        vec2 lp = vec2(f.y * 1.1, (f.x - run) * 1.4) + cid * 7.3;
        // Held below full white: a far cap stays a soft off-white, with no bloom round it. None
        // right round the boat, where a lone cap reads as a scrap of her own foam cast adrift.
        foam = max(foam, wLace(lp, dens, 3.0 + mod(n, 17.0), px) * mix(0.8, 0.55, smoothstep(0.1, 0.5, px)) * (1.0 - smoothstep(0.35, 1.0, px)) * (1.0 - wk.near));
      }
    }
    // Foam round the buoys.
    float bRing, bDark;
    float bf = buoyFoam(q, uTime, dqx, dqy, px, bRing, bDark);
    if (bf > 0.02) foam = max(foam, max(wLace((q - O_WIND * uTime * 0.25) * 1.7, clamp(bf, 0.0, 1.0), 21.0, px), clamp(bf, 0.0, 1.0) * 0.7 * smoothstep(0.04, 0.15, px)));
    col *= 1.0 - 0.3 * bDark;
    col = mix(col, refl * 1.1 + 0.04, bRing * 0.45 * (1.0 - smoothstep(0.05, 0.25, px)));
    // Pier posts: a thin broken collar where each stands in the water, swelling as the swell
    // passes, and the darker wet water hugging it. The bents are evenly spaced, so the nearest
    // pair is found directly.
    {
      vec2 pq = q - vec2(${PIER_POSTS.x0.toFixed(2)}, ${PIER.z.toFixed(2)});
      if (abs(pq.y) < 3.5 && pq.x > -2.0 && pq.x < ${((PIER_POSTS.n - 1) * PIER_POSTS.step + 2).toFixed(1)} && s.h > 0.05 && px < 0.5) {
        float k = clamp(floor(pq.x / ${PIER_POSTS.step.toFixed(2)} + 0.5), 0.0, ${(PIER_POSTS.n - 1).toFixed(1)});
        vec2 d = vec2(pq.x - k * ${PIER_POSTS.step.toFixed(2)}, abs(pq.y) - ${PIER_POSTS.dz.toFixed(2)});
        float L = length(d) - ${(PIER_POSTS.r * 1.08).toFixed(3)};
        float an = atan(d.y, d.x);
        float w = (0.12 + 0.2 * s.pulse) * (0.6 + 0.8 * vnoise(vec2(an * 2.3 + k * 3.7 + sign(pq.y) * 5.0, uTime * 0.7)));
        float collar = exp(-max(L, 0.0) / w) * smoothstep(-0.04, 0.03, L) * smoothstep(0.05, 0.5, s.h);
        float fade = 1.0 - smoothstep(0.12, 0.5, px);
        foam = max(foam, wLace(q * 2.1, clamp(collar * 1.2, 0.0, 1.0), 13.0, px) * 0.85 * fade);
        col *= 1.0 - 0.28 * exp(-max(L, 0.0) / 0.45) * smoothstep(0.05, 0.5, s.h);
      }
    }
    // The last half metre of depth hands over to the beach's swash foam, so the lace carries on
    // across the waterline instead of stopping at it.
    float hA = 0.02 + max(-u, 0.0) * 0.07;
    if (uBand > 0.5 && hA < 0.6 && s.rock < 0.2) {
      WSwash sw = wSwash(q, -s.h, uTime, px);
      foam = mix(sw.foam, foam, max(smoothstep(0.15, 0.6, hA), smoothstep(0.0, 0.2, s.rock)));
    }
    // The wake: painted crest tone, the dark water against the hull, then its foam.
    col *= (1.0 + wk.crest * mix(0.2, 0.38, smoothstep(0.1, 0.8, pxM)) * (1.0 - 0.5 * farK)) * (1.0 - 0.22 * wk.contact);
    // Seen low across the water the glassy slick reads as a lane: a shade darker than the
    // sparkling chop by day, a little paler under the moon.
    col *= 1.0 + wk.slick * max(grazing, 0.35) * mix(-0.22, 0.2, uNight);
    float foamW = step(foam, wk.foam) * step(0.002, wk.foam);
    foam = max(foam, wk.foam);
    if (foam > 0.002) {
      vec3 Nf = normalize(Nw + vec3(0.0, 1.2, 0.0));
      vec3 fc = wFoamColor(normalize(Nf - vec3(0.0, 0.3 * s.crest, 0.0)), q, col, path);
      // Wake foam is lit by the scene: the low sun's warmth and a broken lit-and-shaded tone through
      // its clumps by day; under the moon only a dim cool grey a little above the dark water. Its
      // lace lets the water show through, more so at night.
      if (foamW > 0.5) {
        float ft = 0.8 + 0.2 * vnoise(q * 1.9 + vec2(uTime * 0.25, 3.0));
        fc = mix(fc * mix(vec3(1.0), sunHue, 0.45 * warmSky) * ft, mix(col, fc, 0.45), uNight);
      }
      col = mix(col, fc, foam * mix(1.0, mix(0.88, 0.6, uNight), foamW));
    }

    // Lighthouse beams sweeping over the water (the wedge found above): as each turns, a long soft
    // band of light fans out across the bay from the island, and the wave facets inside it catch
    // the lamp as sparkles. Most of a beam's light grazes past the water, so seen from high above
    // little more than its sparkles shows.
    if (bk > 0.002) {
      // Broken up by the chop like the moon path: the facets turned to the lamp catch more.
      // Feathered patches of light with gaps between, not lines: no term here follows the chop's
      // tone contours.
      float bnz = vnoise(q * 0.03 + uTime * 0.05) * 0.6 + vnoise(q * 0.11 - uTime * 0.08 + 3.0) * 0.4;
      float br = 0.1 + 0.9 * smoothstep(0.3, 0.8, bnz) - 0.15 * dabs;
      float hiK = 1.0 - 0.7 * smoothstep(8.0, 60.0, cameraPosition.y - uReflY);
      col += vec3(1.0, 0.86, 0.6) * uBeam * bk * (0.4 * br * hiK + 1.2 * lampG + 0.3 * foam);
    }
    col = applyFog(col, vWPos);
    // The far sea melts into the horizon haze: sky and sea meet at a soft light line.
    col = mix(col, skyH, smoothstep(1800.0, 3800.0, dist) * 0.85);
    gColor = vec4(safe3(col), 1.0);
    vec3 vn = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
    if (badF3(vn)) vn = vec3(0.0, 0.0, 1.0);
    gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, 0.0);
  }`;

/**
 * The sea's normal-pass twin (render/mrtSplit.ts): the water's id and no ink mask, with the plain up
 * vector for its normal. The ink pass never inks inside the water (mask 0), so the wave normal only
 * ever met the ink at shoreline edge pixels, where the id step decides the line anyway; recomputing
 * it would cost the twin most of the sea shader.
 */
const NORMAL_FS = /* glsl */ `
  layout(location = 1) out vec4 gNormal;
  uniform float uId;
  uniform float uBand;
  in vec3 vWPos;
  in vec2 vFoc;
  ${COAST_GLSL}
  void main(){
    if (uBand < 0.5) {
      float u = vWPos.x - coastRoadX(vWPos.z) - coastWaterU(vWPos.z);
      if (vWPos.z > ${BAND.z0.toFixed(1)} && vWPos.z < ${BAND.z1.toFixed(1)} && u > ${(BAND.outer + 0.4).toFixed(1)}) discard;
    }
    // Reads every varying, so the vertex stage (and the depth it lands on) is built as for colour.
    if (vFoc.x < -1e30) discard;
    vec3 vn = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, 0.0);
  }`;

const SKIRTS = { value: rockSkirts() };

/**
 * The sea material for the surf band (`band`) or the open-sea grid: one program for both (the
 * switch is a uniform), so the longest compile in the game happens once.
 */
function material(band: boolean): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, ...DEPTH, ...REFL, ...WAKE_U, ...WATER_TOD, uRocks: SKIRTS, uBuoys: BUOY_U, uPierLamps: PIER_LAMP_U, uGridO: GRID_UNIFORM, uBand: { value: band ? 1 : 0 }, uId: { value: ID.water }, uMask: { value: 0 } },
    vertexShader: VS,
    fragmentShader: FS,
  });
  m.userData.normalFS = NORMAL_FS;
  return m;
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
  const m = new THREE.Mesh(g, material(true));
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
  const m = new THREE.Mesh(g, material(false));
  m.frustumCulled = false;
  return m;
}

/** Keep the open-sea grid centred under the camera (call once per frame before rendering). */
export function followSea(cam: THREE.Vector3): void {
  GRID_UNIFORM.value.set(Math.round(cam.x / GRID_SNAP) * GRID_SNAP, Math.round(cam.z / GRID_SNAP) * GRID_SNAP);
  // The sea is built before the bay (its program compiles first), so the lamps arrive later.
  if (!pierLampsSet && PIER_LAMPS.length > 0) {
    for (let i = 0; i < PIER_LAMP_U.value.length && i < PIER_LAMPS.length; i++) PIER_LAMP_U.value[i].set(PIER_LAMPS[i].x, PIER_LAMPS[i].y, PIER_LAMPS[i].z, 1);
    pierLampsSet = true;
  }
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
