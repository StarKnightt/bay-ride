#!/usr/bin/env node
/**
 * Cold-boot probe: loads the game once in a fresh headless Chrome (fresh profile, so no cached
 * shader programs) on the real GPU and reports how the boot behaves on the main thread:
 *   node scripts/bootprobe.mjs [--serve=preview|dev] [--page="?tod=golden"] [--serial] [--play]
 *                               [--out=shots/boot-fix/before] [--dump] [--timeout=900]
 * - timeline: loader moving (the painted intro's second frame), first frame drawn to the canvas,
 *   interactive (free play: the click-to-start veil is waiting; skipintro pages: warm-up done);
 * - freezes: requestAnimationFrame gaps (any gap is a frozen loader), long tasks, and every WebGL
 *   call that blocked the main thread for more than 8 ms (with the program it was waiting on);
 * - programs: every linkProgram (count, material/shader name, source sizes) and every first draw per
 *   program x target x vertex format (ANGLE on D3D11 builds draw-time shader variants there);
 * - --serial waits for each program's link and each first draw (gl.finish) as it is issued, so each
 *   one's cold compile cost is measured on its own: the top 10 slowest programs are printed;
 * - --play then clicks in and plays (walk, run, jump, board, throttle, boost, steer, T through all
 *   six times of day) and lists every program or draw variant that compiled after loading;
 * - --dump writes each program's vertex and fragment source next to the JSON report;
 * - --again reloads once more in the same browser (programs from Chrome's cache: a returning visit).
 * Uses scripts/lib/harness.mjs: teardown on every exit path, GPU check, shader errors fatal.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertGpu, bye, fatalShaderErrors, launchBrowser, serve } from "./lib/harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (n, d) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const SERIAL = argv.includes("--serial");
const PLAY = argv.includes("--play");
const DUMP = argv.includes("--dump");
const PAGE = arg("page", "?tod=golden");
const OUT = path.join(ROOT, arg("out", `shots/boot-fix/probe${SERIAL ? "-serial" : ""}`));
const TIMEOUT = Number(arg("timeout", "900")) * 1000;
const [W, H] = arg("res", "1920x1080").split("x").map(Number);

/** Runs in the page before any of its scripts. */
function instrument({ serial }) {
  const B = (window.__boot = { serial, gaps: [], long: [], progs: [], blocks: [], variants: [], marks: {}, rafN: 0, glMs: 0, src: [] });
  const now = () => performance.now();
  let last = 0;
  const tick = (t) => {
    B.rafN++;
    if (last && t - last > 50) B.gaps.push([Math.round(last), Math.round(t - last)]);
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) B.long.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  new MutationObserver((_, mo) => {
    if (!document.querySelector("#loader canvas.intro")) return;
    mo.disconnect();
    B.marks.introAt = now();
    requestAnimationFrame(() => requestAnimationFrame(() => (B.marks.loaderMoving = now())));
  }).observe(document, { childList: true, subtree: true });

  const P = WebGL2RenderingContext.prototype;
  const orig = {};
  for (const k of Object.getOwnPropertyNames(P)) {
    try {
      if (typeof P[k] === "function") orig[k] = P[k];
    } catch {}
  }
  const progs = new Map(), src = new Map(), att = new Map(), fbos = new Map(), vaos = new Map();
  const drawBufs = new Map(), seen = new Set();
  let curProg = null, curFbo = 0, curVao = null, fboN = 0, vaoN = 0;
  window.__bootMaps = { progs, fbos };
  const vaoState = (v) => {
    let s = vaos.get(v ?? "default");
    if (!s) vaos.set(v ?? "default", (s = { id: vaoN++, fmt: new Map(), on: new Set() }));
    return s;
  };
  const sig = () => {
    const s = vaoState(curVao);
    return [...s.on].sort((a, b) => a - b).map((i) => `${i}:${s.fmt.get(i) ?? "?"}`).join(" ");
  };
  const wrap = (name, fn) => {
    if (orig[name]) P[name] = fn(orig[name]);
  };
  wrap("shaderSource", (o) => function (sh, s) {
    src.set(sh, s);
    return o.call(this, sh, s);
  });
  wrap("attachShader", (o) => function (p, sh) {
    if (!att.has(p)) att.set(p, []);
    att.get(p).push(sh);
    return o.call(this, p, sh);
  });
  wrap("linkProgram", (o) => function (p) {
    const ss = (att.get(p) ?? []).map((s) => src.get(s) ?? "");
    const vs = ss.find((s) => /gl_Position/.test(s)) ?? "";
    const fs = ss.find((s) => s !== vs) ?? "";
    const name = (/#define SHADER_NAME (.*)/.exec(fs)?.[1] ?? "").trim();
    const defs = [...fs.matchAll(/^#define (MT_MASK_V|RIDER|USE_INSTANCING|USE_SKINNING|DOUBLE_SIDED|FLIP_SIDED|ALPHA_TO_COVERAGE|USE_FOG)\b(.*)$/gm)].map((m) => (m[1] + m[2]).trim());
    const rec = { id: B.progs.length, t: Math.round(now()), name, defs: defs.join(" "), vsLen: vs.length, fsLen: fs.length, link: -1, done: 0, block: 0 };
    B.progs.push(rec);
    B.src.push([vs, fs]);
    progs.set(p, rec);
    const r = o.call(this, p);
    if (serial) {
      const s = now();
      orig.getProgramParameter.call(this, p, this.LINK_STATUS);
      rec.link = Math.round(now() - s);
      rec.done = Math.round(now());
    }
    return r;
  });
  const SYNC = ["getProgramParameter", "getShaderParameter", "getProgramInfoLog", "getShaderInfoLog", "getUniformLocation", "getActiveUniform", "getActiveAttrib", "getAttribLocation", "getUniformBlockIndex", "getActiveUniforms", "getUniformIndices", "getActiveUniformBlockParameter", "getError", "readPixels", "finish", "getParameter", "checkFramebufferStatus", "clientWaitSync", "getExtension", "getSupportedExtensions", "getContextAttributes"];
  for (const name of SYNC)
    wrap(name, (o) => function (...a) {
      const s = now();
      const r = o.apply(this, a);
      const d = now() - s;
      B.glMs += d;
      const rec = progs.get(a[0]);
      if (rec) rec.block += d;
      if (d > 8) B.blocks.push([Math.round(s), Math.round(d), name, rec?.id ?? -1]);
      if (rec && !rec.done && name === "getProgramParameter" && (a[1] === 0x91b1 || a[1] === this.LINK_STATUS) && r) rec.done = Math.round(now());
      return r;
    });
  wrap("useProgram", (o) => function (p) {
    curProg = p;
    return o.call(this, p);
  });
  wrap("bindFramebuffer", (o) => function (target, fb) {
    if (target === this.FRAMEBUFFER || target === this.DRAW_FRAMEBUFFER) {
      if (fb && !fbos.has(fb)) fbos.set(fb, ++fboN);
      curFbo = fb ? fbos.get(fb) : 0;
    }
    return o.call(this, target, fb);
  });
  wrap("drawBuffers", (o) => function (b) {
    drawBufs.set(curFbo, Array.from(b, (x) => (x === 0 ? "-" : x - 0x8ce0)).join(""));
    return o.call(this, b);
  });
  wrap("bindVertexArray", (o) => function (v) {
    curVao = v;
    return o.call(this, v);
  });
  wrap("vertexAttribPointer", (o) => function (i, size, type, norm, ...r) {
    vaoState(curVao).fmt.set(i, `${type.toString(16)}${norm ? "n" : ""}`);
    return o.call(this, i, size, type, norm, ...r);
  });
  wrap("vertexAttribIPointer", (o) => function (i, size, type, ...r) {
    vaoState(curVao).fmt.set(i, `${type.toString(16)}I`);
    return o.call(this, i, size, type, ...r);
  });
  wrap("enableVertexAttribArray", (o) => function (i) {
    vaoState(curVao).on.add(i);
    return o.call(this, i);
  });
  wrap("disableVertexAttribArray", (o) => function (i) {
    vaoState(curVao).on.delete(i);
    return o.call(this, i);
  });
  for (const name of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"])
    wrap(name, (o) => function (...a) {
      const r = o.apply(this, a);
      const rec = progs.get(curProg);
      const key = `${rec?.id ?? -1}|${curFbo}|${drawBufs.get(curFbo) ?? ""}|${sig()}`;
      if (!seen.has(key)) {
        seen.add(key);
        let ms = -1;
        if (serial) {
          // getError is a round trip to the GPU process (Chrome's finish() only flushes), so it
          // waits for this draw, including any shader variant ANGLE builds for it.
          const s = now();
          orig.getError.call(this);
          ms = Math.round(now() - s);
        }
        B.variants.push([rec?.id ?? -1, curFbo, drawBufs.get(curFbo) ?? "", Math.round(now()), ms, sig()]);
        if (B.marks.firstScreenDraw === undefined && curFbo === 0) B.marks.firstScreenDraw = Math.round(now());
      }
      return r;
    });
}

await fs.mkdir(OUT, { recursive: true });
const URL = await serve(ROOT, arg("serve", "preview"));
console.log(`[serve] ${arg("serve", "preview")} ${URL}`);
const browser = await launchBrowser(["--hide-scrollbars", "--mute-audio", "--disable-gpu-shader-disk-cache"]);
const ctx = await browser.newContext({ viewport: { width: W, height: H } });
{
  const p = await ctx.newPage();
  await p.goto("about:blank");
  await assertGpu(p);
  await p.close();
}
const page = await ctx.newPage();
fatalShaderErrors(page, "boot");
const consoleLog = [];
page.on("pageerror", (e) => console.log("[pageerror]", String(e).split(/\n/).slice(0, 3).join(" | ")));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" || m.type() === "warning") consoleLog.push(`[${m.type()}] ${t.slice(0, 400)}`);
});
await page.addInitScript(instrument, { serial: SERIAL });
const t0 = Date.now();
await page.goto(`${URL}${PAGE}`, { waitUntil: "commit" });
const free = !/skipintro=1|shot=|cam=|pose=/.test(PAGE);
await page.waitForFunction(
  (free) => {
    const r = window.__ride;
    const ok = free ? r?.waiting === true : r?.ready === true;
    if (ok) window.__boot.marks.interactive ??= Math.round(performance.now());
    return ok;
  },
  free,
  { timeout: TIMEOUT, polling: 100 },
);
console.log(`[boot] reached ${free ? "click-to-start" : "ready"} after ${((Date.now() - t0) / 1000).toFixed(1)} s (wall clock)`);
// Let the post-boot frames run a little (warm-up frames, first SMAA warm).
await page.waitForTimeout(1500);

/** Program labels from three's own bookkeeping: which materials and meshes use each GL program. */
const collect = () =>
  page.evaluate(() => {
    const B = window.__boot, M = window.__bootMaps, R = window.__ride;
    const labels = new Map();
    const add = (glp, s) => {
      const rec = M.progs.get(glp);
      if (!rec) return;
      const l = labels.get(rec.id) ?? new Set();
      if (l.size < 4) l.add(s);
      labels.set(rec.id, l);
    };
    const r = R.renderer;
    const label = (o, m) => {
      const ud = m.userData?.uber;
      return `${m.type}${m.name ? ":" + m.name : ""}${ud ? `:uber(${ud.id},${ud.mask})` : ""}@${o.name || o.parent?.name || o.type}`;
    };
    R.scene.traverse((o) => {
      for (const m of [o.material].flat()) {
        if (!m) continue;
        const ps = r.properties.get(m).programs;
        if (ps) for (const p of ps.values()) add(p.program, label(o, m));
      }
    });
    for (const pass of R.post.composer.passes)
      for (const [k, v] of Object.entries(pass))
        for (const m of [v, v?.material, ...(Array.isArray(v) ? v : [])].filter((x) => x?.isMaterial)) {
          const ps = r.properties.get(m).programs;
          if (ps) for (const p of ps.values()) add(p.program, `post:${pass.constructor.name}.${k}`);
        }
    const fboNames = {};
    const nameRt = (rt, n) => {
      const pr = r.properties.get(rt);
      for (const fb of [pr.__webglMultisampledFramebuffer, pr.__webglFramebuffer].flat()) if (fb && M.fbos.has(fb)) fboNames[M.fbos.get(fb)] = n;
    };
    nameRt(R.post.mrt, "mrt");
    return {
      marks: B.marks,
      rafN: B.rafN,
      gaps: B.gaps,
      long: B.long,
      blocks: B.blocks,
      glMs: Math.round(B.glMs),
      progs: B.progs.map((p) => ({ ...p, block: Math.round(p.block), uses: [...(labels.get(p.id) ?? [])] })),
      variants: B.variants,
      fboNames,
      threePrograms: r.info.programs?.length ?? -1,
      bootLog: R.bootLog,
    };
  });

const rep = await collect();
const sum = (a) => a.reduce((s, x) => s + x, 0);
const fmt = (ms) => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(2)} s`);
console.log(`[timeline] loader moving ${fmt(rep.marks.loaderMoving)}, first frame on the canvas ${fmt(rep.marks.firstScreenDraw)}, interactive ${fmt(rep.marks.interactive)}`);
console.log(`[bootLog] ${rep.bootLog.map(([k, v]) => `${k} ${v}`).join(", ")}`);
const until = rep.marks.interactive ?? Infinity;
const gaps = rep.gaps.filter(([t]) => t < until);
const big = gaps.filter(([, g]) => g > 100);
console.log(`[frames] rAF callbacks ${rep.rafN}; gaps >100 ms before interactive: ${big.length}, frozen ${fmt(sum(big.map((g) => g[1])))}, longest ${fmt(Math.max(0, ...gaps.map((g) => g[1])))}`);
console.log(`  longest gaps (start s, ms): ${[...gaps].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, g]) => `${(t / 1000).toFixed(1)}:${g}`).join("  ")}`);
const lt = rep.long.filter(([t]) => t < until);
console.log(`[longtasks] ${lt.length} before interactive, total ${fmt(sum(lt.map((l) => l[1])))}; top: ${[...lt].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, d]) => `${(t / 1000).toFixed(1)}:${d}`).join("  ")}`);
console.log(`[gl] time blocked in sync WebGL calls ${fmt(rep.glMs)}; longest: ${[...rep.blocks].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t, d, n, id]) => `${(t / 1000).toFixed(1)}:${n}#${id}=${d}`).join("  ")}`);
const vBefore = rep.variants.filter((v) => v[3] < until);
console.log(`[programs] linked ${rep.progs.length} (three: ${rep.threePrograms}); first draws per program x target x vertex format: ${vBefore.length}`);
const cost = new Map(rep.progs.map((p) => [p.id, { p, link: Math.max(0, p.link), draw: 0, n: 0 }]));
for (const [id, , , , ms] of vBefore) {
  const c = cost.get(id);
  if (c && ms > 0) {
    c.draw += ms;
    c.n++;
  }
}
const ranked = [...cost.values()].sort((a, b) => b.link + b.draw - (a.link + a.draw));
const desc = (p) => `${p.name || "?"} ${p.defs} fs ${(p.fsLen / 1000).toFixed(0)}k vs ${(p.vsLen / 1000).toFixed(0)}k  ${p.uses.slice(0, 3).join(" | ")}`;
if (SERIAL) {
  console.log(`[serial] link total ${fmt(sum(ranked.map((c) => c.link)))}, first-draw total ${fmt(sum(ranked.map((c) => c.draw)))}; top 10 programs (link + first draws):`);
  for (const c of ranked.slice(0, 10)) console.log(`  #${c.p.id} ${String(c.link + c.draw).padStart(6)} ms = link ${c.link} + draws ${c.draw} (${c.n})  ${desc(c.p)}`);
} else {
  const lat = rep.progs.filter((p) => p.done).map((p) => ({ p, ms: p.done - p.t })).sort((a, b) => b.ms - a.ms);
  console.log(`  slowest link-to-ready latencies (parallel compile, overlapping): ${lat.slice(0, 10).map(({ p, ms }) => `#${p.id}=${ms}`).join(" ")}`);
}

if (argv.includes("--again")) {
  // A second load in the same browser: the programs come from Chrome's cache (a returning visit).
  const t1 = Date.now();
  await page.reload({ waitUntil: "commit" });
  await page.waitForFunction(
    (free) => {
      const r = window.__ride;
      const ok = free ? r?.waiting === true : r?.ready === true;
      if (ok) window.__boot.marks.interactive ??= Math.round(performance.now());
      return ok;
    },
    free,
    { timeout: TIMEOUT, polling: 100 },
  );
  const b = await page.evaluate(() => ({ marks: window.__boot.marks, gaps: window.__boot.gaps, bootLog: window.__ride.bootLog }));
  const g = b.gaps.filter(([t]) => t < b.marks.interactive);
  console.log(`[again] reached after ${((Date.now() - t1) / 1000).toFixed(1)} s: loader moving ${fmt(b.marks.loaderMoving)}, first frame ${fmt(b.marks.firstScreenDraw)}, interactive ${fmt(b.marks.interactive)}; gaps >100 ms ${g.filter((x) => x[1] > 100).length}, longest ${fmt(Math.max(0, ...g.map((x) => x[1])))}`);
}

let play = null;
if (PLAY) {
  const before = { progs: rep.progs.length, variants: rep.variants.length };
  const warns = [];
  page.on("console", (m) => {
    if (/\[shader\]|\[frame\]/.test(m.text())) warns.push(m.text().slice(0, 300));
  });
  const key = async (k, ms = 0) => {
    await page.keyboard.down(k);
    if (ms) await page.waitForTimeout(ms);
    await page.keyboard.up(k);
  };
  const say = async (what) => {
    const s = await page.evaluate(() => ({ mode: window.__ride.footMode, tod: window.__ride.timeOfDay, progs: window.__boot.progs.length, v: window.__boot.variants.length, p: window.__ride.player }));
    console.log(`[play] ${what.padEnd(22)} mode=${s.mode} tod=${s.tod} programs=${s.progs} draw-variants=${s.v} at (${s.p.x.toFixed(1)}, ${s.p.z.toFixed(1)})`);
  };
  if (free) await page.mouse.click(W / 2, H / 2);
  await page.waitForTimeout(1500);
  await say("started");
  await key("KeyW", 2500);
  await say("walked");
  await page.keyboard.down("Shift");
  await key("KeyW", 2000);
  await page.keyboard.up("Shift");
  await say("ran");
  await key("Space", 100);
  await page.waitForTimeout(1200);
  await say("jumped");
  await key("KeyS", 2500);
  await page.waitForTimeout(500);
  await key("KeyF", 100);
  await page.waitForTimeout(4000);
  await say("pressed F (board)");
  await key("KeyW", 3000);
  await page.keyboard.down("Shift");
  await key("KeyW", 3000);
  await page.keyboard.up("Shift");
  await key("KeyA", 1500);
  await key("KeyD", 1500);
  await say("drove, boosted, steered");
  for (let i = 0; i < 6; i++) {
    await key("KeyT", 80);
    await page.waitForTimeout(2500);
    await say(`T x${i + 1}`);
  }
  const after = await collect();
  const late = after.variants.slice(before.variants);
  play = { before, after: { progs: after.progs.length, variants: after.variants.length }, lateProgs: after.progs.slice(before.progs), lateVariants: late, warns };
  console.log(`[play] programs linked after loading: ${after.progs.length - before.progs}; new draw variants: ${late.length}`);
  for (const p of after.progs.slice(before.progs)) console.log(`  late program #${p.id} at ${fmt(p.t)}: ${desc(p)}`);
  for (const v of late.slice(0, 30)) console.log(`  late first draw: program #${v[0]} fbo ${after.fboNames[v[1]] ?? v[1]} buffers ${v[2] || "-"} at ${fmt(v[3])} [${v[5]}] ${desc(after.progs[v[0]] ?? { uses: [], defs: "" })}`);
  for (const w of warns.slice(0, 30)) console.log(`  ${w}`);
  await page.screenshot({ path: path.join(OUT, "play-end.png") });
}

const file = `${OUT}.json`;
await fs.writeFile(file, JSON.stringify({ page: PAGE, serial: SERIAL, ...rep, play, console: consoleLog.slice(0, 200) }, null, 1));
if (DUMP) {
  const dir = `${OUT}-progs`;
  await fs.mkdir(dir, { recursive: true });
  const src = await page.evaluate(() => window.__boot.src);
  for (const [i, [v, f]] of src.entries()) {
    await fs.writeFile(path.join(dir, `${i}.vert`), v);
    await fs.writeFile(path.join(dir, `${i}.frag`), f);
  }
}
console.log(`[out] ${path.relative(ROOT, file)}`);
if (consoleLog.length) console.log(`[console] ${consoleLog.length} warnings/errors, first: ${consoleLog.slice(0, 5).join(" || ")}`);
await bye(0);
