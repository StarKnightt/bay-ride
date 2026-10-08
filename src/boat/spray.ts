import * as THREE from "three";
import { TIER } from "../platform";
import { COMMON, G } from "../render/materials";
import { HULL, STEM_Z, waterlineHalf } from "./model";
import { BOOST, type Boat, type BoatSnap } from "./boat";
import { seaHeight } from "../water/query";

/** Particle slots: bow droplets, thin bow sheets, and the prop's low churn. */
const N_DROP = 110;
const N_SHEET = 70;
const N_PROP = 44;
const N = N_DROP + N_SHEET + N_PROP;

const hash = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const sm = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};
const clamp01 = (x: number) => Math.min(Math.max(x, 0), 1);

/**
 * Translucent blending into the colour target only: the water's normal and ink mask underneath
 * stay as they are (the normal target is written with alpha 0, and neither alpha is touched).
 */
function seeThrough(mat: THREE.ShaderMaterial): THREE.ShaderMaterial {
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.SrcAlphaFactor;
  mat.blendDst = THREE.OneMinusSrcAlphaFactor;
  mat.blendSrcAlpha = THREE.ZeroFactor;
  mat.blendDstAlpha = THREE.OneFactor;
  return mat;
}

/** Water lit by the scene: bright on the side to the light, glowing when back-lit, never dark. */
const WATER_LIGHT = /* glsl */ `
vec3 waterLit(vec3 Nw, vec3 V, float thin){
  vec3 hue = uSunColor / max(max(uSunColor.r, max(uSunColor.g, uSunColor.b)), 0.05);
  vec3 key = mix(vec3(1.0), hue, 0.35);
  float lum = clamp(dot(uSunColor, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
  float ft = smoothstep(-0.4, 0.4, dot(Nw, uSunDir));
  vec3 sky = mix(uSkyMid, vec3(dot(uSkyMid, vec3(0.333))), 0.3);
  vec3 sh = sky * 0.5 + key * 0.55;
  vec3 day = mix(sh, key * 0.96 + sky * 0.06, ft);
  // Thin water lit from behind: the light comes through it.
  day += key * thin * 0.35 * pow(max(dot(V, uSunDir), 0.0), 3.0);
  day *= mix(1.0, lum, uNight);
  // Under the moon a dim cool grey, a little above the dark water.
  vec3 nite = uMoonCol * 0.22 + uSkyMid * 0.5 + vec3(0.03, 0.04, 0.06);
  return mix(day, nite, uNight);
}
`;

/**
 * Spray off the skiff: thin sheets peeling off both sides of the bow and a fine scatter of drops
 * thrown up and out of them once she has speed, and a low churn off the prop under throttle. The
 * spray is short-lived and falls back into the bow wave within half a second, so it always sits
 * on the hull and the wake. Every particle's flight is a function of its emission time and the
 * boat's state then (from the boat's history, or the capture course), so a frozen capture time
 * always shows the same spray. Painted translucent, lit by the scene, stretched along its flight,
 * never inked.
 *
 * The bow wave itself is a thin ragged sheet of white water standing against the forward
 * planking, tall at the stem when she runs and a narrow lapping collar at rest.
 */
export class Spray {
  readonly mesh: THREE.Mesh;
  readonly bowWave: THREE.Mesh;
  private aP: THREE.InstancedBufferAttribute;
  private aF: THREE.InstancedBufferAttribute;
  private aV: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private snap: BoatSnap = { x: 0, z: 0, yaw: 0, speed: 0, throttle: 0, odo: 0, y: 0 };
  private uBow = { value: new THREE.Vector4() };

  constructor(private boat: Boat) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.geo.setAttribute("uv", quad.getAttribute("uv"));
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aF = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aV = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3);
    for (const a of [this.aP, this.aF, this.aV]) a.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aP", this.aP);
    this.geo.setAttribute("aF", this.aF);
    this.geo.setAttribute("aV", this.aV);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...G },
      vertexShader: /* glsl */ `
        in vec4 aP;
        in vec4 aF;
        in vec3 aV;
        out vec2 vUv;
        out vec4 vF;
        out vec3 vWPos;
        void main(){
          vUv = uv;
          vF = aF;
          // Stretched along the flight as seen on screen: drops into short streaks, sheets into
          // long thin veils.
          vec3 vv = (viewMatrix * vec4(aV, 0.0)).xyz;
          vec2 dir = length(vv.xy) > 1e-4 ? normalize(vv.xy) : vec2(0.0, 1.0);
          // (x, y) -> (nrm, dir) must keep the quad's handedness or it is back-face culled.
          vec2 nrm = vec2(dir.y, -dir.x);
          float len = aP.w * (1.0 + aF.z), wid = aP.w;
          vec4 c = viewMatrix * vec4(aP.xyz, 1.0);
          c.xy += dir * position.y * len + nrm * position.x * wid;
          vWPos = (inverse(viewMatrix) * c).xyz;
          gl_Position = projectionMatrix * c;
        }`,
      fragmentShader: /* glsl */ `
        ${COMMON}
        ${WATER_LIGHT}
        layout(location = 0) out vec4 gColor;
        layout(location = 1) out vec4 gNormal;
        in vec2 vUv;
        in vec4 vF;
        in vec3 vWPos;
        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          float r = length(p);
          float a, life = clamp(vF.x, 0.0, 1.0);
          if (vF.w > 0.5) {
            // A sheet of spray: a flat, hard-edged shape tapering to a sharp tip, torn ragged,
            // with a clean hole or two.
            float wdt = mix(1.0, 0.18, clamp(p.y * 0.5 + 0.5, 0.0, 1.0));
            float rv = length(vec2(p.x / wdt, p.y)) + (vnoise(vec2(p.y * 2.5 + vF.y * 30.0, p.x * 1.5)) - 0.5) * 0.45;
            float hv = vnoise(p * 3.0 + vF.y * 17.0);
            // Dying sheets shrink and tear rather than going see-through.
            float m = min(0.8 * sqrt(life) - rv, (hv - 0.28 - 0.4 * (1.0 - life)) * 2.0);
            float fw = max(fwidth(m), 1e-3) * 0.75;
            a = smoothstep(-fw, fw, m) * 0.95;
          } else {
            float rd = 0.7 * sqrt(life);
            float fw = max(fwidth(r), 1e-3) * 0.75;
            ${TIER.softWake ? "a = (1.0 - smoothstep(rd * 0.3, rd + fw, r)) * 0.75;" : "a = 1.0 - smoothstep(rd - fw, rd + fw, r);"}
          }
          a *= mix(1.0, 0.6, uNight);
          if (a < 0.01) discard;
          vec3 V = normalize(vWPos - cameraPosition);
          vec3 Nw = normalize(vec3(p.x * 0.5, 0.7, p.y * 0.5));
          vec3 col = waterLit(Nw, V, vF.w > 0.5 ? 1.0 : 0.5);
          col = applyFog(col, vWPos);
          gColor = vec4(safe3(col), safe1(a));
          gNormal = vec4(0.0);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, seeThrough(mat));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;    this.bowWave = this.buildBowWave();
    boat.root.add(this.bowWave);
  }

  /** A ribbon round the forward hull just outside the planking, from below the water upward. */
  private buildBowWave(): THREE.Mesh {
    const STN = 22, z0 = 0.2, z1 = STEM_Z + 0.04;
    const pos: number[] = [], kk: number[] = [], idx: number[] = [];
    // Reaches well under the floating waterline, so a lifted bow never shows the sheet's foot.
    const lo = HULL.waterY - 0.45, hi = HULL.waterY + 0.24;
    for (const side of [-1, 1]) {
      const base = pos.length / 3;
      for (let i = 0; i <= STN; i++) {
        const u = i / STN;
        const z = z0 + (z1 - z0) * u;
        const hw = Math.max(waterlineHalf(z), 0.02);
        // The water climbs with the hull's flare, and leans out a little at the top.
        pos.push(side * (hw + 0.012), lo, z, side * (hw + 0.03 + 0.03 * u), hi, z);
        kk.push(u, 0, side, u, 1, side);
      }
      for (let i = 0; i < STN; i++) {
        const a = base + i * 2;
        if (side > 0) idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        else idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("aK", new THREE.Float32BufferAttribute(kk, 3));
    g.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...G, uBow: this.uBow },
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        uniform vec4 uBow;
        in vec3 aK;
        out vec3 vK;
        out vec3 vWPos;
        out float vH;
        void main(){
          vK = aK;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWPos = wp.xyz;
          // Height above the real water surface, not the hull's floating waterline: when the
          // bow lifts the sheet still stands on the water.
          vH = wp.y - uBow.w + ${HULL.waterY.toFixed(3)};
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${COMMON}
        ${WATER_LIGHT}
        uniform vec4 uBow;
        layout(location = 0) out vec4 gColor;
        layout(location = 1) out vec4 gNormal;
        in vec3 vK;
        in vec3 vWPos;
        in float vH;
        void main(){
          float u = vK.x, v = vK.y;
          float spd = uBow.x;
          // Water slides aft along the hull: the pattern is tied to the distance run. u is 1 at the
          // stem, so the run is subtracted for the pattern to travel toward the transom.
          float sx = (1.0 - u) * 3.2 - uBow.y - uTime * 0.35;
          float n = vnoise(vec2(sx * 2.2, vK.z * 7.0)) * 0.65 + vnoise(vec2(sx * 6.0, v * 3.0 + vK.z)) * 0.35;
          // Crest height above the floating waterline: a low lapping collar at rest, a tall
          // curling sheet at the stem when she runs, sinking aft along the hull.
          float bowK = smoothstep(0.35, 0.85, u) * (1.0 - 0.6 * smoothstep(0.9, 1.0, u));
          float crest = ${(HULL.waterY + 0.005).toFixed(3)} + (0.025 + 0.075 * spd * bowK) * (0.6 + 0.8 * n);
          // A painted shape, not a haze: a hard edge one pixel wide, its top torn into sharp
          // teeth that lean aft, holes cut clean like the arm foam's lace.
          float teeth = abs(fract(sx * 3.1 + 0.4 * vnoise(vec2(sx * 1.3, vK.z))) * 2.0 - 1.0);
          float edge = crest + (teeth * teeth - 0.35) * (0.012 + 0.03 * spd * bowK) + (vnoise(vec2(sx * 9.0, vK.z * 5.0)) - 0.5) * 0.012;
          float aw = max(fwidth(vH), 1e-4) * 0.75;
          // The holes' torn edge (below) is dropped where its noise is under ~3 px a cycle.
          float fineK = 1.0 - smoothstep(0.2, 0.45, max(fwidth(sx) * 14.0, fwidth(vH) * 70.0));
          float top = 1.0 - smoothstep(edge - aw, edge + aw, vH);
          if (top < 0.01) discard;
          // Holes most toward its top; aft it breaks up into scraps rather than fading. A finer noise
          // tears their edges like the arm foam's lace.
          float rag = (vnoise(vec2(sx * 14.0, vH * 70.0) + vK.z * 5.0) - 0.5) * 0.2 * fineK;
          float hn = vnoise(vec2(sx * 4.0, vH * 22.0) + vK.z * 3.0) + rag + 0.35 * (1.0 - smoothstep(crest - 0.06, crest, vH))
                   - 0.7 * (1.0 - smoothstep(0.0, 0.3, u));
          float hw = max(fwidth(hn), 1e-3) * 0.75;
          float a = top * smoothstep(0.42 - hw, 0.42 + hw, hn) * mix(0.97, 0.75, uNight);
          if (a < 0.02) discard;
          vec3 V = normalize(vWPos - cameraPosition);
          vec3 col = waterLit(normalize(vec3(0.0, 1.0, 0.0) + V * -0.3), V, 0.6);
          // Two tone steps: a lit lip along the crest, the body below a flat shade darker.
          col *= mix(0.82, 1.0, step(edge - 0.025 - 0.01 * spd, vH));
          col = applyFog(col, vWPos);
          gColor = vec4(safe3(col), safe1(a));
          gNormal = vec4(0.0);
        }`,
    });
    const m = new THREE.Mesh(g, seeThrough(mat));
    m.frustumCulled = false;
    m.renderOrder = 1;
    return m;
  }

  update(t: number): void {
    const b = this.boat;
    this.uBow.value.set(sm(0.5, 6.5, Math.abs(b.u)), b.odo, b.throttle, seaHeight(b.x - Math.sin(b.yaw), b.z - Math.cos(b.yaw), t));
    const P = this.aP.array as Float32Array, F = this.aF.array as Float32Array, VV = this.aV.array as Float32Array;
    let n = 0;
    const s = this.snap;
    for (let i = 0; i < N; i++) {
      const kind = i < N_DROP ? 0 : i < N_DROP + N_SHEET ? 1 : 2;
      const life = kind === 0 ? 0.3 + 0.25 * hash(i, 1) : kind === 1 ? 0.22 + 0.16 * hash(i, 1) : 0.25 + 0.2 * hash(i, 1);
      const period = life * 1.2;
      const ph = hash(i, 2) * period;
      const te = Math.floor((t - ph) / period) * period + ph;
      const age = t - te;
      if (age > life) continue;
      b.stateAt(te - 0.25, s);
      const spd0 = s.speed;
      b.stateAt(te, s);
      const spd = Math.max(s.speed, 0);
      // Driving hard (accelerating under throttle, bow up) throws far more water than cruising,
      // and so does the throttle held open past full (boost), even at a steady speed.
      const hard = Math.max(s.throttle, 0) * sm(0.15, 0.9, (spd - spd0) / 0.25);
      const boost = clamp01((s.throttle - 1) / (BOOST - 1)) * sm(4, 9, spd);
      const strength = kind === 2 ? Math.max(s.throttle, 0) * sm(0.5, 3, spd) * (0.5 + 0.5 * hard) : Math.min(1, sm(2.0, 7.0, spd) * 0.5 + 0.8 * hard * sm(1.0, 3.0, spd) + 0.4 * boost);
      if (hash(i, 3) > strength) continue;
      const side = i & 1 ? 1 : -1;
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
      let pf: number, ps: number, vo: number, vu: number, vf: number, size: number, stretch: number;
      const k = sm(2.0, 7.5, spd);
      if (kind === 2) {
        // Low churn right at the leg: flattened, it barely leaves the water.
        // Thrown up off the prop wash right behind the transom: a low ragged fan under hard
        // throttle, a few flecks when cruising.
        pf = -1.95 - 0.35 * hash(i, 4);
        ps = (hash(i, 5) - 0.5) * 0.4;
        vo = (hash(i, 6) - 0.5) * (1.2 + 1.2 * hard);
        vu = (0.55 + 0.9 * hash(i, 7)) * (1 + 0.8 * hard);
        vf = spd * 0.55;
        size = (0.07 + 0.07 * hash(i, 8)) * (1 + 0.8 * hard);
        stretch = 0.9;
      } else {
        // Off the bow wave where it climbs the forward planking.
        pf = (kind === 0 ? 0.9 : 0.6) + (kind === 0 ? 0.85 : 0.95) * hash(i, 4);
        ps = side * (waterlineHalf(-pf) + 0.04);
        // Fans off both forward chines: wider, higher and bigger when she is driven hard.
        const g = 1 + 0.6 * hard + 0.3 * boost;
        if (kind === 0) {
          vo = (1.2 + 1.4 * hash(i, 5)) * (0.45 + 0.45 * k) * g;
          vu = (1.6 + 1.8 * hash(i, 6)) * (0.45 + 0.45 * k) * g;
          size = (0.026 + 0.026 * hash(i, 7)) * g;
          stretch = 2.5;
        } else {
          vo = (1.4 + 0.8 * hash(i, 5)) * (0.6 + 0.5 * k) * g;
          vu = (0.9 + 0.9 * hash(i, 6)) * (0.6 + 0.5 * k) * g;
          size = (0.1 + 0.09 * hash(i, 7)) * (1 + 0.5 * hard);
          stretch = 1.7;
        }
        // The water leaves the hull with most of the boat's speed: it peels away sideways and
        // falls back alongside her.
        vf = spd * (0.8 + 0.12 * hash(i, 8));
      }
      const x0 = s.x + fx * pf + rx * ps, z0 = s.z + fz * pf + rz * ps;
      // Off the top of the bow wave where it stands against the planking; the prop throws from
      // the boil just above the surface.
      const y0 = s.y + (kind === 2 ? 0.04 : 0.06 + 0.06 * k);
      const D = 2.6;
      const drag = Math.exp(-D * age);
      const dk = (1 - drag) / D;
      const vx = fx * vf + rx * side * vo, vz = fz * vf + rz * side * vo;
      const y = y0 + vu * dk - 4.9 * age * age;
      if (y < y0 - 0.03 && age > 0.04) continue;
      const a = age / life;
      const cover = sm(0, 0.12, a) * (1 - sm(0.4, 1, a));
      const o = n * 4, o3 = n * 3;
      P[o] = x0 + vx * dk;
      P[o + 1] = Math.max(y, y0);
      P[o + 2] = z0 + vz * dk;
      P[o + 3] = size * (1 + (kind === 1 ? 0.35 : 0.8) * a);
      F[o] = cover;
      F[o + 1] = hash(i, 9);
      F[o + 2] = stretch;
      F[o + 3] = kind === 0 ? 0 : 1;
      // Velocity relative to the hull (what the eye follows from the chase camera).
      VV[o3] = vx * drag - fx * spd + 0.001;
      VV[o3 + 1] = vu * drag - 9.8 * age;
      VV[o3 + 2] = vz * drag - fz * spd;
      n++;
    }
    this.geo.instanceCount = n;
    for (const a of [this.aP, this.aF, this.aV]) {
      a.needsUpdate = true;
      a.addUpdateRange(0, n * a.itemSize);
    }
  }
}
