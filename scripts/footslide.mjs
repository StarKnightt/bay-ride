#!/usr/bin/env node
/**
 * Foot slide, measured in the game (headless, real GPU, served from the sources): her rider is
 * driven at 60 Hz through scripted manoeuvres on the real ground (the pier deck, the beach slope)
 * and, for every frame a foot is in contact, the contact point on the sole (the lower of heel and
 * ball) is compared with the same point a frame earlier. Prints per scenario: stance frames, mean
 * and 95th-percentile slide per frame (mm), mean slide speed (mm/s), the worst drift over one
 * stance (mm) and the sole's height over the ground while planted (mm).
 *   node scripts/footslide.mjs [--serve=dev|dist]
 * Exits 1 on shader errors or a page error.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const URL = await serve(ROOT, arg("serve", "dev"));
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
let failed = false;

/** Scenarios: page, then per-frame [speed m/s, run 0…1, yaw rate rad/s] as a function of time (s). */
const SCENARIOS = [
  ["walk straight (deck)", "?skipintro=1&t=12&tod=noon", 4, "() => [1.3, 0, 0]"],
  ["run straight (deck)", "?skipintro=1&t=12&tod=noon", 3, "() => [3.4, 1, 0]"],
  ["walk, turning 1.2 rad/s (deck)", "?skipintro=1&t=12&tod=noon", 5, "() => [1.3, 0, 1.2]"],
  ["start, run, stop (deck)", "?skipintro=1&t=12&tod=noon", 5,
    "(t) => { const v = t < 2 ? 1.7 * t : t < 3.5 ? 3.4 - 2.27 * (t - 2) : 0; return [v, Math.min(1, Math.max(0, (v - 1.3) / 2.1)), 0]; }"],
  ["turn on the spot 1.5 rad/s (deck)", "?skipintro=1&t=12&tod=noon", 4, "(t) => [0, 0, t > 0.5 && t < 2.5 ? 1.5 : 0]"],
  ["walk up the beach slope", "?pose=wade&t=12&tod=noon", 5, "() => [1.3, 0, 0]"],
];

async function run(name, query, secs, profile) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => {
    failed = true;
    console.log("[pageerror]", String(e).split(/\n/)[0]);
  });
  fatalShaderErrors(page, "footslide");
  await page.goto(`${URL}${query}`, { waitUntil: "load" });
  await assertGpu(page);
  await page.waitForFunction(() => window.__ready === true || window.__ride?.ready === true, null, { timeout: 300_000, polling: 100 });
  const res = await page.evaluate(
    ({ secs, profile, beach }) => {
      const R = window.__ride, r = R.rider, w = r.walker, V = w.position.constructor;
      const prof = (0, eval)(profile);
      const dt = 1 / 60;
      let yaw = Math.atan2(-(new V(0, 0, -1).applyQuaternion(w.quaternion)).x, -(new V(0, 0, -1).applyQuaternion(w.quaternion)).z);
      // On the deck she starts at the pier end facing the sea: walk back toward land. On the beach: uphill (+x).
      yaw = beach ? -Math.PI / 2 : yaw + Math.PI;
      const pos = w.position.clone();
      let phase = 0, time = 100;
      const f = { speed: 0, phase: 0, run: 0, turn: 0, look: 0, lookUp: 0, time, seat: 0, boating: false, air: 0, jumpW: 0, wind: 0, roll: 0 };
      const heel = [new V(), new V()], ball = [new V(), new V()], prevH = [new V(), new V()], prevB = [new V(), new V()];
      const was = [false, false];
      const slides = [], gaps = [];
      let stances = 0;
      const n = Math.round(secs / dt);
      for (let k = -60; k < n; k++) {
        const t = Math.max(0, k) * dt;
        const [v, run, turn] = k < 0 ? [0, 0, 0] : prof(t);
        yaw += turn * dt;
        pos.x += -Math.sin(yaw) * v * dt;
        pos.z += -Math.cos(yaw) * v * dt;
        const g = r.ground?.(pos.x, pos.z, pos.y);
        if (g) pos.y = k < 0 ? g.h : g.h + (pos.y - g.h) * Math.exp(-14 * dt);
        phase += ((v * dt) / R.gaitCycle(run, v)) * Math.PI * 2;
        time += dt;
        w.position.copy(pos);
        w.rotation.set(0, yaw, 0);
        Object.assign(f, { speed: v, run, turn, phase, time });
        r.update(dt, f);
        for (let i = 0; i < 2; i++) {
          r.soleWorld(i, heel[i], ball[i]);
          const useHeel = heel[i].y < ball[i].y;
          const P = useHeel ? heel[i] : ball[i], P0 = useHeel ? prevH[i] : prevB[i];
          const c = r.contact[i];
          if (k >= 0 && c && was[i]) {
            slides.push(Math.hypot(P.x - P0.x, P.z - P0.z));
            const gr = r.ground?.(P.x, P.z, P.y);
            if (gr) gaps.push(P.y - gr.h);
          }
          if (k >= 0 && !c && was[i]) stances++;
          was[i] = c;
          prevH[i].copy(heel[i]);
          prevB[i].copy(ball[i]);
        }
      }
      slides.sort((a, b) => a - b);
      const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
      const p95 = slides.length ? slides[Math.floor(slides.length * 0.95)] : 0;
      return {
        frames: slides.length, stances,
        meanMm: mean(slides) * 1000, p95Mm: p95 * 1000, maxMm: (slides.at(-1) ?? 0) * 1000,
        speedMmS: (mean(slides) * 1000) / dt,
        gapMm: mean(gaps) * 1000, gapMaxMm: Math.max(0, ...gaps.map(Math.abs)) * 1000,
      };
    },
    { secs, profile, beach: query.includes("wade") },
  );
  const f1 = (x) => x.toFixed(1);
  console.log(
    `${name.padEnd(36)} stance frames ${String(res.frames).padStart(4)}  slide/frame mean ${f1(res.meanMm)} mm  p95 ${f1(res.p95Mm)} mm  max ${f1(res.maxMm)} mm  (${f1(res.speedMmS)} mm/s)  sole-ground ${f1(res.gapMm)} mm (|max| ${f1(res.gapMaxMm)})`,
  );
  await page.close();
  return res;
}

for (const [name, q, secs, prof] of SCENARIOS) await run(name, q, secs, prof);
bye(failed ? 1 : 0);
