/**
 * Bay soundscape and score — everything is synthesised at runtime with Web Audio (no audio files).
 * The engine lives in ./sound/: waves on the sand, lapping at the pier and hull, the outboard and hull
 * slaps, distant gulls, wind, the bicycle, footsteps on wood / sand / wet sand, and a quiet generative
 * score that follows the time of day — all through warm open-air and hall reverbs and a gentle
 * compressor → limiter → soft-ceiling master (peaks held under −3.5 dBFS).
 *
 * ── Wiring guide ────────────────────────────────────────────────────────────────────────────────
 *   const audio = new RideAudio();
 *   new Input(() => audio.start());            // start() must run inside a user gesture (autoplay policy)
 *   audio.bindKeys();                          // B = bell, M = music on/off, Shift+M = mute all
 *
 *   // every frame, the bike (unchanged signature; the 7th argument is optional):
 *   audio.update(dt, speed, cadence, wheelRate, pedaling, braking, { steer, bump, roughness, evening, night });
 *
 *   // every frame (or whenever they change), the world around the listener:
 *   audio.setTimeOfDay("morning" | "noon" | "golden" | "sunset" | "dusk" | "night");  // music mood + gulls
 *   audio.setShore(distanceToWaterline_m, pan);   // pan −1 shore on the left … 1 on the right
 *   audio.setOpenWater(0…1);                      // 0 on land … 1 out on the bay (open-sea hush)
 *   audio.setNearPier(0…1, pan);                  // closeness to pier posts / moored hulls (lapping)
 *   audio.setMotion(m/s);                         // listener travel speed for the wind (bike, feet or boat)
 *
 *   // the boat (once it exists):
 *   audio.setInBoat(true | false);                // aboard: the outboard idles, our hull laps when still
 *   audio.setBoatThrottle(0…1);  audio.setBoatSpeed(m/s);
 *   audio.boatSlap(0…1);                          // optional: a swell meets the bow (auto-generated otherwise)
 *
 *   audio.footstep("wood" | "sand" | "wetsand" | "asphalt" | "grass" | "dirt", 0…1.5);
 *   audio.ringBell();  audio.toggleMusic();  audio.toggleMute();  audio.setMasterVolume(0…1);
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { SoundEngine, type EngineInput, type MoodName, type SoundEvent } from "./sound/engine";
import type { StepSurface } from "./sound/steps";

export type { SoundEvent, MoodName } from "./sound/engine";
export type { StepSurface } from "./sound/steps";

export interface RideAudioExtras {
  steer?: number;
  bump?: number;
  roughness?: number;
  evening?: number;
  night?: number;
}

const PREFS_KEY = "bay-ride:audio";
const FADE_IN = 2.5;
/** Seconds after the player starts before the score begins to fade in. */
const MUSIC_DELAY = 5;

export class RideAudio {
  private ctx: AudioContext | null = null;
  private engine: SoundEngine | null = null;
  private vol = 0.8;
  private mute = false;
  private musicOn = true;
  private hideTimer = 0;
  private onVis = () => this.visibility();
  private mood: MoodName = "golden";
  private world: EngineInput = { speed: 0, crank: 0, wheel: 0, pedal: 0, brake: 0, shore: 30, shorePan: -0.5, sea: 0, pier: 0, pierPan: 0, boat: 0, throttle: 0, boatSpeed: 0 };
  private slapQ = 0;

  constructor() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as { volume?: number; muted?: boolean; music?: boolean };
      if (typeof p.volume === "number" && Number.isFinite(p.volume)) this.vol = Math.min(1, Math.max(0, p.volume));
      if (typeof p.muted === "boolean") this.mute = p.muted;
      if (typeof p.music === "boolean") this.musicOn = p.music;
    } catch {
      /* private mode / no storage */
    }
  }

  /** "off" before start(), otherwise the AudioContext state. */
  get state(): string {
    return this.ctx ? this.ctx.state : "off";
  }

  get muted(): boolean {
    return this.mute;
  }

  get music(): boolean {
    return this.musicOn;
  }

  get volume(): number {
    return this.vol;
  }

  /** Create (or resume) the audio context. Call from a user gesture. */
  start(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended" && !document.hidden) void this.ctx.resume();
      return;
    }
    const AC: typeof AudioContext | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC({ latencyHint: "playback" });
    this.ctx = ctx;
    const engine = (this.engine = new SoundEngine(ctx, ctx.destination, { lazy: true }));
    engine.setVolume(0, ctx.currentTime, 0.01);
    this.applyVolume(FADE_IN / 3);
    engine.setMood(this.mood, ctx.currentTime);
    engine.setMusic(this.musicOn, ctx.currentTime);
    engine.startMusic(ctx.currentTime, MUSIC_DELAY);
    document.addEventListener("visibilitychange", this.onVis);
    if (ctx.state === "suspended") void ctx.resume();
  }

  update(dt: number, speed: number, crankRate: number, wheelRate: number, pedaling: number, braking: boolean | number, extras?: RideAudioExtras): void {
    const ctx = this.ctx;
    if (!ctx || !this.engine || ctx.state !== "running") return;
    const w = this.world;
    w.speed = speed;
    w.crank = crankRate;
    w.wheel = wheelRate;
    w.pedal = pedaling;
    w.brake = typeof braking === "number" ? braking : braking ? 1 : 0;
    w.steer = extras?.steer;
    w.bump = extras?.bump;
    w.roughness = extras?.roughness;
    if (extras?.evening !== undefined) w.evening = extras.evening;
    if (extras?.night !== undefined) w.night = extras.night;
    w.slap = this.slapQ;
    this.slapQ = 0;
    this.engine.tick(ctx.currentTime, dt, w);
  }

  // ── world hooks (cheap setters; read on the next update) ──

  /** Music mood (and gull activity via evening/night if those aren't passed to update). */
  setTimeOfDay(preset: string): void {
    if (!isMood(preset) || preset === this.mood) return;
    this.mood = preset;
    if (this.ctx && this.engine) this.engine.setMood(preset, this.ctx.currentTime);
  }

  /** Distance (m) to the breaking shoreline and its direction (−1 left … 1 right of where we face). */
  setShore(distance: number, pan = 0): void {
    this.world.shore = distance;
    this.world.shorePan = pan;
  }

  /** 0 on land … 1 out on open water. */
  setOpenWater(amount: number): void {
    this.world.sea = amount;
  }

  /** 0…1 closeness to pier posts / moored hulls, and their direction. */
  setNearPier(amount: number, pan = 0): void {
    this.world.pier = amount;
    this.world.pierPan = pan;
  }

  /** Listener travel speed (m/s) for the wind; defaults to the bike speed (or boat speed when aboard). */
  setMotion(speed: number | undefined): void {
    this.world.move = speed;
  }

  setInBoat(aboard: boolean): void {
    this.world.boat = aboard ? 1 : 0;
    if (!aboard) {
      this.world.throttle = 0;
      this.world.boatSpeed = 0;
    }
  }

  setBoatThrottle(t: number): void {
    this.world.throttle = t;
  }

  setBoatSpeed(speed: number): void {
    this.world.boatSpeed = speed;
  }

  /** A swell meets the hull, strength 0…1 (optional — slaps are generated from boat speed otherwise). */
  boatSlap(strength = 0.6): void {
    this.slapQ = Math.max(this.slapQ, strength);
  }

  /** Thumb bell. Starts audio if needed. */
  ringBell(): void {
    this.start();
    if (this.ctx && this.engine) this.engine.ringBell(this.ctx.currentTime + 0.01);
  }

  /** Tyre over a seam, strength 0…1. */
  bump(strength = 0.6): void {
    if (this.ctx && this.engine) this.engine.bump(this.ctx.currentTime + 0.01, strength);
  }

  /** A footstep while walking, strength 0…1.5 (jogging ≈ 1.2). */
  footstep(surface: StepSurface, strength = 0.8): void {
    if (this.ctx && this.engine) this.engine.footstep(this.ctx.currentTime + 0.005, surface, strength);
  }

  /** Fire a specific sound now (handy for testing). */
  trigger(ev: SoundEvent): void {
    if (this.ctx && this.engine) this.engine.trigger(ev, this.ctx.currentTime + 0.02);
  }

  /** 0…1 (persisted). */
  setMasterVolume(v: number): void {
    this.vol = Math.min(1, Math.max(0, Number.isFinite(v) ? v : this.vol));
    this.applyVolume();
    this.save();
  }

  setMuted(m: boolean): void {
    this.mute = m;
    this.applyVolume();
    this.save();
  }

  toggleMute(): boolean {
    this.setMuted(!this.mute);
    return this.mute;
  }

  /** Background music on / off (persisted); the soundscape keeps playing. */
  setMusic(on: boolean): void {
    this.musicOn = on;
    if (this.ctx && this.engine) this.engine.setMusic(on, this.ctx.currentTime);
    this.save();
  }

  toggleMusic(): boolean {
    this.setMusic(!this.musicOn);
    return this.musicOn;
  }

  /** Pause: duck to near-silence over ~0.4 s, and back. */
  setPaused(p: boolean): void {
    this.ducked = p;
    this.applyVolume(0.13);
  }

  /** B = bell, M = music on/off, Shift+M = mute everything. Returns a function that removes the listener. */
  bindKeys(target: Window = window): () => void {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.code === "KeyB") this.ringBell();
      else if (e.code === "KeyM") {
        this.start();
        if (e.shiftKey) this.toggleMute();
        else {
          if (this.mute) this.setMuted(false);
          this.toggleMusic();
        }
      }
    };
    target.addEventListener("keydown", onKey);
    return () => target.removeEventListener("keydown", onKey);
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVis);
    clearTimeout(this.hideTimer);
    void this.ctx?.close();
    this.ctx = null;
    this.engine = null;
  }

  private ducked = false;

  private applyVolume(tau = 0.08): void {
    if (this.ctx && this.engine) this.engine.setVolume(this.mute ? 0 : this.ducked ? this.vol * 0.03 : this.vol, this.ctx.currentTime, tau);
  }

  private save(): void {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: this.vol, muted: this.mute, music: this.musicOn }));
    } catch {
      /* ignore */
    }
  }

  /** Fade out and suspend while the tab is hidden; fade back in when it returns. */
  private visibility(): void {
    const ctx = this.ctx;
    if (!ctx || !this.engine) return;
    clearTimeout(this.hideTimer);
    if (document.hidden) {
      this.engine.setVolume(0, ctx.currentTime, 0.04);
      this.hideTimer = window.setTimeout(() => void ctx.suspend(), 250);
    } else {
      void ctx.resume().then(() => this.applyVolume(0.3));
    }
  }
}

const MOODS: readonly string[] = ["morning", "noon", "golden", "sunset", "dusk", "night"];
const isMood = (p: string): p is MoodName => MOODS.includes(p);
