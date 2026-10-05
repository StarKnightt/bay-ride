import type { Vector3 } from "three";

/**
 * The world's side of the sound: a small post box that never allocates. The systems where things
 * happen (the gulls, the fish) post placed cues and keep the listener's pose current; RideAudio takes
 * the cues on its next update and places each sound around the listener. Nothing here needs an
 * AudioContext, so the world may post before the sound has started (stale cues are dropped there).
 */

/** A perched gull takes off. `a` = its flap phase (cycles) at that moment, `b` = flaps per second. */
export const CUE_TAKEOFF = 1;
/** A leaping fish leaves the water. `a` = its size (0.8…1.3). */
export const CUE_FISH_OUT = 2;
/** The fish falls back in. `a` = its size. */
export const CUE_FISH_IN = 3;

/** One posted cue: kind, world position, the world-clock time it happens at (s), two parameters. */
export interface Cue {
  kind: number;
  x: number;
  y: number;
  z: number;
  at: number;
  a: number;
  b: number;
}

/** Gulls the sound can voice, flying ones first, then the perched ones. */
export interface GullSource {
  readonly voices: number;
  /** Where gull i is `ahead` s after the last update (written to `out`): 0 hidden, 1 flying, 2 perched. */
  where(i: number, ahead: number, out: Vector3): number;
}

const CAP = 16;
const W = 7;

class CueBus {
  /** The ears (the camera), their horizontal forward (unit), her position and the world clock. */
  x = 0;
  y = 0;
  z = 0;
  fx = 0;
  fz = -1;
  px = 0;
  pz = 0;
  t = 0;
  /** Set once the world has reported a listener. */
  live = false;
  gulls: GullSource | null = null;
  private readonly q = new Float64Array(CAP * W);
  private head = 0;
  private n = 0;

  /** Per frame: the camera position and horizontal facing, her position, the world clock. */
  listen(ear: Vector3, fx: number, fz: number, px: number, pz: number, t: number): void {
    this.x = ear.x;
    this.y = ear.y;
    this.z = ear.z;
    this.fx = fx;
    this.fz = fz;
    this.px = px;
    this.pz = pz;
    this.t = t;
    this.live = true;
  }

  /** Post a cue happening at world time `at`; when full, the oldest gives way. */
  post(kind: number, x: number, y: number, z: number, at: number, a = 0, b = 0): void {
    if (this.n === CAP) {
      this.head = (this.head + 1) % CAP;
      this.n--;
    }
    const i = ((this.head + this.n) % CAP) * W, q = this.q;
    q[i] = kind;
    q[i + 1] = x;
    q[i + 2] = y;
    q[i + 3] = z;
    q[i + 4] = at;
    q[i + 5] = a;
    q[i + 6] = b;
    this.n++;
  }

  /** Move the oldest cue into `out`; false when there is none. */
  take(out: Cue): boolean {
    if (this.n === 0) return false;
    const i = this.head * W, q = this.q;
    out.kind = q[i];
    out.x = q[i + 1];
    out.y = q[i + 2];
    out.z = q[i + 3];
    out.at = q[i + 4];
    out.a = q[i + 5];
    out.b = q[i + 6];
    this.head = (this.head + 1) % CAP;
    this.n--;
    return true;
  }
}

export const cues = new CueBus();
