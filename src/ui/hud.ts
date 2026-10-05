import type { TimeOfDay } from "../world/timeofday";

/**
 * No on-screen UI while playing. T steps through the times of day; H (or F1) shows a small card with
 * the keys, hidden again by the same key.
 */
export class Hud {
  private help: HTMLElement;

  constructor(tod: TimeOfDay, enabled: boolean) {
    this.help = document.createElement("div");
    this.help.className = "help";
    const rows: [string, string][] = [
      ["W A S D", "walk"],
      ["Shift", "run · in the boat, full speed"],
      ["Space", "jump"],
      ["mouse", "look around"],
      ["F", "into the boat / back onto the pier"],
      ["W S · A D", "throttle · tiller"],
      ["V / C", "boat cameras"],
      ["T", "time of day"],
      ["M · Shift M", "music · mute"],
      ["H", "this card"],
    ];
    for (const [k, v] of rows) {
      const r = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = k;
      r.append(b, document.createTextNode(v));
      this.help.appendChild(r);
    }
    document.body.append(this.help);
    if (!enabled) return;
    addEventListener("keydown", (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === "KeyT") tod.cycle();
      else if (e.code === "KeyH" || e.code === "F1") {
        e.preventDefault();
        this.help.classList.toggle("on");
      }
    });
  }
}
