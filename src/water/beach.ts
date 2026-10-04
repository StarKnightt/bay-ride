import * as THREE from "three";
import { COMMON, G, REFL } from "../render/materials";
import { ID } from "../world/geo";
import { DEPTH, DEPTH_GLSL } from "./depthMap";
import { WAVES_GLSL } from "./waves";

/**
 * The swash zone of the beach: sand that darkens and turns glossy where the run-ups have been and
 * dries back over a few tens of seconds, the thin sheet of each wave washing up with a lacy foam
 * front and draining back down, and the occasional stranded foam line at the top of a run-up.
 */
export function beachMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, ...DEPTH, ...REFL, uId: { value: ID.ground }, uMask: { value: 0 } },
    vertexShader: /* glsl */ `
      out vec3 vWPos;
      out vec3 vN;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      layout(location = 0) out vec4 gColor;
      layout(location = 1) out vec4 gNormal;
      uniform float uId;
      uniform float uMask;
      ${DEPTH_GLSL}
      ${WAVES_GLSL}
      uniform sampler2D uRefl;
      uniform mat4 uReflMat;
      uniform float uReflOn;
      uniform float uReflY;
      in vec3 vWPos;
      in vec3 vN;
      void main(){
        vec3 N = normalize(vN);
        vec2 q = vWPos.xz;
        float px = length(fwidth(q)) * 0.7;
        float zs = vWPos.y - W_SEA;
        WSwash w = wSwash(q, zs, uTime, px);

        // Sand: pale and warm when dry, umber when wet; it dries unevenly, in patches.
        float n1 = vnoise(q * 0.45), n2 = vnoise(q * 2.7 + 3.0);
        float keep = 1.0 - smoothstep(0.02, 0.08, px);
        vec3 dry = vec3(0.8, 0.69, 0.44) * (0.94 + 0.08 * n1 + 0.05 * (n2 - 0.5) * keep);
        vec3 damp = vec3(0.37, 0.29, 0.17) * (0.93 + 0.1 * n1);
        float wet = clamp(w.wet * (0.8 + 0.4 * vnoise(q * 0.7 + 9.0)), 0.0, 1.0);
        // The lower beach stays faintly damp from earlier tides.
        wet = max(wet, 0.4 * smoothstep(0.9, 0.15, zs));
        vec3 base = mix(dry, damp, wet);
        // Backwash ripple marks on the wet sand (diamond pattern), soft and only up close.
        float rA = abs(fract(dot(q, vec2(0.82, 0.57)) * 1.3 + vnoise(q * 0.6) * 0.7) - 0.5);
        float rB = abs(fract(dot(q, vec2(0.82, -0.57)) * 1.3 + vnoise(q * 0.6 + 4.0) * 0.7) - 0.5);
        base *= 1.0 - 0.06 * (smoothstep(0.32, 0.5, rA) + smoothstep(0.32, 0.5, rB)) * wet * keep;
        // Shell grit on the dry sand.
        float grit = step(0.985, hash12(floor(q * 6.0))) * (1.0 - wet) * keep;
        base = mix(base, vec3(0.92, 0.88, 0.8), grit * 0.6);
        vec3 col = toonT(base, N, vWPos, 0.0, 0.25, 0.0, 0.06, uShadowTint);

        // The sheet of water: sand under it takes the water's tint.
        vec3 tint = uWaterShallow / max(max(uWaterShallow.r, max(uWaterShallow.g, uWaterShallow.b)), 0.05);
        col *= mix(vec3(1.0), mix(vec3(0.92), tint * 0.9, smoothstep(0.0, 0.04, w.film)), w.cover);

        // Gloss: fresh wet sand and the sheet mirror the sky and the scene (the mirror of the sea).
        vec3 V = normalize(vWPos - cameraPosition);
        vec2 rip = (vec2(vnoise(q * 2.2 + uTime * 0.6), vnoise(q * 2.0 - uTime * 0.5 + 3.0)) - 0.5) * w.cover;
        vec3 refl;
        if (uReflOn > 0.5) {
          vec4 rp = uReflMat * vec4(vWPos.x, uReflY, vWPos.z, 1.0);
          refl = texture(uRefl, clamp(rp.xy / rp.w + rip * 0.02, 0.001, 0.999)).rgb;
        } else {
          vec3 R = reflect(V, vec3(0.0, 1.0, 0.0));
          refl = skyColor(normalize(vec3(R.x, max(R.y, 0.02), R.z))) * uWorldTint;
        }
        refl *= uWaterRefl * mix(0.9, 0.7, uNight);
        refl /= max(uWorldTint, vec3(0.05));
        float cosT = max(-V.y, 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        float gloss = max(w.sheen * 0.45 * (0.6 + 0.4 * vnoise(q * 1.3)), w.cover * 0.8);
        col = mix(col, refl, clamp(fres * gloss * 0.8 + gloss * 0.04, 0.0, 1.0));
        // Sun sparkles on the moving sheet.
        vec3 H = normalize(normalize(uGlintDir) - V);
        float sp = step(0.93, vnoise(q * 9.0 + uTime * 1.5)) * pow(max(H.y, 0.0), 40.0) * w.cover * keep;
        col += uGlintCol * uGlint * sp * 1.5;

        // Foam lace.
        vec3 Nf = vec3(0.0, 1.0, 0.0);
        float ft = smoothstep(0.05, 0.35, dot(Nf, uSunDir) + 0.2 * (vnoise(q * 1.7) - 0.5));
        vec3 foamCol = mix(mix(uShadowTint, uSkyMid, 0.35) * 0.82, uSunColor * 0.93 + uSkyMid * 0.06, ft);
        foamCol += refl * (0.15 + 0.35 * uNight);
        col = mix(col, foamCol, w.foam);

        col = applyFog(col, vWPos);
        vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
        gColor = vec4(col, 1.0);
        gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, uMask);
      }`,
  });
}
