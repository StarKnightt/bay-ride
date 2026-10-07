/**
 * Shared harness for scripts that start a server or a browser (see the user's Cursor rules
 * background-processes.mdc and gpu-rendering.mdc):
 * - teardown on every exit path (normal end, SIGINT, SIGTERM, uncaughtException, unhandledRejection)
 *   closes the browser and any server; servers run in-process, so nothing is spawned or detached;
 * - headless installed Chrome (bundled Chromium fallback) on the discrete GPU (ANGLE/D3D11), with the WebGL renderer string printed on
 *   every run and a loud failure on a software rasteriser (opt out with --allow-software);
 * - shader compile/link errors are fatal.
 */
import { chromium } from "playwright";

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
