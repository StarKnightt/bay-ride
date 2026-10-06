/**
 * Time-of-day values only the water reads; world/timeofday.ts writes them with the shared ones.
 * uDusk is 1 at dusk and 0 at every other preset (blended through the transitions): the twilight
 * sky still lights the water, so the night's darker mirror eases off and the mirrored land takes
 * the deep water's blue-violet.
 */
export const WATER_TOD = {
  uDusk: { value: 0 },
};
