#!/usr/bin/env node
/**
 * Evaluate expressions in a running page (headless, real GPU, served from the sources) and print
 * the results as JSON, e.g. where the player and the boat are in the opening:
 *   node scripts/probe.mjs --page="?skipintro=1&t=12" --eval="__ride.player" --eval="__ride.boat"
 * Each --eval is evaluated in order after the page is ready (a returned promise is awaited, so
 * expressions can press keys and wait). Exits 1 on shader errors or a thrown expression.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const evals = argv.filter((a) => a.startsWith("--eval=")).map((a) => a.slice(7));
const URL = await serve(ROOT, arg("serve", "dev"));
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
fatalShaderErrors(page, "probe");
await page.goto(`${URL}${arg("page", "?skipintro=1&t=12")}`, { waitUntil: "load" });
await assertGpu(page);
await page.waitForFunction(() => window.__ready === true || window.__ride?.ready === true, null, { timeout: 120_000, polling: 100 });
await page.waitForTimeout(Number(arg("wait", "300")));
let failed = false;
for (const e of evals) {
  try {
    const v = await page.evaluate(async (src) => JSON.parse(JSON.stringify((await (0, eval)(src)) ?? null)), e);
    console.log(`${e} =`, JSON.stringify(v));
  } catch (err) {
    failed = true;
    console.log(`${e} threw:`, String(err).split("\n")[0]);
  }
}
bye(failed ? 1 : 0);
