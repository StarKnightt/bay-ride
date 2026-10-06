/**
 * Gentle first-time guidance in the painted style, never persistent: a small controls card that eases
 * in at the lower left after the start click and leaves once she has walked a little, and one-line
 * hints low at the bottom centre the first time each is useful (each at most once per session,
 * gone as soon as it is used). Pure DOM, pointer-events none, fixed position (no layout shift).
 * Never shown under a capture: the caller only constructs it for a real, interactive start.
 */

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
}

export class Hints {
  private card: Note;
  private board: Note;
  private helm: Note;
  private ashore: Note;
  private t = 0;
  private walked = 0;
  private drove = 0;

  constructor() {
    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.append(st);
    this.card = new Note(
      "bh-card",
      `<h3>On foot</h3><div class="cols"><div>` +
        `<div>${k("W")}${k("A")}${k("S")}${k("D")}walk</div><div>${k("Shift")}run</div><div>${k("Space")}jump</div><div>${k("F")}board, by the boat</div>` +
        `</div><div><div>${k("T")}time of day</div><div>${k("M")}music</div><div>${k("H")}help</div></div></div>`,
      14,
    );
    this.board = new Note("bh-hint", `${k("F")} board the boat`, 12);
    this.helm = new Note("bh-hint", `${k("W")}/${k("S")} throttle &middot; ${k("A")}/${k("D")} steer &middot; ${k("Shift")} boost &middot; ${k("F")} step ashore in the shallows`, 8);
    this.ashore = new Note("bh-hint", `${k("F")} step ashore`, 10);
    // The full help card opens in the same corner.
    addEventListener("keydown", (e) => {
      if (e.code === "KeyH" || e.code === "F1") this.card.hide();
    });
  }

  update(dt: number, s: HintState): void {
    this.t += dt;
    if (this.t > 0.8) this.card.show();
    if (s.walking && this.card.shown) this.walked += dt;
    // Walked about 3 s: leave about 1.5 s later (14 s at most).
    if (this.walked > 3) this.card.max = Math.min(this.card.max, this.card.t + 1.5);
    this.card.tick(dt);
    // One hint at a time, so they never stack.
    const busy = () => this.board.shown || this.helm.shown || this.ashore.shown;
    if (s.nearBoat && !busy()) this.board.show();
    if (this.board.shown && (s.aboard || !s.nearBoat)) this.board.hide();
    if (s.aboard && !busy()) this.helm.show();
    if (this.helm.shown) {
      if (s.driving) this.drove += dt;
      if (this.drove > 3 || !s.aboard) this.helm.hide();
    }
    if (s.canAshore && this.helm.done && !busy()) this.ashore.show();
    if (this.ashore.shown && !s.aboard) this.ashore.hide();
    this.board.tick(dt);
    this.helm.tick(dt);
    this.ashore.tick(dt);
  }
}
