/**
 * The capture scenario (?boat=1): the skiff drives a fixed course as a pure function of time, so
 * the same t always gives the same frame. It sets off from rest, accelerates out across the bay
 * toward the island, swings north past the red buoy in front of the lighthouse view, loops round
 * under the north headland and runs back south along the bay at cruising speed.
 */

/** Course: straight runs and arcs (signed curvature: + turns left). */
type Seg = { len: number; k: number };
const START = { x: -30, z: 22, yaw: Math.PI / 2 + 0.3 };
const SEGS: Seg[] = [
  { len: 64, k: 0 },
  { len: 42 * 0.69, k: 1 / 42 },
  { len: 75, k: 0 },
  { len: 55 * 3.6, k: 1 / 55 },
  { len: 400, k: 0 },
];
/** Top speed (m/s), spin-up time constant (s); the course loops after LOOP seconds. */
const V1 = 8.2;
const TAU = 2.6;
export const SCRIPT_LOOP = 60;

export interface ScriptPose {
  x: number;
  z: number;
  yaw: number;
  /** Forward speed (m/s), yaw rate (rad/s), throttle 0…1, distance travelled (m). */
  speed: number;
  yawRate: number;
  throttle: number;
  s: number;
}

interface Node { x: number; z: number; yaw: number; s: number }
const NODES: Node[] = (() => {
  const out: Node[] = [];
  let { x, z, yaw } = START, s = 0;
  for (const g of SEGS) {
    out.push({ x, z, yaw, s });
    [x, z, yaw] = advance(x, z, yaw, g.k, g.len);
    s += g.len;
  }
  out.push({ x, z, yaw, s });
  return out;
})();

function advance(x: number, z: number, yaw: number, k: number, d: number): [number, number, number] {
  if (Math.abs(k) < 1e-9) return [x - Math.sin(yaw) * d, z - Math.cos(yaw) * d, yaw];
  const y1 = yaw + k * d;
  return [x + (Math.cos(y1) - Math.cos(yaw)) / k, z - (Math.sin(y1) - Math.sin(yaw)) / k, y1];
}

/** Distance along the course and speed at time t (from rest at t = 0). */
function travel(t: number): [number, number] {
  if (t <= 0) return [0, 0];
  const e = Math.exp(-t / TAU);
  return [V1 * (t - TAU * (1 - e)), V1 * (1 - e)];
}

export function scriptPose(time: number, out: ScriptPose): ScriptPose {
  const t = time < 0 ? time : time % SCRIPT_LOOP;
  const [s, v] = travel(t);
  let i = 0;
  while (i < SEGS.length - 1 && s > NODES[i + 1].s) i++;
  const n = NODES[i], g = SEGS[i];
  const [x, z, yaw] = advance(n.x, n.z, n.yaw, g.k, Math.min(s - n.s, g.len + 50));
  out.x = x;
  out.z = z;
  out.yaw = yaw;
  out.speed = v;
  out.yawRate = g.k * v;
  // Full throttle while spinning up, easing to a cruise setting.
  out.throttle = t <= 0 ? 0 : 0.82 + 0.18 * Math.exp(-Math.max(t - 4, 0) / 2);
  out.s = s;
  return out;
}
