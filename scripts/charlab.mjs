#!/usr/bin/env node
/**
 * Approval renders of the heroine in the game's own renderer (character-lab.html), headless on the
 * real GPU through scripts/lib/harness.mjs (in-process dev server, installed Chrome, GPU flags,
 * renderer string printed, shader errors fatal, teardown on every exit path).
 *   node scripts/charlab.mjs [--out=shots/heroine] [--only=front_noon,face_noon] [--res=1920x1080]
 * Shots: front/side/back at noon and golden (idle), face front and three-quarter, the tiller pose
 * from the three-quarter front, and a 6-frame walk strip (walk_strip.png).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const OUT = path.join(ROOT, arg("out", "shots/heroine"));
const ONLY = arg("only", "").split(",").filter(Boolean);
const [W, H] = arg("res", "1920x1080").split("x").map(Number);
const EXTRA = arg("extra", "");

const SHOTS = [
  ["front_noon", { view: "front", tod: "noon" }],
  ["side_noon", { view: "side", tod: "noon" }],
  ["back_noon", { view: "back", tod: "noon" }],
  ["front_golden", { view: "front", tod: "golden" }],
  ["side_golden", { view: "side", tod: "golden" }],
  ["back_golden", { view: "back", tod: "golden" }],
  ["face_noon", { view: "face", tod: "noon" }],
  ["face34_noon", { view: "face34", tod: "noon" }],
  ["face_golden", { view: "face", tod: "golden" }],
  ["face_noglasses_noon", { view: "face", tod: "noon", glasses: false }],
  ["sit_tiller_noon", { view: "sit", tod: "noon" }],
];

await fs.mkdir(OUT, { recursive: true });
const URL = await serve(ROOT, "dev");
console.log(`[serve] dev ${URL}`);
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
const problems = [];
fatalShaderErrors(page, "lab");
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") problems.push(`${m.type()}: ${m.text().slice(0, 400)}`);
});
await page.goto(`${URL}character-lab.html?view=front&tod=noon${EXTRA ? `&${EXTRA}` : ""}`, { waitUntil: "load" });
await assertGpu(page);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120_000, polling: 100 });
const info = await page.evaluate(() => ({ clips: window.__lab.clips, tris: window.__lab.tris, bones: window.__lab.bones.length }));
console.log(`[lab] ${info.tris} triangles, ${info.bones} bones, clips: ${info.clips.join(", ") || "(none)"}`);

const want = (n) => !ONLY.length || ONLY.some((o) => n.startsWith(o));
for (const [name, s] of SHOTS) {
  if (!want(name)) continue;
  const calls = await page.evaluate((s) => window.__lab.shot(s), s);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`${name.padEnd(22)} calls=${calls}`);
}

if (want("walk")) {
  const dur = await page.evaluate(() => window.__lab.meta.clips?.walk?.duration ?? 1.1);
  const frames = [];
  for (let k = 0; k < 6; k++) {
    await page.evaluate((s) => window.__lab.shot(s), { view: "walk", tod: "noon", clip: "walk", t: (k / 6) * dur });
    frames.push((await page.screenshot()).toString("base64"));
  }
  // Six side-view frames, each cropped round her, side by side.
  const strip = await page.evaluate(async ({ frames, W, H }) => {
    const cw = Math.round(W / 3), c = document.createElement("canvas");
    c.width = cw * frames.length;
    c.height = H;
    const g = c.getContext("2d");
    for (let i = 0; i < frames.length; i++) {
      const img = new Image();
      img.src = `data:image/png;base64,${frames[i]}`;
      await img.decode();
      g.drawImage(img, (W - cw) / 2, 0, cw, H, i * cw, 0, cw, H);
    }
    return c.toDataURL("image/png").split(",")[1];
  }, { frames, W, H });
  await fs.writeFile(path.join(OUT, "walk_strip.png"), Buffer.from(strip, "base64"));
  console.log(`walk_strip             6 frames over ${dur.toFixed(2)} s`);
}

if (problems.length) {
  console.error("\nPage errors/warnings:");
  for (const p of [...new Set(problems)].slice(0, 30)) console.error("  " + p);
}
await bye(problems.some((p) => p.startsWith("pageerror")) ? 1 : 0);
