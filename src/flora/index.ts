import * as THREE from "three";
import { mulberry32, range } from "../core/rng";
import { SEA_Y, roadX } from "../world/bay/road";
import { LIGHTHOUSE, coastH, headlandsH, poolUnder, poolsDone } from "../world/bay/terrain";
import type { Collider } from "../world/bay";
import { FLORA } from "./glsl";
import { Flowers } from "./flowers";
import { Meadow } from "./meadow";
import { groundY, slopeAt, uOf, type Layout } from "./place";
import { buildTrees, type TreeKind, type TreeRegion, type TreeSpot } from "./trees";

/**
 * All the growing things: trees and shrubs (merged per region), the meadow grass (chunked
 * instances with distance thinning) and the flower drifts (repacked round the camera). Built after
 * the town and props have claimed their ground in the layout.
 */

/** Quality tiers: grass density multiplier, grass reach, flower reach. */
export const TIERS = {
  low: { grass: 0.55, far: [16, 38, 70, 95], flowers: [45, 60] },
  med: { grass: 0.8, far: [19, 44, 85, 120], flowers: [58, 78] },
  high: { grass: 1, far: [22, 50, 100, 140], flowers: [70, 95] },
} as const;
export type Tier = keyof typeof TIERS;

export function setTier(t: Tier): void {
  const q = TIERS[t];
  FLORA.uGrassK.value = q.grass;
  FLORA.uGrassFar.value.set(q.far[0], q.far[1], q.far[2], q.far[3]);
  FLORA.uFlowerFar.value.set(q.flowers[0], q.flowers[1]);
}

/** Hill copses and singles, roadside trees, headland and island pines, scattered shrubs. */
function wildTrees(layout: Layout): TreeRegion[] {
  const r = mulberry32(6060);
  const seed = () => Math.floor(r() * 1e9);
  const south: TreeSpot[] = [], north: TreeSpot[] = [], hn: TreeSpot[] = [], hs: TreeSpot[] = [], island: TreeSpot[] = [];
  const hill = (z: number) => (z < -40 ? south : north);
  const ok = (x: number, z: number, pad: number, maxSlope = 0.32) => layout.free(x, z, pad) && slopeAt(x, z) < maxSlope;
  const onHill = (x: number, z: number) => headlandsH(x, z) < coastH(uOf(x, z), z) + 0.5;
  const placed: { x: number; z: number }[] = [];
  const roomy = (x: number, z: number, d: number) => placed.every((p) => (p.x - x) ** 2 + (p.z - z) ** 2 > d * d);
  /** A wood: 5-14 trees strung irregularly along an axis, shrubs along its skirts. */
  const wood = (x: number, z: number, ang: number, len: number, n: number, wid: number) => {
    const ax = Math.cos(ang), az = Math.sin(ang);
    // Each wood has a character: broadleaf, a conifer stand, or mixed with poplars.
    const mood = r();
    const pick = (): TreeKind => {
      const q = r();
      if (mood < 0.55) return q < 0.12 ? "conifer" : q < 0.36 ? "tall" : "round";
      if (mood < 0.75) return q < 0.7 ? "conifer" : q < 0.85 ? "pine" : "round";
      return q < 0.35 ? "poplar" : q < 0.5 ? "conifer" : q < 0.7 ? "tall" : "round";
    };
    for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
      const s = range(r, -0.5, 0.5) * len, w = (r() + r() + r() - 1.5) * wid;
      const tx = x + ax * s - az * w, tz = z + az * s + ax * w;
      // Sizes skew small with the odd giant; spacing follows size so crowns crowd and overlap.
      const sc = r() < 0.12 ? range(r, 1.35, 1.6) : 0.6 + Math.pow(r(), 1.4) * 0.7;
      if (!onHill(tx, tz) || !ok(tx, tz, 2.5) || !roomy(tx, tz, 2.3 + sc * 1.2)) continue;
      i++;
      placed.push({ x: tx, z: tz });
      hill(tz).push({ x: tx, z: tz, kind: pick(), scale: sc, seed: seed() });
    }
    for (let i = 0; i < n; i++) {
      const s = range(r, -0.6, 0.6) * len, w = (r() < 0.5 ? -1 : 1) * range(r, wid * 0.8, wid * 1.8);
      const tx = x + ax * s - az * w, tz = z + az * s + ax * w;
      if (onHill(tx, tz) && ok(tx, tz, 1)) hill(tz).push({ x: tx, z: tz, kind: "bush", scale: range(r, 0.8, 1.4), seed: seed() });
    }
    layout.spot(x + range(r, -6, 6), z + range(r, -6, 6), 3, 14, ["daisy", "pink", "fern", "lavender"]);
  };
  // Woods over the hill, in belts and clumps, most following the slope's contours.
  for (let k = 0, tries = 0; k < 17 && tries < 600; tries++) {
    const z = range(r, -270, 235), u = range(r, 50, 165), x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 4)) continue;
    k++;
    const belt = r() < 0.55;
    wood(x, z, Math.PI / 2 + range(r, -0.5, 0.5), belt ? range(r, 28, 50) : range(r, 10, 18), 5 + Math.floor(r() * (belt ? 10 : 6)), belt ? 3.2 : 5);
  }
  // A wood on the slope above the town, so the roofs sit against trees.
  wood(roadX(-195) + 92, -195, Math.PI / 2, 80, 18, 9);
  wood(roadX(-160) + 118, -160, Math.PI / 2 + 0.3, 40, 10, 6);
  // Hedgerows on the uphill side of the dry-stone walls and the north fence, a tree now and then.
  const hedge = (pts: [number, number][]) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [u0, z0] = pts[i], [u1, z1] = pts[i + 1];
      const len = Math.hypot(u1 - u0, z1 - z0), m = Math.max(1, Math.round(len / 1.7));
      for (let j = 0; j < m; j++) {
        const t = (j + r() * 0.5) / m, z = z0 + (z1 - z0) * t, u = u0 + (u1 - u0) * t + range(r, 1.3, 1.9), x = roadX(z) + u;
        if (!layout.free(x, z, 0.6)) continue;
        if (r() < 0.07 && ok(x + 1, z, 2.5) && roomy(x + 1, z, 3.4)) {
          placed.push({ x: x + 1, z });
          hill(z).push({ x: x + 1, z, kind: "round", scale: range(r, 0.8, 1.05), seed: seed() });
        } else hill(z).push({ x, z, kind: r() < 0.6 ? "hedge" : "bush", scale: range(r, 0.85, 1.25), seed: seed() });
      }
    }
  };
  hedge([[62, -112], [63.5, -92], [64, -70], [65.5, -52], [66, -40]]);
  hedge([[30, 57], [30.5, 75], [31, 95]]);
  hedge([[44, 66], [44, 98]]);
  hedge([[7.4, -100], [7.4, -58]]);
  // Singles on the hill and a few by the road's verge.
  for (let k = 0, tries = 0; k < 16 && tries < 400; tries++) {
    const z = range(r, -260, 230), u = range(r, 40, 160), x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 3)) continue;
    k++;
    const q = r();
    hill(z).push({ x, z, kind: q < 0.25 ? "tall" : q < 0.4 ? "conifer" : q < 0.5 ? "poplar" : "round", scale: range(r, 0.65, 1.45), seed: seed() });
  }
  // Rows of poplars standing along field edges, the way they line lanes and boundaries.
  for (let k = 0, tries = 0; k < 5 && tries < 200; tries++) {
    const z = range(r, -250, 220), u = range(r, 45, 150), x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 3)) continue;
    k++;
    const a = range(r, 0, Math.PI), m = 4 + Math.floor(r() * 5), gap = range(r, 4.2, 5.5);
    for (let i = 0; i < m; i++) {
      const tx = x + Math.cos(a) * gap * i + range(r, -0.6, 0.6), tz = z + Math.sin(a) * gap * i + range(r, -0.6, 0.6);
      if (!onHill(tx, tz) || !ok(tx, tz, 2) || !roomy(tx, tz, 3)) continue;
      placed.push({ x: tx, z: tz });
      hill(tz).push({ x: tx, z: tz, kind: "poplar", scale: range(r, 0.85, 1.15), seed: seed() });
    }
  }
  // Big leafy trees along the road's landward side, framing the coast road and the promenade.
  for (const z0 of [-140, -128, -104, -76, -52, -30, -12, 8, 26, 44, 64, 82, 98, 118, 136, 154]) {
    const z = z0 + range(r, -4, 4), u = range(r, 10.5, 14), x = roadX(z) + u;
    if (ok(x, z, 2.5, 0.4) && roomy(x, z, 7)) {
      placed.push({ x, z });
      hill(z).push({ x, z, kind: r() < 0.2 ? "tall" : "round", scale: range(r, 1.2, 1.55), seed: seed() });
    }
  }
  // The big tree on the north path, with its bench.
  hill(78).push({ x: roadX(80) + 73.5, z: 80, kind: "hero", scale: 1, seed: 4242 });
  // Shrubs scattered along the meadow's lower edge and up the hill.
  for (let k = 0, tries = 0; k < 70 && tries < 1800; tries++) {
    const z = range(r, -280, 245), u = 8 + Math.pow(r(), 1.5) * 140, x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 1.2, 0.36)) continue;
    k++;
    for (let i = 0, m = r() < 0.75 ? 1 : 2; i < m; i++) {
      const bx = x + (i ? range(r, -2.2, 2.2) : 0), bz = z + (i ? range(r, -2.2, 2.2) : 0);
      if (i === 0 || (onHill(bx, bz) && ok(bx, bz, 0.8, 0.4))) hill(bz).push({ x: bx, z: bz, kind: "bush", scale: range(r, 0.6, 1.4), seed: seed() });
    }
  }
  // The upper hill, seen only from the bay and the beach: woods in belts along the contours and
  // copses in the folds, broadleaf with a few conifers, crowding into soft masses at 300-600 m.
  // Its own stream, so everything placed after it stays where it was.
  const rf = mulberry32(6161);
  const farS: TreeSpot[] = [], farN: TreeSpot[] = [];
  for (let k = 0, tries = 0; k < 40 && tries < 1200; tries++) {
    const z = range(rf, -290, 250), u = range(rf, 170, 430), x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 4, 0.4)) continue;
    k++;
    const belt = rf() < 0.6, len = belt ? range(rf, 40, 90) : range(rf, 14, 26), n = belt ? 12 + Math.floor(rf() * 12) : 6 + Math.floor(rf() * 6);
    const ang = Math.PI / 2 + range(rf, -0.35, 0.35), ax = Math.cos(ang), az = Math.sin(ang), wid = belt ? 6 : 8;
    for (let i = 0, t = 0; i < n && t < n * 5; t++) {
      const s = range(rf, -0.5, 0.5) * len, w = (rf() + rf() - 1) * wid;
      const tx = x + ax * s - az * w, tz = z + az * s + ax * w;
      const sc = range(rf, 1.15, 1.85);
      if (!onHill(tx, tz) || !ok(tx, tz, 2, 0.42) || !roomy(tx, tz, 3.2 + sc * 1.5)) continue;
      i++;
      placed.push({ x: tx, z: tz });
      const q = rf();
      (tz < -40 ? farS : farN).push({ x: tx, z: tz, kind: q < 0.14 ? "conifer" : q < 0.38 ? "tall" : "round", scale: sc, seed: Math.floor(rf() * 1e9), far: uOf(tx, tz) > 215 });
    }
  }
  // Lone field trees and shrub clumps between the woods.
  for (let k = 0, tries = 0; k < 70 && tries < 900; tries++) {
    const z = range(rf, -290, 250), u = range(rf, 165, 440), x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 2, 0.42) || !roomy(x, z, 6)) continue;
    k++;
    placed.push({ x, z });
    const bush = rf() < 0.45;
    (z < -40 ? farS : farN).push({ x, z, kind: bush ? "bush" : rf() < 0.3 ? "tall" : "round", scale: bush ? range(rf, 1.6, 2.4) : range(rf, 0.9, 1.4), seed: Math.floor(rf() * 1e9), far: uOf(x, z) > 215 });
  }
  // Headland and island trees in groves, not a sprinkle: a few tight clumps of mixed pines and round
  // crowns, big in the middle and smaller to the edge, 2-4 m apart so the crowns overlap and hide
  // each other's trunks, with bushes at the skirt. Own stream: nothing else moves.
  const rg = mulberry32(6464);
  const grove = (list: TreeSpot[], cx: number, cz: number, n: number, rad: number, minY: number, pine: number, sMax: number) => {
    for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) {
      const a = rg() * Math.PI * 2, d = rad * Math.sqrt(rg());
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (groundY(x, z) < minY || slopeAt(x, z) > 0.5 || !layout.free(x, z, 1.2)) continue;
      if (list.some((t) => Math.hypot(t.x - x, t.z - z) < 2.2)) continue;
      i++;
      const core = 1 - d / rad;
      const edge = d > rad * 0.75 && rg() < 0.55;
      const kind = edge ? "bush" : rg() < pine ? "pine" : "round";
      list.push({ x, z, kind, scale: edge ? range(rg, 0.9, 1.3) : range(rg, 0.75, 0.95) + (sMax - 0.95) * core, seed: Math.floor(rg() * 1e9) });
    }
  };
  for (const [zc, list] of [[262, hn], [-298, hs]] as const) {
    const centres: [number, number][] = [];
    for (let tries = 0; centres.length < 4 && tries < 600; tries++) {
      const z = zc + range(rg, -50, 50), x = range(rg, -165, 120);
      if (onHill(x, z) || groundY(x, z) < SEA_Y + 6 || slopeAt(x, z) > 0.4 || !layout.free(x, z, 3)) continue;
      if (centres.some(([px, pz]) => Math.hypot(px - x, pz - z) < 40)) continue;
      centres.push([x, z]);
    }
    for (const [x, z] of centres) grove(list, x, z, 6 + Math.floor(rg() * 4), range(rg, 6, 9), SEA_Y + 4, 0.55, 1.45);
  }
  // Round the lighthouse: two groves, lower than its gallery, on the faces the opening view from the
  // pier end does not see (the tower stays clear there).
  for (let k = 0, tries = 0; k < 2 && tries < 300; tries++) {
    const a = rg() * Math.PI * 2, d = range(rg, 13, 24);
    if (Math.cos(a) * 0.52 - Math.sin(a) * 0.85 > 0.2) continue;
    const x = LIGHTHOUSE.x + Math.cos(a) * d, z = LIGHTHOUSE.z + Math.sin(a) * d;
    if (groundY(x, z) < SEA_Y + 5 || slopeAt(x, z) > 0.4) continue;
    k++;
    grove(island, x, z, 5, 5, SEA_Y + 4, 0.7, 1.05);
  }
  // Low scrub in clumps over the island's slopes, above the rock band (never as tall as the tower).
  for (let k = 0, tries = 0; k < 30 && tries < 600; tries++) {
    const a = r() * Math.PI * 2, d = range(r, 12, 44);
    const x = LIGHTHOUSE.x + Math.cos(a) * d, z = LIGHTHOUSE.z + Math.sin(a) * d;
    if (groundY(x, z) < SEA_Y + 4.5 || slopeAt(x, z) > 0.5) continue;
    k++;
    for (let i = 0, m = 2 + Math.floor(r() * 4); i < m; i++) {
      const bx = x + range(r, -2.6, 2.6), bz = z + range(r, -2.6, 2.6);
      if (groundY(bx, bz) > SEA_Y + 4) island.push({ x: bx, z: bz, kind: "bush", scale: range(r, 0.8, 1.35), seed: seed() });
    }
  }
  // Own stream again: a dark wood close behind the town's back row (so the roofs sit against tree
  // mass, not lawn), and crowns along both headland crests so their skylines break into lobes.
  const rt = mulberry32(6262);
  for (let z = -242; z < -142; z += range(rt, 3.5, 6)) {
    const x = roadX(z) + range(rt, 67, 86);
    if (!onHill(x, z) || !ok(x, z, 2, 0.4) || !roomy(x, z, 4.2)) continue;
    placed.push({ x, z });
    south.push({ x, z, kind: rt() < 0.25 ? "tall" : "round", scale: range(rt, 1.1, 1.6), seed: Math.floor(rt() * 1e9) });
  }
  for (const [zc, s, tip, list] of [[262, 1.3, -190, hn], [-298, 4.1, -165, hs]] as const) {
    // In belts with open gaps between (a slow wave along the crest), packed close where they stand.
    for (let x = tip + 35; x < 125; x += range(rt, 3, 5)) {
      if (Math.sin(x * 0.045 + s * 3.0) + 0.5 * Math.sin(x * 0.11 + s) < -0.15) continue;
      const z = zc + 10 * Math.sin(x * 0.021 + s) + 5 * Math.sin(x * 0.067 + s * 2.0) + range(rt, -5, 5);
      if (onHill(x, z) || groundY(x, z) < SEA_Y + 6 || slopeAt(x, z) > 0.5 || !layout.free(x, z, 2)) continue;
      list.push({ x, z, kind: rt() < 0.35 ? "bush" : "round", scale: range(rt, 1.2, 1.8), seed: Math.floor(rt() * 1e9), far: true });
    }
  }
  // Hedge volumes on the field boundaries the ground shader paints (same warped, rotated cells and
  // the same per-edge hash), so from the bay each band is a row of bushes with height and shadow.
  const rh = mulberry32(6363);
  const fr = (v: number) => v - Math.floor(v);
  const hash12 = (px: number, py: number) => {
    let a = fr(px * 0.1031), b = fr(py * 0.1031), c = fr(px * 0.1031);
    const d = a * (b + 33.33) + b * (c + 33.33) + c * (a + 33.33);
    a += d; b += d; c += d;
    return fr((a + b) * c);
  };
  const vn = (px: number, py: number) => {
    const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(l(hash12(ix, iy), hash12(ix + 1, iy), ux), l(hash12(ix, iy + 1), hash12(ix + 1, iy + 1), ux), uy);
  };
  const hedgeCell = new Set<string>();
  for (let z = -275; z < 245; z += 1.5) {
    for (let u = 30; u < 205; u += 1.5) {
      const x = roadX(z) + u + range(rh, -0.4, 0.4);
      const y = groundY(x, z);
      if (y < 9 || !onHill(x, z)) continue;
      const w0 = 0.94 * x + 0.34 * z, w1 = -0.34 * x + 0.94 * z;
      const wx = w0 + 3.5 * Math.sin(w1 * 0.043 + 1), wy = w1 + 3 * Math.sin(w0 * 0.061 + 2);
      const cx = Math.floor(wx / 46), cy = Math.floor(wy / 34), fx = wx / 46 - cx, fy = wy / 34 - cy;
      const dX = Math.min(fx, 1 - fx) * 46, dY = Math.min(fy, 1 - fy) * 34;
      const onX = hash12((fx < 0.5 ? cx : cx + 1) + 5.1, cy + 5.1) <= 0.62;
      const onY = hash12(cx + 9.3, (fy < 0.5 ? cy : cy + 1) + 9.3) <= 0.55;
      if (!((onX && dX < 0.9) || (onY && dY < 0.9))) continue;
      if (vn(wx * 0.09 + 4, wy * 0.09 + 4) < 0.24) continue;
      // One bush per ~3.2 m cell of the line, a hedgerow tree now and then.
      const key = `${Math.round(x / 3.2)},${Math.round(z / 3.2)}`;
      if (hedgeCell.has(key) || slopeAt(x, z) > 0.42 || !layout.free(x, z, 1.2)) continue;
      hedgeCell.add(key);
      const tree = rh() < 0.06 && roomy(x, z, 5);
      if (tree) placed.push({ x, z });
      hill(z).push({ x, z, kind: tree ? (rh() < 0.5 ? "round" : "tall") : "bush", scale: tree ? range(rh, 1.0, 1.4) : range(rh, 1.35, 1.9), seed: Math.floor(rh() * 1e9) });
    }
  }
  // Dark copses in the hill's folds (where the ground sits below its surroundings), and a few big
  // lone trees standing out on the open slopes.
  for (let k = 0, tries = 0; k < 14 && tries < 900; tries++) {
    const z = range(rh, -265, 235), u = range(rh, 45, 190), x = roadX(z) + u;
    const y = groundY(x, z), ring = (groundY(x + 14, z) + groundY(x - 14, z) + groundY(x, z + 14) + groundY(x, z - 14)) / 4;
    if (ring - y < 0.9 || !onHill(x, z) || !ok(x, z, 3, 0.4) || !roomy(x, z, 6)) continue;
    k++;
    for (let i = 0, n = 5 + Math.floor(rh() * 5); i < n; i++) {
      const tx = x + range(rh, -9, 9), tz = z + range(rh, -9, 9);
      if (!onHill(tx, tz) || !ok(tx, tz, 2.2, 0.42) || !roomy(tx, tz, 3.2)) continue;
      placed.push({ x: tx, z: tz });
      const q = rh();
      hill(tz).push({ x: tx, z: tz, kind: q < 0.45 ? "conifer" : q < 0.75 ? "round" : "tall", scale: range(rh, 0.95, 1.45), seed: Math.floor(rh() * 1e9) });
    }
  }
  for (let k = 0, tries = 0; k < 7 && tries < 400; tries++) {
    const z = range(rh, -250, 225), u = range(rh, 55, 175), x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 5, 0.3) || !roomy(x, z, 14)) continue;
    k++;
    placed.push({ x, z });
    hill(z).push({ x, z, kind: "hero", scale: range(rh, 1.0, 1.25), seed: Math.floor(rh() * 1e9) });
  }
  // The island's slopes: a dozen big lobed shrubs, so it reads as wooded heath, not a smooth dome.
  for (let k = 0, tries = 0; k < 12 && tries < 400; tries++) {
    const a = rt() * Math.PI * 2, d = range(rt, 12, 36);
    const x = LIGHTHOUSE.x + Math.cos(a) * d, z = LIGHTHOUSE.z + Math.sin(a) * d;
    if (Math.cos(a) * 0.52 - Math.sin(a) * 0.85 > 0.35 && d < 24) continue;
    if (groundY(x, z) < SEA_Y + 4.5 || slopeAt(x, z) > 0.42 || !layout.free(x, z, 2.5)) continue;
    k++;
    // Trunkless: against the island's own green a small crown vanishes and leaves its trunk.
    island.push({ x, z, kind: "bush", scale: range(rt, 1.8, 2.5), seed: Math.floor(rt() * 1e9) });
  }
  return [
    { name: "hill south", spots: south },
    { name: "hill north", spots: north },
    { name: "hill far south", spots: farS },
    { name: "hill far north", spots: farN },
    { name: "north headland", spots: hn },
    { name: "south headland", spots: hs },
    { name: "island", spots: island },
  ];
}

/** Town trees: gardens between the rows and the lanes' heads (u, z road-relative). */
const TOWN_TREES: [number, number, TreeKind, number][] = [
  [19.5, -160, "round", 0.9], [31.5, -166.5, "round", 0.95], [43.5, -186.2, "tall", 0.9], [31, -204.2, "round", 0.85],
  [42.5, -150.5, "round", 1.0], [56, -175, "tall", 1.0], [56, -201, "round", 1.05], [20, -228, "round", 0.9],
  [44.5, -225, "round", 0.95], [9.2, -186.8, "round", 0.75], [61, -160, "round", 1.1], [60, -214, "tall", 0.95],
];

export class Flora {
  readonly group = new THREE.Group();
  meadow!: Meadow;
  flowers!: Flowers;
  trees = 0;
  leafCards = 0;

  /**
   * Trees, then the meadow, then the flowers, with `done(label)` awaited after each and `pause()`
   * between slices of the bigger ones (see Bay.build).
   */
  static async build(layout: Layout, colliders: Collider[], townShrubs: TreeSpot[], done: (label: string) => Promise<void>, pause: () => Promise<void>): Promise<Flora> {
    const f = new Flora();
    f.group.name = "flora";
    const r = mulberry32(3131);
    const town: TreeSpot[] = [...townShrubs];
    for (const [u, z, kind, s] of TOWN_TREES) {
      const x = roadX(z) + u;
      if (layout.free(x, z, 1.6)) town.push({ x, z, kind, scale: s * 1.2, seed: Math.floor(r() * 1e9) });
    }
    // Shrubs that would stand on a lane, path or wall are dropped.
    const regions = [{ name: "town", spots: town.filter((s) => s.y !== undefined || layout.free(s.x, s.z, 0.5)) }, ...wildTrees(layout)];
    // Shade pools in the grass under every crown, deeper under the woods where they overlap.
    for (const reg of regions)
      for (const s of reg.spots) {
        if (s.y !== undefined && !Number.isNaN(s.y)) continue;
        const big = s.kind !== "bush" && s.kind !== "hedge";
        poolUnder(s.x, s.z, (big ? (s.kind === "hero" ? 8 : 5.2) : 2.2) * s.scale, big ? 0.55 : 0.35);
      }
    poolsDone();
    const t = await buildTrees(regions, layout, colliders, pause);
    f.trees = t.trees;
    f.leafCards = t.cards;
    f.group.add(t.group);
    await done("trees");
    f.meadow = await Meadow.build(layout, pause);
    await done("meadow");
    f.flowers = new Flowers(layout);
    f.group.add(f.meadow.group, f.flowers.group);
    await done("flowers");
    return f;
  }

  private constructor() {}

  update(cam: THREE.Vector3): void {
    this.meadow.update(cam);
    this.flowers.update(cam);
  }
}
