import { clamp, expRand, rr, smoothstep, vnoise } from "./dsp";
import { Gate, GEN_SR, glide, glideStep, Kit, Layer, type RideState } from "./kit";
import { hullThud } from "./voices";

const L_MOTOR = 0.16;
const L_BURBLE = 0.05;
const L_WASH = 0.06;
const L_SLAP = 0.2;

const IDLE_HZ = 13; // firing rate at idle (~780 rpm, one cylinder)
const FULL_HZ = 38;

/** Throttle past full (Shift) tops out here (the boat's BOOST); the motor only rises a little more. */
const BOOST_MAX = 1.35;
/** In reverse the little motor turns at most this share of its forward range. */
const REVERSE_RPM = 0.62;

/**
 * The little outboard and the hull. The motor is a mellow putter: a pulse-like wave with gently falling
 * harmonics at the firing rate, warmed by a low-pass that only opens a little with throttle, plus a
 * breath of exhaust burble pulsing in step. Idle is quiet and low; opening the throttle glides pitch,
 * level and brightness up together. Past full (Shift) it rises only a touch more (+7 % pitch, +1 dB),
 * capped soft. In reverse (and braking with the prop reversed) it turns slower, with the exhaust
 * gurgling up round the stern and the prop churning against the transom. Under way the bow wash rises
 * with speed, and the hull meets the swell with padded thuds and a little spray.
 */
export class BoatLayer extends Layer {
  private motor: Gate;
  private eng: OscillatorNode;
  private engLP: BiquadFilterNode;
  private burbleBP: BiquadFilterNode;
  private burble: GainNode;
  private burbleLvl: GainNode;
  private wobble: GainNode;
  private wash: Gate;
  private washBP: BiquadFilterNode;
  private nextSlap = 0;
  private lastSlap = -1;
  private thr = 0;

  constructor(kit: Kit) {
    super(kit);
    kit.bank("hull", 5, GEN_SR, hullThud);
    const ctx = this.ctx;
    const N = 18;
    const re = new Float32Array(N + 1);
    const im = new Float32Array(N + 1);
    for (let n = 1; n <= N; n++) re[n] = Math.pow(n, -0.85) * Math.exp(-n / 14);
    this.eng = this.osc(IDLE_HZ);
    this.eng.setPeriodicWave(ctx.createPeriodicWave(re, im, { disableNormalization: false }));

    // slow unevenness in the putter (a real little two-stroke never runs perfectly smooth)
    this.wobble = this.gain(1);
    const jitter = this.gain(0.12);
    kit.loop(kit.brown, 0.5).connect(this.filter("lowpass", 6, 0.5)).connect(jitter).connect(this.wobble.gain);

    this.engLP = this.filter("lowpass", 260, 0.6);
    this.motor = new Gate(this.gain(), this.out);
    this.eng.connect(this.filter("highpass", 30, 0.6)).connect(this.engLP).connect(this.filter("lowpass", 1100, 0.5)).connect(this.wobble).connect(this.motor.g);

    // exhaust burble: low noise gated by the firing pulses
    this.burble = this.gain(0);
    this.eng.connect(this.burble.gain);
    this.burbleBP = this.filter("bandpass", 180, 0.8);
    this.burbleLvl = this.gain(L_BURBLE / L_MOTOR);
    kit.loop(kit.pink).connect(this.burbleBP).connect(this.burble).connect(this.filter("lowpass", 700, 0.6)).connect(this.burbleLvl).connect(this.wobble);

    this.washBP = this.filter("bandpass", 600, 0.6);
    this.wash = new Gate(this.gain(), this.out);
    kit.loop(kit.pinkSt, 1.07).connect(this.washBP).connect(this.filter("lowpass", 1800, 0.6)).connect(this.wash.g);
    this.wet.gain.value = 0.15;
    this.out.connect(this.wet);
  }

  events(now: number, _dt: number, s: RideState): void {
    if (s.slap > 0.05) this.slap(now + 0.01, s.slap);
    if (s.boat < 0.5 || s.boatSpeed < 1.2) {
      this.nextSlap = 0;
      return;
    }
    // When the game doesn't drive the slaps itself, the swell meets the bow at a speed-dependent rate.
    const k = this.kit;
    if (!this.nextSlap) this.nextSlap = now + rr(k.rng, 0.5, 2);
    if (now >= this.nextSlap) {
      if (now - this.lastSlap > 1) this.slap(now + 0.02, clamp(rr(k.rng, 0.3, 0.9) * smoothstep(1, 7, s.boatSpeed), 0, 1));
      this.nextSlap = now + 0.6 + expRand(k.rng, 3.5 / (0.4 + s.boatSpeed / 4));
    }
  }

  params(now: number, s: RideState): void {
    const on = s.boat;
    // the throttle itself is eased so the putter glides rather than jumps
    this.thr += (clamp(s.throttle, -1, BOOST_MAX) - this.thr) * 0.08;
    const fwd = clamp(this.thr, 0, 1);
    const boost = smoothstep(1, BOOST_MAX, this.thr);
    const rev = clamp(-this.thr, 0, 1);
    const t = Math.max(fwd, REVERSE_RPM * rev);
    const hz = (IDLE_HZ + (FULL_HZ - IDLE_HZ) * Math.pow(t, 0.9)) * (1 + 0.07 * boost) * (1 + 0.015 * (vnoise(now * 0.7, 91) - 0.5));
    glideStep(this.eng.frequency, hz, now, 0.12);
    glideStep(this.engLP.frequency, 220 + 420 * t + 90 * boost, now, 0.2);
    glideStep(this.burbleBP.frequency, 150 + 200 * t - 40 * rev, now, 0.2);
    glide(this.burbleLvl.gain, (L_BURBLE / L_MOTOR) * (1 + 0.9 * rev), now, 0.3);
    this.motor.set(L_MOTOR * on * (0.32 + 0.68 * Math.pow(t, 1.1)) * (1 + 0.12 * boost), now, 0.25);
    const sp = smoothstep(0.5, 7, s.boatSpeed);
    this.wash.set(L_WASH * on * Math.min(1, sp + 0.35 * rev) * (0.8 + 0.2 * vnoise(now / 1.7, 92)), now, 0.4);
    glideStep(this.washBP.frequency, 450 + 500 * sp - 130 * rev, now, 0.4);
  }

  slap(when: number, strength: number): void {
    if (when - this.lastSlap < 0.25) return;
    this.lastSlap = when;
    const k = this.kit;
    const b = k.pick("hull");
    if (b) k.play(b, when, { gain: L_SLAP * clamp(strength, 0, 1.2), pan: rr(k.rng, -0.25, 0.25), rate: rr(k.rng, 0.9, 1.1), dest: this.out, wet: 0.25, wetDest: this.wet });
  }
}
