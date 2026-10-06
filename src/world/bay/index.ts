import * as THREE from "three";
import { ID, M, cyl, merge, xf } from "../geo";
import { roadMaterial, uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { ROAD_HALF, ROAD_Z0, ROAD_Z1, RIBBON_HALF, SEA_Y, roadX } from "./road";
import { ISLAND, LIGHTHOUSE, WALL_IN, WALL_OUT, buildIsland, buildRoadRibbon, buildTerrain, coastH, headlandsH, islandH, meshH } from "./terrain";
import type { StepSurface } from "../../sound/steps";
import { LighthouseBeam } from "./beam";
import { pavedH } from "./houses";
import { buildDuneGrass } from "./dunegrass";
import { WorldDetail } from "../detail";
import { pathDist } from "../detail/paths";
import { Life, type LifeTime } from "../../life";
import { PIER, buildPier, deckH, inPier, pierBlocks, pierContact, pierGround, pierWalkH } from "./pier";
import { beachMaterial } from "../../water/beach";
import { ROCKS, buildRocks, rockTop } from "../../water/rocks";
import { buildSlipways, rampH } from "./slipway";

/** Collision answer for a circle at (x, z): penetration depth and push-out normal. */
export interface Contact {
  pen: number;
  nx: number;
  nz: number;
}

/** A circular obstacle, world space: posts, bollards, lamps; shore rocks; a house's keep-out circle. */
export interface Collider {
  x: number;
  z: number;
  r: number;
  /** World height of its top: she walks over anything whose top is below her feet (the deck over a rock). */
  top: number;
  /** Rocks stop her but not the camera (it clears them by height); houses only keep grass out;
   * plants (bushes, hedges, saplings) she brushes through, but the camera still pulls in ahead of them. */
  kind?: "rock" | "house" | "plant";
}

/**
 * Past the walkable land: the town hill up to its crest (u ~200, where the fine terrain grid ends), and just
 * past the headlands' ends. Further out the terrain is only a coarse backdrop for the views.
 */
function offMap(x: number, z: number): boolean {
  return z < -360 || z > 335 || x < -600 || x - roadX(z) > 200;
}

/** A building's footprint (world AABB) and its ridge height: she can't walk in, the camera stays out. */
export interface Box {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  top: number;
}

/** Walkable surface: height and footstep surface. */
export interface Ground {
  h: number;
  kind: StepSurface;
}

/** Deepest water she may wade into (metres below the mean sea level): about her knees. */
export const WADE = 0.5;

/**
 * The whole bay as one static scene (no streaming): landform, coast road, island, placeholder
 * lighthouse with its night beam, the harbour pier, the swash beach and shore rocks, the town and
 * every prop and plant (WorldDetail), and the life over it (Life).
 */
export class Bay {
  readonly root = new THREE.Group();
  readonly colliders: Collider[] = [];
  readonly boxes: Box[] = [];
  /** Lighthouse lamp centre. */
  readonly lamp = new THREE.Vector3();
  /** Turning lighthouse beams and lamp halo (dusk and night). */
  beam!: LighthouseBeam;
  /** The town, road furniture, harbour gear, boulders and all the flora (see world/detail). */
  detail!: WorldDetail;
  /** Gulls, butterflies, leaping fish, drifting petals and seeds, fireflies (see life/). */
  life!: Life;

  /**
   * Build the bay one step at a time, awaiting `pause()` between steps so the loader keeps
   * drawing (built in one go it held the page for over a second). `log` gets each step's time.
   */
  static async build(pause: () => Promise<void>, log?: (label: string, ms: number) => void): Promise<Bay> {
    const bay = new Bay();
    for (const [label, step] of bay.steps(pause, log)) {
      const s = performance.now();
      const nested = await step();
      if (!nested) log?.(label, performance.now() - s);
      await pause();
    }
    return bay;
  }

  private constructor() {}

  /** Each step builds one part; a step that pauses and logs its own parts returns true. */
  private steps(pause: () => Promise<void>, log?: (label: string, ms: number) => void): [string, () => void | Promise<boolean>][] {
    return [
      ["terrain", () => {
        const { terrain, beach } = buildTerrain(beachMaterial());
        this.root.add(terrain, beach);
      }],
      ["rocks", () => {
        this.root.add(buildRocks(), buildSlipways());
        for (const r of ROCKS) if (r.top > SEA_Y - 0.2) this.colliders.push({ x: r.x, z: r.z, r: r.r * 0.85, top: r.top, kind: "rock" });
      }],
      ["island", () => {
        this.root.add(buildIsland());
        this.root.add(buildRoadRibbon(ROAD_Z0 + 30, ROAD_Z1 - 30, roadMaterial()));
        this.root.add(this.lighthouse());
        this.colliders.push({ x: LIGHTHOUSE.x, z: LIGHTHOUSE.z, r: 2.9, top: islandH(LIGHTHOUSE.x, LIGHTHOUSE.z) + 20 });
      }],
      ["pier", () => {
        this.root.add(buildPier(this.colliders));
      }],
      ["detail", async () => {
        this.detail = await WorldDetail.build(this.colliders, this.boxes, pause, log);
        this.root.add(this.detail.group);
        return true;
      }],
      ["dune grass", () => {
        this.root.add(buildDuneGrass(this.colliders, this.detail.layout));
      }],
      ["life", () => {
        this.life = new Life(this.detail.layout, this.detail.flora.flowers.drifts);
        this.root.add(this.life.group);
        this.beam = new LighthouseBeam(this.lamp);
        this.root.add(this.beam.group);
      }],
    ];
  }

  /**
   * Per frame, once the camera is placed: flora detail and instance packing round the camera,
   * and the life (gulls take off when she comes close; fish leap where the camera can see them).
   */
  update(time: LifeTime, cam: THREE.PerspectiveCamera, px: number, pz: number): void {
    this.detail.update(cam.position);
    this.life.update(time, cam, px, pz);
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
    if (offMap(x, z)) return null;
    const p = pierGround(x, z, y);
    if (p !== undefined) return p;
    const h = this.surfaceH(x, z);
    if (h < SEA_Y - WADE) return null;
    if (h > meshH(x, z) + 1e-4 && islandH(x, z) >= h - 1e-4) return { h: Math.max(h, SEA_Y - WADE), kind: h < SEA_Y + 0.35 ? "wetsand" : h < SEA_Y + 2.4 ? "stone" : "grass" };
    const u = x - roadX(z);
    const onRoadZ = z < ROAD_Z0 + 30 && z > ROAD_Z1 - 30;
    let kind: StepSurface = "grass";
    if ((onRoadZ && Math.abs(u) < ROAD_HALF) || rampH(x, z) >= h - 1e-3 || pavedH(x, z) >= h - 1e-3) kind = "asphalt";
    else if (onRoadZ && u >= WALL_IN && u < RIBBON_HALF + 0.4) kind = "dirt";
    else if (u > 4 && u < 140 && pathDist(x, z, 1.2) < 1.0) kind = "dirt";
    else if (h < 0.1 && u < WALL_IN) kind = h < SEA_Y + 0.35 ? "wetsand" : "sand";
    return { h: Math.max(h, SEA_Y - WADE), kind };
  }

  /** Height of walkable ground at (x, z) as groundAt finds it, or NaN; no allocation (per-frame probes). */
  walkH(x: number, z: number, y = Infinity): number {
    if (offMap(x, z)) return NaN;
    const p = pierWalkH(x, z, y);
    if (p === -Infinity) return NaN;
    if (!Number.isNaN(p)) return p;
    const h = this.surfaceH(x, z);
    return h < SEA_Y - WADE ? NaN : h;
  }

  /** The land as drawn, without the pier: the terrain mesh's triangles, the island, the road ribbon, slipways and the town's paving. */
  surfaceH(x: number, z: number): number {
    const h = meshH(x, z);
    const u = x - roadX(z);
    const road = Math.abs(u) < RIBBON_HALF && z < ROAD_Z0 + 30 && z > ROAD_Z1 - 30 ? 0.02 : -Infinity;
    const isle = Math.abs(x - ISLAND.x) < 80 && Math.abs(z - ISLAND.z) < 80 ? islandH(x, z) : -Infinity;
    return Math.max(h, isle, road, rampH(x, z), u > 4 && u < 60 ? pavedH(x, z) : -Infinity);
  }

  /**
   * On the face of the sea wall at (x, z): between its foot and the promenade edge, where the coast
   * profile (not a headland) makes the ground and no slipway crosses it, nor the pier's root (its
   * deck rises gently over the wall's line onto the promenade). Masonry: she never walks up it.
   */
  seaWall(x: number, z: number): boolean {
    const u = x - roadX(z);
    if (u < WALL_OUT - 0.1 || u > WALL_IN + 0.05 || rampH(x, z, 0.1) > -Infinity) return false;
    if (x < PIER.x0 + 0.3 && Math.abs(z - PIER.z) < PIER.half + 0.1) return false;
    return headlandsH(x, z) < coastH(u, z);
  }

  /** Inside a building footprint grown by `pad` m? Returns its ridge height, or 0. */
  roofAt(x: number, z: number, pad: number): number {
    for (const b of this.boxes) if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return b.top;
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

  /** Lowest camera height at (x, z) over solid things: the drawn ground, a rock or the deck, plus a margin. */
  landFloor(x: number, z: number): number {
    return Math.max(this.surfaceH(x, z), islandH(x, z), rockTop(x, z), inPier(x, z, 0.3) ? deckH(x) : -Infinity) + 0.3;
  }

  /** Lowest camera height at (x, z) for the walking camera: as landFloor, or just above the water. */
  camFloor(x: number, z: number): number {
    return Math.max(this.landFloor(x, z), SEA_Y + 0.45);
  }

  /** 0…1 closeness to the open water (for the ambience). */
  seaNear(x: number, z: number): number {
    const u = x - roadX(z);
    return Math.max(0, Math.min(1, 1 - (u + 8) / 40));
  }
}

export { ISLAND, LIGHTHOUSE };
