import * as THREE from "three";
import type { Boat } from "../boat/boat";
import { BENCH, FLOOR_Y, gunwaleAt, halfWidthAt, stationOf } from "../boat/model";
import { PIER, PIER_GAP } from "../world/bay/pier";
import { JUMP_CLIP, gaitCycle } from "./rider";

/**
 * Stepping aboard the skiff and ashore again, as a scripted move over her clips (walk, idle, jump,
 * sit_tiller), a pure function of its own clock: the same time always gives the same pose, boat
 * dip included, so a frozen capture shows exactly what play shows.
 *
 * At the berth the deck stands 1.6 m over the stern bench, too far to step: she walks to the deck
 * edge beside the bollard east of the gap, crouches with her right hand on its cap, hops down onto
 * the bench (the hull dips and rocks under her), steps down onto the floorboards turning to the bow
 * and sits at the tiller. Leaving, she stands, steps up onto the bench facing the pier, puts her
 * right hand on the deck edge and springs up onto the deck. From a beach she walks to the hull,
 * puts a hand on the gunwale and hops over it (in or out, landing in the shallows with a splash).
 *
 * Segments are planned once (when F is pressed); points on the boat are kept in the boat frame so
 * she stays on the bench as it bobs.
 */
export type TransitKind = "board" | "boardShore" | "leaveBerth" | "leaveShore";

/** On-foot gravity (the jump's). */
const GRAV = 13;
/** The bollard east of the berth gap (its cap) and where she stands at the deck edge beside it. */
export const BOARD_POST = { x: PIER_GAP.x1 - 0.25, z: PIER.z - PIER.half + 0.22, top: PIER.deck + 0.48 };
/** (0.3 m back from the edge keeps her toes on the boards; 0.33 m west of the bollard clears her knee.) */
export const BOARD_EDGE = { x: BOARD_POST.x - 0.33, z: PIER.z - PIER.half + 0.3, y: PIER.deck };
/** Deck edge (world z) and the boat-frame points of the boarding: landing on the bench, standing in front of it, the seat. */
const DECK_EDGE_Z = PIER.z - PIER.half;
const BENCH_LAND = new THREE.Vector3(-0.45, BENCH.top, BENCH.z);
/** Leaving the berth: the bench's port end, and her foot up on the port gunwale beside it. */
const BENCH_PORT = new THREE.Vector3(-0.45, BENCH.top, BENCH.z);
const STAND = new THREE.Vector3(-0.3, FLOOR_Y, 0.86);
/** Over the side (shore): along the boat between the thwart and the bench. */
const SIDE_Z = 0.62;
/** Standing over the side (shore): her centre this far out from the keel, on the floorboards and short of the planking. */
const insideX = () => Math.min(gunwaleAt(SIDE_Z).half - 0.24, halfWidthAt(stationOf(SIDE_Z), FLOOR_Y + 0.02) - 0.18);
/** Her resting weight seated (seat 0.3 m to port of the centreline): the hull 2 cm lower, a touch stern-down, listing to port. */
const SEATED = { h: -0.022, p: 0.008, r: 0.012 };

type SegKind = "walk" | "crouch" | "hop" | "haul" | "land" | "sit" | "stand";
interface Pt {
  v: THREE.Vector3;
  /** In the boat frame (else world). */
  boat: boolean;
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
  /**
   * A crouch's root offset at its end (world): lower to bend her knees, or forward to lean her
   * whole body over planted feet toward a hand-hold; the next segment (hop, haul) eases it out.
   */
  off: THREE.Vector3 | null;
  /** Walk on land: follow the ground (else eased between the end heights), on a curve through `c` if set (world). */
  ground: boolean;
  c: THREE.Vector3 | null;
  /** Walked distance (m) before this segment and in it (walks), for the gait phase. */
  d0: number;
  len: number;
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
const _up = new THREE.Vector3(0, 1, 0);
const pt = (x: number, y: number, z: number, boat: boolean): Pt => ({ v: new THREE.Vector3(x, y, z), boat });

export class Boarding {
  kind: TransitKind = "board";
  /** Total length (s). */
  end = 0;
  /** Landing on the bench (or the deck / sand), the take-off: for sounds and the boat's dip. */
  tLand = 0;
  tOff = 0;
  /** Contact frame: the supporting hand reaches its target. */
  tHand = 0;
  private segs: Seg[] = [];
  private phase0 = 0;
  private reachP: Pt = pt(0, 0, 0, false);
  private reachSide = -1;
  private rT = [0, 0, 0, 0];
  /** Her weight in the boat frame (x, z) for the roll and pitch it causes; when it comes aboard (+1) or leaves (-1). */
  private loadX = -0.3;
  private loadZ = 1.3;
  private loadIn = 1;
  /** The finished state: walker on land (leave) or on the seat. */
  readonly out: TransitPose = {
    pos: new THREE.Vector3(), yaw: 0, quat: new THREE.Quaternion(), seat: 0, speed: 0, phase: 0, jumpT: 0, jumpW: 0, air: 0,
    reach: new THREE.Vector3(), reachW: 0, reachSide: -1, onBoat: false, done: false,
  };

  constructor(
    private boat: Boat,
    /** Walkable ground height at world (x, z) (NaN: none). */
    private groundH: (x: number, z: number, y: number) => number,
  ) {}

  /** Seconds a walk of d metres takes (eased from and to a stop; peak about 1.5x the mean). */
  private static walkT(d: number): number {
    return Math.min(4.5, Math.max(0.42, 0.3 + d / 1.6));
  }

  private seg(kind: SegKind, dur: number, a: Pt, b: Pt, ya: number, yb: number, o: Partial<Seg> = {}): Seg {
    const t0 = this.end;
    const s: Seg = { kind, t0, t1: t0 + dur, a, b, ya, yh: NaN, yb, yaRel: false, ybRel: false, vy: 0, ground: false, c: null, off: null, d0: 0, len: 0, ...o };
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
    this.end = 0;
    this.phase0 = phase0;
    this.out.done = false;
  }

  private finish(): void {
    let d = 0;
    for (const s of this.segs)
      if (s.kind === "walk") {
        s.d0 = d;
        const A = this.world(s.a, _p), B = this.world(s.b, _p2);
        if (s.c) {
          // The curve's length, by chords.
          let len = 0, px = A.x, pz = A.z;
          for (let k = 1; k <= 32; k++) {
            const e = k / 32, i = 1 - e;
            const x = i * i * A.x + 2 * i * e * s.c.x + e * e * B.x, z = i * i * A.z + 2 * i * e * s.c.z + e * e * B.z;
            len += Math.hypot(x - px, z - pz);
            px = x;
            pz = z;
          }
          s.len = len;
        } else s.len = Math.hypot(B.x - A.x, B.z - A.z);
        d += s.len;
      }
  }

  /** On walk s at eased progress e: position (xz, out) and the travel heading (yaw). */
  private along(s: Seg, A: THREE.Vector3, B: THREE.Vector3, e: number, out: THREE.Vector3): number {
    const c = s.c;
    if (!c) {
      out.lerpVectors(A, B, e);
      return Number.isNaN(s.yh) ? Math.atan2(-(B.x - A.x), -(B.z - A.z)) : s.yh;
    }
    const i = 1 - e;
    out.set(i * i * A.x + 2 * i * e * c.x + e * e * B.x, 0, i * i * A.z + 2 * i * e * c.z + e * e * B.z);
    const tx = 2 * i * (c.x - A.x) + 2 * e * (B.x - c.x), tz = 2 * i * (c.z - A.z) + 2 * e * (B.z - c.z);
    return Math.atan2(-tx, -tz);
  }

  private reachAt(p: Pt, side: number, t0: number, t1: number, t2: number, t3: number): void {
    this.reachP = p;
    this.reachSide = side;
    this.rT[0] = t0;
    this.rT[1] = t1;
    this.rT[2] = t2;
    this.rT[3] = t3;
    this.tHand = t1;
  }

  /** F at the berth: from where she stands on the deck to the tiller. */
  planBoard(x: number, y: number, z: number, yaw: number, phase: number): void {
    this.begin("board", phase);
    const E = pt(BOARD_EDGE.x, BOARD_EDGE.y, BOARD_EDGE.z, false);
    const d = Math.hypot(E.v.x - x, E.v.z - z);
    // Facing the boat squarely across the deck edge (-z), arriving from the north: a curve that
    // keeps her clear of the bollard on the way (it stands between the spawn and the edge).
    const yE = 0;
    const c = d > 0.3 ? new THREE.Vector3(E.v.x + 0.05, E.v.y, E.v.z + Math.min(0.9, Math.max(0.45, 0.5 * d))) : null;
    const len = c ? Math.hypot(c.x - x, c.z - z) * 0.5 + Math.hypot(E.v.x - c.x, E.v.z - c.z) * 0.5 + d * 0.5 : d;
    this.seg("walk", Boarding.walkT(len), pt(x, y, z, false), E, yaw, yE, { yh: d > 0.3 ? 0 : NaN, ground: true, c });
    const tC = this.end;
    // Down to the knee-high cap: her knees bend 0.28 m deeper than the jump's crouch.
    this.seg("crouch", 0.28, E, E, yE, yE, { off: new THREE.Vector3(0, -0.28, 0) });
    const L = pt(BENCH_LAND.x, BENCH_LAND.y, BENCH_LAND.z, true);
    const vy = 0.9;
    this.tOff = this.end;
    this.seg("hop", this.hopT(E, L, vy), E, L, yE, yE, { vy });
    this.tLand = this.end;
    this.seg("land", 0.22, L, L, yE, yE);
    const S = pt(STAND.x, STAND.y, STAND.z, true);
    this.seg("walk", 0.42, L, S, yE, 0, { ybRel: true });
    const seatP = pt(this.boat.model.seat.x, this.boat.model.seat.y, this.boat.model.seat.z, true);
    this.seg("sit", 0.45, S, seatP, 0, 0, { yaRel: true, ybRel: true });
    // Right hand (the bollard is on her right facing the boat) on the cap as she comes to the edge,
    // pushing off it at the take-off.
    // (On the cap's near side, toward her: it is 0.17 m round.)
    const post = pt(BOARD_POST.x - 0.08, BOARD_POST.top + 0.045, BOARD_POST.z + 0.04, false);
    this.reachAt(post, -1, tC - 0.22, tC + 0.2, this.tOff + 0.06, this.tOff + 0.26);
    this.loadX = BENCH_LAND.x;
    this.loadZ = BENCH_LAND.z;
    this.loadIn = 1;
    this.finish();
  }

  /**
   * F aboard at the berth: up from the seat, onto the bench's port end, a foot up on the gunwale,
   * her right hand on the deck edge, and up over it onto the boards (the deck is 1.3 m over the
   * gunwale: a haul with the hand planted, not a jump).
   */
  planLeaveBerth(phase: number): void {
    this.begin("leaveBerth", phase);
    const seatP = pt(this.boat.model.seat.x, this.boat.model.seat.y, this.boat.model.seat.z, true);
    const S = pt(STAND.x, STAND.y, STAND.z, true);
    const Bp = pt(BENCH_PORT.x, BENCH_PORT.y, BENCH_PORT.z, true);
    const g = gunwaleAt(BENCH.z);
    const Gw = pt(-(g.half + 0.015), g.y, BENCH.z, true);
    this.seg("stand", 0.45, seatP, S, 0, 0, { yaRel: true, ybRel: true });
    // Turning to face the pier (+z) as she steps up onto the bench, then onto the gunwale.
    const yP = Math.PI;
    this.seg("walk", 0.4, S, Bp, 0, yP, { yaRel: true });
    const tUp = this.end;
    this.seg("walk", 0.3, Bp, Gw, yP, yP);
    const tC = this.end;
    // Braced, not crouched: the edge is at her shoulder.
    // Leaning out over the gap toward the edge (+z), feet planted on the rail.
    this.seg("crouch", 0.24, Gw, Gw, yP, yP, { vy: 0.45, off: new THREE.Vector3(0, -0.04, 0.26) });
    const gw = this.world(Gw, _p);
    const E = pt(Math.min(Math.max(gw.x, PIER_GAP.x0 + 0.6), BOARD_EDGE.x), PIER.deck, BOARD_EDGE.z, false);
    this.tOff = this.end;
    this.seg("haul", 0.66, Gw, E, yP, yP);
    this.tLand = this.end;
    this.seg("land", 0.3, E, E, yP, yP);
    // Right hand (her -x facing +z) on the deck edge in front of her, planted through the haul.
    const hand = pt(gw.x - 0.17, PIER.deck + 0.035, DECK_EDGE_Z + 0.04, false);
    this.reachAt(hand, -1, tUp, this.tOff - 0.02, this.tOff + 0.45, this.tLand + 0.08);
    this.loadX = Gw.v.x;
    this.loadZ = BENCH.z;
    this.loadIn = -1;
    this.finish();
  }

  /** Boat-frame side (+1 starboard) and a point over the side toward world (x, z), on the ground there (or null). */
  private sidePoint(x: number, z: number, y: number, out: Pt): number {
    const lp = this.toBoat(x, y, z, _p);
    const side = lp.x >= 0 ? 1 : -1;
    const g = gunwaleAt(SIDE_Z);
    // Outward until there is ground to stand on (wadeable), at most 1.6 m off the planking.
    for (let off = 0.32; off <= 1.6; off += 0.12) {
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
    this.seg("crouch", 0.24, O, O, yIn, yIn);
    const I = pt(side * insideX(), FLOOR_Y, SIDE_Z, true);
    const top = this.world(pt(side * g.half, g.y, SIDE_Z, true), _p).y;
    const vy = Math.sqrt(2 * GRAV * Math.max(top + 0.16 - O.v.y, 0.1));
    this.tOff = this.end;
    this.seg("hop", this.hopT(O, I, vy), O, I, yIn, yIn, { vy });
    this.tLand = this.end;
    this.seg("land", 0.22, I, I, yIn, yIn);
    const S = pt(STAND.x, STAND.y, STAND.z, true);
    this.seg("walk", 0.5, I, S, yIn, 0, { ybRel: true });
    const seatP = pt(this.boat.model.seat.x, this.boat.model.seat.y, this.boat.model.seat.z, true);
    this.seg("sit", 0.45, S, seatP, 0, 0, { yaRel: true, ybRel: true });
    // Right hand on the gunwale a little to her right (aft or forward, as she faces).
    this.reachAt(pt(side * (g.half + 0.02), g.y + 0.04, SIDE_Z - side * 0.2, true), -1, tC - 0.2, tC + 0.12, this.tOff + 0.1, this.tOff + 0.3);
    this.loadX = I.v.x;
    this.loadZ = SIDE_Z;
    this.loadIn = 1;
    this.finish();
  }

  /** F aboard off a beach: up, to the side toward (x, z), over the gunwale into the shallows. */
  planLeaveShore(x: number, y: number, z: number, phase: number): { x: number; y: number; z: number } {
    this.begin("leaveShore", phase);
    const O = pt(0, 0, 0, false);
    const side = this.sidePoint(x, z, y, O);
    const g = gunwaleAt(SIDE_Z);
    const yOut = this.boat.yaw - (side * Math.PI) / 2;
    const seatP = pt(this.boat.model.seat.x, this.boat.model.seat.y, this.boat.model.seat.z, true);
    const S = pt(STAND.x, STAND.y, STAND.z, true);
    const I = pt(side * insideX(), FLOOR_Y, SIDE_Z, true);
    this.seg("stand", 0.45, seatP, S, 0, 0, { yaRel: true, ybRel: true });
    this.seg("walk", 0.5, S, I, 0, yOut, { yaRel: true });
    const tC = this.end;
    // Leaning out toward the gunwale for the hand-hold.
    const ox = Math.cos(this.boat.yaw) * side, oz = -Math.sin(this.boat.yaw) * side;
    this.seg("crouch", 0.24, I, I, yOut, yOut, { off: new THREE.Vector3(ox * 0.25, -0.1, oz * 0.25) });
    const top = this.world(pt(side * g.half, g.y, SIDE_Z, true), _p).y;
    const iy = this.world(I, _p2).y;
    const vy = Math.sqrt(2 * GRAV * Math.max(top + 0.16 - iy, 0.1));
    this.tOff = this.end;
    this.seg("hop", this.hopT(I, O, vy), I, O, yOut, yOut, { vy });
    this.tLand = this.end;
    this.seg("land", 0.34, O, O, yOut, yOut);
    this.reachAt(pt(side * (g.half + 0.02), g.y + 0.04, SIDE_Z + side * 0.2, true), -1, tC - 0.2, tC + 0.12, this.tOff + 0.1, this.tOff + 0.3);
    this.loadX = I.v.x;
    this.loadZ = SIDE_Z;
    this.loadIn = -1;
    this.finish();
    return O.v;
  }

  /** Where the move ends on land (leave), world. */
  landing(out: THREE.Vector3): THREE.Vector3 {
    return this.world(this.segs[this.segs.length - 1].b, out);
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
    let head = 0;
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
      case "haul": {
        // Up the pier's side, hands on the deck edge: rising first, then over the edge onto the boards.
        o.pos.lerpVectors(A, B, smooth(0.42, 1, u));
        o.pos.y = A.y + (B.y - A.y) * smooth(0, 0.72, u) + 0.07 * Math.sin(Math.PI * smooth(0.3, 1, u));
        const pc = segs[i - 1];
        if (pc?.off) o.pos.addScaledVector(pc.off, 1 - smooth(0.2, 1, u));
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
    o.yaw = this.yawOf(s, u, head);
    o.quat.setFromAxisAngle(_up, o.yaw);
    if (o.seat > 0) {
      // Seated she rides the boat's pitch and roll.
      this.boat.seatMatrix(_m);
      _m.decompose(_p, _q, _p2);
      o.quat.slerp(_q, o.seat);
    }
    // Gait phase: everything walked so far.
    let ph = this.phase0;
    for (let k = 0; k < segs.length; k++) {
      const sk = segs[k];
      if (sk.kind !== "walk" || sk.t0 >= t) continue;
      ph += this.walkPhase(sk, Math.min(1, (t - sk.t0) / (sk.t1 - sk.t0)));
    }
    o.phase = ph;
    // The jump clip: anticipation crouch, aloft, landing (fading out as she moves on).
    o.jumpT = 0;
    o.jumpW = 0;
    if (s.kind === "crouch") {
      // (vy here: how deep, 0..1; 0 = the full anticipation crouch.)
      o.jumpT = JUMP_CLIP.crouch + (JUMP_CLIP.takeOff - JUMP_CLIP.crouch) * u;
      o.jumpW = smooth(0, 0.3, u) * (s.vy || 1);
    } else if (s.kind === "hop" || s.kind === "haul") {
      o.jumpT = JUMP_CLIP.takeOff + (JUMP_CLIP.touchDown - JUMP_CLIP.takeOff) * Math.min(u, 0.96);
      o.jumpW = 1;
    } else if (t >= this.tLand && this.tLand > 0) {
      // As jumpClock's landing: the clip from touch-down, fading out by its end.
      const lt = t - this.tLand;
      o.jumpT = Math.min(JUMP_CLIP.touchDown + lt, JUMP_CLIP.end);
      o.jumpW = 1 - smooth(0.17, JUMP_CLIP.end - JUMP_CLIP.touchDown, lt);
    }
    // The steadying hand.
    const r = this.rT;
    o.reachW = smooth(r[0], r[1], t) * (1 - smooth(r[2], r[3], t));
    o.reachSide = this.reachSide;
    if (o.reachW > 0) this.world(this.reachP, o.reach);
    // Feet on the boat from the landing aboard (boarding) or until the take-off (leaving).
    const aboard = this.kind === "board" || this.kind === "boardShore";
    o.onBoat = aboard ? t >= this.tLand - 0.02 : t <= this.tOff;
    o.done = tau >= this.end;
    return o;
  }

  /**
   * Her weight on the hull at time t: it settles 2 cm lower with a slight list to her side once she
   * is aboard, and her landing (or take-off) sets it bobbing and rocking for a second or so.
   */
  rock(t: number): void {
    const aboard = this.loadIn > 0;
    const tE = aboard ? this.tLand : this.tOff;
    const w = aboard ? smooth(tE, tE + 0.15, t) : 1 - smooth(tE, tE + 0.12, t);
    const s = t - tE;
    let h = SEATED.h * w, p = SEATED.p * w, r = SEATED.r * w;
    if (s > 0) {
      const a = aboard ? 1 : 0.7;
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
