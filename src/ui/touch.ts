import type { Input } from "../core/input";
import type { ChaseCam } from "../rider/camera";
import type { Explore } from "../rider/onfoot";
import type { RideAudio } from "../audio";
import type { TimeOfDay } from "../world/timeofday";
import type { HintState } from "./hints";
import { isPortrait } from "../platform";
import { STICK_RIM } from "../core/input";

/**
 * Touch controls, in the painted style of the hint card (cream, soft, translucent):
 * - left of the screen, a floating stick where the thumb lands: walk, pushed to the rim run; in the
 *   boat up and down are the throttle (the rim opens it past full) and left and right steer;
 * - anywhere else, drag to look round (the mouse look's own camera), tap to hop;
 * - small round buttons on the right: board or step ashore (only while F would; mid-height, as the
 *   moored skiff lies low on the right of the opening view), the boat cameras (aboard), time of day
 *   and music.
 * Every touch pointer is caught on the window in the capture phase and kept from the mouse
 * handlers, so the stick, a look drag and the buttons work at once while a mouse still works as
 * before. Idle controls fade back.
 */

/** Stroke icons on a 24-unit grid. */
export const ICON = {
  board: `<path d="M3.5 14.5h17l-2.6 4.2H6.1z"/><path d="M12 14.5V4.2l5.8 7.6H12"/><path d="M12 7.6 8 11.8h4"/>`,
  ashore: `<path d="M7.6 4.6c1.6 0 2.3 1.6 2.1 3.7-.2 2-1 3.4-2.4 3.4s-2-1.5-1.9-3.4c.1-2.1.8-3.7 2.2-3.7z"/><path d="M6.2 13.3h2.6l-.3 2.4c-.1.9-.7 1.4-1.2 1.4s-1.1-.6-1.1-1.5z"/><path d="M16.4 8.6c1.6 0 2.3 1.6 2.1 3.7-.2 2-1 3.4-2.4 3.4s-2-1.5-1.9-3.4c.1-2.1.8-3.7 2.2-3.7z"/><path d="M15 17.3h2.6l-.3 2.4c-.1.9-.7 1.4-1.2 1.4s-1.1-.6-1.1-1.5z"/>`,
  time: `<path d="M3.5 17h17"/><path d="M7 17a5 5 0 0 1 10 0"/><path d="M12 6.2v2.2M5.6 9.2l1.5 1.5M18.4 9.2l-1.5 1.5M3.6 13.6h1.8M18.6 13.6h1.8"/>`,
  camera: `<rect x="3.5" y="7.5" width="17" height="11" rx="2.4"/><circle cx="12" cy="13" r="3.3"/><path d="M8.6 7.5l1.3-2.3h4.2l1.3 2.3"/>`,
  music: `<path d="M9.5 17.2V6.4l9-2v10.4"/><circle cx="7.4" cy="17.2" r="2.1"/><circle cx="16.4" cy="14.8" r="2.1"/>`,
  musicOff: `<path d="M9.5 17.2V6.4l9-2v10.4"/><circle cx="7.4" cy="17.2" r="2.1"/><circle cx="16.4" cy="14.8" r="2.1"/><path d="M4.5 4.5l15 15"/>`,
  stick: `<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="10.4" r="3.4"/>`,
  run: `<circle cx="12" cy="12" r="8.2"/><circle cx="12" cy="4.6" r="3"/><path d="M8.6 11.6h6.8M9.8 14.8h4.4"/>`,
  drag: `<path d="M4.5 12h15M16.5 9l3 3-3 3M7.5 9l-3 3 3 3"/>`,
  tap: `<circle cx="12" cy="12" r="2.6"/><path d="M12 4.6v2M12 17.4v2M4.6 12h2M17.4 12h2"/>`,
};
export const svg = (paths: string, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;

const CSS = `
.tc { position: fixed; inset: 0; z-index: 4; pointer-events: none; -webkit-user-select: none; user-select: none; touch-action: none; }
.tc-btn { position: absolute; display: grid; place-items: center; width: 52px; height: 52px; border-radius: 50%; pointer-events: auto; touch-action: none;
  background: rgba(248, 241, 226, 0.8); box-shadow: 0 6px 20px rgba(40, 28, 18, 0.2), 0 1px 3px rgba(40, 28, 18, 0.14);
  transition: opacity 0.6s ease, transform 0.14s ease, background 0.14s ease; -webkit-tap-highlight-color: transparent; }
.tc-btn svg, .tc-stick svg { width: 25px; height: 25px; fill: none; stroke: #3d342b; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.tc-btn.big { width: 64px; height: 64px; }
.tc-btn.big svg { width: 30px; height: 30px; }
.tc-btn.down { transform: scale(0.9); background: rgba(255, 251, 241, 0.96); }
.tc-btn.gone { opacity: 0; pointer-events: none; transform: scale(0.82); transition: opacity 0.12s ease, transform 0.12s ease; }
.tc-btn.hello { animation: tc-hello 2.4s ease-in-out 2; }
@keyframes tc-hello { 0%, 100% { box-shadow: 0 6px 20px rgba(40, 28, 18, 0.2), 0 0 0 0 rgba(255, 250, 236, 0.0); } 50% { box-shadow: 0 6px 20px rgba(40, 28, 18, 0.2), 0 0 0 9px rgba(255, 250, 236, 0.32); } }
.tc-act { right: calc(env(safe-area-inset-right) + 18px); top: calc(50% - 32px + (env(safe-area-inset-top) - env(safe-area-inset-bottom)) / 2); }
.tc-act.high { top: calc(env(safe-area-inset-top) + 82px); }
.tc-cam { right: calc(env(safe-area-inset-right) + 24px); bottom: calc(env(safe-area-inset-bottom) + 18px); }
.tc-mus { right: calc(env(safe-area-inset-right) + 16px); top: calc(env(safe-area-inset-top) + 14px); }
.tc-tod { right: calc(env(safe-area-inset-right) + 80px); top: calc(env(safe-area-inset-top) + 14px); }
.tc-stick { position: absolute; left: 0; top: 0; width: 116px; height: 116px; margin: -58px 0 0 -58px; border-radius: 50%;
  border: 1.5px solid rgba(255, 252, 244, 0.6); background: radial-gradient(closest-side, rgba(248, 241, 226, 0.22), rgba(248, 241, 226, 0.08));
  box-shadow: 0 4px 22px rgba(40, 28, 18, 0.12); opacity: 0.55; transition: opacity 0.5s ease; }
.tc-stick.held { opacity: 1; transition: opacity 0.12s ease; }
.tc-knob { position: absolute; left: 50%; top: 50%; width: 50px; height: 50px; margin: -25px 0 0 -25px; border-radius: 50%;
  background: rgba(248, 241, 226, 0.86); box-shadow: 0 4px 14px rgba(40, 28, 18, 0.22); display: grid; place-items: center; }
.tc-knob svg { width: 20px; height: 20px; opacity: 0.55; }
.tc-stick.rim .tc-knob { background: rgba(255, 246, 222, 0.96); }
.tc.dim .tc-btn:not(.gone):not(.tc-act) { opacity: 0.55; }
.tc.dim .tc-btn.down { opacity: 1; }
.tc.dim .tc-stick:not(.held) { opacity: 0.38; }
.tc.idle .tc-stick:not(.held) { opacity: 0.28; }
.tc-port { position: fixed; inset: 0; z-index: 9; display: none; place-items: center; background: var(--boot, #efe6d2); touch-action: none; }
.tc-port.on { display: grid; }
.tc-portrait .tc { visibility: hidden; }
.tc-port .card { display: grid; justify-items: center; gap: 10px; padding: 22px 24px 20px; border-radius: 16px; text-align: center; max-width: calc(100vw - 48px);
  background: rgba(248, 241, 226, 0.9); box-shadow: 0 8px 28px rgba(40, 28, 18, 0.22); color: #3d342b;
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif; }
.tc-port .card b { font-weight: 400; font-style: italic; font-size: 19px; letter-spacing: 0.03em; }
.tc-port .card span { font-size: 10.5px; letter-spacing: 0.12em; white-space: nowrap; text-transform: uppercase; color: #6a5a48; }
.tc-port svg { width: 58px; height: 58px; fill: none; stroke: #3d342b; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; animation: tc-turn 2.6s ease-in-out infinite; }
@keyframes tc-turn { 0%, 18% { transform: rotate(0deg); } 52%, 82% { transform: rotate(-90deg); } 100% { transform: rotate(0deg); } }
`;

let cssDone = false;
function addCss(): void {
  if (cssDone) return;
  cssDone = true;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.append(st);
}

/** Stick travel (px from the centre to the rim), dead zone and look speed (a mouse pixel = 1). */
const THROW = 46;
const DEAD = 0.12;
const LOOK_K = 1.25;
/** A touch on the look side shorter and stiller than this is a tap (a hop). */
const TAP_MS = 240;
const TAP_PX = 12;
/** Seconds without a touch before the controls fade back. */
const IDLE_S = 3.5;

export interface TouchDeps {
  input: Input;
  explore: Explore;
  chase: ChaseCam;
  tod: TimeOfDay;
  audio: RideAudio;
}

type Btn = "act" | "cam" | "tod" | "mus";

export class TouchControls {
  readonly root: HTMLElement;
  /** A real look drag has happened (the touch card leaves once she has walked and looked). */
  looked = false;
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;
  private readonly btn: Record<Btn, HTMLElement>;
  private stickId = -1;
  private sx = 0;
  private sy = 0;
  private lookId = -1;
  private lx = 0;
  private ly = 0;
  private lookT = 0;
  private lookMoved = 0;
  private downBtn = new Map<number, Btn>();
  private idle = 0;
  private actKind: "board" | "ashore" | "" = "";
  private musicOn: boolean | null = null;
  private lastTouchEnd = -1e9;
  /** Off until play starts (the loader takes the first tap). */
  enabled = false;

  constructor(private d: TouchDeps) {
    addCss();
    const root = (this.root = document.createElement("div"));
    root.className = "tc";
    root.innerHTML =
      `<div class="tc-stick"><div class="tc-knob">${svg(ICON.stick)}</div></div>` +
      `<div class="tc-btn big tc-act gone" data-b="act"></div>` +
      `<div class="tc-btn tc-cam gone" data-b="cam">${svg(ICON.camera)}</div>` +
      `<div class="tc-btn tc-tod" data-b="tod">${svg(ICON.time)}</div>` +
      `<div class="tc-btn tc-mus" data-b="mus"></div>`;
    document.body.append(root);
    this.stick = root.querySelector(".tc-stick")!;
    this.knob = root.querySelector(".tc-knob")!;
    const q = (b: Btn) => root.querySelector(`[data-b="${b}"]`) as HTMLElement;
    this.btn = { act: q("act"), cam: q("cam"), tod: q("tod"), mus: q("mus") };
    this.restStick();
    const opt = { capture: true, passive: false } as const;
    addEventListener("pointerdown", this.onDown, opt);
    addEventListener("pointermove", this.onMove, opt);
    addEventListener("pointerup", this.onUp, opt);
    addEventListener("pointercancel", this.onUp, opt);
    addEventListener("lostpointercapture", this.onUp, opt);
    // The click a tap synthesises would ask for pointer lock on the canvas.
    addEventListener("click", this.onClick, opt);
    addEventListener("blur", () => this.releaseAll());
    document.addEventListener("visibilitychange", () => document.hidden && this.releaseAll());
    addEventListener("resize", () => this.restStick());
  }

  private isTouch(e: PointerEvent): boolean {
    return e.pointerType === "touch" || e.pointerType === "pen";
  }

  /** Where the stick rests when no thumb holds it: low on the left, inside the safe area. */
  private restStick(): void {
    if (this.stickId >= 0) return;
    const sa = safeAreas();
    this.place(sa.left + 10 + 58, innerHeight - sa.bottom - 6 - 58);
  }

  private place(x: number, y: number): void {
    this.sx = x;
    this.sy = y;
    this.stick.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.isTouch(e) || !this.enabled) return;
    e.stopPropagation();
    this.wake();
    if (isPortrait()) return;
    const b = (e.target as HTMLElement | null)?.closest?.(".tc-btn") as HTMLElement | null;
    if (b && !b.classList.contains("gone")) {
      e.preventDefault();
      const name = b.dataset.b as Btn;
      this.downBtn.set(e.pointerId, name);
      b.classList.add("down");
      this.press(name);
      return;
    }
    const sa = safeAreas();
    if (this.stickId < 0 && e.clientX < sa.left + (innerWidth - sa.left - sa.right) * 0.42) {
      this.stickId = e.pointerId;
      // The stick comes to the thumb, kept whole on the screen.
      const x = Math.min(Math.max(e.clientX, sa.left + 62), innerWidth * 0.5);
      const y = Math.min(Math.max(e.clientY, sa.top + 62), innerHeight - sa.bottom - 62);
      this.place(x, y);
      this.stick.classList.add("held");
      this.moveStick(e.clientX, e.clientY);
    } else if (this.lookId < 0) {
      this.lookId = e.pointerId;
      this.lx = e.clientX;
      this.ly = e.clientY;
      this.lookT = performance.now();
      this.lookMoved = 0;
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.isTouch(e) || !this.enabled) return;
    e.stopPropagation();
    if (e.pointerId === this.stickId) this.moveStick(e.clientX, e.clientY);
    else if (e.pointerId === this.lookId) {
      const dx = e.clientX - this.lx, dy = e.clientY - this.ly;
      this.lx = e.clientX;
      this.ly = e.clientY;
      this.lookMoved += Math.abs(dx) + Math.abs(dy);
      if (this.lookMoved > 24) this.looked = true;
      if (this.enabled && (dx || dy)) this.d.explore.lookBy(dx * LOOK_K, dy * LOOK_K);
    } else return;
    this.wake();
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.isTouch(e) || !this.enabled) return;
    e.stopPropagation();
    this.lastTouchEnd = performance.now();
    if (e.pointerId === this.stickId) this.releaseStick();
    else if (e.pointerId === this.lookId) {
      this.lookId = -1;
      // A quick still tap on the look side is a hop (Space).
      if (e.type === "pointerup" && this.enabled && this.lookMoved < TAP_PX && performance.now() - this.lookT < TAP_MS) this.d.input.jumps++;
    }
    const b = this.downBtn.get(e.pointerId);
    if (b) {
      this.downBtn.delete(e.pointerId);
      this.btn[b].classList.remove("down");
    }
  };

  private onClick = (e: MouseEvent): void => {
    if (!this.enabled) return;
    const pt = (e as PointerEvent).pointerType;
    if (pt === "touch" || pt === "pen" || (pt !== "mouse" && performance.now() - this.lastTouchEnd < 700)) e.stopPropagation();
  };

  private moveStick(x: number, y: number): void {
    let dx = (x - this.sx) / THROW, dy = (y - this.sy) / THROW;
    const m = Math.hypot(dx, dy);
    if (m > 1) {
      dx /= m;
      dy /= m;
    }
    const k = Math.min(1, m);
    this.knob.style.transform = `translate(${(dx * THROW).toFixed(1)}px, ${(dy * THROW).toFixed(1)}px)`;
    // Dead zone in the middle, then the full range out to the rim; screen up is forward.
    const s = this.d.input.stick;
    const out = k > DEAD ? (k - DEAD) / (1 - DEAD) : 0;
    s.x = k > 1e-6 ? (dx / k) * out : 0;
    s.y = k > 1e-6 ? (-dy / k) * out : 0;
    s.on = true;
    this.stick.classList.toggle("rim", out >= STICK_RIM);
  }

  private releaseStick(): void {
    this.stickId = -1;
    const s = this.d.input.stick;
    s.x = s.y = 0;
    s.on = false;
    this.knob.style.transform = "";
    this.stick.classList.remove("held", "rim");
    this.restStick();
  }

  private releaseAll(): void {
    if (this.stickId >= 0) this.releaseStick();
    this.lookId = -1;
    for (const b of this.downBtn.values()) this.btn[b].classList.remove("down");
    this.downBtn.clear();
  }

  private wake(): void {
    this.idle = 0;
    this.root.classList.remove("idle");
  }

  private press(b: Btn): void {
    const { explore, chase, tod, audio } = this.d;
    if (b === "act") {
      if (explore.enabled) explore.pressF();
    } else if (b === "cam") {
      if (explore.mode !== "boat") return;
      // One button for C and V: chase, her eyes, the front shot, the side shot, back to the chase.
      if (chase.mode === "chase" && !chase.cinematic && chase.fpp < 0.5) chase.toggle();
      else chase.cycle();
    } else if (b === "tod") tod.cycle();
    else audio.musicKey(false);
  }

  /** Each frame, with the state the hints read (F's action, aboard). */
  update(dt: number, s: HintState): void {
    this.idle += dt;
    if (this.idle > IDLE_S && this.stickId < 0 && this.lookId < 0) this.root.classList.add("idle");
    // At dusk and night the cream discs would outshine the stars and the lantern.
    this.root.classList.toggle("dim", this.d.tod.preset === "dusk" || this.d.tod.preset === "night");
    const kind = s.nearBoat && !s.aboard ? "board" : s.aboard && s.canAshore ? "ashore" : "";
    if (kind !== this.actKind) {
      const a = this.btn.act;
      if (kind) {
        a.innerHTML = svg(kind === "board" ? ICON.board : ICON.ashore);
        a.setAttribute("aria-label", kind === "board" ? "board the boat" : "step ashore");
        a.classList.remove("hello");
        void a.offsetWidth;
        a.classList.add("hello");
      }
      a.classList.toggle("gone", !kind);
      this.actKind = kind;
    }
    // Beside the boat (just ashore on a beach) its hull can fill the button's slot: the button goes up, under T and M.
    const b = s.boatBox, sa = safeAreas();
    const ax = innerWidth - sa.right - 18 - 64, ay = innerHeight / 2 - 32 + (sa.top - sa.bottom) / 2;
    this.btn.act.classList.toggle("high", !!b && b.x < ax + 68 && ax - 4 < b.x + b.w && b.y < ay + 68 && ay - 4 < b.y + b.h);
    this.btn.cam.classList.toggle("gone", !s.aboard);
    const on = this.d.audio.music && !this.d.audio.muted;
    if (on !== this.musicOn) {
      this.musicOn = on;
      this.btn.mus.innerHTML = svg(on ? ICON.music : ICON.musicOff);
    }
  }

  /** Bounding boxes of the controls (capture tooling). */
  layout(): Record<string, { x: number; y: number; w: number; h: number; shown: boolean }> {
    const out: Record<string, { x: number; y: number; w: number; h: number; shown: boolean }> = {};
    const box = (k: string, el: HTMLElement, shown: boolean) => {
      const r = el.getBoundingClientRect();
      out[k] = { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), shown };
    };
    const port = isPortrait();
    box("stick", this.stick, !port);
    for (const [k, el] of Object.entries(this.btn)) box(k, el, !el.classList.contains("gone") && !port);
    return out;
  }
}

/** The safe-area insets in CSS px (env() read through a probe element). */
let probe: HTMLElement | null = null;
export function safeAreas(): { top: number; right: number; bottom: number; left: number } {
  if (!probe) {
    probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.append(probe);
  }
  const cs = getComputedStyle(probe);
  return { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
}

/** The landscape prompt: a soft veil in the sky's colours with a turning phone, shown while held upright. */
export class PortraitPrompt {
  readonly el: HTMLElement;
  constructor() {
    addCss();
    this.el = document.createElement("div");
    this.el.className = "tc-port";
    this.el.innerHTML =
      `<div class="card"><svg viewBox="0 0 64 64" aria-hidden="true"><rect x="22" y="8" width="20" height="48" rx="4.5"/><path d="M29 13h6"/><circle cx="32" cy="50.5" r="1.6"/></svg>` +
      `<b>turn your phone sideways</b><span>the bay plays in landscape</span></div>`;
    document.body.append(this.el);
    const check = () => {
      const on = isPortrait();
      this.el.classList.toggle("on", on);
      document.documentElement.classList.toggle("tc-portrait", on);
    };
    check();
    addEventListener("resize", check);
    addEventListener("orientationchange", () => setTimeout(check, 60));
    visualViewport?.addEventListener("resize", check);
  }
  get shown(): boolean {
    return this.el.classList.contains("on");
  }
}
