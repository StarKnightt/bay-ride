import * as THREE from "three";
import { ID, M, beam, blob, box, cyl, merge, prep, sphere, xf } from "../geo";
import { mulberry32, pick, range, type Rng } from "../../core/rng";
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { roadX } from "../bay/road";
import { meshH } from "../bay/terrain";
import { PIER, deckH } from "../bay/pier";
import type { Box, Collider } from "../bay";
import type { Layout } from "../../flora/place";

type Geo = THREE.BufferGeometry;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Harbour clutter, all landward of the opening view so nothing stands between her and the sea:
 * on the pier deck, crates, barrels, a heaped net with floats, rope coils, a stack of lobster pots,
 * fishing floats hung on the rail and planters at the lamp feet; on the sand by the pier root, a
 * small boarded fishing shed with a tin roof, a rowboat drawn up on the beach, more pots, crates and
 * a pile of floats. Every piece she could walk into has a collider.
 */

const WOOD = ["#8a6f52", "#7a6248", "#9a7d5c"];
const FLOATS = ["#e8632c", "#f0a030", "#e84a3a", "#f4f1ea", "#3a7ab0"];

interface Ctx {
  out: Geo[];
  hull: Geo[];
  r: Rng;
  colliders: Collider[];
  layout: Layout;
}

function crate(c: Ctx, x: number, y: number, z: number, s = 0.55, yaw = 0): void {
  const col = pick(c.r, WOOD);
  c.out.push(xf(box(s, s, s, col, M.planks), x, y + s / 2, z, 0, yaw, 0));
  // Slat lines: two dark battens across each long face.
  for (const dy of [-0.18, 0.18]) c.out.push(xf(box(s + 0.02, 0.05, s + 0.02, "#5b4836", M.planks), x, y + s / 2 + dy * s, z, 0, yaw, 0));
}

function barrel(c: Ctx, x: number, y: number, z: number, lying = false): void {
  const g = cyl(0.27, 0.24, 0.82, pick(c.r, ["#7a5a3e", "#6d5238", "#4f6a6a"]), M.planks, 12);
  const hoops = [-0.3, 0, 0.3].map((h) => xf(cyl(0.285, 0.285, 0.04, "#3a3a3a", M.metal, 12), 0, h, 0));
  for (const p of [g, ...hoops]) {
    if (lying) p.rotateZ(Math.PI / 2);
    c.out.push(xf(p, x, y + (lying ? 0.27 : 0.41), z));
  }
}

function ropeCoil(c: Ctx, x: number, y: number, z: number): void {
  for (let i = 0; i < 3; i++) {
    const t = new THREE.TorusGeometry(0.26 - i * 0.04, 0.045, 5, 16);
    t.rotateX(Math.PI / 2);
    c.out.push(xf(prep(t, "#cdbf9a", M.plain), x, y + 0.045 + i * 0.07, z));
  }
  c.out.push(beam(V(x + 0.24, y + 0.18, z), V(x + 0.6, y + 0.03, z + 0.25), 0.04, "#cdbf9a", M.plain, 5));
}

/** Lobster pot: plank base, three arched hoops, dark netting body, two top rails. */
function lobsterPot(c: Ctx, x: number, y: number, z: number, yaw: number): void {
  const parts: Geo[] = [box(0.62, 0.05, 0.46, "#7a6248", M.planks)];
  parts[0].translate(0, 0.025, 0);
  const net = box(0.56, 0.3, 0.42, "#3c4a44", M.plain);
  net.translate(0, 0.2, 0);
  parts.push(net);
  for (const hx of [-0.26, 0, 0.26]) {
    const h = new THREE.TorusGeometry(0.22, 0.015, 4, 10, Math.PI);
    h.rotateY(Math.PI / 2);
    h.translate(hx, 0.08, 0);
    parts.push(prep(h, "#5b4836", M.bark));
  }
  for (const sz of [-0.12, 0.12]) parts.push(beam(V(-0.3, 0.29, sz), V(0.3, 0.29, sz), 0.012, "#5b4836", M.bark, 4));
  for (const p of parts) c.out.push(xf(p, x, y, z, 0, yaw, 0));
}

function floatsPile(c: Ctx, x: number, y: number, z: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const a = c.r() * Math.PI * 2, d = range(c.r, 0, 0.35);
    c.out.push(xf(sphere(range(c.r, 0.1, 0.15), pick(c.r, FLOATS), M.plain, 10, 7), x + Math.cos(a) * d, y + 0.12 + (i > n * 0.6 ? 0.18 : 0), z + Math.sin(a) * d));
  }
}

/** Planter box at a lamp foot on the deck, filled by the flowers. */
function planter(c: Ctx, x: number, y: number, z: number): void {
  c.out.push(xf(box(0.7, 0.38, 0.42, "#6d5946", M.planks), x, y + 0.19, z));
  c.out.push(xf(box(0.74, 0.05, 0.46, "#5b4836", M.planks), x, y + 0.38, z));
  c.layout.spot(x, z, 0.18, 4, ["pink", "daisy", "poppy", "yellow"], y + 0.38, 0.7);
  c.colliders.push({ x, z, r: 0.4, top: y + 0.45 });
}

function pierClutter(c: Ctx): void {
  const Z = PIER.z, y = PIER.deck;
  const N = Z + PIER.half - 0.5, S = Z - PIER.half + 0.5;
  // Crates against the north rail.
  crate(c, -72.3, y, N, 0.55, 0.05);
  crate(c, -71.7, y, N, 0.55, -0.08);
  crate(c, -72.0, y + 0.55, N, 0.5, 0.3);
  c.colliders.push({ x: -72.3, z: N, r: 0.36, top: y + 1.1 }, { x: -71.7, z: N, r: 0.36, top: y + 1.1 });
  c.layout.perches.push([-72.0, y + 1.06, N, 0.4]);
  // Barrels by the south rail, one on its side.
  barrel(c, -66.3, y, S);
  barrel(c, -65.7, y, S + 0.05);
  barrel(c, -67.2, y, S + 0.02, true);
  c.colliders.push({ x: -66.3, z: S, r: 0.32, top: y + 0.85 }, { x: -65.7, z: S, r: 0.32, top: y + 0.85 }, { x: -67.2, z: S, r: 0.4, top: y + 0.55 });
  // A heaped net with floats on it.
  const net = prep(blob(0.6, 1, 0.3, 4.2), "#3f5048", M.plain);
  net.scale(1.6, 0.42, 0.95);
  c.out.push(xf(net, -52.5, y + 0.12, N - 0.05));
  floatsPile(c, -52.3, y + 0.12, N - 0.05, 4);
  c.colliders.push({ x: -52.5, z: N - 0.05, r: 0.6, top: y + 0.45 });
  ropeCoil(c, -47, y, S);
  c.colliders.push({ x: -47, z: S, r: 0.35, top: y + 0.25 });
  // Lobster pots, two side by side with one on top.
  lobsterPot(c, -37.4, y, N, 0.05);
  lobsterPot(c, -36.7, y, N, -0.04);
  lobsterPot(c, -37.05, y + 0.33, N, 0.2);
  c.colliders.push({ x: -37.4, z: N, r: 0.35, top: y + 0.7 }, { x: -36.7, z: N, r: 0.35, top: y + 0.7 });
  // Floats hung on short ropes outside the north rail.
  const rz = Z + PIER.half + 0.06;
  for (let i = 0; i < 4; i++) {
    const x = -41.6 + i * 0.55, hang = range(c.r, 0.25, 0.45);
    c.out.push(beam(V(x, y + 1.0, rz), V(x, y + 1.0 - hang, rz + 0.04), 0.008, "#cdbf9a", M.plain, 3));
    c.out.push(xf(sphere(0.12, pick(c.r, FLOATS), M.plain, 10, 7), x, y + 1.0 - hang - 0.1, rz + 0.05));
  }
  // Planters at the feet of the two landward lamps.
  planter(c, -57.45, y, Z - PIER.half + 0.38);
  planter(c, -23.45, deckH(-23.45), Z + PIER.half - 0.38);
  // Gulls rest on rail posts and lamp heads along the pier (posts every 1.7 m from the end).
  const post = (x: number) => PIER.x1 + 0.08 + Math.round((x - PIER.x1 - 0.08) / 1.7) * 1.7;
  // The first is the north end post, seen from the opening beside the view out to sea.
  for (const [x, s] of [[-94, 1], [-60.4, 1], [-45.1, -1], [-30.0, 1], [-62.1, -1]] as const) c.layout.perches.push([post(x), y + 1.02, Z + s * (PIER.half - 0.06), Math.PI / 2]);
  c.layout.perches.push([-58, y + 3.42, Z - PIER.half + 0.16 + 0.42, 0], [-24, y + 3.42, Z + PIER.half - 0.16 - 0.42, Math.PI]);
}

/** Fishing shed on the sand north of the pier root: boards, a tin lean-to roof, window, gear. */
function shed(c: Ctx, boxes: Box[]): void {
  const z = -179.2, u = -10.9, x = roadX(z) + u;
  const W = 2.6, D = 3.2, H0 = 2.15, H1 = 2.65;
  const g = Math.min(meshH(x - W / 2, z), meshH(x + W / 2, z), meshH(x, z - D / 2), meshH(x, z + D / 2)) - 0.12;
  const { out } = c;
  // Stone footing, board walls, lean-to roof falling toward the sea (-x).
  out.push(xf(box(W + 0.2, 0.35, D + 0.2, "#9a948a", M.stone), x, g + 0.1, z));
  out.push(xf(box(W, H0, D, "#5a4636", M.planks), x, g + 0.25 + H0 / 2, z));
  const rise = H1 - H0;
  const gable = new THREE.Shape([new THREE.Vector2(-W / 2, 0), new THREE.Vector2(W / 2, 0), new THREE.Vector2(W / 2, rise)]);
  const gg = new THREE.ExtrudeGeometry(gable, { depth: D, bevelEnabled: false });
  gg.translate(0, 0, -D / 2);
  out.push(xf(prep(gg, "#5a4636", M.planks), x, g + 0.25 + H0, z));
  const tilt = Math.atan2(rise, W);
  const L = W / Math.cos(tilt) + 0.6;
  out.push(xf(box(L, 0.06, D + 0.5, "#5f7f86", M.metal), x - 0.05, g + 0.25 + H0 + rise / 2 + 0.04, z, 0, 0, tilt));
  for (let k = 0; k < 9; k++) out.push(xf(box(L, 0.04, 0.05, "#4f6a70", M.metal), x - 0.05, g + 0.25 + H0 + rise / 2 + 0.09, z - D / 2 - 0.2 + k * ((D + 0.4) / 8), 0, 0, tilt));
  // Window to the sea, door on the north side, a lifebuoy and floats on the walls.
  out.push(xf(box(0.08, 0.6, 0.8, "#20262c", M.glass), x - W / 2 - 0.03, g + 1.5, z - 0.6));
  out.push(xf(box(0.1, 0.08, 0.96, "#d8d0bc"), x - W / 2 - 0.05, g + 1.84, z - 0.6));
  out.push(xf(box(0.1, 0.08, 0.96, "#d8d0bc"), x - W / 2 - 0.05, g + 1.17, z - 0.6));
  out.push(xf(box(0.9, 1.9, 0.08, "#6d5a48", M.planks), x + 0.3, g + 0.25 + 0.95, z + D / 2 + 0.03));
  for (let i = 0; i < 8; i++) {
    const t = new THREE.TorusGeometry(0.28, 0.065, 6, 4, Math.PI / 4);
    t.rotateZ((i * Math.PI) / 4);
    t.rotateY(Math.PI / 2);
    out.push(xf(prep(t, i % 2 ? "#f2eee6" : "#d0493c", M.plain), x - W / 2 - 0.1, g + 1.55, z + 0.75));
  }
  for (let i = 0; i < 3; i++) out.push(xf(sphere(0.13, pick(c.r, FLOATS), M.plain, 10, 7), x - 0.4 + i * 0.4, g + 1.55, z - D / 2 - 0.12));
  // Oars leaning on the south wall.
  for (const o of [0, 0.35]) out.push(beam(V(x + 0.3 + o, g + 0.05, z - D / 2 - 0.45), V(x + 0.45 + o, g + 2.1, z - D / 2 - 0.06), 0.03, "#b89a6a", M.planks, 5));
  boxes.push({ x0: x - W / 2 - 0.15, x1: x + W / 2 + 0.15, z0: z - D / 2 - 0.15, z1: z + D / 2 + 0.15, top: g + 0.25 + H1 });
  c.colliders.push({ x, z, r: Math.min(W, D) / 2 + 0.25, top: g + H1, kind: "house" });
  c.layout.rect(x - W / 2 - 0.4, x + W / 2 + 0.4, z - D / 2 - 0.4, z + D / 2 + 0.4);
  c.layout.perches.push([x - W / 2 + 0.2, g + 0.25 + H0 + 0.1, z, Math.PI / 2]);
  // Gear round it: pots, crates and floats.
  const by = meshH(x + 0.2, z - D / 2 - 1.1);
  lobsterPot(c, x - 0.5, by, z - D / 2 - 1.0, 0.3);
  lobsterPot(c, x + 0.25, by, z - D / 2 - 1.15, -0.2);
  crate(c, x + W / 2 + 0.6, meshH(x + W / 2 + 0.6, z + 0.8), z + 0.8, 0.5, 0.4);
  floatsPile(c, x - W / 2 - 0.8, meshH(x - W / 2 - 0.8, z + 1.2), z + 1.2, 6);
  c.colliders.push({ x: x - 0.1, z: z - D / 2 - 1.05, r: 0.55, top: by + 0.4 }, { x: x + W / 2 + 0.6, z: z + 0.8, r: 0.38, top: meshH(x + W / 2 + 0.6, z + 0.8) + 0.55 });
  c.layout.spot(x + W / 2 + 0.6, z - 1.0, 1.1, 7, ["thrift", "thrift", "yellow"]);
}

/** A white rowboat drawn up on the sand, rolled onto its bilge, oars across the thwarts. */
function rowboat(c: Ctx): void {
  const z = -185.5, u = -15.8, x = roadX(z) + u;
  const g = meshH(x, z);
  const hull = new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  hull.scale(1.3, 0.48, 0.62);
  const m = new THREE.Matrix4().compose(V(x, g + 0.36, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 0.5, 0.06, "YXZ")), V(1, 1, 1));
  c.hull.push(prep(hull, "#eeeae0", M.plain).applyMatrix4(m));
  const inner: Geo[] = [
    xf(box(1.9, 0.04, 0.6, "#9a7d5c", M.planks), 0, -0.36, 0),
    xf(box(0.22, 0.04, 1.05, "#8a6f52", M.planks), -0.35, -0.12, 0),
    xf(box(0.22, 0.04, 0.9, "#8a6f52", M.planks), 0.5, -0.14, 0),
    beam(V(-0.9, -0.08, -0.25), V(0.9, -0.05, 0.3), 0.025, "#b89a6a", M.planks, 5),
  ];
  const band = new THREE.TorusGeometry(1, 0.03, 4, 28);
  band.rotateX(Math.PI / 2);
  band.scale(1.3, 1, 0.62);
  inner.push(prep(band, "#3d7f86", M.plain));
  for (const p of inner) c.out.push(p.applyMatrix4(m));
  for (const o of [-0.8, 0, 0.8]) c.colliders.push({ x: x + Math.cos(0.5) * o, z: z - Math.sin(0.5) * o, r: 0.6, top: g + 0.8 });
  c.layout.spot(x + 1.6, z + 1.2, 1.2, 6, ["thrift", "yellow"]);
}

export function buildHarbour(layout: Layout, colliders: Collider[], boxes: Box[]): THREE.Group {
  const c: Ctx = { out: [], hull: [], r: mulberry32(8181), colliders, layout };
  pierClutter(c);
  shed(c, boxes);
  rowboat(c);
  // Thrift and dune flowers on the sand at the pier root, either side of the deck.
  for (const dz of [-3.2, 3.4]) {
    const z = PIER.z + dz, x = roadX(z) - 8.6;
    layout.spot(x, z, 1.6, 10, ["thrift", "thrift", "yellow", "daisy"]);
  }
  const group = new THREE.Group();
  group.name = "harbour";
  const gear = new THREE.Mesh(merge(c.out), uber(ID.pier, 1));
  const boat = new THREE.Mesh(merge(c.hull), uber(ID.pier, 1, THREE.DoubleSide));
  for (const m of [gear, boat]) {
    onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
    group.add(m);
  }
  return group;
}
