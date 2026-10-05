import * as THREE from "three";
import { G } from "../render/materials";
import { WADE, type Bay } from "../world/bay";
import { roadX, roadYaw } from "../world/bay/road";
import { gaitCycle, type FootState, type Rider } from "./rider";
import type { ChaseCam } from "./camera";
import type { Input } from "../core/input";
import type { RideAudio, StepSurface } from "../audio";
import { clamp, damp } from "../core/rng";
import type { Boat } from "../boat/boat";
import { BERTH } from "../boat/berth";
import { SEA_Y } from "../world/bay/road";

/**
 * On foot and in the skiff. She walks (WASD, Shift to jog) with a mouse orbit camera; F within
 * reach of the moored skiff steps aboard and sits at the tiller; F aboard, slow, at the berth or
 * close to wadeable shore steps ashore there (at the berth: up onto the pier deck).
 *
 * walk → board → boat → leave → walk
 */
export type FootMode = "walk" | "board" | "boat" | "leave";

const BOARD_T = 1.5;
/** Aboard and slower than this, F steps ashore. */
const LEAVE_SPEED = 1.3;

const WALK = 1.3;
/** Shift: an easy run (stride lengthens with speed, see gaitA). */
const RUN = 3.4;
const BODY_R = 0.24;
/** Jump: gravity (a little over g, a lighter hop), take-off speed (~0.45 m up, ~0.5 s aloft),
 * the anticipation crouch and the landing squash (s), and the drop under her that makes a fall. */
const GRAV = 13;
const JUMP_V = 3.4;
const CROUCH_T = 0.13;
const LAND_T = 0.26;
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
  private k = 0;
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
    if (Math.hypot(b.x - BERTH.x, b.z - BERTH.z) < 6) return Math.hypot(this.x - BERTH.stand.x, this.z - BERTH.stand.z) < BERTH.reach && Math.abs(this.y - BERTH.stand.y) < 0.6;
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
    this.k = 0;
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
    this.k = 1;
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
    this.shore.set(this.x, this.y, this.z);
    this.shoreYaw = this.yaw;
    this.mode = "board";
    this.k = 0;
  }

  /** Seat transform of the boat now (walker origin), and the tiller grip in walker space. */
  private seatPose(): void {
    const b = this.boat!;
    b.seatMatrix(this.seatM);
    this.seatM.decompose(this.seatP, this.seatQ, this.seatS);
    b.gripWorld(this.grip);
    this.grip.applyMatrix4(_mi.copy(this.seatM).invert());
  }

  /** Aboard: step ashore at the berth, or onto any wadeable ground close beside the hull. */
  private tryLeave(): void {
    const b = this.boat;
    if (!b || Math.hypot(b.u, b.v) > LEAVE_SPEED) return;
    let found = false;
    if (Math.hypot(b.x - BERTH.x, b.z - BERTH.z) < 6) {
      this.shore.set(BERTH.stand.x, BERTH.stand.y, BERTH.stand.z);
      found = true;
    } else {
      for (let r = 1.4; r <= 4.3 && !found; r += 0.7) {
        let best = 1e9;
        for (let i = 0; i < 20; i++) {
          const a = (i / 20) * Math.PI * 2;
          const x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
          if (b.hullDistance(x, z) < 0.45 || !this.standable(x, z)) continue;
          // Prefer the shallowest (closest to dry land).
          const h = -(this.bay.groundAt(x, z)?.h ?? SEA_Y);
          if (h < best) {
            best = h;
            this.shore.set(x, this.bay.groundAt(x, z)?.h ?? SEA_Y, z);
            found = true;
          }
        }
      }
    }
    if (!found) return;
    const dx = this.shore.x - b.x, dz = this.shore.z - b.z;
    this.shoreYaw = Math.atan2(-dx, -dz);
    this.x = this.shore.x;
    this.z = this.shore.z;
    this.yaw = this.shoreYaw;
    this.mode = "leave";
    this.k = 1;
    this.orbitFromCam();
    this.chase.forceThirdPerson(this.rider);
  }

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
    return this.bay.groundAt(x, z, this.y) !== null && this.bay.roofAt(x, z, BODY_R) === 0;
  }

  /**
   * Can she step from where she stands to (x, z)? Not into a house or deep water, not up a step
   * higher than STEP_UP, never uphill onto ground steeper than SLOPE_UP (by its gradient, so a
   * slide along a face can't zigzag up it), and not toward a steep rise just ahead (she stops at
   * its foot instead of half inside it). Level or downhill anything goes.
   */
  private passable(x: number, z: number): boolean {
    const g = this.bay.groundAt(x, z, this.y);
    if (!g || this.bay.roofAt(x, z, BODY_R) > 0) return false;
    // Aloft she clears anything below her feet and lands on it; anything higher stops her, and so
    // does a steep face rising ahead (no hopping up the sea wall a jump at a time).
    if (this.air) return g.h <= this.y + 0.05 && (g.h <= this.takeoffY + 0.05 || this.steepness(x, z, g.h) <= SLOPE_UP);
    const rise = g.h - this.gy;
    if (rise > STEP_UP || (rise > 0 && this.steepness(x, z, g.h) > SLOPE_UP)) return false;
    const dx = x - this.x, dz = z - this.z, d = Math.hypot(dx, dz) || 1;
    const ax = x + (dx / d) * LOOK_AHEAD, az = z + (dz / d) * LOOK_AHEAD;
    const a = this.bay.groundAt(ax, az, g.h);
    return !a || a.h - this.gy < 0.05 || this.steepness(ax, az, a.h) <= SLOPE_UP;
  }

  /** Rise over run of the ground at (x, z), whose height is h. */
  private steepness(x: number, z: number, h: number): number {
    const e = 0.15;
    const gx = this.bay.groundAt(x + e, z, h), gz = this.bay.groundAt(x, z + e, h);
    return gx && gz ? Math.hypot(gx.h - h, gz.h - h) / e : 0;
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
      this.gy = g.h;
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
    if (g.h < this.y - DROP_FALL) {
      // Off an edge (the side of a slipway, a rock): she drops.
      this.air = true;
      this.vy = 0;
      this.airT = 0;
      this.takeoffY = this.y;
      return;
    }
    this.y = Math.max(g.h - 0.04, damp(this.y, g.h, 14, dt));
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
        this.k = Math.min(1, this.k + dt / BOARD_T);
        if (this.k >= 1) {
          this.mode = "boat";
          if (!this.lockAboard && document.pointerLockElement === this.canvas) document.exitPointerLock();
          this.chase.handoff("chase");
        }
        break;
      case "leave":
        this.k = Math.max(0, this.k - dt / BOARD_T);
        if (this.k <= 0) {
          this.mode = "walk";
          this.x = this.shore.x;
          this.z = this.shore.z;
          this.y = this.gy = this.shore.y;
          this.onGround();
        }
        break;
    }
    const onFoot = this.onFoot;
    const boating = this.mode === "board" || this.mode === "boat" || this.mode === "leave";
    let seat = 0;
    if (boating && this.boat) {
      // From the shore point to the bench (or back): a couple of steps, over the gunwale, sit down.
      this.seatPose();
      const k = this.mode === "boat" ? 1 : this.k;
      const e = smooth01(k / 0.8);
      const w = this.rider.walker;
      w.position.lerpVectors(this.shore, this.seatP, e);
      w.position.y += Math.sin(Math.PI * smooth01((k - 0.25) / 0.55)) * 0.28;
      _q.setFromAxisAngle(_up, this.shoreYaw);
      w.quaternion.slerpQuaternions(_q, this.seatQ, smooth01((k - 0.1) / 0.6));
      seat = smooth01((k - 0.55) / 0.45);
      const prevX = this.x, prevZ = this.z;
      this.x = w.position.x;
      this.z = w.position.z;
      this.y = w.position.y;
      const moving = this.mode !== "boat" && dt > 0 ? Math.hypot(this.x - prevX, this.z - prevZ) / dt : 0;
      this.speed = this.mode === "boat" ? 0 : Math.min(1.1, moving) * (1 - seat);
      this.yaw = this.mode === "boat" ? this.boat.yaw : this.yaw;
      if (this.mode !== "boat") this.advancePhase(dt);
      this.idleLook(dt);
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
    // Jump: the crouch before take-off, then a squash on landing that comes in fast and eases out.
    const walking = onFoot && !boating;
    const antic = this.crouchT >= 0 ? smooth01(this.crouchT / CROUCH_T) : 0;
    const squash = this.landK * smooth01(this.landT / 0.05) * (1 - smooth01((this.landT - 0.05) / (LAND_T - 0.05)));
    f.air = walking && this.air ? 1 : 0;
    f.crouch = walking ? Math.max(antic * 0.8, squash) : 0;
    f.vy = this.vy;
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
  drive(x: number, z: number, yaw: number, speed: number, phase: number, time: number): void {
    this.mode = "walk";
    this.k = 0;
    this.onGround();
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.speed = speed;
    this.phase = phase;
    this.run = 0;
    this.turn = 0;
    const g = this.bay.groundAt(x, z, this.y);
    if (g) {
      this.y = this.gy = g.h;
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
    f.run = 0;
    f.turn = 0;
    f.look = 0;
    f.lookUp = 0;
    f.time = time;
    f.air = f.crouch = f.vy = 0;
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
