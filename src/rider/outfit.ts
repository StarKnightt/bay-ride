import * as THREE from "three";
import { M, prep } from "../world/geo";
import { Chain, Rig, V, envelope, skin, type WeightFn } from "./rig";
import { J, type Bones, type Geo, flip, lerp, loft, part, shade, smooth, torsoPt, tube } from "./body";
import { HEAD_C, LENS, faceZ, headR, lensPt, lensZ } from "./head";

/**
 * Her summer clothes: a coral camisole, a loose pale sea-green linen shirt worn open with the
 * sleeves rolled above the elbow and its fronts knotted at the waist (two short tails), high-waisted
 * wide cream linen shorts with rolled cuffs, tan leather sandals, and a wide straw hat tipped back
 * with a teal ribbon (bow and two trailing tails) and tortoiseshell sunglasses worn on her face.
 */

export const COL = {
  shirt: "#bcdcc0",
  shirtIn: "#a3c8aa",
  cami: "#ec8466",
  shorts: "#f3e4c6",
  shortsSh: "#e0cfae",
  leather: "#a8693c",
  sole: "#6e4529",
  bed: "#c9a27a",
  straw: "#e3c88f",
  ribbon: "#3f9cb2",
  tort: "#5a3218",
  tortAmber: "#a8662c",
};

const FRONT = V(0, 0, -1);

/** Cloth chains: shirt tails (2) and ribbon tails (2). */
export interface ClothRig {
  tails: Chain[];
  tailBones: number[][];
  tailBind: THREE.Vector3[][];
  ribbons: Chain[];
  ribbonBones: number[][];
  ribbonBind: THREE.Vector3[][];
}

/** The knot of the shirt (bind pose). */
export const KNOT = V(-0.018, 1.105, -0.094);

/** Hat frame: on the crown, tipped back and a touch to her right. */
export const HAT_M = new THREE.Matrix4().compose(
  HEAD_C.clone().add(V(0.004, 0.052, 0.014)),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(0.17, 0.05, -0.035, "YXZ")),
  new THREE.Vector3(1, 1, 1),
);
const HAT_CROWN = { rx: 0.097, rz: 0.108, h: 0.092 };
const BRIM_R = 0.232;
/** Bow on the band (hat space), back-left. */
const BOW = V(-0.078, 0.013, 0.07);

export function clothRig(rig: Rig, B: Bones): ClothRig {
  void B;
  const tails: Chain[] = [], tailBones: number[][] = [], tailBind: THREE.Vector3[][] = [];
  for (const s of [1, -1]) {
    const a = KNOT.clone().add(V(s * 0.012, -0.012, -0.004));
    const pts = [a, a.clone().add(V(s * 0.016, -0.06, -0.006)), a.clone().add(V(s * 0.028, -0.12, -0.004))];
    tailBind.push(pts);
    tails.push(new Chain(3, [9, 6], 3.5, 6, 0.35));
    tailBones.push([0, 1].map((k) => rig.add({ name: `tail${s}_${k}`, head: pts[k], tail: pts[k + 1], front: FRONT })));
  }
  const ribbons: Chain[] = [], ribbonBones: number[][] = [], ribbonBind: THREE.Vector3[][] = [];
  for (const s of [0, 1]) {
    const b0 = BOW.clone().add(V(-0.006, -0.01, 0.006));
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < 4; k++) pts.push(b0.clone().add(V(-0.012 * k - 0.006 * s, -0.045 * k - 0.004 * s, 0.026 * k + 0.012 * s)).applyMatrix4(HAT_M));
    ribbonBind.push(pts);
    ribbons.push(new Chain(4, [6, 3.5, 2.2], 2.6, 5, 0.9));
    ribbonBones.push([0, 1, 2].map((k) => rig.add({ name: `ribbon${s}_${k}`, head: pts[k], tail: pts[k + 1], front: V(-1, 0, 0) })));
  }
  return { tails, tailBones, tailBind, ribbons, ribbonBones, ribbonBind };
}

/** Grid surface from a function of (u, v) in [0,1]², optionally closed in u. */
function grid(nu: number, nv: number, f: (u: number, v: number) => THREE.Vector3, closedU = false): Geo {
  const rings: THREE.Vector3[][] = [];
  for (let j = 0; j <= nv; j++) {
    const row: THREE.Vector3[] = [];
    const n = closedU ? nu : nu + 1;
    for (let i = 0; i < n; i++) row.push(f(i / nu, j / nv));
    rings.push(row);
  }
  return loft(rings, !closedU);
}

/** Make a geometry's faces point away from `inside(p)` (a reference point per vertex). */
function orient(g: Geo, inside: (p: THREE.Vector3) => THREE.Vector3): Geo {
  const pa = g.attributes.position, na = g.attributes.normal;
  let s = 0;
  const p = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < pa.count; i += 3) {
    p.fromBufferAttribute(pa, i);
    n.fromBufferAttribute(na, i);
    s += n.dot(p.clone().sub(inside(p)));
  }
  return s < 0 ? flip(g) : g;
}
const axisIn = (p: THREE.Vector3) => V(0, p.y, 0.0);

/** Flat strap / tie (ribbon of width w, thickness th) along points, normals toward `ups`. */
export function strip(pts: THREE.Vector3[], ups: THREE.Vector3[], w: (t: number) => number, th = 0.0025): Geo {
  const n = pts.length;
  const rings: THREE.Vector3[][] = [];
  for (let k = 0; k < n; k++) {
    const tan = new THREE.Vector3().subVectors(pts[Math.min(k + 1, n - 1)], pts[Math.max(k - 1, 0)]).normalize();
    const b = new THREE.Vector3().crossVectors(tan, ups[k]).normalize();
    const nn = new THREE.Vector3().crossVectors(b, tan).normalize();
    const ww = w(k / (n - 1));
    const P = pts[k];
    rings.push([P.clone().addScaledVector(b, ww), P.clone().addScaledVector(nn, th), P.clone().addScaledVector(b, -ww), P.clone().addScaledVector(nn, -th)]);
  }
  return loft(rings, false, true, true);
}

// ------------------------------------------------------------------ camisole

export function camiParts(rig: Rig, B: Bones): Geo[] {
  const out: Geo[] = [];
  const w = envelope(rig, [B.hips, B.spine, B.chest], 4, 0.03);
  const top = (a: number) => {
    const c = Math.cos(a);
    // Straight neckline in front, a little higher at the back.
    return c > 0 ? 1.302 + 0.01 * (1 - c) : 1.312 + 0.022 * -c;
  };
  const g = grid(48, 24, (u, v) => {
    const a = u * Math.PI * 2;
    const y = lerp(1.0, top(a), v);
    return torsoPt(y, a, 0.0045, 0.6);
  }, true);
  out.push(shade(part(g, COL.cami, M.linen, w), (p) => 1 - 0.1 * smooth(1.28, 1.3, p.y)));
  // Thin straps over the shoulders.
  for (const s of [1, -1]) {
    const pts: THREE.Vector3[] = [], ups: THREE.Vector3[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k / 10;
      const a = lerp(s * 0.38, s * (Math.PI - 0.42), t);
      const y = Math.min(1.355, lerp(1.298, 1.31, t) + 0.105 * Math.sin(Math.PI * t));
      const p = torsoPt(y, a, 0.0052, 0.6);
      pts.push(p);
      ups.push(V(p.x, 0.4, p.z).normalize());
    }
    out.push(part(strip(pts, ups, () => 0.0055, 0.0015), COL.cami, M.cloth, w));
  }
  return out;
}

// ------------------------------------------------------------------ shirt

/** Half-width of the open front between the shirt panels at height y (0 below the knot). */
const gap = (y: number) => (y < 1.105 ? 0 : lerp(0.01, 0.05, smooth(1.105, 1.28, y)) - 0.004 * smooth(1.3, 1.42, y));
const HEM_BACK = 0.975, COLLAR = 1.428;

export function shirtParts(rig: Rig, B: Bones, C: ClothRig): Geo[] {
  const out: Geo[] = [];
  const body = envelope(rig, [B.hips, B.spine, B.chest, B.upper[0], B.upper[1]], 4, 0.03, { [B.upper[0]]: 0.55, [B.upper[1]]: 0.55, [B.hips]: 0.8 });
  // One sheet from her right front edge round the back to her left front edge: u 0 → 1, v from
  // the hem (0) to the collar (1). The fronts are drawn in to the knot (round the body, never
  // through it).
  const TAU = Math.PI * 2;
  const hemY = (af: number) => lerp(1.09, HEM_BACK, smooth(0.25, 2.2, af));
  const edgeA = (v: number) => {
    const ge = gap(lerp(hemY(0.3), COLLAR, v));
    return Math.asin(Math.min(0.99, Math.pow(Math.min(1, ge / 0.13 + 0.02), 1.25)));
  };
  const f = (u: number, v: number, lift = 0) => {
    const aE = edgeA(v);
    const th = lerp(aE, TAU - aE, u);
    const af = Math.min(th, TAU - th);
    let y = lerp(hemY(af), COLLAR - 0.004 * (1 - Math.cos(af)), v);
    const loose = 0.014 + 0.012 * smooth(1.24, 1.08, y) * smooth(0.4, 1.6, af) + 0.016 * (1 - v) ** 2 * smooth(1.2, 3.0, af) + 0.0022 * (1 + Math.sin(af * 11 + y * 24)) * (1 - v);
    const kg = (1 - smooth(0.0, 0.45, v)) * (1 - smooth(0.25, 1.5, af));
    let a = th;
    if (kg > 0) {
      const target = th < Math.PI ? 0.07 : TAU - 0.24;
      y = lerp(y, KNOT.y + 0.004, kg * 0.75);
      a = lerp(th, target, kg * 0.7);
    }
    return torsoPt(y, a, loose + 0.012 * kg + lift, 1);
  };
  {
    const g = grid(56, 26, (u, v) => f(u, v));
    orient(g, axisIn);
    out.push(shade(part(g, COL.shirt, M.linen, body, (p) => 0.6 * smooth(1.12, 0.98, p.y) * smooth(-0.02, 0.06, p.z)), (p) => {
      // Drag folds radiating from the knot.
      const d = Math.hypot(p.x - KNOT.x, p.y - KNOT.y);
      const ang = Math.atan2(p.y - KNOT.y, p.x - KNOT.x);
      return 1 - 0.07 * Math.max(0, Math.sin(ang * 7 + d * 30)) * smooth(0.2, 0.03, d) * smooth(0.01, 0.03, d) * smooth(0.0, -0.05, p.z);
    }));
  }
  // Facing turned out along both open front edges.
  for (const ue of [0, 1]) {
    const pts: THREE.Vector3[] = [], ups: THREE.Vector3[] = [];
    for (let k = 0; k <= 16; k++) {
      const v = 0.05 + (k / 16) * 0.94;
      const p = f(ue, v, 0.002), q = f(ue === 0 ? 0.012 : 0.988, v, 0.002);
      pts.push(p.clone().lerp(q, 0.5));
      ups.push(V(p.x, 0, p.z).normalize());
    }
    out.push(part(strip(pts, ups, (t) => 0.006 + 0.004 * t, 0.002), COL.shirtIn, M.linen, body));
  }
  // Collar: a soft band folded over the neckline.
  {
    const g = grid(56, 3, (u, v) => {
      const p = f(u, lerp(0.9, 1.0, v), 0.004 + 0.005 * (1 - v));
      return p;
    });
    orient(g, axisIn);
    out.push(shade(part(g, COL.shirt, M.linen, body, (p) => 0.3 * smooth(1.4, 1.36, p.y)), () => 1.04));
  }
  // Buttons down her right front, a chest pocket on her left.
  for (const v of [0.42, 0.6, 0.78]) {
    const p = f(0.018, v, 0.002), n = V(p.x, 0, p.z).normalize();
    const bg = new THREE.CylinderGeometry(0.0042, 0.0042, 0.002, 10);
    bg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), n));
    bg.translate(p.x, p.y, p.z);
    out.push(part(bg, "#f2efe6", M.plain, body));
  }
  {
    const pg = grid(6, 6, (u, v) => f(lerp(0.955, 0.9, u), lerp(0.62, 0.78, v), 0.0025));
    orient(pg, axisIn);
    out.push(shade(part(pg, COL.shirt, M.linen, body), (p) => 0.93 + 0.05 * smooth(1.33, 1.335, p.y)));
  }
  // Sleeves: loose over the shoulder and upper arm, rolled up above the elbow.
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1;
    const sh = J.shoulder(s), el = J.elbow(s);
    const a = sh.clone().add(V(-s * 0.04, 0.012, 0.0)), b = sh.clone().lerp(el, 0.8);
    const rings = tube(a, b, FRONT, 14, 22, (t, ang) => (lerp(0.069, 0.06, smooth(0.0, 1.0, t)) + 0.0025 * Math.sin(ang * 5 + t * 9) * t) * (1 + 0.06 * Math.cos(ang) * t));
    const sw: WeightFn = (p) => {
      // Same shoulder blend as the arm skin underneath, so the deltoid never pokes through.
      const wc = smooth(sh.y - 0.06, sh.y + 0.03, p.y) * 0.8;
      return [[B.chest, wc], [B.upper[k], 1 - wc]];
    };
    const sg = loft(rings, false);
    out.push(part(sg, COL.shirt, M.linen, sw, (p) => 0.25 * smooth(0.06, 0.2, p.distanceTo(sh))));
    // Inside of the sleeve (seen past the cuff).
    const ig = loft(tube(sh.clone().lerp(el, 0.55), b, FRONT, 4, 22, () => 0.0505), false);
    flip(ig);
    out.push(part(ig, COL.shirtIn, M.linen, sw));
    // Rolled cuff: a thick soft band.
    const c0 = sh.clone().lerp(el, 0.72), c1 = sh.clone().lerp(el, 0.86);
    const cuff = loft(tube(c0, c1, FRONT, 6, 22, (t, ang) => 0.058 + 0.007 * Math.sin(Math.PI * t) + 0.0015 * Math.sin(ang * 6)), false, false, false);
    out.push(shade(part(cuff, COL.shirt, M.linen, sw), (p) => 1 - 0.08 * smooth(0.3, 0.0, Math.abs((p.clone().sub(c0).dot(el.clone().sub(sh).normalize()) - 0.018) / 0.02))));
  }
  // Knot and its two tails.
  {
    const kg = new THREE.SphereGeometry(1, 16, 12);
    const pa = kg.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i);
      const lump = 1 + 0.12 * Math.sin(x * 7 + y * 5) * Math.cos(z * 4);
      pa.setXYZ(i, KNOT.x + x * 0.03 * lump, KNOT.y + y * 0.02 * lump, KNOT.z - 0.006 + z * 0.018 * lump);
    }
    kg.deleteAttribute("uv");
    kg.computeVertexNormals();
    out.push(part(kg, COL.shirt, M.linen, envelope(rig, [B.hips, B.spine], 4, 0.03)));
    C.tailBind.forEach((pts, c) => {
      const s = c === 0 ? 1 : -1;
      const path: THREE.Vector3[] = [], ups: THREE.Vector3[] = [];
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const p = t < 0.5 ? pts[0].clone().lerp(pts[1], t * 2) : pts[1].clone().lerp(pts[2], t * 2 - 1);
        p.z += -0.004 * Math.sin(Math.PI * t);
        path.push(p);
        ups.push(V(s * 0.2, 0, -1).normalize());
      }
      const g = strip(path, ups, (t) => lerp(0.018, 0.024, t) * (1 - 0.3 * smooth(0.85, 1, t)), 0.0025);
      const bones = C.tailBones[c];
      out.push(part(g, COL.shirt, M.linen, (p) => {
        const t = (pts[0].y - p.y) / (pts[0].y - pts[2].y);
        return [[B.hips, 1 - smooth(0.0, 0.2, t)], [bones[0], smooth(0.0, 0.2, t) * (1 - smooth(0.4, 0.7, t))], [bones[1], smooth(0.4, 0.7, t)]];
      }, (p) => 0.6 * smooth(KNOT.y - 0.02, KNOT.y - 0.12, p.y)));
    });
  }
  return out;
}

// ------------------------------------------------------------------ shorts

const SH_TOP = 1.118, SH_BAND = 1.086;
export function shortsParts(rig: Rig, B: Bones): Geo[] {
  const out: Geo[] = [];
  const hipsW = envelope(rig, [B.hips, B.spine, B.thigh[0], B.thigh[1]], 4, 0.03, { [B.thigh[0]]: 0.45, [B.thigh[1]]: 0.45, [B.spine]: 0.7 });
  // Seat and waist.
  {
    const g = grid(48, 22, (u, v) => {
      const a = u * Math.PI * 2;
      const y = lerp(0.85, SH_TOP, v);
      const off = 0.007 + 0.005 * smooth(1.08, 0.95, y) + 0.003 * smooth(0.92, 0.86, y);
      const p = torsoPt(y, a, off, 0.0);
      // Two soft front pleats each side.
      const c = Math.cos(a);
      if (c > 0.3) p.z -= 0.0025 * Math.max(0, Math.sin(Math.abs(p.x) * 160)) * smooth(SH_BAND, 0.95, y);
      return p;
    }, true);
    out.push(shade(part(g, COL.shorts, M.linen, hipsW), (p) => {
      // Slanted front pockets, pleat lines, a seam down each side.
      let k = 1;
      for (const s of [1, -1]) {
        const d = Math.abs((p.x * s - 0.1) - (SH_BAND - 0.005 - p.y) * 0.32);
        if (p.z < 0 && p.y < SH_BAND && p.y > 0.98) k -= 0.14 * smooth(0.004, 0.0, d);
      }
      if (p.z < -0.05 && p.y < SH_BAND - 0.004) k -= 0.07 * smooth(0.25, 0.0, Math.abs(Math.sin(Math.abs(p.x) * 160) - 1)) * smooth(0.93, 1.06, p.y);
      return k * (1 - 0.05 * smooth(0.9, 0.86, p.y));
    }));
  }
  // Waistband, belt loops, a button.
  {
    const g = grid(48, 3, (u, v) => torsoPt(lerp(SH_BAND, SH_TOP + 0.002, v), u * Math.PI * 2, 0.013, 0.0), true);
    out.push(shade(part(g, COL.shorts, M.linen, hipsW), () => 0.96));
    for (const a of [-2.4, -1.4, -0.55, 0.55, 1.4, 2.4, Math.PI]) {
      const p = torsoPt(SH_BAND + 0.016, a, 0.017, 0.0);
      const bx = new THREE.BoxGeometry(0.008, 0.036, 0.004);
      bx.rotateY(-a);
      bx.translate(p.x, p.y, p.z);
      out.push(part(bx, COL.shortsSh, M.linen, hipsW));
    }
    const p = torsoPt(SH_BAND + 0.016, 0.06, 0.017, 0.0);
    const bt = new THREE.CylinderGeometry(0.0055, 0.0055, 0.003, 12).rotateX(Math.PI / 2).translate(p.x, p.y, p.z - 0.001);
    out.push(part(bt, "#b89a6a", M.metal, hipsW));
  }
  // Wide legs to mid-thigh, with a rolled cuff.
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1;
    const hp = J.hip(s), kn = J.knee(s);
    const a = hp.clone().add(V(0, 0.02, 0)), b = hp.clone().lerp(kn, 0.56);
    const legW: WeightFn = (p) => {
      const t = (a.y - p.y) / (a.y - b.y);
      const wl = smooth(0.05, 0.55, t);
      return [[B.hips, 1 - wl], [B.thigh[k], wl]];
    };
    const r = (t: number, ang: number) => {
      // Outer side kept inside the hips at the top; the opening wide and soft.
      const outer = Math.max(0, Math.sin(ang) * s), inner = Math.max(0, -Math.sin(ang) * s);
      return lerp(0.093, 0.105, smooth(0.0, 0.6, t)) * (1 - (0.16 * outer + 0.08 * inner) * (1 - smooth(0.0, 0.45, t))) + 0.003 * Math.sin(ang * 4 + t * 6) * t + 0.01 * Math.max(0, -Math.cos(ang)) * (1 - t);
    };
    const g = loft(tube(a, b, FRONT, 12, 24, r), false);
    out.push(shade(part(g, COL.shorts, M.linen, legW, (p) => 0.3 * smooth(a.y - 0.08, b.y, p.y)), (p) => 1 - 0.06 * smooth(0.6, 1.0, Math.abs(Math.sin(Math.atan2(p.z - hp.z, (p.x - hp.x) * s) * 2)))));
    const ig = loft(tube(hp.clone().lerp(kn, 0.4), b, FRONT, 3, 24, (t, ang) => r(lerp(0.75, 1, t), ang) - 0.003), false);
    flip(ig);
    out.push(part(ig, COL.shortsSh, M.linen, legW));
    const c0 = hp.clone().lerp(kn, 0.5), c1 = hp.clone().lerp(kn, 0.585);
    const cuff = loft(tube(c0, c1, FRONT, 6, 24, (t, ang) => r(1, ang) + 0.0075 * Math.sin(Math.PI * t) + 0.002), false);
    out.push(shade(part(cuff, COL.shorts, M.linen, legW, () => 0.25), (p) => 1 - 0.1 * smooth(0.004, 0.0, Math.abs(p.y - lerp(c0.y, c1.y, 0.5)))));
  }
  return out;
}

// ------------------------------------------------------------------ sandals

export function sandalParts(rig: Rig, B: Bones): Geo[] {
  void rig;
  const out: Geo[] = [];
  for (let k = 0; k < 2; k++) {
    const s = k === 0 ? 1 : -1;
    const bl = J.ball(s), an = J.ankle(s);
    const fw: WeightFn = (p) => {
      const wt = smooth(bl.z + 0.015, bl.z - 0.02, p.z);
      return [[B.foot[k], 1 - wt], [B.toe[k], wt]];
    };
    // Sole: the foot outline, a footbed on top and a darker edge.
    const outline = (t: number) => {
      const z = lerp(0.07, -0.182, t);
      const w = (0.03 + 0.015 * smooth(0.0, 0.62, t) + 0.006 * Math.exp(-(((t - 0.68) / 0.12) ** 2))) * Math.sqrt(Math.max(0.02, 1 - smooth(0.8, 1.0, t) ** 2)) * Math.sqrt(Math.max(0.05, smooth(-0.05, 0.1, t)));
      const cx = s * (0.099 + 0.008 * smooth(0.5, 1.0, t));
      return [cx, z, w];
    };
    const rings: THREE.Vector3[][] = [];
    for (let j = 0; j <= 18; j++) {
      const [cx, z, w] = outline(j / 18);
      const ring: THREE.Vector3[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const top = Math.cos(a) > 0;
        ring.push(V(cx + Math.sin(a) * w, top ? 0.0125 : 0.0005, z));
      }
      rings.push(ring);
    }
    const sole = loft(rings, false, true, true);
    out.push(shade(part(sole, COL.sole, M.plain, fw), (p) => (p.y > 0.012 ? 1.55 : 1)));
    // Straps: across the toes, crossing over the instep, round the ankle and the heel.
    const strapAt = (pts: THREE.Vector3[], wd: number, w: WeightFn) => {
      const ups = pts.map((p, i) => {
        const c = V(s * 0.1, 0.0, p.z);
        void i;
        return p.clone().sub(c).normalize();
      });
      out.push(part(strip(pts, ups, () => wd, 0.0022), COL.leather, M.plain, w));
    };
    const over = (z: number, h: number, x0: number, x1: number, n = 9) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = lerp(x0, x1, t);
        pts.push(V(s * 0.1 + x, 0.012 + h * Math.sin(Math.PI * t) ** 0.6, z));
      }
      return pts;
    };
    strapAt(over(-0.125, 0.026, -0.045, 0.048), 0.006, fw);
    const cross = (z0: number, z1: number) => {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 9; i++) {
        const t = i / 9;
        pts.push(V(s * 0.1 + lerp(-0.037, 0.037, t), 0.012 + 0.052 * Math.sin(Math.PI * t) ** 0.7, lerp(z0, z1, t)));
      }
      return pts;
    };
    strapAt(cross(-0.07, -0.01), 0.005, fw);
    strapAt(cross(-0.01, -0.07), 0.005, fw);
    {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        pts.push(V(an.x + Math.sin(a) * 0.036, an.y - 0.012 + 0.006 * Math.cos(a), an.z + 0.004 - Math.cos(a) * 0.036));
      }
      strapAt(pts, 0.0045, (p) => [[B.shin[k], 0.4], [B.foot[k], 0.6 + 0 * p.x]]);
      const heel: THREE.Vector3[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        heel.push(V(an.x, lerp(0.012, an.y - 0.012, t), lerp(0.072, an.z + 0.04, t)));
      }
      strapAt(heel, 0.006, (p) => [[B.foot[k], 1 - 0.3 * smooth(0.03, 0.07, p.y)], [B.shin[k], 0.3 * smooth(0.03, 0.07, p.y)]]);
      // Small brass buckle on the outer side.
      const bk = new THREE.BoxGeometry(0.004, 0.009, 0.009).translate(an.x + s * 0.037, an.y - 0.012, an.z + 0.004);
      out.push(part(bk, "#c9a35a", M.metal, (p) => [[B.foot[k], 0.6 + 0 * p.x], [B.shin[k], 0.4]]));
    }
  }
  return out;
}

// ------------------------------------------------------------------ hat

/** Squeeze hair inside the hat crown so no strand pokes through the straw. */
export function underHat(geos: Geo[]): Geo[] {
  const inv = HAT_M.clone().invert();
  const { rx, rz, h } = HAT_CROWN;
  const q = new THREE.Vector3();
  for (const g of geos) {
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      q.fromBufferAttribute(pos, i).applyMatrix4(inv);
      if (q.y < -0.004) continue;
      const rho = Math.hypot(q.x / rx, q.z / rz);
      if (rho > 1.25) continue;
      q.y = Math.min(q.y, h * 0.86);
      const e = Math.asin(Math.min(1, Math.pow(Math.max(0, q.y) / h, 1 / 1.4)));
      const lim = 0.92 * Math.pow(Math.cos(e), 0.55);
      if (rho > lim) {
        q.x *= lim / rho;
        q.z *= lim / rho;
      }
      q.applyMatrix4(HAT_M);
      pos.setXYZ(i, q.x, q.y, q.z);
    }
    pos.needsUpdate = true;
  }
  return geos;
}

export function hatParts(head: number, C: ClothRig): { straw: Geo[]; ribbon: Geo[]; glasses: Geo[] } {
  const straw: Geo[] = [], ribbon: Geo[] = [], glasses: Geo[] = [];
  const hw: WeightFn = () => [[head, 1]];
  const H = HAT_M;
  const { rx, rz, h } = HAT_CROWN;
  // Crown: a soft rounded dome over the band, closed on top, open below (onto the head).
  {
    const g = grid(40, 14, (u, v) => {
      const a = u * Math.PI * 2;
      const e = v * (Math.PI / 2);
      const k = Math.cos(e) ** 0.55;
      const pinch = 1 - 0.05 * Math.cos(2 * a) * smooth(0.6, 1, v);
      return V(Math.sin(a) * rx * k * pinch * (1 + 0.04 * (1 - v)), h * Math.sin(e) ** 1.4, -Math.cos(a) * rz * k).applyMatrix4(H);
    }, true);
    orient(g, () => HEAD_C.clone().add(V(0, 0.06, 0)));
    straw.push(part(g, COL.straw, M.straw, hw));
    // Inside of the crown (dark), seen under the brim at the back.
    const ig = grid(40, 3, (u, v) => {
      const a = u * Math.PI * 2;
      return V(Math.sin(a) * rx * 0.97, h * 0.4 * v, -Math.cos(a) * rz * 0.97).applyMatrix4(H);
    }, true);
    orient(ig, (p) => p.clone().multiplyScalar(2).sub(HEAD_C));
    straw.push(shade(part(ig, COL.straw, M.straw, hw), () => 0.55));
  }
  // Brim: a wide disc with a little thickness, dipping softly at the front and sides.
  {
    const ring = (r: number, a: number, top: boolean) => {
      const t = (r - rz) / (BRIM_R - rz);
      const droop = -0.02 * t * t * (0.7 + 0.3 * Math.cos(a)) + 0.012 * t * Math.max(0, -Math.cos(a)) * 0.6;
      const wav = 0.002 * Math.sin(a * 7) * t;
      const rr = r * (1 + 0.03 * Math.cos(2 * a) * t);
      return V(Math.sin(a) * rr * (rx / rz + (1 - rx / rz) * t), droop + wav + (top ? 0.004 * (1 - t) + 0.0015 : -0.0015), -Math.cos(a) * rr).applyMatrix4(H);
    };
    const NA = 56, NR = 8;
    for (const top of [true, false]) {
      const g = grid(NA, NR, (u, v) => ring(lerp(rz * 0.98, BRIM_R, v), u * Math.PI * 2, top), true);
      orient(g, (p) => p.clone().add(new THREE.Vector3(0, top ? -1 : 1, 0).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(H))));
      straw.push(shade(part(g, COL.straw, M.straw, hw, (p) => {
        const d = Math.hypot(p.x - HEAD_C.x, p.z - HEAD_C.z);
        return 0.9 * smooth(0.13, 0.24, d);
      }), () => (top ? 1 : 0.86)));
    }
    // Bound edge.
    const edge: THREE.Vector3[][] = [];
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2;
      const o = ring(BRIM_R, a, true), q = ring(BRIM_R, a, false);
      const r2 = ring(BRIM_R + 0.004, a, true).lerp(ring(BRIM_R + 0.004, a, false), 0.5);
      edge.push([o, r2, q]);
    }
    const rings = [0, 1, 2].map((j) => edge.map((e) => e[j]));
    const eg = loft(rings, false);
    straw.push(shade(part(eg, COL.straw, M.straw, hw, (p) => (Math.hypot(p.x - HEAD_C.x, p.z - HEAD_C.z) > 0.2 ? 0.9 : 0)), () => 0.9));
  }
  // Ribbon band and bow.
  {
    const g = grid(40, 2, (u, v) => {
      const a = u * Math.PI * 2;
      return V(Math.sin(a) * (rx + 0.003), lerp(0.003, 0.026, v), -Math.cos(a) * (rz + 0.003)).applyMatrix4(H);
    }, true);
    orient(g, () => HEAD_C.clone().add(V(0, 0.06, 0)));
    ribbon.push(part(g, COL.ribbon, M.cloth, hw));
    for (const s of [-1, 1]) {
      const loop: THREE.Vector3[] = [], ups: THREE.Vector3[] = [];
      for (let i = 0; i <= 12; i++) {
        const t = (i / 12) * Math.PI * 2;
        const p = BOW.clone().add(V(-0.004, 0.003 * Math.sin(t) + 0.006, 0)).add(V(0, Math.sin(t) * 0.0075, 0).add(new THREE.Vector3(-0.6, 0, 0.8).normalize().multiplyScalar(s * (0.011 + 0.011 * Math.cos(t)))));
        loop.push(p.applyMatrix4(H));
        ups.push(V(-0.92, 0, -0.38).normalize().applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(H)));
      }
      ribbon.push(part(strip(loop, ups, () => 0.008, 0.0015), COL.ribbon, M.cloth, hw));
    }
    const knot = new THREE.SphereGeometry(0.008, 10, 8).scale(0.8, 1.1, 0.8).translate(BOW.x - 0.005, BOW.y + 0.012, BOW.z).applyMatrix4(H);
    ribbon.push(part(knot, COL.ribbon, M.cloth, hw));
    C.ribbonBind.forEach((pts, c) => {
      const path: THREE.Vector3[] = [], ups: THREE.Vector3[] = [];
      for (let k = 0; k <= 12; k++) {
        const t = k / 12;
        const f = t * 3, j = Math.min(2, Math.floor(f));
        path.push(pts[j].clone().lerp(pts[j + 1], f - j));
        ups.push(V(-0.92, 0, -0.38).normalize());
      }
      const bones = C.ribbonBones[c];
      ribbon.push(part(strip(path, ups, (t) => 0.0098 * (1 - 0.35 * t) + 0.0035 * smooth(0.88, 1, t), 0.0012), COL.ribbon, M.cloth, (p) => {
        const out: [number, number][] = [];
        let tot = 0;
        const ws = bones.map((b, i) => {
          const d = p.distanceTo(pts[i].clone().lerp(pts[i + 1], 0.5));
          const w = Math.pow(1 / (d + 0.01), 6);
          tot += w;
          return w;
        });
        const d0 = p.distanceTo(pts[0]);
        const wh = 1 - smooth(0.0, 0.03, d0);
        out.push([head, wh]);
        bones.forEach((b, i) => out.push([b, (1 - wh) * ws[i] / tot]));
        return out;
      }, (p) => 0.5 * smooth(0.0, 0.08, p.distanceTo(pts[0]))));
    });
  }
  // Sunglasses worn on her face: tortoiseshell acetate frames (heavier brow bar), a keyhole bridge
  // over the nose, temples back to the ears under the hair. The tinted lenses are painted by the
  // face shader (same outline, see LENS), so her eyes still read through them.
  {
    const zc = lensZ();
    const tort = (g: Geo) => {
      const c = g.attributes.color as THREE.BufferAttribute, pa = g.attributes.position, v = new THREE.Vector3();
      const dk = new THREE.Color(COL.tort), am = new THREE.Color(COL.tortAmber), o = new THREE.Color();
      for (let i = 0; i < c.count; i++) {
        v.fromBufferAttribute(pa, i).sub(HEAD_C);
        const n = Math.sin(v.x * 610 + 2.1 * Math.sin(v.y * 820)) * Math.sin(v.y * 540 - v.z * 700 + 1.3 * Math.sin(v.x * 1300));
        o.copy(dk).lerp(am, smooth(0.05, 0.75, n));
        c.setXYZ(i, o.r, o.g, o.b);
      }
      return g;
    };
    const NK = 56;
    for (const s of [-1, 1]) {
      // Frame front: a flattened ring swept round the lens outline, thicker along the top.
      const n = V(-LENS.wrap * s, LENS.tilt, 1).normalize();
      const rings: THREE.Vector3[][] = [];
      const P = new THREE.Vector3(), Q = new THREE.Vector3(), T = new THREE.Vector3(), Bn = new THREE.Vector3();
      for (let k = 0; k <= NK; k++) {
        const a = (k / NK) * Math.PI * 2;
        lensPt(s, a, zc, 0.0016, P);
        lensPt(s, a + 0.01, zc, 0.0016, Q);
        T.subVectors(Q, P).normalize();
        Bn.crossVectors(T, n).normalize();
        const top = Math.max(0, Math.sin(a)) ** 2;
        const rw = 0.0017 + 0.0013 * top, rd = 0.0015 + 0.0005 * top;
        const ring: THREE.Vector3[] = [];
        for (let i = 0; i < 8; i++) {
          const f = (i / 8) * Math.PI * 2;
          ring.push(P.clone().addScaledVector(Bn, Math.cos(f) * rw).addScaledVector(n, -Math.sin(f) * rd).addScaledVector(Bn, 0.0008 * top * s));
        }
        rings.push(ring);
      }
      glasses.push(tort(part(loft(rings, false), COL.tort, M.lacquer, hw)));
      // Temple: hinge at the outer top corner, back along the side of the head to the ear.
      const hinge = lensPt(s, 0.32, zc, 0.0035);
      const pts = [hinge, hinge.clone().add(V(s * 0.006, -0.0005, 0.008))];
      const y0 = hinge.y - HEAD_C.y;
      const d = new THREE.Vector3();
      for (let k = 0; k <= 5; k++) {
        const az = 1.0 + (k / 5) * 0.72;
        d.set(s * Math.sin(az), (y0 - 0.006 * (k / 5)) / 0.075, -Math.cos(az)).normalize();
        pts.push(d.clone().multiplyScalar(headR(d) + 0.0045).add(HEAD_C));
      }
      d.set(s * Math.sin(1.9), (y0 - 0.02) / 0.075, -Math.cos(1.9)).normalize();
      pts.push(d.clone().multiplyScalar(headR(d) + 0.003).add(HEAD_C));
      const tg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 20, 0.0017, 6, false);
      tg.deleteAttribute("uv");
      glasses.push(tort(part(tg, COL.tort, M.lacquer, hw)));
    }
    // Bridge: a keyhole arch over the nose between the inner top corners.
    const bl = lensPt(-1, Math.PI - 0.42, zc, 0.0016), br = lensPt(1, Math.PI - 0.42, zc, 0.0016);
    const my = (bl.y + br.y) / 2 + 0.003 - HEAD_C.y;
    const mid = V(0, my, Math.min(faceZ(0, my) - 0.003, (bl.z + br.z) / 2 - HEAD_C.z - 0.002)).add(HEAD_C);
    const bg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([bl, bl.clone().lerp(mid, 0.5).add(V(0, 0.0015, -0.001)), mid, br.clone().lerp(mid, 0.5).add(V(0, 0.0015, -0.001)), br]), 12, 0.0022, 6, false);
    bg.deleteAttribute("uv");
    glasses.push(tort(part(bg, COL.tort, M.lacquer, hw)));
  }
  return { straw, ribbon, glasses };
}
