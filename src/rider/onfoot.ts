import * as THREE from "three";
import { G } from "../render/materials";
import type { Bay } from "../world/bay";
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
const RUN = 3.0;
const BODY_R = 0.24;
/** Orbit pitch limits: never steeper than ~55° looking down or below ~-10° looking up. */
const PITCH_MIN = -0.17;
const PITCH_MAX = 0.96;
const PIVOT_DROP = 0.1;
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Explore {
  mode: FootMode = "walk";
  /** Walker position (feet), heading (forward = (-sin, -cos)), ground speed. */
  x = 0;
  z = 0;
  y = 0;
  yaw = 0;
  speed = 0;
  private run = 0;
  private phase = 0;
  private turn = 0;
  private k = 0;
  private shiftKey = false;
  private look = 0;
  private lookUp = 0;
  private lookT = 0;
  private lookTarget = 0;
  private idleT = 0;
  private stepCount = 0;
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
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.shiftKey = true;
      if (e.repeat || !this.enabled) return;
      if (e.code === "KeyF") this.pressF();
      else if (e.code === "KeyC" && this.mode === "boat") this.chase.cycle();
    });
    addEventListener("keyup", (e) => {
      if (e.code === "ShiftLeft" || e.code === "ShiftRight") this.shiftKey = false;
    });
    addEventListener("blur", () => {
      this.shiftKey = false;
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
    if (this.mode === "walk" && this.nearBoat) this.startBoard();
    else if (this.mode === "boat") this.tryLeave();
  }

  /**
   * Character spawn: standing at world (x, z) facing `yaw`; the orbit camera at bearing `rel` from
   * behind her (radians, + swings it round to her right), `pitch` above her and `dist` back.
   */
  spawn(x: number, z: number, yaw: number, rel = 0, pitch = 0.12, dist = 3.6): void {
    this.mode = "walk";
    this.k = 0;
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.speed = 0;
    this.y = this.bay.groundAt(x, z)?.h ?? 0;
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
    this.shore.set(b.x, b.y, b.z);
    this.shoreYaw = b.yaw;
    this.mode = "boat";
    this.k = 1;
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
          if (b.hullDistance(x, z) < 0.45 || !this.free(x, z)) continue;
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

  /** Circle obstacles (trunks, poles, signs, posts, bollards); houses are boxes, see free(). */
  private circles(x: number, z: number): { pen: number; nx: number; nz: number } {
    const out = { pen: 0, nx: 0, nz: 0 };
    const test = (cx: number, cz: number, r: number) => {
      const dx = x - cx, dz = z - cz;
      const rr = r + BODY_R;
      const d2 = dx * dx + dz * dz;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2);
        if (rr - d > out.pen) {
          out.pen = rr - d;
          out.nx = d > 1e-5 ? dx / d : 1;
          out.nz = d > 1e-5 ? dz / d : 0;
        }
      }
    };
    for (const k of this.bay.colliders) if (k.r <= 1.2 && Math.abs(k.z - z) < 3 && Math.abs(k.x - x) < 3) test(k.x, k.z, k.r);
    return out;
  }

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
          if (k.r >= 0.35 && k.r <= 1.2 && Math.hypot(p.x - k.x, p.z - k.z) < k.r * 0.7 + 0.2) {
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

  private free(x: number, z: number): boolean {
    return this.bay.groundAt(x, z, this.y) !== null && this.bay.roofAt(x, z, BODY_R) === 0;
  }

  private move(dx: number, dz: number): void {
    let nx = this.x + dx, nz = this.z + dz;
    for (let it = 0; it < 2; it++) {
      const c = this.circles(nx, nz);
      if (c.pen <= 0) break;
      nx += c.nx * c.pen;
      nz += c.nz * c.pen;
    }
    // Stuck somewhere odd (teleport): let her walk out.
    if (this.free(nx, nz) || !this.free(this.x, this.z)) {
      this.x = nx;
      this.z = nz;
      return;
    }
    // Slide along walls and bank edges: keep the road-relative lateral fixed, or keep z fixed.
    const u0 = this.x - roadX(this.z);
    const tries: [number, number][] = [[roadX(this.z + dz) + u0, this.z + dz], [this.x + dx, this.z], [this.x, this.z + dz]];
    for (const [tx, tz] of tries) {
      if (this.free(tx, tz) && this.circles(tx, tz).pen < 0.002) {
        this.x = tx;
        this.z = tz;
        return;
      }
    }
    this.speed *= 0.6;
  }

  update(dt: number, input: Input, time: number): void {
    switch (this.mode) {
      case "walk":
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
          this.y = this.shore.y;
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
      const g = this.bay.groundAt(this.x, this.z, this.y);
      if (g) {
        this.y = damp(this.y, g.h, 12, dt);
        this.surface = g.kind;
      }
      this.rider.walker.position.set(this.x, this.y, this.z);
      this.rider.walker.rotation.set(0, this.yaw, 0);
      this.idleLook(dt);
    }
    const f = this.foot;
    f.seat = seat;
    f.grip = seat > 0 ? this.grip : undefined;
    f.wind = boating && this.boat ? Math.abs(this.boat.u) : 0;
    f.speed = this.speed;
    f.phase = this.phase;
    f.run = this.run;
    f.turn = this.turn;
    f.look = this.look;
    f.lookUp = this.lookUp;
    f.time = time;
    G.uPush.value.set(this.x, this.z, 0.85, onFoot && !boating ? 1 : 0);
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
    this.phase += ((this.speed * dt) / gaitCycle(this.run)) * Math.PI * 2;
    // Footfalls: each foot lands when the phase passes a multiple of π.
    const n = Math.floor(this.phase / Math.PI);
    if (n !== this.stepCount) {
      if (this.speed > 0.35) this.audio.footstep(this.surface, 0.5 + 0.55 * this.run + 0.15 * Math.min(1, this.speed / WALK));
      this.stepCount = n;
    }
  }

  private locomotion(dt: number, input: Input): void {
    let fwd = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    let str = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const sy = Math.sin(this.oYaw), cy = Math.cos(this.oYaw);
    let wx = -sy * fwd + cy * str;
    let wz = -cy * fwd - sy * str;
    let runKey = this.shiftKey;
    if (this.autoWalk) {
      wx = this.autoWalk.dx;
      wz = this.autoWalk.dz;
      runKey = this.autoWalk.run;
      fwd = 1;
      str = 0;
    }
    const len = Math.hypot(wx, wz);
    let want = 0;
    if (len > 0.01) {
      wx /= len;
      wz /= len;
      want = runKey ? RUN : WALK;
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
        // Glance around: over a shoulder, at the sky, back ahead.
        const r = Math.random();
        this.lookTarget = this.lookTarget !== 0 && r < 0.55 ? 0 : (r < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.35);
        this.lookT = 1.6 + Math.random() * 2.6;
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

  /** Test hook: stand at world (x, z) facing `yaw` (on foot only). */
  standAt(x: number, z: number, yaw = this.yaw): void {
    if (this.mode !== "walk") return;
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.y = this.bay.groundAt(x, z)?.h ?? this.y;
    this.speed = 0;
  }

  /** Test hook: stand at road-relative (u, z) facing `yaw`. */
  teleport(u: number, z: number, yaw = roadYaw(z)): void {
    this.x = roadX(z) + u;
    this.z = z;
    this.yaw = yaw;
    this.y = this.bay.groundAt(this.x, z)?.h ?? 0;
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
    cam.fov = 45;
    cam.near = 0.1;
    cam.updateProjectionMatrix();
    cam.lookAt(this.pivot.x, this.pivot.y + 0.05, this.pivot.z);
    cam.updateMatrixWorld();
  }
}

const _mi = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

const smooth01 = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};
