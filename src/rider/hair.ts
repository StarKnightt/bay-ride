import * as THREE from "three";
import { M } from "../world/geo";
import { HEAD_C, headR } from "./head";
import { part, smooth, type Geo } from "./body";
import { Chain, Rig, V, segDist } from "./rig";

/**
 * Her hair: warm chestnut, shoulder length, soft waves with the ends flipping out, a deep side part
 * on her left and a fringe swept across to her right, a few loose strands framing the face. A
 * scalp shell carries the volume; locks are tapered ribbons skinned to nine spring chains round the
 * head (and one for the fringe), so it all swings with her steps, turns and the wind.
 */

const HAIR = new THREE.Color("#55301e");
const HAIR_LIGHT = new THREE.Color("#8a5634");
const HAIR_DARK = new THREE.Color("#3a2015");

/** Unit direction from the head centre: az 0 = front (-Z), + toward her right (+X); el up. */
export const dirOf = (az: number, el: number) => V(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
const surf = (az: number, el: number, off: number) => {
  const d = dirOf(az, el);
  return d.multiplyScalar(headR(d) + off).add(HEAD_C);
};

/** Hairline elevation by |azimuth|: forehead, temples, in front of the ears, behind them, nape. */
const HL: [number, number][] = [[0, 0.42], [0.55, 0.36], [0.95, 0.14], [1.3, -0.04], [1.65, -0.18], [2.1, -0.38], [2.6, -0.62], [Math.PI, -0.72]];
export function hairline(az: number): number {
  const a = Math.min(Math.PI, Math.abs(az));
  for (let i = 1; i < HL.length; i++) {
    const [a0, e0] = HL[i - 1], [a1, e1] = HL[i];
    if (a <= a1) return e0 + (e1 - e0) * (0.5 - 0.5 * Math.cos(((a - a0) / (a1 - a0)) * Math.PI));
  }
  return HL[HL.length - 1][1];
}
/** Volume of the hair over the scalp: fuller on the crown and at the back. */
export const shellOff = (az: number, el: number) => 0.007 + 0.011 * smooth(-0.3, 0.9, el) + 0.006 * smooth(1.2, 2.6, Math.abs(az)) * smooth(-0.8, 0.3, el);

const PART = -0.42;

/** Chain azimuths round the head (front-side, side, back-side, back) and the fringe. */
export const CHAIN_AZ = [-2.62, -2.05, -1.5, -1.0, 1.0, 1.5, 2.05, 2.62, Math.PI];
const HANG_EL = -0.08;
const TIP_Y = -0.228;

/**
 * Hanging part of a lock at azimuth az: from the head at elevation HANG_EL down to the tip, a bell
 * that widens over the shoulders, waves in two directions and flips outward at the end.
 */
function hang(az: number, t: number, len: number, phase: number, flip: number, out = new THREE.Vector3()): THREE.Vector3 {
  const s0 = surf(az, HANG_EL, shellOff(az, HANG_EL) - 0.002);
  const r0 = Math.hypot(s0.x - HEAD_C.x, s0.z - HEAD_C.z);
  const back = smooth(1.2, 2.8, Math.abs(az));
  const y = s0.y + (TIP_Y * len - (s0.y - HEAD_C.y)) * t;
  let r = r0 + 0.012 + 0.03 * Math.pow(t, 1.1) * (1 - 0.3 * back) + flip * 0.03 * smooth(0.7, 1.0, t);
  r += 0.009 * Math.sin(t * 8.5 + phase) * smooth(0.1, 0.5, t);
  const a = az + (0.05 * Math.sin(t * 7.0 + phase * 1.7) * smooth(0.1, 0.6, t)) / Math.max(0.6, r * 10);
  return out.set(HEAD_C.x + Math.sin(a) * r, y + 0.006 * flip * smooth(0.8, 1, t), HEAD_C.z - Math.cos(a) * r);
}

export interface HairRig {
  chains: Chain[];
  /** Bone indices per chain (segment k = particle k → k+1). */
  bones: number[][];
  /** Bind-pose particle positions per chain. */
  bind: THREE.Vector3[][];
  fringe: Chain;
  fringeBones: number[];
  fringeBind: THREE.Vector3[];
}

/** Add the hair chains to the skeleton (bind pose). */
export function hairRig(rig: Rig): HairRig {
  const chains: Chain[] = [], bones: number[][] = [], bind: THREE.Vector3[][] = [];
  const N = 5;
  CHAIN_AZ.forEach((az, c) => {
    const pts: THREE.Vector3[] = [];
    for (let j = 0; j < N; j++) pts.push(hang(az, j / (N - 1), 1, 0, 0.5));
    const ch = new Chain(N, [4.2, 2.7, 1.8, 1.25], 2.6, 9.8, 0.9);
    chains.push(ch);
    bind.push(pts);
    const bs: number[] = [];
    for (let j = 0; j < N - 1; j++) bs.push(rig.add({ name: `hair${c}_${j}`, head: pts[j], tail: pts[j + 1], front: V(Math.sin(az), 0, -Math.cos(az)) }));
    bones.push(bs);
  });
  const fb = [surf(PART + 0.2, 0.95, 0.02), surf(0.3, 0.55, 0.024), surf(0.8, 0.25, 0.02)];
  const fringe = new Chain(3, [9, 6], 3.2, 4, 0.4);
  const fringeBones = [rig.add({ name: "fringe0", head: fb[0], tail: fb[1], front: V(0, 0, -1) }), rig.add({ name: "fringe1", head: fb[1], tail: fb[2], front: V(0, 0, -1) })];
  return { chains, bones, bind, fringe, fringeBones, fringeBind: fb };
}

/**
 * Soft clump of hair along a path: an elliptical cross-section (half-width w across, th outward
 * along `ups`, a flatter belly), rounded at the tip. Normals lean toward "out from the head" so the
 * cel step runs over the hair as one soft mass. Returns the geometry, each vertex's path parameter
 * and how far round the edge of the clump it sits (0 = middle of the face, 1 = its edge or belly).
 */
function ribbon(pts: THREE.Vector3[], ups: THREE.Vector3[], w: number[], th: number[], belly = 0.45): { g: Geo; t: number[]; edge: number[] } {
  const n = pts.length, S = 8;
  const pos: number[] = [], tp: number[] = [], ed: number[] = [], idx: number[] = [], nrm: number[] = [];
  const tan = new THREE.Vector3(), b = new THREE.Vector3(), nn = new THREE.Vector3(), out = new THREE.Vector3(), m = new THREE.Vector3();
  for (let k = 0; k < n; k++) {
    const t = k / (n - 1);
    tan.subVectors(pts[Math.min(k + 1, n - 1)], pts[Math.max(k - 1, 0)]).normalize();
    b.crossVectors(tan, ups[k]).normalize();
    nn.crossVectors(b, tan).normalize();
    const P = pts[k];
    // Rounded tip: the last stretch closes on a quarter ellipse instead of a point.
    const tip = t > 0.84 ? Math.sqrt(Math.max(0, 1 - ((t - 0.84) / 0.16) ** 2)) : 1;
    const W = w[k] * tip, T = th[k] * (0.35 + 0.65 * tip);
    out.set(P.x - HEAD_C.x, Math.max(0, P.y - HEAD_C.y), P.z - HEAD_C.z).normalize();
    for (let e = 0; e < S; e++) {
      const f = (e / S) * Math.PI * 2, c = Math.cos(f), sn = Math.sin(f);
      const tt = sn > 0 ? T : T * belly;
      pos.push(P.x + b.x * c * W + nn.x * sn * tt, P.y + b.y * c * W + nn.y * sn * tt, P.z + b.z * c * W + nn.z * sn * tt);
      m.copy(b).multiplyScalar(c / Math.max(W, 1e-4)).addScaledVector(nn, sn / Math.max(tt, 1e-4)).normalize();
      m.multiplyScalar(0.45).addScaledVector(out.dot(nn) >= 0 ? nn : out, 0.25).addScaledVector(out, 0.3).normalize();
      nrm.push(m.x, m.y, m.z);
      tp.push(t);
      ed.push(sn > 0 ? Math.abs(c) ** 2 : 1);
    }
  }
  for (let k = 0; k < n - 1; k++)
    for (let e = 0; e < S; e++) {
      const a = k * S + e, bb = k * S + ((e + 1) % S), c = a + S, d = bb + S;
      idx.push(a, bb, c, bb, d, c);
    }
  for (let e = 1; e < S - 1; e++) idx.push(0, e + 1, e);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  // Face winding outward: flip if the first quad faces into the clump.
  const A = new THREE.Vector3(pos[0], pos[1], pos[2]), B2 = new THREE.Vector3(pos[3], pos[4], pos[5]), C2 = new THREE.Vector3(pos[S * 3], pos[S * 3 + 1], pos[S * 3 + 2]);
  const fn = new THREE.Vector3().crossVectors(B2.clone().sub(A), C2.clone().sub(A));
  if (fn.dot(A.clone().sub(pts[0])) < 0) {
    const ix = g.index!.array as Uint16Array | Uint32Array;
    for (let i = 0; i < ix.length; i += 3) {
      const tmp = ix[i + 1];
      ix[i + 1] = ix[i + 2];
      ix[i + 2] = tmp;
    }
  }
  return { g, t: tp, edge: ed };
}

const hsh = (k: number) => {
  const v = Math.sin(k * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Colour a lock: darker at the roots, a soft light band where it turns over the head, sun-kissed
 * toward the ends, and darker along the clump's edges and underside so clumps read without ink.
 */
function tintLock(g: Geo, r: { t: number[]; edge: number[] }, tone: number, sun: number, band = 0.25): void {
  const c = g.attributes.color as THREE.BufferAttribute;
  const col = new THREE.Color();
  for (let i = 0; i < c.count; i++) {
    const t = r.t[i];
    col.copy(HAIR).lerp(HAIR_DARK, 0.35 * (1 - smooth(0.0, 0.3, t))).lerp(HAIR_LIGHT, sun * smooth(0.45, 1.0, t));
    col.lerp(HAIR_LIGHT, band * Math.exp(-(((t - 0.3) / 0.1) ** 2)) * (1 - r.edge[i]));
    col.lerp(HAIR_DARK, 0.45 * smooth(0.35, 1.0, r.edge[i]));
    col.multiplyScalar(tone);
    c.setXYZ(i, col.r, col.g, col.b);
  }
}

export function hairParts(rig: Rig, H: HairRig, headBone: number): Geo[] {
  const out: Geo[] = [];
  // Weights for a hanging lock at azimuth az: the head near the root, then the two nearest chains.
  const chainW = (az: number, p: THREE.Vector3, wHead: number): [number, number][] => {
    let best = 0, bd = 1e9, second = 0, sd = 1e9;
    CHAIN_AZ.forEach((ca, c) => {
      const d = Math.abs(Math.atan2(Math.sin(az - ca), Math.cos(az - ca)));
      if (d < bd) {
        second = best;
        sd = bd;
        best = c;
        bd = d;
      } else if (d < sd) {
        second = c;
        sd = d;
      }
    });
    const f = sd > 1e-6 ? bd / (bd + sd) : 0;
    const res: [number, number][] = [[headBone, wHead]];
    for (const [c, cw] of [[best, 1 - f], [second, f]] as const) {
      const bs = H.bones[c];
      let tot = 0;
      const ws = bs.map((b) => {
        const [, d] = segDist(p, rig.h0[b], rig.t0[b]);
        const w = Math.pow(1 / (d + 0.015), 6);
        tot += w;
        return w;
      });
      bs.forEach((b, k) => res.push([b, (1 - wHead) * cw * (ws[k] / tot)]));
    }
    return res;
  };

  // Scalp shell above the hairline.
  {
    const C = 64, R = 18;
    const pos: number[] = [];
    for (let i = 0; i < C; i++) {
      const az = -Math.PI + (i / C) * Math.PI * 2;
      const e0 = hairline(az);
      for (let j = 0; j < R; j++) {
        const el = e0 + (Math.PI / 2 - 0.02 - e0) * Math.pow(j / (R - 1), 0.9);
        const off = j === 0 ? -0.004 : shellOff(az, el) * smooth(0.0, 0.18, el - e0) - 0.003 * (1 - smooth(0.0, 0.18, el - e0));
        const p = surf(az, el, off);
        pos.push(p.x, p.y, p.z);
      }
    }
    const top = surf(0, Math.PI / 2, shellOff(0, Math.PI / 2));
    pos.push(top.x, top.y, top.z);
    const idx: number[] = [];
    for (let i = 0; i < C; i++) {
      const i2 = (i + 1) % C;
      for (let j = 0; j < R - 1; j++) {
        const a = i * R + j, b = i2 * R + j, c = a + 1, d = b + 1;
        idx.push(a, c, b, b, c, d);
      }
      idx.push(i * R + R - 1, C * R, i2 * R + R - 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const pg = part(g, HAIR, M.hair, () => [[headBone, 1]]);
    // The part: a slightly darker parting line from the forehead back toward the crown.
    const c = pg.attributes.color as THREE.BufferAttribute, pa = pg.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < c.count; i++) {
      v.fromBufferAttribute(pa, i).sub(HEAD_C).normalize();
      const az = Math.atan2(v.x, -v.z), el = Math.asin(v.y);
      const dk = Math.exp(-((((az - PART) * Math.cos(el)) / 0.035) ** 2)) * smooth(0.3, 0.6, el) * smooth(1.45, 1.1, el);
      const band = 1 + 0.12 * Math.exp(-(((el - 0.95) / 0.12) ** 2)) * smooth(1.2, 2.4, Math.abs(az) + 0.8);
      const k = (1 - 0.3 * dk) * band;
      c.setXYZ(i, c.getX(i) * k, c.getY(i) * k, c.getZ(i) * k);
    }
    out.push(pg);
  }

  // Surface strands combed away from the part over the crown (break up the shell).
  for (let k = 0; k < 18; k++) {
    const side = k % 2 ? 1 : -1;
    const az0 = PART + side * 0.04, el0 = 0.55 + 0.75 * (Math.floor(k / 2) / 8);
    const az1 = side > 0 ? 0.9 + 1.9 * (Math.floor(k / 2) / 8) + 0.2 * hsh(k) : -1.3 - 1.6 * (Math.floor(k / 2) / 8);
    const el1 = HANG_EL + 0.18;
    const pts: THREE.Vector3[] = [], ups: THREE.Vector3[] = [], w: number[] = [], th: number[] = [];
    const n = 12;
    for (let j = 0; j < n; j++) {
      const t = j / (n - 1);
      const az = az0 + (az1 - az0) * Math.pow(t, 0.8);
      const el = el0 + (el1 - el0) * Math.pow(t, 1.3);
      const d = dirOf(az, el);
      pts.push(surf(az, el, shellOff(az, el) + 0.0015));
      ups.push(d);
      w.push((0.011 + 0.005 * hsh(k + 3)) * (0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, 0.1 + 0.9 * t))));
      th.push(0.0026);
    }
    const r = ribbon(pts, ups, w, th);
    const pg = part(r.g, HAIR, M.hair, () => [[headBone, 1]]);
    tintLock(pg, r, 0.95 + 0.12 * hsh(k + 9), 0.3);
    out.push(pg);
  }

  // Hanging locks all round, behind the face: from under the shell down past the ears to the
  // shoulders, alternating long and short, waves out of phase, the ends flipping out.
  const NL = 32;
  for (let k = 0; k < NL; k++) {
    const u = k / NL;
    const az = 1.02 + u * (2 * Math.PI - 2.04) + (hsh(k) - 0.5) * 0.06;
    const aw = Math.atan2(Math.sin(az), Math.cos(az));
    // Ragged, layered hem: most reach the shoulders, every third a shorter layer.
    const len = 0.9 + 0.16 * hsh(k + 1) - (k % 3 === 1 ? 0.2 + 0.08 * hsh(k + 11) : 0);
    const phase = hsh(k + 2) * 6.28;
    const flip = 0.6 + 0.6 * hsh(k + 4);
    const pts: THREE.Vector3[] = [], ups: THREE.Vector3[] = [], w: number[] = [], th: number[] = [];
    // Over the scalp from the crown, then hanging.
    const n1 = 6, n2 = 14;
    const elR = 0.85 - 0.25 * smooth(1.0, 3.0, Math.abs(aw));
    for (let j = 0; j < n1; j++) {
      const t = j / (n1 - 1);
      const el = elR + (HANG_EL - elR) * t;
      // Combed back from the part over the crown, but never forward over the temples.
      let azz = aw + (PART - aw) * 0.18 * (1 - t) ** 2 * (Math.abs(aw) < 2.2 ? 1 : 0.2);
      if (el < 0.55 && Math.abs(azz) < 1.05) azz = Math.sign(aw) * 1.05;
      pts.push(surf(azz, el, shellOff(azz, el) - 0.003 + 0.004 * t));
      ups.push(dirOf(azz, el));
    }
    for (let j = 1; j <= n2; j++) {
      const t = j / n2;
      const p = hang(aw, t, len, phase, flip);
      // Alternate locks form an inner layer, a little shorter and closer in.
      if (k % 2) {
        const kk = 1 - 0.08 * smooth(0.0, 0.4, t);
        p.x = HEAD_C.x + (p.x - HEAD_C.x) * kk;
        p.z = HEAD_C.z + (p.z - HEAD_C.z) * kk;
      }
      pts.push(p);
      ups.push(V(Math.sin(aw), 0.15, -Math.cos(aw)).normalize());
    }
    const n = pts.length;
    for (let j = 0; j < n; j++) {
      const t = j / (n - 1);
      const wd = (0.02 + 0.007 * hsh(k + 6)) * (j < n1 ? 0.85 + 0.15 * (j / n1) : 1) * (1 - 0.45 * Math.pow(Math.max(0, (t - 0.45) / 0.55), 1.3));
      w.push(wd);
      th.push(0.0075 * (0.5 + 0.5 * wd / 0.024));
    }
    const r = ribbon(pts, ups, w, th);
    const tH = n1 / (n - 1);
    const pg = part(r.g, HAIR, M.hair, (p, i) => chainW(aw, p, 1 - smooth(tH * 0.7, tH + 0.12, r.t[i])), (p) => 0.35 * smooth(HEAD_C.y - 0.06, HEAD_C.y - 0.24, p.y));
    tintLock(pg, r, 0.92 + 0.16 * hsh(k + 7), 0.55 + 0.4 * hsh(k + 8), 0.3);
    out.push(pg);
  }

  // Face-framing strands: two thin wavy locks on each side, in front of the ears, to the jaw.
  for (const s of [1, -1]) {
    for (let k = 0; k < 2; k++) {
      const az0 = s * (0.82 + 0.13 * k), el0 = 0.3 - 0.06 * k;
      const pts: THREE.Vector3[] = [], ups: THREE.Vector3[] = [], w: number[] = [], th: number[] = [];
      const n = 16;
      for (let j = 0; j < n; j++) {
        const t = j / (n - 1);
        const el = el0 + (-0.95 - el0) * t;
        const az = az0 + s * (0.18 + 0.1 * k) * t + s * 0.05 * Math.sin(t * 8 + k);
        const d = dirOf(az, el);
        const off = 0.008 + 0.014 * smooth(0.0, 0.5, t) + 0.006 * smooth(0.6, 1, t);
        pts.push(surf(az, el, off));
        ups.push(d);
        w.push((0.0095 - 0.002 * k) * (1 - Math.pow(t, 2) * 0.55) * (0.6 + 0.4 * smooth(0, 0.15, t)));
        th.push(0.0035);
      }
      const r = ribbon(pts, ups, w, th);
      const azc = s * 1.0;
      const pg = part(r.g, HAIR, M.hair, (p, i) => chainW(azc, p, 1 - smooth(0.2, 0.55, r.t[i])), (p) => 0.4 * smooth(HEAD_C.y - 0.02, HEAD_C.y - 0.1, p.y));
      tintLock(pg, r, 1.02, 0.7);
      out.push(pg);
    }
  }

  // Fringe: broad locks from the side part sweeping across the forehead to her right temple, the
  // longest reaching the cheekbone; a few short ones falling to her left.
  const NF = 6;
  for (let k = 0; k < NF; k++) {
    const u = k / (NF - 1);
    const az0 = PART + 0.02 + 0.08 * u, el0 = 1.02 - 0.24 * u;
    const az1 = 0.05 + 1.05 * u + 0.05 * (hsh(k) - 0.5), el1 = 0.3 - 0.28 * u - 0.03 * hsh(k + 1);
    const pts: THREE.Vector3[] = [], ups: THREE.Vector3[] = [], w: number[] = [], th: number[] = [];
    const n = 16;
    for (let j = 0; j < n; j++) {
      const t = j / (n - 1);
      const az = az0 + (az1 - az0) * smooth(0.0, 1.0, Math.pow(t, 0.85));
      const el = el0 + (el1 - el0) * Math.pow(t, 1.2) + 0.08 * Math.sin(Math.PI * t) * (1 - u);
      const d = dirOf(az, el);
      // Lift off the forehead (volume) and curl in a little at the end.
      const off = shellOff(az, Math.max(el, 0.3)) + 0.003 + 0.012 * Math.sin(Math.PI * Math.min(1, t * 1.1)) * (1 - 0.5 * u) - 0.006 * smooth(0.8, 1, t);
      pts.push(surf(az, el, off));
      ups.push(d);
      w.push((0.026 + 0.006 * hsh(k + 3)) * (1 - 0.6 * Math.pow(t, 1.4)) * (0.7 + 0.3 * smooth(0, 0.2, t)));
      th.push(0.0058);
    }
    const r = ribbon(pts, ups, w, th);
    const pg = part(r.g, HAIR, M.hair, (p, i) => {
      const t = r.t[i];
      return [[headBone, 1 - smooth(0.15, 0.5, t)], [H.fringeBones[0], smooth(0.15, 0.5, t) * (1 - smooth(0.5, 0.85, t))], [H.fringeBones[1], smooth(0.5, 0.85, t)]];
    });
    tintLock(pg, r, 1.0 + 0.1 * hsh(k + 5), 0.35);
    out.push(pg);
  }
  for (let k = 0; k < 4; k++) {
    const az0 = PART - 0.02 + 0.03 * k, el0 = 0.98 - 0.08 * k;
    const az1 = PART - 0.12 - 0.2 * k, el1 = 0.16 - 0.06 * k;
    const pts: THREE.Vector3[] = [], ups: THREE.Vector3[] = [], w: number[] = [], th: number[] = [];
    const n = 12;
    for (let j = 0; j < n; j++) {
      const t = j / (n - 1);
      const az = az0 + (az1 - az0) * t, el = el0 + (el1 - el0) * t;
      pts.push(surf(az, el, shellOff(az, Math.max(el, 0.3)) + 0.003 + 0.008 * Math.sin(Math.PI * t)));
      ups.push(dirOf(az, el));
      w.push(0.021 * (1 - 0.55 * Math.pow(t, 1.6)));
      th.push(0.005);
    }
    const r = ribbon(pts, ups, w, th);
    const pg = part(r.g, HAIR, M.hair, () => [[headBone, 1]]);
    tintLock(pg, r, 0.97, 0.3);
    out.push(pg);
  }
  return out;
}
