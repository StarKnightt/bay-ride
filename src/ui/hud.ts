import { PRESETS, PRESET_LABELS, type Preset, type TimeOfDay } from "../world/timeofday";

/**
 * The only on-screen UI: the time-of-day buttons (top right; T cycles them too) and a small
 * controls hint (bottom left) that fades after a while and returns with H.
 */
export class Hud {
  readonly speed: HTMLElement;
  private bar: HTMLElement;
  private hint: HTMLElement;
  private buttons = new Map<Preset, HTMLButtonElement>();

  constructor(tod: TimeOfDay, visible: boolean) {
    this.speed = document.getElementById("hud")!;
    this.bar = document.createElement("div");
    this.bar.className = "tod";
    for (const p of PRESETS) {
      const b = document.createElement("button");
      b.textContent = PRESET_LABELS[p];
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        tod.set(p);
        b.blur();
      });
      this.bar.appendChild(b);
      this.buttons.set(p, b);
    }
    this.hint = document.createElement("div");
    this.hint.className = "keys";
    this.hint.innerHTML =
      "<b>W A S D</b> ride / walk &nbsp; <b>Shift</b> sprint &nbsp; <b>F</b> get off / on<br>" +
      "<b>V</b> first person &nbsp; <b>C</b> cinematic &nbsp; <b>T</b> time of day &nbsp; <b>B</b> bell &nbsp; <b>M</b> music &nbsp; <b>H</b> hint";
    document.body.append(this.bar, this.hint);
    this.mark(tod.preset);
    tod.onChange((p) => this.mark(p));
    addEventListener("keydown", (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "KeyT") tod.cycle();
      else if (e.code === "KeyH") this.hint.classList.toggle("off");
    });
    setTimeout(() => this.hint.classList.add("off"), 14000);
    if (!visible) this.hide();
  }

  private mark(p: Preset): void {
    for (const [k, b] of this.buttons) b.classList.toggle("on", k === p);
  }

  hide(): void {
    this.speed.style.display = "none";
    this.bar.style.display = "none";
    this.hint.style.display = "none";
  }
}
