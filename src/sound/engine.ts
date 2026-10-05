import { WindLayer } from "./air";
import { BoatLayer } from "./boat";
import { clamp, reverbIR, smoothstep, vnoise } from "./dsp";
import { GullLayer, type GullPlace } from "./gulls";
import { Kit, type Env, type Layer, type RideState } from "./kit";
import { FishLayer, InsectLayer } from "./life";
import { Music, type MoodName } from "./music";
import { LapLayer, ShoreLayer } from "./sea";
import type { Place } from "./spot";
import { Steps, type StepSurface } from "./steps";

export type LayerName = "wind" | "shore" | "lap" | "boat" | "gulls" | "fish" | "insects";
export const LAYER_NAMES: LayerName[] = ["wind", "shore", "lap", "boat", "gulls", "fish", "insects"];
export type SoundEvent = "gull" | "slap";
export type { MoodName } from "./music";
export type { GullPlace } from "./gulls";
export type { Place } from "./spot";

/** Raw per-frame input; anything left undefined falls back to a sensible default. */
export interface EngineInput {
  /** Walking speed on foot, m/s (the wind follows it ashore). */
  speed?: number;
  /** -1 … 1, turning (the wind swings a little toward it). */
  steer?: number;
  move?: number;
  shore?: number;
  shorePan?: number;
  sea?: number;
  pier?: number;
  pierPan?: number;
  boat?: number;
  /** −1 full astern … 1 full ahead … 1.35 past full (Shift). */
  throttle?: number;
  boatSpeed?: number;
  slap?: number;
  evening?: number;
  night?: number;
  /** 0 … 1 how much grass round the listener (night insects). */
  grass?: number;
}

export interface EngineOptions {
  seed?: number;
  /** Generate voice banks a few ms per tick instead of all up front (real-time use). */
  lazy?: boolean;
  /** Include the generative score (default true). */
  music?: boolean;
}

const PARAM_RATE = 1 / 30;
/** Hard output ceiling: −3.5 dBFS (the curve tops out at 0.6671, −3.52 dBFS). */
const CEIL = 0.668;

/** A finite input clamped to [a, b], else the default `d`. */
const num = (v: number | undefined, d: number, a = 0, b = 1): number => (v === undefined || !Number.isFinite(v) ? d : clamp(v, a, b));

export class SoundEngine {
  readonly kit: Kit;
  readonly layers: Record<LayerName, Layer>;
  readonly music: Music | null;
  /** Final node of the chain (after the safety clipper) — tap it for metering. */
  readonly output: AudioNode;
  private readonly boat: BoatLayer;
  private readonly gulls: GullLayer;
  private readonly shore: ShoreLayer;
  private readonly fish: FishLayer;
  private readonly steps: Steps;
  private readonly env: Env = { gust: 0, turb: 0 };
  private readonly volume: GainNode;
  private readonly mix: GainNode;
  private readonly sfx: GainNode;
  private readonly verbIn: AudioNode;
  private readonly routed = new Set<LayerName>();
  private readonly lazy: boolean;
  private lastParams = -1;
  private state: RideState = {
    speed: 0,
    steer: 0,
    move: 0,
    shore: 30,
    shorePan: -0.5,
    sea: 0,
    pier: 0,
    pierPan: 0,
    boat: 0,
    throttle: 0,
    boatSpeed: 0,
    slap: 0,
    evening: 0.5,
    night: 0,
    grass: 0,
  };

  constructor(
    readonly ctx: BaseAudioContext,
    dest: AudioNode,
    opts: EngineOptions = {},
  ) {
    this.lazy = opts.lazy ?? false;
    const kit = (this.kit = new Kit(ctx, opts.seed ?? (Math.random() * 2 ** 31) | 0));

    // ── master: (sfx + music) → rumble cut → warm tilt → gentle glue → volume → limiter → soft ceiling ──
    // DynamicsCompressorNode adds automatic makeup gain; the layer levels are tuned (and measured) with it.
    const mix = (this.mix = ctx.createGain());
    const sub = ctx.createBiquadFilter();
    sub.type = "highpass";
    sub.frequency.value = 45;
    sub.Q.value = 0.6;
    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    high.frequency.value = 6000;
    high.gain.value = -4;
    const top = ctx.createBiquadFilter();
    top.type = "lowpass";
    top.frequency.value = 9500;
    top.Q.value = 0.5;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -24;
    glue.knee.value = 12;
    glue.ratio.value = 2;
    glue.attack.value = 0.04;
    glue.release.value = 0.4;
    this.volume = ctx.createGain();
    this.volume.gain.value = 1;
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    const trim = ctx.createGain();
    trim.gain.value = 0.7;
    const clip = ctx.createWaveShaper();
    clip.curve = softCeiling();
    mix.connect(sub).connect(high).connect(top).connect(glue).connect(this.volume).connect(limiter).connect(trim).connect(clip).connect(dest);
    this.output = clip;

    // ── open-air reverb for the soundscape ──
    this.sfx = ctx.createGain();
    this.sfx.connect(mix);
    const verbIn = ctx.createBiquadFilter();
    verbIn.type = "bandpass";
    verbIn.frequency.value = 900;
    verbIn.Q.value = 0.4;
    const conv = ctx.createConvolver();
    conv.normalize = false;
    kit.defer("reverb", () => (conv.buffer = kit.buffer(reverbIR(ctx.sampleRate, kit.rng, 2.4, 2.0), ctx.sampleRate)));
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.8;
    verbIn.connect(conv).connect(verbOut).connect(this.sfx);
    this.verbIn = verbIn;

    this.boat = new BoatLayer(kit);
    this.gulls = new GullLayer(kit);
    this.shore = new ShoreLayer(kit);
    this.fish = new FishLayer(kit);
    this.layers = { wind: new WindLayer(kit), shore: this.shore, lap: new LapLayer(kit), boat: this.boat, gulls: this.gulls, fish: this.fish, insects: new InsectLayer(kit) };
    this.steps = new Steps(kit, this.sfx, verbIn);
    this.music = opts.music === false ? null : new Music(kit, mix);
    this.solo(null);
    if (!this.lazy) kit.pump(Infinity);
  }

  /** Advance the soundscape. `now` is the audio-clock time events are scheduled against. */
  tick(now: number, dt: number, inp: EngineInput): void {
    if (this.lazy && this.kit.pending) this.kit.pump(3);
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    const s = this.state;
    s.speed = num(inp.speed, 0, 0, 40);
    s.steer = num(inp.steer, 0, -1, 1);
    s.boat = num(inp.boat, s.boat);
    s.throttle = num(inp.throttle, s.throttle, -1, 1.35);
    s.boatSpeed = num(inp.boatSpeed, s.boatSpeed, 0, 30);
    s.move = num(inp.move, Math.max(s.speed, s.boat * s.boatSpeed), 0, 40);
    s.shore = num(inp.shore, s.shore, 0, 5000);
    s.shorePan = num(inp.shorePan, s.shorePan, -1, 1);
    s.sea = num(inp.sea, s.sea);
    s.pier = num(inp.pier, s.pier);
    s.pierPan = num(inp.pierPan, s.pierPan, -1, 1);
    s.slap = num(inp.slap, 0, 0, 2);
    s.evening = num(inp.evening, s.evening);
    s.night = num(inp.night, s.night);
    s.grass = num(inp.grass, s.grass);

    const env = this.env;
    env.gust = smoothstep(0.3, 0.85, 0.55 * vnoise(now / 9, 21) + 0.45 * vnoise(now / 23, 22));
    env.turb = vnoise(now * 3.3, 23);
    for (let i = 0; i < LAYER_NAMES.length; i++) this.layers[LAYER_NAMES[i]].events(now, dt, s, env);
    if (this.lastParams < 0 || now - this.lastParams >= PARAM_RATE || now < this.lastParams) {
      this.lastParams = now;
      for (let i = 0; i < LAYER_NAMES.length; i++) this.layers[LAYER_NAMES[i]].params(now, s, env);
      this.music?.tick(now);
    }
  }

  setVolume(v: number, now: number, tau = 0.08): void {
    this.volume.gain.cancelScheduledValues(now);
    this.volume.gain.setTargetAtTime(clamp(v, 0, 2), now, tau);
  }

  /**
   * Hear only some layers (null = everything). Footsteps stay audible unless "music" is given, which
   * leaves the score alone.
   */
  solo(name: LayerName | LayerName[] | "music" | null): void {
    const list = name === null ? LAYER_NAMES : name === "music" ? [] : Array.isArray(name) ? name : [name];
    for (const n of LAYER_NAMES) {
      const l = this.layers[n];
      const on = list.includes(n);
      if (on === this.routed.has(n)) continue;
      if (on) {
        l.out.connect(this.sfx);
        l.wet.connect(this.verbIn);
        this.routed.add(n);
      } else {
        l.out.disconnect(this.sfx);
        l.wet.disconnect(this.verbIn);
        this.routed.delete(n);
      }
    }
    this.sfx.gain.value = name === "music" ? 0 : 1;
  }

  /** Hull meeting a swell, strength 0…1. */
  slap(when: number, strength: number): void {
    this.boat.slap(when, strength);
  }

  /** One footstep on `surface` (0…1.5 strength) — used while she explores on foot. `depth`: water over the ground, m. */
  footstep(when: number, surface: StepSurface, strength: number, depth = 0): void {
    this.steps.play(when, surface, strength, depth);
  }

  /** Landing from a jump or a drop (`k` 0.3…1 how hard) on `surface`. */
  land(when: number, surface: StepSurface, k: number, depth = 0): void {
    this.steps.land(when, surface, k, depth);
  }

  /** The push-off of a jump from `surface`. */
  takeoff(when: number, surface: StepSurface, k: number, depth = 0): void {
    this.steps.takeoff(when, surface, k, depth);
  }

  /** The shoreline's own wave near the listener: "break" offshore or "runup" on the sand (size in m, wave number). */
  shoreWave(when: number, kind: "break" | "runup", size: number, wave: number): void {
    this.shore.shoreEvent(when, kind, size, wave, this.state);
  }

  /** Who places the gull calls (the game: its actual gulls); null = distant, unplaced calls. */
  set gullPlacer(fn: ((dur: number, out: GullPlace) => boolean) | null) {
    this.gulls.placer = fn;
  }

  /** A perched gull takes off at `at`; its first wing beat peaks FLUTTER_LEAD s after `when`. */
  gullTakeoff(when: number, at: Place, rate = 1): void {
    this.gulls.flutter(when, at, rate);
  }

  /** A leaping fish leaves the water (`entering` false) or falls back in, at `at`. */
  fishSplash(when: number, entering: boolean, at: Place, size: number): void {
    this.fish.splash(when, entering, at, size);
  }

  startMusic(now: number, delay?: number): void {
    this.music?.start(now, delay);
  }

  setMusic(on: boolean, now: number): void {
    this.music?.setEnabled(on, now);
  }

  setMood(name: MoodName, now: number): void {
    this.music?.setMood(name, now);
  }

  trigger(ev: SoundEvent, when: number): void {
    switch (ev) {
      case "gull":
        this.gulls.call(when, (this.kit.rng() - 0.5) * 1.4, 0.7);
        return;
      case "slap":
        return this.boat.slap(when, 0.8);
    }
  }
}

/** Transparent below 0.5, then a tanh knee that never exceeds CEIL (≈ −3.5 dBFS). */
function softCeiling(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const c = new Float32Array(n);
  const k = 0.5;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    c[i] = a < k ? x : Math.sign(x) * (k + (CEIL - k) * Math.tanh((a - k) / (CEIL - k)));
  }
  return c;
}
