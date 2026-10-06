import * as THREE from "three";
import { ID, M, beam, box, cyl, merge, prep, xf } from "../geo";
import { mulberry32, pick, range, type Rng } from "../../core/rng";
import { uber } from "../../render/materials";
import { LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { SEA_Y, roadX } from "../bay/road";
import { WALL_OUT, waterlineU } from "../bay/terrain";
import { ROCKS, rockTop } from "../../water/rocks";
import type { Collider } from "../bay";
import { groundY, type Layout } from "../../flora/place";

type Geo = THREE.BufferGeometry;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/**
 * The beach dressed: a wrack line at the high-water mark (a broken band of seaweed with dried
 * tufts, shells and small driftwood caught in it), pebble drifts at the wall foot and along the
 * wrack, shells scattered down to the swash, bleached driftwood, tide pools on the exposed shore
 * rocks, and one beach set on the upper sand (an open striped parasol, a striped towel and a basket).
 * All of it is landward of the pier end, so nothing stands between her and the sea in the opening.
 * Small debris is unoutlined (the ground's ink group) and casts no shadow, in a few chunks along
 * the beach; the props are one outlined, shadow-casting mesh.
 */

const Z0 = -226, Z1 = 166;
const CHUNK = 80;

/** Road-relative u of the high-water line at z: above the highest run-up, wobbling along the beach. */
function wrackU(z: number): number {
  const uw = waterlineU(z);
  return uw + 0.42 * (WALL_OUT - uw) + 0.7 * Math.sin(z * 0.11 + 1.3) + 0.4 * Math.sin(z * 0.37);
}

const WEED = ["#4d4a26", "#5c5428", "#3e4a2a", "#55502c", "#6b5f36"];
const WEED_DRY = ["#7a6a45", "#8a7a52", "#6f6444"];
const SHELL = ["#f2ebdc", "#efd9c4", "#e8c2b0", "#f4e2c8", "#d9a68a", "#e6e0d4"];
const PEBBLE = ["#9a9488", "#8a8378", "#b0a898", "#7c766e", "#a39a8a", "#6f6b66"];
const DRIFT = ["#b9ae9c", "#a89c88", "#c8bfae", "#9e9282"];

/** Lay a flat piece on the sand at (x, z): lifted a little and tilted to the local slope. */
function onSand(g: Geo, x: number, z: number, lift: number, yaw: number): Geo {
  const e = 0.3;
  const gx = (groundY(x + e, z) - groundY(x - e, z)) / (2 * e), gz = (groundY(x, z + e) - groundY(x, z - e)) / (2 * e);
  g.rotateY(yaw);
  return xf(g, x, groundY(x, z) + lift, z, -Math.atan(gz), 0, Math.atan(gx));
}

function weed(r: Rng, x: number, z: number, dry: boolean): Geo {
  const len = range(r, 0.25, 0.7), w = range(r, 0.04, 0.09);
  const g = new THREE.PlaneGeometry(len, w, 3, 1);
  const p = g.attributes.position;
  const bend = range(r, -0.5, 0.5);
  for (let i = 0; i < p.count; i++) {
    const t = p.getX(i) / len;
    p.setY(i, p.getY(i) + bend * len * t * t);
  }
  g.rotateX(-Math.PI / 2);
  prep(g, pick(r, dry ? WEED_DRY : WEED), M.plain);
  return onSand(g, x, z, 0.012, r() * Math.PI);
}

/** A tangled clump of wrack: a low flattened lump. */
function clump(r: Rng, x: number, z: number): Geo {
  const s = range(r, 0.12, 0.26);
  const g = new THREE.IcosahedronGeometry(1, 0);
  g.scale(s * range(r, 1.2, 2), s * 0.28, s);
  prep(g, pick(r, WEED), M.plain);
  return onSand(g, x, z, s * 0.05, r() * Math.PI);
}

function shell(r: Rng, x: number, z: number): Geo {
  const s = range(r, 0.018, 0.04);
  let g: Geo;
  if (r() < 0.75) {
    // Cockle: a low ribbed dome.
    g = new THREE.SphereGeometry(s, 7, 2, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(1, 0.5, 1.15);
  } else {
    // Auger: a slim cone on its side.
    g = new THREE.CylinderGeometry(s * 0.08, s * 0.5, s * 2.6, 5, 1);
    g.rotateZ(Math.PI / 2);
    g.translate(0, s * 0.35, 0);
  }
  prep(g, pick(r, SHELL), M.plain);
  return onSand(g, x, z, 0.0, r() * Math.PI * 2);
}

function pebble(r: Rng, x: number, z: number, big: boolean): Geo {
  const s = big ? range(r, 0.06, 0.13) : range(r, 0.025, 0.06);
  const g = new THREE.IcosahedronGeometry(1, 0);
  g.scale(s * range(r, 1.0, 1.5), s * range(r, 0.45, 0.7), s);
  prep(g, pick(r, PEBBLE), M.stone);
  return onSand(g, x, z, s * 0.15, r() * Math.PI);
}

/** Bleached driftwood: a crooked bough with a stub branch or two, bedded in the sand. */
function driftwood(r: Rng, out: Geo[], x: number, z: number, len: number, rad: number): void {
  const yaw = r() * Math.PI;
  const dx = Math.cos(yaw), dz = Math.sin(yaw);
  const col = pick(r, DRIFT);
  const a = V(x - dx * len / 2, 0, z - dz * len / 2), b = V(x + dx * len / 2, 0, z + dz * len / 2);
  const mid = V(x + range(r, -0.1, 0.1) * len * -dz, 0, z + range(r, -0.1, 0.1) * len * dx);
  for (const p of [a, b, mid]) p.y = groundY(p.x, p.z) + rad * 0.55;
  out.push(beam(a, mid, rad, col, M.bark, 6, rad * 0.9), beam(mid, b, rad * 0.9, col, M.bark, 6, rad * 0.55));
  for (let k = 0; k < (len > 1.2 ? 2 : 1); k++) {
    const t = range(r, 0.25, 0.75);
    const p = a.clone().lerp(b, t);
    p.y = groundY(p.x, p.z) + rad * 0.6;
    const s = range(r, 0.6, 1.4) * (r() < 0.5 ? 1 : -1);
    const q = V(p.x + (-dz * s + dx * 0.3) * len * 0.3, 0, p.z + (dx * s + dz * 0.3) * len * 0.3);
    q.y = groundY(q.x, q.z) + rad * 0.4 + range(r, 0, 0.12);
    out.push(beam(p, q, rad * 0.45, col, M.bark, 5, rad * 0.25));
  }
}

/** A trail of footprints (flat, slightly darker dents) from a to b, left and right alternating. */
function footprints(out: Geo[], ax: number, az: number, bx: number, bz: number): void {
  const L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L, yaw = Math.atan2(dx, dz);
  for (let d = 0, i = 0; d < L; d += 0.62, i++) {
    const s = i % 2 ? 0.1 : -0.1, x = ax + dx * d - dz * s, z = az + dz * d + dx * s;
    const g = new THREE.SphereGeometry(1, 8, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    g.scale(0.055, 0.006, 0.12);
    out.push(xf(prep(g, "#c4ad84", M.plain), x, groundY(x, z) - 0.004, z, 0, yaw, 0));
  }
}

/** A sandcastle: a mound, a keep with crenels, two corner towers; a bucket and a spade by it. */
function sandcastle(out: Geo[], colliders: Collider[], x: number, z: number): void {
  const g = groundY(x, z), sand = "#dcc596";
  out.push(xf(cyl(0.55, 0.7, 0.18, sand, M.plain, 14), x, g + 0.06, z));
  out.push(xf(cyl(0.26, 0.3, 0.3, sand, M.plain, 10), x, g + 0.3, z));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    out.push(xf(box(0.07, 0.07, 0.07, sand, M.plain), x + Math.cos(a) * 0.22, g + 0.48, z + Math.sin(a) * 0.22, 0, -a, 0));
  }
  for (const [ox, oz] of [[0.42, 0.25], [-0.38, -0.3]]) {
    out.push(xf(cyl(0.11, 0.13, 0.26, sand, M.plain, 8), x + ox, g + 0.2, z + oz));
    out.push(xf(cyl(0.0, 0.12, 0.14, sand, M.plain, 8), x + ox, g + 0.4, z + oz));
  }
  const bx = x + 0.85, bz = z - 0.35, bg = groundY(bx, bz);
  out.push(xf(cyl(0.12, 0.09, 0.2, "#e84a3a", M.plain, 12), bx, bg + 0.1, bz));
  out.push(xf(cyl(0.125, 0.125, 0.02, "#f0a030", M.plain, 12), bx, bg + 0.2, bz));
  out.push(beam(V(bx + 0.25, bg + 0.01, bz + 0.35), V(bx + 0.45, bg + 0.42, bz + 0.6), 0.015, "#3a7ab0", M.plain, 4));
  out.push(xf(box(0.14, 0.02, 0.18, "#3a7ab0", M.plain), bx + 0.22, bg + 0.03, bz + 0.3, 0, 0.6, 0));
  colliders.push({ x, z, r: 0.7, top: g + 0.5 });
}

function flipflops(out: Geo[], x: number, z: number, yaw: number): void {
  for (const s of [-0.09, 0.09]) {
    const g = new THREE.CylinderGeometry(1, 1, 1, 10);
    g.scale(0.05, 0.02, 0.13);
    out.push(xf(prep(g, "#2f8f8a", M.plain), x + Math.cos(yaw) * s, groundY(x, z) + 0.01, z - Math.sin(yaw) * s, 0, yaw + s, 0));
  }
}

function cooler(out: Geo[], colliders: Collider[], x: number, z: number, yaw: number): void {
  const g = groundY(x, z);
  out.push(xf(box(0.6, 0.36, 0.38, "#3a7ab0", M.plain), x, g + 0.18, z, 0, yaw, 0));
  out.push(xf(box(0.62, 0.07, 0.4, "#f4f1ea", M.plain), x, g + 0.39, z, 0, yaw, 0));
  out.push(xf(box(0.3, 0.04, 0.05, "#f4f1ea", M.plain), x, g + 0.45, z, 0, yaw, 0));
  colliders.push({ x, z, r: 0.38, top: g + 0.45 });
}

/** Open beach parasol planted in the sand, a little askew. */
function umbrella(out: Geo[], colliders: Collider[], x: number, z: number): void {
  const g = groundY(x, z);
  const tilt = V(0.12, 1, 0.05).normalize();
  const top = V(x, g - 0.25, z).addScaledVector(tilt, 2.35);
  out.push(beam(V(x, g - 0.25, z), top, 0.022, "#e8e2d6", M.metal, 6));
  // Open canopy: eight coral and cream panels (closed wedges, so the shade side reads from below),
  // a scalloped teal valance and a finial; big enough to read as a parasol, not a pole.
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), tilt);
  const c0 = top.clone().addScaledVector(tilt, -0.36);
  for (let i = 0; i < 8; i++) {
    const seg = new THREE.CylinderGeometry(0.05, 1.15, 0.38, 3, 1, false, (i / 8) * Math.PI * 2, Math.PI / 4);
    seg.translate(0, 0.19, 0);
    prep(seg, i % 2 ? "#f4ecd8" : "#e8604c", M.cloth);
    seg.applyQuaternion(q);
    out.push(xf(seg, c0.x, c0.y, c0.z));
  }
  const val = new THREE.CylinderGeometry(1.15, 1.15, 0.1, 24, 1, true);
  prep(val, "#2f8f8a", M.cloth);
  val.applyQuaternion(q);
  const vp = c0.clone().addScaledVector(tilt, -0.05);
  out.push(xf(val, vp.x, vp.y, vp.z));
  const fin = cyl(0.012, 0.03, 0.08, "#c9b07a", M.metal, 6);
  fin.applyQuaternion(q);
  const fp = top.clone().addScaledVector(tilt, 0.04);
  out.push(xf(fin, fp.x, fp.y, fp.z));
  colliders.push({ x, z, r: 0.18, top: g + 2.3 });
}

/** A striped beach towel spread on the sand. */
function towel(out: Geo[], x: number, z: number, yaw: number): void {
  const stripes = ["#2f8f8a", "#f1e8d2", "#e88a78", "#f1e8d2", "#2f8f8a"];
  const L = 1.7, W = 0.85;
  stripes.forEach((col, i) => {
    const g = box(L, 0.012, W / stripes.length + 0.002, col, M.cloth);
    g.translate(0, 0, -W / 2 + (i + 0.5) * (W / stripes.length));
    out.push(onSand(g, x, z, 0.012, yaw));
  });
}

/** A woven basket with a handle, by the towel. */
function basket(out: Geo[], colliders: Collider[], x: number, z: number): void {
  const g = groundY(x, z);
  out.push(xf(cyl(0.21, 0.17, 0.28, "#c8a46a", M.plain, 12), x, g + 0.14, z));
  for (const h of [0.06, 0.15, 0.25]) out.push(xf(cyl(0.21 - (0.28 - h) * 0.12 + 0.006, 0.21 - (0.28 - h) * 0.12 + 0.006, 0.018, "#9a7a48", M.plain, 12), x, g + h, z));
  const handle = new THREE.TorusGeometry(0.17, 0.012, 4, 12, Math.PI);
  out.push(xf(prep(handle, "#9a7a48", M.plain), x, g + 0.28, z, 0, 0.6, 0));
  // A rolled cloth sticking out of it.
  out.push(xf(cyl(0.05, 0.05, 0.36, "#e88a78", M.cloth, 8), x + 0.05, g + 0.36, z - 0.03, 0.4, 0, 0.25));
  colliders.push({ x, z, r: 0.25, top: g + 0.4 });
}

/** Tide pool in a hollow on a shore rock's top: a dark wet rim round still water with a sky sheen. */
function tidePool(r: Rng, out: Geo[], x: number, z: number, rad: number): void {
  const y = rockTop(x, z);
  const rim = new THREE.CircleGeometry(rad * 1.25, 12);
  rim.rotateX(-Math.PI / 2);
  out.push(xf(prep(rim, "#5a5248", M.stone), x, y + 0.012, z));
  const water = new THREE.CircleGeometry(rad, 12);
  water.rotateX(-Math.PI / 2);
  out.push(xf(prep(water, pick(r, ["#4f8796", "#457f8c"]), M.metal), x, y + 0.02, z));
  const sheen = new THREE.CircleGeometry(rad * 0.45, 8, 0, Math.PI);
  sheen.rotateX(-Math.PI / 2);
  out.push(xf(prep(sheen, "#a8cfd0", M.metal), x + rad * 0.2, y + 0.024, z - rad * 0.15, 0, r() * 6.28, 0));
}

export function buildBeach(layout: Layout, colliders: Collider[]): THREE.Group {
  const r = mulberry32(9393);
  const chunks = new Map<number, Geo[]>();
  const add = (z: number, g: Geo) => {
    const k = Math.max(0, Math.floor((z - Z0) / CHUNK));
    let l = chunks.get(k);
    if (!l) chunks.set(k, (l = []));
    l.push(g);
  };
  const props: Geo[] = [];
  const at = (u: number, z: number) => roadX(z) + u;
  const ok = (x: number, z: number, pad = 0) => layout.free(x, z, pad);

  // The wrack line: a broken band (gaps where the noise drops) of weed, dried tufts, clumps and shells.
  for (let z = Z0; z < Z1; z += 0.22) {
    const band = Math.sin(z * 0.043 + 0.4) * 0.5 + Math.sin(z * 0.131 + 2.1) * 0.35 + Math.sin(z * 0.37) * 0.15;
    if (band < -0.35) continue;
    const dens = 0.55 + 0.45 * Math.min(1, (band + 0.35) * 1.4);
    for (let k = 0; k < 2; k++) {
      if (r() > dens) continue;
      const zz = z + range(r, -0.11, 0.11);
      const u = wrackU(zz) + range(r, -0.45, 0.45) * (r() < 0.2 ? 2.5 : 1);
      const x = at(u, zz);
      if (!ok(x, zz)) continue;
      const roll = r();
      add(zz, roll < 0.72 ? weed(r, x, zz, u > wrackU(zz) + 0.25) : roll < 0.84 ? clump(r, x, zz) : roll < 0.94 ? shell(r, x, zz) : pebble(r, x, zz, false));
    }
  }
  // Pebble drifts: clusters at the wall foot and along the wrack line.
  for (let i = 0; i < 70; i++) {
    const z = range(r, Z0, Z1);
    const atWall = r() < 0.55;
    const cu = atWall ? WALL_OUT - range(r, 0.3, 1.6) : wrackU(z) + range(r, -1.2, 1.2);
    const n = Math.floor(range(r, 12, 40)), rad = range(r, 0.4, 1.4);
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * rad;
      const zz = z + Math.sin(a) * d * 1.6, x = at(cu + Math.cos(a) * d * 0.6, zz);
      if (!ok(x, zz)) continue;
      add(zz, pebble(r, x, zz, r() < 0.25));
    }
  }
  // Shells scattered over the lower beach toward the swash.
  for (let i = 0; i < 420; i++) {
    const z = range(r, Z0, Z1);
    const uw = waterlineU(z);
    const u = uw + 1.6 + Math.pow(r(), 1.4) * (wrackU(z) - uw);
    const x = at(u, z);
    if (!ok(x, z)) continue;
    add(z, shell(r, x, z));
  }
  // Driftwood: bigger pieces on the upper beach (colliders), small ones caught in the wrack.
  for (let i = 0, n = 0; i < 120 && n < 34; i++) {
    const z = range(r, Z0 + 4, Z1 - 4);
    const big = r() < 0.35;
    const u = big ? range(r, WALL_OUT - 4.5, WALL_OUT - 1.2) : wrackU(z) + range(r, -0.6, 0.8);
    const x = at(u, z);
    if (!ok(x, z, big ? 1.2 : 0.4)) continue;
    n++;
    const len = big ? range(r, 1.4, 3.2) : range(r, 0.4, 1.1), rad = big ? range(r, 0.07, 0.13) : range(r, 0.025, 0.05);
    driftwood(r, props, x, z, len, rad);
    if (big) {
      colliders.push({ x, z, r: len * 0.45, top: groundY(x, z) + rad * 1.6 });
      layout.rect(x - len / 2, x + len / 2, z - len / 2, z + len / 2);
    }
  }
  // Shot 1's foreground (eye on the wet sand at u -27, z 40, looking along the shore): a log and
  // dry tufts to landward, pebbles, shells and a strand of weed across the sand in front. Hand
  // placed on open sand, so only kept above the sea line.
  {
    const ex = at(-27, 40), fx = -0.585, fz = -0.811, rx = 0.811, rz = -0.585;
    const p = (d: number, s: number): [number, number] => [ex + fx * d + rx * s, 40 + fz * d + rz * s];
    const dry = (x: number, z: number, m = 0.06) => groundY(x, z) > SEA_Y + m;
    const [lx, lz] = p(5, 3.2);
    if (dry(lx, lz)) {
      driftwood(r, props, lx, lz, 2.4, 0.11);
      colliders.push({ x: lx, z: lz, r: 1.1, top: groundY(lx, lz) + 0.2 });
    }
    // Near-third interest: a sandcastle with bucket and spade, a footprint trail across the frame,
    // bigger dune grass drifts at the frame edges.
    const [cx, cz] = p(4.6, -1.4);
    if (dry(cx, cz, 0.15)) {
      sandcastle(props, colliders, cx, cz);
      layout.rect(cx - 1, cx + 1.3, cz - 1, cz + 1);
    }
    const [f0x, f0z] = p(1.6, 2.2), [f1x, f1z] = p(10, -0.6);
    footprints(props, f0x, f0z, f1x, f1z);
    for (const [d, s] of [[3.2, 4.3], [2.8, -3.6], [6, 4.8]] as const) {
      const [x, z] = p(d, s);
      if (dry(x, z, 0.12)) layout.spot(x, z, 1.1, 16, ["weed", "weed", "thrift", "weed"]);
    }
    for (let i = 0; i < 90; i++) {
      const [x, z] = p(range(r, 3.2, 8), range(r, -1.5, 5));
      if (dry(x, z)) add(z, r() < 0.55 ? pebble(r, x, z, r() < 0.55) : shell(r, x, z));
    }
    for (let i = 0; i < 60; i++) {
      const t = i / 59, [x, z] = p(3.4 + t * 5 + range(r, -0.25, 0.25), 4.2 - t * 4.5 + range(r, -0.25, 0.25));
      if (dry(x, z)) add(z, r() < 0.75 ? weed(r, x, z, r() < 0.4) : clump(r, x, z));
    }
    for (const [d, s] of [[3.8, 5.2], [6.5, 5.8], [8.5, 4.6]] as const) {
      const [x, z] = p(d, s);
      if (dry(x, z, 0.1)) layout.spot(x, z, 0.8, 10, ["weed", "weed", "thrift", "weed"]);
    }
  }
  // The beach set on the upper sand, on shot 2's centre line (eye on the road at z 60, looking
  // over the wall to the island).
  {
    const z = 55.2, x = at(-12.2, z);
    umbrella(props, colliders, x - 0.3, z + 1.3);
    towel(props, x + 0.6, z - 0.3, 0.35);
    basket(props, colliders, x + 1.75, z + 0.65);
    flipflops(props, x + 1.55, z - 0.9, 0.4);
    cooler(props, colliders, x + 1.1, z + 1.9, 0.3);
    footprints(props, at(WALL_OUT - 0.4, z + 3.2), z + 3.2, x + 1.3, z - 0.6);
    layout.rect(x - 0.8, x + 2.1, z - 1.0, z + 2.4);
  }
  // Tide pools on the shore rocks that stand clear of the water.
  for (const rk of ROCKS) {
    if (rk.top < SEA_Y + 0.25 || rk.r < 0.7) continue;
    const n = rk.r > 1.4 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, d = rk.r * range(r, 0.05, 0.3);
      tidePool(r, props, rk.x + Math.cos(a) * d, rk.z + Math.sin(a) * d, rk.r * range(r, 0.16, 0.26));
    }
  }
  // Dune flowers and grass tufts in drifts along the wall foot, thicker near the beach set.
  for (let z = Z0 + 8; z < Z1 - 8; z += range(r, 9, 16)) {
    const x = at(WALL_OUT - range(r, 0.6, 1.6), z);
    if (ok(x, z, 0.5)) layout.spot(x, z, range(r, 0.8, 1.6), Math.floor(range(r, 4, 9)), ["weed", "thrift", "weed", "yellow", "thrift"]);
  }
  layout.spot(at(-9.6, 59), 59, 1.6, 14, ["weed", "thrift", "weed", "yellow"]);
  layout.spot(at(-9.4, 51), 51, 1.4, 11, ["weed", "thrift", "daisy"]);

  const group = new THREE.Group();
  group.name = "beach";
  const small = uber(ID.ground, 0.6);
  for (const [k, list] of chunks) {
    const m = new THREE.Mesh(merge(list), small);
    m.name = `beach debris ${k}`;
    group.add(m);
  }
  if (props.length) {
    const m = new THREE.Mesh(merge(props), uber(ID.pier, 1));
    m.name = "beach props";
    onLayers(m, LAYER_SHADOW);
    group.add(m);
  }
  return group;
}
