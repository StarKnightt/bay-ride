import * as THREE from "three";
import { mulberry32, range } from "../core/rng";
import { SEA_Y, pnoise, roadX, smooth } from "../world/bay/road";
import { ISLAND, LIGHTHOUSE, coastH, headlandsH } from "../world/bay/terrain";
import { FLORA, meadowMaterial } from "./glsl";
import { groundY, slopeAt, uOf, type Layout } from "./place";

/**
 * Tall meadow grass over the hills, the headlands and the island: individual tapered blades in
 * instanced clumps (root to tip colour per blade, per-clump hue and height), swaying with the
 * scene's coherent wind plus broad gust waves rolling across the field, lit with translucency
 * toward the sun. Instances live in 32 m chunks (one draw each, frustum culled); a chunk draws
 * only as many instances as the density at its nearest point needs (instances are sorted by a
 * random rank, so dropping the tail thins it evenly), and the vertex shader folds instances away
 * smoothly by distance, so there is no popping. Far chunks switch to a 5-blade clump.
 */

const CHUNK = 32;
/** Densest planting (clumps per square metre) and the grid spacing that gives it. */
const PEAK = 2.6;
const STEP = 1 / Math.sqrt(PEAK);

type Geo = THREE.BufferGeometry;
const _a = new THREE.Color(), _m = new THREE.Color(), _b = new THREE.Color(), _c = new THREE.Color();

/**
 * One clump at unit height: blade centrelines in `position`, half-width vectors in `aEdge` (the
 * shader widens them with distance), root → mid → tip colours, normals facing each blade's lean.
 */
function clumpGeo(blades: number, segs: number, widthK: number, seed: number): Geo {
  const r = mulberry32(seed);
  const pos: number[] = [], nrm: number[] = [], col: number[] = [], edge: number[] = [], idx: number[] = [];
  for (let b = 0; b < blades; b++) {
    const a = r() * Math.PI * 2;
    const rad = 0.21 * Math.sqrt(r());
    const ox = Math.cos(a) * rad, oz = Math.sin(a) * rad;
    const da = a + range(r, -0.6, 0.6);
    const dx = Math.cos(da), dz = Math.sin(da);
    const bend = range(r, 0.12, 0.42);
    const bh = range(r, 0.6, 1.0);
    const hw0 = range(r, 0.017, 0.028) * widthK;
    _a.set("#1c3a24");
    _m.set(r() < 0.5 ? "#3d7a2f" : "#46803a");
    const tv = r();
    _b.set(tv < 0.25 ? "#7fae46" : tv < 0.8 ? "#a8c45a" : "#cfca72");
    const start = pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const off = bend * t * t * bh;
      const y = bh * t * (1 - bend * 0.3 * t);
      const hw = hw0 * (1 - t * 0.92);
      const cx = ox + dx * off, cz = oz + dz * off;
      for (const s of [-1, 1]) {
        pos.push(cx, y, cz);
        edge.push(-dz * hw * s, dx * hw * s);
        const ny = 0.35 + 0.5 * t;
        const l = Math.hypot(dx, ny, dz);
        nrm.push(dx / l, ny / l, dz / l);
        if (t < 0.45) _c.copy(_a).lerp(_m, t / 0.45);
        else _c.copy(_m).lerp(_b, Math.pow((t - 0.45) / 0.55, 0.9));
        col.push(_c.r, _c.g, _c.b);
      }
    }
    for (let i = 0; i < segs; i++) {
      const k = start + i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute("aEdge", new THREE.Float32BufferAttribute(edge, 2));
  g.setIndex(idx);
  return g;
}

interface Chunk {
  mesh: THREE.Mesh;
  near: THREE.InstancedBufferGeometry;
  far: THREE.InstancedBufferGeometry;
  n: number;
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
}

/** Density falloff the shader applies (kept in step with MEADOW_VS). */
function densAt(d: number): number {
  const f = FLORA.uGrassFar.value;
  return FLORA.uGrassK.value * (1 - 0.65 * smooth(f.x, f.y, d) - 0.23 * smooth(f.y, f.z, d) - 0.12 * smooth(f.z, f.w, d));
}

export class Meadow {
  readonly group = new THREE.Group();
  private readonly chunks: Chunk[] = [];
  /** Instances in total, and how many the last update drew. */
  total = 0;
  drawn = 0;
  draws = 0;

  /** Built in slices, awaiting `pause()` between them, so the loader keeps drawing (see Bay.build). */
  static async build(layout: Layout, pause: () => Promise<void>): Promise<Meadow> {
    const m = new Meadow();
    await m.fill(layout, pause);
    return m;
  }

  private constructor() {}

  private async fill(layout: Layout, pause: () => Promise<void>): Promise<void> {
    this.group.name = "meadow";
    const mat = meadowMaterial();
    const nearBase = clumpGeo(9, 3, 1, 71);
    const farBase = clumpGeo(5, 2, 1.35, 72);
    const lists = new Map<number, number[]>();
    const r = mulberry32(9090);
    const put = (x: number, y: number, z: number, h: number, w: number, hue: number) => {
      const k = Math.floor(x / CHUNK) * 4096 + Math.floor(z / CHUNK);
      let l = lists.get(k);
      if (!l) lists.set(k, (l = []));
      l.push(x, y - 0.04, z, r() * Math.PI * 2, h, w, hue, r());
    };

    // Hill above the coast road (and the town's gardens round the houses).
    const try1 = (x: number, z: number) => {
      const u = uOf(x, z);
      if (u < 7.5) return;
      const drift = pnoise(x * 0.07, z * 0.07, 5);
      const lawn = pnoise(x * 0.031 + 40, z * 0.027, 8);
      let dens = (0.45 + 0.55 * smooth(0.25, 0.6, drift)) * smooth(7.5, 11.5, u);
      if (u > 95) dens *= 0.65;
      if (r() > dens) return;
      if (headlandsH(x, z) > coastH(u, z) + 0.5) return;
      if (!layout.free(x, z, 0.15)) return;
      const y = groundY(x, z);
      if (y < SEA_Y + 1.5) return;
      const sl = slopeAt(x, z);
      if (sl > 0.36) return;
      // Tall in the lower fields, shorter up the hill and on the steeper ground, short lawns in places.
      let h = range(r, 0.7, 1.12) * (1 - 0.35 * smooth(60, 150, u)) * (1 - sl * 1.1);
      h *= 0.55 + 0.45 * smooth(0.3, 0.55, lawn);
      // Shorter at a lane or wall foot: the edge reads as trodden.
      const cl = layout.clearance(x, z, 2);
      h *= 0.55 + 0.45 * smooth(0.0, 1.6, cl);
      put(x, y, z, Math.max(0.28, h), range(r, 0.85, 1.25), Math.min(1, Math.max(0, range(r, 0, 0.75) + (drift - 0.5) * 0.5)));
    };
    let rows = 0;
    for (let z = -300; z < 268; z += STEP) {
      for (let x = roadX(z) + 7.5; x < roadX(z) + 168; x += STEP) try1(x + range(r, -0.95, 0.95) * STEP, z + range(r, -0.95, 0.95) * STEP);
      if (++rows % 48 === 0) await pause();
    }
    await pause();

    // Headlands: shorter, wind-swept golden grass on the gentler slopes.
    const try2 = (x: number, z: number) => {
      if (r() > 0.85) return;
      const u = uOf(x, z);
      if (headlandsH(x, z) < coastH(u, z) + 0.5) return;
      const y = groundY(x, z);
      if (y < SEA_Y + 3.5) return;
      const sl = slopeAt(x, z);
      if (sl > 0.32) return;
      if (!layout.free(x, z, 0.1)) return;
      const h = range(r, 0.35, 0.68) * (1 - sl);
      put(x, y, z, h, range(r, 0.9, 1.3), range(r, 0.55, 1));
    };
    for (const [zc, x0] of [[262, -175], [-298, -150]] as const)
      for (let z = zc - 75; z < zc + 75; z += STEP)
        for (let x = x0; x < 150; x += STEP) try2(x + range(r, -0.95, 0.95) * STEP, z + range(r, -0.95, 0.95) * STEP);

    // The island: short grass round the lighthouse, off the rocky shore.
    for (let z = ISLAND.z - 34; z < ISLAND.z + 34; z += STEP * 1.1)
      for (let x = ISLAND.x - 34; x < ISLAND.x + 34; x += STEP * 1.1) {
        const xx = x + range(r, -0.5, 0.5) * STEP, zz = z + range(r, -0.5, 0.5) * STEP;
        if (r() > 0.8 || Math.hypot(xx - LIGHTHOUSE.x, zz - LIGHTHOUSE.z) < 4) continue;
        const y = groundY(xx, zz);
        if (y < SEA_Y + 2.6 || slopeAt(xx, zz) > 0.34) continue;
        put(xx, y, zz, range(r, 0.3, 0.6), range(r, 0.9, 1.3), range(r, 0.4, 0.95));
      }
    await pause();

    let made = 0;
    for (const [k, l] of lists) {
      if (++made % 24 === 0) await pause();
      const n = l.length / 8;
      // Sort by rank: drawing the first `count` instances thins the chunk evenly.
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => l[a * 8 + 7] - l[b * 8 + 7]);
      const off = new Float32Array(n * 4), vr = new Float32Array(n * 4);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      order.forEach((s, i) => {
        for (let c = 0; c < 4; c++) {
          off[i * 4 + c] = l[s * 8 + c];
          vr[i * 4 + c] = l[s * 8 + 4 + c];
        }
        x0 = Math.min(x0, off[i * 4]);
        x1 = Math.max(x1, off[i * 4]);
        y0 = Math.min(y0, off[i * 4 + 1]);
        y1 = Math.max(y1, off[i * 4 + 1]);
        z0 = Math.min(z0, off[i * 4 + 2]);
        z1 = Math.max(z1, off[i * 4 + 2]);
      });
      const aOff = new THREE.InstancedBufferAttribute(off, 4);
      const aVar = new THREE.InstancedBufferAttribute(vr, 4);
      const sphere = new THREE.Sphere(new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2 + 0.6, (z0 + z1) / 2), 0);
      sphere.radius = Math.hypot(x1 - x0, y1 - y0 + 1.5, z1 - z0) / 2 + 1.5;
      const mk = (base: Geo) => {
        const g = new THREE.InstancedBufferGeometry();
        g.index = base.index;
        for (const name of ["position", "normal", "color", "aEdge"]) g.setAttribute(name, base.getAttribute(name));
        g.setAttribute("aOff", aOff);
        g.setAttribute("aVar", aVar);
        // A few instances until the first update: the boot's warm draws stay cheap.
        g.instanceCount = Math.min(n, 32);
        g.boundingSphere = sphere;
        return g;
      };
      const near = mk(nearBase), far = mk(farBase);
      // Half the chunks start on each clump so the warm-up draws both.
      const mesh = new THREE.Mesh(k % 2 ? far : near, mat);
      mesh.matrixAutoUpdate = false;
      mesh.name = "meadow chunk";
      this.group.add(mesh);
      this.chunks.push({ mesh, near, far, n, x0, x1, z0, z1, y: (y0 + y1) / 2 });
      this.total += n;
    }
  }

  /** Per frame: instance count and clump detail per chunk from its nearest point to the camera. */
  update(cam: THREE.Vector3): void {
    let drawn = 0, draws = 0;
    const fw = FLORA.uGrassFar.value.w;
    for (const c of this.chunks) {
      const dx = Math.max(c.x0 - cam.x, 0, cam.x - c.x1), dz = Math.max(c.z0 - cam.z, 0, cam.z - c.z1);
      const d = Math.hypot(dx, dz, Math.max(0, Math.abs(cam.y - c.y) - 6));
      if (d > fw) {
        c.mesh.visible = false;
        continue;
      }
      const dens = densAt(d);
      const count = Math.min(c.n, Math.ceil(c.n * Math.min(1, dens + 0.08)));
      c.mesh.visible = count > 0;
      const g = d > 46 ? c.far : c.near;
      c.mesh.geometry = g;
      g.instanceCount = count;
      drawn += count;
      draws++;
    }
    this.drawn = drawn;
    this.draws = draws;
  }
}
