import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { blob, prep, spherize, M, ID } from "./geo";
import { SEA_Y } from "./bay/road";
import { cloudMaterial, skyMaterial, uber } from "../render/materials";
import { LAYER_REFLECT, onLayers } from "../render/lightpasses";
import { mulberry32, range } from "../core/rng";

const smooth01 = (x: number) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Sky and distance. The dome (gradient, sun disk, painted moon, stars, cirrus) follows the camera;
 * the cumulus towers and the distant ridges are fixed around the bay, ridges only on the land
 * side so the sea horizon stays open. Drifting light motes wrap around the camera in the shader.
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

    const cm = cloudMaterial();
    const r = mulberry32(77);
    // Hand-placed cumulus (azimuth in radians from -Z toward +X, distance, size, tallness).
    // The heaviest towers stand over the open sea (-X), where the sun goes down.
    const SEA = -Math.PI / 2;
    const spots: [number, number, number, number][] = [
      [0.28, 2300, 560, 2.3], // the big towering one near the horizon
      [-0.42, 1450, 290, 1.1],
      [0.75, 1350, 280, 1.2],
      [-1.15, 1300, 220, 0.9],
      [1.25, 1400, 260, 1.1],
      [-0.12, 2000, 170, 0.6],
      [1.9, 1500, 180, 0.9],
      [-1.9, 1500, 170, 0.85],
      [2.7, 1400, 200, 1.0],
      [-2.6, 1500, 190, 0.9],
      [3.14, 1600, 170, 0.8],
    ];
    for (const [az, dist, size, tall] of spots) {
      const g = cumulus(size, tall, Math.floor(r() * 1e6));
      const m = new THREE.Mesh(g, cm);
      m.position.set(Math.sin(az + SEA) * dist, range(r, 110, 150), -Math.cos(az + SEA) * dist);
      m.rotation.y = r() * 6.28;
      m.frustumCulled = false;
      this.far.add(m);
    }

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
    this.motes = im;
  }

  /** Added to the scene separately: must not follow the sky group (the shader wraps it). */
  readonly motes: THREE.InstancedMesh;

  follow(cam: THREE.Vector3): void {
    this.group.position.set(cam.x, 0, cam.z);
  }
}

/** Cauliflower cumulus: flat floor, heaped towers, crisp secondary lobes; normals partly spherized. */
function cumulus(size: number, tall: number, seed: number): THREE.BufferGeometry {
  const r = mulberry32(seed);
  const parts: THREE.BufferGeometry[] = [];
  const n = 24 + Math.round(tall * 6);
  const top = size * (0.5 + tall * 0.55);
  const big: { x: number; y: number; z: number; rad: number }[] = [];
  const lobe = (g: THREE.BufferGeometry, x: number, y: number, z: number) => {
    const c = new Float32Array(g.attributes.position.count * 3);
    for (let k = 0; k < c.length; k += 3) (c[k] = x), (c[k + 1] = y), (c[k + 2] = z);
    g.setAttribute("aLobe", new THREE.BufferAttribute(c, 3));
  };
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const a = r() * Math.PI * 2;
    // Base lobes stay tucked in so the flat floor is one clean line, not stacked slabs.
    const spread = size * (1 - t * 0.72) * range(r, 0.3, 0.95) * (0.7 + 0.3 * Math.min(1, t * 4));
    const y = t * top * range(r, 0.72, 1.0);
    const rad = size * range(r, 0.22, 0.36) * (1 - t * 0.35);
    const x = Math.cos(a) * spread, z = Math.sin(a) * spread * 0.55;
    const g = blob(rad, 2, 0.12, seed + i * 3.7);
    const cy = y + rad * 0.5;
    g.translate(x, cy, z);
    lobe(g, x, cy, z);
    parts.push(g);
    big.push({ x, y: cy, z, rad });
  }
  // Secondary cauliflower lobes on the upper surfaces.
  for (let i = 0; i < 34; i++) {
    const b = big[Math.floor(r() * big.length)];
    const u = range(r, 0.15, 1), a = r() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const rad = b.rad * range(r, 0.22, 0.38);
    const g = blob(rad, 1, 0.15, seed + 100 + i);
    const lx = b.x + Math.cos(a) * s * b.rad * 0.92, ly = b.y + u * b.rad * 0.92, lz = b.z + Math.sin(a) * s * b.rad * 0.92;
    g.translate(lx, ly, lz);
    lobe(g, lx, ly, lz);
    parts.push(g);
  }
  // Small bulges around the outer flanks so the vertical sides never read as flat walls.
  for (let i = 0; i < 22; i++) {
    let b = big[Math.floor(r() * big.length)];
    for (let k = 0; k < 2; k++) {
      const o = big[Math.floor(r() * big.length)];
      if (Math.hypot(o.x, o.z) > Math.hypot(b.x, b.z)) b = o;
    }
    const out = Math.atan2(b.z, b.x) + range(r, -0.9, 0.9);
    const u = range(r, -0.25, 0.4), s = Math.sqrt(1 - u * u);
    const rad = b.rad * range(r, 0.2, 0.34);
    const g = blob(rad, 1, 0.15, seed + 300 + i);
    const lx = b.x + Math.cos(out) * s * b.rad * 0.9, ly = b.y + u * b.rad * 0.9, lz = b.z + Math.sin(out) * s * b.rad * 0.9;
    g.translate(lx, ly, lz);
    lobe(g, lx, ly, lz);
    parts.push(g);
  }
  const merged = mergeGeometries(parts, false)!;
  const p = merged.attributes.position;
  let ymin = Infinity, ymax = -Infinity;
  const floor = size * 0.14;
  for (let i = 0; i < p.count; i++) {
    let y = p.getY(i);
    // Flat horizontal base with a slightly rounded lip (no hard step where lobes are cut).
    if (y < floor + size * 0.04) {
      const d = floor + size * 0.04 - y;
      y = floor + size * 0.04 - (size * 0.04) * (1 - Math.exp(-d / (size * 0.04)));
    }
    p.setY(i, y);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  merged.computeVertexNormals();
  spherize(merged, new THREE.Vector3(0, top * 0.35, 0), 0.3, 0.8);
  const h = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) h[i] = (p.getY(i) - ymin) / (ymax - ymin);
  merged.setAttribute("aH", new THREE.BufferAttribute(h, 1));
  return merged;
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
