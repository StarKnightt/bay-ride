import { clamp, expRand, rr } from "./dsp";
import { GEN_SR, Kit, Layer, type RideState } from "./kit";
import { Spots, type Place } from "./spot";
import { flutter, gull } from "./voices";

const L_GULL = 0.06;
/** A placed call at (or nearer than) the near distance, about the old loudest call; perched birds call softer. */
const L_GULL_AT = 0.1;
const L_FLUTTER = 0.07;

/** Where a placed call comes from (and where the bird is by its end), and whether the bird is sitting. */
export interface GullPlace extends Place {
  perched: boolean;
}

/**
 * Seabirds: now and then a gull calls, sometimes answered by another. When the game says where its
 * gulls are (`placer`), each call comes from a real bird and follows it as it flies (level, darkness
 * and reverb by distance, never louder than a bird 8 m off); otherwise from somewhere far out over the
 * water, as before. Sparse, soft, quieter toward evening and silent at night. A perched gull that
 * takes off nearby beats its wings softly.
 */
export class GullLayer extends Layer {
  private far: BiquadFilterNode;
  private spots: Spots;
  private next = 0;
  private answer = 0;
  private answerPan = 0;
  /** Finds a bird for the next call (dur = its length, s); false when none can be heard. Null: unplaced calls. */
  placer: ((dur: number, out: GullPlace) => boolean) | null = null;
  private readonly at: GullPlace = { pan: 0, dist: 60, back: 0, panTo: NaN, distTo: NaN, perched: false };

  constructor(kit: Kit) {
    super(kit);
    kit.bank("gull", 6, GEN_SR, gull);
    kit.bank("flutter", 4, GEN_SR, flutter);
    this.far = this.filter("lowpass", 2200, 0.5);
    this.far.connect(this.out);
    this.spots = new Spots(kit, this.out, this.wet, 3, { near: 8, half: 30, bright: 2400, dark: 1000, wet: 0.45 });
    this.wet.gain.value = 1;
  }

  private activity(s: RideState): number {
    return clamp((1 - s.night) * (1 - 0.6 * s.evening) * (0.6 + 0.4 * Math.max(s.sea, 1 - Math.min(1, s.shore / 80))), 0, 1);
  }

  events(now: number, _dt: number, s: RideState): void {
    const k = this.kit;
    const a = this.activity(s);
    if (!this.next) this.next = now + rr(k.rng, 8, 20);
    if (this.answer && now >= this.answer) {
      this.answer = 0;
      if (a > 0.05) this.call(now + 0.02, this.answerPan, rr(k.rng, 0.75, 1));
    }
    if (now < this.next) return;
    let called = false;
    if (a > 0.05 && k.has("gull")) {
      const pan = rr(k.rng, -0.85, 0.85);
      called = this.call(now + 0.02, pan, rr(k.rng, 0.6, 1));
      if (called && k.rng() < 0.35) {
        this.answer = now + rr(k.rng, 1.5, 4);
        this.answerPan = clamp(-pan + rr(k.rng, -0.3, 0.3), -0.9, 0.9);
      }
    }
    // No bird to voice right now (all out of earshot): look again soon rather than after a full wait.
    this.next = now + (called || !this.placer ? 8 + expRand(k.rng, 24 / Math.max(0.15, a)) : rr(k.rng, 4, 8));
  }

  /** One call; `pan` and `d` (0.6…1, how far) place an unplaced one. False when no bird could be placed. */
  call(when: number, pan: number, d = 0.8): boolean {
    const k = this.kit;
    const b = k.pick("gull");
    if (!b) return false;
    const rate = rr(k.rng, 0.93, 1.06);
    if (this.placer) {
      const at = this.at;
      if (!this.placer(b.duration / rate, at)) return false;
      return this.spots.play(b, when, at, L_GULL_AT * (at.perched ? 0.7 : 1), at.perched ? rate * 0.95 : rate);
    }
    k.play(b, when, {
      gain: L_GULL * (1.3 - 0.7 * d),
      pan,
      panTo: clamp(pan + rr(k.rng, -0.35, 0.35), -0.95, 0.95),
      rate,
      dest: this.far,
      wet: 0.6 + 0.5 * d,
      wetDest: this.wet,
    });
    return true;
  }

  /** A perched gull takes off at `at`; its first wing beat peaks FLUTTER_LEAD s after `when`. */
  flutter(when: number, at: Place, rate = 1): void {
    const b = this.kit.pick("flutter");
    if (b) this.spots.play(b, when, at, L_FLUTTER, rate);
  }

  params(): void {}
}
