import * as THREE from "three";
import { M, ID, prep } from "../geo";
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { RIBBON_HALF, ROAD_Z0, ROAD_Z1, SEA_Y, pnoise, roadX, smooth } from "./road";
import { pathDist } from "../detail/paths";

/**
 * Placeholder coastal landform (later systems refine the shoreline, harbour and town ground):
 * a hill behind the coast road, the road bench with a promenade and a short sea wall, a sandy
 * beach sloping into the water, a shelving seabed, two headlands closing the bay and a small
 * rocky island out in the bay. Everything is one analytic height function, so walking, camera
 * clearance and the baked seabed depth for the water all agree with the mesh.
 */

/** Island (lighthouse) centre and footprint radius at the waterline. */
export const ISLAND = { x: -200, z: -20, r: 38, top: SEA_Y + 18 };
/** Lighthouse foot on the island's summit. */
export const LIGHTHOUSE = { x: ISLAND.x + 3, z: ISLAND.z - 2 };

/** Sea wall top / bottom (road-relative u) and the promenade between it and the road. */
export const WALL_IN = -5.6;
export const WALL_OUT = -7.0;
export const BEACH_TOP = -1.4;

/** Mean waterline on the beach (road-relative u): the beach is a little wider in places. */
export function waterlineU(z: number): number {
  return -28 - 4 * Math.sin(z * 0.021 + 0.6) - 2 * Math.sin(z * 0.057);
}

/** Height of the coastal profile across the road at (u, z). */
export function coastH(u: number, z: number): number {
  const x = roadX(z) + u;
  if (u >= RIBBON_HALF) {
    const hill = 58 * Math.pow(smooth(6, 210, u), 1.15) + 16 * smooth(200, 650, u);
    const und = (pnoise(x, z, 1) - 0.5) * 9 * smooth(12, 70, u) + (pnoise(x * 2.3, z * 2.3, 4) - 0.5) * 2.2 * smooth(8, 30, u);
    return 0.22 * smooth(RIBBON_HALF, 6, u) + hill + und;
  }
  if (u >= WALL_IN) return 0;
  if (u >= WALL_OUT) {
    // Short battered sea wall: nearly vertical, a little lean back.
    const t = (WALL_IN - u) / (WALL_IN - WALL_OUT);
    return BEACH_TOP * Math.pow(t, 0.7);
  }
  const uw = waterlineU(z);
  if (u >= uw) {
    // Beach: steeper near the wall (dry sand), flatter toward the water (swash zone).
    const t = (u - uw) / (WALL_OUT - uw);
    return SEA_Y + (BEACH_TOP - SEA_Y) * (0.55 * t + 0.45 * t * t);
  }
  // Seabed: gentle shelf of clear shallows, then dropping off into deep blue.
  const w = uw - u;
  const shelf = Math.min(w, 34) * 0.07;
  const drop = Math.max(0, w - 34) * 0.12;
  const ripple = (pnoise(x * 1.7, z * 1.7, 7) - 0.5) * 0.5 * smooth(4, 20, w);
  return SEA_Y - 0.02 - Math.min(26, shelf + drop) + ripple;
}

/** One headland: a ridge running out to sea along -x, falling to a rocky tip. */
function headland(x: number, z: number, zc: number, halfW: number, tipX: number, height: number, s: number): number {
  const wob = 10 * Math.sin(x * 0.021 + s) + 5 * Math.sin(x * 0.067 + s * 2.0);
  const across = (z - zc - wob) / halfW;
  const t = smooth(tipX - 30, 140, x);
  const crest = SEA_Y - 14 + (height + 16) * Math.pow(t, 0.55) * smooth(tipX - 40, tipX + 20, x);
  const noise = (pnoise(x, z, s) - 0.5) * 8;
  return crest + noise - Math.pow(Math.abs(across), 1.6) * (height * 0.9 + 10);
}

export function headlandsH(x: number, z: number): number {
  return Math.max(headland(x, z, 262, 62, -190, 52, 1.3), headland(x, z, -298, 58, -165, 44, 4.1));
}

export function islandH(x: number, z: number): number {
  const dx = x - ISLAND.x, dz = z - ISLAND.z;
  const a = Math.atan2(dz, dx);
  const r = Math.hypot(dx, dz) / (1 + 0.14 * Math.sin(3 * a + 1) + 0.07 * Math.sin(7 * a + 2.2));
  if (r > 80) return -100;
  const dome = 18 * Math.pow(1 - smooth(4, ISLAND.r, r), 0.6);
  const shoulder = -10 * smooth(ISLAND.r - 4, ISLAND.r + 26, r);
  const rough = (pnoise(x * 3.1, z * 3.1, 9) - 0.5) * 2.2 * smooth(10, 36, r);
  return SEA_Y + dome + shoulder + rough;
}

/** Ground height anywhere (seabed included). */
export function terrainH(x: number, z: number): number {
  const u = x - roadX(z);
  return Math.max(coastH(u, z), headlandsH(x, z), islandH(x, z));
}

/** The coastal grid exactly as drawn: road-relative columns, rows along z, vertex positions. */
const GRID = { uu: new Float64Array(0), zs: new Float64Array(0), rx: new Float64Array(0), pos: new Float32Array(0), nu: 0 };

/** i with a[i] <= v < a[i + 1] in the sorted array a, clamped to the first and last cell. */
function cellOf(a: Float64Array, v: number): number {
  let lo = 0, hi = a.length - 1;
  if (v <= a[0]) return 0;
  if (v >= a[hi]) return hi - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (a[m] <= v) lo = m;
    else hi = m;
  }
  return lo;
}

/**
 * Height of the coastal terrain mesh at (x, z), on its triangles. The smooth height function sits
 * up to a metre off the drawn surface where the grid is coarse (the upper hill, the headlands),
 * which is how she sank into the hill and the camera dipped under it. Island excluded.
 */
export function meshH(x: number, z: number): number {
  const g = GRID;
  if (!g.nu) return Math.max(coastH(x - roadX(z), z), headlandsH(x, z));
  const j = cellOf(g.zs, z);
  const t = Math.min(1, Math.max(0, (z - g.zs[j]) / (g.zs[j + 1] - g.zs[j])));
  const u = x - (g.rx[j] + (g.rx[j + 1] - g.rx[j]) * t);
  const i = cellOf(g.uu, u);
  const s = Math.min(1, Math.max(0, (u - g.uu[i]) / (g.uu[i + 1] - g.uu[i])));
  const P = g.pos, a = (j * g.nu + i) * 3 + 1, c = a + g.nu * 3;
  const ha = P[a], hb = P[a + 3], hc = P[c], hd = P[c + 3];
  // Cells split along b-c, as in buildTerrain: (a, c, b) below the diagonal, (b, c, d) above.
  return s + t <= 1 ? ha + (hb - ha) * s + (hc - ha) * t : hd + (hc - hd) * (1 - s) + (hb - hd) * (1 - t);
}

// ------------------------------------------------------------------ meshes

const C = {
  sandDry: new THREE.Color("#ecdcb2"),
  sandWet: new THREE.Color("#b9a37a"),
  seabed: new THREE.Color("#d8c696"),
  wall: new THREE.Color("#b7b0a2"),
  paving: new THREE.Color("#cfc5b2"),
  grass: new THREE.Color("#6f9a3e"),
  grassDark: new THREE.Color("#4f7a33"),
  rock: new THREE.Color("#8c8273"),
  rockDark: new THREE.Color("#6a6258"),
  path: new THREE.Color("#b5a07a"),
};

function steps(a: number, b: number, d: number): number[] {
  const out: number[] = [];
  const n = Math.max(1, Math.round((b - a) / d));
  for (let i = 0; i < n; i++) out.push(a + ((b - a) * i) / n);
  return out;
}

/** Surface colour + pattern id for a vertex (y = height, slope = 1 - normal.y). */
function surface(u: number, z: number, x: number, y: number, slope: number, out: THREE.Color): number {
  const n = pnoise(x * 0.9, z * 0.9, 3);
  if (u > WALL_OUT - 0.05 && u < WALL_IN + 0.05 && y < -0.02 && y > SEA_Y + 1) {
    out.copy(C.wall);
    return M.stone;
  }
  if (u >= WALL_IN && u < -RIBBON_HALF + 0.2 && Math.abs(y) < 0.1) {
    out.copy(C.paving);
    return M.plain;
  }
  // Steep or wave-washed land: rock.
  if (slope > 0.42 || (y < SEA_Y + 2.2 && y > SEA_Y - 1 && slope > 0.18 && u < -60)) {
    out.copy(C.rock).lerp(C.rockDark, n);
    return M.stone;
  }
  if (y > 0.15 || u > 0) {
    out.copy(C.grass).lerp(C.grassDark, smooth(0.3, 0.8, n));
    // Footpaths over the hill: worn tracks, soft-edged on the grid.
    const pd = u > 4 && u < 140 ? pathDist(x, z, 3) : 3;
    if (pd < 2.4) out.lerp(C.path, (1 - smooth(0.5, 2.4, pd)) * 0.8);
    return M.ground;
  }
  if (y < SEA_Y - 0.35) {
    out.copy(C.seabed);
    return M.plain;
  }
  // Beach: dry sand up top, darker damp sand in the swash band (system 2 animates this).
  const wet = 1 - smooth(SEA_Y + 0.15, SEA_Y + 0.55, y);
  out.copy(C.sandDry).lerp(C.sandWet, wet * 0.85);
  return M.plain;
}

/**
 * Sheared (road-aligned) grid, fine near the coast and coarse far out. The swash zone of the beach
 * (from under the shallows up to the foot of the sea wall) is split off into its own mesh with
 * `beachMat`, sharing the grid's vertices so the two meet without cracks.
 */
export function buildTerrain(beachMat: THREE.Material): { terrain: THREE.Mesh; beach: THREE.Mesh } {
  const us = [
    ...steps(-700, -260, 20),
    ...steps(-260, -120, 4),
    ...steps(-120, -42, 2),
    ...steps(-42, WALL_OUT - 0.5, 0.5),
    WALL_OUT - 0.5, WALL_OUT - 0.25, WALL_OUT, WALL_OUT + 0.08,
    ...steps(WALL_IN - 0.08, WALL_IN, 0.08), WALL_IN, WALL_IN + 0.5,
    ...steps(WALL_IN + 1, 8, 0.5),
    ...steps(8, 40, 1),
    ...steps(40, 200, 4),
    ...steps(200, 700, 20),
    700,
  ];
  us.sort((a, b) => a - b);
  const uu = us.filter((v, i) => i === 0 || v - us[i - 1] > 1e-3);
  const zs = [...steps(-660, -300, 4), ...steps(-300, 260, 2), ...steps(260, 620, 4), 620];
  const nu = uu.length, nz = zs.length;
  const pos = new Float32Array(nu * nz * 3);
  for (let j = 0; j < nz; j++) {
    const z = zs[j], rx = roadX(z);
    for (let i = 0; i < nu; i++) {
      const u = uu[i], x = rx + u;
      let y = Math.max(coastH(u, z), headlandsH(x, z));
      // Tucked under the road ribbon so the two never z-fight.
      if (Math.abs(u) < RIBBON_HALF - 0.3 && z < ROAD_Z0 + 30 && z > ROAD_Z1 - 30 && y < 0.05) y -= 0.25;
      const k = (j * nu + i) * 3;
      pos[k] = x;
      pos[k + 1] = y;
      pos[k + 2] = z;
    }
  }
  GRID.uu = Float64Array.from(uu);
  GRID.zs = Float64Array.from(zs);
  GRID.rx = Float64Array.from(zs, roadX);
  GRID.pos = pos;
  GRID.nu = nu;
  // Beach vertices: sand of the open beach (not under a headland), from 16 m out under the
  // shallows up to the sea wall foot.
  const isBeach = new Uint8Array(nu * nz);
  for (let j = 0; j < nz; j++) {
    const z = zs[j], rx = roadX(z), uw = waterlineU(z);
    for (let i = 0; i < nu; i++) {
      const u = uu[i];
      isBeach[j * nu + i] = u < WALL_OUT - 0.3 && u > uw - 16 && coastH(u, z) >= headlandsH(rx + u, z) ? 1 : 0;
    }
  }
  const idx: number[] = [];
  const bidx: number[] = [];
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nu - 1; i++) {
      const a = j * nu + i, b = a + 1, c = a + nu, d = c + 1;
      const dst = isBeach[a] && isBeach[b] && isBeach[c] && isBeach[d] ? bidx : idx;
      // Winding so normals face up (+y) with u along +x and rows along +z.
      dst.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array([...idx, ...bidx]), 1));
  g.computeVertexNormals();
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  paint(g, (x, z) => x - roadX(z));
  const mesh = new THREE.Mesh(g, uber(ID.ground, 0.6));
  mesh.frustumCulled = false;
  onLayers(mesh, LAYER_SHADOW, LAYER_REFLECT);
  const bg = new THREE.BufferGeometry();
  bg.setAttribute("position", g.attributes.position);
  bg.setAttribute("normal", g.attributes.normal);
  bg.setIndex(new THREE.BufferAttribute(new Uint32Array(bidx), 1));
  const beach = new THREE.Mesh(bg, beachMat);
  beach.frustumCulled = false;
  return { terrain: mesh, beach };
}

/** Radial mesh for the island (its own resolution, independent of the coastal grid). */
export function buildIsland(): THREE.Mesh {
  const rings = 44, segs = 96, R = 82;
  const pos: number[] = [];
  for (let j = 0; j <= rings; j++) {
    const r = R * Math.pow(j / rings, 1.25);
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      const x = ISLAND.x + Math.cos(a) * r, z = ISLAND.z + Math.sin(a) * r;
      pos.push(x, Math.max(islandH(x, z), SEA_Y - 12), z);
    }
  }
  const idx: number[] = [];
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < segs; i++) {
      const a = j * segs + i, b = j * segs + ((i + 1) % segs), c = a + segs, d = b + segs;
      idx.push(a, b, c, b, d, c);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  paint(g, () => -1000);
  const mesh = new THREE.Mesh(g, uber(ID.ground, 0.6));
  onLayers(mesh, LAYER_SHADOW, LAYER_REFLECT);
  return mesh;
}

function paint(g: THREE.BufferGeometry, uOf: (x: number, z: number) => number): void {
  const p = g.attributes.position, n = g.attributes.normal;
  const col = new Float32Array(p.count * 3);
  const mat = new Float32Array(p.count);
  const c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    mat[i] = surface(uOf(x, z), z, x, y, 1 - n.getY(i), c);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  prep(g, null);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aMat", new THREE.BufferAttribute(mat, 1));
}

/** Coast road surface: a ribbon over the road bench (uv.x = u, uv.y = metres along). */
export function buildRoadRibbon(z0: number, z1: number, material: THREE.Material): THREE.Mesh {
  const lat = steps(-RIBBON_HALF, RIBBON_HALF, 0.6).concat(RIBBON_HALF);
  const zs = steps(z1, z0, 1).concat(z0);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j < zs.length; j++) {
    const z = zs[j], rx = roadX(z);
    for (const u of lat) {
      pos.push(rx + u, 0.02, z);
      uv.push(u, -z);
    }
  }
  const nl = lat.length;
  for (let j = 0; j < zs.length - 1; j++)
    for (let i = 0; i < nl - 1; i++) {
      const a = j * nl + i, b = a + 1, c = a + nl, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, material);
  m.frustumCulled = false;
  onLayers(m, LAYER_REFLECT);
  return m;
}
