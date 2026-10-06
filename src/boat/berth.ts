import { HULL } from "./model";
import { PIER, PIER_GAP, PIER_STAGE, PIER_STAIR, deckH } from "../world/bay/pier";

/**
 * Where the skiff is moored: alongside the low landing stage off the south side of the pier end,
 * bow out toward the end, her bench beside the stage's mooring pile. She goes down the stair from
 * the deck, across the stage and one short step down into her; coming in she steps up onto the
 * stage and climbs the stair. Her bow line runs to the west bollard, her stern line to the cleat on
 * the stage's pile. Everything else (boarding, mooring, stepping ashore, the opening view) reads it
 * from here.
 */

export interface Berth {
  /** Boat centre (world x, z) and heading (three.js yaw; forward = (-sin, -cos)). */
  x: number;
  z: number;
  yaw: number;
  /** Where she stands on the deck by the stair head to go aboard or ashore, and the deck height there. */
  stand: { x: number; z: number; y: number };
  /** Where she stands on the stage, facing the boat, to step aboard (and steps ashore to). */
  stage: { x: number; z: number; y: number };
  /** Boarding reach: within this distance (m) of `stand` she can go aboard with F (and anywhere on the stair or stage). */
  reach: number;
}

const stage = { x: -90.95, z: PIER_STAGE.z1 + 0.24, y: PIER_STAGE.y };
const sx = PIER_STAIR.x0 - 0.4;

export const BERTH: Berth = {
  x: stage.x - 1.3,
  z: PIER_STAGE.z1 - 0.17 - HULL.halfBeam,
  yaw: Math.PI / 2,
  stand: { x: sx, z: PIER.z - PIER.half + 0.4, y: deckH(sx) },
  stage,
  reach: 3.6,
};

/**
 * The opening: she stands near the pier end, facing out over the skiff to the island; the camera's
 * orbit (bearing from behind her, pitch, distance) frames her, the boat below and the lighthouse.
 */
export const SPAWN = { x: PIER_GAP.x1 + 0.6, z: PIER.z - 0.9, yaw: 2.2, orbit: [0, 0.17, 6.6] as [number, number, number] };
