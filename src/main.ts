import * as THREE from "three";
import { G, specializeUber } from "./render/materials";
import { Post } from "./render/post";
import { LAYER_REFLECT, LAYER_SHADOW, PlanarReflection, SunShadow, onLayers } from "./render/lightpasses";
import { precompile, warmDraws } from "./render/precompile";
import { leafAtlas } from "./render/leafAtlas";
import { Profiler } from "./render/profiler";
import { Bay, type Contact } from "./world/bay";
import { ROAD_Z1, SEA_Y, roadX, roadYaw } from "./world/bay/road";
import { Sky } from "./world/sky";
import { TimeOfDay, parsePreset, type Preset } from "./world/timeofday";
import { bakeDepth } from "./water/depthMap";
import { buildSea } from "./water/sea";
import { ShoreEvents, waterAt, waveEta, type WaterAt } from "./water/waves";
import { terrainH, waterlineU } from "./world/bay/terrain";
import { Rider } from "./rider/rider";
import { Controller, START_Z } from "./rider/controller";
import { ChaseCam, type CamMode } from "./rider/camera";
import { Explore } from "./rider/onfoot";
import { Input } from "./core/input";
import { RideAudio } from "./audio";
import { coastCues } from "./sound/listener";
import { Loader, fatal } from "./loader";
import { Hud } from "./ui/hud";
import { captureParams, poseCamera } from "./capture/shots";

const params = new URLSearchParams(location.search);
const CAP = captureParams(params);
const SHOT = CAP.shot;
const AUTOPLAY = params.has("autoplay") && params.get("autoplay") !== "0";
/** Go straight in once built (no "click to start" wait): captures and autoplay. */
const SKIP_INTRO = !!SHOT || (params.has("skipintro") && params.get("skipintro") !== "0");
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
loader.advance(W_BOOT, "the bay");
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
  loader.advance(weight, label);
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
// After the scenery on purpose: opaque draws sort by material id, and the dome should draw last
// so early-z rejects most of its pixels.
const sky = await step("the sky", W_BUILD * 0.25, () => new Sky());
scene.add(sky.group, sky.far, sky.motes);
const rider = await step("the rider", W_BUILD * 0.1, () => new Rider());
onLayers(rider.lean, LAYER_SHADOW, LAYER_REFLECT);
scene.add(rider.root, rider.walker);
if (!params.has("nospec")) for (const o of [bay.root, rider.root, rider.walker]) specializeUber(o);

const shadow = new SunShadow(2048, 55);
const reflection = new PlanarReflection(Math.floor(innerWidth * 0.5), Math.floor(innerHeight * 0.5));
const startParam = params.get("start");
const ctl = new Controller(AUTOPLAY, startParam !== null && Number.isFinite(Number(startParam)) ? Number(startParam) : START_Z);
const chase = new ChaseCam(innerWidth / innerHeight);
const camParam = params.get("cam");
if (camParam === "fpp") chase.fpp = 1;
else if (camParam) chase.mode = camParam as CamMode;
const post = new Post(renderer, innerWidth, innerHeight, { kuwahara: params.get("kuwahara") !== "0", msaa: Number(params.get("msaa") ?? 4) });
const prof = new Profiler(renderer, params.has("prof"));
post.prof = prof;

// Time of day: ?tod=morning|noon|golden|sunset|dusk|night (also ?time=); T or the buttons cycle.
const startPreset: Preset = parsePreset(params.get("tod") ?? params.get("time")) ?? "golden";
const tod = new TimeOfDay(post, shadow, startPreset, params.get("timelapse") === "1");
const hud = new Hud(tod, CAP.hud && !AUTOPLAY);

if (SHOT) {
  poseCamera(chase.cam, SHOT);
  rider.root.visible = false;
  rider.walker.visible = false;
}

{
  const s = performance.now();
  let done = 0;
  await precompile(renderer, scene, chase.cam, post, shadow, (f) => {
    loader.advance((f - done) * W_COMPILE, "paint");
    done = f;
  }, yieldToPaint);
  bootLog.push(["compile", Math.round(performance.now() - s)]);
  const parts = [...bay.root.children, sea, sky.far, sky.group, sky.motes, rider.root];
  let tp = performance.now();
  await warmDraws(renderer, scene, chase.cam, post, shadow, parts, (i) => {
    const n = performance.now();
    bootLog.push([`draw${i}`, Math.round(n - tp)]);
    tp = n;
    loader.advance(W_DRAW / parts.length, "paint");
  }, yieldToPaint);
}

const audio = new RideAudio();
const input = new Input(
  () => audio.start(),
  () => {
    if (!explore.onFoot) chase.toggle();
  },
);
// B = bicycle bell, M = music on/off, Shift+M = mute all (each also counts as the first gesture that starts audio).
audio.bindKeys();
addEventListener("keydown", (e) => {
  if (e.code === "KeyB" && !e.repeat) rider.bike.ringBell();
});
// F = get off and walk / get back on; C = cinematic ride cameras.
const explore = new Explore(bay, rider, ctl, chase, audio, renderer.domElement, CAP.hud && !AUTOPLAY);
chase.clear = explore;
chase.mouseLook = !AUTOPLAY && !SHOT;
explore.lockRiding = !AUTOPLAY && !SHOT;
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
/** The bike as three circles: body at the saddle, front wheel + basket ahead, rear wheel behind. */
function bikeContact(x: number, z: number): Contact {
  const fx = -Math.sin(ctl.yaw), fz = -Math.cos(ctl.yaw);
  let best = bay.contact(x, z, 0.35);
  for (const [d, r] of [[0.75, 0.28], [-0.45, 0.25]]) {
    const c = bay.contact(x + fx * d, z + fz * d, r);
    if (c.pen > best.pen) best = c;
  }
  return best;
}
// Warm-up: a few frames behind the veil with the clock frozen (shadow map filled, programs bound).
const WARM_FRAMES = 8;
const FADE = 0.45;
const fadeEl = document.getElementById("fade")!;
let warm = 0;
let fadeT = 0;
/** Built and waiting behind the loader for a gesture. */
let waiting = false;
let started = false;

function frame(now: number) {
  const interval = now - last;
  let dt = interval / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  if (warm < WARM_FRAMES) {
    warm++;
    dt = 0;
    loader.advance(W_WARM / WARM_FRAMES);
  } else if (SKIP_INTRO && fadeEl.style.display !== "none") {
    fadeT += dt;
    const k = SHOT ? 1 : Math.min(1, fadeT / FADE);
    fadeEl.style.opacity = String(1 - k * k * (3 - 2 * k));
    if (k >= 1) fadeEl.style.display = "none";
  }
  const simDt = CAP.time !== null ? 0 : dt;
  t += simDt;
  G.uTime.value = t;
  explore.enabled = started && !waiting && !SHOT;

  if (!SHOT) {
    if (explore.bikeActive) {
      // Sub-step so a frame hitch can never tunnel the bike through a thin obstacle.
      const steps = Math.max(1, Math.ceil((Math.abs(ctl.speed) * simDt) / 0.1));
      let bumpMax = 0;
      for (let i = 0; i < steps; i++) {
        ctl.update(simDt / steps, input, bikeContact);
        bumpMax = Math.max(bumpMax, ctl.bumpImpulse);
      }
      ctl.bumpImpulse = bumpMax;
    } else ctl.bumpImpulse = 0;
    explore.update(simDt, input, t);
    // Autoplay loops the coast road.
    if (AUTOPLAY && ctl.z < ROAD_Z1 + 12) {
      ctl.z = START_Z;
      ctl.x = roadX(START_Z);
      ctl.yaw = roadYaw(START_Z);
    }
  }
  const px = explore.playerX, pz = explore.playerZ;
  const onFoot = explore.onFoot;
  rider.root.position.set(ctl.x, 0.02, ctl.z);
  rider.root.rotation.y = ctl.yaw;
  if (!SHOT) {
    rider.update(
      simDt,
      {
        speed: ctl.speed,
        steer: onFoot ? ctl.steer * 1.6 * (1 - explore.kick) + explore.parkSteer : ctl.steer * 1.6,
        lean: onFoot ? ctl.lean * (1 - explore.kick) + explore.parkLean : ctl.lean,
        crank: ctl.crank,
        wheel: ctl.wheel,
        pedaling: onFoot ? 0 : ctl.pedaling,
        time: t,
        kick: explore.kick,
        sprint: onFoot ? 0 : ctl.sprint,
      },
      onFoot ? explore.foot : undefined,
    );
    rider.bike.bump(ctl.bumpImpulse);
  }
  if (SHOT) poseCamera(chase.cam, SHOT);
  else if (onFoot && chase.mode !== "custom") explore.updateCamera(simDt, chase.cam);
  else chase.update(simDt, ctl, t, rider);
  sky.follow(chase.cam.position);
  tod.update(dt);
  shoreEvents.update(t, roadX(pz) + waterlineU(pz), pz);
  rider.bike.setLamp(tod.night);

  if (audio.state === "running") {
    chase.cam.getWorldDirection(_dir);
    const cue = coastCues(px, pz, _dir.x, _dir.z);
    audio.setShore(cue.shore, cue.shorePan);
    audio.setOpenWater(cue.sea);
    audio.setTimeOfDay(tod.preset);
    audio.update(simDt, Math.abs(ctl.speed), Math.abs(ctl.cadence), Math.abs(ctl.wheelRate), ctl.pedaling, ctl.brakePressure, {
      steer: Math.max(-1, Math.min(1, ctl.steer / 0.3)),
      bump: ctl.bumpImpulse,
      roughness: 0.25,
      evening: tod.evening,
      night: tod.night,
    });
  }

  // Sun shadow frustum centred where the camera looks, ~25-30 m ahead.
  chase.cam.getWorldDirection(_dir);
  const l = Math.hypot(_dir.x, _dir.z) || 1;
  if (SHOT) {
    const reach = Math.min(40, SHOT.eye.distanceTo(SHOT.look));
    shadowCenter.set(SHOT.eye.x + (_dir.x / l) * reach, 0, SHOT.eye.z + (_dir.z / l) * reach);
  } else if (onFoot) shadowCenter.set(px + (_dir.x / l) * 22, 0, pz + (_dir.z / l) * 22);
  else shadowCenter.set(ctl.x - Math.sin(ctl.yaw) * 30, 0, ctl.z - Math.cos(ctl.yaw) * 30);
  renderer.info.reset();
  shadow.update(renderer, scene, shadowCenter);
  bay.beam.update(t, chase.cam.position);
  reflection.update(renderer, scene, chase.cam, SEA_Y);
  post.setNear(chase.cam.near);
  post.render(scene, chase.cam, t);
  prof.poll();

  hud.speed.textContent = onFoot ? "" : `${Math.round(ctl.speed * 3.6)} km/h`;
  frames++;
  fpsT += dt;
  if (fpsT >= 1) {
    fps = frames / fpsT;
    fpsLog.push(Math.round(fps));
    if (fpsLog.length > 3600) fpsLog.splice(0, fpsLog.length - 3600);
    frames = 0;
    fpsT = 0;
  }
  if (started && SHOT && ++shotFrames === 6) {
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
  if (SHOT && window.__ready && CAP.time !== null) {
    // Frozen capture: nothing changes any more, so stop drawing (keeps the GPU idle).
    return;
  }
  requestAnimationFrame(frame);
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
  setCam(mode: CamMode | "fpp" | "tpp") {
    chase.fpp = mode === "fpp" ? 1 : 0;
    chase.mode = mode === "fpp" || mode === "tpp" ? "chase" : mode;
  },
  place(u: number, z: number, speed: number, yawOff = 0) {
    ctl.x = roadX(z) + u;
    ctl.z = z;
    ctl.yaw = roadYaw(z) + yawOff;
    ctl.speed = speed;
  },
  get ctl() {
    return { x: ctl.x, z: ctl.z, u: ctl.x - roadX(ctl.z), yaw: ctl.yaw, speed: ctl.speed };
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
