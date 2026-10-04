import * as THREE from "three";
import { COMMON, G, REFL } from "../render/materials";
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
 * time-of-day water colours: sand showing through the shallows, deep blue further out, the real
 * sky, clouds and land mirrored (planar reflection) with Fresnel, a glitter path of broken
 * dashes under the sun or moon, a soft line of foam where it meets the beach, and the
 * lighthouse beam sweeping across it at night.
 */
export function buildSea(): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, ...DEPTH, ...REFL, uId: { value: ID.water }, uMask: { value: 0 }, uSeaY: { value: SEA_Y } },
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
      uniform sampler2D uRefl;
      uniform mat4 uReflMat;
      uniform float uReflOn;
      uniform float uReflY;
      in vec3 vWPos;
      void main(){
        vec3 V = normalize(vWPos - cameraPosition);
        vec2 q = vWPos.xz;
        float dist = length(vWPos - cameraPosition);
        // Painted ripples: two drifting octaves, calmed with distance so they never alias.
        float near = 1.0 - smoothstep(40.0, 500.0, dist);
        vec2 r1 = vec2(vnoise(q * 0.31 + vec2(uTime * 0.21, uTime * 0.08)), vnoise(q * 0.27 - vec2(uTime * 0.15, -uTime * 0.19) + 7.0)) - 0.5;
        vec2 r2 = vec2(vnoise(q * 1.2 + uTime * 0.45), vnoise(q * 1.05 - uTime * 0.38 + 3.0)) - 0.5;
        vec2 rip = r1 * (0.06 + 0.1 * near) + r2 * 0.08 * near * near;
        vec3 Nw = normalize(vec3(rip.x, 1.0, rip.y));

        // Mirror: the real scene above the water (sky, clouds, hills, island), gently broken up.
        vec3 refl;
        if (uReflOn > 0.5) {
          vec4 rp = uReflMat * vec4(vWPos.x, uReflY, vWPos.z, 1.0);
          vec2 ruv = rp.xy / rp.w + rip * vec2(0.05, 0.08) * (0.25 + 0.75 * near);
          refl = texture(uRefl, clamp(ruv, 0.001, 0.999)).rgb;
        } else {
          vec3 R = reflect(V, normalize(vec3(rip.x * 0.4, 1.0, rip.y * 0.4)));
          R.y = max(R.y, 0.02);
          refl = skyColor(normalize(R)) * uWorldTint;
        }
        // Reflections read a little darker and richer than what they mirror (more so at night).
        float rl = dot(refl, vec3(0.2126, 0.7152, 0.0722));
        refl = mix(vec3(rl), refl, 1.15) * uWaterRefl * mix(0.9, 0.68, uNight);
        // Undo the world tint applyFog adds: the mirrored scene already carries it.
        refl /= max(uWorldTint, vec3(0.05));

        float cosT = max(-V.y, 0.0);
        float fres = 0.04 + 0.96 * pow(1.0 - cosT, 5.0);
        // Body colour by depth, with a little painterly banding.
        float depth = max(uSeaY - seabedY(q), 0.0);
        float k = 1.0 - exp(-depth * 0.2);
        float kb = k * 5.0 + vnoise(q * 0.04);
        k = mix(k, (floor(kb) + smoothstep(0.25, 0.75, fract(kb))) / 5.0, 0.2);
        vec3 body = mix(uWaterShallow, uWaterDeep, smoothstep(0.0, 0.95, k));
        // Sand glows through the clear shallows.
        vec3 sand = vec3(0.78, 0.68, 0.47) * mix(uShadowTint, uSunColor, 0.7) * 0.9;
        body = mix(sand, body, smoothstep(0.0, 1.6, depth) * 0.8 + 0.2);
        vec3 col = mix(body, refl, fres * 0.92);

        // Glitter path: the share of wave facets tilted to mirror the light into the eye (a slope
        // spread of uGlintShape.x) sets where dashes may appear, so they gather in a wedge under
        // the sun or moon and vanish elsewhere. Dashes are short and horizontal on screen.
        vec3 Ld = normalize(uGlintDir);
        vec3 H = normalize(Ld - V);
        float c2 = H.y * H.y;
        float tan2 = (1.0 - c2) / max(c2, 1e-4);
        float sig = uGlintShape.x;
        float path = exp(-tan2 / (2.0 * sig * sig)) * smoothstep(-0.02, 0.04, Ld.y);
        vec2 fwd = normalize(V.xz + 1e-5);
        vec2 sq = vec2(dot(q, vec2(-fwd.y, fwd.x)), dot(q, fwd)) / (0.4 + dist * 0.01);
        float dn = vnoise(sq * vec2(0.55, 3.2) + vec2(uTime * 0.5, -uTime * 1.1)) * 0.6
                 + vnoise(sq * vec2(1.3, 7.0) + vec2(-uTime * 0.7, uTime * 0.6) + 5.0) * 0.4;
        float th = 1.0 - path * 0.42;
        float dash = smoothstep(th, th + 0.04, dn);
        col += uGlintCol * uGlint * (dash * (0.7 + 1.6 * path) + path * uGlintShape.y);

        // Soft foam line where the water thins out on the sand (placeholder for the breaking surf).
        float wob = vnoise(q * 0.22 + vec2(0.0, uTime * 0.3)) * 0.25;
        float foam = 1.0 - smoothstep(0.03, 0.28 + wob, depth);
        foam *= smoothstep(0.35, 0.55, vnoise(q * 1.4 + vec2(uTime * 0.2, 0.0)) + 0.35);
        vec3 foamCol = mix(uShadowTint, uSunColor, 0.75) * 0.92;
        col = mix(col, foamCol, clamp(foam, 0.0, 1.0) * 0.85);

        // Lighthouse beam brushing across the water as it turns (placeholder for system 3).
        if (uBeam > 0.0) {
          vec2 rel = q - uLampPos.xz;
          float rlen = length(rel);
          float al = dot(rel / max(rlen, 1e-3), uBeamDir);
          float sweep = smoothstep(0.975, 0.998, al) * exp(-rlen * 0.004) * smoothstep(8.0, 40.0, rlen);
          col += vec3(1.0, 0.88, 0.62) * sweep * 0.22 * uBeam;
        }
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
