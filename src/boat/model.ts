import * as THREE from "three";
import { ID, M, beam, box, cyl, merge, prep, sphere, xf } from "../world/geo";
import { uber } from "../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../render/lightpasses";

/**
 * The skiff, built in code: a small lapstrake wooden motorboat with a painted hull, a bench across
 * the stern, a thwart amidships and a bow seat, floorboards, a pair of oars, a rope coil at the bow
 * and a tiller outboard on the transom.
 *
 * Boat frame: origin amidships at the build datum, forward = -Z, up = +Y, right = +X. She floats
 * with the water at HULL.waterY in this frame.
 */

/** Transom and stem (boat z). */
const ZS = 1.86;
const ZB = -1.98;
export const HULL = {
  /** Half length and half beam at the waterline (for foam, collisions and the wake). */
  halfLen: 1.88,
  halfBeam: 0.74,
  /** Height of the floating waterline in the boat frame: she floats a strake up her sides. */
  waterY: 0.08,
  /** Keel below the floating waterline. */
  draft: 0.29,
  /** Gunwale height amidships above the floating waterline. */
  freeboard: 0.41,
};

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Station t (0 transom … 1 stem) → boat z. */
const zAt = (t: number) => ZS - t * (ZS - ZB);

/** Cross-section at station t: keel, chine, two strake laps and the gunwale (right side, x >= 0). */
function profile(t: number): [number, number][] {
  const a = Math.max(t - 0.4, 0) / 0.6;
  const bG = 0.8 * (1 - Math.pow(a, 2.0)) * (0.84 + 0.16 * sm(0, 0.32, t));
  const kY = -0.21 + 0.36 * Math.pow(Math.max(t - 0.5, 0) / 0.5, 1.7);
  const sS = 0.42 + 0.34 * Math.pow(t, 2.2) + 0.05 * Math.pow(1 - t, 3);
  const bC = bG * (0.8 - 0.1 * t);
  const cY = Math.min(kY + 0.1 + 0.12 * t, sS - 0.05);
  const pts: [number, number][] = [[0, kY], [bC, cY]];
  for (let j = 1; j <= 2; j++) {
    const k = j / 3;
    pts.push([bC + (bG - bC) * k + 0.035 * Math.sin(Math.PI * k) * (bG / 0.76), cY + (sS - cY) * k]);
  }
  pts.push([bG, sS]);
  return pts;
}

/** Inside half width of the hull at height y, station t (through the planking). */
function halfWidthAt(t: number, y: number): number {
  const p = profile(t);
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1];
    if (y >= y0 && y <= y1) return Math.max(0, x0 + ((x1 - x0) * (y - y0)) / Math.max(y1 - y0, 1e-4) - 0.045);
  }
  return y < p[0][1] ? 0 : Math.max(0, p[p.length - 1][0] - 0.045);
}

const stationOf = (z: number) => (ZS - z) / (ZS - ZB);

/** Outside half width of the hull at the floating waterline, at boat z (0 past the stem). */
export function waterlineHalf(z: number): number {
  const t = stationOf(z);
  if (t <= 0 || t >= 1) return 0;
  const p = profile(t);
  return p[0][1] >= HULL.waterY ? 0 : halfWidthAt(t, HULL.waterY) + 0.045;
}
export const STEM_Z = ZB;
export const TRANSOM_Z = ZS;

const C = {
  bottom: new THREE.Color("#a5483b"),
  boot: new THREE.Color("#c9533f"),
  side: new THREE.Color("#f7f2e7"),
  sheer: new THREE.Color("#4c9fb8"),
  wood: new THREE.Color("#b98451"),
  woodDark: new THREE.Color("#8a5a33"),
  rail: new THREE.Color("#a46b3a"),
};

/** Push a quad (a, b, c, d: a-b along the section, a-c along the hull) with vertex normals. */
class Skin {
  pos: number[] = [];
  nrm: number[] = [];
  col: number[] = [];
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, na: THREE.Vector3, nb: THREE.Vector3, nc: THREE.Vector3, col: THREE.Color): void {
    for (const [p, n] of [[a, na], [b, nb], [c, nc]] as const) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.col.push(col.r, col.g, col.b);
    }
  }
  geo(mat: number): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    return prep(g, null, mat);
  }
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * Lofted planking: each strake is flat across (so the laps read as painted bands) and smooth along
 * the hull. inner = the varnished inside skin, a plank's thickness in from the outside.
 */
function planking(skin: Skin, inner: boolean): void {
  const N = 22;
  const st = Array.from({ length: N + 1 }, (_, i) => {
    const t = i / N;
    const p = profile(t);
    if (inner) {
      const bG = p[p.length - 1][0];
      const k = 1 - 0.035 / Math.max(bG, 0.12);
      return p.map(([x, y], j) => [x * Math.max(k, 0), j === p.length - 1 ? y : y + 0.03] as [number, number]);
    }
    return p;
  });
  const F = st[0].length - 1;
  const quad = (side: number, f: number, i: number) => {
    const z0 = zAt(i / N), z1 = zAt((i + 1) / N);
    return [
      v3(st[i][f][0] * side, st[i][f][1], z0),
      v3(st[i][f + 1][0] * side, st[i][f + 1][1], z0),
      v3(st[i + 1][f][0] * side, st[i + 1][f][1], z1),
      v3(st[i + 1][f + 1][0] * side, st[i + 1][f + 1][1], z1),
    ];
  };
  for (const side of [1, -1]) {
    for (let f = 0; f < F; f++) {
      // Facet normals per bay, facing out of the hull (into it for the inside skin), averaged
      // along the hull at each station so the strake is smooth lengthwise and flat across.
      const fn: THREE.Vector3[] = [];
      const flip: boolean[] = [];
      for (let i = 0; i < N; i++) {
        const [A, B, Cc, D] = quad(side, f, i);
        const n = new THREE.Vector3().crossVectors(Cc.clone().sub(A), B.clone().sub(A));
        n.add(new THREE.Vector3().crossVectors(Cc.clone().sub(B), D.clone().sub(B)));
        const mid = A.clone().add(B).add(Cc).add(D).multiplyScalar(0.25);
        const hint = mid.clone().sub(v3(0, 0.12, mid.z));
        let fl = n.dot(hint) < 0;
        if (inner) fl = !fl;
        if (fl) n.multiplyScalar(-1);
        if (n.lengthSq() < 1e-12) n.set(side * (inner ? -1 : 1), 0, 0);
        fn.push(n.normalize());
        flip.push(fl);
      }
      const vn = (i: number) => fn[Math.max(0, i - 1)].clone().add(fn[Math.min(N - 1, i)]).normalize();
      const col = inner ? (f === 0 ? C.woodDark : C.wood) : f === 0 ? C.bottom : f === 1 ? C.boot : f === F - 1 ? C.sheer : C.side;
      for (let i = 0; i < N; i++) {
        const [A, B, Cc, D] = quad(side, f, i);
        const nA = vn(i), nC = vn(i + 1);
        if (!flip[i]) {
          skin.tri(A, Cc, B, nA, nC, nA, col);
          skin.tri(B, Cc, D, nA, nC, nC, col);
        } else {
          skin.tri(A, B, Cc, nA, nA, nC, col);
          skin.tri(B, D, Cc, nA, nC, nC, col);
        }
      }
    }
  }
}

/** Gunwale rail: a rounded wooden cap along the sheer, a little proud of the planking. */
function rail(skin: Skin): void {
  const N = 26;
  for (const side of [1, -1]) {
    const ring = (t: number) => {
      const p = profile(t);
      const [bG, sS] = p[p.length - 1];
      const bi = bG * Math.max(1 - 0.035 / Math.max(bG, 0.12), 0);
      const z = zAt(t);
      return [v3((bG + 0.018) * side, sS - 0.04, z), v3((bG + 0.018) * side, sS + 0.022, z), v3((bi - 0.008) * side, sS + 0.022, z), v3((bi - 0.008) * side, sS - 0.025, z)];
    };
    const nrm = [v3(side, -0.2, 0), v3(side * 0.4, 1, 0), v3(-side * 0.4, 1, 0), v3(-side, -0.2, 0)].map((n) => n.normalize());
    for (let i = 0; i < N; i++) {
      const r0 = ring(i / N), r1 = ring((i + 1) / N);
      for (let k = 0; k < 3; k++) {
        const nA = nrm[k].clone().add(nrm[k + 1]).normalize();
        const A = r0[k], B = r0[k + 1], Cc = r1[k], D = r1[k + 1];
        const g = new THREE.Vector3().crossVectors(Cc.clone().sub(A), B.clone().sub(A));
        if (g.dot(nA) >= 0) {
          skin.tri(A, Cc, B, nA, nA, nA, C.rail);
          skin.tri(B, Cc, D, nA, nA, nA, C.rail);
        } else {
          skin.tri(A, B, Cc, nA, nA, nA, C.rail);
          skin.tri(B, D, Cc, nA, nA, nA, C.rail);
        }
      }
    }
  }
}

/** Flat transom: painted outside, varnished inside. */
function transom(skin: Skin): void {
  const p = profile(0);
  const ring: [number, number][] = [...p.slice().reverse().map(([x, y]) => [x, y] as [number, number]), ...p.slice(1).map(([x, y]) => [-x, y] as [number, number])];
  const cy = (p[0][1] + p[p.length - 1][1]) / 2;
  for (const [z, nz, col] of [[ZS, 1, C.sheer], [ZS - 0.04, -1, C.wood]] as const) {
    const n = v3(0, 0, nz);
    const c = v3(0, cy, z);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const A = v3(a[0], a[1], z), B = v3(b[0], b[1], z);
      const cr = new THREE.Vector3().crossVectors(A.clone().sub(c), B.clone().sub(c));
      if (cr.z * nz >= 0) skin.tri(c, A, B, n, n, n, col);
      else skin.tri(c, B, A, n, n, n, col);
    }
  }
}

export interface BoatModel {
  root: THREE.Group;
  /** Outboard pivot (rotation.y = tiller angle; + swings the tiller to port). */
  motor: THREE.Group;
  prop: THREE.Mesh;
  /** Tiller grip in the motor frame. */
  grip: THREE.Vector3;
  /** Where she sits (boat frame): the walker origin on the floor under her, facing forward. */
  seat: THREE.Vector3;
}

export function buildBoat(): BoatModel {
  const root = new THREE.Group();
  const skin = new Skin();
  planking(skin, false);
  planking(skin, true);
  rail(skin);
  transom(skin);
  // Painted planking takes the painted-metal shading: few brush strokes, so faces near the
  // light's terminator do not break into stripes of lit and shaded paint.
  const parts: THREE.BufferGeometry[] = [skin.geo(M.metal)];

  // Floorboards: five planks with gaps, each as long as the bottom is wide enough for it.
  const floorY = -0.09;
  for (let k = -2; k <= 2; k++) {
    const x = k * 0.17;
    let zf = 1.6;
    for (let z = 1.6; z > -1.6; z -= 0.02) {
      if (halfWidthAt(stationOf(z), floorY - 0.02) < Math.abs(x) + 0.08) break;
      zf = z;
    }
    const z0 = Math.min(1.6, ZS - 0.08), len = z0 - zf;
    if (len > 0.3) parts.push(xf(box(0.15, 0.025, len, k % 2 ? "#a77446" : "#b07c4c", M.plain), x, floorY - 0.0125, zf + len / 2));
  }
  // Seats: a stern bench, a thwart amidships and a small bow seat, each on two short legs.
  const seat = (z: number, depth: number, top: number) => {
    const w = 2 * halfWidthAt(stationOf(z), top - 0.02) - 0.01;
    parts.push(xf(box(w, 0.035, depth, "#b98953", M.plain), 0, top - 0.0175, z));
    for (const sx of [-1, 1]) parts.push(xf(box(0.05, top - floorY - 0.03, 0.05, "#8a5a33", M.plain), sx * w * 0.32, (top + floorY) / 2 - 0.02, z));
  };
  seat(1.3, 0.36, 0.2);
  seat(0.12, 0.22, 0.21);
  seat(-1.12, 0.2, 0.26);
  // Knees bracing the stern bench to the transom.
  for (const sx of [-1, 1]) parts.push(xf(box(0.04, 0.16, 0.22, "#8a5a33", M.plain), sx * 0.5, 0.25, 1.62, 0.5));

  // A pair of oars along the port side, resting on the thwarts.
  for (const [ox, a] of [[-0.36, 0.03], [-0.46, -0.02]] as const) {
    const g: THREE.BufferGeometry[] = [];
    g.push(xf(cyl(0.02, 0.02, 2.0, "#c9a271", M.plain, 6), 0, 0, 0, Math.PI / 2));
    g.push(xf(box(0.13, 0.012, 0.48, "#c49a68", M.plain), 0, 0, -1.18));
    g.push(xf(cyl(0.024, 0.024, 0.18, "#7b5232", M.plain, 6), 0, 0, 0.93, Math.PI / 2));
    g.push(xf(cyl(0.026, 0.026, 0.06, "#3a3a3e", M.metal, 6), 0, 0, 0.35, Math.PI / 2));
    const og = merge(g);
    parts.push(xf(og, ox, 0.245, 0.15, 0, a));
  }
  // Oarlocks on the gunwale by the middle thwart.
  {
    const t = stationOf(0.38), p = profile(t), [bG, sS] = p[p.length - 1];
    for (const sx of [-1, 1]) {
      parts.push(xf(cyl(0.012, 0.012, 0.09, "#4a4a4e", M.metal, 6), sx * bG, sS + 0.06, 0.38));
      parts.push(xf(cyl(0.035, 0.035, 0.012, "#4a4a4e", M.metal, 8), sx * bG, sS + 0.1, 0.38, 0, 0, Math.PI / 2));
    }
  }
  // Rope coil on the floor up in the bow, its end running to the stem ring.
  {
    const cz = -0.72, cx = 0.04;
    for (let k = 0; k < 3; k++) {
      const tg = new THREE.TorusGeometry(0.15 - k * 0.012, 0.021, 6, 18);
      tg.rotateX(Math.PI / 2);
      parts.push(xf(prep(tg, "#d8c49a", M.cloth), cx + k * 0.012, floorY + 0.02 + k * 0.034, cz - k * 0.01));
    }
    const tS = profile(0.985), stemTop = tS[tS.length - 1][1];
    parts.push(beam(v3(cx + 0.14, floorY + 0.08, cz), v3(0.02, stemTop - 0.08, ZB + 0.2), 0.018, "#d8c49a", M.cloth, 5));
    parts.push(xf(cyl(0.035, 0.035, 0.014, "#4a4a4e", M.metal, 8), 0, stemTop - 0.05, ZB + 0.12, 0, 0, Math.PI / 2));
  }
  // Fuel can under the stern bench, port side.
  parts.push(xf(box(0.2, 0.2, 0.3, "#c2412f", M.metal), -0.3, floorY + 0.1, 1.3));
  parts.push(xf(cyl(0.025, 0.025, 0.05, "#2e2e30", M.metal, 6), -0.3, floorY + 0.22, 1.2));

  const hull = new THREE.Mesh(merge(parts), uber(ID.boat, 1));
  root.add(hull);

  // Outboard on the transom: clamp bracket, cowled head, leg, cavitation plate, gearcase, tiller.
  const motor = new THREE.Group();
  const sternTop = profile(0)[4][1];
  motor.position.set(0, sternTop + 0.01, ZS + 0.04);
  const COWL = "#7d878d", DARK = "#3b4247";
  const mp: THREE.BufferGeometry[] = [
    xf(box(0.14, 0.15, 0.12, "#55595e", M.metal), 0, -0.04, -0.02),
    xf(box(0.18, 0.1, 0.25, COWL, M.metal), 0, 0.12, 0.13),
    xf(sphere(1, COWL, M.metal, 14, 8), 0, 0.17, 0.13, 0, 0, 0, 0.09, 0.055, 0.125),
    xf(box(0.2, 0.05, 0.27, DARK, M.metal), 0, 0.055, 0.13),
    xf(box(0.09, 0.62, 0.11, DARK, M.metal), 0, -0.28, 0.12),
    xf(box(0.25, 0.018, 0.27, DARK, M.metal), 0, -0.6, 0.15),
    xf(cyl(0.055, 0.045, 0.3, DARK, M.metal, 10), 0, -0.71, 0.15, Math.PI / 2),
    xf(box(0.02, 0.13, 0.13, DARK, M.metal), 0, -0.79, 0.18),
    beam(v3(0, 0.12, 0.0), v3(0, 0.1, -0.7), 0.024, "#4a4f54", M.metal, 6),
    xf(cyl(0.033, 0.03, 0.17, "#26282b", M.metal, 8), 0, 0.1, -0.76, Math.PI / 2),
  ];
  const motorMesh = new THREE.Mesh(merge(mp), uber(ID.motor, 1));
  motor.add(motorMesh);
  const pg: THREE.BufferGeometry[] = [xf(cyl(0.03, 0.03, 0.08, DARK, M.metal, 8), 0, 0, 0, Math.PI / 2)];
  for (let k = 0; k < 3; k++) pg.push(xf(box(0.16, 0.012, 0.05, "#6c7277", M.metal), 0, 0, 0.0, 0.25, 0, (k * Math.PI * 2) / 3));
  const prop = new THREE.Mesh(merge(pg), uber(ID.motor, 1));
  prop.position.set(0, -0.71, 0.32);
  motor.add(prop);
  root.add(motor);
  onLayers(root, LAYER_SHADOW, LAYER_REFLECT);
  root.add(seaLid());

  return { root, motor, prop, grip: v3(0, 0.1, -0.74), seat: v3(0.3, floorY, 1.3) };
}

/**
 * Keeps the sea out of the open boat without a discard in the sea shader (which would cost the
 * whole sea its early depth test): an invisible depth-only cover across the opening, flush with
 * the rail tops so the ink sees one continuous surface. It draws after the boat and her (render
 * order 0) and before the sea (render order 1), on the main view only (not shadows, not mirror).
 */
function seaLid(): THREE.Mesh {
  const N = 26;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const p = profile(t);
    const [bG, sS] = p[p.length - 1];
    const bi = bG * Math.max(1 - 0.035 / Math.max(bG, 0.12), 0) - 0.008;
    const z = i === 0 ? ZS - 0.04 : zAt(t);
    pos.push(-bi, sS + 0.022, z, bi, sS + 0.022, z);
    if (i < N) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const lid = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }));
  lid.renderOrder = 0.5;
  lid.name = "seaLid";
  return lid;
}
