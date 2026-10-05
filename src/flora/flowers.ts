import * as THREE from "three";
import { mulberry32, pick, range, type Rng } from "../core/rng";
import { LEAF_CELL, cellUv } from "../render/leafAtlas";
import { pnoise, roadX, smooth } from "../world/bay/road";
import { ISLAND, LIGHTHOUSE, coastH, headlandsH } from "../world/bay/terrain";
import { FLORA, flowerMaterial } from "./glsl";
import { groundY, slopeAt, uOf, type FlowerKind, type Layout } from "./place";

/**
 * Flowers in natural drifts: lavender spikes, red poppies and pink cosmos, white daisies, yellow
 * wildflowers, sea thrift, hydrangea heads by the houses, and leafy weeds and broad-leaved plants
 * round posts, lamps and wall feet. One instanced draw per kind. The world holds a few thousand
 * clumps; every few metres of camera travel the clumps within reach are packed into the instance
 * buffers (nearest region only), and the shader shrinks them away before that reach.
 */

type V3 = THREE.Vector3;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const _c = new THREE.Color();

/** Petal parts as the flower shader cuts them (aPart). */
const P = { stem: 0, daisy: 1, cup: 2, floret: 3, pom: 4, star: 5, leaf: 6 } as const;

class Proto {
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly part: number[] = [];
  readonly wind: number[] = [];
  readonly idx: number[] = [];
  private get n(): number {
    return this.pos.length / 3;
  }

  /** Tapered blade (stem or leaf) from a toward b, bowing by `bow` (part 0, sway rising with height). */
  blade(a: V3, b: V3, w0: number, w1: number, color: string, bow: V3, segs = 2): void {
    const base = this.n;
    const d = b.clone().sub(a);
    const side = V(-d.z, 0, d.x);
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
    side.normalize();
    const nrm = side.clone().cross(d).normalize();
    if (nrm.y < 0) nrm.negate();
    _c.set(color);
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const p = a.clone().lerp(b, t).addScaledVector(bow, t * (1 - t) * 4 * 0.5);
      const w = (w0 + (w1 - w0) * t) / 2;
      for (const s of [-1, 1]) {
        this.pos.push(p.x + side.x * w * s, p.y, p.z + side.z * w * s);
        this.nrm.push(nrm.x, nrm.y, nrm.z);
        this.uv.push(s < 0 ? 0 : 1, t);
        const k = 0.75 + 0.25 * t;
        this.col.push(_c.r * k, _c.g * k, _c.b * k);
        this.part.push(P.stem);
        this.wind.push(Math.min(1, p.y * 1.4));
      }
    }
    for (let i = 0; i < segs; i++) {
      const k = base + i * 2;
      this.idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }

  /** A square card of `size` at c facing `face` (petal shapes and leaf cards). */
  card(c: V3, face: V3, size: number, part: number, color: string, roll = 0, cell = -1): void {
    const base = this.n;
    const q = new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), face.clone().normalize());
    const cr = Math.cos(roll), sr = Math.sin(roll), h = size / 2;
    _c.set(color);
    const n = face.clone().normalize();
    for (const [x, y, u, v] of [[-h, -h, 0, 0], [h, -h, 1, 0], [-h, h, 0, 1], [h, h, 1, 1]]) {
      const p = V(x * cr - y * sr, x * sr + y * cr, 0).applyQuaternion(q).add(c);
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      if (cell >= 0) this.uv.push(...cellUv(cell, u, v));
      else this.uv.push(u, v);
      this.col.push(_c.r, _c.g, _c.b);
      this.part.push(part);
      this.wind.push(Math.min(1, p.y * 1.4));
    }
    this.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
  }

  build(): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("aPart", new THREE.Float32BufferAttribute(this.part, 1));
    g.setAttribute("aWind", new THREE.Float32BufferAttribute(this.wind, 1));
    g.setIndex(this.idx);
    return g;
  }
}

/** A tuft of leaves at the foot of a plant. */
function leaves(p: Proto, r: Rng, n: number, h: number, color: string, spread = 0.06): void {
  for (let i = 0; i < n; i++) {
    const a = r() * Math.PI * 2, d = range(r, 0, spread);
    const o = V(Math.cos(a) * d, 0, Math.sin(a) * d);
    const tip = o.clone().add(V(Math.cos(a) * h * 0.5, h * range(r, 0.6, 1), Math.sin(a) * h * 0.5));
    p.blade(o, tip, 0.03, 0.004, color, V(Math.cos(a) * 0.05, -0.02, Math.sin(a) * 0.05));
  }
}

const STEM = "#4a7a32";

function lavender(seed: number): Proto {
  const r = mulberry32(seed), p = new Proto();
  leaves(p, r, 9, 0.28, "#5f8458", 0.08);
  for (let s = 0; s < 8; s++) {
    const a = r() * Math.PI * 2, d = range(r, 0, 0.09), h = range(r, 0.5, 0.74);
    const o = V(Math.cos(a) * d, 0, Math.sin(a) * d), top = V(o.x + Math.cos(a) * h * 0.22, h, o.z + Math.sin(a) * h * 0.22);
    p.blade(o, top, 0.008, 0.004, "#6c8a50", V(0, 0, 0));
    for (let i = 0; i < 8; i++) {
      const t = 0.62 + (i / 7) * 0.38;
      const c = o.clone().lerp(top, t);
      const sz = 0.05 * (1.15 - t * 0.5);
      const ang = i * 2.4 + r();
      p.card(c, V(Math.cos(ang), 0.4, Math.sin(ang)), sz, P.floret, "#ffffff", r() * 6.28);
      p.card(c, V(-Math.sin(ang), 0.4, Math.cos(ang)), sz, P.floret, "#f4f0fa", r() * 6.28);
    }
  }
  return p;
}

/** Cup blooms on single stems (poppies, cosmos): `n` stems of height h, blooms of size `bs`. */
function cups(seed: number, n: number, h: [number, number], bs: number, leaf: string): Proto {
  const r = mulberry32(seed), p = new Proto();
  leaves(p, r, 6, 0.22, leaf, 0.07);
  for (let s = 0; s < n; s++) {
    const a = r() * Math.PI * 2, d = range(r, 0.02, 0.12), hh = range(r, h[0], h[1]);
    const o = V(Math.cos(a) * d, 0, Math.sin(a) * d), top = V(o.x + Math.cos(a) * hh * 0.18, hh, o.z + Math.sin(a) * hh * 0.18);
    p.blade(o, top, 0.009, 0.005, STEM, V(Math.cos(a) * 0.04, 0, Math.sin(a) * 0.04));
    p.card(top, V(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5), bs * range(r, 0.85, 1.15), P.cup, "#ffffff", r() * 6.28);
  }
  return p;
}

function daisies(seed: number): Proto {
  const r = mulberry32(seed), p = new Proto();
  leaves(p, r, 7, 0.2, "#4d7a3a", 0.08);
  for (let s = 0; s < 9; s++) {
    const a = r() * Math.PI * 2, d = range(r, 0.02, 0.14), hh = range(r, 0.28, 0.5);
    const o = V(Math.cos(a) * d, 0, Math.sin(a) * d), top = V(o.x + Math.cos(a) * hh * 0.15, hh, o.z + Math.sin(a) * hh * 0.15);
    p.blade(o, top, 0.007, 0.004, STEM, V(0, 0, 0));
    p.card(top, V(Math.cos(a) * 0.35, 1, Math.sin(a) * 0.35), range(r, 0.07, 0.095), P.daisy, "#ffffff", r() * 6.28);
  }
  return p;
}

function yellows(seed: number): Proto {
  const r = mulberry32(seed), p = new Proto();
  leaves(p, r, 6, 0.2, "#4f7d36", 0.06);
  for (let s = 0; s < 4; s++) {
    const a = r() * Math.PI * 2, hh = range(r, 0.35, 0.6);
    const top = V(Math.cos(a) * 0.08, hh, Math.sin(a) * 0.08);
    p.blade(V(0, 0, 0), top, 0.008, 0.005, STEM, V(0, 0, 0));
    for (let i = 0; i < 4; i++) {
      const b = a + range(r, -1.4, 1.4);
      const tw = top.clone().add(V(Math.cos(b) * 0.09, range(r, 0.03, 0.1), Math.sin(b) * 0.09));
      p.blade(top.clone().multiplyScalar(0.85), tw, 0.005, 0.003, STEM, V(0, 0, 0), 1);
      p.card(tw, V(Math.cos(b) * 0.4, 1, Math.sin(b) * 0.4), range(r, 0.045, 0.065), P.star, "#ffffff", r() * 6.28);
    }
  }
  return p;
}

function thrift(seed: number): Proto {
  const r = mulberry32(seed), p = new Proto();
  leaves(p, r, 12, 0.12, "#3d5f35", 0.1);
  for (let s = 0; s < 6; s++) {
    const a = r() * Math.PI * 2, d = range(r, 0, 0.09), hh = range(r, 0.15, 0.27);
    const o = V(Math.cos(a) * d, 0, Math.sin(a) * d), top = V(o.x, hh, o.z);
    p.blade(o, top, 0.006, 0.004, "#5b7a40", V(0, 0, 0), 1);
    p.card(top, V(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3), range(r, 0.05, 0.065), P.pom, "#ffffff", r() * 6.28);
    p.card(top, V(-Math.sin(a), 0.2, Math.cos(a)), range(r, 0.045, 0.06), P.pom, "#f6eef2", r() * 6.28);
  }
  return p;
}

function hydrangea(seed: number): Proto {
  const r = mulberry32(seed), p = new Proto();
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + r() * 0.4;
    const out = V(Math.cos(a), range(r, 0.5, 1.0), Math.sin(a)).normalize();
    p.card(V(Math.cos(a) * 0.22, range(r, 0.2, 0.5), Math.sin(a) * 0.22), out, range(r, 0.32, 0.42), P.leaf, "#3f7a3c", r() * 6.28, LEAF_CELL.broad);
  }
  for (let i = 0; i < 7; i++) {
    const a = r() * Math.PI * 2, d = range(r, 0.05, 0.28);
    const c = V(Math.cos(a) * d, range(r, 0.5, 0.78), Math.sin(a) * d);
    p.card(c, V(Math.cos(a) * 0.5, 1, Math.sin(a) * 0.5), range(r, 0.2, 0.26), P.pom, "#ffffff", r() * 6.28);
    p.card(c, V(-Math.sin(a), 0.25, Math.cos(a)), range(r, 0.18, 0.22), P.pom, "#f2f2f8", r() * 6.28);
  }
  return p;
}

/** Tall leafy weeds (knotweed, sorrel): stems with long narrow leaf cards. */
function weed(seed: number): Proto {
  const r = mulberry32(seed), p = new Proto();
  for (let s = 0; s < 4; s++) {
    const a = r() * Math.PI * 2, h = range(r, 0.6, 1.05);
    const top = V(Math.cos(a) * h * 0.2, h, Math.sin(a) * h * 0.2);
    p.blade(V(Math.cos(a) * 0.03, 0, Math.sin(a) * 0.03), top, 0.012, 0.005, "#47702e", V(0, 0, 0));
    for (let i = 0; i < 5; i++) {
      const t = 0.25 + i * 0.16;
      const out = V(Math.cos(a + i * 2.2), 0.55, Math.sin(a + i * 2.2)).normalize();
      p.card(top.clone().multiplyScalar(t).addScaledVector(out, 0.12), out, range(r, 0.3, 0.42), P.leaf, pick(r, ["#2f5a30", "#3a6a34", "#447536"]), range(r, -0.5, 0.5), LEAF_CELL.lance);
    }
  }
  return p;
}

/** Low rosette of broad leaves (dock, butterbur): wall feet, lamp bases, the shade of the town. */
function fern(seed: number): Proto {
  const r = mulberry32(seed), p = new Proto();
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + r() * 0.5;
    const out = V(Math.cos(a), range(r, 0.6, 1.1), Math.sin(a)).normalize();
    p.card(V(Math.cos(a) * 0.16, range(r, 0.14, 0.3), Math.sin(a) * 0.16), out, range(r, 0.34, 0.48), P.leaf, pick(r, ["#2e5a30", "#386836", "#30603a"]), range(r, -0.4, 0.4), LEAF_CELL.broad);
  }
  return p;
}

const TINTS: Record<FlowerKind, string[]> = {
  lavender: ["#9a86d6", "#8f7fd0", "#ae98de", "#a08ad8"],
  poppy: ["#d8362f", "#e24a40", "#cc2c30"],
  pink: ["#f08cb4", "#f4a8c8", "#e66f9e", "#f7c0d4"],
  daisy: ["#fbf8f0", "#fffdf6", "#f4f1ea"],
  yellow: ["#f2c53a", "#f5d84a", "#eaa82c", "#f7e070"],
  thrift: ["#ec9ab8", "#f2b8cc", "#e488aa"],
  hydrangea: ["#7f9be0", "#a58ad8", "#e8a0c0", "#93b4ea"],
  weed: ["#ffffff"],
  fern: ["#ffffff"],
};
const KINDS = Object.keys(TINTS) as FlowerKind[];
const SCALE: Record<FlowerKind, [number, number]> = {
  lavender: [0.85, 1.2], poppy: [0.85, 1.2], pink: [0.85, 1.25], daisy: [0.8, 1.2], yellow: [0.85, 1.25],
  thrift: [0.85, 1.3], hydrangea: [0.85, 1.15], weed: [0.7, 1.25], fern: [0.75, 1.3],
};

const BUCKET = 32;

class Kind {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly off: THREE.InstancedBufferAttribute;
  private readonly tint: THREE.InstancedBufferAttribute;
  /** All clumps of this kind, sorted by bucket: x, y, z, yaw, r, g, b, scale. */
  data = new Float32Array(0);
  /** Bucket key → [start, end) into data (in clumps). */
  readonly buckets = new Map<number, [number, number]>();
  readonly list: number[] = [];

  constructor(readonly name: FlowerKind, proto: Proto, mat: THREE.ShaderMaterial, readonly cap: number) {
    this.geo = proto.build();
    this.off = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    this.off.setUsage(THREE.DynamicDrawUsage);
    this.tint.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("aOff", this.off);
    this.geo.setAttribute("aTint", this.tint);
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = `flowers: ${name}`;
  }

  /** Freeze the clump list into bucket order. */
  seal(): void {
    const n = this.list.length / 8;
    const keyOf = (i: number) => Math.floor(this.list[i * 8] / BUCKET) * 4096 + Math.floor(this.list[i * 8 + 2] / BUCKET);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => keyOf(a) - keyOf(b));
    this.data = new Float32Array(n * 8);
    order.forEach((s, i) => {
      for (let c = 0; c < 8; c++) this.data[i * 8 + c] = this.list[s * 8 + c];
      const k = keyOf(s);
      const b = this.buckets.get(k);
      if (b) b[1] = i + 1;
      else this.buckets.set(k, [i, i + 1]);
    });
    this.list.length = 0;
  }

  /** Pack the clumps within `reach` of (x, z) into the instance buffers. */
  repack(x: number, z: number, reach: number): number {
    const o = this.off.array as Float32Array, t = this.tint.array as Float32Array, d = this.data;
    const r2 = reach * reach;
    let n = 0;
    const i0 = Math.floor((x - reach) / BUCKET), i1 = Math.floor((x + reach) / BUCKET);
    const j0 = Math.floor((z - reach) / BUCKET), j1 = Math.floor((z + reach) / BUCKET);
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++) {
        const b = this.buckets.get(i * 4096 + j);
        if (!b) continue;
        for (let k = b[0]; k < b[1] && n < this.cap; k++) {
          const dx = d[k * 8] - x, dz = d[k * 8 + 2] - z;
          if (dx * dx + dz * dz > r2) continue;
          for (let c = 0; c < 4; c++) {
            o[n * 4 + c] = d[k * 8 + c];
            t[n * 4 + c] = d[k * 8 + 4 + c];
          }
          n++;
        }
      }
    this.geo.instanceCount = n;
    this.off.clearUpdateRanges();
    this.tint.clearUpdateRanges();
    if (n > 0) {
      this.off.addUpdateRange(0, n * 4);
      this.tint.addUpdateRange(0, n * 4);
      this.off.needsUpdate = true;
      this.tint.needsUpdate = true;
    }
    return n;
  }
}

export class Flowers {
  readonly group = new THREE.Group();
  /** Ground drifts (x, y, z, radius): anchors for the butterflies. */
  readonly drifts: [number, number, number, number][] = [];
  private readonly kinds = new Map<FlowerKind, Kind>();
  private readonly lastAt = new THREE.Vector2(Infinity, Infinity);
  total = 0;
  drawn = 0;

  constructor(layout: Layout) {
    this.group.name = "flowers";
    const mat = flowerMaterial();
    const protos: Record<FlowerKind, Proto> = {
      lavender: lavender(301), poppy: cups(302, 5, [0.35, 0.58], 0.11, "#4a7a36"), pink: cups(303, 6, [0.45, 0.72], 0.1, "#4d7d3a"),
      daisy: daisies(304), yellow: yellows(305), thrift: thrift(306), hydrangea: hydrangea(307), weed: weed(308), fern: fern(309),
    };
    for (const k of KINDS) this.kinds.set(k, new Kind(k, protos[k], mat, 7000));
    const r = mulberry32(5150);

    const put = (kind: FlowerKind, x: number, y: number, z: number, sk = 1) => {
      const kd = this.kinds.get(kind)!;
      _c.set(pick(r, TINTS[kind]));
      // A little per-clump drift in hue and value: drifts read as many plants, not stamps.
      _c.offsetHSL(range(r, -0.015, 0.015), 0, range(r, -0.05, 0.04));
      const [s0, s1] = SCALE[kind];
      kd.list.push(x, y, z, r() * Math.PI * 2, _c.r, _c.g, _c.b, range(r, s0, s1) * sk);
    };
    const scatter = (cx: number, cz: number, rad: number, n: number, kinds: FlowerKind[], y0: number, sk = 1) => {
      // Ground drifts of real flowers are where the butterflies go.
      if (n >= 6 && Number.isNaN(y0) && kinds.some((k) => k !== "weed" && k !== "fern")) this.drifts.push([cx, groundY(cx, cz), cz, rad]);
      for (let i = 0; i < n; i++) {
        // Clumped toward the middle, a few stragglers further out.
        const a = r() * Math.PI * 2, d = rad * Math.pow(r(), 0.75);
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        const kind = kinds[Math.floor(r() * kinds.length)];
        if (Number.isNaN(y0)) {
          if (!layout.free(x, z, kind === "fern" || kind === "weed" ? 0 : 0.1)) continue;
          put(kind, x, groundY(x, z) - 0.03, z, sk);
        } else put(kind, x, y0, z, sk);
      }
    };

    // Spots the town and props asked for: rocks, posts, lamps, path edges, window boxes, beds.
    for (const s of layout.spots) scatter(s.x, s.z, s.r, s.n, s.kinds, s.y, s.s);

    // Drifts on the hill meadow: one or two species each, as wild flowers grow.
    const DRIFT: FlowerKind[][] = [["lavender"], ["poppy"], ["daisy"], ["yellow"], ["pink"], ["daisy", "yellow"], ["poppy", "daisy"], ["lavender", "pink"]];
    let drifts = 0;
    for (let tries = 0; tries < 900 && drifts < 120; tries++) {
      const z = range(r, -280, 250);
      const u = 10 + Math.pow(r(), 1.6) * 140;
      const x = roadX(z) + u;
      if (headlandsH(x, z) > coastH(u, z) + 0.5 || !layout.free(x, z, 1) || slopeAt(x, z) > 0.3) continue;
      // Denser near where she walks (the lower hill, the town edge, the paths).
      if (r() > 0.4 + 0.6 * (1 - smooth(20, 120, u))) continue;
      drifts++;
      const kinds = pick(r, DRIFT);
      scatter(x, z, range(r, 2.5, 6.5), Math.round(range(r, 12, 34) * (0.7 + 0.6 * pnoise(x * 0.1, z * 0.1, 2))), kinds, NaN);
    }
    // Headlands: thrift on the cliff tops, yellow among the short grass.
    for (let i = 0; i < 70; i++) {
      const north = i % 2 === 0;
      const z = north ? range(r, 225, 300) : range(r, -335, -262);
      const x = range(r, -170, 120);
      const y = groundY(x, z);
      if (headlandsH(x, z) < coastH(uOf(x, z), z) + 0.5 || y < -0.5 || slopeAt(x, z) > 0.32) continue;
      scatter(x, z, range(r, 1.5, 4), Math.round(range(r, 6, 16)), r() < 0.6 ? ["thrift"] : ["yellow", "thrift"], NaN);
    }
    // The island: thrift and daisies round the lighthouse.
    for (let i = 0; i < 16; i++) {
      const a = r() * Math.PI * 2, d = range(r, 5, 24);
      const x = LIGHTHOUSE.x + Math.cos(a) * d, z = LIGHTHOUSE.z + Math.sin(a) * d;
      if (groundY(x, z) < ISLAND.top - 14) continue;
      scatter(x, z, range(r, 1.2, 3), Math.round(range(r, 5, 12)), ["thrift", "thrift", "daisy"], NaN);
    }

    for (const k of this.kinds.values()) {
      this.total += k.list.length / 8;
      k.seal();
      this.group.add(k.mesh);
    }
  }

  /** Repack the clumps near the camera when it has moved a few metres (and on the first call). */
  update(cam: THREE.Vector3): void {
    if (Math.hypot(cam.x - this.lastAt.x, cam.z - this.lastAt.y) < 4) return;
    this.lastAt.set(cam.x, cam.z);
    const reach = FLORA.uFlowerFar.value.y + 4;
    let n = 0;
    for (const k of this.kinds.values()) n += k.repack(cam.x, cam.z, reach);
    this.drawn = n;
  }

  /** Count per kind within reach right now (debug). */
  counts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, k] of this.kinds) out[name] = (k.mesh.geometry as THREE.InstancedBufferGeometry).instanceCount;
    return out;
  }
}
