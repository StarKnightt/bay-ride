#!/usr/bin/env node
/**
 * Taste r2 R3/R4/R7 checks on the built game (dist/), headless on the GPU:
 *   node scripts/t3shots.mjs --out=shots/t3/after [--parts=rocks,sky,beach]
 * rocks: the tide rocks by the pier from the deck and from the water, noon and golden (golden views
 *        look seaward, so no trees in frame).
 * sky:   up at the sky (four bearings, 30 degrees up) at noon, morning, golden, dusk and night, plus
 *        the judge's noon boat view; white specks are counted per frame from the PNGs afterwards.
 * beach: the wrack line from the pier and at walking distance, noon.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const OUT = path.join(ROOT, arg("out", "shots/t3/after"));
const PARTS = arg("parts", "rocks,sky,beach").split(",");
await fs.mkdir(OUT, { recursive: true });
const base = await serve(ROOT, "preview", 5474);
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
const cam = async (o, ms = 900) => { await page.evaluate((o) => { window.__camOv = o; }, o); await wait(ms); };

if (PARTS.includes("rocks")) {
  const rk = await page.evaluate(() => {
    const B = window.__ride.bay;
    const rocks = B.colliders.filter((c) => c.kind === "rock" && Math.abs(c.z + 193) < 12 && c.x < 30 && c.x > -40);
    return rocks.map((c) => [c.x, c.z, c.r, c.top]);
  });
  console.log("[rocks] by the pier", JSON.stringify(rk));
  const cx = rk.reduce((s, r) => s + r[0], 0) / rk.length, cz = rk.reduce((s, r) => s + r[1], 0) / rk.length;
  const ty = -2.9;
  for (const t of ["noon", "golden"]) {
    await tod(t);
    await page.evaluate(() => window.__ride.explore.standAt(-60, -193, Math.PI / 2));
    // From the deck, landward of the rocks, looking seaward and down over them.
    await cam([cx + 13, -1.3 + 1.6, -193, cx - 2, ty, cz]);
    await shot(`rocks_pier_seaward_${t}`);
    // From the water just off the beach, low, looking seaward at them.
    await cam([cx + 9, -3 + 1.3, cz - 9, cx - 1, ty + 0.2, cz]);
    await shot(`rocks_boat_seaward_${t}`);
    if (t === "noon") {
      // The judge's view: walking the pier toward the town.
      await cam([cx - 22, -1.3 + 1.6, -193, cx + 8, -2.6, -193]);
      await shot(`rocks_pier_landward_${t}`);
      await cam([cx - 9, -3 + 1.3, cz - 10, cx + 1, ty + 0.2, cz]);
      await shot(`rocks_boat_landward_${t}`);
    }
  }
  await cam(null, 100);
}

if (PARTS.includes("sky")) {
  // She stands well away, out of frame; the eye is on the deck.
  await page.evaluate(() => window.__ride.explore.standAt(-85, -193, Math.PI / 2));
  for (const t of ["noon", "morning", "golden", "dusk", "night"]) {
    await tod(t);
    for (const [k, a] of [[0, 0], [1, Math.PI / 2], [2, Math.PI], [3, -Math.PI / 2]]) {
      const e = [-60, 0.3, -193];
      await cam([e[0], e[1], e[2], e[0] + Math.sin(a) * 10, e[1] + 5.8, e[2] + Math.cos(a) * 10], 500);
      await shot(`sky_${t}_${k}`);
    }
  }
  // The judge's noon view: from the water off the town, looking at the shore and the sky over it.
  await tod("noon");
  await cam([-75, -1.2, -60, 0, 4, -40]);
  await shot("sky_judge_noon");
  // A/B: the same frame with the gulls hidden (white specks: birds or stars?).
  const hid = await page.evaluate(() => {
    const names = [];
    window.__ride.scene.traverse((o) => { if (/gull|bird/i.test(o.name) && o.visible) { o.visible = false; names.push(o.name); } });
    return names;
  });
  console.log("[sky] hidden for A/B:", hid.join() || "(no gull objects found by name)");
  await wait(500);
  await shot("sky_judge_noon_nogulls");
  await page.evaluate(() => window.__ride.scene.traverse((o) => { if (/gull|bird/i.test(o.name)) o.visible = true; }));
  await cam(null, 100);
}

if (PARTS.includes("beach")) {
  await tod("noon");
  await page.evaluate(() => window.__ride.explore.standAt(-60, -193, Math.PI / 2));
  // From the pier near its root, looking along the beach both ways.
  await cam([-2, -1.0 + 1.6, -192, 12, -2.6, -165]);
  await shot("beach_pier_north");
  await cam([-2, -1.0 + 1.6, -194, 12, -2.6, -222]);
  await shot("beach_pier_south");
  await cam(null, 100);
  // Walking along the beach near the wrack line: the gameplay orbit.
  const spot = await page.evaluate(() => {
    const B = window.__ride.bay;
    for (let x = -30; x < 40; x += 0.5) { const g = B.groundAt(x, -150); if (g && g.kind === "sand" && g.h > -3 + 1.2) return [x, -150]; }
    return [20, -150];
  });
  console.log("[beach] walk spot", JSON.stringify(spot));
  await page.evaluate(([x, z]) => { const E = window.__ride.explore; E.standAt(x, z, Math.PI); E.setOrbit(0.6, 0.18, 3.6); E.autoWalk = { dx: 0, dz: 1, run: false }; }, spot);
  await wait(2500);
  await shot("beach_walk");
  await page.evaluate(() => { window.__ride.explore.autoWalk = null; });
  await page.evaluate(([x, z]) => { const E = window.__ride.explore; E.standAt(x, z, -Math.PI / 2); E.setOrbit(0.3, 0.32, 3.8); }, spot);
  await wait(1500);
  await shot("beach_walk_down");
}
console.log("[done] console errors:", errors);
await bye(errors ? 1 : 0);
