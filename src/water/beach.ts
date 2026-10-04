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

        // Sand: pale and warm when dry, ~40% darker when freshly wet, a lighter damp in between.
        float n1 = vnoise(q * 0.45), n2 = vnoise(q * 2.7 + 3.0);
        float keep = 1.0 - smoothstep(0.02, 0.08, px);
        vec3 dry = vec3(0.8, 0.69, 0.44) * (0.94 + 0.08 * n1 + 0.05 * (n2 - 0.5) * keep);
        float patchy = 0.8 + 0.4 * vnoise(q * 0.7 + 9.0);
        // The lower beach stays faintly damp from earlier tides; recent run-ups leave a lighter damp.
        float damp = max(0.3 * w.mem * patchy, 0.22 * smoothstep(0.9, 0.15, zs));
        float wet = clamp(max(w.wet, damp), 0.0, 1.0);
        // Freshly wet sand is ~40% darker and a little cooler than dry sand.
        vec3 base = dry * mix(vec3(1.0), vec3(0.56, 0.58, 0.62), wet);
        // The high-water line of recent run-ups: a thin darker damp edge.
        base *= 1.0 - 0.4 * w.line * (1.0 - w.cover);
        // Backwash ripple marks on the wet sand (diamond pattern), soft and only up close.
        float rA = abs(fract(dot(q, vec2(0.82, 0.57)) * 1.3 + vnoise(q * 0.6) * 0.7) - 0.5);
        float rB = abs(fract(dot(q, vec2(0.82, -0.57)) * 1.3 + vnoise(q * 0.6 + 4.0) * 0.7) - 0.5);
        base *= 1.0 - 0.06 * (smoothstep(0.32, 0.5, rA) + smoothstep(0.32, 0.5, rB)) * wet * keep;
        vec3 col = toonT(base, N, vWPos, 0.0, 0.25, 0.0, 0.06, uShadowTint);

        // The swash sheet is a thin, clear film: the wet sand shows through, turning yellow-green
        // only as the water deepens (the same depth tint as the clear shallows beyond).
        vec3 cW = wCool(uWaterShallow);
        vec3 tint = cW / max(max(cW.r, max(cW.g, cW.b)), 0.05);
        vec3 green = tint * vec3(0.95, 1.0, 0.72);
        col *= mix(vec3(1.0), green, smoothstep(0.0, 1.0, w.film) * w.cover);

        // Gloss: the sheet and freshly drained sand mirror the sky and the scene.
        vec3 V = normalize(vWPos - cameraPosition);
        vec2 rip = (vec2(vnoise(q * 2.2 + uTime * 0.6), vnoise(q * 2.0 - uTime * 0.5 + 3.0)) - 0.5) * w.cover;
        // The breaking crests stand between the beach and distant land: the sheet mirrors the sky.
        vec3 R = reflect(V, normalize(vec3(rip.x * 0.3, 1.0, rip.y * 0.3)));
        vec3 refl = skyColor(normalize(vec3(R.x, max(R.y, 0.02), R.z))) * uWorldTint;
        refl *= uWaterRefl * mix(0.9, 0.7, uNight);
        refl /= max(uWorldTint, vec3(0.05));
        // Water stays cool against warm sand at low sun, so the sheet's edge keeps reading.
        refl = mix(refl, wCool(refl), 0.8 * w.cover);
        float cosT = max(-V.y, 0.0);
        float fres = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        // Drained sand: a glassy mirror of the sky in soft patches (it stays dark where it doesn't
        // catch the sky); the moving sheet a little less, broken by its ripples.
        float sheen = w.sheen * smoothstep(0.25, 0.75, vnoise(q * vec2(0.5, 1.4) + 2.0) * 0.6 + 0.5 * w.sheen);
        float gl = max(sheen * (1.0 - 0.5 * w.cover) * (0.12 + 0.75 * fres), w.cover * (0.03 + 0.55 * fres));
        col = mix(col, refl * mix(vec3(1.0), vec3(0.92, 0.96, 1.0), sheen), clamp(gl, 0.0, 0.62));
        // Sun sparkles on the moving sheet.
        vec3 H = normalize(normalize(uGlintDir) - V);
        float sp = step(0.93, vnoise(q * 9.0 + uTime * 1.5)) * pow(max(H.y, 0.0), 40.0) * w.cover * keep;
        col += uGlintCol * uGlint * sp * 1.5;

        // Foam lace.
        col = mix(col, wFoamColor(vec3(0.0, 1.0, 0.0), q, col, 0.0), w.foam);

        col = applyFog(col, vWPos);
        vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
        gColor = vec4(col, 1.0);
        gNormal = vec4(vn.xy * 0.5 + 0.5, uId / 32.0, uMask);
      }`,
  });
}
