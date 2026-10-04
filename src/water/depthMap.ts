import * as THREE from "three";
import { terrainH } from "../world/bay/terrain";

/**
 * Seabed height baked once into a small texture over the bay, so water shaders know the depth
 * under every point (shallow tint, shoreline foam, wave shoaling) without re-evaluating the
 * landform. Outside the baked area the sea counts as deep.
 */
export const DEPTH_BOUNDS = { x0: -520, z0: -480, size: 960 };
const RES = 512;

export const DEPTH = {
  uDepthTex: { value: null as THREE.Texture | null },
  /** xy = world min corner (x, z), z = 1 / size. */
  uDepthXf: { value: new THREE.Vector3(DEPTH_BOUNDS.x0, DEPTH_BOUNDS.z0, 1 / DEPTH_BOUNDS.size) },
};

export const DEPTH_GLSL = /* glsl */ `
uniform sampler2D uDepthTex;
uniform vec3 uDepthXf;
/** Seabed height (world y) under xz; deep outside the baked area. */
float seabedY(vec2 xz){
  vec2 uv = (xz - uDepthXf.xy) * uDepthXf.z;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return -40.0;
  return texture(uDepthTex, uv).r;
}
`;

export function bakeDepth(): THREE.DataTexture {
  const { x0, z0, size } = DEPTH_BOUNDS;
  const data = new Uint16Array(RES * RES);
  for (let j = 0; j < RES; j++) {
    const z = z0 + ((j + 0.5) / RES) * size;
    for (let i = 0; i < RES; i++) {
      const x = x0 + ((i + 0.5) / RES) * size;
      data[j * RES + i] = THREE.DataUtils.toHalfFloat(Math.max(-40, Math.min(60, terrainH(x, z))));
    }
  }
  const tex = new THREE.DataTexture(data, RES, RES, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  DEPTH.uDepthTex.value = tex;
  return tex;
}
