import * as THREE from "three";
import { G } from "../render/materials";
import { mulberry32, range } from "../core/rng";
import { groundY, uOf, type Layout } from "../flora/place";

/**
 * Fireflies at dusk and night over the grass round her: soft green-gold points drifting low and
 * blinking slowly, added as light (the bloom makes the glow). Positions are kept within ~40 m of
 * her on grassy ground (the hill, the verges, the island), recycled ahead of the camera as she
 * moves; the drift and blink run in the vertex shader. One draw.
 */

const N = 150;

export class Fireflies {
  readonly mesh: THREE.Mesh;
  private readonly off: THREE.InstancedBufferAttribute;
  private readonly r = mulberry32(911);
  private init = false;

  constructor(private readonly layout: Layout) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute("position", quad.attributes.position);
    g.instanceCount = N;
    this.off = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    this.off.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute("aOff", this.off);
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uTime: G.uTime, uNight: G.uNight },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform float uNight;
        in vec4 aOff;
        out vec2 vQ; out float vB;
        void main(){
          float ph = aOff.w, t = uTime;
          vec3 c = aOff.xyz + vec3(sin(t * 0.37 + ph) * 0.9 + sin(t * 1.3 + ph * 2.0) * 0.2,
                                   sin(t * 0.8 + ph * 1.7) * 0.28,
                                   cos(t * 0.29 + ph * 1.3) * 0.9);
          // Slow blink: long dark gaps, a soft pulse, the flies out of step with each other.
          float bl = sin(t * (0.9 + fract(ph) * 0.9) + ph * 5.0);
          vB = smoothstep(0.1, 0.8, bl) * smoothstep(0.25, 0.75, uNight);
          float d = distance(c, cameraPosition);
          // Never smaller than ~7 px, so they survive the paint filter.
          float s = max(0.09, d * 0.0075) * step(0.01, vB) * smoothstep(0.6, 1.4, d);
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vQ = position.xy * 2.0;
          gl_Position = projectionMatrix * viewMatrix * vec4(c + (right * position.x + up * position.y) * s, 1.0);
          if (s <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        in vec2 vQ; in float vB;
        layout(location = 0) out vec4 gColor;
        layout(location = 1) out vec4 gNormal;
        void main(){
          float r = length(vQ);
          if (r > 1.0 || vB < 0.01) discard;
          float k = 1.0 - smoothstep(0.2, 1.0, r);
          gColor = vec4(mix(vec3(0.55, 0.9, 0.25), vec3(1.0, 1.0, 0.7), k) * (0.6 + 4.0 * k) * vB * k, 0.0);
          gNormal = vec4(0.0);
        }`,
      transparent: true,
      depthWrite: false,
      // Light added as is; the alpha and the normal / outline buffer stay untouched.
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    mat.name = "fireflies";
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = "fireflies";
  }

  /** A grassy spot near (x, z), ahead of the view `(fx, fz)` when `ahead`. */
  private place(i: number, x: number, z: number, fx: number, fz: number, ahead: boolean): void {
    const r = this.r, a = this.off.array as Float32Array;
    for (let k = 0; k < 8; k++) {
      const ang = ahead ? Math.atan2(fz, fx) + range(r, -0.9, 0.9) : r() * Math.PI * 2;
      const d = ahead ? range(r, 18, 38) : range(r, 3, 38);
      const px = x + Math.cos(ang) * d, pz = z + Math.sin(ang) * d;
      if (uOf(px, pz) < 4 && Math.hypot(px + 200, pz + 20) > 40) continue;
      if (!this.layout.free(px, pz, 0)) continue;
      a[i * 4] = px;
      a[i * 4 + 1] = groundY(px, pz) + range(r, 0.3, 1.7);
      a[i * 4 + 2] = pz;
      a[i * 4 + 3] = r() * 100;
      return;
    }
    a[i * 4 + 1] = -1e4;
  }

  /** `night` 0…1; (px, pz) = her, (fx, fz) = the view's heading. */
  update(night: number, px: number, pz: number, fx: number, fz: number): void {
    this.mesh.visible = night > 0.25;
    if (!this.mesh.visible) {
      this.init = false;
      return;
    }
    const a = this.off.array as Float32Array;
    let moved = 0;
    if (!this.init) {
      for (let i = 0; i < N; i++) this.place(i, px, pz, fx, fz, false);
      moved = N;
      this.init = true;
    } else
      // A few per frame at most: those left behind are recycled into the view ahead.
      for (let j = 0; j < N && moved < 3; j++) {
        const i = (this.cursor + j) % N;
        const dx = a[i * 4] - px, dz = a[i * 4 + 2] - pz;
        if (dx * dx + dz * dz > 44 * 44 || a[i * 4 + 1] < -1e3) {
          this.place(i, px, pz, fx, fz, true);
          moved++;
        }
      }
    this.cursor = (this.cursor + 7) % N;
    if (moved) this.off.needsUpdate = true;
  }
  private cursor = 0;
}
