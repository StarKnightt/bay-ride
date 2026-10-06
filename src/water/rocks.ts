import * as THREE from "three";
import { ID, M, blob, merge, prep, xf } from "../world/geo";
import { uber } from "../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../render/lightpasses";
import { SEA_Y, roadX } from "../world/bay/road";
import { waterlineU } from "../world/bay/terrain";
import { mulberry32 } from "../core/rng";

/** A shore rock: footprint centre, horizontal radius, top height (world y), vertical squash. */
export interface Rock {
  x: number;
  z: number;
  r: number;
  top: number;
  sy: number;
  seed: number;
}

/** Rock at `o` metres off the mean waterline (negative = seaward) at z. */
function at(o: number, z: number, r: number, topAboveSea: number, sy: number, seed: number): Rock {
  return { x: roadX(z) + waterlineU(z) + o, z, r, top: SEA_Y + topAboveSea, sy, seed };
}

function buildList(): Rock[] {
  const list: Rock[] = [
    // In front of the shoreline view: a pair breaking the surface in the surf, one awash.
    at(-13, 21, 2.1, 0.7, 0.55, 1),
    at(-15.5, 17.5, 1.2, 0.35, 0.6, 2),
    at(-8, 31, 1.4, 0.05, 0.5, 3),
    at(-21, 9, 1.6, -0.35, 0.5, 4),
    at(-5, 2, 0.9, -0.25, 0.5, 5),
    // North end, toward the headland: a broken reef of boulders.
    at(-10, 182, 2.6, 1.0, 0.6, 6),
    at(-14, 189, 1.8, 0.4, 0.55, 7),
    at(-6, 196, 1.5, 0.55, 0.6, 8),
    at(-19, 201, 2.2, 0.2, 0.5, 9),
    at(-24, 176, 1.7, -0.5, 0.5, 10),
    at(-4, 207, 1.1, 0.35, 0.6, 11),
    // South end, toward the harbour.
    at(-12, -186, 2.0, 0.8, 0.6, 12),
    at(-17, -193, 1.4, 0.25, 0.55, 13),
    at(-8, -199, 1.2, 0.45, 0.6, 14),
    at(-23, -178, 1.9, -0.45, 0.5, 15),
  ];
  // Scattered submerged boulders in the clear shallows.
  const rnd = mulberry32(77);
  for (let i = 0; i < 26; i++) {
    const z = -170 + rnd() * 340;
    const o = -6 - rnd() * 26;
    if (list.some((r) => Math.hypot(r.z - z, roadX(z) + waterlineU(z) + o - r.x) < 6)) continue;
    list.push(at(o, z, 0.6 + rnd() * 1.3, -0.5 - rnd() * 0.9 - (-o - 6) * 0.03, 0.45, 20 + i));
  }
  return list;
}

export const ROCKS: Rock[] = buildList();

/**
 * Height of the rock tops at (x, z) (−Infinity outside every footprint) and rock cover: 1 inside a
 * footprint, a falloff ring (≤ 0.95) around rocks that reach the surface (foam skirts).
 */
export function rockAt(x: number, z: number): { y: number; cover: number } {
  let y = -Infinity, cover = 0;
  for (const r of ROCKS) {
    const dx = x - r.x, dz = z - r.z;
    if (Math.abs(dx) > r.r + 3 || Math.abs(dz) > r.r + 3) continue;
    const d = Math.hypot(dx, dz) / r.r;
    if (d < 1) {
      const cy = r.top - r.r * r.sy;
      y = Math.max(y, cy + r.r * r.sy * Math.sqrt(1 - d * d));
      cover = 1;
    } else if (r.top > SEA_Y - 0.4) cover = Math.max(cover, 0.95 * (1 - ((d - 1) * r.r) / 2.5));
  }
  return { y, cover: Math.max(0, cover) };
}

/** Height of the rock tops at (x, z), −Infinity outside every footprint (per-frame safe: no allocation). */
export function rockTop(x: number, z: number): number {
  let y = -Infinity;
  for (const r of ROCKS) {
    const dx = x - r.x, dz = z - r.z;
    if (Math.abs(dx) > r.r || Math.abs(dz) > r.r) continue;
    const d2 = (dx * dx + dz * dz) / (r.r * r.r);
    if (d2 < 1) y = Math.max(y, r.top - r.r * r.sy * (1 - Math.sqrt(1 - d2)));
  }
  return y;
}

/** Max rocks that get surf foam in the water shader (the uniform array size). */
export const SKIRT_MAX = 16;

/**
 * Rocks that reach the surface, for foam skirts: (x, z, radius at the waterline, seed). Awash rocks
 * just under the surface get a small boil over their top.
 */
export function rockSkirts(): THREE.Vector4[] {
  const out = ROCKS.filter((r) => r.top > SEA_Y - 0.4)
    .sort((a, b) => b.top - a.top)
    .slice(0, SKIRT_MAX)
    .map((r) => {
      const cy = r.top - r.r * r.sy;
      const k = (SEA_Y - cy) / (r.r * r.sy);
      const rs = r.top > SEA_Y ? r.r * Math.sqrt(Math.max(0.05, 1 - k * k)) : r.r * 0.45;
      return new THREE.Vector4(r.x, r.z, rs * (0.9 + 0.1 * Math.sin(r.seed)), r.seed);
    });
  while (out.length < SKIRT_MAX) out.push(new THREE.Vector4(1e5, 1e5, 0, 0));
  return out;
}

const ROCK = new THREE.Color("#93897a");
const ROCK_TOP = new THREE.Color("#b2a78f");
const ROCK_WARM = new THREE.Color("#9a8670");
const ROCK_WET = new THREE.Color("#4e5148");
const SALT = new THREE.Color("#c9c3b0");
const WEED = new THREE.Color("#5d6136");

/**
 * All shore rocks as one mesh, shaded like the boulders on land: lumpy and rounded, a lit warm
 * top, a pale salt line just above the tide, an olive weed band at the waterline and dark wet
 * stone below. The underside reaches down into the seabed (a bare ellipsoid floated over it).
 */
export function buildRocks(): THREE.Mesh {
  const parts: THREE.BufferGeometry[] = [];
  const c = new THREE.Color();
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  for (const r of ROCKS) {
    if (r.top < SEA_Y - 1.6) continue;
    let g = blob(1, 2, 0.22, r.seed * 1.37);
    const lp = g.attributes.position;
    for (let i = 0; i < lp.count; i++) {
      const vx = lp.getX(i), vy = lp.getY(i), vz = lp.getZ(i);
      const k = 1 + 0.16 * Math.sin(vx * 2.3 + r.seed) * Math.sin(vy * 2.9 + r.seed * 1.3) * Math.sin(vz * 2.1 + r.seed * 0.7);
      lp.setXYZ(i, vx * k, (vy < 0 ? vy * 3.2 : vy) * k, vz * k);
    }
    g = prep(g, null, M.stone);
    xf(g, r.x, r.top - r.r * r.sy, r.z, 0, r.seed * 0.9, 0, r.r, r.r * r.sy, r.r * (0.8 + 0.2 * Math.sin(r.seed)));
    g.computeVertexNormals();
    const p = g.attributes.position, nr = g.attributes.normal;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), up = nr.getY(i);
      const h = y - SEA_Y + 0.08 * Math.sin(x * 1.7 + z * 1.3 + r.seed);
      const mot = 0.5 + 0.5 * Math.sin(x * 3.1 + r.seed) * Math.sin(z * 2.7 - r.seed);
      c.copy(ROCK).lerp(ROCK_WARM, 0.3 + 0.3 * mot).lerp(ROCK_TOP, clamp((up - 0.25) * 1.5) * 0.7);
      c.lerp(SALT, clamp(1 - Math.abs(h - 0.42) / 0.14) * 0.55);
      c.lerp(WEED, clamp(1 - Math.abs(h - 0.08) / 0.2) * 0.7);
      c.lerp(ROCK_WET, clamp((0.25 - h) / 0.3) * 0.75);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    parts.push(g);
  }
  const m = new THREE.Mesh(merge(parts), uber(ID.ground, 0.6));
  onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
  return m;
}
