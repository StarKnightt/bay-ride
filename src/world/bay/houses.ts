import * as THREE from "three";
import { ID, M, beam, box, boxM, cyl, merge, prep, sphere, xf } from "../geo";
import { mulberry32, pick, range, type Rng } from "../../core/rng";
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { roadX } from "./road";
import { meshH, terrainH } from "./terrain";
import type { Box, Collider } from "./index";
import type { Layout } from "../../flora/place";
import type { TreeSpot } from "../../flora/trees";

type Geo = THREE.BufferGeometry;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * The harbour town on the hill above the pier: four stepped rows of plastered houses with dark
 * tiled roofs (tile rows painted by the roof surface), framed windows with sills, shutters and
 * flower boxes, doors with hoods and steps, balconies with railings and pots, air-conditioner
 * units, chimneys, gutters, laundry fluttering on lines, a corner shop with a striped awning and
 * its goods outside, and two stepped stone lanes climbing between the rows (walkable: their tread
 * heights are the ground, see pavedH). Fronts face the sea (-x); windows light warm after dusk.
 */

interface HouseSpec {
  u: number;
  z: number;
  w: number;
  d: number;
  floors: 1 | 2;
  wall: string;
  /** Ridge along z (eaves to the sea) instead of along x (gable to the sea). */
  ridgeZ?: boolean;
  balcony?: boolean;
  shutters?: string;
  boxes?: boolean;
  ac?: boolean;
  laundry?: "balcony" | "yard";
  shop?: boolean;
  chimney?: boolean;
  door?: string;
}

const HOUSES: HouseSpec[] = [
  { u: 14, z: -150, w: 7, d: 6.5, floors: 2, wall: "#efe5d2", balcony: true, shutters: "#3d7f86", boxes: true, door: "#3f6672" },
  { u: 13.5, z: -160.5, w: 6.5, d: 6, floors: 2, wall: "#e6d6b8", ridgeZ: true, ac: true, balcony: true, laundry: "balcony", door: "#7a3b2e" },
  { u: 13, z: -171, w: 8, d: 7.5, floors: 1, wall: "#f3ece0", shop: true },
  { u: 14, z: -192, w: 7, d: 6.5, floors: 2, wall: "#d8dfdc", boxes: true, shutters: "#5b7d4a", door: "#4a3a2e" },
  { u: 13.5, z: -201.5, w: 6.5, d: 5.5, floors: 1, wall: "#ead2bc", ridgeZ: true, boxes: true, door: "#3f6672" },
  { u: 15, z: -218, w: 7.5, d: 6.5, floors: 2, wall: "#efe5d2", balcony: true, laundry: "balcony", shutters: "#8a4f3a" },
  { u: 25, z: -154, w: 6.5, d: 6, floors: 2, wall: "#e9dcc6", shutters: "#8a4f3a", chimney: true, door: "#4a3a2e" },
  { u: 26, z: -165.5, w: 7, d: 6.5, floors: 2, wall: "#dfe4dc", ac: true, boxes: true, door: "#7a3b2e" },
  { u: 24.5, z: -174.5, w: 6.5, d: 6, floors: 1, wall: "#e6d6b8", laundry: "yard", door: "#3f6672" },
  { u: 25.5, z: -195, w: 7, d: 6.5, floors: 2, wall: "#f0e2cc", ridgeZ: true, balcony: true, shutters: "#3d7f86" },
  { u: 27, z: -218, w: 7, d: 6, floors: 1, wall: "#dcd6c8", chimney: true, door: "#4a3a2e" },
  { u: 37, z: -160, w: 7, d: 6.5, floors: 2, wall: "#efe5d2", chimney: true, ac: true, boxes: true },
  { u: 38, z: -171, w: 6.5, d: 6, floors: 1, wall: "#ead2bc", boxes: true, door: "#5b7d4a" },
  { u: 37, z: -192, w: 7.5, d: 6.5, floors: 2, wall: "#e3dccf", balcony: true, shutters: "#3f6f95", laundry: "balcony" },
  { u: 37.5, z: -202, w: 6.5, d: 5.5, floors: 1, wall: "#f3ece0", ridgeZ: true, door: "#7a3b2e" },
  { u: 38, z: -218, w: 7, d: 6, floors: 1, wall: "#e6d6b8", boxes: true },
  { u: 48, z: -155, w: 6.5, d: 6, floors: 1, wall: "#efe5d2", chimney: true },
  { u: 49, z: -166, w: 7, d: 6, floors: 2, wall: "#dfe4dc", laundry: "yard", shutters: "#3d7f86" },
  { u: 50, z: -193, w: 7, d: 6.5, floors: 1, wall: "#e9dcc6", chimney: true, boxes: true },
  { u: 49, z: -214, w: 6.5, d: 6, floors: 2, wall: "#ead2bc", ridgeZ: true, ac: true },
];

/** Stepped stone lanes up the hill at fixed z: from the verge (u0) to the top (u1). */
export const LANES = [
  { z: -181, u0: 4.6, u1: 58, half: 1.15 },
  { z: -209, u0: 4.6, u1: 46, half: 1.0 },
];
/** The shop's paved forecourt by the road. */
const FORECOURT = { z0: -175.2, z1: -166.8, u0: 4.5 };

const TREAD = 1.3;
const RISER = 0.05;
const LIFT = 0.07;

interface Lane {
  z: number;
  half: number;
  x0: number;
  /** Ground under the lane centreline at each tread boundary (world x0 + i * TREAD). */
  g: Float64Array;
}
const LANE_GEO: Lane[] = [];
const PADS: { x0: number; x1: number; z0: number; z1: number; y: number }[] = [];

/**
 * Walk height of the paved lanes and forecourt at (x, z), or −Infinity off them: each tread slopes
 * with the hill and ends RISER below the next, so a 5 cm step separates them (well under her step
 * limit, and gentle enough for her slope test).
 */
export function pavedH(x: number, z: number): number {
  for (const l of LANE_GEO) {
    if (Math.abs(z - l.z) > l.half) continue;
    const s = (x - l.x0) / TREAD;
    const i = Math.floor(s);
    if (i < 0 || i >= l.g.length - 1) continue;
    const t = s - i;
    return l.g[i] + LIFT + (l.g[i + 1] - RISER - l.g[i]) * t;
  }
  for (const p of PADS) if (x > p.x0 && x < p.x1 && z > p.z0 && z < p.z1) return p.y;
  return -Infinity;
}

// ------------------------------------------------------------------ parts

/** A wall face: outward normal along x (sx = ±1) or z (sz = ±1). */
interface Face {
  /** World point on the wall plane at lateral offset `a` (along the wall) and height y, pushed out by `out`. */
  at(a: number, y: number, out: number): THREE.Vector3;
  /** Box sized (along the wall, height, depth out of the wall), centred at `at(a, y, out)`. */
  box(a: number, y: number, out: number, along: number, h: number, depth: number, color: string, mat?: number): Geo;
}

function face(cx: number, cz: number, w: number, d: number, axis: "x" | "z", sign: number): Face {
  const along = (lx: number, h: number, dp: number) => (axis === "x" ? [dp, h, lx] : [lx, h, dp]);
  return {
    at: (a, y, out) => (axis === "x" ? V(cx + sign * (w / 2 + out), y, cz + a) : V(cx + a, y, cz + sign * (d / 2 + out))),
    box(a, y, out, al, h, dp, color, mat = M.plain) {
      const p = this.at(a, y, out);
      const [bx, by, bz] = along(al, h, dp);
      return xf(box(bx, by, bz, color, mat), p.x, p.y, p.z);
    },
  };
}

interface Ctx {
  out: Geo[];
  cloth: Geo[];
  r: Rng;
  layout: Layout;
  colliders: Collider[];
  trees: TreeSpot[];
}

const FRAME_W = "#f2efe6";
const FRAME_D = "#4a3a2e";

function windowAt(c: Ctx, f: Face, a: number, y: number, ww: number, wh: number, spec: HouseSpec, frameCol: string): void {
  const { out } = c;
  out.push(f.box(a, y, 0.04, ww, wh, 0.08, "#20262c", M.glass));
  // Frame, sill and lintel stand proud of the plaster.
  out.push(f.box(a, y + wh / 2 + 0.04, 0.07, ww + 0.16, 0.08, 0.12, frameCol));
  out.push(f.box(a, y - wh / 2 - 0.03, 0.09, ww + 0.24, 0.06, 0.2, frameCol));
  out.push(f.box(a - ww / 2 - 0.04, y, 0.07, 0.08, wh, 0.12, frameCol));
  out.push(f.box(a + ww / 2 + 0.04, y, 0.07, 0.08, wh, 0.12, frameCol));
  if (spec.shutters) {
    // Open shutters folded back against the wall either side.
    for (const s of [-1, 1]) out.push(f.box(a + s * (ww / 2 + 0.1 + ww / 4), y, 0.05, ww / 2, wh + 0.04, 0.05, spec.shutters, M.planks));
  }
  if (spec.boxes && c.r() < 0.75) {
    const by = y - wh / 2 - 0.16;
    out.push(f.box(a, by, 0.16, ww + 0.1, 0.2, 0.22, pick(c.r, ["#b5653f", "#6d5946", "#c4795a"])));
    // Small plants in a row along the box (a disc of spots would hang off its front).
    for (const o of [-0.32, 0, 0.32]) {
      const p = f.at(a + o * ww, by + 0.1, 0.16);
      c.layout.spot(p.x, p.z, 0.05, 2, ["pink", "poppy", "daisy", "yellow", "pink"], p.y, 0.5);
    }
  }
}

function acUnit(f: Face, a: number, y: number): Geo[] {
  const out: Geo[] = [f.box(a, y, 0.17, 0.8, 0.56, 0.3, "#d6d4ca", M.metal)];
  const p = f.at(a + 0.12, y, 0.33);
  const fan = cyl(0.19, 0.19, 0.03, "#4c4e52", M.metal, 14);
  fan.rotateX(Math.PI / 2);
  // The fan's disc faces out of the wall.
  const n = f.at(0, 0, 1).sub(f.at(0, 0, 0));
  fan.lookAt(n);
  fan.translate(p.x, p.y, p.z);
  out.push(fan);
  for (let i = -2; i <= 2; i++) out.push(f.box(a + 0.12, y + i * 0.06, 0.34, 0.36, 0.012, 0.012, "#9a9c9e"));
  out.push(f.box(a - 0.3, y - 0.5, 0.06, 0.05, 0.9, 0.05, "#e0ddd0"));
  return out;
}

/** Cloth pieces pegged on a line from a to b, swaying from the line in the wind (aWind 0 → bottom). */
function laundry(c: Ctx, a: THREE.Vector3, b: THREE.Vector3): void {
  c.out.push(beam(a, b, 0.008, "#d9d4c8", M.plain, 4));
  const n = 4 + Math.floor(c.r() * 3);
  const L = a.distanceTo(b);
  const dir = b.clone().sub(a).normalize();
  const yaw = Math.atan2(-dir.z, dir.x);
  let s = 0.15;
  for (let i = 0; i < n && s < L - 0.3; i++) {
    const w = range(c.r, 0.32, 0.62), h = range(c.r, 0.38, 0.78);
    const sag = 0.06 * Math.sin(Math.PI * (s + w / 2) / L);
    const p = a.clone().addScaledVector(dir, s + w / 2);
    const g = new THREE.PlaneGeometry(w, h, 2, 3);
    g.translate(0, -h / 2, 0);
    prep(g, pick(c.r, ["#f4f1ea", "#a8c8e0", "#e88a78", "#f0d070", "#a8d8c0", "#f4f1ea", "#d8b4d8"]), M.cloth);
    const pa = g.attributes.position, wa = g.attributes.aWind as THREE.BufferAttribute;
    for (let k = 0; k < pa.count; k++) wa.setX(k, Math.min(0.6, (-pa.getY(k) / h) * 0.6));
    g.rotateY(yaw);
    g.translate(p.x, p.y - sag - 0.02, p.z);
    c.cloth.push(g);
    s += w + range(c.r, 0.08, 0.2);
  }
}

function pot(c: Ctx, x: number, y: number, z: number, kinds: ("hydrangea" | "pink" | "poppy" | "daisy" | "fern")[]): void {
  const r = range(c.r, 0.17, 0.24);
  c.out.push(xf(cyl(r, r * 0.75, r * 1.5, pick(c.r, ["#b5653f", "#a85a3a", "#8f7a6a", "#c4795a"]), M.plain, 10), x, y + r * 0.75, z));
  c.layout.spot(x, z, r * 0.4, 2, kinds, y + r * 1.5 - 0.02, 0.6);
}

function house(c: Ctx, s: HouseSpec, boxes: Box[]): void {
  const { out, r } = c;
  const x = roadX(s.z) + s.u, z = s.z;
  const { w, d } = s;
  const h = 3.1 * s.floors + 0.6;
  let y = Infinity;
  for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) y = Math.min(y, terrainH(x + (cx * w) / 2, z + (cz * d) / 2));
  y -= 0.4;
  // Plaster walls on a darker stone plinth.
  out.push(xf(boxM(w, h, d, s.wall, M.plaster), x, y + h / 2, z));
  out.push(xf(box(w + 0.12, 0.75, d + 0.12, "#a39d90", M.stone), x, y + 0.37, z));
  // Roof: two tiled slabs, ridge cap, gutters and barge boards.
  const pitch = 0.5;
  const span = s.ridgeZ ? w : d, len = s.ridgeZ ? d : w;
  const rise = Math.tan(pitch) * (span / 2);
  const slab = span / 2 / Math.cos(pitch) + 0.5;
  const ridge = y + h + rise * 0.98;
  const eave = y + h;
  for (const sg of [-1, 1]) {
    const mid = (eave + ridge) / 2;
    // Each slab tilts down toward its own eave.
    if (s.ridgeZ) out.push(xf(boxM(slab, 0.22, len + 0.7, "#5f7184", M.roof), x + sg * span / 4, mid, z, 0, 0, -sg * pitch));
    else out.push(xf(boxM(len + 0.7, 0.22, slab, "#5f7184", M.roof), x, mid, z + sg * span / 4, sg * pitch, 0, 0));
    // Gutter along the eave.
    const ge = span / 2 + 0.42;
    const ga = s.ridgeZ ? V(x + sg * ge, eave - 0.18, z - len / 2 - 0.35) : V(x - len / 2 - 0.35, eave - 0.18, z + sg * ge);
    const gb = s.ridgeZ ? V(x + sg * ge, eave - 0.18, z + len / 2 + 0.35) : V(x + len / 2 + 0.35, eave - 0.18, z + sg * ge);
    out.push(beam(ga, gb, 0.055, "#8e9294", M.metal, 6));
  }
  const ra = s.ridgeZ ? V(x, ridge + 0.1, z - len / 2 - 0.36) : V(x - len / 2 - 0.36, ridge + 0.1, z);
  const rb = s.ridgeZ ? V(x, ridge + 0.1, z + len / 2 + 0.36) : V(x + len / 2 + 0.36, ridge + 0.1, z);
  out.push(beam(ra, rb, 0.15, "#3c4652", M.metal, 8));
  // Gable walls under the roof and the barge boards along their rake.
  const gable = new THREE.Shape([new THREE.Vector2(-span / 2, 0), new THREE.Vector2(span / 2, 0), new THREE.Vector2(0, rise)]);
  const gg = new THREE.ExtrudeGeometry(gable, { depth: len - 0.1, bevelEnabled: false });
  gg.translate(0, 0, -(len - 0.1) / 2);
  if (!s.ridgeZ) gg.rotateY(Math.PI / 2);
  out.push(xf(prep(gg, s.wall, M.plaster), x, y + h - 0.05, z));
  for (const e of [-1, 1])
    for (const sg of [-1, 1]) {
      const p0 = s.ridgeZ ? V(x + sg * (span / 2 + 0.4), eave - 0.05, z + e * (len / 2 + 0.36)) : V(x + e * (len / 2 + 0.36), eave - 0.05, z + sg * (span / 2 + 0.4));
      const p1 = s.ridgeZ ? V(x, ridge + 0.06, z + e * (len / 2 + 0.36)) : V(x + e * (len / 2 + 0.36), ridge + 0.06, z);
      out.push(beam(p0, p1, 0.06, FRAME_D, M.planks, 4));
    }
  if (s.chimney) {
    const cx = x + (s.ridgeZ ? 0.6 : len * 0.22), cz = z + (s.ridgeZ ? len * 0.2 : 0.6);
    out.push(xf(box(0.55, 1.5, 0.55, "#b9ad9a", M.stone), cx, ridge - 0.1, cz));
    out.push(xf(box(0.7, 0.1, 0.7, "#6d6a66", M.plain), cx, ridge + 0.68, cz));
  }

  const front = face(x, z, w, d, "x", -1), back = face(x, z, w, d, "x", 1);
  const sides = [face(x, z, w, d, "z", -1), face(x, z, w, d, "z", 1)];
  const fc = s.shutters || r() < 0.5 ? FRAME_W : FRAME_D;
  if (s.shop) shopFront(c, s, x, y, z);
  else {
    // Door with frame, hood, step, a lantern and pots either side.
    const da = d * 0.26;
    out.push(front.box(da, y + 1.05 + 0.4, 0.05, 1.0, 2.1, 0.1, s.door ?? FRAME_D, M.planks));
    out.push(front.box(da, y + 2.55, 0.08, 1.24, 0.1, 0.14, FRAME_W));
    out.push(front.box(da - 0.56, y + 1.45, 0.08, 0.1, 2.1, 0.14, FRAME_W));
    out.push(front.box(da + 0.56, y + 1.45, 0.08, 0.1, 2.1, 0.14, FRAME_W));
    out.push(front.box(da, y + 2.78, 0.32, 1.5, 0.08, 0.66, "#4d4a48"));
    out.push(front.box(da, y + 0.48, 0.32, 1.3, 0.18, 0.62, "#bdb6a6", M.stone));
    out.push(front.box(da + 0.85, y + 2.15, 0.12, 0.2, 0.3, 0.2, "#f1d9a8", M.lantern));
    for (const sg of [-1, 1]) {
      const p = front.at(da + sg * 0.95, 0, 0.42);
      pot(c, p.x, meshH(p.x, p.z), p.z, ["hydrangea", "pink", "fern", "daisy"]);
      c.colliders.push({ x: p.x, z: p.z, r: 0.22, top: meshH(p.x, p.z) + 0.6 });
    }
    // A bed of flowers along the front wall, by the plinth.
    const bp = front.at(-d * 0.18, 0, 0.45);
    c.layout.spot(bp.x, bp.z, 1.0, 7, ["hydrangea", "pink", "daisy", "fern", "lavender"]);
  }
  for (let f = 0; f < s.floors; f++) {
    const wy = y + 1.7 + f * 3.1 + 0.25;
    if (f === 1 && s.balcony) balcony(c, s, front, y + 3.1 + 0.55);
    else if (!s.shop || f > 0) {
      const across = f === 0 ? [-d * 0.2] : [-d * 0.27, d * 0.22];
      for (const a of across) windowAt(c, front, a, wy, 1.0, 1.2, s, fc);
    }
    windowAt(c, back, 0, wy, 1.0, 1.2, { ...s, boxes: false }, fc);
    for (const sd of sides) windowAt(c, sd, (f % 2 ? 0.8 : -0.9) * (w * 0.2), wy, 0.9, 1.1, s, fc);
  }
  if (s.ac) out.push(...acUnit(sides[r() < 0.5 ? 0 : 1], w * 0.22, y + 2.55));
  if (s.laundry === "yard") {
    const bx = x + w / 2 + 1.7;
    const g0 = meshH(bx, z - 1.7), g1 = meshH(bx, z + 1.7);
    for (const [pz, g] of [[z - 1.7, g0], [z + 1.7, g1]] as const) {
      out.push(beam(V(bx, g - 0.2, pz), V(bx, g + 1.85, pz), 0.04, "#6d5946", M.bark, 5));
      out.push(beam(V(bx, g + 1.8, pz - 0.25), V(bx, g + 1.8, pz + 0.25), 0.03, "#6d5946", M.bark, 4));
      c.colliders.push({ x: bx, z: pz, r: 0.12, top: g + 1.85 });
    }
    laundry(c, V(bx, g0 + 1.78, z - 1.65), V(bx, g1 + 1.78, z + 1.65));
  }
  // Gulls rest on the ridges.
  c.layout.perches.push([s.ridgeZ ? x : x - len * 0.25, ridge + 0.26, s.ridgeZ ? z - len * 0.2 : z, r() * 6.28]);
  // Shrubs at the corners, kept off the door and the windows.
  for (const [ox, oz] of [[1, 1], [1, -1]]) if (r() < 0.6) c.trees.push({ x: x + ox * (w / 2 + 0.8), z: z + oz * (d / 2 + 0.7), kind: "bush", scale: range(r, 0.8, 1.2), seed: Math.floor(r() * 1e6) });
  c.colliders.push({ x, z, r: Math.min(w, d) / 2 + 0.3, top: ridge, kind: "house" });
  boxes.push({ x0: x - w / 2 - 0.1, x1: x + w / 2 + 0.1, z0: z - d / 2 - 0.1, z1: z + d / 2 + 0.1, top: ridge });
  c.layout.rect(x - w / 2 - 0.25, x + w / 2 + 0.25, z - d / 2 - 0.25, z + d / 2 + 0.25);
  // The balcony sticks out at the front: keep the grass from growing up through its drips.
  if (s.balcony) c.layout.rect(x - w / 2 - 1.1, x - w / 2, z - 1.7, z + 1.7);
}

function balcony(c: Ctx, s: HouseSpec, f: Face, y: number): void {
  const { out } = c;
  const rail = s.shutters ? "#f2efe6" : "#3a3f40";
  out.push(f.box(0, y - 0.06, 0.45, 3.4, 0.12, 0.9, "#cfc8ba", M.stone));
  // Glazed double doors behind it.
  out.push(f.box(0, y + 1.05, 0.04, 1.3, 2.0, 0.08, "#20262c", M.glass));
  out.push(f.box(0, y + 2.1, 0.07, 1.46, 0.08, 0.12, FRAME_W));
  for (const sg of [-1, 1]) out.push(f.box(sg * 0.69, y + 1.05, 0.07, 0.08, 2.0, 0.12, FRAME_W));
  // Railing: top rail and balusters along the front and both ends.
  out.push(f.box(0, y + 0.95, 0.88, 3.4, 0.05, 0.05, rail, M.metal));
  for (let a = -1.65; a <= 1.66; a += 0.18) out.push(f.box(a, y + 0.48, 0.88, 0.025, 0.9, 0.025, rail, M.metal));
  for (const sg of [-1, 1]) {
    out.push(f.box(sg * 1.68, y + 0.95, 0.45, 0.05, 0.05, 0.9, rail, M.metal));
    for (let o = 0.1; o < 0.85; o += 0.18) out.push(f.box(sg * 1.68, y + 0.48, o, 0.025, 0.9, 0.025, rail, M.metal));
  }
  for (const a of [-1.25, 1.25]) {
    const p = f.at(a, 0, 0.6);
    pot(c, p.x, y, p.z, ["hydrangea", "pink", "poppy"]);
  }
  if (s.laundry === "balcony") laundry(c, f.at(-1.6, y + 1.75, 0.8), f.at(1.6, y + 1.75, 0.8));
}

/** Corner shop: wide display windows, a striped awning, a symbol sign, goods out front. */
function shopFront(c: Ctx, s: HouseSpec, x: number, y: number, z: number): void {
  const { out, r } = c;
  const f = face(x, z, s.w, s.d, "x", -1);
  const fy = Math.max(y + 0.45, meshH(x - s.w / 2 - 1, z));
  out.push(f.box(-0.9, fy + 1.25, 0.04, 3.6, 1.9, 0.08, "#20262c", M.glass));
  out.push(f.box(2.25, fy + 1.1, 0.04, 1.1, 2.2, 0.08, "#2b3a3e", M.glass));
  out.push(f.box(-0.9, fy + 0.2, 0.1, 3.8, 0.4, 0.2, "#4f6f6c"));
  out.push(f.box(0.55, fy + 1.25, 0.08, 0.1, 2.4, 0.14, FRAME_W));
  // Awning: alternating teal and cream stripes sloping out over the goods, with a scalloped hem.
  const aw = 6.4, out0 = 0.1, depth = 1.9, top = fy + 2.75, drop = 0.5;
  const tilt = Math.atan2(drop, depth);
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = -aw / 2 + (i + 0.5) * (aw / n);
    const p = f.at(a, top - drop / 2, out0 + depth / 2);
    // Raised at the wall (+x), dropping toward the road.
    out.push(xf(box(depth / Math.cos(tilt), 0.03, aw / n, i % 2 ? "#f1e8d2" : "#2f8f8a", M.cloth), p.x, p.y, p.z, 0, 0, tilt));
    const hm = f.at(a, top - drop - 0.12, out0 + depth);
    out.push(xf(box(0.03, 0.22, aw / n - 0.02, i % 2 ? "#f1e8d2" : "#2f8f8a", M.cloth), hm.x, hm.y, hm.z));
  }
  for (const sg of [-1, 1]) {
    const a0 = f.at(sg * aw / 2, top, out0), a1 = f.at(sg * aw / 2, top - drop, out0 + depth);
    out.push(beam(a0, a1, 0.025, "#3a3f40", M.metal, 4));
  }
  // Sign board over the awning: a fish and a cup, no words.
  const sp = f.at(0, top + 0.55, 0.1);
  out.push(xf(box(0.08, 0.7, 3.2, "#2f6f78", M.metal), sp.x, sp.y, sp.z));
  const fish = new THREE.Shape();
  fish.moveTo(-0.5, 0);
  fish.quadraticCurveTo(-0.1, 0.26, 0.32, 0.02);
  fish.lineTo(0.55, 0.2);
  fish.lineTo(0.5, -0.18);
  fish.lineTo(0.32, -0.02);
  fish.quadraticCurveTo(-0.1, -0.26, -0.5, 0);
  const fg = new THREE.ShapeGeometry(fish);
  fg.rotateY(-Math.PI / 2);
  out.push(xf(prep(fg, "#f4efe2", M.plain), sp.x - 0.05, sp.y, sp.z - 0.6));
  const cup = cyl(0.13, 0.1, 0.24, "#f4efe2", M.plain, 10);
  out.push(xf(cup, sp.x - 0.1, sp.y - 0.04, sp.z + 0.8));
  out.push(xf(prep(new THREE.TorusGeometry(0.07, 0.02, 4, 8).rotateY(Math.PI / 2), "#f4efe2", M.plain), sp.x - 0.1, sp.y - 0.02, sp.z + 0.97));
  // Goods outside: crates of fruit on a low stand, a bucket of flowers, a stack of beach floats.
  for (let i = 0; i < 3; i++) {
    const p = f.at(-2.4 + i * 0.75, fy + 0.72, 0.9);
    out.push(xf(box(0.6, 0.06, 0.62, "#8a6f52", M.planks), p.x, p.y - 0.25, p.z));
    out.push(xf(box(0.56, 0.24, 0.5, "#a88a62", M.planks), p.x, p.y - 0.08, p.z));
    const fruit = pick(r, ["#f08a2c", "#d8402e", "#9cc23e", "#f2c63a"]);
    for (let k = 0; k < 9; k++) out.push(xf(sphere(0.055, fruit, M.plain, 8, 6), p.x + ((k % 3) - 1) * 0.15, p.y + 0.08, p.z + (Math.floor(k / 3) - 1) * 0.14));
  }
  const st = f.at(-1.65, fy + 0.25, 0.9);
  out.push(f.box(-1.65, fy + 0.2, 0.9, 2.4, 0.5, 0.7, "#6d5946", M.planks));
  c.colliders.push({ x: st.x, z: st.z - 0.6, r: 0.42, top: fy + 0.8 }, { x: st.x, z: st.z + 0.6, r: 0.42, top: fy + 0.8 });
  const bk = f.at(1.5, fy, 0.75);
  out.push(xf(cyl(0.2, 0.16, 0.36, "#8e9aa0", M.metal, 10), bk.x, fy + 0.18, bk.z));
  c.layout.spot(bk.x, bk.z, 0.1, 3, ["poppy", "pink", "daisy"], fy + 0.32, 0.75);
  c.colliders.push({ x: bk.x, z: bk.z, r: 0.25, top: fy + 0.5 });
  const fl = f.at(2.6, fy, 0.6);
  for (let k = 0; k < 4; k++) {
    const ring = new THREE.TorusGeometry(0.32, 0.1, 6, 14);
    out.push(xf(prep(ring, pick(r, ["#f06c5a", "#5ab0d8", "#f2c63a", "#f4f1ea"]), M.plain), fl.x - 0.05 - k * 0.04, fy + 0.45 + k * 0.05, fl.z, 0, Math.PI / 2 + range(r, -0.15, 0.15), 0));
  }
  c.colliders.push({ x: fl.x, z: fl.z, r: 0.4, top: fy + 1 });
  // Bench by the door.
  const bn = f.at(2.1, fy, 1.1);
  out.push(xf(box(0.42, 0.05, 1.5, "#8a6f52", M.planks), bn.x, fy + 0.45, bn.z));
  for (const sg of [-0.6, 0.6]) out.push(xf(box(0.36, 0.42, 0.06, "#4a3a2e", M.planks), bn.x, fy + 0.21, bn.z + sg));
  c.colliders.push({ x: bn.x, z: bn.z, r: 0.5, top: fy + 0.5 });
  // Flat paved forecourt from the road edge to the shop front (walkable: pavedH). The road runs
  // askew here, so the slab starts where the verge is narrowest and never reaches the asphalt.
  const x0 = Math.max(roadX(FORECOURT.z0), roadX(FORECOURT.z1)) + FORECOURT.u0, x1 = x - s.w / 2;
  PADS.push({ x0, x1, z0: FORECOURT.z0, z1: FORECOURT.z1, y: fy + 0.02 });
  out.push(xf(box(x1 - x0, 0.3, FORECOURT.z1 - FORECOURT.z0, "#c9c0ae", M.stone), (x0 + x1) / 2, fy - 0.13, (FORECOURT.z0 + FORECOURT.z1) / 2));
  c.layout.rect(x0 - 0.2, x1, FORECOURT.z0 - 0.2, FORECOURT.z1 + 0.2);
  c.layout.perches.push([sp.x, sp.y + 0.38, sp.z, 0]);
}

/** Stepped lanes with kerbs, a lantern every few treads and flowers along their edges. */
function lanes(c: Ctx, stone: Geo[]): void {
  for (const L of LANES) {
    const x0 = roadX(L.z) + L.u0, x1 = roadX(L.z) + L.u1;
    const n = Math.ceil((x1 - x0) / TREAD);
    const g = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) g[i] = meshH(x0 + i * TREAD, L.z);
    LANE_GEO.push({ z: L.z, half: L.half, x0, g });
    for (let i = 0; i < n; i++) {
      const a = g[i] + LIFT, b = g[i + 1] - RISER + LIFT;
      const tilt = Math.atan2(b - a, TREAD);
      const cx = x0 + (i + 0.5) * TREAD;
      // Tread slab, thick enough to hide the ground across the lane's width.
      stone.push(xf(box(TREAD / Math.cos(tilt) + 0.02, 0.5, L.half * 2, i % 3 ? "#c4bcaa" : "#bab2a0", M.stone), cx, (a + b) / 2 - 0.25, L.z, 0, 0, tilt));
      // Kerbs either side.
      for (const sg of [-1, 1]) stone.push(xf(box(TREAD + 0.02, 0.62, 0.22, "#9f978a", M.stone), cx, (a + b) / 2 - 0.22, L.z + sg * (L.half + 0.11), 0, 0, tilt));
      if (i % 6 === 3) {
        // Post lantern on the kerb, flowers and weeds at its foot.
        const lz = L.z + (i % 12 === 3 ? 1 : -1) * (L.half + 0.35);
        const gy = meshH(cx, lz);
        c.out.push(beam(V(cx, gy - 0.2, lz), V(cx, gy + 1.7, lz), 0.05, "#2f4a45", M.metal, 6));
        c.out.push(xf(box(0.24, 0.32, 0.24, "#f1d9a8", M.lantern), cx, gy + 1.88, lz));
        c.out.push(xf(cyl(0.02, 0.2, 0.12, "#2f4a45", M.metal, 4), cx, gy + 2.1, lz, 0, Math.PI / 4, 0));
        c.colliders.push({ x: cx, z: lz, r: 0.12, top: gy + 2.1 });
        c.layout.spot(cx, lz + Math.sign(lz - L.z) * 0.35, 0.7, 6, ["fern", "weed", "pink", "daisy", "yellow"]);
        c.layout.perches.push([cx, gy + 2.18, lz, 0]);
      } else if (i % 4 === 1) {
        const lz = L.z + (i % 8 === 1 ? 1 : -1) * (L.half + 0.5);
        c.layout.spot(cx, lz, 0.6, 4, ["fern", "pink", "daisy", "weed"]);
      }
    }
    c.layout.seg(x0 - 0.5, L.z, x1 + 0.4, L.z, L.half + 0.3);
  }
}

export interface Town {
  group: THREE.Group;
  houses: number;
}

/** The town: houses, shop, lanes. Registers colliders, footprints, flower spots, perches, shrubs. */
export function buildTown(colliders: Collider[], boxes: Box[], layout: Layout, trees: TreeSpot[]): Town {
  const c: Ctx = { out: [], cloth: [], r: mulberry32(1717), layout, colliders, trees };
  const stone: Geo[] = [];
  lanes(c, stone);
  for (const s of HOUSES) house(c, s, boxes);
  const group = new THREE.Group();
  group.name = "town";
  const m = new THREE.Mesh(merge(c.out), uber(ID.house, 2));
  // One stone material for lanes, walls and boulders: one program.
  const st = new THREE.Mesh(merge(stone), uber(ID.berm, 0.8));
  for (const o of [m, st]) {
    onLayers(o, LAYER_SHADOW, LAYER_REFLECT);
    group.add(o);
  }
  if (c.cloth.length) {
    const cl = new THREE.Mesh(merge(c.cloth), uber(ID.house, 0.4, THREE.DoubleSide));
    cl.name = "laundry";
    onLayers(cl, LAYER_SHADOW);
    group.add(cl);
  }
  return { group, houses: HOUSES.length };
}
