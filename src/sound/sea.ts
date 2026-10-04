import { clamp, expRand, lerp, rr, vnoise } from "./dsp";
import { Gate, GEN_SR, glide, glideStep, Kit, Layer, type Env, type RideState } from "./kit";
import { fizz, plop } from "./voices";

const L_BED = 0.05;
const L_WAVE = 0.3;
const L_FIZZ = 0.05;
const L_OPEN = 0.045;
const L_SLOSH = 0.035;
const L_PLOP = 0.13;
const LOOKAHEAD = 0.15;

interface WaveVoice {
  g: GainNode;
  lp: BiquadFilterNode;
  p: StereoPannerNode;
}

interface FizzVoice {
  g: GainNode;
  p: StereoPannerNode;
}

/** 0 at the waterline … 1 out of earshot, with a soft knee (for level and darkness). */
const nearness = (d: number) => 1 / (1 + Math.pow(Math.max(0, d) / 14, 1.3));

/**
 * Waves on the sand. A low rolling bed never quite stops; on top, each wave is one long envelope on a
 * persistent noise voice: the swell gathers (dark and quiet), the crest spills over (the low-pass opens
 * to a warm ~2 kHz, never a hiss), the wash runs up the beach and the backwash slides away with a soft
 * fizz of bubbles. Waves come in sets with irregular spacing. Everything is placed by the distance and
 * direction of the shoreline: far away it is a low murmur, at the water's edge it surrounds you.
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
  private vi = 0;
  private fi = 0;
  private setLeft = 0;

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
      this.voices.push({ g, lp, p });
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

  /** One wave: swell, spill, wash up, backwash fizz. */
  private wave(t: number, size: number, s: RideState): void {
    const r = this.kit.rng;
    const v = this.voices[this.vi++ % this.voices.length];
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
