#!/usr/bin/env node
/**
 * Capture the fixed comparison shots at 1920x1080 on the real GPU (headless ANGLE/D3D11), one page
 * per shot x time of day, and log console errors. Needs a running dev or preview server.
 *   node scripts/shoot.mjs --url=http://localhost:5430/ --out=shots/sky-r1 [--tods=golden,night] [--shots=1,2] [--t=12]
 *   add --fps to also sample frame rate in a normal (unfrozen) autoplay ride.
 */
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const URL = arg("url", "http://localhost:5430/");
const OUT = path.join(ROOT, arg("out", "shots/latest"));
const TODS = arg("tods", "morning,noon,golden,sunset,dusk,night").split(",").filter(Boolean);
const SHOTS = arg("shots", "1,2,3,4,5").split(",").filter(Boolean);
const T = arg("t", "12");
const FPS = argv.includes("--fps");
const W = 1920, H = 1080;
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;

await fs.mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  args: ["--use-angle=d3d11", "--use-gl=angle", "--enable-gpu", "--ignore-gpu-blocklist", "--force_high_performance_gpu", "--hide-scrollbars", "--mute-audio"],
});
const errors = [];
const watch = (page, tag) => {
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    const txt = m.text();
    if (/warning X\d{4}/.test(txt)) return;
    if (m.type() === "error" || m.type() === "warning") errors.push(`[${tag}] ${m.type()}: ${txt}`);
  });
};
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  let gpuChecked = false;
  for (const tod of TODS) {
    for (const s of SHOTS) {
      const tag = `shot${s}_${tod}`;
      const page = await ctx.newPage();
      watch(page, tag);
      const t0 = Date.now();
      await page.goto(`${URL}?shot=${s}&tod=${tod}&t=${T}&hud=0`, { waitUntil: "load" });
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 120_000, polling: 100 });
      if (!gpuChecked) {
        const gpu = await page.evaluate(() => {
          const gl = document.querySelector("canvas").getContext("webgl2");
          const ext = gl.getExtension("WEBGL_debug_renderer_info");
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
        });
        console.log(`[gpu] ${gpu}`);
        if (SOFTWARE.test(String(gpu))) throw new Error(`software renderer: ${gpu}`);
        gpuChecked = true;
      }
      await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
      const st = await page.evaluate(() => window.__ride.stats());
      console.log(`${tag.padEnd(16)} calls=${st.sceneCalls} tris=${(st.sceneTris / 1e6).toFixed(2)}M  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      await page.close();
    }
  }
  if (FPS) {
    const page = await ctx.newPage();
    watch(page, "fps");
    await page.goto(`${URL}?autoplay=1&skipintro=1&tod=golden`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__ride?.ready === true, null, { timeout: 120_000 });
    await page.waitForTimeout(8000);
    const log = await page.evaluate(() => window.__ride.fpsLog);
    const st = await page.evaluate(() => window.__ride.stats());
    console.log(`fps (headless, not vsync-locked): ${log.join(",")}  calls=${st.sceneCalls} tris=${(st.sceneTris / 1e6).toFixed(2)}M`);
    await page.screenshot({ path: path.join(OUT, "autoplay_golden.png") });
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.error("\nPage errors/warnings:");
  for (const e of [...new Set(errors)].slice(0, 40)) console.error("  " + e);
  process.exitCode = 1;
}
