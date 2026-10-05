#!/usr/bin/env node
/**
 * Capture the fixed comparison shots on the real GPU (headless ANGLE/D3D11), one page per shot x
 * time of day x resolution, and log console errors. By default it serves the built game itself
 * (in-process vite preview of dist/, so run `pnpm build` first) and stops it on exit:
 *   node scripts/shoot.mjs --out=shots/sky-r1 [--tods=golden,night] [--shots=1,2] [--t=12]
 * --serve=dev serves the current sources instead (no build needed); --url=http://... uses a server
 * you started yourself (it is left alone).
 * --res=1920x1080,1536x864 captures at each viewport size (default 1920x1080); --dpr=1,1.25 at each
 * device scale factor (default 1). Files get a _<W>x<H>[@dpr] suffix when more than one is given.
 * --t takes a comma list for a motion sequence (frozen at each time, files suffixed _t<seconds>):
 *   node scripts/shoot.mjs --out=shots/seq --tods=noon --shots=1 --t=10,10.5,11,11.5,12
 *   add --fps to also sample frame rate live: the opening with her walking off along the pier
 *   (autoplay), then a few fixed views over the open water.
 * --extra=boat=1 appends query parameters to every page (the scripted boat course, see SHOTS.md).
 * --variants="a=1|a=2" captures every shot once per variant query (files suffixed _v<i>), e.g. to
 *   compare framings of the opening with ?spawn=x,z,yaw and ?orbit=rel,pitch,dist.
 * Shot tokens besides 1..5: cam:<mode> captures the boat course from the ride camera in that mode
 * (implies boat=1); `open` is the game's opening view (where play starts, frozen at t); `intro` is
 * the start screen waiting for its first click (the opening view behind a breathing dash).
 * Guards (fatal unless --noguard): every capture samples the open sea in the frame and fails if it
 * is near-black at a non-night preset or has pure-black (NaN) patches at any preset; any shader
 * warning or error in the browser console fails the run. Prints the WebGL renderer on every run and
 * fails on a software rasteriser (--allow-software to override).
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
const GUARD = !argv.includes("--noguard");
const SERVE = arg("serve", "preview");
const EXTRA = arg("extra", "") ? `&${arg("extra", "")}` : "";
const VARIANTS = arg("variants", "").split("|").filter(Boolean);
const RES = arg("res", "1920x1080").split(",").filter(Boolean).map((r) => r.split("x").map(Number));
const DPRS = arg("dpr", "1").split(",").filter(Boolean).map(Number);

await fs.mkdir(OUT, { recursive: true });
let URL = arg("url", "");
if (!URL) {
  if (SERVE === "preview") await fs.access(path.join(ROOT, "dist", "index.html")).catch(() => bye(1, "dist/ missing: run `pnpm build` first, or pass --serve=dev"));
  URL = await serve(ROOT, SERVE);
  console.log(`[serve] ${SERVE} ${URL}`);
}
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const errors = [];
const failures = [];
const SHADER_WARN = /warning X\d{4}|Program Info Log|Shader Info Log|THREE\.WebGLProgram|THREE\.WebGLShader/;
const watch = (page, tag) => {
  fatalShaderErrors(page, tag);
  page.on("pageerror", (e) => errors.push(`[${tag}] pageerror: ${e.message}`));
  page.on("console", (m) => {
    const txt = m.text();
    if (SHADER_WARN.test(txt)) failures.push(`[${tag}] shader ${m.type()}: ${txt.slice(0, 600)}`);
    else if (m.type() === "error" || m.type() === "warning") errors.push(`[${tag}] ${m.type()}: ${txt}`);
  });
};

/**
 * Sea guard: the game reports screen points whose view ray reaches open water unoccluded
 * (`__ride.seaProbe()`); sample those pixels of the screenshot. Fails a capture whose sea is
 * near-black in daylight, or that has pure-black specks or patches (NaN) at any preset.
 */
async function seaGuard(page, png, tag, tod) {
  const pts = await page.evaluate(() => window.__ride.seaProbe?.() ?? []);
  if (pts.length < 8) return `${tag}: sea ${pts.length} probe points (not enough sea in frame to check)`;
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
  const med = mean[mean.length >> 1];
  const nan = lum.filter((l) => l[1] < 2).length / lum.length;
  const dark = mean.filter((l) => l < 18).length / mean.length;
  const night = tod === "night";
  const msg = `${tag}: sea median luma ${med.toFixed(0)}, near-black ${(dark * 100).toFixed(0)}%, pure-black ${(nan * 100).toFixed(1)}% (${lum.length} pts)`;
  if (nan > 0.01 || (!night && (med < 40 || dark > 0.05)) || (night && med < 6)) return `FAIL ${msg}`;
  return msg;
}

let gpuChecked = false;
for (const [W, H] of RES) for (const dpr of DPRS) {
  const sfx = (RES.length > 1 || DPRS.length > 1 ? `_${W}x${H}` : "") + (DPRS.length > 1 || dpr !== 1 ? `@${dpr}` : "");
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: dpr });
  for (const tod of TODS) {
    for (const s of SHOTS) for (const T of TS) for (const [vi, vq] of (VARIANTS.length ? VARIANTS : [""]).entries()) {
      const cam = s.startsWith("cam:") ? s.slice(4) : null;
      const name = cam ? `cam-${cam}` : s === "open" || s === "intro" ? s : `shot${s}`;
      const tag = `${name}_${tod}` + (TS.length > 1 ? `_t${T}` : "") + (VARIANTS.length ? `_v${vi}` : "") + sfx;
      const page = await ctx.newPage();
      watch(page, tag);
      const t0 = Date.now();
      const q = cam ? `?boat=1&cam=${cam}&skipintro=1&t=${T}` : s === "open" ? `?skipintro=1&t=${T}` : s === "intro" ? `?t=${T}` : `?shot=${s}&t=${T}`;
      await page.goto(`${URL}${q}&tod=${tod}${s === "open" || s === "intro" ? "" : "&hud=0"}${EXTRA}${vq ? `&${vq}` : ""}`, { waitUntil: "load" });
      if (!gpuChecked) { await assertGpu(page); gpuChecked = true; }
      if (s === "intro") {
        await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 300_000, polling: 100 });
        await page.waitForTimeout(2200);
      } else await page.waitForFunction(() => window.__ready === true, null, { timeout: 300_000, polling: 100 });
      const png = await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
      const st = await page.evaluate(() => window.__ride.stats());
      let g = "";
      if (GUARD && s !== "intro") {
        g = await seaGuard(page, png, tag, tod);
        if (g.startsWith("FAIL")) failures.push(g);
        g = "  " + g.slice(g.indexOf(": sea") + 2);
      }
      console.log(`${tag.padEnd(22)} calls=${st.sceneCalls} tris=${(st.sceneTris / 1e6).toFixed(2)}M  ${((Date.now() - t0) / 1000).toFixed(1)}s${g}`);
      await page.close();
    }
  }
  await ctx.close();
}
if (FPS) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  watch(page, "fps");
  await page.goto(`${URL}?autoplay=1&skipintro=1&tod=golden`, { waitUntil: "load" });
  if (!gpuChecked) { await assertGpu(page); gpuChecked = true; }
  await page.waitForFunction(() => window.__ride?.ready === true, null, { timeout: 300_000 });
  await page.waitForTimeout(8000);
  const log = await page.evaluate(() => window.__ride.fpsLog);
  const st = await page.evaluate(() => window.__ride.stats());
  console.log(`fps (headless, not vsync-locked): ${log.join(",")}  calls=${st.sceneCalls} tris=${(st.sceneTris / 1e6).toFixed(2)}M`);
  await page.screenshot({ path: path.join(OUT, "walk_golden.png") });
  await page.close();
  // Live (unfrozen) fixed views over the open water, where the sea fills most of the frame;
  // `open` is the live opening view (standing on the pier end).
  const views = arg("fpsviews", "open:golden,4:golden,4:night,5:noon,3:night").split(",").filter(Boolean).map((v) => v.split(":"));
  for (const [s, tod] of views) {
    const p = await ctx.newPage();
    watch(p, `fps shot${s}`);
    const q = s === "open" ? "?skipintro=1" : `?shot=${s}&hud=0`;
    await p.goto(`${URL}${q}&tod=${tod}${EXTRA}`, { waitUntil: "load" });
    if (s === "open") await p.waitForFunction(() => window.__ride?.ready === true, null, { timeout: 300_000, polling: 100 });
    else await p.waitForFunction(() => window.__ready === true, null, { timeout: 300_000, polling: 100 });
    await p.waitForTimeout(5000);
    const l = await p.evaluate(() => window.__ride.fpsLog);
    console.log(`fps ${s === "open" ? "open" : "shot" + s}_${tod}${EXTRA} (live): ${l.slice(-4).join(",")}`);
    await p.close();
  }
  await ctx.close();
}
if (errors.length) {
  console.error("\nPage errors/warnings:");
  for (const e of [...new Set(errors)].slice(0, 40)) console.error("  " + e);
}
if (failures.length) {
  console.error("\nGUARD FAILURES (sea darkness / shader warnings):");
  for (const e of [...new Set(failures)].slice(0, 40)) console.error("  " + e);
}
await bye(errors.length || failures.length ? 1 : 0);
