import * as THREE from "three";
import { G } from "../render/materials";
import { mulberry32, range } from "../core/rng";
import { groundY, uOf, type Layout } from "../flora/place";
import { ROAD_Z0, ROAD_Z1 } from "../world/bay/road";
import { ISLAND, WALL_OUT } from "../world/bay/terrain";

/**
 * Fireflies at dusk and night over the grass round her: soft green-gold points drifting and blinking
 * slowly, added as light (the bloom makes the glow). They hang in a few loose clumps, from knee
 * height to a little over her head, along the hedgerows, garden and path edges, the verges, the
 * dune grass under the sea wall and the island, all within ~40 m of her. A clump left behind as she
 * moves is moved into the view ahead, its flies following a few a frame; the drift and blink run in
 * the vertex shader. One draw.
 */

const N = 150;
/** Clumps (fly i belongs to clump i % K) and how far from her they may stay. */
const K = 6;
const FAR = 44;

export class Fireflies {
  readonly mesh: THREE.Mesh;
  private readonly off: THREE.InstancedBufferAttribute;
  private readonly r = mulberry32(911);
  private init = false;
  /** Per clump: centre x, z, spread (m), height scale, long-axis angle; x NaN = not on grass yet. */
  private readonly clumps = new Float32Array(K * 5).fill(NaN);
  private readonly stale = new Uint8Array(N);
  private cursor = 0;
  private turn = 0;

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
          vec3 h = fract(ph * vec3(0.618, 0.414, 0.732));
          // A slow wander round its spot, a quicker weave on top and a lazy rise and fall, each fly
          // at its own pace.
          vec3 c = aOff.xyz + vec3(
            sin(t * (0.2 + 0.18 * h.x) + ph) * (0.6 + 0.7 * h.y) + sin(t * (0.9 + 0.7 * h.z) + ph * 2.3) * 0.2,
            sin(t * (0.3 + 0.3 * h.y) + ph * 1.7) * (0.12 + 0.2 * h.z) + sin(t * (1.6 + h.x) + ph * 3.1) * 0.04,
            cos(t * (0.17 + 0.16 * h.z) + ph * 1.3) * (0.6 + 0.7 * h.x) + cos(t * (0.8 + 0.6 * h.y) + ph * 0.7) * 0.2);
          // Slow blink: a soft flash, then a long dark gap; the flies out of step with each other.
          float cyc = fract(t / (3.2 + 2.8 * h.z) + ph * 0.137);
          vB = smoothstep(0.0, 0.1, cyc) * (1.0 - smoothstep(0.18, 0.5, cyc)) * smoothstep(0.25, 0.75, uNight);
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

  /**
   * Grass a fly may hang over: inland of the road (the verges, the hill, the town's gardens), the
   * dune grass at the top of the beach, the island. Never the open sand or the water.
   */
  private grassy(x: number, z: number): boolean {
    const u = uOf(x, z);
    const dune = u < WALL_OUT - 0.5 && u > WALL_OUT - 6 && z < ROAD_Z0 && z > ROAD_Z1;
    if (u < 4 && !dune && Math.hypot(x - ISLAND.x, z - ISLAND.z) > ISLAND.r + 2) return false;
    return this.layout.free(x, z, 0);
  }

  /**
   * Clump k on grass near (x, z), apart from the others: ahead of the view `(fx, fz)` when `ahead`,
   * else anywhere round her, the first clump close by.
   */
  private placeClump(k: number, x: number, z: number, fx: number, fz: number, ahead: boolean): boolean {
    const r = this.r, c = this.clumps;
    for (let n = 0; n < 12; n++) {
      const fwd = ahead && n < 8;
      const ang = fwd ? Math.atan2(fz, fx) + range(r, -0.9, 0.9) : r() * Math.PI * 2;
      const d = fwd ? range(r, 18, 38) : range(r, 3, !ahead && k === 0 ? 14 : 38);
      const cx = x + Math.cos(ang) * d, cz = z + Math.sin(ang) * d;
      if (!this.grassy(cx, cz)) continue;
      // Mostly by an edge (hedgerows along the walls, gardens, path verges), out on open grass less often.
      if (n < 8 && this.layout.clearance(cx, cz) > 3.5 && r() < 0.5) continue;
      let near = false;
      for (let j = 0; j < K && !near; j++)
        near = j !== k && n < 10 && Math.hypot(c[j * 5] - cx, c[j * 5 + 1] - cz) < 9;
      if (near) continue;
      c.set([cx, cz, range(r, 2.5, 6), range(r, 0.6, 1), r() * Math.PI], k * 5);
      return true;
    }
    c[k * 5] = NaN;
    return false;
  }

  /** Fly i somewhere in its clump: a soft spread thinning outward, knee height to a little over hers. */
  private place(i: number): void {
    const r = this.r, a = this.off.array as Float32Array, c = this.clumps, k = (i % K) * 5;
    this.stale[i] = 0;
    a[i * 4 + 1] = -1e4;
    if (Number.isNaN(c[k])) return;
    const ca = Math.cos(c[k + 4]), sa = Math.sin(c[k + 4]);
    for (let n = 0; n < 6; n++) {
      // Gaussian round the centre (sigma = half the spread), stretched along the clump's long axis.
      const rad = c[k + 2] * 0.5 * Math.sqrt(-2 * Math.log(1 - r() * 0.999));
      const ang = r() * Math.PI * 2;
      const along = Math.cos(ang) * rad, across = Math.sin(ang) * rad * 0.55;
      const px = c[k] + along * ca - across * sa, pz = c[k + 1] + along * sa + across * ca;
      if (!this.grassy(px, pz)) continue;
      a[i * 4] = px;
      a[i * 4 + 1] = groundY(px, pz) + 0.45 + 2.05 * c[k + 3] * Math.pow(r(), 1.6);
      a[i * 4 + 2] = pz;
      a[i * 4 + 3] = r() * 100;
      return;
    }
  }

  /** `night` 0…1; (px, pz) = her, (fx, fz) = the view's heading. */
  update(night: number, px: number, pz: number, fx: number, fz: number): void {
    this.mesh.visible = night > 0.25;
    if (!this.mesh.visible) {
      this.init = false;
      return;
    }
    const c = this.clumps;
    let moved = 0;
    if (!this.init) {
      c.fill(NaN);
      for (let k = 0; k < K; k++) this.placeClump(k, px, pz, fx, fz, false);
      for (let i = 0; i < N; i++) this.place(i);
      moved = N;
      this.init = true;
    } else {
      // One clump looked at per frame: left behind (or not on grass yet), it moves into the view ahead.
      const k = this.turn;
      this.turn = (k + 1) % K;
      if ((Number.isNaN(c[k * 5]) || Math.hypot(c[k * 5] - px, c[k * 5 + 1] - pz) > FAR) && this.placeClump(k, px, pz, fx, fz, true))
        for (let i = k; i < N; i += K) this.stale[i] = 1;
      // Its flies follow a few per frame.
      for (let j = 0; j < N && moved < 3; j++) {
        const i = (this.cursor + j) % N;
        if (!this.stale[i]) continue;
        this.place(i);
        moved++;
      }
    }
    this.cursor = (this.cursor + 7) % N;
    if (moved) this.off.needsUpdate = true;
  }
}
