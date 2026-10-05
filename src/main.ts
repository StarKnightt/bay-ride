import * as THREE from "three";
import { G, specializeUber } from "./render/materials";
import { Post } from "./render/post";
import { CharShadow, LAYER_CHAR, LAYER_REFLECT, PlanarReflection, SunShadow, onLayers } from "./render/lightpasses";
import { precompile, warmDraws } from "./render/precompile";
import { leafAtlas } from "./render/leafAtlas";
import { Profiler } from "./render/profiler";
import { Bay } from "./world/bay";
import { MooringLines } from "./world/bay/pier";
import { SEA_Y, roadX } from "./world/bay/road";
import { Sky } from "./world/sky";
import { PRESETS, TimeOfDay, parsePreset, type Preset } from "./world/timeofday";
import { bakeDepth } from "./water/depthMap";
import { buildSea, followSea } from "./water/sea";
import { Buoys } from "./water/buoys";
import { seaHeight, seaNormal, waterSample, type WaterSample } from "./water/query";
import { ShoreEvents, waterAt, waveEta, type WaterAt } from "./water/waves";
import { terrainH, waterlineU } from "./world/bay/terrain";
import { Rider } from "./rider/rider";
import { ChaseCam, type CamMode, type CamTarget } from "./rider/camera";
import { Boat } from "./boat/boat";
import { Spray } from "./boat/spray";
import { BERTH, SPAWN } from "./boat/berth";
import { STEM_Z, TRANSOM_Z } from "./boat/model";
import { Explore } from "./rider/onfoot";
import { Input } from "./core/input";
import { RideAudio } from "./audio";
import { coastCues } from "./sound/listener";
import { Loader, fatal } from "./loader";
import { Hud } from "./ui/hud";
import { captureParams, poseCamera } from "./capture/shots";
import { CharDirector, charMode } from "./capture/charcam";
import { Trail } from "./rider/prints";

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
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
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

const scene = new THREE.Scene();
const bay = await step("the bay", W_BUILD * 0.5, () => new Bay());
scene.add(bay.root);
await step("the sea", W_BUILD * 0.15, () => bakeDepth());
const sea = buildSea();
scene.add(sea);
const buoys = new Buoys();
bay.root.add(buoys.group);
// After the scenery on purpose: opaque draws sort by material id, and the dome should draw last
// so early-z rejects most of its pixels.
const sky = await step("the sky", W_BUILD * 0.25, () => new Sky());
scene.add(sky.group, sky.far, sky.motes);
const rider = await step("the rider", W_BUILD * 0.1, () => new Rider());
// She casts into her own tight shadow map (CharShadow), not the bay's.
onLayers(rider.walker, LAYER_CHAR, LAYER_REFLECT);
rider.walker.traverse((o) => {
  if (o.userData.noCast) o.layers.disable(LAYER_CHAR);
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

const shadow = new SunShadow(2048, 55);
const charShadow = new CharShadow(shadow.mat);
const _charC = new THREE.Vector3();
const reflection = new PlanarReflection(Math.floor(innerWidth * 0.5), Math.floor(innerHeight * 0.5));
const chase = new ChaseCam(innerWidth / innerHeight);
const camParam = params.get("cam");
if (camParam === "fpp") chase.fpp = 1;
else if (camParam === "boat") chase.mode = "chase";
else if (camParam && !CHAR) chase.mode = camParam as CamMode;
const post = new Post(renderer, innerWidth, innerHeight, { kuwahara: params.get("kuwahara") !== "0", msaa: Number(params.get("msaa") ?? 4) });
const prof = new Profiler(renderer, params.has("prof"));
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
  await precompile(renderer, scene, chase.cam, post, [shadow, charShadow], (f) => {
    loader.advance((f - done) * W_COMPILE);
    done = f;
  }, yieldToPaint);
  bootLog.push(["compile", Math.round(performance.now() - s)]);
  const parts = [...bay.root.children, sea, sky.far, sky.group, sky.motes, rider.walker, boat.root, spray.mesh, moor.group, trail.group];
  let tp = performance.now();
  await warmDraws(renderer, scene, chase.cam, post, [shadow, charShadow], parts, (i) => {
    const n = performance.now();
    bootLog.push([`draw${i}`, Math.round(n - tp)]);
    tp = n;
    loader.advance(W_DRAW / parts.length);
  }, yieldToPaint, [reflection.rt]);
}

const audio = new RideAudio();
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

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  chase.cam.aspect = innerWidth / innerHeight;
  chase.cam.updateProjectionMatrix();
  post.setSize(innerWidth, innerHeight);
  reflection.setSize(Math.floor(innerWidth * 0.5), Math.floor(innerHeight * 0.5));
});

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
// Warm-up: a few frames behind the veil with the clock frozen (shadow map filled, programs bound).
const WARM_FRAMES = 8;
const FADE = 0.45;
const fadeEl = document.getElementById("fade")!;
let warm = 0;
let fadeT = 0;
/** Built and waiting behind the loader for a gesture. */
let waiting = false;
let started = false;

/** Shadows, reflection, scene and post for the current camera (also the warm-up frames). */
function drawScene(px: number, pz: number): void {
  // Sun shadow frustum centred where the camera looks, ~25-30 m ahead.
  chase.cam.getWorldDirection(_dir);
  const l = Math.hypot(_dir.x, _dir.z) || 1;
  if (SHOT) {
    const reach = Math.min(40, SHOT.eye.distanceTo(SHOT.look));
    shadowCenter.set(SHOT.eye.x + (_dir.x / l) * reach, 0, SHOT.eye.z + (_dir.z / l) * reach);
  } else shadowCenter.set(px + (_dir.x / l) * 22, 0, pz + (_dir.z / l) * 22);
  renderer.info.reset();
  shadow.update(renderer, scene, shadowCenter);
  _charC.copy(rider.walker.position).y += 0.85;
  charShadow.update(renderer, scene, _charC, shadow.dir ?? G.uSunDir.value, rider.walker.visible);
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
  reflection.update(renderer, scene, chase.cam, SEA_Y + nearBoat * (boat.waterH - SEA_Y));
  G.uStars.value = stars;
  G.uMoonCol.value.copy(_moon);
  post.setNear(chase.cam.near);
  post.render(scene, chase.cam, t);
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
      // Past full throttle (Shift) the motor rises a little further, kept short of a whine.
      audio.setBoatThrottle(Math.min(1.2, Math.max(0, boat.throttle)));
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
    });
  }

  drawScene(px, pz);
  prof.poll();
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
    if (SKIP_INTRO) loader.remove();
    else {
      // The gesture that dismisses the loader also starts the audio (autoplay policy).
      fadeEl.style.display = "none";
      waiting = true;
      loader.ready((viaPointer) => {
        audio.start();
        if (!AUTOPLAY && viaPointer) lockPointer();
        waiting = false;
        last = performance.now();
        loader.dissolve();
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
  reflection.every = 2;
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
};
