import * as THREE from "three";
import { COMMON, G, OUT } from "../render/materials";

/**
 * The sky dome: gradient, cirrus, stars, sun disc and painted moon. Cirrus lie on a plane over the
 * bay, so one anisotropic noise there projects into straight bands converging on the horizon
 * vanishing point wherever it runs along the view (it read as a diagonal light beam). Here the
 * wisps are warped so they bend, broken into short segments that taper at both ends, less
 * stretched, and faded where they run along the line of sight.
 */
export function skyDomeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, uId: { value: 0 }, uMask: { value: 0 } },
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      out vec3 vWPos;
      void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vWPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${OUT}
      in vec3 vWPos;
      // Screen-round disc coordinates around a sky direction, in units of its angular radius:
      // measured on the view plane so a disc stays a circle anywhere in a wide frame.
      vec2 discQ(vec3 dir, vec3 c, float ang, out float ok){
        vec3 a = mat3(viewMatrix) * dir;
        vec3 b = mat3(viewMatrix) * c;
        ok = step(0.0, -b.z) * step(0.0, -a.z);
        vec2 pa = a.xy / max(-a.z, 1e-5);
        vec2 pb = b.xy / max(-b.z, 1e-5);
        return (pa - pb) * -b.z / ang;
      }
      const vec2 WISP_AX = vec2(0.9004, 0.4350);
      float cirrus(vec3 dir){
        float h = max(dir.y, 0.02);
        vec2 p = dir.xz / h * 0.6;
        // A bounded warp bends the wisps without multiplying their frequency far out.
        vec2 pw = p + (vec2(vnoise(p * 0.16 + 3.7), vnoise(p * 0.16 + 9.1)) - 0.5) * 2.6;
        vec2 q = vec2(dot(pw, WISP_AX), dot(pw, vec2(-WISP_AX.y, WISP_AX.x))) + vec2(uTime * 0.004, 0.0);
        float w = fbm2(q * vec2(0.75, 1.5));
        float seg = smoothstep(0.45, 0.78, vnoise(q * vec2(0.7, 1.2) + 5.1));
        float wisp = smoothstep(0.56, 0.8, w) * seg;
        float along = abs(dot(normalize(dir.xz + vec2(1e-5)), WISP_AX));
        wisp *= 1.0 - 0.85 * smoothstep(0.55, 0.9, along);
        return wisp * smoothstep(0.12, 0.3, dir.y) * (1.0 - smoothstep(0.55, 0.95, dir.y));
      }
      void main(){
        vec3 dir = normalize(vWPos - cameraPosition);
        vec3 col = skyColor(dir);
        float skyLum = dot(col, vec3(0.2126, 0.7152, 0.0722));
        // Thin cirrus wisps high up; dim at night, a little brighter near the moon.
        float wisp = uWispAmt > 0.0 ? cirrus(dir) : 0.0;
        float md = dot(dir, uMoonDir);
        vec3 wc = uWisp + uMoonCol * pow(max(md, 0.0), 6.0) * 0.25 * uNight;
        col = mix(col, wc, wisp * uWispAmt);
        if (uStars > 0.0 && dir.y > 0.02) {
          vec2 sp = dir.xz / (1.0 + dir.y) * 70.0;
          vec2 ci = floor(sp);
          float hs = hash12(ci);
          vec2 off = vec2(hash12(ci + 3.1), hash12(ci + 7.7)) * 0.6 + 0.2;
          float d = length(fract(sp) - off);
          float tw = 0.65 + 0.35 * sin(uTime * (0.8 + hs * 2.5) + hs * 40.0);
          float star = step(0.94, hs) * (1.0 - smoothstep(0.03, 0.11 + 0.08 * fract(hs * 17.0), d)) * tw;
          float minY = mix(0.6, 0.06, uStars);
          float dark = 1.0 - smoothstep(0.05, 0.16, skyLum);
          col += vec3(0.95, 0.95, 1.0) * star * smoothstep(minY, minY + 0.15, dir.y) * dark * (1.0 - wisp * 0.8);
        }
        float ok;
        if (dot(uSunDisk, vec3(1.0)) > 0.0 && dot(dir, uSkySun) > 0.6) {
          // The disc, its halo and its rays stay out of the water's mirror (the glitter path draws
          // the sun on the water instead).
          vec2 q = discQ(dir, uSkySun, 0.011, ok);
          float r = length(q);
          float fw = max(fwidth(r), 0.02);
          float disk = (1.0 - smoothstep(1.0 - fw, 1.0 + fw, r)) * ok * (1.0 - uNoFringe);
          float ang = atan(q.y, q.x);
          float rays = pow(abs(sin(ang * 4.0 + 0.4)), 40.0) + pow(abs(sin(ang * 7.0 + 1.3)), 60.0) * 0.6;
          rays *= exp(-max(r - 1.0, 0.0) * 0.16) * smoothstep(1.0, 2.0, r) * ok * (1.0 - uNoFringe);
          float halo = exp(-max(r - 1.0, 0.0) * 0.55) * 0.35 + exp(-max(r - 1.0, 0.0) * 0.09) * 0.12;
          halo *= mix(1.0, 0.3, smoothstep(0.35, 0.85, skyLum)) * (1.0 - uNoFringe);
          vec3 hot = uSunDisk;
          col = mix(col, hot, disk);
          col += normalize(hot + 1e-4) * (halo * ok * (1.0 - disk) + rays * 0.22) * min(length(hot), 1.4);
          col += uSunGlow * exp(-max(r - 1.0, 0.0) * 0.06) * uSunGlowAmt.y * 0.35 * ok * (1.0 - disk);
        }
        if (dot(uMoonCol, vec3(1.0)) > 0.0 && md > 0.6) {
          vec2 q = discQ(dir, uMoonDir, 0.026, ok);
          float r = length(q);
          float fw = max(fwidth(r), 0.02);
          float disk = (1.0 - smoothstep(1.0 - fw, 1.0 + fw, r)) * ok;
          vec2 mq = q * 1.6;
          float maria = smoothstep(0.38, 0.78, vnoise(mq * 1.2 + 3.0) * 0.65 + vnoise(mq * 2.6 + 9.0) * 0.35);
          vec3 mc = uMoonCol * mix(vec3(1.0), vec3(0.8, 0.77, 0.72), maria * 0.8);
          col = mix(col, mc, disk * (1.0 - wisp * 0.4 * uWispAmt));
          float halo = exp(-max(r - 1.0, 0.0) * 2.2) * 0.32 + exp(-max(r - 1.0, 0.0) * 0.18) * 0.06;
          col += uMoonCol * halo * (1.0 - disk) * ok;
        }
        gColor = vec4(safe3(col), 1.0);
        gNormal = vec4(0.5, 0.5, 0.0, 0.0);
      }`,
  });
}
