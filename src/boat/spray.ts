import * as THREE from "three";
import { COMMON, G } from "../render/materials";
import type { Boat, BoatSnap } from "./boat";

/** Particle slots: bow droplets, low bow sheets, and the prop's churned spatter. */
const N_DROP = 110;
const N_SHEET = 60;
const N_PROP = 36;
const N = N_DROP + N_SHEET + N_PROP;

const hash = (i: number, k: number) => {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const sm = (a: number, b: number, x: number) => {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Spray off the skiff: sheets peeling back from both sides of the bow and droplets thrown up and
 * out once she has speed, and a low spatter off the prop under throttle. Every particle's flight is
 * a function of its emission time and the boat's state then (from the boat's history, or the
 * capture course), so a frozen capture time always shows the same spray. Painted as small opaque
 * dithered blobs in foam white tinted by the light; never inked.
 */
export class Spray {
  readonly mesh: THREE.Mesh;
  private aP: THREE.InstancedBufferAttribute;
  private aF: THREE.InstancedBufferAttribute;
  private geo: THREE.InstancedBufferGeometry;
  private snap: BoatSnap = { x: 0, z: 0, yaw: 0, speed: 0, throttle: 0, odo: 0, y: 0 };

  constructor(private boat: Boat) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.geo.setAttribute("uv", quad.getAttribute("uv"));
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aF = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.aP.setUsage(THREE.DynamicDrawUsage);
    this.aF.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aP", this.aP);
    this.geo.setAttribute("aF", this.aF);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...G },
      vertexShader: /* glsl */ `
        in vec4 aP;
        in vec4 aF;
        out vec2 vUv;
        out vec4 vF;
        out vec3 vWPos;
        void main(){
          vUv = uv;
          vF = aF;
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          // Sheets are stretched along their flight, droplets round.
          vec2 s = vec2(aP.w) * vec2(1.0 + aF.w * 1.4, 1.0 - aF.w * 0.35);
          vec3 wp = aP.xyz + right * position.x * s.x + up * position.y * s.y;
          vWPos = wp;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${COMMON}
        layout(location = 0) out vec4 gColor;
        layout(location = 1) out vec4 gNormal;
        in vec2 vUv;
        in vec4 vF;
        in vec3 vWPos;
        void main(){
          vec2 p = vUv * 2.0 - 1.0;
          // A soft clumpy blob: radius wobbles with a per-particle seed.
          float ang = atan(p.y, p.x);
          float r = length(p) / (0.82 + 0.14 * sin(ang * 3.0 + vF.y * 40.0) + 0.08 * sin(ang * 5.0 - vF.y * 17.0));
          // Opaque painted blobs that shrink away as they thin (no grey, no speckle).
          if (r > 0.95 * sqrt(clamp(vF.x, 0.0, 1.0))) discard;
          vec3 N = normalize(vec3(p * 0.8, 0.6));
          vec3 Nw = normalize((inverse(viewMatrix) * vec4(N, 0.0)).xyz);
          vec3 hue = uSunColor / max(max(uSunColor.r, max(uSunColor.g, uSunColor.b)), 0.05);
          vec3 key = mix(vec3(1.0), hue, 0.3);
          float ft = smoothstep(-0.3, 0.3, dot(Nw, uSunDir));
          vec3 sh = mix(mix(uShadowTint, uSkyMid, 0.4), key, 0.55) * 0.86;
          float lum = dot(uSunColor, vec3(0.2126, 0.7152, 0.0722));
          vec3 day = mix(sh, key * 0.97, ft) * mix(1.0, clamp(lum, 0.0, 1.0), uNight);
          // At night: a cool pale grey a little above the dark water, catching some moonlight.
          vec3 nite = vec3(0.06, 0.08, 0.12) + uMoonCol * 0.08;
          vec3 col = mix(day, nite, uNight);
          // Sunlight caught in the drops: a small warm sparkle on the lit side.
          col += key * 0.25 * pow(max(dot(reflect(normalize(vWPos - cameraPosition), Nw), uSunDir), 0.0), 12.0) * (1.0 - uNight);
          col = applyFog(col, vWPos);
          gColor = vec4(col, 1.0);
          gNormal = vec4(N.xy * 0.5 + 0.5, 0.0, -1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  update(t: number): void {
    const P = this.aP.array as Float32Array, F = this.aF.array as Float32Array;
    let n = 0;
    const s = this.snap;
    const put = (x: number, y: number, z: number, size: number, cover: number, seed: number, stretch: number) => {
      const o = n * 4;
      P[o] = x;
      P[o + 1] = y;
      P[o + 2] = z;
      P[o + 3] = size;
      F[o] = cover;
      F[o + 1] = seed;
      F[o + 2] = 0;
      F[o + 3] = stretch;
      n++;
    };
    for (let i = 0; i < N; i++) {
      const kind = i < N_DROP ? 0 : i < N_DROP + N_SHEET ? 1 : 2;
      const life = kind === 0 ? 0.45 + 0.45 * hash(i, 1) : kind === 1 ? 0.25 + 0.2 * hash(i, 1) : 0.3 + 0.25 * hash(i, 1);
      const period = life * 1.15;
      const ph = hash(i, 2) * period;
      const te = Math.floor((t - ph) / period) * period + ph;
      const age = t - te;
      if (age > life) continue;
      this.boat.stateAt(te, s);
      const spd = Math.max(s.speed, 0);
      const strength = kind === 2 ? Math.max(s.throttle, 0) * sm(0.5, 3, spd) * 0.6 : sm(2.6, 7.5, spd) * 0.7;
      if (hash(i, 3) > strength) continue;
      const side = i & 1 ? 1 : -1;
      const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
      const rx = Math.cos(s.yaw), rz = -Math.sin(s.yaw);
      let pf: number, ps: number, vo: number, vu: number, vf: number, size: number;
      if (kind === 2) {
        pf = -2.05 - 0.2 * hash(i, 4);
        ps = (hash(i, 5) - 0.5) * 0.35;
        vo = (hash(i, 6) - 0.5) * 1.4;
        vu = 0.8 + 1.2 * hash(i, 7);
        vf = spd * 0.55 - 0.6;
        size = 0.07 + 0.06 * hash(i, 8);
      } else {
        // From the forward part of the hull where the bow wave climbs it.
        pf = 0.5 + 0.85 * hash(i, 4);
        const half = 0.62 * Math.sqrt(Math.max(1 - (pf / 1.95) ** 2, 0)) * (1 - 0.35 * pf / 1.95);
        ps = side * (half + 0.06);
        const k = sm(2.6, 8, spd);
        if (kind === 0) {
          vo = (1.3 + 1.3 * hash(i, 5)) * (0.6 + 0.6 * k);
          vu = (0.8 + 1.4 * hash(i, 6)) * (0.5 + 0.7 * k);
          size = 0.025 + 0.028 * hash(i, 7);
        } else {
          vo = (1.4 + 0.9 * hash(i, 5)) * (0.6 + 0.5 * k);
          vu = (0.25 + 0.5 * hash(i, 6)) * (0.6 + 0.5 * k);
          size = 0.08 + 0.07 * hash(i, 7);
        }
        // The water leaves the hull with most of the boat's speed: it peels away sideways.
        vf = spd * (0.62 + 0.2 * hash(i, 8));
      }
      const x0 = s.x + fx * pf + rx * ps, z0 = s.z + fz * pf + rz * ps;
      const y0 = s.y + 0.02;
      const vx = fx * vf + rx * side * vo, vz = fz * vf + rz * side * vo;
      const drag = Math.exp(-1.2 * age);
      const dk = (1 - drag) / 1.2;
      const y = y0 + vu * age - 4.9 * age * age;
      if (y < y0 - 0.05 && age > 0.05) continue;
      const a = age / life;
      const cover = sm(0, 0.08, a) * (1 - sm(0.45, 1, a)) * (kind === 1 ? 0.95 : 1);
      put(x0 + vx * dk, Math.max(y, y0), z0 + vz * dk, size * (1 + 1.2 * a), cover, hash(i, 9), kind === 1 ? 1 - a : 0);
    }
    this.geo.instanceCount = n;
    this.aP.needsUpdate = true;
    this.aF.needsUpdate = true;
    this.aP.addUpdateRange(0, n * 4);
    this.aF.addUpdateRange(0, n * 4);
  }
}
