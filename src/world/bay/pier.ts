import * as THREE from "three";
import { ID, M, beam, box, boxM, cyl, merge, prep, xf } from "../geo";
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { SEA_Y } from "./road";
import { terrainH } from "./terrain";
import type { Collider } from "./index";

type Geo = THREE.BufferGeometry;

/**
 * The harbour pier: a plank deck on timber posts running straight out to sea along world z = PIER.z,
 * from the promenade on top of the sea wall (x0, level with the road) down a gentle slope to a flat
 * deck PIER.deck above the water and out to the pier end (x1), over about seven metres of water.
 * White railings both sides, a gap with two bollards on the south side at the end where the skiff
 * lies alongside, a ladder down from the end, lamps that glow after dusk and a lifebuoy.
 *
 * Everything that has to agree with the mesh (walking, the boat's collisions, the capture guard, the
 * foam rings round the posts in the sea shader) reads the numbers here.
 */
export const PIER = {
  z: -193,
  /** Landward end (on the promenade) and seaward end (world x). */
  x0: 7.2,
  x1: -94,
  /** Half width of the deck (planks), m. */
  half: 1.5,
  /** Flat deck top height, and where the slope up to the promenade starts. */
  deck: SEA_Y + 1.7,
  flatX: -20,
  /** Railings stand seaward of this x (the landward end is level with the promenade). */
  railFrom: 4.5,
  /** Railing height above the deck. */
  rail: 1.0,
};

/** The berth gap in the south railing at the end (world x range). */
export const PIER_GAP = { x0: -93.0, x1: -87.6 };

/** Posts: a pair per bent (z = PIER.z ± dz), bents every `step` m from x = x0 for n bents. */
export const PIER_POSTS = { x0: PIER.x1 + 0.3, step: 3.4, n: 30, dz: 1.32, r: 0.15 };

/** Bollard tops on the south edge either side of the berth gap (mooring lines run from these). */
export const PIER_BOLLARDS: THREE.Vector3[] = [];
/** Lamp heads (glow after dusk). */
export const PIER_LAMPS: THREE.Vector3[] = [];

/** Top of the deck at world x (sloping up to the promenade at the landward end). */
export function deckH(x: number): number {
  if (x <= PIER.flatX) return PIER.deck;
  const t = Math.min(1, (x - PIER.flatX) / (PIER.x0 - PIER.flatX));
  return PIER.deck + (0.02 - PIER.deck) * t;
}

/** Inside the pier's plan footprint (deck plus railings), grown by `pad` m? */
export function inPier(x: number, z: number, pad = 0): boolean {
  return x <= PIER.x0 + pad && x >= PIER.x1 - 0.1 - pad && Math.abs(z - PIER.z) <= PIER.half + 0.08 + pad;
}

/**
 * Walking on the pier at (x, z) for someone at height y (Infinity = from above):
 * - a wood Ground on the deck,
 * - null where the railings, the end or the drop off the side stop her,
 * - undefined where the pier has no say (beside it on land, or under it with headroom).
 */
export function pierGround(x: number, z: number, y = Infinity): { h: number; kind: "wood" } | null | undefined {
  const h = pierWalkH(x, z, y);
  return Number.isNaN(h) ? undefined : h === -Infinity ? null : { h, kind: "wood" };
}

/** pierGround as a number (no allocation): the deck height, −Infinity where it stops her, NaN where it has no say. */
export function pierWalkH(x: number, z: number, y = Infinity): number {
  const dz = Math.abs(z - PIER.z);
  if (x > PIER.x0 || x < PIER.x1 - 0.6 || dz > PIER.half + 0.6) return NaN;
  const top = deckH(x);
  const ground = terrainH(x, z);
  if (y < top - 0.7) return ground < top - 1.9 ? NaN : -Infinity;
  if (x < PIER.x1 + 0.3) return -Infinity;
  const gap = z < PIER.z && x > PIER_GAP.x0 && x < PIER_GAP.x1;
  if (dz <= (gap ? PIER.half - 0.12 : PIER.half - 0.24)) return top;
  // Off the side: open onto the promenade at the landward end, railings (or the drop) elsewhere.
  return x > PIER.railFrom && ground > top - 0.35 ? NaN : -Infinity;
}

/** Is (x, y, z) inside the pier's solid (deck, railings, posts and the space between them)? */
export function pierBlocks(x: number, y: number, z: number): boolean {
  return inPier(x, z, 0.1) && y < deckH(x) + PIER.rail + 0.1 && y > Math.max(terrainH(x, z), SEA_Y - 1);
}

/** Push a circle (x, z, r) out of the pier's footprint (for hulls): penetration and normal. */
export function pierContact(x: number, z: number, r: number): { pen: number; nx: number; nz: number } | null {
  const hx = (PIER.x0 - (PIER.x1 - 0.1)) / 2, cx = (PIER.x0 + PIER.x1 - 0.1) / 2, hz = PIER.half + 0.08;
  const lx = x - cx, lz = z - PIER.z;
  const qx = Math.abs(lx) - hx, qz = Math.abs(lz) - hz;
  if (qx > r || qz > r) return null;
  if (qx > 0 && qz > 0) {
    const d = Math.hypot(qx, qz);
    if (d >= r) return null;
    return { pen: r - d, nx: (Math.sign(lx) * qx) / d, nz: (Math.sign(lz) * qz) / d };
  }
  // Out across the nearer face (the pier end or a side).
  return qx > qz ? { pen: r - qx, nx: Math.sign(lx), nz: 0 } : { pen: r - qz, nx: 0, nz: Math.sign(lz) };
}

const C = {
  plank: "#ad977a",
  timber: "#6d5946",
  wet: "#3f362d",
  weed: "#4c5a3c",
  rail: "#eee8dc",
  iron: "#34393a",
  lamp: "#2f4a45",
};

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** The pier mesh; adds its walk-level obstacles (bollards, lamp posts, beach-side posts) to `colliders`. */
export function buildPier(colliders: Collider[]): THREE.Group {
  const wood: Geo[] = [];
  const paint: Geo[] = [];
  const Z = PIER.z, H = PIER.half;
  const slope = Math.atan((0.02 - PIER.deck) / (PIER.x0 - PIER.flatX));
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // Deck: two long slabs (the slope and the flat run) painted as boards by the deck surface, whose
  // seams and per-board tone fade out with distance instead of beating into moire rings.
  const flatLen = PIER.flatX - PIER.x1;
  wood.push(xf(boxM(flatLen, 0.08, 2 * H, C.plank, M.deck), (PIER.x1 + PIER.flatX) / 2, PIER.deck - 0.04, Z));
  const rampLen = Math.hypot(PIER.x0 - PIER.flatX, 0.02 - PIER.deck);
  const rampMid = (PIER.x0 + PIER.flatX) / 2;
  wood.push(xf(boxM(rampLen + 0.02, 0.08, 2 * H, C.plank, M.deck), rampMid, deckH(rampMid) - 0.04, Z, 0, 0, slope));

  // Bents: a pair of posts from the seabed (or the sand) up under a cross beam, X-braced over water.
  const P = PIER_POSTS;
  for (let k = 0; k < P.n; k++) {
    const x = P.x0 + k * P.step;
    const top = deckH(x) - 0.08;
    for (const s of [-1, 1]) {
      const z = Z + s * P.dz;
      const g = terrainH(x, z);
      const lean = (hash(k * 2 + s) - 0.5) * 0.03;
      const y0 = g - 0.4;
      const wetTop = Math.min(SEA_Y + 0.42, top - 0.3);
      if (wetTop > y0) {
        wood.push(xf(cyl(P.r * 1.04, P.r * 1.08, wetTop - y0, C.wet, M.bark, 9), x, (y0 + wetTop) / 2, z, lean, 0, 0));
        if (wetTop > SEA_Y - 0.1) wood.push(xf(cyl(P.r * 1.09, P.r * 1.09, 0.22, C.weed, M.plain, 9), x, SEA_Y + 0.12, z));
      }
      const ya = Math.max(y0, wetTop);
      wood.push(xf(cyl(P.r, P.r * 1.03, top - ya, C.timber, M.bark, 9), x, (ya + top) / 2, z, lean, 0, 0));
      if (g > SEA_Y - 0.45) colliders.push({ x, z, r: P.r + 0.05, top });
    }
    wood.push(xf(box(0.24, 0.2, 2 * H + 0.3, C.timber, M.bark), x, top - 0.1, Z));
    const lo = Math.max(SEA_Y + 0.35, terrainH(x, Z) + 0.3);
    if (k % 2 === 0 && top - lo > 1.2) {
      wood.push(beam(v(x, top - 0.25, Z - P.dz), v(x, lo, Z + P.dz), 0.055, C.timber, M.bark, 5));
      wood.push(beam(v(x, top - 0.25, Z + P.dz), v(x, lo, Z - P.dz), 0.055, C.timber, M.bark, 5));
    }
  }
  // Edge boards (fascia) along both sides under the deck, one per bay between bents.
  const ends = [PIER.x1 - 0.02];
  for (let k = 0; k < P.n; k++) ends.push(P.x0 + k * P.step);
  ends.push(PIER.x0);
  for (let i = 0; i < ends.length - 1; i++) {
    const a = ends[i], b = ends[i + 1];
    for (const s of [-1, 1])
      wood.push(beam(v(a, deckH(a) - 0.16, Z + s * (H + 0.03)), v(b, deckH(b) - 0.16, Z + s * (H + 0.03)), 0.09, C.timber, M.bark, 4));
  }
  // End beam across the pier end.
  wood.push(xf(box(0.08, 0.24, 2 * H + 0.06, C.timber, M.bark), PIER.x1 - 0.05, PIER.deck - 0.14, Z));

  // Railings: white posts and two rails, both sides and across the end (open at the ladder and the
  // berth gap).
  const RP = P.step / 2;
  const railPosts: number[] = [];
  for (let x = PIER.x1 + 0.08; x <= PIER.railFrom; x += RP) railPosts.push(x);
  const rh = PIER.rail;
  for (const s of [-1, 1]) {
    const z = Z + s * (H - 0.06);
    for (let i = 0; i < railPosts.length; i++) {
      const x = railPosts[i];
      const inGap = s < 0 && x > PIER_GAP.x0 + 0.05 && x < PIER_GAP.x1 - 0.05;
      if (!inGap) paint.push(xf(box(0.09, rh, 0.09, C.rail, M.plain), x, deckH(x) + rh / 2, z));
      const nx = railPosts[i + 1];
      if (nx === undefined) continue;
      const gapSpan = s < 0 && nx > PIER_GAP.x0 && x < PIER_GAP.x1;
      if (gapSpan) continue;
      for (const f of [1, 0.52]) paint.push(beam(v(x, deckH(x) + rh * f, z), v(nx, deckH(nx) + rh * f, z), f === 1 ? 0.045 : 0.03, C.rail, M.plain, 5));
    }
  }
  // Across the end, leaving an opening for the ladder at z = Z + 0.6.
  const xe = PIER.x1 + 0.08;
  for (const [za, zb] of [[Z - H + 0.06, Z + 0.2], [Z + 1.0, Z + H - 0.06]]) {
    paint.push(xf(box(0.09, rh, 0.09, C.rail, M.plain), xe, PIER.deck + rh / 2, za === Z - H + 0.06 ? zb : za));
    for (const f of [1, 0.52]) paint.push(beam(v(xe, PIER.deck + rh * f, za), v(xe, PIER.deck + rh * f, zb), f === 1 ? 0.045 : 0.03, C.rail, M.plain, 5));
  }
  // Ladder down the end face into the water.
  {
    const x = PIER.x1 - 0.12, zc = Z + 0.6, y1 = PIER.deck + 0.9, y0 = SEA_Y - 0.9;
    for (const s of [-1, 1]) paint.push(beam(v(x, y0, zc + s * 0.24), v(x, y1, zc + s * 0.24), 0.03, C.iron, M.metal, 5));
    for (let y = PIER.deck - 0.25; y > y0 + 0.1; y -= 0.3) paint.push(beam(v(x, y, zc - 0.24), v(x, y, zc + 0.24), 0.018, C.iron, M.metal, 4));
  }
  // Bollards either side of the berth gap.
  for (const x of [PIER_GAP.x0 + 0.25, PIER_GAP.x1 - 0.25]) {
    const z = Z - H + 0.22, y = PIER.deck;
    paint.push(xf(cyl(0.12, 0.14, 0.42, C.iron, M.metal, 10), x, y + 0.21, z));
    paint.push(xf(cyl(0.17, 0.15, 0.08, C.iron, M.metal, 10), x, y + 0.44, z));
    PIER_BOLLARDS.push(v(x, y + 0.36, z));
    colliders.push({ x, z, r: 0.2, top: y + 0.48 });
  }
  // Lamps: dark green posts with a lantern head on a short arm over the deck.
  for (const [x, s] of [[PIER.x1 + 1.0, 1], [-58, -1], [-24, 1]] as const) {
    const z = Z + s * (H - 0.16), y = deckH(x), hgt = 3.3;
    paint.push(xf(cyl(0.11, 0.13, 0.3, C.lamp, M.metal, 8), x, y + 0.15, z));
    paint.push(xf(cyl(0.05, 0.065, hgt, C.lamp, M.metal, 8), x, y + hgt / 2, z));
    paint.push(beam(v(x, y + hgt - 0.05, z), v(x, y + hgt + 0.08, z - s * 0.42), 0.03, C.lamp, M.metal, 5));
    const hz = z - s * 0.42;
    paint.push(xf(cyl(0.16, 0.06, 0.12, C.lamp, M.metal, 8), x, y + hgt + 0.06, hz));
    paint.push(xf(cyl(0.11, 0.09, 0.26, "#ffe2a0", M.glow, 8), x, y + hgt - 0.13, hz));
    PIER_LAMPS.push(v(x, y + hgt - 0.13, hz));
    colliders.push({ x, z, r: 0.16, top: y + hgt });
  }
  // A lifebuoy on the north railing, banded red and white.
  {
    const x = -78.5, z = Z + H + 0.02, y = PIER.deck + 0.58;
    for (let i = 0; i < 8; i++) {
      const g = new THREE.TorusGeometry(0.3, 0.07, 6, 4, Math.PI / 4);
      g.rotateZ((i * Math.PI) / 4);
      paint.push(xf(prep(g, i % 2 ? "#f2eee6" : "#d0493c", M.plain), x, y, z));
    }
  }

  const group = new THREE.Group();
  const deck = new THREE.Mesh(merge(wood), uber(ID.pier, 1));
  const trim = new THREE.Mesh(merge(paint), uber(ID.fence, 1));
  for (const m of [deck, trim]) {
    onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
    group.add(m);
  }
  return group;
}

/**
 * Two mooring lines from the bollards to the skiff's bow and stern, each sagging in two spans; they
 * follow the hull as it rides at its berth and hide once she is under way.
 */
export class MooringLines {
  readonly group = new THREE.Group();
  private readonly spans: THREE.Mesh[] = [];
  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();
  private readonly m = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() {
    const g = cyl(0.022, 0.022, 1, "#d9cdb0", M.plain, 5);
    g.translate(0, 0.5, 0);
    const mat = uber(ID.pier, 0.6);
    for (let i = 0; i < 4; i++) {
      const s = new THREE.Mesh(g, mat);
      s.frustumCulled = false;
      onLayers(s, LAYER_SHADOW, LAYER_REFLECT);
      this.spans.push(s);
      this.group.add(s);
    }
  }

  /** `bow` and `stern` are the hull's fairleads in world space; `visible` false once she casts off. */
  update(bow: THREE.Vector3, stern: THREE.Vector3, visible: boolean): void {
    this.group.visible = visible && PIER_BOLLARDS.length >= 2;
    if (!this.group.visible) return;
    const ends = [bow, stern];
    for (let k = 0; k < 2; k++) {
      this.a.copy(PIER_BOLLARDS[k]);
      this.b.copy(ends[k]);
      this.m.lerpVectors(this.a, this.b, 0.5);
      this.m.y -= 0.06 + 0.05 * this.a.distanceTo(this.b);
      this.span(this.spans[k * 2], this.a, this.m);
      this.span(this.spans[k * 2 + 1], this.m, this.b);
    }
  }

  private readonly d = new THREE.Vector3();
  private span(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    this.d.subVectors(b, a);
    const len = this.d.length();
    mesh.position.copy(a);
    mesh.quaternion.setFromUnitVectors(this.up, this.d.multiplyScalar(1 / Math.max(len, 1e-4)));
    mesh.scale.set(1, len, 1);
  }
}
