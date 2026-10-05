import { roadX } from "../bay/road";

/**
 * Footpaths over the hill, as road-relative (u, z) polylines: worn tracks painted into the
 * ground's colour, kept clear of tall grass and edged with flowers. They link the top of the
 * town's main lane, a viewpoint bench above the bay, and a big tree on the north slope.
 */
export const PATHS_UZ: readonly (readonly [number, number])[][] = [
  [[58, -181], [64, -172], [71, -158], [77, -140], [82, -126], [86, -104], [89, -78], [91, -50], [93, -20], [95, 15], [97, 50], [98, 74]],
  [[5.5, 38], [14, 42], [26, 48], [40, 56], [54, 64], [68, 72], [84, 74], [98, 74]],
  [[5.5, -120], [20, -117], [38, -121], [60, -128], [82, -126]],
];

/** The paths in world (x, z). */
export const PATHS: [number, number][][] = PATHS_UZ.map((p) => p.map(([u, z]) => [roadX(z) + u, z] as [number, number]));

/** Viewpoint benches along them (road-relative u, z), facing the sea. */
export const VIEW_BENCHES: [number, number][] = [[82.5, -124], [70, 78]];

/** Distance from (x, z) to the nearest path centreline (m), capped at `cap`. */
export function pathDist(x: number, z: number, cap = 8): number {
  let best = cap;
  for (const p of PATHS)
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, az] = p[i], [bx, bz] = p[i + 1];
      if (Math.min(ax, bx) - cap > x || Math.max(ax, bx) + cap < x || Math.min(az, bz) - cap > z || Math.max(az, bz) + cap < z) continue;
      const ex = bx - ax, ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
      const d = Math.hypot(x - ax - ex * t, z - az - ez * t);
      if (d < best) best = d;
    }
  return best;
}
