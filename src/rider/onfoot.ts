import * as THREE from "three";
import { G } from "../render/materials";
import { WADE, type Bay } from "../world/bay";
import { roadX, roadYaw } from "../world/bay/road";
import { gaitCycle, jumpClock, type FootState, type GroundFn, type Rider } from "./rider";
import { Boarding, SHORE_FROM, SHORE_OFF, SHORE_STATIONS, type TransitKind } from "./boarding";
import { gunwaleAt } from "../boat/model";
import type { ChaseCam } from "./camera";
import type { Input } from "../core/input";
import type { RideAudio, StepSurface } from "../audio";
import { clamp, damp } from "../core/rng";
import type { Boat } from "../boat/boat";
import { BERTH } from "../boat/berth";
import { SEA_Y } from "../world/bay/road";
import { PIER, PIER_STAGE, PIER_STAIR, STAIR_FOOT_X, deckH } from "../world/bay/pier";

/**
 * On foot and in the skiff. She walks (WASD, Shift to jog) with a mouse orbit camera; F within
 * reach of the moored skiff steps aboard and sits at the tiller; F aboard, slow, at the berth or
 * close to wadeable shore steps ashore there (at the berth: up onto the pier deck). Stepping
 * aboard and ashore is a scripted move with the input locked (see boarding.ts).
 *
 * walk → board → boat → leave → walk
 */
export type FootMode = "walk" | "board" | "boat" | "leave";

/** After a boarding the boat's rocking from it dies out within this (s); then the resting load holds. */
const ROCK_T = 3.5;
/** Aboard and slower than this, F steps ashore. */
const LEAVE_SPEED = 1.3;

const WALK = 1.3;
/** Shift: an easy run (stride lengthens with speed, see gaitA). */
const RUN = 3.4;
/** On the stair: about one tread a step at the walk's cadence, two with Shift. */
const STAIR_WALK = 0.52, STAIR_RUN = 0.8;
/**
 * Her body's height over the stair: the line through the middle of each tread (her feet find the
 * treads themselves); NaN off it.
 */
function stairBodyH(x: number, z: number): number {
  const S = PIER_STAIR;
  if (z > S.z0 + 0.1 || z < S.z1 - 0.05 || x > S.x1 || x < STAIR_FOOT_X) return NaN;
  return clamp(PIER.deck - S.rise * ((S.x1 - x) / S.going + 0.5), PIER_STAGE.y, PIER.deck);
}
const BODY_R = 0.24;
/** Jump: gravity (a little over g, a lighter hop), take-off speed (~0.45 m up, ~0.5 s aloft),
 * the anticipation crouch and the landing squash (s), and the drop under her that makes a fall. */
const GRAV = 13;
const JUMP_V = 3.4;
const CROUCH_T = 0.13;
const LAND_T = 0.26;
/** Flight time of a standing jump on the flat (s). */
const FLY_T = (2 * JUMP_V) / GRAV;
const DROP_FALL = 0.3;
/** Steepest ground she walks up (tan 38°) and the highest step she takes in her stride (m). */
const SLOPE_UP = 0.78;
const STEP_UP = 0.3;
/** How far ahead (m) a steep rise stops her: about her body's half width. */
const LOOK_AHEAD = 0.25;
/** Orbit pitch limits: never steeper than ~55° looking down or below ~-10° looking up. */
const PITCH_MIN = -0.17;
const PITCH_MAX = 0.96;
const PIVOT_DROP = 0.1;
/** Turns (rad) tried, in order, to slide a blocked step along what stops it. */
const SLIDE = [0.5, -0.5, 1.0, -1.0, 1.35, -1.35];
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Explore {
  mode: FootMode = "walk";
  /** Walker position (feet), heading (forward = (-sin, -cos)), ground speed. */
  x = 0;
  z = 0;
  y = 0;
  yaw = 0;
  speed = 0;
  /** The ground under her (her feet rest on it, y eases toward it). */
  private gy = 0;
  /** Airborne (jumped or stepped off an edge), vertical speed, time aloft, ground she left. */
  private air = false;
  private vy = 0;
  private airT = 0;
  private takeoffY = 0;
  /** Jump anticipation timer (< 0: not crouching), time since landing and how hard it was. */
  private crouchT = -1;
  private landT = 1;
  private landK = 0;
  /** A Space press waits this long (s) for her to be ready; presses already handled. */
  private jumpBuf = 0;
  private jumpsSeen = 0;
  private run = 0;
  private phase = 0;
  private turn = 0;
  private look = 0;
  private lookUp = 0;
  private lookT = 0;
  private lookTarget = 0;
  private idleT = 0;
  private glance = 0;
  private surface: StepSurface = "wood";
  // Orbit camera.
  private oYaw = 0;
  private oPitch = 0.16;
  private oDist = 3.4;
  private dCur = 3.4;
  private pivot = new THREE.Vector3();
  private touched = 0;
  private dragging = false;
  private dragMoved = 0;
  private dragT = 0;
  private lastX = 0;
  private lastY = 0;
  readonly foot: FootState = { speed: 0, phase: 0, run: 0, turn: 0, look: 0, lookUp: 0, time: 0 };
  /** Test hook: walk in a fixed world direction instead of reading the keys. */
  autoWalk: { dx: number; dz: number; run: boolean } | null = null;
  /** F / C only act once play is running (not on the intro loader's "press any key"). */
  enabled = false;
  /** Idle glances around (off for posed test shots). */
  lookAround = true;
  /** The skiff (set once it exists). */
  boat: Boat | null = null;
  /** Boarding / stepping ashore: start (or end) point on land, and progress. */
  private shore = new THREE.Vector3();
  private shoreYaw = 0;
  private seatM = new THREE.Matrix4();
  private seatP = new THREE.Vector3();
  private seatQ = new THREE.Quaternion();
  private seatS = new THREE.Vector3();
  private grip = new THREE.Vector3();
  /** The boarding / stepping-ashore move under way, its clock (s), and the boat as her ground meanwhile. */
  private trans: Boarding | null = null;
  private tau = 0;
  private rockT = 1e9;
  private _bg = { h: 0, kind: "wood" as StepSurface };
  private readonly boatGround: GroundFn = (x, z, y) => {
    const b = this.boat;
    if (!b || !this.trans || (this.mode !== "board" && this.mode !== "leave")) return null;
    if (!this.trans.out.onBoat || b.hullDistance(x, z) > 0.02) {
      // At the deck edge her toes are over boards the walk rule keeps her body off (its last 12 cm);
      // elsewhere (the stair, the stage, the shore) the world's own ground.
      if (Math.abs(z - PIER.z) > PIER.half || x > PIER.x0 || x < PIER.x1 || y < PIER.deck - 0.7) return null;
      this._bg.h = deckH(x);
      return this._bg;
    }
    // The highest thing under the foot's length (so a toe never stubs into the bench or onto air).
    let h = b.standH(x, z, y);
    for (let k = 0; k < 4; k++) h = Math.max(h, b.standH(x + RING[k][0], z + RING[k][1], y));
    this._bg.h = h;
    return this._bg;
  };

  constructor(
    private bay: Bay,
    private rider: Rider,
    private chase: ChaseCam,
    private audio: RideAudio,
    private canvas: HTMLCanvasElement,
  ) {
    addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.repeat || !this.enabled) return;
      if (e.code === "KeyF") this.pressF();
      else if (e.code === "KeyC" && this.mode === "boat") this.chase.cycle();
    });
    addEventListener("blur", () => {
      this.dragging = false;
    });
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.dragMoved = 0;
      this.dragT = performance.now();
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    addEventListener("pointermove", (e) => {
      const locked = document.pointerLockElement === canvas;
      let mx = 0, my = 0;
      if (locked) {
        mx = e.movementX;
        my = e.movementY;
      } else if (this.dragging) {
        mx = e.clientX - this.lastX;
        my = e.clientY - this.lastY;
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.dragMoved += Math.abs(mx) + Math.abs(my);
      }
      if ((mx || my) && this.onFoot) this.orbitBy(mx, my);
    });
    addEventListener("pointerup", () => {
      if (this.dragging && this.dragMoved < 5 && performance.now() - this.dragT < 350 && (this.onFoot || this.lockAboard) && document.pointerLockElement !== canvas) {
        // A plain click captures the mouse for free look (Esc releases it).
        try {
          const p = canvas.requestPointerLock() as unknown as Promise<void> | undefined;
          p?.catch?.(() => {});
        } catch {
          /* not allowed here */
        }
      }
      this.dragging = false;
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        if (!this.onFoot) return;
        this.oDist = clamp(this.oDist * Math.exp(e.deltaY * 0.0011), 1.4, 7);
        this.touched = 3;
      },
      { passive: true },
    );
  }

  /** Also capture the mouse on a canvas click while aboard (off for scripted captures). */
  lockAboard = false;

  /** On her feet (the orbit camera is in charge), including stepping aboard and ashore. */
  get onFoot(): boolean {
    return this.mode === "walk" || this.mode === "board" || this.mode === "leave";
  }

  /** Seated in the boat at the tiller (the boat camera is in charge). */
  get inBoat(): boolean {
    return this.mode === "boat";
  }

  /** Where the player is (the boat while aboard, her while on foot). */
  get playerZ(): number {
    return this.mode === "boat" && this.boat ? this.boat.z : this.z;
  }
  get playerX(): number {
    return this.mode === "boat" && this.boat ? this.boat.x : this.x;
  }

  /** Close enough to the moored skiff to step aboard? At the berth: near the gap in the railing. */
  get nearBoat(): boolean {
    const b = this.boat;
    if (!b || this.mode !== "walk" || b.mode !== "idle" || Math.hypot(b.u, b.v) >= 1) return false;
    if (Math.hypot(b.x - BERTH.x, b.z - BERTH.z) < 6) {
      // On the stair or the stage, or on the deck near the stair head.
      const S = PIER_STAIR, G = PIER_STAGE;
      if (this.x < S.x0 + 0.1 && this.x > G.x1 - 0.1 && this.z < PIER.z - PIER.half && this.z > G.z1 - 0.1 && this.y < PIER.deck + 0.3) return true;
      return Math.hypot(this.x - BERTH.stand.x, this.z - BERTH.stand.z) < BERTH.reach && Math.abs(this.y - BERTH.stand.y) < 0.6;
    }
    return b.hullDistance(this.x, this.z) < BERTH.reach;
  }

  pressF(): void {
    if (this.mode === "walk" && !this.air && this.crouchT < 0 && this.nearBoat) this.startBoard();
    else if (this.mode === "boat") this.tryLeave();
  }

  /**
   * Character spawn: standing at world (x, z) facing `yaw`; the orbit camera at bearing `rel` from
   * behind her (radians, + swings it round to her right), `pitch` above her and `dist` back.
   */
  spawn(x: number, z: number, yaw: number, rel = 0, pitch = 0.12, dist = 3.6): void {
    this.mode = "walk";
    this.endTransit();
    this.onGround();
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.speed = 0;
    this.y = this.gy = this.bay.groundAt(x, z)?.h ?? 0;
    this.rider.walker.position.set(x, this.y, z);
    this.rider.walker.rotation.set(0, yaw, 0);
    this.setOrbit(rel, pitch, dist);
    this.touched = 0;
    this.rider.headWorld(this.pivot);
  }

  /** The orbit camera picks up from wherever the current camera is. */
  private orbitFromCam(): void {
    const cam = this.chase.cam.position;
    this.rider.headWorld(this.pivot);
    this.pivot.y -= PIVOT_DROP;
    const dx = cam.x - this.pivot.x, dy = cam.y - this.pivot.y, dz = cam.z - this.pivot.z;
    const d = Math.max(0.5, Math.hypot(dx, dy, dz));
    this.oYaw = Math.atan2(dx, dz);
    this.oPitch = clamp(Math.asin(clamp(dy / d, -1, 1)), PITCH_MIN, PITCH_MAX);
    this.oDist = clamp(d, 1.4, 7);
    this.dCur = this.oDist;
    this.touched = 0;
  }

  /** Capture / test hook: already seated at the tiller. */
  seatInBoat(): void {
    const b = this.boat;
    if (!b) return;
    this.onGround();
    this.shore.set(b.x, b.y, b.z);
    this.shoreYaw = b.yaw;
    this.mode = "boat";
    this.endTransit();
    Boarding.seatedLoad(b);
  }

  /** Off the scripted move: her ground is the world's again. */
  private endTransit(): void {
    this.rider.groundOverride = null;
    this.rockT = 1e9;
  }

  private transit(): Boarding {
    return (this.trans ??= new Boarding(this.boat!, (x, z, y) => (this.standable(x, z) ? (this.bay.groundAt(x, z, y)?.h ?? NaN) : NaN), this.rider.gait));
  }

  /** At the berth (the skiff moored by the pier gap)? */
  private get atBerth(): boolean {
    const b = this.boat!;
    return Math.hypot(b.x - BERTH.x, b.z - BERTH.z) < 6;
  }

  /** Feet on the ground, no jump under way. */
  private onGround(): void {
    this.air = false;
    this.vy = 0;
    this.crouchT = -1;
    this.landT = 1;
    this.landK = 0;
    this.jumpBuf = 0;
  }

  private startBoard(): void {
    const T = this.transit();
    if (this.atBerth) T.planBoard(this.x, this.y, this.z, this.yaw, this.phase);
    else T.planBoardShore(this.x, this.y, this.z, this.yaw, this.phase);
    this.startTransit("board");
  }

  private startTransit(mode: "board" | "leave"): void {
    this.mode = mode;
    this.tau = 0;
    this.rockT = 1e9;
    this.onGround();
    this.speed = 0;
    this.rider.groundOverride = this.boatGround;
  }

  /**
   * Capture hook: the scripted move `kind` (board from (x, z, yaw) on the deck / leave the berth
   * seat) at its clock tau (s; before 0 she waits at the start), at time `time`. Planned on the
   * first call.
   */
  transitAt(kind: "board" | "leave", tau: number, time: number, x = 0, z = 0, yaw = 0): void {
    const T = this.transit();
    const want: TransitKind = kind === "board" ? "board" : "leaveBerth";
    if (this.mode !== kind || T.kind !== want) {
      if (kind === "board") {
        this.x = x;
        this.z = z;
        this.yaw = yaw;
        this.y = this.gy = this.bay.groundAt(x, z)?.h ?? this.y;
        T.planBoard(x, this.y, z, yaw, 0);
      } else T.planLeaveBerth(0);
      this.startTransit(kind);
    }
    this.tau = tau;
    this.applyTransit(0, time);
  }

  /** Pose her on the move at this.tau; dt > 0 (live) also plays its knocks on the hull. */
  private applyTransit(dt: number, time: number): void {
    const T = this.trans!, b = this.boat!;
    const o = T.pose(this.tau);
    if (dt > 0) {
      const t0 = this.tau - dt;
      // A hop lands hard; a step in or out is a soft knock.
      const step = T.kind === "board" || T.kind === "leaveBerth";
      if (this.mode === "board" && t0 < T.tLand && this.tau >= T.tLand) b.onSlap(step ? 0.25 : 0.4);
      if (this.mode === "leave" && t0 < T.tOff && this.tau >= T.tOff) b.onSlap(step ? 0.18 : 0.25);
    }
    const w = this.rider.walker;
    w.position.copy(o.pos);
    w.quaternion.copy(o.quat);
    this.x = o.pos.x;
    this.y = o.pos.y;
    this.z = o.pos.z;
    this.yaw = o.yaw;
    this.speed = o.speed;
    this.phase = o.phase;
    this.run = clamp((o.speed - WALK) / (RUN - WALK), 0, 1);
    this.turn = 0;
    if (o.seat > 0) this.seatPose();
    // Her footsteps: on the boat's boards, or whatever is under her ashore.
    this.surface = o.onBoat ? "wood" : (this.bay.groundAt(this.x, this.z, this.y + 0.3)?.kind ?? this.surface);
    const f = this.foot;
    f.seat = o.seat;
    f.grip = o.seat > 0 ? this.grip : undefined;
    f.wind = 0;
    f.boating = false;
    f.roll = o.onBoat ? b.roll : 0;
    f.speed = o.speed;
    f.phase = o.phase;
    f.run = this.run;
    f.turn = 0;
    f.look = this.look = 0;
    f.lookUp = this.lookUp = 0;
    f.time = time;
    f.air = o.air;
    f.crouch = 0;
    f.vy = 0;
    f.jumpT = o.jumpT;
    f.jumpW = o.jumpW;
    f.reach = o.reach;
    f.reachW = o.reachW;
    f.reachSide = o.reachSide;
    f.stepP = o.stepP;
    f.stepW = o.stepW;
    f.stepYaw = o.stepYaw;
    f.stepDown = o.stepDown;
    f.busy = true;
    G.uPush.value.set(this.x, this.z, 0.85, o.onBoat || o.air ? 0 : 1);
  }

  /** Seat transform of the boat now (walker origin), and the tiller grip in walker space. */
  private seatPose(): void {
    const b = this.boat!;
    b.seatMatrix(this.seatM);
    this.seatM.decompose(this.seatP, this.seatQ, this.seatS);
    b.gripWorld(this.grip);
    this.grip.applyMatrix4(_mi.copy(this.seatM).invert());
  }

  /**
   * Aboard: step ashore at the berth, or over the side wherever the ground beside the hull is dry
   * or wadeable (a beach, a rock edge, a slipway's foot, the island). Slow, or aground, she goes;
   * in deep water she glances over the side and stays put.
   */
  private tryLeave(): void {
    const b = this.boat;
    if (!b) return;
    const T = this.transit();
    if (this.atBerth) {
      if (Math.hypot(b.u, b.v) > LEAVE_SPEED) return;
      // The stage is beside her berth: a boat stopped further off is laid in it.
      if (Math.hypot(b.x - BERTH.x, b.z - BERTH.z) > 1 || Math.abs(wrapA(b.yaw - BERTH.yaw)) > 0.3) b.moor();
      this.shore.set(BERTH.stand.x, BERTH.stand.y, BERTH.stand.z);
      T.planLeaveBerth(this.phase);
    } else {
      const out = this.shoreStep();
      if (!out) {
        this.refuseT = 0;
        return;
      }
      // Touching the bed counts as stopped (it holds her there while she steps out).
      if (Math.hypot(b.u, b.v) > LEAVE_SPEED && !b.aground) return;
      b.halt();
      T.planLeaveShore(this.phase, out.side, this.shore, out.from);
    }
    this.startTransit("leave");
    this.orbitFromCam();
    this.chase.forceThirdPerson(this.rider);
  }

  /**
   * The shallowest place to step out over the side: along both sides at each station, outward from
   * the planking, the first ground she can stand on there (dry, or water up to about her knees),
   * clear of rocks and posts. Sets this.shore; null in deep water.
   */
  private shoreStep(): { side: number; from: number } | null {
    const b = this.boat!;
    b.root.updateMatrixWorld(true);
    const M = b.root.matrixWorld.elements;
    let best = Infinity, side = 0, from = 0;
    for (let k = 0; k < SHORE_STATIONS.length; k++) {
      const { z, from: fi } = SHORE_STATIONS[k], half = gunwaleAt(z).half, F = SHORE_FROM[fi];
      for (const s of [-1, 1])
        for (let off = SHORE_OFF.min; off <= SHORE_OFF.max + 1e-6; off += 0.1) {
          const lx = s * (half + off);
          if (Math.hypot(lx - s * F.x, z - F.z) > SHORE_OFF.hop) break;
          const x = M[0] * lx + M[8] * z + M[12], wz = M[2] * lx + M[10] * z + M[14];
          if (!this.standable(x, wz)) continue;
          const h = this.bay.walkH(x, wz, this.y);
          if (this.circles(x, wz).pen > 0) continue;
          // Shallowest first; a little against a longer reach out, a station other than the usual and climbing forward.
          const score = Math.max(0, SEA_Y - h) + 0.1 * (off - SHORE_OFF.min) + 0.03 * k + 0.08 * fi;
          if (score < best) {
            best = score;
            side = s;
            from = fi;
            this.shore.set(x, h, wz);
          }
          break;
        }
    }
    return side ? { side, from } : null;
  }

  /** Time since F was refused in deep water (s): she glances down over the side and shakes her head. */
  private refuseT = 9;

  /** Circle obstacles (posts, bollards, lamps, shore rocks); houses are boxes, see standable(). */
  private circles(x: number, z: number): { pen: number; nx: number; nz: number } {
    const out = this._pen;
    out.pen = out.nx = out.nz = 0;
    for (const k of this.bay.colliders) {
      if (k.kind === "house" || k.top < this.y + 0.25) continue;
      const dx = x - k.x, dz = z - k.z, rr = k.r + BODY_R;
      if (Math.abs(dx) >= rr || Math.abs(dz) >= rr) continue;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2);
      if (rr - d > out.pen) {
        out.pen = rr - d;
        out.nx = d > 1e-5 ? dx / d : 1;
        out.nz = d > 1e-5 ? dz / d : 0;
      }
    }
    return out;
  }
  private readonly _pen = { pen: 0, nx: 0, nz: 0 };

  /**
   * Camera clearance: march from `pivot` along unit `dir` up to `dist`, stopping short of houses,
   * the ground and trunk/prop colliders. Returns the usable distance (>= 1 m).
   */
  obstruct(pivot: THREE.Vector3, dir: THREE.Vector3, dist: number): number {
    const p = this._p;
    for (let i = 1; i <= 14; i++) {
      const d = (i / 14) * dist;
      p.copy(pivot).addScaledVector(dir, d);
      const roof = this.bay.roofAt(p.x, p.z, 0.3);
      let hit = (roof > 0 && p.y < roof) || p.y < this.bay.camFloor(p.x, p.z) - 0.05;
      if (!hit && p.y < 3.2) {
        for (const k of this.bay.colliders)
          if (!k.kind && p.y < k.top && k.r >= 0.35 && k.r <= 1.2 && Math.hypot(p.x - k.x, p.z - k.z) < k.r * 0.7 + 0.2) {
            hit = true;
            break;
          }
      }
      if (hit) return Math.max(1.0, d - 0.35);
    }
    return dist;
  }
  private readonly _p = new THREE.Vector3();

  /** Lowest camera height at world (x, z): ground or water plus a margin. */
  camFloor(x: number, z: number): number {
    return this.bay.camFloor(x, z);
  }

  /** Lowest camera height over land, rocks and the deck (the boat camera may skim the water). */
  landFloor(x: number, z: number): number {
    return this.bay.landFloor(x, z);
  }

  /** Somewhere she can stand: walkable ground (not deep water, not off the map), not in a house. */
  private standable(x: number, z: number): boolean {
    return !Number.isNaN(this.bay.walkH(x, z, this.y)) && this.bay.roofAt(x, z, BODY_R) === 0;
  }

  /**
   * Can she step from where she stands to (x, z)? Not into a house or deep water, not up a step
   * higher than STEP_UP, never uphill onto ground steeper than SLOPE_UP (by its gradient, so a
   * slide along a face can't zigzag up it), and not toward a steep rise just ahead (she stops at
   * its foot instead of half inside it). Level or downhill anything goes.
   */
  private passable(x: number, z: number): boolean {
    const h = this.bay.walkH(x, z, this.y);
    if (Number.isNaN(h) || this.bay.roofAt(x, z, BODY_R) > 0) return false;
    // Aloft she clears anything below her feet and lands on it; anything higher stops her, and so
    // does a steep face rising ahead (no hopping up the sea wall a jump at a time).
    if (this.air) return h <= this.y + 0.05 && (h <= this.takeoffY + 0.05 || this.steepness(x, z, h) <= SLOPE_UP);
    const rise = h - this.gy;
    if (rise > STEP_UP || (rise > 0 && this.steepness(x, z, h) > SLOPE_UP)) return false;
    const dx = x - this.x, dz = z - this.z, d = Math.hypot(dx, dz) || 1;
    const ax = x + (dx / d) * LOOK_AHEAD, az = z + (dz / d) * LOOK_AHEAD;
    const a = this.bay.walkH(ax, az, h);
    return Number.isNaN(a) || a - this.gy < 0.05 || this.steepness(ax, az, a) <= SLOPE_UP;
  }

  /** Rise over run of the ground at (x, z), whose height is h. */
  private steepness(x: number, z: number, h: number): number {
    const e = 0.15;
    const hx = this.bay.walkH(x + e, z, h), hz = this.bay.walkH(x, z + e, h);
    return Number.isNaN(hx) || Number.isNaN(hz) ? 0 : Math.hypot(hx - h, hz - h) / e;
  }

  private move(dx: number, dz: number): void {
    let nx = this.x + dx, nz = this.z + dz;
    for (let it = 0; it < 2; it++) {
      const c = this.circles(nx, nz);
      if (c.pen <= 0) break;
      nx += c.nx * c.pen;
      nz += c.nz * c.pen;
    }
    // Stuck somewhere odd (teleport, set down on a steep face): let her walk out.
    if (this.passable(nx, nz) || !this.standable(this.x, this.z)) {
      this.x = nx;
      this.z = nz;
      return;
    }
    // Slide along whatever stops her (a wall, a slope, the deep water, a house): the step turned
    // toward its edge, shorter the further it turns.
    for (const a of SLIDE) {
      const c = Math.cos(a), s = Math.sin(a);
      const tx = this.x + (dx * c - dz * s) * c, tz = this.z + (dx * s + dz * c) * c;
      if (this.circles(tx, tz).pen < 0.002 && this.passable(tx, tz)) {
        this.x = tx;
        this.z = tz;
        return;
      }
    }
    this.speed *= 0.6;
  }

  /**
   * Her height. On the ground: eased over facets and small steps, never sunk into it. After the
   * take-off or off an edge: airborne under gravity until her feet meet the ground again.
   */
  private vertical(dt: number): void {
    if (this.crouchT >= 0) {
      this.crouchT += dt;
      if (this.crouchT >= CROUCH_T) {
        this.crouchT = -1;
        this.air = true;
        this.vy = JUMP_V;
        this.airT = 0;
        this.takeoffY = this.gy;
      }
    }
    const g = this.bay.groundAt(this.x, this.z, this.y);
    if (g) {
      const sb = stairBodyH(this.x, this.z);
      this.gy = Number.isNaN(sb) || Math.abs(sb - g.h) > 0.3 ? g.h : sb;
      this.surface = g.kind;
    }
    if (this.air) {
      this.airT += dt;
      this.vy -= GRAV * dt;
      this.y += this.vy * dt;
      if ((g && this.vy <= 0 && this.y <= g.h) || this.airT > 3) {
        this.landK = clamp(-this.vy / 5.5, 0.3, 1);
        this.landT = 0;
        this.air = false;
        this.y = this.gy;
        this.vy = 0;
      }
      return;
    }
    if (!g) return;
    this.landT += dt;
    const h = this.gy;
    if (h < this.y - DROP_FALL) {
      // Off an edge (the side of a slipway, a rock): she drops.
      this.air = true;
      this.vy = 0;
      this.airT = 0;
      this.takeoffY = this.y;
      return;
    }
    this.y = Math.max(h - 0.04, damp(this.y, h, 14, dt));
  }

  /** Space: a short anticipation crouch, then the take-off (on foot, ready, not aloft). */
  private jumpInput(dt: number, input: Input): void {
    if (input.jumps !== this.jumpsSeen) {
      this.jumpsSeen = input.jumps;
      if (this.enabled) this.jumpBuf = 0.15;
    }
    this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    if (this.jumpBuf > 0 && !this.air && this.crouchT < 0 && this.landT > 0.12) {
      this.jumpBuf = 0;
      this.crouchT = 0;
    }
  }

  update(dt: number, input: Input, time: number): void {
    switch (this.mode) {
      case "walk":
        this.jumpInput(dt, input);
        this.locomotion(dt, input);
        break;
      case "board":
      case "leave": {
        // Input locked: the move plays out on its own clock.
        this.tau += dt;
        this.applyTransit(dt, time);
        const T = this.trans!;
        if (!T.out.done) {
          this.idleLook(dt);
          return;
        }
        this.rockT = this.tau;
        this.rider.groundOverride = null;
        this.foot.busy = false;
        this.foot.reachW = 0;
        if (this.mode === "board") {
          this.mode = "boat";
          if (!this.lockAboard && document.pointerLockElement === this.canvas) document.exitPointerLock();
          this.chase.handoff("chase");
        } else {
          this.mode = "walk";
          T.landing(_v);
          this.x = _v.x;
          this.z = _v.z;
          this.y = this.gy = _v.y;
          this.onGround();
        }
        break;
      }
    }
    // The boat's rocking from the boarding (or stepping off) dies out, then her resting load holds.
    if (this.rockT < ROCK_T && this.trans && this.boat) {
      this.rockT += dt;
      this.trans.rock(this.rockT);
    } else if (this.boat && this.rockT < 1e9) {
      if (this.mode === "boat") Boarding.seatedLoad(this.boat);
      else this.boat.setLoad(0, 0, 0);
      this.rockT = 1e9;
    }
    const onFoot = this.onFoot;
    const boating = this.mode === "boat";
    let seat = 0;
    if (boating && this.boat) {
      // Seated at the tiller.
      this.seatPose();
      const w = this.rider.walker;
      w.position.copy(this.seatP);
      w.quaternion.copy(this.seatQ);
      seat = 1;
      this.x = w.position.x;
      this.z = w.position.z;
      this.y = w.position.y;
      this.speed = 0;
      this.yaw = this.boat.yaw;
      this.idleLook(dt);
      if (this.refuseT < 1.5) {
        // Too deep to step out: a look down over the side, a small shake of the head, back ahead.
        this.refuseT += dt;
        const r = this.refuseT;
        const over = smooth01(r / 0.35) * (1 - smooth01((r - 0.75) / 0.5));
        this.look = 0.8 * over + (r > 0.7 && r < 1.3 ? 0.2 * Math.sin(((r - 0.7) / 0.6) * Math.PI * 4) : 0);
        this.lookUp = -0.45 * over;
      }
    } else if (onFoot) {
      this.vertical(dt);
      this.rider.walker.position.set(this.x, this.y, this.z);
      this.rider.walker.rotation.set(0, this.yaw, 0);
      this.idleLook(dt);
    }
    const f = this.foot;
    f.seat = seat;
    f.grip = seat > 0 ? this.grip : undefined;
    f.wind = boating && this.boat ? Math.abs(this.boat.u) : 0;
    f.boating = boating;
    f.roll = boating && this.boat ? this.boat.roll : 0;
    f.speed = this.speed;
    f.phase = this.phase;
    f.run = this.run;
    f.turn = this.turn;
    f.look = this.look;
    f.lookUp = this.lookUp;
    f.time = time;
    f.reachW = 0;
    f.stepW = undefined;
    f.busy = false;
    // Jump: the crouch before take-off, then a squash on landing that comes in fast and eases out.
    const walking = onFoot && !boating;
    const antic = this.crouchT >= 0 ? smooth01(this.crouchT / CROUCH_T) : 0;
    const squash = this.landK * smooth01(this.landT / 0.05) * (1 - smooth01((this.landT - 0.05) / (LAND_T - 0.05)));
    f.air = walking && this.air ? 1 : 0;
    f.crouch = walking ? Math.max(antic * 0.8, squash) : 0;
    f.vy = this.vy;
    [f.jumpT, f.jumpW] = walking ? jumpClock(this.crouchT, this.airT, this.air, this.landT, FLY_T) : [0, 0];
    G.uPush.value.set(this.x, this.z, 0.85, walking && !this.air ? 1 : 0);
  }

  private steerToward(target: number, dt: number, rate: number): number {
    const err = wrapA(target - this.yaw);
    const dy = err * (1 - Math.exp(-rate * dt));
    this.yaw = wrapA(this.yaw + dy);
    this.turn = damp(this.turn, dt > 0 ? dy / dt : 0, 8, dt);
    return err;
  }

  private advancePhase(dt: number): void {
    this.run = clamp((this.speed - WALK) / (RUN - WALK), 0, 1);
    this.phase += ((this.speed * dt) / gaitCycle(this.run, this.speed)) * Math.PI * 2;
  }

  /** A footfall sound, called when one of her feet actually lands (Rider.onPlant). */
  footfall(): void {
    if (this.mode === "boat") return;
    const s = this.speed > 0.35 ? 0.5 + 0.55 * this.run + 0.15 * Math.min(1, this.speed / WALK) : 0.3;
    this.audio.footstep(this.surface, s);
  }

  private locomotion(dt: number, input: Input): void {
    let fwd = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    let str = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const sy = Math.sin(this.oYaw), cy = Math.cos(this.oYaw);
    let wx = -sy * fwd + cy * str;
    let wz = -cy * fwd - sy * str;
    let runKey = input.shift;
    if (this.autoWalk) {
      wx = this.autoWalk.dx;
      wz = this.autoWalk.dz;
      runKey = this.autoWalk.run;
      fwd = 1;
      str = 0;
    }
    const len = Math.hypot(wx, wz);
    if (this.air) {
      // Aloft: her momentum carries her, with a little steering; the stride waits for the landing.
      if (len > 0.01) this.steerToward(Math.atan2(-wx / len, -wz / len), dt, 1.5);
      if (this.speed > 1e-3) this.move(-Math.sin(this.yaw) * this.speed * dt, -Math.cos(this.yaw) * this.speed * dt);
      return;
    }
    let want = 0;
    if (len > 0.01) {
      wx /= len;
      wz /= len;
      want = runKey ? RUN : WALK;
      // Wading: no running past her shins, and the water slows her as it deepens to her knees.
      const depth = Math.max(0, SEA_Y - this.gy);
      want = Math.min(want, WALK + (RUN - WALK) * (1 - smooth01((depth - 0.1) / 0.2)));
      want *= 1 - 0.45 * smooth01((depth - 0.08) / (WADE - 0.08));
      // The stair (and the step or two before it, so she has slowed by its edge).
      const ah = 0.45 + 0.4 * this.speed, ax = this.x - Math.sin(this.yaw) * ah, az = this.z - Math.cos(this.yaw) * ah;
      const onStair = (x: number, z: number) => x < PIER_STAIR.x1 + 0.05 && x > STAIR_FOOT_X - 0.05 && z <= PIER_STAIR.z0 + 0.1 && z >= PIER_STAIR.z1 - 0.05;
      if (onStair(this.x, this.z) || onStair(ax, az)) want = Math.min(want, runKey ? STAIR_RUN : STAIR_WALK);
      const err = this.steerToward(Math.atan2(-wx, -wz), dt, want > WALK ? 7 : 9);
      // Turn on the spot for big direction changes, then set off.
      want *= clamp(Math.cos(err) * 1.2, 0.1, 1);
    } else this.turn = damp(this.turn, 0, 6, dt);
    const acc = want > this.speed ? (want > WALK ? 3.2 : 3.6) : 6.5;
    this.speed = Math.max(0, this.speed + clamp(want - this.speed, -acc * dt, acc * dt));
    if (this.speed > 1e-3) this.move(-Math.sin(this.yaw) * this.speed * dt, -Math.cos(this.yaw) * this.speed * dt);
    this.advancePhase(dt);
    // Lazy camera follow: while pushing forward, the orbit slowly swings in behind her.
    this.touched = Math.max(0, this.touched - dt);
    if (fwd > 0 && this.touched <= 0 && this.speed > 0.2) {
      const behind = this.yaw;
      this.oYaw = wrapA(this.oYaw + wrapA(behind - this.oYaw) * (1 - Math.exp(-0.35 * dt * (this.speed / WALK))));
    }
  }

  private idleLook(dt: number): void {
    if (this.mode === "walk" && this.speed < 0.08 && this.lookAround) this.idleT += dt;
    else {
      this.idleT = 0;
      this.lookTarget = 0;
    }
    if (this.idleT > 2.2) {
      this.lookT -= dt;
      if (this.lookT <= 0) {
        // Glance around: over a shoulder, out to sea, back ahead (a fixed pseudo-random sequence,
        // so captures repeat).
        const k = ++this.glance;
        const r = hash(k), r2 = hash(k + 0.5), r3 = hash(k + 0.25);
        this.lookTarget = this.lookTarget !== 0 && r < 0.55 ? 0 : (r < 0.5 ? -1 : 1) * (0.35 + r2 * 0.35);
        this.lookT = 1.6 + r3 * 2.6;
      }
    }
    this.look = damp(this.look, this.lookTarget, 2.4, dt);
    this.lookUp = damp(this.lookUp, this.lookTarget !== 0 ? -0.08 + 0.05 * Math.sin(this.idleT * 0.7) : 0, 1.5, dt);
  }

  private orbitBy(mx: number, my: number): void {
    this.oYaw = wrapA(this.oYaw - mx * 0.0055);
    this.oPitch = clamp(this.oPitch + my * 0.004, PITCH_MIN, PITCH_MAX);
    this.touched = 3;
  }

  /** Test / script hook: camera bearing relative to her facing (0 = behind, π = in front), pitch, distance. */
  setOrbit(rel: number, pitch: number, dist: number): void {
    this.oYaw = wrapA(this.yaw + rel);
    this.oPitch = clamp(pitch, PITCH_MIN, PITCH_MAX);
    this.oDist = clamp(dist, 1.4, 7);
    this.dCur = this.oDist;
    this.touched = 1e9;
  }

  /**
   * Capture hook: on foot at world (x, z) facing `yaw`, moving at `speed` (m/s) with gait `phase`,
   * at time `time`; no input, no collisions (the caller keeps her on a clear path).
   */
  drive(x: number, z: number, yaw: number, speed: number, phase: number, time: number, run = 0): void {
    this.mode = "walk";
    this.endTransit();
    this.onGround();
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.speed = speed;
    this.phase = phase;
    this.run = run;
    this.turn = 0;
    const g = this.bay.groundAt(x, z, this.y);
    if (g) {
      // On the stair: the free walk's line through the tread middles, not the tread heights.
      const sb = stairBodyH(x, z);
      this.y = this.gy = Number.isNaN(sb) || Math.abs(sb - g.h) > 0.3 ? g.h : sb;
      this.surface = g.kind;
    }
    this.rider.walker.position.set(x, this.y, z);
    this.rider.walker.rotation.set(0, yaw, 0);
    const f = this.foot;
    f.seat = 0;
    f.grip = undefined;
    f.wind = 0;
    f.boating = false;
    f.roll = 0;
    f.speed = speed;
    f.phase = phase;
    f.run = run;
    f.turn = 0;
    f.look = 0;
    f.lookUp = 0;
    f.time = time;
    f.air = f.crouch = f.vy = f.jumpW = f.reachW = 0;
    f.stepW = undefined;
    f.busy = false;
    G.uPush.value.set(x, z, 0.85, 1);
  }

  /** Test hook: stand at world (x, z) facing `yaw` (on foot only). */
  standAt(x: number, z: number, yaw = this.yaw): void {
    if (this.mode !== "walk") return;
    this.onGround();
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.y = this.gy = this.bay.groundAt(x, z)?.h ?? this.y;
    this.speed = 0;
  }

  /** Test hook: stand at road-relative (u, z) facing `yaw`. */
  teleport(u: number, z: number, yaw = roadYaw(z)): void {
    this.onGround();
    this.x = roadX(z) + u;
    this.z = z;
    this.yaw = yaw;
    this.y = this.gy = this.bay.groundAt(this.x, z)?.h ?? 0;
    this.speed = 0;
    this.rider.headWorld(this.pivot);
  }

  updateCamera(dt: number, cam: THREE.PerspectiveCamera): void {
    const head = this.rider.headWorld(new THREE.Vector3());
    head.y -= PIVOT_DROP;
    this.pivot.x = damp(this.pivot.x, head.x, 9, dt);
    this.pivot.z = damp(this.pivot.z, head.z, 9, dt);
    this.pivot.y = damp(this.pivot.y, head.y, 5, dt);
    const cp = Math.cos(this.oPitch);
    const dir = new THREE.Vector3(Math.sin(this.oYaw) * cp, Math.sin(this.oPitch), Math.cos(this.oYaw) * cp);
    // Pull in ahead of houses, trunks and the ground; ease back out.
    const lim = this.obstruct(this.pivot, dir, this.oDist);
    this.dCur = lim < this.dCur ? lim : damp(this.dCur, lim, 2.5, dt);
    cam.position.copy(this.pivot).addScaledVector(dir, this.dCur);
    // Pulled in to its minimum it can still sit in a slope: never below the ground.
    cam.position.y = Math.max(cam.position.y, this.bay.camFloor(cam.position.x, cam.position.z));
    cam.fov = 45;
    cam.near = 0.1;
    cam.updateProjectionMatrix();
    cam.lookAt(this.pivot.x, this.pivot.y + 0.05, this.pivot.z);
    cam.updateMatrixWorld();
  }
}

const _mi = new THREE.Matrix4();
/** Sample offsets round a foot's ankle (m): about its length. */
const RING = [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]];
const _v = new THREE.Vector3();
const hash = (n: number) => {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

const smooth01 = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
