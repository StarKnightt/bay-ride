#!/usr/bin/env node
/**
 * The boat against the pier, its piles and the landing stage, and F beside them (judge taste-r2 R5):
 *   node scripts/pile-sim.mjs [--out=shots/pile/after]
 * route: board at the berth, hold W and steer for the beach (-40, -205) like the judge; then F by the piles.
 * slide: the hull driven into each face (pier south / north side, the pier end, the stage) at 30/60/90
 *        degrees, full throttle: distance made along the face, the slowest speed after contact.
 * step:  the over-the-side search all along the pier on both sides: no step-out under the deck.
 * shore: F off several beaches: she steps out into water no deeper than the wading limit.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PARTS = (process.argv.slice(2).find((a) => a.startsWith("--parts="))?.slice(8) ?? "route,slide,f,step,shore").split(",");
const ROUTE_LEFT = !process.argv.includes("--route-right");
const OUT = path.join(ROOT, process.argv.slice(2).find((a) => a.startsWith("--out="))?.slice(6) ?? "shots/pile/after");
await fs.mkdir(OUT, { recursive: true });
const base = await serve(ROOT, "preview", 5473);
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
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
const st = () => page.evaluate(() => {
  const R = window.__ride, E = R.explore, b = E.boat;
  return { mode: R.footMode, x: +b.x.toFixed(2), z: +b.z.toFixed(2), yaw: +b.yaw.toFixed(2), speed: +Math.hypot(b.u, b.v).toFixed(2), py: +R.player.y.toFixed(2), refuseT: +E.refuseT.toFixed(2) };
});

// ---- board at the berth
await wait(1200);
await page.keyboard.press("KeyF");
await page.waitForFunction(() => window.__ride.boat.aboard && window.__ride.footMode === "boat", null, { timeout: 30000, polling: 50 });
await wait(600);
const out = {};

// Keys held from here (the game's input listens to real key events).
const held = new Set();
const hold = async (want) => {
  for (const k of [...held]) if (!want.includes(k)) { await page.keyboard.up(k); held.delete(k); }
  for (const k of want) if (!held.has(k)) { await page.keyboard.down(k); held.add(k); }
};
// Contact frames counted in the page.
await page.evaluate(() => {
  const b = window.__ride.explore.boat, orig = b.collide.bind(b);
  window.__hits = 0;
  b.collide = (px, pz, dt) => {
    const x0 = b.x, z0 = b.z, u0 = b.u, v0 = b.v;
    orig(px, pz, dt);
    if (b.x !== x0 || b.z !== z0 || b.u !== u0 || b.v !== v0) window.__hits++;
  };
});
const boatS = () => page.evaluate(() => { const b = window.__ride.explore.boat; return { x: b.x, z: b.z, yaw: b.yaw, sp: Math.hypot(b.u, b.v), hits: window.__hits }; });
const place = (x, z, yaw, u = 0) => page.evaluate(([x, z, yaw, u]) => { const b = window.__ride.explore.boat; b.x = x; b.z = z; b.yaw = yaw; b.halt(); b.u = u; window.__hits = 0; }, [x, z, yaw, u]);

// ---- the judge's route: hold W, steer for (-40, -205)
if (PARTS.includes("route")) {
  await page.evaluate(() => { window.__hits = 0; });
  const track = [];
  let firstHit = -1, minAfter = 99, t = 0, s = await boatS();
  const t0 = Date.now();
  // Turning left off the berth (toward the pier) until she points at the beach, as the judge did.
  let turning = ROUTE_LEFT;
  while ((t = (Date.now() - t0) / 1000) < 45) {
    const dx = -40 - s.x, dz = -205 - s.z;
    if (Math.hypot(dx, dz) < 4) break;
    let e = Math.atan2(Math.sin(Math.atan2(-dx, -dz) - s.yaw), Math.cos(Math.atan2(-dx, -dz) - s.yaw));
    if (turning && Math.abs(e) < 0.3) turning = false;
    if (turning) e = 1;
    await hold(["KeyW", ...(e > 0.08 ? ["KeyA"] : e < -0.08 ? ["KeyD"] : [])]);
    await wait(100);
    s = await boatS();
    if (s.hits && firstHit < 0) firstHit = t;
    if (firstHit >= 0 && t > firstHit + 1) minAfter = Math.min(minAfter, s.sp);
    if (track.length < t) track.push([Math.round(t), +s.x.toFixed(1), +s.z.toFixed(1), +s.sp.toFixed(2), s.hits]);
  }
  await hold([]);
  out.route = { reached: Math.hypot(-40 - s.x, -205 - s.z) < 4, seconds: +t.toFixed(1), contactFrames: s.hits, firstContact_s: +firstHit.toFixed(1), minSpeedAfterContact: minAfter === 99 ? null : +minAfter.toFixed(2), track };
  console.log("[route]", JSON.stringify({ ...out.route, track: undefined }));
  console.log("[route] track [s, x, z, speed, contactFrames]", JSON.stringify(track));
  await shot("route_end");
}

// ---- slides: drive into each face at an angle, full throttle, 3 s
if (PARTS.includes("slide")) {
out.slide = [];
const faces = [
  ["pier S x-75", -75, -197.6, [0, -1], [1, 0]],
  ["pier S x-59 (judge)", -59, -197.6, [0, -1], [1, 0]],
  ["pier S x-30", -30, -197.6, [0, -1], [1, 0]],
  ["pier N x-60", -60, -188.4, [0, 1], [1, 0]],
  ["pier N x-85", -85, -188.4, [0, 1], [-1, 0]],
  ["pier end", -97.4, -193, [-1, 0], [0, 1]],
  ["stage S", -91.2, -199.4, [0, -1], [-1, 0]],
  ["stage W", -94.8, -196.8, [-1, 0], [0, -1]],
];
console.log("[slide] face, deg, contactFrames, along_m, minSpeedAfterContact, stuck_s(<0.3 m/s)");
for (const [name, x, z, n, tg] of faces) {
  for (const deg of [30, 60, 90]) {
    const r = (deg * Math.PI) / 180;
    const hx = -n[0] * Math.sin(r) + tg[0] * Math.cos(r), hz = -n[1] * Math.sin(r) + tg[1] * Math.cos(r);
    await place(x, z, Math.atan2(-hx, -hz), 2.5);
    await hold(["KeyW"]);
    const p0 = await boatS();
    let minSp = 99, first = -1, stuck = 0, s = p0;
    const t0 = Date.now();
    for (let t = 0; t < 3.5; t = (Date.now() - t0) / 1000) {
      await wait(50);
      s = await boatS();
      if (first < 0 && s.hits) first = t;
      if (first >= 0 && t > first + 0.5) { minSp = Math.min(minSp, s.sp); if (s.sp < 0.3) stuck += 0.05; }
    }
    await hold([]);
    const along = (s.x - p0.x) * tg[0] + (s.z - p0.z) * tg[1];
    const row = [name, deg, s.hits, +along.toFixed(1), minSp === 99 ? null : +minSp.toFixed(2), +stuck.toFixed(2)];
    out.slide.push(row);
    console.log("[slide]", JSON.stringify(row));
  }
}
// Head-on into the pier's south face, then full left tiller: she must come off it.
{
  await place(-59, -197.3, Math.PI);
  await hold(["KeyW"]);
  await wait(2500);
  const a = await boatS();
  await hold(["KeyW", "KeyA"]);
  await wait(3500);
  await hold([]);
  const b2 = await boatS();
  out.headOn = { pressedAt: [+a.x.toFixed(2), +a.z.toFixed(2), +a.sp.toFixed(2)], afterSteer: [+b2.x.toFixed(2), +b2.z.toFixed(2), +b2.sp.toFixed(2)], movedAlong_m: +Math.abs(b2.x - a.x).toFixed(1) };
  console.log("[slide] head-on then steer away", JSON.stringify(out.headOn));
  await shot("headon_steer");
}
// The judge's jam, replayed: the pose he was pinned in, full throttle 4 s.
{
  await place(-58.86, -196.16, -2.53, 0.15);
  await hold(["KeyW"]);
  await wait(4000);
  await hold([]);
  const s = await boatS();
  out.judgePose = { after4s: [+s.x.toFixed(2), +s.z.toFixed(2)], speed: +s.sp.toFixed(2), movedFrom_m: +Math.hypot(s.x + 58.86, s.z + 196.16).toFixed(1) };
  console.log("[slide] judge pose, W 4 s", JSON.stringify(out.judgePose));
  await shot("judge_pose_after");
}
}

// ---- F by the piles: stopped against the pier's south side where the judge was, and at others
out.fPiles = [];
if (PARTS.includes("f")) for (const [x, z, yaw] of [[-58.9, -196.16, -2.53], [-58.9, -196.3, Math.PI / 2], [-40, -196.3, -Math.PI / 2], [-75, -189.8, Math.PI / 2], [-20, -196.3, Math.PI / 2], [-8, -196.3, Math.PI / 2]]) {
  const r = await page.evaluate(async ([x, z, yaw]) => {
    const R = window.__ride, E = R.explore, b = E.boat;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    b.x = x; b.z = z; b.yaw = yaw; b.halt();
    await sleep(700);
    const s = E.shoreStep();
    const shore = s ? [+E.shore.x.toFixed(2), +E.shore.y.toFixed(2), +E.shore.z.toFixed(2)] : null;
    return { at: [x, z], bed: +R.bay.surfaceH(x, z - 1.4).toFixed(2), canStepAshore: E.canStepAshore, shore };
  }, [x, z, yaw]);
  await page.keyboard.press("KeyF");
  await wait(250);
  const s1 = await st();
  await wait(2250);
  const s2 = await st();
  r.after = { mode: s2.mode, refusedGlance: s1.refuseT < 0.6 };
  if (s2.mode !== "boat") {
    await page.waitForFunction(() => window.__ride.footMode === "walk", null, { timeout: 20000, polling: 50 });
    r.landed = await page.evaluate(() => { const R = window.__ride; return { y: +R.player.y.toFixed(2), depth: +Math.max(0, -3 - R.player.y).toFixed(2), underPier: R.bay.overWater(R.player.x, R.player.z, 0) }; });
    await shot(`fpiles_${r.at[0]}`);
    // back aboard for the next case
    await page.evaluate(() => window.__ride.explore.seatInBoat());
    await wait(500);
  } else if (r.at[0] === -58.9 && !out.fPiles.length) await shot("fpiles_refused_judge");
  out.fPiles.push(r);
  console.log("[F piles]", JSON.stringify(r));
}

// ---- the over-the-side search all along the pier, both sides, two headings
if (PARTS.includes("step")) out.step = await page.evaluate(async () => {
  const R = window.__ride, E = R.explore, b = E.boat;
  let n = 0, found = 0, under = 0, deep = 0, worst = 0;
  for (let x = -93; x <= 6; x += 1.5)
    for (const z of [-196.0, -196.6, -197.4, -190.0, -189.4, -188.6])
      for (const yaw of [Math.PI / 2, -Math.PI / 2, 0.4, -2.7]) {
        b.x = x; b.z = z; b.yaw = yaw; b.halt();
        b.root.position.set(x, b.y, z); b.root.rotation.set(0, yaw, 0); b.root.updateMatrixWorld(true);
        n++;
        if (!E.shoreStep()) continue;
        found++;
        const s = E.shore;
        if (R.bay.overWater(s.x, s.z, 0.5) && s.y < -2.8) under++;
        const d = -3 - s.y;
        worst = Math.max(worst, d);
        if (d > 0.5 + 1e-6) deep++;
      }
  return { tried: n, stepOutFound: found, underPier: under, deeperThanWade: deep, deepestStepOut_m: +worst.toFixed(2) };
});
console.log("[step]", JSON.stringify(out.step));

// ---- shore leaves off beaches: find shallow points (depth 0.55-0.9 m) seaward of the shore line
out.shore = [];
const spots = await page.evaluate(() => {
  const R = window.__ride, B = R.bay, pts = [];
  for (const z of [-150, -110, -60, -20, 30, 90, 160, -230]) {
    for (let x = -120; x < 20; x += 0.5) {
      const h = B.surfaceH(x, z);
      const d = -3 - h, d2 = -3 - B.surfaceH(x + 1.6, z);
      if (d > 0.55 && d < 1.0 && d2 < 0.45 && !B.overWater(x, z, 3)) { pts.push([x, z]); break; }
    }
  }
  return pts;
});
for (const [x, z] of PARTS.includes("shore") ? spots : []) {
  const r = await page.evaluate(async ([x, z]) => {
    const R = window.__ride, E = R.explore, b = E.boat;
    b.x = x; b.z = z; b.yaw = 0; b.halt();
    await new Promise((r) => setTimeout(r, 700));
    return { at: [x, z], aboard: R.footMode, can: E.canStepAshore };
  }, [x, z]);
  await page.keyboard.press("KeyF");
  await wait(1500);
  const m = await st();
  if (m.mode === "boat") { r.result = "refused"; out.shore.push(r); console.log("[shore]", JSON.stringify(r)); continue; }
  await page.waitForFunction(() => window.__ride.footMode === "walk", null, { timeout: 20000, polling: 50 });
  await wait(300);
  r.landed = await page.evaluate(() => { const R = window.__ride; return { y: +R.player.y.toFixed(2), depth: +Math.max(0, -3 - R.player.y).toFixed(2) }; });
  out.shore.push(r);
  console.log("[shore]", JSON.stringify(r));
  await page.evaluate(() => window.__ride.explore.seatInBoat());
  await wait(500);
}
await fs.writeFile(path.join(OUT, "pile-sim.json"), JSON.stringify(out, null, 1));
console.log("[done] console errors:", errors);
await bye(errors ? 1 : 0);
