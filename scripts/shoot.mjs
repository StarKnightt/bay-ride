#!/usr/bin/env node
/**
 * Capture the fixed comparison shots at 1920x1080 on the real GPU (headless ANGLE/D3D11), one page
 * per shot x time of day, and log console errors. By default it serves the built game itself
 * (in-process vite preview of dist/, so run `pnpm build` first) and stops it on exit:
 *   node scripts/shoot.mjs --out=shots/sky-r1 [--tods=golden,night] [--shots=1,2] [--t=12]
 * --serve=dev serves the current sources instead (no build needed); --url=http://... uses a server
 * you started yourself (it is left alone).
 * --t takes a comma list for a motion sequence (frozen at each time, files suffixed _t<seconds>):
 *   node scripts/shoot.mjs --out=shots/seq --tods=noon --shots=1 --t=10,10.5,11,11.5,12
 *   add --fps to also sample frame rate in a normal (unfrozen) autoplay ride.
 * Prints the WebGL renderer on every run and fails on a software rasteriser (--allow-software to
 * override) or on any shader compile/link error.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const OUT = path.join(ROOT, arg("out", "shots/latest"));
const TODS = arg("tods", "morning,noon,golden,sunset,dusk,night").split(",").filter(Boolean);
const SHOTS = arg("shots", "1,2,3,4,5").split(",").filter(Boolean);
const TS = arg("t", "12").split(",").filter(Boolean);
const FPS = argv.includes("--fps");
const SERVE = arg("serve", "preview");
const W = 1920, H = 1080;

await fs.mkdir(OUT, { recursive: true });
let URL = arg("url", "");
if (!URL) {
  if (SERVE === "preview") await fs.access(path.join(ROOT, "dist", "index.html")).catch(() => bye(1, "dist/ missing: run `pnpm build` first, or pass --serve=dev"));
  URL = await serve(ROOT, SERVE);
  console.log(`[serve] ${SERVE} ${URL}`);
}
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const errors = [];
const watch = (page, tag) => {
  fatalShaderErrors(page, tag);
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    const txt = m.text();
    if (/warning X\d{4}/.test(txt)) return;
    if (m.type() === "error" || m.type() === "warning") errors.push(`[${tag}] ${m.type()}: ${txt}`);
  });
};

const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
let gpuChecked = false;
for (const tod of TODS) {
  for (const s of SHOTS) for (const T of TS) {
    const tag = `shot${s}_${tod}` + (TS.length > 1 ? `_t${T}` : "");
    const page = await ctx.newPage();
    watch(page, tag);
    const t0 = Date.now();
    await page.goto(`${URL}?shot=${s}&tod=${tod}&t=${T}&hud=0`, { waitUntil: "load" });
    if (!gpuChecked) { await assertGpu(page); gpuChecked = true; }
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 120_000, polling: 100 });
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
  if (!gpuChecked) { await assertGpu(page); gpuChecked = true; }
  await page.waitForFunction(() => window.__ride?.ready === true, null, { timeout: 120_000 });
  await page.waitForTimeout(8000);
  const log = await page.evaluate(() => window.__ride.fpsLog);
  const st = await page.evaluate(() => window.__ride.stats());
  console.log(`fps (headless, not vsync-locked): ${log.join(",")}  calls=${st.sceneCalls} tris=${(st.sceneTris / 1e6).toFixed(2)}M`);
  await page.screenshot({ path: path.join(OUT, "autoplay_golden.png") });
  await page.close();
  // Live (unfrozen) fixed views over the open water, where the sea fills most of the frame.
  const views = arg("fpsviews", "4:golden,4:night,5:noon,3:night").split(",").filter(Boolean).map((v) => v.split(":"));
  for (const [s, tod] of views) {
    const p = await ctx.newPage();
    watch(p, `fps shot${s}`);
    await p.goto(`${URL}?shot=${s}&tod=${tod}&hud=0`, { waitUntil: "load" });
    await p.waitForFunction(() => window.__ready === true, null, { timeout: 120_000, polling: 100 });
    await p.waitForTimeout(5000);
    const l = await p.evaluate(() => window.__ride.fpsLog);
    console.log(`fps shot${s}_${tod} (live): ${l.slice(-4).join(",")}`);
    await p.close();
  }
}
if (errors.length) {
  console.error("\nPage errors/warnings:");
  for (const e of [...new Set(errors)].slice(0, 40)) console.error("  " + e);
}
await bye(errors.length ? 1 : 0);
