/**
 * Generative background score: a quiet, warm, slowly evolving piece for felt piano, music box, a soft
 * string pad, a low bass and an occasional sustained string line — all synthesised.
 *
 * Structure: the score plays "pieces" separated by long rests. A piece is a short song form
 * (intro → theme → varied theme → contrasting phrase → theme → outro), each section one 8-bar phrase
 * over a 4-chord progression (two bars per chord). The theme's rhythm is kept and its pitches are re-fitted
 * to each new progression, so it is recognisable but never a literal loop; every piece draws a new
 * theme, new progressions and new accompaniment figures. Harmony stays consonant: major / lydian keys,
 * add9 and maj7 colours, a borrowed minor iv for warmth, melodies weighted toward the pentatonic.
 *
 * Mood follows the time of day (key, tempo, metre, instrumentation, density, brightness); a change is
 * taken at the next phrase so it never jolts.
 */
import { clamp, lerp, mulberry32, reverbIR, sn, TAU, type Rng } from "./dsp";
import type { Kit } from "./kit";

export type MoodName = "morning" | "noon" | "golden" | "sunset" | "dusk" | "night";

interface Mood {
  key: number; // tonic pitch class (0 = C)
  bpm: number;
  meter: 3 | 4;
  lydian: number; // chance a phrase uses the raised 4th
  progs: number[]; // indices into PROGS
  accomp: string[]; // accompaniment figures
  melodyBox: number; // chance the theme is sung by the music box instead of the piano
  sparkle: number; // music box glints per bar
  pad: number; // string pad level 0…1
  strings: number; // sustained string line chance per bar
  density: number; // 0 sparse … 1 busy melody rhythms
  bright: number; // tone low-pass (Hz)
  center: number; // melody centre, semitones above the tonic
  gain: number; // per-mood level trim so every time of day sits at the same quiet loudness
}

const MOODS: Record<MoodName, Mood> = {
  morning: { key: 2, bpm: 72, meter: 4, lydian: 0.5, progs: [0, 1, 5, 6, 9, 2], accomp: ["flow", "broken"], melodyBox: 0.15, sparkle: 0.3, pad: 0.45, strings: 0.1, density: 0.7, bright: 4200, center: 9 , gain: 1.45 },
  noon: { key: 5, bpm: 76, meter: 4, lydian: 0.2, progs: [0, 1, 2, 6, 4, 8], accomp: ["flow", "broken"], melodyBox: 0.05, sparkle: 0.15, pad: 0.4, strings: 0.2, density: 0.75, bright: 4200, center: 8 , gain: 1.3 },
  golden: { key: 3, bpm: 68, meter: 4, lydian: 0.1, progs: [3, 4, 0, 7, 2, 8], accomp: ["broken", "rolled", "flow"], melodyBox: 0, sparkle: 0.1, pad: 0.7, strings: 0.45, density: 0.6, bright: 3800, center: 7 , gain: 1.1 },
  sunset: { key: 1, bpm: 64, meter: 4, lydian: 0, progs: [3, 7, 4, 2, 9], accomp: ["rolled", "broken"], melodyBox: 0, sparkle: 0.08, pad: 0.8, strings: 0.6, density: 0.5, bright: 3500, center: 7 , gain: 1.1 },
  dusk: { key: 10, bpm: 62, meter: 3, lydian: 0.1, progs: [7, 2, 3, 8, 0], accomp: ["waltz", "rock"], melodyBox: 0.3, sparkle: 0.15, pad: 0.75, strings: 0.35, density: 0.45, bright: 3200, center: 7 , gain: 1 },
  night: { key: 7, bpm: 60, meter: 3, lydian: 0, progs: [0, 7, 2, 9], accomp: ["rock", "waltz"], melodyBox: 0.7, sparkle: 0.2, pad: 0.6, strings: 0.15, density: 0.4, bright: 3000, center: 5 , gain: 0.8 },
};

/** Chords by name: root (semitones above the tonic) and voiced intervals above the root. */
const CHORDS: Record<string, { root: number; tones: number[] }> = {
  I: { root: 0, tones: [0, 4, 7, 14] },
  Imaj7: { root: 0, tones: [0, 4, 7, 11] },
  II: { root: 2, tones: [0, 4, 7, 14] },
  ii: { root: 2, tones: [0, 3, 7, 10] },
  iii: { root: 4, tones: [0, 3, 7, 10] },
  IV: { root: 5, tones: [0, 4, 7, 11] },
  IVadd9: { root: 5, tones: [0, 4, 7, 14] },
  iv: { root: 5, tones: [0, 3, 7, 14] },
  V: { root: 7, tones: [0, 4, 7, 14] },
  Vsus: { root: 7, tones: [0, 5, 7, 14] },
  vi: { root: 9, tones: [0, 3, 7, 14] },
  bVII: { root: 10, tones: [0, 4, 7, 14] },
};

const PROGS: string[][] = [
  ["I", "IVadd9", "vi", "Vsus"], // 0
  ["I", "iii", "IV", "V"], // 1
  ["vi", "IV", "I", "Vsus"], // 2
  ["IV", "V", "iii", "vi"], // 3
  ["IVadd9", "V", "I", "vi"], // 4
  ["I", "II", "IVadd9", "I"], // 5 lydian
  ["Imaj7", "V", "vi", "IV"], // 6
  ["IV", "iv", "I", "Imaj7"], // 7 plagal, borrowed minor iv
  ["vi", "ii", "Vsus", "I"], // 8
  ["I", "bVII", "IV", "I"], // 9
];
const ENDING = ["IV", "Vsus", "I", "I"];

/** Accompaniment figures: [position in eighths, voice index (0 = bass), velocity]. */
const FIGURES: Record<string, [number, number, number][]> = {
  flow: [[0, 0, 1], [1, 2, 0.55], [2, 3, 0.6], [3, 4, 0.55], [4, 3, 0.6], [5, 2, 0.5], [6, 1, 0.5], [7, 2, 0.45]],
  broken: [[0, 0, 1], [2, 2, 0.6], [4, 3, 0.65], [6, 2, 0.5]],
  rolled: [[0, 0, 1], [0.18, 1, 0.55], [0.36, 2, 0.55], [0.54, 3, 0.5], [4, 2, 0.42], [4.2, 3, 0.4]],
  sparse: [[0, 0, 0.9], [4, 2, 0.45]],
  waltz: [[0, 0, 1], [2, 2, 0.5], [2.1, 3, 0.45], [4, 2, 0.45], [4.1, 3, 0.4]],
  rock: [[0, 0, 1], [1, 2, 0.5], [2, 3, 0.55], [3, 4, 0.5], [4, 3, 0.5], [5, 2, 0.45]],
  sparse3: [[0, 0, 0.9], [3, 2, 0.45]],
};

/** Melody rhythm cells (eighths per bar), busiest first; the last three are the calm, long ones. */
const RHYTHM4: number[][] = [[2, 2, 2, 2], [1, 1, 2, 4], [2, 2, 4], [3, 1, 4], [4, 2, 2], [3, 3, 2], [2, 6], [6, 2], [4, 4], [8]];
const RHYTHM3: number[][] = [[2, 2, 2], [1, 1, 4], [3, 1, 2], [2, 4], [4, 2], [3, 3], [6]];
/** Melodic weight of each pitch class above the tonic (pentatonic favoured; 4th and 7th pass through). */
const PC_W = [1, 0.1, 1, 0.1, 1, 0.4, 0.45, 1, 0.1, 0.9, 0.1, 0.35];

const PIANO_SR = 24000;
const L_PIANO = 0.2;
const L_BOX = 0.11;
const L_PAD = 0.018;
const L_BASS = 0.03;
const L_STR = 0.03;
const LEVEL = 0.36;
const MIDI_MAX = 88;

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const pcOf = (m: number) => ((m % 12) + 12) % 12;

interface Note {
  pos: number; // eighths from the phrase start
  dur: number; // eighths
  midi: number; // -1 = rest
  vel: number;
}

type Section = "intro" | "theme" | "vary" | "contrast" | "outro";

interface Piece {
  mood: Mood;
  tonic: number; // midi of the tonic in the melody octave
  lydian: boolean;
  progs: string[][];
  rhythm: number[][]; // one cell per bar (8 bars)
  theme: Note[] | null;
  accomp: string;
  box: boolean;
  sections: Section[];
}

/**
 * Felt piano: a few inharmonic partials with their own two-stage decays, a 9 ms rounded hammer, string
 * pairs a hair apart (gentle beating) and a tiny low body knock.
 */
function renderPiano(midi: number, sr: number, r: Rng): Float32Array {
  const f = mtof(midi);
  const tau1 = clamp(3.2 * Math.sqrt(262 / f), 1.3, 6);
  const len = Math.floor(sr * Math.min(7.5, tau1 * 3.2 + 0.3));
  const d = new Float32Array(len);
  const B = 0.00035;
  const amps = [1, 0.5, 0.3, 0.17, 0.1, 0.06, 0.035, 0.02];
  const att = Math.floor(0.014 * sr);
  for (let k = 1; k <= amps.length; k++) {
    const fk = f * k * Math.sqrt(1 + B * k * k);
    if (fk > 6000) break;
    const a = amps[k - 1] * Math.exp(-fk / 5000);
    const tau = tau1 / (1 + 0.55 * (k - 1));
    const kp = Math.exp(-1 / (tau * 0.16 * sr));
    const ks = Math.exp(-1 / (tau * sr));
    const strings = k <= 3 ? 2 : 1;
    for (let s = 0; s < strings; s++) {
      const det = strings === 2 ? (s === 0 ? 0.9997 : 1.0004) : 1;
      const inc = (fk * det) / sr;
      let ph = r();
      let ep = 0.55 * a / strings;
      let es = 0.45 * a / strings;
      for (let i = 0; i < len; i++) {
        const w = i < att ? 0.5 - 0.5 * Math.cos((Math.PI * i) / att) : 1;
        d[i] += (ep + es) * w * sn(ph);
        ph += inc;
        ep *= kp;
        es *= ks;
      }
    }
  }
  // felt knock: a short low thump under the note
  const fb = Math.min(180, f * 0.5 + 60);
  for (let i = 0; i < Math.min(len, sr * 0.08); i++) {
    const t = i / sr;
    d[i] += 0.05 * Math.min(1, t / 0.006) * Math.exp(-t / 0.018) * Math.sin(TAU * fb * t);
  }
  const fo = Math.floor(sr * 0.3);
  for (let i = 0; i < fo; i++) d[len - 1 - i] *= i / fo;
  return d;
}

/** Music box / celesta: a pure tine with two quiet upper partials, rounded onset, long ring. */
function renderBox(midi: number, sr: number, r: Rng): Float32Array {
  const f = mtof(midi);
  const len = Math.floor(sr * 3.2);
  const d = new Float32Array(len);
  const att = Math.floor(0.016 * sr);
  const parts: [number, number, number][] = [
    [1, 1, 1.5],
    [2.0, 0.14, 0.45],
    [3.0, 0.04, 0.2],
  ];
  for (const [ratio, a, tau] of parts) {
    const fk = f * ratio;
    if (fk > 5500) continue;
    const k = Math.exp(-1 / (tau * sr));
    let e = a;
    let ph = r();
    for (let i = 0; i < len; i++) {
      const w = i < att ? 0.5 - 0.5 * Math.cos((Math.PI * i) / att) : 1;
      d[i] += e * w * sn(ph);
      ph += fk / sr;
      e *= k;
    }
  }
  const fo = Math.floor(sr * 0.3);
  for (let i = 0; i < fo; i++) d[len - 1 - i] *= i / fo;
  return d;
}

export class Music {
  private readonly ctx: BaseAudioContext;
  private readonly r: Rng;
  private readonly fade: GainNode;
  private readonly tone: BiquadFilterNode;
  private readonly melBus: GainNode;
  private readonly loBus: GainNode;
  private readonly hiBus: GainNode;
  private readonly padBus: GainNode;
  private readonly padLP: BiquadFilterNode;
  private readonly strBus: GainNode;
  private readonly strWave: PeriodicWave;
  private readonly strIn: GainNode;
  private readonly piano = new Map<number, AudioBuffer>();
  private readonly box = new Map<number, AudioBuffer>();

  private mood: Mood = MOODS.golden;
  private enabled = true;
  private running = false;
  private piece: Piece | null = null;
  private section = 0;
  private bar = 0;
  private nextBar = 0;
  private melody: Note[] = [];
  private voicing: number[] = [];
  private strLast = 0;
  private themeTimes = 0;
  /** Live one-shot voices (bounded: the oldest is released early if the score gets dense). */
  nodes = 0;

  constructor(
    private readonly kit: Kit,
    dest: AudioNode,
  ) {
    const ctx = (this.ctx = kit.ctx);
    this.r = mulberry32((kit.rng() * 2 ** 31) | 0);
    // instruments → pre → (dry + hall reverb) → tone → fade → dest
    const pre = ctx.createGain();
    this.tone = ctx.createBiquadFilter();
    this.tone.type = "lowpass";
    this.tone.frequency.value = this.mood.bright;
    this.tone.Q.value = 0.5;
    this.fade = ctx.createGain();
    this.fade.gain.value = 0;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 45;
    pre.connect(hp).connect(this.tone);
    const verbIn = ctx.createBiquadFilter();
    verbIn.type = "lowpass";
    verbIn.frequency.value = 3600;
    const conv = ctx.createConvolver();
    conv.normalize = false;
    kit.defer("music-hall", () => (conv.buffer = kit.buffer(reverbIR(ctx.sampleRate, kit.rng, 3.8, 3.2), ctx.sampleRate)));
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.55;
    pre.connect(verbIn).connect(conv).connect(verbOut).connect(this.tone);
    this.tone.connect(this.fade).connect(dest);

    const bus = (pan: number) => {
      const g = ctx.createGain();
      const p = ctx.createStereoPanner();
      p.pan.value = pan;
      g.connect(p).connect(pre);
      return g;
    };
    this.melBus = bus(0.05);
    this.loBus = bus(-0.22);
    this.hiBus = bus(0.18);
    this.padLP = ctx.createBiquadFilter();
    this.padLP.type = "lowpass";
    this.padLP.frequency.value = 1100;
    this.padLP.Q.value = 0.5;
    this.padBus = ctx.createGain();
    this.padBus.connect(this.padLP).connect(pre);
    const strLP = ctx.createBiquadFilter();
    strLP.type = "lowpass";
    strLP.frequency.value = 1500;
    strLP.Q.value = 0.5;
    this.strBus = bus(-0.1);
    const strIn = ctx.createGain();
    strIn.connect(strLP).connect(this.strBus);
    this.strIn = strIn;
    // bowed-string-ish tone: harmonics falling ~1/n², the top already gone
    const N = 10;
    const re = new Float32Array(N + 1);
    const im = new Float32Array(N + 1);
    for (let n = 1; n <= N; n++) im[n] = Math.pow(n, -1.9);
    this.strWave = ctx.createPeriodicWave(re, im);

    // Sample the instruments every minor third and transpose by ≤ ±1.5 semitones; render lazily.
    for (let m = 33; m <= 90; m += 3) kit.defer(`piano${m}`, () => this.piano.set(m, kit.buffer([renderPiano(m, PIANO_SR, this.r)], PIANO_SR)));
    for (let m = 66; m <= 90; m += 3) kit.defer(`box${m}`, () => this.box.set(m, kit.buffer([renderBox(m, PIANO_SR, this.r)], PIANO_SR)));
  }

  /** Begin the score `delay` s from `now`, fading in. */
  start(now: number, delay = 4): void {
    if (this.running) return;
    this.running = true;
    this.piece = null;
    this.nextBar = now + delay;
    if (this.enabled) this.fadeTo(1, now + delay * 0.5, 2.5);
  }

  setEnabled(on: boolean, now: number): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      // resume with a fresh piece after a breath
      this.piece = null;
      this.nextBar = Math.max(this.nextBar, now + 1.5);
      this.fadeTo(1, now, 1.2);
    } else this.fadeTo(0, now, 0.5);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setMood(name: MoodName, now: number): void {
    const m = MOODS[name];
    if (!m || m === this.mood) return;
    this.mood = m;
    this.tone.frequency.setTargetAtTime(m.bright, now, 3);
    if (this.enabled && this.running) this.fadeTo(1, now, 4);
    // if between pieces, the new mood starts with the next one; mid-piece it takes over at the next phrase
  }

  private fadeTo(v: number, when: number, tau: number): void {
    const g = this.fade.gain;
    g.cancelScheduledValues(when);
    g.setTargetAtTime(v * LEVEL * this.mood.gain, when, tau);
  }

  /** Schedule bars ahead of the audio clock. Cheap: a handful of nodes per bar. */
  tick(now: number): void {
    if (!this.running) return;
    if (!this.enabled) {
      // let tails ring out; keep the clock moving so a re-enable starts cleanly
      if (this.nextBar < now) this.nextBar = now;
      return;
    }
    if (this.nextBar < now - 0.5) this.nextBar = now + 0.1; // the context was suspended / we fell behind
    let guard = 0;
    while (this.nextBar < now + 0.8 && guard++ < 4) this.scheduleBar(this.nextBar);
  }

  // ─────────────────────────── composition ───────────────────────────

  private newPiece(): Piece {
    const r = this.r;
    const m = this.mood;
    const pickProg = (avoid: string[] | null) => {
      for (let i = 0; i < 6; i++) {
        const p = PROGS[m.progs[Math.floor(r() * m.progs.length)]];
        if (p !== avoid) return p;
      }
      return PROGS[m.progs[0]];
    };
    const a = pickProg(null);
    const a2 = r() < 0.5 ? a : pickProg(a);
    let b = pickProg(a);
    if (b === a2) b = pickProg(a2);
    const cells = m.meter === 4 ? RHYTHM4 : RHYTHM3;
    // sparser cells for calm moods: the last cells in each list are the long ones
    const cell = () => {
      const busy = r() < m.density;
      const i = busy ? Math.floor(r() * cells.length) : cells.length - 1 - Math.floor(r() * 3);
      return cells[clamp(i, 0, cells.length - 1)];
    };
    const c0 = cell(), c1 = cell(), c2 = cell();
    const endA = m.meter === 4 ? (r() < 0.5 ? [6, -2] : [8]) : r() < 0.5 ? [6] : [4, -2];
    const endB = m.meter === 4 ? [8] : [6];
    const rhythm = [c0, c1, r() < 0.6 ? c0 : c2, endA, c0, c1, c2, endB];
    const sections: Section[] = r() < 0.7 ? ["intro", "theme", "vary", "contrast", "theme", "outro"] : ["intro", "theme", "contrast", "vary", "outro"];
    return {
      mood: m,
      tonic: 60 + (m.key > 7 ? m.key - 12 : m.key),
      lydian: r() < m.lydian,
      progs: [a, a2, b],
      rhythm,
      theme: null,
      accomp: m.accomp[Math.floor(r() * m.accomp.length)],
      box: r() < m.melodyBox,
      sections,
    };
  }

  private progFor(p: Piece, sec: Section): string[] {
    if (sec === "vary") return p.progs[1];
    if (sec === "contrast") return p.progs[2];
    if (sec === "outro") return ENDING;
    return p.progs[0];
  }

  private chordPcs(p: Piece, name: string): number[] {
    const c = CHORDS[name];
    return c.tones.map((t) => pcOf(p.tonic + c.root + t));
  }

  private scalePcs(p: Piece): Set<number> {
    const s = p.lydian ? [0, 2, 4, 6, 7, 9, 11] : [0, 2, 4, 5, 7, 9, 11];
    return new Set(s.map((x) => pcOf(p.tonic + x)));
  }

  /** Fit a melody to `prog` with the piece's rhythm; `guide` pitches (the theme) pull it when given. */
  private makeMelody(p: Piece, prog: string[], guide: Note[] | null, keep: number, lift = 0): Note[] {
    const r = this.r;
    const per = p.mood.meter * 2;
    const scale = this.scalePcs(p);
    const lo = p.tonic + 2 + lift;
    const hi = Math.min(MIDI_MAX - 2, p.tonic + 19 + lift);
    const centre = p.tonic + p.mood.center + lift;
    const notes: Note[] = [];
    let prev = centre;
    let lastLeap = 0;
    let gi = 0;
    for (let bar = 0; bar < 8; bar++) {
      let pos = bar * per;
      const cell = p.rhythm[bar];
      for (let ci = 0; ci < cell.length; ci++) {
        const len = cell[ci];
        if (len < 0) {
          notes.push({ pos, dur: -len, midi: -1, vel: 0 });
          pos += -len;
          gi++;
          continue;
        }
        const g = guide ? guide[gi] : undefined;
        gi++;
        const chord = prog[Math.floor(bar / 2)];
        const cp = this.chordPcs(p, chord);
        const half = bar < 4 ? 0 : 1;
        const inHalf = (pos - half * 4 * per) / (4 * per);
        const lastOfHalf = (bar === 3 || bar === 7) && ci === cell.length - 1 - (cell[cell.length - 1] < 0 ? 1 : 0);
        const strong = pos % (p.mood.meter === 4 ? 4 : 6) === 0 || len >= 3 || lastOfHalf;
        // an arch over each half-phrase; the answering half settles lower toward its cadence
        let target = centre + 7 * Math.sin(Math.PI * inHalf) - (half ? 3 * inHalf : 0) - 2;
        let pull = 0.45;
        if (g && g.midi > 0 && r() < keep) {
          target = g.midi;
          pull = 1.2;
        }
        let allowed: (m: number) => boolean = strong ? (m) => cp.includes(pcOf(m)) : (m) => scale.has(pcOf(m));
        if (lastOfHalf && bar === 3) {
          const want = [pcOf(p.tonic + 2), pcOf(p.tonic + 7), pcOf(p.tonic + 4)];
          const ok = want.filter((x) => cp.includes(x));
          if (ok.length) allowed = (m) => ok.includes(pcOf(m));
        } else if (lastOfHalf && bar === 7) {
          const want = CHORDS[chord].root === 0 ? [pcOf(p.tonic), pcOf(p.tonic + 4)] : cp.slice(0, 3);
          allowed = (m) => want.includes(pcOf(m));
        }
        let best = prev;
        let bestS = -1e9;
        for (let m = lo; m <= hi; m++) {
          if (!allowed(m)) continue;
          const step = Math.abs(m - prev);
          let s = Math.log(PC_W[pcOf(m - p.tonic)] + 0.05);
          s -= step <= 2 ? 0 : step <= 4 ? 0.35 : step <= 7 ? 1.1 : 5;
          if (step === 0) s -= 1.2;
          // after a leap, step back the other way
          if (Math.abs(lastLeap) > 4 && Math.sign(m - prev) === Math.sign(lastLeap)) s -= 1.5;
          s -= Math.abs(m - target) * pull;
          s += r() * 0.9;
          if (s > bestS) {
            bestS = s;
            best = m;
          }
        }
        lastLeap = best - prev;
        prev = best;
        const vel = clamp(0.6 + 0.16 * Math.sin(Math.PI * inHalf) + (strong ? 0.08 : 0) - (lastOfHalf ? 0.06 : 0) + (r() - 0.5) * 0.08, 0.3, 0.95);
        notes.push({ pos, dur: len, midi: best, vel });
        pos += len;
      }
    }
    return notes;
  }

  /** Voice-lead the chord into the accompaniment register: a bass note plus four tones (~D3–C5). */
  private voice(p: Piece, name: string): number[] {
    const c = CHORDS[name];
    const root = p.tonic - 12 + c.root;
    let bass = root;
    while (bass < 36) bass += 12;
    while (bass > 47) bass -= 12;
    const pcs = c.tones.map((t) => pcOf(root + t));
    const prev = this.voicing.length === 5 ? this.voicing.slice(1) : [55, 59, 62, 66];
    let best: number[] = [];
    let bestCost = 1e9;
    for (let inv = 0; inv < pcs.length; inv++) {
      for (const open of [false, true]) {
        const order = [...pcs.slice(inv), ...pcs.slice(0, inv)];
        const tones: number[] = [];
        let m = 50;
        while (pcOf(m) !== order[0]) m++;
        tones.push(m);
        for (let i = 1; i < order.length; i++) {
          let n = tones[i - 1] + 1;
          while (pcOf(n) !== order[i]) n++;
          tones.push(n);
        }
        if (open) tones[1] += 12;
        tones.sort((a, b) => a - b);
        for (const shift of [0, 12]) {
          const t = tones.map((x) => x + shift);
          if (t[0] < 50 || t[t.length - 1] > 74) continue;
          // keep colour tones (7th / 9th) off the bottom of the voicing, and the low end open
          const colourLow = c.tones.findIndex((iv) => pcOf(root + iv) === pcOf(t[0])) === 3 ? 6 : 0;
          let rub = 0;
          for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] === 1) rub += 16;
          const cost = t.reduce((acc, x, i) => acc + Math.abs(x - prev[i]), 0) + (t[1] - t[0] < 3 ? 3 : 0) + colourLow + rub;
          if (cost < bestCost) {
            bestCost = cost;
            best = t;
          }
        }
      }
    }
    this.voicing = [bass, ...best];
    return this.voicing;
  }

  private scheduleBar(t: number): void {
    const r = this.r;
    if (!this.piece) {
      this.piece = this.newPiece();
      this.section = 0;
      this.bar = 0;
    }
    const p = this.piece;
    const m = p.mood;
    const beat = 60 / m.bpm;
    const e8 = beat / 2;
    const barDur = beat * m.meter;
    const sec = p.sections[this.section];
    const prog = this.progFor(p, sec);
    const chordName = prog[Math.floor(this.bar / 2)];
    const firstOfChord = this.bar % 2 === 0;

    if (this.bar === 0) {
      // new phrase: (re)write its melody
      if (sec === "theme") {
        if (!p.theme) {
          p.theme = this.makeMelody(p, prog, null, 0);
          this.themeTimes = 0;
        }
        // the theme returns slightly re-sung
        this.melody = this.themeTimes++ === 0 ? p.theme : this.makeMelody(p, prog, p.theme, 0.85);
      } else if (sec === "vary") this.melody = this.makeMelody(p, prog, p.theme, 0.55);
      else if (sec === "contrast") this.melody = this.makeMelody(p, prog, null, 0, 2);
      else this.melody = [];
    }

    // harmony
    const v = firstOfChord ? this.voice(p, chordName) : this.voicing;
    if (firstOfChord) {
      const padLevel = m.pad * (sec === "intro" && this.bar === 0 ? 0.7 : 1);
      this.padChord(t, barDur * 2, v.slice(1), padLevel);
      if (sec !== "intro" || this.bar >= 2) this.bass(t, barDur * 2, v[0]);
      this.padLP.frequency.setTargetAtTime(lerp(900, 1500, m.pad) * (m.bright / 4000), t, 2);
    }

    // accompaniment figure
    let fig = p.accomp;
    if (sec === "intro" && this.bar < 2) fig = m.meter === 4 ? "sparse" : "sparse3";
    if (sec === "outro" && this.bar >= 4) fig = m.meter === 4 ? "sparse" : "sparse3";
    const lastBar = sec === "outro" && this.bar === 7;
    if (!lastBar) {
      for (const [pos, vi, vel] of FIGURES[fig]) {
        if (pos >= m.meter * 2) continue;
        // second bar of a chord: lighter bass, slight variation of the figure
        let idx = vi;
        let vv = vel;
        if (!firstOfChord && vi === 0) {
          if (r() < 0.5) continue;
          vv *= 0.7;
        }
        if (!firstOfChord && vi > 0 && r() < 0.2) idx = clamp(vi + (r() < 0.5 ? -1 : 1), 1, 4);
        const note = v[Math.min(idx, v.length - 1)];
        const when = t + pos * e8 + (r() - 0.5) * 0.012;
        const hold = vi === 0 ? barDur * 1.5 : e8 * 3;
        this.pianoNote(when, note, 0.42 * vv * (0.92 + 0.16 * r()), hold, note < 60 ? this.loBus : this.hiBus);
      }
    } else {
      // final rolled tonic chord, left ringing
      v.forEach((n, i) => this.pianoNote(t + i * 0.09, n, 0.38, barDur * 2.5, n < 60 ? this.loBus : this.hiBus));
      this.pianoNote(t + 0.5, p.tonic + 12 <= MIDI_MAX ? p.tonic + 12 : p.tonic, 0.32, barDur * 2.5, this.melBus);
    }

    // melody notes of this bar
    const per = m.meter * 2;
    const b0 = this.bar * per;
    const useStrings = sec === "contrast" && m.strings > 0.4 && r() < 0.5;
    for (const n of this.melody) {
      if (n.midi < 0 || n.pos < b0 || n.pos >= b0 + per) continue;
      const when = t + (n.pos - b0) * e8 + (r() - 0.5) * 0.015;
      const dur = n.dur * e8;
      if (useStrings && n.dur >= 2) this.stringNote(when, n.midi - 12, dur * 1.1, 0.9 * n.vel);
      else if (p.box) this.boxNote(when, n.midi, n.vel * 0.9);
      else this.pianoNote(when, n.midi, n.vel * 0.75, dur * 1.3 + 0.3, this.melBus);
      // morning air: the music box sometimes doubles long notes an octave up
      if (!p.box && n.dur >= 3 && r() < m.sparkle && n.midi + 12 <= MIDI_MAX) this.boxNote(when + 0.02, n.midi + 12, n.vel * 0.45);
    }

    // glints and the sustained string line
    if (sec !== "intro" && r() < m.sparkle * 0.6) {
      const pcs = this.chordPcs(p, chordName);
      const pc = pcs[Math.floor(r() * pcs.length)];
      let note = p.tonic + 24;
      while (pcOf(note) !== pc) note--;
      if (note > MIDI_MAX) note -= 12;
      this.boxNote(t + (Math.floor(r() * m.meter) * 2 + 1) * e8, note, 0.35);
    }
    if (sec !== "intro" && !lastBar && r() < m.strings) {
      const pcs = this.chordPcs(p, chordName);
      let best = this.strLast || p.tonic;
      let bd = 1e9;
      for (let n = p.tonic - 5; n <= p.tonic + 7; n++) {
        if (!pcs.includes(pcOf(n))) continue;
        const d = Math.abs(n - (this.strLast || p.tonic + 2)) + (n === this.strLast ? 0.5 : 0);
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
      this.strLast = best;
      this.stringNote(t + 0.05, best, barDur * 0.98, 0.7);
    }

    // advance
    this.nextBar = t + barDur;
    if (++this.bar >= 8) {
      this.bar = 0;
      if (++this.section >= p.sections.length) {
        // a long breath before the next piece (which picks up any new mood)
        this.piece = null;
        this.voicing = [];
        this.nextBar = t + barDur * 2 + 14 + r() * 22;
      } else if (this.mood !== p.mood && p.sections[this.section] !== "outro") {
        // the time of day changed: let this piece close now
        this.section = p.sections.length - 1;
      }
    }
  }

  // ─────────────────────────── instruments ───────────────────────────

  private sample(map: Map<number, AudioBuffer>, midi: number, lo: number): { buf: AudioBuffer; rate: number } | null {
    const base = lo + Math.round((midi - lo) / 3) * 3;
    const buf = map.get(base);
    return buf ? { buf, rate: Math.pow(2, (midi - base) / 12) } : null;
  }

  private pianoNote(when: number, midi: number, vel: number, hold: number, bus: GainNode): void {
    const s = this.sample(this.piano, clamp(midi, 33, 90), 33);
    if (!s) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = s.rate;
    const g = ctx.createGain();
    // softer top for softer touches: quieter notes are also a little lower in level up high
    const lvl = L_PIANO * vel * vel * (midi > 76 ? 0.8 : 1);
    g.gain.setValueAtTime(lvl, when);
    // damper: release after `hold` with a felt-soft fall
    const end = Math.min(when + hold, when + s.buf.duration / s.rate);
    g.gain.setTargetAtTime(0, end, 0.35);
    src.connect(g).connect(bus);
    src.start(when);
    src.stop(Math.min(end + 2, when + s.buf.duration / s.rate));
    this.track(src, g);
  }

  private boxNote(when: number, midi: number, vel: number): void {
    const s = this.sample(this.box, clamp(midi, 66, 90), 66);
    if (!s) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = s.rate;
    const g = ctx.createGain();
    g.gain.value = L_BOX * vel;
    src.connect(g).connect(this.hiBus);
    src.start(when);
    this.track(src, g);
  }

  /** Soft pad: two slightly detuned triangles per tone, slow swell and a long, overlapping release. */
  private padChord(when: number, dur: number, tones: number[], level: number): void {
    if (level <= 0.01) return;
    const ctx = this.ctx;
    const att = Math.min(2.5, dur * 0.35);
    const rel = 2.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(L_PAD * level, when + att);
    g.gain.setTargetAtTime(L_PAD * level * 0.8, when + att, dur * 0.4);
    g.gain.setTargetAtTime(0, when + dur, rel / 3);
    g.connect(this.padBus);
    const oscs: OscillatorNode[] = [];
    for (const m of tones) {
      for (const det of [-5, 4.5]) {
        const o = ctx.createOscillator();
        o.type = "triangle";
        o.frequency.value = mtof(m);
        o.detune.value = det + (this.r() - 0.5) * 2;
        o.connect(g);
        o.start(when);
        o.stop(when + dur + rel * 2);
        oscs.push(o);
      }
    }
    oscs[oscs.length - 1].onended = () => {
      for (const o of oscs) o.disconnect();
      g.disconnect();
    };
    this.nodes += oscs.length + 1;
  }

  private bass(when: number, dur: number, midi: number): void {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(L_BASS, when + 0.12);
    g.gain.setTargetAtTime(L_BASS * 0.45, when + 0.12, 1.2);
    g.gain.setTargetAtTime(0, when + dur * 0.95, 0.5);
    const o1 = ctx.createOscillator();
    o1.frequency.value = mtof(midi);
    const o2 = ctx.createOscillator();
    o2.frequency.value = mtof(midi + 12);
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    o1.connect(g);
    o2.connect(g2).connect(g);
    g.connect(this.loBus);
    for (const o of [o1, o2]) {
      o.start(when);
      o.stop(when + dur + 2.5);
    }
    o2.onended = () => {
      o1.disconnect();
      o2.disconnect();
      g2.disconnect();
      g.disconnect();
    };
    this.nodes += 4;
  }

  /** A sustained, bowed-sounding note with a slow swell and delayed gentle vibrato. */
  private stringNote(when: number, midi: number, dur: number, vel: number): void {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.setPeriodicWave(this.strWave);
    o.frequency.value = mtof(midi);
    const vib = ctx.createOscillator();
    vib.frequency.value = 4.8 + this.r() * 0.6;
    const vd = ctx.createGain();
    vd.gain.setValueAtTime(0, when);
    vd.gain.linearRampToValueAtTime(mtof(midi) * 0.003, when + Math.min(1.2, dur * 0.6));
    vib.connect(vd).connect(o.frequency);
    const g = ctx.createGain();
    const att = Math.min(0.7, dur * 0.4);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(L_STR * vel, when + att);
    g.gain.setTargetAtTime(0, when + dur, 0.45);
    o.connect(g).connect(this.strIn);
    o.start(when);
    vib.start(when);
    o.stop(when + dur + 2.5);
    vib.stop(when + dur + 2.5);
    o.onended = () => {
      o.disconnect();
      vib.disconnect();
      vd.disconnect();
      g.disconnect();
    };
    this.nodes += 4;
  }

  private track(src: AudioBufferSourceNode, g: GainNode): void {
    this.nodes += 2;
    src.onended = () => {
      src.disconnect();
      g.disconnect();
    };
  }
}
