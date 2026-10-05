import * as THREE from "three";
import { terrainH } from "../world/bay/terrain";
import { SEA_Y } from "../world/bay/road";
import { rockAt } from "./rocks";
import { WAVE, setFieldSampler } from "./waves";

/**
 * The shore field, baked once into a small texture over the bay so the water shaders know, for
 * every point: the seabed height (rocks included), the wave travel-time offsets of both swell
 * trains, and rock cover (for foam around rocks). Outside the baked area the sea counts as deep
 * and waves travel as straight crests.
 *
 * Travel times solve the eikonal equation |grad T| = 1 / c(depth) with c = sqrt(g h) (capped at
 * the deep-water speed), so crests slow and bend round toward the shallows and wrap around the
 * island. Stored as the offset from a straight deep-water crest, which keeps half floats precise.
 */
export const DEPTH_BOUNDS = { x0: -520, z0: -480, size: 960 };
const RES = 512;
/** Travel-time solve grid (bilinear-upsampled into the texture). */
const TN = 256;

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
  return textureLod(uDepthTex, uv, 0.0).r;
}
`;

/** Seabed height with rocks. */
function bedY(x: number, z: number): number {
  return Math.max(-40, Math.min(60, Math.max(terrainH(x, z), rockAt(x, z).y)));
}

/** Min-heap of cell indices keyed by travel time. */
class Heap {
  private idx: Int32Array;
  private key: Float64Array;
  n = 0;
  constructor(cap: number) {
    this.idx = new Int32Array(cap);
    this.key = new Float64Array(cap);
  }
  push(i: number, k: number): void {
    let p = this.n++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (this.key[q] <= k) break;
      this.idx[p] = this.idx[q];
      this.key[p] = this.key[q];
      p = q;
    }
    this.idx[p] = i;
    this.key[p] = k;
  }
  pop(): number {
    const top = this.idx[0];
    const li = this.idx[--this.n], lk = this.key[this.n];
    let p = 0;
    for (;;) {
      let c = 2 * p + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.key[c + 1] < this.key[c]) c++;
      if (this.key[c] >= lk) break;
      this.idx[p] = this.idx[c];
      this.key[p] = this.key[c];
      p = c;
    }
    this.idx[p] = li;
    this.key[p] = lk;
    return top;
  }
  get topKey(): number {
    return this.key[0];
  }
}

const NB: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
];

/**
 * Wrapped travel field offshore, blending to the plain field inside ~20 m of depth: the crest shapes
 * refract round the island and across the bay while the beach keeps its arrival times exactly.
 */
function shoreMatched(depth: Float32Array, dir: readonly [number, number], period: number): Float32Array {
  const plain = solveTravel(depth, dir), wrapped = solveTravel(depth, dir, period);
  for (let k = 0; k < wrapped.length; k++) {
    const w = Math.min(Math.max((depth[k] - 3) / 17, 0), 1);
    wrapped[k] = plain[k] + (wrapped[k] - plain[k]) * w * w * (3 - 2 * w);
  }
  return wrapped;
}

/**
 * Travel-time offset field (TN x TN) for one train: T - dot(p, dir) / cDeep. With wrapPeriod, only the
 * domain edge is seeded and water slows with depth relative to the wavelength (dispersion), so crests
 * bend over the bay's slopes and wrap into the island's lee instead of staying ruled lines.
 */
function solveTravel(depth: Float32Array, dir: readonly [number, number], wrapPeriod = 0): Float32Array {
  const wrap = wrapPeriod > 0;
  const kw = (2 * Math.PI) / (WAVE.cDeep * wrapPeriod);
  const { x0, z0, size } = DEPTH_BOUNDS;
  const cell = size / TN;
  const g = 9.81;
  const slow = new Float32Array(TN * TN);
  for (let i = 0; i < TN * TN; i++) {
    const h = depth[i];
    // Broken bores ride on their own height (c ~ sqrt(g (h + H))), so the inner surf never crawls:
    // the swash arrives a few seconds after its wave breaks, not ten.
    // Intermediate-depth dispersion, c ~ c0 tanh(k0 h): crests already slow (and turn) over 10-30 m.
    const cMax = wrap ? WAVE.cDeep * Math.tanh(kw * h) : WAVE.cDeep;
    slow[i] = h < 0.12 ? 0 : 1 / Math.min(Math.max(Math.sqrt(g * h), 3.6), cMax);
  }
  const T = new Float64Array(TN * TN).fill(Infinity);
  const done = new Uint8Array(TN * TN);
  const heap = new Heap(TN * TN * 8);
  for (let j = 0; j < TN; j++)
    for (let i = 0; i < TN; i++) {
      const k = j * TN + i;
      if (depth[k] < 16) continue;
      if (wrap && i > 0 && j > 0 && i < TN - 1 && j < TN - 1) continue;
      const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
      T[k] = (x * dir[0] + z * dir[1]) / WAVE.cDeep;
      heap.push(k, T[k]);
    }
  while (heap.n > 0) {
    const tk = heap.topKey;
    const k = heap.pop();
    if (done[k] || tk > T[k]) continue;
    done[k] = 1;
    const i = k % TN, j = (k / TN) | 0;
    for (const [di, dj] of NB) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= TN || nj >= TN) continue;
      const nk = nj * TN + ni;
      if (done[nk] || slow[nk] === 0) continue;
      const t = T[k] + Math.hypot(di, dj) * cell * 0.5 * (slow[k] + slow[nk]);
      if (t < T[nk]) {
        T[nk] = t;
        heap.push(nk, t);
      }
    }
  }
  // Offsets from the straight crest; land (and unreachable pockets) takes the nearest water value,
  // so on the beach T is the arrival time at the waterline below.
  const out = new Float32Array(TN * TN).fill(NaN);
  const queue: number[] = [];
  for (let j = 0; j < TN; j++)
    for (let i = 0; i < TN; i++) {
      const k = j * TN + i;
      if (!Number.isFinite(T[k])) continue;
      const x = x0 + (i + 0.5) * cell, z = z0 + (j + 0.5) * cell;
      out[k] = T[k] - (x * dir[0] + z * dir[1]) / WAVE.cDeep;
      queue.push(k);
    }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q];
    const i = k % TN, j = (k / TN) | 0;
    for (let d = 0; d < 4; d++) {
      const [di, dj] = NB[d];
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= TN || nj >= TN) continue;
      const nk = nj * TN + ni;
      if (!Number.isNaN(out[nk])) continue;
      out[nk] = out[k];
      queue.push(nk);
    }
  }
  for (let k = 0; k < out.length; k++) if (Number.isNaN(out[k])) out[k] = 0;
  // Two light box blurs: smooths the stencil's faint polygonal kinks out of the crest lines.
  const tmp = new Float32Array(out.length);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < TN; j++)
      for (let i = 0; i < TN; i++) {
        let s = 0, w = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ni = i + di, nj = j + dj;
            if (ni < 0 || nj < 0 || ni >= TN || nj >= TN) continue;
            s += out[nj * TN + ni];
            w++;
          }
        tmp[j * TN + i] = s / w;
      }
    out.set(tmp);
  }
  return out;
}

function bilerp(grid: Float32Array, u: number, v: number): number {
  const x = Math.min(TN - 1.001, Math.max(0, u * TN - 0.5));
  const y = Math.min(TN - 1.001, Math.max(0, v * TN - 0.5));
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const a = grid[j * TN + i], b = grid[j * TN + i + 1], c = grid[(j + 1) * TN + i], d = grid[(j + 1) * TN + i + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

export function bakeDepth(): THREE.DataTexture {
  const { x0, z0, size } = DEPTH_BOUNDS;
  // Travel times on the coarse grid.
  const tc = size / TN;
  const depth = new Float32Array(TN * TN);
  for (let j = 0; j < TN; j++)
    for (let i = 0; i < TN; i++) depth[j * TN + i] = SEA_Y - bedY(x0 + (i + 0.5) * tc, z0 + (j + 0.5) * tc);
  const tA = shoreMatched(depth, WAVE.dir[0], WAVE.period[0]);
  const tB = shoreMatched(depth, WAVE.dir[1], WAVE.period[1]);

  const field = new Float32Array(RES * RES * 4);
  const data = new Uint16Array(RES * RES * 4);
  for (let j = 0; j < RES; j++) {
    const v = (j + 0.5) / RES;
    const z = z0 + v * size;
    for (let i = 0; i < RES; i++) {
      const u = (i + 0.5) / RES;
      const x = x0 + u * size;
      const r = rockAt(x, z);
      const k = (j * RES + i) * 4;
      field[k] = bedY(x, z);
      field[k + 1] = bilerp(tA, u, v);
      field[k + 2] = bilerp(tB, u, v);
      field[k + 3] = r.cover;
      for (let c = 0; c < 4; c++) data[k + c] = THREE.DataUtils.toHalfFloat(field[k + c]);
    }
  }
  const tex = new THREE.DataTexture(data, RES, RES, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  DEPTH.uDepthTex.value = tex;

  // The same field for gameplay queries (bilinear, like the GPU).
  setFieldSampler((x, z, out) => {
    const u = (x - x0) / size, v = (z - z0) / size;
    if (u < 0 || v < 0 || u > 1 || v > 1) {
      out[0] = -40;
      out[1] = out[2] = out[3] = 0;
      return out;
    }
    const fx0 = Math.min(RES - 1.001, Math.max(0, u * RES - 0.5));
    const fy0 = Math.min(RES - 1.001, Math.max(0, v * RES - 0.5));
    const i = Math.floor(fx0), j = Math.floor(fy0);
    const fx = fx0 - i, fy = fy0 - j;
    for (let c = 0; c < 4; c++) {
      const a = field[(j * RES + i) * 4 + c], b = field[(j * RES + i + 1) * 4 + c];
      const cc = field[((j + 1) * RES + i) * 4 + c], d = field[((j + 1) * RES + i + 1) * 4 + c];
      out[c] = a + (b - a) * fx + (cc - a) * fy + (a - b - cc + d) * fx * fy;
    }
    return out;
  });
  return tex;
}
