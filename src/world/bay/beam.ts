import * as THREE from "three";
import { G } from "../../render/materials";
import { LAYER_REFLECT, onLayers } from "../../render/lightpasses";

/** Seconds per turn of the lighthouse lens. */
const PERIOD = 10;
const LEN = 200;
/** Haze streaks round the beam: a whole number, so the noise closes round the cone with no seam. */
const STREAKS = 18;

const OUT = /* glsl */ `
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormal;
uniform float uBeam;
`;

/**
 * Lighthouse lamp at dusk and night: two opposite slim beams of light turning slowly through the
 * evening haze, a soft bright core streaked with drifting haze and fading out along their length,
 * and a soft halo round the lamp that flares when a beam swings toward the viewer. Seen from high
 * above, a beam crosses little haze against the dark sea and stays faint. Additive and
 * depth-tested, so the island and the tower hide them where they should. Sets `uBeamDir` for the
 * water's sweep.
 */
export class LighthouseBeam {
  readonly group = new THREE.Group();
  private readonly turn = new THREE.Group();
  private readonly flash = { value: 0 };

  constructor(lamp: THREE.Vector3) {
    this.group.position.copy(lamp);
    G.uLampPos.value.copy(lamp);
    const beamMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uBeam: G.uBeam, uFogDensity: G.uFogDensity, uLampPos: G.uLampPos, uTime: G.uTime },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        out float vS;
        out float vA;
        out vec3 vN;
        out vec3 vWPos;
        void main(){
          vS = length(position.xz) / ${LEN.toFixed(1)};
          vA = uv.x * ${STREAKS.toFixed(1)};
          vN = normalize(mat3(modelMatrix) * normal);
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        ${OUT}
        in float vS;
        in float vA;
        in vec3 vN;
        in vec3 vWPos;
        uniform float uFogDensity;
        uniform vec3 uLampPos;
        uniform float uTime;
        float bHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        // Value noise wrapping every ${STREAKS} cells in x (round the cone).
        float bNoise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float x0 = mod(i.x, ${STREAKS.toFixed(1)}), x1 = mod(i.x + 1.0, ${STREAKS.toFixed(1)});
          return mix(mix(bHash(vec2(x0, i.y)), bHash(vec2(x1, i.y)), f.x), mix(bHash(vec2(x0, i.y + 1.0)), bHash(vec2(x1, i.y + 1.0)), f.x), f.y);
        }
        void main(){
          vec3 V = normalize(cameraPosition - vWPos);
          // Seen across the cone the core is the longest path through the beam: a slim bright core,
          // soft out to the edges.
          float core = pow(abs(dot(normalize(vN), V)), 5.0);
          // Most of the light is gone within a few island widths, and the open end fades out rather
          // than stopping; denser haze shows more of the beam.
          float fall = smoothstep(0.0, 0.025, vS) * exp(-vS * 5.0) * (1.0 - smoothstep(0.5, 1.0, vS));
          // Painted: long soft streaks of haze along the beam, drifting slowly outward.
          float streak = 0.5 + 0.5 * bNoise(vec2(vA, vS * 3.0 - uTime * 0.08));
          // From high above, a beam crosses little haze against the dark sea.
          float hi = 1.0 - 0.6 * smoothstep(12.0, 70.0, cameraPosition.y - uLampPos.y);
          float haze = clamp(uFogDensity / 0.0008, 0.5, 1.5);
          gColor = vec4(vec3(1.0, 0.88, 0.66) * core * fall * streak * hi * 0.24 * haze * uBeam, 1.0);
          gNormal = vec4(0.5, 0.5, 0.0, 0.0);
        }`,
    });
    for (const side of [0, Math.PI]) {
      const g = new THREE.CylinderGeometry(0.45, 5, LEN, 24, 1, true);
      g.translate(0, -LEN / 2, 0);
      g.rotateZ(Math.PI / 2 - 0.02);
      g.rotateY(side);
      const m = new THREE.Mesh(g, beamMat);
      m.frustumCulled = false;
      this.turn.add(m);
    }
    this.group.add(this.turn);

    const haloMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: { uBeam: G.uBeam, uFlash: this.flash },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        out vec2 vUv;
        void main(){
          vUv = uv;
          vec3 c = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          // Pulled a little toward the viewer so the lamp room never cuts it.
          c += normalize(cameraPosition - c) * 2.5;
          vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          vec3 wp = c + (right * position.x + up * position.y) * 16.0;
          gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        ${OUT}
        uniform float uFlash;
        in vec2 vUv;
        void main(){
          float r = length(vUv - 0.5) * 2.0;
          float glow = exp(-r * r * 9.0) * 0.55 + exp(-r * 22.0) * 0.9 + exp(-r * 3.5) * 0.12;
          glow *= 1.0 + uFlash * 2.5;
          gColor = vec4(vec3(1.0, 0.86, 0.6) * glow * uBeam, 1.0);
          gNormal = vec4(0.5, 0.5, 0.0, 0.0);
        }`,
    });
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), haloMat);
    halo.frustumCulled = false;
    halo.renderOrder = 2;
    this.group.add(halo);
    onLayers(this.group, LAYER_REFLECT);
    this.group.visible = false;
  }

  private readonly _toCam = new THREE.Vector3();

  /** Turn the lens (time in seconds) and flare the halo when a beam faces the camera. */
  update(time: number, cam: THREE.Vector3): void {
    const on = G.uBeam.value > 0.01;
    this.group.visible = on;
    // Phase chosen so the fixed capture time (t = 12) shows the beams across the views.
    const a = (time / PERIOD) * Math.PI * 2 + 3.81;
    this.turn.rotation.y = a;
    const dx = Math.cos(a), dz = -Math.sin(a);
    G.uBeamDir.value.set(dx, dz);
    if (!on) return;
    const v = this._toCam.subVectors(cam, this.group.position).setY(0).normalize();
    const facing = Math.abs(v.x * dx + v.z * dz);
    this.flash.value = Math.pow(facing, 40);
  }
}
