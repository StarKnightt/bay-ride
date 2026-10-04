import { clamp, vnoise } from "./dsp";
import { glide, glideStep, Kit, Layer, type Env, type RideState } from "./kit";

const L_BREEZE = 0.05;
const L_FLOW = 0.11;
const L_AIRY = 0.025;

/**
 * Wind: a soft sea breeze that breathes with the gusts, and airflow past the ears that rises gently with
 * travel speed. Stereo pink noise through warm low-passes (the cutoff opens a little with speed, never
 * into hiss), plus a faint airy band that only shows on gusts.
 */
export class WindLayer extends Layer {
  private gL: GainNode;
  private gR: GainNode;
  private lpL: BiquadFilterNode;
  private lpR: BiquadFilterNode;
  private airy: GainNode;
  private airyBP: BiquadFilterNode;

  constructor(kit: Kit) {
    super(kit);
    const src = kit.loop(kit.pinkSt);
    const split = this.ctx.createChannelSplitter(2);
    const merge = this.ctx.createChannelMerger(2);
    src.connect(this.filter("highpass", 90, 0.6)).connect(split);
    this.lpL = this.filter("lowpass", 500, 0.5);
    this.lpR = this.filter("lowpass", 520, 0.5);
    this.gL = this.gain();
    this.gR = this.gain();
    split.connect(this.lpL, 0).connect(this.gL).connect(merge, 0, 0);
    split.connect(this.lpR, 1).connect(this.gR).connect(merge, 0, 1);
    merge.connect(this.out);

    this.airy = this.gain();
    this.airyBP = this.filter("bandpass", 1400, 0.6);
    kit.loop(kit.pinkSt, 0.93).connect(this.airyBP).connect(this.filter("lowpass", 2600, 0.6)).connect(this.airy).connect(this.out);
    this.wet.gain.value = 0.06;
    this.airy.connect(this.wet);
  }

  events(): void {}

  params(now: number, s: RideState, e: Env): void {
    const sp = clamp(s.move / 10, 0, 1.5);
    const calm = 1 - 0.35 * s.night;
    const air = 0.25 + 0.75 * e.gust;
    const flow = sp * sp;
    const dir = clamp(s.steer * 0.3 + (vnoise(now / 13, 5) - 0.5) * 0.5, -0.5, 0.5);
    const base = (L_BREEZE * air * calm + L_FLOW * flow) * (1 + 0.25 * s.sea);
    glide(this.gL.gain, base * (1 - dir * 0.5), now, 0.25);
    glide(this.gR.gain, base * (1 + dir * 0.5), now, 0.25);
    glideStep(this.lpL.frequency, 380 + 260 * air + 650 * Math.min(1, sp) + 120 * (vnoise(now / 3.1, 7) - 0.5), now, 0.3);
    glideStep(this.lpR.frequency, 400 + 260 * air + 650 * Math.min(1, sp) + 120 * (vnoise(now / 2.7, 8) - 0.5), now, 0.3);
    glide(this.airy.gain, L_AIRY * Math.pow(e.gust, 1.6) * calm * (1 + 0.6 * Math.min(1, sp)), now, 0.5);
    glideStep(this.airyBP.frequency, 1200 + 500 * e.gust + 300 * Math.min(1, sp), now, 0.4);
  }
}
