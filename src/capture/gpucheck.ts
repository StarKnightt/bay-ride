import * as THREE from "three";

/**
 * Phone-GPU safety checks (capture tooling, `__ride.mobile.limits()` / `.memory()`):
 * - every linked program against the WebGL 2 minimums a phone may have: 224 fragment and 256 vertex
 *   uniform vectors, 15 varying vectors, 16 texture units per stage. Each stage is linked again on
 *   its own with a trivial partner, so the active uniforms counted are that stage's, as the driver
 *   sees them (unused ones compiled away). Vectors are counted without packing (every scalar, vec2
 *   and vec3 takes a whole row), so a pass here is a pass under any packing.
 * - the largest texture or render target, and the GPU memory the textures, targets and geometry take.
 */

const ROWS: Record<number, number> = {};
function rowsOf(gl: WebGL2RenderingContext, type: number): number {
  if (!Object.keys(ROWS).length) {
    for (const t of [gl.FLOAT, gl.FLOAT_VEC2, gl.FLOAT_VEC3, gl.FLOAT_VEC4, gl.INT, gl.INT_VEC2, gl.INT_VEC3, gl.INT_VEC4, gl.BOOL, gl.BOOL_VEC2, gl.BOOL_VEC3, gl.BOOL_VEC4, gl.UNSIGNED_INT, gl.UNSIGNED_INT_VEC2, gl.UNSIGNED_INT_VEC3, gl.UNSIGNED_INT_VEC4]) ROWS[t] = 1;
    ROWS[gl.FLOAT_MAT2] = 2;
    ROWS[gl.FLOAT_MAT3] = 3;
    ROWS[gl.FLOAT_MAT4] = 4;
    ROWS[gl.FLOAT_MAT2x3] = 2;
    ROWS[gl.FLOAT_MAT2x4] = 2;
    ROWS[gl.FLOAT_MAT3x2] = 3;
    ROWS[gl.FLOAT_MAT3x4] = 3;
    ROWS[gl.FLOAT_MAT4x2] = 4;
    ROWS[gl.FLOAT_MAT4x3] = 4;
  }
  return ROWS[type] ?? 0;
}

const isSampler = (gl: WebGL2RenderingContext, t: number) =>
  ([gl.SAMPLER_2D, gl.SAMPLER_3D, gl.SAMPLER_CUBE, gl.SAMPLER_2D_SHADOW, gl.SAMPLER_2D_ARRAY, gl.SAMPLER_2D_ARRAY_SHADOW, gl.SAMPLER_CUBE_SHADOW, gl.INT_SAMPLER_2D, gl.INT_SAMPLER_3D, gl.INT_SAMPLER_CUBE, gl.INT_SAMPLER_2D_ARRAY, gl.UNSIGNED_INT_SAMPLER_2D, gl.UNSIGNED_INT_SAMPLER_3D, gl.UNSIGNED_INT_SAMPLER_CUBE, gl.UNSIGNED_INT_SAMPLER_2D_ARRAY] as number[]).includes(t);

/**
 * The source with its inactive preprocessor branches dropped (#define, #undef, #ifdef, #ifndef, #if,
 * #elif, #else, #endif with defined() and numeric conditions): three's chunks declare some varyings
 * with different types in different branches.
 */
function preprocess(src: string): string {
  const defs = new Map<string, string>([["GL_ES", "1"], ["__VERSION__", "300"], ["GL_FRAGMENT_PRECISION_HIGH", "1"]]);
  const out: string[] = [];
  const stack: { active: boolean; taken: boolean; parent: boolean }[] = [];
  const live = () => stack.every((s) => s.active);
  const test = (e: string): boolean => {
    let x = e.replace(/defined\s*\(\s*(\w+)\s*\)|defined\s+(\w+)/g, (_, a, b) => (defs.has(a ?? b) ? "1" : "0"));
    x = x.replace(/\b[A-Za-z_]\w*\b/g, (id) => {
      const v = defs.get(id)?.trim();
      return v === undefined ? "0" : /^-?[\d.]+$/.test(v) ? v : "1";
    });
    try {
      return !!Function(`return (${x});`)();
    } catch {
      return false;
    }
  };
  for (const line of src.split("\n")) {
    const m = line.match(/^\s*#\s*(\w+)\s*(.*)$/);
    if (!m) {
      if (live()) out.push(line);
      continue;
    }
    const d = m[1], rest = m[2].replace(/\/\*.*?\*\//g, "").replace(/\/\/.*$/, "").trim();
    if (d === "ifdef" || d === "ifndef" || d === "if") {
      const parent = live();
      const c = d === "ifdef" ? defs.has(rest.trim()) : d === "ifndef" ? !defs.has(rest.trim()) : test(rest);
      stack.push({ active: parent && c, taken: c, parent });
    } else if (d === "elif") {
      const s = stack[stack.length - 1];
      const c = !s.taken && test(rest);
      s.active = s.parent && c;
      s.taken ||= c;
    } else if (d === "else") {
      const s = stack[stack.length - 1];
      s.active = s.parent && !s.taken;
      s.taken = true;
    } else if (d === "endif") stack.pop();
    else if (live()) {
      if (d === "define") {
        const dm = rest.match(/^(\w+)(?:\s+(.*))?$/);
        if (dm) defs.set(dm[1], dm[2] ?? "");
      } else if (d === "undef") defs.delete(rest.trim());
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Varyings a fragment source reads: `in` (GLSL 3) or `varying` (three's GLSL 1 path) declarations used past their line. */
function fragInputs(raw: string): { decl: string; name: string; rows: number }[] {
  const src = preprocess(raw);
  const out: { decl: string; name: string; rows: number }[] = [];
  const seen = new Set<string>();
  // A lookbehind, not a consumed `;`: several declarations often share a line (`in vec2 vUv; flat in int vMat;`).
  const re = /(?<=^|[;{}])\s*((?:(?:flat|smooth|centroid|noperspective)\s+)*)(?:in|varying)\s+((?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*(\[\s*\d+\s*\])?\s*;/gm;
  for (const m of src.matchAll(re)) {
    const [, qual = "", , type, name, arr] = m;
    if (seen.has(name)) continue;
    seen.add(name);
    const used = new RegExp(`\\b${name}\\b`, "g");
    if ((src.match(used) ?? []).length < 2) continue;
    const n = arr ? Number(arr.replace(/\D/g, "")) : 1;
    const rows = (/^mat4/.test(type) ? 4 : /^mat3/.test(type) ? 3 : /^mat2/.test(type) ? 2 : 1) * n;
    out.push({ decl: `${qual.trim()} out ${type} ${name}${arr ?? ""};`.trim(), name, rows });
  }
  return out;
}

interface StageCount {
  vectors: number;
  samplers: number;
}

let lastError = "";
function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram | null {
  const mk = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const p = gl.createProgram()!;
  const a = mk(gl.VERTEX_SHADER, vs), b = mk(gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, a);
  gl.attachShader(p, b);
  gl.linkProgram(p);
  const ok = gl.getProgramParameter(p, gl.LINK_STATUS);
  if (!ok) lastError = `${gl.getShaderInfoLog(a) ?? ""} ${gl.getShaderInfoLog(b) ?? ""} ${gl.getProgramInfoLog(p) ?? ""}`.replace(/\s+/g, " ").slice(0, 240);
  gl.deleteShader(a);
  gl.deleteShader(b);
  if (!ok) {
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

function count(gl: WebGL2RenderingContext, p: WebGLProgram): StageCount {
  let vectors = 0, samplers = 0;
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const u = gl.getActiveUniform(p, i)!;
    if (isSampler(gl, u.type)) samplers += u.size;
    else vectors += rowsOf(gl, u.type) * u.size;
  }
  return { vectors, samplers };
}

const MIN_FS = `#version 300 es\nprecision highp float;\nout vec4 o_;\nvoid main(){ o_ = vec4(0.0); }`;

export interface ProgramLimits {
  name: string;
  vertex: StageCount | null;
  fragment: StageCount | null;
  varyings: number;
  over: string[];
}

export function programLimits(renderer: THREE.WebGLRenderer): { programs: ProgramLimits[]; max: Record<string, number>; over: ProgramLimits[] } {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const programs: ProgramLimits[] = [];
  for (const info of renderer.info.programs ?? []) {
    const prog = (info as unknown as { program: WebGLProgram; name: string; cacheKey: string }).program;
    const shaders = gl.getAttachedShaders(prog) ?? [];
    const vsS = shaders.find((s) => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.VERTEX_SHADER);
    const fsS = shaders.find((s) => gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER);
    if (!vsS || !fsS) continue;
    const vs = gl.getShaderSource(vsS) ?? "", fs = gl.getShaderSource(fsS) ?? "";
    // The vertex stage alone.
    const pv = link(gl, vs, MIN_FS);
    const vertex = pv ? count(gl, pv) : null;
    if (pv) gl.deleteProgram(pv);
    // The fragment stage alone: a vertex stage that only declares what it reads.
    const ins = fragInputs(fs);
    const minVs = `#version 300 es\nprecision highp float;\nprecision highp int;\n${ins.map((v) => v.decl).join("\n")}\nvoid main(){ gl_Position = vec4(0.0); }`;
    const pf = link(gl, minVs, fs);
    const fragment = pf ? count(gl, pf) : null;
    if (pf) gl.deleteProgram(pf);
    const varyings = ins.reduce((a, v) => a + v.rows, 0);
    const over: string[] = [];
    if (!vertex) over.push("vertex stage did not relink");
    else {
      if (vertex.vectors > 256) over.push(`vertex uniforms ${vertex.vectors} > 256`);
      if (vertex.samplers > 16) over.push(`vertex samplers ${vertex.samplers} > 16`);
    }
    if (!fragment) over.push(`fragment stage did not relink: ${lastError}`);
    else {
      if (fragment.vectors > 224) over.push(`fragment uniforms ${fragment.vectors} > 224`);
      if (fragment.samplers > 16) over.push(`fragment samplers ${fragment.samplers} > 16`);
    }
    if (varyings > 15) over.push(`varyings ${varyings} > 15`);
    if ((vertex?.samplers ?? 0) + (fragment?.samplers ?? 0) > 32) over.push("combined samplers > 32");
    programs.push({ name: (info as unknown as { name: string }).name || "", vertex, fragment, varyings, over });
  }
  const max = {
    vertexVectors: Math.max(0, ...programs.map((p) => p.vertex?.vectors ?? 0)),
    fragmentVectors: Math.max(0, ...programs.map((p) => p.fragment?.vectors ?? 0)),
    varyings: Math.max(0, ...programs.map((p) => p.varyings)),
    vertexSamplers: Math.max(0, ...programs.map((p) => p.vertex?.samplers ?? 0)),
    fragmentSamplers: Math.max(0, ...programs.map((p) => p.fragment?.samplers ?? 0)),
    programs: programs.length,
  };
  return { programs, max, over: programs.filter((p) => p.over.length) };
}

const BYTES: Record<number, number> = {
  [THREE.UnsignedByteType]: 1,
  [THREE.ByteType]: 1,
  [THREE.HalfFloatType]: 2,
  [THREE.FloatType]: 4,
  [THREE.UnsignedIntType]: 4,
  [THREE.IntType]: 4,
  [THREE.UnsignedShortType]: 2,
  [THREE.ShortType]: 2,
};
const CHANNELS: Record<number, number> = { [THREE.RGBAFormat]: 4, [THREE.RGFormat]: 2, [THREE.RedFormat]: 1, [THREE.DepthFormat]: 1, [THREE.AlphaFormat]: 1 };

/** Texture and render-target sizes and an estimate of the GPU memory in use (bytes, without driver padding). */
export function gpuMemory(scene: THREE.Scene, targets: THREE.WebGLRenderTarget[], extraTextures: (THREE.Texture | null | undefined)[]): Record<string, number | string> {
  const texSeen = new Set<THREE.Texture>();
  let texBytes = 0, rtBytes = 0, geoBytes = 0, maxDim = 0, maxName = "";
  const texture = (t: THREE.Texture | null | undefined) => {
    if (!t || texSeen.has(t)) return;
    texSeen.add(t);
    const img = t.image as { width?: number; height?: number; data?: ArrayBufferView } | undefined;
    const w = img?.width ?? 0, h = img?.height ?? 0;
    if (Math.max(w, h) > maxDim) {
      maxDim = Math.max(w, h);
      maxName = t.name || t.constructor.name;
    }
    texBytes += w * h * (CHANNELS[t.format] ?? 4) * (BYTES[t.type] ?? 1) * (t.generateMipmaps ? 4 / 3 : 1);
  };
  for (const rt of targets) {
    const n = rt.textures.length, s = Math.max(1, rt.samples);
    for (const t of rt.textures) {
      texSeen.add(t);
      const per = (CHANNELS[t.format] ?? 4) * (BYTES[t.type] ?? 1);
      rtBytes += rt.width * rt.height * per * (rt.samples > 0 ? s + 1 : 1);
      if (Math.max(rt.width, rt.height) > maxDim) {
        maxDim = Math.max(rt.width, rt.height);
        maxName = t.name || "render target";
      }
    }
    if (rt.depthBuffer || rt.depthTexture) rtBytes += rt.width * rt.height * 4 * (rt.samples > 0 ? s + 1 : 1) * (n > 0 ? 1 : 0);
    if (rt.depthTexture) texSeen.add(rt.depthTexture);
  }
  for (const t of extraTextures) texture(t);
  const bufSeen = new Set<ArrayBufferLike>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    const g = m.geometry as THREE.BufferGeometry | undefined;
    if (g?.attributes)
      for (const a of [...Object.values(g.attributes), g.index]) {
        const arr = (a as THREE.BufferAttribute | null)?.array as ArrayBufferView | undefined;
        if (arr && !bufSeen.has(arr.buffer)) {
          bufSeen.add(arr.buffer);
          geoBytes += arr.byteLength;
        }
      }
    const im = o as THREE.InstancedMesh;
    if (im.isInstancedMesh && !bufSeen.has(im.instanceMatrix.array.buffer)) {
      bufSeen.add(im.instanceMatrix.array.buffer);
      geoBytes += im.instanceMatrix.array.byteLength;
    }
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      const u = (mat as THREE.ShaderMaterial).uniforms;
      if (u) for (const v of Object.values(u)) if ((v?.value as THREE.Texture)?.isTexture) texture(v.value as THREE.Texture);
    }
  });
  const MB = (b: number) => +(b / 1048576).toFixed(1);
  return { renderTargetsMB: MB(rtBytes), texturesMB: MB(texBytes), geometryMB: MB(geoBytes), totalMB: MB(rtBytes + texBytes + geoBytes), largestTexture: maxDim, largestTextureName: maxName };
}
