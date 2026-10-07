/** Past this share of its throw the touch stick runs (on foot) or opens the throttle past full (in the boat). */
export const STICK_RIM = 0.88;

export class Input {
  up = false;
  down = false;
  left = false;
  right = false;
  /** Shift held: jog on foot, open the throttle past full in the boat. */
  shift = false;
  /** Presses of Space so far (on foot: jump). Readers keep their own count of what they handled. */
  jumps = 0;
  /** The touch stick (ui/touch.ts): deflection -1…1 (x to the right, y forward), while a thumb holds it. */
  readonly stick = { x: 0, y: 0, on: false };

  /** Forward (+) or back (-), -1…1: the keys, or the touch stick while it is held. */
  get fwd(): number {
    return this.stick.on ? this.stick.y : (this.up ? 1 : 0) - (this.down ? 1 : 0);
  }

  /** Right (+) or left (-), -1…1: the keys, or the touch stick while it is held. */
  get str(): number {
    return this.stick.on ? this.stick.x : (this.right ? 1 : 0) - (this.left ? 1 : 0);
  }

  /** Shift, or the touch stick pushed to its rim. */
  get run(): boolean {
    return this.shift || (this.stick.on && Math.hypot(this.stick.x, this.stick.y) >= STICK_RIM);
  }

  constructor(onFirst: () => void, onToggleView: () => void = () => {}) {
    const set = (code: string, v: boolean) => {
      switch (code) {
        case "KeyW":
        case "ArrowUp":
          this.up = v;
          return true;
        case "KeyS":
        case "ArrowDown":
          this.down = v;
          return true;
        case "KeyA":
        case "ArrowLeft":
          this.left = v;
          return true;
        case "KeyD":
        case "ArrowRight":
          this.right = v;
          return true;
        case "ShiftLeft":
        case "ShiftRight":
          this.shift = v;
          return false;
      }
      return false;
    };
    addEventListener("keydown", (e) => {
      onFirst();
      if (e.code === "KeyV" && !e.repeat) onToggleView();
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) this.jumps++;
      }
      if (set(e.code, true)) e.preventDefault();
    });
    addEventListener("keyup", (e) => {
      set(e.code, false);
    });
    addEventListener("pointerdown", onFirst);
    addEventListener("blur", () => {
      this.up = this.down = this.left = this.right = this.shift = false;
      this.stick.x = this.stick.y = 0;
      this.stick.on = false;
    });
  }
}
