import * as THREE from "three";
import { ID, M, cyl, merge, xf } from "../geo";
import { roadMaterial, uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { ROAD_HALF, ROAD_Z0, ROAD_Z1, RIBBON_HALF, SEA_Y, roadX } from "./road";
import { ISLAND, LIGHTHOUSE, WALL_IN, buildIsland, buildRoadRibbon, buildTerrain, islandH, terrainH } from "./terrain";
import type { StepSurface } from "../../sound/steps";
import { LighthouseBeam } from "./beam";
import { buildHouses } from "./houses";
import { buildDuneGrass } from "./dunegrass";
import { buildPier, deckH, inPier, pierBlocks, pierContact, pierGround } from "./pier";
import { beachMaterial } from "../../water/beach";
import { ROCKS, buildRocks } from "../../water/rocks";

/** Collision answer for a circle at (x, z): penetration depth and push-out normal. */
export interface Contact {
  pen: number;
  nx: number;
  nz: number;
}

/** A circular obstacle (posts, bollards, trunks), world space. */
export interface Collider {
  x: number;
  z: number;
  r: number;
}

/** Walkable surface: height and footstep surface. */
export interface Ground {
  h: number;
  kind: StepSurface;
}

/** Deepest water she may wade into (metres below the mean sea level). */
const WADE = 0.45;

/**
 * The whole bay as one static scene (no streaming): landform, coast road, island, placeholder
 * lighthouse with its night beam, the harbour pier, a few placeholder harbour houses, the swash
 * beach and shore rocks. Later systems add the town and props to `root`.
 */
export class Bay {
  readonly root = new THREE.Group();
  readonly colliders: Collider[] = [];
  /** Lighthouse lamp centre. */
  readonly lamp = new THREE.Vector3();
  /** Turning lighthouse beams and lamp halo (dusk and night). */
  readonly beam: LighthouseBeam;

  constructor() {
    const { terrain, beach } = buildTerrain(beachMaterial());
    this.root.add(terrain, beach, buildRocks());
    for (const r of ROCKS) if (r.top > SEA_Y - 0.2) this.colliders.push({ x: r.x, z: r.z, r: r.r * 0.85 });
    this.root.add(buildIsland());
    this.root.add(buildRoadRibbon(ROAD_Z0 + 30, ROAD_Z1 - 30, roadMaterial()));
    this.root.add(this.lighthouse());
    this.root.add(buildHouses(this.colliders));
    this.root.add(buildPier(this.colliders));
    this.root.add(buildDuneGrass(this.colliders));
    this.beam = new LighthouseBeam(this.lamp);
    this.root.add(this.beam.group);
  }

  /** Placeholder lighthouse: white tapered tower, red band, gallery, lamp room and cap. */
  private lighthouse(): THREE.Object3D {
    const x = LIGHTHOUSE.x, z = LIGHTHOUSE.z;
    const y0 = islandH(x, z) - 0.4;
    const H = 13;
    const parts = [
      xf(cyl(2.3, 2.9, 1.2, "#cfc8b8", M.stone, 16), 0, 0.6, 0),
      xf(cyl(1.55, 2.2, H, "#f4f0e6", M.plaster, 20), 0, 1.2 + H / 2, 0),
      xf(cyl(1.62, 1.75, 2.2, "#c8473a", M.plain, 20), 0, 1.2 + H * 0.55, 0),
      xf(cyl(2.25, 2.25, 0.25, "#3a3a3e", M.metal, 20), 0, 1.2 + H + 0.12, 0),
      xf(cyl(1.15, 1.15, 1.5, "#ffe7a8", M.glow, 16), 0, 1.2 + H + 1.0, 0),
      xf(cyl(0.3, 1.45, 1.1, "#c8473a", M.plain, 16), 0, 1.2 + H + 2.3, 0),
      xf(cyl(0.12, 0.12, 0.7, "#3a3a3e", M.metal, 6), 0, 1.2 + H + 3.15, 0),
    ];
    const m = new THREE.Mesh(merge(parts), uber(ID.house, 1));
    m.position.set(x, y0, z);
    this.lamp.set(x, y0 + 1.2 + H + 1.0, z);
    onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
    return m;
  }

  /**
   * Walkable ground at world (x, z), or null (deep water, off the map, a railing). `y` is the walker's
   * current height: the pier deck is ground from above, the sand under it from below.
   */
  groundAt(x: number, z: number, y = Infinity): Ground | null {
    if (Math.abs(z) > 520 || x < -600 || x > 600) return null;
    const p = pierGround(x, z, y);
    if (p !== undefined) return p;
    const h = terrainH(x, z);
    if (h < SEA_Y - WADE) return null;
    const u = x - roadX(z);
    const onRoadZ = z < ROAD_Z0 + 30 && z > ROAD_Z1 - 30;
    let kind: StepSurface = "grass";
    if (onRoadZ && Math.abs(u) < ROAD_HALF) kind = "asphalt";
    else if (onRoadZ && u >= WALL_IN && u < RIBBON_HALF + 0.4) kind = "dirt";
    else if (h < 0.1 && u < WALL_IN) kind = h < SEA_Y + 0.35 ? "wetsand" : "sand";
    return { h: Math.max(h, SEA_Y - WADE), kind };
  }

  /** Inside a building footprint? Returns its roof height (none yet). */
  roofAt(_x: number, _z: number, _pad: number): number {
    return 0;
  }

  /** Is (x, z) under a structure standing over the water (pier deck), within `pad` m? */
  overWater(x: number, z: number, pad = 0): boolean {
    return inPier(x, z, pad);
  }

  /** Is the point (x, y, z) inside a solid structure over the water (pier)? */
  blocks(x: number, y: number, z: number): boolean {
    return pierBlocks(x, y, z);
  }

  /** Circle (x, z, r) against every collider and the pier's footprint (hulls): deepest penetration. */
  contact(x: number, z: number, r: number): Contact {
    const out: Contact = pierContact(x, z, r) ?? { pen: 0, nx: 0, nz: 0 };
    for (const c of this.colliders) {
      const dx = x - c.x, dz = z - c.z, rr = r + c.r;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      if (rr - d > out.pen) {
        out.pen = rr - d;
        out.nx = d > 1e-5 ? dx / d : 1;
        out.nz = d > 1e-5 ? dz / d : 0;
      }
    }
    return out;
  }

  /** Lowest camera height at (x, z): ground (or the water surface) plus a margin. */
  camFloor(x: number, z: number): number {
    const g = Math.max(terrainH(x, z), SEA_Y + 0.15, inPier(x, z, 0.3) ? deckH(x) : -Infinity);
    return g + 0.3;
  }

  /** 0…1 closeness to the open water (for the ambience). */
  seaNear(x: number, z: number): number {
    const u = x - roadX(z);
    return Math.max(0, Math.min(1, 1 - (u + 8) / 40));
  }
}

export { ISLAND, LIGHTHOUSE };
