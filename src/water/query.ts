import * as THREE from "three";
import { SEA_Y } from "../world/bay/road";
import { waterAt, waveEta, type WaterAt } from "./waves";

/**
 * One water query for the whole bay (open water, surf zone and the swash on the sand), the same
 * surface the sea mesh draws: swell trains, refracted and breaking toward the shore, plus the
 * longer wind-chop trains offshore. For boats, buoys, the rider and effects.
 */
export interface WaterSample {
  /** Surface height (world y). On dry sand: NaN. */
  y: number;
  /** Surface normal (unit). */
  normal: THREE.Vector3;
  /** Water depth over the ground (m), 0 when dry. */
  depth: number;
  /** 0…1 wetness of the sand (1 under water). */
  wet: number;
}

const E = 0.6;
const _w: WaterAt = { y: NaN, depth: 0, wet: 0 };

/** Sea surface height (world y) at (x, z), time t, ignoring the beach (the open-sea surface). */
export function seaHeight(x: number, z: number, t: number): number {
  return SEA_Y + waveEta(x, z, t);
}

/** Sea surface normal at (x, z), time t (finite differences over ~1 m: what a hull feels). */
export function seaNormal(x: number, z: number, t: number, out = new THREE.Vector3()): THREE.Vector3 {
  const dx = (waveEta(x + E, z, t) - waveEta(x - E, z, t)) / (2 * E);
  const dz = (waveEta(x, z + E, t) - waveEta(x, z - E, t)) / (2 * E);
  return out.set(-dx, 1, -dz).normalize();
}

/** Full sample: height, normal, depth and wetness over ground height `ground` (terrain at x, z). */
export function waterSample(x: number, z: number, t: number, ground: number, out?: WaterSample): WaterSample {
  const o = out ?? { y: NaN, normal: new THREE.Vector3(0, 1, 0), depth: 0, wet: 0 };
  waterAt(x, z, t, ground, _w);
  o.y = _w.y;
  o.depth = _w.depth;
  o.wet = _w.wet;
  if (Number.isNaN(_w.y)) o.normal.set(0, 1, 0);
  else seaNormal(x, z, t, o.normal);
  return o;
}
