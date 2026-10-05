import * as THREE from "three";
import { ID, M, merge, prep } from "../world/geo";
import { uber } from "../render/materials";
import { mulberry32, range } from "../core/rng";
import { CUE_TAKEOFF, cues } from "../sound/cues";

/**
 * Seagulls. Loose flocks wheel over the bay and a few loners soar high over the headlands and the
 * island, gliding on bent (M-shaped) wings and flapping in bursts; every flying position is a pure
 * function of time, so fixed-time captures repeat exactly. Others rest on posts, the pier rail,
 * lamp heads and ridges; when she comes close they take off out over the water, circle there and
 * come back once she has moved on. CPU-posed instances: a body and four wing parts (inner wing and
 * hand on each side, hinged at shoulder and wrist), three draws in all, no allocation per frame.
 */

type V3 = THREE.Vector3;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function bodyGeo(legs: boolean): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(0.1, 12, 8);
  body.scale(1, 0.85, 2.6);
  // Grey mantle on the back, white below.
  const p = body.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    c.set(p.getY(i) > 0.035 && p.getZ(i) < 0.2 ? "#aab3bc" : "#f4f4f0");
    c.toArray(col, i * 3);
  }
  body.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const head = new THREE.SphereGeometry(0.072, 10, 7);
  head.translate(0, 0.07, 0.25);
  const beak = new THREE.ConeGeometry(0.018, 0.08, 5);
  beak.rotateX(Math.PI / 2);
  beak.translate(0, 0.06, 0.34);
  const tail = new THREE.BufferGeometry();
  tail.setAttribute("position", new THREE.Float32BufferAttribute([-0.08, 0.02, -0.38, 0.08, 0.02, -0.38, 0, 0.04, -0.2], 3));
  tail.setIndex([0, 1, 2]);
  tail.computeVertexNormals();
  const parts = [prep(body, null, M.plain), prep(head, "#f6f6f2", M.plain), prep(beak, "#e8b830", M.plain), prep(tail, "#e8eaea", M.plain)];
  if (legs)
    for (const x of [-0.035, 0.035]) {
      const l = new THREE.CylinderGeometry(0.008, 0.008, 0.16, 4);
      l.translate(x, -0.15, -0.02);
      parts.push(prep(l, "#d9a07a", M.plain));
    }
  return merge(parts);
}

/** One wing part along +x from its hinge: `outer` = the swept, black-tipped hand. */
function wingGeo(outer: boolean): THREE.BufferGeometry {
  const s = new THREE.Shape();
  if (!outer) {
    s.moveTo(0, 0.07);
    s.lineTo(0.34, 0.06);
    s.lineTo(0.34, -0.1);
    s.lineTo(0, -0.12);
  } else {
    s.moveTo(0, 0.06);
    s.lineTo(0.2, 0.03);
    s.lineTo(0.42, -0.06);
    s.lineTo(0.3, -0.1);
    s.lineTo(0, -0.1);
  }
  s.closePath();
  const g = new THREE.ShapeGeometry(s);
  // Shape y (the chord, leading edge up) becomes +z: the leading edge faces forward.
  g.rotateX(Math.PI / 2);
  const p = g.attributes.position, col = new Float32Array(p.count * 3), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    if (outer && x > 0.24) c.set(x > 0.38 ? "#f2f2ee" : "#25282c");
    else c.set(z < -0.07 ? "#e9ecee" : "#b4bcc5");
    c.toArray(col, i * 3);
  }
  prep(g, null, M.plain);
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

/** A closed flight path: centre, radii, height, angular speed, phase, drift of the centre. */
interface Path {
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  y: number;
  w: number;
  ph: number;
  drift: number;
}

interface Gull {
  path: number;
  /** Formation offset (m) and its wobble phase. */
  ox: number;
  oy: number;
  oz: number;
  ph: number;
  scale: number;
  /** Flying gulls hide at dusk below this activity. */
  need: number;
}

interface Percher {
  p: V3;
  yaw: number;
  mode: 0 | 1 | 2;
  t0: number;
  /** Where it heads when it leaves (unit, horizontal), and where the return started. */
  out: V3;
  from: V3;
  scale: number;
}

const PATHS: Path[] = [
  { cx: -62, cz: -150, rx: 55, rz: 40, y: 21, w: 0.17, ph: 0, drift: 18 },
  { cx: -105, cz: 30, rx: 90, rz: 120, y: 29, w: 0.085, ph: 2.1, drift: 30 },
  { cx: -30, cz: 20, rx: 26, rz: 130, y: 15, w: 0.06, ph: 4.0, drift: 12 },
  { cx: -200, cz: -20, rx: 32, rz: 28, y: 46, w: 0.2, ph: 1.0, drift: 10 },
  { cx: -40, cz: 262, rx: 40, rz: 30, y: 58, w: 0.15, ph: 3.3, drift: 14 },
  { cx: -20, cz: -300, rx: 36, rz: 26, y: 52, w: 0.17, ph: 5.1, drift: 12 },
];

const FLAP_HZ = 2.7;

export class Gulls {
  readonly group = new THREE.Group();
  private readonly fly: THREE.InstancedMesh;
  private readonly sit: THREE.InstancedMesh;
  private readonly wings: THREE.InstancedMesh;
  private readonly outer: THREE.InstancedMesh;
  private readonly gulls: Gull[] = [];
  private readonly perchers: Percher[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly q2 = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly vel = new THREE.Vector3();
  private readonly wrist = new THREE.Vector3();
  private readonly hinge = new THREE.Vector3();
  private readonly bodyM = new THREE.Matrix4();
  private readonly tmpM = new THREE.Matrix4();
  private readonly hide = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly zAxis = new THREE.Vector3(0, 0, 1);
  /** The last update's clock and activity (the sound asks where its gulls are). */
  private lastT = 0;
  private lastAct = 1;

  constructor(perches: [number, number, number, number][]) {
    this.group.name = "gulls";
    const r = mulberry32(919);
    const sizes = [6, 5, 4, 1, 1, 1];
    sizes.forEach((n, path) => {
      for (let i = 0; i < n; i++)
        this.gulls.push({
          path,
          ox: n > 1 ? range(r, -9, 9) : 0,
          oy: n > 1 ? range(r, -2.5, 2.5) : 0,
          oz: n > 1 ? range(r, -9, 9) : 0,
          ph: r() * 50,
          scale: range(r, 0.92, 1.1),
          need: path === 2 || path >= 4 ? 0.75 : path === 3 ? 0.6 : 0.3,
        });
    });
    // Perches nearest the water first (pier, shed, poles by the harbour), at most ten.
    const sorted = perches.slice().sort((p, q) => p[0] - q[0]).slice(0, 10);
    for (const [x, y, z, yaw] of sorted)
      this.perchers.push({ p: V(x, y, z), yaw, mode: 0, t0: -1e3, out: V(-1, 0, 0), from: V(x, y, z), scale: range(r, 0.92, 1.08) });
    const mat = uber(ID.butterfly, 0.7, THREE.DoubleSide);
    this.fly = new THREE.InstancedMesh(bodyGeo(false), mat, this.gulls.length + this.perchers.length);
    this.sit = new THREE.InstancedMesh(bodyGeo(true), mat, Math.max(1, this.perchers.length));
    this.wings = new THREE.InstancedMesh(wingGeo(false), mat, (this.gulls.length + this.perchers.length) * 2);
    this.outer = new THREE.InstancedMesh(wingGeo(true), mat, (this.gulls.length + this.perchers.length) * 2);
    for (const im of [this.fly, this.sit, this.wings, this.outer]) {
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(im);
    }
    cues.gulls = this;
  }

  /** For the sound: how many gulls (flying first, then perched), and where gull i is `ahead` s after the last update (0 hidden, 1 flying, 2 sitting). */
  get voices(): number {
    return this.gulls.length + this.perchers.length;
  }
  where(i: number, ahead: number, out: V3): number {
    const g = this.gulls[i], p = this.perchers[i - this.gulls.length], t = this.lastT + ahead;
    if (g && this.lastAct >= g.need) this.flyingAt(g, t, out);
    else if (g || !p) return 0;
    else if (p.mode === 0) out.copy(p.p);
    else if (p.mode === 1) this.awayAt(p, t, out);
    else this.returnAt(p, t, out);
    return g || p.mode !== 0 ? 1 : 2;
  }

  /** Flock centre on path i at time t, and the flock's own drift. */
  private pathAt(i: number, t: number, out: V3): V3 {
    const p = PATHS[i];
    const a = t * p.w + p.ph;
    const dx = Math.sin(t * 0.021 + p.ph) * p.drift, dz = Math.cos(t * 0.017 + p.ph * 1.3) * p.drift;
    return out.set(p.cx + dx + Math.cos(a) * p.rx, p.y + Math.sin(t * 0.13 + p.ph) * 2.5, p.cz + dz + Math.sin(a) * p.rz);
  }

  private flyingAt(g: Gull, t: number, out: V3): V3 {
    this.pathAt(g.path, t, out);
    const w = t * 0.11 + g.ph;
    return out.set(out.x + g.ox + Math.sin(w) * 2.2, out.y + g.oy + Math.sin(w * 1.7) * 0.8, out.z + g.oz + Math.cos(w * 0.8) * 2.2);
  }

  /** How much a bird is flapping (0 glide … 1 flap): bursts of 1.5–2.6 s in 6 s slots, smoothed. */
  private flapness(seed: number, t: number, climb: number): number {
    const k = Math.floor(t / 6), f = t - k * 6;
    const on = hash(seed * 31 + k) < 0.55 ? 1.5 + hash(seed * 17 + k) * 1.1 : 0;
    const burst = Math.min(1, Math.max(0, Math.min(f / 0.4, (on - f) / 0.5)));
    return Math.min(1, burst + Math.max(0, climb) * 0.6);
  }

  /** Body + wing matrices for a bird at `pos` moving with `vel`, flap state, scale. */
  private pose(i: number, pos: V3, vel: V3, flap: number, t: number, seed: number, scale: number, turn: number): void {
    const speed = Math.hypot(vel.x, vel.z) || 1e-4;
    const yaw = Math.atan2(vel.x, vel.z);
    const pitch = -Math.atan2(vel.y, speed) * 0.7;
    // The flock paths all wheel the same way: a positive turn banks the bird into it.
    const roll = Math.max(-0.7, Math.min(0.7, turn * 2.2));
    this.e.set(pitch, yaw, roll, "YXZ");
    this.q.setFromEuler(this.e);
    this.bodyM.compose(pos, this.q, this.s.setScalar(scale));
    this.fly.setMatrixAt(i, this.bodyM);
    const ph = t * FLAP_HZ * Math.PI * 2 + seed * 3.1;
    // Glide: a slight dihedral at the shoulder, the hand drooped and swept back (gull M shape).
    const inner = (1 - flap) * 0.1 + flap * Math.sin(ph) * 0.62;
    const hand = (1 - flap) * -0.32 + flap * (Math.sin(ph - 0.7) * 0.5 - 0.05);
    const sweep = (1 - flap) * 0.38 + flap * (0.12 + 0.12 * Math.sin(ph + 1.2));
    for (let si = 0; si < 2; si++) {
      const side = si ? 1 : -1;
      // Shoulder hinge 4 cm out from the body axis, wing along ±x.
      this.e.set(0, 0, side * inner, "YXZ");
      this.q2.setFromEuler(this.e);
      this.tmpM.compose(this.hinge.set(side * 0.04, 0.04, 0.02), this.q2, this.s.set(side, 1, 1));
      this.m.multiplyMatrices(this.bodyM, this.tmpM);
      this.wings.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), this.m);
      // Wrist at the inner wing's tip; the hand bends again from there, swept back.
      this.wrist.set(0.33, 0, 0).applyMatrix4(this.tmpM);
      this.e.set(0, side * sweep, side * (inner + hand), "YXZ");
      this.q2.setFromEuler(this.e);
      this.tmpM.compose(this.wrist, this.q2, this.s.set(side, 1, 1));
      this.m.multiplyMatrices(this.bodyM, this.tmpM);
      this.outer.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), this.m);
    }
  }

  private hideBird(i: number): void {
    this.fly.setMatrixAt(i, this.hide);
    for (let k = 0; k < 2; k++) {
      this.wings.setMatrixAt(i * 2 + k, this.hide);
      this.outer.setMatrixAt(i * 2 + k, this.hide);
    }
  }

  /** `px, pz` = her position; `activity` 0…1 thins the flying birds toward dusk. */
  update(t: number, dt: number, px: number, pz: number, cam: V3, activity: number): void {
    this.lastT = t;
    this.lastAct = activity;
    const n = this.gulls.length;
    for (let i = 0; i < n; i++) {
      const g = this.gulls[i];
      if (activity < g.need) {
        this.hideBird(i);
        continue;
      }
      this.flyingAt(g, t, this.a);
      this.flyingAt(g, t - 0.25, this.b);
      this.vel.subVectors(this.a, this.b).multiplyScalar(4);
      // Turn rate from the path's angular speed: wheeling flocks bank into the circle.
      const turn = PATHS[g.path].w * Math.sign(PATHS[g.path].rx);
      this.pose(i, this.a, this.vel, this.flapness(i, t, this.vel.y * 0.3), t, i, g.scale, turn);
    }
    let sitting = 0;
    for (let k = 0; k < this.perchers.length; k++) {
      const p = this.perchers[k];
      const i = n + k;
      const dPlayer = Math.hypot(px - p.p.x, pz - p.p.z);
      const dCam = cam.distanceTo(p.p);
      if (p.mode === 0 && dt > 0 && (dPlayer < 3.6 || dCam < 2.2)) {
        p.mode = 1;
        p.t0 = t;
        p.out.set(p.p.x - px, 0, p.p.z - pz);
        // Away from her, biased out over the sea (-x).
        p.out.x -= 3;
        p.out.normalize();
        cues.post(CUE_TAKEOFF, p.p.x, p.p.y, p.p.z, t, t * FLAP_HZ + ((k + 40) * 3.1) / (2 * Math.PI), FLAP_HZ);
      } else if (p.mode === 1 && t - p.t0 > 22 && dPlayer > 11 && dCam > 6) {
        this.awayAt(p, t, p.from);
        p.mode = 2;
        p.t0 = t;
      } else if (p.mode === 2 && t - p.t0 > 6) p.mode = 0;
      if (p.mode === 0) {
        // Sitting: a slow look about now and then.
        const look = Math.sin(t * 0.37 + k * 2.1) * 0.5 + Math.sin(t * 1.3 + k) * 0.15;
        this.e.set(0, p.yaw + look, 0, "YXZ");
        this.q.setFromEuler(this.e);
        this.m.compose(this.a.copy(p.p).setY(p.p.y + 0.22 * p.scale), this.q, this.s.setScalar(p.scale));
        this.sit.setMatrixAt(sitting++, this.m);
        // Folded wings along the back.
        for (let si = 0; si < 2; si++) {
          const side = si ? 1 : -1;
          this.e.set(0.05, side * 1.45, side * 0.12, "YXZ");
          this.q2.setFromEuler(this.e);
          this.tmpM.compose(this.b.set(side * 0.07, 0.05, 0.12), this.q2, this.s.set(side * 0.9, 1, 0.9));
          this.bodyM.multiplyMatrices(this.m, this.tmpM);
          this.wings.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), this.bodyM);
          this.outer.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), this.hide);
        }
        this.fly.setMatrixAt(i, this.hide);
        continue;
      }
      if (p.mode === 1) {
        this.awayAt(p, t, this.a);
        this.awayAt(p, t - 0.2, this.b);
      } else {
        this.returnAt(p, t, this.a);
        this.returnAt(p, t - 0.2, this.b);
      }
      this.vel.subVectors(this.a, this.b).multiplyScalar(5);
      const tau = t - p.t0;
      const flap = p.mode === 1 ? (tau < 3 ? 1 : this.flapness(k + 40, t, 0)) : tau > 4.2 ? 1 : 0.2;
      this.pose(i, this.a, this.vel, flap, t, k + 40, p.scale, p.mode === 1 && tau > 4 ? 0.6 : 0);
    }
    this.sit.count = sitting;
    this.fly.instanceMatrix.needsUpdate = true;
    this.sit.instanceMatrix.needsUpdate = true;
    this.wings.instanceMatrix.needsUpdate = true;
    this.outer.instanceMatrix.needsUpdate = true;
  }

  /** Leaving: up and out over the water, then circling a point 30 m out. */
  private awayAt(p: Percher, t: number, out: V3): V3 {
    const tau = Math.max(0, t - p.t0);
    const k = Math.min(1, tau / 4);
    const e = k * k * (3 - 2 * k);
    const hx = p.p.x + p.out.x * 30, hz = p.p.z + p.out.z * 30, hy = Math.max(p.p.y, 0) + 12;
    const a = tau * 0.55;
    const cx = hx + Math.cos(a) * 9, cz = hz + Math.sin(a) * 9;
    const lx = p.p.x + p.out.x * 14 * e, lz = p.p.z + p.out.z * 14 * e, ly = p.p.y + 9 * e;
    const b = Math.min(1, Math.max(0, (tau - 3) / 3));
    const bb = b * b * (3 - 2 * b);
    return out.set(lx + (cx - lx) * bb, ly + (hy - ly) * bb, lz + (cz - lz) * bb);
  }

  /** Coming back: a descending glide from where it was to the perch, flapping to land. */
  private returnAt(p: Percher, t: number, out: V3): V3 {
    const k = Math.min(1, Math.max(0, (t - p.t0) / 6));
    const e = k * k * (3 - 2 * k);
    const cx = (p.from.x + p.p.x) / 2, cz = (p.from.z + p.p.z) / 2, cy = Math.max(p.from.y, p.p.y) + 3;
    const u = 1 - e;
    return out.set(u * u * p.from.x + 2 * u * e * cx + e * e * p.p.x, u * u * p.from.y + 2 * u * e * cy + e * e * (p.p.y + 0.22), u * u * p.from.z + 2 * u * e * cz + e * e * p.p.z);
  }
}
