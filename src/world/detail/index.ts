import * as THREE from "three";
import { ID, M, blob, merge, prep, xf } from "../geo";
import { mulberry32, range } from "../../core/rng";
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { roadX } from "../bay/road";
import { ISLAND, coastH, headlandsH, islandH } from "../bay/terrain";
import { SEA_Y } from "../bay/road";
import type { Box, Collider } from "../bay";
import { Layout, groundY, slopeAt, uOf } from "../../flora/place";
import { Flora, setTier, type Tier } from "../../flora";
import { FLORA } from "../../flora/glsl";
import type { TreeSpot } from "../../flora/trees";
import { buildTown } from "../bay/houses";
import { buildStreet } from "./street";
import { buildHarbour } from "./harbour";
import { buildBeach } from "./beach";

/**
 * Everything that dresses the bay beyond its landform and water: the town, the coast road's
 * furniture, the harbour clutter, the beach's wrack line and props, boulders on the hill, then the flora that grows round all of
 * them. The props claim their ground (and ask for flowers) in one shared Layout first.
 */
export class WorldDetail {
  readonly group = new THREE.Group();
  readonly layout = new Layout();
  flora!: Flora;
  readonly stats: Record<string, number> = {};

  /** Built a part at a time, awaiting `pause()` between parts (see Bay.build). */
  static async build(colliders: Collider[], boxes: Box[], pause: () => Promise<void>, log?: (label: string, ms: number) => void): Promise<WorldDetail> {
    const d = new WorldDetail();
    let s = performance.now();
    const done = async (label: string) => {
      log?.(label, performance.now() - s);
      await pause();
      s = performance.now();
    };
    d.group.name = "world detail";
    const q = new URLSearchParams(location.search).get("detail");
    setTier(q === "low" || q === "med" ? (q as Tier) : "high");
    const shrubs: TreeSpot[] = [];
    const c0 = colliders.length;
    const town = buildTown(colliders, boxes, d.layout, shrubs);
    await done("town");
    const street = buildStreet(d.layout, colliders);
    await done("street");
    d.group.add(town.group, street, buildHarbour(d.layout, colliders, boxes), boulders(d.layout, colliders));
    await done("harbour");
    d.group.add(buildBeach(d.layout, colliders));
    await done("beach");
    d.flora = await Flora.build(d.layout, colliders, shrubs, done, pause);
    d.group.add(d.flora.group);
    Object.assign(d.stats, {
      houses: town.houses,
      trees: d.flora.trees,
      leafCards: d.flora.leafCards,
      grassClumps: d.flora.meadow.total,
      flowerClumps: d.flora.flowers.total,
      flowerSpots: d.layout.spots.length,
      colliders: colliders.length - c0,
    });
    return d;
  }

  private constructor() {}

  update(cam: THREE.Vector3): void {
    this.flora.update(cam);
  }

  /** Live tunables of the flora shaders (density reach, canopy palette, grass light). */
  readonly tune = FLORA;

  /** Quality tier: grass density and reach, flower reach (also ?detail=low|med|high). */
  setTier(t: Tier): void {
    setTier(t);
  }
}

/**
 * Boulders bedded in the meadow and on the headlands: lumpy flattened stones, lichen and moss on
 * their tops, painted by the stone surface (light top, warm sides, cool shadow), flowers at their
 * feet.
 */
function boulders(layout: Layout, colliders: Collider[]): THREE.Mesh {
  const r = mulberry32(7070);
  const parts: THREE.BufferGeometry[] = [];
  const stone = new THREE.Color("#8e877c"), dark = new THREE.Color("#6b665f"), moss = new THREE.Color("#5f7a3a"), lichen = new THREE.Color("#c4b45e");
  const top = new THREE.Color("#b3a88f"), warm = new THREE.Color("#9a8670"), cool = new THREE.Color("#6c7282"), lichenO = new THREE.Color("#c08a4c");
  const c = new THREE.Color();
  const wet = new THREE.Color("#4f4c49");
  let n = 0;
  /** One rounded stone; `shore`: the island's sea-worn rocks, darker, a wet foot, salt lichen, no moss. */
  const stoneAt = (x: number, z: number, s: number, y: number, shore: boolean) => {
    // Smooth, bedded and rounded (never a faceted polyhedron): lumps from a product of sines, the
    // top squashed into a worn dome and the underside flattened into the ground. Colour per vertex,
    // blended across faces: lit warm top, warm flanks, cool underside, moss creeping over the top
    // in mottled patches and lichen blooms (all at sizes of 15 cm and up, so nothing speckles).
    const sd = r() * 100;
    const g = prep(blob(1, s > 1.1 ? 3 : 2, 0.12, sd), null, M.stone);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      const lump = Math.sin(vx * 2.1 + sd) * Math.sin(vy * 2.7 + sd * 1.3) * Math.sin(vz * 2.3 + sd * 0.7);
      const k = 1 + 0.2 * lump;
      p.setXYZ(i, vx * k, (vy > 0 ? vy * 0.66 : vy * 0.32) * k, vz * k);
    }
    g.computeVertexNormals();
    const nr = g.attributes.normal;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const up = nr.getY(i), px = p.getX(i), py = p.getY(i), pz = p.getZ(i);
      const mot = 0.5 + 0.5 * Math.sin(px * 5.3 + sd) * Math.sin(pz * 4.7 - sd) * Math.sin(py * 6.1 + 1.3);
      c.copy(stone).lerp(warm, 0.35 + 0.35 * Math.sin(px * 2.1 + pz * 1.7 + sd));
      c.lerp(top, Math.max(0, Math.min(1, (up - 0.2) * 1.6)) * 0.75);
      c.lerp(cool, Math.max(0, Math.min(1, -up * 1.4)) * 0.8);
      c.lerp(dark, 0.12 + 0.25 * (1 - mot) * (up < 0 ? 1 : 0.4));
      const lp = Math.sin(px * 4.1 - sd) * Math.sin(pz * 3.7 + sd * 0.7) * Math.sin(py * 3.3 + sd);
      if (shore) {
        c.lerp(wet, Math.max(0, Math.min(1, (0.05 - py) * 2.5)) * 0.6 + 0.12);
        c.lerp(lichen, Math.max(0, Math.min(1, (lp - 0.35) * 3)) * Math.max(0, up) * 0.45);
      } else {
        c.lerp(moss.clone().lerp(lichen, mot * 0.25), Math.max(0, Math.min(1, (up - 0.3 + (mot - 0.5) * 0.8) * 2.2)) * 0.8);
        if (up > -0.2) c.lerp(lp > 0.75 ? lichenO : lichen, Math.max(0, Math.min(1, (lp - 0.45) * 3)) * 0.55);
      }
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.scale(s * range(r, 1.0, 1.5), s * range(r, 0.55, 0.8), s * range(r, 0.9, 1.3));
    parts.push(xf(g, x, y + s * (shore ? 0.02 : 0.12), z, range(r, -0.15, 0.15), r() * 6.28, range(r, -0.15, 0.15)));
    colliders.push({ x, z, r: s * 1.1, top: y + s * 0.75, kind: "rock" });
    layout.rect(x - s * 1.1, x + s * 1.1, z - s * 1.1, z + s * 1.1);
  };
  for (let tries = 0; tries < 600 && n < 42; tries++) {
    const z = range(r, -285, 250), u = 9 + Math.pow(r(), 1.3) * 150;
    const x = roadX(z) + u;
    if (headlandsH(x, z) > coastH(u, z) + 0.5 && r() < 0.5) continue;
    if (!layout.free(x, z, 1.5) || slopeAt(x, z) > 0.35) continue;
    n++;
    const s = range(r, 0.5, 1.4);
    stoneAt(x, z, s, groundY(x, z), false);
    // A drift of flowers on the sunny side, ferns in the shade.
    layout.spot(x - s * 1.6, z + range(r, -1, 1), s * 1.8, Math.round(8 + s * 8), ["daisy", "yellow", "lavender", "poppy", "pink"]);
    layout.spot(x + s * 1.3, z, s, 4, ["fern", "weed"]);
    if (uOf(x, z) < 60) layout.perches.push([x, groundY(x, z) + s * 0.72, z, r() * 6.28]);
  }
  // The island's shore: dark sea-worn outcrops bedded in the sand and shingle at irregular spacing,
  // big enough (1-2.6 m) to read as shapes from the beach, not as dots.
  for (let a = r() * 0.4, k = 0; a < Math.PI * 2 && k < 30; a += range(r, 0.25, 0.6), k++) {
    const ca = Math.cos(a), sa = Math.sin(a);
    let rs = 12;
    while (rs < 80 && islandH(ISLAND.x + ca * rs, ISLAND.z + sa * rs) > SEA_Y + 0.1) rs += 0.5;
    if (rs >= 80) continue;
    // Irregular: long bare stretches between outcrops (an even ring read as beads from the beach).
    if (r() < 0.45) continue;
    const lift = range(r, 0.05, 1.1);
    let rr = rs;
    while (rr > 8 && islandH(ISLAND.x + ca * rr, ISLAND.z + sa * rr) < SEA_Y + lift) rr -= 0.4;
    const group = r() < 0.45 ? 1 : r() < 0.6 ? 2 : 3;
    for (let j = 0; j < group; j++) {
      const x = ISLAND.x + ca * rr + range(r, -1.6, 1.6) * j, z = ISLAND.z + sa * rr + range(r, -1.6, 1.6) * j;
      const s = j === 0 ? range(r, 1.1, 2.6) : range(r, 0.6, 1.3);
      n++;
      stoneAt(x, z, s, islandH(x, z) - s * 0.22, true);
      if (j === 0 && r() < 0.35) layout.perches.push([x, islandH(x, z) + s * 0.7, z, r() * 6.28]);
    }
  }
  const m = new THREE.Mesh(parts.length ? merge(parts) : new THREE.BufferGeometry(), uber(ID.berm, 0.8));
  m.name = "boulders";
  onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
  return m;
}
