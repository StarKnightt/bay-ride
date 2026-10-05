import * as THREE from "three";
import { COMMON, G, OUT } from "../render/materials";
import { ID } from "../world/geo";
import { mulberry32 } from "../core/rng";

/**
 * Petals and seeds on the breeze by day: pink and white petals tumbling end over end, cream
 * blossom flakes, and dandelion-like seed fluff floating level, all drifting downwind and slowly
 * sinking in a box that wraps round the camera, so there are always a few in view and never a
 * blob on the lens. One draw, animated entirely on the GPU.
 */

const N = 240;
const BOX = [44, 10, 44] as const;

const VS = /* glsl */ `
${COMMON}
in vec4 aP;  // box position 0..1 (xyz), phase
in vec4 aK;  // kind (0 petal, 1 flake, 2 seed), size, colour pick, spin
out vec3 vWPos;
out vec2 vQ;
out vec3 vCol;
flat out int vKind;
out float vFace;
const vec3 BOX = vec3(${BOX[0].toFixed(1)}, ${BOX[1].toFixed(1)}, ${BOX[2].toFixed(1)});
void main(){
  float t = uTime, ph = aP.w;
  int kind = int(aK.x + 0.5);
  float rate = kind == 2 ? 0.05 : 0.14 + 0.08 * fract(ph * 3.1);
  vec3 p = aP.xyz * BOX;
  p.xz += uWindDir * t * (kind == 2 ? 1.3 : 0.85 + 0.4 * fract(ph * 7.3));
  p.y -= t * rate;
  p += vec3(sin(t * 1.3 + ph * 6.0), sin(t * 0.9 + ph * 4.0) * 0.5, cos(t * 1.1 + ph * 5.0)) * 0.55;
  // Wrap into a box round the camera, a little more of it below eye height than above.
  vec3 lo = cameraPosition - BOX * vec3(0.5, 0.35, 0.5);
  vec3 c = lo + mod(p - lo, BOX);
  float d = distance(c, cameraPosition);
  float k = aK.y * (1.0 - uNight) * smoothstep(0.7, 1.6, d) * (1.0 - smoothstep(16.0, 22.0, d));
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 off;
  vFace = 1.0;
  if (kind == 2) {
    off = (right * position.x + up * position.y) * k;
  } else {
    // Tumbling: the petal turns about its own axis, edge-on and face-on by turns.
    float a = t * (1.6 + 2.2 * fract(ph * 11.0)) * aK.w + ph;
    vec3 ax = normalize(vec3(sin(ph * 3.0), cos(ph * 5.0), sin(ph * 7.0)));
    vec3 l = vec3(position.x * (kind == 0 ? 0.7 : 1.0), position.y, 0.0) * k;
    off = l * cos(a) + cross(ax, l) * sin(a) + ax * dot(ax, l) * (1.0 - cos(a));
    vec3 n = vec3(0.0, 0.0, 1.0) * cos(a) + cross(ax, vec3(0.0, 0.0, 1.0)) * sin(a) + ax * ax.z * (1.0 - cos(a));
    vFace = abs(dot(n, normalize(cameraPosition - c)));
  }
  vWPos = c + off;
  vQ = position.xy * 2.0;
  vKind = kind;
  float pick = aK.z;
  vCol = kind == 2 ? vec3(0.96, 0.95, 0.9) : pick < 0.45 ? vec3(0.95, 0.62, 0.72) : pick < 0.8 ? vec3(0.97, 0.94, 0.9) : vec3(0.96, 0.86, 0.55);
  gl_Position = projectionMatrix * viewMatrix * vec4(vWPos, 1.0);
  if (k < 0.005) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const FS = /* glsl */ `
${COMMON}
${OUT}
in vec3 vWPos;
in vec2 vQ;
in vec3 vCol;
flat in int vKind;
in float vFace;
void main(){
  float r = length(vQ);
  float a;
  if (vKind == 2) {
    // Seed fluff: a soft star of fine rays round a dot.
    float th = atan(vQ.y, vQ.x);
    a = (1.0 - smoothstep(0.15, 1.0, r)) * (0.35 + 0.65 * pow(abs(cos(th * 5.0)), 8.0)) + (1.0 - smoothstep(0.1, 0.2, r));
  } else {
    // Petal: an oval, notched at the tip for the pink ones.
    float e = 1.0 - length(vQ * vec2(1.0, 0.75));
    if (vKind == 0) e -= 0.35 * (1.0 - smoothstep(0.0, 0.25, abs(vQ.x))) * smoothstep(0.6, 1.0, vQ.y);
    a = clamp(e / max(fwidth(e), 1e-4) + 0.5, 0.0, 1.0);
  }
  if (a < 0.35) discard;
  gAlpha = min(a, 1.0);
  vec3 col = vCol * (uSunColor * (0.6 + 0.4 * vFace) + uSkyMid * 0.2);
  writeOut(applyFog(col, vWPos), vec3(0.0, 1.0, 0.0), -1.0);
}
`;

export class Drift {
  readonly mesh: THREE.Mesh;

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute("position", quad.attributes.position);
    const r = mulberry32(2626);
    const P = new Float32Array(N * 4), K = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      P.set([r(), r(), r(), r() * 100], i * 4);
      const u = r();
      const kind = u < 0.45 ? 0 : u < 0.7 ? 1 : 2;
      K.set([kind, kind === 2 ? 0.06 + r() * 0.03 : 0.035 + r() * 0.02, r(), r() < 0.5 ? 1 : -1], i * 4);
    }
    g.setAttribute("aP", new THREE.InstancedBufferAttribute(P, 4));
    g.setAttribute("aK", new THREE.InstancedBufferAttribute(K, 4));
    g.instanceCount = N;
    const mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { ...G, uId: { value: ID.sky }, uMask: { value: -1 } },
      vertexShader: VS,
      fragmentShader: FS,
      side: THREE.DoubleSide,
      alphaToCoverage: true,
    });
    mat.name = "drift";
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = "petals and seeds";
  }

  update(day: number): void {
    this.mesh.visible = day > 0.02;
  }
}
