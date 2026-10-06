#!/usr/bin/env node
/**
 * Taste r3 B1 check on the built game (dist/), headless on the GPU: her at every time of day,
 * close (face and glasses) and at play distance, on the pier end, on the beach and in the boat.
 *   node scripts/t4shots.mjs --out=shots/t4/after [--tods=morning,noon,...] [--parts=walk,boat]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const OUT = path.join(ROOT, arg("out", "shots/t4/after"));
const TODS = arg("tods", "morning,noon,golden,sunset,dusk,night").split(",");
const PARTS = arg("parts", "walk,boat").split(",");
await fs.mkdir(OUT, { recursive: true });
const base = await serve(ROOT, "preview", 5476);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
fatalShaderErrors(page);
let errors = 0;
page.on("console", (m) => { if (m.type() === "error") { errors++; console.log("[console]", m.text().slice(0, 300)); } });
page.on("pageerror", (e) => { errors++; console.log("[pageerror]", e.message); });
await page.goto(`${base}?skipintro=1&tod=noon`);
await assertGpu(page);
await page.waitForFunction(() => window.__ride?.ready, null, { timeout: 240000 });
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log("shot", name); };
const tod = async (p) => { await page.evaluate((p) => window.__ride.setTime(p, true), p); await wait(900); };
await page.evaluate(() => {
  const E = window.__ride.explore, orig = E.updateCamera.bind(E);
  E.updateCamera = (dt, cam) => {
    orig(dt, cam);
    const o = window.__camOv;
    if (!o) return;
    cam.position.set(o[0], o[1], o[2]);
    cam.lookAt(o[3], o[4], o[5]);
    cam.updateMatrixWorld();
  };
});
const orbit = async (x, z, yaw, rel, pitch, dist) => {
  await page.evaluate(([x, z, yaw, rel, pitch, dist]) => { const E = window.__ride.explore; E.standAt(x, z, yaw); E.setOrbit(rel, pitch, dist); }, [x, z, yaw, rel, pitch, dist]);
  await wait(1400);
};

// Pier end (the judge's night frame) facing the town; the beach by the wrack line facing the sea.
const PIER = [-56, -193, -Math.PI / 2];
const BEACH = [16.5, -150, Math.PI / 2];
if (PARTS.includes("walk")) {
  for (const t of TODS) {
    await tod(t);
    for (const [nm, [x, z, yaw]] of [["pier", PIER], ["beach", BEACH]]) {
      await orbit(x, z, yaw, Math.PI - 0.55, 0.08, 1.9);
      await shot(`${nm}_close_${t}`);
      await orbit(x, z, yaw, 0.7, 0.22, 7);
      await shot(`${nm}_play_${t}`);
    }
  }
}
if (PARTS.includes("boat")) {
  await page.evaluate(() => window.__ride.explore.seatInBoat());
  await wait(1500);
  for (const t of TODS) {
    await tod(t);
    // Close, off the bow quarter, at her eye; then the chase camera at play distance.
    const b = await page.evaluate(() => { const b = window.__ride.explore.boat; return [b.x, b.y, b.z, b.yaw]; });
    const fx = -Math.sin(b[3]), fz = -Math.cos(b[3]), sx = Math.cos(b[3]), sz = -Math.sin(b[3]);
    const hx = b[0] - fx * 0.6, hz = b[2] - fz * 0.6;
    await page.evaluate((o) => { window.__camOv = o; }, [hx + fx * 1.6 + sx * 1.1, b[1] + 1.25, hz + fz * 1.6 + sz * 1.1, hx, b[1] + 0.95, hz]);
    await wait(1200);
    await shot(`boat_close_${t}`);
    await page.evaluate((o) => { window.__camOv = o; }, [hx - fx * 6.5 + sx * 2.5, b[1] + 2.6, hz - fz * 6.5 + sz * 2.5, hx, b[1] + 0.8, hz]);
    await wait(1200);
    await shot(`boat_play_${t}`);
  }
  await page.evaluate(() => { window.__camOv = null; });
}
console.log("[done] console errors:", errors);
await bye(errors ? 1 : 0);
