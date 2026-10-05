#!/usr/bin/env node
/**
 * Time cold shader compiles on the real GPU (headless Chrome, fresh profile, ANGLE D3D11), one
 * program at a time, outside the game: link (until LINK_STATUS) and, with --mrt, the first draw
 * into a two-target framebuffer (ANGLE builds a pixel shader per output layout at that draw).
 *   node scripts/shadertime.mjs --dir=shots/boot-fix/before-real-progs --ids=24,25 [--mrt] [--hlsl]
 *   node scripts/shadertime.mjs --files=a.vert:a.frag,b.vert:b.frag [--mrt] [--parallel]
 * Sources are the final GLSL three.js passes to shaderSource (scripts/bootprobe.mjs --dump).
 * --hlsl writes ANGLE's translated HLSL next to each source (WEBGL_debug_shaders).
 * --parallel links all programs at once (the game's situation) instead of one after another.
 * Uses scripts/lib/harness.mjs: teardown on every exit path, GPU check.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, launchBrowser } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const MRT = argv.includes("--mrt"), HLSL = argv.includes("--hlsl"), PAR = argv.includes("--parallel");
const pairs = [];
if (arg("ids")) for (const id of arg("ids").split(",")) pairs.push([path.join(ROOT, arg("dir"), `${id}.vert`), path.join(ROOT, arg("dir"), `${id}.frag`)]);
for (const f of (arg("files", "") || "").split(",").filter(Boolean)) pairs.push(f.split(":").length === 2 ? f.split(":").map((p) => path.resolve(ROOT, p)) : [f, f]);
if (!pairs.length) await bye(1, "nothing to compile: --ids with --dir, or --files=a.vert:a.frag");
const progs = [];
for (const [v, f] of pairs) progs.push({ name: path.basename(f), vs: await fs.readFile(v, "utf8"), fs: await fs.readFile(f, "utf8"), vPath: v, fPath: f });

const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio", "--disable-gpu-shader-disk-cache", "--enable-privileged-webgl-extensions"]);
const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
page.on("console", (m) => /WebGL|GL_/.test(m.text()) && console.log(`[console] ${m.text().slice(0, 300)}`));
await page.goto("about:blank");
await assertGpu(page);
const res = await page.evaluate(async ({ progs, MRT, HLSL, PAR }) => {
  const cv = document.createElement("canvas");
  const gl = cv.getContext("webgl2");
  gl.getExtension("KHR_parallel_shader_compile");
  gl.getExtension("EXT_color_buffer_half_float");
  gl.getExtension("EXT_color_buffer_float");
  const dbg = gl.getExtension("WEBGL_debug_shaders");
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  for (let i = 0; i < 2; i++) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 4, 4);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
  }
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
  // Left bound, an attachment would sit on unit 0 under the samplers: a feedback loop, no draw.
  gl.bindTexture(gl.TEXTURE_2D, null);
  const now = () => performance.now();
  const make = (p) => {
    const prog = gl.createProgram();
    const sh = [[gl.VERTEX_SHADER, p.vs], [gl.FRAGMENT_SHADER, p.fs]].map(([type, src]) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      gl.attachShader(prog, s);
      return s;
    });
    p.t0 = now();
    gl.linkProgram(prog);
    return { prog, sh };
  };
  const finish = (p, { prog, sh }) => {
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return { name: p.name, error: (gl.getProgramInfoLog(prog) || "") + sh.map((s) => gl.getShaderInfoLog(s)).join("\n") };
    const link = Math.round(now() - p.t0);
    let draw = -1, err = 0;
    if (MRT) {
      gl.useProgram(prog);
      // Every sampler on its own unit (mixed sampler types on one unit fail the draw) and integer
      // attributes fed integer defaults, so the draw reaches the driver.
      const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (let i = 0, unit = 0; i < n; i++) {
        const u = gl.getActiveUniform(prog, i);
        if (/SAMPLER/.test(Object.keys(WebGL2RenderingContext).find((k) => WebGL2RenderingContext[k] === u.type && /SAMPLER/.test(k)) ?? "")) {
          const loc = gl.getUniformLocation(prog, u.name);
          gl.uniform1iv(loc, Array.from({ length: u.size }, () => unit++));
        }
      }
      const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
      for (let i = 0; i < na; i++) {
        const a = gl.getActiveAttrib(prog, i), loc = gl.getAttribLocation(prog, a.name);
        if ([gl.INT, gl.INT_VEC2, gl.INT_VEC3, gl.INT_VEC4].includes(a.type)) gl.vertexAttribI4i(loc, 0, 0, 0, 0);
        else if ([gl.UNSIGNED_INT, gl.UNSIGNED_INT_VEC2, gl.UNSIGNED_INT_VEC3, gl.UNSIGNED_INT_VEC4].includes(a.type)) gl.vertexAttribI4ui(loc, 0, 0, 0, 0);
      }
      gl.getError();
      const s = now();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      err = gl.getError();
      draw = Math.round(now() - s);
    }
    const hlsl = HLSL && dbg ? sh.map((s) => dbg.getTranslatedShaderSource(s)) : null;
    return { name: p.name, link, draw, err, fbo: gl.checkFramebufferStatus(gl.FRAMEBUFFER), hlsl };
  };
  const out = [];
  if (PAR) {
    const made = progs.map(make);
    // Wait for every link without blocking (as the game's warm-up does), then time the draws.
    for (;;) {
      const left = made.filter((m, i) => !progs[i].done && !(gl.getProgramParameter(m.prog, 0x91b1) && (progs[i].done = now())));
      if (!left.length) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    made.forEach((m, i) => out.push({ ...finish(progs[i], m), ready: Math.round(progs[i].done - progs[i].t0) }));
  } else for (const p of progs) out.push(finish(p, make(p)));
  return out;
}, { progs: progs.map(({ name, vs, fs }) => ({ name, vs, fs })), MRT, HLSL, PAR });
for (const [i, r] of res.entries()) {
  if (r.error) console.log(`${r.name}: LINK FAILED ${r.error.slice(0, 1500)}`);
  else console.log(`${r.name.padEnd(28)} link ${String(r.link).padStart(6)} ms${r.ready !== undefined ? ` (ready after ${r.ready} ms)` : ""}${MRT ? `   first MRT draw ${String(r.draw).padStart(6)} ms${r.err ? ` (GL error 0x${r.err.toString(16)})` : ""}${r.fbo !== 0x8cd5 ? ` (framebuffer 0x${r.fbo.toString(16)})` : ""}` : ""}`);
  if (r.hlsl) {
    await fs.writeFile(progs[i].vPath + ".hlsl", r.hlsl[0] ?? "");
    await fs.writeFile(progs[i].fPath + ".hlsl", r.hlsl[1] ?? "");
  }
}
await bye(0);
