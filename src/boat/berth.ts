import { SEA_Y, roadX } from "../world/bay/road";
import { terrainH, waterlineU } from "../world/bay/terrain";

/**
 * Where the skiff is moored: the harbour end of the bay, just off the beach below the coast road,
 * a little south of the line the wooden pier will run out along (PIER_Z, toward the pier end that
 * capture shot 3 looks back from) and clear of the rocks off this stretch of beach. She lies along
 * the shore with her bow toward the harbour.
 *
 * Until the pier exists the berth is reached by wading: `stand` is in knee-deep water abeam of the
 * boat on its shoreward side. The pier builder can move the berth alongside the pier and `stand`
 * onto the deck; everything else (boarding, mooring, stepping ashore) reads it from here.
 */

/** Line of the future pier (world z) and the pier end (shot 3's eye). */
export const PIER_Z = -193;
export const PIER_END_X = -92;

/** Mooring position (world z) and still-water depth under the boat there. */
const BERTH_Z = -207;
const BERTH_DEPTH = 0.7;
/** Water she wades through to step aboard or ashore here. */
const STAND_DEPTH = 0.4;

/** First point seaward of the waterline along z where the seabed lies `depth` under mean sea level. */
function offshoreAt(z: number, depth: number): number {
  const x0 = roadX(z) + waterlineU(z);
  for (let d = 0; d < 120; d += 0.05) {
    if (terrainH(x0 - d, z) <= SEA_Y - depth) return x0 - d;
  }
  return x0 - 120;
}

export interface Berth {
  /** Boat centre (world x, z) and heading (three.js yaw; forward = (-sin, -cos)). */
  x: number;
  z: number;
  yaw: number;
  /** Where she stands to step aboard or ashore, and the ground height there. */
  stand: { x: number; z: number; y: number };
  /** Boarding reach: within this distance (m) of the hull she can step aboard with F. */
  reach: number;
}

const bx = offshoreAt(BERTH_Z, BERTH_DEPTH);
// Along the depth contour, heading south (toward the harbour).
const dxdz = (offshoreAt(BERTH_Z + 3, BERTH_DEPTH) - offshoreAt(BERTH_Z - 3, BERTH_DEPTH)) / 6;
const yaw = Math.atan2(dxdz, 1);
const sx = offshoreAt(BERTH_Z, STAND_DEPTH);

export const BERTH: Berth = {
  x: bx,
  z: BERTH_Z,
  yaw,
  stand: { x: sx, z: BERTH_Z, y: Math.max(terrainH(sx, BERTH_Z), SEA_Y - STAND_DEPTH) },
  reach: 3.2,
};
