import * as THREE from "three";
import { COMMON, G } from "../render/materials";
import { ID } from "../world/geo";
import { DEPTH, DEPTH_GLSL } from "./depthMap";
import { WAVES_GLSL } from "./waves";
import { COAST_GLSL } from "./sea";
import { BEACH_TOP, WALL_OUT } from "../world/bay/terrain";
import { SEA_Y } from "../world/bay/road";

/**
 * The swash zone of the beach: the thin clear sheet of each wave washing up with a clumpy lace
 * front and draining back down over several seconds; sand that turns dark and mirror-glossy where
 * the run-ups have been and dries back slowly, with a faint damp band and high-water line.
 */
export function beachMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, ...DEPTH, uId: { value: ID.ground }, uMask: { value: 0 } },
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
      ${COAST_GLSL}
      // Beach profile height above mean sea level (terrain.ts coastH), smooth between the grid
      // vertices so the swash front follows a clean contour.
      float beachZs(vec2 q){
        float uw = coastWaterU(q.y);
        float u = q.x - coastRoadX(q.y);
        if (u >= uw) { float t = (u - uw) / (${WALL_OUT.toFixed(2)} - uw); return (${(BEACH_TOP - SEA_Y).toFixed(3)}) * (0.55 * t + 0.45 * t * t); }
        return -0.02 - min(uw - u, 34.0) * 0.07;
      }
      in vec3 vWPos;
      in vec3 vN;
      void main(){
        vec3 N = normalize(vN);
        vec2 q = vWPos.xz;
        float px = sqrt(length(dFdx(q)) * length(dFdy(q)));
        float zs = beachZs(q);
        WSwash w = wSwash(q, zs, uTime, px);

        // Sand: pale and warm when dry, a clear 35-40% darker (and a touch cooler) where the recent
        // run-ups reached, a lighter damp from older ones.
        float n1 = vnoise(q * 0.45), n2 = vnoise(q * 2.7 + 3.0);
        float keep = 1.0 - smoothstep(0.02, 0.08, px);
        vec3 dry = vec3(0.8, 0.69, 0.44) * (0.94 + 0.08 * n1 + 0.05 * (n2 - 0.5) * keep);
        float patchy = 0.8 + 0.4 * vnoise(q * 0.7 + 9.0);
        float wet = clamp(max(w.wet, 0.6 * w.mem * patchy), 0.0, 1.0);
        // Linear factor ~0.23 in luma: after tone mapping it reads ~35% darker on screen; cool, not brown.
        vec3 base = dry * mix(vec3(1.0), vec3(0.245, 0.27, 0.315), wet);
        // The high-water line of recent run-ups: a thin darker damp edge.
        base *= 1.0 - 0.2 * w.line * (1.0 - w.cover);
        // Backwash ripple marks on the wet sand (diamond pattern), soft and only up close.
        float rA = abs(fract(dot(q, vec2(0.82, 0.57)) * 1.3 + vnoise(q * 0.6) * 0.7) - 0.5);
        float rB = abs(fract(dot(q, vec2(0.82, -0.57)) * 1.3 + vnoise(q * 0.6 + 4.0) * 0.7) - 0.5);
        base *= 1.0 - 0.06 * (smoothstep(0.32, 0.5, rA) + smoothstep(0.32, 0.5, rB)) * wet * keep;
        vec3 col = toonT(base, N, vWPos, 0.0, 0.25, 0.0, 0.06, uShadowTint);

        // The swash sheet: a clear film in two flat painted bands (barely tinted where thin,
        // yellow-green where it deepens), kept cool against warm sand at low sun.
        float warmK = smoothstep(0.08, 0.35, uSunColor.r - uSunColor.b);
        float thin = smoothstep(0.0, 0.012, w.film);
        float band = smoothstep(0.01, 0.02, w.film);
        vec3 filmTint = mix(mix(vec3(0.95, 1.0, 0.86), vec3(0.86, 1.0, 0.6), band), vec3(0.8, 0.96, 0.92), warmK);
        // Water over sand is darker and glassier than the wet sand around it, never lighter.
        col *= mix(vec3(1.0), filmTint * 0.8, w.cover * thin);
        col = mix(col, wCool(col), 0.5 * warmK * w.cover);

        // Sheen: a few broad, soft painted strokes along the shore that ride with the water, well
        // below foam white, fading out toward the camera. Drained sand keeps a fainter version.
        vec3 V = normalize(vWPos - cameraPosition);
        float dist = length(vWPos - cameraPosition);
        float along = wAlong(q);
        vec3 R = reflect(V, vec3(0.0, 1.0, 0.0));
        vec3 sky = skyColor(normalize(vec3(R.x, max(R.y, 0.03), R.z))) * uWorldTint;
        sky = mix(sky, wCool(sky), 0.8) * uWaterRefl * mix(0.85, 0.7, uNight) / max(uWorldTint, vec3(0.05));
        float cosT = max(-V.y, 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        float sn = vnoise(vec2(along * 0.14, w.adv * 0.55 + 1.5 * vnoise(vec2(along * 0.09, 3.0)))) * 0.7 + vnoise(vec2(along * 0.4 + 3.0, w.adv * 1.3)) * 0.3;
        // Only on moving sheets: below the waterline the pattern coordinate is a fixed contour.
        float stroke = smoothstep(0.58, 0.72, sn) * smoothstep(2.5, 10.0, dist) * smoothstep(-0.04, 0.02, zs + 0.03 * (vnoise(q * 0.2) - 0.5));
        float gl = w.cover * thin * (0.02 + 0.05 * fres) + stroke * w.cover * mix(0.04, 0.12, thin)
                 + (1.0 - w.cover) * w.sheen * (0.06 + 0.1 * fres + 0.08 * stroke);
        col = mix(col, min(sky, vec3(0.7)), clamp(gl, 0.0, 0.25));
        // At night the sheet keeps a faint cool glint so the water's edge still reads.
        col += vec3(0.012, 0.018, 0.03) * uNight * (w.cover + stroke * w.cover);

        // Foam lace on top.
        col = mix(col, wFoamColor(vec3(0.0, 1.0, 0.0), q, col, 0.0), w.foam * 0.92);

        col = applyFog(col, vWPos);
        vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
        gColor = vec4(col, 1.0);
        gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, uMask);
      }`,
  });
}
