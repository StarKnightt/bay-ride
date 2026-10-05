import * as THREE from "three";

/**
 * Her skeleton: a flat list of bones under one group in walker space (feet on y = 0, facing -Z,
 * +X her right). Every bone is posed directly in walker space each frame (no parenting maths in
 * the bones themselves), and every skinned part binds to the same skeleton.
 */

export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface BoneDef {
  name: string;
  head: THREE.Vector3;
  tail: THREE.Vector3;
  /** Direction the bone's local +Z faces in the bind pose (its "front"). */
  front: THREE.Vector3;
}

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Quaternion of the frame whose +Y runs along `dir` and whose +Z leans toward `front`. */
export function frameQ(dir: THREE.Vector3, front: THREE.Vector3, out = new THREE.Quaternion()): THREE.Quaternion {
  _y.copy(dir).normalize();
  _z.copy(front).addScaledVector(_y, -front.dot(_y));
  if (_z.lengthSq() < 1e-8) _z.set(0, 0, -1).addScaledVector(_y, _y.z);
  _z.normalize();
  _x.crossVectors(_y, _z);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}

export class Rig {
  readonly root = new THREE.Group();
  readonly bones: THREE.Bone[] = [];
  readonly defs: BoneDef[] = [];
  /** Bind-pose head position, tail position and orientation of each bone (walker space). */
  readonly h0: THREE.Vector3[] = [];
  readonly t0: THREE.Vector3[] = [];
  readonly q0: THREE.Quaternion[] = [];
  private byName = new Map<string, number>();
  skeleton!: THREE.Skeleton;

  add(def: BoneDef): number {
    const i = this.bones.length;
    const b = new THREE.Bone();
    b.name = def.name;
    const q = frameQ(_y.subVectors(def.tail, def.head), def.front);
    b.position.copy(def.head);
    b.quaternion.copy(q);
    this.root.add(b);
    this.bones.push(b);
    this.defs.push(def);
    this.h0.push(def.head.clone());
    this.t0.push(def.tail.clone());
    this.q0.push(q.clone());
    this.byName.set(def.name, i);
    return i;
  }

  idx(name: string): number {
    const i = this.byName.get(name);
    if (i === undefined) throw new Error(`no bone ${name}`);
    return i;
  }

  bone(name: string): THREE.Bone {
    return this.bones[this.idx(name)];
  }

  /** Freeze the bind pose (call with every bone at its bind frame, root at the identity). */
  bind(): void {
    this.root.updateMatrixWorld(true);
    this.skeleton = new THREE.Skeleton(this.bones);
  }

  /** Pose bone i: head at `p`, +Y along `dir`, front toward `front`. */
  setFrame(i: number, p: THREE.Vector3, dir: THREE.Vector3, front: THREE.Vector3): void {
    const b = this.bones[i];
    b.position.copy(p);
    frameQ(dir, front, b.quaternion);
  }

  /** Pose bone i rigidly: rotated by `d` (walker space) from its bind orientation, head at `p`. */
  setDelta(i: number, p: THREE.Vector3, d: THREE.Quaternion): void {
    const b = this.bones[i];
    b.position.copy(p);
    b.quaternion.multiplyQuaternions(d, this.q0[i]);
  }

  /** Rotation of bone i from its bind orientation (walker space). */
  delta(i: number, out = new THREE.Quaternion()): THREE.Quaternion {
    return out.copy(this.bones[i].quaternion).multiply(_qi.copy(this.q0[i]).invert());
  }

  /** Where a bind-pose point carried rigidly by bone i is now (walker space). */
  carry(i: number, p0: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    const b = this.bones[i];
    return out.subVectors(p0, this.h0[i]).applyQuaternion(this.delta(i, _qd)).add(b.position);
  }
}
const _qi = new THREE.Quaternion(), _qd = new THREE.Quaternion();

/** Closest-point parameter (0..1) of p on segment a-b, and the distance. */
export function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): [number, number] {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2 : 0;
  t = Math.min(1, Math.max(0, t));
  const dx = p.x - (a.x + abx * t), dy = p.y - (a.y + aby * t), dz = p.z - (a.z + abz * t);
  return [t, Math.sqrt(dx * dx + dy * dy + dz * dz)];
}

/** Per-vertex weight function: returns up to four [bone, weight] pairs (any order, any sum). */
export type WeightFn = (p: THREE.Vector3, i: number) => [number, number][];

/**
 * Envelope weights: each listed bone weighs 1 / (d + r)^k by distance to its bind segment, the
 * strongest four kept. `bias` scales a bone's reach (1 = neutral).
 */
export function envelope(rig: Rig, bones: number[], k = 5, r = 0.02, bias: Record<number, number> = {}): WeightFn {
  return (p) => {
    const out: [number, number][] = [];
    for (const b of bones) {
      const [, d] = segDist(p, rig.h0[b], rig.t0[b]);
      out.push([b, Math.pow((bias[b] ?? 1) / (d + r), k)]);
    }
    return out;
  };
}

/** One bone only. */
export const rigid = (b: number): WeightFn => () => [[b, 1]];

/** Write skinIndex / skinWeight (the four strongest, normalised) onto a geometry. */
export function skin(g: THREE.BufferGeometry, fn: WeightFn): THREE.BufferGeometry {
  const pa = g.attributes.position;
  const n = pa.count;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  const p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pa, i);
    const w = fn(p, i).filter((e) => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 4);
    let s = 0;
    for (const e of w) s += e[1];
    if (s <= 0) w.splice(0, w.length, [0, 1]), (s = 1);
    w.forEach(([b, x], k) => {
      si[i * 4 + k] = b;
      sw[i * 4 + k] = x / s;
    });
  }
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(si, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(sw, 4));
  return g;
}

/** Two-bone IK: joint position for a chain a → c of lengths l1, l2 bending toward `pole`. */
export function ik(a: THREE.Vector3, c: THREE.Vector3, l1: number, l2: number, pole: THREE.Vector3, mid: THREE.Vector3): THREE.Vector3 {
  const d = _ia.subVectors(c, a);
  let len = d.length();
  len = Math.min(Math.max(len, Math.abs(l1 - l2) + 1e-3), l1 + l2 - 1e-4);
  d.normalize();
  const cosA = (l1 * l1 + len * len - l2 * l2) / (2 * l1 * len);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  const perp = _ib.copy(pole).addScaledVector(d, -pole.dot(d));
  if (perp.lengthSq() < 1e-8) perp.set(0, 0, -1);
  perp.normalize();
  return mid.copy(a).addScaledVector(d, l1 * cosA).addScaledVector(perp, l1 * sinA);
}
const _ia = new THREE.Vector3(), _ib = new THREE.Vector3();

/** Verlet chain (hair lock, shirt tail, ribbon): particle 0 is pinned, the rest swing. */
export class Chain {
  readonly p: THREE.Vector3[];
  readonly q: THREE.Vector3[];
  readonly len: number[];
  /** Rest positions this frame (pinned root first), written by the owner before step(). */
  readonly rest: THREE.Vector3[];
  constructor(
    n: number,
    /** Pull toward the rest shape per segment, root to tip (1/s). */
    public stiff: number[],
    public drag = 2.5,
    public gravity = 9.8,
    /** How much the apparent wind pushes it (m/s² per m/s). */
    public windK = 0.5,
  ) {
    this.p = Array.from({ length: n }, () => new THREE.Vector3());
    this.q = Array.from({ length: n }, () => new THREE.Vector3());
    this.rest = Array.from({ length: n }, () => new THREE.Vector3());
    this.len = new Array(n - 1).fill(0);
  }
  /** Snap to the rest shape (spawn, teleports). */
  reset(): void {
    for (let i = 0; i < this.p.length; i++) {
      this.p[i].copy(this.rest[i]);
      this.q[i].copy(this.rest[i]);
    }
    for (let i = 0; i < this.len.length; i++) this.len[i] = this.rest[i].distanceTo(this.rest[i + 1]);
  }
  step(h: number, wind: THREE.Vector3, collide: (p: THREE.Vector3, r: number) => void, radius: number): void {
    const P = this.p, Q = this.q, n = P.length;
    P[0].copy(this.rest[0]);
    Q[0].copy(this.rest[0]);
    const damp = Math.exp(-this.drag * h);
    for (let i = 1; i < n; i++) {
      const p = P[i], q = Q[i];
      _cv.subVectors(p, q).multiplyScalar(damp);
      q.copy(p);
      p.add(_cv);
      p.y -= this.gravity * h * h;
      p.addScaledVector(wind, this.windK * h * h);
      // Shape memory: ease toward the rest pose (stronger near the root).
      p.lerp(this.rest[i], Math.min(1, this.stiff[i - 1] * h));
    }
    for (let it = 0; it < 3; it++) {
      for (let i = 1; i < n; i++) {
        const a = P[i - 1], b = P[i];
        _cv.subVectors(b, a);
        const d = _cv.length() || 1e-6;
        b.copy(a).addScaledVector(_cv, this.len[i - 1] / d);
      }
      for (let i = 1; i < n; i++) collide(P[i], radius);
    }
  }
}
const _cv = new THREE.Vector3();
