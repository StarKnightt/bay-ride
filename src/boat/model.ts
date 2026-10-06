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
  const a = Math.max(t - 0.42, 0) / 0.58;
  // Full forward sections: she carries her beam well up toward the bow before it closes in.
  const bG = 0.8 * (1 - Math.pow(a, 2.6)) * (0.84 + 0.16 * sm(0, 0.32, t));
  // A little rocker: the keel sweeps up toward the forefoot and lifts slightly at the transom.
  const kY = -0.21 + 0.36 * Math.pow(Math.max(t - 0.5, 0) / 0.5, 1.7) + 0.05 * Math.pow(Math.max(0.3 - t, 0) / 0.3, 2);
  // Sheer spring: lowest just aft of amidships, rising gently to the transom and boldly to a high bow.
  const sS = 0.41 + 0.07 * Math.pow(1 - t, 2) + 0.45 * Math.pow(t, 1.8);
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
export function halfWidthAt(t: number, y: number): number {
  const p = profile(t);
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[i], [x1, y1] = p[i + 1];
    if (y >= y0 && y <= y1) return Math.max(0, x0 + ((x1 - x0) * (y - y0)) / Math.max(y1 - y0, 1e-4) - 0.045);
  }
  return y < p[0][1] ? 0 : Math.max(0, p[p.length - 1][0] - 0.045);
}

export const stationOf = (z: number) => (ZS - z) / (ZS - ZB);

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
  /** Alternate strakes inside, a shade deeper, so the laps read inside the open boat too. */
  woodLap: new THREE.Color("#a5703f"),
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
      const col = inner ? (f === 0 ? C.woodDark : f % 2 ? C.wood : C.woodLap) : f === 0 ? C.bottom : f === 1 ? C.boot : f === F - 1 ? C.sheer : C.side;
      // Outside, each painted band is two narrow planks (one for the boot top), each lap painted:
      // a lit lower edge standing proud of the plank below, and a dark shadow line along its top
      // where the plank above overlaps it, wide and dark enough to read from chase distance.
      const bands: [number, number, THREE.Color][] = [];
      const nP = inner || f === 0 ? 0 : f === 1 ? 1 : 2;
      if (nP === 0) bands.push([0, 1, col]);
      const lit = col.clone().lerp(new THREE.Color(1, 1, 1), 0.32).multiplyScalar(1.04);
      const dark = col.clone().multiplyScalar(0.48);
      for (let p = 0; p < nP; p++) {
        const a = p / nP, b = (p + 1) / nP, h = b - a;
        bands.push([a, a + 0.12 * h, lit], [a + 0.12 * h, b - 0.17 * h, col], [b - 0.17 * h, b, dark]);
      }
      for (let i = 0; i < N; i++) {
        const [A0, B0, C0, D0] = quad(side, f, i);
        const nA = vn(i), nC = vn(i + 1);
        for (const [s0, s1, bc] of bands) {
          const A = A0.clone().lerp(B0, s0), B = A0.clone().lerp(B0, s1);
          const Cc = C0.clone().lerp(D0, s0), D = C0.clone().lerp(D0, s1);
          if (!flip[i]) {
            skin.tri(A, Cc, B, nA, nC, nA, bc);
            skin.tri(B, Cc, D, nA, nC, nC, bc);
          } else {
            skin.tri(A, B, Cc, nA, nA, nC, bc);
            skin.tri(B, D, Cc, nA, nC, nC, bc);
          }
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

/**
 * A small hurricane lantern on a short iron post at the starboard quarter, clear of her seat (port
 * of the centreline), the tiller's swing and the outboard: a dark frame, warm amber glass, a cap with
 * a chimney, and a bail handle. The glass is the night-glow panel the pier lamp heads use (plain paint
 * by day, lit from sunset; the bloom gives it its halo). It merges into the hull, so no new program.
 */
export const LANTERN_AT = { x: 0, y: 0, z: ZS - 0.12 };
function sternLantern(parts: THREE.BufferGeometry[]): void {
  const IRON = "#2b2a2c", g = gunwaleAt(LANTERN_AT.z);
  const x = g.half + 0.02, z = LANTERN_AT.z, y0 = g.y;
  LANTERN_AT.x = x;
  parts.push(xf(cyl(0.012, 0.014, 0.2, IRON, M.metal, 6), x, y0 + 0.1, z));
  const yb = y0 + 0.2;
  parts.push(xf(cyl(0.046, 0.05, 0.014, IRON, M.metal, 10), x, yb + 0.007, z));
  parts.push(xf(cyl(0.037, 0.037, 0.09, "#ffb04a", M.glow, 10), x, yb + 0.059, z));
  for (let k = 0; k < 4; k++) {
    const a = (k + 0.5) * (Math.PI / 2);
    parts.push(xf(box(0.007, 0.1, 0.007, IRON, M.metal), x + Math.cos(a) * 0.041, yb + 0.059, z + Math.sin(a) * 0.041));
  }
  const yt = yb + 0.104;
  parts.push(xf(cyl(0.018, 0.05, 0.034, IRON, M.metal, 10), x, yt + 0.017, z));
  parts.push(xf(cyl(0.011, 0.012, 0.022, IRON, M.metal, 6), x, yt + 0.045, z));
  // Bail handle: a wire hoop over the cap, across the boat.
  const hk = [v3(x - 0.042, yt + 0.01, z), v3(x - 0.03, yt + 0.07, z), v3(x, yt + 0.088, z), v3(x + 0.03, yt + 0.07, z), v3(x + 0.042, yt + 0.01, z)];
  for (let k = 0; k < hk.length - 1; k++) parts.push(beam(hk[k], hk[k + 1], 0.0035, IRON, M.metal, 4));
  LANTERN_AT.y = yb + 0.059;
}

/** Transom's crowned top: the sheer height at its sides, arched up by TRANSOM_CROWN at the centreline. */
const TRANSOM_CROWN = 0.05;
/** Half width of the motor well: a notch in the crown where the outboard's clamp sits on the sheer line. */
const WELL = 0.11;
const transomTop = (x: number, bG: number, sS: number) =>
  Math.abs(x) < WELL ? sS : sS + TRANSOM_CROWN * (1 - Math.min(1, (x / bG) ** 2)) * Math.min(1, (Math.abs(x) - WELL) / 0.03);

/**
 * The transom, where the chase camera looks: a crowned top edge, and outside the hull's own bands
 * carried round it (bottom red, boot top, white) under a blue sheer band with a red pinstripe;
 * varnished inside. Built in horizontal strips across the section.
 */
function transom(skin: Skin): void {
  const p = profile(0);
  const [bG, sS] = p[p.length - 1];
  const kY = p[0][1], cY = p[1][1];
  // Half width of the section at height y (straight between the profile's points).
  const half = (y: number) => {
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i], [x1, y1] = p[i + 1];
      if (y >= y0 && y <= y1) return x0 + ((x1 - x0) * (y - y0)) / Math.max(y1 - y0, 1e-4);
    }
    return y < kY ? 0 : bG;
  };
  const pin = new THREE.Color("#c4483a");
  const bandAt = (y: number) =>
    y < cY ? C.bottom : y < cY + 0.05 ? C.boot : y < sS - 0.13 ? C.side : y < sS - 0.105 ? pin : y < sS - 0.09 ? C.side : C.sheer;
  const ys: number[] = [];
  for (let y = kY; y < sS; y += 0.02) ys.push(y);
  for (const y of [cY, cY + 0.05, sS - 0.13, sS - 0.105, sS - 0.09]) ys.push(y);
  ys.push(sS);
  ys.sort((a, b) => a - b);
  for (const [z, nz, inside] of [[ZS, 1, false], [ZS - 0.04, -1, true]] as const) {
    const n = v3(0, 0, nz);
    const quad = (A: THREE.Vector3, B: THREE.Vector3, Cc: THREE.Vector3, D: THREE.Vector3, col: THREE.Color) => {
      // A, B lower left/right; Cc, D upper left/right (x grows to the right).
      if (nz > 0) {
        skin.tri(A, B, Cc, n, n, n, col);
        skin.tri(B, D, Cc, n, n, n, col);
      } else {
        skin.tri(A, Cc, B, n, n, n, col);
        skin.tri(B, Cc, D, n, n, n, col);
      }
    };
    for (let i = 0; i < ys.length - 1; i++) {
      const y0 = ys[i], y1 = ys[i + 1];
      if (y1 - y0 < 1e-4) continue;
      const h0 = half(y0), h1 = half(y1);
      const col = inside ? C.wood : bandAt((y0 + y1) / 2);
      quad(v3(-h0, y0, z), v3(h0, y0, z), v3(-h1, y1, z), v3(h1, y1, z), col);
    }
    // The crown above the sheer line, in strips across.
    const NS = 10;
    for (let j = 0; j < NS; j++) {
      const xa = -bG + (2 * bG * j) / NS, xb = -bG + (2 * bG * (j + 1)) / NS;
      quad(v3(xa, sS, z), v3(xb, sS, z), v3(xa, transomTop(xa, bG, sS), z), v3(xb, transomTop(xb, bG, sS), z), inside ? C.wood : C.sheer);
    }
  }
}

/** A varnished capping (rubbing strip) along the transom's crowned top, standing a little proud. */
function transomCap(parts: THREE.BufferGeometry[]): void {
  const p = profile(0);
  const [bG, sS] = p[p.length - 1];
  const NS = 8;
  for (let j = 0; j < NS; j++) {
    const xa = -bG - 0.01 + ((2 * bG + 0.02) * j) / NS, xb = -bG - 0.01 + ((2 * bG + 0.02) * (j + 1)) / NS;
    const ya = transomTop(Math.min(Math.abs(xa), bG), bG, sS) + 0.008, yb = transomTop(Math.min(Math.abs(xb), bG), bG, sS) + 0.008;
    parts.push(beam(v3(xa, ya, ZS - 0.015), v3(xb, yb, ZS - 0.015), 0.022, "#a46b3a", M.plain, 5));
  }
}

/**
 * Frames (ribs) inside the planking: steamed oak strips from the keel up each side to the gunwale,
 * a shade darker than the varnished skin, so the open boat reads as built, not as a tub.
 */
function frames(parts: THREE.BufferGeometry[]): void {
  const RIB = "#7a4f2c";
  for (const z of [1.05, 0.62, 0.3, -0.12, -0.5, -0.85, -1.2]) {
    const t = stationOf(z);
    const pr = profile(t);
    const bG = pr[pr.length - 1][0];
    const k = 1 - 0.05 / Math.max(bG, 0.12);
    const pts = pr.map(([x, y], j) => [x * Math.max(k, 0), j === pr.length - 1 ? y - 0.01 : y + 0.04] as [number, number]);
    for (const sx of [-1, 1])
      for (let i = 0; i < pts.length - 1; i++) {
        // From the floorboards' edge up (under the floor the ribs are hidden anyway).
        if (pts[i + 1][1] < FLOOR_Y) continue;
        const a = pts[i], b = pts[i + 1];
        const ya = Math.max(a[1], FLOOR_Y), xa = ya === a[1] ? a[0] : a[0] + ((b[0] - a[0]) * (ya - a[1])) / Math.max(b[1] - a[1], 1e-4);
        parts.push(beam(v3(sx * xa, ya, z), v3(sx * b[0], b[1], z), 0.016, RIB, M.plain, 4));
      }
  }
}

/** Top of the floorboards (boat frame y). */
export const FLOOR_Y = -0.09;
/** The stern bench: centre z, depth along the boat and top height (boat frame). */
export const BENCH = { z: 1.3, depth: 0.36, top: 0.2 };
/** Half width of the stern bench's top (it spans the hull inside the planking). */
export const benchHalf = (): number => halfWidthAt(stationOf(BENCH.z), BENCH.top - 0.02) - 0.005;
/** The gunwale at boat z: rail-top height and the inside half width of the planking there (boat frame). */
export function gunwaleAt(z: number, out = { y: 0, half: 0 }): { y: number; half: number } {
  const p = profile(Math.min(1, Math.max(0, stationOf(z))));
  const [bG, sS] = p[p.length - 1];
  out.y = sS + 0.022;
  out.half = bG - 0.045;
  return out;
}

export interface BoatModel {
  root: THREE.Group;
  /** Outboard pivot (rotation.y = tiller angle; + swings the tiller to port). */
  motor: THREE.Group;
  prop: THREE.Mesh;
  /** Tiller grip in the motor frame. */
  grip: THREE.Vector3;
  /** Where she sits (boat frame): the walker origin on the floor under her, facing forward, on the
   * bench to port of the centreline so her right hand falls on the tiller (the sit_tiller clip). */
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
  const floorY = FLOOR_Y;
  for (let k = -2; k <= 2; k++) {
    const x = k * 0.17;
    let zf = 1.6;
    for (let z = 1.6; z > -1.6; z -= 0.02) {
      if (halfWidthAt(stationOf(z), floorY - 0.02) < Math.abs(x) + 0.08) break;
      zf = z;
    }
    const z0 = Math.min(1.6, ZS - 0.08), len = z0 - zf;
    if (len <= 0.3) continue;
    // Darker oiled boards than the varnished skin, each in two lengths with a butt joint
    // (staggered board to board), so the floor reads as planks with seams from the chase camera.
    const butt = zf + len * (0.45 + 0.12 * ((k + 2) % 2));
    for (const [a, b] of [[zf, butt - 0.006], [butt + 0.006, z0]])
      parts.push(xf(box(0.15, 0.025, b - a, k % 2 ? "#6f4a2c" : "#7a5332", M.plain), x, floorY - 0.0125, (a + b) / 2));
  }
  // Cross battens under the boards' ends show as dark seams across the floor.
  for (const z of [1.45, 0.75, -0.05]) {
    const w = 2 * halfWidthAt(stationOf(z), floorY - 0.02) - 0.04;
    if (w > 0.2) parts.push(xf(box(w, 0.012, 0.035, "#4a3020", M.plain), 0, floorY + 0.004, z));
  }
  frames(parts);
  // Seats: a stern bench, a thwart amidships and a small bow seat, each on two short legs.
  const seat = (z: number, depth: number, top: number) => {
    const t = stationOf(z);
    const w = 2 * halfWidthAt(t, top - 0.02) - 0.01;
    parts.push(xf(box(w, 0.035, depth, "#b98953", M.plain), 0, top - 0.0175, z));
    // Legs stand on the floorboards, or on the inside of the planking where the rockered bottom
    // rises above them toward the bow (never through it). Checked across the leg's foot.
    const lx = w * 0.32 + 0.03;
    let yb = floorY - 0.005;
    for (const dz of [-0.03, 0.03]) {
      const tl = stationOf(z + dz);
      let y = profile(tl)[0][1];
      while (y < top && halfWidthAt(tl, y) < lx) y += 0.005;
      yb = Math.max(yb, y);
    }
    const y0 = yb, y1 = top - 0.035;
    for (const sx of [-1, 1]) parts.push(xf(box(0.05, y1 - y0, 0.05, "#8a5a33", M.plain), sx * w * 0.32, (y0 + y1) / 2, z));
  };
  seat(BENCH.z, BENCH.depth, BENCH.top);
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

  transomCap(parts);
  sternLantern(parts);
  const hull = new THREE.Mesh(merge(parts), uber(ID.boat, 1));
  root.add(hull);

  // Outboard on the transom: clamp bracket, cowled head, leg, cavitation plate, gearcase, tiller.
  const motor = new THREE.Group();
  const sternTop = profile(0)[4][1];
  motor.position.set(0, sternTop + 0.01, ZS + 0.04);
  // Two-tone: a cream cowling with a rounded top and a red decal band over a dark lower cowl,
  // a tapered leg, cavitation plate, gearcase and skeg in the dark grey.
  const COWL = "#e8e1cf", DECAL = "#c8473a", DARK = "#33393d", MID = "#4a5157";
  const ell = (col: string, x: number, y: number, z: number, rx: number, h: number, rz: number, top = 1) =>
    xf(cyl(top, 1, 1, col, M.metal, 16), x, y, z, 0, 0, 0, rx, h, rz);
  const mp: THREE.BufferGeometry[] = [
    xf(box(0.14, 0.15, 0.12, MID, M.metal), 0, -0.04, -0.02),
    // Lower cowl (dark) and its seam band, then the cream hood rounding over the top.
    ell(DARK, 0, 0.06, 0.13, 0.105, 0.07, 0.145, 0.97),
    ell(DECAL, 0, 0.1, 0.13, 0.108, 0.022, 0.148),
    ell(COWL, 0, 0.145, 0.13, 0.104, 0.07, 0.144, 0.92),
    xf(sphere(1, COWL, M.metal, 16, 8), 0, 0.18, 0.13, 0, 0, 0, 0.095, 0.05, 0.132),
    // Leg: tapered (elliptical), with the exhaust housing flare under the cowl.
    ell(DARK, 0, -0.01, 0.12, 0.06, 0.06, 0.085, 1.2),
    xf(cyl(0.6, 1, 1, DARK, M.metal, 10), 0, -0.3, 0.12, 0, 0, 0, 0.045, 0.52, 0.07),
    xf(box(0.25, 0.018, 0.27, DARK, M.metal), 0, -0.6, 0.15),
    xf(cyl(0.055, 0.045, 0.3, DARK, M.metal, 10), 0, -0.71, 0.15, Math.PI / 2),
    xf(box(0.02, 0.13, 0.13, DARK, M.metal), 0, -0.79, 0.18),
    // Tiller: a slim tapered ash handle from a metal collar, a lighter turned grip and a knob end.
    xf(cyl(0.022, 0.022, 0.05, "#4a4f54", M.metal, 8), 0, 0.12, -0.02, Math.PI / 2),
    beam(v3(0, 0.12, -0.04), v3(0, 0.1, -0.66), 0.015, "#9a6a3e", M.plain, 8, 0.011),
    xf(cyl(0.0165, 0.0145, 0.14, "#c99460", M.plain, 8), 0, 0.1, -0.735, Math.PI / 2),
    xf(sphere(0.019, "#b9844f", M.plain, 8, 6), 0, 0.1, -0.81),
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

  return { root, motor, prop, grip: v3(0, 0.1, -0.74), seat: v3(-0.3, floorY, 1.3) };
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
