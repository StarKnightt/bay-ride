import { clamp, smoothstep } from "./dsp";
import type { Kit } from "./kit";

/** Where a placed sound is, relative to the ears. */
export interface Place {
  /** −1 left … 1 right. */
  pan: number;
  /** Distance, m. */
  dist: number;
  /** 0 ahead or beside … 1 straight behind (a little darker). */
  back: number;
  /** Where it ends up by the end of the sound (a bird in flight); NaN = it stays put. */
  panTo: number;
  distTo: number;
}

/** How a placed sound fades with distance. */
export interface Falloff {
  /** No louder than at this distance, m. */
  near: number;
  /** Distance beyond `near` at which the level halves, m. */
  half: number;
  /** Low-pass cutoff up close and far away, Hz (air and the ground take the top off distant sounds). */
  bright: number;
  dark: number;
  /** Reverb send up close; it doubles toward the far field. */
  wet: number;
}

interface Voice {
  g: GainNode;
  lp: BiquadFilterNode;
  p: StereoPannerNode;
  w: GainNode;
  until: number;
}

/**
 * Placed one-shots on a fixed pool of voice chains (gain → air low-pass → pan, plus a reverb send):
 * however many gulls or fish are busy at once, at most `size` sounds play, and each costs one buffer
 * source. Distance sets the level, the darkness and the reverb share.
 */
export class Spots {
  private readonly voices: Voice[] = [];

  constructor(
    private readonly kit: Kit,
    dest: AudioNode,
    wetDest: AudioNode,
    size: number,
    private readonly fall: Falloff,
  ) {
    const ctx = kit.ctx;
    for (let i = 0; i < size; i++) {
      const g = ctx.createGain();
      g.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = fall.bright;
      lp.Q.value = 0.5;
      const p = ctx.createStereoPanner();
      const w = ctx.createGain();
      w.gain.value = 0;
      g.connect(lp).connect(p).connect(dest);
      p.connect(w).connect(wetDest);
      this.voices.push({ g, lp, p, w, until: 0 });
    }
  }

  /** Level at distance `d` relative to `near` (an inverse-distance law with a near clamp). */
  level(d: number): number {
    return 1 / (1 + Math.max(0, d - this.fall.near) / this.fall.half);
  }

  private cut(d: number, back: number): number {
    const f = this.fall;
    return clamp(f.bright * Math.pow(f.near / Math.max(d, f.near), 0.35), f.dark, f.bright) * (1 - 0.22 * clamp(back, 0, 1));
  }

  private wetAt(d: number): number {
    const f = this.fall;
    return f.wet * (1 + smoothstep(f.near, f.near + 8 * f.half, d));
  }

  /** Play `buf` at `when` from `at` with `gain` at the near distance. False (nothing played) when every voice is busy. */
  play(buf: AudioBuffer, when: number, at: Place, gain: number, rate = 1): boolean {
    let v: Voice | null = null;
    for (let i = 0; i < this.voices.length; i++)
      if (this.voices[i].until <= when) {
        v = this.voices[i];
        break;
      }
    if (!v || !Number.isFinite(when) || !Number.isFinite(at.pan) || !Number.isFinite(at.dist)) return false;
    rate = clamp(rate, 0.5, 2);
    const dur = buf.duration / rate;
    const end = when + dur;
    const moves = Number.isFinite(at.panTo) && Number.isFinite(at.distTo);
    const pan = clamp(at.pan, -1, 1);
    v.g.gain.cancelScheduledValues(when);
    v.lp.frequency.cancelScheduledValues(when);
    v.p.pan.cancelScheduledValues(when);
    v.w.gain.cancelScheduledValues(when);
    v.g.gain.setValueAtTime(gain * this.level(at.dist), when);
    v.lp.frequency.setValueAtTime(this.cut(at.dist, at.back), when);
    v.p.pan.setValueAtTime(pan, when);
    v.w.gain.setValueAtTime(this.wetAt(at.dist), when);
    if (moves) {
      v.g.gain.linearRampToValueAtTime(gain * this.level(at.distTo), end);
      v.lp.frequency.linearRampToValueAtTime(this.cut(at.distTo, at.back), end);
      v.p.pan.linearRampToValueAtTime(clamp(at.panTo, -1, 1), end);
      v.w.gain.linearRampToValueAtTime(this.wetAt(at.distTo), end);
    }
    const s = this.kit.ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    s.connect(v.g);
    s.onended = () => s.disconnect();
    s.start(when);
    v.until = end + 0.05;
    this.kit.nodes++;
    return true;
  }
}
