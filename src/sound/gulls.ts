import { clamp, expRand, rr } from "./dsp";
import { GEN_SR, Kit, Layer, type RideState } from "./kit";
import { gull } from "./voices";

const L_GULL = 0.06;

/**
 * Seabirds: now and then a gull calls far out over the water, sometimes answered by another from a
 * different side. Always distant (dark far bus, mostly reverb), sparse, quieter toward evening and
 * silent at night.
 */
export class GullLayer extends Layer {
  private far: BiquadFilterNode;
  private next = 0;
  private answer = 0;
  private answerPan = 0;

  constructor(kit: Kit) {
    super(kit);
    kit.bank("gull", 6, GEN_SR, gull);
    this.far = this.filter("lowpass", 2200, 0.5);
    this.far.connect(this.out);
    this.wet.gain.value = 1;
  }

  private activity(s: RideState): number {
    return clamp((1 - s.night) * (1 - 0.6 * s.evening) * (0.6 + 0.4 * Math.max(s.sea, 1 - Math.min(1, s.shore / 80))), 0, 1);
  }

  events(now: number, _dt: number, s: RideState): void {
    const k = this.kit;
    const a = this.activity(s);
    if (!this.next) this.next = now + rr(k.rng, 12, 25);
    if (this.answer && now >= this.answer) {
      this.answer = 0;
      this.call(now + 0.02, this.answerPan, rr(k.rng, 0.75, 1));
    }
    if (now < this.next) return;
    if (a > 0.05 && k.has("gull")) {
      const pan = rr(k.rng, -0.85, 0.85);
      this.call(now + 0.02, pan, rr(k.rng, 0.6, 1));
      if (k.rng() < 0.35) {
        this.answer = now + rr(k.rng, 1.5, 4);
        this.answerPan = clamp(-pan + rr(k.rng, -0.3, 0.3), -0.9, 0.9);
      }
    }
    this.next = now + 10 + expRand(k.rng, 34 / Math.max(0.15, a));
  }

  /** One distant series; `d` 0.6…1 = how far away. */
  call(when: number, pan: number, d = 0.8): void {
    const k = this.kit;
    const b = k.pick("gull");
    if (!b) return;
    k.play(b, when, {
      gain: L_GULL * (1.3 - 0.7 * d),
      pan,
      panTo: clamp(pan + rr(k.rng, -0.35, 0.35), -0.95, 0.95),
      rate: rr(k.rng, 0.93, 1.06),
      dest: this.far,
      wet: 0.6 + 0.5 * d,
      wetDest: this.wet,
    });
  }

  params(): void {}
}
