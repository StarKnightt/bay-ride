import { clamp, expRand, rr, smoothstep, vnoise } from "./dsp";
import { Gate, GEN_SR, glide, glideStep, Kit, Layer, type RideState } from "./kit";
import { bikeBell, chainTick, freewheelClick, rattle } from "./voices";

const L_TYRE = 0.05;
const L_PURR = 0.008;
const L_CHAIN = 0.035;
const L_FREE = 0.03;
const L_RUB = 0.025;
const L_RATTLE = 0.06;
const L_BELL = 0.16;

const TEETH = 33; // chainring teeth → chain mesh rate
const PAWL_CLICKS = 16; // freewheel ticks per wheel revolution
const CHAIN_TICKS = 6; // soft ticks per crank revolution (every 3rd accented = each pedal stroke)
const LOOKAHEAD = 0.1;

interface Clicker {
  phase: number;
  t: number;
}

/**
 * The bicycle, kept quiet and round: a low tyre roll, a soft chain purr and ticks locked to cadence,
 * the freewheel's muted tick when coasting, a gentle rim-brake brush, a padded thump on seams, and a
 * soft thumb bell.
 */
export class BikeLayer extends Layer {
  private tyre: Gate;
  private tyreLP: BiquadFilterNode;
  private tread: OscillatorNode;
  private purr: Gate;
  private mesh: OscillatorNode;
  private rub: Gate;
  private freeBus: GainNode;
  private chainBus: GainNode;
  private fw: Clicker = { phase: 0, t: 0 };
  private ch: Clicker = { phase: 0.5, t: 0 };
  private chainN = 0;
  private nextBump = -1;
  private lastBump = -1;
  private lastBell = -1;
  private dist = 0;

  constructor(kit: Kit) {
    super(kit);
    const sr = kit.ctx.sampleRate;
    kit.bank("fw", 8, sr, freewheelClick, true);
    kit.bank("chain", 6, sr, chainTick(false), true);
    kit.bank("chainAcc", 3, sr, chainTick(true), true);
    kit.bank("rattle", 4, GEN_SR, rattle);
    kit.bank("bell", 2, GEN_SR, bikeBell(false));

    // Tyre: brown/pink noise, swelling once per wheel revolution, low-passed with speed.
    this.tread = this.osc(1);
    const treadDepth = this.gain(0.12);
    this.tread.connect(treadDepth);
    const treadAM = this.gain(1);
    treadDepth.connect(treadAM.gain);
    this.tyreLP = this.filter("lowpass", 300, 0.6);
    const pinkSrc = kit.loop(kit.pink);
    this.tyre = new Gate(this.gain(), this.out);
    pinkSrc.connect(treadAM).connect(this.filter("highpass", 70, 0.7)).connect(this.tyreLP).connect(this.tyre.g);

    // Chain purr: low band of noise gently pulsing at the tooth-mesh rate.
    this.mesh = this.osc(30);
    const meshDepth = this.gain(0.35);
    this.mesh.connect(meshDepth);
    const meshAM = this.gain(0.65);
    meshDepth.connect(meshAM.gain);
    this.purr = new Gate(this.gain(), this.out);
    pinkSrc.connect(this.filter("bandpass", 900, 0.9)).connect(meshAM).connect(this.filter("lowpass", 1800, 0.6)).connect(this.purr.g);

    // Rim-brake brush: dark noise only (no squeal).
    this.rub = new Gate(this.gain(), this.out);
    pinkSrc.connect(this.filter("bandpass", 1100, 0.8)).connect(this.filter("lowpass", 2000, 0.6)).connect(this.rub.g);

    this.freeBus = this.gain();
    this.freeBus.connect(this.filter("lowpass", 3000, 0.6)).connect(this.out);
    this.chainBus = this.gain();
    this.chainBus.connect(this.filter("lowpass", 2400, 0.6)).connect(this.out);
    this.wet.gain.value = 0.05;
    this.out.connect(this.wet);
  }

  events(now: number, dt: number, s: RideState): void {
    this.dist += s.speed * dt;
    const h = now + LOOKAHEAD;
    const kit = this.kit;
    this.clicks(this.fw, s.wheel * PAWL_CLICKS * (s.speed > 0.25 ? 1 : 0), now, h, (t) => {
      const b = kit.pick("fw");
      if (b) kit.fire(b, t, this.freeBus, rr(kit.rng, 0.96, 1.04));
    });
    this.clicks(this.ch, s.crank * CHAIN_TICKS * (s.pedal > 0.05 ? 1 : 0), now, h, (t) => {
      const b = kit.pick(this.chainN++ % 3 === 0 ? "chainAcc" : "chain");
      if (b) kit.fire(b, t + rr(kit.rng, 0, 0.004), this.chainBus);
    });

    // bumps: explicit from the game, or an occasional road seam
    if (s.bump > 0.05) this.bump(now + 0.01, s.bump, s);
    const sp = clamp(s.speed / 10, 0, 1.2);
    if (this.nextBump < 0) this.nextBump = now + rr(kit.rng, 6, 12);
    if (now >= this.nextBump) {
      if (s.speed > 1.5) this.bump(now + 0.02, rr(kit.rng, 0.2, 0.45) * (0.6 + s.roughness), s);
      this.nextBump = now + Math.min(40, 3 + expRand(kit.rng, 1 / Math.max(0.02, (0.04 + 0.2 * s.roughness) * sp)));
    }
  }

  params(now: number, s: RideState): void {
    const sp = clamp(s.speed / 10, 0, 1.4);
    const grain = 0.85 + 0.3 * vnoise(this.dist / 7, 3);
    this.tyre.set(L_TYRE * Math.pow(sp, 1.2) * grain * (1 + 0.3 * s.roughness), now, 0.1);
    glideStep(this.tyreLP.frequency, 200 + 500 * sp, now, 0.1);
    glideStep(this.tread.frequency, Math.max(0.05, s.wheel), now, 0.05);

    const crank = clamp(s.crank / 1.2, 0, 1);
    this.purr.set(L_PURR * s.pedal * crank, now, 0.1);
    glideStep(this.mesh.frequency, Math.max(1, s.crank * TEETH), now, 0.05);
    glide(this.chainBus.gain, L_CHAIN * s.pedal * clamp(s.crank / 0.5, 0, 1), now, 0.06);
    const coast = 1 - s.pedal;
    glide(this.freeBus.gain, L_FREE * coast * coast * smoothstep(0.2, 1.5, s.speed) * (1 - 0.7 * s.brake), now, 0.06);

    const moving = smoothstep(0.2, 3, s.speed);
    this.rub.set(L_RUB * s.brake * moving * (0.6 + 0.4 * sp), now, 0.08);
  }

  bump(when: number, strength: number, s: RideState): void {
    if (when - this.lastBump < 0.2) return;
    this.lastBump = when;
    const k = this.kit;
    const b = k.pick("rattle");
    const sp = clamp(s.speed / 10, 0, 1.2);
    if (b) k.play(b, when, { gain: L_RATTLE * clamp(strength, 0, 1.2) * (0.35 + 0.65 * sp), pan: rr(k.rng, -0.1, 0.1), rate: rr(k.rng, 0.94, 1.06), dest: this.out });
  }

  ringBell(when: number): void {
    if (when - this.lastBell < 0.5) return;
    this.lastBell = when;
    const b = this.kit.pick("bell");
    if (b) this.kit.play(b, when, { gain: L_BELL, pan: 0.06, rate: rr(this.kit.rng, 0.985, 1.015), dest: this.out, wet: 1.2, wetDest: this.wet });
  }

  /** Schedule evenly spaced clicks at `rate`/s between the last scheduled time and `horizon`. */
  private clicks(c: Clicker, rate: number, now: number, horizon: number, fire: (t: number) => void): void {
    if (c.t < now) c.t = now;
    if (rate < 0.2) {
      c.t = horizon;
      return;
    }
    for (let guard = 0; guard < 64; guard++) {
      const tn = c.t + (1 - c.phase) / rate;
      if (tn > horizon) {
        c.phase = Math.min(0.999, c.phase + (horizon - c.t) * rate);
        c.t = horizon;
        return;
      }
      fire(tn);
      c.phase = 0;
      c.t = tn;
    }
  }
}
