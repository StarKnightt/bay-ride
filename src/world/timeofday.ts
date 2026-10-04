import * as THREE from "three";
import { G } from "../render/materials";
import { TOD_GRADE } from "../render/todUniforms";
import type { Post } from "../render/post";
import type { SunShadow } from "../render/lightpasses";

/**
 * Time of day: morning → noon → golden hour → sunset → dusk → night. Each preset is a flat table of
 * light / sky / cloud / water / grade values; the current state is interpolated between presets
 * and written into the shared uniforms (`G`, the grade pass, the bloom pass).
 *
 * Bearings: azimuth = atan2(x, z) in degrees. The open sea lies toward -X (-90°), the hill and the
 * town toward +X (+90°), the harbour toward -Z (±180°). The sun rises over the hill and sets over
 * the sea, a little toward the island and its lighthouse.
 */
export const PRESETS = ["morning", "noon", "golden", "sunset", "dusk", "night"] as const;
export type Preset = (typeof PRESETS)[number];
export const PRESET_LABELS: Record<Preset, string> = {
  morning: "morning",
  noon: "noon",
  golden: "golden hour",
  sunset: "sunset",
  dusk: "dusk",
  night: "night",
};

type RGB = [number, number, number];
interface Look {
  az: number; // key light azimuth (the sun; the moon at night), degrees
  el: number; // true elevation of that light (sky glow, disk, clouds, shadows)
  shadeMin: number; // shading light never goes lower than this (keeps flat ground readable)
  sun: RGB; shadow: RGB; rim: RGB;
  zenith: RGB; mid: RGB; horizon: RGB; fog: RGB; fogD: number;
  glow: RGB; glowA: number; glowB: number;
  haze: RGB; hazeA: number;
  hgl: RGB; hglA: number; hglF: number;
  cTop: RGB; cMid: RGB; cLow: RGB; cRim: RGB; cRimK: number; cBack: number; cUnder: RGB; cUnderA: number;
  wisp: RGB; disk: RGB; stars: number; night: number;
  world: RGB; far: RGB; farHaze: number;
  grade: RGB; sat: number;
  bloomS: number; bloomR: number; bloomT: number;
  moonAz: number; moonEl: number; moon: RGB;
  /** Water: body colours, reflection tint, glitter strength / colour, 0…1 glitter follows the moon. */
  wShallow: RGB; wDeep: RGB; wRefl: RGB; glint: number; glintCol: RGB; glintMoon: number;
  /** Lighthouse lamp and beam. */
  beam: number;
  evening: number;
  birds: number; // share of seabirds aloft
}

/** Values the water (and lit windows / lighthouse) read for the current time of day. */
export interface WaterLook {
  shallow: THREE.Color;
  deep: THREE.Color;
  reflTint: THREE.Color;
  glitter: number;
  night: number;
  beam: number;
}

/** sRGB hex → linear (what `new THREE.Color(hex)` stores), optionally scaled. */
const hx = (hex: string, k = 1): RGB => {
  const c = new THREE.Color(hex);
  return [c.r * k, c.g * k, c.b * k];
};

const DEG = Math.PI / 180;

// Art direction: painted anime summer seaside. Saturated gradient skies, big sunlit cumulus with
// lavender shadow sides, warm rim light; the sea goes from clear turquoise shallows to deep blue,
// gold and rose at sunset, indigo with a moon path at night.
const LOOKS: Record<Preset, Look> = {
  morning: {
    az: 78, el: 14, shadeMin: 16,
    sun: hx("#ffe6c8"), shadow: hx("#8a8fba"), rim: hx("#ffd8b0", 1.3),
    zenith: hx("#3a7fc0"), mid: hx("#8cc2e2"), horizon: hx("#f4dccb"), fog: hx("#e3e2df"), fogD: 0.0013,
    glow: [1.0, 0.84, 0.64], glowA: 0.22, glowB: 0.35,
    haze: [0.97, 0.9, 0.86], hazeA: 0.55,
    hgl: hx("#ffd5b8"), hglA: 0.35, hglF: 8,
    cTop: [1.0, 0.93, 0.84], cMid: [0.84, 0.83, 0.9], cLow: [0.48, 0.5, 0.67], cRim: [1.0, 0.9, 0.78], cRimK: 0.55, cBack: 0.35,
    cUnder: [1.0, 0.82, 0.72], cUnderA: 0.2,
    wisp: [1.0, 0.94, 0.9], disk: [2.4, 2.15, 1.75], stars: 0, night: 0,
    world: [1.02, 0.99, 0.95], far: [0.98, 0.98, 1.02], farHaze: 0.28,
    grade: [1.0, 1.0, 1.0], sat: 1.04,
    bloomS: 0.3, bloomR: 0.5, bloomT: 0.95,
    moonAz: -78, moonEl: 24, moon: [0.86, 0.88, 0.92],
    wShallow: hx("#7cd8cc"), wDeep: hx("#2a6aa2"), wRefl: [1.0, 0.98, 0.96], glint: 0.55, glintCol: [1.0, 0.92, 0.8], glintMoon: 0,
    beam: 0,
    evening: 0.25,
    birds: 1,
  },
  noon: {
    az: -150, el: 62, shadeMin: 62,
    sun: hx("#fff5e6"), shadow: hx("#8290bc"), rim: hx("#fff1d6"),
    zenith: hx("#1f62b4"), mid: hx("#4fa2e0"), horizon: hx("#cde6f0"), fog: hx("#cfe2e8"), fogD: 0.0009,
    glow: [1.0, 0.92, 0.75], glowA: 0.12, glowB: 0.25,
    haze: [0.86, 0.9, 0.9], hazeA: 0.4,
    hgl: hx("#ffffff"), hglA: 0, hglF: 6,
    cTop: [1.0, 0.98, 0.94], cMid: [0.8, 0.83, 0.9], cLow: [0.4, 0.45, 0.64], cRim: [1.0, 0.98, 0.92], cRimK: 0.5, cBack: 0.1,
    cUnder: [1.0, 0.9, 0.8], cUnderA: 0,
    wisp: [0.96, 0.97, 1.0], disk: [3.0, 2.9, 2.6], stars: 0, night: 0,
    world: [1.0, 1.0, 1.0], far: [0.98, 1.0, 1.04], farHaze: 0.12,
    grade: [1.0, 1.0, 1.01], sat: 1.06,
    bloomS: 0.26, bloomR: 0.5, bloomT: 1.0,
    moonAz: 0, moonEl: -30, moon: [0, 0, 0],
    wShallow: hx("#58d6c8"), wDeep: hx("#1a5aa0"), wRefl: [1.0, 1.0, 1.0], glint: 0.5, glintCol: [1.0, 0.97, 0.9], glintMoon: 0,
    beam: 0,
    evening: 0,
    birds: 1,
  },
  golden: {
    az: -100, el: 12, shadeMin: 15,
    sun: hx("#ffc98a", 1.02), shadow: hx("#8583ad"), rim: hx("#ffc07a", 1.7),
    zenith: hx("#1b5c80"), mid: hx("#4d9cbc"), horizon: hx("#f4d6a8"), fog: hx("#e4d3b2"), fogD: 0.0011,
    glow: [1.0, 0.7, 0.36], glowA: 0.3, glowB: 0.5,
    haze: [0.96, 0.8, 0.58], hazeA: 0.42,
    hgl: hx("#ffc58a"), hglA: 0.45, hglF: 7,
    cTop: [1.0, 0.86, 0.6], cMid: [0.86, 0.74, 0.72], cLow: [0.44, 0.42, 0.62], cRim: [1.0, 0.86, 0.6], cRimK: 0.6, cBack: 0.5,
    cUnder: [1.0, 0.7, 0.45], cUnderA: 0.25,
    wisp: [1.0, 0.88, 0.74], disk: [2.2, 1.85, 1.3], stars: 0, night: 0,
    world: [1.05, 0.97, 0.87], far: [1.02, 0.94, 0.88], farHaze: 0.1,
    grade: [1.02, 1.0, 0.97], sat: 1.08,
    bloomS: 0.34, bloomR: 0.5, bloomT: 0.95,
    moonAz: 0, moonEl: -30, moon: [0, 0, 0],
    wShallow: hx("#88c8ae"), wDeep: hx("#245a80"), wRefl: [1.05, 0.95, 0.82], glint: 1.0, glintCol: [1.0, 0.84, 0.58], glintMoon: 0,
    beam: 0,
    evening: 0.8,
    birds: 1,
  },
  sunset: {
    az: -112, el: 4.5, shadeMin: 13,
    sun: hx("#f7ae82", 0.88), shadow: hx("#6f5f96"), rim: hx("#ff9448", 2.2),
    zenith: hx("#2a4a7a"), mid: hx("#b98aac"), horizon: hx("#ffb070"), fog: hx("#8f7aa8"), fogD: 0.0009,
    glow: [1.0, 0.6, 0.28], glowA: 0.42, glowB: 0.6,
    haze: [1.0, 0.64, 0.4], hazeA: 0.38,
    hgl: hx("#ff8a5c"), hglA: 0.62, hglF: 5,
    cTop: [1.0, 0.76, 0.46], cMid: [0.95, 0.56, 0.52], cLow: [0.42, 0.3, 0.5], cRim: [1.0, 0.72, 0.38], cRimK: 0.6, cBack: 0.5,
    cUnder: [1.0, 0.6, 0.36], cUnderA: 0.75,
    wisp: [1.0, 0.62, 0.5], disk: [2.6, 1.95, 1.2], stars: 0, night: 0.3,
    world: [0.98, 0.86, 0.8], far: [0.52, 0.42, 0.64], farHaze: 0.2,
    grade: [1.02, 0.98, 0.96], sat: 1.12,
    bloomS: 0.42, bloomR: 0.55, bloomT: 0.95,
    moonAz: 0, moonEl: -30, moon: [0, 0, 0],
    wShallow: hx("#a39aa6"), wDeep: hx("#2e3c6c"), wRefl: [1.05, 0.9, 0.85], glint: 1.0, glintCol: [1.0, 0.68, 0.4], glintMoon: 0,
    beam: 0.3,
    evening: 0.95,
    birds: 0.5,
  },
  dusk: {
    az: -116, el: -3, shadeMin: 18,
    sun: hx("#535d96"), shadow: hx("#444e80"), rim: hx("#ff9a6a", 0.7),
    zenith: hx("#141a46"), mid: hx("#3a4c7c"), horizon: hx("#dd8e6c"), fog: hx("#3c4570"), fogD: 0.001,
    glow: [1.0, 0.55, 0.35], glowA: 0.18, glowB: 0.12,
    haze: [0.56, 0.45, 0.56], hazeA: 0.3,
    hgl: hx("#ff9a60"), hglA: 0.55, hglF: 14,
    cTop: [0.36, 0.31, 0.47], cMid: [0.25, 0.24, 0.4], cLow: [0.13, 0.14, 0.27], cRim: [0.9, 0.55, 0.45], cRimK: 0.25, cBack: 0.25,
    cUnder: [0.8, 0.44, 0.42], cUnderA: 0.4,
    wisp: [0.6, 0.5, 0.66], disk: [0, 0, 0], stars: 0.7, night: 1,
    world: [0.42, 0.46, 0.66], far: [0.4, 0.43, 0.66], farHaze: 0.35,
    grade: [0.97, 0.98, 1.04], sat: 1.05,
    bloomS: 0.7, bloomR: 0.6, bloomT: 0.8,
    moonAz: -62, moonEl: 11, moon: [0.9, 0.86, 0.8],
    wShallow: hx("#4a5a86"), wDeep: hx("#18204a"), wRefl: [1.0, 1.0, 1.0], glint: 0.25, glintCol: [1.0, 0.62, 0.45], glintMoon: 0,
    beam: 1,
    evening: 1.0,
    birds: 0,
  },
  night: {
    az: -84, el: 19, shadeMin: 22,
    sun: hx("#7d90c8", 0.72), shadow: hx("#2c3666"), rim: hx("#a8bce8", 0.8),
    zenith: hx("#071131"), mid: hx("#172a5a"), horizon: hx("#36508a"), fog: hx("#1f2d58"), fogD: 0.0011,
    glow: [0.62, 0.72, 0.98], glowA: 0.1, glowB: 0.22,
    haze: [0.24, 0.3, 0.5], hazeA: 0.3,
    hgl: hx("#40568e"), hglA: 0.25, hglF: 10,
    cTop: [0.3, 0.35, 0.53], cMid: [0.16, 0.19, 0.34], cLow: [0.07, 0.09, 0.19], cRim: [0.62, 0.7, 0.9], cRimK: 0.45, cBack: 0.4,
    cUnder: [0.3, 0.32, 0.5], cUnderA: 0.1,
    wisp: [0.34, 0.4, 0.62], disk: [0, 0, 0], stars: 1, night: 1,
    world: [0.36, 0.42, 0.66], far: [0.3, 0.36, 0.6], farHaze: 0.4,
    grade: [0.96, 0.98, 1.06], sat: 1.05,
    bloomS: 0.75, bloomR: 0.6, bloomT: 0.75,
    moonAz: -84, moonEl: 19, moon: [0.94, 0.92, 0.84],
    wShallow: hx("#1e3a5e"), wDeep: hx("#08122e"), wRefl: [1.0, 1.0, 1.0], glint: 0.75, glintCol: [0.85, 0.92, 1.1], glintMoon: 1,
    beam: 1,
    evening: 1,
    birds: 0,
  },
};

/** a→b by k, written into `out` (reused every frame: no per-frame allocation). */
function mix(a: Look, b: Look, k: number, out: Look): Look {
  const o = out as unknown as Record<string, number | RGB>;
  for (const key of Object.keys(a) as (keyof Look)[]) {
    const x = a[key], y = b[key];
    if (Array.isArray(x)) {
      const r = o[key] as RGB, yy = y as RGB;
      for (let i = 0; i < 3; i++) r[i] = x[i] + (yy[i] - x[i]) * k;
    } else o[key] = (x as number) + ((y as number) - (x as number)) * k;
  }
  return out;
}

const cloneLook = (l: Look): Look => {
  const o = { ...l } as unknown as Record<string, number | RGB>;
  for (const k in o) if (Array.isArray(o[k])) o[k] = [...(o[k] as RGB)] as RGB;
  return o as unknown as Look;
};

const dirFrom = (v: THREE.Vector3, azDeg: number, elDeg: number) => {
  const a = azDeg * DEG, e = elDeg * DEG;
  return v.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
};

/** Seconds for a preset transition, and for the full timelapse (morning → night). */
const TRANSITION = 3.6;
const TIMELAPSE = 60;

export function parsePreset(s: string | null | undefined): Preset | null {
  if (!s) return null;
  const k = s.toLowerCase().replace(/[^a-z]/g, "");
  if (k === "goldenhour") return "golden";
  return (PRESETS as readonly string[]).includes(k) ? (k as Preset) : null;
}

export class TimeOfDay {
  private readonly looks: Look[] = PRESETS.map((p) => LOOKS[p]);
  private from: Look;
  private to: Look;
  private k = 1;
  private idx: number;
  private cur: Look;
  private lapse: boolean;
  private lapseT = 0;
  /** Scratch look the transitions/timelapse blend into. */
  private readonly blend: Look;
  private lapseDone = false;
  private dirty = true;
  private readonly shadowDir = new THREE.Vector3();
  private readonly listeners: ((p: Preset) => void)[] = [];
  private readonly _water: WaterLook = {
    shallow: new THREE.Color(), deep: new THREE.Color(), reflTint: new THREE.Color(), glitter: 0, night: 0, beam: 0,
  };

  constructor(private post: Post, private shadow: SunShadow, start: Preset, timelapse = false) {
    this.idx = PRESETS.indexOf(start);
    this.cur = this.from = this.to = this.looks[this.idx];
    this.blend = cloneLook(this.looks[0]);
    this.lapse = timelapse;
    if (this.lapse) this.idx = 0;
    this.apply(this.lapse ? this.looks[0] : this.cur);
  }

  get preset(): Preset {
    return PRESETS[this.idx];
  }
  get evening(): number {
    return this.cur.evening;
  }
  get birds(): number {
    return this.cur.birds;
  }
  get night(): number {
    return this.cur.night;
  }
  /** Water colours, reflection tint, glitter strength and the night / lighthouse flags. */
  get water(): WaterLook {
    const w = this._water, l = this.cur;
    w.shallow.setRGB(...l.wShallow);
    w.deep.setRGB(...l.wDeep);
    w.reflTint.setRGB(...l.wRefl);
    w.glitter = l.glint;
    w.night = l.night;
    w.beam = l.beam;
    return w;
  }

  onChange(fn: (p: Preset) => void): void {
    this.listeners.push(fn);
  }

  /** Next preset (wraps night → morning), with a smooth transition from wherever we are now. */
  cycle(): void {
    this.set(PRESETS[(this.idx + 1) % PRESETS.length]);
  }

  set(p: Preset, instant = false): void {
    this.lapse = false;
    this.idx = PRESETS.indexOf(p);
    // `cur` may be the scratch blend: freeze a copy as the start of the new transition.
    this.from = cloneLook(this.cur);
    this.to = this.looks[this.idx];
    this.k = instant ? 1 : 0;
    if (instant) this.cur = this.to;
    this.dirty = true;
    for (const fn of this.listeners) fn(p);
  }

  /** Continuous 0…5 position along morning → … → night. */
  private along(s: number): Look {
    const n = this.looks.length - 1;
    const i = Math.min(n - 1, Math.floor(s));
    const f = s - i;
    return mix(this.looks[i], this.looks[i + 1], f * f * (3 - 2 * f) * 0.35 + f * 0.65, this.blend);
  }

  update(dt: number): void {
    const n = this.looks.length - 1;
    if (this.lapse && !this.lapseDone) {
      this.lapseT += dt;
      const s = Math.min(n, Math.max(0, ((this.lapseT - 2) / (TIMELAPSE - 4)) * n));
      this.cur = this.along(s);
      this.idx = Math.min(n, Math.round(s));
      if (s >= n) {
        this.lapseDone = true;
        this.cur = this.looks[n];
      }
      this.dirty = true;
    } else if (this.k < 1) {
      this.k = Math.min(1, this.k + dt / TRANSITION);
      const e = this.k * this.k * (3 - 2 * this.k);
      this.cur = this.k >= 1 ? this.to : mix(this.from, this.to, e, this.blend);
      this.dirty = true;
    }
    if (this.dirty) {
      this.apply(this.cur);
      this.dirty = false;
    }
  }

  private apply(l: Look): void {
    dirFrom(G.uSkySun.value, l.az, l.el);
    dirFrom(G.uSunDir.value, l.az, Math.max(l.el, l.shadeMin));
    // Shadows follow the true light but never from below the horizon.
    this.shadow.dir = dirFrom(this.shadowDir, l.az, Math.max(l.el, 3));
    G.uSunColor.value.setRGB(...l.sun);
    G.uShadowTint.value.setRGB(...l.shadow);
    G.uRimColor.value.setRGB(...l.rim);
    G.uSkyZenith.value.setRGB(...l.zenith);
    G.uSkyMid.value.setRGB(...l.mid);
    G.uSkyHorizon.value.setRGB(...l.horizon);
    G.uFogColor.value.setRGB(...l.fog);
    G.uFogDensity.value = l.fogD;
    G.uSunGlow.value.setRGB(...l.glow);
    G.uSunGlowAmt.value.set(l.glowA, l.glowB);
    G.uHaze.value.setRGB(...l.haze);
    G.uHazeAmt.value = l.hazeA;
    G.uHorizGlow.value.setRGB(...l.hgl);
    G.uHorizGlowK.value.set(l.hglA, l.hglF);
    G.uCloudTop.value.setRGB(...l.cTop);
    G.uCloudMid.value.setRGB(...l.cMid);
    G.uCloudLow.value.setRGB(...l.cLow);
    G.uCloudRim.value.setRGB(...l.cRim);
    G.uCloudK.value.set(l.cRimK, l.cBack, l.cUnderA);
    G.uCloudUnder.value.setRGB(...l.cUnder);
    G.uWisp.value.setRGB(...l.wisp);
    G.uSunDisk.value.setRGB(...l.disk);
    G.uStars.value = l.stars;
    G.uNight.value = l.night;
    G.uWorldTint.value.setRGB(...l.world);
    G.uFarTint.value.setRGB(...l.far);
    G.uFarHaze.value = l.farHaze;
    dirFrom(G.uMoonDir.value, l.moonAz, l.moonEl);
    G.uMoonCol.value.setRGB(...l.moon);
    G.uGlint.value = l.glint;
    G.uGlintDir.value.copy(G.uSkySun.value).lerp(G.uMoonDir.value, l.glintMoon).normalize();
    G.uGlintCol.value.setRGB(...l.glintCol);
    G.uWaterShallow.value.setRGB(...l.wShallow);
    G.uWaterDeep.value.setRGB(...l.wDeep);
    G.uWaterRefl.value.setRGB(...l.wRefl);
    G.uBeam.value = l.beam;
    TOD_GRADE.uGradeMul.value.setRGB(...l.grade);
    TOD_GRADE.uSat.value = l.sat;
    this.post.bloom.strength = l.bloomS;
    this.post.bloom.radius = l.bloomR;
    this.post.bloom.threshold = l.bloomT;
  }
}
