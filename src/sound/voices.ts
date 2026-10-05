/**
 * Procedural "recordings": each generator renders one variation of a sound into Float32Array channels.
 * They run once (lazily, a few per frame) and the results are played back as AudioBuffers.
 * Everything here is deliberately soft: rounded attacks, low-passed tops, nothing much above ~5 kHz.
 */
import { Biq, filt, lerp, makeLoop, normPeak, normRms, note, rr, smooth, sn, TAU, trim, type Rng } from "./dsp";

type Gen = (r: Rng, sr: number) => Float32Array[];
const mono = (d: Float32Array, sr: number, peak = 0.9): Float32Array[] => normPeak([trim(d, sr)], peak);

/** Raised-cosine fade-in over the first `sec` seconds (no hard onsets anywhere). */
function fadeIn(d: Float32Array, sr: number, sec: number): Float32Array {
  const n = Math.min(d.length, Math.max(1, Math.floor(sec * sr)));
  for (let i = 0; i < n; i++) d[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / n);
  return d;
}

// ───────────────────────────── sea ─────────────────────────────

/**
 * Backwash fizz: a dense bed of tiny bursting bubbles (rising chirps) and a breath of noise, all kept
 * under ~4.5 kHz. Seamless loop; channels are independent so it spreads in stereo.
 */
export const fizz =
  (secs: number): Gen =>
  (r, sr) => {
    const fade = Math.floor(sr * 0.2);
    const n = Math.floor(sr * secs) + fade;
    const d = new Float32Array(n);
    const count = Math.floor(secs * 260);
    for (let k = 0; k < count; k++) {
      const t0 = r() * (n / sr - 0.02);
      const f0 = rr(r, 900, 3200);
      const tau = rr(r, 0.002, 0.006);
      const a = Math.pow(r(), 2) * 0.5;
      const i0 = Math.floor(t0 * sr);
      const len = Math.min(n - i0, Math.floor(tau * 6 * sr));
      const at = Math.floor(0.0012 * sr);
      let ph = r();
      let e = a;
      const k = Math.exp(-1 / (tau * sr));
      const chirp = 0.8 / (tau * 6 * sr);
      for (let i = 0; i < len; i++) {
        ph += (f0 * (1 + chirp * i)) / sr;
        d[i0 + i] += e * (i < at ? i / at : 1) * sn(ph);
        e *= k;
      }
    }
    const bp = new Biq("bp", sr, 1800, 0.5);
    for (let i = 0; i < n; i++) d[i] += bp.run(r() * 2 - 1) * 0.12;
    filt(d, new Biq("lp", sr, 4200, 0.6));
    filt(d, new Biq("hp", sr, 400, 0.6));
    return [normRms(makeLoop(d, fade), 0.2)];
  };

/** Water lapping a post or a hull: a soft slosh with a small rounded "glop". */
export const plop: Gen = (r, sr) => {
  const d = new Float32Array(Math.floor(sr * 0.5));
  const bp = new Biq("bp", sr, rr(r, 380, 620), 0.8);
  const len = rr(r, 0.08, 0.16);
  const att = rr(r, 0.025, 0.045);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const env = t < att ? smooth(t / att) : Math.exp(-(t - att) / len);
    d[i] = bp.run(r() * 2 - 1) * env;
  }
  if (r() < 0.75) {
    const f0 = rr(r, 260, 480);
    const t0 = rr(r, 0.01, 0.04);
    const i0 = Math.floor(t0 * sr);
    const tau = rr(r, 0.025, 0.045);
    let ph = 0;
    for (let i = 0; i + i0 < d.length; i++) {
      const t = i / sr;
      ph += (f0 * (1 + 0.5 * Math.min(1, t / 0.05))) / sr;
      d[i0 + i] += 0.5 * Math.min(1, t / 0.006) * Math.exp(-t / tau) * Math.sin(TAU * ph);
    }
  }
  filt(d, new Biq("lp", sr, 1600, 0.6));
  return mono(d, sr);
};

/** The hull meeting a swell: a low, padded thud and a breath of spray. */
export const hullThud: Gen = (r, sr) => {
  const d = new Float32Array(Math.floor(sr * 0.8));
  note(d, sr, 0, 0.35, (u) => lerp(rr(r, 85, 100), 50, Math.sqrt(u)), (u) => (u < 0.04 ? smooth(u / 0.04) : Math.exp(-(u - 0.04) * 9)), [1, 0.25]);
  const lp = new Biq("lp", sr, 380, 0.7);
  const bp = new Biq("bp", sr, rr(r, 1100, 1600), 0.6);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    const thud = smooth(Math.min(1, t / 0.014)) * Math.exp(-t / 0.09);
    const spray = smooth(Math.min(1, t / 0.06)) * Math.exp(-t / 0.22);
    const w = r() * 2 - 1;
    d[i] += lp.run(w) * thud * 0.9 + bp.run(w) * spray * 0.22;
  }
  filt(d, new Biq("lp", sr, 2800, 0.6));
  return mono(d, sr);
};

// ───────────────────────────── birds ─────────────────────────────

/**
 * A gull far over the water: a short series of falling "kyow" calls. Rendered already distant: rounded
 * onsets, a muted top (the far bus low-passes it further) and no raw buzz.
 */
export const gull: Gen = (r, sr) => {
  const calls = 2 + Math.floor(r() * 4);
  const laugh = r() < 0.35;
  const base = rr(r, 780, 980);
  let t = 0.02;
  const starts: [number, number, number][] = [];
  for (let k = 0; k < calls; k++) {
    const dur = laugh ? rr(r, 0.16, 0.24) : rr(r, 0.32, 0.5);
    starts.push([t, dur, 1 - 0.1 * k]);
    t += dur + (laugh ? rr(r, 0.06, 0.12) : rr(r, 0.18, 0.4));
  }
  const d = new Float32Array(Math.floor(sr * (t + 0.4)));
  for (const [t0, dur, a] of starts) {
    const peak = base * rr(r, 1.25, 1.45);
    const end = base * rr(r, 0.72, 0.85);
    const vib = rr(r, 5, 8);
    note(
      d,
      sr,
      t0,
      dur,
      (u) => (u < 0.18 ? lerp(base, peak, smooth(u / 0.18)) : lerp(peak, end, smooth((u - 0.18) / 0.82))) * (1 + 0.006 * Math.sin(TAU * vib * u * dur)),
      (u) => a * (u < 0.12 ? smooth(u / 0.12) : Math.pow(1 - (u - 0.12) / 0.88, 1.4)),
      [1, 0.5, 0.28, 0.12, 0.05],
    );
  }
  filt(d, new Biq("bp", sr, 1300, 0.55));
  filt(d, new Biq("lp", sr, 2600, 0.6));
  return mono(fadeIn(d, sr, 0.01), sr);
};
