import * as THREE from "three";
import { COMMON, G } from "../render/materials";
import { ID } from "../world/geo";
import { BAND, COAST_GLSL } from "./sea";
import { SEA_Y } from "../world/bay/road";

/**
 * Plain painted water for a GPU whose driver can't build the sea's program (a phone's compiler or
 * limits): the time of day's water colours, the sky mirrored toward grazing angles and a soft sun or
 * moon path, on the same two meshes. Never a black hole where the bay should be.
 */
const VS = /* glsl */ `
  uniform vec2 uGridO;
  uniform float uBand;
  out vec3 vWPos;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    if (uBand < 0.5) wp.xz += uGridO;
    wp.y = ${SEA_Y.toFixed(3)} - 0.03 * uBand;
    vWPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }`;

const FS = /* glsl */ `
  ${COMMON}
  ${COAST_GLSL}
  layout(location = 0) out vec4 gColor;
  layout(location = 1) out vec4 gNormal;
  uniform float uId;
  uniform float uBand;
  in vec3 vWPos;
  void main(){
    if (uBand < 0.5) {
      float u = vWPos.x - coastRoadX(vWPos.z) - coastWaterU(vWPos.z);
      if (vWPos.z > ${BAND.z0.toFixed(1)} && vWPos.z < ${BAND.z1.toFixed(1)} && u > ${(BAND.outer + 0.4).toFixed(1)}) discard;
    }
    vec3 V = normalize(cameraPosition - vWPos);
    vec3 R = reflect(-V, vec3(0.0, 1.0, 0.0));
    float fres = pow(1.0 - max(V.y, 0.0), 3.0);
    float n = vnoise(vWPos.xz * 0.08 + uTime * 0.05) * 0.5 + vnoise(vWPos.xz * 0.23 - uTime * 0.07) * 0.5;
    vec3 body = mix(uWaterDeep, uWaterShallow, 0.18 + 0.12 * n);
    vec3 col = mix(body, skyColor(R) * uWaterRefl, 0.2 + 0.6 * fres);
    col += uGlintCol * uGlint * pow(max(dot(R, uGlintDir), 0.0), 160.0) * (0.6 + 0.8 * n);
    col = applyFog(col, vWPos);
    vec3 vn = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
    gColor = vec4(safe3(col), 1.0);
    gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, 0.0);
  }`;

export function fallbackSeaMaterial(src: THREE.ShaderMaterial): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, uGridO: src.uniforms.uGridO, uBand: src.uniforms.uBand, uId: { value: ID.water } },
    vertexShader: VS,
    fragmentShader: FS,
  });
}
