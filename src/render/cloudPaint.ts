import * as THREE from "three";
import { COMMON, G } from "./materials";

/** Lobes per cloud (texels per row of the lobe table). */
export const CLOUD_LOBES = 12;

/**
 * Painted cumulus on camera-facing cards (turning about the vertical only). Each card evaluates a
 * smooth union of uneven round lobes (x, y, radius per texel of `uLobes`, one row per cloud) cut
 * by a flat base, then shades it as ONE volume: a broad envelope normal blended with the lobes,
 * lit by the sun or moon in two or three painted tones, a darker flat base, a warm underside at a
 * low sun, a thin lit rim on the light-facing edge and a silver lining when backlit. The body is
 * opaque; only the outer edge is soft. Distant clouds fade toward the sky behind them.
 *
 * Vertex attributes: position = cloud base centre, aCorner = card corner in cloud units (half
 * width = 1), aSize = (half width, vertical scale) in metres, aInfo = (row, seed, haze).
 */
export function paintedCloudMaterial(lobes: THREE.DataTexture): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, uLobes: { value: lobes } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      in vec2 aCorner;
      in vec2 aSize;
      in vec3 aInfo;
      out vec2 vP;
      out vec3 vWPos;
      out vec3 vRight;
      out vec3 vFwd;
      flat out int vRow;
      out float vSeed;
      out float vHaze;
      void main(){
        vec3 c = (modelMatrix * vec4(position, 1.0)).xyz;
        vec3 toCam = cameraPosition - c;
        toCam.y = 0.0;
        toCam = normalize(toCam + vec3(1e-4, 0.0, 0.0));
        vec3 right = vec3(toCam.z, 0.0, -toCam.x);
        vec3 wp = c + right * aCorner.x * aSize.x + vec3(0.0, 1.0, 0.0) * aCorner.y * aSize.x * aSize.y;
        vP = aCorner;
        vWPos = wp;
        vRight = right;
        vFwd = toCam;
        vRow = int(aInfo.x + 0.5);
        vSeed = aInfo.y;
        vHaze = aInfo.z;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      layout(location = 0) out vec4 gColor;
      layout(location = 1) out vec4 gNormal;
      uniform sampler2D uLobes;
      in vec2 vP;
      in vec3 vWPos;
      in vec3 vRight;
      in vec3 vFwd;
      flat in int vRow;
      in float vSeed;
      in float vHaze;

      float smin(float a, float b, float k){
        float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
        return mix(b, a, h) - k * h * (1.0 - h);
      }
      // Signed distance to the cloud outline (negative inside), in cloud units.
      float cloudSd(vec2 p){
        float d = 10.0;
        for (int i = 0; i < ${CLOUD_LOBES}; i++) {
          vec4 L = texelFetch(uLobes, ivec2(i, vRow), 0);
          if (L.z <= 0.0) break;
          d = smin(d, length(p - L.xy) - L.z, 0.07);
        }
        // Flat base with a slight painted waver.
        float base = 0.015 * sin(p.x * 4.0 + vSeed * 6.0) - p.y;
        return max(d, base);
      }
      void main(){
        // Cauliflower edge: warp the lookup a little, coarse and fine.
        vec2 w = vec2(vnoise(vP * 2.6 + vSeed * 13.0), vnoise(vP * 2.6 + vSeed * 13.0 + 7.3)) - 0.5;
        vec2 p = vP + w * vec2(0.09, 0.06) * smoothstep(-0.02, 0.12, vP.y);
        float sd = cloudSd(p) + (vnoise(p * 10.0 + vSeed * 31.0) - 0.5) * 0.03 * smoothstep(0.02, 0.15, p.y);
        float aa = max(fwidth(sd), 0.002);
        float alpha = 1.0 - smoothstep(-aa * 1.2, aa * 0.8, sd);
        if (alpha < 0.004) discard;

        const float E = 0.035;
        vec2 grad = vec2(cloudSd(p + vec2(E, 0.0)) - cloudSd(p - vec2(E, 0.0)), cloudSd(p + vec2(0.0, E)) - cloudSd(p - vec2(0.0, E)));
        vec2 n2 = normalize(grad + 1e-5);
        float ins = clamp(-sd / 0.32, 0.0, 1.0);
        float z = sqrt(ins * (2.0 - ins));
        vec3 nLobe = normalize(vec3(n2 * (1.0 - z * 0.85), z));
        // Whole-cloud envelope: one big rounded mass, so light falls on two or three large planes.
        float top = texelFetch(uLobes, ivec2(${CLOUD_LOBES - 1}, vRow), 0).x;
        vec2 e = (p - vec2(0.0, top * 0.55)) / vec2(1.05, top * 0.7);
        vec3 nEnv = normalize(vec3(e, sqrt(max(1.0 - dot(e, e), 0.08))));
        vec3 N = normalize(mix(nEnv, nLobe, 0.42));
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 Nw = normalize(vRight * N.x + up * N.y + vFwd * N.z);
        vec3 L = uCloudLight;

        float br = vnoise(p * vec2(3.0, 5.0) + vSeed * 3.0) * 0.6 + vnoise(p * 9.0 + vSeed) * 0.4;
        float baseK = 1.0 - smoothstep(0.0, 0.2, p.y);
        // The lower body sits in its own shade: one big shadow mass under the lit cauliflower.
        float selfSh = 1.0 - smoothstep(0.1, top * 0.75, p.y);
        float t = dot(Nw, L) * 0.5 + 0.5 + (br - 0.5) * 0.22 - baseK * 0.3 - selfSh * 0.22;
        float lit = smoothstep(0.56, 0.62, t);
        float mid = smoothstep(0.34, 0.4, t);
        vec3 col = mix(uCloudLow, uCloudMid, mid);
        col = mix(col, uCloudTop, lit);
        // Flat, darker base.
        col = mix(col, uCloudLow * 0.92, baseK * 0.55);

        vec3 dir = normalize(vWPos - cameraPosition);
        vec2 Lh = normalize(L.xz + 1e-5);
        // How close the cloud sits to the sun or moon on the sky (1 = right beside it).
        float near = smoothstep(0.55, 0.98, dot(normalize(dir.xz + 1e-5), Lh)) * smoothstep(-0.25, 0.1, L.y);
        // Low sun: undersides catch warm light, strongest on clouds toward the sun.
        float lowSun = 1.0 - smoothstep(0.08, 0.5, L.y);
        float lowPart = 1.0 - smoothstep(-0.02, 0.32, p.y + Nw.y * 0.12);
        float sunSide = smoothstep(-0.3, 0.7, dot(normalize(Nw.xz + 1e-5), Lh));
        col = mix(col, uCloudUnder, clamp(uCloudK.z * lowPart * (0.25 + 0.4 * near + 0.35 * sunSide) * mix(0.5, 1.0, lowSun), 0.0, 1.0));

        // Thin lit rim on the light-facing part of the silhouette only.
        float edge = 1.0 - smoothstep(0.0, 0.035, -sd);
        vec3 n2w = normalize(vRight * n2.x + up * n2.y);
        float facing = smoothstep(0.25, 0.8, dot(n2w, L));
        col = mix(col, uCloudRim, clamp(edge * facing * uCloudK.x, 0.0, 1.0));
        // Silver lining: only clouds close to the light, and only on their light side.
        float lining = near * near * smoothstep(-0.2, 0.5, dot(n2w, L));
        col += uCloudRim * edge * lining * uCloudK.y * 0.8;

        // Aerial perspective toward the sky behind (more for distant and low clouds).
        float haze = clamp(vHaze + (1.0 - smoothstep(0.0, 0.12, dir.y)) * 0.35, 0.0, 0.85);
        col = mix(col, skyColor(dir), haze);
        gColor = vec4(col, alpha);
        gNormal = vec4(0.5, 0.5, 0.0, 0.0);
      }`,
  });
}
