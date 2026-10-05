import * as THREE from "three";
import { M, prep } from "../world/geo";
import { Rig, V, envelope, skin, type WeightFn } from "./rig";

/**
 * Her body in the bind pose (walker space: feet on y = 0, facing -Z, +X her right), about 1.68 m
 * tall: long legs, a slim waist over wider hips, square-ish soft shoulders, a long neck. Bones are
 * laid out here; every skinned part is a loft of cross-sections weighted to them.
 */

export type Geo = THREE.BufferGeometry;

export const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Catmull-Rom through table rows [y, ...values] at y (rows sorted by y ascending). */
export function table(T: number[][], y: number, out: number[]): number[] {
  const n = T.length;
  y = Math.min(T[n - 1][0], Math.max(T[0][0], y));
  let i = 0;
  while (i < n - 2 && y > T[i + 1][0]) i++;
  const y0 = T[i][0], y1 = T[i + 1][0], f = (y - y0) / (y1 - y0), f2 = f * f, f3 = f2 * f;
  for (let c = 1; c < T[0].length; c++) {
    const p0 = T[i][c], p1 = T[i + 1][c];
    const m0 = i > 0 ? ((p1 - T[i - 1][c]) / (y1 - T[i - 1][0])) * (y1 - y0) : p1 - p0;
    const m1 = i < n - 2 ? ((T[i + 2][c] - p0) / (T[i + 2][0] - y0)) * (y1 - y0) : p1 - p0;
    out[c - 1] = (2 * f3 - 3 * f2 + 1) * p0 + (f3 - 2 * f2 + f) * m0 + (-2 * f3 + 3 * f2) * p1 + (f3 - f2) * m1;
  }
  return out;
}

/**
 * Lofted surface from rings of equal length (each ring a loop, or an open strip if `open`).
 * Faces wind outward from each ring's centre (or toward `outward` for open strips). UV: u along a
 * ring, v across rings.
 */
export function loft(rings: THREE.Vector3[][], open = false, capStart = false, capEnd = false): Geo {
  const m = rings.length, n = rings[0].length;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const p = rings[j][i];
      pos.push(p.x, p.y, p.z);
      uv.push(i / (open ? n - 1 : n), j / (m - 1));
    }
  const cols = open ? n - 1 : n;
  for (let j = 0; j < m - 1; j++)
    for (let i = 0; i < cols; i++) {
      const i2 = (i + 1) % n;
      const a = j * n + i, b = j * n + i2, c = a + n, d = b + n;
      idx.push(a, c, b, b, c, d);
    }
  const cap = (j: number, flip: boolean) => {
    const c = new THREE.Vector3();
    for (const p of rings[j]) c.add(p);
    c.divideScalar(n);
    const k = pos.length / 3;
    pos.push(c.x, c.y, c.z);
    uv.push(0.5, j / (m - 1));
    for (let i = 0; i < n; i++) {
      const i2 = (i + 1) % n;
      if (flip) idx.push(k, j * n + i2, j * n + i);
      else idx.push(k, j * n + i, j * n + i2);
    }
  };
  if (capStart) cap(0, false);
  if (capEnd) cap(m - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  if (!open) {
    // Wind outward: compare a mid-ring normal against the direction from the ring's centre.
    const j = m >> 1, c = new THREE.Vector3();
    for (const p of rings[j]) c.add(p);
    c.divideScalar(n);
    let s = 0;
    const na = g.attributes.normal;
    for (let i = 0; i < n; i++) s += new THREE.Vector3(na.getX(j * n + i), na.getY(j * n + i), na.getZ(j * n + i)).dot(rings[j][i].clone().sub(c));
    if (s < 0) flip(g);
  }
  return g;
}

export function flip(g: Geo): Geo {
  const ix = g.index!.array as Uint32Array | Uint16Array;
  for (let k = 0; k < ix.length; k += 3) {
    const t = ix[k + 1];
    ix[k + 1] = ix[k + 2];
    ix[k + 2] = t;
  }
  g.index!.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/** Prep for the toon material, skin it, and set a flutter weight per vertex (0 = none). */
export function part(g: Geo, color: THREE.ColorRepresentation | null, mat: number, w: WeightFn, flutter?: (p: THREE.Vector3) => number): Geo {
  prep(g, color, mat);
  skin(g, w);
  if (flutter) {
    const a = g.attributes.aWind as THREE.BufferAttribute, p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < a.count; i++) a.setX(i, flutter(v.fromBufferAttribute(p, i)));
  }
  return g;
}

/** Multiply vertex colours by f(p) (painted shading, seams). */
export function shade(g: Geo, f: (p: THREE.Vector3) => number): Geo {
  const c = g.attributes.color as THREE.BufferAttribute, p = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < c.count; i++) {
    const k = f(v.fromBufferAttribute(p, i));
    c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
  }
  return g;
}

// ------------------------------------------------------------------ skeleton

/** Bind-pose joints (walker space). Index 0 of a pair is her right side (+X). */
export const J = {
  hipC: V(0, 0.93, 0),
  waist: V(0, 1.06, 0.004),
  chest: V(0, 1.2, 0.01),
  neck: V(0, 1.405, 0.014),
  head: V(0, 1.47, 0.004),
  crown: V(0, 1.672, 0.0),
  shoulder: (s: number) => V(s * 0.168, 1.372, 0.012),
  elbow: (s: number) => V(s * 0.202, 1.103, 0.03),
  wrist: (s: number) => V(s * 0.226, 0.858, 0.012),
  knuckle: (s: number) => V(s * 0.232, 0.783, 0.004),
  fingerMid: (s: number) => V(s * 0.234, 0.748, 0.0),
  fingerTip: (s: number) => V(s * 0.235, 0.716, -0.002),
  thumb0: (s: number) => V(s * 0.214, 0.836, -0.012),
  thumbTip: (s: number) => V(s * 0.214, 0.79, -0.03),
  hip: (s: number) => V(s * 0.088, 0.93, 0.0),
  knee: (s: number) => V(s * 0.093, 0.507, -0.012),
  ankle: (s: number) => V(s * 0.097, 0.088, 0.024),
  ball: (s: number) => V(s * 0.104, 0.022, -0.112),
  toe: (s: number) => V(s * 0.106, 0.016, -0.168),
};
export const THIGH = J.hip(1).distanceTo(J.knee(1));
export const SHIN = J.knee(1).distanceTo(J.ankle(1));
export const UPPER = J.shoulder(1).distanceTo(J.elbow(1));
export const FORE = J.elbow(1).distanceTo(J.wrist(1));
/** Ankle height above the sole with sandals on. */
export const ANKLE_H = J.ankle(1).y;

export interface Bones {
  hips: number;
  spine: number;
  chest: number;
  neck: number;
  head: number;
  upper: number[];
  fore: number[];
  hand: number[];
  fing1: number[];
  fing2: number[];
  thumb: number[];
  thigh: number[];
  shin: number[];
  foot: number[];
  toe: number[];
}

const FRONT = V(0, 0, -1), UP = V(0, 1, 0);

export function buildSkeleton(rig: Rig): Bones {
  const b: Bones = {
    hips: rig.add({ name: "hips", head: J.hipC, tail: J.waist, front: FRONT }),
    spine: rig.add({ name: "spine", head: J.waist, tail: J.chest, front: FRONT }),
    chest: rig.add({ name: "chest", head: J.chest, tail: J.neck, front: FRONT }),
    neck: rig.add({ name: "neck", head: J.neck, tail: J.head, front: FRONT }),
    head: rig.add({ name: "head", head: J.head, tail: J.crown, front: FRONT }),
    upper: [], fore: [], hand: [], fing1: [], fing2: [], thumb: [], thigh: [], shin: [], foot: [], toe: [],
  };
  for (const s of [1, -1]) {
    const k = s > 0 ? "R" : "L";
    b.upper.push(rig.add({ name: "upper" + k, head: J.shoulder(s), tail: J.elbow(s), front: FRONT }));
    b.fore.push(rig.add({ name: "fore" + k, head: J.elbow(s), tail: J.wrist(s), front: FRONT }));
    b.hand.push(rig.add({ name: "hand" + k, head: J.wrist(s), tail: J.knuckle(s), front: FRONT }));
    b.fing1.push(rig.add({ name: "fing1" + k, head: J.knuckle(s), tail: J.fingerMid(s), front: FRONT }));
    b.fing2.push(rig.add({ name: "fing2" + k, head: J.fingerMid(s), tail: J.fingerTip(s), front: FRONT }));
    b.thumb.push(rig.add({ name: "thumb" + k, head: J.thumb0(s), tail: J.thumbTip(s), front: V(-s, 0, 0) }));
    b.thigh.push(rig.add({ name: "thigh" + k, head: J.hip(s), tail: J.knee(s), front: FRONT }));
    b.shin.push(rig.add({ name: "shin" + k, head: J.knee(s), tail: J.ankle(s), front: FRONT }));
    b.foot.push(rig.add({ name: "foot" + k, head: J.ankle(s), tail: J.ball(s), front: UP }));
    b.toe.push(rig.add({ name: "toe" + k, head: J.ball(s), tail: J.toe(s), front: UP }));
  }
  return b;
}

// ------------------------------------------------------------------ torso surface

/**
 * Torso cross-sections (world y): half-width, front depth, back depth. A soft hourglass: hips
 * wider than the waist, a modest bust (added by `bust`), shoulders rounding into the neck.
 */
const TORSO: number[][] = [
  [0.835, 0.05, 0.035, 0.04],
  [0.865, 0.134, 0.068, 0.088],
  [0.905, 0.165, 0.082, 0.107],
  [0.955, 0.173, 0.084, 0.112],
  [1.005, 0.159, 0.08, 0.094],
  [1.055, 0.133, 0.072, 0.074],
  [1.1, 0.121, 0.068, 0.067],
  [1.15, 0.125, 0.073, 0.069],
  [1.2, 0.134, 0.082, 0.075],
  [1.25, 0.141, 0.09, 0.08],
  [1.3, 0.146, 0.088, 0.083],
  [1.34, 0.155, 0.079, 0.085],
  [1.372, 0.164, 0.069, 0.079],
  [1.398, 0.148, 0.058, 0.066],
  [1.418, 0.088, 0.048, 0.053],
  [1.432, 0.05, 0.043, 0.046],
];
export const TORSO_TOP = 1.432, TORSO_BOT = 0.835;
const TP = 2.5;
const _t3 = [0, 0, 0];

/** Bust drape: two soft lobes on the front, tasteful and modest. */
export function bust(x: number, y: number): number {
  const dy = y - 1.255;
  return 0.024 * Math.exp(-(((Math.abs(x) - 0.056) / 0.048) ** 2)) * Math.exp(-((dy / (dy > 0 ? 0.045 : 0.06)) ** 2));
}
/** Small of the back and the spine groove; shoulder blades. */
function backShape(x: number, y: number): number {
  return -0.004 * Math.exp(-((x / 0.02) ** 2)) * smooth(1.02, 1.12, y) * smooth(1.38, 1.25, y) + 0.005 * Math.exp(-(((Math.abs(x) - 0.07) / 0.04) ** 2) - ((y - 1.31) / 0.05) ** 2);
}

/**
 * Point on the torso at height y, angle a (0 = front, π/2 = her right, π = back), pushed out by
 * `off` (clothing) and `ease` (loose cloth: the front over the bust no longer dips between).
 */
export function torsoPt(y: number, a: number, off = 0, ease = 0, out = new THREE.Vector3()): THREE.Vector3 {
  const [W, F, B] = table(TORSO, y, _t3);
  const s = Math.sin(a), c = Math.cos(a);
  const x = (W + off) * Math.sign(s) * Math.pow(Math.abs(s), 2 / TP);
  const k = Math.pow(Math.abs(c), 2 / TP);
  let z: number;
  if (c >= 0) {
    // Front: the bust, with loose cloth spanning the cleavage instead of following it.
    const b = bust(x, y), bc = bust(0.056, y);
    z = -(F + off) * k - Math.max(b, bc * ease * smooth(0.11, 0.0, Math.abs(x))) * k;
  } else z = (B + off + backShape(x, y)) * k;
  return out.set(x, y, z);
}

// ------------------------------------------------------------------ parts

/** Ring sampler around an axis (a → b) with radius r(t, angle); angle 0 faces `front`. */
export function tube(a: THREE.Vector3, b: THREE.Vector3, front: THREE.Vector3, nRings: number, nSeg: number, r: (t: number, ang: number) => number, t0 = 0, t1 = 1): THREE.Vector3[][] {
  const ax = new THREE.Vector3().subVectors(b, a);
  const L = ax.length();
  ax.normalize();
  const fz = front.clone().addScaledVector(ax, -front.dot(ax)).normalize();
  const fx = new THREE.Vector3().crossVectors(ax, fz).normalize();
  const rings: THREE.Vector3[][] = [];
  for (let j = 0; j < nRings; j++) {
    const t = t0 + ((t1 - t0) * j) / (nRings - 1);
    const c = a.clone().addScaledVector(ax, L * t);
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < nSeg; i++) {
      const ang = (i / nSeg) * Math.PI * 2;
      const rr = r(t, ang);
      ring.push(c.clone().addScaledVector(fz, Math.cos(ang) * rr).addScaledVector(fx, Math.sin(ang) * rr));
    }
    rings.push(ring);
  }
  return rings;
}

export const SKIN = "#f4d3bd";
const SKIN_SH = "#efc4ad";

/** Skin: torso (under the clothes), neck, arms, hands, legs and bare feet. */
export function skinParts(rig: Rig, B: Bones): Geo[] {
  const out: Geo[] = [];
  // Torso.
  {
    const rings: THREE.Vector3[][] = [];
    const NY = 30, NA = 36;
    for (let j = 0; j <= NY; j++) {
      const y = TORSO_BOT + ((TORSO_TOP - TORSO_BOT) * j) / NY;
      const ring: THREE.Vector3[] = [];
      for (let i = 0; i < NA; i++) ring.push(torsoPt(y, (i / NA) * Math.PI * 2));
      rings.push(ring);
    }
    const g = loft(rings, false, true, true);
    out.push(part(g, SKIN, M.skin, envelope(rig, [B.hips, B.spine, B.chest, B.neck, B.upper[0], B.upper[1], B.thigh[0], B.thigh[1]], 4, 0.03, { [B.upper[0]]: 0.45, [B.upper[1]]: 0.45, [B.thigh[0]]: 0.5, [B.thigh[1]]: 0.5, [B.neck]: 0.6 })));
  }
  // Neck: slender, a touch forward, into the head behind the jaw; a soft shade under the chin.
  {
    const a = V(0, 1.37, 0.018), b = V(0, 1.517, 0.0);
    const rings = tube(a, b, FRONT, 9, 18, (t, ang) => (0.045 - 0.006 * smooth(0.2, 0.8, t) + 0.003 * smooth(0.0, 0.12, 0.12 - t)) * (1 + 0.06 * Math.cos(ang)) * (1 - 0.05 * Math.cos(2 * ang)));
    const g = loft(rings, false);
    out.push(shade(part(g, SKIN, M.skin, (p) => {
      const t = (p.y - 1.37) / 0.147;
      return [[B.chest, 1 - smooth(0.0, 0.35, t)], [B.neck, Math.min(smooth(0.0, 0.35, t), 1 - smooth(0.55, 0.9, t))], [B.head, smooth(0.55, 0.9, t)]];
    }), (p) => 1 - 0.07 * smooth(1.445, 1.5, p.y) * smooth(0.0, -0.03, p.z)));
  }
  // Arms: one tube shoulder → wrist (deltoid, slim upper arm, soft elbow, tapering forearm, a
  // flattened wrist), then the hand.
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1;
    const sh = J.shoulder(s), el = J.elbow(s), wr = J.wrist(s);
    const top = sh.clone().add(V(-s * 0.03, -0.004, 0));
    const L1 = top.distanceTo(el), L2 = el.distanceTo(wr);
    const tEl = L1 / (L1 + L2);
    const ax = (t: number) => (t < tEl ? top.clone().lerp(el, t / tEl) : el.clone().lerp(wr, (t - tEl) / (1 - tEl)));
    const rad = (t: number, ang: number) => {
      const u = t < tEl ? t / tEl : 1 + (t - tEl) / (1 - tEl);
      const base = u < 1 ? lerp(0.048, 0.038, smooth(0.15, 0.95, u)) + 0.007 * Math.exp(-(((u - 0.3) / 0.2) ** 2)) : lerp(0.037, 0.022, smooth(1.12, 1.98, u)) + 0.004 * Math.exp(-(((u - 1.25) / 0.15) ** 2));
      const flat = u > 1.6 ? 1 - 0.22 * smooth(1.6, 2.0, u) * Math.abs(Math.sin(ang)) : 1;
      return base * flat;
    };
    const N = 22;
    const rings: THREE.Vector3[][] = [];
    for (let j = 0; j <= N; j++) {
      const t = j / N;
      const c = ax(t);
      const d = (t < tEl ? el.clone().sub(top) : wr.clone().sub(el)).normalize();
      const fz = FRONT.clone().addScaledVector(d, -FRONT.dot(d)).normalize();
      const fx = new THREE.Vector3().crossVectors(d, fz);
      const ring: THREE.Vector3[] = [];
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * Math.PI * 2;
        const r = rad(t, ang);
        ring.push(c.clone().addScaledVector(fz, Math.cos(ang) * r).addScaledVector(fx, Math.sin(ang) * r));
      }
      rings.push(ring);
    }
    const g = loft(rings, false, true, false);
    out.push(part(g, SKIN, M.skin, (p) => {
      const wU = smooth(-0.03, 0.035, p.y - el.y);
      const wS = smooth(sh.y - 0.06, sh.y + 0.03, p.y) * 0.8;
      const wH = 1 - smooth(wr.y - 0.012, wr.y + 0.012, p.y);
      return [[B.chest, wS], [B.upper[k], wU * (1 - wS)], [B.fore[k], (1 - wU) * (1 - wH)], [B.hand[k], (1 - wU) * wH]];
    }));
    out.push(...hand(rig, B, k));
  }
  // Legs: thigh into knee, calf, slim ankle.
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1;
    const hp = J.hip(s), kn = J.knee(s), an = J.ankle(s);
    const top = hp.clone().add(V(-s * 0.012, 0.02, 0));
    const L1 = top.distanceTo(kn), L2 = kn.distanceTo(an);
    const tK = L1 / (L1 + L2);
    const N = 28;
    const rings: THREE.Vector3[][] = [];
    for (let j = 0; j <= N; j++) {
      const t = j / N;
      const u = t < tK ? t / tK : 1 + (t - tK) / (1 - tK);
      const c = t < tK ? top.clone().lerp(kn, u) : kn.clone().lerp(an, u - 1);
      const d = (t < tK ? kn.clone().sub(top) : an.clone().sub(kn)).normalize();
      const fz = FRONT.clone().addScaledVector(d, -FRONT.dot(d)).normalize();
      const fx = new THREE.Vector3().crossVectors(d, fz);
      const ring: THREE.Vector3[] = [];
      for (let i = 0; i < 18; i++) {
        const ang = (i / 18) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        let r: number;
        if (u < 1) {
          r = lerp(0.081, 0.056, smooth(0.0, 1.0, u)) + 0.01 * Math.exp(-(((u - 0.3) / 0.3) ** 2));
          // Inner thigh fuller, outer flatter toward the knee; kneecap in front.
          r *= 1 + 0.025 * (-sa * s) * (1 - u) + 0.03 * Math.max(0, sa * s) * Math.exp(-(((u - 0.25) / 0.25) ** 2));
          // Under the shorts (above the hem at u ~ 0.55) slimmer, so it never pokes through them.
          r *= 1 - 0.16 * (1 - smooth(0.22, 0.48, u)) * (0.7 + 0.3 * Math.max(0, -sa * s));
          r += 0.007 * Math.max(0, ca) ** 3 * Math.exp(-(((u - 0.95) / 0.08) ** 2));
        } else {
          const v = u - 1;
          r = lerp(0.052, 0.03, smooth(0.0, 0.92, v));
          // Calf at the back (upper third), shin bone in front, a slim ankle.
          r += 0.021 * Math.max(0, -ca) ** 1.5 * Math.exp(-(((v - 0.28) / 0.17) ** 2));
          r += 0.004 * Math.max(0, -sa * s) * Math.exp(-(((v - 0.3) / 0.2) ** 2));
          r += 0.004 * Math.max(0, ca) ** 3 * Math.exp(-(((v - 0.03) / 0.06) ** 2));
          r *= 1 - 0.1 * smooth(0.75, 1.0, v) * Math.abs(ca);
        }
        ring.push(c.clone().addScaledVector(fz, ca * r).addScaledVector(fx, sa * r));
      }
      rings.push(ring);
    }
    const g = loft(rings, false, true, true);
    out.push(part(g, SKIN, M.skin, (p) => {
      const wT = smooth(kn.y - 0.03, kn.y + 0.035, p.y);
      const wH = smooth(hp.y - 0.04, hp.y + 0.05, p.y) * 0.5;
      return [[B.hips, wH], [B.thigh[k], wT * (1 - wH)], [B.shin[k], (1 - wT) * smooth(an.y - 0.005, an.y + 0.04, p.y)], [B.foot[k], (1 - wT) * (1 - smooth(an.y - 0.005, an.y + 0.04, p.y))]];
    }));
    out.push(foot(rig, B, k));
  }
  return out;
}

/** Slender relaxed hand: palm, four fingers in two segments, a thumb, nails painted pale. */
function hand(rig: Rig, B: Bones, k: number): Geo[] {
  void rig;
  const s = k === 0 ? 1 : -1;
  const wr = J.wrist(s), kn = J.knuckle(s);
  const parts: Geo[] = [];
  // Palm: a rounded slab, thin across (x), wider front-back (z), from the wrist to the knuckles.
  {
    const rings = tube(wr.clone().add(V(0, 0.012, 0)), kn.clone().add(V(0, -0.004, 0)), FRONT, 8, 16, (t, ang) => {
      const w = lerp(0.024, 0.037, smooth(0.0, 0.6, t)) * (1 - 0.15 * smooth(0.85, 1, t));
      const th = lerp(0.016, 0.012, t);
      const c = Math.cos(ang), sn = Math.sin(ang);
      return 1 / Math.sqrt((c / w) ** 2 + (sn / th) ** 2);
    });
    const g = loft(rings, false, true, true);
    parts.push(part(g, SKIN, M.skin, (p) => [[B.fore[k], smooth(wr.y - 0.012, wr.y + 0.01, p.y)], [B.hand[k], 1 - smooth(wr.y - 0.012, wr.y + 0.01, p.y)]]));
  }
  // Fingers: index (front) … little finger (back), slightly different lengths.
  const zs = [-0.026, -0.009, 0.008, 0.024];
  const lens = [0.068, 0.074, 0.07, 0.056];
  for (let f = 0; f < 4; f++) {
    const base = V(kn.x + s * 0.001, kn.y + 0.004, kn.z + zs[f] * 0.95);
    const tip = base.clone().add(V(s * 0.003, -lens[f], 0.002 * f - 0.004));
    const rings = tube(base, tip, V(-s, 0, 0), 9, 10, (t) => lerp(0.0079, 0.0058, t) * (1 - 0.55 * smooth(0.82, 1.0, t)) + 0.0006 * Math.exp(-(((t - 0.45) / 0.06) ** 2)));
    const g = loft(rings, false, true, true);
    const mid = base.y - lens[f] * 0.5;
    parts.push(shade(part(g, SKIN, M.skin, (p) => {
      const w1 = smooth(base.y + 0.006, base.y - 0.008, p.y);
      const w2 = smooth(mid + 0.007, mid - 0.007, p.y);
      return [[B.hand[k], 1 - w1], [B.fing1[k], w1 * (1 - w2)], [B.fing2[k], w2]];
    }), (p) => 1 + 0.06 * smooth(tip.y + 0.012, tip.y + 0.002, p.y) * smooth(-0.002, 0.004, -s * (p.x - tip.x))));
  }
  // Thumb.
  {
    const t0 = J.thumb0(s), t1 = J.thumbTip(s);
    const rings = tube(t0.clone().add(V(-s * 0.004, 0.022, 0.01)), t1, V(-s, 0, 0), 9, 10, (t) => lerp(0.012, 0.0072, t) * (1 - 0.5 * smooth(0.82, 1.0, t)));
    const g = loft(rings, false, true, true);
    parts.push(part(g, SKIN, M.skin, (p) => {
      const w = smooth(t0.y + 0.01, t0.y - 0.008, p.y);
      return [[B.hand[k], 1 - w], [B.thumb[k], w]];
    }));
  }
  return parts;
}

/** Bare foot (heel, arch, ball, toes) sitting on the sandal sole at y = 0.013. */
function foot(rig: Rig, B: Bones, k: number): Geo {
  void rig;
  const s = k === 0 ? 1 : -1;
  const an = J.ankle(s), bl = J.ball(s);
  const SOLE = 0.013;
  const HEEL = 0.062, TIP = -0.172;
  const N = 20, NA = 16;
  const rings: THREE.Vector3[][] = [];
  for (let j = 0; j <= N; j++) {
    const t = j / N;
    const z = lerp(HEEL, TIP, t);
    // Width: narrow heel, waist at the arch, widest at the ball, rounded toes.
    const w = (0.024 + 0.014 * smooth(0.0, 0.62, t) + 0.006 * Math.exp(-(((t - 0.68) / 0.12) ** 2))) * Math.sqrt(Math.max(0.02, 1 - smooth(0.82, 1.0, t) ** 2)) * Math.sqrt(Math.max(0.04, smooth(-0.04, 0.1, t)));
    // Height: up the instep to the ankle, low over the toes.
    const h = lerp(0.075, 0.03, smooth(0.2, 0.75, t)) * Math.sqrt(Math.max(0.03, 1 - smooth(0.85, 1.0, t) ** 2)) * Math.sqrt(Math.max(0.05, smooth(-0.05, 0.12, t)));
    const cx = s * (0.098 + 0.008 * smooth(0.5, 1.0, t)) - s * 0.004 * Math.exp(-(((t - 0.95) / 0.1) ** 2));
    const ring: THREE.Vector3[] = [];
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      // Flat sole, domed top; the arch lifts on the inner side.
      const top = ca > 0;
      let y = top ? SOLE + h * Math.pow(ca, 0.8) : SOLE - 0.002 * ca * ca;
      if (!top && sa * s < 0) y += 0.006 * Math.exp(-(((t - 0.4) / 0.15) ** 2)) * Math.abs(sa);
      ring.push(V(cx + sa * w * (top ? 1 : 1.04), y, z));
    }
    rings.push(ring);
  }
  const g = loft(rings, false, true, true);
  return part(g, SKIN, M.skin, (p) => {
    const wt = smooth(bl.z + 0.015, bl.z - 0.02, p.z);
    const ws = smooth(an.y - 0.02, an.y + 0.02, p.y) * smooth(an.z - 0.06, an.z, p.z);
    return [[B.shin[k], ws], [B.foot[k], (1 - wt) * (1 - ws)], [B.toe[k], wt * (1 - ws)]];
  });
}

export { SKIN_SH };
