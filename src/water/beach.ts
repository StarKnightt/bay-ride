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
        // Fine sand detail fades by the long axis of the footprint: at a grazing angle the mean
        // underestimates it many times over and the detail aliases into streaks along the view.
        gFoot = max(length(dFdx(vWPos)), length(dFdy(vWPos)));
        float zs = beachZs(q);
        WSwash w = wSwash(q, zs, uTime, px);

        // Sand: pale and warm when dry; wet it is a deeper, richer version of the same sand (35-40%
        // darker on screen, nudged cool), one gradient from fresh-wet at the water to drying above.
        float n1 = vnoise(q * 0.45), n2 = vnoise(q * 2.7 + 3.0);
        float keep = 1.0 - smoothstep(0.04, 0.14, gFoot);
        vec3 dry = vec3(0.8, 0.69, 0.44) * (0.94 + 0.08 * n1 + 0.05 * (n2 - 0.5) * keep);
        float patchy = 0.8 + 0.4 * vnoise(q * 0.7 + 9.0);
        float wet = clamp(max(w.wet, 0.8 * w.mem * patchy), 0.0, 1.0);
        // Under a running sheet the water fills the surface instead of the pores, so the sand reads
        // lighter than freshly drained sand; the last draining film stays at the wet value.
        wet *= 1.0 - 0.32 * w.cover * smoothstep(0.004, 0.02, w.film) * smoothstep(-0.3, 0.03, zs);
        // Linear factor ~0.27: after tone mapping it reads ~35% darker on screen. Scaling the sand colour
        // keeps its hue; large soft patches keep it from reading as one flat slab.
        vec3 base = dry * mix(vec3(1.0), vec3(0.24, 0.21, 0.175) * (0.88 + 0.24 * vnoise(q * 0.06 + 2.0)), wet);
        // The high-water line of recent run-ups: a thin darker damp edge.
        base *= 1.0 - 0.2 * w.line * (1.0 - w.cover);
        // Backwash ripple marks on the wet sand (diamond pattern), soft and only up close.
        float rA = abs(fract(dot(q, vec2(0.82, 0.57)) * 1.3 + vnoise(q * 0.6) * 0.7) - 0.5);
        float rB = abs(fract(dot(q, vec2(0.82, -0.57)) * 1.3 + vnoise(q * 0.6 + 4.0) * 0.7) - 0.5);
        base *= 1.0 - 0.06 * (smoothstep(0.32, 0.5, rA) + smoothstep(0.32, 0.5, rB)) * wet * keep;
        // Below the wandering mean waterline the sand is seen through still water exactly as the sea
        // paints its last metres (waves.ts wBedAlb, wBedSeen): the two meet in one colour wherever
        // the sea's edge tucks under the sand, and ankle-deep water shows its ripples, pebbles and
        // caustics instead of a flat sheet.
        float kU = w.under;
        float dB = max(-zs, 0.0) + max(w.film - 0.012, 0.0);
        float nq9 = vnoise(q * 0.09);
        vec3 albU = vec3(0.0);
        if (kU > 0.001) {
          albU = wBedAlb(q, dB, px);
          base = mix(base, albU, kU);
        }
        vec3 col = toonT(base, N, vWPos, 0.0, 0.25, 0.0, 0.06, uShadowTint);
        if (kU > 0.001) col = mix(col, wBedSeen(col, albU, q, q, dB, px, 0.0, wShallowCol(), nq9), kU);
        // The moving swash above it: everything below applies there only.
        float sheet = 1.0 - kU;

        // The swash sheet: a clear film in two flat painted bands (barely tinted where thin,
        // yellow-green where it deepens, the edge wobbling), kept cool against warm sand at low sun.
        float warmK = smoothstep(0.08, 0.35, uSunColor.r - uSunColor.b);
        float thin = smoothstep(0.0, 0.012, w.film);
        float hwB = dB + 0.12 * (nq9 - 0.5);
        float band = max(smoothstep(0.01, 0.02, w.film + 0.006 * (vnoise(q * vec2(1.3, 0.9) + vec2(uTime * 0.25, 0.0)) - 0.5)), smoothstep(0.12, 0.32, hwB + 0.2 * (vnoise(q * 0.04 + 3.0) - 0.5)) * step(0.0, -zs));
        vec3 filmTint = mix(mix(vec3(0.95, 1.0, 0.86), vec3(0.86, 1.0, 0.6), band), vec3(0.8, 0.96, 0.92), warmK);
        // A clear film: the wet sand shows through, a touch brighter where it deepens (sky gloss below
        // adds the rest); only the last thin draining film darkens it, glassy rather than muddy.
        col *= mix(vec3(1.0), filmTint * 1.22, w.cover * thin * sheet);
        col *= mix(1.0, mix(0.88, 1.0, smoothstep(0.003, 0.012, w.film)), w.cover);
        col = mix(col, wCool(col), 0.35 * warmK * w.cover * sheet);
        // Faint warm caustic lines run with the sheet over the sand it covers.
        float sunUp = clamp(uSunDir.y * 3.0, 0.0, 1.0) * (1.0 - uNight);
        float caS = w.cover * thin * sheet * sunUp * (1.0 - smoothstep(0.08, 0.3, px));
        if (caS > 0.01) col += mix(base, vec3(1.0, 0.95, 0.75), 0.5) * uSunColor * smoothstep(0.12, 0.26, wCaustic(q * 1.4 + vec2(0.0, w.adv * 0.05), uTime * 1.5)) * caS * 0.22;

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
        // A light gloss on the running film (more would turn it a milky grey sheet), and under the
        // still water only as little as the sea's own shallows mirror.
        float gl = w.cover * thin * (0.045 + 0.11 * fres) * (1.0 - 0.5 * step(0.0, -zs) * (1.0 - smoothstep(0.012, 0.02, w.film))) + stroke * w.cover * mix(0.04, 0.1, thin)
                 + (1.0 - w.cover) * w.sheen * (0.08 + 0.12 * fres + 0.06 * stroke);
        gl *= mix(1.0, 0.3, kU);
        col = mix(col, min(sky, vec3(0.7)), clamp(gl, 0.0, 0.3));
        // At night the sheet keeps a faint cool glint so the water's edge still reads.
        col += vec3(0.012, 0.018, 0.03) * uNight * (w.cover + stroke * w.cover) * sheet;

        // Foam lace on top.
        col = mix(col, wFoamColor(vec3(0.0, 1.0, 0.0), q, col, 0.0), w.foam * 0.92);

        col = applyFog(col, vWPos);
        vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
        gColor = vec4(safe3(col), 1.0);
        gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, uMask);
      }`,
  });
}
