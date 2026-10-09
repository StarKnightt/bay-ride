/**
 * Everything that differs on phones and tablets is decided here, so the desktop game runs exactly
 * as it always has:
 * - `touch`: the touch controls and the touch versions of the hints (ui/touch.ts). On from the start
 *   where the primary pointer is coarse (phones, tablets); on a touchscreen laptop only after its
 *   first real touch.
 * - `phone`: the phone quality tier (TIER below) and the phone basics: no page scroll, zoom or text
 *   selection, the landscape prompt, the viewport watcher, audio unlocked on the first tap and, on
 *   Android, fullscreen. Fixed at boot (render targets and programs depend on it).
 * `?mobile=1` forces both on a desktop, `?mobile=0` forces the desktop game.
 */

// Node tools (the CPU sims) import modules that read the tier: there it is the desktop's.
const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const forceQ = params.get("mobile");
const FORCED: boolean | null = forceQ === "1" ? true : forceQ === "0" ? false : null;
const mm = (q: string) => typeof matchMedia === "function" && matchMedia(q).matches;
const ua = navigator.userAgent;
const IOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const ANDROID = /Android/.test(ua);
/** A phone or tablet: a mobile OS, or a touch-first device (coarse primary pointer and no hover). */
const HANDHELD = IOS || ANDROID || /Mobile|Silk|Kindle/.test(ua) || (mm("(pointer: coarse)") && mm("(hover: none)"));

export const PLATFORM = {
  /** ?mobile=1 / ?mobile=0, or null. */
  forced: FORCED,
  phone: FORCED ?? HANDHELD,
  touch: FORCED ?? mm("(pointer: coarse)"),
  ios: IOS,
  android: ANDROID,
};

/**
 * Render quality. The desktop values are the game's own, unchanged; the phone values were tuned
 * on the RTX 4060 at the emulated phone viewports in the order the phone pass prescribes (pixel
 * ratio and resolution, then shadows, then post, then the water), stopping once the 30 fps proxy
 * held (DECISIONS.md, "Mobile").
 */
export interface Tier {
  /** Pixel ratio cap. */
  dpr: number;
  /** Adaptive scene resolution: starting scale, lowest and highest. */
  res: [start: number, floor: number, ceil: number];
  /** Frame budgets for the adaptive resolution (ms): GPU timer high/low marks, frame interval high/low marks. */
  budget: [hi: number, lo: number, hiFrame: number, loFrame: number];
  /** Scene pass in one two-target draw (no normal-pass twins: the split only helps ANGLE on D3D11). */
  singlePass: boolean;
  msaa: number;
  /** Sun and character shadow map sizes. */
  shadow: number;
  charShadow: number;
  /** Paint filter strength (0 = off), bloom resolution as a share of the output. */
  paint: number;
  bloom: number;
  /** Water mirror: resolution as a share of the output, refresh every n frames, MSAA. */
  refl: [scale: number, every: number, msaa: number];
  /** Grass and flower density and reach (flora/index.ts TIERS). */
  flora: "xlow" | "low" | "med" | "high";
  /** Sea mesh spacing factor (1 = the desktop's; at a phone's resolution its vertex shader costs more than its pixels). */
  seaMesh: number;
  /** Sun shadow map refreshed every n frames. */
  shadowEvery: number;
  /** Leaf cards per tree crown (drawn larger to cover the same crown), and the dune grass kept. */
  treeCards: number;
  dune: number;
  /** Icosphere detail of each leaf clump's solid mass: 1 is 80 triangles, 0 is 20 (most of a tree's triangles). */
  treeMass: number;
  /** Ink width and the paint filter's radius follow the frame height all the way down (a phone's small frame keeps desktop's thin lines, faded below half a pixel) instead of holding their 1080p size. */
  fineLines: boolean;
  /** The wake's lace with softer edges and less far-off fill (a phone's coarse pixels otherwise turn it into flat, hard-edged scraps). */
  softWake: boolean;
  /** A lighter sea: two glitter cell sizes of three, one ripple-dab size of two, three mirror taps of five, no thin far break lines, and lace detail computed only where it shows. */
  seaLite: boolean;
  /** Without MSAA, alpha-cut cards (grass blades, leaf cards) cut cleanly at half coverage: the 4x4 ordered dither that stands in for MSAA stipples every blade edge into beads at a phone's pixel size. */
  alphaCut: boolean;
  /** Frames narrower than this aspect keep its horizontal view (the field of view widens upward), so an X player card's square keeps her, the island and the boat in shot; 0 = off. */
  horAspect: number;
  /** Sun shadow filter taps this many texels apart: the phone's half-size map needs a wider penumbra to hide its steps (1 = desktop). */
  shadowSpread: number;
  /** Dune grass may draw or induce ink. Under MSAA the faint outline the sand draws round each blade stays hair-thin; at a phone's pixel size it broke into chains of rings, so phones keep the blades out of the ink like the meadow grass. */
  inkFoliage: boolean;
  /** Trees drawn in the water mirror: 1 every wood but the hill's (desktop), 0 only the island's (its reflection leads the opening view; the town and headland trees are a few pixels in a phone's small mirror). */
  reflTrees: number;
}

export const DESKTOP: Tier = {
  dpr: 1.5,
  res: [1, 0.75, 1],
  budget: [14.5, 12, 18, 13],
  singlePass: false,
  msaa: 4,
  shadow: 2048,
  charShadow: 1024,
  paint: 0.85,
  bloom: 0.5,
  refl: [0.5, 2, 4],
  flora: "high",
  seaMesh: 1,
  shadowEvery: 1,
  treeCards: 1,
  dune: 1,
  treeMass: 1,
  fineLines: false,
  softWake: false,
  seaLite: false,
  alphaCut: false,
  horAspect: 0,
  shadowSpread: 1,
  inkFoliage: true,
  reflTrees: 1,
};

export const PHONE: Tier = {
  dpr: 1,
  res: [0.9, 0.8, 1],
  budget: [26, 18, 38, 22],
  singlePass: true,
  msaa: 0,
  shadow: 1024,
  charShadow: 512,
  paint: 0.85,
  bloom: 0.25,
  refl: [0.35, 2, 0],
  flora: "xlow",
  seaMesh: 2,
  shadowEvery: 4,
  treeCards: 0.35,
  dune: 0.5,
  treeMass: 0,
  fineLines: true,
  softWake: true,
  seaLite: true,
  alphaCut: true,
  horAspect: 1.6,
  shadowSpread: 1.75,
  inkFoliage: false,
  reflTrees: 0,
};

/** `?tier=key:value,...` overrides single settings (tuning runs), e.g. `?tier=msaa:0,shadow:512,res:0.7/0.6/1`. */
function overrides(t: Tier): Tier {
  const s = params.get("tier");
  if (!s) return t;
  const o: Record<string, unknown> = { ...t };
  for (const kv of s.split(",")) {
    const [k, v] = kv.split(":");
    if (!(k in o) || v === undefined) continue;
    const cur = o[k];
    if (Array.isArray(cur)) o[k] = v.split("/").map(Number);
    else if (typeof cur === "number") o[k] = Number(v);
    else if (typeof cur === "boolean") o[k] = v === "1" || v === "true";
    else o[k] = v;
  }
  return o as unknown as Tier;
}

export const TIER: Tier = overrides(PLATFORM.phone ? PHONE : DESKTOP);

/** What the GPU can render to: half-float colour targets, and how many MSAA samples each format takes. */
export interface GpuCaps {
  halfFloat: boolean;
  samplesHalf: number;
  samples8: number;
  maxTexture: number;
}

/**
 * Probe once on the game's own context. Half-float colour targets need EXT_color_buffer_float (or
 * _half_float); without them every float target falls back to 8 bits (no HDR above 1, a little
 * banding at night) instead of an incomplete framebuffer and a black screen. `?nofloat=1` forces
 * the fallback for testing.
 */
export function probeGpu(gl: WebGL2RenderingContext): GpuCaps {
  const ext = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
  let halfFloat = false;
  if (ext && params.get("nofloat") !== "1") {
    const tex = gl.createTexture(), fb = gl.createFramebuffer();
    const prevFb = gl.getParameter(gl.FRAMEBUFFER_BINDING), prevTex = gl.getParameter(gl.TEXTURE_BINDING_2D);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 4, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    halfFloat = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFb);
    gl.bindTexture(gl.TEXTURE_2D, prevTex);
    gl.deleteFramebuffer(fb);
    gl.deleteTexture(tex);
  }
  const most = (fmt: number) => {
    try {
      const s = gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES) as Int32Array | null;
      return s && s.length ? Math.max(...s) : 0;
    } catch {
      return 0;
    }
  };
  return {
    halfFloat,
    samplesHalf: halfFloat ? most(gl.RGBA16F) : 0,
    samples8: most(gl.RGBA8),
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
  };
}

// ---------------------------------------------------------------------------- touch switching

const touchListeners: (() => void)[] = [];

/** Run `fn` once the touch controls are on: now on a touch-first device, or at a laptop's first touch. */
export function onTouch(fn: () => void): void {
  if (PLATFORM.touch) fn();
  else touchListeners.push(fn);
}

if (PLATFORM.touch) document.documentElement.classList.add("touch");
else if (FORCED === null && (navigator.maxTouchPoints > 0 || "ontouchstart" in window)) {
  const first = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    removeEventListener("pointerdown", first, true);
    PLATFORM.touch = true;
    document.documentElement.classList.add("touch");
    for (const f of touchListeners.splice(0)) f();
  };
  addEventListener("pointerdown", first, true);
}

// ---------------------------------------------------------------------------- phone basics

const PHONE_CSS = `
html.phone, html.phone body { position: fixed; inset: 0; width: 100%; height: 100%; overflow: hidden;
  overscroll-behavior: none; touch-action: none; -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; -webkit-text-size-adjust: 100%; }
html.phone canvas { touch-action: none; }
html.phone #loader .bar { margin-bottom: calc(9dvh + env(safe-area-inset-bottom)); }
html.phone #loader .start, html.phone #loader .note { bottom: calc(9dvh + 12px + env(safe-area-inset-bottom)); }
html.phone #loader .title { top: 14dvh; }
html.phone #loader .title h1 { font-size: clamp(40px, 8.4vw, 118px); }
html.phone #loader .title p { font-size: clamp(10px, 1.6vw, 17px); }
html.phone #loader .note { font-size: clamp(10px, 1.5vw, 15px); padding: 0 calc(16px + env(safe-area-inset-left)) 0 calc(16px + env(safe-area-inset-right)); }
`;

if (PLATFORM.phone) {
  document.documentElement.classList.add("phone");
  const st = document.createElement("style");
  st.textContent = PHONE_CSS;
  document.head.append(st);
  // No page zoom, pull-to-refresh, long-press menus or selection while playing. iOS Safari ignores
  // user-scalable=no and pinches through touch-action: its own gesture events stop it.
  const stop = (e: Event) => e.preventDefault();
  for (const g of ["gesturestart", "gesturechange", "gestureend"]) document.addEventListener(g, stop, { passive: false });
  document.addEventListener("touchmove", stop, { passive: false });
  document.addEventListener("dblclick", stop, { passive: false });
  document.addEventListener("contextmenu", stop);
  document.addEventListener("selectstart", stop);
}

/** The loader's start line in touch words. */
export function touchLoaderText(): void {
  const s = document.querySelector<HTMLElement>("#loader .start");
  if (s) {
    s.textContent = "tap to start";
    // Thin italic over the pale deck: a soft dark shadow keeps it legible.
    s.style.textShadow = "0 1px 3px rgba(40, 26, 18, 0.6), 0 0 14px rgba(40, 26, 18, 0.5)";
  }
  // In a landscape phone frame the pier lamp stands mid-screen with the lighthouse to its left: the
  // title goes in the open sky right of the lamp, a little smaller.
  const t = document.querySelector<HTMLElement>("#loader .title");
  if (t) {
    t.style.top = "3vh";
    t.style.left = "60%";
    t.style.right = "env(safe-area-inset-right)";
    const h = t.querySelector<HTMLElement>("h1");
    if (h) h.style.fontSize = "clamp(36px, 7vw, 96px)";
  }
}

/**
 * Run `fn` inside the first tap's user activation (touchend: a touch pointerdown doesn't count for
 * audio or fullscreen). Called again for later taps until `fn` returns true.
 */
export function onFirstTap(fn: () => boolean): void {
  const h = (e: Event) => {
    if ((e as PointerEvent).pointerType === "mouse") return;
    if (fn()) {
      removeEventListener("touchend", h, true);
      removeEventListener("pointerup", h, true);
    }
  };
  addEventListener("touchend", h, { capture: true, passive: true });
  addEventListener("pointerup", h, { capture: true, passive: true });
}

/** Android: fullscreen with the navigation bar hidden, then hold landscape. Elsewhere nothing. */
export function goFullscreen(): void {
  if (!PLATFORM.android || PLATFORM.forced !== null || EMBEDDED) return;
  const el = document.documentElement;
  if (!el.requestFullscreen || document.fullscreenElement) return;
  el.requestFullscreen({ navigationUI: "hide" })
    .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape"))
    .catch(() => {});
}

/**
 * Viewport changes on a phone: rotation, the URL bar sliding, the keyboard, fullscreen. Every
 * source (`resize`, `orientationchange`, `visualViewport`) is collected into one call of
 * `apply(w, h)` once the size has stopped moving (iOS reports the old size for a moment after a
 * rotation), so the renderer, post chain and camera always change together and only once.
 */
export function watchViewport(apply: (w: number, h: number) => void): void {
  let w = innerWidth, h = innerHeight, timer = 0, checks = 0;
  const settle = () => {
    clearTimeout(timer);
    checks = 0;
    const tick = () => {
      const nw = innerWidth, nh = innerHeight;
      if (nw !== w || nh !== h) {
        w = nw;
        h = nh;
        apply(w, h);
      }
      // Look again a few times: the size can settle in steps after a rotation.
      if (++checks < 4) timer = window.setTimeout(tick, checks === 1 ? 120 : 250);
    };
    timer = window.setTimeout(tick, 60);
  };
  addEventListener("resize", settle);
  addEventListener("orientationchange", settle);
  visualViewport?.addEventListener("resize", settle);
  document.addEventListener("fullscreenchange", settle);
}

/** Inside another page's frame (an X player card is a fixed 480x480 or 640x360 iframe, even on an upright phone). */
export const EMBEDDED = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

/**
 * Held in portrait (on a phone): the landscape prompt shows and play waits. Measured on the page's
 * own size: in a frame only a clearly upright one asks, never a square or wide card.
 */
export function isPortrait(): boolean {
  return PLATFORM.phone && innerHeight > innerWidth * (EMBEDDED ? 1.2 : 1.05);
}
