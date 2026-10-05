import * as THREE from "three";
import type { Post } from "./post";

/** A depth pass that draws its layer with one override material (sun shadow, her shadow). */
export interface ShadowPass {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cam: THREE.Camera;
  readonly mat: THREE.Material;
}

/**
 * Compile every shader variant play will use (scene into the MRT target, the shadow override on
 * each mesh kind, every post pass offscreen + on screen) through the parallel-compile path,
 * reporting 0…1 as programs finish, so no frame stalls on a compile later.
 */
export async function precompile(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  post: Post,
  shadows: ShadowPass[],
  onProgress: (f: number) => void,
  pause: () => Promise<void>,
): Promise<void> {
  const prev = renderer.getRenderTarget();

  renderer.setRenderTarget(post.mrt);
  renderer.compile(scene, camera);
  await pause();

  // Shadow passes render the scene with an override material: the variants differ per mesh kind.
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
    await pause();
  }

  const quads = new THREE.Scene();
  const plane = new THREE.PlaneGeometry(2, 2);
  const seen = new Set<THREE.Material>();
  const take = (v: unknown) => {
    if (v instanceof THREE.Material && !seen.has(v)) {
      seen.add(v);
      quads.add(new THREE.Mesh(plane, v));
    }
  };
  for (const pass of post.composer.passes)
    for (const v of Object.values(pass)) {
      if (Array.isArray(v)) v.forEach(take);
      else take(v);
      take((v as { material?: unknown } | null)?.material);
    }
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  renderer.setRenderTarget(post.composer.renderTarget1);
  renderer.compile(quads, ortho);
  renderer.setRenderTarget(null);
  renderer.compile(quads, ortho);
  renderer.setRenderTarget(prev);
  plane.dispose();

  const programs = renderer.info.programs ?? [];
  const pending = () => programs.filter((p) => !(p as unknown as { isReady(): boolean }).isReady()).length;
  const total = Math.max(1, programs.length);
  for (let left = pending(); left > 0; left = pending()) {
    onProgress(1 - left / total);
    await new Promise((r) => setTimeout(r, 40));
  }
  onProgress(1);
}

/**
 * Draw each part of the scene once, alone and unculled, into every target kind it is drawn into
 * during play: buffer uploads and the driver's deferred per-draw shader variants (ANGLE builds them
 * at the first real draw) land here in small slices instead of mid-play. Meshes that start empty
 * (footprints, ripple rings, spray) get one instance for the warm draw, or they would first draw,
 * and stall, at the first footstep or the first throttle.
 */
export async function warmDraws(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  post: Post,
  shadows: ShadowPass[],
  parts: THREE.Object3D[],
  onPart: (i: number) => void,
  pause: () => Promise<void>,
  extraTargets: THREE.WebGLRenderTarget[] = [],
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
    for (const rt of [post.mrt, ...extraTargets]) {
      renderer.setRenderTarget(rt);
      renderer.render(scene, camera);
    }
    const po = scene.overrideMaterial;
    for (const sp of shadows) {
      scene.overrideMaterial = sp.mat;
      renderer.setRenderTarget(sp.rt);
      renderer.render(scene, sp.cam);
    }
    scene.overrideMaterial = po;
    renderer.setRenderTarget(prev);
    onPart(i);
    await pause();
  }
  parts.forEach((p, j) => (p.visible = vis[j]));
  for (const o of culled) o.frustumCulled = true;
  for (const r of restore) r();
}
