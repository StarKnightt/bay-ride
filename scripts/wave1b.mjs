#!/usr/bin/env node
/**
 * Wave 1b checks on the built game (dist/), headless on the GPU, no fps:
 *   node scripts/wave1b.mjs --out=shots/wave1b/after --parts=cam,her,boat
 * cam: the on-foot camera on the hill above the town, facing downhill / across / up, with an
 *      orbit sweep, logging the eye's clearance over the ground.
 * her: her on the beach and on grass at noon and golden: the gameplay orbit, and 14 / 22 m.
 * boat: the chase camera at noon and dusk, under way.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const OUT = path.join(ROOT, arg("out", "shots/wave1b/after"));
const PARTS = arg("parts", "cam,her,boat").split(",");
await fs.mkdir(OUT, { recursive: true });

const base = await serve(ROOT, "preview", 5470);
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
const tod = async (p) => { await page.evaluate((p) => window.__ride.setTime(p, true), p); await wait(600); };

// Camera override hook: after the game's own camera update, place an exact eye / target.
await page.evaluate(() => {
  const E = window.__ride.explore;
  const orig = E.updateCamera.bind(E);
  E.updateCamera = (dt, cam) => {
    orig(dt, cam);
    const o = window.__camOv;
    if (!o) return;
    const p = window.__ride.player;
    const f = o.f(p);
    cam.position.set(f[0], f[1], f[2]);
    cam.lookAt(f[3], f[4], f[5]);
    cam.updateMatrixWorld();
  };
});

if (PARTS.includes("cam")) {
  await tod("noon");
  // Hill above the town, just above the lane's top: walking downhill (-x), camera behind = uphill.
  const res = await page.evaluate(async () => {
    const R = window.__ride, E = R.explore, B = R.bay, cam = R.camera;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const clr = () => cam.position.y - (B.groundAt(cam.position.x, cam.position.z)?.h ?? -99);
    const out = {};
    // 1) walk down the slope from high up.
    E.standAt(112, -181, Math.PI / 2);
    E.setOrbit(0, 0.16, 3.4);
    E.autoWalk = null;
    await sleep(800);
    let min = 9, prev = cam.position.clone(), jump = 0;
    E.autoWalk = { dx: -1, dz: 0, run: false };
    for (let i = 0; i < 60; i++) {
      await sleep(50);
      min = Math.min(min, clr());
      jump = Math.max(jump, cam.position.distanceTo(prev) - 0.25);
      prev.copy(cam.position);
    }
    E.autoWalk = null;
    out.walkDown = { minClear: +min.toFixed(2), maxJumpOverWalk: +jump.toFixed(2), at: [R.player.x.toFixed(1), R.player.y.toFixed(1)] };
    // 2) standing on the slope, sweep the orbit all the way round, slowly.
    E.standAt(100, -181, Math.PI / 2);
    E.setOrbit(0, 0.16, 3.4);
    await sleep(1200);
    prev.copy(cam.position);
    min = 9; jump = 0;
    const per = [];
    for (let k = 0; k <= 72; k++) {
      E.setOrbit((k / 72) * Math.PI * 2, 0.16, 3.4);
      await sleep(40);
      const c = clr();
      min = Math.min(min, c);
      if (k % 9 === 0) per.push(+c.toFixed(2));
      jump = Math.max(jump, cam.position.distanceTo(prev));
      prev.copy(cam.position);
    }
    out.sweep = { minClear: +min.toFixed(2), maxStep: +jump.toFixed(2), every45deg: per };
    return out;
  });
  console.log("[cam]", JSON.stringify(res));
  for (const [nm, rel] of [["downhill_behind", 0], ["across_left", Math.PI / 2], ["across_right", -Math.PI / 2], ["uphill_front", Math.PI]]) {
    await page.evaluate((rel) => { const E = window.__ride.explore; E.standAt(100, -181, Math.PI / 2); E.setOrbit(rel, 0.16, 3.4); }, rel);
    await wait(1500);
    const c = await page.evaluate(() => { const R = window.__ride, p = R.camera.position; return +(p.y - R.bay.groundAt(p.x, p.z).h).toFixed(2); });
    console.log(`[cam] ${nm} clearance ${c}`);
    await shot(`cam_${nm}_noon`);
  }
  // The judge's repro: walking down from the top, the default (follow) camera.
  await page.evaluate(() => { const E = window.__ride.explore; E.standAt(112, -181, Math.PI / 2); E.setOrbit(0, 0.16, 3.4); E.autoWalk = { dx: -1, dz: 0, run: false }; });
  await wait(2500);
  await shot("cam_walkdown_noon");
  await page.evaluate(() => { window.__ride.explore.autoWalk = null; });
}

if (PARTS.includes("diag")) {
  await tod("noon");
  const info = await page.evaluate(async () => {
    const R = window.__ride, E = R.explore;
    E.standAt(16, -112, Math.PI);
    E.setOrbit(Math.PI - 0.5, 0.16, 3.4);
    await new Promise((r) => setTimeout(r, 1500));
    const groups = [];
    R.rider.walker.traverse((o) => { if (o.isSkinnedMesh) groups.push(o.name); });
    return groups;
  });
  console.log("[diag] groups", info.join());
  await page.evaluate(() => { window.__camOv = { f: (p) => { const s = Math.sin(window.__ride.player.yaw), c = Math.cos(window.__ride.player.yaw); return [p.x - s * 1.4, p.y + 0.85, p.z - c * 1.4, p.x, p.y + 0.8, p.z]; } }; });
  await wait(800);
  await shot("diag_shorts_all");
  for (const g of ["heroine_skin", "heroine_shirt", "heroine_shorts"]) {
    await page.evaluate((g) => { window.__ride.rider.walker.traverse((o) => { if (o.isSkinnedMesh) o.visible = o.name !== g; }); }, g);
    await wait(500);
    await shot(`diag_shorts_no_${g}`);
  }
  await page.evaluate(() => { window.__camOv = null; window.__ride.rider.walker.traverse((o) => { if (o.isSkinnedMesh) o.visible = true; }); });
}

if (PARTS.includes("her")) {
  const spots = await page.evaluate(() => {
    const B = window.__ride.bay, sea = window.__ride.shore.seaLevel;
    const find = (z, x0, x1, want) => { for (let x = x0; x < x1; x += 0.5) { const g = B.groundAt(x, z); if (g && g.kind === want && g.h > sea + 0.8) return [x + 3, z]; } return null; };
    return { beach: find(-112, -30, 40, "sand"), grass: find(-150, 30, 140, "grass") };
  });
  console.log("[her] spots", JSON.stringify(spots));
  for (const t of ["noon", "golden"]) {
    await tod(t);
    for (const [sp, [x, z]] of Object.entries(spots)) {
      // Gameplay: walking along the shore / slope, the follow orbit behind her.
      await page.evaluate(([x, z]) => { const E = window.__ride.explore; window.__camOv = null; E.standAt(x, z, Math.PI); E.setOrbit(0.5, 0.16, 3.4); E.autoWalk = { dx: 0, dz: 1, run: false }; }, [x, z]);
      await wait(1800);
      await shot(`her_${sp}_${t}_play_behind`);
      await page.evaluate(() => { window.__ride.explore.autoWalk = null; });
      await page.evaluate(([x, z]) => { const E = window.__ride.explore; E.standAt(x, z, Math.PI); E.setOrbit(Math.PI - 0.5, 0.16, 3.4); }, [x, z]);
      await wait(1500);
      await shot(`her_${sp}_${t}_play_front`);
      for (const d of [14, 22]) {
        await page.evaluate(([x, z, d]) => {
          window.__ride.explore.standAt(x, z, Math.PI * 0.75);
          // 3/4 front, from a little above her head height.
          window.__camOv = { f: (p) => [p.x - d * 0.55, p.y + 2.2 + d * 0.06, p.z + d * 0.83, p.x, p.y + 0.9, p.z] };
        }, [x, z, d]);
        await wait(1200);
        await shot(`her_${sp}_${t}_${d}m`);
      }
      await page.evaluate(() => { window.__camOv = null; });
    }
  }
}

if (PARTS.includes("boat")) {
  await page.evaluate(() => { window.__camOv = null; window.__ride.explore.seatInBoat(); });
  await wait(1500);
  for (const t of ["noon", "dusk"]) {
    await tod(t);
    await page.keyboard.down("KeyW");
    await wait(4000);
    await shot(`boat_chase_${t}`);
    await page.keyboard.down("KeyA");
    await wait(900);
    await page.keyboard.up("KeyA");
    await wait(700);
    await shot(`boat_chase_${t}_turn`);
    await page.keyboard.up("KeyW");
    await wait(2500);
    await shot(`boat_chase_${t}_idle`);
  }
}

console.log(`[done] console errors: ${errors}`);
await bye(0);
