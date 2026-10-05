import * as THREE from "three";
import type { Post } from "./post";
import { restoreMaterials, useTwins } from "./mrtSplit";

/** A depth pass that draws its layer with one override material (sun shadow, her shadow). */
export interface ShadowPass {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cam: THREE.Camera;
  readonly mat: THREE.Material;
}

/** Resolves on the next frame (or after `ms` if frames stop, as in a hidden tab). */
export type NextFrame = () => Promise<void>;

/** Programs compiling at once besides the ones already started (see precompile). */
const MAX_COMPILING = 4;

/**
 * Start compiling every program play uses, a mesh at a time with at most MAX_COMPILING in flight,
 * and wait for all of them without ever blocking on one: ANGLE links on worker threads
 * (KHR_parallel_shader_compile), and a program is only drawn once it reports ready. Covers each
 * part's colour materials and their normal-pass twins (both for the scene's render targets), the
 * shadow overrides per mesh kind, and every post pass's material on a quad laid out like the
 * passes' own (no normals: a normal attribute changes the program). Reports 0…1 as programs finish.
 */
export async function precompile(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  post: Post,
  shadows: ShadowPass[],
  parts: THREE.Object3D[],
  onProgress: (f: number) => void,
  nextFrame: NextFrame,
  log?: (label: string, ms: number) => void,
): Promise<void> {
  const prev = renderer.getRenderTarget();
  const programs = () => (renderer.info.programs ?? []) as unknown as { isReady(): boolean }[];
  // Programs already compiling (the sea, started first) are left to finish at full speed: the D3D
  // compiler barely scales across threads, so a flood of others would stretch the longest one.
  const early = new Set(programs());
  const busy = () => programs().filter((p) => !early.has(p) && !p.isReady()).length;
  const s0 = performance.now();
  for (const p of parts) {
    const units: THREE.Object3D[] = [];
    p.traverse((o) => {
      if ((o as THREE.Mesh).material) units.push(o);
    });
    for (const o of units) {
      while (busy() >= MAX_COMPILING) await nextFrame();
      const n = programs().length;
      renderer.setRenderTarget(post.mrt);
      renderer.compile(o, camera, scene);
      useTwins(o);
      renderer.compile(o, camera, scene);
      restoreMaterials();
      renderer.setRenderTarget(prev);
      if (programs().length > n) await nextFrame();
    }
  }
  log?.("compile submitted", performance.now() - s0);

  // Shadow passes draw with an override material: its program differs per mesh kind.
  for (const sp of shadows) {
    const swapped: [THREE.Mesh, THREE.Material | THREE.Material[]][] = [];
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.layers.test(sp.cam.layers)) {
        swapped.push([m, m.material]);
        m.material = sp.mat;
      }
    });
    renderer.setRenderTarget(sp.rt);
    renderer.compile(scene, sp.cam);
    for (const [m, mat] of swapped) m.material = mat;
    renderer.setRenderTarget(prev);
    await nextFrame();
  }

  // Post passes: every material each pass holds, drawn offscreen; the last enabled pass to the screen.
  const quad = new THREE.BufferGeometry();
  quad.setAttribute("position", new THREE.Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3));
  quad.setAttribute("uv", new THREE.Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2));
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const compileQuads = (mats: Set<THREE.Material>, target: THREE.WebGLRenderTarget | null) => {
    const quads = new THREE.Scene();
    for (const m of mats) quads.add(new THREE.Mesh(quad, m));
    renderer.setRenderTarget(target);
    renderer.compile(quads, ortho);
  };
  const passMaterials = (pass: object) => {
    const out = new Set<THREE.Material>();
    const take = (v: unknown) => {
      if (v instanceof THREE.Material && !(v instanceof THREE.MeshBasicMaterial)) out.add(v);
    };
    for (const v of Object.values(pass)) {
      if (Array.isArray(v)) v.forEach(take);
      else take(v);
      take((v as { material?: unknown } | null)?.material);
    }
    return out;
  };
  const passes = post.composer.passes;
  const offscreen = new Set<THREE.Material>();
  for (const pass of passes) for (const m of passMaterials(pass)) offscreen.add(m);
  compileQuads(offscreen, post.composer.renderTarget1);
  const last = [...passes].reverse().find((p) => p.enabled);
  if (last) compileQuads(passMaterials(last), null);
  renderer.setRenderTarget(prev);
  quad.dispose();

  const all = programs();
  const total = Math.max(1, all.length);
  for (;;) {
    const left = all.filter((p) => !p.isReady()).length;
    onProgress(1 - left / total);
    if (left === 0) break;
    await nextFrame();
  }
}

/**
 * Draw each part of the scene once, alone and unculled, into every target it is drawn into during
 * play, one part per frame: geometry and texture uploads land here in small slices instead of in
 * the first frame of play. Meshes that start empty (footprints, ripple rings, spray) get one
 * instance for the warm draw, or they would first draw, and upload, at the first footstep or the
 * first throttle.
 */
export async function warmDraws(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  post: Post,
  shadows: ShadowPass[],
  parts: THREE.Object3D[],
  reflection: THREE.WebGLRenderTarget,
  onPart: (i: number) => void,
  nextFrame: NextFrame,
): Promise<void> {
  const culled: THREE.Object3D[] = [];
  const restore: (() => void)[] = [];
  scene.traverse((o) => {
    if (o.frustumCulled) {
      o.frustumCulled = false;
      culled.push(o);
    }
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && im.count === 0) {
      im.count = 1;
      restore.push(() => (im.count = 0));
    }
    const g = (o as THREE.Mesh).geometry as THREE.InstancedBufferGeometry | undefined;
    if (g?.isInstancedBufferGeometry && g.instanceCount === 0) {
      g.instanceCount = 1;
      restore.push(() => (g.instanceCount = 0));
    }
    if (g && g.drawRange.count === 0) {
      g.drawRange.count = Infinity;
      restore.push(() => (g.drawRange.count = 0));
    }
  });
  const vis = parts.map((p) => p.visible);
  const prev = renderer.getRenderTarget();
  for (let i = 0; i < parts.length; i++) {
    parts.forEach((p, j) => (p.visible = j === i));
    post.renderScene(scene, camera);
    renderer.setRenderTarget(reflection);
    renderer.render(scene, camera);
    const po = scene.overrideMaterial;
    for (const sp of shadows) {
      scene.overrideMaterial = sp.mat;
      renderer.setRenderTarget(sp.rt);
      renderer.render(scene, sp.cam);
    }
    scene.overrideMaterial = po;
    renderer.setRenderTarget(prev);
    onPart(i);
    await nextFrame();
  }
  parts.forEach((p, j) => (p.visible = vis[j]));
  for (const o of culled) o.frustumCulled = true;
  for (const r of restore) r();
}
