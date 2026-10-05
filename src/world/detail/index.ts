import * as THREE from "three";
import { ID, M, blob, merge, prep, xf } from "../geo";
import { mulberry32, range } from "../../core/rng";
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { roadX } from "../bay/road";
import { coastH, headlandsH } from "../bay/terrain";
import type { Box, Collider } from "../bay";
import { Layout, groundY, slopeAt, uOf } from "../../flora/place";
import { Flora, setTier, type Tier } from "../../flora";
import { FLORA } from "../../flora/glsl";
import type { TreeSpot } from "../../flora/trees";
import { buildTown } from "../bay/houses";
import { buildStreet } from "./street";
import { buildHarbour } from "./harbour";

/**
 * Everything that dresses the bay beyond its landform and water: the town, the coast road's
 * furniture, the harbour clutter, boulders on the hill, then the flora that grows round all of
 * them. The props claim their ground (and ask for flowers) in one shared Layout first.
 */
export class WorldDetail {
  readonly group = new THREE.Group();
  readonly layout = new Layout();
  readonly flora: Flora;
  readonly stats: Record<string, number> = {};

  constructor(colliders: Collider[], boxes: Box[]) {
    this.group.name = "world detail";
    const q = new URLSearchParams(location.search).get("detail");
    setTier(q === "low" || q === "med" ? (q as Tier) : "high");
    const shrubs: TreeSpot[] = [];
    const c0 = colliders.length;
    const town = buildTown(colliders, boxes, this.layout, shrubs);
    this.group.add(town.group, buildStreet(this.layout, colliders), buildHarbour(this.layout, colliders, boxes), boulders(this.layout, colliders));
    this.flora = new Flora(this.layout, colliders, shrubs);
    this.group.add(this.flora.group);
    Object.assign(this.stats, {
      houses: town.houses,
      trees: this.flora.trees,
      leafCards: this.flora.leafCards,
      grassClumps: this.flora.meadow.total,
      flowerClumps: this.flora.flowers.total,
      flowerSpots: this.layout.spots.length,
      colliders: colliders.length - c0,
    });
  }

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
  const stone = new THREE.Color("#8e877c"), dark = new THREE.Color("#6b665f"), moss = new THREE.Color("#5f7a3a"), lichen = new THREE.Color("#b9b07a");
  const c = new THREE.Color();
  let n = 0;
  for (let tries = 0; tries < 600 && n < 42; tries++) {
    const z = range(r, -285, 250), u = 9 + Math.pow(r(), 1.3) * 150;
    const x = roadX(z) + u;
    if (headlandsH(x, z) > coastH(u, z) + 0.5 && r() < 0.5) continue;
    if (!layout.free(x, z, 1.5) || slopeAt(x, z) > 0.35) continue;
    n++;
    const s = range(r, 0.5, 1.4);
    const g = prep(blob(1, 2, 0.22, r() * 100), null, M.stone);
    const p = g.attributes.position, nr = g.attributes.normal;
    const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const up = nr.getY(i), py = p.getY(i);
      const mot = 0.5 + 0.5 * Math.sin(p.getX(i) * 5.3 + n) * Math.sin(p.getZ(i) * 4.7 - n);
      c.copy(stone).lerp(dark, (1 - mot) * 0.5 + (py < 0 ? 0.3 : 0));
      c.lerp(moss, Math.max(0, Math.min(1, (up - 0.35 + (mot - 0.5) * 0.6) * 2)) * 0.8);
      if (mot > 0.82 && up > 0.2) c.lerp(lichen, 0.5);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.scale(s * range(r, 1.0, 1.5), s * range(r, 0.55, 0.8), s * range(r, 0.9, 1.3));
    parts.push(xf(g, x, groundY(x, z) + s * 0.12, z, range(r, -0.15, 0.15), r() * 6.28, range(r, -0.15, 0.15)));
    colliders.push({ x, z, r: s * 1.1, top: groundY(x, z) + s * 0.75, kind: "rock" });
    layout.rect(x - s * 1.1, x + s * 1.1, z - s * 1.1, z + s * 1.1);
    // A drift of flowers on the sunny side, ferns in the shade.
    layout.spot(x - s * 1.6, z + range(r, -1, 1), s * 1.8, Math.round(8 + s * 8), ["daisy", "yellow", "lavender", "poppy", "pink"]);
    layout.spot(x + s * 1.3, z, s, 4, ["fern", "weed"]);
    if (uOf(x, z) < 60) layout.perches.push([x, groundY(x, z) + s * 0.72, z, r() * 6.28]);
  }
  const m = new THREE.Mesh(parts.length ? merge(parts) : new THREE.BufferGeometry(), uber(ID.berm, 0.8));
  m.name = "boulders";
  onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
  return m;
}
