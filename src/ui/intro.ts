/**
 * The painted intro behind the loading veil: a teal summer sky with soft brush strokes, one big
 * cumulus and a small one drifting slowly, a far headland and the island with its lighthouse on the
 * horizon, a sea with a few glints under the sun, and a single cream wave line across the lower
 * third that draws itself from left to right as the bay loads (the only progress mark, no text).
 * When the bay is ready the line completes and the painting dissolves into the live opening view.
 * It is painted in the time of day the game opens in (morning teal, noon teal, golden, sunset, dusk,
 * moonlit night), so the dissolve never jumps between skies.
 * Canvas 2D at reduced resolution (it is soft by nature); the layers are painted once per size.
 */
import type { Preset } from "../world/timeofday";

type Ctx = CanvasRenderingContext2D;
type RGB = [number, number, number];
const rgba = (c: RGB, a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a.toFixed(3)})`;

/** One time of day: sky and sea gradients (top to bottom), light glow, land, haze and cloud tones. */
interface Palette {
  sky: [string, string, string, string];
  sea: [string, string, string, string];
  /** Sun or moon glow: centre (fraction of width, fraction of the sky height), colour, alpha, radius. */
  glow: [number, number, RGB, number, number];
  headland: string;
  island: string;
  haze: RGB;
  /** Dark brush strokes. */
  ink: RGB;
  cloudBody: RGB;
  cloudLit: RGB;
  cloudBase: RGB;
  cloudA: number;
  glint: RGB;
  line: RGB;
  stars: number;
  moon: boolean;
  lamp: boolean;
}

export const PALETTES: Record<Preset, Palette> = {
  morning: {
    sky: ["#2b98ad", "#5bb5c6", "#b6d8d6", "#f3dfc9"], sea: ["#9ccac8", "#4f9db0", "#2f7c9c", "#24688a"],
    glow: [0.84, 0.86, [255, 222, 186], 0.5, 0.5], headland: "#7fa5b0", island: "#6c94a4", haze: [243, 223, 201], ink: [10, 60, 90],
    cloudBody: [186, 198, 214], cloudLit: [255, 242, 226], cloudBase: [160, 172, 196], cloudA: 1, glint: [255, 240, 220], line: [251, 246, 234], stars: 0, moon: false, lamp: false,
  },
  noon: {
    sky: ["#168fb0", "#36a9c6", "#9fd6dc", "#dcefe6"], sea: ["#7cbcc6", "#3f97ad", "#25789a", "#1d6588"],
    glow: [0.78, 0.55, [255, 244, 214], 0.45, 0.45], headland: "#6f9fb0", island: "#5d8ea2", haze: [226, 240, 232], ink: [10, 60, 90],
    cloudBody: [176, 194, 214], cloudLit: [255, 252, 244], cloudBase: [150, 170, 196], cloudA: 1, glint: [255, 250, 230], line: [251, 246, 234], stars: 0, moon: false, lamp: false,
  },
  golden: {
    sky: ["#3f7a8e", "#b3a684", "#ebc78c", "#f6d49a"], sea: ["#e2c18c", "#8f9a86", "#3a6a80", "#28506a"],
    glow: [0.8, 0.9, [255, 204, 128], 0.6, 0.55], headland: "#7d8a8a", island: "#6a7a7e", haze: [246, 214, 160], ink: [60, 50, 40],
    cloudBody: [184, 160, 140], cloudLit: [255, 228, 172], cloudBase: [150, 124, 110], cloudA: 1, glint: [255, 222, 150], line: [255, 240, 214], stars: 0, moon: false, lamp: false,
  },
  sunset: {
    sky: ["#2c5078", "#9c7f9c", "#e9a58c", "#ffb878"], sea: ["#e8a07a", "#8a7896", "#3a4c78", "#25335a"],
    glow: [0.8, 0.97, [255, 150, 90], 0.65, 0.6], headland: "#5c5470", island: "#4f4866", haze: [255, 180, 130], ink: [40, 30, 60],
    cloudBody: [104, 82, 106], cloudLit: [255, 172, 112], cloudBase: [84, 64, 92], cloudA: 0.95, glint: [255, 190, 120], line: [255, 226, 200], stars: 0, moon: false, lamp: true,
  },
  dusk: {
    sky: ["#141a46", "#34467a", "#8a6e88", "#dd8e6c"], sea: ["#8a7a9a", "#4e5a92", "#2c3466", "#1a2048"],
    glow: [0.8, 0.98, [221, 142, 108], 0.35, 0.6], headland: "#2f3458", island: "#282c50", haze: [200, 130, 120], ink: [8, 10, 30],
    cloudBody: [52, 52, 86], cloudLit: [120, 100, 136], cloudBase: [40, 40, 72], cloudA: 0.9, glint: [255, 170, 130], line: [236, 226, 236], stars: 0.45, moon: false, lamp: true,
  },
  night: {
    sky: ["#071131", "#122452", "#22386a", "#33497e"], sea: ["#2c4470", "#1a3058", "#10224a", "#0a1838"],
    glow: [0.76, 0.3, [214, 222, 236], 0.22, 0.32], headland: "#101a38", island: "#0d1634", haze: [60, 80, 130], ink: [2, 6, 20],
    cloudBody: [24, 30, 56], cloudLit: [64, 74, 108], cloudBase: [18, 22, 46], cloudA: 0.85, glint: [220, 228, 244], line: [214, 222, 240], stars: 1, moon: true, lamp: true,
  },
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HORIZON = 0.63;
const WAVE_Y = 0.8;

function layer(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Sky, far land and sea, with brush-stroke texture. */
function paintBackdrop(w: number, h: number, P: Palette): HTMLCanvasElement {
  const [c, g] = layer(w, h);
  const hy = h * HORIZON;
  const sky = g.createLinearGradient(0, 0, 0, hy);
  [0, 0.45, 0.82, 1].forEach((t, i) => sky.addColorStop(t, P.sky[i]));
  g.fillStyle = sky;
  g.fillRect(0, 0, w, hy + 1);
  const r = rng(77);
  if (P.stars > 0) {
    // Soft painted stars; at dusk fewer and only high up.
    for (let i = 0; i < 220; i++) {
      const x = r() * w, y = r() * hy * 0.85, k = r();
      if (y > hy * (0.25 + 0.55 * P.stars)) continue;
      g.fillStyle = `rgba(240, 242, 255, ${((0.3 + 0.6 * k) * P.stars).toFixed(3)})`;
      g.beginPath();
      g.arc(x, y, Math.max(0.6, h * (0.0012 + 0.0016 * k)), 0, Math.PI * 2);
      g.fill();
    }
  }
  // Glow round the sun (or the moon).
  const [gx, gy, gc, ga, gr] = P.glow;
  const glow = g.createRadialGradient(w * gx, hy * gy, 0, w * gx, hy * gy, w * gr);
  glow.addColorStop(0, rgba(gc, ga));
  glow.addColorStop(1, rgba(gc, 0));
  g.fillStyle = glow;
  g.fillRect(0, 0, w, hy);
  if (P.moon) {
    const mr = h * 0.022;
    g.fillStyle = "#eef0ea";
    g.beginPath();
    g.arc(w * gx, hy * gy, mr, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(170, 172, 168, 0.35)";
    g.beginPath();
    g.arc(w * gx - mr * 0.3, hy * gy - mr * 0.15, mr * 0.35, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.arc(w * gx + mr * 0.25, hy * gy + mr * 0.3, mr * 0.25, 0, Math.PI * 2);
    g.fill();
  }
  const sea = g.createLinearGradient(0, hy, 0, h);
  [0, 0.18, 0.6, 1].forEach((t, i) => sea.addColorStop(t, P.sea[i]));
  g.fillStyle = sea;
  g.fillRect(0, hy, w, h - hy);
  // Brush strokes: long soft horizontal dabs, lighter and darker, over sky and sea.
  for (let i = 0; i < 260; i++) {
    const y = r() * h, x = r() * w;
    const inSea = y > hy;
    const len = (inSea ? 0.05 + r() * 0.16 : 0.08 + r() * 0.22) * w, th = (inSea ? 0.002 + r() * 0.004 : 0.004 + r() * 0.01) * h;
    const light = r() < 0.55;
    const la = (inSea ? 0.05 + r() * 0.06 : 0.03 + r() * 0.04) * (P.stars > 0 ? 0.35 : 1);
    g.fillStyle = light ? `rgba(255, 255, 250, ${la.toFixed(3)})` : rgba(P.ink, 0.03 + r() * 0.05);
    g.beginPath();
    g.ellipse(x, y, len / 2, th, (r() - 0.5) * 0.04, 0, Math.PI * 2);
    g.fill();
  }
  // Far headland on the left, the island and its lighthouse on the right.
  g.fillStyle = P.headland;
  g.beginPath();
  g.moveTo(0, hy);
  for (let x = 0; x <= w * 0.34; x += w / 160) {
    const t = x / (w * 0.34);
    g.lineTo(x, hy - h * (0.07 * (1 - t * t) + 0.012 * Math.sin(t * 17) * (1 - t)));
  }
  g.lineTo(w * 0.36, hy);
  g.fill();
  g.fillStyle = P.island;
  const ix = w * 0.66, iw = w * 0.11;
  g.beginPath();
  g.moveTo(ix - iw / 2, hy);
  g.quadraticCurveTo(ix - iw * 0.2, hy - h * 0.045, ix, hy - h * 0.05);
  g.quadraticCurveTo(ix + iw * 0.25, hy - h * 0.042, ix + iw / 2, hy);
  g.fill();
  const lw = Math.max(2, w * 0.004), lh = h * 0.05;
  g.fillStyle = "#f4f0e6";
  g.fillRect(ix - lw / 2, hy - h * 0.048 - lh, lw, lh);
  g.fillStyle = "#c8473a";
  g.fillRect(ix - lw / 2, hy - h * 0.048 - lh * 0.55, lw, lh * 0.16);
  g.fillRect(ix - lw * 0.7, hy - h * 0.048 - lh - lw * 0.8, lw * 1.4, lw * 0.9);
  if (P.lamp) {
    // The lighthouse lamp is lit from sunset on.
    const ly = hy - h * 0.048 - lh - lw * 0.35;
    const lg = g.createRadialGradient(ix, ly, 0, ix, ly, h * 0.03);
    lg.addColorStop(0, "rgba(255, 236, 190, 0.95)");
    lg.addColorStop(0.25, "rgba(255, 214, 150, 0.4)");
    lg.addColorStop(1, "rgba(255, 214, 150, 0)");
    g.fillStyle = lg;
    g.fillRect(ix - h * 0.03, ly - h * 0.03, h * 0.06, h * 0.06);
  }
  // The horizon softened into the haze.
  const hz = g.createLinearGradient(0, hy - h * 0.02, 0, hy + h * 0.03);
  hz.addColorStop(0, rgba(P.haze, 0));
  hz.addColorStop(0.5, rgba(P.haze, 0.35));
  hz.addColorStop(1, rgba(P.haze, 0));
  g.fillStyle = hz;
  g.fillRect(0, hy - h * 0.02, w, h * 0.05);
  // Paper grain.
  const n = g.getImageData(0, 0, w, h);
  const d = n.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = (r() - 0.5) * 7;
    d[i] += k;
    d[i + 1] += k;
    d[i + 2] += k;
  }
  g.putImageData(n, 0, 0);
  return c;
}

/** A painted cumulus: overlapping lobes, sunlit tops, blue-grey shaded base. */
function paintCloud(w: number, h: number, seed: number, P: Palette): HTMLCanvasElement {
  const [c, g] = layer(w, h);
  const r = rng(seed);
  const lobes: [number, number, number][] = [];
  for (let i = 0; i < 26; i++) {
    const t = r();
    const x = w * (0.12 + 0.76 * t), base = h * 0.78;
    const rad = h * (0.12 + 0.24 * Math.sin(Math.PI * t) * (0.6 + 0.4 * r()));
    lobes.push([x + (r() - 0.5) * w * 0.05, base - rad * (0.4 + 0.9 * r()) * Math.sin(Math.PI * t), rad]);
  }
  lobes.sort((a, b) => b[1] - a[1]);
  // Shadowed body first, then the lit tops offset toward the sun.
  for (const [x, y, rad] of lobes) {
    const gr = g.createRadialGradient(x, y + rad * 0.2, rad * 0.2, x, y, rad);
    const b = P.cloudBody;
    gr.addColorStop(0, rgba([Math.min(255, b[0] + 20), Math.min(255, b[1] + 16), Math.min(255, b[2] + 10)], 1));
    gr.addColorStop(0.85, rgba(b, 1));
    gr.addColorStop(1, rgba(b, 0));
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  for (const [x, y, rad] of lobes) {
    const gr = g.createRadialGradient(x + rad * 0.25, y - rad * 0.35, rad * 0.05, x + rad * 0.15, y - rad * 0.2, rad * 0.85);
    gr.addColorStop(0, rgba(P.cloudLit, 1));
    gr.addColorStop(0.7, rgba(P.cloudLit, 0.9));
    gr.addColorStop(1, rgba(P.cloudLit, 0));
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x + rad * 0.12, y - rad * 0.16, rad * 0.86, 0, Math.PI * 2);
    g.fill();
  }
  // Flat, slightly cool base.
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = "rgba(0,0,0,1)";
  g.fillRect(0, h * 0.84, w, h * 0.16);
  g.globalCompositeOperation = "source-over";
  const base = g.createLinearGradient(0, h * 0.62, 0, h * 0.84);
  base.addColorStop(0, rgba(P.cloudBase, 0));
  base.addColorStop(1, rgba(P.cloudBase, 0.5));
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = base;
  g.fillRect(0, h * 0.62, w, h * 0.22);
  g.globalCompositeOperation = "source-over";
  return c;
}

export class PaintedIntro {
  readonly canvas = document.createElement("canvas");
  private readonly g: Ctx;
  private backdrop: HTMLCanvasElement | null = null;
  private clouds: HTMLCanvasElement[] = [];
  private w = 0;
  private h = 0;
  private shown = 0;
  private lastP = 0;
  private lastPT = performance.now();
  private raf = 0;
  private readonly t0 = performance.now();
  private done = false;
  private stopped = false;
  private readonly still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** 0…1 load progress (the wave line's drawn length eases toward it). */
  progress = 0;
  private readonly pal: Palette;

  constructor(parent: HTMLElement, preset: Preset = "golden") {
    this.pal = PALETTES[preset];
    this.g = this.canvas.getContext("2d")!;
    this.canvas.className = "intro";
    const css = document.createElement("style");
    css.textContent = `
      #loader canvas.intro { position: absolute; inset: 0; width: 100%; height: 100%; transition: opacity 1.6s ease; }
      #loader:not(.ready) .bar { opacity: 0; }
      #loader.ready canvas.intro { opacity: 0; }
      #loader .bar { position: relative; z-index: 1; }`;
    document.head.appendChild(css);
    parent.prepend(this.canvas);
    this.resize();
    addEventListener("resize", this.onResize);
    this.draw(performance.now());
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly onResize = () => this.resize();

  private resize(): void {
    // Half resolution: the painting is soft, and it costs the boot almost nothing.
    const k = Math.min(1, Math.max(0.5, 900 / Math.max(innerHeight, 1)));
    const w = Math.max(320, Math.round(innerWidth * k)), h = Math.max(180, Math.round(innerHeight * k));
    if (w === this.w && h === this.h) return;
    this.w = this.canvas.width = w;
    this.h = this.canvas.height = h;
    this.backdrop = paintBackdrop(w, h, this.pal);
    this.clouds = [paintCloud(Math.round(w * 0.42), Math.round(h * 0.3), 11, this.pal), paintCloud(Math.round(w * 0.2), Math.round(h * 0.15), 23, this.pal)];
  }

  private readonly frame = (now: number) => {
    if (this.stopped) return;
    this.draw(now);
    this.raf = requestAnimationFrame(this.frame);
  };

  private draw(now: number): void {
    const { g, w, h } = this;
    if (!this.backdrop) return;
    const t = this.still ? 0 : (now - this.t0) / 1000;
    g.drawImage(this.backdrop, 0, 0);
    // Clouds drift slowly to the right and wrap.
    const [big, small] = this.clouds;
    const P = this.pal;
    const bx = ((w * 0.08 + t * w * 0.006) % (w + big.width)) - big.width * 0.2;
    g.globalAlpha = P.cloudA;
    g.drawImage(big, bx, h * 0.12);
    const sx = ((w * 0.62 + t * w * 0.009) % (w + small.width)) - small.width * 0.3;
    g.globalAlpha = 0.92 * P.cloudA;
    g.drawImage(small, sx, h * 0.3);
    g.globalAlpha = 1;
    // A few glints on the sea under the sun, flickering softly.
    const hy = h * HORIZON;
    for (let i = 0; i < 14; i++) {
      const p = Math.sin(t * (1.3 + (i % 5) * 0.37) + i * 2.1) * 0.5 + 0.5;
      if (p < 0.55) continue;
      const x = w * (P.glow[0] - 0.06 + 0.12 * Math.sin(i * 12.9)), y = hy + h * (0.01 + 0.06 * ((i * 0.618) % 1));
      g.fillStyle = rgba(P.glint, (p - 0.55) * 1.6 * (P.moon ? 0.7 : 1));
      g.fillRect(x, y, w * (0.006 + 0.01 * ((i * 0.37) % 1)), Math.max(1, h * 0.002));
    }
    // The wave line: drawn as far as the progress, its tip a soft dab of paint.
    // A long stall (the sea's compile, up to a minute on a first visit) must never look frozen: the
    // tip keeps creeping on, slower and slower, at most a fifth of the way past the real progress.
    if (this.progress !== this.lastP) {
      this.lastP = this.progress;
      this.lastPT = now;
    }
    const creep = (Math.min(0.97, this.progress + 0.2) - this.progress) * (1 - Math.exp(-(now - this.lastPT) / 30000));
    const target = this.done ? 1 : Math.max(this.shown, this.progress + creep);
    this.shown += (target - this.shown) * 0.08;
    if (target - this.shown < 0.002) this.shown = target;
    const y0 = h * WAVE_Y;
    const end = w * this.shown;
    const lw = Math.max(1.2, h * 0.0024);
    const breathe = this.done ? 0.65 + 0.25 * Math.sin(t * 2.2) : 0.85;
    g.lineWidth = lw;
    g.lineCap = "round";
    g.strokeStyle = rgba(P.line, breathe);
    g.beginPath();
    const yAt = (x: number) =>
      y0 + h * (0.009 * Math.sin(x / w * 9.0 - t * 0.9) + 0.005 * Math.sin(x / w * 23.0 + t * 1.4) + 0.003 * Math.sin(x / w * 47.0 - t * 2.1));
    g.moveTo(0, yAt(0));
    for (let x = 0; x <= end; x += Math.max(2, w / 240)) g.lineTo(x, yAt(x));
    if (end > 1) g.lineTo(end, yAt(end));
    g.stroke();
    if (!this.done && end > 1) {
      g.fillStyle = rgba(P.line, 0.95);
      g.beginPath();
      g.arc(end, yAt(end), lw * 1.6, 0, Math.PI * 2);
      g.fill();
    }
  }

  /** Loaded: complete the line (the veil's CSS fades the painting into the live view). */
  ready(): void {
    this.done = true;
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    removeEventListener("resize", this.onResize);
  }
}
