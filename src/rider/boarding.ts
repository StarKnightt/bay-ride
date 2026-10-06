import * as THREE from "three";
import type { Boat } from "../boat/boat";
import { BERTH } from "../boat/berth";
import { BENCH, FLOOR_Y, gunwaleAt, halfWidthAt, stationOf } from "../boat/model";
import { PIER, PIER_STAGE, PIER_STAIR, STAGE_POST, STAIR_FOOT_X, stairRailH } from "../world/bay/pier";
import { JUMP_CLIP, gaitCycle, type GaitInfo } from "./rider";

/**
 * Stepping aboard the skiff and ashore again, as a scripted move over her clips (walk, idle, jump,
 * sit_tiller), a pure function of its own clock: the same time always gives the same pose, boat
 * dip included, so a frozen capture shows exactly what play shows.
 *
 * At the berth she walks round the bollard to the head of the stair, goes down it a foot to a tread
 * (each sole planted flat on its tread, her right hand sliding down the rail), crosses the landing
 * stage turning to the boat, puts her right hand on the mooring pile and steps down onto the bench
 * (the hull dips and rocks under her), on down onto the floorboards turning to the bow, and sits at
 * the tiller. Leaving, she stands, steps up onto the bench and the stage (left hand on the pile),
 * turns to the stair and climbs it (left hand on the rail), and walks back to where she started.
 * The stair, the stage and the step in or out are footholds: per foot, where it lifts off, where it
 * lands and when; her root follows the feet. From a beach she walks to the hull, puts a hand on the
 * gunwale and hops over it (in or out, landing in the shallows with a splash).
 *
 * Segments are planned once (when F is pressed); points on the boat are kept in the boat frame so
 * she stays on the bench as it bobs.
 */
export type TransitKind = "board" | "boardShore" | "leaveBerth" | "leaveShore";

/** On-foot gravity (the jump's). */
const GRAV = 13;
/** Boat-frame points: the foot on the bench (its port end), standing in front of it facing the bow. */
const BENCH_STEP = new THREE.Vector3(-0.4, BENCH.top, BENCH.z);
/** Up onto the bench leaving at the berth: nearer the middle, so the knee over the foot stays inside the gunwale. */
const BENCH_UP = new THREE.Vector3(-0.27, BENCH.top, BENCH.z);
const STAND = new THREE.Vector3(-0.3, FLOOR_Y, 0.86);
/** Over the side (shore): along the boat between the thwart and the bench. */
const SIDE_Z = 0.62;
/** Standing over the side (shore) at boat z: her centre this far out from the keel, on the floorboards and short of the planking. */
const insideX = (z = SIDE_Z) => Math.min(gunwaleAt(z).half - 0.32, halfWidthAt(stationOf(z), FLOOR_Y + 0.02) - 0.33);
/**
 * Where along the boat she may land stepping out over the side (boat z, the first preferred: she
 * always goes over between the thwart and the bench, the others are a hop forward along the side
 * for a boat run bow-in up a steep shore), how far out from the planking, and the longest hop (m).
 */
export const SHORE_STATIONS: { z: number; from: number }[] = [
  { z: SIDE_Z, from: 0 },
  { z: 0.05, from: 0 },
  { z: -0.5, from: 1 },
  { z: -1.1, from: 1 },
  { z: -1.5, from: 1 },
];
export const SHORE_OFF = { min: 0.45, max: 1.45, hop: 1.7 };
/**
 * Her centre standing at the side before she goes over (boat frame, x for the starboard side):
 * between the thwart and the bench, or (over the thwart) between it and the bow seat.
 */
const FWD_Z = -0.5;
export const SHORE_FROM = [
  { x: insideX(), z: SIDE_Z },
  { x: insideX(FWD_Z), z: FWD_Z },
];
/** The thwart amidships (boat z of its middle, half depth, top): she steps over it to go forward. */
export const THWART = { z: 0.12, half: 0.11, top: 0.21 };
/** Her resting weight seated (seat 0.3 m to port of the centreline): the hull 2 cm lower, a touch stern-down, listing to port. */
const SEATED = { h: -0.022, p: 0.008, r: 0.012 };

/** The berth's footholds. The stair runs down to the west (yaw π/2 faces it); its walking line. */
const WEST = Math.PI / 2;
const STAIR_Z = (PIER_STAIR.z0 + PIER_STAIR.railZ) / 2 + 0.03;
/** Where she stands at the stair head before the first step, and on the stage at the foot of the stair (climbing). */
export const STAIR_HEAD = { x: PIER_STAIR.x1 + 0.3, z: STAIR_Z, y: PIER.deck };
const STAIR_FOOT = { x: STAIR_FOOT_X - 0.36, z: STAIR_Z + 0.02 };
/** Tread k's centre (world x; 0 = the head, n = the stage). */
const treadX = (k: number) => PIER_STAIR.x1 - (k - 0.5) * PIER_STAIR.going;
const treadY = (k: number) => (k <= 0 ? PIER.deck : k >= PIER_STAIR.n ? PIER_STAGE.y : PIER.deck - k * PIER_STAIR.rise);
/** How far between the lower and the higher foot her root rides (the knees take the rest). */
const ROOT_K = 0.35;

type SegKind = "walk" | "crouch" | "hop" | "land" | "sit" | "stand" | "steps";
interface Pt {
  v: THREE.Vector3;
  /** In the boat frame (else world). */
  boat: boolean;
}
/** A foothold: where the foot comes to rest, its heading, and the swing that brings it there. */
interface Hold {
  p: Pt;
  /** World yaw of the foot (the walker's convention), or relative to the boat's heading. */
  yaw: number;
  rel: boolean;
  /** Lift-off and strike (s, transition clock); the first hold is where the foot starts (t0 = t1). */
  t0: number;
  t1: number;
  /** Swing: arc height over the straight line, and when the height change happens (down: from d, up: by d). */
  lift: number;
  d: number;
}
/** Her root at a strike: the holds both feet are on, her facing (unwrapped), the clips' gait speed and phase. */
interface Key {
  t: number;
  h: [number, number];
  yaw: number;
  rel: boolean;
  v: number;
  ph: number;
}
interface Steps {
  holds: [Hold[], Hold[]];
  keys: Key[];
}
interface FootOpts {
  rel?: boolean;
  dbl?: number;
  swing?: number;
  lift?: number;
  d?: number;
  v?: number;
  body?: number;
}
interface Grip {
  /** A point (world or boat) or the stair rail (her hand slides along it, `dir` ahead of her root). */
  p: Pt | null;
  dir: number;
  side: number;
  t: [number, number, number, number];
}
interface Seg {
  kind: SegKind;
  t0: number;
  t1: number;
  a: Pt;
  b: Pt;
  /** Facing at the start, on the way (walks) and at the end; relative to the boat's heading if `rel`. */
  ya: number;
  yh: number;
  yb: number;
  yaRel: boolean;
  ybRel: boolean;
  /** Hop take-off speed (m/s, up); a crouch's depth (0..1, 0 = full). */
  vy: number;
  /** A crouch's root offset at its end (world): the next segment (hop) eases it out. */
  off: THREE.Vector3 | null;
  /** Walk on land: follow the ground (else eased between the end heights), on a curve through `c` (and `c2`) if set (world). */
  ground: boolean;
  c: THREE.Vector3 | null;
  c2: THREE.Vector3 | null;
  /** Walked distance (m) before this segment and in it (walks), for the gait phase. */
  d0: number;
  len: number;
  /** Footholds (steps). */
  st: Steps | null;
  /** Gait phase (cycles) at the start (steps). */
  ph0: number;
}

/** Her pose at a transition time. */
export interface TransitPose {
  pos: THREE.Vector3;
  yaw: number;
  quat: THREE.Quaternion;
  seat: number;
  speed: number;
  phase: number;
  jumpT: number;
  jumpW: number;
  air: number;
  reach: THREE.Vector3;
  reachW: number;
  reachSide: number;
  /** Scripted feet, per foot [right, left]: ground point under the ankle, weight, heading, planted. */
  stepP: THREE.Vector3[];
  stepW: number[];
  stepYaw: number[];
  stepDown: boolean[];
  /** Her feet are on the boat (the bench / floorboards are her ground). */
  onBoat: boolean;
  /** Finished (seated, or standing ashore). */
  done: boolean;
}

const smooth = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (u: number) => u * u * (3 - 2 * u);
const _p = new THREE.Vector3(), _p2 = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _r = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const _ry = [0, 0, 0, 0];
const _up = new THREE.Vector3(0, 1, 0);
const pt = (x: number, y: number, z: number, boat: boolean): Pt => ({ v: new THREE.Vector3(x, y, z), boat });
/** Rotate walker-space (x, z) by yaw: world offset. */
const rotX = (x: number, z: number, yaw: number) => x * Math.cos(yaw) + z * Math.sin(yaw);
const rotZ = (x: number, z: number, yaw: number) => -x * Math.sin(yaw) + z * Math.cos(yaw);
/** Monotone cubic (Fritsch–Carlson) slope at the middle of three samples. */
const slope = (t0: number, y0: number, t1: number, y1: number, t2: number, y2: number) => {
  const d0 = (y1 - y0) / Math.max(t1 - t0, 1e-6), d1 = (y2 - y1) / Math.max(t2 - t1, 1e-6);
  return d0 * d1 <= 0 ? 0 : (2 * d0 * d1) / (d0 + d1);
};
const hermite = (t0: number, y0: number, m0: number, t1: number, y1: number, m1: number, t: number) => {
  const h = t1 - t0, s = h > 1e-6 ? (t - t0) / h : 1, s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * y0 + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * y1 + (s3 - s2) * h * m1;
};
/** Key times and values around an interval (its ends are the middle two). */
const _T = [0, 0, 0, 0], _V = [0, 0, 0, 0];
/** Monotone cubic over _T/_V's middle interval at t; level at the first and last keys. */
function pchip(t: number, first: boolean, last: boolean): number {
  const m1 = first ? 0 : slope(_T[0], _V[0], _T[1], _V[1], _T[2], _V[2]);
  const m2 = last ? 0 : slope(_T[1], _V[1], _T[2], _V[2], _T[3], _V[3]);
  return hermite(_T[1], _V[1], m1, _T[2], _V[2], m2, Math.min(Math.max(t, _T[1]), _T[2]));
}

export class Boarding {
  kind: TransitKind = "board";
  /** Total length (s). */
  end = 0;
  /** Landing aboard (or ashore), the take-off: for sounds and the boat's dip. */
  tLand = 0;
  tOff = 0;
  /** Contact frame: the supporting hand reaches its target (the first grip). */
  tHand = 0;
  /** The step in (or out): from the first foot leaving to the last landing (s). */
  stepSpan = [0, 0];
  private segs: Seg[] = [];
  private phase0 = 0;
  private grips: Grip[] = [];
  /** Her weight in the boat frame (x, z) for the roll and pitch it causes; when it comes aboard (+1) or leaves (-1). */
  private loadX = -0.3;
  private loadZ = 1.3;
  private loadIn = 1;
  /** Footholds under construction: the steps segment, its clock. */
  private st: Steps | null = null;
  private sT = 0;
  /** The finished state: walker on land (leave) or on the seat. */
  readonly out: TransitPose = {
    pos: new THREE.Vector3(), yaw: 0, quat: new THREE.Quaternion(), seat: 0, speed: 0, phase: 0, jumpT: 0, jumpW: 0, air: 0,
    reach: new THREE.Vector3(), reachW: 0, reachSide: -1,
    stepP: [new THREE.Vector3(), new THREE.Vector3()], stepW: [0, 0], stepYaw: [0, 0], stepDown: [true, true],
    onBoat: false, done: false,
  };

  constructor(
    private boat: Boat,
    /** Walkable ground height at world (x, z) (NaN: none). */
    private groundH: (x: number, z: number, y: number) => number,
    /** Her clips' stance and stride timing. */
    private gait: GaitInfo,
  ) {}

  /** Seconds a walk of d metres takes (eased from and to a stop; peak about 1.5x the mean). */
  private static walkT(d: number): number {
    return Math.min(4.5, Math.max(0.42, 0.3 + d / 1.6));
  }

  private seg(kind: SegKind, dur: number, a: Pt, b: Pt, ya: number, yb: number, o: Partial<Seg> = {}): Seg {
    const t0 = this.end;
    const s: Seg = {
      kind, t0, t1: t0 + dur, a, b, ya, yh: NaN, yb, yaRel: false, ybRel: false, vy: 0, ground: false, c: null, c2: null,
      off: null, d0: 0, len: 0, st: null, ph0: 0, ...o,
    };
    this.end = s.t1;
    this.segs.push(s);
    return s;
  }

  private world(p: Pt, out: THREE.Vector3): THREE.Vector3 {
    if (!p.boat) return out.copy(p.v);
    this.boat.root.updateMatrixWorld(true);
    return out.copy(p.v).applyMatrix4(this.boat.root.matrixWorld);
  }
  private toBoat(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    this.boat.root.updateMatrixWorld(true);
    return out.set(x, y, z).applyMatrix4(_m.copy(this.boat.root.matrixWorld).invert());
  }

  /** Plan a hop from a to b: the time aloft from the take-off speed and the drop. */
  private hopT(a: Pt, b: Pt, vy: number): number {
    const ya = this.world(a, _p).y, yb = this.world(b, _p2).y;
    const dh = yb - ya;
    const disc = vy * vy - 2 * GRAV * dh;
    return (vy + Math.sqrt(Math.max(disc, 0.01))) / GRAV;
  }

  private begin(kind: TransitKind, phase0: number): void {
    this.kind = kind;
    this.segs.length = 0;
    this.grips.length = 0;
    this.end = 0;
    this.tLand = this.tOff = this.tHand = 0;
    this.stepSpan[0] = this.stepSpan[1] = 0;
    this.phase0 = phase0;
    this.out.done = false;
  }

  private finish(): void {
    let d = 0, ph = this.phase0 / (Math.PI * 2);
    for (const s of this.segs) {
      if (s.kind === "walk") {
        s.d0 = d;
        const A = this.world(s.a, _p), B = this.world(s.b, _p2);
        if (s.c) {
          // The curve's length, by chords.
          let len = 0, px = A.x, pz = A.z;
          for (let k = 1; k <= 32; k++) {
            this.curve(s, A, B, k / 32, _a);
            len += Math.hypot(_a.x - px, _a.z - pz);
            px = _a.x;
            pz = _a.z;
          }
          s.len = len;
        } else s.len = Math.hypot(B.x - A.x, B.z - A.z);
        d += s.len;
        ph += this.walkPhase(s, 1) / (Math.PI * 2);
      } else if (s.kind === "steps" && s.st) {
        // Each strike lands on its foot's strike phase of the walk clip, the next one round from the last.
        s.ph0 = ph;
        let last = ph, prevFoot = -1;
        s.st.keys[0].ph = ph;
        for (let n = 1; n < s.st.keys.length; n++) {
          const k = s.st.keys[n], p = s.st.keys[n - 1];
          const foot = k.h[0] !== p.h[0] ? 0 : k.h[1] !== p.h[1] ? 1 : -1;
          if (foot < 0) {
            k.ph = last;
            continue;
          }
          const target = this.gait.strike[foot];
          let next = Math.floor(last) + target;
          while (next < last + (prevFoot < 0 ? 0.3 : 0.25)) next += 1;
          k.ph = last = next;
          prevFoot = foot;
        }
        ph = last;
      }
    }
  }

  /** Walk s at eased progress e: on its straight line or its curve (quadratic through c, cubic through c and c2). */
  private curve(s: Seg, A: THREE.Vector3, B: THREE.Vector3, e: number, out: THREE.Vector3): THREE.Vector3 {
    const c = s.c!, i = 1 - e;
    if (s.c2) {
      const c2 = s.c2, a = i * i * i, b = 3 * i * i * e, cc = 3 * i * e * e, dd = e * e * e;
      return out.set(a * A.x + b * c.x + cc * c2.x + dd * B.x, 0, a * A.z + b * c.z + cc * c2.z + dd * B.z);
    }
    return out.set(i * i * A.x + 2 * i * e * c.x + e * e * B.x, 0, i * i * A.z + 2 * i * e * c.z + e * e * B.z);
  }

  /** On walk s at eased progress e: position (xz, out) and the travel heading (yaw). */
  private along(s: Seg, A: THREE.Vector3, B: THREE.Vector3, e: number, out: THREE.Vector3): number {
    if (!s.c) {
      out.lerpVectors(A, B, e);
      return Number.isNaN(s.yh) ? Math.atan2(-(B.x - A.x), -(B.z - A.z)) : s.yh;
    }
    this.curve(s, A, B, e, out);
    const n = this.curve(s, A, B, Math.min(1, e + 1e-3), _b), px = n.x, pz = n.z;
    const q = this.curve(s, A, B, Math.max(0, e - 1e-3), _b);
    return Math.atan2(-(px - q.x), -(pz - q.z));
  }

  private grip(p: Pt | null, dir: number, side: number, t0: number, t1: number, t2: number, t3: number): void {
    this.grips.push({ p, dir, side, t: [t0, t1, t2, t3] });
    if (this.grips.length === 1) this.tHand = t1;
  }

  // ---------------------------------------------------------------- footholds

  /** Start footholds with her standing at world (x, y, z) facing yaw (her feet at the idle stance there). */
  private stepsBegin(x: number, y: number, z: number, yaw: number): void {
    const G = this.gait;
    const h = (i: number): Hold => ({ p: pt(x + rotX(G.stance[i].x, G.stance[i].z, yaw), y, z + rotZ(G.stance[i].x, G.stance[i].z, yaw), false), yaw, rel: false, t0: this.end, t1: this.end, lift: 0, d: 0 });
    this.st = { holds: [[h(0)], [h(1)]], keys: [] };
    this.sT = this.end;
    this.key(yaw, false, 0);
    // A moment's pre-roll: the scripted feet blend in over the clip's (standing on the same spot).
    this.sT += 0.15;
    this.key(yaw, false, 0);
  }

  private key(yaw: number, rel: boolean, v: number): void {
    const st = this.st!;
    let y = yaw;
    const prev = st.keys[st.keys.length - 1];
    if (prev && prev.rel === rel) y = prev.yaw + wrapA(yaw - prev.yaw);
    st.keys.push({ t: this.sT, h: [st.holds[0].length - 1, st.holds[1].length - 1], yaw: y, rel, v, ph: 0 });
  }

  /** Where foot i's ankle goes for its sole's middle to be at (x, z) with heading yaw (world). */
  private ankleFor(i: number, x: number, z: number, yaw: number): [number, number] {
    const G = this.gait;
    const cx = (G.heel[i].x + G.ball[i].x) / 2, cz = (G.heel[i].z + G.ball[i].z) / 2;
    return [x - rotX(cx, cz, yaw), z - rotZ(cx, cz, yaw)];
  }

  /**
   * Foot i to p (ankle over it, sole on it) facing yaw: lifting `dbl` after the last strike, swinging
   * for `swing` s; her facing then is `bodyYaw` (default the foot's), the clips' gait speed v.
   */
  private foot(i: number, p: Pt, yaw: number, o: FootOpts = {}): Hold {
    const st = this.st!;
    const t0 = this.sT + (o.dbl ?? 0.1), t1 = t0 + (o.swing ?? 0.34);
    const prev = st.holds[i][st.holds[i].length - 1];
    const down = this.world(p, _p).y < this.world(prev.p, _p2).y - 0.02;
    const h: Hold = { p, yaw, rel: !!o.rel, t0, t1, lift: o.lift ?? 0.07, d: o.d ?? (down ? 0.45 : 0.6) };
    st.holds[i].push(h);
    this.sT = t1;
    this.key(o.body ?? yaw, !!o.rel, o.v ?? 0.75);
    return h;
  }

  /** Foot i to its idle stance around root (x, y, z) facing yaw (world, or boat-relative if rel with a boat-frame root). */
  private stance(i: number, x: number, y: number, z: number, yaw: number, boat: boolean, o: FootOpts = {}): Hold {
    const G = this.gait;
    const p = pt(x + rotX(G.stance[i].x, G.stance[i].z, yaw), y, z + rotZ(G.stance[i].x, G.stance[i].z, yaw), boat);
    return this.foot(i, p, yaw, { ...o, rel: boat });
  }

  /** Close the footholds: still for `hold` s, then the clips take the feet back over a moment. */
  private stepsEnd(hold = 0.05): Seg {
    const st = this.st!;
    const last = st.keys[st.keys.length - 1];
    this.sT += hold;
    this.key(last.yaw, last.rel, 0);
    this.sT += 0.12;
    this.key(last.yaw, last.rel, 0);
    const t0 = st.keys[0].t;
    const a = st.holds[0][0].p, b = st.holds[0][st.holds[0].length - 1].p;
    const s = this.seg("steps", this.sT - t0, a, b, st.keys[0].yaw, last.yaw, { st });
    this.st = null;
    return s;
  }

  /** Down the stair from tread k0 (0: standing at the head) to the stage, starting with foot i0. Returns the next foot. */
  private descend(k0: number, i0: number): number {
    let i = i0;
    for (let k = k0 + 1; k <= PIER_STAIR.n - 1; k++) {
      const [ax, az] = this.ankleFor(i, treadX(k) - 0.025, STAIR_Z + (i === 0 ? -0.1 : 0.1), WEST);
      this.foot(i, pt(ax, treadY(k), az, false), WEST, { dbl: k === k0 + 1 ? 0 : 0.04, swing: 0.34, lift: 0.08, d: 0.62, v: 0.75 });
      i = 1 - i;
    }
    return i;
  }

  /** Across the stage from the stair foot to stand facing the boat beside the pile (foot i first). */
  private toStageEdge(i: number): void {
    const P = BERTH.stage;
    const [ax, az] = this.ankleFor(i, STAIR_FOOT_X - 0.27, STAIR_Z + (i === 0 ? -0.1 : 0.1), WEST - 0.15);
    this.foot(i, pt(ax, PIER_STAGE.y, az, false), WEST - 0.15, { dbl: 0.04, swing: 0.34, lift: 0.08, d: 0.62, v: 0.7 });
    i = 1 - i;
    this.stance(i, (P.x + STAIR_FOOT_X - 0.3) / 2 - 0.05, P.y, (P.z + STAIR_Z) / 2 + 0.05, 0.75, false, { dbl: 0.04, swing: 0.32, v: 0.65 });
    i = 1 - i;
    this.stance(i, P.x, P.y, P.z, 0, false, { dbl: 0.04, swing: 0.32, v: 0.5 });
    i = 1 - i;
    this.stance(i, P.x, P.y, P.z, 0, false, { dbl: 0.04, swing: 0.28, lift: 0.04, v: 0 });
  }

  /** From standing on the stage at the pile, the step down into the boat and on down to the floorboards facing the bow. */
  private stepIn(): void {
    const y0 = this.boat.yaw;
    // A breath with her hand going to the pile, then the right foot down onto the bench.
    this.sT += 0.15;
    this.key(0, false, 0);
    const R = this.foot(0, pt(BENCH_STEP.x, BENCH_STEP.y, BENCH_STEP.z, true), 0.3 - y0, { rel: true, dbl: 0, swing: 0.46, lift: 0.12, d: 0.55, v: 0.3, body: 0.15 - y0 });
    this.stepSpan[0] = R.t0;
    this.tLand = R.t1;
    this.loadX = BENCH_STEP.x;
    this.loadZ = BENCH_STEP.z;
    this.loadIn = 1;
    // The left over the gunwale onto the floor ahead of the bench, turning to the bow; the right down beside it.
    this.stance(1, STAND.x, STAND.y, STAND.z, 0, true, { dbl: 0.13, swing: 0.44, lift: 0.1, d: 0.5, v: 0.3 });
    const R2 = this.stance(0, STAND.x, STAND.y, STAND.z, 0, true, { dbl: 0.06, swing: 0.3, lift: 0.06, d: 0.4, v: 0 });
    this.stepSpan[1] = R2.t1;
  }

  /** The pile's top, from her side (her hand's target), world. */
  private postPt(sx: number, sz: number): Pt {
    const P = STAGE_POST, d = Math.hypot(sx - P.x, sz - P.z) || 1;
    return pt(P.x + ((sx - P.x) / d) * 0.035, P.top + 0.05, P.z + ((sz - P.z) / d) * 0.035, false);
  }

  /** F at the berth: from wherever she is on the deck, the stair or the stage, to the tiller. */
  planBoard(x: number, y: number, z: number, yaw: number, phase: number): void {
    this.begin("board", phase);
    const S = PIER_STAIR, P = BERTH.stage;
    const onStage = y < PIER_STAGE.y + 0.15 && x < S.x1;
    const onStair = !onStage && x < S.x1 && x > STAIR_FOOT_X - 0.05 && z < PIER.z - PIER.half;
    let i = 0, tRail = -1;
    if (onStage) {
      // Across the stage to the pile.
      const d = Math.hypot(P.x - x, P.z - z);
      if (d > 0.12) this.seg("walk", Boarding.walkT(d), pt(x, y, z, false), pt(P.x, P.y, P.z, false), yaw, 0, { yh: Math.atan2(-(P.x - x), -(P.z - z)), ground: true });
      this.stepsBegin(P.x, P.y, P.z, d > 0.12 ? 0 : yaw);
      if (d <= 0.12 && Math.abs(wrapA(yaw)) > 0.1) {
        this.stance(1, P.x, P.y, P.z, 0, false, { dbl: 0, swing: 0.36, lift: 0.04, v: 0 });
        this.stance(0, P.x, P.y, P.z, 0, false, { swing: 0.34, lift: 0.04, v: 0 });
      }
    } else {
      let k0 = 0;
      if (onStair) {
        // From the tread she stands on.
        k0 = Math.min(S.n - 1, Math.max(1, Math.ceil((S.x1 - x) / S.going - 1e-6)));
        this.stepsBegin(x, y, z, yaw);
        tRail = this.sT;
      } else {
        // Round the bollard (it stands between her and the stair head) to the head, facing down the stair.
        const H = STAIR_HEAD;
        const d = Math.hypot(H.x - x, H.z - z);
        if (d > 0.12) {
          const c = new THREE.Vector3(x - 0.5 * Math.sin(yaw), y, z - 0.5 * Math.cos(yaw));
          c.z = Math.max(c.z, PIER.z - PIER.half + 0.8);
          const c2 = new THREE.Vector3(H.x + 0.05, H.y, PIER.z - PIER.half + 0.75);
          this.seg("walk", Boarding.walkT(d + 0.4), pt(x, y, z, false), pt(H.x, H.y, H.z, false), yaw, WEST, { yh: 0, ground: true, c, c2 });
        }
        this.stepsBegin(H.x, H.y, H.z, d > 0.12 ? WEST : yaw);
        tRail = this.end - 0.35;
      }
      i = this.descend(k0, 0);
      const tFoot = this.sT;
      this.toStageEdge(i);
      // Right hand down the rail (on her right, going down), off at the newel as she steps onto the stage.
      this.grip(null, -1, -1, Math.max(0, tRail), Math.max(0.2, tRail + 0.35), tFoot + 0.15, tFoot + 0.45);
    }
    const tPost = this.sT;
    this.stepIn();
    // Right hand on the pile (on her right, facing the boat) from the pause until she is down on the bench.
    const g0 = this.st!.holds[0][this.st!.holds[0].length - 3];
    const gp = this.world(g0.p, _a);
    this.grip(this.postPt(gp.x + 0.15, gp.z + 0.1), 0, -1, tPost - 0.15, tPost + 0.3, this.tLand + 0.1, this.tLand + 0.4);
    this.stepsEnd();
    const S2 = pt(STAND.x, STAND.y, STAND.z, true);
    const seatP = pt(this.boat.model.seat.x, this.boat.model.seat.y, this.boat.model.seat.z, true);
    this.seg("sit", 0.45, S2, seatP, 0, 0, { yaRel: true, ybRel: true });
    this.finish();
  }

  /**
   * F aboard at the berth: up from the seat, up onto the bench and the stage (left hand on the
   * pile), up the stair (left hand on the rail) and back to where she stepped off from.
   */
  planLeaveBerth(phase: number): void {
    this.begin("leaveBerth", phase);
    const S = PIER_STAIR, P = BERTH.stage, y0 = this.boat.yaw, NORTH = Math.PI, EAST = -Math.PI / 2;
    const seatP = pt(this.boat.model.seat.x, this.boat.model.seat.y, this.boat.model.seat.z, true);
    const S2 = pt(STAND.x, STAND.y, STAND.z, true);
    this.seg("stand", 0.45, seatP, S2, 0, 0, { yaRel: true, ybRel: true });
    const sw = this.world(S2, _a);
    this.stepsBegin(sw.x, sw.y, sw.z, y0);
    // Left up onto the bench turning to the pier, right up onto the stage, left beside it.
    const L1 = this.foot(1, pt(BENCH_UP.x, BENCH_UP.y, BENCH_UP.z, true), NORTH - 1.05 - y0, { rel: true, dbl: 0, swing: 0.42, lift: 0.06, d: 0.5, v: 0.3 });
    this.stepSpan[0] = L1.t0;
    const R2 = this.stance(0, P.x, P.y, P.z + 0.05, NORTH, false, { dbl: 0.14, swing: 0.5, lift: 0.14, d: 0.55, v: 0.3 });
    const L3 = this.stance(1, P.x, P.y, P.z + 0.05, NORTH, false, { dbl: 0.1, swing: 0.42, lift: 0.16, d: 0.4, v: 0.2 });
    this.tOff = L3.t0;
    this.stepSpan[1] = L3.t1;
    this.loadX = BENCH_UP.x;
    this.loadZ = BENCH_UP.z;
    this.loadIn = -1;
    // Left hand on the pile (on her left facing the pier) as she rises onto the stage.
    this.grip(this.postPt(P.x + 0.2, P.z + 0.1), 0, 1, L1.t1 - 0.1, R2.t1 - 0.05, L3.t1 + 0.05, L3.t1 + 0.35);
    // Round to the stair foot (north first, clear of the newel), turning to face up it.
    this.stance(0, P.x + 0.05, P.y, (P.z + STAIR_FOOT.z) / 2 + 0.05, NORTH + 0.6, false, { dbl: 0.1, swing: 0.4, v: 0.5 });
    this.stance(1, STAIR_FOOT.x, P.y, STAIR_FOOT.z, NORTH + Math.PI / 2, false, { swing: 0.4, v: 0.6 });
    this.stance(0, STAIR_FOOT.x, P.y, STAIR_FOOT.z, NORTH + Math.PI / 2, false, { swing: 0.36, lift: 0.04, v: 0.4 });
    const tRail = this.sT;
    // Up a foot to a tread, the left a tread behind the right; both feet onto the head.
    let i = 0;
    for (let k = S.n - 1; k >= 1; k--) {
      const [ax, az] = this.ankleFor(i, treadX(k) - 0.04, STAIR_Z + (i === 0 ? 0.1 : -0.1), EAST);
      this.foot(i, pt(ax, treadY(k), az, false), EAST, { dbl: k === S.n - 1 ? 0.06 : 0.08, swing: 0.4, lift: 0.1, d: 0.35, v: 0.7 });
      i = 1 - i;
    }
    const H = STAIR_HEAD;
    this.stance(i, H.x + 0.05, H.y, H.z, EAST, false, { dbl: 0.08, swing: 0.4, lift: 0.1, d: 0.35, v: 0.6 });
    const tTop = this.sT;
    this.stance(1 - i, H.x + 0.05, H.y, H.z, EAST, false, { dbl: 0.08, swing: 0.36, lift: 0.1, d: 0.35, v: 0 });
    this.grip(null, 1, 1, tRail - 0.2, tRail + 0.15, tTop - 0.1, tTop + 0.25);
    const st = this.stepsEnd(0);
    // And back to where she stepped off from, turning to look out to sea.
    const sb = this.world(st.st!.holds[0][st.st!.holds[0].length - 1].p, _a);
    const fin = st.st!.holds[1][st.st!.holds[1].length - 1].p.v;
    const G = this.gait, mx = (G.stance[0].x + G.stance[1].x) / 2, mz = (G.stance[0].z + G.stance[1].z) / 2;
    const hx = (sb.x + fin.x) / 2 - rotX(mx, mz, EAST);
    const hz = (sb.z + fin.z) / 2 - rotZ(mx, mz, EAST);
    const B = BERTH.stand;
    this.seg("walk", Boarding.walkT(Math.hypot(B.x - hx, B.z - hz)), pt(hx, H.y, hz, false), pt(B.x, B.y, B.z, false), EAST, 2.2, { ground: true });
    this.finish();
  }

  /** Boat-frame side (+1 starboard) and a point over the side toward world (x, z), on the ground there (or null). */
  private sidePoint(x: number, z: number, y: number, out: Pt): number {
    const lp = this.toBoat(x, y, z, _p);
    const side = lp.x >= 0 ? 1 : -1;
    const g = gunwaleAt(SIDE_Z);
    // Outward until there is ground to stand on (wadeable), at most 1.6 m off the planking; far
    // enough out that her shin swings clear of the gunwale.
    for (let off = 0.45; off <= 1.6; off += 0.12) {
      out.v.set(side * (g.half + off), 0, SIDE_Z).applyMatrix4(this.boat.root.matrixWorld);
      const h = this.groundH(out.v.x, out.v.z, y);
      if (!Number.isNaN(h)) {
        out.v.y = h;
        return side;
      }
    }
    out.v.set(x, y, z);
    return side;
  }

  /** F near the boat off a beach: to the hull, over the gunwale, to the tiller. */
  planBoardShore(x: number, y: number, z: number, yaw: number, phase: number): void {
    this.begin("boardShore", phase);
    const O = pt(0, 0, 0, false);
    const side = this.sidePoint(x, z, y, O);
    const g = gunwaleAt(SIDE_Z);
    // Facing across the boat (toward its centreline).
    const yIn = this.boat.yaw + (side * Math.PI) / 2;
    const d = Math.hypot(O.v.x - x, O.v.z - z);
    this.seg("walk", Boarding.walkT(d), pt(x, y, z, false), O, yaw, yIn, { yh: d > 0.3 ? Math.atan2(-(O.v.x - x), -(O.v.z - z)) : NaN, ground: true });
    const tC = this.end;
    // Down for the hand-hold on the gunwale (not leaning in: her knees stay off its side).
    this.seg("crouch", 0.24, O, O, yIn, yIn, { off: new THREE.Vector3(0, -0.07, 0) });
    const I = pt(side * insideX(), FLOOR_Y, SIDE_Z, true);
    const top = this.world(pt(side * g.half, g.y, SIDE_Z, true), _p).y;
    const vy = Math.sqrt(2 * GRAV * Math.max(top + 0.24 - O.v.y, 0.1));
    this.tOff = this.end;
    this.seg("hop", this.hopT(O, I, vy), O, I, yIn, yIn, { vy });
    this.tLand = this.end;
    this.seg("land", 0.22, I, I, yIn, yIn);
    const S = pt(STAND.x, STAND.y, STAND.z, true);
    const iw = this.world(I, _a);
    this.stepsBegin(iw.x, iw.y, iw.z, yIn);
    const rel = wrapA(yIn - this.boat.yaw);
    this.stance(0, S.v.x, FLOOR_Y, S.v.z, rel * 0.4, true, { dbl: 0, swing: 0.4, lift: 0.07, v: 0.4 });
    this.stance(1, S.v.x, FLOOR_Y, S.v.z, 0, true, { dbl: 0.08, swing: 0.4, lift: 0.07, v: 0.3 });
    this.stance(0, S.v.x, FLOOR_Y, S.v.z, 0, true, { dbl: 0.06, swing: 0.3, lift: 0.04, v: 0 });
    this.stepsEnd(0.02);
    const seatP = pt(this.boat.model.seat.x, this.boat.model.seat.y, this.boat.model.seat.z, true);
    this.seg("sit", 0.45, S, seatP, 0, 0, { yaRel: true, ybRel: true });
    // Right hand on the gunwale a little to her right (aft or forward, as she faces), down in the crouch.
    this.grip(pt(side * (g.half + 0.02), g.y + 0.04, SIDE_Z - side * 0.12, true), 0, -1, tC - 0.1, tC + 0.16, this.tOff + 0.1, this.tOff + 0.3);
    this.loadX = I.v.x;
    this.loadZ = SIDE_Z;
    this.loadIn = 1;
    this.finish();
  }

  /**
   * F aboard off a shore: up, to the side (+1 starboard) between the thwart and the bench, and over
   * the gunwale onto the ground at `land` (world: the sand or the shallows there, square off the side
   * or a hop forward along it).
   */
  planLeaveShore(phase: number, side: number, land: THREE.Vector3, from = 0): void {
    this.begin("leaveShore", phase);
    const O = pt(land.x, land.y, land.z, false);
    const F = SHORE_FROM[from];
    const g = gunwaleAt(F.z);
    const seatP = pt(this.boat.model.seat.x, this.boat.model.seat.y, this.boat.model.seat.z, true);
    const S = pt(STAND.x, STAND.y, STAND.z, true);
    const I = pt(side * F.x, FLOOR_Y, F.z, true);
    // Facing where she will land.
    const iw = this.world(I, _p);
    let yOut = Math.atan2(-(land.x - iw.x), -(land.z - iw.z));
    this.seg("stand", 0.45, seatP, S, 0, 0, { yaRel: true, ybRel: true });
    // A foot at a time to stand angled toward the bow with the gunwale at her outboard hand (forward:
    // over the thwart, between it and the bow seat): placed footholds, so a turning stride never
    // swings a toe into the planking, and her knees point along the boat, not into its side.
    const sw = this.world(S, _a);
    this.stepsBegin(sw.x, sw.y, sw.z, this.boat.yaw);
    let rel = yOut - this.boat.yaw;
    rel = Math.atan2(Math.sin(rel), Math.cos(rel));
    yOut = this.boat.yaw + rel;
    const relC = rel * 0.45, yC = this.boat.yaw + relC;
    const over = from === 1;
    this.stance(0, I.v.x, FLOOR_Y, I.v.z, relC * (over ? 0.6 : 0.8), true, { dbl: 0, swing: over ? 0.55 : 0.42, lift: over ? 0.4 : 0.08, d: 0.5, v: 0.3 });
    this.stance(1, I.v.x, FLOOR_Y, I.v.z, relC, true, { dbl: 0.12, swing: over ? 0.55 : 0.42, lift: over ? 0.4 : 0.08, d: 0.5, v: 0.2 });
    this.stepsEnd(0.02);
    const tC = this.end;
    this.seg("crouch", 0.24, I, I, yC, yC, { off: new THREE.Vector3(0, -0.17, 0) });
    const top = this.world(pt(side * g.half, g.y, F.z, true), _p).y;
    const iy = this.world(I, _p2).y;
    const vy = Math.sqrt(2 * GRAV * Math.max(top + 0.24 - iy, 0.1));
    this.tOff = this.end;
    // Swinging round to face out as she goes over.
    this.seg("hop", this.hopT(I, O, vy), I, O, yC, yOut, { vy });
    this.tLand = this.end;
    this.seg("land", 0.34, O, O, yOut, yOut);
    // The outboard hand (right to starboard, left to port) on the gunwale just aft of her as she crouches, pushing off it.
    this.grip(pt(side * (g.half + 0.02), g.y + 0.04, F.z + 0.12, true), 0, -side, tC - 0.2, tC + 0.2, this.tOff + 0.08, this.tOff + 0.26);
    this.loadX = I.v.x;
    this.loadZ = F.z;
    this.loadIn = -1;
    this.finish();
  }

  /** Where the move ends on land (leave), world. */
  landing(out: THREE.Vector3): THREE.Vector3 {
    return this.world(this.segs[this.segs.length - 1].b, out);
  }

  /** The planned footholds (tests): per foot, world point, strike time and lift-off. */
  holds(): { foot: number; p: THREE.Vector3; t0: number; t1: number }[] {
    const r: { foot: number; p: THREE.Vector3; t0: number; t1: number }[] = [];
    for (const s of this.segs)
      if (s.st)
        for (let i = 0; i < 2; i++) for (const h of s.st.holds[i]) r.push({ foot: i, p: this.world(h.p, new THREE.Vector3()), t0: h.t0, t1: h.t1 });
    return r;
  }

  /** Facing on s at u; `head` = the travel heading there (walks that follow it: yh set). */
  private yawOf(s: Seg, u: number, head: number): number {
    const by = this.boat.yaw;
    const ya = s.yaRel ? by + s.ya : s.ya, yb = s.ybRel ? by + s.yb : s.yb;
    if (s.kind !== "walk") return wrapA(ya + wrapA(yb - ya) * ease(u));
    if (Number.isNaN(s.yh)) return wrapA(ya + wrapA(yb - ya) * smooth(0.1, 0.9, u));
    // Turn toward where she is going, follow the path, then turn to face the way she ends up.
    return wrapA(ya + wrapA(head - ya) * smooth(0, 0.3, u) + wrapA(yb - head) * smooth(0.6, 1, u));
  }

  /** Walking speed (m/s) in a walk segment at u, and the gait phase at u. */
  private walkSpeed(s: Seg, u: number): number {
    return (s.len * 6 * u * (1 - u)) / (s.t1 - s.t0);
  }
  private walkPhase(s: Seg, u: number): number {
    // Cadence = speed / stride (the clip's), integrated over the segment.
    const N = 24;
    let ph = 0;
    for (let k = 0; k < N; k++) {
      const uk = ((k + 0.5) / N) * u;
      const v = this.walkSpeed(s, uk);
      ph += v / gaitCycle(0, v);
    }
    return ((ph * u) / N) * (s.t1 - s.t0) * Math.PI * 2;
  }

  /** Key k's root (world, out) and facing. */
  private keyRoot(st: Steps, k: Key, out: THREE.Vector3): number {
    const G = this.gait;
    const a = this.world(st.holds[0][k.h[0]].p, _a), b = this.world(st.holds[1][k.h[1]].p, _b);
    const yaw = k.rel ? this.boat.yaw + k.yaw : k.yaw;
    const mx = (G.stance[0].x + G.stance[1].x) / 2, mz = (G.stance[0].z + G.stance[1].z) / 2;
    out.set((a.x + b.x) / 2 - rotX(mx, mz, yaw), Math.min(a.y, b.y) + ROOT_K * Math.abs(a.y - b.y), (a.z + b.z) / 2 - rotZ(mx, mz, yaw));
    return yaw;
  }

  /** On footholds at time t: root (out), facing (returned), feet into the pose, the clips' speed and phase. */
  private stepsPose(s: Seg, t: number, o: TransitPose): number {
    const st = s.st!, K = st.keys;
    let n = 0;
    while (n < K.length - 2 && t > K[n + 1].t) n++;
    // Four keys around the interval [n, n+1], their roots in world now (the boat moves under some).
    for (let j = 0; j < 4; j++) {
      const k = K[Math.min(K.length - 1, Math.max(0, n - 1 + j))];
      _ry[j] = this.keyRoot(st, k, _r[j]);
    }
    for (let j = 1; j < 4; j++) _ry[j] = _ry[j - 1] + wrapA(_ry[j] - _ry[j - 1]);
    const k0 = K[Math.max(0, n - 1)], k1 = K[n], k2 = K[Math.min(K.length - 1, n + 1)], k3 = K[Math.min(K.length - 1, n + 2)];
    const T = [k0.t, k1.t, k2.t, k3.t];
    const comp = (v: number[]) => {
      const m1 = n === 0 ? 0 : slope(T[0], v[0], T[1], v[1], T[2], v[2]);
      const m2 = n + 1 >= K.length - 1 ? 0 : slope(T[1], v[1], T[2], v[2], T[3], v[3]);
      return hermite(T[1], v[1], m1, T[2], v[2], m2, Math.min(Math.max(t, T[1]), T[2]));
    };
    o.pos.set(comp([_r[0].x, _r[1].x, _r[2].x, _r[3].x]), comp([_r[0].y, _r[1].y, _r[2].y, _r[3].y]), comp([_r[0].z, _r[1].z, _r[2].z, _r[3].z]));
    const yaw = comp(_ry);
    // Clip speed and phase: linear between the keys.
    const u = k2.t > k1.t ? Math.min(1, Math.max(0, (t - k1.t) / (k2.t - k1.t))) : 1;
    o.speed = k1.v + (k2.v - k1.v) * u;
    o.phase = (k1.ph + (k2.ph - k1.ph) * u) * Math.PI * 2;
    // Feet.
    const tEnd = K[K.length - 1].t;
    for (let i = 0; i < 2; i++) {
      const H = st.holds[i];
      let j = 0;
      while (j < H.length - 1 && t >= H[j + 1].t0) j++;
      const h = H[j];
      const P = o.stepP[i];
      const yawOf = (x: Hold) => (x.rel ? this.boat.yaw + x.yaw : x.yaw);
      if (j > 0 && t < h.t1) {
        // Swinging from the last hold to this one.
        const A = this.world(H[j - 1].p, _a), B = this.world(h.p, _b);
        const w = (t - h.t0) / Math.max(h.t1 - h.t0, 1e-4);
        const e = ease(w);
        const vy = B.y < A.y ? smooth(h.d, 1, w) : smooth(0, h.d, w);
        P.set(A.x + (B.x - A.x) * e, A.y + (B.y - A.y) * vy + h.lift * Math.sin(Math.PI * w), A.z + (B.z - A.z) * e);
        const ya = yawOf(H[j - 1]);
        o.stepYaw[i] = ya + wrapA(yawOf(h) - ya) * e;
        o.stepDown[i] = false;
      } else {
        this.world(h.p, P);
        o.stepYaw[i] = yawOf(h);
        o.stepDown[i] = true;
      }
      // In over the pre-roll, out over the last moment.
      o.stepW[i] = smooth(s.t0, s.t0 + 0.15, t) * (1 - smooth(tEnd - 0.12, tEnd, t));
    }
    return yaw;
  }

  /** The stair rail under her hand: just ahead of her (dir: +1 east / up, -1 west / down) along it, world. */
  private railAt(x: number, dir: number, out: THREE.Vector3): THREE.Vector3 {
    const S = PIER_STAIR;
    const hx = Math.min(S.x0 - 0.06, Math.max(STAIR_FOOT_X + 0.02, x + dir * 0.12));
    return out.set(hx, stairRailH(hx) + 0.045, S.railZ + 0.035);
  }

  /**
   * Her pose at time tau (s since F). Before 0 and after the end it holds the first and last poses.
   * Also sets the boat's weight offsets for that time.
   */
  pose(tau: number): TransitPose {
    const o = this.out;
    const segs = this.segs;
    const t = Math.min(Math.max(tau, 0), this.end);
    let i = 0;
    while (i < segs.length - 1 && t > segs[i].t1) i++;
    const s = segs[i];
    const u = s.t1 > s.t0 ? Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0))) : 1;

    this.rock(Math.max(tau, 0));
    const A = this.world(s.a, _p), B = this.world(s.b, _p2);
    o.speed = 0;
    o.air = 0;
    o.seat = 0;
    o.stepW[0] = o.stepW[1] = 0;
    let head = 0, yaw = NaN;
    switch (s.kind) {
      case "walk": {
        const e = ease(u);
        head = this.along(s, A, B, e, o.pos);
        if (s.ground) {
          const h = this.groundH(o.pos.x, o.pos.z, Math.max(A.y, B.y) + 0.3);
          o.pos.y = Number.isNaN(h) ? A.y + (B.y - A.y) * e : h;
        } else o.pos.y = A.y + (B.y - A.y) * smooth(0.15, 0.85, u);
        o.speed = this.walkSpeed(s, u);
        break;
      }
      case "steps":
        yaw = this.stepsPose(s, t, o);
        break;
      case "crouch":
        o.pos.copy(A);
        if (s.off) o.pos.addScaledVector(s.off, ease(u));
        break;
      case "land":
        o.pos.copy(A);
        break;
      case "hop": {
        const T = s.t1 - s.t0, sT = u * T;
        // Ballistic, corrected linearly so it lands exactly on B however the boat moved.
        const ballistic = s.vy * T - 0.5 * GRAV * T * T;
        o.pos.lerpVectors(A, B, u);
        o.pos.y = A.y + s.vy * sT - 0.5 * GRAV * sT * sT + (B.y - A.y - ballistic) * u;
        const pc = segs[i - 1];
        if (pc?.off) o.pos.addScaledVector(pc.off, 1 - smooth(0, 0.3, u));
        o.air = u < 1 ? 1 : 0;
        break;
      }
      case "sit":
      case "stand": {
        const e = ease(u);
        o.pos.lerpVectors(A, B, e);
        o.seat = s.kind === "sit" ? e : 1 - e;
        break;
      }
    }
    o.yaw = Number.isNaN(yaw) ? this.yawOf(s, u, head) : wrapA(yaw);
    o.quat.setFromAxisAngle(_up, o.yaw);
    if (o.seat > 0) {
      // Seated she rides the boat's pitch and roll.
      this.boat.seatMatrix(_m);
      _m.decompose(_p, _q, _p2);
      o.quat.slerp(_q, o.seat);
    }
    // Gait phase: everything walked so far (the footholds set their own, continuing it).
    if (s.kind !== "steps") {
      let ph = this.phase0;
      for (let k = 0; k < segs.length; k++) {
        const sk = segs[k];
        if (sk.t0 >= t) continue;
        if (sk.kind === "walk") ph += this.walkPhase(sk, Math.min(1, (t - sk.t0) / (sk.t1 - sk.t0)));
        else if (sk.kind === "steps" && sk.st) {
          const K = sk.st.keys;
          ph = K[K.length - 1].ph * Math.PI * 2;
        }
      }
      o.phase = ph;
    }
    // The jump clip: anticipation crouch, aloft, landing (fading out as she moves on).
    o.jumpT = 0;
    o.jumpW = 0;
    const hops = this.kind === "boardShore" || this.kind === "leaveShore";
    if (s.kind === "crouch") {
      // (vy here: how deep, 0..1; 0 = the full anticipation crouch.)
      o.jumpT = JUMP_CLIP.crouch + (JUMP_CLIP.takeOff - JUMP_CLIP.crouch) * u;
      o.jumpW = smooth(0, 0.3, u) * (s.vy || 1);
    } else if (s.kind === "hop") {
      o.jumpT = JUMP_CLIP.takeOff + (JUMP_CLIP.touchDown - JUMP_CLIP.takeOff) * Math.min(u, 0.96);
      o.jumpW = 1;
    } else if (hops && t >= this.tLand && this.tLand > 0) {
      // As jumpClock's landing: the clip from touch-down, fading out by its end.
      const lt = t - this.tLand;
      o.jumpT = Math.min(JUMP_CLIP.touchDown + lt, JUMP_CLIP.end);
      o.jumpW = 1 - smooth(0.17, JUMP_CLIP.end - JUMP_CLIP.touchDown, lt);
    }
    // The steadying hand: the strongest grip (two on the same hand hand over between them).
    o.reachW = 0;
    let wSum = 0, best = 0;
    o.reach.set(0, 0, 0);
    for (const g of this.grips) {
      const w = smooth(g.t[0], g.t[1], t) * (1 - smooth(g.t[2], g.t[3], t));
      if (w <= 1e-4) continue;
      if (w > best) {
        best = w;
        o.reachSide = g.side;
      }
    }
    for (const g of this.grips) {
      const w = smooth(g.t[0], g.t[1], t) * (1 - smooth(g.t[2], g.t[3], t));
      if (w <= 1e-4 || g.side !== o.reachSide) continue;
      const p = g.p ? this.world(g.p, _a) : this.railAt(o.pos.x, g.dir, _a);
      o.reach.addScaledVector(p, w);
      wSum += w;
    }
    if (wSum > 0) {
      o.reach.divideScalar(wSum);
      o.reachW = Math.min(1, wSum);
    }
    // Feet on the boat from the landing aboard (boarding) or until the take-off (leaving).
    const aboard = this.kind === "board" || this.kind === "boardShore";
    o.onBoat = aboard ? t >= this.tLand - 0.02 : t <= this.tOff;
    o.done = tau >= this.end;
    return o;
  }

  /**
   * Her weight on the hull at time t: it settles 2 cm lower with a slight list to her side once she
   * is aboard, and her landing (or take-off) sets it bobbing and rocking for a second or so (a step
   * in rocks it less than a hop).
   */
  rock(t: number): void {
    const aboard = this.loadIn > 0;
    const tE = aboard ? this.tLand : this.tOff;
    const w = aboard ? smooth(tE, tE + 0.15, t) : 1 - smooth(tE, tE + 0.12, t);
    const s = t - tE;
    let h = SEATED.h * w, p = SEATED.p * w, r = SEATED.r * w;
    if (s > 0) {
      const step = this.kind === "board" || this.kind === "leaveBerth";
      const a = (aboard ? 1 : 0.7) * (step ? 0.6 : 1);
      const lx = -this.loadX / 0.5, lz = this.loadZ / 1.3;
      h += -0.05 * a * Math.sin((2 * Math.PI * s) / 0.85) * Math.exp(-s / 0.4);
      r += 0.06 * a * lx * Math.sin((2 * Math.PI * s) / 1.5) * Math.exp(-s / 0.9);
      p += 0.02 * a * lz * Math.sin((2 * Math.PI * s) / 1.1) * Math.exp(-s / 0.5);
    }
    this.boat.setLoad(h, p, r);
  }

  /** Seated at the tiller: her weight's resting offsets. */
  static seatedLoad(boat: Boat): void {
    boat.setLoad(SEATED.h, SEATED.p, SEATED.r);
  }
}
