import * as THREE from "three";
import { COMMON, G } from "./materials";

/** Lobes per cloud (texels per row of the lobe table; the last texel holds the cloud's top). */
export const CLOUD_LOBES = 32;

/**
 * Painted cumulus on cards parallel to the screen (turned to the camera's horizontal right axis,
 * so a level base stays level anywhere in the frame). Each card evaluates a smooth union of
 * uneven round lobes (x, y, radius, depth per texel of `uLobes`, one row per cloud) over a soft,
 * broken base. Each pixel takes the front-most lobe sphere, so every lobe shades as its own round
 * volume with a crisp crease where it overlaps the one behind; that normal is blended with one
 * broad envelope so light also falls on a few large planes. Painted tones: bright sunlit tops,
 * blue-grey shadow lobes and creases, a warm underside at a low sun, and a rim on the edge that
 * faces the light on screen. The body is opaque with a defined edge about a pixel and a half wide.
 * Distant clouds fade toward the sky behind them.
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
      // One pass over the lobes: the smooth-union distance (negative inside, cloud units), and the
      // front surface of the lobe spheres (each at its own depth, .w) as a soft maximum, so the
      // pixel takes the sphere normal of the lobe in front, blended over a narrow crease where two
      // lobes meet. The crease is where no single lobe dominates.
      struct Hit { float sd; vec3 n; float crease; float lobeY; vec2 n2; };
      Hit lobes(vec2 p){
        Hit h; h.sd = 10.0; h.n2 = vec2(0.0, 1.0);
        const float K = 0.022;
        float m = -1e3, S = 0.0, Y = 0.0, nearD = 1e3;
        vec3 A = vec3(0.0);
        for (int i = 0; i < ${CLOUD_LOBES - 1}; i++) {
          vec4 L = texelFetch(uLobes, ivec2(i, vRow), 0);
          if (L.z <= 0.0) break;
          vec2 q = p - L.xy;
          float r2 = dot(q, q);
          float d = sqrt(r2) - L.z;
          h.sd = smin(h.sd, d, 0.035);
          if (d < nearD) { nearD = d; h.n2 = q / max(sqrt(r2), 1e-4); }
          if (d < 0.0) {
            float zl = sqrt(L.z * L.z - r2);
            float s = zl + L.w;
            vec3 nI = vec3(q, zl) / L.z;
            if (s > m) {
              float f = exp((m - s) / K);
              S = S * f + 1.0; A = A * f + nI; Y = Y * f + L.y; m = s;
            } else {
              float e = exp((s - m) / K);
              S += e; A += nI * e; Y += L.y * e;
            }
          }
        }
        h.n = S > 0.0 ? normalize(A + vec3(0.0, 0.0, 1e-4)) : vec3(0.0, 0.0, 1.0);
        h.lobeY = S > 0.0 ? Y / S : 0.0;
        h.crease = S > 0.0 ? smoothstep(0.5, 0.85, 1.0 / S) : 1.0;
        return h;
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
        Hit hit = lobes(p);
        float ls = hit.sd;
        float bs = baseSd(p);
        float sd = max(ls, bs);
        // Defined edge: about a pixel and a half of ramp, nudged by a fine brush wobble.
        float brushN = vnoise(vec2(p.x * 14.0 + p.y * 3.0, p.y * 30.0) + vSeed * 29.0) - 0.5;
        float aa = max(fwidth(sd), 0.0015);
        float alpha = 1.0 - smoothstep(-aa * 1.5, aa * 1.5, sd + brushN * 0.007);
        // The flat base thins out softly over the last few metres.
        alpha *= smoothstep(-0.015, 0.04, p.y + brushN * 0.025 - 0.012 * sin(p.x * 9.0 + vSeed * 3.0));
        // Never a straight cut at the card's edge: fade out just inside it.
        alpha *= smoothstep(1.45, 1.3, abs(vP.x)) * smoothstep(top + 0.4, top + 0.28, vP.y);
        if (alpha < 0.004) discard;

        vec2 n2 = hit.n2;
        // Outside every sphere (the blended necks and the brushed rim) the outline normal stands in.
        vec3 nLobe = hit.n.z > 0.0 && ls < 0.0 ? hit.n : normalize(vec3(n2, 0.35));
        // Whole-cloud envelope: one big rounded mass, so light also falls on a few large planes.
        vec2 e = (p - vec2(0.0, top * 0.5)) / vec2(1.05, top * 0.68);
        vec3 nEnv = normalize(vec3(e, sqrt(max(1.0 - dot(e, e), 0.08))));
        vec3 N = normalize(mix(nEnv, nLobe, 0.72));
        vec3 up = vec3(0.0, 1.0, 0.0);
        vec3 Nw = normalize(vRight * N.x + up * N.y + vFwd * N.z);
        vec3 L = uCloudLight;

        float br = vnoise(p * vec2(3.0, 5.0) + vSeed * 3.0) * 0.6 + vnoise(p * 9.0 + vSeed) * 0.4;
        float ph = p.y / max(top, 0.1);
        float lobePh = hit.lobeY / max(top, 0.1);
        // The lower lobes sit in the body's own shade, lobe by lobe (each keeps its round shape).
        float selfSh = 1.0 - smoothstep(0.1, 0.7, mix(ph, lobePh, 0.6) + nLobe.y * 0.2 + (br - 0.5) * 0.14);
        // Each lobe's own underside turns away from the sky.
        float underLobe = 1.0 - smoothstep(-0.65, 0.05, nLobe.y);
        // Sky light from above: tops stay bright even when the sun sits behind the viewer.
        float sky = smoothstep(0.1, 0.8, Nw.y);
        float t = dot(Nw, L) * 0.5 + 0.5 + (br - 0.5) * 0.14 - selfSh * 0.36 - underLobe * 0.16 + sky * 0.12;
        float lit = smoothstep(0.52, 0.6, t);
        float mid = smoothstep(0.3, 0.4, t);
        vec3 col = mix(uCloudLow, uCloudMid, mid);
        col = mix(col, uCloudTop, lit);
        // Creases between lobes and the flat underside take the blue-grey shade.
        float crease = (1.0 - hit.crease) * (1.0 - lit * 0.5);
        col = mix(col, uCloudLow * 0.92, crease * 0.3);
        float baseK = 1.0 - smoothstep(0.0, 0.12, ph + (br - 0.5) * 0.06);
        col = mix(col, uCloudLow * 0.9, baseK * 0.4);

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
