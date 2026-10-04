import * as THREE from "three";
import { COMMON, G } from "../render/materials";
import { ID } from "../world/geo";
import { SEA_Y } from "../world/bay/road";
import { DEPTH, DEPTH_GLSL } from "./depthMap";

const OUT = /* glsl */ `
layout(location = 0) out vec4 gColor;
layout(location = 1) out vec4 gNormal;
uniform float uId;
uniform float uMask;
`;

/**
 * Placeholder sea (systems 2 and 3 replace it): one flat disc at mean sea level, painted from the
 * time-of-day water colours — sand showing through the shallows, deep blue further out, the sky
 * reflected with Fresnel, a glitter path under the sun (or moon) and a soft line of foam where it
 * meets the beach.
 */
export function buildSea(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, ...DEPTH, uId: { value: ID.water }, uMask: { value: 0 }, uSeaY: { value: SEA_Y } },
    vertexShader: /* glsl */ `
      out vec3 vWPos;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${OUT}
      ${DEPTH_GLSL}
      uniform float uSeaY;
      in vec3 vWPos;
      void main(){
        vec3 V = normalize(vWPos - cameraPosition);
        vec2 q = vWPos.xz;
        float dist = length(vWPos - cameraPosition);
        // Painted ripples: two drifting octaves, calmed with distance so they never alias.
        float near = 1.0 - smoothstep(40.0, 500.0, dist);
        vec2 r1 = vec2(vnoise(q * 0.31 + vec2(uTime * 0.21, uTime * 0.08)), vnoise(q * 0.27 - vec2(uTime * 0.15, -uTime * 0.19) + 7.0)) - 0.5;
        vec2 r2 = vec2(vnoise(q * 1.2 + uTime * 0.45), vnoise(q * 1.05 - uTime * 0.38 + 3.0)) - 0.5;
        vec2 rip = r1 * (0.1 + 0.12 * near) + r2 * 0.1 * near * near;
        vec3 Nw = normalize(vec3(rip.x, 1.0, rip.y));
        vec3 R = reflect(V, Nw);
        R.y = max(R.y, 0.01);
        // Sky reflection (undo the world tint applyFog adds: the sky is never darkened by it).
        vec3 refl = skyColor(normalize(R)) * uWaterRefl / max(uWorldTint, vec3(0.05));
        float cosT = max(-V.y, 0.0);
        float fres = 0.05 + 0.95 * pow(1.0 - cosT, 5.0);
        // Body colour by depth, with a little painterly banding.
        float depth = max(uSeaY - seabedY(q), 0.0);
        float k = 1.0 - exp(-depth * 0.2);
        k = mix(k, floor(k * 5.0 + vnoise(q * 0.04)) / 5.0, 0.25);
        vec3 body = mix(uWaterShallow, uWaterDeep, smoothstep(0.0, 0.95, k));
        // Sand glows through the clear shallows.
        vec3 sand = vec3(0.78, 0.68, 0.47) * mix(uShadowTint, uSunColor, 0.7) * 0.9;
        body = mix(sand, body, smoothstep(0.0, 1.6, depth) * 0.8 + 0.2);
        vec3 col = mix(body, refl, fres * 0.9);
        // Glitter path: tight sparkles on ripple crests plus a broad soft sheen toward the light.
        float g = max(dot(R, uGlintDir), 0.0);
        float sp = smoothstep(0.62, 0.9, vnoise(q * vec2(1.3, 3.1) + vec2(uTime * 0.9, -uTime * 0.4)) * 0.6 + vnoise(q * 3.7 - uTime * 0.7) * 0.4);
        col += uGlintCol * (pow(g, 160.0) * (0.25 + 3.0 * sp) + pow(g, 14.0) * 0.06) * uGlint;
        // Soft foam line where the water thins out on the sand (placeholder for the breaking surf).
        float wob = vnoise(q * 0.22 + vec2(0.0, uTime * 0.3)) * 0.25;
        float foam = 1.0 - smoothstep(0.03, 0.28 + wob, depth);
        foam *= smoothstep(0.35, 0.55, vnoise(q * 1.4 + vec2(uTime * 0.2, 0.0)) + 0.35);
        vec3 foamCol = mix(uShadowTint, uSunColor, 0.75) * 0.92;
        col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.85);
        col = applyFog(col, vWPos);
        gColor = vec4(col, 1.0);
        vec3 vn = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
        gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, 0.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.CircleGeometry(4000, 96).rotateX(-Math.PI / 2), mat);
  m.position.y = SEA_Y;
  m.frustumCulled = false;
  return m;
}
