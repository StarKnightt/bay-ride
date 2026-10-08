/**
 * Gentle first-time guidance in the painted style, never persistent: a small controls card that eases
 * in at the lower left after the start click and leaves once she has walked a little; one line low at
 * the bottom centre: "press F" to board or step ashore whenever she is in range (every time), and the
 * helm keys once, the first time she is under way. Pure DOM, pointer-events none, fixed position (no layout shift).
 * Never shown under a capture: the caller only constructs it for a real, interactive start.
 */

import { ICON, svg } from "./touch";

const CSS = `
.bh-card, .bh-hint { position: fixed; z-index: 4; pointer-events: none; user-select: none;
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif; color: #3d342b;
  background: rgba(248, 241, 226, 0.88); box-shadow: 0 6px 24px rgba(40, 28, 18, 0.18), 0 1px 3px rgba(40, 28, 18, 0.12);
  opacity: 0; transition: opacity 1.1s ease, transform 1.1s ease; }
.bh-card { left: max(22px, 2.2vw); bottom: max(22px, 3vh); padding: 14px 20px 13px; border-radius: 12px;
  font-size: clamp(12px, 0.8vw, 15px); line-height: 1.7; transform: translateY(8px); }
.bh-card h3 { margin: 0 0 4px; font-weight: 400; font-style: italic; font-size: 1.08em; letter-spacing: 0.05em; color: #6a5a48; }
.bh-card .cols { display: grid; grid-template-columns: auto auto; gap: 0 26px; }
.bh-card div div { white-space: nowrap; }
.bh-card kbd, .bh-hint kbd { display: inline-block; min-width: 13px; margin-right: 6px; padding: 0 5px; border: 1px solid rgba(61, 52, 43, 0.55);
  border-radius: 4px; font: 400 0.84em/1.45 Georgia, serif; text-align: center; color: #3d342b; background: rgba(255, 252, 244, 0.7); }
.bh-hint { left: 50%; bottom: max(26px, 6vh); padding: 7px 16px 6px; border-radius: 999px; white-space: nowrap;
  font-size: clamp(12px, 0.82vw, 15px); font-style: italic; letter-spacing: 0.03em; transform: translate(-50%, 6px); }
.bh-card.on { opacity: 1; transform: none; }
.bh-hint.on { opacity: 1; transform: translate(-50%, 0); }
`;

const k = (s: string) => `<kbd>${s}</kbd>`;

/**
 * Touch: the card top left, clear of the stick; the F and helm lines top centre, over the sky, never
 * over the moored boat beside the pier end (low right in the opening view).
 */
const TOUCH_CSS = `
.bh-touch.bh-card { left: 50%; top: auto; bottom: calc(env(safe-area-inset-bottom) + 12px); padding: 6px 15px 5px; border-radius: 14px; box-sizing: border-box;
  max-width: calc(100vw - 2 * (env(safe-area-inset-left) + 128px)); font-size: 11.5px; line-height: 1.55; transform: translate(-50%, 8px); }
.bh-touch.bh-card.on { transform: translate(-50%, 0); }
.bh-touch.bh-card .row { display: flex; flex-wrap: wrap; justify-content: center; align-items: center; gap: 2px 13px; }
.bh-touch.bh-card .row > * { white-space: nowrap; }
.bh-touch.bh-card h3 { margin: 0; font-size: 1.04em; }
.bh-touch.bh-hint { font-size: 11.5px; max-width: calc(100vw - 2 * (env(safe-area-inset-right) + 136px)); white-space: normal; text-align: center; }
.bh-touch.bh-act, .bh-touch.bh-helm { top: calc(env(safe-area-inset-top) + 14px); bottom: auto; transform: translate(-50%, -6px); }
.bh-touch.bh-act.on, .bh-touch.bh-helm.on { transform: translate(-50%, 0); }
.bh-ico { display: inline-grid; place-items: center; width: 19px; height: 19px; margin-right: 7px; border-radius: 50%; vertical-align: -5px;
  border: 1px solid rgba(61, 52, 43, 0.4); background: rgba(255, 252, 244, 0.7); }
.bh-hint .bh-ico { margin: 0 3px; }
.bh-ico svg { width: 13px; height: 13px; fill: none; stroke: #3d342b; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
`;
const ic = (paths: string) => `<span class="bh-ico">${svg(paths)}</span>`;

class Note {
  readonly el: HTMLElement;
  t = 0;
  private live = false;
  done = false;
  constructor(cls: string, html: string, public max: number) {
    this.el = document.createElement("div");
    this.el.className = cls;
    this.el.innerHTML = html;
    document.body.append(this.el);
  }
  show(): void {
    if (this.done || this.live) return;
    this.live = true;
    requestAnimationFrame(() => this.el.classList.add("on"));
  }
  hide(): void {
    if (this.done) return;
    this.done = true;
    this.el.classList.remove("on");
    setTimeout(() => this.el.remove(), 1300);
  }
  get shown(): boolean {
    return this.live && !this.done;
  }
  tick(dt: number): void {
    if (!this.shown) return;
    this.t += dt;
    if (this.t > this.max) this.hide();
  }
}

/** A one-line prompt that fades in whenever its action is available and out when it isn't, every time. */
class Prompt {
  readonly el: HTMLElement;
  private on = false;
  constructor(html: string, cls = "bh-hint") {
    this.el = document.createElement("div");
    this.el.className = cls;
    this.el.innerHTML = html;
    document.body.append(this.el);
  }
  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.el.classList.toggle("on", on);
  }
  get shown(): boolean {
    return this.on;
  }
}

/** What the game reports each frame. */
export interface HintState {
  /** On her feet and moving (s of this frame count toward "has walked"). */
  walking: boolean;
  /** Within boarding range of the moored skiff. */
  nearBoat: boolean;
  aboard: boolean;
  /** Aboard and under way. */
  driving: boolean;
  /** Aboard, away from the berth, F would step ashore. */
  canAshore: boolean;
  /** Touch: a look drag has happened. */
  looked?: boolean;
  /** Touch: the boat's box on screen (CSS px), so a button can step out of its way. */
  boatBox?: { x: number; y: number; w: number; h: number } | null;
}

export class Hints {
  private card: Note;
  private board: Prompt;
  private helm: Note;
  private ashore: Prompt;
  private t = 0;
  private walked = 0;
  private drove = 0;

  /** `touch`: the touch words (ui/touch.ts), placed beside the controls instead of at the bottom. */
  constructor(private readonly touch = false) {
    const st = document.createElement("style");
    st.textContent = touch ? CSS + TOUCH_CSS : CSS;
    document.head.append(st);
    if (touch) {
      this.card = new Note(
        "bh-card bh-touch",
        `<div class="row"><h3>On foot</h3><span>${ic(ICON.stick)}walk</span><span>${ic(ICON.run)}run</span>` +
          `<span>${ic(ICON.drag)}look</span><span>${ic(ICON.tap)}hop</span></div>`,
        8,
      );
      this.board = new Prompt(`tap ${ic(ICON.board)} to board the boat`, "bh-hint bh-touch bh-act");
      this.helm = new Note("bh-hint bh-touch bh-helm", `In the boat &middot; ${ic(ICON.stick)}drive &middot; ${ic(ICON.run)}full speed &middot; ${ic(ICON.camera)}views`, 9);
      this.ashore = new Prompt(`tap ${ic(ICON.ashore)} to step ashore`, "bh-hint bh-touch bh-act");
      return;
    }
    this.card = new Note(
      "bh-card",
      `<h3>On foot</h3><div class="cols"><div>` +
        `<div>${k("W")}${k("A")}${k("S")}${k("D")}walk</div><div>${k("Shift")}run</div><div>${k("Space")}jump</div><div>${k("F")}board, by the boat</div>` +
        `</div><div><div>${k("T")}time of day</div><div>${k("M")}music</div><div>${k("H")}help</div></div></div>`,
      14,
    );
    this.board = new Prompt(`press ${k("F")} to board the boat`);
    this.helm = new Note("bh-hint", `${k("W")}/${k("S")} throttle &middot; ${k("A")}/${k("D")} steer &middot; ${k("Shift")} boost`, 8);
    this.ashore = new Prompt(`press ${k("F")} to step ashore`);
    // The full help card opens in the same corner.
    addEventListener("keydown", (e) => {
      if (e.code === "KeyH" || e.code === "F1") this.card.hide();
    });
  }

  /** Fade everything out for good (a touchscreen laptop switching to the touch words). */
  dispose(): void {
    this.card.hide();
    this.helm.hide();
    this.board.set(false);
    this.ashore.set(false);
    for (const p of [this.board, this.ashore]) setTimeout(() => p.el.remove(), 1300);
    this.update = () => {};
  }

  /** Bounding boxes of what is showing (capture tooling). */
  layout(): Record<string, { x: number; y: number; w: number; h: number; shown: boolean }> {
    const out: Record<string, { x: number; y: number; w: number; h: number; shown: boolean }> = {};
    const box = (key: string, el: HTMLElement, shown: boolean) => {
      const r = el.getBoundingClientRect();
      out[key] = { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1), shown };
    };
    box("card", this.card.el, this.card.shown);
    box("boardHint", this.board.el, this.board.shown);
    box("ashoreHint", this.ashore.el, this.ashore.shown);
    box("helmHint", this.helm.el, this.helm.shown);
    return out;
  }

  update(dt: number, s: HintState): void {
    if (this.touch) return this.updateTouch(dt, s);
    this.t += dt;
    if (this.t > 0.8) this.card.show();
    if (s.walking && this.card.shown) this.walked += dt;
    // Walked about 3 s: leave about 1.5 s later (14 s at most).
    if (this.walked > 3) this.card.max = Math.min(this.card.max, this.card.t + 1.5);
    this.card.tick(dt);
    // One line at a time, so they never stack: the F prompts (every time she is in range) over the
    // first-time helm hint, which only shows once she is under way from the berth.
    // On touch the card shares the top with the F line: the card already shows F's icon, and the button pulses.
    this.board.set(s.nearBoat && !s.aboard && !(this.touch && this.card.shown));
    this.ashore.set(s.aboard && s.canAshore);
    if (s.aboard && s.driving && !this.ashore.shown) this.helm.show();
    if (this.helm.shown) {
      this.drove += dt;
      if (this.drove > 5 || !s.aboard || this.ashore.shown) this.helm.hide();
    }
    this.helm.tick(dt);
  }

  /**
   * Touch: the card at the bottom leaves once she has walked and looked round (or after 12 s), and as
   * she boards. Aboard, the boat line shows once; the step-ashore line waits until it has gone (the
   * button itself shows whenever stepping ashore works).
   */
  private updateTouch(dt: number, s: HintState): void {
    this.t += dt;
    if (this.t > 0.8 && !s.aboard) this.card.show();
    if (s.walking && this.card.shown) this.walked += dt;
    if (this.walked > 1.5 && s.looked) this.card.max = Math.min(this.card.max, this.card.t + 1);
    if (s.aboard && this.card.shown) this.card.hide();
    this.card.tick(dt);
    this.board.set(s.nearBoat && !s.aboard && !this.card.shown);
    if (s.aboard) this.helm.show();
    if (this.helm.shown) {
      if (s.driving) this.drove += dt;
      if (this.drove > 6 || !s.aboard) this.helm.hide();
    }
    this.helm.tick(dt);
    this.ashore.set(s.aboard && s.canAshore && !this.helm.shown);
  }
}
