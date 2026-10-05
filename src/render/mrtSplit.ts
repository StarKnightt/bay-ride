import * as THREE from "three";

/**
 * The scene pass writes two targets (colour, and normal/id/ink mask). ANGLE on D3D11 builds a
 * program's pixel shader at link time for its first output only, and the first draw with both
 * targets enabled rebuilt the whole pixel shader synchronously in the GPU process: up to 28 s for
 * the sea, with every frame (the loader included) frozen meanwhile. So the scene is drawn twice:
 * colour with only the first target enabled (each material's own program, which matches its
 * link-time shader), then the normal/id target with a twin of each material whose only output is
 * that target (its colour maths compiled away). The twin tests depth for equality, so it lands on
 * exactly the samples the colour pass kept (alpha-to-coverage included) and needs no coverage of
 * its own; materials that write no depth keep their own depth test and blending.
 *
 * A depth-only draw (the boat's lid over its open hull) hides what is under it from that equality
 * test, so while one is in view the scene goes in two segments: everything drawn before it, colour
 * then normals; then it and everything after it.
 */

/** Stands in for materials that draw nothing in a pass. */
const SKIP = new THREE.MeshBasicMaterial({ visible: false });
const twins = new WeakMap<THREE.Material, THREE.Material>();
const OUT_DECL = /layout\s*\(\s*location\s*=\s*(\d+)\s*\)\s*out\s+((?:(?:lowp|mediump|highp)\s+)?\w+)\s+(\w+)\s*;/g;

/** The fragment source with every output but location 1 turned into a plain global, or null. */
export function normalOnly(fs: string): string | null {
  let found = false;
  const out = fs.replace(OUT_DECL, (all, loc: string, type: string, name: string) => {
    if (loc === "1") {
      found = true;
      return all;
    }
    return `${type} ${name};`;
  });
  return found ? out : null;
}

/** The normal-pass twin of a scene material (cached; shares the material's uniforms). */
export function normalTwin(m: THREE.Material): THREE.Material {
  let t = twins.get(m);
  if (!t) {
    t = makeTwin(m);
    twins.set(m, t);
  }
  return t;
}

function makeTwin(m: THREE.Material): THREE.Material {
  const s = m as THREE.ShaderMaterial;
  if (!s.isShaderMaterial || !s.colorWrite || !s.visible) return SKIP;
  const fs = (s.userData.normalFS as string | undefined) ?? normalOnly(s.fragmentShader);
  if (!fs) return SKIP;
  const writesDepth = s.depthTest && s.depthWrite;
  const t = new THREE.ShaderMaterial({
    name: s.name,
    glslVersion: s.glslVersion,
    uniforms: s.uniforms,
    defines: { ...s.defines },
    extensions: { ...s.extensions },
    vertexShader: s.vertexShader,
    fragmentShader: fs,
    side: s.side,
    vertexColors: s.vertexColors,
    transparent: s.transparent,
    blending: s.blending,
    blendSrc: s.blendSrc,
    blendDst: s.blendDst,
    blendEquation: s.blendEquation,
    blendSrcAlpha: s.blendSrcAlpha,
    blendDstAlpha: s.blendDstAlpha,
    blendEquationAlpha: s.blendEquationAlpha,
    premultipliedAlpha: s.premultipliedAlpha,
    depthTest: s.depthTest,
    depthWrite: false,
    depthFunc: writesDepth ? THREE.EqualDepth : s.depthFunc,
    polygonOffset: s.polygonOffset,
    polygonOffsetFactor: s.polygonOffsetFactor,
    polygonOffsetUnits: s.polygonOffsetUnits,
    clipping: s.clipping,
    fog: s.fog,
    lights: s.lights,
    wireframe: s.wireframe,
    forceSinglePass: s.forceSinglePass,
    alphaToCoverage: false,
  });
  if (s.index0AttributeName) t.index0AttributeName = s.index0AttributeName;
  t.blendColor.copy(s.blendColor);
  t.blendAlpha = s.blendAlpha;
  return t;
}

type Mat = THREE.Material | THREE.Material[];
type Drawn = THREE.Object3D & { material: Mat };
const twinOf = (m: Mat): Mat => (Array.isArray(m) ? m.map(normalTwin) : normalTwin(m));
const skipOf = (m: Mat): Mat => (Array.isArray(m) ? m.map(() => SKIP) : SKIP);
const isTransparent = (m: Mat) => (Array.isArray(m) ? m.some((x) => x.transparent) : m.transparent);
const isDepthOnly = (m: Mat) => !Array.isArray(m) && m.visible && !m.colorWrite && m.depthWrite && !m.transparent;

const drawn: Drawn[] = [];
const own: Mat[] = [];
const segment: number[] = [];
const _frustum = new THREE.Frustum();
const _pv = new THREE.Matrix4();

/** Swap every material under `root` for its normal-pass twin (undo with `restoreMaterials`). */
export function useTwins(root: THREE.Object3D): void {
  drawn.length = own.length = 0;
  root.traverse((o) => {
    const d = o as Drawn;
    if (!d.material) return;
    drawn.push(d);
    own.push(d.material);
    d.material = twinOf(d.material);
  });
}

export function restoreMaterials(): void {
  for (let i = 0; i < drawn.length; i++) drawn[i].material = own[i];
  drawn.length = own.length = 0;
}

/**
 * Draw `scene` into the two-target `target` as described above. `bind(normals)` binds the target
 * and selects its draw buffers (three unbinds a multisampled target after each render). Returns the
 * draw calls and triangles of the colour passes (the scene as one pass would count it).
 */
export function renderSplit(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, target: THREE.WebGLRenderTarget, bind: (normals: boolean) => void): [number, number] {
  // Where the opaque draws are cut: the first depth-only draw in view (Infinity: no cut).
  let cut = Infinity;
  camera.updateMatrixWorld();
  _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  drawn.length = own.length = segment.length = 0;
  scene.traverseVisible((o) => {
    const d = o as Drawn;
    if (!d.material || !o.layers.test(camera.layers)) return;
    drawn.push(d);
    own.push(d.material);
    if (isDepthOnly(d.material) && o.renderOrder < cut && (!(o as THREE.Mesh).isMesh || _frustum.intersectsObject(o))) cut = o.renderOrder;
  });
  for (let i = 0; i < drawn.length; i++) segment.push(drawn[i].renderOrder < cut && !isTransparent(own[i]) ? 0 : 1);
  const segments = cut === Infinity ? [-1] : [0, 1];
  const autoUpdate = scene.matrixWorldAutoUpdate;
  // three resolves a multisampled target at the end of every render() (about 1 ms at 1080p for
  // both targets and depth): only the last render here may. It reads `samples` only for that.
  const samples = target.samples;
  let left = segments.length * 2;
  const render = () => {
    if (--left > 0) target.samples = 0;
    renderer.render(scene, camera);
    target.samples = samples;
    scene.matrixWorldAutoUpdate = false;
  };
  let calls = 0, tris = 0;
  for (const s of segments) {
    for (let i = 0; i < drawn.length; i++) drawn[i].material = s < 0 || segment[i] === s ? own[i] : skipOf(own[i]);
    bind(false);
    const c = renderer.info.render.calls, t = renderer.info.render.triangles;
    render();
    calls += renderer.info.render.calls - c;
    tris += renderer.info.render.triangles - t;
    for (let i = 0; i < drawn.length; i++) drawn[i].material = s < 0 || segment[i] === s ? twinOf(own[i]) : skipOf(own[i]);
    bind(true);
    render();
  }
  scene.matrixWorldAutoUpdate = autoUpdate;
  for (let i = 0; i < drawn.length; i++) drawn[i].material = own[i];
  drawn.length = own.length = segment.length = 0;
  return [calls, tris];
}
