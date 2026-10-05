import { HULL } from "./model";
import { PIER, PIER_GAP, deckH } from "../world/bay/pier";

/**
 * Where the skiff is moored: alongside the south side of the pier end, bow out to sea, in the gap in
 * the railing between the two bollards her lines run to. She steps down into it from the deck and
 * back up onto the deck when she comes in; everything else (boarding, mooring, stepping ashore,
 * the opening view) reads it from here.
 */

export interface Berth {
  /** Boat centre (world x, z) and heading (three.js yaw; forward = (-sin, -cos)). */
  x: number;
  z: number;
  yaw: number;
  /** Where she stands on the deck to step aboard or ashore, and the deck height there. */
  stand: { x: number; z: number; y: number };
  /** Boarding reach: within this distance (m) of `stand` she can step aboard with F. */
  reach: number;
}

const bx = (PIER_GAP.x0 + PIER_GAP.x1) / 2 + 0.1;
const sz = PIER.z - PIER.half + 0.35;

export const BERTH: Berth = {
  x: bx,
  z: PIER.z - PIER.half - HULL.halfBeam - 0.62,
  yaw: Math.PI / 2,
  stand: { x: bx, z: sz, y: deckH(bx) },
  reach: 3.6,
};

/**
 * The opening: she stands near the pier end, facing out over the skiff to the island; the camera's
 * orbit (bearing from behind her, pitch, distance) frames her, the boat below and the lighthouse.
 */
export const SPAWN = { x: PIER_GAP.x1 + 0.6, z: PIER.z - 0.9, yaw: 2.2, orbit: [0, 0.17, 6.6] as [number, number, number] };
