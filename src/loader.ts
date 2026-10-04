/**
 * Start veil: a calm paper-coloured screen with the title and a thin progress line while the bay
 * builds and the shaders compile; then "click to start" (the gesture that unlocks audio).
 */
export class Loader {
  private el: HTMLElement;
  private bar: HTMLElement;
  private line: HTMLElement;
  progress = 0;

  constructor(private skip: boolean) {
    this.el = document.getElementById("loader")!;
    this.bar = this.el.querySelector(".bar i") as HTMLElement;
    this.line = this.el.querySelector(".line") as HTMLElement;
    if (skip) this.el.classList.add("quiet");
  }

  advance(w: number, label?: string): void {
    this.progress = Math.min(1, this.progress + w);
    this.bar.style.transform = `scaleX(${this.progress.toFixed(3)})`;
    if (label) this.line.textContent = label;
  }

  /** Built: wait for a click / key, then call `go` (true when it was a pointer gesture). */
  ready(go: (viaPointer: boolean) => void): void {
    this.progress = 1;
    this.bar.style.transform = "scaleX(1)";
    this.line.textContent = "click to start";
    this.el.classList.add("ready");
    const done = (viaPointer: boolean) => {
      removeEventListener("pointerdown", onPtr);
      removeEventListener("keydown", onKey);
      go(viaPointer);
    };
    const onPtr = () => done(true);
    const onKey = (e: KeyboardEvent) => {
      if (!e.repeat) done(false);
    };
    addEventListener("pointerdown", onPtr);
    addEventListener("keydown", onKey);
  }

  dissolve(): void {
    this.el.classList.add("gone");
    setTimeout(() => this.remove(), 900);
  }

  remove(): void {
    this.el.remove();
  }
}

/** Replace everything with a short, friendly message (no WebGL 2, lost context). */
export function fatal(title: string, body: string): void {
  document.body.innerHTML = "";
  const d = document.createElement("div");
  d.className = "fatal";
  const h = document.createElement("h2");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = body;
  const b = document.createElement("button");
  b.textContent = "Reload";
  b.onclick = () => location.reload();
  d.append(h, p, b);
  document.body.appendChild(d);
}
