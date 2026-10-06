import * as THREE from "three";
import { G, shadowDepthMaterial } from "../render/materials";
import { LAYER_CHAR_HAT } from "../render/lightpasses";
import { loadHeroine, mergeHeroine, type ClipMeta, type Heroine } from "./heroine";
import { FACE_U } from "./heroineFace";

/**
 * The player character: the heroine built in Blender (tools/character → public/models/heroine.glb),
 * one skeleton under nine skinned meshes in the game's toon materials. Local frame: forward = -Z,
 * up = +Y, right = +X, feet on y = 0 (the GLB faces +Z and sits under the walker turned by π).
 *
 * An AnimationMixer plays her clips (idle, walk, run, jump, sit_tiller), blended by speed and
 * state, with the walk and run clocks taken from the explorer's gait phase: one stride of the clip
 * per stride on the ground, so the clip's feet already keep pace with the ground. On top of the
 * clips, per frame:
 * - foot locks: while a foot is in contact (the clips' contact windows) any motion of its contact
 *   point in the world (turning, blending, a speed change) is cancelled, so a planted foot stays
 *   put; the lift-off error eases out over the swing. Standing, a foot re-steps once it has been
 *   twisted or dragged too far. Each foot follows the real ground under it (steps, the pier deck,
 *   the beach), the pelvis drops when a foot would not reach;
 * - seated: her right hand is IK'd to the tiller, and she leans with turns, roll and heave;
 * - hair locks, the hat ribbon and the shirt knot tails are damped springs driven by the apparent
 *   wind and the head's motion; cloth edges flutter in the same wind on the GPU (aWind);
 * - head look, blinks and gaze on the painted face.
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
  /** Tiller grip for the right hand, in walker space. */
  grip?: THREE.Vector3;
  /** Apparent wind (m/s) on the water (the boat's speed through it). */
  wind?: number;
  /** The explorer moves her by script (stepping aboard, in the boat, stepping ashore). */
  boating?: boolean;
  /** Boat roll (rad), for leaning against the heel. */
  roll?: number;
  /** Jump: 1 while airborne (feet off the ground). */
  air?: number;
  /** Knees bend and the hips drop (crouch / landing squash), 0…1; the jump clip carries it now. */
  crouch?: number;
  /** Vertical speed (m/s) while airborne. */
  vy?: number;
  /** Jump clip clock (s, see jumpClock) and its blend weight; absent or weight 0 = no jump. */
  jumpT?: number;
  jumpW?: number;
}

/** Ground under a world point: height and surface. */
export type GroundFn = (x: number, z: number, y: number) => { h: number; kind: string } | null;
/** A foot landing in the world (for footprints and ripples). */
export type PlantFn = (x: number, y: number, z: number, yaw: number, side: number, kind: string, time: number) => void;

/** Walk and run clips (tools/character/heroine/anim.py): speed (m/s) and loop (s); stride = v·T. */
const WALK = { v: 1.3, T: 1.1 };
const RUN = { v: 3.4, T: 20 / 30 };
const STRIDE_WALK = WALK.v * WALK.T, STRIDE_RUN = RUN.v * RUN.T;
/**
 * Ground covered per stride (one gait cycle) at this speed: the clip's own stride, blended walk →
 * run; slower than the walk clip the cadence holds and the steps shorten (the idle blends in).
 */
export const gaitCycle = (run: number, speed = WALK.v) => {
  const walk = STRIDE_WALK * Math.min(1, Math.max(speed, 0.05) / WALK.v);
  return walk + (STRIDE_RUN - walk) * clamp(run, 0, 1);
};

/** Jump clip timing (s): crouch, take-off, touch-down, end. */
export const JUMP_CLIP = { crouch: 0.27, takeOff: 0.4, touchDown: 0.85, end: 1.2 };
/**
 * The jump clip clock from the jump's state: `crouchT` into the anticipation crouch, `airT` aloft
 * (`fly` = flight time on the flat), `landT` since touch-down. Returns [clip time, weight].
 */
export function jumpClock(crouchT: number, airT: number, air: boolean, landT: number, fly: number): [number, number] {
  const J = JUMP_CLIP;
  if (crouchT >= 0) return [J.crouch + crouchT, smooth(0, 0.06, crouchT)];
  if (air) return [J.takeOff + (J.touchDown - J.takeOff) * Math.min(airT / fly, 0.96), 1];
  const t = J.touchDown + landT;
  if (t >= J.end) return [J.end, 0];
  return [t, 1 - smooth(0.17, J.end - J.touchDown, landT)];
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const frac = (x: number) => x - Math.floor(x);
const smooth = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
};
const hash = (n: number) => frac(Math.sin(n * 127.1 + 311.7) * 43758.5453);
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (a: number, b: number, k: number, dt: number) => b + (a - b) * Math.exp(-k * dt);

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _pq = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);

/** Rotate a bone by a world-space rotation about its own head (children follow). */
function rotateWorld(b: THREE.Object3D, q: THREE.Quaternion): void {
  b.parent!.getWorldQuaternion(_pq);
  _q2.copy(_pq).invert().multiply(q).multiply(_pq);
  b.quaternion.premultiply(_q2);
  b.updateMatrixWorld(true);
}
/** Set a bone's world rotation (its parent's stays). */
function setWorldQuat(b: THREE.Object3D, q: THREE.Quaternion): void {
  b.parent!.getWorldQuaternion(_pq);
  b.quaternion.copy(_pq.invert().multiply(q));
  b.updateMatrixWorld(true);
}
const wpos = (b: THREE.Object3D, out: THREE.Vector3) => out.setFromMatrixPosition(b.matrixWorld);

/**
 * Two-bone IK: rotate `a` and `b` so `c` (a descendant of `b`) reaches `t`, keeping the bend
 * plane of the current pose (`hint`: bend axis when the limb is straight).
 */
function twoBone(a: THREE.Object3D, b: THREE.Object3D, c: THREE.Object3D, t: THREE.Vector3, hint: THREE.Vector3): void {
  const pa = wpos(a, _a), pb = wpos(b, _b), pc = wpos(c, _c);
  const lab = pa.distanceTo(pb), lcb = pb.distanceTo(pc);
  const lat = clamp(t.distanceTo(pa), 1e-4, (lab + lcb) * 0.9999);
  const ac = _v.subVectors(pc, pa).normalize(), ab = _v2.subVectors(pb, pa).normalize();
  const ba = _v3.copy(ab).negate(), bc = _v4.subVectors(pc, pb).normalize();
  const acab0 = Math.acos(clamp(ac.dot(ab), -1, 1));
  const babc0 = Math.acos(clamp(ba.dot(bc), -1, 1));
  const acab1 = Math.acos(clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const babc1 = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));
  const axis0 = new THREE.Vector3().crossVectors(ac, ab).addScaledVector(hint, 0.02).normalize();
  const at = new THREE.Vector3().subVectors(t, pa).normalize();
  const acat0 = Math.acos(clamp(ac.dot(at), -1, 1));
  const axis1 = new THREE.Vector3().crossVectors(ac, at);
  rotateWorld(b, _q.setFromAxisAngle(axis0, babc1 - babc0));
  rotateWorld(a, _q.setFromAxisAngle(axis0, acab1 - acab0));
  if (axis1.lengthSq() > 1e-12) rotateWorld(a, _q.setFromAxisAngle(axis1.normalize(), acat0));
}

/** Contact windows of one clip, per foot (0 = right, 1 = left), as [start, length] in cycle units. */
type Windows = [number, number][][];
function windows(m: ClipMeta | undefined, fallback: Windows): Windows {
  if (!m?.contacts) return fallback;
  const d = m.duration;
  return (["R", "L"] as const).map((k) =>
    (m.contacts![k] ?? []).map(([s, e]) => [s / d, frac((e - s) / d) || (e > s ? 1 : 0)] as [number, number]),
  );
}
const inWindow = (w: [number, number][], u: number): [boolean, number] => {
  for (const [s, len] of w) {
    const k = frac(u - s);
    if (k < len) return [true, k / len];
  }
  return [false, 0];
};

/** One foot's lock. */
class Foot {
  planted = false;
  /** Slide cancelled so far (world xz) and twist cancelled (rad). */
  readonly s = new THREE.Vector2();
  psi = 0;
  /** At lift-off, eased to zero over the swing. */
  readonly s0 = new THREE.Vector2();
  psi0 = 0;
  /** Last frame's clip contact points (heel, ball), ankle and foot yaw, world. */
  readonly heel = new THREE.Vector3();
  readonly ball = new THREE.Vector3();
  readonly ank = new THREE.Vector3();
  yaw = 0;
  has = false;
  /** Ground offset under the foot (m, relative to the walker), lift while re-stepping. */
  gOff = 0;
  /** Lift that puts a planted sole on the ground (m). */
  cY = 0;
  restep = -1;
  kind = "wood";
  swingT = 0;
}

/** A spring chain (hair lock, ribbon tail, knot tail): rotated as a whole toward the wind. */
interface Spring {
  bones: THREE.Bone[];
  share: number[];
  gain: number;
  inertia: number;
  max: number;
  hz: number;
  /** Keep the tip from swinging into her head (hair). */
  head: boolean;
  o: THREE.Vector3;
  ov: THREE.Vector3;
  /** Root last frame, and a point mass hung on the root (lags it as she moves: inertia). */
  prev: THREE.Vector3;
  lag: THREE.Vector3;
  lagV: THREE.Vector3;
}

const GRIP_OFF = new THREE.Vector3(-0.005, 0.028, 0.045);
const FPP_HIDE = ["face", "hair", "hat", "ribbon", "frame", "shirt", "cami"];

export class Rider {
  /** Her root: feet on the ground, facing -Z. The explorer sets its position and rotation. */
  readonly walker = new THREE.Group();
  /** Ground query for planting her feet (set by main; flat y = walker y if absent). */
  ground: GroundFn | null = null;
  /** Called when a foot lands on foot (footprints, ripples, the footstep sound). */
  onPlant: PlantFn | null = null;
  /** Called before a frozen frame re-runs the seconds leading up to it (clear trails). */
  onSettle: (() => void) | null = null;
  /** Seconds a frozen frame re-runs (longer leaves a longer trail of footprints). */
  settleT = 3;
  /** World point she looks at (head and eyes), or null to look where the explorer says. */
  gazeTarget: THREE.Vector3 | null = null;
  /** Hat and face stand-ins for her shadow map (offset depth, see CharShadow.hat). */
  readonly shadowProxies: THREE.SkinnedMesh[] = [];
  /** Per-foot contact this frame (tests). */
  readonly contact = [false, false];
  readonly meshes: Map<string, THREE.SkinnedMesh>;

  private h: Heroine;
  private bone: (n: string) => THREE.Bone;
  private act: Record<string, THREE.AnimationAction> = {};
  private win: Record<"walk" | "run" | "jump", Windows>;
  private legs: { thigh: THREE.Bone; shin: THREE.Bone; foot: THREE.Bone; toe: THREE.Bone; heelL: THREE.Vector3; ballL: THREE.Vector3 }[];
  private legLen = 0.8;
  private feet = [new Foot(), new Foot()];
  private springs: Spring[] = [];
  private headC = new THREE.Vector3();
  private eyeC = new THREE.Vector3();
  private standK = 1;
  private fppOn = false;
  private fppArms = false;
  private simInit = false;
  private simAcc = 0;
  private lastPos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private vy = 0;
  private ay = 0;
  private wind = new THREE.Vector3();
  private settledAt = NaN;
  private lookYaw = 0;
  private lookPitch = 0;
  private drop = 0;

  static async load(url = "./models/heroine.glb"): Promise<Rider> {
    return new Rider(await loadHeroine(url));
  }

  private constructor(h: Heroine) {
    this.h = h;
    this.meshes = mergeHeroine(h);
    h.root.rotation.y = Math.PI;
    this.walker.add(h.root);
    this.walker.name = "rider";
    this.bone = (n) => {
      const b = h.bones.get(n);
      if (!b) throw new Error(`heroine: no bone ${n}`);
      return b;
    };
    const meta = h.meta.clips ?? {};
    for (const [k, m] of [["walk", WALK], ["run", RUN]] as const) {
      const c = meta[k];
      if (c?.speed && (Math.abs(c.speed - m.v) > 1e-3 || Math.abs((h.clips.get(k)?.duration ?? 0) - m.T) > 0.01))
        console.warn(`heroine: ${k} clip timing differs from the gait constants`);
    }
    for (const name of ["idle", "walk", "run", "sit_tiller", "jump"]) {
      const clip = h.clips.get(name);
      if (!clip) throw new Error(`heroine: no clip ${name}`);
      const a = h.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      this.act[name] = a;
    }
    this.win = {
      walk: windows(meta.walk, [[[0.5, 0.62]], [[0, 0.62]]]),
      run: windows(meta.run, [[[0.5, 0.36]], [[0, 0.36]]]),
      jump: windows(meta.jump, [[[0, 0.33], [0.71, 0.29]], [[0, 0.33], [0.71, 0.29]]]),
    };

    // Rest data, from the bind pose with the walker at the origin.
    this.walker.updateMatrixWorld(true);
    this.legs = (["R", "L"] as const).map((s) => {
      const thigh = this.bone(`thigh_${s}`), shin = this.bone(`shin_${s}`), foot = this.bone(`foot_${s}`), toe = this.bone(`toe_${s}`);
      const ank = wpos(foot, new THREE.Vector3()), ball = wpos(toe, new THREE.Vector3());
      // Contact points on the sole: under the heel (behind the ankle) and under the ball.
      const heelL = foot.worldToLocal(new THREE.Vector3(ank.x, 0, ank.z + 0.045));
      const ballL = foot.worldToLocal(new THREE.Vector3(ball.x, 0, ball.z));
      return { thigh, shin, foot, toe, heelL, ballL };
    });
    const L0 = this.legs[0];
    this.legLen = wpos(L0.thigh, _a).distanceTo(wpos(L0.shin, _b)) + _b.distanceTo(wpos(L0.foot, _c));
    const head = this.bone("head");
    const hc = h.meta.face.headC as unknown as number[];
    this.headC.copy(head.worldToLocal(h.root.localToWorld(new THREE.Vector3(hc[0], hc[1], hc[2]))));
    this.eyeC.copy(head.worldToLocal(h.root.localToWorld(new THREE.Vector3(hc[0], hc[1] - 0.009, hc[2] + 0.075))));

    const chain = (names: string[], o: Partial<Spring>): void => {
      const share = names.length === 3 ? [0.42, 0.33, 0.25] : [0.55, 0.45];
      this.springs.push({
        bones: names.map(this.bone), share, gain: 0.05, inertia: 0.6, max: 0.4, hz: 1.6, head: false,
        o: new THREE.Vector3(), ov: new THREE.Vector3(), prev: new THREE.Vector3(), lag: new THREE.Vector3(), lagV: new THREE.Vector3(), ...o,
      });
    };
    for (const k of ["Fringe", "SideL", "SideR", "EarL", "EarR", "BackL", "Back", "BackR"]) {
      const front = k === "Fringe" || k.startsWith("Side");
      chain([1, 2, 3].map((i) => `hair${k}_${i}`), { gain: front ? 0.035 : 0.055, inertia: front ? 0.35 : 0.6, max: front ? 0.22 : 0.45, hz: front ? 2.2 : 1.5, head: true });
    }
    for (const s of ["L", "R"]) {
      chain([1, 2, 3].map((i) => `ribbon_${s}${i}`), { gain: 0.13, inertia: 1.0, max: 1.0, hz: 1.2 });
      chain([1, 2].map((i) => `knot_${s}${i}`), { gain: 0.03, inertia: 0.5, max: 0.25, hz: 2.4 });
    }

    // Her hat and face cast into her shadow map from offset stand-ins (main puts them on their layer).
    for (const k of ["hat", "ribbon", "face"]) {
      const m = this.meshes.get(k);
      if (!m) continue;
      m.userData.noCast = true;
      const p = new THREE.SkinnedMesh(m.geometry, HAT_SHADOW);
      p.name = `${m.name}_shadow`;
      p.frustumCulled = false;
      p.userData.shadowProxy = true;
      p.layers.set(LAYER_CHAR_HAT);
      m.parent!.add(p);
      p.bind(m.skeleton, m.bindMatrix);
      this.shadowProxies.push(p);
    }
    FACE_U.uLens.value = 1;
    this.walker.add(blobShadow(0.62, 0.62));
    this.weights(1, 0, 0, 0, 0);
    h.mixer.update(0);
    this.walker.updateMatrixWorld(true);
  }

  // ---------------------------------------------------------------- public seams

  /** Hide head, hair, hat and upper body (first-person view) or show them; arms stay if `arms`. */
  setFirstPerson(on: boolean, arms = on): void {
    arms &&= on;
    if (on === this.fppOn && arms === this.fppArms) return;
    this.fppOn = on;
    this.fppArms = arms;
    for (const k of FPP_HIDE) {
      const m = this.meshes.get(k);
      if (!m) continue;
      if (on) m.layers.disable(0);
      else m.layers.enable(0);
    }
    const limbs = this.meshes.get("skin");
    if (limbs) {
      if (on && !arms) limbs.layers.disable(0);
      else limbs.layers.enable(0);
    }
  }

  /** Kept for the camera code: she wears no skirt. */
  setSkirtHidden(on: boolean): void {
    void on;
  }

  /** World-space eye point (between the eyes, slightly forward). */
  eyeWorld(out: THREE.Vector3): THREE.Vector3 {
    this.walker.updateMatrixWorld(true);
    return this.bone("head").localToWorld(out.copy(this.eyeC));
  }

  /** World-space point at the middle of her head (orbit-camera pivot). */
  headWorld(out: THREE.Vector3): THREE.Vector3 {
    this.walker.updateMatrixWorld(true);
    return this.bone("head").localToWorld(out.copy(this.headC));
  }

  /** 0 seated in the boat … 1 standing. */
  get standing(): number {
    return this.standK;
  }

  /** Where her feet stand now (world ankle), for tests and footprints. */
  footWorld(i: number, out = new THREE.Vector3()): THREE.Vector3 {
    this.walker.updateMatrixWorld(true);
    return wpos(this.legs[i].foot, out);
  }

  /** Contact points of foot i now (world): heel and ball on the sole (tests). */
  soleWorld(i: number, heel: THREE.Vector3, ball: THREE.Vector3): void {
    const L = this.legs[i];
    L.foot.localToWorld(heel.copy(L.heelL));
    L.foot.localToWorld(ball.copy(L.ballL));
  }

  /**
   * One frame. With dt = 0 (frozen captures) the secondary motion is first run up to `f.time`
   * from a few seconds before, with her moving the way `f` says, so a frame is a pure function of t.
   */
  update(dt: number, f: FootState): void {
    if (dt === 0 && f.time !== this.settledAt && !Number.isNaN(f.time)) this.settle(f);
    else this.step(dt, f);
  }

  /** Re-run the last settleT seconds (60 Hz) leading up to f.time, then draw f.time itself. */
  private settle(f: FootState): void {
    const T = this.settleT, h = 1 / 60;
    this.onSettle?.();
    const w = this.walker;
    const p0 = w.position.clone(), q0 = w.quaternion.clone();
    const yaw = new THREE.Euler().setFromQuaternion(q0, "YXZ").y;
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const moving = !f.boating && f.speed > 0.05;
    const g = { ...f };
    for (const ft of this.feet) Object.assign(ft, new Foot());
    this.simInit = false;
    const n = Math.round(T / h);
    for (let k = n; k >= 0; k--) {
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
      this.step(k === n ? 0 : h, g);
    }
    w.position.copy(p0);
    w.quaternion.copy(q0);
    this.settledAt = f.time;
  }

  private pose: Float64Array | null = null;
  private keepPose(): void {
    const B = this.h.bones, P = (this.pose ??= new Float64Array(B.size * 10));
    let i = 0;
    for (const b of B.values()) {
      b.position.toArray(P, i);
      b.quaternion.toArray(P, i + 3);
      b.scale.toArray(P, i + 7);
      i += 10;
    }
  }
  private restorePose(): void {
    const P = this.pose;
    if (!P) return;
    let i = 0;
    for (const b of this.h.bones.values()) {
      b.position.fromArray(P, i);
      b.quaternion.fromArray(P, i + 3);
      b.scale.fromArray(P, i + 7);
      i += 10;
    }
  }

  private weights(idle: number, walk: number, run: number, sit: number, jump: number): void {
    const s = idle + walk + run + sit + jump || 1;
    this.act.idle.setEffectiveWeight(idle / s);
    this.act.walk.setEffectiveWeight(walk / s);
    this.act.run.setEffectiveWeight(run / s);
    this.act.sit_tiller.setEffectiveWeight(sit / s);
    this.act.jump.setEffectiveWeight(jump / s);
  }

  private step(dt: number, f: FootState): void {
    const w = this.walker;
    w.updateMatrixWorld(true);
    const seat = clamp(f.seat ?? 0, 0, 1);
    this.standK = 1 - seat;
    // Her own motion (apparent wind, heave).
    const p = _v.setFromMatrixPosition(w.matrixWorld);
    if (!this.simInit || p.distanceTo(this.lastPos) > 1.5) {
      this.simInit = false;
      this.vel.set(0, 0, 0);
      this.vy = this.ay = 0;
    } else if (dt > 0) {
      const vy = (p.y - this.lastPos.y) / dt;
      this.ay = damp(this.ay, clamp((vy - this.vy) / dt, -30, 30), 8, dt);
      this.vy = vy;
      this.vel.lerp(_v2.subVectors(p, this.lastPos).divideScalar(dt).clampLength(0, 12), 1 - Math.exp(-10 * dt));
    }
    this.lastPos.copy(p);

    // Clips: locomotion by speed, the jump over it, the seat over everything.
    const run = clamp(f.run, 0, 1);
    const gait = f.boating && seat > 0.5 ? 0 : clamp(f.speed / WALK.v, 0, 1);
    const jw = seat > 0 ? 0 : clamp(f.jumpW ?? 0, 0, 1);
    const loco = (1 - seat) * (1 - jw);
    this.weights(loco * (1 - gait), loco * gait * (1 - run), loco * gait * run, seat, (1 - seat) * jw);
    const ph = frac(f.phase / (Math.PI * 2));
    this.act.walk.time = ph * this.act.walk.getClip().duration;
    this.act.run.time = ph * this.act.run.getClip().duration;
    this.act.idle.time = frac(f.time / this.act.idle.getClip().duration) * this.act.idle.getClip().duration;
    this.act.sit_tiller.time = frac(f.time / this.act.sit_tiller.getClip().duration) * this.act.sit_tiller.getClip().duration;
    this.act.jump.time = clamp(f.jumpT ?? 0, 0, this.act.jump.getClip().duration - 1e-4);
    // The mixer writes a bone only when its blended value changed since its last write, so the
    // IK and springs below would pile up on an unchanged clip pose: start from the clip pose kept.
    this.restorePose();
    this.h.mixer.update(0);
    this.keepPose();
    w.updateMatrixWorld(true);

    this.faceAnim(f);
    this.bodyLean(f, seat);
    const free = !!f.boating || seat > 0;
    this.feetIK(dt, f, free, gait, run, jw);
    if (seat > 0 && f.grip) this.armIK(f.grip, seat);
    this.secondary(dt, f, seat);
    this.simInit = true;
  }

  // ---------------------------------------------------------------- body

  private bodyLean(f: FootState, seat: number): void {
    const w = this.walker;
    const fwd = _v.set(0, 0, -1).applyQuaternion(w.quaternion);
    const right = _v2.set(1, 0, 0).applyQuaternion(w.quaternion);
    // Into turns on foot; seated, against the turn and the boat's roll, and forward under heave.
    const walkLean = clamp(f.turn * f.speed * 0.035, -0.12, 0.12) * (1 - seat);
    const boatLean = (clamp(-f.turn * 0.18, -0.12, 0.12) - (f.roll ?? 0) * 0.55) * seat;
    const heave = clamp(-this.ay * 0.012, -0.08, 0.08) * seat;
    const lean = walkLean + boatLean;
    // Rotation about +Z (backward) tilts her top toward -X (her left).
    _q.setFromAxisAngle(fwd, -lean * 0.55);
    rotateWorld(this.bone("spine"), _q);
    _q.setFromAxisAngle(fwd, -lean * 0.45);
    rotateWorld(this.bone("spine1"), _q);
    if (heave !== 0) rotateWorld(this.bone("spine1"), _q.setFromAxisAngle(right, heave));
    // Head and eyes: the explorer's glances or the gaze target, the head held level against the lean.
    const level = lean * 0.4;
    rotateWorld(this.bone("neck"), _q.setFromAxisAngle(_Y, this.lookYaw * 0.4));
    rotateWorld(this.bone("neck"), _q.setFromAxisAngle(right, this.lookPitch * 0.35));
    rotateWorld(this.bone("head"), _q.setFromAxisAngle(_Y, this.lookYaw * 0.6));
    rotateWorld(this.bone("head"), _q.setFromAxisAngle(right, this.lookPitch * 0.65));
    rotateWorld(this.bone("head"), _q.setFromAxisAngle(fwd, level));
  }

  // ---------------------------------------------------------------- feet

  private feetIK(dt: number, f: FootState, free: boolean, gait: number, run: number, jw: number): void {
    const w = this.walker;
    const ph = frac(f.phase / (Math.PI * 2));
    const airborne = (f.air ?? 0) > 0.5;
    const idle = gait < 0.12 && jw < 0.5;
    const wy = w.position.y;
    const right = _v.set(1, 0, 0).applyQuaternion(w.quaternion).clone();
    const targets: THREE.Vector3[] = [];
    const footQ: THREE.Quaternion[] = [];
    const heel = new THREE.Vector3(), ball = new THREE.Vector3();
    for (let i = 0; i < 2; i++) {
      const L = this.legs[i], ft = this.feet[i];
      L.foot.localToWorld(heel.copy(L.heelL));
      L.foot.localToWorld(ball.copy(L.ballL));
      const ank = wpos(L.foot, new THREE.Vector3());
      const yaw = Math.atan2(-(ball.x - heel.x), -(ball.z - heel.z));
      // Contact from the dominant clip's windows.
      let contact: boolean, u = 0;
      if (free || airborne) contact = false;
      else if (jw >= 0.5) contact = inWindow(this.win.jump[i], (f.jumpT ?? 0) / JUMP_CLIP.end)[0];
      else if (idle) contact = true;
      else {
        const W = run > 0.5 ? this.win.run[i] : this.win.walk[i];
        [contact] = inWindow(W, ph);
        if (!contact) {
          // Swing progress: from lift-off to the next strike.
          const [s, len] = W[0];
          u = clamp((frac(ph - s) - len) / (1 - len), 0, 1);
        }
      }
      if (ft.restep >= 0) contact = false;
      this.contact[i] = contact;

      if (contact) {
        if (!ft.planted) {
          ft.planted = true;
          const gp = this.groundAt(ball.x + ft.s.x, ball.z + ft.s.y, wy);
          ft.kind = gp?.kind ?? ft.kind;
          if (dt > 0) {
            const a = wpos(L.foot, _a);
            this.onPlant?.(a.x + ft.s.x, gp?.h ?? wy, a.z + ft.s.y, yaw + ft.psi, i === 0 ? 1 : -1, ft.kind, f.time);
          }
        } else if (ft.has) {
          // The lock is one rigid correction of the clip's foot: a twist psi about the clip ankle A,
          // then an offset s. Keep the contact point (the lower of heel and ball) where the
          // corrected foot had it last frame, and cancel the foot's turn.
          const useHeel = heel.y < ball.y;
          const P = useHeel ? heel : ball, P0 = useHeel ? ft.heel : ft.ball;
          const was = _v3.subVectors(P0, ft.ank).applyAxisAngle(_Y, ft.psi).add(ft.ank);
          was.x += ft.s.x;
          was.z += ft.s.y;
          ft.psi = clamp(ft.psi - wrapA(yaw - ft.yaw), -1.1, 1.1);
          const now = _v4.subVectors(P, ank).applyAxisAngle(_Y, ft.psi).add(ank);
          ft.s.set(was.x - now.x, was.z - now.z).clampLength(0, 0.4);
        }
        ft.s0.copy(ft.s);
        ft.psi0 = ft.psi;
        ft.swingT = 0;
      } else {
        if (ft.planted) {
          ft.planted = false;
          ft.s0.copy(ft.s);
          ft.psi0 = ft.psi;
          ft.swingT = 0;
        }
        ft.swingT += dt;
        // Ease the lift-off error out over the swing (aloft or scripted: over a quarter second).
        const k = free || airborne || jw >= 0.5 ? smooth(0, 0.25, ft.swingT) : smooth(0, 0.75, u);
        if (ft.restep < 0) {
          ft.s.copy(ft.s0).multiplyScalar(1 - k);
          ft.psi = ft.psi0 * (1 - k);
        }
      }
      ft.heel.copy(heel);
      ft.ball.copy(ball);
      ft.ank.copy(ank);
      ft.yaw = yaw;
      ft.has = true;

      // Ground under the foot, relative to her root (the root follows the ground under her middle).
      let lift = 0;
      if (ft.restep >= 0) {
        ft.restep += dt;
        const k = smooth(0, 0.3, ft.restep);
        ft.s.copy(ft.s0).multiplyScalar(1 - k);
        ft.psi = ft.psi0 * (1 - k);
        lift = 0.045 * Math.sin(Math.PI * clamp(ft.restep / 0.3, 0, 1));
        if (ft.restep >= 0.3) {
          ft.restep = -1;
          ft.planted = false;
        }
      }
      let gTarget = 0;
      if (!free && !airborne) {
        const a = wpos(L.foot, _a);
        const g = this.groundAt(a.x + ft.s.x, a.z + ft.s.y, wy);
        if (g) gTarget = clamp(g.h - wy, -0.35, 0.35);
      }
      ft.gOff = dt > 0 && this.simInit ? damp(ft.gOff, gTarget, contact ? 40 : 18, dt) : gTarget;
      // A planted sole's lower contact point sits on the ground: blends between clips (start, stop,
      // walk to run) otherwise leave the blended foot hovering a few centimetres up.
      const cT = contact && !free && !airborne ? clamp(wy - Math.min(heel.y, ball.y), -0.08, 0.08) : 0;
      ft.cY = contact || dt <= 0 || !this.simInit ? cT : damp(ft.cY, cT, 10, dt);
      const T = ank.clone();
      T.x += ft.s.x;
      T.z += ft.s.y;
      T.y += ft.gOff + lift + ft.cY;
      targets.push(T);
      const q = L.foot.getWorldQuaternion(new THREE.Quaternion());
      footQ.push(q.premultiply(_q.setFromAxisAngle(_Y, ft.psi)));
    }

    // Standing: re-step the foot that has been dragged or twisted furthest from where the clip wants it.
    if (idle && !free && !airborne && this.feet[0].restep < 0 && this.feet[1].restep < 0) {
      const err = (ft: Foot) => Math.max(ft.s.length() / 0.1, Math.abs(ft.psi) / 0.35);
      const e0 = err(this.feet[0]), e1 = err(this.feet[1]);
      const i = e0 >= e1 ? 0 : 1;
      if (Math.max(e0, e1) > 1 && dt > 0) {
        const ft = this.feet[i];
        ft.restep = 0;
        ft.s0.copy(ft.s);
        ft.psi0 = ft.psi;
      }
    }

    // Pelvis down if a foot target is out of reach.
    let need = 0;
    for (let i = 0; i < 2; i++) {
      const hip = wpos(this.legs[i].thigh, _a);
      const d = hip.distanceTo(targets[i]) - this.legLen * 0.985;
      if (d > 0) need = Math.max(need, Math.min(d * 1.1, 0.3));
    }
    this.drop = need > this.drop || dt === 0 ? need : damp(this.drop, need, 10, dt);
    if (this.drop > 1e-4) {
      const hips = this.bone("hips");
      const hp = wpos(hips, _b);
      hp.y -= this.drop;
      hips.position.copy(hips.parent!.worldToLocal(hp));
      hips.updateMatrixWorld(true);
    }
    for (let i = 0; i < 2; i++) {
      const L = this.legs[i];
      twoBone(L.thigh, L.shin, L.foot, targets[i], right);
      setWorldQuat(L.foot, footQ[i]);
    }
  }

  private groundAt(x: number, z: number, y: number): { h: number; kind: string } | null {
    return this.ground ? this.ground(x, z, y) : { h: y, kind: "wood" };
  }

  /** Right hand onto the tiller (walker-space grip), blended in as she sits down. */
  private armIK(grip: THREE.Vector3, seat: number): void {
    const up = this.bone("upperarm_R"), fore = this.bone("forearm_R"), hand = this.bone("hand_R");
    const hq = hand.getWorldQuaternion(new THREE.Quaternion());
    const t = _v3.copy(grip).add(GRIP_OFF).applyMatrix4(this.walker.matrixWorld);
    const cur = wpos(hand, _v4);
    t.lerpVectors(cur, t, seat).clone();
    twoBone(up, fore, hand, t.clone(), new THREE.Vector3(0, -1, 0));
    setWorldQuat(hand, hq);
  }

  /** Distance from the tiller grip to where her hand holds it (tests; walker-space grip). */
  gripError(grip: THREE.Vector3): number {
    const t = _v3.copy(grip).add(GRIP_OFF).applyMatrix4(this.walker.matrixWorld);
    return wpos(this.bone("hand_R"), _v4).distanceTo(t);
  }

  // ---------------------------------------------------------------- secondary motion

  private secondary(dt: number, f: FootState, seat: number): void {
    // Apparent wind: the sea breeze (gusting) minus her own motion through the air.
    const t = f.time;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.9) * Math.sin(t * 0.37 + 1.1);
    const wd = G.uWindDir.value;
    const yaw = new THREE.Euler().setFromQuaternion(this.walker.quaternion, "YXZ").y;
    this.wind.set(wd.x, 0, wd.y).multiplyScalar(1.0 + 1.6 * gust);
    if (seat > 0.5) this.wind.addScaledVector(_v.set(-Math.sin(yaw), 0, -Math.cos(yaw)), -(f.wind ?? 0));
    else this.wind.addScaledVector(this.vel, -1);
    const ws = this.wind.length();
    G.uRiderWind.value.set(ws > 1e-3 ? this.wind.x / ws : 0, ws > 1e-3 ? this.wind.z / ws : 0, ws, gust);

    const headC = this.bone("head").localToWorld(_c.copy(this.headC));
    const init = !this.simInit;
    if (dt > 0 && !init) this.simAcc = Math.min(this.simAcc + dt, 0.1);
    const F = new THREE.Vector3(), d = new THREE.Vector3(), ot = new THREE.Vector3(), tip = new THREE.Vector3(), rs = new THREE.Vector3();
    const h = 1 / 120, n = Math.floor(this.simAcc / h + 1e-6);
    for (const sp of this.springs) {
      const root = wpos(sp.bones[0], _a);
      const end = wpos(sp.bones[sp.bones.length - 1], _b);
      d.subVectors(end, root);
      const len = d.length() || 1e-3;
      d.divideScalar(len);
      const wn = sp.hz * Math.PI * 2, z = 0.35;
      if (init) {
        sp.prev.copy(root);
        sp.lag.copy(root);
        sp.lagV.set(0, 0, 0);
      }
      // Inertia: a point mass on a spring from the root, stepped along the root's path this frame.
      // Damped against the root's own velocity: steady motion leaves no lag (the wind covers that).
      const vr = _v2.subVectors(root, sp.prev).divideScalar(Math.max(n, 1) * h);
      for (let k = 1; k <= n; k++) {
        rs.lerpVectors(sp.prev, root, k / n);
        sp.lagV.addScaledVector(_v.subVectors(rs, sp.lag).multiplyScalar(wn * wn).addScaledVector(_v3.subVectors(vr, sp.lagV), 2 * 0.6 * wn), h);
        sp.lag.addScaledVector(sp.lagV, h);
      }
      sp.prev.copy(root);
      F.copy(this.wind).multiplyScalar(sp.gain).addScaledVector(_v.subVectors(sp.lag, root), sp.inertia / len);
      ot.copy(F).addScaledVector(d, -F.dot(d)).clampLength(0, sp.max);
      if (sp.head) {
        // Never toward the middle of her head.
        tip.copy(root).addScaledVector(d, len * 0.7);
        const inward = _v.subVectors(headC, tip).normalize();
        const k = ot.dot(inward);
        if (k > 0) ot.addScaledVector(inward, -k);
      }
      if (init) {
        sp.o.copy(ot);
        sp.ov.set(0, 0, 0);
      } else
        for (let k = 0; k < n; k++) {
          sp.ov.addScaledVector(_v.subVectors(ot, sp.o).multiplyScalar(wn * wn).addScaledVector(sp.ov, -2 * z * wn), h);
          sp.o.addScaledVector(sp.ov, h);
        }
      if (sp.o.lengthSq() < 1e-8) continue;
      _q.setFromUnitVectors(d, _v.copy(d).add(sp.o).normalize());
      for (let j = 0; j < sp.bones.length; j++) rotateWorld(sp.bones[j], _q2.identity().slerp(_q, sp.share[j]).clone());
    }
    this.simAcc -= n * h;
  }

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
    FACE_U.uBlink.value = lid;
    // Head and eyes: follow the explorer's glances, or a gaze target (eyes lead, head follows).
    let yaw = f.look, pitch = f.lookUp;
    let eyeX: number, eyeY: number;
    if (this.gazeTarget) {
      const head = this.headWorld(_v4);
      const vb = _v3.subVectors(this.gazeTarget, head).applyQuaternion(_q.copy(this.walker.quaternion).invert());
      const ty = Math.atan2(-vb.x, -vb.z), tp = Math.atan2(vb.y, Math.hypot(vb.x, vb.z));
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
    // Eyes: a little saccade drift; positive x moves the iris toward her left.
    const sac = 0.0004 * Math.sin(t * 0.7) * Math.sin(t * 1.9 + 1);
    FACE_U.uGaze.value.set(clamp(eyeX * 0.006 + sac, -0.0032, 0.0032), clamp(eyeY * 0.004, -0.0018, 0.0022));
    FACE_U.uSmile.value = 0.3 + 0.1 * Math.sin(t * 0.17);
  }
}

/** Her hat and face in her own shadow map: depth pushed 0.6 m from the light (see CharShadow). */
const HAT_SHADOW = (() => {
  const m = shadowDepthMaterial();
  m.vertexShader = m.vertexShader.replace(
    "gl_Position = projectionMatrix * viewMatrix * m * vec4(p, 1.0);",
    "gl_Position = projectionMatrix * viewMatrix * m * vec4(p, 1.0); gl_Position.z += 2.0 * 0.6 / 39.5 * gl_Position.w;",
  );
  return m;
})();
export const hatShadowMaterial = HAT_SHADOW;

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
