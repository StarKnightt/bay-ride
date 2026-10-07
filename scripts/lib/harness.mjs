/**
 * Shared harness for scripts that start a server or a browser (see the user's Cursor rules
 * background-processes.mdc and gpu-rendering.mdc):
 * - teardown on every exit path (normal end, SIGINT, SIGTERM, uncaughtException, unhandledRejection)
 *   closes the browser and any server; servers run in-process, so nothing is spawned or detached;
 * - headless installed Chrome (bundled Chromium fallback) on the discrete GPU (ANGLE/D3D11), with the WebGL renderer string printed on
 *   every run and a loud failure on a software rasteriser (opt out with --allow-software);
 * - shader compile/link errors are fatal;
 * - no browser starts while .gauntlet/GPU_PAUSE exists, and one running when it appears is closed
 *   (exit 3).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

/** While this file exists (the user is gaming or recording) no browser may run on the GPU. */
const GPU_PAUSE = fileURLToPath(new URL("../../.gauntlet/GPU_PAUSE", import.meta.url));

export const GPU_ARGS = [
  "--use-angle=d3d11",
  "--use-gl=angle",
  "--enable-gpu",
  "--enable-gpu-rasterization",
  "--ignore-gpu-blocklist",
  "--force_high_performance_gpu",
];
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const SHADER_ERROR = /THREE\.WebGLProgram: Shader Error|THREE\.WebGLShader|LINK_STATUS|COMPILE_STATUS|VALIDATE_STATUS false/;

const owned = { browser: null, servers: [] };
let closing = null;

async function closeAll() {
  try { await owned.browser?.close(); } catch {}
  owned.browser = null;
  for (const s of owned.servers.splice(0)) {
    try { await s.close(); } catch {}
  }
}

/** Close everything we own, then exit. Safe to call more than once. */
export function bye(code, why) {
  if (why) console.error("[teardown]", why instanceof Error ? why.stack || why.message : why);
  closing ??= closeAll().finally(() => process.exit(code));
  return closing;
}

process.on("SIGINT", () => bye(130, "interrupted"));
process.on("SIGTERM", () => bye(143, "terminated"));
process.on("uncaughtException", (e) => bye(1, e));
process.on("unhandledRejection", (e) => bye(1, e));

/** Register a server (anything with close()) so teardown stops it. */
export function own(server) {
  owned.servers.push(server);
  return server;
}

/**
 * The user's installed Google Chrome, headless on the discrete GPU; bundled Chromium only if Chrome
 * fails to launch. Logs which one is used; closed by teardown.
 */
export async function launchBrowser(extraArgs = []) {
  if (existsSync(GPU_PAUSE)) await bye(3, `GPU paused (${GPU_PAUSE} exists): no browser started`);
  // A pause that starts mid-run closes the browser within a second.
  setInterval(() => existsSync(GPU_PAUSE) && bye(3, "GPU pause signalled: browser closed"), 1000).unref();
  const opts = { headless: true, args: [...GPU_ARGS, ...extraArgs] };
  try {
    owned.browser = await chromium.launch({ ...opts, channel: "chrome" });
    console.log(`[browser] installed Google Chrome ${owned.browser.version()}`);
  } catch (e) {
    console.warn(`[browser] installed Chrome failed to launch (${String(e?.message ?? e).split("\n")[0]}); falling back to bundled Chromium`);
    owned.browser = await chromium.launch({ ...opts, channel: "chromium" });
    console.log(`[browser] bundled Chromium ${owned.browser.version()}`);
  }
  return owned.browser;
}

/** Print the unmasked WebGL renderer; tear down and fail on a software rasteriser. */
export async function assertGpu(page, allowSoftware = process.argv.includes("--allow-software")) {
  const renderer = await page.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
    return gl ? (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown (no debug_renderer_info)") : "no webgl2";
  });
  console.log(`[gpu] ${renderer}`);
  if (SOFTWARE.test(renderer) || /^no webgl2|^unknown/.test(renderer)) {
    if (allowSoftware) console.warn("[gpu] not a hardware renderer; continuing because --allow-software was given");
    else await bye(1, new Error(`not a hardware GPU renderer: ${renderer}`));
  }
  return renderer;
}

/** Make shader compile/link errors on this page fatal (after teardown). */
export function fatalShaderErrors(page, tag = "page") {
  page.on("console", (m) => {
    if (m.type() === "error" && SHADER_ERROR.test(m.text())) bye(1, `[${tag}] shader error: ${m.text().slice(0, 2000)}`);
  });
}

/**
 * The open sea in a screenshot: the game's probe points whose view ray reaches open water
 * unoccluded (`__ride.seaProbe()`), each sampled 3x3 in the PNG. `median` of the means, `dark` the
 * share under luma 18, `nan` the share with a pure-black (NaN) pixel; `n` points (under 8: too
 * little sea in frame to judge).
 */
export async function seaLuma(page, png) {
  const pts = await page.evaluate(() => window.__ride.seaProbe?.() ?? []);
  if (pts.length < 8) return { n: pts.length };
  const lum = await page.evaluate(async ({ b64, pts }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const out = [];
    for (const [u, v] of pts) {
      const x = Math.min(img.width - 2, Math.max(1, Math.round(u * img.width)));
      const y = Math.min(img.height - 2, Math.max(1, Math.round(v * img.height)));
      const d = g.getImageData(x - 1, y - 1, 3, 3).data;
      let s = 0, mn = 255;
      for (let i = 0; i < 36; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        s += l;
        mn = Math.min(mn, l);
      }
      out.push([s / 9, mn]);
    }
    return out;
  }, { b64: png.toString("base64"), pts });
  const mean = lum.map((l) => l[0]).sort((a, b) => a - b);
  return {
    n: lum.length,
    median: mean[mean.length >> 1],
    dark: mean.filter((l) => l < 18).length / mean.length,
    nan: lum.filter((l) => l[1] < 2).length / lum.length,
  };
}

/**
 * Serve the game in this process (attached; stopped by teardown). mode "dev" serves the current
 * sources, "preview" serves dist/ (run `pnpm build` first), or `outDir` (another build, e.g. a saved
 * copy of master's for before/after captures). Returns the base URL.
 */
export async function serve(root, mode = "dev", port = 5440, outDir = "dist") {
  const vite = await import("vite");
  if (mode === "preview") {
    const srv = own(await vite.preview({ root, logLevel: "error", build: { outDir }, preview: { port, strictPort: false } }));
    return srv.resolvedUrls.local[0];
  }
  const srv = own(await vite.createServer({ root, logLevel: "error", server: { port, strictPort: false } }));
  await srv.listen();
  return srv.resolvedUrls.local[0];
}
