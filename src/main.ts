import * as THREE from "three";
import { G, specializeUber } from "./render/materials";
import { Post } from "./render/post";
import { CharShadow, LAYER_CHAR, LAYER_CHAR_HAT, LAYER_REFLECT, PlanarReflection, SunShadow, onLayers } from "./render/lightpasses";
import { precompile, warmDraws } from "./render/precompile";
import { restoreMaterials, useTwins } from "./render/mrtSplit";
import { leafAtlas } from "./render/leafAtlas";
import { FrameTimer, Profiler } from "./render/profiler";
import { Bay } from "./world/bay";
import { MooringLines } from "./world/bay/pier";
import { SEA_Y, roadX } from "./world/bay/road";
import { Sky } from "./world/sky";
import { PRESETS, TimeOfDay, parsePreset, type Preset } from "./world/timeofday";
import { bakeDepth } from "./water/depthMap";
import { buildSea, followSea } from "./water/sea";
import { fallbackSeaMaterial } from "./water/fallback";
import { Buoys } from "./water/buoys";
import { seaHeight, seaNormal, waterSample, type WaterSample } from "./water/query";
import { ShoreEvents, waterAt, waveEta, type WaterAt } from "./water/waves";
import { terrainH, waterlineU } from "./world/bay/terrain";
import { Rider, gaitCycle, hatShadowMaterial } from "./rider/rider";
import { ChaseCam, type CamMode, type CamTarget } from "./rider/camera";
import { Boat } from "./boat/boat";
import { Spray } from "./boat/spray";
import { BERTH, SPAWN } from "./boat/berth";
import { STEM_Z, TRANSOM_Z } from "./boat/model";
import { Explore } from "./rider/onfoot";
import { Places } from "./rider/places";
import { Input } from "./core/input";
import { RideAudio } from "./audio";
import { coastCues } from "./sound/listener";
import { Loader, fatal } from "./loader";
import { Hud } from "./ui/hud";
import { captureParams, poseCamera } from "./capture/shots";
import { CharDirector, charMode } from "./capture/charcam";
import { Trail } from "./rider/prints";
import { Hints, type HintState } from "./ui/hints";
import type { LifeTime } from "./life";
import { PLATFORM, TIER, goFullscreen, isPortrait, onFirstTap, onTouch, probeGpu, touchLoaderText, watchViewport } from "./platform";
import { PortraitPrompt, TouchControls, safeAreas } from "./ui/touch";
import { gpuMemory, programLimits } from "./capture/gpucheck";

const params = new URLSearchParams(location.search);
const CAP = captureParams(params);
const SHOT = CAP.shot;
/** ?autoplay=1: she walks off along the pier by herself (frame-rate sampling). */
const AUTOPLAY = params.has("autoplay") && params.get("autoplay") !== "0";
/** Character capture views (?cam=portrait|turn|walk|boatseat, ?pose=wade; see SHOTS.md). */
const CHAR = SHOT ? null : charMode(params);
/** ?boat=1: she is seated in the skiff running the scripted capture course (a function of t). */
const BOAT_RUN = params.get("boat") === "1" || CHAR === "boatseat";
/** A frozen-time boat capture from the ride camera (no fixed shot). */
const BOATCAP = BOAT_RUN && !SHOT && CAP.time !== null;
/** Go straight in once built (no click to start): captures and autoplay. */
const SKIP_INTRO = !!SHOT || !!CHAR || (params.has("skipintro") && params.get("skipintro") !== "0");
/** A frozen-time capture of the opening view (play as it starts, no fixed shot, no boat course). */
const OPENCAP = !SHOT && !BOAT_RUN && SKIP_INTRO && !AUTOPLAY && CAP.time !== null;
const CHARCAP = !!CHAR && CAP.time !== null;
const FROZEN = !!SHOT || BOATCAP || OPENCAP || CHARCAP;
/**
 * First-time guidance (ui/hints.ts) only for a real interactive start: never under a capture hook,
 * a fixed time, autoplay, the boat course or an automated browser (?hints=1 forces it for checks).
 */
const HINTS = params.get("hints") === "1" ||
  (!SKIP_INTRO && !AUTOPLAY && !BOAT_RUN && CAP.time === null && !navigator.webdriver && !params.has("cam") && !params.has("shot"));
let hints: Hints | null = null;
let hintAcc = 0;
/** Touch controls (ui/touch.ts) for interactive play only, never under a capture hook or the boat course. */
const TOUCH_OK = !SHOT && !CHAR && !BOAT_RUN && !AUTOPLAY;
let touch: TouchControls | null = null;
let hintsTouch = false;
const W_BOOT = 0.04, W_BUILD = 0.2, W_COMPILE = 0.2, W_DRAW = 0.5, W_WARM = 0.06;

if (!document.createElement("canvas").getContext("webgl2")) {
  fatal("This browser can't draw the bay", "Bay Ride needs WebGL 2. Try an up-to-date Chrome, Edge, Firefox or Safari, and check that hardware acceleration is turned on.");
  throw new Error("WebGL2 unavailable");
}
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", stencil: false, preserveDrawingBuffer: !!SHOT });
} catch (e) {
  fatal("The graphics couldn't start", "Your browser refused to create a WebGL 2 context. Closing other 3D tabs or restarting the browser usually helps.");
  throw e;
}
renderer.domElement.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  fatal("The graphics took a break", "The GPU reset or the browser reclaimed the 3D context. Reload to keep going.");
});
renderer.domElement.addEventListener("webglcontextrestored", () => location.reload());
if (params.has("gpu")) {
  const gl = renderer.getContext();
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  console.info("[gpu]", dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown");
}
/** Half-float colour targets where the GPU renders to them, 8 bits where it can't; MSAA as each format allows. */
const caps = probeGpu(renderer.getContext() as WebGL2RenderingContext);
const COLOR_TYPE = caps.halfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType;
const maxSamples = caps.halfFloat ? caps.samplesHalf : caps.samples8;
const samples = (want: number) => (maxSamples > 0 ? Math.min(want, maxSamples) : want);
renderer.setPixelRatio(Math.min(devicePixelRatio, TIER.dpr));
renderer.setSize(innerWidth, innerHeight);
renderer.autoClear = true;
renderer.info.autoReset = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
G.uLeafTex.value = leafAtlas(renderer);
{
  // No shop signs in this world yet: a blank 1x1 stands in for the sign atlas.
  const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.needsUpdate = true;
  G.uSignTex.value = t;
}

const loader = new Loader(SKIP_INTRO);
loader.advance(W_BOOT);
if (PLATFORM.touch) touchLoaderText();
const portrait = PLATFORM.phone ? new PortraitPrompt() : null;
const bootLog: [string, number][] = [];
const bootT0 = performance.now();
const yieldToPaint = () =>
  new Promise<void>((res) => {
    const to = setTimeout(res, 120); // hidden tabs never fire rAF
    requestAnimationFrame(() => setTimeout(() => (clearTimeout(to), res()), 0));
  });
async function step<T>(label: string, weight: number, fn: () => T): Promise<T> {
  const s = performance.now();
  const out = fn();
  bootLog.push([label, Math.round(performance.now() - s)]);
  loader.advance(weight);
  await yieldToPaint();
  return out;
}
await yieldToPaint();

// The sea's program takes by far the longest to compile (tens of seconds on D3D): start it, and its
// normal-pass twin, before anything else is built. Nothing it compiles against is baked yet.
const sea = buildSea();
if (params.has("seafail")) for (const m of sea.children as THREE.Mesh[]) (m.material as THREE.ShaderMaterial).fragmentShader += "\n#error forced sea failure (?seafail)\n";
{
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: COLOR_TYPE });
  const cam = new THREE.PerspectiveCamera();
  renderer.setRenderTarget(rt);
  renderer.compile(sea, cam);
  if (!TIER.singlePass) {
    useTwins(sea);
    renderer.compile(sea, cam);
    restoreMaterials();
  }
  renderer.setRenderTarget(null);
  rt.dispose();
}
await yieldToPaint();

const scene = new THREE.Scene();
const bay = await Bay.build(yieldToPaint, (label, ms) => {
  bootLog.push([label, Math.round(ms)]);
  loader.advance((W_BUILD * 0.5) / 12);
});
scene.add(bay.root);
{
  const s = performance.now();
  await bakeDepth(yieldToPaint);
  bootLog.push(["the sea", Math.round(performance.now() - s)]);
  loader.advance(W_BUILD * 0.15);
}
scene.add(sea);
const buoys = new Buoys();
bay.root.add(buoys.group);
// After the scenery on purpose: opaque draws sort by material id, and the dome should draw last
// so early-z rejects most of its pixels.
const sky = await step("the sky", W_BUILD * 0.25, () => new Sky());
scene.add(sky.group, sky.far, sky.motes);
const rider = await step("the rider", W_BUILD * 0.1, () => Rider.load());
// She casts into her own tight shadow map (CharShadow), not the bay's.
onLayers(rider.walker, LAYER_CHAR, LAYER_REFLECT);
rider.walker.traverse((o) => {
  if (o.userData.noCast) o.layers.disable(LAYER_CHAR);
  if (o.userData.shadowProxy) o.layers.set(LAYER_CHAR_HAT);
  // Integer skin indices read as floats make ANGLE rebuild the vertex shader at the first draw.
  const g = (o as THREE.Mesh).geometry;
  const si = g?.attributes.skinIndex as THREE.BufferAttribute | undefined;
  if (si && !(si.array instanceof Float32Array) && !si.normalized) g.setAttribute("skinIndex", new THREE.BufferAttribute(Float32Array.from(si.array), si.itemSize));
});
scene.add(rider.walker);
const boat = new Boat(bay);
scene.add(boat.root);
const moor = new MooringLines();
scene.add(moor.group);
const _bow = new THREE.Vector3(), _stern = new THREE.Vector3();
/** Mooring lines to the stem ring and the pier-side quarter, while she lies at her berth. */
function updateMooring(): void {
  boat.model.root.updateMatrixWorld(true);
  const m = boat.model.root.matrixWorld;
  _bow.set(0, 0.84, STEM_Z + 0.12).applyMatrix4(m);
  _stern.set(-0.6, 0.52, TRANSOM_Z - 0.2).applyMatrix4(m);
  moor.update(_bow, _stern, boat.mode === "idle" && Math.hypot(boat.x - BERTH.x, boat.z - BERTH.z) < 2.5);
}
const spray = new Spray(boat);
scene.add(spray.mesh);
// Footprints in the sand and rings where she wades: in the scene before the shaders compile.
const _ws: WaterSample = { y: NaN, normal: new THREE.Vector3(), depth: 0, wet: 0 };
const trail = new Trail((x, z, at) => waterSample(x, z, at ?? t, terrainH(x, z), _ws));
scene.add(trail.group);
if (BOAT_RUN) boat.mode = "scripted";
boat.update(0, CAP.time ?? 0, null);
if (!params.has("nospec")) for (const o of [bay.root, rider.walker, boat.root, moor.group]) specializeUber(o);

const shadow = new SunShadow(TIER.shadow, 55);
const charShadow = new CharShadow(shadow.mat, TIER.charShadow);
charShadow.hatMat = hatShadowMaterial;
const _charC = new THREE.Vector3();
const REFL = TIER.refl[0];
const reflection = new PlanarReflection(Math.floor(innerWidth * REFL), Math.floor(innerHeight * REFL), samples(TIER.refl[2]), COLOR_TYPE);
const chase = new ChaseCam(innerWidth / innerHeight);
const camParam = params.get("cam");
if (camParam === "fpp") chase.fpp = 1;
else if (camParam === "boat") chase.mode = "chase";
else if (camParam && !CHAR) chase.mode = camParam as CamMode;
const post = new Post(renderer, innerWidth, innerHeight, {
  kuwahara: params.get("kuwahara") !== "0" && TIER.paint > 0,
  msaa: samples(Number(params.get("msaa") ?? TIER.msaa)),
  res: TIER.res,
  budget: TIER.budget,
  bloom: TIER.bloom,
  colorType: COLOR_TYPE,
});
if (TIER.singlePass) post.singlePass = true;
if (post.paint && !params.has("paint")) post.paint.strength = TIER.paint;
const prof = new Profiler(renderer, params.has("prof"), params.get("prof") === "fill");
post.prof = prof;

// Time of day: ?tod=morning|noon|golden|sunset|dusk|night (also ?time=); T cycles it.
const startPreset: Preset = parsePreset(params.get("tod") ?? params.get("time")) ?? "golden";
const tod = new TimeOfDay(post, shadow, startPreset, params.get("timelapse") === "1");
new Hud(tod, !SHOT && CAP.hud);

if (SHOT) {
  poseCamera(chase.cam, SHOT);
  rider.walker.visible = false;
}

{
  const s = performance.now();
  let done = 0;
  const parts = [sea, ...bay.root.children, sky.far, sky.group, sky.motes, rider.walker, boat.root, spray.mesh, moor.group, trail.group];
  const passes = [shadow, charShadow, ...charShadow.hatPass];
  await precompile(renderer, scene, chase.cam, post, passes, parts, (f) => {
    loader.advance((f - done) * W_COMPILE);
    done = f;
  }, yieldToPaint, (label, ms) => bootLog.push([label, Math.round(ms)]));
  bootLog.push(["compile", Math.round(performance.now() - s)]);
  let tp = performance.now();
  await warmDraws(renderer, scene, chase.cam, post, passes, parts, reflection.rt, (i) => {
    const n = performance.now();
    bootLog.push([`draw${i}`, Math.round(n - tp)]);
    tp = n;
    loader.advance(W_DRAW / parts.length);
  }, yieldToPaint);
  // A sea program this GPU couldn't build (a phone's compiler or limits) draws nothing, which reads
  // as a black bay: plain painted water instead (water/fallback.ts). ?seafail forces it.
  const seaMeshes = sea.children as THREE.Mesh[];
  const broken = (m: THREE.Material) =>
    (renderer.properties.get(m) as { currentProgram?: { diagnostics?: { runnable: boolean } } }).currentProgram?.diagnostics?.runnable === false;
  if (seaMeshes.some((m) => broken(m.material as THREE.Material))) {
    console.warn("[sea] the sea's shader failed on this GPU: plain painted water instead");
    for (const m of seaMeshes) m.material = fallbackSeaMaterial(m.material as THREE.ShaderMaterial);
    renderer.setRenderTarget(post.mrt);
    renderer.compile(sea, chase.cam, scene);
    if (!TIER.singlePass) {
      useTwins(sea);
      renderer.compile(sea, chase.cam, scene);
      restoreMaterials();
    }
    renderer.setRenderTarget(null);
  }
}

const audio = new RideAudio();
// Phones only allow sound (and fullscreen) inside a tap's activation, which a touch's pointerdown isn't.
if (PLATFORM.touch || navigator.maxTouchPoints > 0)
  onFirstTap(() => {
    if (PLATFORM.phone) goFullscreen();
    return audio.unlock();
  });
const input = new Input(
  () => audio.start(),
  () => {
    if (!explore.onFoot) chase.toggle();
  },
);
// M = music on/off, Shift+M = mute all (each also counts as the first gesture that starts audio).
audio.bindKeys();
// F = into the boat at the pier / back onto the deck; C = boat cameras.
const explore = new Explore(bay, rider, chase, audio, renderer.domElement);
chase.clear = explore;
chase.mouseLook = !AUTOPLAY && !SHOT && !BOAT_RUN;
explore.lockAboard = !AUTOPLAY && !SHOT && !BOAT_RUN;
explore.boat = boat;
new Places(explore, tod, renderer.domElement);
// The opening: standing near the pier end, the skiff tied up beside her, looking out to sea.
{
  // Test hooks: ?spawn=x,z,yaw and ?orbit=rel,pitch,dist override the opening.
  const num = (k: string) => (params.get(k) ?? "").split(",").filter((v) => v.trim() !== "").map(Number).filter(Number.isFinite);
  const [sx = SPAWN.x, sz = SPAWN.z, sy = SPAWN.yaw] = num("spawn");
  const [or = SPAWN.orbit[0], op = SPAWN.orbit[1], od = SPAWN.orbit[2]] = num("orbit");
  explore.spawn(sx, sz, sy, or, op, od);
}
if (AUTOPLAY) explore.autoWalk = { dx: 1, dz: 0, run: false };
// Her feet plant on the real ground.
rider.ground = (x, z, y) => bay.groundAt(x, z, y);
rider.onPlant = (x, y, z, yaw, side, kind, time) => {
  trail.plant(x, y, z, yaw, side, kind, time);
  explore.footfall();
};
rider.onSettle = () => trail.clear();
const director = CHAR ? new CharDirector(CHAR, params, explore, rider, boat) : null;
if (director?.drives) explore.lookAround = false;
const _feet = [new THREE.Vector3(), new THREE.Vector3()];
let trailResolved = false;
boat.onSlap = (s) => audio.boatSlap(s * 0.8);
if (BOAT_RUN) {
  explore.seatInBoat();
  explore.lookAround = false;
  rider.walker.visible = true;
}
const boatCam: CamTarget = { x: 0, z: 0, yaw: 0, speed: 0, lean: 0, boat: { y: 0, roll: 0 } };
const canvasEl = renderer.domElement;
const lockPointer = () => {
  try {
    const p = canvasEl.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch?.(() => {});
  } catch {
    /* not allowed here */
  }
};
canvasEl.addEventListener("click", () => {
  if (started && !waiting && !AUTOPLAY && !SHOT && document.pointerLockElement !== canvasEl) lockPointer();
});
addEventListener("pointermove", (e) => {
  if (document.pointerLockElement === canvasEl && !explore.onFoot) chase.lookBy(e.movementX, e.movementY);
});

/** The renderer, the post chain, the mirror and the camera's aspect, always changed together. */
function resize(w = innerWidth, h = innerHeight): void {
  renderer.setSize(w, h);
  chase.cam.aspect = w / h;
  chase.cam.updateProjectionMatrix();
  post.setSize(w, h);
  reflection.setSize(Math.floor(w * REFL), Math.floor(h * REFL));
}
// On a phone a rotation, the URL bar or fullscreen settle first (platform.ts); held upright the
// game waits behind the landscape prompt at its landscape size.
let sizedW = innerWidth, sizedH = innerHeight;
if (PLATFORM.phone)
  watchViewport((w, h) => {
    if (isPortrait() || (w === sizedW && h === sizedH)) return;
    sizedW = w;
    sizedH = h;
    resize(w, h);
  });
else addEventListener("resize", () => resize());

let frames = 0;
let fpsT = 0;
let fps = 0;
const fpsLog: number[] = [];
let last = performance.now();
let t = CAP.time ?? 0;
let shotFrames = 0;
const shoreEvents = new ShoreEvents();
const shadowCenter = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _moon = new THREE.Color();
const lifeT: LifeTime = { t: 0, dt: 0, birds: 1, night: 0 };
// Warm-up: a few frames behind the veil with the clock frozen (shadow map filled, programs bound).
const WARM_FRAMES = 8;
const FADE = 0.45;
const fadeEl = document.getElementById("fade")!;
let warm = 0;
let fadeT = 0;
/** Built and waiting behind the loader for a gesture. */
let waiting = false;
let started = false;

/** Play starts: the first-time hints, and the touch controls on a touch device (or from a laptop's first touch). */
function beginPlay(): void {
  if (PLATFORM.phone) post.restartAdaptive(TIER.res[0]);
  if (HINTS) {
    hints = new Hints(PLATFORM.touch);
    hintsTouch = PLATFORM.touch;
  }
  if (!TOUCH_OK) return;
  onTouch(() => {
    if (hints && !hintsTouch) {
      hints.dispose();
      hints = new Hints(true);
      hintsTouch = true;
    }
    touch ??= new TouchControls({ input, explore, chase, tod, audio });
    touch.enabled = true;
  });
}

/** Frames drawn, for the phone tier's every-other-frame sun shadow. */
let shadowTick = 0;

/** ?gpums with a fixed ?res=: the whole frame's GPU time and the frame's main-thread time (the phone proxy). */
const gpuT = params.has("gpums") && !post.adaptive && !prof.on ? new FrameTimer(renderer, params.get("gpums") !== "raw") : null;

/** Shadows, reflection, scene and post for the current camera (also the warm-up frames). */
function drawScene(px: number, pz: number): void {
  if (prof.on) prof.frameStart();
  const q = gpuT?.begin() ?? null;
  // Sun shadow frustum centred where the camera looks, ~25-30 m ahead.
  chase.cam.getWorldDirection(_dir);
  const l = Math.hypot(_dir.x, _dir.z) || 1;
  if (SHOT) {
    const reach = Math.min(40, SHOT.eye.distanceTo(SHOT.look));
    shadowCenter.set(SHOT.eye.x + (_dir.x / l) * reach, 0, SHOT.eye.z + (_dir.z / l) * reach);
  } else shadowCenter.set(px + (_dir.x / l) * 22, 0, pz + (_dir.z / l) * 22);
  renderer.info.reset();
  const pf = prof.on ? prof : null;
  pf?.begin("shadow", renderer);
  // On the phone tier this map and the mirror both refresh every other frame: they take turns (the
  // mirror's own count is one ahead), so no frame carries both.
  if (++shadowTick % TIER.shadowEvery === 0) shadow.update(renderer, scene, shadowCenter);
  pf?.end("shadow", renderer);
  _charC.copy(rider.walker.position).y += 0.85;
  pf?.begin("charShadow", renderer);
  charShadow.update(renderer, scene, _charC, shadow.dir ?? G.uSunDir.value, rider.walker.visible);
  pf?.end("charShadow", renderer);
  bay.beam.update(t, chase.cam.position);
  // Stars stay in the sky: mirrored as sharp dots they read as specks painted on the sea.
  // So is the painted moon: its mirrored disc would sit on the near water as a solid plate (the
  // moon's light on the water is the glitter path).
  const stars = G.uStars.value;
  G.uStars.value = 0;
  _moon.copy(G.uMoonCol.value);
  G.uMoonCol.value.setScalar(0);
  // Near the boat the mirror sits at the water under her, so her reflection starts at her
  // waterline even on a swell crest; far off it is the mean sea level.
  const nearBoat = 1 - THREE.MathUtils.smoothstep(chase.cam.position.distanceTo(boat.root.position), 40, 100);
  pf?.begin("reflection", renderer);
  reflection.update(renderer, scene, chase.cam, SEA_Y + nearBoat * (boat.waterH - SEA_Y));
  pf?.end("reflection", renderer);
  G.uStars.value = stars;
  G.uMoonCol.value.copy(_moon);
  post.setNear(chase.cam.near);
  post.render(scene, chase.cam, t);
  gpuT?.end(q);
}

/**
 * Dev builds (and ?progwarn): a shader program compiled after loading, or a long stall, can show
 * as a blank or black frame on a busy GPU. Say so in the console with what was going on.
 */
const WATCH = import.meta.env.DEV || params.has("progwarn");
let progSeen = -1;
let watchSkip = true;
addEventListener("visibilitychange", () => (watchSkip = true));
function watch(interval: number): void {
  const progs = renderer.info.programs ?? [];
  if (progSeen >= 0 && progs.length > progSeen) {
    const names = progs.slice(progSeen).map((p) => p.name || p.cacheKey.slice(0, 48));
    console.warn(`[shader] ${progs.length - progSeen} program(s) compiled during play at t=${t.toFixed(2)} (${explore.mode}, ${tod.preset}): ${names.join(", ")}`);
  }
  progSeen = progs.length;
  if (!watchSkip && !waiting && interval > 250 && document.visibilityState === "visible")
    console.warn(`[frame] ${Math.round(interval)} ms stall at t=${t.toFixed(2)} (${explore.mode}, ${tod.preset}, ${renderer.info.render.calls} draws)`);
  watchSkip = waiting;
}

function frame(now: number) {
  // A phone held upright during play: the landscape prompt shows and the bay waits behind it.
  if (started && !waiting && isPortrait()) {
    last = now;
    requestAnimationFrame(frame);
    return;
  }
  const c0 = performance.now();
  const interval = now - last;
  // The first frame after the loader can carry a timestamp from before `last` was reset.
  let dt = Math.max(0, interval / 1000);
  last = now;
  if (dt > 0.1) dt = 0.1;
  if (warm < WARM_FRAMES) {
    warm++;
    dt = 0;
    loader.advance(W_WARM / WARM_FRAMES);
  } else if (SKIP_INTRO && fadeEl.style.display !== "none") {
    fadeT += dt;
    const k = FROZEN ? 1 : Math.min(1, fadeT / FADE);
    fadeEl.style.opacity = String(1 - k * k * (3 - 2 * k));
    if (k >= 1) fadeEl.style.display = "none";
  }
  const simDt = CAP.time !== null ? 0 : dt;
  t += simDt;
  G.uTime.value = t;
  explore.enabled = started && !waiting && !SHOT && !BOAT_RUN;

  // The skiff first: the seated rider and the boat camera read its pose.
  if (!BOAT_RUN) boat.mode = explore.inBoat ? "driven" : "idle";
  boat.update(simDt, t, explore.inBoat ? input : null);
  spray.update(t);
  updateMooring();
  const boating = BOAT_RUN || explore.inBoat;
  if (SHOT && BOAT_RUN) explore.update(0, input, t);

  if (director?.drives) director.drive(t);
  else if (!SHOT) explore.update(simDt, input, t);
  const px = explore.playerX, pz = explore.playerZ;
  const onFoot = explore.onFoot;
  if (hints || touch) {
    hintAcc += simDt;
    // The shore test walks the hull's sides: a few times a second is plenty.
    if (hintAcc > 0.2) {
      const b = explore.boat;
      const s: HintState = {
        walking: onFoot && Math.abs(explore.speed) > 0.4,
        nearBoat: explore.nearBoat,
        aboard: explore.inBoat,
        driving: explore.inBoat && !!b && Math.abs(b.throttle) > 0.2,
        canAshore: explore.canStepAshore,
      };
      hints?.update(hintAcc, s);
      touch?.update(hintAcc, s);
      hintAcc = 0;
    }
  }
  if (!SHOT || BOAT_RUN) rider.update(simDt, explore.foot);
  if (FROZEN && !trailResolved && !SHOT) {
    trail.resolve(t);
    trailResolved = true;
  }
  if (!SHOT) {
    const walking = onFoot && explore.mode === "walk";
    if (walking) for (let i = 0; i < 2; i++) rider.footWorld(i, _feet[i]);
    trail.update(t, simDt, walking ? _feet : null);
  }
  if (boating) {
    boatCam.x = boat.x;
    boatCam.z = boat.z;
    boatCam.yaw = boat.yaw;
    boatCam.speed = boat.u;
    boatCam.lean = -boat.roll * 0.8;
    boatCam.boat.y = boat.y;
    boatCam.boat.roll = boat.roll;
  }
  if (SHOT) poseCamera(chase.cam, SHOT);
  else if (director) director.camera(chase.cam);
  else if (onFoot && chase.mode !== "custom") explore.updateCamera(simDt, chase.cam);
  else chase.update(simDt, boatCam, t, rider);
  sky.follow(chase.cam.position);
  followSea(chase.cam.position);
  buoys.update(t);
  // Flora detail round the camera, gulls, butterflies, fish, petals, fireflies.
  lifeT.t = t;
  lifeT.dt = simDt;
  lifeT.birds = tod.birds;
  lifeT.night = tod.night;
  bay.update(lifeT, chase.cam, px, pz);
  tod.update(dt);
  shoreEvents.update(t, roadX(pz) + waterlineU(pz), pz);

  if (audio.state === "running") {
    chase.cam.getWorldDirection(_dir);
    const cue = coastCues(px, pz, _dir.x, _dir.z);
    audio.setShore(cue.shore, cue.shorePan);
    audio.setOpenWater(cue.sea);
    audio.setTimeOfDay(tod.preset);
    audio.setInBoat(boating);
    if (boating) {
      // Signed (astern below 0); past full (Shift) the motor rises a little further, capped soft in the sound.
      audio.setBoatThrottle(boat.throttle);
      audio.setBoatSpeed(Math.abs(boat.u));
      audio.setMotion(Math.hypot(boat.u, boat.v));
      audio.setNearPier(Math.max(0, 1 - Math.hypot(boat.x - BERTH.x, boat.z - BERTH.z) / 18));
    } else {
      audio.setMotion(undefined);
      // Water lapping at the pier posts and the moored skiff knocking at its lines (panned by the camera).
      const dB = boat.hullDistance(px, pz);
      const d = Math.hypot(boat.x - px, boat.z - pz);
      const pan = d > 0.5 ? Math.max(-1, Math.min(1, ((boat.x - px) * -_dir.z + (boat.z - pz) * _dir.x) / d)) : 0;
      const onPier = bay.overWater(px, pz, 0.5) ? 0.55 : 0;
      audio.setNearPier(Math.max(onPier, 1 - dB / 14), pan);
    }
    audio.update(simDt, {
      speed: boating ? 0 : explore.foot.speed,
      steer: Math.max(-1, Math.min(1, explore.foot.turn / 2)),
      evening: tod.evening,
      night: tod.night,
      air: explore.foot.air,
      vy: explore.foot.vy,
    });
  }

  drawScene(px, pz);
  prof.poll();
  if (gpuT && started) gpuT.cpu(performance.now() - c0);
  if (WATCH && started) watch(interval);

  frames++;
  fpsT += dt;
  if (fpsT >= 1) {
    fps = frames / fpsT;
    fpsLog.push(Math.round(fps));
    if (fpsLog.length > 3600) fpsLog.splice(0, fpsLog.length - 3600);
    frames = 0;
    fpsT = 0;
  }
  if (started && FROZEN && ++shotFrames === 6) {
    post.warmSmaa();
    window.__ready = true;
  }
  if (warm === WARM_FRAMES && !started) {
    started = true;
    post.warmSmaa();
    bootLog.push(["total", Math.round(performance.now() - bootT0)]);
    if (SKIP_INTRO) {
      loader.remove();
      beginPlay();
    }
    else {
      // The gesture that dismisses the loader also starts the audio (autoplay policy).
      fadeEl.style.display = "none";
      waiting = true;
      if (PLATFORM.phone) post.restartAdaptive(TIER.res[0]);
      loader.ready((viaPointer) => {
        audio.start();
        if (!AUTOPLAY && viaPointer && !PLATFORM.touch) lockPointer();
        waiting = false;
        last = performance.now();
        loader.dissolve();
        beginPlay();
        requestAnimationFrame(frame);
      });
      return;
    }
  }
  if (FROZEN && window.__ready && CAP.time !== null) {
    // Frozen capture: nothing changes any more, so stop drawing (keeps the GPU idle).
    return;
  }
  requestAnimationFrame(frame);
}

// Every time of day once through the whole pipeline (dusk and night turn on the lamps and the
// lighthouse beam), behind the loader, then back to the opening preset.
if (params.get("timelapse") !== "1") {
  const s = performance.now();
  reflection.every = 1;
  for (const p of PRESETS) {
    tod.set(p, true);
    tod.update(0);
    drawScene(explore.playerX, explore.playerZ);
    await yieldToPaint();
  }
  reflection.every = TIER.refl[1];
  tod.set(startPreset, true);
  tod.update(0);
  bootLog.push(["presets", Math.round(performance.now() - s)]);
}
requestAnimationFrame(frame);

declare global {
  interface Window {
    __ride: unknown;
    __ready: boolean;
  }
}
window.__ready = false;
window.__ride = {
  renderer,
  scene,
  camera: chase.cam,
  /** The character and her controller (tests: foot contacts, grip error). */
  rider,
  explore,
  gaitCycle,
  bay,
  audio,
  post,
  prof,
  tod,
  bootLog,
  fpsLog,
  get fps() {
    return fps;
  },
  get ready() {
    return warm >= WARM_FRAMES;
  },
  get waiting() {
    return waiting;
  },
  get time() {
    return t;
  },
  get timeOfDay() {
    return tod.preset;
  },
  setTime(p: Preset, instant = false) {
    tod.set(p, instant);
  },
  get water() {
    return tod.water;
  },
  /**
   * Shoreline water for later systems: wave elevation above mean sea level at (x, z), and the
   * water there now (surface height, depth over the ground, sand wetness). Optional t = seconds.
   * Wave breaks and run-ups near the player fire window "shorewave" events.
   */
  shore: {
    seaLevel: SEA_Y,
    eta: (x: number, z: number, at?: number) => waveEta(x, z, at ?? t),
    waterAt: (x: number, z: number, at?: number, out?: WaterAt) => waterAt(x, z, at ?? t, terrainH(x, z), out),
  },
  /**
   * The water of the whole bay (open sea, surf zone and swash), as drawn: surface height and
   * normal at (x, z), and a full sample over the ground there. Optional t = seconds.
   */
  sea: {
    seaLevel: SEA_Y,
    height: (x: number, z: number, at?: number) => seaHeight(x, z, at ?? t),
    normal: (x: number, z: number, at?: number) => seaNormal(x, z, at ?? t),
    sample: (x: number, z: number, at?: number, out?: WaterSample) => waterSample(x, z, at ?? t, terrainH(x, z), out),
  },
  setCam(mode: CamMode | "fpp" | "tpp") {
    chase.fpp = mode === "fpp" ? 1 : 0;
    chase.mode = mode === "fpp" || mode === "tpp" ? "chase" : mode;
  },
  /** The character: where she is, which way she faces, how fast she moves and what she is doing. */
  get player() {
    return { x: explore.x, y: explore.y, z: explore.z, yaw: explore.yaw, speed: explore.speed, mode: explore.mode, spawn: SPAWN };
  },
  /** On foot: stand at world (x, z) (test hook). */
  standAt(x: number, z: number, yaw?: number) {
    explore.standAt(x, z, yaw);
  },
  get footMode() {
    return explore.mode;
  },
  /** The skiff: pose, speed, mode; and where it is moored. */
  get boat() {
    return { x: boat.x, z: boat.z, y: boat.y, yaw: boat.yaw, speed: boat.u, slip: boat.v, pitch: boat.pitch, roll: boat.roll, throttle: boat.throttle, mode: boat.mode, aboard: explore.inBoat, berth: BERTH };
  },
  /**
   * Capture guard: normalized screen points (0..1, y down) whose view ray reaches open water
   * (>= 1 m deep) unoccluded by the land, the character, the boat or the pier.
   */
  seaProbe(nx = 32, ny = 18): [number, number][] {
    const cam = chase.cam;
    cam.updateMatrixWorld();
    const o = cam.position, d = new THREE.Vector3(), out: [number, number][] = [];
    const avoid: [THREE.Vector3, number][] = [
      [new THREE.Vector3(explore.playerX, explore.y + 0.9, explore.playerZ), 1.3],
      [boat.root.position.clone(), 3.4],
    ];
    if (explore.inBoat || BOAT_RUN) avoid[0][0].copy(boat.root.position);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const u = (i + 0.5) / nx, v = (j + 0.5) / ny;
        d.set(u * 2 - 1, 1 - v * 2, 0.5).unproject(cam).sub(o).normalize();
        if (d.y > -1e-3) continue;
        const s = (SEA_Y - o.y) / d.y;
        if (s <= 0 || s > 1800) continue;
        const hx = o.x + d.x * s, hz = o.z + d.z * s;
        if (terrainH(hx, hz) > SEA_Y - 1 || bay.overWater(hx, hz, 1.5)) continue;
        let hit = false;
        for (let k = 1; k < 96 && !hit; k++) {
          const q = s * Math.pow(k / 96, 1.6);
          const y = o.y + d.y * q;
          if (y < terrainH(o.x + d.x * q, o.z + d.z * q) + 0.1 || bay.blocks(o.x + d.x * q, y, o.z + d.z * q)) hit = true;
        }
        for (const [c, r] of avoid) {
          const t0 = Math.max(0, c.clone().sub(o).dot(d));
          if (o.clone().addScaledVector(d, t0).distanceTo(c) < r) hit = true;
        }
        if (!hit) out.push([u, v]);
      }
    return out;
  },
  stats() {
    return {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      sceneCalls: post.sceneCalls,
      sceneTris: post.sceneTris,
      fps: Math.round(fps),
    };
  },
  /** World detail: build counts, what is drawn now, and the tunables (see VERIFY_TODO, World detail). */
  get world() {
    const f = bay.detail.flora, l = bay.life;
    return {
      ...bay.detail.stats,
      grassDrawn: f.meadow.drawn,
      grassChunks: f.meadow.draws,
      flowersDrawn: f.flowers.drawn,
      flowerKinds: f.flowers.counts(),
      butterflies: l.butterflies.drawn,
      fishLeaps: l.fish.count,
      paint: post.paint,
      tune: bay.detail.tune,
      setTier: (q: "low" | "med" | "high") => bay.detail.setTier(q),
    };
  },
  /** Phones and touch (platform.ts, ui/touch.ts): what was decided, the screen layout, the frame timer. */
  mobile: {
    platform: PLATFORM,
    tier: TIER,
    caps,
    get touchOn() {
      return !!touch;
    },
    /** Every control's and hint's box, where she and the boat are on screen, the viewport (CSS px). */
    layout() {
      const c = renderer.domElement;
      return {
        viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio, vv: visualViewport ? { w: visualViewport.width, h: visualViewport.height } : null },
        safeArea: safeAreas(),
        canvas: { cssW: c.clientWidth, cssH: c.clientHeight, w: c.width, h: c.height, pixelRatio: renderer.getPixelRatio(), aspect: +chase.cam.aspect.toFixed(4), scale: post.scale },
        portrait: portrait?.shown ?? false,
        fullscreen: !!document.fullscreenElement,
        controls: touch?.layout() ?? null,
        stick: { ...input.stick },
        hints: hints?.layout() ?? null,
        her: screenBox(rider.walker),
        boat: screenBox(boat.root),
        mode: explore.mode,
        camMode: chase.mode,
        fpp: chase.fpp,
        tod: tod.preset,
        fps: Math.round(fps),
        audio: audio.state,
        music: audio.music,
      };
    },
    timer: gpuT ? { stats: () => gpuT.stats(), reset: () => gpuT.reset(), frames: () => [...gpuT.gpuMs] } : null,
    /** Every linked program against the WebGL 2 minimum limits (capture/gpucheck.ts). */
    limits: () => programLimits(renderer),
    /** The largest texture and the GPU memory of the targets, textures and geometry. */
    memory() {
      type RT = THREE.WebGLRenderTarget;
      const pp = post as unknown as { paint: Record<string, RT> | null; bloom: Record<string, RT | RT[]>; smaa: Record<string, RT | THREE.Texture> };
      const rts: RT[] = [post.mrt, reflection.rt, shadow.rt, charShadow.rt, post.composer.renderTarget1, post.composer.renderTarget2];
      if (pp.paint) rts.push(pp.paint.tA, pp.paint.tB, pp.paint.kw, pp.paint.output);
      rts.push(pp.bloom.renderTargetBright as RT, ...(pp.bloom.renderTargetsHorizontal as RT[]), ...(pp.bloom.renderTargetsVertical as RT[]));
      rts.push(pp.smaa._edgesRT as RT, pp.smaa._weightsRT as RT);
      return gpuMemory(scene, rts.filter(Boolean), [G.uLeafTex.value, G.uSignTex.value, pp.smaa._areaTexture as THREE.Texture, pp.smaa._searchTexture as THREE.Texture]);
    },
  },
};

const _sv = new THREE.Vector3(), _vv = new THREE.Vector3();
/**
 * On-screen box (CSS px) of what `root` draws in the main view, from its vertices (skinned where
 * they are), so it is her or the boat's silhouette and not a loose 3D box; null when none of it is
 * in front of the camera.
 */
function screenBox(root: THREE.Object3D): { x: number; y: number; w: number; h: number } | null {
  const cam = chase.cam;
  root.updateWorldMatrix(true, true);
  cam.updateMatrixWorld();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.layers.test(cam.layers) || o.userData.noCast || o.userData.shadowProxy) return;
    const mat = m.material as THREE.Material;
    if (!mat || !mat.visible || !mat.colorWrite) return;
    const pos = m.geometry.attributes.position;
    if (!pos) return;
    const sk = m as THREE.SkinnedMesh;
    const step = Math.max(1, Math.floor(pos.count / 3000));
    for (let i = 0; i < pos.count; i += step) {
      if (sk.isSkinnedMesh) sk.getVertexPosition(i, _sv);
      else _sv.fromBufferAttribute(pos, i);
      _sv.applyMatrix4(m.matrixWorld);
      if (_vv.copy(_sv).applyMatrix4(cam.matrixWorldInverse).z > -cam.near) continue;
      _sv.project(cam);
      const x = (_sv.x * 0.5 + 0.5) * innerWidth, y = (0.5 - _sv.y * 0.5) * innerHeight;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  });
  if (x0 === Infinity) return null;
  const cx0 = Math.max(0, x0), cy0 = Math.max(0, y0), cx1 = Math.min(innerWidth, x1), cy1 = Math.min(innerHeight, y1);
  if (cx1 <= cx0 || cy1 <= cy0) return null;
  return { x: +cx0.toFixed(1), y: +cy0.toFixed(1), w: +(cx1 - cx0).toFixed(1), h: +(cy1 - cy0).toFixed(1) };
}
