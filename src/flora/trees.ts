import * as THREE from "three";
import { mulberry32, range, type Rng } from "../core/rng";
import { M, beam, blob, prep } from "../world/geo";
import { LEAF_CELL, cellUv } from "../render/leafAtlas";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../render/lightpasses";
import type { Collider } from "../world/bay";
import { foliageMaterial } from "./glsl";
import { groundY, type Layout } from "./place";

/**
 * Trees and shrubs as painted volumes: each crown is a few lopsided clusters, every cluster a dark
 * hidden core plus painted leaf-cluster cards on its shell whose normals point out from the whole
 * crown (sphere-projected), so the canopy shades as soft volumes, with fringe cards breaking the
 * silhouette into individual leaves. Broadleaf trees round the town and in copses on the hill,
 * seaside pines with flat needle pads on the headlands and the island, shrubs everywhere. All
 * static, written straight into one merged geometry per region (one draw each, culled per region).
 */

export type TreeKind = "round" | "tall" | "hero" | "pine" | "poplar" | "conifer" | "bush" | "hedge";

export interface TreeSpot {
  x: number;
  z: number;
  kind: TreeKind;
  scale: number;
  seed: number;
  /** Explicit base height (a potted shrub on a step); NaN = on the ground. */
  y?: number;
}

type V3 = THREE.Vector3;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const _q = new THREE.Quaternion(), _z = V(0, 0, 1), _c = new THREE.Color(), _v = V(0, 0, 0), _n = V(0, 0, 0);
const _m3 = new THREE.Matrix3();

/** Typed-array geometry writer: cards and prepped geometries appended without merge passes. */
class Builder {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly mat: number[] = [];
  readonly wind: number[] = [];
  readonly idx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  /**
   * Append a prepped geometry (position, normal, uv, color, aMat, aWind; indexed), moved by `m`.
   * `windK(localY)` sets the sway weight; null keeps the geometry's own aWind.
   */
  geo(g: THREE.BufferGeometry, m: THREE.Matrix4 | null, windK: ((y: number) => number) | null): void {
    const base = this.count;
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, c = g.attributes.color, a = g.attributes.aMat;
    const w = g.attributes.aWind;
    if (m) _m3.getNormalMatrix(m);
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i);
      _n.fromBufferAttribute(n, i);
      const wk = windK ? windK(_v.y) : w.getX(i);
      if (m) {
        _v.applyMatrix4(m);
        _n.applyMatrix3(_m3).normalize();
      }
      this.pos.push(_v.x, _v.y, _v.z);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.uv.push(u.getX(i), u.getY(i));
      this.col.push(c.getX(i), c.getY(i), c.getZ(i));
      this.mat.push(a.getX(i));
      this.wind.push(wk);
    }
    const ix = g.index!;
    for (let i = 0; i < ix.count; i++) this.idx.push(base + ix.getX(i));
    g.dispose();
  }

  /** A leaf-cluster card at c facing `face`, its normal `nrm` (the crown's sphere direction). */
  card(c: V3, face: V3, size: number, color: THREE.Color, nrm: V3, roll: number, mat: number, cell: number, wind: number): void {
    const base = this.count;
    _q.setFromUnitVectors(_z, face);
    const cr = Math.cos(roll), sr = Math.sin(roll), h = size / 2;
    const corners = [[-h, -h, 0, 0], [h, -h, 1, 0], [-h, h, 0, 1], [h, h, 1, 1]];
    for (const [x, y, u, v] of corners) {
      _v.set(x * cr - y * sr, x * sr + y * cr, 0).applyQuaternion(_q).add(c);
      this.pos.push(_v.x, _v.y, _v.z);
      this.nrm.push(nrm.x, nrm.y, nrm.z);
      const [au, av] = cellUv(cell, u, v);
      this.uv.push(au, av);
      this.col.push(color.r, color.g, color.b);
      this.mat.push(mat);
      this.wind.push(wind);
    }
    this.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aMat", new THREE.Float32BufferAttribute(this.mat, 1));
    g.setAttribute("aWind", new THREE.Float32BufferAttribute(this.wind, 1));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

function randDir(r: Rng, up = 0.12): V3 {
  const u = r() * 2 - 1, a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - u * u);
  return V(s * Math.cos(a), u * 0.85 + up, s * Math.sin(a)).normalize();
}

const BROAD = ["#3f7d3a", "#468a3c", "#3a7444", "#4f8a3a", "#437f40", "#2f6e4c", "#5b9a3e"];
const PINE = ["#2f5a45", "#365f48", "#2c5440"];
const SHRUB = ["#3d7a3f", "#4a8040", "#3a7048", "#527f3c"];

interface Cluster {
  c: V3;
  r: number;
}

/**
 * Crown of clusters: a dark core per cluster, shell cards with normals from the crown centre
 * (blended a little toward the cluster's own bulge), fringe cards where a cluster is the outer
 * silhouette. `cell` picks the painted leaf shape, `squash` flattens pads (pines).
 */
function crown(b: Builder, r: Rng, cl: Cluster[], centre: V3, colors: readonly string[], perCluster: number, fringe: number, size: [number, number], cell: number, wind: (y: number) => number, squash = 1, lobe = 0.35, coreReach = Infinity): void {
  for (const k of cl) {
    // The core reads as the shadowed inside of the crown through any gap between cards. Outer
    // clumps have none, so the sky shows between their leaves.
    if (k.c.distanceTo(centre) < coreReach) {
      const core = prep(blob(k.r * 0.8, 1, 0.18, r() * 50), _c.set(colors[0]).multiplyScalar(0.7), M.foliage, 0);
      core.scale(1, squash, 1);
      core.translate(k.c.x, k.c.y, k.c.z);
      b.geo(core, null, wind);
    }
    for (let i = 0; i < perCluster; i++) {
      const dir = randDir(r, squash < 1 ? 0.3 : 0.12);
      const rad = k.r * range(r, 0.72, 1.0);
      const p = V(k.c.x + dir.x * rad, k.c.y + dir.y * rad * squash, k.c.z + dir.z * rad);
      const nrm = p.clone().sub(centre);
      nrm.y /= squash < 1 ? 0.6 : 1;
      // `lobe`: how far each clump shades as its own bulge (lit top, shaded underside).
      nrm.normalize().lerp(dir, lobe).normalize();
      const face = nrm.clone().add(V(range(r, -0.5, 0.5), range(r, -0.25, 0.5), range(r, -0.5, 0.5))).normalize();
      _c.set(colors[Math.floor(r() * colors.length)]).multiplyScalar(range(r, 0.85, 1.15));
      // Each card sways as one piece, by the height of its centre.
      b.card(p, face, range(r, size[0], size[1]) * k.r, _c, nrm, r() * 6.283, M.leafCard, r() < 0.82 ? cell : LEAF_CELL.small, wind(p.y));
    }
  }
  // Fringe: cards straddling the outer shell, only where no other cluster covers the point.
  for (let i = 0; i < fringe; i++) {
    const k = cl[Math.floor(r() * cl.length)];
    const dir = randDir(r, squash < 1 ? 0.2 : 0.0);
    const rad = k.r * range(r, 0.95, 1.12);
    const p = V(k.c.x + dir.x * rad, k.c.y + dir.y * rad * squash, k.c.z + dir.z * rad);
    let inside = false;
    for (const o of cl) if (o !== k && p.distanceTo(o.c) < o.r * 0.92) inside = true;
    if (inside) continue;
    const nrm = p.clone().sub(centre).normalize().lerp(dir, Math.max(0.3, lobe)).normalize();
    const face = dir.clone().add(V(range(r, -0.6, 0.6), range(r, -0.5, 0.3), range(r, -0.6, 0.6))).normalize();
    _c.set(colors[Math.floor(r() * colors.length)]).multiplyScalar(range(r, 0.9, 1.2));
    b.card(p, face, range(r, size[0], size[1]) * k.r * 1.1, _c, nrm, r() * 6.283, M.fringeCard, cell, wind(p.y));
  }
}

/** Sway weight rising with height in the tree (0 at the foot, `max` at `top`): trunk, branches and crown agree. */
const swayBy = (top: number, max: number) => (y: number) => Math.min(1, Math.max(0, (y - 0.8) / Math.max(top - 0.8, 0.5))) ** 2 * max;

const bark = (a: V3, c: V3, r0: number, r1: number) => beam(a, c, r0, "#5b4634", M.bark, 6, r1);

/** One tree or shrub at (x, y, z): returns the trunk radius (0 = no collider) and its height. */
function plant(b: Builder, s: TreeSpot, y: number): { trunk: number; h: number } {
  const r = mulberry32(s.seed);
  const k = s.scale;
  const yaw = r() * Math.PI * 2;
  const m = new THREE.Matrix4().compose(V(s.x, y, s.z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw), V(k, k, k));
  // Local builder: geometry in tree space, moved into place at the end.
  const t = new Builder();
  let trunk = 0, h = 0;
  if (s.kind === "round" || s.kind === "tall" || s.kind === "hero") {
    const tall = s.kind === "tall", hero = s.kind === "hero";
    h = hero ? range(r, 4.6, 5.4) : tall ? range(r, 4.8, 5.8) : range(r, 2.8, 3.6);
    const cr = hero ? range(r, 4.2, 4.8) : tall ? range(r, 2.4, 2.9) : range(r, 2.5, 3.1);
    const top = V(range(r, -0.3, 0.3), h, range(r, -0.3, 0.3));
    trunk = hero ? 0.46 : 0.3;
    const sway = swayBy(h + cr * (tall ? 1.7 : 1.3), hero ? 0.7 : 0.9);
    t.geo(bark(V(0, -0.3, 0), top, trunk, trunk * 0.6), null, sway);
    const centre = V(top.x, h + cr * (tall ? 0.85 : 0.55), top.z);
    // Lopsided: the clumps crowd toward one side and one tier sits higher.
    const la = r() * Math.PI * 2, lean = V(Math.cos(la), 0, Math.sin(la)).multiplyScalar(cr * 0.28);
    const n = hero ? 13 : 7 + Math.floor(r() * 3);
    const cl: Cluster[] = [{ c: centre.clone(), r: cr * 0.6 }];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + range(r, -0.5, 0.5);
      const d = cr * range(r, 0.45, 0.85);
      const tier = (i % 3 === 0 ? 0.45 : i % 3 === 1 ? -0.25 : 0.1) + range(r, -0.2, 0.2);
      const c = V(centre.x + Math.cos(a) * d, centre.y + tier * cr * (tall ? 1.3 : 0.85), centre.z + Math.sin(a) * d);
      c.addScaledVector(lean, Math.max(0, Math.cos(a - la)) * 0.8 + 0.2);
      cl.push({ c, r: cr * range(r, 0.38, 0.54) });
      // Limbs reach well into the crown, so they show through its gaps.
      t.geo(bark(V(top.x * 0.6, h * 0.7, top.z * 0.6), V(c.x * 0.85, c.y - cr * 0.18, c.z * 0.85), 0.13 * (hero ? 1.7 : 1), 0.055), null, sway);
    }
    crown(t, r, cl, centre, BROAD, hero ? 36 : 28, hero ? 260 : 130, [0.64, 0.94], LEAF_CELL.ovate, sway, 1, 0.55, cr * 0.72);
  } else if (s.kind === "pine") {
    // Seaside pine: a leaning, kinked trunk and flat needle pads at the branch ends.
    h = range(r, 6, 8.5);
    const lean = V(range(r, -1, 1), 0, range(r, -1, 1)).normalize().multiplyScalar(h * 0.22);
    const mid = V(lean.x * 0.4, h * 0.5, lean.z * 0.4), top = V(lean.x, h, lean.z);
    trunk = 0.26;
    const sway = swayBy(h + 1.2, 0.6);
    t.geo(bark(V(0, -0.3, 0), mid, 0.26, 0.2), null, sway);
    t.geo(bark(mid, top, 0.2, 0.1), null, sway);
    const pads: Cluster[] = [{ c: V(top.x, h + 0.5, top.z), r: range(r, 1.5, 1.9) }];
    const n = 4 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, yy = h * range(r, 0.55, 0.95), len = range(r, 1.4, 2.6);
      const base = V(lean.x * yy / h, yy, lean.z * yy / h);
      const end = base.clone().add(V(Math.cos(a) * len, range(r, 0.2, 0.7), Math.sin(a) * len));
      t.geo(bark(base, end, 0.08, 0.04), null, sway);
      pads.push({ c: end.clone().add(V(0, 0.35, 0)), r: range(r, 1.0, 1.5) });
    }
    crown(t, r, pads, V(top.x, h * 0.8, top.z), PINE, 26, 34, [0.55, 0.8], LEAF_CELL.lance, sway, 0.42);
  } else if (s.kind === "poplar" || s.kind === "conifer") {
    // Poplar: a narrow column of stacked clumps. Conifer: a cone of tiers narrowing to a spire.
    const pop = s.kind === "poplar";
    h = pop ? range(r, 7.5, 9.5) : range(r, 6, 8);
    trunk = pop ? 0.24 : 0.22;
    const sway = swayBy(h + 1, pop ? 1 : 0.5);
    const top = V(range(r, -0.15, 0.15), h, range(r, -0.15, 0.15));
    t.geo(bark(V(0, -0.3, 0), top, trunk, trunk * 0.5), null, sway);
    const cl: Cluster[] = [];
    const tiers = pop ? 6 : 6 + Math.floor(r() * 2);
    for (let i = 0; i < tiers; i++) {
      const f = i / (tiers - 1), y = h * (pop ? 0.3 + f * 0.78 : 0.22 + f * 0.86);
      const rad = pop ? 1.15 * (1 - 0.55 * Math.abs(f - 0.4) ** 1.5) : 2.1 * (1 - f * 0.82);
      const a = r() * Math.PI * 2, d = rad * 0.18;
      cl.push({ c: V(top.x * f + Math.cos(a) * d, y, top.z * f + Math.sin(a) * d), r: rad * range(r, 0.9, 1.1) });
    }
    crown(t, r, cl, V(top.x, h * 0.62, top.z), pop ? BROAD : PINE, pop ? 13 : 14, pop ? 40 : 28, pop ? [0.5, 0.72] : [0.55, 0.78], pop ? LEAF_CELL.ovate : LEAF_CELL.lance, sway, pop ? 1 : 0.55, 0.3);
  } else {
    // Shrub (or a clipped hedge clump): low clusters of broad leaves, no trunk to speak of.
    const hedge = s.kind === "hedge";
    const cr = hedge ? 0.7 : range(r, 0.55, 0.85);
    h = cr * 1.6;
    const centre = V(0, cr * 0.95, 0);
    const cl: Cluster[] = [{ c: centre.clone(), r: cr }];
    const n = 2 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      cl.push({ c: V(Math.cos(a) * cr * 0.6, cr * range(r, 0.6, 1.1), Math.sin(a) * cr * 0.6), r: cr * range(r, 0.55, 0.8) });
    }
    crown(t, r, cl, centre, SHRUB, hedge ? 26 : 24, hedge ? 34 : 40, [0.5, 0.75], r() < 0.6 ? LEAF_CELL.broad : LEAF_CELL.ovate, (y) => Math.min(1, Math.max(0, y / (cr * 2))) * 0.55, 1, 0.5);
  }
  // Into place, keeping the sway weights authored in tree space.
  b.geo(t.build(), m, null);
  return { trunk: trunk * k, h: h * k };
}

function placeInto(b: Builder, s: TreeSpot, layout: Layout, colliders: Collider[]): void {
  const y = s.y !== undefined && !Number.isNaN(s.y) ? s.y : groundY(s.x, s.z) - 0.15;
  const { trunk, h } = plant(b, s, y);
  if (trunk > 0) {
    colliders.push({ x: s.x, z: s.z, r: trunk + 0.12, top: y + h });
    layout.rect(s.x - trunk - 0.25, s.x + trunk + 0.25, s.z - trunk - 0.25, s.z + trunk + 0.25);
  } else if (s.kind === "bush" || s.kind === "hedge") {
    const rr = 0.45 * s.scale;
    colliders.push({ x: s.x, z: s.z, r: rr, top: y + h * 0.8 });
  }
}

export interface TreeRegion {
  name: string;
  spots: TreeSpot[];
}

/** One merged mesh per region; registers trunk and shrub colliders and keeps grass off trunks. */
/** One merged mesh per region, awaiting `pause()` between regions (see Bay.build). */
export async function buildTrees(regions: TreeRegion[], layout: Layout, colliders: Collider[], pause: () => Promise<void> = async () => {}): Promise<{ group: THREE.Group; trees: number; cards: number }> {
  const group = new THREE.Group();
  group.name = "trees";
  const mat = foliageMaterial();
  let trees = 0, cards = 0;
  for (const reg of regions) {
    if (!reg.spots.length) continue;
    if (group.children.length) await pause();
    const b = new Builder();
    for (const s of reg.spots) placeInto(b, s, layout, colliders);
    trees += reg.spots.length;
    for (const v of b.mat) if (v === M.leafCard || v === M.fringeCard) cards++;
    const mesh = new THREE.Mesh(b.build(), mat);
    mesh.name = `trees: ${reg.name}`;
    mesh.matrixAutoUpdate = false;
    // The hill woods stand well back from the water: the mirror shows the slope without them.
    if (reg.name.startsWith("hill")) onLayers(mesh, LAYER_SHADOW);
    else onLayers(mesh, LAYER_SHADOW, LAYER_REFLECT);
    group.add(mesh);
  }
  return { group, trees, cards: Math.round(cards / 4) };
}
