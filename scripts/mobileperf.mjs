#!/usr/bin/env node
/**
 * The phone performance proxy (DECISIONS.md, "Mobile"), in Playwright mobile emulation on the RTX 4060:
 * - GPU: the whole frame's GPU time (one timer query round shadows, mirror, scene and post: `?gpums`
 *   with a fixed `?res=`), each frame led by the GPU filler so the query times the GPU's own work and
 *   not its waits for commands still being issued (render/profiler.ts). Phone GPU ms = that x RATIO,
 *   the RTX 4060 over the phone GPU in 3DMark Wild Life Extreme: Mali-G68 MC4 33x, Snapdragon 7 Gen 1 25x.
 * - CPU: the frame's main-thread time with the CPU throttled 4x through CDP.
 * - Estimate: 1000 / max(phone GPU ms, CPU ms at 4x).
 * - Check: the GPU time again under the 4x throttle. With the waits hidden it doesn't move.
 *   node scripts/mobileperf.mjs [--devices=pixel4a,iphone15] [--views=open,walk,ride,night,hill]
 *     [--res=0.8,0.6] [--configs="ship=|s1=shadow:512"] [--prof] [--raw] [--out=shots/mobile/perf.json]
 * A config is a `?tier=` override string (platform.ts); empty is the phone tier as shipped. --prof
 * prints GPU ms per pass instead (?prof=fill); --raw drops the filler (the old, waiting-inflated timer).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devices } from "playwright";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
/** RTX 4060 (about 20,600) over Mali-G68 MC4 (about 630) and Snapdragon 7 Gen 1 (about 830), Wild Life Extreme. */
const RATIO = { mali: 33, sd7: 25 };
const DEVS = { pixel4a: "Pixel 4a (5G) landscape", iphone15: "iPhone 15 landscape" };
const VIEWS = {
  open: "?skipintro=1&tod=golden",
  walk: "?autoplay=1&skipintro=1&tod=golden",
  ride: "?boat=1&cam=boat&skipintro=1&tod=sunset",
  night: "?boat=1&cam=boat&skipintro=1&tod=night",
  hill: "?skipintro=1&tod=golden&spawn=40,-60,1.4&orbit=0,0.2,4",
};
const want = arg("devices", "pixel4a").split(",").filter(Boolean);
const views = arg("views", "open,walk,ride,night").split(",").filter(Boolean);
const resList = arg("res", "0.8").split(",").filter(Boolean);
const configs = arg("configs", "ship=").split("|").filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2));
const PROF = argv.includes("--prof");
const RAW = argv.includes("--raw");
const OUTF = path.join(ROOT, arg("out", "shots/mobile/perf.json"));
const SETTLE = Number(arg("settle", "3000")), SAMPLE = Number(arg("sample", "4000"));

let URL = arg("url", "");
if (!URL) {
  const mode = arg("serve", "preview");
  if (mode === "preview") await fs.access(path.join(ROOT, "dist", "index.html")).catch(() => bye(1, "dist/ missing: run `pnpm build` first"));
  URL = await serve(ROOT, mode);
}
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const results = [];
let checked = false;
const fps = (ms) => +(1000 / ms).toFixed(1);

for (const dk of want) {
  const { defaultBrowserType: _, ...d } = devices[DEVS[dk]];
  const ctx = await browser.newContext({ ...d });
  for (const [name, tier] of configs) for (const res of resList) for (const v of views) {
    const page = await ctx.newPage();
    fatalShaderErrors(page, `${dk}/${name}/${v}`);
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));
    const q = `${URL}${VIEWS[v]}&${PROF ? "prof=fill" : RAW ? "gpums=raw" : "gpums"}&res=${res}${tier ? `&tier=${tier}` : ""}`;
    const t0 = Date.now();
    await page.goto(q, { waitUntil: "load" });
    if (!checked) {
      await assertGpu(page);
      checked = true;
    }
    await page.waitForFunction(() => window.__ride?.ready === true, null, { timeout: 400_000, polling: 200 });
    const boot = +((Date.now() - t0) / 1000).toFixed(1);
    await page.waitForTimeout(SETTLE);
    const tag = `${dk.padEnd(8)} ${name.padEnd(10)} res ${res} ${v.padEnd(5)}`;
    if (PROF) {
      await page.evaluate(() => window.__ride.prof.reset());
      await page.waitForTimeout(SAMPLE);
      const rep = await page.evaluate(() => ({ ...window.__ride.prof.report(), fill: window.__ride.prof.fillMs }));
      const sum = Object.values(rep.gpuMs).reduce((a, b) => a + b, 0);
      console.log(`${tag} GPU ${sum.toFixed(3)} ms (filler ${rep.fill.toFixed(1)}): ` + Object.entries(rep.gpuMs).sort((a, b) => b[1] - a[1]).map(([k, ms]) => `${k} ${ms.toFixed(3)} (${Math.round(rep.calls[k] ?? 0)}c ${((rep.tris[k] ?? 0) / 1e6).toFixed(2)}M)`).join(", "));
      results.push({ device: dk, config: name, tier, res: Number(res), view: v, boot, prof: rep });
      await page.close();
      continue;
    }
    // Other apps' GPU work (here a live wallpaper) lands inside some frames' queries and only ever
    // adds time: the 25th percentile is kept beside the median, and runs are compared best of N.
    const sample = async () => {
      await page.evaluate(() => window.__ride.mobile.timer.reset());
      await page.waitForTimeout(SAMPLE);
      const s = await page.evaluate(() => ({ ...window.__ride.mobile.timer.stats(), frames: window.__ride.mobile.timer.frames() }));
      const f = s.frames.sort((x, y) => x - y);
      s.gpu.p25 = +(f[Math.floor(f.length * 0.25)] ?? NaN).toFixed(3);
      delete s.frames;
      return s;
    };
    const a = await sample();
    const info = await page.evaluate(() => ({ st: window.__ride.stats(), canvas: window.__ride.mobile.layout().canvas }));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
    await page.waitForTimeout(1500);
    const b = await sample();
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await cdp.detach();
    const gpu = a.gpu.median, cpu4 = b.cpu.median;
    const r = {
      device: dk, config: name, tier, view: v, res: Number(res), boot,
      canvas: `${info.canvas.w}x${info.canvas.h}`, scene: `${Math.round(info.canvas.w * info.canvas.scale)}x${Math.round(info.canvas.h * info.canvas.scale)}`,
      gpuMedian: gpu, gpuP25: a.gpu.p25, gpuP90: a.gpu.p90, gpu4Median: b.gpu.median, fillMedian: a.fill.median, frames: a.gpu.n,
      cpuMedian: a.cpu.median, cpu4Median: cpu4, cpu4P90: b.cpu.p90,
      maliGpuFps: fps(gpu * RATIO.mali), sd7GpuFps: fps(gpu * RATIO.sd7), cpu4Fps: fps(cpu4),
      maliFps: fps(Math.max(gpu * RATIO.mali, cpu4)), sd7Fps: fps(Math.max(gpu * RATIO.sd7, cpu4)),
      calls: info.st.sceneCalls, tris: +(info.st.sceneTris / 1e6).toFixed(2), errors: errs.length,
    };
    results.push(r);
    console.log(`${tag} GPU ${gpu.toFixed(3)} ms (p25 ${a.gpu.p25.toFixed(3)}, p90 ${a.gpu.p90.toFixed(3)}; at 4x CPU ${b.gpu.median.toFixed(3)}; filler ${a.fill.median.toFixed(1)}; ${a.gpu.n} frames) -> Mali-G68 ${r.maliFps} fps, SD 7 Gen 1 ${r.sd7Fps} fps | CPU ${a.cpu.median.toFixed(2)} ms, 4x ${cpu4.toFixed(2)} (p90 ${b.cpu.p90.toFixed(2)}) | ${r.canvas} scene ${r.scene} ${r.calls} calls ${r.tris}M | boot ${boot}s${errs.length ? ` ERR ${errs.length}: ${errs[0]}` : ""}`);
    await page.close();
  }
  await ctx.close();
}
await fs.mkdir(path.dirname(OUTF), { recursive: true });
let prev = [];
try {
  prev = JSON.parse(await fs.readFile(OUTF, "utf8"));
} catch {}
await fs.writeFile(OUTF, JSON.stringify([...prev, { at: new Date().toISOString(), ratio: RATIO, mode: PROF ? "prof=fill" : RAW ? "gpums=raw" : "gpums (filled)", results }], null, 1));
console.log(OUTF);
await bye(0);
