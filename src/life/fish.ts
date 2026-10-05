import * as THREE from "three";
import { G, uber } from "../render/materials";
import { ID, M, merge, prep } from "../world/geo";
import { seaHeight } from "../water/query";
import { SEA_Y } from "../world/bay/road";
import { terrainH } from "../world/bay/terrain";
import { inPier } from "../world/bay/pier";

/**
 * Little fish leaping now and then out of the sea where the camera can see them: an arc of about a
 * second, a ring of ripples and a crown of droplets where it leaves the water and again where it
 * goes back in. The surface height comes from the shared water query, so the rings ride the swell.
 * Leaps are planned per time slot from a hash (two channels, sometimes overlapping): at a fixed
 * time the same leap is in the air.
 */

const SLOT = 2.4;
const CH = 2;

const hash = (n: number) => {
  const s = Math.sin(n * 91.7 + 47.3) * 43758.5453;
  return s - Math.floor(s);
};

interface Leap {
  k: number;
  on: boolean;
  x: number;
  z: number;
  dx: number;
  dz: number;
  t0: number;
  T: number;
  L: number;
  H: number;
  s: number;
}

function fishGeo(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(1, 12, 8);
  body.scale(0.045, 0.07, 0.17);
  const p = body.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    c.set("#e6ebee").lerp(new THREE.Color("#4a6a86"), Math.max(0, Math.min(1, p.getY(i) / 0.05 + 0.4)));
    c.toArray(col, i * 3);
  }
  body.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const tail = new THREE.BufferGeometry();
  tail.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, -0.15, 0, 0.065, -0.27, 0, -0.065, -0.27], 3));
  tail.setIndex([0, 1, 2]);
  tail.computeVertexNormals();
  const fin = new THREE.BufferGeometry();
  fin.setAttribute("position", new THREE.Float32BufferAttribute([0, 0.06, 0.04, 0, 0.11, -0.04, 0, 0.055, -0.07], 3));
  fin.setIndex([0, 1, 2]);
  fin.computeVertexNormals();
  return merge([prep(body, null, M.plain), prep(tail, "#5a7890", M.plain), prep(fin, "#4a6a86", M.plain)]);
}

const LIGHT = /* glsl */ `
uniform vec3 uSunColor; uniform vec3 uSkyMid; uniform vec3 uWorldTint; uniform float uNight; uniform float uTime;
vec3 lightK(){ return (uSunColor * 0.7 + uSkyMid * 0.3) * uWorldTint * (1.0 - 0.6 * uNight); }
`;

const ADD = {
  transparent: true,
  depthWrite: false,
  blending: THREE.CustomBlending,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor,
  blendDstAlpha: THREE.OneFactor,
} as const;

export class Fish {
  readonly group = new THREE.Group();
  private readonly fish: THREE.InstancedMesh;
  private readonly rings: THREE.InstancedMesh;
  private readonly crowns: THREE.InstancedMesh;
  private readonly ringInfo: THREE.InstancedBufferAttribute;
  private readonly crownInfo: THREE.InstancedBufferAttribute;
  private readonly leaps: Leap[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly hide = new THREE.Matrix4().makeScale(0, 0, 0);
  /** Leaps begun so far (tests). */
  count = 0;

  constructor() {
    this.group.name = "fish";
    // Same material as the gulls (fins are single-sided triangles).
    this.fish = new THREE.InstancedMesh(fishGeo(), uber(ID.butterfly, 0.7, THREE.DoubleSide), CH);
    const rg = new THREE.PlaneGeometry(2, 2);
    rg.rotateX(-Math.PI / 2);
    this.ringInfo = new THREE.InstancedBufferAttribute(new Float32Array(CH * 2 * 2).fill(-1e3), 2);
    this.ringInfo.setUsage(THREE.DynamicDrawUsage);
    rg.setAttribute("aInfo", this.ringInfo);
    this.rings = new THREE.InstancedMesh(rg, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uSunColor: G.uSunColor, uSkyMid: G.uSkyMid, uWorldTint: G.uWorldTint, uNight: G.uNight, uTime: G.uTime },
      vertexShader: /* glsl */ `
        in vec2 aInfo; out vec2 vUv; out vec2 vInfo;
        void main(){ vUv = uv; vInfo = aInfo; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        ${LIGHT}
        in vec2 vUv; in vec2 vInfo;
        layout(location = 0) out vec4 gColor; layout(location = 1) out vec4 gNormal;
        void main(){
          // Two rings spreading and thinning, broken into soft arcs (vInfo: birth, strength).
          float age = uTime - vInfo.x;
          vec2 q = (vUv - 0.5) * 2.0;
          float r = length(q), ang = atan(q.y, q.x);
          float a = 0.0;
          for (int k = 0; k < 2; k++) {
            float lag = float(k) * 0.3;
            float t = max(age - lag, 0.0);
            float R = 0.12 + 0.8 * (1.0 - exp(-t * 1.5));
            float w = 0.03 + 0.035 * t;
            float br = 0.7 + 0.3 * sin(ang * 6.0 + vInfo.x * 7.0 + float(k) * 2.0);
            a += (1.0 - smoothstep(0.0, w, abs(r - R))) * (1.0 - smoothstep(0.5, 1.8, t)) * step(lag, age) * br * (k == 0 ? 1.0 : 0.55);
          }
          a *= vInfo.y * (1.0 - smoothstep(0.85, 1.0, r)) * step(0.0, age);
          if (a < 0.004) discard;
          gColor = vec4(lightK() * a * 0.32, 0.0);
          gNormal = vec4(0.0);
        }`,
      ...ADD,
    }), CH * 2);
    const cg = new THREE.PlaneGeometry(1, 1);
    cg.translate(0, 0.5, 0);
    this.crownInfo = new THREE.InstancedBufferAttribute(new Float32Array(CH * 2 * 2).fill(-1e3), 2);
    this.crownInfo.setUsage(THREE.DynamicDrawUsage);
    cg.setAttribute("aInfo", this.crownInfo);
    this.crowns = new THREE.InstancedMesh(cg, new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uSunColor: G.uSunColor, uSkyMid: G.uSkyMid, uWorldTint: G.uWorldTint, uNight: G.uNight, uTime: G.uTime },
      vertexShader: /* glsl */ `
        in vec2 aInfo; out vec2 vUv; out vec2 vInfo;
        void main(){
          vUv = uv; vInfo = aInfo;
          // Upright billboard turned to the camera about the vertical.
          vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float sc = length(instanceMatrix[0].xyz);
          vec3 right = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]) + 1e-5);
          vec3 wp = c + right * position.x * sc * 0.7 + vec3(0.0, position.y * sc * 0.55, 0.0);
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${LIGHT}
        in vec2 vUv; in vec2 vInfo;
        layout(location = 0) out vec4 gColor; layout(location = 1) out vec4 gNormal;
        void main(){
          // Droplets thrown up and falling back (uv: x across -0.5..0.5, y up 0..1).
          float age = uTime - vInfo.x;
          if (age < 0.0 || age > 0.6) discard;
          vec2 p = vec2((vUv.x - 0.5) * 1.4, vUv.y * 1.1);
          float a = 0.0;
          for (int k = 0; k < 9; k++) {
            float fk = float(k);
            float h = fract(sin(fk * 12.9898 + vInfo.x * 3.7) * 43758.5453);
            float vx = (h - 0.5) * 1.3, vy = 1.7 + 1.3 * fract(h * 7.1);
            vec2 d = vec2(vx * age, vy * age - 4.9 * age * age);
            float rr = 0.022 + 0.012 * fract(h * 3.3);
            a += 1.0 - smoothstep(rr * 0.5, rr, length(p - d));
          }
          a = min(a, 1.0) * vInfo.y * (1.0 - smoothstep(0.35, 0.6, age));
          if (a < 0.01) discard;
          gColor = vec4(lightK() * a * 0.9, 0.0);
          gNormal = vec4(0.0);
        }`,
      ...ADD,
    }), CH * 2);
    for (const im of [this.fish, this.rings, this.crowns]) {
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      for (let i = 0; i < im.count; i++) im.setMatrixAt(i, this.hide);
      this.group.add(im);
    }
    for (let c = 0; c < CH; c++) this.leaps.push({ k: -1, on: false, x: 0, z: 0, dx: 1, dz: 0, t0: 0, T: 1, L: 1, H: 0.5, s: 0.3 });
  }

  /** A leap for slot k of channel c, in view ahead of the camera over water at least 1.6 m deep. */
  private plan(l: Leap, c: number, k: number, cam: THREE.Vector3, fx: number, fz: number): void {
    l.k = k;
    l.on = false;
    const seed = k * 7 + c * 1013;
    if (hash(seed) > 0.45) return;
    for (let tr = 0; tr < 4; tr++) {
      const h1 = hash(seed + tr * 31 + 1), h2 = hash(seed + tr * 31 + 2);
      const ang = Math.atan2(fz, fx) + (h1 - 0.5) * 1.2;
      const d = 12 + h2 * 46;
      const x = cam.x + Math.cos(ang) * d, z = cam.z + Math.sin(ang) * d;
      if (terrainH(x, z) > SEA_Y - 1.6 || inPier(x, z, 5)) continue;
      const a = hash(seed + 5) * Math.PI * 2;
      l.on = true;
      l.x = x;
      l.z = z;
      l.dx = Math.cos(a);
      l.dz = Math.sin(a);
      l.t0 = k * SLOT - c * 1.15 + hash(seed + 6) * 0.9;
      l.T = 0.8 + hash(seed + 7) * 0.45;
      l.L = 1.1 + hash(seed + 8) * 0.9;
      l.H = 0.35 + hash(seed + 9) * 0.4;
      l.s = 0.8 + hash(seed + 10) * 0.5;
      this.count++;
      // Ripples and droplets where it leaves the water and where it falls back in.
      this.ringInfo.setXY(c * 2, l.t0, l.s);
      this.ringInfo.setXY(c * 2 + 1, l.t0 + l.T, l.s * 0.9);
      this.crownInfo.setXY(c * 2, l.t0, l.s * 0.8);
      this.crownInfo.setXY(c * 2 + 1, l.t0 + l.T, l.s);
      this.ringInfo.needsUpdate = true;
      this.crownInfo.needsUpdate = true;
      return;
    }
  }

  update(t: number, cam: THREE.Vector3, fx: number, fz: number): void {
    for (let c = 0; c < CH; c++) {
      const l = this.leaps[c];
      const k = Math.floor((t + c * 1.15) / SLOT);
      if (k !== l.k) this.plan(l, c, k, cam, fx, fz);
      const tau = t - l.t0;
      if (!l.on || tau > l.T + 2) {
        this.fish.setMatrixAt(c, this.hide);
        this.rings.setMatrixAt(c * 2, this.hide);
        this.rings.setMatrixAt(c * 2 + 1, this.hide);
        this.crowns.setMatrixAt(c * 2, this.hide);
        this.crowns.setMatrixAt(c * 2 + 1, this.hide);
        continue;
      }
      // The splashes ride the swell where they are: where it left the water, where it falls back.
      for (let e = 0; e < 2; e++) {
        const x = l.x + l.dx * l.L * e, z = l.z + l.dz * l.L * e, i = c * 2 + e;
        const y = seaHeight(x, z, t);
        this.m.makeScale(l.s, 1, l.s).setPosition(x, y + 0.03, z);
        this.rings.setMatrixAt(i, this.m);
        this.m.makeScale(l.s, l.s, l.s).setPosition(x, y, z);
        this.crowns.setMatrixAt(i, this.m);
      }
      if (tau < 0 || tau > l.T) {
        this.fish.setMatrixAt(c, this.hide);
        continue;
      }
      const s = tau / l.T;
      const y0 = seaHeight(l.x + l.dx * l.L * s, l.z + l.dz * l.L * s, t);
      this.p.set(l.x + l.dx * l.L * s, y0 + 4 * l.H * s * (1 - s) - 0.1, l.z + l.dz * l.L * s);
      const slope = (4 * l.H * (1 - 2 * s)) / l.L;
      this.e.set(-Math.atan(slope), Math.atan2(l.dx, l.dz), Math.sin(tau * 9) * 0.25, "YXZ");
      this.q.setFromEuler(this.e);
      // A small fish: 22-35 cm.
      this.m.compose(this.p, this.q, this.s.setScalar(l.s * 0.8));
      this.fish.setMatrixAt(c, this.m);
    }
    this.fish.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    this.crowns.instanceMatrix.needsUpdate = true;
  }
}
