import { clamp, expRand, lerp, rr, smoothstep, vnoise } from "./dsp";
import { Gate, GEN_SR, glide, glideStep, Kit, Layer, type Env, type RideState } from "./kit";
import { fizz, plop } from "./voices";

const L_BED = 0.05;
const L_WAVE = 0.3;
const L_FIZZ = 0.05;
const L_OPEN = 0.045;
const L_SLOSH = 0.035;
const L_PLOP = 0.13;
const LOOKAHEAD = 0.15;
/** With no shore event for this long (s; the main swell's period is ~7.4 s), the layer times its own waves again. */
const EVENT_HOLD = 16;

interface WaveVoice {
  g: GainNode;
  lp: BiquadFilterNode;
  p: StereoPannerNode;
  /** When it last started a wave, and which shoreline wave it carries (NaN: one of its own). */
  used: number;
  wave: number;
}

interface FizzVoice {
  g: GainNode;
  p: StereoPannerNode;
}

/** 0 at the waterline … 1 out of earshot, with a soft knee (for level and darkness). */
const nearness = (d: number) => 1 / (1 + Math.pow(Math.max(0, d) / 14, 1.3));

/**
 * Waves on the sand. A low rolling bed never quite stops; on top, each wave is one long envelope on a
 * persistent noise voice. The shoreline model reports its own waves near the listener (`shoreEvent`):
 * a soft spill when a crest breaks offshore, the broken bore rolling in, then the wash running up the
 * sand with a fizz of foam for as long as the drawn swash takes, and a gentle backwash sliding away
 * while the bubbles burst. Without those events the layer times its own waves in sets (swell, spill,
 * wash, backwash fizz), as before. Everything is placed by the distance and direction of the
 * shoreline: far away it is a low murmur, at the water's edge it surrounds you.
 */
export class ShoreLayer extends Layer {
  private voices: WaveVoice[] = [];
  private fizzes: FizzVoice[] = [];
  private fizzSrc: AudioBufferSourceNode | null = null;
  private fizzIn: GainNode;
  private bed: GainNode;
  private bedLP: BiquadFilterNode;
  private busLP: BiquadFilterNode;
  private busG: GainNode;
  private busPan: StereoPannerNode;
  private next = 0;
  private fi = 0;
  private setLeft = 0;
  private evAt = -1e9;

  constructor(kit: Kit) {
    super(kit);
    kit.loopBank("fizz", 2, GEN_SR, fizz(4));
    const bus = this.gain(1);
    this.busLP = this.filter("lowpass", 2400, 0.5);
    this.busG = this.gain();
    this.busPan = this.ctx.createStereoPanner();
    bus.connect(this.busLP).connect(this.busG).connect(this.busPan).connect(this.out);
    this.busPan.connect(this.gain(0.35)).connect(this.wet);

    this.bed = this.gain();
    this.bedLP = this.filter("lowpass", 260, 0.6);
    kit.loop(kit.brown).connect(this.filter("highpass", 40, 0.6)).connect(this.bedLP).connect(this.bed).connect(bus);

    for (let i = 0; i < 3; i++) {
      const lp = this.filter("lowpass", 400, 0.5);
      const g = this.gain();
      const p = this.ctx.createStereoPanner();
      kit.loop(kit.pinkSt, rr(kit.rng, 0.92, 1.05)).connect(this.filter("highpass", 60, 0.6)).connect(lp).connect(g).connect(p).connect(bus);
      this.voices.push({ g, lp, p, used: -1e9, wave: NaN });
    }
    this.fizzIn = this.gain(1);
    for (let i = 0; i < 2; i++) {
      const g = this.gain();
      const p = this.ctx.createStereoPanner();
      this.fizzIn.connect(g).connect(p).connect(bus);
      this.fizzes.push({ g, p });
    }
  }

  events(now: number, _dt: number, s: RideState): void {
    const k = this.kit;
    if (!this.fizzSrc && k.has("fizz")) {
      this.fizzSrc = k.loop(k.get("fizz")[0]);
      this.fizzSrc.connect(this.fizzIn);
    }
    // While the shoreline reports its waves, those are the waves; the layer's own timing waits.
    if (now - this.evAt < EVENT_HOLD) {
      this.next = 0;
      return;
    }
    if (!this.next) this.next = now + rr(k.rng, 0.5, 2);
    if (now + LOOKAHEAD < this.next) return;
    const r = k.rng;
    const t = Math.max(now + 0.02, this.next);
    // sets: a few bigger waves, then a lull of smaller ones
    if (this.setLeft <= 0) this.setLeft = 2 + Math.floor(r() * 4);
    this.setLeft--;
    const set = vnoise(now / 60, 71);
    const size = clamp(rr(r, 0.45, 1) * (0.7 + 0.5 * set) * (this.setLeft === 0 ? 0.75 : 1), 0.3, 1);
    this.wave(t, size, s);
    this.next = t + rr(r, 6.5, 10.5) * (0.85 + 0.3 * (1 - size)) + (r() < 0.12 ? rr(r, 3, 6) : 0);
  }

  /**
   * A wave of the shoreline model near the listener: "break" when its crest starts spilling offshore,
   * "runup" when its swash starts up the sand. `size` = its height there (m, ~0.05…1.6), `wave` its number.
   */
  shoreEvent(when: number, kind: "break" | "runup", size: number, wave: number, s: RideState): void {
    if (!Number.isFinite(when) || !Number.isFinite(size)) return;
    this.evAt = when;
    const k = 0.25 + 0.75 * smoothstep(0.05, 1, size);
    if (kind === "break") this.spill(when, k, wave);
    else this.wash(when, k, clamp(size, 0, 1.6), wave, s);
  }

  /** The voice already carrying shoreline wave `n` (NaN: one of its own), else the one that started a wave longest ago. */
  private take(n: number, t: number): WaveVoice {
    let v = this.voices[0];
    for (const c of this.voices) {
      if (c.wave === n) {
        v = c;
        break;
      }
      if (c.used < v.used) v = c;
    }
    v.used = t;
    v.wave = n;
    return v;
  }

  /** The crest spills over offshore: a soft rise to a warm top (never a hiss), then the broken bore rolling in. */
  private spill(t: number, k: number, n: number): void {
    const v = this.take(n, t);
    const g = v.g.gain, f = v.lp.frequency;
    g.cancelScheduledValues(t);
    f.cancelScheduledValues(t);
    g.setTargetAtTime(0.8 * k, t, 0.18);
    f.setTargetAtTime(900 + 1000 * k, t, 0.22);
    g.setTargetAtTime(0.4 * k, t + 0.8, 0.9);
    f.setTargetAtTime(800 + 200 * k, t + 0.8, 1);
    // If no run-up follows (she moved along the beach), the bore fades by itself.
    g.setTargetAtTime(0, t + 5, 1.2);
    f.setTargetAtTime(380, t + 5, 1.2);
    v.p.pan.cancelScheduledValues(t);
    v.p.pan.setTargetAtTime(rr(this.kit.rng, -0.35, 0.35), t, 0.3);
  }

  /**
   * The swash runs up the sand for Tu s and slides back for 1.7 Tu, timed as the shoreline model draws
   * it: a broad wash brightest as it surges, softening as the sheet thins near the top, then a gentle,
   * darker backwash. The foam fizzes on the way up; the bubbles burst as the backwash drains.
   */
  private wash(t: number, k: number, size: number, n: number, s: RideState): void {
    const v = this.take(n, t);
    const r = this.kit.rng;
    const R = 0.012 + 0.12 * size, Tu = 1.3 + 4.5 * R, Td = 1.7 * Tu;
    const g = v.g.gain, f = v.lp.frequency;
    g.cancelScheduledValues(t);
    f.cancelScheduledValues(t);
    g.setTargetAtTime(0.75 * k, t, 0.2);
    f.setTargetAtTime(1000 + 700 * k, t, 0.25);
    g.setTargetAtTime(0.38 * k, t + 0.6 * Tu, 0.3 * Tu);
    f.setTargetAtTime(900, t + 0.6 * Tu, 0.4 * Tu);
    g.setTargetAtTime(0.14 * k, t + Tu, 0.35 * Td);
    f.setTargetAtTime(480, t + Tu, 0.4 * Td);
    g.setTargetAtTime(0, t + Tu + Td, 0.7);
    f.setTargetAtTime(340, t + Tu + Td, 0.9);
    // the wash spreads along the beach as it runs up
    v.p.pan.cancelScheduledValues(t);
    v.p.pan.setTargetAtTime(rr(r, -0.2, 0.2), t, 1.2);

    const fz = this.fizzes[this.fi++ % this.fizzes.length];
    const near = 0.6 + 0.4 * nearness(s.shore);
    const fg = fz.g.gain;
    fg.cancelScheduledValues(t);
    fg.setTargetAtTime(0.35 * k * near, t + 0.2, 0.3);
    fg.setTargetAtTime(0.75 * k * near, t + 0.8 * Tu, 0.35);
    fg.setTargetAtTime(0, t + Tu + 0.55 * Td, 0.3 * Td);
    fz.p.pan.cancelScheduledValues(t);
    fz.p.pan.setTargetAtTime(rr(r, -0.5, 0.5), t, 0.5);
  }

  /** One wave of its own: swell, spill, wash up, backwash fizz. */
  private wave(t: number, size: number, s: RideState): void {
    const r = this.kit.rng;
    const v = this.take(NaN, t);
    const swell = rr(r, 1.4, 2.4);
    const tb = t + swell;
    const tw = tb + rr(r, 0.6, 0.9);
    const te = tw + rr(r, 2.2, 3.2);
    const g = v.g.gain;
    const f = v.lp.frequency;
    g.cancelScheduledValues(t);
    f.cancelScheduledValues(t);
    g.setTargetAtTime(0.14 * size, t, swell / 3);
    f.setTargetAtTime(380, t, swell / 3);
    g.setTargetAtTime(size, tb, 0.22);
    f.setTargetAtTime(1300 + 900 * size, tb, 0.25);
    g.setTargetAtTime(0.32 * size, tw, 0.8);
    f.setTargetAtTime(650, tw, 1.1);
    g.setTargetAtTime(0, te, 0.9);
    f.setTargetAtTime(350, te, 1);
    const pan = clamp(rr(r, -0.6, 0.6), -1, 1);
    v.p.pan.cancelScheduledValues(t);
    v.p.pan.setTargetAtTime(pan, t, 0.3);
    // the wash spreads along the beach as it runs up
    v.p.pan.setTargetAtTime(pan * 0.6, tw, 1.5);

    const fz = this.fizzes[this.fi++ % this.fizzes.length];
    const tf = tw + rr(r, 0.4, 0.8);
    fz.g.gain.cancelScheduledValues(t);
    fz.g.gain.setTargetAtTime(size * (0.6 + 0.4 * nearness(s.shore)), tf, 0.45);
    fz.g.gain.setTargetAtTime(0, tf + rr(r, 1.4, 2.2), 1);
    fz.p.pan.setTargetAtTime(clamp(pan + rr(r, -0.3, 0.3), -0.8, 0.8), tf, 0.5);
  }

  params(now: number, s: RideState): void {
    const n = nearness(s.shore);
    glide(this.busG.gain, L_WAVE * (0.04 + 0.96 * n), now, 0.4);
    glideStep(this.busLP.frequency, 500 + 3000 * n * n, now, 0.4);
    glide(this.busPan.pan, clamp(s.shorePan, -1, 1) * (0.25 + 0.4 * n), now, 0.3);
    glide(this.bed.gain, (L_BED / L_WAVE) * (0.7 + 0.3 * vnoise(now / 17, 31)), now, 0.6);
    glideStep(this.bedLP.frequency, 220 + 80 * n, now, 0.6);
    glide(this.fizzIn.gain, (L_FIZZ / L_WAVE) * Math.pow(n, 1.5), now, 0.4);
  }
}

/**
 * Water against things: lapping and soft "glops" around pier posts and moored hulls (or our own hull
 * when the boat sits still), a gentle slosh underneath, and the wide low hush of open water when out
 * on the bay.
 */
export class LapLayer extends Layer {
  private slosh: Gate;
  private sloshBP: BiquadFilterNode;
  private sloshPan: StereoPannerNode;
  private open: Gate;
  private nextPlop = 0;

  constructor(kit: Kit) {
    super(kit);
    kit.bank("plop", 8, GEN_SR, plop);
    this.sloshBP = this.filter("bandpass", 420, 0.7);
    this.sloshPan = this.ctx.createStereoPanner();
    this.slosh = new Gate(this.gain(), this.sloshPan);
    kit.loop(kit.pinkSt, 0.9).connect(this.sloshBP).connect(this.filter("lowpass", 1000, 0.6)).connect(this.slosh.g);
    this.sloshPan.connect(this.out);

    this.open = new Gate(this.gain(), this.out);
    kit.loop(kit.pinkSt, 0.8).connect(this.filter("lowpass", 520, 0.5)).connect(this.filter("highpass", 70, 0.6)).connect(this.open.g);
    this.wet.gain.value = 1;
  }

  /** How much there is to lap against right now (pier posts, or our hull when slow). */
  private amount(s: RideState): number {
    const hull = s.boat * clamp(1 - s.boatSpeed / 5, 0, 1);
    return clamp(Math.max(s.pier, hull), 0, 1);
  }

  events(now: number, _dt: number, s: RideState): void {
    const k = this.kit;
    const a = this.amount(s);
    if (a < 0.02) {
      this.nextPlop = 0;
      return;
    }
    if (!this.nextPlop) this.nextPlop = now + rr(k.rng, 0.2, 1);
    if (now < this.nextPlop) return;
    const b = k.pick("plop");
    if (b) {
      const centre = s.boat > 0.5 ? 0 : s.pierPan * 0.6;
      const pan = clamp(centre + rr(k.rng, -0.6, 0.6), -0.9, 0.9);
      k.play(b, now + 0.02, {
        gain: L_PLOP * a * rr(k.rng, 0.4, 1),
        pan,
        rate: rr(k.rng, 0.85, 1.12),
        dest: this.out,
        wet: 0.18,
        wetDest: this.wet,
      });
      // lapping comes in little clusters with the passing ripples
      this.nextPlop = now + (k.rng() < 0.45 ? rr(k.rng, 0.15, 0.4) : expRand(k.rng, 1.3 / (0.4 + a)));
    } else this.nextPlop = now + 0.5;
  }

  params(now: number, s: RideState, e: Env): void {
    const a = this.amount(s);
    const breathe = 0.55 + 0.45 * vnoise(now / 2.3, 81);
    this.slosh.set(L_SLOSH * a * breathe, now, 0.35);
    glideStep(this.sloshBP.frequency, lerp(320, 520, vnoise(now / 3.7, 82)), now, 0.4);
    glide(this.sloshPan.pan, s.boat > 0.5 ? 0 : clamp(s.pierPan, -1, 1) * 0.5, now, 0.5);
    this.open.set(L_OPEN * s.sea * (0.7 + 0.3 * e.gust), now, 0.8);
  }
}
