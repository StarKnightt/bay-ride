#!/usr/bin/env node
/** Wave 1b: board, step ashore, board again and drive with real keys; tiller grip error throughout. */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, process.argv.slice(2).find((a) => a.startsWith("--out="))?.slice(6) ?? "shots/wave1b/sim");
await fs.mkdir(OUT, { recursive: true });
const base = await serve(ROOT, "preview", 5472);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
fatalShaderErrors(page);
let errors = 0;
page.on("console", (m) => { if (m.type() === "error") { errors++; console.log("[console]", m.text().slice(0, 300)); } });
page.on("pageerror", (e) => { errors++; console.log("[pageerror]", e.message); });
await page.goto(`${base}?skipintro=1&tod=noon`);
await assertGpu(page);
await page.waitForFunction(() => window.__ride?.ready, null, { timeout: 240000 });
const wait = (ms) => page.waitForTimeout(ms);
const key = async (k, ms = 80) => { await page.keyboard.down(k); await wait(ms); await page.keyboard.up(k); };
const state = () => page.evaluate(() => {
  const R = window.__ride, E = R.explore;
  return { mode: R.footMode, aboard: R.boat.aboard, boat: R.boat.mode, x: +R.player.x.toFixed(2), y: +R.player.y.toFixed(2), z: +R.player.z.toFixed(2), speed: +R.boat.speed.toFixed(2) };
});
/** Max tiller grip error (m) sampled every 50 ms for ms, with keys held. */
const gripOver = async (ms, keys = []) => {
  for (const k of keys) await page.keyboard.down(k);
  const e = await page.evaluate(async (ms) => {
    const R = window.__ride, E = R.explore;
    let mx = 0, n = 0;
    for (let t = 0; t < ms; t += 50) {
      await new Promise((r) => setTimeout(r, 50));
      if (!R.boat.aboard) continue;
      mx = Math.max(mx, R.rider.gripError(E.grip));
      n++;
    }
    return { max: +mx.toFixed(3), n };
  }, ms);
  for (const k of keys) await page.keyboard.up(k);
  return e;
};
const until = async (what, fn) => {
  const t0 = Date.now();
  await page.waitForFunction(fn, null, { timeout: 30000, polling: 50 });
  await wait(800);
  return { ...(await state()), took_s: +((Date.now() - t0) / 1000).toFixed(1), what };
};
const aboard = () => window.__ride.boat.aboard && window.__ride.footMode !== "board";
const onFoot = () => !window.__ride.boat.aboard && window.__ride.footMode === "walk";
const out = {};
await wait(1500);
out.start = await state();
await key("KeyF");
out.boarded = await until("seated", aboard);
out.gripSeatedIdle = await gripOver(2500);
await page.screenshot({ path: path.join(OUT, "seated_berth.png") });
await key("KeyF");
out.ashore = await until("on the pier", onFoot);
await key("KeyF");
out.boardedAgain = await until("seated", aboard);
out.gripThrottle = await gripOver(3000, ["KeyW"]);
out.gripTurnLeft = await gripOver(1500, ["KeyW", "KeyA"]);
out.gripTurnRight = await gripOver(1500, ["KeyW", "KeyD"]);
out.gripCoast = await gripOver(2000);
out.underway = await state();
await page.screenshot({ path: path.join(OUT, "seated_underway.png") });
console.log(JSON.stringify(out, null, 1));
console.log("[done] console errors:", errors);
await bye(errors ? 1 : 0);
