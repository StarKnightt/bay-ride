#!/usr/bin/env node
/**
 * Phone captures in Playwright mobile emulation on the real GPU (headless Chrome, ANGLE/D3D11), driven
 * only by touch: taps through page.touchscreen, the stick, look drags and multi-touch through CDP
 * Input.dispatchTouchEvent. Never the mouse or keyboard.
 *   node scripts/mobile.mjs --out=shots/mobile/r1 [--devices=iphone15,pixel4a] [--serve=preview|dev] [--url=...]
 * Per device, in landscape with its safe-area insets emulated (CDP Emulation.setSafeAreaInsetsOverride):
 *   intro (tap to start), pier (the start), walking (stick held, a second finger looking), boarding (the
 *   F button), riding at sunset (T, then the stick as throttle), night (T twice more), then the landscape
 *   prompt in portrait and a landscape -> portrait -> landscape rotation.
 * Writes <device>_<scene>.png and layout.json (viewport, insets, every control's and hint's box, her and
 * the boat on screen, console errors so far, fps, canvas size), and checks: 0 console errors, no shader
 * compiled after play started, no control over her, the boat or another control, canvas matching the
 * viewport after each rotation. Exits 1 on a failed check. One browser, closed on every exit path.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { devices } from "playwright";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const FINAL = path.join(ROOT, arg("out", "shots/mobile/latest"));
// The run fills a sibling folder that replaces --out only when it completes: an interrupted run
// never leaves half a set where a whole one was.
const OUT = `${FINAL}.partial`;

/**
 * The two phones, landscape, with the insets their browsers report there. The iPhone keeps the
 * adaptive scale (an A16 holds full scale, as this GPU does); the Pixel draws at the phone tier's
 * resolution floor, where a mid-range Android's scaler settles (DECISIONS.md, "Mobile").
 */
const DEVICES = {
  iphone15: { desc: "iPhone 15 landscape", safe: { top: 0, right: 59, bottom: 21, left: 59 }, q: "" },
  pixel4a: { desc: "Pixel 4a (5G) landscape", safe: { top: 0, right: 0, bottom: 0, left: 26 }, q: "&res=0.8" },
};
/** X player cards: the game in a fixed iframe (480x480 square, 640x360 wide), on a phone too. */
const EMBEDS = [["embed480", 480, 480], ["embed640", 640, 360]];
const WANT = arg("devices", "iphone15,pixel4a").split(",").filter(Boolean);

await fs.rm(OUT, { recursive: true, force: true });
await fs.mkdir(OUT, { recursive: true });
let URL = arg("url", "");
if (!URL) {
  const mode = arg("serve", "preview");
  if (mode === "preview") await fs.access(path.join(ROOT, "dist", "index.html")).catch(() => bye(1, "dist/ missing: run `pnpm build` first, or pass --serve=dev"));
  URL = await serve(ROOT, mode);
  console.log(`[serve] ${mode} ${URL}`);
}
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const layout = {};
const failures = [];
let gpuChecked = false;

for (const key of WANT) {
  const dev = DEVICES[key];
  if (!dev) await bye(1, `unknown device ${key}`);
  const { defaultBrowserType: _, ...d } = devices[dev.desc];
  const ctx = await browser.newContext({ ...d });
  const page = await ctx.newPage();
  const errors = [], late = [];
  fatalShaderErrors(page, key);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (/program\(s\) compiled during play/.test(t)) late.push(t);
    if (m.type() === "error") errors.push(t.slice(0, 300));
  });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: dev.safe });
  const T0 = Date.now();
  await page.goto(`${URL}?progwarn&hints=1&tod=golden${dev.q}`, { waitUntil: "load" });
  if (!gpuChecked) {
    await assertGpu(page);
    gpuChecked = true;
  }
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 400_000, polling: 200 });
  console.log(`[${key}] ready in ${((Date.now() - T0) / 1000).toFixed(1)} s`);
  const vp = d.viewport;
  layout[key] = {
    device: dev.desc, viewport: vp, dpr: d.deviceScaleFactor, safeArea: dev.safe, query: `?progwarn&hints=1&tod=golden${dev.q}`,
    fpsNote: "fps is this desktop GPU (RTX 4060) drawing the emulated phone, not a phone; the phone estimates are in shots/mobile/perf.json",
    shots: {},
  };

  // ------------------------------------------------------------------ touch helpers
  const touches = new Map();
  const send = (type) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: [...touches.values()].map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 9, radiusY: 9, force: 1 })) });
  const down = async (id, x, y) => { touches.set(id, { id, x, y }); await send("touchStart"); };
  const move = async (id, x, y) => { touches.set(id, { id, x, y }); await send("touchMove"); };
  // touchStart and touchMove list every finger down; touchEnd lists the fingers lifting.
  const up = async (id) => {
    const p = touches.get(id);
    touches.delete(id);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: p.x, y: p.y, id: p.id }] });
    return p;
  };
  /** A tap as one more finger (id 9): every finger already down stays in the touch list, so it stays held. */
  const tap = async (x, y) => {
    await down(9, x, y);
    await page.waitForTimeout(60);
    await up(9);
    await page.waitForTimeout(60);
  };
  const L = () => page.evaluate(() => window.__ride.mobile.layout());
  const centre = (r) => [r.x + r.w / 2, r.y + r.h / 2];

  /** Hold the stick (finger 1) and steer her toward world (x, z) for `ms`, re-aiming every 200 ms (k = 0..1 of the throw). */
  async function walkToward(tx, tz, ms, k = 0.6, stop = null) {
    const lay = await L();
    const [sx, sy] = centre(lay.controls.stick);
    await down(1, sx, sy);
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const g = await page.evaluate(() => {
        const r = window.__ride, c = r.camera.position, p = r.player;
        return { cx: c.x, cz: c.z, px: p.x, pz: p.z };
      });
      const oy = Math.atan2(g.cx - g.px, g.cz - g.pz), syw = Math.sin(oy), cyw = Math.cos(oy);
      let wx = tx - g.px, wz = tz - g.pz;
      const dist = Math.hypot(wx, wz);
      if (stop !== null && dist < stop) break;
      wx /= dist || 1;
      wz /= dist || 1;
      const fwd = -syw * wx - cyw * wz, str = cyw * wx - syw * wz;
      await move(1, sx + str * 46 * k, sy - fwd * 46 * k);
      await page.waitForTimeout(200);
    }
    return { sx, sy };
  }

  /** Hold the stick as throttle and tiller toward world (x, z) until stepping ashore is possible (false after `ms`). */
  async function driveToShore(tx, tz, ms) {
    const lay = await L();
    const [sx, sy] = centre(lay.controls.stick);
    await down(1, sx, sy);
    const t0 = Date.now();
    let ok = false;
    while (Date.now() - t0 < ms) {
      const g = await page.evaluate(() => {
        const r = window.__ride, c = r.camera.position, b = r.boat;
        return { cx: c.x, cz: c.z, bx: b.x, bz: b.z, can: !!r.explore?.canStepAshore };
      });
      if (g.can) { ok = true; break; }
      // Steer by the chase camera's forward: the signed angle to the target, right positive.
      const fx = g.bx - g.cx, fz = g.bz - g.cz, dx = tx - g.bx, dz = tz - g.bz;
      const ang = Math.atan2(fx * dz - fz * dx, fx * dx + fz * dz);
      await move(1, sx + Math.max(-1, Math.min(1, ang * 1.4)) * 40, sy - 34);
      await page.waitForTimeout(200);
    }
    await up(1);
    return ok;
  }

  async function shot(name, extra = {}) {
    const file = `${key}_${name}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    const lay = await L();
    const entry = { file, ...lay, consoleErrors: [...errors], lateCompiles: [...late], ...extra };
    layout[key].shots[name] = entry;
    await fs.writeFile(path.join(OUT, "layout.json"), JSON.stringify(layout, null, 1));
    check(key, name, entry);
    console.log(`[${key}] ${name.padEnd(12)} mode=${lay.mode} tod=${lay.tod} fps=${lay.fps} scale=${lay.canvas.scale} canvas=${lay.canvas.w}x${lay.canvas.h} her=${JSON.stringify(lay.her)} boat=${JSON.stringify(lay.boat)}`);
    return entry;
  }

  // ------------------------------------------------------------------ scenes
  // The painting dissolves and "tap to start" fades in over about two seconds.
  await page.waitForTimeout(2400);
  await shot("intro");
  await page.touchscreen.tap(vp.width / 2, vp.height / 2);
  await page.waitForFunction(() => window.__ride.waiting === false, null, { timeout: 10_000 });
  await page.waitForTimeout(2600);
  await shot("pier");

  // Walking: the stick held (finger 1) along the deck toward the shore while a second finger looks round.
  const p0 = await page.evaluate(() => window.__ride.player);
  const lay0 = await L();
  const { sx, sy } = await walkToward(p0.x + 6, p0.z, 1200, 0.6);
  const lx = vp.width * 0.72, ly = vp.height * 0.45;
  await down(2, lx, ly);
  for (let i = 1; i <= 6; i++) {
    await move(2, lx - i * 9, ly - i * 1.5);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(500);
  const walking = await shot("walking", { stickHeld: true, lookHeld: true, speed: (await page.evaluate(() => window.__ride.player.speed)) });
  await up(2);
  await up(1);
  if (!(walking.speed > 0.8)) failures.push(`${key} walking: speed ${walking.speed} (stick not walking her)`);
  // Back to the stair head, where F boards.
  const berth = await page.evaluate(() => window.__ride.boat.berth.stand);
  await walkToward(berth.x, berth.z, 6000, 0.5, 1.0);
  await up(1);
  await page.waitForTimeout(700);

  // Boarding through the F button.
  let lay = await L();
  if (!lay.controls.act.shown) failures.push(`${key} boarding: the F button is not showing at the stair head`);
  await tap(...centre(lay.controls.act));
  // About when she steps from the landing stage down into the skiff.
  await page.waitForTimeout(5000);
  await shot("boarding");
  await page.waitForFunction(() => window.__ride.player.mode === "boat", null, { timeout: 15_000 }).catch(() => failures.push(`${key} boarding: never seated`));
  await page.waitForTimeout(600);
  // Seated at the berth: the step-ashore button, and the boat's one-line card.
  await page.waitForTimeout(900);
  const atBerth = await shot("leave_berth");
  if (!atBerth.controls.act.shown) failures.push(`${key} leave at the berth: no step-ashore button`);
  if (!atBerth.hints?.helmHint?.shown) failures.push(`${key} boat: no "In the boat" card after boarding`);

  // Riding at sunset: T once, then the stick up as throttle, a little steering.
  lay = await L();
  await tap(...centre(lay.controls.tod));
  lay = await L();
  const [bx, by] = centre(lay.controls.stick);
  await down(1, bx, by);
  for (let i = 1; i <= 5; i++) {
    await move(1, bx + i * 1.5, by - i * 7);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(6500);
  await move(1, bx + 14, by - 34);
  await page.waitForTimeout(1500);
  const riding = await shot("riding_sunset", { stickHeld: true, boatSpeed: (await page.evaluate(() => window.__ride.boat.speed)) });
  if (riding.tod !== "sunset") failures.push(`${key} riding: time of day ${riding.tod}, wanted sunset`);
  if (!(riding.boatSpeed > 3)) failures.push(`${key} riding: boat speed ${riding.boatSpeed} (stick not driving it)`);

  // Night: T twice more (dusk, night) with the stick still held, a camera press and back.
  for (let i = 0; i < 2; i++) {
    await tap(...centre(lay.controls.tod));
    await page.waitForTimeout(300);
  }
  await move(1, bx - 10, by - 36);
  await page.waitForTimeout(5200);
  const night = await shot("night", { stickHeld: true });
  if (night.tod !== "night") failures.push(`${key} night: time of day ${night.tod}`);
  if (!night.stick.on) failures.push(`${key} night: the stick let go while T was tapped (multi-touch)`);
  await up(1);
  await page.waitForTimeout(200);
  if ((await L()).stick.on) failures.push(`${key}: the stick is still held after its finger lifted`);

  // The camera button (V then C) and music, checked by state (no picture).
  lay = await L();
  await tap(...centre(lay.controls.cam));
  await page.waitForTimeout(400);
  const camA = await L();
  await tap(...centre(lay.controls.cam));
  await page.waitForTimeout(2600);
  const camB = await L();
  // On through the side shot and back to the chase camera, so the rotation is seen from the ride view.
  await tap(...centre(lay.controls.cam));
  await page.waitForTimeout(2200);
  const camC = await L();
  await tap(...centre(lay.controls.cam));
  await page.waitForTimeout(2600);
  const camD = await L();
  await tap(...centre(lay.controls.mus));
  await page.waitForTimeout(200);
  const musA = await L();
  await tap(...centre(lay.controls.mus));
  await page.waitForTimeout(200);
  const musB = await L();
  const cv = (c) => c.camMode + (c.fpp > 0.5 ? "+fpp" : "");
  layout[key].buttons = { camera: [cv(camA), cv(camB), cv(camC), cv(camD)], music: [musA.music, musB.music], audio: musB.audio };
  console.log(`[${key}] camera button: ${layout[key].buttons.camera.join(" -> ")}; music button: ${musA.music} -> ${musB.music}; audio ${musB.audio}`);
  if (layout[key].buttons.camera.join(" ") !== "chase+fpp front flank chase") failures.push(`${key} camera button: ${layout[key].buttons.camera.join(" -> ")}`);
  if (musA.music === musB.music) failures.push(`${key} music button did not toggle`);

  // Portrait prompt and a rotation: landscape -> portrait -> landscape.
  const before = await shot("rotate_1_landscape");
  // Playwright owns the device emulation: a viewport swap is its rotation (resize and orientation events).
  const orient = (portrait) => page.setViewportSize(portrait ? { width: vp.height, height: vp.width } : vp);
  await orient(true);
  await page.waitForTimeout(1500);
  const port = await shot("rotate_2_portrait");
  if (!port.portrait) failures.push(`${key} portrait: no landscape prompt`);
  await page.screenshot({ path: path.join(OUT, `${key}_portrait.png`) });
  await orient(false);
  await page.waitForTimeout(1500);
  const after = await shot("rotate_3_landscape");
  for (const [n, e] of [["before", before], ["after", after]]) {
    if (e.canvas.cssW !== e.viewport.w || e.canvas.cssH !== e.viewport.h) failures.push(`${key} rotation ${n}: canvas ${e.canvas.cssW}x${e.canvas.cssH} vs viewport ${e.viewport.w}x${e.viewport.h}`);
    if (Math.abs(e.canvas.aspect - e.viewport.w / e.viewport.h) > 0.01) failures.push(`${key} rotation ${n}: camera aspect ${e.canvas.aspect} vs ${(e.viewport.w / e.viewport.h).toFixed(4)}`);
  }
  // Back to day (night -> morning), drive to the beach by the stick and step ashore by the button.
  lay = await L();
  await tap(...centre(lay.controls.tod));
  await page.waitForTimeout(400);
  if (!(await driveToShore(40, -36, 60_000))) failures.push(`${key} beach: never reached water shallow enough to step ashore`);
  await page.waitForTimeout(1500);
  const atBeach = await shot("leave_beach");
  if (!atBeach.controls.act.shown) failures.push(`${key} leave at the beach: no step-ashore button`);
  else {
    await tap(...centre(atBeach.controls.act));
    await page.waitForFunction(() => window.__ride.player.mode === "walk", null, { timeout: 15_000 }).catch(() => failures.push(`${key} beach: the step-ashore button did not put her ashore`));
    await page.waitForTimeout(1200);
    await shot("ashore_beach");
  }

  // On foot at golden: the beach and shallows toward the island, and the dune grass under the hill woods.
  for (const [name, q] of [["beach", "spawn=40,-60,1.4&orbit=0,0.2,4"], ["dunes_woods", "spawn=34,-36,-1.5&orbit=0,0.06,4"]]) {
    await page.goto(`${URL}?progwarn&hints=1&skipintro=1&tod=golden&${q}${dev.q}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__ride?.ready === true, null, { timeout: 400_000, polling: 200 });
    // The On foot card belongs to the pier start: these frames show the ground once it has gone.
    await page.waitForFunction(() => window.__ride.mobile.layout().hints?.card?.shown, null, { timeout: 5_000, polling: 100 }).catch(() => {});
    await page.waitForFunction(() => !window.__ride.mobile.layout().hints?.card?.shown, null, { timeout: 20_000, polling: 250 }).catch(() => failures.push(`${key} ${name}: the On foot card never left`));
    await page.waitForTimeout(1500);
    await shot(name);
  }
  if (errors.length) failures.push(`${key}: ${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`);
  if (late.length) failures.push(`${key}: shaders compiled during play: ${late.join(" | ")}`);
  await ctx.close();
}

// X player cards: a local page holding the game in a fixed iframe, with a phone's touch and user agent.
for (const [key, w, h] of EMBEDS) {
  const { defaultBrowserType: _, ...d } = devices[DEVICES.pixel4a.desc];
  const ctx = await browser.newContext({ ...d, viewport: { width: w, height: h } });
  const page = await ctx.newPage();
  const errors = [], late = [];
  fatalShaderErrors(page, key);
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (/program\(s\) compiled during play/.test(m.text())) late.push(m.text());
    if (m.type() === "error") errors.push(m.text().slice(0, 300));
  });
  const query = `?progwarn&hints=1&tod=golden${DEVICES.pixel4a.q}`;
  await page.setContent(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#111"><iframe src="${URL}${query}" style="position:fixed;left:0;top:0;width:${w}px;height:${h}px;border:0" allow="autoplay; fullscreen"></iframe></body>`);
  let fr = null;
  for (let i = 0; i < 200 && !fr; i++) {
    fr = page.frames().find((f) => f !== page.mainFrame() && f.url().startsWith(URL)) ?? null;
    if (!fr) await page.waitForTimeout(100);
  }
  if (!fr) await bye(1, `${key}: the game's frame never loaded`);
  await fr.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 400_000, polling: 200 });
  const embedded = await fr.evaluate(() => window.self !== window.top);
  await page.waitForTimeout(2400);
  await page.touchscreen.tap(w / 2, h / 2);
  await fr.waitForFunction(() => window.__ride.waiting === false, null, { timeout: 10_000 }).catch(() => failures.push(`${key}: tap to start did not start (the rotate prompt?)`));
  await page.waitForTimeout(2600);
  const file = `${key}_pier.png`;
  await page.screenshot({ path: path.join(OUT, file) });
  const lay = await fr.evaluate(() => window.__ride.mobile.layout());
  const entry = { file, ...lay, embedded, consoleErrors: [...errors], lateCompiles: [...late] };
  layout[key] = { device: `${DEVICES.pixel4a.desc} holding the game in a ${w}x${h} iframe (an X player card)`, viewport: { width: w, height: h }, dpr: d.deviceScaleFactor, safeArea: lay.safeArea, query, shots: { pier: entry } };
  await fs.writeFile(path.join(OUT, "layout.json"), JSON.stringify(layout, null, 1));
  check(key, "pier", entry);
  console.log(`[${key}] pier embedded=${embedded} portrait=${lay.portrait} mode=${lay.mode} canvas=${lay.canvas.w}x${lay.canvas.h} her=${JSON.stringify(lay.her)} boat=${JSON.stringify(lay.boat)}`);
  if (!embedded) failures.push(`${key}: not detected as embedded`);
  if (lay.portrait) failures.push(`${key}: the rotate prompt shows in a ${w}x${h} frame`);
  if (errors.length) failures.push(`${key}: ${errors.length} console error(s): ${errors.slice(0, 3).join(" | ")}`);
  if (late.length) failures.push(`${key}: shaders compiled during play: ${late.join(" | ")}`);
  await ctx.close();
}

/** Controls never over her, the boat or each other; everything inside the safe area. */
function check(key, name, e) {
  if (!e.controls || e.portrait) return;
  const boxes = Object.entries(e.controls).filter(([, b]) => b.shown);
  for (const [n, b] of Object.entries(e.hints ?? {})) if (b.shown) boxes.push([`hint:${n}`, b]);
  const hit = (a, b, pad = 0) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
  const sa = e.safeArea, vw = e.viewport.w, vh = e.viewport.h;
  for (let i = 0; i < boxes.length; i++) {
    const [n, b] = boxes[i];
    if (!n.startsWith("hint") && n !== "stick" && (b.w < 48 || b.h < 48)) failures.push(`${key} ${name}: ${n} is ${b.w}x${b.h} (under 48 px)`);
    if (b.x < sa.left - 0.5 || b.y < sa.top - 0.5 || b.x + b.w > vw - sa.right + 0.5 || b.y + b.h > vh - sa.bottom + 0.5) failures.push(`${key} ${name}: ${n} outside the safe area`);
    for (let j = i + 1; j < boxes.length; j++) if (hit(b, boxes[j][1], 4)) failures.push(`${key} ${name}: ${n} overlaps ${boxes[j][0]}`);
    for (const [who, w] of [["her", e.her], ["the boat", e.boat]]) if (w && hit(b, w)) failures.push(`${key} ${name}: ${n} covers ${who}`);
  }
}

await fs.writeFile(path.join(OUT, "layout.json"), JSON.stringify(layout, null, 1));
await fs.rm(FINAL, { recursive: true, force: true });
await fs.rename(OUT, FINAL);
console.log(`layout: ${path.join(FINAL, "layout.json")}`);
if (failures.length) {
  console.error("\nCHECKS FAILED:");
  for (const f of [...new Set(failures)]) console.error("  " + f);
}
await bye(failures.length ? 1 : 0);
