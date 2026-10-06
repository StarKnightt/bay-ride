import * as THREE from "three";
import { BENCH, FLOOR_Y, HULL, benchHalf, buildBoat, gunwaleAt, type BoatModel } from "./model";
import { BERTH } from "./berth";
import { scriptPose, type ScriptPose } from "./script";
import { seaHeight } from "../water/query";
import { BUOY_XZ } from "../water/buoys";
import { WAKE_DT, WAKE_N, setWake, type TrailPoint } from "../water/wake";
import { terrainH } from "../world/bay/terrain";
import { SEA_Y } from "../world/bay/road";
import type { Bay } from "../world/bay";
import type { Input } from "../core/input";
import { clamp } from "../core/rng";

/** Waterline: half length, and how far forward of amidships it ends at the bow. */
const WL_HALF = 1.8;
const BOW_F = 1.85;
/** Full-throttle push (m/s²), drag (linear, quadratic), reverse push, and prop-reversal braking. */
const THRUST = 3.55;
const DRAG1 = 0.12;
const DRAG2 = 0.035;
/** Astern she makes ~3.8 m/s, about 45% of her 8.5 m/s ahead. */
const REVERSE = 0.96;
const BRAKE = 1.3;
/** Shift: the throttle opens past full (top speed ~10.4 m/s), with a harder wake and spray. */
export const BOOST = 1.35;
/** Sideways slip damping (1/s): low enough for a light, drifting hull. */
const SLIP = 1.5;
const _sp = new THREE.Vector3(), _sm = new THREE.Matrix4(), _sg = { y: 0, half: 0 };
/** Prop churn at full throttle is 1; boosted it reaches this (boil, aerated band and slick astern). */
const CHURN_MAX = 1.25;
/** Seabed clearance under the keel that stops the hull, and the depth where the shallows start to drag. */
const GROUND = 0.38;
const SHALLOW = 1.15;
/** Hull probe points (forward, starboard) in metres from amidships. */
const PROBES: [number, number][] = [[1.35, 0], [-1.75, 0], [0, -0.62], [0, 0.62]];
const HIST = 1100;

const sm = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export interface BoatSnap {
  x: number;
  z: number;
  yaw: number;
  speed: number;
  throttle: number;
  odo: number;
  y: number;
}

/**
 * The skiff: floats on the bay's water query (heave, pitch and roll from five points on the hull,
 * on soft springs), leans into turns (a flick outward, then inward as she carves), lifts her bow
 * under throttle and settles as she slows. W/S throttle (S reverses slowly), A/D the tiller, with
 * momentum, sideways drift and drag; the shallows drag her down and the land stops her.
 *
 * Modes: idle (nobody aboard: drifts to a stop, moored on soft lines at the berth), driven (keys),
 * scripted (the capture course, a pure function of time).
 */
export class Boat {
  readonly model: BoatModel;
  mode: "idle" | "driven" | "scripted" = "idle";
  x = BERTH.x;
  z = BERTH.z;
  yaw = BERTH.yaw;
  /** Forward and starboard speed (m/s), yaw rate (rad/s, + turns left). */
  u = 0;
  v = 0;
  yawRate = 0;
  /** -1 (astern) … 1 (full ahead), eased. */
  throttle = 0;
  /** Tiller -1 … 1 (+ steers to starboard, the arm swung to port), eased. */
  steer = 0;
  /** Distance the bow has travelled (m). */
  odo = 0;
  /** Pose: heave (world y of the boat frame's origin), pitch (+ bow up), roll (+ starboard up). */
  y = SEA_Y;
  pitch = 0;
  roll = 0;
  /** Mean water height under the hull (the mirror plane near her). */
  waterH = SEA_Y;
  private wBow = SEA_Y;
  private wStern = SEA_Y;
  private vy = 0;
  private vp = 0;
  private vr = 0;
  private latLP = 0;
  private uPrev = 0;
  private accLP = 0;
  private bowVelMin = 0;
  private slapCool = 0;
  private lastT: number | null = null;
  /** Hit the hull on a swell or the shore: strength 0…1. */
  onSlap: (s: number) => void = () => {};
  /** Ran aground or bumped something this frame (for a soft knock). */
  bumped = 0;
  private hist = new Float64Array(HIST * 7);
  private hHead = 0;
  private hLen = 0;
  private sp: ScriptPose = { x: 0, z: 0, yaw: 0, speed: 0, yawRate: 0, throttle: 0, s: 0 };
  private trail: TrailPoint[] = Array.from({ length: WAKE_N }, () => ({ x: 0, z: 0, odo: 0, age: 0, speed: 0, churn: 0, yaw: 0 }));
  private m4 = new THREE.Matrix4();

  constructor(private bay: Bay) {
    this.model = buildBoat();
    this.y = seaHeight(this.x, this.z, 0) - HULL.waterY;
  }

  get root(): THREE.Group {
    return this.model.root;
  }

  /** Forward unit vector. */
  get fx(): number {
    return -Math.sin(this.yaw);
  }
  get fz(): number {
    return -Math.cos(this.yaw);
  }

  /** Horizontal distance from (px, pz) to the hull (0 on or inside it). */
  hullDistance(px: number, pz: number): number {
    const dx = px - this.x, dz = pz - this.z;
    const f = dx * this.fx + dz * this.fz;
    const s = dx * Math.cos(this.yaw) - dz * Math.sin(this.yaw);
    const ex = Math.max(Math.abs(f) - 1.9, 0), es = Math.max(Math.abs(s) - 0.75, 0);
    return Math.hypot(ex, es);
  }

  /** Where she sits: the seat frame in world space (origin on the floor under her, facing forward). */
  seatMatrix(out: THREE.Matrix4): THREE.Matrix4 {
    this.model.root.updateMatrixWorld(true);
    this.m4.makeTranslation(this.model.seat);
    return out.multiplyMatrices(this.model.root.matrixWorld, this.m4);
  }

  /** Tiller grip in world space. */
  gripWorld(out: THREE.Vector3): THREE.Vector3 {
    this.model.motor.updateMatrixWorld(true);
    return out.copy(this.model.grip).applyMatrix4(this.model.motor.matrixWorld);
  }

  /** Touching the bed: a hull probe within a few centimetres of where the shallows stop her. */
  get aground(): boolean {
    for (const [pf, ps] of PROBES) if (this.depthAt(pf, ps) < GROUND + 0.06) return true;
    return false;
  }

  /** Stop dead where she is (stepping out of her). */
  halt(): void {
    this.u = this.v = this.yawRate = this.throttle = this.steer = 0;
  }

  /** Put her back on the berth, at rest. */
  moor(): void {
    this.x = BERTH.x;
    this.z = BERTH.z;
    this.yaw = BERTH.yaw;
    this.u = this.v = this.yawRate = this.throttle = this.steer = 0;
    this.apply(0);
  }

  update(dt: number, t: number, input: Input | null): void {
    this.bumped = 0;
    if (this.mode === "scripted") this.runScript(t);
    else {
      if (this.lastT === null || this.lastT !== -1) {
        this.settle(t);
        this.lastT = -1;
      }
      const n = Math.max(1, Math.ceil(dt / (1 / 90)));
      for (let i = 0; i < n; i++) {
        const tt = t - dt + ((i + 1) * dt) / n;
        this.physics(dt / n, this.mode === "driven" ? input : null);
        this.floatStep(dt / n, tt);
      }
      if (dt > 0) this.record(t);
    }
    this.apply(dt);
    this.uploadWake(t);
  }

  // ------------------------------------------------------------------ driving

  private physics(dt: number, input: Input | null): void {
    if (dt <= 0) return;
    const up = input?.up ?? false, down = input?.down ?? false;
    const want = up && !down ? (input?.shift ? BOOST : 1) : down && !up ? -1 : 0;
    // The throttle eases up (more slowly past full), comes off quicker.
    const rate = want > this.throttle ? (this.throttle >= 1 ? 0.6 : 0.9) : 2.2;
    this.throttle += clamp(want - this.throttle, -rate * dt, rate * dt);
    const steerIn = input ? (input.right ? 1 : 0) - (input.left ? 1 : 0) : 0;
    this.steer += (steerIn - this.steer) * (1 - Math.exp(-5 * dt));

    // Forward push: ahead, astern (slowly), or the prop reversed against forward way.
    let a = 0;
    if (this.throttle > 0) a = this.throttle * THRUST;
    else if (this.throttle < 0) a = this.u > 0.3 ? this.throttle * BRAKE : this.throttle * REVERSE;
    a -= DRAG1 * this.u + DRAG2 * this.u * Math.abs(this.u);
    this.u += a * dt;
    this.v *= Math.exp(-(SLIP + 0.5 * Math.abs(this.v)) * dt);

    // The tiller turns her through the water once she has way on; at rest the prop wash still swings
    // the stern a little. Turning bleeds a little speed.
    const au = Math.abs(this.u);
    const grip = sm(0.2, 3.0, au) * (1 - 0.3 * sm(5, 9, au)) * Math.sign(this.u || 1);
    const wash = 0.3 * Math.max(this.throttle, 0) * (1 - sm(0, 2, au));
    const wantYaw = -this.steer * (0.62 * grip + wash);
    this.yawRate += (wantYaw - this.yawRate) * (1 - Math.exp(-2.4 * dt));
    this.u *= 1 - Math.abs(this.yawRate) * 0.05 * dt * au;
    // Turning the hull leaves part of its momentum behind: it shows up as outward slip (drift).
    const dy = this.yawRate * dt;
    const c = Math.cos(dy * 0.35), s = Math.sin(dy * 0.35);
    const u2 = this.u * c - this.v * s, v2 = this.u * s + this.v * c;
    this.u = u2;
    this.v = v2;
    this.yaw += dy;

    // Shallows drag her down; mooring lines hold her at the berth when nobody is aboard.
    let dmin = 99;
    for (const [pf, ps] of PROBES) dmin = Math.min(dmin, this.depthAt(pf, ps));
    if (dmin < SHALLOW) {
      const k = clamp((SHALLOW - dmin) / (SHALLOW - GROUND), 0, 1);
      const e = Math.exp(-2.2 * k * k * dt);
      this.u *= e;
      this.v *= e;
    }
    if (this.mode === "idle") {
      const bx = BERTH.x - this.x, bz = BERTH.z - this.z;
      if (bx * bx + bz * bz < 64) {
        const lx = bx * Math.cos(this.yaw) - bz * Math.sin(this.yaw);
        const lf = bx * this.fx + bz * this.fz;
        this.u += (lf * 0.6 - this.u * 1.2) * dt;
        this.v += (lx * 0.6 - this.v * 1.2) * dt;
        const dyaw = Math.atan2(Math.sin(BERTH.yaw - this.yaw), Math.cos(BERTH.yaw - this.yaw));
        this.yawRate += (dyaw * 0.5 - this.yawRate * 1.0) * dt;
      }
    }

    const px = this.x, pz = this.z;
    const wx = this.fx * this.u + Math.cos(this.yaw) * this.v;
    const wz = this.fz * this.u - Math.sin(this.yaw) * this.v;
    this.x += wx * dt;
    this.z += wz * dt;
    this.odo += Math.abs(this.u) * dt;
    this.collide(px, pz, dt);
    this.x = clamp(this.x, -560, 560);
    this.z = clamp(this.z, -480, 480);
  }

  /** Still-water depth under a hull point (forward pf, starboard ps). */
  private depthAt(pf: number, ps: number, x = this.x, z = this.z): number {
    const cx = Math.cos(this.yaw), sx = Math.sin(this.yaw);
    return SEA_Y - terrainH(x + this.fx * pf + cx * ps, z + this.fz * pf - sx * ps);
  }

  /**
   * Land, rocks, the pier and buoys. Running up the bed stops her and pushes her back toward deeper
   * water. Against a solid (the pier and its stage, a rock, a buoy) she slides: pushed out by the
   * penetration, only the speed into it is taken off (a soft bump), the speed along it kept, and
   * the hit off her centre line swings her away from it.
   */
  private collide(px: number, pz: number, dt: number): void {
    let nx = 0, nz = 0, ground = false;
    let ox = 0, oz = 0, tq = 0, solid = false;
    const cx = Math.cos(this.yaw), sx = Math.sin(this.yaw);
    for (const [pf, ps] of PROBES) {
      const rx = this.fx * pf + cx * ps, rz = this.fz * pf - sx * ps;
      const qx = this.x + rx, qz = this.z + rz;
      if (SEA_Y - terrainH(qx, qz) < GROUND) {
        // Toward deeper water.
        const e = 0.6;
        const gx = terrainH(qx + e, qz) - terrainH(qx - e, qz), gz = terrainH(qx, qz + e) - terrainH(qx, qz - e);
        const l = Math.hypot(gx, gz) || 1;
        nx -= gx / l;
        nz -= gz / l;
        ground = true;
      }
      const c = this.bay.contact(qx, qz, 0.45);
      let pen = c.pen, cnx = c.nx, cnz = c.nz;
      for (const [bx, bz] of BUOY_XZ) {
        const dx = qx - bx, dz = qz - bz, d = Math.hypot(dx, dz);
        if (d < 1.15 && d > 1e-3 && 1.15 - d > pen) {
          pen = 1.15 - d;
          cnx = dx / d;
          cnz = dz / d;
        }
      }
      if (pen > 0) {
        ox += cnx * pen;
        oz += cnz * pen;
        // Yaw that moves this probe out along the normal (+ yaw turns her left).
        tq += rz * cnx - rx * cnz;
        solid = true;
      }
    }
    if (ground) this.runAground(px, pz, nx, nz, cx, sx);
    else if (solid) this.slide(ox, oz, tq, cx, sx, dt);
  }

  private slide(ox: number, oz: number, tq: number, cx: number, sx: number, dt: number): void {
    const l = Math.hypot(ox, oz);
    if (l < 1e-6) return;
    const nx = ox / l, nz = oz / l;
    // Out of it, fully: several probes on one face would each count the same overlap.
    const push = Math.min(l, 0.25);
    this.x += nx * push;
    this.z += nz * push;
    const wx = this.fx * this.u + cx * this.v, wz = this.fz * this.u - sx * this.v;
    const vn = wx * nx + wz * nz;
    let vx = wx, vz = wz;
    if (vn < 0) {
      vx -= 1.25 * vn * nx;
      vz -= 1.25 * vn * nz;
      if (-vn > 0.8) {
        this.bumped = clamp(-vn / 5, 0.2, 1);
        this.onSlap(this.bumped * 0.7);
      }
      // A little yaw away, more for a harder hit, from the off-centre contact.
      this.yawRate += clamp(Math.sign(tq) * Math.min(1, Math.abs(tq)) * -vn * 0.35, -0.6, 0.6);
    }
    // Rubbing along it: light friction, never a stop.
    const f = Math.exp(-0.8 * dt);
    vx *= f;
    vz *= f;
    this.u = vx * this.fx + vz * this.fz;
    this.v = vx * cx - vz * sx;
  }

  private runAground(px: number, pz: number, nx: number, nz: number, cx: number, sx: number): void {
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    this.x = px + nx * 0.03;
    this.z = pz + nz * 0.03;
    const wx = this.fx * this.u + cx * this.v, wz = this.fz * this.u - sx * this.v;
    const vn = wx * nx + wz * nz;
    let ox = wx, oz = wz;
    if (vn < 0) {
      ox -= 1.35 * vn * nx;
      oz -= 1.35 * vn * nz;
      if (-vn > 0.8) {
        this.bumped = clamp(-vn / 5, 0.2, 1);
        this.onSlap(this.bumped * 0.7);
      }
    }
    ox *= 0.55;
    oz *= 0.55;
    this.u = ox * this.fx + oz * this.fz;
    this.v = ox * cx - oz * sx;
    this.yawRate *= 0.6;
  }

  private record(t: number): void {
    const i = this.hHead * 7, h = this.hist;
    h[i] = t;
    h[i + 1] = this.x;
    h[i + 2] = this.z;
    h[i + 3] = this.yaw;
    h[i + 4] = this.u;
    h[i + 5] = this.throttle;
    h[i + 6] = this.odo;
    this.hHead = (this.hHead + 1) % HIST;
    this.hLen = Math.min(HIST, this.hLen + 1);
  }

  /** The boat at an earlier time (history, or the course in scripted mode). */
  stateAt(time: number, out: BoatSnap): BoatSnap {
    if (this.mode === "scripted") {
      const p = scriptPose(time, this.sp);
      out.x = p.x;
      out.z = p.z;
      out.yaw = p.yaw;
      out.speed = p.speed;
      out.throttle = p.throttle;
      out.odo = p.s;
      out.y = seaHeight(p.x, p.z, time);
      return out;
    }
    const h = this.hist;
    const at = (k: number) => ((this.hHead - 1 - k + HIST * 2) % HIST) * 7;
    let lo = 0;
    if (this.hLen === 0 || time >= h[at(0)]) {
      out.x = this.x;
      out.z = this.z;
      out.yaw = this.yaw;
      out.speed = this.u;
      out.throttle = this.throttle;
      out.odo = this.odo;
      out.y = seaHeight(this.x, this.z, time);
      return out;
    }
    // Newest first: find the pair around `time`.
    let hi = this.hLen - 1;
    if (time <= h[at(hi)]) lo = hi;
    else {
      lo = 0;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (h[at(m)] >= time) lo = m;
        else hi = m;
      }
    }
    const a = at(lo), b = at(Math.min(lo + 1, this.hLen - 1));
    const span = h[a] - h[b];
    const k = span > 1e-6 ? clamp((h[a] - time) / span, 0, 1) : 0;
    const L = (o: number) => h[a + o] + (h[b + o] - h[a + o]) * k;
    out.x = L(1);
    out.z = L(2);
    out.yaw = h[a + 3] + Math.atan2(Math.sin(h[b + 3] - h[a + 3]), Math.cos(h[b + 3] - h[a + 3])) * k;
    out.speed = L(4);
    out.throttle = L(5);
    out.odo = L(6);
    out.y = seaHeight(out.x, out.z, time);
    return out;
  }

  // ------------------------------------------------------------------ the capture course

  private runScript(t: number): void {
    const step = 1 / 90;
    let from = this.lastT;
    if (from === null || from === -1 || t < from || t - from > 4) {
      from = t - 4;
      this.syncScript(from);
      this.settle(from);
    }
    for (let tt = from; tt < t - 1e-9; ) {
      const h = Math.min(step, t - tt);
      tt += h;
      this.syncScript(tt);
      this.floatStep(h, tt);
    }
    this.syncScript(t);
    this.lastT = t;
  }

  private syncScript(t: number): void {
    const p = scriptPose(t, this.sp);
    this.x = p.x;
    this.z = p.z;
    this.yaw = p.yaw;
    this.u = p.speed;
    this.v = 0;
    this.yawRate = p.yawRate;
    this.throttle = p.throttle;
    this.steer = clamp(-p.yawRate / 0.45, -1, 1);
    this.odo = p.s;
  }

  // ------------------------------------------------------------------ floating

  /** Spring targets from the water under the hull and the way she is moving. */
  private targets(t: number): [number, number, number] {
    const cx = Math.cos(this.yaw), sx = Math.sin(this.yaw);
    const h = (pf: number, ps: number) => seaHeight(this.x + this.fx * pf + cx * ps, this.z + this.fz * pf - sx * ps, t);
    const hb = h(1.3, 0), hs = h(-1.5, 0), hp = h(0, -0.6), hr = h(0, 0.6), hc = h(0, 0);
    const au = Math.abs(this.u);
    // Climbing onto the plane the bow rises, then levels a little once she is up and running.
    const hump = sm(1.2, 4.2, au) * (1 - 0.5 * sm(5, 8, au));
    const surge = clamp(this.accLP, -2.5, 2.5);
    const water = (hb + hs + hp + hr + hc * 2) / 6;
    this.waterH = water;
    this.wBow = hb;
    this.wStern = hs;
    const heave = water - HULL.waterY + 0.02 * sm(4.5, 8, au) + Math.min(surge, 0) * 0.012;
    const pitch = clamp(Math.atan2(hb - hs, 2.8) * 0.85 + 0.04 * hump * Math.sign(this.u || 1) + 0.009 * surge, -0.07, 0.06);
    // Banking: a flick outward as the turn bites (the hull's inertia), then a steady lean inward.
    const lat = this.u * this.yawRate;
    const bank = clamp(0.11 * this.latLP - 0.1 * (lat - this.latLP), -0.24, 0.24);
    const roll = Math.atan2(hr - hp, 1.2) * 0.8 + bank - this.v * 0.05;
    return [heave, pitch, roll];
  }

  private settle(t: number): void {
    const [y, p, r] = this.targets(t);
    this.y = y;
    this.pitch = p;
    this.roll = r;
    this.vy = this.vp = this.vr = 0;
    this.latLP = this.u * this.yawRate;
    this.uPrev = this.u;
    this.accLP = 0;
  }

  /** One spring step of heave, pitch and roll (light and a little underdamped). */
  private floatStep(dt: number, t: number): void {
    if (dt <= 0) return;
    const lat = this.u * this.yawRate;
    this.latLP += (lat - this.latLP) * (1 - Math.exp(-dt / 0.75));
    const acc = (this.u - this.uPrev) / dt;
    this.uPrev = this.u;
    this.accLP += (acc - this.accLP) * (1 - Math.exp(-dt / 0.5));
    const [ty, tp, tr] = this.targets(t);
    const spring = (x: number, v: number, target: number, w: number, z: number): [number, number] => {
      const a = w * w * (target - x) - 2 * z * w * v;
      v += a * dt;
      return [x + v * dt, v];
    };
    const bowVel = this.vy + this.vp * 1.4;
    [this.y, this.vy] = spring(this.y, this.vy, ty, 6.5, 0.45);
    [this.pitch, this.vp] = spring(this.pitch, this.vp, tp, 6.0, 0.42);
    [this.roll, this.vr] = spring(this.roll, this.vr, tr, 3.6, 0.3);
    // However the springs lag a passing swell, she floats: the waterline never sinks more than a
    // few centimetres under the water amidships, at the transom or at the bow.
    this.pitch = clamp(this.pitch, -0.09, 0.075);
    const over = this.y + HULL.waterY - (this.waterH + 0.14);
    if (over > 0) {
      this.y -= over;
      this.vy = Math.min(this.vy, 0);
    }
    const sp = Math.sin(this.pitch);
    const under = Math.max(
      this.waterH - 0.05 - (this.y + HULL.waterY),
      this.wStern - 0.06 - (this.y + HULL.waterY - 1.5 * sp),
      this.wBow - 0.1 - (this.y + HULL.waterY + 1.3 * sp),
    );
    if (under > 0) {
      this.y += under;
      this.vy = Math.max(this.vy, 0);
    }
    // A slap: the bow drops onto a swell and is stopped.
    this.slapCool -= dt;
    this.bowVelMin = Math.min(this.bowVelMin + dt * 0.6, bowVel, 0);
    const nb = this.vy + this.vp * 1.4;
    if (this.bowVelMin < -0.3 && nb > -0.05 && Math.abs(this.u) > 2 && this.slapCool <= 0) {
      this.onSlap(clamp(-this.bowVelMin * 0.9 * Math.min(1, Math.abs(this.u) / 6), 0.15, 1));
      this.slapCool = 0.35;
      this.bowVelMin = 0;
    }
  }

  /**
   * Her weight aboard: offsets (heave m, pitch, roll rad) over the floating pose, set by the boarding
   * as a pure function of its clock (so a frozen frame shows the same dip) and held while she sits.
   * The hull is re-posed at once, so her seat follows it this frame.
   */
  setLoad(h: number, p: number, r: number): void {
    const L = this.load;
    if (L.h === h && L.p === p && L.r === r) return;
    L.h = h;
    L.p = p;
    L.r = r;
    this.apply(0);
  }
  private load = { h: 0, p: 0, r: 0 };

  /**
   * World height of what she stands on aboard at world (x, z), her root at world height y: the
   * gunwale's rail cap at the side (if she is up there), the stern bench's top over it, else the
   * floorboards.
   */
  standH(x: number, z: number, y = this.y): number {
    const m = this.model.root;
    m.updateMatrixWorld(true);
    const p = _sp.set(x, y, z).applyMatrix4(_sm.copy(m.matrixWorld).invert());
    const g = gunwaleAt(p.z, _sg);
    const onBench = Math.abs(p.z - BENCH.z) < BENCH.depth / 2 && Math.abs(p.x) < this.benchHalf;
    p.y = Math.abs(p.x) > g.half - 0.01 && p.y > g.y - 0.45 ? g.y : onBench ? BENCH.top : FLOOR_Y;
    return p.applyMatrix4(m.matrixWorld).y;
  }
  private benchHalf = benchHalf();

  private apply(dt: number): void {
    const r = this.model.root, L = this.load;
    r.position.set(this.x, this.y + L.h, this.z);
    r.rotation.set(this.pitch + L.p, this.yaw, this.roll + L.r, "YXZ");
    this.model.motor.rotation.y = this.steer * 0.45;
    this.model.prop.rotation.z += dt * (6 + 70 * Math.abs(this.throttle));
  }

  /** How hard the prop churns the water (0…1, up to 1.25 with the throttle past full). */
  get churn(): number {
    return clamp(Math.max(this.throttle, 0) * (0.55 + 0.45 * sm(0.5, 5, Math.abs(this.u))) + 0.25 * Math.max(-this.throttle, 0), 0, CHURN_MAX);
  }

  private snap: BoatSnap = { x: 0, z: 0, yaw: 0, speed: 0, throttle: 0, odo: 0, y: 0 };

  private uploadWake(t: number): void {
    const s = this.snap;
    for (let k = 0; k < WAKE_N; k++) {
      const tk = t - k * WAKE_DT;
      if (k === 0) {
        s.x = this.x;
        s.z = this.z;
        s.yaw = this.yaw;
        s.speed = this.u;
        s.throttle = this.throttle;
        s.odo = this.odo;
      } else this.stateAt(tk, s);
      const p = this.trail[k];
      p.x = s.x - Math.sin(s.yaw) * BOW_F;
      p.z = s.z - Math.cos(s.yaw) * BOW_F;
      p.odo = s.odo;
      p.yaw = s.yaw;
      p.age = k * WAKE_DT;
      p.speed = Math.max(s.speed, 0);
      p.churn = clamp(Math.max(s.throttle, 0) * (0.55 + 0.45 * sm(0.5, 5, Math.abs(s.speed))), 0, CHURN_MAX) * sm(0.3, 2.5, Math.abs(s.speed) + 1.2 * Math.max(s.throttle, 0));
    }
    setWake(
      this.trail,
      { x: this.x, z: this.z, yaw: this.yaw, speed: this.u, throttle: this.throttle, odo: this.odo },
      { halfLen: WL_HALF, halfBeam: HULL.halfBeam },
    );
  }
}
