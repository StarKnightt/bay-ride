#!/usr/bin/env node
/**
 * Shader lint on the real GPU: loads pages (default: the opening view, shots 1-5, the boat course)
 * from the current sources, then for every linked program prints the D3D compiler warnings with the
 * offending line of the translated HLSL (WEBGL_debug_shaders), so warnings like X3595 (gradient
 * instruction in a loop) can be traced back to the GLSL. Exits 1 if any warning remains.
 *   node scripts/shaderlint.mjs [--pages=?skipintro=1&t=12,?shot=1&t=12]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n, d) => process.argv.slice(2).find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const PAGES = arg("pages", "?skipintro=1&t=12,?shot=1&t=12,?shot=3&tod=night&t=12,?shot=4&t=12&boat=1,?boat=1&cam=flank&t=4&skipintro=1").split(",");
const URL = await serve(ROOT, "dev");
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio"]);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
let total = 0;
const seen = new Set();
for (const q of PAGES) {
  const page = await ctx.newPage();
  fatalShaderErrors(page, q);
  await page.goto(`${URL}${q}`, { waitUntil: "load" });
  await assertGpu(page);
  await page.waitForFunction(() => window.__ready === true || window.__ride?.ready === true, null, { timeout: 120_000, polling: 100 });
  await page.waitForTimeout(500);
  const rows = await page.evaluate(() => {
    const r = window.__ride;
    const renderer = r.renderer;
    const gl = renderer.getContext();
    const ext = gl.getExtension("WEBGL_debug_shaders");
    const out = [];
    for (const p of renderer.info.programs) {
      const prog = p.program;
      const log = gl.getProgramInfoLog(prog) || "";
      if (!/warning/.test(log)) continue;
      const shaders = gl.getAttachedShaders(prog);
      const src = shaders.map((s) => ({ type: gl.getShaderParameter(s, gl.SHADER_TYPE) === gl.FRAGMENT_SHADER ? "frag" : "vert", hlsl: ext ? ext.getTranslatedShaderSource(s) : "" }));
      const lines = [...new Set([...log.matchAll(/\((\d+),(\d+)-(\d+)\): warning (X\d+)/g)].map((m) => `${m[1]}:${m[4]}`))];
      const hits = lines.map((l) => {
        const [n, code] = l.split(":");
        return { n, code, text: src.map((s) => `${s.type}: ${(s.hlsl.split("\n")[Number(n) - 1] || "").trim().slice(0, 220)}`) };
      });
      out.push({ name: p.name, hits });
    }
    return out;
  });
  for (const r of rows)
    for (const h of r.hits) {
      const key = `${r.name}|${h.text.join("|")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      total++;
      console.log(`[${q}] ${r.name} line ${h.n} ${h.code}\n    ${h.text.join("\n    ")}`);
    }
  await page.close();
}
console.log(total ? `${total} distinct warnings` : "no shader warnings");
await bye(total ? 1 : 0);
