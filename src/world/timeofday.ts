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
  /** 0…1: lit faces take the light's own hue and shade goes cool (low sun, moonlight). */
  keyHue: number;
  sun: RGB; shadow: RGB; rim: RGB;
  zenith: RGB; mid: RGB; horizon: RGB; fog: RGB; fogD: number;
  glow: RGB; glowA: number; glowB: number;
  haze: RGB; hazeA: number;
  hgl: RGB; hglA: number; hglF: number;
  cTop: RGB; cMid: RGB; cLow: RGB; cRim: RGB; cRimK: number; cBack: number; cUnder: RGB; cUnderA: number;
  /** Cirrus colour and strength. */
  wisp: RGB; wispA: number;
  disk: RGB; stars: number; night: number;
  world: RGB; far: RGB; farHaze: number;
  grade: RGB; sat: number;
  bloomS: number; bloomR: number; bloomT: number;
  moonAz: number; moonEl: number; moon: RGB;
  /** Water: body colours, reflection tint, glitter strength / colour, 0…1 glitter follows the moon. */
  wShallow: RGB; wDeep: RGB; wRefl: RGB; glint: number; glintCol: RGB; glintMoon: number;
  /** Glitter path width (facet slope spread) and the broad sheen under the light. */
  gSpread: number; gSheen: number;
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
  // Low sun over the hill: pale peach key, long cool shadows, a softer paler blue than noon.
  morning: {
    az: 140, el: 13, shadeMin: 15, keyHue: 0.15,
    sun: hx("#ffd9b4", 0.98), shadow: hx("#7b8ac4"), rim: hx("#ffd2a8", 1.35),
    zenith: hx("#5a8cc4"), mid: hx("#a6c8e2"), horizon: hx("#f2dccc"), fog: hx("#dedfe2"), fogD: 0.001,
    glow: [1.0, 0.82, 0.62], glowA: 0.24, glowB: 0.36,
    haze: [0.97, 0.9, 0.86], hazeA: 0.5,
    hgl: hx("#ffd2b0"), hglA: 0.38, hglF: 8,
    cTop: [1.0, 0.89, 0.78], cMid: [0.8, 0.81, 0.9], cLow: [0.5, 0.54, 0.72], cRim: [1.0, 0.86, 0.72], cRimK: 0.6, cBack: 0.35,
    cUnder: [1.0, 0.8, 0.68], cUnderA: 0.25,
    wisp: [1.0, 0.93, 0.88], wispA: 0.5, disk: [1.7, 1.5, 1.2], stars: 0, night: 0,
    world: [1.02, 0.98, 0.94], far: [0.94, 0.95, 1.04], farHaze: 0.26,
    grade: [1.02, 1.0, 0.98], sat: 0.98,
    bloomS: 0.3, bloomR: 0.5, bloomT: 0.95,
    moonAz: -78, moonEl: 24, moon: [0.86, 0.88, 0.92],
    wShallow: hx("#86cfc6"), wDeep: hx("#326c9c"), wRefl: [1.0, 0.97, 0.95], glint: 0.55, glintCol: [1.0, 0.9, 0.78], glintMoon: 0,
    gSpread: 0.15, gSheen: 0.12,
    beam: 0,
    evening: 0.25,
    birds: 1,
  },
  noon: {
    az: -150, el: 62, shadeMin: 62, keyHue: 0,
    sun: hx("#fff5e6"), shadow: hx("#8290bc"), rim: hx("#fff1d6"),
    zenith: hx("#1f62b4"), mid: hx("#4fa2e0"), horizon: hx("#cfe4ee"), fog: hx("#cfe0e8"), fogD: 0.00075,
    glow: [1.0, 0.92, 0.75], glowA: 0.12, glowB: 0.25,
    haze: [0.86, 0.9, 0.92], hazeA: 0.45,
    hgl: hx("#ffffff"), hglA: 0, hglF: 6,
    cTop: [1.0, 0.98, 0.94], cMid: [0.8, 0.83, 0.9], cLow: [0.42, 0.47, 0.66], cRim: [1.0, 0.98, 0.92], cRimK: 0.45, cBack: 0.1,
    cUnder: [1.0, 0.9, 0.8], cUnderA: 0,
    wisp: [0.96, 0.97, 1.0], wispA: 0.55, disk: [3.0, 2.9, 2.6], stars: 0, night: 0,
    world: [1.0, 1.0, 1.0], far: [0.96, 1.0, 1.06], farHaze: 0.14,
    grade: [1.0, 1.0, 1.01], sat: 1.06,
    bloomS: 0.26, bloomR: 0.5, bloomT: 1.0,
    moonAz: 0, moonEl: -30, moon: [0, 0, 0],
    wShallow: hx("#58d6c8"), wDeep: hx("#1a5aa0"), wRefl: [1.0, 1.0, 1.0], glint: 0.5, glintCol: [1.0, 0.97, 0.9], glintMoon: 0,
    gSpread: 0.17, gSheen: 0.1,
    beam: 0,
    evening: 0,
    birds: 1,
  },
  // Amber hour: warm grey-blue zenith over a gold sky, cream-gold clouds, warm water.
  golden: {
    az: -100, el: 12, shadeMin: 9, keyHue: 0.45,
    sun: hx("#ffc887", 1.02), shadow: hx("#5b7f90"), rim: hx("#ffbe74", 1.7),
    zenith: hx("#56708c"), mid: hx("#d4b37c"), horizon: hx("#f6cf90"), fog: hx("#dfcaa4"), fogD: 0.001,
    glow: [1.0, 0.72, 0.36], glowA: 0.24, glowB: 0.45,
    haze: [0.98, 0.82, 0.55], hazeA: 0.45,
    hgl: hx("#ffc480"), hglA: 0.45, hglF: 7,
    cTop: [1.0, 0.84, 0.55], cMid: [0.68, 0.54, 0.38], cLow: [0.44, 0.35, 0.3], cRim: [1.0, 0.8, 0.42], cRimK: 0.9, cBack: 0.7,
    cUnder: [1.0, 0.74, 0.38], cUnderA: 0.6,
    wisp: [1.0, 0.86, 0.66], wispA: 0.45, disk: [1.6, 1.3, 0.82], stars: 0, night: 0,
    world: [1.04, 0.96, 0.86], far: [1.0, 0.9, 0.82], farHaze: 0.14,
    grade: [1.02, 1.0, 0.96], sat: 1.0,
    bloomS: 0.26, bloomR: 0.5, bloomT: 1.05,
    moonAz: 0, moonEl: -30, moon: [0, 0, 0],
    wShallow: hx("#a2b590"), wDeep: hx("#2e5a76"), wRefl: [1.1, 0.96, 0.78], glint: 1.0, glintCol: [1.0, 0.84, 0.56], glintMoon: 0,
    gSpread: 0.14, gSheen: 0.16,
    beam: 0,
    evening: 0.8,
    birds: 1,
  },
  // Sun on the horizon: cool grey-violet cloud bodies with orange-gold undersides and rims.
  sunset: {
    az: -112, el: 4.5, shadeMin: 6, keyHue: 0.45,
    sun: hx("#ffa676", 0.92), shadow: hx("#5f5596"), rim: hx("#ff9448", 2.1),
    zenith: hx("#34497a"), mid: hx("#c08ca4"), horizon: hx("#ffab68"), fog: hx("#8a76a2"), fogD: 0.0008,
    glow: [1.0, 0.6, 0.28], glowA: 0.4, glowB: 0.55,
    haze: [1.0, 0.66, 0.42], hazeA: 0.38,
    hgl: hx("#ff8a5c"), hglA: 0.6, hglF: 5,
    cTop: [0.46, 0.33, 0.38], cMid: [0.3, 0.22, 0.3], cLow: [0.18, 0.14, 0.23], cRim: [1.0, 0.62, 0.28], cRimK: 0.9, cBack: 0.7,
    cUnder: [1.0, 0.5, 0.2], cUnderA: 0.95,
    wisp: [1.0, 0.62, 0.48], wispA: 0.45, disk: [2.0, 1.55, 1.05], stars: 0, night: 0.3,
    world: [0.94, 0.84, 0.8], far: [0.5, 0.4, 0.62], farHaze: 0.2,
    grade: [1.02, 0.98, 0.96], sat: 1.05,
    bloomS: 0.3, bloomR: 0.45, bloomT: 1.05,
    moonAz: 0, moonEl: -30, moon: [0, 0, 0],
    wShallow: hx("#9a90a2"), wDeep: hx("#2a3868"), wRefl: [1.05, 0.9, 0.85], glint: 1.0, glintCol: [1.0, 0.66, 0.38], glintMoon: 0,
    gSpread: 0.12, gSheen: 0.14,
    beam: 0.3,
    evening: 0.95,
    birds: 0.5,
  },
  // After the sun: dark slate clouds with thin pink rims, the first stars high up.
  dusk: {
    az: -116, el: -3, shadeMin: 18, keyHue: 0.4,
    sun: hx("#535d96"), shadow: hx("#40497a"), rim: hx("#ff9a6a", 0.7),
    zenith: hx("#141a46"), mid: hx("#3a4c7c"), horizon: hx("#dd8e6c"), fog: hx("#343c66"), fogD: 0.0009,
    glow: [1.0, 0.55, 0.35], glowA: 0.18, glowB: 0.12,
    haze: [0.56, 0.45, 0.56], hazeA: 0.3,
    hgl: hx("#ff9a60"), hglA: 0.55, hglF: 14,
    cTop: [0.3, 0.27, 0.4], cMid: [0.2, 0.2, 0.33], cLow: [0.11, 0.12, 0.23], cRim: [1.0, 0.5, 0.6], cRimK: 0.95, cBack: 0.6,
    cUnder: [0.9, 0.42, 0.5], cUnderA: 0.55,
    wisp: [0.16, 0.13, 0.22], wispA: 0.25, disk: [0, 0, 0], stars: 0.45, night: 1,
    world: [0.4, 0.44, 0.64], far: [0.32, 0.34, 0.56], farHaze: 0.3,
    grade: [0.97, 0.98, 1.04], sat: 1.05,
    bloomS: 0.6, bloomR: 0.55, bloomT: 0.85,
    moonAz: -62, moonEl: 11, moon: [0.95, 0.88, 0.72],
    wShallow: hx("#4a5a86"), wDeep: hx("#18204a"), wRefl: [1.0, 1.0, 1.0], glint: 0.25, glintCol: [1.0, 0.62, 0.45], glintMoon: 0,
    gSpread: 0.12, gSheen: 0.1,
    beam: 1,
    evening: 1.0,
    birds: 0,
  },
  // Moonlight: cool weak clouds lit only on the moon side, haze and far land darker than the sky.
  night: {
    az: -84, el: 19, shadeMin: 15, keyHue: 0.55,
    sun: hx("#7d90c8", 0.66), shadow: hx("#26305e"), rim: hx("#a8bce8", 0.8),
    zenith: hx("#071131"), mid: hx("#172a5a"), horizon: hx("#33497e"), fog: hx("#141d3e"), fogD: 0.0007,
    glow: [0.62, 0.72, 0.98], glowA: 0.1, glowB: 0.22,
    haze: [0.2, 0.25, 0.44], hazeA: 0.3,
    hgl: hx("#3a4e86"), hglA: 0.22, hglF: 10,
    cTop: [0.13, 0.155, 0.27], cMid: [0.07, 0.09, 0.18], cLow: [0.04, 0.05, 0.11], cRim: [0.8, 0.84, 0.95], cRimK: 0.6, cBack: 0.55,
    cUnder: [0.2, 0.22, 0.38], cUnderA: 0.05,
    wisp: [0.035, 0.05, 0.11], wispA: 0.3, disk: [0, 0, 0], stars: 1, night: 1,
    world: [0.3, 0.35, 0.58], far: [0.17, 0.21, 0.4], farHaze: 0.22,
    grade: [0.96, 0.98, 1.06], sat: 1.05,
    bloomS: 0.6, bloomR: 0.55, bloomT: 0.85,
    moonAz: -84, moonEl: 19, moon: [0.95, 0.88, 0.7],
    wShallow: hx("#1e3a5e"), wDeep: hx("#08122e"), wRefl: [0.9, 0.92, 1.0], glint: 0.75, glintCol: [1.0, 0.92, 0.74], glintMoon: 1,
    gSpread: 0.13, gSheen: 0.14,
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
    G.uKeyHue.value = l.keyHue;
    G.uWisp.value.setRGB(...l.wisp);
    G.uWispAmt.value = l.wispA;
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
    G.uGlintShape.value.set(l.gSpread, l.gSheen);
    // Clouds are lit by the sun (even just below the horizon at dusk), by the moon at night.
    G.uCloudLight.value.copy(G.uGlintDir.value);
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
