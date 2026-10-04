import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { blob, prep, M, ID } from "./geo";
import { SEA_Y } from "./bay/road";
import { skyMaterial, uber } from "../render/materials";
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
    const dome = new THREE.Mesh(new THREE.SphereGeometry(2600, 48, 24), skyMaterial());
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

type Lobe = [number, number, number];
type CloudKind = "tower" | "heap" | "flat";

/**
 * Lobe layout of one cloud in cloud units (half width = 1, base at y = 0): a row of uneven base
 * lobes cut flat by the base, then cauliflower lobes heaped on the upper edges of earlier ones.
 */
function cloudLobes(r: () => number, kind: CloudKind): { lobes: Lobe[]; top: number } {
  const lobes: Lobe[] = [];
  const nBase = kind === "flat" ? 3 + Math.floor(r() * 2) : 3 + Math.floor(r() * 3);
  const big = Math.floor(r() * nBase);
  for (let i = 0; i < nBase; i++) {
    const t = nBase === 1 ? 0.5 : i / (nBase - 1);
    const rad = (kind === "flat" ? range(r, 0.2, 0.32) : range(r, 0.24, 0.38)) * (i === big ? 1.3 : 1);
    const x = (t * 2 - 1) * (0.92 - rad) + range(r, -0.06, 0.06);
    lobes.push([x, rad * range(r, 0.2, 0.55), rad]);
  }
  const extra = kind === "tower" ? 6 + Math.floor(r() * 3) : kind === "heap" ? 3 + Math.floor(r() * 3) : 1 + Math.floor(r() * 2);
  // Tall clouds heap into a broad crown, never a thin column.
  const cap = kind === "tower" ? 1.05 : kind === "heap" ? 0.8 : 0.5;
  for (let k = 0, added = 0; added < extra && k < extra * 4 && lobes.length < CLOUD_LOBES - 1; k++) {
    // Prefer growing from the higher, more central lobes: the tower heaps up, not out.
    let p = lobes[Math.floor(r() * lobes.length)];
    for (let tries = 0; tries < 2; tries++) {
      const o = lobes[Math.floor(r() * lobes.length)];
      if (o[1] + o[2] - Math.abs(o[0]) * 0.5 > p[1] + p[2] - Math.abs(p[0]) * 0.5) p = o;
    }
    const ang = range(r, 0.35, Math.PI - 0.35);
    const rad = Math.max(0.12, p[2] * range(r, 0.55, kind === "tower" ? 1.0 : 0.85));
    const d = p[2] * range(r, 0.5, 0.85);
    let x = p[0] + Math.cos(ang) * d;
    x = Math.max(-0.98 + rad, Math.min(0.98 - rad, x * (kind === "tower" ? 0.8 : 1)));
    const y = p[1] + Math.sin(ang) * d;
    if (y + rad > cap) continue;
    lobes.push([x, y, rad]);
    added++;
  }
  const top = Math.max(...lobes.map((l) => l[1] + l[2]));
  return { lobes, top };
}

/**
 * The painted cumulus field: big towers fairly near, smaller heaps further out and small
 * flattened clouds along the horizon, at natural (jittered) spacing all round the bay. The sky
 * stays clear around the low golden and setting sun so the disc and its path are never hidden.
 */
function cloudField(r: () => number): THREE.Mesh {
  // [count, dist min, dist max, base height min, max, half width min, max, kind, vertical squash, haze]
  const bands: [number, number, number, number, number, number, number, CloudKind, number, number][] = [
    [9, 700, 1050, 210, 300, 95, 170, "tower", 1, 0.0],
    [15, 1050, 1600, 150, 230, 65, 125, "heap", 0.9, 0.1],
    [22, 1600, 2150, 45, 120, 60, 140, "flat", 0.55, 0.3],
  ];
  const suns = [
    [-112, 4.5],
    [-100, 12],
  ].map(([az, el]) => [(az * Math.PI) / 180, (el * Math.PI) / 180]);
  const angDiff = (a: number, b: number) => Math.abs(((a - b + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
  interface C { x: number; y: number; z: number; hw: number; sy: number; haze: number; lobes: Lobe[]; top: number; d: number }
  const clouds: C[] = [];
  for (const [count, d0, d1, y0, y1, w0, w1, kind, sy, haze] of bands) {
    const phase = r() * Math.PI * 2;
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 6; attempt++) {
        const az = phase + ((i + range(r, -0.42, 0.42)) / count) * Math.PI * 2;
        const d = range(r, d0, d1);
        const y = range(r, y0, y1);
        const hw = range(r, w0, w1);
        const { lobes, top } = cloudLobes(r, kind);
        const halfA = Math.atan(hw / d);
        const elLo = Math.atan(y / d), elHi = Math.atan((y + top * hw * sy) / d);
        const hidesSun = suns.some(([sa, se]) => angDiff(az, sa) < halfA + 0.12 && se > elLo - 0.06 && se < elHi + 0.08);
        if (hidesSun) continue;
        clouds.push({ x: Math.sin(az) * d, y, z: Math.cos(az) * d, hw, sy, haze, lobes, top, d });
        break;
      }
    }
  }
  // Far first: the cards are blended in this order.
  clouds.sort((a, b) => b.d - a.d);

  const n = clouds.length;
  const table = new Float32Array(CLOUD_LOBES * n * 4);
  const pos: number[] = [], corner: number[] = [], size: number[] = [], info: number[] = [], idx: number[] = [];
  clouds.forEach((c, row) => {
    c.lobes.forEach((l, i) => table.set([l[0], l[1], l[2], 0], (row * CLOUD_LOBES + i) * 4));
    table.set([c.top, 0, 0, 0], (row * CLOUD_LOBES + CLOUD_LOBES - 1) * 4);
    const seed = r();
    const v0 = pos.length / 3;
    for (const [cx, cy] of [[-1.2, -0.08], [1.2, -0.08], [1.2, c.top + 0.15], [-1.2, c.top + 0.15]]) {
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
