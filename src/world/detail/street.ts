import * as THREE from "three";
import { ID, M, beam, blob, box, cyl, merge, prep, wire, xf } from "../geo";
import { mulberry32, range, type Rng } from "../../core/rng";
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { ROAD_Z1, roadDX, roadX } from "../bay/road";
import { WALL_IN, meshH } from "../bay/terrain";
import type { Collider } from "../bay";
import type { Layout } from "../../flora/place";
import { PATHS, VIEW_BENCHES } from "./paths";

type Geo = THREE.BufferGeometry;
type V3 = THREE.Vector3;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * The coast road's furniture: wooden utility poles with crossarms and insulators carrying sagging
 * wires along the hill side of the road (and service drops into the town), street lamps on the
 * verge and the promenade, benches facing the sea, road signs with symbols only, a hazard-striped
 * barrier where the road ends, white rails at the pier root and the harbour slipway, post-and-rail
 * fences and dry-stone walls on the hill. Grass and flowers are asked for round their feet.
 */

/** Yaw that turns local +x across the road (inland, (1, -roadDX) in x, z) at z. */
const acrossYaw = (z: number) => Math.atan(roadDX(z));

/** Place a local-space geometry: local x across the road (inland), z along it, at road (u, z). */
function onRoad(g: Geo, u: number, z: number, y: number, extraYaw = 0): Geo {
  return xf(g, roadX(z) + u, y, z, 0, acrossYaw(z) + extraYaw, 0);
}

/** Utility pole: local crossarms along x (across the road). Returns the wire tips, local. */
function pole(h: number, transformer: boolean): { geo: Geo[]; tips: V3[] } {
  const out: Geo[] = [];
  out.push(beam(V(0, -0.4, 0), V(0, h, 0), 0.15, "#6e5d49", M.bark, 8, 0.12));
  const guard = cyl(0.17, 0.17, 1.8, "#ffffff", M.guard, 10);
  guard.translate(0, 0.9, 0);
  out.push(guard);
  out.push(xf(box(1.8, 0.12, 0.12, "#4a3d30"), 0, h - 0.5, 0));
  out.push(xf(box(1.15, 0.1, 0.1, "#4a3d30"), 0, h - 1.3, 0));
  const tips: V3[] = [];
  for (const x of [-0.72, 0, 0.72]) {
    out.push(xf(cyl(0.05, 0.06, 0.16, "#dcdcd4", M.metal, 6), x, h - 0.36, 0));
    tips.push(V(x, h - 0.28, 0));
  }
  for (const x of [-0.46, 0.46]) {
    out.push(xf(cyl(0.04, 0.05, 0.12, "#dcdcd4", M.metal, 6), x, h - 1.18, 0));
    tips.push(V(x, h - 1.12, 0));
  }
  out.push(beam(V(-0.62, h - 0.55, 0), V(0, h - 1.1, 0), 0.03, "#4a4a4a", M.metal, 4));
  out.push(beam(V(0.62, h - 0.55, 0), V(0, h - 1.1, 0), 0.03, "#4a4a4a", M.metal, 4));
  if (transformer) {
    out.push(xf(cyl(0.28, 0.28, 0.8, "#8f959a", M.metal, 12), 0, h - 2.6, 0.36));
    out.push(xf(cyl(0.3, 0.3, 0.06, "#747a7e", M.metal, 12), 0, h - 2.18, 0.36));
  }
  // Step bolts up the pole.
  for (let y = 2.2; y < h - 1.5; y += 0.45) out.push(xf(box(0.22, 0.03, 0.03, "#555555"), 0, y, 0, 0, y * 2.0));
  return { geo: out, tips };
}

/** Street lamp: post, swan-neck arm reaching over the road (local -x) and a lamp head that glows at night. */
function streetLamp(h: number): Geo[] {
  const out: Geo[] = [];
  out.push(xf(cyl(0.12, 0.15, 0.4, "#2f4a45", M.metal, 8), 0, 0.2, 0));
  out.push(beam(V(0, 0, 0), V(0, h, 0), 0.07, "#2f4a45", M.metal, 8, 0.05));
  out.push(beam(V(0, h - 0.05, 0), V(-0.55, h + 0.25, 0), 0.04, "#2f4a45", M.metal, 5));
  out.push(beam(V(-0.55, h + 0.25, 0), V(-1.05, h + 0.12, 0), 0.04, "#2f4a45", M.metal, 5));
  out.push(xf(cyl(0.22, 0.08, 0.16, "#2f4a45", M.metal, 10), -1.1, h + 0.04, 0));
  out.push(xf(cyl(0.15, 0.12, 0.14, "#ffe2a0", M.glow, 10), -1.1, h - 0.1, 0));
  return out;
}

/** Bench facing local -x: slatted seat and back, cast-iron ends. */
function bench(): Geo[] {
  const out: Geo[] = [];
  for (let i = 0; i < 3; i++) out.push(xf(box(0.12, 0.04, 1.7, "#a07a52", M.planks), -0.15 + i * 0.14, 0.45, 0));
  for (let i = 0; i < 2; i++) out.push(xf(box(0.04, 0.11, 1.7, "#a07a52", M.planks), 0.2 + i * 0.02, 0.62 + i * 0.16, 0, 0, 0, -0.2));
  for (const z of [-0.72, 0.72]) {
    out.push(xf(box(0.5, 0.06, 0.06, "#2f3335", M.metal), 0, 0.42, z));
    out.push(xf(box(0.06, 0.45, 0.06, "#2f3335", M.metal), -0.18, 0.22, z));
    out.push(xf(box(0.06, 0.9, 0.06, "#2f3335", M.metal), 0.2, 0.45, z, 0, 0, -0.2));
  }
  return out;
}

/** Sign post with a symbol board facing local -z (toward oncoming traffic). Symbols only, no text. */
function sign(kind: "curveL" | "curveR" | "fork" | "keep" | "noEntry" | "harbour"): Geo[] {
  const out: Geo[] = [xf(cyl(0.035, 0.035, 2.5, "#b8bcc0", M.metal, 6), 0, 1.25, 0.03)];
  const ink = "#1b1814";
  const y = 2.3;
  const at = (g: Geo, x: number, yy: number, rz = 0) => out.push(xf(g, x, yy, -0.045, 0, 0, rz));
  if (kind === "curveL" || kind === "curveR" || kind === "fork") {
    out.push(xf(box(0.62, 0.62, 0.03, "#eeb622", M.metal), 0, y, -0.01, 0, 0, Math.PI / 4));
    out.push(xf(box(0.7, 0.7, 0.02, ink, M.metal), 0, y, 0.01, 0, 0, Math.PI / 4));
    if (kind === "fork") {
      at(box(0.07, 0.26, 0.02, ink), 0, y - 0.12);
      at(box(0.06, 0.2, 0.02, ink), -0.07, y + 0.08, 0.55);
      at(box(0.06, 0.2, 0.02, ink), 0.07, y + 0.08, -0.55);
    } else {
      const s = kind === "curveL" ? 1 : -1;
      at(box(0.07, 0.3, 0.02, ink), -0.02 * s, y - 0.12);
      at(box(0.07, 0.22, 0.02, ink), 0.06 * s, y + 0.09, -0.6 * s);
      at(box(0.16, 0.05, 0.02, ink), 0.12 * s, y + 0.18, -0.6 * s);
    }
  } else if (kind === "keep") {
    const d = cyl(0.32, 0.32, 0.03, "#2a62b0", M.metal, 20);
    d.rotateX(Math.PI / 2);
    out.push(xf(d, 0, y, -0.01));
    at(box(0.07, 0.32, 0.02, "#f4f2ea"), 0.04, y - 0.04, -0.75);
    at(box(0.2, 0.06, 0.02, "#f4f2ea"), -0.06, y + 0.1, -0.75);
  } else if (kind === "noEntry") {
    const d = cyl(0.34, 0.34, 0.03, "#c8302c", M.metal, 20);
    d.rotateX(Math.PI / 2);
    out.push(xf(d, 0, y, -0.01));
    at(box(0.44, 0.11, 0.02, "#f4f2ea"), 0, y);
  } else {
    // Harbour: a blue square board with a white boat and a wave line.
    out.push(xf(box(0.66, 0.66, 0.03, "#2a62b0", M.metal), 0, y, -0.01));
    const hull = new THREE.Shape();
    hull.moveTo(-0.22, 0.02);
    hull.lineTo(0.22, 0.02);
    hull.lineTo(0.15, -0.08);
    hull.lineTo(-0.15, -0.08);
    hull.closePath();
    at(prep(new THREE.ShapeGeometry(hull), "#f4f2ea", M.plain).rotateY(Math.PI) as Geo, 0, y);
    at(box(0.025, 0.2, 0.02, "#f4f2ea"), 0, y + 0.12);
    at(box(0.4, 0.03, 0.02, "#f4f2ea"), 0, y - 0.17);
  }
  return out;
}

interface Ctx {
  out: Geo[];
  wires: Geo[];
  stone: Geo[];
  r: Rng;
  layout: Layout;
  colliders: Collider[];
}

/** Colliders every 0.55 m along a-b (fences, walls, rails): she can't slip between the posts. */
function wallColliders(c: Ctx, ax: number, az: number, bx: number, bz: number, top: number): void {
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 0.55));
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    c.colliders.push({ x, z, r: 0.3, top: meshH(x, z) + top });
  }
}

/** Post-and-rail fence along world a → b on the ground (two rails, posts every ~1.8 m). */
function fence(c: Ctx, ax: number, az: number, bx: number, bz: number, color: string): void {
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(L / 1.8));
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    const g = meshH(x, z);
    pts.push(V(x, g, z));
    c.out.push(xf(box(0.1, 1.15, 0.1, color, M.bark), x, g + 0.5, z, range(c.r, -0.04, 0.04), range(c.r, -0.2, 0.2), range(c.r, -0.04, 0.04)));
    if (i % 2 === 0) c.layout.spot(x, z, 0.55, 3, ["daisy", "weed", "yellow", "poppy", "fern"]);
    if (i % 5 === 2) c.layout.perches.push([x, g + 1.12, z, c.r() * 6.28]);
  }
  for (let i = 0; i < n; i++)
    for (const hgt of [0.95, 0.5]) c.out.push(beam(pts[i].clone().setY(pts[i].y + hgt), pts[i + 1].clone().setY(pts[i + 1].y + hgt), 0.04, color, M.bark, 4));
  wallColliders(c, ax, az, bx, bz, 1.1);
  c.layout.seg(ax, az, bx, bz, 0.25);
}

/** Dry-stone wall along a polyline: rough stones in two courses with a cap, ~0.75 m high. */
function stoneWall(c: Ctx, pts: [number, number][]): void {
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    for (let s = 0; s < L; s += range(c.r, 0.32, 0.46)) {
      const x = ax + dx * s, z = az + dz * s, g = meshH(x, z);
      for (const [yy, rr] of [[0.18, 0.3], [0.48, 0.26], [0.7, 0.22]] as const) {
        const st = prep(blob(rr * range(c.r, 0.85, 1.2), 1, 0.25, c.r() * 90), c.r() < 0.5 ? "#9a9488" : "#8a857c", M.stone);
        st.scale(range(c.r, 1.1, 1.5), range(c.r, 0.7, 0.9), 1);
        c.stone.push(xf(st, x + range(c.r, -0.06, 0.06), g + yy, z + range(c.r, -0.06, 0.06), 0, Math.atan2(-dz, dx) + range(c.r, -0.3, 0.3), 0));
      }
      if (c.r() < 0.28) c.layout.spot(x + dz * 0.5 * (c.r() < 0.5 ? 1 : -1), z - dx * 0.5, 0.55, 3, ["fern", "weed", "daisy", "poppy", "yellow"]);
    }
    wallColliders(c, ax, az, bx, bz, 0.8);
    c.layout.seg(ax, az, bx, bz, 0.5);
  }
}

/** White rail along the promenade's sea edge (posts and two rails), world z from z0 to z1. */
function rail(c: Ctx, z0: number, z1: number): void {
  const u = WALL_IN + 0.14;
  const n = Math.max(1, Math.round(Math.abs(z1 - z0) / 1.5));
  const pts: V3[] = [];
  for (let i = 0; i <= n; i++) {
    const z = z0 + ((z1 - z0) * i) / n, x = roadX(z) + u;
    pts.push(V(x, 0, z));
    c.out.push(xf(box(0.08, 1.0, 0.08, "#eee8dc", M.plain), x, 0.5, z));
  }
  for (let i = 0; i < n; i++)
    for (const [h, rr] of [[1.0, 0.04], [0.52, 0.028]] as const) c.out.push(beam(pts[i].clone().setY(h), pts[i + 1].clone().setY(h), rr, "#eee8dc", M.plain, 5));
  wallColliders(c, pts[0].x, z0, pts[n].x, z1, 1.0);
}

export function buildStreet(layout: Layout, colliders: Collider[]): THREE.Group {
  const c: Ctx = { out: [], wires: [], stone: [], r: mulberry32(2323), layout, colliders };
  const { out } = c;

  // Utility poles along the hill side of the road, wires sagging between them.
  const POLE_U = 4.3, H = 8.6;
  const poles: { z: number; tips: V3[] }[] = [];
  for (let z = ROAD_Z1 + 6, i = 0; z < 168; z += 34, i++) {
    const p = pole(H, i % 4 === 1);
    const g = meshH(roadX(z) + POLE_U, z);
    const yaw = acrossYaw(z);
    const m = new THREE.Matrix4().compose(V(roadX(z) + POLE_U, g, z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), yaw), V(1, 1, 1));
    for (const gg of p.geo) out.push(gg.applyMatrix4(m));
    poles.push({ z, tips: p.tips.map((t) => t.clone().applyMatrix4(m)) });
    colliders.push({ x: roadX(z) + POLE_U, z, r: 0.2, top: g + H });
    layout.spot(roadX(z) + POLE_U + 0.5, z, 0.8, 5, ["weed", "daisy", "yellow", "fern"]);
    // A gull's perch on the crossarm, between the insulators.
    const pp = V(0.36, H - 0.44, 0).applyMatrix4(m);
    layout.perches.push([pp.x, pp.y, pp.z, yaw + Math.PI / 2]);
  }
  for (let i = 0; i + 1 < poles.length; i++)
    for (let k = 0; k < 5; k++) {
      const a = poles[i].tips[k], b = poles[i + 1].tips[k];
      c.wires.push(...wire(a, b, range(c.r, 0.55, 0.85) * (k < 3 ? 1 : 1.15), 0.012, "#2a2a2a", 10));
    }
  // Service drops from the harbour poles to the waterfront houses' eaves, and up the main lane.
  const drop = (a: V3, b: V3) => c.wires.push(...wire(a, b, 0.35 + a.distanceTo(b) * 0.012, 0.01, "#2a2a2a", 8));
  // [pole z, house u, house centre z, house width, where on its front wall the wire lands].
  const DROPS: [number, number, number, number, number][] = [
    [-156, 14, -150, 7, -152], [-156, 13.5, -160.5, 6.5, -158.5], [-190, 14, -192, 7, -190.2],
    [-190, 14, -192, 7, -194], [-224, 15, -218, 7.5, -219.5], [-224, 15, -218, 7.5, -216.5],
  ];
  for (const [pz, u, hz, w, z] of DROPS) {
    const p = poles.find((q) => Math.abs(q.z - pz) < 1);
    if (!p) continue;
    const x = roadX(hz) + u - w / 2 - 0.03;
    drop(p.tips[3], V(x, meshH(x, z) + 3.7, z));
  }
  {
    const z = -183.4;
    const lp = [19.6, 31, 43].map((u) => {
      const x = roadX(z) + u, g = meshH(x, z);
      out.push(beam(V(x, g - 0.3, z), V(x, g + 6.2, z), 0.12, "#6e5d49", M.bark, 7, 0.1));
      out.push(xf(box(0.12, 0.1, 0.9, "#4a3d30"), x, g + 5.8, z));
      colliders.push({ x, z, r: 0.17, top: g + 6.2 });
      layout.spot(x, z - 0.4, 0.5, 3, ["fern", "weed", "daisy"]);
      return V(x, g + 5.85, z);
    });
    const p = poles.find((q) => Math.abs(q.z + 190) < 1);
    if (p) drop(p.tips[4], lp[0]);
    drop(lp[0], lp[1]);
    drop(lp[1], lp[2]);
    for (const [i, u, zz] of [[0, 24.5, -177.6], [1, 37, -188.8], [2, 50, -189.6], [1, 38, -174.1]] as const) drop(lp[i], V(roadX(zz) + u, meshH(roadX(zz) + u, zz) + 3.5, zz));
  }

  // Street lamps on the hill verge (between the poles), flowers and grass round their feet.
  for (const z of [-200, -165, -130, -95, -60, -25, 10, 45, 72, 104, 138]) {
    const u = 4.05, x = roadX(z) + u, g = meshH(x, z);
    for (const gg of streetLamp(4.4)) out.push(onRoad(gg, u, z, g));
    colliders.push({ x, z, r: 0.17, top: g + 4.6 });
    layout.spot(x + 0.4, z, 1.0, 9, ["daisy", "yellow", "weed", "fern", "pink", "poppy"]);
  }
  // Promenade: lamps with planters at their feet, benches facing the sea.
  for (const z of [-150, -100, -40, 30, 100]) {
    const u = WALL_IN + 0.55;
    for (const gg of streetLamp(3.8)) out.push(onRoad(gg, u, z, 0, Math.PI));
    colliders.push({ x: roadX(z) + u, z, r: 0.17, top: 4 });
    const pz = z + 0.7;
    out.push(onRoad(box(0.5, 0.42, 0.5, "#b7ae9c", M.stone), u, pz, 0.21));
    layout.spot(roadX(pz) + u, pz, 0.15, 3, ["daisy", "pink", "yellow", "poppy"], 0.42, 0.7);
    colliders.push({ x: roadX(pz) + u, z: pz, r: 0.3, top: 0.45 });
    const bz = z + 3;
    for (const gg of bench()) out.push(onRoad(gg, -4.75, bz, 0));
    for (const o of [-0.6, 0.6]) colliders.push({ x: roadX(bz + o) - 4.75, z: bz + o, r: 0.32, top: 0.9 });
    layout.perches.push([roadX(bz) - 4.55, 0.86, bz, Math.PI / 2]);
  }
  // Viewpoint benches on the hill paths, facing the sea.
  for (const [u, z] of VIEW_BENCHES) {
    const g = meshH(roadX(z) + u, z);
    for (const gg of bench()) out.push(onRoad(gg, u, z, g - 0.02));
    for (const o of [-0.6, 0.6]) colliders.push({ x: roadX(z + o) + u, z: z + o, r: 0.32, top: g + 0.9 });
    layout.rect(roadX(z) + u - 0.6, roadX(z) + u + 0.6, z - 1.1, z + 1.1);
    layout.spot(roadX(z) + u + 1.2, z - 1.4, 1.2, 9, ["lavender", "daisy", "yellow"]);
  }

  // Signs: curves, the fork into the town lane, keep-left at the pier, no entry at the road's end.
  const signAt = (kind: Parameters<typeof sign>[0], u: number, z: number, facingNorth: boolean) => {
    const g = meshH(roadX(z) + u, z);
    for (const gg of sign(kind)) out.push(onRoad(gg, u, z, g, facingNorth ? Math.PI : 0));
    colliders.push({ x: roadX(z) + u, z, r: 0.12, top: g + 2.6 });
    layout.spot(roadX(z) + u, z, 0.5, 3, ["weed", "daisy", "yellow"]);
  };
  signAt("curveR", 4.1, 122, false);
  signAt("curveL", 4.1, -112, true);
  signAt("fork", 4.2, -177.5, true);
  signAt("keep", 4.15, -196, false);
  signAt("harbour", WALL_IN + 0.8, -188.6, true);
  // The road ends at the harbour: a no-entry sign and striped barriers across it.
  signAt("noEntry", 3.1, ROAD_Z1 - 1.5, true);
  for (const u of [-2.6, -0.9, 0.8, 2.5]) {
    const z = ROAD_Z1 - 2.5;
    const b = box(1.6, 0.8, 0.45, "#ffffff", M.guard);
    out.push(onRoad(b, u, z, 0.4));
    colliders.push({ x: roadX(z) + u, z, r: 0.5, top: 0.8 });
  }

  // White rails along the promenade edge either side of the pier root and the harbour slipway.
  rail(c, -186.2, -191.3);
  rail(c, -194.7, -203.3);
  rail(c, -206.7, -212);

  // Hill fences and dry-stone walls, with gaps where the paths cross.
  const W = (u: number, z: number): [number, number] => [roadX(z) + u, z];
  fence(c, ...W(7.4, -100), ...W(7.4, -58), "#7a6650");
  fence(c, ...W(44, 66), ...W(44, 98), "#7a6650");
  stoneWall(c, [W(62, -112), W(63.5, -92), W(64, -70), W(65.5, -52), W(66, -40)]);
  stoneWall(c, [W(30, 57), W(30.5, 75), W(31, 95)]);
  stoneWall(c, [W(54, -186.6), W(57.5, -186.6)]);

  // Paths: flowers along the edges, grass kept off the tread.
  for (const p of PATHS) {
    layout.line(p, 0.85);
    for (let k = 0; k + 1 < p.length; k++) {
      const [ax, az] = p[k], [bx, bz] = p[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s < L; s += range(c.r, 2.2, 4.2)) {
        const t = s / L, side = c.r() < 0.5 ? -1 : 1;
        const nx = -(bz - az) / L, nz = (bx - ax) / L;
        layout.spot(ax + (bx - ax) * t + nx * side * 1.25, az + (bz - az) * t + nz * side * 1.25, 0.6, 3, ["daisy", "yellow", "lavender", "poppy", "pink"]);
      }
    }
  }

  const group = new THREE.Group();
  group.name = "street";
  const furniture = new THREE.Mesh(merge(out), uber(ID.pole, 1));
  onLayers(furniture, LAYER_SHADOW, LAYER_REFLECT);
  const walls = new THREE.Mesh(merge(c.stone), uber(ID.berm, 0.8));
  onLayers(walls, LAYER_SHADOW);
  // Wires draw no ink of their own: they are already thin dark lines.
  const wires = new THREE.Mesh(merge(c.wires), uber(ID.wire, 0));
  onLayers(wires, LAYER_SHADOW);
  group.add(furniture, walls, wires);
  return group;
}
