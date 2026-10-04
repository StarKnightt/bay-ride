#!/usr/bin/env node
/**
 * Render the audio scenarios offline in headless Chromium and print level / spectrum / attack metrics.
 * Writes .gauntlet/audio/metrics.json and preview WAVs (gitignored, never shipped).
 *   node scripts/audio-check.mjs [--only=music-golden,shore-near]
 * Offline rendering is CPU-bound, so this process (and the browser it starts, which inherits the
 * priority class) runs below normal priority. The vite server runs in-process; teardown closes it
 * and the browser on every exit path.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".gauntlet", "audio");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice(7).split(",").filter(Boolean) : [];

await fs.mkdir(OUT, { recursive: true });
const base = await serve(ROOT, "dev", 5433);
const browser = await launchBrowser(["--mute-audio", "--autoplay-policy=no-user-gesture-required"]);
const page = await browser.newPage();
fatalShaderErrors(page, "audio-lab");
page.on("pageerror", (e) => console.error("pageerror:", e.message));
page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
await page.goto(`${base}audio-lab.html`);
await assertGpu(page);
await page.waitForFunction(() => typeof window.runLab === "function", null, { timeout: 60000 });
const res = await page.evaluate((o) => window.runLab(o), only);
const rows = res.metrics;
const cols = ["name", "peakDb", "rmsDb", "maxShortRmsDb", "crestDb", "dc", "clipped", "nans", "above6kDb", "above8kDb", "centroidHz", "onsets", "attackMinMs", "attackMedMs", "bandsDb", "band8kAbsDb", "genMs", "realtimeX", "nodes"];
console.log(cols.join("\t"));
for (const r of rows) console.log(cols.map((c) => r[c]).join("\t"));
console.log("\nvoice\tcount\tattackMinMs\tworstAbove6kDb");
for (const v of res.voices) console.log([v.name, v.count, v.attackMinMs, v.worstAbove6kDb].join("\t"));
await fs.writeFile(path.join(OUT, only.length ? "voices-partial.json" : "voices.json"), JSON.stringify(res.voices, null, 2));
await fs.writeFile(path.join(OUT, only.length ? "metrics-partial.json" : "metrics.json"), JSON.stringify(rows, null, 2));
for (const [name, b64] of Object.entries(res.wavs)) {
  const f = path.join(OUT, `${name}.wav`);
  await fs.writeFile(f, Buffer.from(b64, "base64"));
  console.log("wrote", path.relative(ROOT, f));
}
await bye(0);
