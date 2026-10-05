/**
 * The painted intro behind the loading veil: a teal summer sky with soft brush strokes, one big
 * cumulus and a small one drifting slowly, a far headland and the island with its lighthouse on the
 * horizon, a sea with a few glints under the sun, and a single cream wave line across the lower
 * third that draws itself from left to right as the bay loads (the only progress mark, no text).
 * When the bay is ready the line completes and the painting dissolves into the live opening view.
 * Canvas 2D at reduced resolution (it is soft by nature); the layers are painted once per size.
 */

type Ctx = CanvasRenderingContext2D;

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
function paintBackdrop(w: number, h: number): HTMLCanvasElement {
  const [c, g] = layer(w, h);
  const hy = h * HORIZON;
  const sky = g.createLinearGradient(0, 0, 0, hy);
  sky.addColorStop(0, "#168fb0");
  sky.addColorStop(0.45, "#36a9c6");
  sky.addColorStop(0.82, "#9fd6dc");
  sky.addColorStop(1, "#f2e6cc");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, hy + 1);
  // Warm glow toward the sun (upper right).
  const glow = g.createRadialGradient(w * 0.78, hy * 0.55, 0, w * 0.78, hy * 0.55, w * 0.45);
  glow.addColorStop(0, "rgba(255, 244, 214, 0.55)");
  glow.addColorStop(1, "rgba(255, 244, 214, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, w, hy);
  const sea = g.createLinearGradient(0, hy, 0, h);
  sea.addColorStop(0, "#7cbcc6");
  sea.addColorStop(0.18, "#3f97ad");
  sea.addColorStop(0.6, "#25789a");
  sea.addColorStop(1, "#1d6588");
  g.fillStyle = sea;
  g.fillRect(0, hy, w, h - hy);
  const r = rng(77);
  // Brush strokes: long soft horizontal dabs, lighter and darker, over sky and sea.
  for (let i = 0; i < 260; i++) {
    const y = r() * h, x = r() * w;
    const inSea = y > hy;
    const len = (inSea ? 0.05 + r() * 0.16 : 0.08 + r() * 0.22) * w, th = (inSea ? 0.002 + r() * 0.004 : 0.004 + r() * 0.01) * h;
    const light = r() < 0.55;
    g.fillStyle = light ? `rgba(255, 255, 250, ${inSea ? 0.05 + r() * 0.06 : 0.03 + r() * 0.04})` : `rgba(10, 60, 90, ${0.03 + r() * 0.05})`;
    g.beginPath();
    g.ellipse(x, y, len / 2, th, (r() - 0.5) * 0.04, 0, Math.PI * 2);
    g.fill();
  }
  // Far headland on the left, the island and its lighthouse on the right.
  g.fillStyle = "#6f9fb0";
  g.beginPath();
  g.moveTo(0, hy);
  for (let x = 0; x <= w * 0.34; x += w / 160) {
    const t = x / (w * 0.34);
    g.lineTo(x, hy - h * (0.07 * (1 - t * t) + 0.012 * Math.sin(t * 17) * (1 - t)));
  }
  g.lineTo(w * 0.36, hy);
  g.fill();
  g.fillStyle = "#5d8ea2";
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
  // The horizon softened into the haze.
  const hz = g.createLinearGradient(0, hy - h * 0.02, 0, hy + h * 0.03);
  hz.addColorStop(0, "rgba(242, 230, 204, 0)");
  hz.addColorStop(0.5, "rgba(242, 230, 204, 0.35)");
  hz.addColorStop(1, "rgba(242, 230, 204, 0)");
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
function paintCloud(w: number, h: number, seed: number): HTMLCanvasElement {
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
    gr.addColorStop(0, "rgba(196, 210, 224, 1)");
    gr.addColorStop(0.85, "rgba(176, 194, 214, 1)");
    gr.addColorStop(1, "rgba(176, 194, 214, 0)");
    g.fillStyle = gr;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  for (const [x, y, rad] of lobes) {
    const gr = g.createRadialGradient(x + rad * 0.25, y - rad * 0.35, rad * 0.05, x + rad * 0.15, y - rad * 0.2, rad * 0.85);
    gr.addColorStop(0, "rgba(255, 252, 244, 1)");
    gr.addColorStop(0.7, "rgba(248, 246, 240, 0.9)");
    gr.addColorStop(1, "rgba(240, 242, 242, 0)");
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
  base.addColorStop(0, "rgba(150, 170, 196, 0)");
  base.addColorStop(1, "rgba(150, 170, 196, 0.5)");
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
  private raf = 0;
  private readonly t0 = performance.now();
  private done = false;
  private stopped = false;
  private readonly still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** 0…1 load progress (the wave line's drawn length eases toward it). */
  progress = 0;

  constructor(parent: HTMLElement) {
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
    this.backdrop = paintBackdrop(w, h);
    this.clouds = [paintCloud(Math.round(w * 0.42), Math.round(h * 0.3), 11), paintCloud(Math.round(w * 0.2), Math.round(h * 0.15), 23)];
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
    const bx = ((w * 0.08 + t * w * 0.006) % (w + big.width)) - big.width * 0.2;
    g.drawImage(big, bx, h * 0.12);
    const sx = ((w * 0.62 + t * w * 0.009) % (w + small.width)) - small.width * 0.3;
    g.globalAlpha = 0.92;
    g.drawImage(small, sx, h * 0.3);
    g.globalAlpha = 1;
    // A few glints on the sea under the sun, flickering softly.
    const hy = h * HORIZON;
    for (let i = 0; i < 14; i++) {
      const p = Math.sin(t * (1.3 + (i % 5) * 0.37) + i * 2.1) * 0.5 + 0.5;
      if (p < 0.55) continue;
      const x = w * (0.72 + 0.12 * Math.sin(i * 12.9)), y = hy + h * (0.01 + 0.06 * ((i * 0.618) % 1));
      g.fillStyle = `rgba(255, 250, 230, ${((p - 0.55) * 1.6).toFixed(3)})`;
      g.fillRect(x, y, w * (0.006 + 0.01 * ((i * 0.37) % 1)), Math.max(1, h * 0.002));
    }
    // The wave line: drawn as far as the progress, its tip a soft dab of paint.
    const target = this.done ? 1 : this.progress;
    this.shown += (target - this.shown) * 0.08;
    if (target - this.shown < 0.002) this.shown = target;
    const y0 = h * WAVE_Y;
    const end = w * this.shown;
    const lw = Math.max(1.2, h * 0.0024);
    const breathe = this.done ? 0.65 + 0.25 * Math.sin(t * 2.2) : 0.85;
    g.lineWidth = lw;
    g.lineCap = "round";
    g.strokeStyle = `rgba(251, 246, 234, ${breathe.toFixed(3)})`;
    g.beginPath();
    const yAt = (x: number) =>
      y0 + h * (0.009 * Math.sin(x / w * 9.0 - t * 0.9) + 0.005 * Math.sin(x / w * 23.0 + t * 1.4) + 0.003 * Math.sin(x / w * 47.0 - t * 2.1));
    g.moveTo(0, yAt(0));
    for (let x = 0; x <= end; x += Math.max(2, w / 240)) g.lineTo(x, yAt(x));
    if (end > 1) g.lineTo(end, yAt(end));
    g.stroke();
    if (!this.done && end > 1) {
      g.fillStyle = "rgba(255, 252, 244, 0.95)";
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
