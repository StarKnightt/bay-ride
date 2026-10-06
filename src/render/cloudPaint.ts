import * as THREE from "three";
import { COMMON, G } from "./materials";

/** Lobes per cloud (texels per row of the lobe table; the last texel holds the cloud's top). */
export const CLOUD_LOBES = 16;

/**
 * Painted cumulus on cards parallel to the screen (turned to the camera's horizontal right axis,
 * so a level base stays level anywhere in the frame). Each card evaluates a smooth union of
 * uneven round lobes (x, y, radius per texel of `uLobes`, one row per cloud) over a soft, broken
 * base, then shades it as ONE volume: a broad envelope normal blended with the lobes, lit by the
 * sun or moon in painted tones whose boundary follows the lobes, a shaded lower body, a warm
 * underside at a low sun, and a rim on the edge that faces the light on screen. The body is
 * opaque; the outer edge is brushed soft. Distant clouds fade toward the sky behind them.
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
        // Camera right, kept horizontal: the card is parallel to the image plane's horizontal.
        vec3 right = vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]);
        right = normalize(right + vec3(1e-5, 0.0, 0.0));
        vec3 toCam = vec3(-right.z, 0.0, right.x);
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
      // Signed distance to the lobes (negative inside), in cloud units; the base is separate.
      float lobeSd(vec2 p){
        float d = 10.0;
        for (int i = 0; i < ${CLOUD_LOBES - 1}; i++) {
          vec4 L = texelFetch(uLobes, ivec2(i, vRow), 0);
          if (L.z <= 0.0) break;
          d = smin(d, length(p - L.xy) - L.z, 0.06);
        }
        return d;
      }
      // Soft, slightly wavy base a little above the lowest lobe edges (never a ruler line).
      float baseSd(vec2 p){
        float wav = 0.018 * sin(p.x * 5.0 + vSeed * 6.0) + 0.022 * (vnoise(vec2(p.x * 6.0, vSeed * 17.0)) - 0.5);
        return wav - p.y;
      }
      void main(){
        // Cauliflower edge: warp the lookup a little, coarse and fine.
        vec2 w = vec2(vnoise(vP * 2.6 + vSeed * 13.0), vnoise(vP * 2.6 + vSeed * 13.0 + 7.3)) - 0.5;
        vec2 p = vP + w * vec2(0.08, 0.05) * smoothstep(-0.02, 0.12, vP.y);
        float top = texelFetch(uLobes, ivec2(${CLOUD_LOBES - 1}, vRow), 0).x;
        float ls = lobeSd(p);
        float bs = baseSd(p);
        float sd = max(ls, bs);
        // Brushed rim: a short soft ramp broken up by stroke noise, no cut edge.
        float brushN = vnoise(vec2(p.x * 14.0 + p.y * 3.0, p.y * 30.0) + vSeed * 29.0) - 0.5;
        float aa = max(fwidth(sd), 0.002);
        float alpha = 1.0 - smoothstep(-0.018 - aa, aa, sd + brushN * 0.016);
        // The base thins out softly over the last few metres.
        alpha *= smoothstep(-0.015, 0.05, p.y + brushN * 0.03 - 0.012 * sin(p.x * 9.0 + vSeed * 3.0));
        if (alpha < 0.004) discard;

        const float E = 0.035;
        vec2 grad = vec2(lobeSd(p + vec2(E, 0.0)) - lobeSd(p - vec2(E, 0.0)), lobeSd(p + vec2(0.0, E)) - lobeSd(p - vec2(0.0, E)));
        vec2 n2 = normalize(grad + 1e-5);
        float ins = clamp(-ls / 0.3, 0.0, 1.0);
        float z = sqrt(ins * (2.0 - ins));
        vec3 nLobe = normalize(vec3(n2 * (1.0 - z * 0.8), z));
        // Whole-cloud envelope: one big rounded mass, so light falls on a few large planes.
        vec2 e = (p - vec2(0.0, top * 0.5)) / vec2(1.05, top * 0.68);
        vec3 nEnv = normalize(vec3(e, sqrt(max(1.0 - dot(e, e), 0.08))));
        vec3 N = normalize(mix(nEnv, nLobe, 0.58));
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 Nw = normalize(vRight * N.x + up * N.y + vFwd * N.z);
        vec3 L = uCloudLight;

        float br = vnoise(p * vec2(3.0, 5.0) + vSeed * 3.0) * 0.6 + vnoise(p * 9.0 + vSeed) * 0.4;
        float ph = p.y / max(top, 0.1);
        // The lower body sits in its own shade; the boundary rides the lobes, not a straight line.
        float selfSh = 1.0 - smoothstep(0.05, 0.62, ph + nLobe.y * 0.16 + (br - 0.5) * 0.2);
        float t = dot(Nw, L) * 0.5 + 0.5 + (br - 0.5) * 0.2 - selfSh * 0.24;
        float lit = smoothstep(0.5, 0.6, t);
        float mid = smoothstep(0.3, 0.4, t);
        vec3 col = mix(uCloudLow, uCloudMid, mid);
        col = mix(col, uCloudTop, lit);
        // Darker, soft-edged base.
        float baseK = 1.0 - smoothstep(0.0, 0.16, ph + (br - 0.5) * 0.08);
        col = mix(col, uCloudLow * 0.9, baseK * 0.45);

        vec3 dir = normalize(vWPos - cameraPosition);
        vec2 Lh = normalize(L.xz + 1e-5);
        // How close the cloud sits to the sun or moon on the sky (1 = right beside it).
        float near = smoothstep(0.55, 0.98, dot(normalize(dir.xz + 1e-5), Lh)) * smoothstep(-0.25, 0.1, L.y);
        // Low sun: a broad band of the underside and low flanks takes the warm light.
        float lowSun = 1.0 - smoothstep(0.08, 0.5, L.y);
        float lowPart = 1.0 - smoothstep(0.0, 0.5, ph + nLobe.y * 0.12 + (br - 0.5) * 0.12);
        float sunSide = smoothstep(-0.3, 0.7, dot(normalize(Nw.xz + 1e-5), Lh));
        float under = uCloudK.z * lowPart * (0.45 + 0.3 * near + 0.25 * sunSide) * mix(0.45, 1.0, lowSun);
        col = mix(col, uCloudUnder, clamp(under, 0.0, 1.0));

        // Rim on the part of the outline that faces the light as seen on screen. Under the moon it is
        // a soft moonlit edge fading inward, clear only on clouds near the moon (never a bright
        // outline round every cloud).
        vec2 Lc = vec2(dot(L, vRight), L.y);
        float lcLen = length(Lc);
        vec2 Ls = Lc / max(lcLen, 1e-4);
        float moonLit = smoothstep(0.9, 0.99, dot(L, uMoonDir)) * step(0.001, dot(uMoonCol, vec3(1.0)));
        float edge = 1.0 - smoothstep(0.0, 0.055, -sd);
        edge *= mix(1.0, edge, moonLit);
        float facing = smoothstep(0.15, 0.85, dot(n2, Ls)) * smoothstep(0.02, 0.15, lcLen);
        col = mix(col, uCloudRim, clamp(edge * facing * uCloudK.x * mix(1.0, 0.3 + 0.7 * near, moonLit), 0.0, 1.0));
        // Silver lining: only clouds close to the light.
        col += uCloudRim * edge * near * near * smoothstep(-0.2, 0.5, dot(n2, Ls)) * uCloudK.y * 0.7;

        // Aerial perspective toward the sky behind (more for distant and low clouds).
        float haze = clamp(vHaze + (1.0 - smoothstep(0.0, 0.1, dir.y)) * 0.22, 0.0, 0.8);
        col = mix(col, skyColor(dir), haze);
        gColor = vec4(safe3(col), safe1(alpha));
        gNormal = vec4(0.5, 0.5, 0.0, 0.0);
      }`,
  });
}
