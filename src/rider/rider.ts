import * as THREE from "three";
import { G, uber } from "../render/materials";
import { ID } from "../world/geo";
import { LAYER_CHAR } from "../render/lightpasses";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Chain, Rig, V, ik } from "./rig";
import { ANKLE_H, FORE, J, SHIN, THIGH, UPPER, buildSkeleton, skinParts, smooth, type Bones, type Geo } from "./body";
import { FACE, HEAD_C, faceMaterial, headGeo } from "./head";
import { hairParts, hairRig, type HairRig } from "./hair";
import { camiParts, clothRig, hatParts, sandalParts, shirtParts, shortsParts, underHat, type ClothRig } from "./outfit";

/**
 * The player character: a young woman in her mid-twenties made for the beach (see body.ts,
 * head.ts, hair.ts, outfit.ts for how she is built). One skeleton drives a handful of skinned
 * meshes on the GPU. Local frame: forward = -Z, up = +Y, right = +X, feet on y = 0.
 *
 * On foot her feet are planted in the world: each stance foot stays exactly where it landed
 * (heel strike, roll over the ball, toe-off) while the hips travel over it, so nothing slides,
 * also when turning, slowing or on a slope; standing still she rests her weight on one leg and
 * shifts it now and then, breathing, re-stepping if she turns on the spot. Hair, shirt tails and
 * the hat ribbon are spring chains in world space; cloth edges and the hat brim flutter in the
 * apparent wind on the GPU.
 */

/** Animation input for one frame (written by the explorer, rider/onfoot.ts). */
export interface FootState {
  /** Ground speed (m/s), gait phase (radians, one stride per 2π), 0 walk … 1 run. */
  speed: number;
  phase: number;
  run: number;
  /** Yaw rate (rad/s) for leaning into turns. */
  turn: number;
  /** Idle head look-around (yaw, pitch offsets). */
  look: number;
  lookUp: number;
  time: number;
  /** 0 standing … 1 seated in the boat (walker origin on the floor under the bench, facing forward). */
  seat?: number;
  /** Tiller grip for the left hand, in walker space. */
  grip?: THREE.Vector3;
  /** Apparent wind (m/s) on the water (the boat's speed through it). */
  wind?: number;
  /** The explorer moves her by script (stepping aboard, in the boat, stepping ashore). */
  boating?: boolean;
  /** Boat roll (rad), for leaning against the heel. */
  roll?: number;
}

/** Ground under a world point: height and surface. */
export type GroundFn = (x: number, z: number, y: number) => { h: number; kind: string } | null;
/** A foot landing in the world (for footprints and ripples). */
export type PlantFn = (x: number, y: number, z: number, yaw: number, side: number, kind: string, time: number) => void;

/** Gait: stance fraction and half step (m) for walk (0) … jog (1); cycle = ground covered per stride. */
const gaitDuty = (run: number) => 0.6 - 0.2 * run;
/** Half step: shorter strides (and a quicker cadence for the speed) when she ambles. */
const gaitA = (run: number, speed = 1.3) => (0.31 + 0.1 * run) * Math.min(1, Math.max(0.45, 0.45 + 0.55 * (speed / 1.3)));
export const gaitCycle = (run: number, speed = 1.3) => (2 * gaitA(run, speed)) / gaitDuty(run);

const SIDE = [1, -1];
const REACH = (THIGH + SHIN) * 0.994;
/** Foot pivots relative to the ankle (bind, flat): heel and ball contact points. */
const HEEL = V(0, -ANKLE_H, 0.045);
const BALL = new THREE.Vector3().subVectors(J.ball(1), J.ankle(1)).setX(0).add(V(0, -0.022, 0));

interface Pose {
  pelvisP: THREE.Vector3;
  pelvisQ: THREE.Quaternion;
  spineQ: THREE.Quaternion;
  chestQ: THREE.Quaternion;
  neckQ: THREE.Quaternion;
  headQ: THREE.Quaternion;
  shrug: THREE.Vector3[];
  ankle: THREE.Vector3[];
  footQ: THREE.Quaternion[];
  toe: number[];
  kneePole: THREE.Vector3[];
  wrist: THREE.Vector3[];
  elbowPole: THREE.Vector3[];
  handDir: THREE.Vector3[];
  thumbDir: THREE.Vector3[];
  curl: number[];
  thumb: number[];
  /** 1: wrist targets are relative to the shoulder (standing); 0: walker space (seated). */
  wristRel: number[];
}
const v2 = () => [new THREE.Vector3(), new THREE.Vector3()];
const q2 = () => [new THREE.Quaternion(), new THREE.Quaternion()];
const newPose = (): Pose => ({
  pelvisP: new THREE.Vector3(), pelvisQ: new THREE.Quaternion(), spineQ: new THREE.Quaternion(), chestQ: new THREE.Quaternion(),
  neckQ: new THREE.Quaternion(), headQ: new THREE.Quaternion(), shrug: v2(), ankle: v2(), footQ: q2(), toe: [0, 0], kneePole: v2(),
  wrist: v2(), elbowPole: v2(), handDir: v2(), thumbDir: v2(), curl: [0, 0], thumb: [0, 0], wristRel: [1, 1],
});
function blendPose(A: Pose, B: Pose, w: number): void {
  A.pelvisP.lerp(B.pelvisP, w);
  for (const k of ["pelvisQ", "spineQ", "chestQ", "neckQ", "headQ"] as const) A[k].slerp(B[k], w);
  for (let i = 0; i < 2; i++) {
    A.shrug[i].lerp(B.shrug[i], w);
    A.ankle[i].lerp(B.ankle[i], w);
    A.footQ[i].slerp(B.footQ[i], w);
    A.toe[i] += (B.toe[i] - A.toe[i]) * w;
    A.kneePole[i].lerp(B.kneePole[i], w).normalize();
    A.wrist[i].lerp(B.wrist[i], w);
    A.elbowPole[i].lerp(B.elbowPole[i], w).normalize();
    A.handDir[i].lerp(B.handDir[i], w).normalize();
    A.thumbDir[i].lerp(B.thumbDir[i], w).normalize();
    A.curl[i] += (B.curl[i] - A.curl[i]) * w;
    A.thumb[i] += (B.thumb[i] - A.thumb[i]) * w;
    A.wristRel[i] += (B.wristRel[i] - A.wristRel[i]) * w;
  }
}

/** One foot's world-locked state. */
class Foot {
  planted = true;
  /** Flat-foot ankle position (world) and heading (world yaw) where it stands or will land. */
  readonly pw = new THREE.Vector3();
  yaw = 0;
  /** Swing: start ankle (world), start yaw / pitch, progress, duration, lift, ground kind. */
  readonly from = new THREE.Vector3();
  fromYaw = 0;
  fromPitch = 0;
  u = 0;
  dur = 0.4;
  lift = 0.08;
  prevS = 0;
  kind = "wood";
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _mi = new THREE.Matrix4();
const qEuler = (x: number, y: number, z: number, out = new THREE.Quaternion()) => out.setFromEuler(_e.set(x, y, z, "YXZ"));
const frac = (x: number) => x - Math.floor(x);
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const hash = (n: number) => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class Rider {
  /** Her root: feet on the ground, facing -Z. The explorer sets its position and rotation. */
  readonly walker = new THREE.Group();
  /** Ground query for planting her feet (set by main; flat y = walker y if absent). */
  ground: GroundFn | null = null;
  /** Called when a foot lands on foot (footprints, ripples). */
  onPlant: PlantFn | null = null;
  /** Called before a frozen frame re-runs the seconds leading up to it (clear trails). */
  onSettle: (() => void) | null = null;
  /** Seconds a frozen frame re-runs (longer leaves a longer trail of footprints). */
  settleT = 3;
  /** World point she looks at (head and eyes), or null to look where the explorer says. */
  gazeTarget: THREE.Vector3 | null = null;
  private rig = new Rig();
  private B: Bones;
  private hair: HairRig;
  private cloth: ClothRig;
  private meshes: Record<string, THREE.SkinnedMesh> = {};
  private poseA = newPose();
  private poseS = newPose();
  private feet = [new Foot(), new Foot()];
  private feetInit = false;
  private standK = 1;
  private fppOn = false;
  private fppArms = false;
  private simAcc = 0;
  private simInit = false;
  private lastPos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private wind = new THREE.Vector3();
  private settledAt = NaN;
  private lastTime = NaN;
  private lookYaw = 0;
  private lookPitch = 0;

  constructor() {
    const rig = this.rig;
    this.B = buildSkeleton(rig);
    this.hair = hairRig(rig);
    this.cloth = clothRig(rig, this.B);
    rig.bind();
    this.walker.add(rig.root);
    const B = this.B;
    const add = (name: string, geos: Geo[], mat: THREE.Material) => {
      const g = mergeGeometries(geos, false);
      if (!g) throw new Error(`merge failed: ${name}`);
      for (const x of geos) x.dispose();
      g.computeBoundingSphere();
      const m = new THREE.SkinnedMesh(g, mat);
      m.name = name;
      m.bind(rig.skeleton, new THREE.Matrix4());
      m.frustumCulled = false;
      this.walker.add(m);
      this.meshes[name] = m;
      return m;
    };
    const skins = skinParts(rig, B);
    // Neck and torso apart from the limbs (first person hides the upper body, not the arms).
    add("skinUpper", skins.slice(0, 2), uber(ID.skin, 1, THREE.FrontSide, 0, true));
    add("skinLimbs", skins.slice(2), uber(ID.skin, 1, THREE.FrontSide, 0, true));
    add("face", [headGeo(() => [[B.head, 1]])], faceMaterial(ID.eye));
    add("hair", underHat(hairParts(rig, this.hair, B.head)), uber(ID.hair, 0.6, THREE.FrontSide, 0, true));
    add("shirt", shirtParts(rig, B, this.cloth), uber(ID.rider, 1, THREE.DoubleSide, 0, true));
    add("cami", camiParts(rig, B), uber(ID.top, 0.7, THREE.FrontSide, 0, true));
    add("shorts", [...shortsParts(rig, B), ...sandalParts(rig, B)], uber(ID.shorts, 1, THREE.DoubleSide, 0, true));
    const hat = hatParts(B.head, this.cloth);
    add("hat", [...hat.straw, ...hat.ribbon, ...hat.glasses], uber(ID.hat, 1, THREE.FrontSide, 0, true));
    // Soft contact shadow under her feet (the sun shadow does the rest).
    this.walker.add(blobShadow(0.62, 0.62));
    this.poseNeutral();
  }

  /** Bind pose → a neutral standing pose so the first frame is sane. */
  private poseNeutral(): void {
    this.rig.root.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- public seams

  /** Hide head/hair/hat and upper body (first-person view) or show them; arms stay if `arms`. */
  setFirstPerson(on: boolean, arms = on): void {
    arms &&= on;
    if (on === this.fppOn && arms === this.fppArms) return;
    this.fppOn = on;
    this.fppArms = arms;
    for (const k of ["face", "hair", "hat", "skinUpper", "cami", "shirt"]) {
      const m = this.meshes[k];
      m.layers.enable(LAYER_CHAR);
      if (on) m.layers.disable(0);
      else m.layers.enable(0);
    }
    const limbs = this.meshes.skinLimbs;
    if (on && !arms) limbs.layers.disable(0);
    else limbs.layers.enable(0);
  }

  /** Kept for the camera code: she wears no skirt any more. */
  setSkirtHidden(on: boolean): void {
    void on;
  }

  /** World-space eye point (between the eyes, slightly forward). */
  eyeWorld(out: THREE.Vector3): THREE.Vector3 {
    this.walker.updateMatrixWorld(true);
    return this.rig.carry(this.B.head, _v.copy(HEAD_C).add(V(0, -0.009, -0.075)), out).applyMatrix4(this.walker.matrixWorld);
  }

  /** World-space point at the middle of her head (orbit-camera pivot). */
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    this.walker.updateMatrixWorld(true);
    return this.rig.carry(this.B.head, HEAD_C, out).applyMatrix4(this.walker.matrixWorld);
  }

  /** 0 seated in the boat … 1 standing. */
  get standing(): number {
    return this.standK;
  }

  /** Where her feet stand now (world), for tests and footprints. */
  footWorld(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.walker.updateMatrixWorld(true);
    return out.copy(this.rig.bones[this.B.foot[i]].position).applyMatrix4(this.walker.matrixWorld);
  }

  /**
   * One frame. With dt = 0 (frozen captures) the secondary motion is first run up to `f.time`
   * from a few seconds before, with her moving the way `f` says, so a frame is a pure function of t.
   */
  update(dt: number, f: FootState): void {
    if (dt === 0 && f.time !== this.settledAt && !Number.isNaN(f.time)) this.settle(f);
    else this.step(dt, f);
    this.lastTime = f.time;
  }

  /** Re-run the last 3 s (60 Hz) leading up to f.time, then draw f.time itself. */
  private settle(f: FootState): void {
    const T = this.settleT, h = 1 / 60;
    this.onSettle?.();
    const w = this.walker;
    const p0 = w.position.clone(), q0 = w.quaternion.clone();
    const yaw = new THREE.Euler().setFromQuaternion(q0, "YXZ").y;
    const fwd = V(-Math.sin(yaw), 0, -Math.cos(yaw));
    const moving = !f.boating && f.speed > 0.05;
    const g = { ...f };
    this.feetInit = false;
    this.simInit = false;
    for (let k = Math.round(T / h); k >= 0; k--) {
      const back = k * h;
      g.time = f.time - back;
      if (moving) {
        g.phase = f.phase - ((f.speed * back) / gaitCycle(f.run, f.speed)) * Math.PI * 2;
        w.position.copy(p0).addScaledVector(fwd, -f.speed * back);
        if (this.ground) {
          const gr = this.ground(w.position.x, w.position.z, p0.y);
          if (gr) w.position.y = gr.h;
        }
      }
      w.updateMatrixWorld(true);
      this.step(k === Math.round(T / h) ? 0 : h, g);
    }
    w.position.copy(p0);
    w.quaternion.copy(q0);
    this.settledAt = f.time;
  }

  private step(dt: number, f: FootState): void {
    const w = this.walker;
    w.updateMatrixWorld(true);
    const seat = clamp(f.seat ?? 0, 0, 1);
    this.standK = 1 - seat;
    const P = this.poseA;
    const scripted = !!f.boating;
    this.bodyPose(f, P);
    if (!scripted) this.plantFeet(dt, f, P);
    else {
      this.feetInit = false;
      this.analyticFeet(f, P);
    }
    this.solveHeight(P);
    if (seat > 0) {
      this.seatPose(f, this.poseS);
      blendPose(P, this.poseS, smooth(0, 1, seat));
    }
    this.applyPose(P);
    // Velocity of her root (smoothed) for the apparent wind on hair and cloth.
    _v.setFromMatrixPosition(w.matrixWorld);
    if (dt > 0 && this.lastPos.lengthSq() > 0 && _v.distanceTo(this.lastPos) < 3) {
      _v2.subVectors(_v, this.lastPos).divideScalar(dt);
      this.vel.lerp(_v2, 1 - Math.exp(-dt * 6));
    } else if (dt > 0) this.vel.set(0, 0, 0);
    this.lastPos.copy(_v);
    this.secondary(dt, f, seat);
    this.faceAnim(f);
  }

  // ---------------------------------------------------------------- poses

  /** Torso, head and arms standing or walking (feet are filled by plantFeet / analyticFeet). */
  private bodyPose(f: FootState, P: Pose): void {
    const t = f.time, ph = f.phase, run = f.run;
    const mv = clamp(f.speed / 1.1, 0, 1);
    const idle = 1 - smooth(0.0, 0.35, f.speed);
    // Contrapposto: weight on one leg, shifting every so often (+1 = on her right leg).
    const sup = Math.tanh(3 * Math.sin((t * 2 * Math.PI) / 17 + 0.7));
    const breath = Math.sin(t * 1.55);
    const turnLean = clamp(f.turn * f.speed * 0.03, -0.1, 0.1);
    const pelvisRoll = (0.042 * Math.sin(ph - 0.15)) * mv + 0.05 * sup * idle - turnLean;
    P.pelvisP.set(0.017 * mv * Math.sin(ph) + 0.022 * sup * idle, 0, -0.01 * idle);
    qEuler(-0.025 - 0.03 * mv - 0.08 * run, 0.075 * mv * Math.cos(ph) - 0.05 * sup * idle, pelvisRoll, P.pelvisQ);
    qEuler(0.03 + 0.025 * idle, -0.06 * mv * Math.cos(ph), -pelvisRoll * 0.45, P.spineQ);
    qEuler(0.035 + 0.008 * breath * idle - 0.04 * run, -0.06 * mv * Math.cos(ph), -pelvisRoll * 0.35 + 0.012 * Math.sin(t * 0.37) * idle, P.chestQ);
    // Head steadied against the body's sway, plus the explorer's glances (or a gaze target).
    const look = this.lookYaw, lookUp = this.lookPitch;
    qEuler(-0.04 + lookUp * 0.35, 0.05 * mv * Math.cos(ph) + look * 0.4, pelvisRoll * 0.25, P.neckQ);
    qEuler(0.03 + lookUp * 0.65 + 0.01 * Math.sin(t * 0.23) * idle, 0.06 * mv * Math.cos(ph) + look * 0.6, pelvisRoll * 0.2 + 0.035 * Math.sin(t * 0.29 + 1) * idle - 0.02 * sup * idle, P.headQ);
    for (let i = 0; i < 2; i++) {
      const s = SIDE[i];
      P.shrug[i].set(0, 0.0025 * breath * idle, 0.004);
      P.kneePole[i].set(s * 0.1, 0.05, -1).normalize();
      // Arms swing opposite to the same-side leg; relaxed, elbows soft, a slow idle sway.
      const swing = mv * (0.13 + 0.06 * run) * Math.cos(ph + (i === 0 ? 0 : Math.PI));
      const sway = idle * 0.008 * Math.sin(t * 0.8 + i * 1.9);
      P.wrist[i].set(s * (0.088 + 0.012 * mv), -0.468 + 0.12 * run + Math.max(0, -swing) * 0.18, 0.022 + swing + sway - 0.12 * run);
      P.elbowPole[i].set(s * 0.35, -0.1, 1).normalize();
      P.handDir[i].set(s * 0.12, -1, -0.12 - 0.5 * Math.max(0, -swing)).normalize();
      P.thumbDir[i].set(-s * 0.15, 0, -1).normalize();
      P.curl[i] = 0.42 + 0.1 * run + 0.05 * Math.sin(t * 0.6 + i);
      P.thumb[i] = 0.25;
      P.wristRel[i] = 1;
    }
  }

  /** In the boat: seated on the stern bench, left hand on the tiller, right on her knee or the hat. */
  private seatPose(f: FootState, P: Pose): void {
    const t = f.time, wind = clamp((f.wind ?? 0) / 8, 0, 1.3);
    const lean = clamp(-f.turn * 0.18, -0.12, 0.12) - (f.roll ?? 0) * 0.55;
    P.pelvisP.set(0, 0.37, 0.03);
    qEuler(0.16, 0.06, lean * 0.4, P.pelvisQ);
    qEuler(-0.1 - 0.03 * wind, 0.03, lean * 0.35, P.spineQ);
    qEuler(-0.07 + 0.006 * Math.sin(t * 1.5), 0.04, lean * 0.25, P.chestQ);
    const look = this.lookYaw - 0.12, lookUp = this.lookPitch;
    qEuler(0.0 + lookUp * 0.35, look * 0.4, -lean * 0.3, P.neckQ);
    qEuler(0.04 + lookUp * 0.65 - 0.02 * wind, look * 0.6 + 0.05 * Math.sin(t * 0.21), -lean * 0.3, P.headQ);
    for (let i = 0; i < 2; i++) {
      const s = SIDE[i];
      P.shrug[i].set(0, 0, 0);
      P.ankle[i].set(s * 0.125, ANKLE_H, -0.37 + (i === 0 ? -0.03 : 0.02));
      qEuler(0, -s * 0.12, 0, P.footQ[i]);
      P.toe[i] = 0;
      P.kneePole[i].set(s * 0.3, 0.75, -0.6).normalize();
    }
    // Left hand on the tiller grip, knuckles up; right hand on the right knee (or the hat brim when
    // the wind tugs at it).
    if (f.grip) P.wrist[1].copy(f.grip).add(V(-0.01, 0.065, 0.01));
    else P.wrist[1].set(-0.25, 0.48, -0.12);
    P.elbowPole[1].set(-0.6, -0.55, 0.55).normalize();
    P.handDir[1].set(0.2, -0.95, -0.15).normalize();
    P.thumbDir[1].set(0.1, 0.05, -1).normalize();
    P.wristRel[0] = P.wristRel[1] = 0;
    P.curl[1] = 1.25;
    P.thumb[1] = 0.8;
    P.wrist[0].set(0.15, 0.6, -0.24);
    P.elbowPole[0].set(0.7, -0.4, 0.5).normalize();
    P.handDir[0].set(0.05, -0.75, -0.65).normalize();
    P.thumbDir[0].set(-0.6, 0.2, -0.6).normalize();
    P.curl[0] = 0.55;
    P.thumb[0] = 0.3;
  }

  /** Feet relative to her root (stepping aboard / ashore and seated): stride from the phase. */
  private analyticFeet(f: FootState, P: Pose): void {
    const mv = clamp(f.speed / 1.1, 0, 1), run = f.run, duty = gaitDuty(run), A = gaitA(run, f.speed) * mv;
    for (let i = 0; i < 2; i++) {
      const s = SIDE[i];
      const sp = frac(f.phase / (Math.PI * 2) + (i === 0 ? 0 : 0.5));
      let z: number, y: number, pitch: number;
      if (sp < duty) {
        const u = sp / duty;
        z = -A + 2 * A * u;
        y = 0;
        pitch = (0.2 * (1 - smooth(0, 0.18, u)) - 0.45 * smooth(0.7, 1, u)) * mv;
      } else {
        const u = (sp - duty) / (1 - duty), e = u * u * (3 - 2 * u);
        z = A - 2 * A * e;
        y = (0.07 + 0.08 * run) * mv * Math.sin(Math.PI * u);
        pitch = (-0.45 + 0.65 * e) * mv;
      }
      z += (i === 0 ? -0.035 : 0.03) * (1 - mv);
      _v.set(s * 0.098, ANKLE_H + y, z);
      this.ankleAt(_v, -s * 0.12 * (1 - mv) - s * 0.06 * mv, pitch, P.ankle[i], P.footQ[i]);
      P.toe[i] = pitch < 0 && sp < duty ? -pitch : 0;
    }
  }

  /**
   * Ankle position and foot rotation (walker space) for a flat-foot ankle point, a yaw, and a pitch
   * that rolls about the heel (toes up, > 0) or the ball (heel up, < 0).
   */
  private ankleAt(flat: THREE.Vector3, yaw: number, pitch: number, outA: THREE.Vector3, outQ: THREE.Quaternion): void {
    const pivot = pitch > 0 ? HEEL : BALL;
    _q.setFromAxisAngle(_Y, yaw);
    _q2.setFromAxisAngle(_X, pitch);
    outQ.copy(_q).multiply(_q2);
    _v3.copy(pivot).applyQuaternion(_q);
    _v4.copy(pivot).negate().applyQuaternion(outQ);
    outA.copy(flat).add(_v3).add(_v4);
  }

  /** World-locked feet on foot (see the class comment). */
  private plantFeet(dt: number, f: FootState, P: Pose): void {
    const w = this.walker;
    const M = w.matrixWorld;
    _mi.copy(M).invert();
    const wyaw = new THREE.Euler().setFromQuaternion(w.quaternion, "YXZ").y;
    const run = f.run, duty = gaitDuty(run);
    const mv = clamp(f.speed / 1.1, 0, 1);
    const walking = f.speed > 0.22;
    const A = gaitA(run, f.speed);
    const cycleT = gaitCycle(run, f.speed) / Math.max(f.speed, 0.3);
    const groundAt = (p: THREE.Vector3, ft: Foot) => {
      const g = this.ground?.(p.x, p.z, p.y);
      if (g) ft.kind = g.kind;
      return g ? g.h : w.position.y;
    };
    // Idle stance targets (walker space): right foot a touch ahead, toes out.
    const idleT = (i: number, out: THREE.Vector3) => out.set(SIDE[i] * 0.1, ANKLE_H, i === 0 ? -0.04 : 0.03);
    const idleYaw = (i: number) => -SIDE[i] * (i === 0 ? 0.17 : 0.12);
    if (!this.feetInit) {
      // Start planted where an idle stance (or the stride, if moving) puts them.
      for (let i = 0; i < 2; i++) {
        const ft = this.feet[i];
        idleT(i, _v);
        if (walking) {
          const sp = frac(f.phase / (Math.PI * 2) + (i === 0 ? 0 : 0.5));
          _v.z = sp < duty ? -A + (2 * A * sp) / duty : A;
        }
        _v.applyMatrix4(M);
        _v.y = groundAt(_v, ft) + ANKLE_H;
        ft.pw.copy(_v);
        ft.yaw = wyaw + idleYaw(i);
        ft.planted = true;
        ft.prevS = frac(f.phase / (Math.PI * 2) + (i === 0 ? 0 : 0.5));
      }
      this.feetInit = true;
    }
    for (let i = 0; i < 2; i++) {
      const ft = this.feet[i], s = SIDE[i], other = this.feet[1 - i];
      const sp = frac(f.phase / (Math.PI * 2) + (i === 0 ? 0 : 0.5));
      // Nominal landing for a stride (walker space), including how far she travels until then.
      const landing = (out: THREE.Vector3) => {
        if (!walking) return idleT(i, out);
        return out.set(s * (0.096 - 0.012 * run), ANKLE_H, -A - f.speed * (1 - ft.u) * ft.dur);
      };
      const landYaw = () => wyaw + (walking ? -s * 0.07 : idleYaw(i));
      if (ft.planted) {
        if (walking && sp >= duty && ft.prevS < duty && sp - ft.prevS < 0.5) {
          this.lift(ft, P, i, cycleT * (1 - duty), 0.07 + 0.08 * run, M, sp, duty, mv);
        } else if (!walking && other.planted) {
          // Turned or drifted on the spot: re-step toward the stance.
          idleT(i, _v).applyMatrix4(M);
          const dx = ft.pw.x - _v.x, dz = ft.pw.z - _v.z;
          const err = Math.hypot(dx, dz), yerr = Math.abs(wrapA(ft.yaw - (wyaw + idleYaw(i))));
          const otherErr = (() => {
            idleT(1 - i, _v2).applyMatrix4(M);
            return Math.hypot(other.pw.x - _v2.x, other.pw.z - _v2.z) + 0.15 * Math.abs(wrapA(other.yaw - (wyaw + idleYaw(1 - i))));
          })();
          if ((err > 0.085 || yerr > 0.42) && err + 0.15 * yerr >= otherErr - 1e-4) this.lift(ft, P, i, 0.36, 0.045, M, 1, 1, 0);
        }
      } else {
        ft.u = Math.min(1, ft.u + (dt > 0 ? dt / ft.dur : 0));
        if (ft.u >= 1 || (walking && sp < ft.prevS - 0.5)) {
          // Land: plant at the target, on the ground there.
          landing(_v).applyMatrix4(M);
          _v.y = groundAt(_v, ft) + ANKLE_H;
          ft.pw.copy(_v);
          ft.yaw = landYaw();
          ft.planted = true;
          ft.u = 1;
          this.onPlant?.(ft.pw.x, ft.pw.y - ANKLE_H, ft.pw.z, ft.yaw, s, ft.kind, f.time);
        }
      }
      ft.prevS = sp;
      // Pose this foot.
      if (ft.planted) {
        _v.copy(ft.pw).applyMatrix4(_mi);
        let pitch = 0;
        if (walking && sp < duty) {
          const u = sp / duty;
          pitch = (0.2 * (1 - smooth(0, 0.16, u)) - 0.45 * smooth(0.68, 1, u)) * mv;
        }
        this.ankleAt(_v, wrapA(ft.yaw - wyaw), pitch, P.ankle[i], P.footQ[i]);
        P.toe[i] = pitch < 0 ? -pitch : 0;
      } else {
        const u = ft.u, e = u * u * (3 - 2 * u);
        landing(_v);
        _v.applyMatrix4(M);
        _v.y = groundAt(_v, ft) + ANKLE_H;
        _v.applyMatrix4(_mi);
        const landPitch = walking ? 0.2 * mv : 0;
        const yawL = wrapA(ft.fromYaw + wrapA(landYaw() - ft.fromYaw) * e - wyaw);
        const pitch = ft.fromPitch + (landPitch - ft.fromPitch) * smooth(0.0, 0.85, u);
        this.ankleAt(_v, yawL, landPitch, _v2, _q3);
        _v3.copy(ft.from).applyMatrix4(_mi);
        P.ankle[i].lerpVectors(_v3, _v2, e);
        P.ankle[i].y += ft.lift * Math.sin(Math.PI * u) * (0.6 + 0.4 * (1 - u));
        _q.setFromAxisAngle(_Y, yawL);
        _q2.setFromAxisAngle(_X, pitch);
        P.footQ[i].copy(_q).multiply(_q2);
        P.toe[i] = Math.max(0, -pitch) * (1 - smooth(0, 0.4, u)) * 0.6;
      }
    }
  }

  /** Lift a planted foot into a swing. */
  private lift(ft: Foot, P: Pose, i: number, dur: number, lift: number, M: THREE.Matrix4, sp: number, duty: number, mv: number): void {
    void sp;
    void duty;
    // Start where it is now (heel already up from the roll-off).
    _v.copy(ft.pw).applyMatrix4(_mi);
    const wyaw = new THREE.Euler().setFromQuaternion(this.walker.quaternion, "YXZ").y;
    const pitch = -0.45 * mv;
    this.ankleAt(_v, wrapA(ft.yaw - wyaw), pitch, _v2, _q3);
    ft.from.copy(_v2).applyMatrix4(M);
    ft.fromYaw = ft.yaw;
    ft.fromPitch = pitch;
    ft.u = 0;
    ft.dur = Math.max(0.18, dur);
    ft.lift = lift;
    ft.planted = false;
    void P;
    void i;
  }

  /** Hip height from the feet: as high as the legs allow (the stance leg nearly straight). */
  private solveHeight(P: Pose): void {
    let hy = 1e9;
    for (let i = 0; i < 2; i++) {
      _v.subVectors(J.hip(SIDE[i]), J.hipC).applyQuaternion(P.pelvisQ);
      const dx = P.ankle[i].x - (P.pelvisP.x + _v.x), dz = P.ankle[i].z - (P.pelvisP.z + _v.z);
      const reach = Math.sqrt(Math.max(0, REACH * REACH - dx * dx - dz * dz));
      hy = Math.min(hy, P.ankle[i].y + reach - _v.y);
    }
    P.pelvisP.y = Math.min(hy, J.hipC.y + 0.01) - 0.004;
  }

  // ---------------------------------------------------------------- bones

  private applyPose(P: Pose): void {
    const R = this.rig, B = this.B;
    // Torso chain, each joint carried by the one below.
    const Dh = P.pelvisQ;
    R.setDelta(B.hips, P.pelvisP, Dh);
    const Ds = _qa.multiplyQuaternions(Dh, P.spineQ);
    const Hs = _va.subVectors(J.waist, J.hipC).applyQuaternion(Dh).add(P.pelvisP);
    R.setDelta(B.spine, Hs, Ds);
    const Dc = _qb.multiplyQuaternions(Ds, P.chestQ);
    const Hc = _vb.subVectors(J.chest, J.waist).applyQuaternion(Ds).add(Hs);
    R.setDelta(B.chest, Hc, Dc);
    const Dn = _qc.multiplyQuaternions(Dc, P.neckQ);
    const Hn = _vc.subVectors(J.neck, J.chest).applyQuaternion(Dc).add(Hc);
    R.setDelta(B.neck, Hn, Dn);
    // Gaze target: turn the head toward it (within limits) before posing it.
    const Dhd = _qd.multiplyQuaternions(Dn, P.headQ);
    const Hh = _vd.subVectors(J.head, J.neck).applyQuaternion(Dn).add(Hn);
    R.setDelta(B.head, Hh, Dhd);
    // Legs.
    for (let i = 0; i < 2; i++) {
      const s = SIDE[i];
      const hip = _v.subVectors(J.hip(s), J.hipC).applyQuaternion(Dh).add(P.pelvisP);
      const knee = ik(hip, P.ankle[i], THIGH, SHIN, P.kneePole[i], _v2);
      R.setFrame(B.thigh[i], hip, _v3.subVectors(knee, hip), P.kneePole[i]);
      R.setFrame(B.shin[i], knee, _v3.subVectors(P.ankle[i], knee), P.kneePole[i]);
      R.setDelta(B.foot[i], P.ankle[i], P.footQ[i]);
      const ball = _v4.subVectors(J.ball(s), J.ankle(s)).applyQuaternion(P.footQ[i]).add(P.ankle[i]);
      _q.setFromAxisAngle(_X, P.toe[i]);
      R.setDelta(B.toe[i], ball, _q2.multiplyQuaternions(P.footQ[i], _q));
      (this.kneeW[i] ??= new THREE.Vector3()).copy(knee);
    }
    // Arms: the wrist toward its target (never past full reach), the elbow by IK, the hand and
    // fingers rigid from the wrist.
    for (let i = 0; i < 2; i++) {
      const s = SIDE[i];
      const sh = _vs.subVectors(J.shoulder(s), J.chest).applyQuaternion(Dc).add(Hc).add(P.shrug[i]);
      const wr = _vw.copy(P.wrist[i]).addScaledVector(sh, P.wristRel[i]);
      _v3.subVectors(wr, sh);
      const L = _v3.length(), Lmax = UPPER + FORE - 1e-3;
      if (L > Lmax) wr.copy(sh).addScaledVector(_v3, Lmax / L);
      // Hands stay clear of her hips and the shorts.
      if (this.standK > 0.3) {
        _v4.copy(wr).sub(P.pelvisP);
        const lat = _v4.x * s;
        const need = 0.215 * smooth(P.pelvisP.y - 0.25, P.pelvisP.y - 0.05, wr.y) * smooth(P.pelvisP.y + 0.28, P.pelvisP.y + 0.12, wr.y);
        if (lat < need) wr.x += s * (need - lat);
      }
      const elbow = ik(sh, wr, UPPER, FORE, P.elbowPole[i], _v2);
      R.setFrame(B.upper[i], sh, _v3.subVectors(elbow, sh), _v4.copy(P.elbowPole[i]).negate());
      const foreFront = _v4.copy(P.elbowPole[i]).negate().lerp(P.thumbDir[i], 0.5);
      R.setFrame(B.fore[i], elbow, _v3.subVectors(wr, elbow), foreFront);
      R.setFrame(B.hand[i], wr, P.handDir[i], P.thumbDir[i]);
      const Dhand = R.delta(B.hand[i], _qe);
      const kn = R.carry(B.hand[i], J.knuckle(s), _v3);
      _q.setFromAxisAngle(_Z, -s * P.curl[i] * 0.85);
      _q2.multiplyQuaternions(Dhand, _q);
      R.setDelta(B.fing1[i], kn, _q2);
      const mid = _vm.subVectors(J.fingerMid(s), J.knuckle(s)).applyQuaternion(_q2).add(kn);
      _q.setFromAxisAngle(_Z, -s * P.curl[i] * 0.75);
      R.setDelta(B.fing2[i], mid, _q2.multiply(_q));
      const th = R.carry(B.hand[i], J.thumb0(s), _vm);
      _q.setFromAxisAngle(_X, -P.thumb[i] * 0.6);
      _q2.setFromAxisAngle(_Z, -s * P.thumb[i] * 0.5);
      R.setDelta(B.thumb[i], th, _q3.multiplyQuaternions(Dhand, _q).multiply(_q2));
    }
  }
  private kneeW: THREE.Vector3[] = [];

  // ---------------------------------------------------------------- secondary motion

  private spheres: { b: number; c: THREE.Vector3; r: number }[] = [];
  private sphereW: { p: THREE.Vector3; r: number }[] = [];

  private secondary(dt: number, f: FootState, seat: number): void {
    const R = this.rig, B = this.B, M = this.walker.matrixWorld;
    if (!this.spheres.length) {
      this.spheres = [
        { b: B.head, c: HEAD_C.clone().add(V(0, -0.005, 0.004)), r: 0.098 },
        { b: B.neck, c: V(0, 1.47, 0.012), r: 0.05 },
        { b: B.chest, c: V(0, 1.31, 0.04), r: 0.1 },
        { b: B.chest, c: V(0, 1.27, -0.03), r: 0.105 },
        { b: B.upper[0], c: J.shoulder(1).add(V(0, 0.015, 0)), r: 0.074 },
        { b: B.upper[1], c: J.shoulder(-1).add(V(0, 0.015, 0)), r: 0.074 },
        { b: B.chest, c: V(0.105, 1.39, 0.0), r: 0.052 },
        { b: B.chest, c: V(-0.105, 1.39, 0.0), r: 0.052 },
        { b: B.hips, c: V(0, 0.97, -0.02), r: 0.15 },
        { b: B.thigh[0], c: J.hip(1).lerp(J.knee(1), 0.3), r: 0.085 },
        { b: B.thigh[1], c: J.hip(-1).lerp(J.knee(-1), 0.3), r: 0.085 },
      ];
      this.sphereW = this.spheres.map((s) => ({ p: new THREE.Vector3(), r: s.r }));
    }
    for (let k = 0; k < this.spheres.length; k++) R.carry(this.spheres[k].b, this.spheres[k].c, this.sphereW[k].p).applyMatrix4(M);
    const SW = this.sphereW;
    const collideUpper = (p: THREE.Vector3, r: number) => {
      for (let k = 0; k < 8; k++) {
        const s = SW[k];
        _cv.subVectors(p, s.p);
        const d = _cv.length(), rr = s.r + r;
        if (d < rr && d > 1e-6) p.addScaledVector(_cv, (rr - d) / d);
      }
    };
    const collideLower = (p: THREE.Vector3, r: number) => {
      for (let k = 8; k < SW.length; k++) {
        const s = SW[k];
        _cv.subVectors(p, s.p);
        const d = _cv.length(), rr = s.r + r;
        if (d < rr && d > 1e-6) p.addScaledVector(_cv, (rr - d) / d);
      }
    };
    // Apparent wind: the sea breeze (gusting) minus her own motion through the air.
    const t = f.time;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1.1);
    const wd = G.uWindDir.value;
    const yaw = new THREE.Euler().setFromQuaternion(this.walker.quaternion, "YXZ").y;
    this.wind.set(wd.x, 0, wd.y).multiplyScalar(1.0 + 1.6 * gust);
    if (seat > 0.5) this.wind.addScaledVector(V(-Math.sin(yaw), 0, -Math.cos(yaw)), -(f.wind ?? 0));
    else this.wind.addScaledVector(this.vel, -1);
    const ws = this.wind.length();
    G.uRiderWind.value.set(ws > 1e-3 ? this.wind.x / ws : 0, ws > 1e-3 ? this.wind.z / ws : 0, ws, gust);
    // Rest shapes this frame (world space).
    const H = this.hair, C = this.cloth;
    const rest = (ch: Chain, b: number, bind: THREE.Vector3[]) => {
      for (let j = 0; j < bind.length; j++) R.carry(b, bind[j], ch.rest[j]).applyMatrix4(M);
    };
    H.chains.forEach((ch, c) => rest(ch, B.head, H.bind[c]));
    rest(H.fringe, B.head, H.fringeBind);
    C.tails.forEach((ch, c) => rest(ch, B.hips, C.tailBind[c]));
    C.ribbons.forEach((ch, c) => rest(ch, B.head, C.ribbonBind[c]));
    const all = [...H.chains, H.fringe, ...C.tails, ...C.ribbons];
    const jump = this.simInit && SW[0].p.distanceTo(this.lastHead) > 1.5;
    if (!this.simInit || jump) {
      for (const ch of all) ch.reset();
      this.simInit = true;
      this.simAcc = 0;
    }
    this.lastHead.copy(SW[0].p);
    if (dt > 0) {
      this.simAcc = Math.min(this.simAcc + dt, 0.1);
      const h = 1 / 120;
      // Drag the gusting breeze through as a force on every chain.
      while (this.simAcc >= h) {
        this.simAcc -= h;
        for (const ch of H.chains) ch.step(h, this.wind, collideUpper, 0.012);
        H.fringe.step(h, this.wind, collideUpper, 0.004);
        for (const ch of C.tails) ch.step(h, this.wind, collideLower, 0.01);
        for (const ch of C.ribbons) ch.step(h, this.wind, collideUpper, 0.006);
      }
    }
    // Bones from the particles (walker space).
    _mi.copy(M).invert();
    const Dhd = R.delta(B.head, _qe);
    const place = (ch: Chain, bones: number[], frontFrom: number) => {
      for (let j = 0; j < bones.length; j++) {
        const a = _va.copy(ch.p[j]).applyMatrix4(_mi), b = _vb.copy(ch.p[j + 1]).applyMatrix4(_mi);
        const front = _vc.set(0, 0, 1).applyQuaternion(R.q0[bones[j]]).applyQuaternion(frontFrom === B.head ? Dhd : R.delta(frontFrom, _qf));
        R.setFrame(bones[j], a, _vd.subVectors(b, a), front);
      }
    };
    H.chains.forEach((ch, c) => place(ch, H.bones[c], B.head));
    place(H.fringe, H.fringeBones, B.head);
    C.tails.forEach((ch, c) => place(ch, C.tailBones[c], B.hips));
    C.ribbons.forEach((ch, c) => place(ch, C.ribbonBones[c], B.head));
  }
  private lastHead = new THREE.Vector3();

  // ---------------------------------------------------------------- face

  private faceAnim(f: FootState): void {
    const t = f.time;
    // Blinks on a fixed, irregular schedule (pure function of time): ~every 3-5 s, 0.16 s long.
    const n = Math.floor(t / 4.1);
    let lid = 0;
    for (const k of [n - 1, n]) {
      const t0 = k * 4.1 + 2.6 * hash(k);
      const u = (t - t0) / 0.16;
      if (u > 0 && u < 1) lid = Math.max(lid, Math.sin(Math.PI * u) ** 0.7);
    }
    FACE.uBlink.value = lid;
    // Head and eyes: follow the explorer's glances, or a gaze target (eyes lead, head follows).
    let yaw = f.look, pitch = f.lookUp;
    let eyeX = 0, eyeY = 0;
    if (this.gazeTarget) {
      const head = this.headWorld(_va);
      _vb.subVectors(this.gazeTarget, head).applyQuaternion(_qf.copy(this.walker.quaternion).invert());
      const ty = Math.atan2(-_vb.x, -_vb.z), tp = Math.atan2(_vb.y, Math.hypot(_vb.x, _vb.z));
      yaw = clamp(ty, -0.9, 0.9) * 0.55;
      pitch = clamp(tp, -0.5, 0.5) * 0.5;
      eyeX = clamp(ty - yaw, -0.5, 0.5);
      eyeY = clamp(tp - pitch, -0.4, 0.4);
    } else {
      eyeX = (f.look - this.lookYaw) * 1.5;
      eyeY = (f.lookUp - this.lookPitch) * 1.2;
    }
    this.lookYaw = yaw;
    this.lookPitch = pitch;
    // Eyes: a little saccade drift; positive x moves the iris toward her right (screen left).
    const sac = 0.0004 * Math.sin(t * 0.7) * Math.sin(t * 1.9 + 1);
    FACE.uGaze.value.set(clamp(-eyeX * 0.006 + sac, -0.004, 0.004), clamp(eyeY * 0.004, -0.002, 0.0025));
    FACE.uSmile.value = 0.3 + 0.1 * Math.sin(t * 0.17);
  }
}

const _Y = new THREE.Vector3(0, 1, 0), _X = new THREE.Vector3(1, 0, 0), _Z = new THREE.Vector3(0, 0, 1);
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _qd = new THREE.Quaternion(), _qe = new THREE.Quaternion(), _qf = new THREE.Quaternion();
const _vs = new THREE.Vector3(), _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vc = new THREE.Vector3(), _vd = new THREE.Vector3(), _vw = new THREE.Vector3(), _vm = new THREE.Vector3();
const _cv = new THREE.Vector3();
void _m;

function blobShadow(w: number, d: number): THREE.Mesh {
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2),
    new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      transparent: true,
      depthWrite: false,
      uniforms: {},
      vertexShader: `out vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `in vec2 vUv; layout(location=0) out vec4 gColor; layout(location=1) out vec4 gNormal;
        void main(){ vec2 d = (vUv - 0.5) * 2.0; float a = 1.0 - smoothstep(0.3, 1.0, length(d));
          gColor = vec4(0.035, 0.035, 0.05, a * 0.32); gNormal = vec4(0.5, 1.0, 1.0/32.0, 0.0) * a; }`,
    }),
  );
  shadow.position.y = 0.03;
  shadow.renderOrder = 1;
  // A flat card just over the ground: in her shadow map it would cast a square.
  shadow.userData.noCast = true;
  return shadow;
}
