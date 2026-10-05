import { Biq, clamp, filt, lerp, mode, normPeak, note, rr, smooth, smoothstep, sn, type Rng } from "./dsp";
import { GEN_SR, type Kit } from "./kit";

/** Ground under a footstep. The world reports the first six; RideAudio tells stone lanes and water apart. */
export type StepSurface = "asphalt" | "grass" | "dirt" | "sand" | "wetsand" | "wood" | "stone" | "water";
export const STEP_SURFACES: StepSurface[] = ["asphalt", "grass", "dirt", "sand", "wetsand", "wood", "stone", "water"];

const L_STEP = 0.2;
const L_LAND = 0.16;
/** Per-surface trim so they sit at a similar, quiet loudness. */
const TRIM: Record<StepSurface, number> = { asphalt: 0.8, grass: 0.8, dirt: 0.85, sand: 1, wetsand: 1, wood: 0.9, stone: 0.75, water: 0.85 };
/** The body's padded thud under a landing on each surface (level, playback rate: wood rings higher, sand swallows it). */
const THUD: Record<StepSurface, [number, number]> = {
  asphalt: [0.6, 1],
  grass: [0.5, 0.95],
  dirt: [0.55, 0.95],
  sand: [0.45, 0.85],
  wetsand: [0.55, 0.9],
  wood: [0.9, 1.2],
  stone: [0.6, 1.05],
  water: [0, 1],
};
/** Water deeper than this (m) is waded through (a slower, heavier slosh) rather than splashed. */
const WADE_DEPTH = 0.14;

/** Final warm roll-off shared by every step (keeps grit and grain well under 6 kHz). */
function soften(d: Float32Array, sr: number): Float32Array {
  filt(d, new Biq("lp", sr, 3000, 0.6));
  return filt(d, new Biq("lp", sr, 3400, 0.6));
}

/** Rounded envelope: smooth rise over `att`, exponential fall with time constant `tau`. */
const env = (t: number, att: number, tau: number) => (t < att ? smooth(t / att) : Math.exp(-(t - att) / tau));

/** Soft-soled shoe on the promenade: a muted heel and a short toe brush. */
function asphalt(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.18));
  const bp = new Biq("bp", sr, rr(r, 900, 1300), 0.9);
  const lp = new Biq("lp", sr, 1600, 0.7);
  const f0 = rr(r, 80, 105);
  const toe = rr(r, 0.025, 0.035);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const w = r() * 2 - 1;
    const scuff = t > toe ? env(t - toe, 0.006, 0.03) * 0.35 : 0;
    d[i] = bp.run(w) * env(t, 0.007, 0.014) * 0.8 + lp.run(w) * scuff + Math.sin(2 * Math.PI * f0 * t) * env(t, 0.007, 0.025) * 0.5;
  }
  filt(d, new Biq("lp", sr, 2600, 0.6));
  return normPeak([soften(d, sr)], 0.8);
}

/** Blades brushing past and a muffled tread. */
function grass(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.3));
  const bp = new Biq("bp", sr, rr(r, 1800, 2400), 0.7);
  const f0 = rr(r, 60, 80);
  const len = rr(r, 0.08, 0.12);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] = bp.run(r() * 2 - 1) * env(t, 0.02, len) * 0.8 + Math.sin(2 * Math.PI * f0 * t) * env(t, 0.006, 0.03) * 0.35;
  }
  filt(d, new Biq("lp", sr, 3200, 0.6));
  return normPeak([soften(d, sr)], 0.7);
}

/** Packed earth: a soft gritty crunch. */
function dirt(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.22));
  const bp = new Biq("bp", sr, rr(r, 900, 1300), 0.8);
  const f0 = rr(r, 70, 90);
  let grain = 0;
  let g = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    if (grain-- <= 0) {
      grain = Math.floor(sr * rr(r, 0.001, 0.004));
      g = r() < 0.6 ? rr(r, 0.4, 1) : 0.15;
    }
    d[i] = bp.run((r() * 2 - 1) * g) * env(t, 0.01, 0.05) + Math.sin(2 * Math.PI * f0 * t) * env(t, 0.008, 0.028) * 0.45;
  }
  filt(d, new Biq("lp", sr, 2600, 0.6));
  return normPeak([soften(d, sr)], 0.8);
}

/** Dry sand: the foot sinks in with a slow, hushed granular "shff" — no thump, no edge. */
function sand(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.32));
  const bp = new Biq("bp", sr, rr(r, 700, 1000), 0.6);
  const lp = new Biq("lp", sr, 1800, 0.6);
  const len = rr(r, 0.06, 0.09);
  let grain = 0;
  let g = 0;
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    if (grain-- <= 0) {
      grain = Math.floor(sr * rr(r, 0.0006, 0.002));
      g = rr(r, 0.3, 1);
    }
    d[i] = lp.run(bp.run((r() * 2 - 1) * g)) * env(t, 0.022, len) + Math.sin(2 * Math.PI * 55 * t) * env(t, 0.015, 0.03) * 0.15;
  }
  return normPeak([soften(d, sr)], 0.75);
}

/** Wet, packed sand at the water's edge: a dark, damp press with a little suck as the heel lifts. */
function wetsand(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.34));
  const lp = new Biq("lp", sr, rr(r, 550, 750), 0.7);
  const suck = new Biq("bp", sr, rr(r, 300, 420), 2.2);
  const f0 = rr(r, 55, 70);
  const ts = rr(r, 0.09, 0.13);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const w = r() * 2 - 1;
    const s = t > ts ? env(t - ts, 0.02, 0.05) * 0.5 : 0;
    d[i] = lp.run(w) * env(t, 0.012, 0.06) + suck.run(w) * s + Math.sin(2 * Math.PI * f0 * t) * env(t, 0.01, 0.04) * 0.4;
  }
  filt(d, new Biq("lp", sr, 1400, 0.6));
  return normPeak([soften(d, sr)], 0.75);
}

/** Pier planks: a warm, hollow knock with the boards ringing briefly underneath. */
function wood(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.35));
  const f = rr(r, 150, 185);
  mode(d, sr, 0, f, 0.7, rr(r, 0.05, 0.07), 0, 0.004);
  mode(d, sr, 0, f * rr(r, 1.9, 2.1), 0.45, rr(r, 0.035, 0.05), r(), 0.004);
  mode(d, sr, 0, f * rr(r, 3.2, 3.6), 0.25, rr(r, 0.02, 0.03), r(), 0.003);
  mode(d, sr, 0, f * rr(r, 6, 7), 0.08, 0.012, r(), 0.003);
  mode(d, sr, 0, rr(r, 85, 100), 0.35, 0.09, 0, 0.006);
  const lp = new Biq("lp", sr, 1500, 0.7);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] += lp.run(r() * 2 - 1) * env(t, 0.003, 0.015) * 0.3;
  }
  filt(d, new Biq("lp", sr, 2400, 0.6));
  return normPeak([soften(d, sr)], 0.8);
}

/** A sandal on a stone tread in the lanes: a soft, slightly brighter tap and the sole's little slap after it. */
function stone(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.2));
  const bp = new Biq("bp", sr, rr(r, 1300, 1700), 1.1);
  const lp = new Biq("lp", sr, 2000, 0.7);
  const f0 = rr(r, 95, 120);
  const slap = rr(r, 0.035, 0.05);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const w = r() * 2 - 1;
    const flap = t > slap ? env(t - slap, 0.004, 0.018) * 0.3 : 0;
    d[i] = bp.run(w) * env(t, 0.005, 0.011) * 0.75 + lp.run(w) * flap + Math.sin(2 * Math.PI * f0 * t) * env(t, 0.006, 0.02) * 0.45;
  }
  filt(d, new Biq("lp", sr, 2900, 0.6));
  return normPeak([soften(d, sr)], 0.8);
}

/** A few drops falling back off the foot: tiny rising pings, rounded. */
function drip(d: Float32Array, sr: number, r: Rng, count: number, t0: number, t1: number, f0: number, f1: number, amp: number): void {
  const at = Math.max(1, Math.floor(0.0025 * sr));
  for (let k = 0; k < count; k++) {
    const i0 = Math.floor(rr(r, t0, t1) * sr);
    const f = rr(r, f0, f1), tau = rr(r, 0.008, 0.018), a = amp * rr(r, 0.4, 1);
    const n = Math.min(d.length - i0, Math.floor(tau * 6 * sr));
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      ph += (f * (1 + 0.5 * Math.min(1, t / (tau * 3)))) / sr;
      d[i0 + i] += a * (i < at ? i / at : 1) * Math.exp(-t / tau) * sn(ph);
    }
  }
}

/** A foot into ankle-deep water (or a wash running over the sand): a soft splish, a little slap, a few drops. */
function water(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.45));
  const bp = new Biq("bp", sr, rr(r, 700, 1000), 0.8);
  const bp2 = new Biq("bp", sr, rr(r, 1400, 1900), 1.2);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const w = r() * 2 - 1;
    d[i] = bp.run(w) * env(t, 0.025, 0.07) * 0.8 + bp2.run(w) * env(t, 0.008, 0.025) * 0.35;
  }
  drip(d, sr, r, 3 + Math.floor(r() * 4), 0.08, 0.32, 900, 1700, 0.15);
  filt(d, new Biq("lp", sr, 2600, 0.6));
  return normPeak([soften(d, sr)], 0.75);
}

/** Wading deeper: a slower, heavier slosh round the shins, a low glug, a few lower drops. */
function wade(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.7));
  const bp = new Biq("bp", sr, rr(r, 450, 650), 0.7);
  const lp = new Biq("lp", sr, 1600, 0.6);
  const f0 = rr(r, 60, 80);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const w = r() * 2 - 1;
    d[i] = bp.run(w) * env(t, 0.06, 0.16) * 0.9 + lp.run(w) * env(t, 0.02, 0.05) * 0.3 + Math.sin(2 * Math.PI * f0 * t) * env(t, 0.02, 0.06) * 0.25;
  }
  drip(d, sr, r, 2 + Math.floor(r() * 3), 0.18, 0.5, 600, 1100, 0.12);
  filt(d, new Biq("lp", sr, 2200, 0.6));
  return normPeak([soften(d, sr)], 0.75);
}

/** Her weight coming down after a jump: a low, padded thump with a muffled puff (no click, nothing bright). */
function land(r: Rng, sr: number): Float32Array[] {
  const d = new Float32Array(Math.floor(sr * 0.32));
  const f0 = rr(r, 80, 95);
  note(d, sr, 0, 0.22, (u) => lerp(f0, 52, Math.sqrt(u)), (u) => (u < 0.05 ? smooth(u / 0.05) : Math.exp(-(u - 0.05) * 7)), [1, 0.3, 0.1]);
  const lp = new Biq("lp", sr, 420, 0.7);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    d[i] += lp.run(r() * 2 - 1) * smooth(t / 0.008) * Math.exp(-t / 0.05) * 0.6;
  }
  filt(d, new Biq("lp", sr, 900, 0.6));
  return normPeak([d], 0.8);
}

const GENS: Record<StepSurface, (r: Rng, sr: number) => Float32Array[]> = { asphalt, grass, dirt, sand, wetsand, wood, stone, water };

/** Footstep one-shots, generated lazily into the kit (a handful of variations per surface). */
export class Steps {
  private lastPan = 0.06;
  constructor(
    private readonly kit: Kit,
    private readonly dest: AudioNode,
    private readonly wet: AudioNode,
  ) {
    for (const s of STEP_SURFACES) kit.bank(`step-${s}`, 5, GEN_SR, GENS[s]);
    kit.bank("step-wade", 4, GEN_SR, wade);
    kit.bank("land", 4, GEN_SR, land);
  }

  /** One footstep; `depth` = water over the ground (m) for "water", `rate` lowers or raises the whole step. */
  play(when: number, surface: StepSurface, strength: number, depth = 0, rate = 1): void {
    const deep = surface === "water" && depth >= WADE_DEPTH;
    const b = (deep ? this.kit.pick("step-wade") : null) ?? this.kit.pick(`step-${surface}`) ?? this.kit.pick("step-dirt");
    if (!b) return;
    // Alternate feet a touch left / right of centre.
    this.lastPan = -this.lastPan;
    const k = clamp(strength, 0, 1.6);
    const wading = surface === "water" ? 0.8 + 0.5 * smoothstep(0.02, 0.4, depth) : 1;
    this.kit.play(b, when, {
      gain: L_STEP * (TRIM[surface] ?? 0.8) * k * wading,
      pan: this.lastPan,
      rate: rr(this.kit.rng, 0.94, 1.06) * rate,
      dest: this.dest,
      // wood rings under the deck; the stone lanes give a short slap back off the walls
      wet: surface === "wood" ? 0.3 : surface === "stone" ? 0.26 : 0.15,
      wetDest: this.wet,
    });
  }

  /** Both feet come down after a jump or a drop (`k` 0.3…1 how hard): the surface, heavier, over a padded thud. */
  land(when: number, surface: StepSurface, k: number, depth = 0): void {
    const kk = clamp(k, 0.3, 1);
    this.play(when, surface, 0.75 + 0.45 * kk, surface === "water" ? Math.max(depth, WADE_DEPTH) : depth, 0.9);
    this.thud(when + 0.004, surface, kk);
  }

  /** The push-off of a jump: a lighter press on the surface and a little of the thud. */
  takeoff(when: number, surface: StepSurface, k: number, depth = 0): void {
    const kk = clamp(k, 0.3, 1);
    this.play(when, surface, 0.5 + 0.3 * kk, depth, 0.97);
    this.thud(when + 0.003, surface, kk * 0.35);
  }

  private thud(when: number, surface: StepSurface, k: number): void {
    const [level, rate] = THUD[surface] ?? THUD.dirt;
    const b = level > 0 ? this.kit.pick("land") : null;
    if (b) this.kit.play(b, when, { gain: L_LAND * level * k, pan: 0, rate: rate * rr(this.kit.rng, 0.95, 1.05), dest: this.dest, wet: 0.12, wetDest: this.wet });
  }
}
