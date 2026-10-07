/**
 * Bay soundscape and score — everything is synthesised at runtime with Web Audio (no audio files).
 * The engine lives in ./sound/: waves on the sand (following the shoreline's own breaks and run-ups),
 * lapping at the pier and hull, the outboard and hull slaps, gulls calling from where the gulls are,
 * a soft flutter when one takes off nearby, leaping fish, faint night insects in the grass, wind,
 * footsteps on wood / sand / wet sand / stone / grass and through the shallows, jumps and landings, and
 * a quiet generative score that follows the time of day — all through warm open-air and hall reverbs
 * and a gentle compressor → limiter → soft-ceiling master (peaks held under −3.5 dBFS).
 *
 * ── Wiring guide ────────────────────────────────────────────────────────────────────────────────
 *   const audio = new RideAudio();
 *   new Input(() => audio.start());            // start() must run inside a user gesture (autoplay policy)
 *   audio.bindKeys();                          // M = music on/off, Shift+M = mute all
 *
 *   // every frame (all fields optional; air / vy = her jump: 1 while airborne, vertical speed m/s):
 *   audio.update(dt, { speed, steer, evening, night, air, vy });
 *
 *   // every frame (or whenever they change), the world around the listener:
 *   audio.setTimeOfDay("morning" | "noon" | "golden" | "sunset" | "dusk" | "night");  // music mood + gulls
 *   audio.setShore(distanceToWaterline_m, pan);   // pan −1 shore on the left … 1 on the right
 *   audio.setOpenWater(0…1);                      // 0 on land … 1 out on the bay (open-sea hush)
 *   audio.setNearPier(0…1, pan);                  // closeness to pier posts / moored hulls (lapping)
 *   audio.setMotion(m/s);                         // listener travel speed for the wind (feet or boat)
 *
 *   // the boat:
 *   audio.setInBoat(true | false);                // aboard: the outboard idles, our hull laps when still
 *   audio.setBoatThrottle(−1…1.35);               // astern … full … past full (Shift: a touch more, soft)
 *   audio.setBoatSpeed(m/s);
 *   audio.boatSlap(0…1);                          // optional: a swell meets the bow (auto-generated otherwise)
 *
 *   audio.footstep("wood" | "sand" | "wetsand" | "asphalt" | "grass" | "dirt", 0…1.5);
 *   audio.toggleMusic();  audio.toggleMute();  audio.setMasterVolume(0…1);
 *
 * Placed sounds need no calls here: the shoreline's window "shorewave" events drive the waves, and the
 * life posts to ./sound/cues (the listener's pose, gull take-offs, fish leaps, where its gulls are).
 * In water a footstep splashes and on the town's paving it is stone (both told apart here).
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { Vector3 } from "three";
import { CUE_FISH_IN, CUE_FISH_OUT, CUE_TAKEOFF, cues, type Cue } from "./sound/cues";
import { SoundEngine, type EngineInput, type GullPlace, type MoodName, type Place, type SoundEvent } from "./sound/engine";
import type { StepSurface } from "./sound/steps";
import { FLUTTER_HZ, FLUTTER_LEAD } from "./sound/voices";
import { waterAt, type WaterAt } from "./water/waves";
import { ROAD_HALF, roadX } from "./world/bay/road";
import { meshH } from "./world/bay/terrain";

export type { SoundEvent, MoodName } from "./sound/engine";
export type { StepSurface } from "./sound/steps";

export interface AudioFrame {
  /** Walking speed, m/s. */
  speed?: number;
  /** -1 … 1 turning. */
  steer?: number;
  evening?: number;
  night?: number;
  /** Her jump: 1 while airborne (jumped or dropping off an edge), and her vertical speed (m/s). */
  air?: number;
  vy?: number;
}

/** The shoreline's window event (src/water/waves.ts ShoreEvents). */
interface ShoreWave {
  kind: "break" | "runup";
  size: number;
  wave: number;
}

const PREFS_KEY = "bay-ride:audio";
const FADE_IN = 2.5;
/** Seconds after the player starts before the score begins to fade in. */
const MUSIC_DELAY = 5;
/** Paved ground this far inland of the road's centre line is the town's stone lanes and forecourt. */
const STONE_U = ROAD_HALF + 1.6;
/** Water over the sand deeper than this (m) splashes underfoot. */
const SPLASH_DEPTH = 0.01;
const landHardness = (vy: number) => Math.min(1, Math.max(0.3, -vy / 5.5));

export class RideAudio {
  private ctx: AudioContext | null = null;
  private engine: SoundEngine | null = null;
  private vol = 0.8;
  private mute = false;
  private musicOn = true;
  private hideTimer = 0;
  private onVis = () => this.visibility();
  private mood: MoodName = "golden";
  private world: EngineInput = { speed: 0, shore: 30, shorePan: -0.5, sea: 0, pier: 0, pierPan: 0, boat: 0, throttle: 0, boatSpeed: 0, grass: 0 };
  private slapQ = 0;
  private musicPending = false;
  // placed sounds (scratch, reused)
  private readonly cue: Cue = { kind: 0, x: 0, y: 0, z: 0, at: 0, a: 0, b: 0 };
  private readonly spot: Place = { pan: 0, dist: 10, back: 0, panTo: NaN, distTo: NaN };
  private readonly gullAt = new Vector3();
  private lastGull = -1;
  // her feet: the ground she last stood on, the jump
  private readonly wa: WaterAt = { y: NaN, depth: 0, wet: 0 };
  private surface: StepSurface = "wood";
  private depth = 0;
  private aloft = false;
  private minVy = 0;
  private landedAt = -1;
  private landK = 0.5;
  private landDone = true;
  private secondAt = -1;

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
    engine.gullPlacer = this.placeGull;
    // The score starts on the first update, once the game has said which time of day it is.
    this.musicPending = true;
    document.addEventListener("visibilitychange", this.onVis);
    window.addEventListener("shorewave", this.onShore);
    if (ctx.state === "suspended") void ctx.resume();
  }

  update(dt: number, extras?: AudioFrame): void {
    const ctx = this.ctx;
    const e = this.engine;
    if (!ctx || !e || ctx.state !== "running") return;
    const now = ctx.currentTime;
    const w = this.world;
    w.speed = extras?.speed ?? 0;
    w.steer = extras?.steer;
    if (extras?.evening !== undefined) w.evening = extras.evening;
    if (extras?.night !== undefined) w.night = extras.night;
    // Grass (night insects) lies inland of the coast road: the verges, the hill and the town's gardens.
    w.grass = cues.live ? Math.min(1, Math.max(0, (cues.px - roadX(cues.pz) - 4) / 26)) : 0;
    w.slap = this.slapQ;
    this.slapQ = 0;
    if (this.musicPending) {
      this.musicPending = false;
      e.startMusic(now, MUSIC_DELAY);
    }
    this.feet(now, extras?.air ?? 0, extras?.vy ?? 0);
    this.placed(now);
    e.tick(now, dt, w);
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

  /** Listener travel speed (m/s) for the wind; defaults to the walking speed (or boat speed when aboard). */
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

  /** −1 full astern … 1 full ahead … 1.35 past full (Shift); the motor only rises a touch past full. */
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

  /**
   * A footstep while walking, strength 0…1.5 (jogging ≈ 1.2). Water over the sand turns it into a
   * splash (deeper: wading), the town's paving into stone; the first plant after a jump is the landing.
   */
  footstep(surface: StepSurface, strength = 0.8): void {
    const ctx = this.ctx, e = this.engine;
    if (!ctx || !e) return;
    const now = ctx.currentTime;
    const s = (this.surface = this.ground(surface));
    if (!this.landDone && (this.aloft || now - this.landedAt < 0.2)) {
      // The landing: the first foot down carries it, the other follows as a soft step.
      this.landDone = true;
      this.secondAt = now;
      e.land(now + 0.005, s, this.aloft ? landHardness(this.minVy) : this.landK, this.depth);
      return;
    }
    e.footstep(now + 0.005, s, now - this.secondAt < 0.2 ? strength * 0.45 : strength, this.depth);
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

  /** The M key (`shift`: Shift+M, mute everything); the touch music button presses it too. */
  musicKey(shift: boolean): void {
    this.start();
    if (shift) this.toggleMute();
    else if (this.mute) {
      // Muted, M brings the sound back with the music playing (not silently switched off).
      this.setMuted(false);
      if (!this.musicOn) this.setMusic(true);
    } else this.toggleMusic();
  }

  /**
   * Inside a tap's user activation (touchend): phones refuse sound before one, and a touch's
   * pointerdown doesn't count. Starts or resumes the context and plays one silent sample (older iOS
   * only unlocks on a sound started in the gesture). True once it runs.
   */
  unlock(): boolean {
    this.start();
    const ctx = this.ctx;
    if (!ctx) return false;
    if (ctx.state !== "running" && !document.hidden) void ctx.resume();
    try {
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      /* closed */
    }
    return ctx.state === "running";
  }

  /** M = music on/off, Shift+M = mute everything. Returns a function that removes the listener. */
  bindKeys(target: Window = window): () => void {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.code === "KeyM") this.musicKey(e.shiftKey);
    };
    target.addEventListener("keydown", onKey);
    return () => target.removeEventListener("keydown", onKey);
  }

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onVis);
    window.removeEventListener("shorewave", this.onShore);
    clearTimeout(this.hideTimer);
    void this.ctx?.close();
    this.ctx = null;
    this.engine = null;
  }

  private ducked = false;

  /** A wave of the shoreline near her breaks offshore or runs up the sand: the wave layer follows it. */
  private onShore = (ev: Event): void => {
    const d = (ev as CustomEvent<ShoreWave>).detail;
    const ctx = this.ctx;
    if (!ctx || !this.engine || ctx.state !== "running" || !d) return;
    this.engine.shoreWave(ctx.currentTime + 0.02, d.kind === "break" ? "break" : "runup", d.size, d.wave);
  };

  /** The ground as it sounds: water over the sand splashes (`depth` kept), the town's paving is stone. */
  private ground(surface: StepSurface): StepSurface {
    this.depth = 0;
    if (!cues.live) return surface;
    const x = cues.px, z = cues.pz;
    if (surface === "sand" || surface === "wetsand") {
      const d = waterAt(x, z, cues.t, meshH(x, z), this.wa).depth;
      if (d > SPLASH_DEPTH) {
        this.depth = d;
        return "water";
      }
    } else if (surface === "asphalt" && x - roadX(z) > STONE_U) return "stone";
    return surface;
  }

  /** Take-off and landing, from her airborne flag and vertical speed (her feet plant again on landing). */
  private feet(now: number, air: number, vy: number): void {
    const e = this.engine!;
    if (air >= 0.5) {
      if (!this.aloft) {
        this.aloft = true;
        this.landDone = false;
        this.minVy = vy;
        // A jump pushes off the ground she stood on; a drop off an edge has nothing to push from.
        if (vy > 0.8) e.takeoff(now + 0.005, this.surface, Math.min(1, vy / 3.5), this.depth);
      }
      this.minVy = Math.min(this.minVy, vy);
    } else if (this.aloft) {
      this.aloft = false;
      this.landedAt = now;
      this.landK = landHardness(this.minVy);
    }
    // The landing normally comes with her feet planting (footstep); if they haven't, land anyway.
    if (!this.landDone && !this.aloft && now - this.landedAt > 0.15) {
      this.landDone = true;
      e.land(now, this.surface, this.landK, this.depth);
    }
  }

  /** Pan, distance and how far behind the ears a world point is. */
  private where(x: number, y: number, z: number, out: Place): void {
    const dx = x - cues.x, dy = y - cues.y, dz = z - cues.z;
    const d = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    out.pan = (dx * -cues.fz + dz * cues.fx) / d;
    out.dist = d;
    out.back = Math.max(0, -(dx * cues.fx + dz * cues.fz) / d);
  }

  /** What the world posted with a place (gull take-offs, fish leaps), placed round the ears. */
  private placed(now: number): void {
    const e = this.engine!, q = this.cue, p = this.spot;
    while (cues.take(q)) {
      const when = now + 0.02 + (q.at - cues.t);
      // stale (posted before the sound started, or while it was suspended) or bogus
      if (!(when > now - 0.05 && when < now + 4)) continue;
      this.where(q.x, q.y, q.z, p);
      p.panTo = p.distTo = NaN;
      if (q.kind === CUE_TAKEOFF) {
        // Line the wing beats up with the visible downstrokes (fastest at flap phase 0.5).
        const hz = q.b > 0 ? q.b : FLUTTER_HZ;
        let lead = ((((0.5 - q.a) % 1) + 1) % 1) / hz - (FLUTTER_LEAD * FLUTTER_HZ) / hz;
        if (lead < 0) lead += 1 / hz;
        e.gullTakeoff(Math.max(now + 0.005, when + lead), p, hz / FLUTTER_HZ);
      } else if (q.kind === CUE_FISH_OUT || q.kind === CUE_FISH_IN) e.fishSplash(Math.max(now + 0.005, when), q.kind === CUE_FISH_IN, p, q.a);
    }
  }

  /** The engine wants a gull to call: a random one in sight and earshot (perched ones now and then), followed over the call. */
  private placeGull = (dur: number, out: GullPlace): boolean => {
    const src = cues.gulls, at = this.gullAt;
    if (!src || !cues.live || src.voices <= 0) return false;
    for (let k = 0; k < 8; k++) {
      const i = Math.floor(Math.random() * src.voices);
      if (i === this.lastGull) continue;
      const kind = src.where(i, 0, at);
      if (kind === 0 || (kind === 2 && Math.random() > 0.3)) continue;
      this.where(at.x, at.y, at.z, out);
      if (out.dist > 240) continue;
      const pan = out.pan, dist = out.dist, back = out.back;
      src.where(i, dur, at);
      this.where(at.x, at.y, at.z, out);
      out.panTo = out.pan;
      out.distTo = out.dist;
      out.pan = pan;
      out.dist = dist;
      out.back = back;
      out.perched = kind === 2;
      this.lastGull = i;
      return true;
    }
    return false;
  };

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
