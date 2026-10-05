import * as THREE from "three";
import { COMMON, G, OUT, shadowDepthMaterial, specializeUber } from "../render/materials";
import { Post } from "../render/post";
import { CharShadow, LAYER_CHAR, SunShadow, onLayers } from "../render/lightpasses";
import { PRESETS, TimeOfDay, parsePreset, type Preset } from "../world/timeofday";
import { buildBoat } from "../boat/model";
import { FACE_U } from "./heroineFace";
import { loadHeroine, poseAt, type Heroine } from "./heroine";

/**
 * Character lab (not part of the game build): the heroine GLB in the game's own toon materials,
 * ink outline and post chain, lit by the game's time-of-day presets, on a soft painted studio
 * backdrop. The key light turns with the camera (a turntable), so front, side and back views are
 * all lit from the camera's upper left at the preset's sun height and colour.
 *
 *   character-lab.html?view=front|side|back|face|face34|sit|walk|free&tod=noon|golden&clip=idle&t=0
 *   &glasses=0 hides the lens tint, &yaw=<deg> orbits the camera, &dist / &fov / &look=x,y,z.
 * window.__lab.shot({...}) re-poses without a reload; window.__ready is set once a frame is drawn.
 */

const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance", stencil: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.info.autoReset = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
{
  const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  blank.needsUpdate = true;
  G.uLeafTex.value = blank;
  G.uSignTex.value = blank;
}

const scene = new THREE.Scene();
const post = new Post(renderer, innerWidth, innerHeight, { kuwahara: params.get("kuwahara") !== "0", msaa: 4 });
const sun = new SunShadow(1024, 10);
G.uShadowOn.value = 0;
const charShadow = new CharShadow(shadowDepthMaterial(), 2048, 1.3);
const preset0: Preset = parsePreset(params.get("tod")) ?? "noon";
const tod = new TimeOfDay(post, sun, preset0);

// ---------------------------------------------------------------- studio backdrop and floor

const BG = /* glsl */ `
// Soft painted studio: warm paper toward the floor, a pale wash of the preset's sky above,
// a few broad brush tones so it never reads as a flat fill.
vec3 studio(vec3 dir){
  vec3 paper = vec3(0.80, 0.765, 0.69);
  vec3 sky = skyColor(normalize(vec3(dir.x, max(dir.y, 0.0) * 0.6 + 0.12, dir.z)));
  float h = dir.y;
  vec3 c = mix(paper * 0.93, mix(paper, sky * 0.9 + paper * 0.25, 0.42), smoothstep(-0.12, 0.55, h));
  float br = vnoise(vec2(atan(dir.x, dir.z) * 3.0, h * 4.0)) * 0.6 + vnoise(vec2(atan(dir.x, dir.z) * 9.0, h * 11.0)) * 0.4;
  c *= 0.97 + 0.06 * br;
  return c * mix(vec3(1.0), uWorldTint, 0.6) + uSunColor * 0.02;
}`;

const backdrop = new THREE.Mesh(
  new THREE.SphereGeometry(40, 48, 24),
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, uId: { value: 0 }, uMask: { value: 0 } },
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `out vec3 vWPos; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vWPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${OUT}
      ${BG}
      in vec3 vWPos;
      void main(){
        vec3 dir = normalize(vWPos - cameraPosition);
        gColor = vec4(safe3(studio(dir)), 1.0);
        gNormal = vec4(0.5, 0.5, 0.0, 0.0);
      }`,
  }),
);
backdrop.renderOrder = 10;
scene.add(backdrop);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(9, 96).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { ...G, uId: { value: 1 }, uMask: { value: 0 } },
    vertexShader: /* glsl */ `out vec3 vWPos; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); vWPos = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }`,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${OUT}
      ${BG}
      in vec3 vWPos;
      void main(){
        gFoot = max(length(dFdx(vWPos)), length(dFdy(vWPos)));
        vec3 N = vec3(0.0, 1.0, 0.0);
        vec3 base = vec3(0.62, 0.585, 0.52);
        vec3 col = toon(base, N, vWPos, 0.0, 0.5, 0.0, 0.03);
        // Fade into the backdrop with distance, so floor and wall are one soft studio.
        vec3 dir = normalize(vWPos - cameraPosition);
        float k = smoothstep(1.6, 6.5, length(vWPos.xz));
        col = mix(col, studio(dir), k);
        writeOut(col, N, 0.0);
      }`,
  }),
);
scene.add(floor);

// ---------------------------------------------------------------- the skiff (tiller pose)

const boat = buildBoat();
boat.root.visible = false;
scene.add(boat.root);
/** Boat frame → where she sits: port side of the stern bench so her right hand is on the tiller. */
const SEAT = new THREE.Vector3(-0.3, -0.09, 1.3);

// ---------------------------------------------------------------- the heroine

const camera = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 0.05, 200);
let her: Heroine | null = null;
const holder = new THREE.Group();
scene.add(holder);

interface Shot {
  view?: string;
  tod?: string;
  clip?: string | null;
  t?: number;
  yaw?: number;
  dist?: number;
  fov?: number;
  look?: [number, number, number];
  glasses?: boolean;
  light?: number;
  height?: number;
  pitch?: number;
}

const DEG = Math.PI / 180;
const _look = new THREE.Vector3();
const _sun = new THREE.Vector3();

function setSun(camAz: number, offset: number): void {
  // Keep the preset's sun height and colour; turn its bearing to the camera's upper left.
  const el = Math.asin(THREE.MathUtils.clamp(G.uSunDir.value.y, -1, 1));
  const elSky = Math.asin(THREE.MathUtils.clamp(G.uSkySun.value.y, -1, 1));
  const az = camAz + offset * DEG;
  G.uSunDir.value.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  G.uSkySun.value.set(Math.sin(az) * Math.cos(elSky), Math.sin(elSky), Math.cos(az) * Math.cos(elSky));
  G.uGlintDir.value.copy(G.uSkySun.value);
  G.uCloudLight.value.copy(G.uSkySun.value);
  const se = Math.max(el, 6 * DEG);
  _sun.set(Math.sin(az) * Math.cos(se), Math.sin(se), Math.cos(az) * Math.cos(se));
  sun.dir = _sun;
}

function frame(s: Shot): void {
  const view = s.view ?? "front";
  const p = s.tod ? parsePreset(s.tod) : null;
  if (p) {
    tod.set(p, true);
    tod.update(0);
  }
  FACE_U.uLens.value = s.glasses === false ? 0 : 1;
  if (her) for (const m of her.meshes) if (m.userData.role === "frame") m.visible = s.glasses !== false;
  const sit = view === "sit";
  boat.root.visible = sit;
  holder.position.set(0, 0, 0);
  holder.rotation.set(0, 0, 0);
  if (sit) {
    // She faces the bow (boat -Z); the GLB faces +Z, so turn her round on the seat.
    holder.position.copy(SEAT);
    holder.rotation.y = Math.PI;
  }
  const clip = s.clip !== undefined ? s.clip : sit ? "sit_tiller" : view === "walk" ? "walk" : "idle";
  if (her) poseAt(her, clip && her.clips.has(clip) ? clip : null, s.t ?? 0);
  // Camera: azimuth around her (0 = in front of her), distance, look-at height.
  let az = 0, dist = 4.6, lookY = 0.88, fov = 26, pitch = 0;
  if (view === "side" || view === "walk") az = 90;
  if (view === "back") az = 180;
  if (view === "face" || view === "face34") {
    dist = 0.72;
    lookY = 1.53;
    fov = 24;
    if (view === "face34") az = 34;
  }
  if (sit) {
    az = 180 - 36;
    dist = 4.0;
    lookY = 0.55;
    pitch = 9;
  }
  if (s.yaw !== undefined) az = s.yaw;
  if (s.dist !== undefined) dist = s.dist;
  if (s.fov !== undefined) fov = s.fov;
  if (s.height !== undefined) lookY = s.height;
  if (s.pitch !== undefined) pitch = s.pitch;
  _look.set(0, lookY, 0);
  if (sit) _look.set(SEAT.x + 0.12, lookY, SEAT.z - 0.1);
  if (s.look) _look.set(...s.look);
  const a = az * DEG, pt = pitch * DEG;
  camera.fov = fov;
  camera.aspect = innerWidth / innerHeight;
  camera.position.set(_look.x + Math.sin(a) * Math.cos(pt) * dist, _look.y + Math.sin(pt) * dist, _look.z + Math.cos(a) * Math.cos(pt) * dist);
  camera.lookAt(_look);
  camera.updateProjectionMatrix();
  setSun(a, s.light ?? -42);
}

/**
 * Her hat shades her face as paint (see heroineFace), so it must not also drop a cast shadow over
 * her hair, shoulders and chest: in her shadow map the hat's depth is pushed 0.6 m away from the
 * light. Anything nearer behind it than that (all of her) stays lit by it; the ground metres away
 * still gets the brim's shadow.
 */
const hatShadowMat = (() => {
  const m = shadowDepthMaterial();
  m.vertexShader = m.vertexShader.replace(
    "gl_Position = projectionMatrix * viewMatrix * m * vec4(p, 1.0);",
    "gl_Position = projectionMatrix * viewMatrix * m * vec4(p, 1.0); gl_Position.z += 2.0 * 0.6 / 39.5 * gl_Position.w;",
  );
  return m;
})();
const _vis = new Map<THREE.Object3D, boolean>();
const NO_SHADOW = new Set((params.get("noshadow") ?? "").split(",").filter(Boolean));

function herShadow(c: THREE.Vector3): void {
  const dir = sun.dir ?? G.uSunDir.value;
  if (!her) return charShadow.update(renderer, scene, c, dir, false);
  const hat = her.meshes.filter((m) => m.userData.hatPart || m.userData.headPart);
  for (const m of hat) m.visible = false;
  // Debug: ?noshadow=role,role leaves those parts out of her shadow pass entirely.
  const skip = her.meshes.filter((m) => NO_SHADOW.has(m.userData.role) || NO_SHADOW.has(m.name));
  for (const m of skip) m.visible = false;
  charShadow.update(renderer, scene, c, dir, true);
  for (const m of skip) m.visible = true;
  // The hat alone, offset, into the same map (no clear).
  _vis.clear();
  scene.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      _vis.set(o, o.visible);
      o.visible = false;
    }
  });
  for (const m of hat) m.visible = true;
  const ac = renderer.autoClear;
  renderer.autoClear = false;
  const po = scene.overrideMaterial;
  scene.overrideMaterial = hatShadowMat;
  renderer.setRenderTarget(charShadow.rt);
  renderer.render(scene, charShadow.cam);
  renderer.setRenderTarget(null);
  scene.overrideMaterial = po;
  renderer.autoClear = ac;
  for (const [o, v] of _vis) o.visible = v;
  for (const m of hat) m.visible = true;
}

function draw(): void {
  renderer.info.reset();
  scene.updateMatrixWorld(true);
  const c = new THREE.Vector3();
  if (her) her.root.getWorldPosition(c);
  c.y += 0.85;
  if (boat.root.visible) c.copy(holder.position).add(new THREE.Vector3(0, 0.55, 0));
  herShadow(c);
  post.setNear(camera.near);
  post.render(scene, camera, G.uTime.value);
}

async function main(): Promise<void> {
  const url = params.get("glb") ?? "./models/heroine.glb";
  her = await loadHeroine(url);
  holder.add(her.root);
  onLayers(her.root, LAYER_CHAR);
  onLayers(boat.root, LAYER_CHAR);
  specializeUber(her.root);
  specializeUber(boat.root);
  const s0: Shot = {
    view: params.get("view") ?? "front",
    clip: params.has("clip") ? params.get("clip") : undefined,
    t: Number(params.get("t") ?? 0),
    glasses: params.get("glasses") !== "0",
  };
  if (params.has("yaw")) s0.yaw = Number(params.get("yaw"));
  if (params.has("dist")) s0.dist = Number(params.get("dist"));
  if (params.has("fov")) s0.fov = Number(params.get("fov"));
  if (params.has("look")) s0.look = params.get("look")!.split(",").map(Number) as [number, number, number];
  frame(s0);
  // Compile every program once (scene into the MRT target, her shadow pass, the post chain).
  renderer.setRenderTarget(post.mrt);
  renderer.compile(scene, camera);
  renderer.setRenderTarget(null);
  for (let i = 0; i < 4; i++) draw();
  post.warmSmaa();
  draw();
  window.__lab = {
    presets: PRESETS,
    clips: [...her.clips.keys()],
    tris: her.tris,
    bones: [...her.bones.keys()],
    meta: her.meta,
    shot(s: Shot) {
      frame(s);
      draw();
      draw();
      return renderer.info.render.calls;
    },
  };
  window.__ready = true;
}

addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight);
});

declare global {
  interface Window {
    __lab: unknown;
    __ready: boolean;
  }
}
window.__ready = false;
main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML("beforeend", `<pre style="color:#fff;position:fixed;top:8px;left:8px">${String(e?.stack ?? e)}</pre>`);
});
