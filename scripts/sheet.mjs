#!/usr/bin/env node
/**
 * Contact sheet of captures (headless Chromium on the GPU like every other browser script; prints
 * the renderer and tears the browser down on every exit path):
 *   node scripts/sheet.mjs --out=shots/x/sheet.jpg --cols=4 [--w=480] [--crop=x,y,w,h] a.png b.png ...
 * --crop takes a region of each source image in source pixels (default: whole image).
 */
import fs from "node:fs/promises";
import path from "node:path";
import { assertGpu, bye, launchBrowser } from "./lib/harness.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const files = argv.filter((a) => !a.startsWith("--"));
const out = path.resolve(arg("out", "sheet.jpg"));
const cols = Number(arg("cols", "4"));
const w = Number(arg("w", "480"));
const crop = arg("crop", "0,0,1920,1080").split(",").map(Number);
// --fit: images of any size (phone captures), each scaled whole into a cell of --aspect (width / height).
const FIT = argv.includes("--fit");
const h = FIT ? Math.round(w / Number(arg("aspect", "2.2"))) : Math.round((w * crop[3]) / crop[2]);
const s = w / crop[2];

const cells = await Promise.all(
  files.map(async (f) => {
    const b64 = (await fs.readFile(f)).toString("base64");
    const label = path.basename(f).replace(/\.png$/, "");
    const img = FIT
      ? `<img src="data:image/png;base64,${b64}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain">`
      : `<img src="data:image/png;base64,${b64}" style="position:absolute;left:${-crop[0] * s}px;top:${-crop[1] * s}px;width:${1920 * s}px">`;
    return `<div style="position:relative;width:${w}px;height:${h}px;overflow:hidden">
      ${img}
      <span style="position:absolute;left:3px;top:2px;font:12px sans-serif;color:#fff;text-shadow:0 0 2px #000">${label}</span></div>`;
  }),
);
const html = `<body style="margin:0;background:#222;display:grid;grid-template-columns:repeat(${cols},${w}px);gap:2px">${cells.join("")}</body>`;
const rows = Math.ceil(files.length / cols);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: cols * (w + 2), height: rows * (h + 2) } });
await assertGpu(page);
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: out, type: "jpeg", quality: 85, fullPage: true });
console.log(out);
await bye(0);
