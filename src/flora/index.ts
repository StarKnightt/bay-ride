import * as THREE from "three";
import { mulberry32, range } from "../core/rng";
import { SEA_Y, roadX } from "../world/bay/road";
import { LIGHTHOUSE, coastH, headlandsH } from "../world/bay/terrain";
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
  // Copses: a few trees with shrubs round their skirts.
  for (let k = 0, tries = 0; k < 11 && tries < 400; tries++) {
    const z = range(r, -270, 235), u = range(r, 58, 165), x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 4)) continue;
    k++;
    const n = 2 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = i ? range(r, 4.5, 9) : 0;
      const tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d;
      if (!ok(tx, tz, 2.5)) continue;
      const kind: TreeKind = r() < 0.35 ? "tall" : "round";
      hill(tz).push({ x: tx, z: tz, kind, scale: range(r, 0.85, 1.2), seed: seed() });
    }
    for (let i = 0; i < 5; i++) {
      const a = r() * Math.PI * 2, d = range(r, 5, 11);
      const tx = x + Math.cos(a) * d, tz = z + Math.sin(a) * d;
      if (ok(tx, tz, 1)) hill(tz).push({ x: tx, z: tz, kind: "bush", scale: range(r, 0.8, 1.3), seed: seed() });
    }
    layout.spot(x + range(r, -6, 6), z + range(r, -6, 6), 3, 14, ["daisy", "pink", "fern", "lavender"]);
  }
  // Singles on the hill and a few by the road's verge.
  for (let k = 0, tries = 0; k < 16 && tries < 400; tries++) {
    const z = range(r, -260, 230), u = range(r, 40, 160), x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 3)) continue;
    k++;
    hill(z).push({ x, z, kind: r() < 0.3 ? "tall" : "round", scale: range(r, 0.85, 1.25), seed: seed() });
  }
  for (const z of [-128, -76, -12, 26, 64, 98, 136]) {
    const u = range(r, 10.5, 13), x = roadX(z) + u;
    if (ok(x, z, 2.5, 0.4)) hill(z).push({ x, z, kind: "round", scale: range(r, 0.8, 1.0), seed: seed() });
  }
  // The big tree on the north path, with its bench.
  hill(78).push({ x: roadX(80) + 73.5, z: 80, kind: "hero", scale: 1, seed: 4242 });
  // Shrubs scattered along the meadow's lower edge and up the hill.
  for (let k = 0, tries = 0; k < 70 && tries < 900; tries++) {
    const z = range(r, -280, 245), u = 8 + Math.pow(r(), 1.5) * 130, x = roadX(z) + u;
    if (!onHill(x, z) || !ok(x, z, 1.2, 0.36)) continue;
    k++;
    hill(z).push({ x, z, kind: "bush", scale: range(r, 0.7, 1.25), seed: seed() });
  }
  // Seaside pines on the headlands, shrubs in their lee.
  for (const [zc, list] of [[262, hn], [-298, hs]] as const) {
    for (let k = 0, tries = 0; k < 26 && tries < 900; tries++) {
      const z = zc + range(r, -55, 55), x = range(r, -175, 130);
      if (onHill(x, z)) continue;
      const y = groundY(x, z);
      if (y < SEA_Y + 5 || slopeAt(x, z) > 0.45 || !layout.free(x, z, 2)) continue;
      k++;
      list.push({ x, z, kind: "pine", scale: range(r, 0.8, 1.2), seed: seed() });
      if (r() < 0.6) {
        const a = r() * Math.PI * 2;
        const bx = x + Math.cos(a) * 3.5, bz = z + Math.sin(a) * 3.5;
        if (groundY(bx, bz) > SEA_Y + 3) list.push({ x: bx, z: bz, kind: "bush", scale: range(r, 0.8, 1.2), seed: seed() });
      }
    }
  }
  // A few pines round the lighthouse, kept lower than its gallery and off the line to the pier.
  for (let k = 0, tries = 0; k < 9 && tries < 300; tries++) {
    const a = r() * Math.PI * 2, d = range(r, 9, 27);
    const x = LIGHTHOUSE.x + Math.cos(a) * d, z = LIGHTHOUSE.z + Math.sin(a) * d;
    // Not on the face the opening view sees from the pier end: the tower stays clear there.
    if (Math.cos(a) * 0.52 - Math.sin(a) * 0.85 > 0.35) continue;
    if (groundY(x, z) < SEA_Y + 4 || slopeAt(x, z) > 0.45) continue;
    k++;
    island.push({ x, z, kind: r() < 0.75 ? "pine" : "bush", scale: range(r, 0.7, 0.95), seed: seed() });
  }
  return [
    { name: "hill south", spots: south },
    { name: "hill north", spots: north },
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
      if (layout.free(x, z, 1.6)) town.push({ x, z, kind, scale: s, seed: Math.floor(r() * 1e9) });
    }
    // Shrubs that would stand on a lane, path or wall are dropped.
    const regions = [{ name: "town", spots: town.filter((s) => s.y !== undefined || layout.free(s.x, s.z, 0.5)) }, ...wildTrees(layout)];
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
