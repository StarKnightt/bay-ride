import { ROAD_Z0, ROAD_Z1, RIBBON_HALF, SEA_Y, roadX } from "../world/bay/road";
import { ISLAND, WALL_OUT, islandH, meshH } from "../world/bay/terrain";
import { rampH } from "../world/bay/slipway";
import { PIER } from "../world/bay/pier";

/**
 * Where things may grow: the ground as drawn (the coastal mesh's triangles, or the island) and a
 * spatial registry of everything that keeps grass and flowers out (house footprints, lanes, paths,
 * walls) or invites them (flower spots by rocks, posts, lamps and path edges). The town and props
 * fill it first; the flora reads it.
 */

/** Ground height as drawn at (x, z): the coastal mesh, or the island where it stands higher. */
export function groundY(x: number, z: number): number {
  const h = meshH(x, z);
  const dx = x - ISLAND.x, dz = z - ISLAND.z;
  return dx * dx + dz * dz < 90 * 90 ? Math.max(h, islandH(x, z)) : h;
}

/** Ground slope (1 - normal.y) by central differences over ~0.6 m. */
export function slopeAt(x: number, z: number): number {
  const e = 0.6;
  const gx = (groundY(x + e, z) - groundY(x - e, z)) / (2 * e);
  const gz = (groundY(x, z + e) - groundY(x, z - e)) / (2 * e);
  return 1 - 1 / Math.sqrt(1 + gx * gx + gz * gz);
}

/** Road-relative lateral coordinate (+ inland). */
export const uOf = (x: number, z: number) => x - roadX(z);

export type FlowerKind = "lavender" | "poppy" | "pink" | "daisy" | "yellow" | "thrift" | "hydrangea" | "weed" | "fern";

export interface Spot {
  x: number;
  z: number;
  /** Explicit base height (window boxes, planters); NaN = on the ground. */
  y: number;
  /** Drift radius, number of clumps and the mix of kinds. */
  r: number;
  n: number;
  kinds: FlowerKind[];
  /** Size multiplier (window boxes and pots hold smaller plants). */
  s: number;
}

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  hw: number;
}
interface Rect {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

const CELL = 8;
const key = (i: number, j: number) => i * 4096 + j;

/** Spatial registry of keep-out shapes (8 m buckets) and the flower spots the props ask for. */
export class Layout {
  private readonly cells = new Map<number, (Seg | Rect)[]>();
  readonly spots: Spot[] = [];
  /** Gull perches (x, y, z, yaw): post tops, ridges, lamps. */
  readonly perches: [number, number, number, number][] = [];

  /** Bucketed with a 2 m margin, so pads up to 2 m see shapes in the neighbouring cells. */
  private add(s: Seg | Rect, x0: number, x1: number, z0: number, z1: number): void {
    const M = 2;
    for (let i = Math.floor((x0 - M) / CELL); i <= Math.floor((x1 + M) / CELL); i++)
      for (let j = Math.floor((z0 - M) / CELL); j <= Math.floor((z1 + M) / CELL); j++) {
        const k = key(i, j);
        let l = this.cells.get(k);
        if (!l) this.cells.set(k, (l = []));
        l.push(s);
      }
  }

  /** No grass inside this world-axis box. */
  rect(x0: number, x1: number, z0: number, z1: number): void {
    this.add({ x0, x1, z0, z1 }, x0, x1, z0, z1);
  }

  /** No grass within `hw` of the segment a-b (lanes, paths, walls, fences' feet). */
  seg(ax: number, az: number, bx: number, bz: number, hw: number): void {
    this.add({ ax, az, bx, bz, hw }, Math.min(ax, bx) - hw, Math.max(ax, bx) + hw, Math.min(az, bz) - hw, Math.max(az, bz) + hw);
  }

  /** A polyline of segments. */
  line(pts: readonly (readonly [number, number])[], hw: number): void {
    for (let i = 0; i + 1 < pts.length; i++) this.seg(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], hw);
  }

  spot(x: number, z: number, r: number, n: number, kinds: FlowerKind[], y = NaN, s = 1): void {
    this.spots.push({ x, z, y, r, n, kinds, s });
  }

  /** Distance past the nearest keep-out edge (negative = inside one), capped at `cap`. */
  clearance(x: number, z: number, cap = 4): number {
    const l = this.cells.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
    let best = cap;
    if (!l) return best;
    for (const s of l) {
      let d: number;
      if ("hw" in s) {
        const ex = s.bx - s.ax, ez = s.bz - s.az;
        const L2 = ex * ex + ez * ez || 1;
        const t = Math.max(0, Math.min(1, ((x - s.ax) * ex + (z - s.az) * ez) / L2));
        d = Math.hypot(x - s.ax - ex * t, z - s.az - ez * t) - s.hw;
      } else {
        const dx = Math.max(s.x0 - x, x - s.x1), dz = Math.max(s.z0 - z, z - s.z1);
        d = dx > 0 || dz > 0 ? Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) : Math.max(dx, dz);
      }
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Can a plant grow at (x, z)? Not on a keep-out shape, the road, the promenade or the sea wall, a
   * slipway, the pier, or in the sea.
   */
  free(x: number, z: number, pad = 0): boolean {
    if (z < ROAD_Z0 + 30 && z > ROAD_Z1 - 30) {
      const u = uOf(x, z);
      if (u > WALL_OUT - 0.3 && u < RIBBON_HALF + 0.25) return false;
    }
    if (this.clearance(x, z) < pad) return false;
    if (rampH(x, z, 0.6 + pad) > -Infinity) return false;
    if (Math.abs(z - PIER.z) < PIER.half + 0.6 && x < PIER.x0 + 1 && x > PIER.x1 - 1) return false;
    return groundY(x, z) > SEA_Y + 0.25;
  }
}
