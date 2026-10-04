/**
 * The coast road. It runs along the bay toward -Z (harbour end) with the sea on the left (-x) and
 * the hill on the right (+x). Lateral coordinate `u` is a horizontal offset from the centreline:
 * world x = roadX(z) + u, +u = the rider's right (hill), -u = the left (beach, sea).
 *
 * Heights: the road is the y = 0 datum; mean sea level sits at SEA_Y below it.
 */
export const SEA_Y = -3.0;
/** Road ends: north end (+z) and harbour end (-z). The bike stays between them. */
export const ROAD_Z0 = 170;
export const ROAD_Z1 = -230;
export const ROAD_HALF = 2.4; // asphalt half width
export const RIBBON_HALF = 3.6; // road mesh half width (edges blend into kerb / verge)
export const RAIL = 2.75; // invisible guide rail: max |u| for the bike

/** How far the road bows inland at the middle of the bay. */
const BOW = 45;
const MID = (ROAD_Z0 + ROAD_Z1) / 2;
const HALF = (ROAD_Z0 - ROAD_Z1) / 2;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

export function roadX(z: number): number {
  return BOW * Math.cos(clamp((z - MID) / HALF, -1, 1) * (Math.PI / 2));
}

export function roadDX(z: number): number {
  const t = (z - MID) / HALF;
  if (t <= -1 || t >= 1) return 0;
  return -BOW * Math.sin(t * (Math.PI / 2)) * (Math.PI / 2) / HALF;
}

/** Yaw (three.js rotation.y) of a rider travelling toward -Z along the road at z. */
export function roadYaw(z: number): number {
  return Math.atan(roadDX(z));
}

export function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Deterministic smooth pseudo noise in [0,1] for placement / terrain detail. */
export function pnoise(x: number, z: number, s = 0): number {
  const v =
    Math.sin(x * 0.031 + z * 0.017 + s * 1.7) * 0.5 +
    Math.sin(x * 0.073 - z * 0.051 + s * 3.1) * 0.3 +
    Math.sin(x * 0.19 + z * 0.23 + s) * 0.2;
  return v * 0.5 + 0.5;
}
