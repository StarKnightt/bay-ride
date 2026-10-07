#!/usr/bin/env node
/**
 * The phone performance proxy (DECISIONS.md, "Mobile"): in Playwright mobile emulation on the RTX 4060,
 * the whole frame's GPU time (one timer query round shadows, mirror, scene and post: `?gpums` with a
 * fixed `?res=`) at the phone tier and the phone's own viewport, then the frame's main-thread time with
 * the CPU throttled 4x through CDP. Prints medians and 90th percentiles, and the phone estimate:
 * GPU ms x RATIO (the RTX 4060 over a Mali-G68 MC4 in 3DMark Wild Life Extreme).
 *   node scripts/mobileperf.mjs [--devices=pixel4a] [--views=open,walk,ride,night] [--res=0.85]
 *     [--configs="base=|s1=shadow:1024"] [--serve=preview|dev] [--out=shots/mobile/perf.json]
 * A config is a `?tier=` override string (platform.ts); empty is the phone tier as shipped.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { devices } from "playwright";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, own, serve } from "./lib/harness.mjs";

/**
 * GPU busy share over a window, from nvidia-smi (attached child, stopped by the harness on every
 * exit path). Timer queries round a pass also count the GPU waiting for commands still being
 * issued (they grow when only the CPU is throttled), so the busy share times the frame interval is
 * the closer measure of the GPU's own work.
 */
function sampleUtil(ms) {
  return new Promise((resolve) => {
    const p = spawn("nvidia-smi", ["--query-gpu=utilization.gpu,clocks.gr", "--format=csv,noheader,nounits", "-lms", "100"], { stdio: ["ignore", "pipe", "ignore"] });
    const handle = own({ close: async () => { try { p.kill(); } catch {} } });
    const vals = [], clk = [];
    p.stdout.on("data", (b) => {
      for (const line of String(b).split("\n")) {
        const [u, c] = line.split(",").map((s) => Number(s.trim()));
        if (Number.isFinite(u)) vals.push(u), clk.push(c);
      }
    });
    setTimeout(() => {
      p.kill();
      void handle;
      const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
      resolve({ util: mean(vals.slice(2)) / 100, clock: mean(clk.slice(2)), n: vals.length });
    }, ms);
  });
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
/** RTX 4060 (about 20,600) over Mali-G68 MC4 (about 630) and Snapdragon 7 Gen 1 (about 830), Wild Life Extreme. */
const RATIO = Number(arg("ratio", "33"));
const RATIO_SD7 = 25;
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
const res = arg("res", "0.85");
const configs = arg("configs", "ship=").split("|").filter(Boolean).map((c) => c.split(/=(.*)/s).slice(0, 2));
const OUTF = path.join(ROOT, arg("out", "shots/mobile/perf.json"));
const SETTLE = Number(arg("settle", "3000")), SAMPLE = Number(arg("sample", "5000"));

let URL = arg("url", "");
if (!URL) {
  const mode = arg("serve", "preview");
  if (mode === "preview") await fs.access(path.join(ROOT, "dist", "index.html")).catch(() => bye(1, "dist/ missing: run `pnpm build` first"));
  URL = await serve(ROOT, mode);
}
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const results = [];
let checked = false;
// Other apps' share of the GPU with no page drawing (the desktop, a live wallpaper), taken off every sample.
const idle = await sampleUtil(3000);
console.log(`[idle] GPU busy ${(idle.util * 100).toFixed(1)}% at ${Math.round(idle.clock)} MHz with no page drawing`);
for (const dk of want) {
  const { defaultBrowserType: _, ...d } = devices[DEVS[dk]];
  const ctx = await browser.newContext({ ...d });
  for (const [name, tier] of configs) {
    for (const v of views) {
      const page = await ctx.newPage();
      fatalShaderErrors(page, `${dk}/${name}/${v}`);
      const errs = [];
      page.on("pageerror", (e) => errs.push(e.message));
      page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 200)));
      const PROF = argv.includes("--prof");
      const q = `${URL}${VIEWS[v]}&${PROF ? "prof" : "gpums"}&res=${res}${tier ? `&tier=${tier}` : ""}`;
      const t0 = Date.now();
      await page.goto(q, { waitUntil: "load" });
      if (!checked) {
        await assertGpu(page);
        checked = true;
      }
      await page.waitForFunction(() => window.__ride?.ready === true, null, { timeout: 400_000, polling: 200 });
      const boot = (Date.now() - t0) / 1000;
      if (PROF) {
        // Per pass (?prof): GPU ms, draw calls and triangles, averaged over the sample.
        await page.waitForTimeout(SETTLE);
        await page.evaluate(() => window.__ride.prof.reset());
        await page.waitForTimeout(SAMPLE);
        const rep = await page.evaluate(() => window.__ride.prof.report());
        const sum = Object.values(rep.gpuMs).reduce((a, b) => a + b, 0);
        console.log(`${dk} ${name} ${v} total ${sum.toFixed(3)} ms: ` + Object.entries(rep.gpuMs).map(([k, ms]) => `${k} ${ms.toFixed(3)} (${Math.round(rep.calls[k] ?? 0)}c ${((rep.tris[k] ?? 0) / 1e6).toFixed(2)}M)`).join(", "));
        results.push({ device: dk, config: name, view: v, prof: rep });
        await page.close();
        continue;
      }
      await page.waitForTimeout(SETTLE);
      await page.evaluate(() => window.__ride.mobile.timer.reset());
      const f0 = await page.evaluate(() => performance.now());
      const fr0 = await page.evaluate(() => window.__ride.mobile.timer.stats().cpu.n);
      const u = await sampleUtil(SAMPLE);
      const g = await page.evaluate(() => ({ ...window.__ride.mobile.timer.stats(), st: window.__ride.stats(), canvas: window.__ride.mobile.layout().canvas, tier: window.__ride.mobile.tier, now: performance.now() }));
      const frames = g.cpu.n - fr0, interval = (g.now - f0) / Math.max(1, frames);
      const busy = Math.max(0, u.util - idle.util) * interval;
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.__ride.mobile.timer.reset());
      await page.waitForTimeout(SAMPLE);
      const c4 = await page.evaluate(() => window.__ride.mobile.timer.stats().cpu);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      await cdp.detach();
      const r = {
        device: dk, config: name, tier, view: v, res: Number(res), boot: +boot.toFixed(1),
        canvas: `${g.canvas.w}x${g.canvas.h}`, scene: `${Math.round(g.canvas.w * g.canvas.scale)}x${Math.round(g.canvas.h * g.canvas.scale)}`,
        gpuMedian: g.gpu.median, gpuP90: g.gpu.p90, cpuMedian: g.cpu.median, cpu4Median: c4.median, cpu4P90: c4.p90,
        util: +u.util.toFixed(3), clock: Math.round(u.clock), interval: +interval.toFixed(2), busy: +busy.toFixed(3),
        phoneFps: +(1000 / (busy * RATIO)).toFixed(1), sd7Fps: +(1000 / (busy * RATIO_SD7)).toFixed(1),
        timerPhoneFps: +(1000 / (g.gpu.median * RATIO)).toFixed(1),
        calls: g.st.sceneCalls, tris: +(g.st.sceneTris / 1e6).toFixed(2), errors: errs.length,
      };
      results.push(r);
      console.log(`${dk.padEnd(8)} ${name.padEnd(10)} ${v.padEnd(6)} busy ${r.busy.toFixed(3)} ms (util ${(u.util * 100).toFixed(0)}% @ ${r.clock} MHz x ${r.interval} ms) -> Mali-G68 ~${r.phoneFps} fps, SD7G1 ~${r.sd7Fps}; timer ${r.gpuMedian.toFixed(3)} ms (p90 ${r.gpuP90.toFixed(3)}, Mali ~${r.timerPhoneFps}); cpu ${r.cpuMedian.toFixed(2)} ms, 4x ${r.cpu4Median.toFixed(2)} (p90 ${r.cpu4P90.toFixed(2)}); ${r.canvas} scene ${r.scene}; ${r.calls} calls ${r.tris}M; boot ${r.boot}s${errs.length ? ` ERR ${errs.length}` : ""}`);
      await page.close();
    }
  }
  await ctx.close();
}
await fs.mkdir(path.dirname(OUTF), { recursive: true });
let prev = [];
try {
  prev = JSON.parse(await fs.readFile(OUTF, "utf8"));
} catch {}
await fs.writeFile(OUTF, JSON.stringify([...prev, { at: new Date().toISOString(), ratio: RATIO, results }], null, 1));
console.log(OUTF);
await bye(0);
