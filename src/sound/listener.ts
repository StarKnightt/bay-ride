import { roadX } from "../world/bay/road";
import { waterlineU } from "../world/bay/terrain";

export interface CoastCues {
  /** Distance to the beach waterline, m. */
  shore: number;
  /** Direction of the shoreline relative to the facing direction: −1 left … 1 right. */
  shorePan: number;
  /** 0 on land … 1 well out on the bay. */
  sea: number;
}

const out: CoastCues = { shore: 30, shorePan: -0.5, sea: 0 };

/**
 * Where the breaking shoreline is relative to a listener at (x, z) facing (fx, fz) on the ground plane.
 * The beach runs along the coast road, so the waterline is found across the road at `waterlineU`.
 */
export function coastCues(x: number, z: number, fx: number, fz: number): CoastCues {
  const u = x - roadX(z);
  const uw = waterlineU(z);
  const toShore = Math.sign(uw - u) || -1; // +x if the shore lies toward the hill (we're on the water)
  const l = Math.hypot(fx, fz) || 1;
  out.shore = Math.abs(u - uw);
  // right vector of the facing direction is (−fz, fx); dot with (toShore, 0)
  out.shorePan = Math.max(-1, Math.min(1, (-fz / l) * toShore));
  out.sea = Math.max(0, Math.min(1, (uw - u - 12) / 70));
  return out;
}
