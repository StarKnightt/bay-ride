import * as THREE from "three";
import { COMMON, G, OUT } from "../render/materials";
import { ID } from "../world/geo";
import { mulberry32, range } from "../core/rng";

/**
 * Butterflies over the flower drifts: small yellow flecks mostly (as in a painted summer meadow),
 * some white, a few orange and the odd blue. Each wanders round its drift on a smooth looping path
 * with a quick flutter, and now and then settles on a flower with its wings slowly opening and
 * closing. All of it happens in the vertex shader; the CPU only packs the drifts near the camera
 * into the instance buffer every few metres of travel. Gone by dusk.
 */

const VS = /* glsl */ `
${COMMON}
in vec4 aAnchor; // drift centre x, y, z, phase
in vec4 aCol;    // colour rgb, wander radius
out vec3 vWPos;
out vec3 vCol;
out float vShade;
vec3 wander(float t, float ph, float R){
  return vec3((sin(t * 0.71 + ph) * 1.0 + sin(t * 1.87 + ph * 2.0) * 0.3) * R,
              0.5 + 0.28 * sin(t * 1.31 + ph) + 0.09 * sin(t * 3.7 + ph * 1.3),
              (cos(t * 0.53 + ph * 1.7) * 1.0 + sin(t * 1.41 + ph * 0.6) * 0.28) * R);
}
void main(){
  float t = uTime, ph = aAnchor.w, R = aCol.w;
  vec3 a = aAnchor.xyz;
  // Settling: now and then it lands on a flower near the middle of its drift.
  float rest = smoothstep(0.78, 0.93, sin(t * 0.11 + ph * 3.0) * 0.5 + 0.5);
  vec3 seat = vec3(cos(ph * 2.3) * R * 0.5, 0.42, sin(ph * 2.3) * R * 0.5);
  vec3 w0 = wander(t, ph, R), w1 = wander(t + 0.06, ph, R);
  vec3 p = a + mix(w0, seat, rest);
  vec2 dir = mix(w1.xz - w0.xz, vec2(sin(ph), cos(ph)), rest);
  float yaw = atan(dir.x, dir.y);
  // Quick flutter in flight, a slow open-and-close when settled.
  float fl = sin(t * 17.0 + ph * 7.0);
  float ang = mix(mix(0.15, 1.35, fl * 0.5 + 0.5), 0.75 + 0.55 * sin(t * 1.6 + ph), rest);
  p.y += 0.035 * fl * (1.0 - rest);
  float d = distance(p, cameraPosition);
  float k = (0.85 + 0.35 * fract(ph * 13.7)) * (1.0 - uNight) * (1.0 - smoothstep(45.0, 62.0, d)) * smoothstep(0.35, 0.9, d);
  vec3 q = position;
  float ax = abs(q.x);
  q = vec3(sign(q.x) * ax * cos(ang), ax * sin(ang), q.z);
  float c = cos(yaw), s = sin(yaw);
  q.xz = mat2(c, -s, s, c) * q.xz;
  vec3 wp = p + q * k;
  vWPos = wp;
  vCol = aCol.rgb * color;
  vShade = 0.85 + 0.15 * cos(ang);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  if (k < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FS = /* glsl */ `
${COMMON}
${OUT}
in vec3 vWPos;
in vec3 vCol;
in float vShade;
void main(){
  // Bright and nearly unshaded: small painted flecks catching the light.
  vec3 col = vCol * vShade * mix(vec3(1.0), uSunColor, 0.5) * 0.95;
  writeOut(applyFog(col, vWPos), vec3(0.0, 1.0, 0.0), -1.0);
}
`;

/** Wing fans hinged at x = 0 (forewing and hindwing on each side), darker toward the rim. */
function wings(): THREE.InstancedBufferGeometry {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (const s of [1, -1])
    for (const [cz, rx, rz, n] of [[-0.008, 0.042, 0.03, 6], [0.016, 0.03, 0.022, 5]] as const) {
      const c0 = pos.length / 3;
      pos.push(0, 0, cz);
      col.push(0.75, 0.75, 0.75);
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI;
        pos.push(s * Math.cos(a) * rx, 0, cz + Math.sin(a) * rz * (cz < 0 ? 1.15 : 1));
        col.push(1, 1, 1);
      }
      for (let i = 0; i < n; i++) idx.push(c0, c0 + 1 + i, c0 + 2 + i);
    }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

const HUES: [string, number][] = [["#f2d038", 0.6], ["#f6f3e8", 0.24], ["#f08a2c", 0.11], ["#6aa0e0", 0.05]];

export class Butterflies {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly anchor: THREE.InstancedBufferAttribute;
  private readonly col: THREE.InstancedBufferAttribute;
  /** Every butterfly: x, y, z, phase, r, g, b, radius. */
  private readonly all: Float32Array;
  private readonly lastAt = new THREE.Vector2(Infinity, Infinity);
  private readonly cap: number;
  readonly total: number;
  drawn = 0;

  constructor(drifts: readonly [number, number, number, number][], cap = 200) {
    const r = mulberry32(4545);
    const list: number[] = [];
    const c = new THREE.Color();
    for (const [x, y, z, rad] of drifts) {
      // One to three per drift, more on the big ones.
      const n = Math.min(3, Math.max(1, Math.round(rad / 2.2 + r() * 1.2)));
      for (let i = 0; i < n; i++) {
        let u = r(), hue = HUES[0][0];
        for (const [h, w] of HUES) {
          if (u < w) {
            hue = h;
            break;
          }
          u -= w;
        }
        c.set(hue);
        list.push(x + range(r, -0.5, 0.5), y, z + range(r, -0.5, 0.5), r() * 100, c.r, c.g, c.b, Math.max(0.8, Math.min(2.6, rad * range(r, 0.45, 0.7))));
      }
    }
    this.all = Float32Array.from(list);
    this.total = list.length / 8;
    this.geo = wings();
    this.anchor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.col = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.anchor.setUsage(THREE.DynamicDrawUsage);
    this.col.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aAnchor", this.anchor);
    this.geo.setAttribute("aCol", this.col);
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...G, uId: { value: ID.butterfly }, uMask: { value: -1 } },
      vertexShader: VS,
      fragmentShader: FS,
      vertexColors: true,
      side: THREE.DoubleSide,
    });
    mat.name = "butterflies";
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = "butterflies";
    this.cap = cap;
  }

  /** Pack the butterflies within 64 m of the camera (when it has moved 6 m, and on the first call). */
  update(cam: THREE.Vector3, day: number): void {
    this.mesh.visible = day > 0.02;
    if (Math.hypot(cam.x - this.lastAt.x, cam.z - this.lastAt.y) < 6) return;
    this.lastAt.set(cam.x, cam.z);
    const a = this.anchor.array as Float32Array, c = this.col.array as Float32Array, d = this.all;
    let n = 0;
    for (let k = 0; k * 8 < d.length && n < this.cap; k++) {
      const dx = d[k * 8] - cam.x, dz = d[k * 8 + 2] - cam.z;
      if (dx * dx + dz * dz > 64 * 64) continue;
      for (let j = 0; j < 4; j++) {
        a[n * 4 + j] = d[k * 8 + j];
        c[n * 4 + j] = d[k * 8 + 4 + j];
      }
      n++;
    }
    this.geo.instanceCount = n;
    this.drawn = n;
    if (n) {
      this.anchor.clearUpdateRanges();
      this.col.clearUpdateRanges();
      this.anchor.addUpdateRange(0, n * 4);
      this.col.addUpdateRange(0, n * 4);
      this.anchor.needsUpdate = true;
      this.col.needsUpdate = true;
    }
  }
}
