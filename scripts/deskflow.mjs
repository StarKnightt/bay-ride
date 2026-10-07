#!/usr/bin/env node
/**
 * Desktop keyboard and mouse flow, the same on two builds (default: a saved copy of master's build
 * against dist/), at 1920x1080 with no touch: the start click, the hints and F prompts, H help, T,
 * M, walking (W, Shift), Space, F boarding, the helm hint under way, C and V cameras, and a mouse
 * drag look. Input is Playwright's, inside the headless page (never the real mouse or keyboard).
 * Prints a trace per build and every step where the two differ; exits 1 if any visible text or
 * state transition differs, or a desktop page shows any touch control.
 *   node scripts/deskflow.mjs [--a=.gauntlet/tmp/dist-master] [--b=dist] [--query=&mobile=0]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const BUILDS = [arg("a", ".gauntlet/tmp/dist-master"), arg("b", "dist")];
const EXTRA = arg("query", "");
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
let gpu = false;

async function run(dist, port) {
  const URL = await serve(ROOT, "preview", port, dist);
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  fatalShaderErrors(page, dist);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => (m.type() === "error" || /compiled during play/.test(m.text())) && errors.push(m.text().slice(0, 200)));
  await page.goto(`${URL}?hints=1&tod=golden&progwarn${EXTRA}`, { waitUntil: "load" });
  if (!gpu) {
    await assertGpu(page);
    gpu = true;
  }
  await page.waitForFunction(() => window.__ride?.waiting === true, null, { timeout: 400_000, polling: 200 });
  const trace = [];
  const snap = async (step) => {
    const s = await page.evaluate(() => {
      const r = window.__ride, vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.classList.contains("on")).map((e) => e.textContent.trim());
      return {
        start: document.querySelector("#loader .start")?.textContent ?? null,
        card: vis(".bh-card"),
        lines: vis(".bh-hint"),
        help: document.querySelector(".help")?.classList.contains("on") ?? false,
        touchUi: !!document.querySelector(".tc, .tc-port"),
        mode: r.player.mode,
        moving: r.player.speed > 0.4,
        tod: r.timeOfDay,
        music: r.audio.music,
        cam: r.explore.inBoat ? r.camera.fov.toFixed(0) : "walk",
        air: r.explore.foot.air,
      };
    });
    trace.push([step, s]);
  };
  await snap("loader");
  await page.mouse.click(960, 540);
  await page.waitForTimeout(2500);
  await snap("started");
  const key = async (k, ms = 400) => {
    await page.keyboard.press(k);
    await page.waitForTimeout(ms);
  };
  await key("KeyH", 700);
  await snap("H");
  await key("KeyH", 700);
  await snap("H again");
  await key("KeyT", 300);
  await snap("T");
  await key("KeyM", 300);
  await snap("M");
  await key("KeyM", 300);
  await snap("M again");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(900);
  await snap("W held");
  await page.keyboard.down("ShiftLeft");
  await page.waitForTimeout(700);
  await snap("Shift+W held");
  await page.keyboard.up("ShiftLeft");
  await page.keyboard.up("KeyW");
  await page.waitForTimeout(1200);
  await page.keyboard.press("Space");
  await page.waitForTimeout(250);
  await snap("Space");
  await page.waitForTimeout(1500);
  // Mouse look on foot: a drag across the canvas swings the orbit camera round her.
  const before = await page.evaluate(() => window.__ride.camera.position.toArray());
  await page.mouse.move(900, 500);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(900 + i * 25, 500, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__ride.camera.position.toArray());
  trace.push(["mouse drag moved the camera", { moved: Math.hypot(after[0] - before[0], after[2] - before[2]) > 0.01 }]);
  // Back to the spawn (where F boards) and F.
  await page.evaluate(() => window.__ride.standAt(window.__ride.player.spawn.x, window.__ride.player.spawn.z, window.__ride.player.spawn.yaw));
  await page.waitForTimeout(800);
  await snap("at the boat");
  await key("KeyF", 9000);
  await snap("F (aboard)");
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(2500);
  await snap("W under way");
  await page.keyboard.up("KeyW");
  await key("KeyC", 2400);
  await snap("C");
  await key("KeyV", 1200);
  await snap("V");
  trace.push(["console errors", { n: errors.length }]);
  await ctx.close();
  return { trace, errors };
}

const [A, B] = [await run(BUILDS[0], 5450), await run(BUILDS[1], 5460)];
let diffs = 0;
for (let i = 0; i < Math.max(A.trace.length, B.trace.length); i++) {
  const [sa, a] = A.trace[i] ?? ["-", {}], [, b] = B.trace[i] ?? ["-", {}];
  // Whether she is moving at that instant depends on frame timing; everything else must match
  // (the camera's field of view settles to 45 chase, 38 front shot, 70 first person).
  const strip = (o) => JSON.stringify({ ...o, moving: undefined });
  const same = strip(a) === strip(b);
  if (!same) diffs++;
  console.log(`${same ? "  " : "!!"} ${sa.padEnd(28)} ${JSON.stringify(a)}${same ? "" : `\n   ${"".padEnd(28)} ${JSON.stringify(b)}`}`);
}
const touchShown = B.trace.some(([, s]) => s.touchUi);
if (touchShown) console.log("!! a desktop page showed a touch control");
console.log(diffs || touchShown ? `FLOWS DIFFER (${diffs} steps)` : `flows identical (${A.trace.length} steps) on ${BUILDS.join(" and ")}`);
for (const e of [...A.errors, ...B.errors]) console.log("  error:", e);
await bye(diffs || touchShown || A.errors.length || B.errors.length ? 1 : 0);
