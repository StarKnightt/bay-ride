import * as THREE from "three";
import { G } from "../render/materials";

/** Unlit marks follow the time-of-day light, normalised so daytime looks as authored. */
const DAY = new THREE.Color("#8a90b0").lerp(new THREE.Color("#fff1dc"), 0.75);
const LIGHT_GLSL = `uniform vec3 uSunColor; uniform vec3 uShadowTint;
  vec3 todLight(){ return clamp(mix(uShadowTint, uSunColor, 0.75) / vec3(${DAY.r.toFixed(4)}, ${DAY.g.toFixed(4)}, ${DAY.b.toFixed(4)}), 0.0, 1.2); }`;

/**
 * Her trail: sandal prints pressed into the sand (darker and glossier in wet sand, washed away by
 * the swash, fading over a minute) and ripple rings on the water round her feet when she wades.
 * Two instanced draws; prints darken the scene by multiplying, rings add light, so neither touches
 * the normal / outline buffer.
 */

const N_PRINTS = 64;
const N_RINGS = 24;
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0), _one = new THREE.Vector3(1, 1, 1);

/** Leg i's centre line at world height y (the rider binds it): where a wading leg meets the water. */
export type LegProbe = (i: number, y: number, out: THREE.Vector3) => boolean;
let legProbe: LegProbe | null = null;
export function bindLegs(fn: LegProbe): void {
  legProbe = fn;
}
const _leg = new THREE.Vector3(), _zero = new THREE.Matrix4().makeScale(0, 0, 0);
/** Foam collar quad (m across) round each wading leg. */
const COLLAR = 0.3;

export interface WaterProbe {
  /** Water surface height and depth at (x, z) now (depth 0 = dry). */
  (x: number, z: number, t?: number): { y: number; depth: number; wet: number };
}

export class Trail {
  readonly group = new THREE.Group();
  private prints: THREE.InstancedMesh;
  private rings: THREE.InstancedMesh;
  private pInfo: THREE.InstancedBufferAttribute;
  private rInfo: THREE.InstancedBufferAttribute;
  private p: { x: number; y: number; z: number; yaw: number; side: number; t0: number; wet: number; wipe: number }[] = [];
  private r: { x: number; z: number; t0: number; s: number }[] = [];
  private pNext = 0;
  private rNext = 0;
  private check = 0;
  private wadeT = [0, 0];
  private collarS = [0, 0];
  readonly uNow = { value: 0 };

  constructor(private water: WaterProbe) {
    const pg = new THREE.PlaneGeometry(0.12, 0.27).rotateX(-Math.PI / 2);
    this.pInfo = new THREE.InstancedBufferAttribute(new Float32Array(N_PRINTS * 4), 4);
    pg.setAttribute("aInfo", this.pInfo);
    const pm = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uNow: this.uNow, uSunColor: G.uSunColor, uShadowTint: G.uShadowTint },
      vertexShader: /* glsl */ `
        in vec4 aInfo; out vec2 vUv; out vec4 vInfo;
        void main(){ vUv = uv; vInfo = aInfo; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uNow; in vec2 vUv; in vec4 vInfo;
        layout(location = 0) out vec4 gColor; layout(location = 1) out vec4 gNormal;
        void main(){
          // vInfo: side, birth time, wet 0..1, wipe start (or 0).
          vec2 q = (vUv - 0.5) * vec2(0.12, 0.27);
          q.x *= vInfo.x;
          // Sandal outline: heel, waist toward the arch, wide ball, rounded toes.
          float y = q.y / 0.125;
          float w = mix(0.034, 0.05, smoothstep(-0.9, 0.35, y)) - 0.008 * exp(-pow((y + 0.05) / 0.3, 2.0)) * step(0.0, -q.x);
          float d = max(abs(q.x + 0.004 * y) - w * sqrt(max(0.0, 1.0 - pow(abs(y), 6.0))), abs(y) - 1.0);
          float fw = fwidth(d) + 1e-4;
          float inside = 1.0 - smoothstep(-fw, fw, d);
          float rim = (1.0 - smoothstep(0.0, 0.012, abs(d - 0.006))) * (1.0 - inside);
          // Deeper under the heel and the ball.
          float press = 0.6 + 0.4 * max(exp(-pow((y + 0.62) / 0.25, 2.0)), exp(-pow((y - 0.45) / 0.3, 2.0)));
          float age = uNow - vInfo.y;
          float fade = (1.0 - smoothstep(25.0, 70.0, age)) * smoothstep(0.0, 0.08, age);
          if (vInfo.w > 0.0) fade *= 1.0 - smoothstep(0.0, 1.6, uNow - vInfo.w);
          float wet = vInfo.z;
          float dark = inside * press * mix(0.16, 0.3, wet) - rim * mix(0.08, 0.03, wet);
          if (fade * abs(dark) < 0.003) discard;
          vec3 m = vec3(1.0 - dark * fade);
          // Water standing in a fresh wet print: a faint cool sheen.
          m *= mix(vec3(1.0), vec3(0.94, 0.98, 1.06), inside * wet * fade * (1.0 - smoothstep(4.0, 15.0, age)));
          gColor = vec4(m, 1.0);
          gNormal = vec4(1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    this.prints = new THREE.InstancedMesh(pg, pm, N_PRINTS);
    this.prints.count = 0;
    this.prints.frustumCulled = false;
    this.prints.renderOrder = 1;

    const rg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    // Ripple rings, then one foam collar per leg (aInfo.z = 1) in the same draw.
    this.rInfo = new THREE.InstancedBufferAttribute(new Float32Array((N_RINGS + 2) * 4), 4);
    rg.setAttribute("aInfo", this.rInfo);
    const rm = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uNow: this.uNow, uSunColor: G.uSunColor, uShadowTint: G.uShadowTint, uWorldTint: G.uWorldTint, uNight: G.uNight },
      vertexShader: /* glsl */ `
        in vec4 aInfo; out vec2 vUv; out vec4 vInfo;
        void main(){ vUv = uv; vInfo = aInfo; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        ${LIGHT_GLSL}
        uniform float uNow; uniform vec3 uWorldTint; uniform float uNight; in vec2 vUv; in vec4 vInfo;
        layout(location = 0) out vec4 gColor; layout(location = 1) out vec4 gNormal;
        void main(){
          vec2 q = (vUv - 0.5) * 2.0;
          float r = length(q);
          float ang = atan(q.y, q.x);
          vec3 light = todLight() * mix(vec3(0.95, 0.97, 1.0), vec3(0.35, 0.42, 0.55), uNight);
          if (vInfo.z > 0.5) {
            // Foam collar where a leg meets the water (vInfo: seed, strength): a soft lapping band
            // hugging the leg, broken into drifting arcs, in two painted steps; dimmer at night.
            float sd = vInfo.x;
            float rr = r + 0.035 * sin(uNow * 2.3 + sd) * (0.6 + 0.4 * sin(ang * 2.0 + sd));
            float band = smoothstep(0.27, 0.36, rr) * (1.0 - smoothstep(0.4, 0.78, rr));
            float br = 0.55 + 0.45 * sin(ang * 3.0 + uNow * 1.1 + sd) * sin(ang * 5.0 - uNow * 0.7 + sd * 2.0);
            float c = band * br;
            c = smoothstep(0.16, 0.3, c) * 0.7 + smoothstep(0.45, 0.6, c) * 0.3;
            c *= vInfo.y;
            if (c < 0.004) discard;
            gColor = vec4(light * uWorldTint * c * 0.34 * mix(1.0, 0.6, uNight), 0.0);
            gNormal = vec4(0.0);
            return;
          }
          // vInfo: birth, strength. Two rings spreading and thinning, broken into soft arcs.
          float age = uNow - vInfo.x;
          float a = 0.0;
          for (int k = 0; k < 2; k++) {
            float lag = float(k) * 0.35;
            float t = max(age - lag, 0.0);
            float R = 0.2 + 0.65 * (1.0 - exp(-t * 1.6));
            float w = 0.025 + 0.03 * t;
            float br = 0.75 + 0.25 * sin(ang * 5.0 + vInfo.x * 7.0 + float(k) * 2.0);
            a += (1.0 - smoothstep(0.0, w, abs(r - R))) * (1.0 - smoothstep(0.4, 1.9, t)) * step(lag, age) * br * (k == 0 ? 1.0 : 0.6);
          }
          a *= vInfo.y * (1.0 - smoothstep(0.85, 1.0, r));
          if (a < 0.004) discard;
          gColor = vec4(light * uWorldTint * a * 0.2, 0.0);
          gNormal = vec4(0.0);
        }`,
      transparent: true,
      depthWrite: false,
      // Light added as is (alpha-weighted additive would multiply it by the 0 alpha), alpha and the
      // normal / outline buffer left untouched.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    this.rings = new THREE.InstancedMesh(rg, rm, N_RINGS + 2);
    for (let i = 0; i < N_RINGS + 2; i++) this.rings.setMatrixAt(i, _zero);
    this.rings.count = N_RINGS + 2;
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 3;
    this.group.add(this.prints, this.rings);
  }

  /** A foot landed at (x, y, z) facing yaw (world); side +1 right, -1 left; surface kind. */
  plant(x: number, y: number, z: number, yaw: number, side: number, kind: string, now: number): void {
    const w = this.water(x, z);
    // Only a foot that lands in the water rings it (not one on the deck above it).
    if (w.depth > 0.015 && y < w.y + 0.05) this.ring(x, z, now, Math.min(1, 0.5 + w.depth * 3));
    if (kind !== "sand" && kind !== "wetsand") return;
    if (w.depth > 0.25) return;
    const i = this.pNext;
    this.pNext = (this.pNext + 1) % N_PRINTS;
    this.p[i] = { x, y, z, yaw, side, t0: now, wet: Math.max(w.wet, kind === "wetsand" ? 0.8 : 0), wipe: 0 };
    this.prints.count = Math.max(this.prints.count, i + 1);
    const m = _m.compose(_p.set(x, y + 0.012, z), _q.setFromAxisAngle(_up, yaw), _one);
    // The print centre is ahead of the ankle (under the arch).
    m.multiply(_m2.makeTranslation(0, 0, -0.055));
    this.prints.setMatrixAt(i, m);
    this.prints.instanceMatrix.needsUpdate = true;
    this.pInfo.setXYZW(i, side, now, this.p[i].wet, 0);
    this.pInfo.needsUpdate = true;
  }

  private ring(x: number, z: number, now: number, s: number): void {
    const i = this.rNext;
    this.rNext = (this.rNext + 1) % N_RINGS;
    this.r[i] = { x, z, t0: now, s };
    this.rInfo.setXYZW(i, now, s, 0, 0);
    this.rInfo.needsUpdate = true;
  }

  /**
   * Per frame: rings ride the water surface; standing in water sends a ring now and then; the
   * swash wipes prints it runs over. `feet` = her two ankle points (world), or null off foot.
   */
  update(now: number, dt: number, feet: THREE.Vector3[] | null): void {
    this.uNow.value = now;
    const m = _m;
    _q.identity();
    for (let i = 0; i < this.r.length; i++) {
      const r = this.r[i];
      if (!r) continue;
      const age = now - r.t0;
      const w = this.water(r.x, r.z);
      const y = Number.isFinite(w.y) ? w.y + 0.01 : -100;
      const size = age < 2.6 && age >= 0 ? 1.6 : 0;
      m.compose(_p.set(r.x, y, r.z), _q, _s.set(size, 1, size));
      this.rings.setMatrixAt(i, m);
    }
    // Foam collars: where each leg crosses the water surface, faded in and out with the wading.
    for (let k = 0; k < 2; k++) {
      let s = 0, y = 0;
      if (feet && legProbe) {
        const w = this.water(feet[k].x, feet[k].z);
        if (Number.isFinite(w.y) && w.depth > 0.03 && feet[k].y < w.y && legProbe(k, w.y, _leg)) {
          y = this.water(_leg.x, _leg.z).y;
          if (!Number.isFinite(y)) y = w.y;
          s = Math.min(1, (w.depth - 0.03) / 0.05) * Math.min(1, (w.y - feet[k].y) / 0.04);
        }
      }
      const c = (this.collarS[k] += (s - this.collarS[k]) * (dt > 0 ? 1 - Math.exp(-8 * dt) : 1));
      if (c > 0.01) m.compose(_p.set(_leg.x, y + 0.008, _leg.z), _q, _s.set(COLLAR, 1, COLLAR));
      else m.copy(_zero);
      this.rings.setMatrixAt(N_RINGS + k, m);
      this.rInfo.setXYZW(N_RINGS + k, 1.7 + k * 2.3, c, 1, 0);
    }
    this.rInfo.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true;
    if (feet && dt > 0) {
      for (let k = 0; k < 2; k++) {
        const w = this.water(feet[k].x, feet[k].z);
        if (w.depth > 0.03 && feet[k].y < w.y + 0.03) {
          this.wadeT[k] -= dt;
          if (this.wadeT[k] <= 0) {
            this.ring(feet[k].x, feet[k].z, now, 0.45);
            this.wadeT[k] = 1.3 + 0.4 * k;
          }
        }
      }
    }
    this.check -= dt;
    if (this.check <= 0) {
      this.check = 0.25;
      for (let i = 0; i < this.p.length; i++) {
        const p = this.p[i];
        if (!p || p.wipe > 0 || now - p.t0 < 1.0) continue;
        if (this.water(p.x, p.z).depth > 0.02) {
          p.wipe = now;
          this.pInfo.setW(i, now);
          this.pInfo.needsUpdate = true;
        }
      }
    }
  }

  /** Frozen frames: wipe every print the water has run over since it was made (sampled history). */
  resolve(now: number): void {
    for (let i = 0; i < this.p.length; i++) {
      const p = this.p[i];
      if (!p) continue;
      for (let tt = p.t0 + 1; tt <= now; tt += 0.4)
        if (this.water(p.x, p.z, tt).depth > 0.02) {
          p.wipe = tt;
          this.pInfo.setW(i, tt);
          break;
        }
    }
    this.pInfo.needsUpdate = true;
  }

  /** Forget the trail (a frozen frame re-runs the seconds before it). */
  clear(): void {
    this.p = [];
    this.r = [];
    this.prints.count = 0;
    for (let i = 0; i < N_RINGS + 2; i++) this.rings.setMatrixAt(i, _zero);
    this.rings.instanceMatrix.needsUpdate = true;
    this.collarS[0] = this.collarS[1] = 0;
    this.pNext = this.rNext = 0;
  }
}
