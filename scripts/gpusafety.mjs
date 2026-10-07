#!/usr/bin/env node
/**
 * Phone GPU safety (DECISIONS.md, "Mobile"), in Playwright mobile emulation on the real GPU:
 * - every program the phone tier links, against the WebGL 2 minimum limits (224 fragment and 256
 *   vertex uniform vectors, 15 varyings, 16 texture units per stage: `__ride.mobile.limits()`);
 * - the largest texture or render target (at most 4096) and the GPU memory of the render targets,
 *   textures and geometry (`__ride.mobile.memory()`), against iOS Safari's roughly 1 GB per tab;
 * - the fallbacks: 8-bit colour targets where half floats can't be rendered (?nofloat=1), and plain
 *   painted water when the sea's program fails (?seafail). Each must draw a sea that isn't black.
 *   node scripts/gpusafety.mjs [--devices=pixel4a,iphone15] [--out=shots/mobile/safety]
 * Exits 1 on a program over a limit, a texture over 4096, a black sea or an unexpected error.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devices } from "playwright";
import { assertGpu, bye, launchBrowser, seaLuma, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const OUT = path.join(ROOT, arg("out", "shots/mobile/safety"));
const DEVS = { pixel4a: "Pixel 4a (5G) landscape", iphone15: "iPhone 15 landscape" };
const want = arg("devices", "pixel4a,iphone15").split(",").filter(Boolean);
await fs.mkdir(OUT, { recursive: true });
await fs.access(path.join(ROOT, "dist", "index.html")).catch(() => bye(1, "dist/ missing: run `pnpm build` first"));
const URL = await serve(ROOT, "preview");
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const failures = [];
const report = {};
let checked = false;

/** One load: errors (minus the ones `expect` allows), the sea's luma, and whatever `extra` reads. */
async function load(ctx, tag, q, expect = null, extra = async () => ({})) {
  const page = await ctx.newPage();
  const errors = [], warns = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "warning") warns.push(t.slice(0, 200));
    if (m.type() === "error" && !(expect && expect.test(t))) errors.push(t.slice(0, 300));
  });
  await page.goto(`${URL}${q}`, { waitUntil: "load" });
  if (!checked) {
    await assertGpu(page);
    checked = true;
  }
  await page.waitForFunction(() => window.__ride?.ready === true, null, { timeout: 400_000, polling: 200 });
  await page.waitForTimeout(1500);
  const png = await page.screenshot({ path: path.join(OUT, `${tag}.png`) });
  const sea = await seaLuma(page, png);
  const out = { sea, errors, warns, ...(await extra(page)) };
  await page.close();
  const night = q.includes("tod=night");
  if (sea.n < 8) failures.push(`${tag}: too little sea in frame to judge (${sea.n} points)`);
  else if (sea.nan > 0.01 || (!night && (sea.median < 40 || sea.dark > 0.05)) || (night && sea.median < 6))
    failures.push(`${tag}: sea median luma ${sea.median.toFixed(0)}, near-black ${(sea.dark * 100).toFixed(0)}%, pure-black ${(sea.nan * 100).toFixed(1)}%`);
  if (errors.length) failures.push(`${tag}: ${errors.length} console error(s): ${errors.slice(0, 2).join(" | ")}`);
  console.log(`${tag.padEnd(22)} sea median luma ${sea.median?.toFixed(0) ?? "-"} (${sea.n} pts), ${errors.length} errors`);
  return out;
}

for (const dk of want) {
  const { defaultBrowserType: _, ...d } = devices[DEVS[dk]];
  const ctx = await browser.newContext({ ...d });
  const main = await load(ctx, `${dk}_tier`, "?skipintro=1&tod=golden", null, async (page) =>
    page.evaluate(() => {
      const m = window.__ride.mobile;
      return { tier: m.tier, caps: m.caps, limits: m.limits(), memory: m.memory() };
    }),
  );
  const { limits, memory, caps } = main;
  console.log(`${dk}: ${limits.max.programs} programs; most vertex uniform vectors ${limits.max.vertexVectors} (min limit 256), fragment ${limits.max.fragmentVectors} (224), varyings ${limits.max.varyings} (15), samplers ${limits.max.vertexSamplers} vertex / ${limits.max.fragmentSamplers} fragment (16)`);
  for (const p of limits.over) {
    console.log(`  OVER ${p.name}: ${p.over.join("; ")}`);
    failures.push(`${dk} ${p.name}: ${p.over.join("; ")}`);
  }
  console.log(`${dk}: GPU memory ${memory.totalMB} MB (targets ${memory.renderTargetsMB}, textures ${memory.texturesMB}, geometry ${memory.geometryMB}); largest texture ${memory.largestTexture} (${memory.largestTextureName}); max texture size ${caps.maxTexture}; half-float targets ${caps.halfFloat ? "yes" : "no"}, MSAA samples ${caps.samplesHalf}/${caps.samples8}`);
  if (memory.largestTexture > 4096) failures.push(`${dk}: a texture or target is ${memory.largestTexture} px (over 4096)`);
  if (memory.totalMB > 512) failures.push(`${dk}: GPU memory ${memory.totalMB} MB (over half of iOS Safari's ~1 GB)`);
  report[dk] = { tier: main.tier, caps, max: limits.max, over: limits.over, programs: limits.programs, memory, sea: main.sea };
  if (dk === want[0]) {
    // GPUs without EXT_color_buffer_float: every colour target falls back to 8 bits.
    const nf = await load(ctx, `${dk}_nofloat_golden`, "?skipintro=1&tod=golden&nofloat=1", null, async (page) => page.evaluate(() => window.__ride.mobile.caps));
    if (nf.halfFloat) failures.push(`${dk} nofloat: still rendering to half floats`);
    const nfn = await load(ctx, `${dk}_nofloat_night`, "?skipintro=1&tod=night&nofloat=1");
    // A sea program the GPU refuses: the forced #error is the expected shader error; the game warns and draws plain water.
    const sf = await load(ctx, `${dk}_seafail`, "?skipintro=1&tod=golden&seafail", /forced sea failure|THREE\.WebGLProgram|Shader Error|VALIDATE_STATUS|LINK_STATUS|COMPILE_STATUS/);
    if (!sf.warns.some((w) => /plain painted water/.test(w))) failures.push(`${dk} seafail: no fallback warning (${sf.warns.slice(0, 2).join(" | ")})`);
    report.fallbacks = { nofloat: { caps: nf, sea: nf.sea, night: nfn.sea }, seafail: { sea: sf.sea, warns: sf.warns } };
  }
  await ctx.close();
}

await fs.writeFile(path.join(OUT, "safety.json"), JSON.stringify(report, null, 1));
console.log(path.join(OUT, "safety.json"));
if (failures.length) {
  console.error("\nCHECKS FAILED:");
  for (const f of failures) console.error("  " + f);
}
await bye(failures.length ? 1 : 0);
