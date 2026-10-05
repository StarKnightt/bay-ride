import { clamp, rr, vnoise } from "./dsp";
import { Gate, GEN_SR, Kit, Layer, type RideState } from "./kit";
import { Spots, type Place } from "./spot";
import { crickets, fishIn, fishOut } from "./voices";

const L_FISH = 0.11;
const L_INSECTS = 0.014;
/** The cricket loop holds nothing above ~3.6 kHz: rendered at 16 kHz, its one-off generation job is half as long. */
const INSECT_SR = 16000;

/**
 * Leaping fish: a soft plip where one leaves the water and a small plop and splash where it falls
 * back in, placed where the leap is and fading with distance (they leap 12–58 m off, so most are
 * faint). A fixed three-voice pool: a busy patch of sea can't pile up sounds.
 */
export class FishLayer extends Layer {
  private spots: Spots;

  constructor(kit: Kit) {
    super(kit);
    kit.bank("fish-out", 4, GEN_SR, fishOut);
    kit.bank("fish-in", 5, GEN_SR, fishIn);
    this.spots = new Spots(kit, this.out, this.wet, 3, { near: 6, half: 9, bright: 3200, dark: 1300, wet: 0.35 });
    this.wet.gain.value = 1;
  }

  events(): void {}
  params(): void {}

  /** `entering`: falling back in (else leaving the water); `size` 0.8…1.3 (bigger: a little louder and lower). */
  splash(when: number, entering: boolean, at: Place, size: number): void {
    const b = this.kit.pick(entering ? "fish-in" : "fish-out");
    if (!b) return;
    const k = clamp(size, 0.6, 1.4);
    this.spots.play(b, when, at, L_FISH * (entering ? 1 : 0.6) * (0.7 + 0.3 * k), rr(this.kit.rng, 0.94, 1.06) * (1.12 - 0.12 * k));
  }
}

/**
 * Night insects: a very faint, far bed of tree-cricket trills when the listener is up in the grass
 * (the hill, the verges, the town's gardens), breathing slowly. Nothing by day, nothing at sea.
 */
export class InsectLayer extends Layer {
  private gate: Gate;
  private src: AudioBufferSourceNode | null = null;
  private readonly lp: BiquadFilterNode;

  constructor(kit: Kit) {
    super(kit);
    kit.loopBank("crickets", 2, INSECT_SR, crickets(6));
    this.lp = this.filter("lowpass", 3400, 0.5);
    this.gate = new Gate(this.gain(), this.out);
    this.lp.connect(this.gate.g);
    this.wet.gain.value = 0.5;
    this.out.connect(this.wet);
  }

  private level(s: RideState): number {
    return Math.pow(clamp((s.night - 0.35) / 0.65, 0, 1), 1.5) * s.grass * (1 - s.sea);
  }

  events(_now: number, _dt: number, s: RideState): void {
    if (this.src || this.level(s) <= 0 || !this.kit.has("crickets")) return;
    this.src = this.kit.loop(this.kit.get("crickets")[0]);
    this.src.connect(this.lp);
  }

  params(now: number, s: RideState): void {
    this.gate.set(L_INSECTS * this.level(s) * (0.75 + 0.25 * vnoise(now / 11, 51)), now, 1.5);
  }
}
