import * as THREE from "three";
import { ID, M, merge, prep, windByHeight } from "../geo";
import { mulberry32, range } from "../../core/rng";
import { uber } from "../../render/materials";
import { RIBBON_HALF, ROAD_Z0, ROAD_Z1, pnoise, roadX, smooth } from "./road";
import { WALL_OUT, terrainH } from "./terrain";
import { PIER } from "./pier";
import { rampH } from "./slipway";
import type { Collider } from "./index";
import type { Layout } from "../../flora/place";

/**
 * Seaside grasses that move in the wind and part around her: salt-meadow grass with sun-bleached
 * tips along the hill verge, tall pale marram in clumps at the top of the beach under the sea
 * wall, and the odd cushion of pink sea thrift. Instanced per 50 m stretch of road so stretches
 * out of view are culled.
 */

type Geo = THREE.BufferGeometry;
const _a = new THREE.Color(), _b = new THREE.Color(), _m = new THREE.Color(), _c = new THREE.Color();

/** A clump of tapered, arching blades: root → mid → tip colour up each blade. Base at y = 0. */
function clump(n: number, h: number, w: number, lean: number, spread: number, root: string, mid: string, tip: string, seed: number): Geo {
  const r = mulberry32(seed);
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const seg = 3;
  for (let b = 0; b < n; b++) {
    const a = r() * Math.PI * 2;
    const bh = h * range(r, 0.6, 1.1), bw = w * range(r, 0.75, 1.2);
    const rad = spread * Math.sqrt(r());
    const ox = Math.cos(a) * rad, oz = Math.sin(a) * rad;
    // Blades lean out from the clump's middle, so a clump reads as a fountain, not a brush.
    const da = a + range(r, -0.5, 0.5);
    const dx = Math.cos(da), dz = Math.sin(da);
    const bend = lean * range(r, 0.5, 1.4);
    const px = -dz, pz = dx;
    _a.set(root);
    _m.set(mid);
    _b.set(tip);
    const tv = r();
    if (tv > 0.7) _b.lerp(_m, 0.45);
    else if (tv < 0.2) _b.multiplyScalar(0.85);
    const start = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const off = bend * t * t * bh;
      const hw = bw * (1 - t * 0.9) * 0.5;
      const cx = ox + dx * off, cz = oz + dz * off, y = bh * t * (1 - bend * 0.35 * t);
      pos.push(cx - px * hw, y, cz - pz * hw, cx + px * hw, y, cz + pz * hw);
      if (t < 0.5) _c.copy(_a).lerp(_m, t * 2);
      else _c.copy(_m).lerp(_b, (t - 0.5) * 2);
      col.push(_c.r, _c.g, _c.b, _c.r, _c.g, _c.b);
    }
    for (let i = 0; i < seg; i++) {
      const k = start + i * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Soft up-facing normals: a clump shades as one tuft instead of flickering blade by blade.
  const nr = g.attributes.normal;
  for (let i = 0; i < nr.count; i++) nr.setXYZ(i, nr.getX(i) * 0.35, 1, nr.getZ(i) * 0.35);
  g.normalizeNormals();
  prep(g, null, M.grass);
  return windByHeight(g, 0, h, 1, 1.6);
}

const saltGrass = (s: number) => clump(16, 0.62, 0.034, 0.22, 0.2, "#2f4a2c", "#5d7d42", "#bdb978", s);
const marram = (s: number) => clump(16, 0.9, 0.042, 0.38, 0.18, "#59603a", "#8e9152", "#ddd29b", s);
/** A full marram tussock for a hummock's crown: dense, arching wide, dead straw at the skirt. */
const tussock = (s: number) => clump(36, 1.1, 0.055, 0.5, 0.32, "#615f3c", "#949456", "#e2d6a2", s);

/** Sea thrift: a low dark cushion with a few pink heads on wiry stems. */
function thrift(seed: number): Geo {
  const r = mulberry32(seed);
  const parts: Geo[] = [clump(9, 0.14, 0.03, 0.5, 0.1, "#27402a", "#3d5f35", "#6d8a4c", seed + 7)];
  const heads = 3 + Math.floor(r() * 3);
  for (let i = 0; i < heads; i++) {
    const a = r() * Math.PI * 2, d = range(r, 0, 0.09), hh = range(r, 0.17, 0.27);
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    const stem = new THREE.CylinderGeometry(0.004, 0.006, hh, 3, 1).translate(x, hh / 2, z);
    const head = new THREE.IcosahedronGeometry(range(r, 0.026, 0.034), 0).translate(x, hh, z);
    parts.push(prep(stem, "#4c6a38", M.plain), prep(head, r() > 0.5 ? "#e9a3bb" : "#f2bfd0", M.plain));
  }
  return windByHeight(merge(parts), 0, 0.27, 0.6, 1.4);
}

const CHUNK = 50;

/**
 * Plant the grasses (call after every collider is registered: none grow through a house). `layout`
 * keeps them off the town's paving and the shop forecourt.
 */
export function buildDuneGrass(colliders: readonly Collider[], layout?: Layout): THREE.Group {
  const group = new THREE.Group();
  group.name = "dune grass";
  const kinds = [saltGrass(11), marram(23), thrift(37), tussock(41)];
  // No ink: outlined, every clump turns into a scribble.
  const mat = uber(ID.grass, 0, THREE.DoubleSide);
  const free = (x: number, z: number) => {
    if (Math.abs(z - PIER.z) < PIER.half + 2.5 && x < PIER.x0 + 6) return false;
    if (rampH(x, z, 0.8) > -Infinity) return false;
    if (layout && layout.clearance(x, z, 1) < 0.3) return false;
    for (const c of colliders) {
      const dx = x - c.x, dz = z - c.z, rr = c.r + 0.9;
      if (Math.abs(dx) < rr && Math.abs(dz) < rr && dx * dx + dz * dz < rr * rr) return false;
    }
    return true;
  };
  const r = mulberry32(4242);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const z0 = Math.min(ROAD_Z0, ROAD_Z1), z1 = Math.max(ROAD_Z0, ROAD_Z1);
  for (let cz = z0; cz < z1; cz += CHUNK) {
    const lists: THREE.Matrix4[][] = [[], [], [], []];
    const put = (k: number, x: number, z: number, scale: number) => {
      p.set(x, terrainH(x, z) - 0.03, z);
      q.setFromAxisAngle(up, r() * Math.PI * 2);
      s.set(scale, scale * range(r, 0.85, 1.2), scale);
      lists[k].push(m.compose(p, q, s).clone());
    };
    for (let z = cz; z < Math.min(cz + CHUNK, z1); z += 0.9) {
      const rx = roadX(z);
      // Hill verge: thick along the road edge, thinning up the slope, in drifts.
      for (let u = RIBBON_HALF + 0.35; u < 15; u += 0.9) {
        const uu = u + range(r, -0.4, 0.4), zz = z + range(r, -0.4, 0.4);
        const x = rx + uu;
        const drift = pnoise(x * 0.35, zz * 0.35, 21);
        const pr = (1 - smooth(7, 16, uu)) * (0.5 + 0.5 * smooth(0.3, 0.55, drift));
        if (r() > pr || !free(x, zz)) continue;
        if (r() < 0.07 && uu < 9) put(2, x, zz, range(r, 0.9, 1.3));
        else put(0, x, zz, range(r, 0.85, 1.4) * (0.8 + 0.5 * drift));
      }
      // Top of the beach: marram in hummocks under the sea wall.
      for (let u = WALL_OUT - 0.35; u > WALL_OUT - 6.2; u -= 0.6) {
        const uu = u + range(r, -0.35, 0.35), zz = z + range(r, -0.35, 0.35);
        const x = rx + uu;
        const hum = pnoise(x * 0.22, zz * 0.22, 33);
        const crown = smooth(0.5, 0.68, hum);
        const pr = (1 - smooth(2.0, 6.2, WALL_OUT - uu)) * (0.35 + 0.65 * smooth(0.3, 0.55, hum));
        if (r() > pr || !free(x, zz)) continue;
        // Hummock crowns grow full tussocks; marram rings them and runs thinner between.
        if (r() < crown * 0.35) put(3, x, zz, range(r, 0.85, 1.25) * (0.85 + 0.3 * hum));
        else put(r() < 0.1 ? 2 : 1, x, zz, range(r, 0.85, 1.3) * (0.8 + 0.5 * hum));
      }
    }
    lists.forEach((list, k) => {
      if (!list.length) return;
      const im = new THREE.InstancedMesh(kinds[k], mat, list.length);
      list.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.computeBoundingSphere();
      im.frustumCulled = true;
      group.add(im);
    });
  }
  return group;
}
