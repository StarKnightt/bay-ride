import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { blob, prep, M, ID } from "./geo";
import { SEA_Y } from "./bay/road";
import { uber } from "../render/materials";
import { skyDomeMaterial } from "./skyDome";
import { CLOUD_LOBES, paintedCloudMaterial } from "../render/cloudPaint";
import { LAYER_REFLECT, onLayers } from "../render/lightpasses";
import { mulberry32, range } from "../core/rng";

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Sky and distance. The dome (gradient, sun disk, painted moon, stars, cirrus) follows the camera;
 * the painted cumulus cards and the distant ridges are fixed around the bay, ridges only on the
 * land side so the sea horizon stays open.
 */
export class Sky {
  /** Follows the camera. */
  readonly group = new THREE.Group();
  /** Fixed around the bay: clouds and ridges. */
  readonly far = new THREE.Group();

  constructor() {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(4100, 48, 24), skyDomeMaterial());
    dome.frustumCulled = false;
    dome.renderOrder = -10;
    this.group.add(dome);

    this.far.add(cloudField(mulberry32(77)));

    // Distant layers behind the hill: forested ridges, then painted blue mountains fading lighter
    // (aerial perspective). Arcs centred on the land side (+X); the far bands reach further round.
    const LAND = Math.PI / 2;
    const layers: [number, number, number, string, number, number][] = [
      [820, 150, 1, "#2f5a40", M.foliage, 1.45],
      [1100, 215, 4, "#3f6a5a", M.foliage, 1.6],
      [1450, 260, 2, "#6c90a8", M.distant, 1.85],
      [1800, 330, 3, "#90aec2", M.distant, 2.0],
      [2300, 450, 6, "#b3c8d6", M.distant, 2.05],
    ];
    layers.forEach(([rad, h, s, color, mat, half], i) => {
      const g = ridge(rad, h, s * 13 + 5, color, mat, i < 2, i === 4, LAND - half, LAND + half);
      const m = new THREE.Mesh(g, uber(ID.hills, i < 2 ? 0.5 : 0.0, THREE.DoubleSide));
      m.frustumCulled = false;
      this.far.add(m);
    });
    this.far.position.set(60, SEA_Y, 0);
    onLayers(this.group, LAYER_REFLECT);
    onLayers(this.far, LAYER_REFLECT);

    // Light motes drifting on the wind (wrapped around the camera in the shader).
    const r = mulberry32(78);
    const n = 160;
    const mote = prep(new THREE.PlaneGeometry(0.06, 0.06), "#ffffff", M.mote);
    const im = new THREE.InstancedMesh(mote, uber(ID.sky, -1, THREE.DoubleSide), n);
    const m4 = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const s = range(r, 0.6, 1.4);
      m4.makeScale(s, s, s).setPosition(range(r, -18, 18), range(r, 0.3, 5), range(r, -18, 18));
      im.setMatrixAt(i, m4);
    }
    im.frustumCulled = false;
    // Sunbeam dust only floats under canopies; the open coast has none yet.
    im.visible = false;
    this.motes = im;
  }

  /** Added to the scene separately: must not follow the sky group (the shader wraps it). */
  readonly motes: THREE.InstancedMesh;

  follow(cam: THREE.Vector3): void {
    this.group.position.set(cam.x, 0, cam.z);
  }
}

/** x, y, radius, depth (toward the camera; the front-most lobe sphere at a pixel shades it). */
type Lobe = [number, number, number, number];
type CloudKind = "cumulus" | "heap" | "strata";

const clampX = (x: number, rad: number) => Math.max(-0.97 + rad, Math.min(0.97 - rad, x));

/**
 * Lobe layout of one cloud in cloud units (half width = 1, base at y = 0). Towering cumulus: a
 * broad base under a tall body heaped off-centre, its crown broken into small cauliflower bumps.
 * Heaps: one to three lopsided masses with a few bumps. Strata: a long, thin, wavy strip of
 * small lobes that swells and breaks along its length. Higher masses sit further back, so the
 * lower ones overlap their bases; bumps sit on the surface of the lobe they grow from.
 */
function cloudLobes(r: () => number, kind: CloudKind): { lobes: Lobe[]; top: number } {
  const lobes: Lobe[] = [];
  const max = CLOUD_LOBES - 1;
  const add = (x: number, y: number, rad: number, depth = -y * 0.15 + r() * 0.18 * rad / 0.3) => {
    if (lobes.length < max) lobes.push([clampX(x, rad), y, rad, depth]);
  };
  // Small cauliflower bumps on the upper edges of the big masses.
  const bumps = (n: number, r0: number, r1: number) => {
    const body = lobes.slice();
    for (let k = 0; k < n && lobes.length < max; k++) {
      const b = body[Math.floor(r() * body.length)];
      const ang = range(r, 0.25, Math.PI - 0.25);
      const s = range(r, r0, r1);
      const d = b[2] - s * range(r, 0.15, 0.55);
      const onParent = b[3] + Math.sqrt(Math.max(0, b[2] * b[2] - d * d));
      add(b[0] + Math.cos(ang) * d, b[1] + Math.sin(ang) * d, s, onParent - s * range(r, 0.35, 0.6));
    }
  };
  if (kind === "strata") {
    // Overlapping lobes so the strip reads as one band that swells, thins and sometimes breaks.
    const n = 6 + Math.floor(r() * 6);
    const phase = r() * 6.28;
    const step = 1.7 / n;
    const gap = r() < 0.4 ? Math.floor(r() * n) : -1;
    for (let i = 0, x = -0.85 + range(r, 0, 0.06); i < n && x < 0.9; i++, x += step * range(r, 0.8, 1.15)) {
      if (i === gap) continue;
      const swell = 0.6 + 0.7 * Math.max(0, Math.sin(x * 2.1 + phase));
      const rad = step * swell * range(r, 0.85, 1.2);
      add(x, rad * range(r, 0.7, 0.95) + 0.02 * Math.sin(x * 4 + phase), rad, r() * 0.03);
    }
  } else if (kind === "cumulus") {
    // Broad base, a tall body heaped off-centre, then cauliflower bumps round the crown.
    const nb = 3 + Math.floor(r() * 2);
    for (let i = 0; i < nb; i++) {
      const rad = range(r, 0.26, 0.36);
      add(((i / (nb - 1)) * 2 - 1) * (0.8 - rad) + range(r, -0.05, 0.05), rad * range(r, 0.45, 0.65), rad);
    }
    const cx = range(r, -0.25, 0.25);
    const tiers = 2 + Math.floor(r() * 2);
    let y = 0.3;
    for (let k = 0; k < tiers; k++) {
      y += range(r, 0.2, 0.26);
      const rad = range(r, 0.3, 0.38) * (1 - k * 0.1);
      add(cx + range(r, -0.18, 0.18), y, rad);
      if (r() < 0.6) add(cx + range(r, -0.35, 0.35), y - range(r, 0.05, 0.15), rad * range(r, 0.65, 0.85));
    }
    bumps(Math.min(max - lobes.length, 12 + Math.floor(r() * 7)), 0.08, 0.16);
  } else {
    // Lopsided heap: one to three big masses, maybe a raised shoulder, a few bumps.
    const nb = 1 + Math.floor(r() * 3);
    for (let i = 0; i < nb; i++) {
      const rad = range(r, 0.26, 0.42) * (nb === 1 ? 1.25 : 1);
      add(nb === 1 ? range(r, -0.15, 0.15) : ((i / (nb - 1)) * 2 - 1) * (0.78 - rad) + range(r, -0.08, 0.08), rad * range(r, 0.35, 0.6), rad);
    }
    if (r() < 0.6) {
      const b = lobes[Math.floor(r() * lobes.length)];
      add(b[0] + range(r, -0.2, 0.2), b[1] + b[2] * range(r, 0.5, 0.8), b[2] * range(r, 0.6, 0.8));
    }
    if (r() < 0.5) add(range(r, -0.75, 0.75), range(r, 0.06, 0.12), range(r, 0.12, 0.2));
    bumps(8 + Math.floor(r() * 9), 0.07, 0.15);
  }
  const top = Math.max(...lobes.map((l) => l[1] + l[2]));
  return { lobes, top };
}

/**
 * The painted cloud field around the bay: a few big towering cumulus, medium heaps of every
 * size in depth, a nearer high layer, and long flat strata low on the horizon. Clouds at similar
 * depths never overlap on the sky (so their cards can't cut through each other), and the sky
 * stays clear around the low golden and setting sun.
 */
function cloudField(r: () => number): THREE.Mesh {
  const DEG = Math.PI / 180;
  const suns = [
    [-112, 4.5],
    [-100, 12],
  ].map(([az, el]) => [az * DEG, el * DEG]);
  const angDiff = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  interface C { x: number; y: number; z: number; hw: number; sy: number; haze: number; lobes: Lobe[]; top: number; d: number; az: number; halfA: number; elLo: number; elHi: number }
  const clouds: C[] = [];
  const tryAdd = (kind: CloudKind, az: number, d: number, y: number, hw: number, sy: number, haze: number): boolean => {
    const { lobes, top } = cloudLobes(r, kind);
    const halfA = Math.atan((hw * 1.05) / d);
    const elLo = Math.atan(y / d), elHi = Math.atan((y + top * hw * sy) / d);
    // The low play cameras' frame top sits ~15-25 deg up: no cloud may cross it (a flat-bottomed
    // cloud sliced by the frame edge reads as a cut card). Towering cumulus get a little more.
    if (elHi > (kind === "cumulus" ? 0.3 : kind === "heap" ? 0.25 : 0.4)) return false;
    if (suns.some(([sa, se]) => angDiff(az, sa) < halfA + 0.12 && se > elLo - 0.06 && se < elHi + 0.08)) return false;
    for (const c of clouds) {
      if (angDiff(az, c.az) > halfA + c.halfA + 0.015) continue;
      if (elHi < c.elLo - 0.01 || elLo > c.elHi + 0.01) continue;
      if (Math.abs(d - c.d) < 0.35 * Math.max(d, c.d)) return false;
    }
    clouds.push({ x: Math.sin(az) * d, y, z: Math.cos(az) * d, hw, sy, haze, lobes, top, d, az, halfA, elLo, elHi });
    return true;
  };

  // Big towering cumulus: toward the harbour, either side of the island view, over the hill.
  for (const az0 of [-160, -66, 74, 158]) {
    for (let k = 0; k < 30; k++) {
      if (tryAdd("cumulus", (az0 + range(r, -8, 8)) * DEG, range(r, 1000, 1300), range(r, 70, 110), range(r, 200, 290), range(r, 0.9, 1.05), 0.02)) break;
    }
  }
  // [count, dist min, max, base height min, max, half width min, max, kind, squash min, max, haze]
  const bands: [number, number, number, number, number, number, number, CloudKind, number, number, number][] = [
    [8, 450, 800, 55, 110, 40, 100, "heap", 0.75, 1.0, 0.0],
    [20, 800, 1750, 90, 200, 55, 190, "heap", 0.7, 1.0, 0.06],
    [16, 1800, 2700, 115, 190, 140, 380, "strata", 0.45, 0.7, 0.14],
  ];
  for (const [count, d0, d1, y0, y1, w0, w1, kind, s0, s1, haze] of bands) {
    for (let i = 0; i < count; i++) {
      for (let k = 0; k < 30; k++) {
        // Skewed toward the small end: many medium and small clouds, a few large ones.
        const hw = w0 + (w1 - w0) * Math.pow(r(), 1.6);
        if (tryAdd(kind, r() * Math.PI * 2, range(r, d0, d1), range(r, y0, y1), hw, range(r, s0, s1), haze)) break;
      }
    }
  }
  // Far first: the cards are blended in this order.
  clouds.sort((a, b) => b.d - a.d);

  const n = clouds.length;
  const table = new Float32Array(CLOUD_LOBES * n * 4);
  const pos: number[] = [], corner: number[] = [], size: number[] = [], info: number[] = [], idx: number[] = [];
  clouds.forEach((c, row) => {
    c.lobes.forEach((l, i) => table.set(l, (row * CLOUD_LOBES + i) * 4));
    table.set([c.top, 0, 0, 0], (row * CLOUD_LOBES + CLOUD_LOBES - 1) * 4);
    const seed = r();
    const v0 = pos.length / 3;
    // The lobes' smooth union swells the outline past the lobe circles (up to ~0.2 cloud units with
    // many lobes), so the card keeps a wide margin: a tighter one sliced the outline straight.
    for (const [cx, cy] of [[-1.45, -0.1], [1.45, -0.1], [1.45, c.top + 0.4], [-1.45, c.top + 0.4]]) {
      pos.push(c.x, c.y, c.z);
      corner.push(cx, cy);
      size.push(c.hw, c.sy);
      info.push(row, seed, c.haze);
    }
    idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
  });
  const tex = new THREE.DataTexture(table, CLOUD_LOBES, n, THREE.RGBAFormat, THREE.FloatType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aCorner", new THREE.Float32BufferAttribute(corner, 2));
  g.setAttribute("aSize", new THREE.Float32BufferAttribute(size, 2));
  g.setAttribute("aInfo", new THREE.Float32BufferAttribute(info, 3));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, paintedCloudMaterial(tex));
  m.frustumCulled = false;
  m.renderOrder = -5;
  return m;
}

/**
 * One distant ridge band on an arc [a0, a1] (azimuth from -Z toward +X), sinking into the sea at
 * both ends so the open-water horizon stays clear.
 */
function ridge(rad: number, h: number, seed: number, color: string, mat: number, forest: boolean, peaks: boolean, a0: number, a1: number): THREE.BufferGeometry {
  const span = a1 - a0;
  const seg = Math.ceil((forest ? 360 : 200) * (span / (Math.PI * 2)));
  const taper = (a: number) => {
    const t = (a - a0) / span;
    return smooth01(t / 0.16) * smooth01((1 - t) / 0.16);
  };
  const rows = forest ? 10 : 5;
  const pos: number[] = [];
  const idx: number[] = [];
  const s = seed;
  const prof = (a: number) => {
    if (peaks) {
      // Far range: a few soft peaks with long saddles between them.
      const v = Math.pow(Math.abs(Math.sin(a * 2.5 + s)), 2.2) * 0.55 + Math.pow(Math.abs(Math.sin(a * 5 + s * 1.3)), 3) * 0.3 + Math.sin(a * 17 + s) * 0.03;
      return h * Math.max(0.1, 0.12 + v);
    }
    const v = Math.sin(a * 3 + s) * 0.35 + Math.sin(a * 7 + s * 1.7) * 0.25 + Math.sin(a * 13 + s * 0.3) * 0.15 + Math.sin(a * 29 + s) * 0.06;
    return h * Math.max(0.12, 0.5 + v);
  };
  // Gullies and spurs: the slope bends in and out, so the sun paints lit and shaded faces.
  const gully = (a: number, t: number) => Math.sin(a * 61 + s + t * 2.0) * 0.5 + Math.sin(a * 23 + s * 2.3 - t) * 0.5;
  for (let i = 0; i <= seg; i++) {
    const a = a0 + (i / seg) * span;
    const tp = taper(a);
    const top = prof(a) * tp - 14 * (1 - tp);
    for (let j = 0; j <= rows; j++) {
      const t = j / rows;
      const y = -6 + (top + 6) * Math.sin((t * Math.PI) / 2);
      const rr = rad + (1 - t) * rad * 0.08 + (forest ? gully(a, t) * rad * 0.012 * Math.sin(t * Math.PI) : 0);
      pos.push(Math.sin(a) * rr, y, -Math.cos(a) * rr);
    }
  }
  for (let i = 0; i < seg; i++)
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j, b = a + 1, c = a + rows + 1, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  const g0 = new THREE.BufferGeometry();
  g0.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g0.setIndex(idx);
  g0.computeVertexNormals();
  const g = prep(g0.toNonIndexed(), color, mat);
  g.computeVertexNormals();
  if (!forest) return g;

  // Painted slope patches: darker forest, lighter meadow on the lower slopes.
  const base = new THREE.Color(color);
  const lit = base.clone().lerp(new THREE.Color("#6f9a48"), 0.45);
  const dark = base.clone().multiplyScalar(0.72);
  const cAttr = g.attributes.color as THREE.BufferAttribute;
  const p = g.attributes.position;
  const tmp = new THREE.Color();
  const rr = mulberry32(seed);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(x, -z);
    const n = Math.sin(a * 37 + s) * Math.sin(a * 11 - s + y * 0.05) * 0.5 + 0.5;
    tmp.copy(base).lerp(n > 0.6 ? lit : dark, Math.abs(n - 0.5) * 1.4);
    cAttr.setXYZ(i, tmp.r, tmp.g, tmp.b);
  }
  cAttr.needsUpdate = true;

  // Layered tree-mass bumps along the ridgeline and a second row lower down the slope.
  const parts: THREE.BufferGeometry[] = [g];
  const step = 5.5 * (rad / 430);
  const n = Math.floor((span * rad) / step);
  for (let k = 0; k < n; k++) {
    const a = a0 + (k / n) * span + rr() * 0.004;
    const tp = taper(a);
    if (tp < 0.35) continue;
    const top = prof(a) * tp - 14 * (1 - tp);
    for (const row of [0, 1]) {
      if (row === 1 && rr() > 0.55) continue;
      const bR = (row === 0 ? range(rr, 5, 10) : range(rr, 4, 7)) * (rad / 430);
      const y = (row === 0 ? top - bR * 0.25 : top * range(rr, 0.45, 0.8));
      const d = rad - bR * 0.2 + (row === 0 ? 0 : -rad * 0.004);
      const b = blob(bR, 1, 0.2, k * 7 + row);
      b.scale(1, range(rr, 0.7, 1.0), 1);
      b.translate(Math.sin(a) * d, y, -Math.cos(a) * d);
      const shade = row === 0 ? range(rr, 0.8, 1.05) : range(rr, 0.7, 0.95);
      parts.push(prep(b.index ? b.toNonIndexed() : b, base.clone().multiplyScalar(shade), mat));
    }
  }
  const merged = mergeGeometries(parts.map((x) => { x.deleteAttribute("uv"); return x; }), false)!;
  return merged;
}
