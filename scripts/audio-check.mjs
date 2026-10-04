#!/usr/bin/env node
/**
 * Render the audio scenarios offline in headless Chromium and print level / spectrum / attack metrics.
 * Writes .gauntlet/audio/metrics.json and preview WAVs (gitignored, never shipped).
 *   node scripts/audio-check.mjs [--only=music-golden,shore-near]
 */
import { chromium } from "playwright";
import { createServer } from "vite";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, ".gauntlet", "audio");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice(7).split(",").filter(Boolean) : [];

await fs.mkdir(OUT, { recursive: true });
const server = await createServer({ root: ROOT, logLevel: "error", server: { port: 5433, strictPort: true } });
await server.listen();
const browser = await chromium.launch({ headless: true, args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  page.on("console", (m) => m.type() === "error" && console.error("console:", m.text()));
  await page.goto("http://localhost:5433/audio-lab.html");
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
} finally {
  await browser.close();
  await server.close();
}
