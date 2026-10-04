import { Biq, filt, mode, normPeak, rr, smooth, type Rng } from "./dsp";
import { GEN_SR, type Kit } from "./kit";

export type StepSurface = "asphalt" | "grass" | "dirt" | "sand" | "wetsand" | "wood";
export const STEP_SURFACES: StepSurface[] = ["asphalt", "grass", "dirt", "sand", "wetsand", "wood"];

const L_STEP = 0.2;
/** Per-surface trim so they sit at a similar, quiet loudness. */
const TRIM: Record<StepSurface, number> = { asphalt: 0.8, grass: 0.8, dirt: 0.85, sand: 1, wetsand: 1, wood: 0.9 };

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

const GENS: Record<StepSurface, (r: Rng, sr: number) => Float32Array[]> = { asphalt, grass, dirt, sand, wetsand, wood };

/** Footstep one-shots, generated lazily into the kit (a handful of variations per surface). */
export class Steps {
  private lastPan = 0.06;
  constructor(
    private readonly kit: Kit,
    private readonly dest: AudioNode,
    private readonly wet: AudioNode,
  ) {
    for (const s of STEP_SURFACES) kit.bank(`step-${s}`, 5, GEN_SR, GENS[s]);
  }

  play(when: number, surface: StepSurface, strength: number): void {
    const b = this.kit.pick(`step-${surface}`) ?? this.kit.pick("step-dirt");
    if (!b) return;
    // Alternate feet a touch left / right of centre.
    this.lastPan = -this.lastPan;
    const k = Math.max(0, Math.min(1.5, strength));
    this.kit.play(b, when, {
      gain: L_STEP * TRIM[surface] * k,
      pan: this.lastPan,
      rate: rr(this.kit.rng, 0.94, 1.06),
      dest: this.dest,
      wet: surface === "wood" ? 0.3 : 0.15,
      wetDest: this.wet,
    });
  }
}
