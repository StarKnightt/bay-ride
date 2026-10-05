// Standalone measurement page for the bay audio (not part of the game build): renders scenarios with an
// OfflineAudioContext, driving the engine like a frame loop, and analyses level, spectrum and attacks.
import { SoundEngine, type EngineInput, type GullPlace, type LayerName, type MoodName, type Place } from "./src/sound/engine";
import { STEP_SURFACES, type StepSurface } from "./src/sound/steps";

const SR = 48000;
const QUANTUM_STEP = 128 * 19; // engine tick every ~50 ms of audio, on render-quantum boundaries

interface Scenario {
  name: string;
  secs: number;
  solo: LayerName[] | "music" | null;
  music?: MoodName;
  musicDelay?: number;
  input: (t: number) => Partial<EngineInput>;
  steps?: { every: number; surface: (t: number) => StepSurface; strength?: number; depth?: (t: number) => number };
  events?: [number, "gull" | "slap"][];
  /** Engine calls at scenario times (shore events, placed sounds, landings). */
  calls?: [number, (eng: SoundEngine, when: number) => void][];
  /** Where placed gull calls come from (the game passes its real gulls). */
  gullAt?: (t: number, out: GullPlace) => boolean;
  wav?: boolean;
  seed?: number;
}

const at = (pan: number, dist: number, panTo = NaN, distTo = NaN, back = 0): Place => ({ pan, dist, back, panTo, distTo });

/** The shoreline's events for a run of waves on the main swell (break offshore, run-up ~2.6 s later). */
function shoreRun(t0: number, sizes: number[]): [number, (eng: SoundEngine, when: number) => void][] {
  const out: [number, (eng: SoundEngine, when: number) => void][] = [];
  sizes.forEach((s, i) => {
    const t = t0 + i * 7.4 + (i % 2 ? 0.9 : -0.4);
    out.push([t, (e, w) => e.shoreWave(w, "break", s, i)], [t + 2.6, (e, w) => e.shoreWave(w, "runup", s, i)]);
  });
  return out;
}

/** A boat run: idle, open to full, past full (Shift), back to full, ease off; speed follows the throttle. */
function boatRun(t: number): Partial<EngineInput> {
  const th = t < 2 ? 0 : t < 10 ? (t - 2) / 8 : t < 12 ? 1 : t < 13 ? 1 + 0.35 * (t - 12) : t < 21 ? 1.35 : t < 23 ? 1.35 - 0.35 * ((t - 21) / 2) : Math.max(0, 1 - (t - 23) / 5);
  return { boat: 1, throttle: th, boatSpeed: Math.min(10.1, 8.5 * Math.min(1, th) + 4.5 * Math.max(0, th - 1)), sea: 1, move: 7 * Math.min(1, th) };
}

/** Reverse: ahead at half throttle, brake with the prop reversed, back astern to ~3.8 m/s, idle. */
function reverseRun(t: number): Partial<EngineInput> {
  if (t < 5) return { boat: 1, throttle: 0.6, boatSpeed: 5, sea: 1 };
  if (t < 8) return { boat: 1, throttle: -1, boatSpeed: Math.max(0, 5 - (t - 5) * 1.7), sea: 1 };
  if (t < 18) return { boat: 1, throttle: -1, boatSpeed: Math.min(3.8, (t - 8) * 0.5), sea: 1 };
  return { boat: 1, throttle: 0, boatSpeed: Math.max(0, 3.8 - (t - 18) * 0.8), sea: 1 };
}

/** Placed gulls for the lab: a perched one close by, a flock bird crossing 40→60 m, one far out at 150 m. */
function labGull(t: number, out: GullPlace): boolean {
  const k = Math.floor(t / 4) % 3;
  out.back = 0;
  out.perched = k === 0;
  if (k === 0) Object.assign(out, { pan: 0.4, dist: 9, panTo: NaN, distTo: NaN });
  else if (k === 1) Object.assign(out, { pan: -0.7, dist: 40, panTo: 0.3, distTo: 60 });
  else Object.assign(out, { pan: 0.2, dist: 150, panTo: 0.1, distTo: 160 });
  return true;
}

const SCENARIOS: Scenario[] = [
  { name: "shore-near", secs: 30, solo: ["shore"], input: () => ({ shore: 3, shorePan: -0.6 }) },
  { name: "shore-far", secs: 30, solo: ["shore"], input: () => ({ shore: 60, shorePan: -0.6 }) },
  { name: "pier-lapping", secs: 20, solo: ["lap"], input: () => ({ pier: 1, pierPan: 0.3 }) },
  { name: "boat-idle", secs: 20, solo: ["boat", "lap"], input: () => ({ boat: 1, throttle: 0, boatSpeed: 0, sea: 0.8 }) },
  {
    name: "boat-throttle-ramp",
    secs: 30,
    solo: ["boat", "lap", "wind"],
    input: (t) => {
      const th = t < 3 ? 0 : t < 13 ? (t - 3) / 10 : t < 22 ? 1 : Math.max(0, 1 - (t - 22) / 6);
      return { boat: 1, throttle: th, boatSpeed: 7 * th, sea: 1 };
    },
  },
  { name: "boat-boost", secs: 30, solo: ["boat", "lap", "wind"], input: boatRun, wav: true },
  { name: "boat-reverse", secs: 24, solo: ["boat", "lap"], input: reverseRun, wav: true },
  { name: "wind-fast", secs: 15, solo: ["wind"], input: () => ({ move: 11, speed: 0 }) },
  {
    name: "footsteps",
    secs: 24,
    solo: [],
    input: () => ({}),
    steps: { every: 0.5, surface: (t) => STEP_SURFACES[Math.floor(t / 3) % STEP_SURFACES.length], strength: 1, depth: () => 0.06 },
  },
  { name: "footsteps-wading", secs: 12, solo: [], input: () => ({}), steps: { every: 0.55, surface: () => "water", strength: 0.9, depth: (t) => (t < 6 ? 0.05 : 0.35) }, wav: true },
  {
    // a jump on every surface: push-off, 0.5 s aloft, landing (both feet), then a step away
    name: "jumps",
    secs: 26,
    solo: [],
    input: () => ({}),
    calls: STEP_SURFACES.flatMap((s, i): [number, (eng: SoundEngine, when: number) => void][] => [
      [0.5 + i * 3, (e, w) => e.takeoff(w, s, 0.82, 0.3)],
      [1.0 + i * 3, (e, w) => e.land(w, s, 0.52, 0.3)],
      [1.06 + i * 3, (e, w) => e.footstep(w, s, 0.3 * 0.45, 0.3)],
      [1.6 + i * 3, (e, w) => e.footstep(w, s, 0.8, 0.3)],
    ]),
    wav: true,
  },
  { name: "shore-events", secs: 45, solo: ["shore"], input: () => ({ shore: 4, shorePan: -0.5 }), calls: shoreRun(1, [0.35, 0.8, 1.2, 0.9, 0.5, 0.2]), wav: true },
  { name: "gulls", secs: 22, solo: ["gulls"], input: () => ({ shore: 10, sea: 0.5 }), events: [[0.5, "gull"], [6, "gull"], [12, "gull"], [17, "gull"]] },
  {
    name: "gulls-placed",
    secs: 26,
    solo: ["gulls"],
    input: () => ({ shore: 10, sea: 0.5 }),
    gullAt: labGull,
    events: [[0.5, "gull"], [4.5, "gull"], [8.5, "gull"], [12.5, "gull"], [16.5, "gull"], [20.5, "gull"]],
    calls: [
      [2.5, (e, w) => e.gullTakeoff(w, at(-0.3, 3.6))],
      [14.5, (e, w) => e.gullTakeoff(w, at(0.5, 6))],
    ],
    wav: true,
  },
  {
    name: "fish",
    secs: 20,
    solo: ["fish"],
    input: () => ({ sea: 0.6 }),
    calls: [
      [0.5, (e, w) => e.fishSplash(w, false, at(0.3, 12), 1.3)],
      [1.5, (e, w) => e.fishSplash(w, true, at(0.32, 12.5), 1.3)],
      [5, (e, w) => e.fishSplash(w, false, at(-0.5, 30), 0.9)],
      [5.9, (e, w) => e.fishSplash(w, true, at(-0.48, 30.6), 0.9)],
      [10, (e, w) => e.fishSplash(w, false, at(0.1, 55), 1)],
      [11, (e, w) => e.fishSplash(w, true, at(0.12, 56), 1)],
      // a burst: more cues than voices (only three may sound)
      ...[14, 14.1, 14.2, 14.3, 14.4, 14.5].map((t, i): [number, (eng: SoundEngine, when: number) => void] => [t, (e, w) => e.fishSplash(w, i % 2 === 1, at(-0.6 + 0.24 * i, 14), 1)]),
    ],
    wav: true,
  },
  { name: "night-insects", secs: 30, solo: ["insects"], input: () => ({ night: 1, grass: 1, sea: 0 }), wav: true },
  { name: "night-insects-beach", secs: 12, solo: ["insects"], input: () => ({ night: 1, grass: 0, sea: 0 }) },
  { name: "hull-slaps", secs: 10, solo: ["boat"], input: () => ({ boat: 1, throttle: 0.6, boatSpeed: 5, sea: 1 }), events: [[1, "slap"], [3, "slap"], [5, "slap"], [7, "slap"]] },
  { name: "music-morning", secs: 60, solo: "music", music: "morning", input: () => ({}), seed: 3 },
  { name: "music-golden", secs: 90, solo: "music", music: "golden", input: () => ({}), wav: true, seed: 11 },
  { name: "music-sunset", secs: 60, solo: "music", music: "sunset", input: () => ({}), seed: 5 },
  { name: "music-night", secs: 60, solo: "music", music: "night", input: () => ({ night: 1 }), wav: true, seed: 7 },
  {
    name: "mix-beach-walk-golden",
    secs: 60,
    solo: null,
    music: "golden",
    musicDelay: 3,
    input: () => ({ shore: 7, shorePan: -0.5, evening: 0.8 }),
    steps: { every: 0.55, surface: (t) => (t % 20 < 12 ? "sand" : "wetsand"), strength: 0.8 },
    events: [[9, "gull"]],
    wav: true,
    seed: 21,
  },
  {
    name: "ambience-beach-golden",
    secs: 60,
    solo: null,
    input: () => ({ shore: 7, shorePan: -0.5, evening: 0.8 }),
    steps: { every: 0.55, surface: (t) => (t % 20 < 12 ? "sand" : "wetsand"), strength: 0.8 },
    events: [[9, "gull"]],
    seed: 21,
  },
  {
    name: "mix-boat-noon",
    secs: 40,
    solo: null,
    music: "noon",
    musicDelay: 2,
    input: (t) => ({ ...boatRun(t % 30), shore: 120, shorePan: 0.6, evening: 0 }),
    events: [[9, "slap"], [15, "slap"], [16.2, "slap"], [24, "slap"]],
  },
  {
    // the beach at night: waves from the shoreline's events, a fish, faint insects up the verge behind
    name: "mix-night-shore",
    secs: 45,
    solo: null,
    music: "night",
    musicDelay: 2,
    input: () => ({ shore: 9, shorePan: -0.6, night: 1, evening: 1, grass: 0.35 }),
    steps: { every: 0.6, surface: (t) => (t % 20 < 10 ? "sand" : "wetsand"), strength: 0.7 },
    calls: [...shoreRun(1, [0.5, 0.9, 0.7, 0.4, 1, 0.6]), [17, (e, w) => e.fishSplash(w, false, at(-0.4, 25), 1)], [17.9, (e, w) => e.fishSplash(w, true, at(-0.38, 25.6), 1)]],
    wav: true,
    seed: 9,
  },
];

interface Metrics {
  name: string;
  secs: number;
  peakDb: number;
  rmsDb: number;
  maxShortRmsDb: number;
  crestDb: number;
  dc: number;
  clipped: number;
  nans: number;
  above6kDb: number;
  above8kDb: number;
  centroidHz: number;
  onsets: number;
  attackMinMs: number;
  attackMedMs: number;
  maxRiseDb5ms: number;
  bandsDb: string;
  band8kAbsDb: number;
  genMs: number;
  renderMs: number;
  realtimeX: number;
  nodes: number;
}

const db = (x: number) => (x > 1e-9 ? Math.round(200 * Math.log10(x)) / 10 : -999);

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

function analyse(name: string, L: Float32Array, R: Float32Array, sr: number): Omit<Metrics, "genMs" | "renderMs" | "realtimeX" | "nodes" | "secs"> {
  const n = L.length;
  let peak = 0, sum = 0, dcL = 0, dcR = 0, clipped = 0, nans = 0;
  for (let i = 0; i < n; i++) {
    const a = L[i], b = R[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      nans++;
      continue;
    }
    peak = Math.max(peak, Math.abs(a), Math.abs(b));
    sum += a * a + b * b;
    dcL += a;
    dcR += b;
    if (Math.abs(a) >= 0.99 || Math.abs(b) >= 0.99) clipped++;
  }
  const rms = Math.sqrt(sum / (2 * n));
  // short-term RMS (400 ms)
  const W = Math.floor(sr * 0.4);
  let maxShort = 0;
  for (let i = 0; i + W <= n; i += W / 2) {
    let s = 0;
    for (let j = i; j < i + W; j++) s += L[j] * L[j] + R[j] * R[j];
    maxShort = Math.max(maxShort, Math.sqrt(s / (2 * W)));
  }
  // spectrum: averaged Hann-windowed FFTs of the mid signal
  const N = 4096;
  const re = new Float64Array(N), im = new Float64Array(N);
  const pow = new Float64Array(N / 2);
  for (let i = 0; i + N <= n; i += N) {
    for (let k = 0; k < N; k++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1));
      re[k] = 0.5 * (L[i + k] + R[i + k]) * w;
      im[k] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
  }
  let tot = 0, a6 = 0, a8 = 0, cen = 0;
  const edges = [150, 500, 2000, 6000, 1e9];
  const bands = [0, 0, 0, 0, 0];
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    tot += pow[k];
    bands[edges.findIndex((e) => f < e)] += pow[k];
    cen += pow[k] * f;
    if (f >= 6000) a6 += pow[k];
    if (f >= 8000) a8 += pow[k];
  }
  // onsets & attack times on a 5 ms RMS envelope (1 ms hop)
  const F = Math.floor(sr * 0.005), H = Math.floor(sr * 0.001);
  const env: number[] = [];
  for (let i = 0; i + F <= n; i += H) {
    let s = 0;
    for (let j = i; j < i + F; j += 2) s += L[j] * L[j] + R[j] * R[j];
    env.push(Math.sqrt(s / F));
  }
  const attacks: number[] = [];
  let lastOn = -1e9;
  let maxRise = 0;
  for (let i = 300; i < env.length - 20; i++) {
    if (env[i] > rms * 0.5 && env[i - 5] > 0) maxRise = Math.max(maxRise, 20 * Math.log10(env[i] / env[i - 5]));
    let isMax = true;
    for (let j = i - 20; j <= i + 20 && isMax; j++) if (env[j] > env[i]) isMax = false;
    if (!isMax || i - lastOn < 60) continue;
    let floor = 0;
    for (let j = i - 300; j < i - 20; j++) floor += env[j];
    floor /= 280;
    // a real event: ≥ 9 dB over the preceding 300 ms, and audible relative to the whole render
    if (env[i] < floor * 2.8 || env[i] < rms * 0.3) continue;
    lastOn = i;
    const lo = floor + 0.1 * (env[i] - floor), hi = floor + 0.9 * (env[i] - floor);
    let t10 = i, t90 = i;
    for (let j = i; j > i - 300 && env[j] > lo; j--) t10 = j;
    for (let j = t10; j <= i; j++) if (env[j] >= hi) ((t90 = j), (j = i + 1));
    attacks.push(Math.max(1, t90 - t10));
  }
  attacks.sort((a, b) => a - b);
  return {
    name,
    peakDb: db(peak),
    rmsDb: db(rms),
    maxShortRmsDb: db(maxShort),
    crestDb: Math.round((db(peak) - db(rms)) * 10) / 10,
    dc: Math.round(1e6 * Math.max(Math.abs(dcL / n), Math.abs(dcR / n))) / 1e6,
    clipped,
    nans,
    above6kDb: Math.round(100 * Math.log10(a6 / tot)) / 10,
    above8kDb: Math.round(100 * Math.log10(a8 / tot)) / 10,
    centroidHz: Math.round(cen / tot),
    onsets: attacks.length,
    attackMinMs: attacks.length ? attacks[0] : -1,
    attackMedMs: attacks.length ? attacks[Math.floor(attacks.length / 2)] : -1,
    maxRiseDb5ms: Math.round(maxRise * 10) / 10,
    bandsDb: bands.map((b) => Math.round(100 * Math.log10(b / tot)) / 10).join("/"),
    band8kAbsDb: Math.round(10 * (db(rms) + 10 * Math.log10(a8 / tot))) / 10,
  };
}

function wav16(L: Float32Array, R: Float32Array, sr: number): string {
  const n = L.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 4, true);
  w(8, "WAVE");
  w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
  }
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(sc: Scenario): Promise<{ m: Metrics; wav?: string }> {
  const ctx = new OfflineAudioContext(2, SR * sc.secs, SR);
  const g0 = performance.now();
  const eng = new SoundEngine(ctx, ctx.destination, { seed: sc.seed ?? 7, music: !!sc.music });
  const genMs = performance.now() - g0;
  eng.solo(sc.solo);
  eng.setVolume(0.8, 0, 0.01);
  if (sc.music) {
    eng.setMood(sc.music, 0);
    eng.startMusic(0, sc.musicDelay ?? 0.5);
  }
  const dt = QUANTUM_STEP / SR;
  const ev = [...(sc.events ?? [])];
  const calls = [...(sc.calls ?? [])].sort((a, b) => a[0] - b[0]);
  const gullAt = sc.gullAt;
  if (gullAt) eng.gullPlacer = (_dur, out) => gullAt(ctx.currentTime, out);
  let nextStep = 0.3;
  const tick = () => {
    const t = ctx.currentTime;
    const inp: EngineInput = { speed: 0, ...sc.input(t) };
    eng.tick(t, dt, inp);
    while (ev.length && ev[0][0] <= t) eng.trigger(ev.shift()![1], t + 0.02);
    while (calls.length && calls[0][0] <= t + dt) {
      const [when, fn] = calls.shift()!;
      fn(eng, Math.max(t + 0.02, when + 0.02));
    }
    if (sc.steps) while (nextStep <= t + dt) {
      eng.footstep(nextStep + 0.02, sc.steps.surface(nextStep), sc.steps.strength ?? 0.8, sc.steps.depth?.(nextStep) ?? 0);
      nextStep += sc.steps.every * (0.95 + 0.1 * Math.random());
    }
  };
  tick();
  for (let k = 1; k * dt < sc.secs - 0.01; k++)
    void ctx.suspend((k * QUANTUM_STEP) / SR).then(() => {
      tick();
      void ctx.resume();
    });
  const r0 = performance.now();
  const buf = await ctx.startRendering();
  const renderMs = performance.now() - r0;
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const a = analyse(sc.name, L, R, SR);
  const m: Metrics = { ...a, secs: sc.secs, genMs: Math.round(genMs), renderMs: Math.round(renderMs), realtimeX: Math.round((sc.secs * 1000) / renderMs), nodes: eng.kit.nodes + (eng.music?.nodes ?? 0) };
  return { m, wav: sc.wav ? wav16(L, R, SR) : undefined };
}

/** Every pre-rendered one-shot voice measured on its own: attack (10→90 % of peak, 0.5 ms peak envelope) and top. */
function voices(): Record<string, unknown>[] {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const eng = new SoundEngine(ctx, ctx.destination, { seed: 5 });
  const out: Record<string, unknown>[] = [];
  const names = ["hull", "plop", "gull", "flutter", "fish-out", "fish-in", "crickets", "land", "step-wade", ...STEP_SURFACES.map((s) => `step-${s}`)];
  const measure = (name: string, bufs: AudioBuffer[]) => {
    let worst = 1e9, above = -999;
    for (const b of bufs) {
      const d = b.getChannelData(0);
      const sr = b.sampleRate;
      const H = Math.max(1, Math.floor(sr * 0.0005));
      let peak = 0;
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
      let t10 = -1, t90 = -1;
      for (let i = 0; i < d.length; i += H) {
        let m = 0;
        for (let j = i; j < Math.min(d.length, i + H); j++) m = Math.max(m, Math.abs(d[j]));
        if (t10 < 0 && m >= 0.1 * peak) t10 = i;
        if (t90 < 0 && m >= 0.9 * peak) {
          t90 = i;
          break;
        }
      }
      worst = Math.min(worst, ((t90 - t10) / sr) * 1000);
      // energy above 6 kHz (whole buffer)
      const N = 2048;
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let k = 0; k < Math.min(N, d.length); k++) re[k] = d[k] * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1)));
      fft(re, im);
      let tot = 0, hi = 0;
      for (let k = 1; k < N / 2; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        tot += p;
        if ((k * sr) / N >= 6000) hi += p;
      }
      above = Math.max(above, Math.round(100 * Math.log10(hi / tot + 1e-12)) / 10);
    }
    out.push({ name, count: bufs.length, attackMinMs: Math.round(worst * 10) / 10, worstAbove6kDb: above });
  };
  for (const n of names) measure(n, eng.kit.get(n));
  const mus = eng.music as unknown as { piano: Map<number, AudioBuffer>; box: Map<number, AudioBuffer> };
  measure("piano", [...mus.piano.values()]);
  measure("musicbox", [...mus.box.values()]);
  const tm = Object.entries(eng.kit.timings).sort((a, b) => b[1] - a[1]);
  out.push({ name: "gen-ms(top)", count: tm.length, attackMinMs: tm.slice(0, 8).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(" "), worstAbove6kDb: Math.round(tm.reduce((a, [, v]) => a + v, 0)) });
  return out;
}

/** Text dump of a generated piece (chords + melody) to sanity-check the composition by eye. */
function dumpScore(mood: MoodName, seed: number): string {
  const ctx = new OfflineAudioContext(2, SR, SR);
  const eng = new SoundEngine(ctx, ctx.destination, { seed, music: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = eng.music as any;
  m.setMood(mood, 0);
  const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const nm = (x: number) => (x < 0 ? "-" : NAMES[x % 12] + (Math.floor(x / 12) - 1));
  const p = m.newPiece();
  const lines = [`${mood} tonic ${nm(p.tonic)} lydian ${p.lydian} accomp ${p.accomp} box ${p.box} sections ${p.sections.join(",")}`];
  m.piece = p;
  for (const sec of p.sections) {
    const prog = m.progFor(p, sec);
    let mel: { pos: number; dur: number; midi: number }[] = [];
    if (sec === "theme") mel = p.theme ??= m.makeMelody(p, prog, null, 0);
    else if (sec === "vary") mel = m.makeMelody(p, prog, p.theme, 0.55);
    else if (sec === "contrast") mel = m.makeMelody(p, prog, null, 0, 2);
    const voices = prog.map((c: string) => m.voice(p, c).map(nm).join(" "));
    lines.push(`  ${sec}: ${prog.join(" ")} | ${voices.join(" ; ")}`);
    if (mel.length) lines.push("    " + mel.map((n) => `${nm(n.midi)}:${n.dur}`).join(" "));
  }
  return lines.join("\n");
}
(window as unknown as { dumpScore: typeof dumpScore }).dumpScore = dumpScore;

declare global {
  interface Window {
    runLab: (only?: string[]) => Promise<{ metrics: Metrics[]; wavs: Record<string, string>; voices: Record<string, unknown>[] }>;
  }
}

window.runLab = async (only) => {
  const metrics: Metrics[] = [];
  const wavs: Record<string, string> = {};
  for (const sc of SCENARIOS) {
    if (only && only.length && !only.includes(sc.name)) continue;
    const { m, wav } = await render(sc);
    metrics.push(m);
    if (wav) wavs[sc.name] = wav;
    document.body.textContent = `done ${metrics.length}: ${sc.name}`;
  }
  return { metrics, wavs, voices: voices() };
};
document.body.textContent = "ready";
