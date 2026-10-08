import type { Explore } from "./onfoot";
import type { Preset, TimeOfDay } from "../world/timeofday";
import { PALETTES } from "../ui/intro";
import { SPAWN } from "../boat/berth";
import { ISLAND } from "../world/bay/terrain";

type Orbit = [number, number, number];

/** Where she stands (world x, z) facing `yaw`, and the orbit camera: bearing from behind her, pitch, distance. */
interface Place {
  x: number;
  z: number;
  yaw: number;
  orbit: Orbit;
  /** The skiff goes back to its berth as well. */
  home?: boolean;
}

/** Standing at (x, z) facing the world point (tx, tz). */
const facing = (x: number, z: number, tx: number, tz: number, orbit: Orbit): Place => ({ x, z, yaw: Math.atan2(x - tx, z - tz), orbit });

/** By key: 0 the opening on the pier, 1 to 9 the rest. */
const PLACES: Place[] = [
  { x: SPAWN.x, z: SPAWN.z, yaw: SPAWN.yaw, orbit: SPAWN.orbit, home: true },
  // The island's east shore by the water, across the bay to the town and the pier.
  facing(-162, -19, 30, -175, [0.45, 0, 3.6]),
  // The lighthouse's foot, over the bay to the town, the tower on her left.
  facing(-200.8, -25.8, 40, -180, [0, 0.08, 4]),
  // The top of the main lane, down it over the roofs to the harbour and the sea.
  { x: 72.6, z: -181, yaw: Math.PI / 2, orbit: [0, 0.25, 4.2] },
  // The crest of the hill above the town, over the whole bay to the island.
  facing(223.8, -130, ISLAND.x, ISLAND.z, [0, 0.1, 4.5]),
  // The middle of the beach, on dry sand above the swash, out to the island.
  facing(34, -36, ISLAND.x, ISLAND.z, [0, 0.06, 4]),
  // By the pines on the north headland's ridge, across the mouth of the bay to the island.
  facing(-17, 272, ISLAND.x, ISLAND.z, [0, 0.06, 4]),
  // By a grove on the south headland, over the water to the island and the pier's end.
  facing(-80, -284, ISLAND.x, ISLAND.z, [0, 0.06, 4]),
  // The north end of the beach among the reef rocks under the headland.
  facing(-10, 195, ISLAND.x, ISLAND.z, [0, 0.06, 4]),
  // The pier's landward end, out along it to the sea.
  { x: 4, z: -193, yaw: Math.PI / 2, orbit: [0, 0.12, 4.5] },
];

const OUT = 0.2;
const IN = 0.35;
const KEY = /^(?:Digit|Numpad)(\d)$/;
const smooth = (k: number) => k * k * (3 - 2 * k);

/** The opening veil's painted sky and sea (index.html, ui/intro.ts), in the time of day now. */
function veilOf(p: Preset): string {
  const { sky, sea } = PALETTES[p], H = 63;
  const at = (v: number) => `${v.toFixed(1)}%`;
  return `linear-gradient(to bottom, ${sky[0]} 0%, ${sky[1]} ${at(H * 0.45)}, ${sky[2]} ${at(H * 0.82)}, ${sky[3]} ${at(H)}, ${sea[0]} ${at(H)}, ${sea[1]} ${at(H + 37 * 0.3)}, ${sea[2]} ${at(H + 37 * 0.65)}, ${sea[3]} 100%)`;
}

/**
 * The number keys: a short veil in, she stands at that place facing the view with the camera behind
 * her, and the veil lifts. Held keys and presses while the veil is up do nothing.
 */
export class Places {
  private readonly veil = document.createElement("div");
  private to: Place | null = null;
  /** 0 idle, 1 veil coming in, 2 lifting; progress through the step (0…1), last frame time. */
  private phase = 0;
  private k = 0;
  private last = 0;

  constructor(private explore: Explore, private tod: TimeOfDay, canvas: HTMLElement) {
    this.veil.style.cssText = "position: fixed; inset: 0; pointer-events: none; opacity: 0; display: none";
    canvas.after(this.veil);
    addEventListener("keydown", (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || this.phase || !this.explore.enabled) return;
      const m = KEY.exec(e.code);
      if (m) this.go(PLACES[Number(m[1])]);
    });
  }

  private go(p: Place): void {
    this.to = p;
    this.phase = 1;
    this.k = 0;
    this.veil.style.background = veilOf(this.tod.preset);
    this.veil.style.opacity = "0";
    this.veil.style.display = "block";
    this.last = performance.now();
    requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (this.phase === 1) {
      this.k = Math.min(1, this.k + dt / OUT);
      this.veil.style.opacity = smooth(this.k).toFixed(3);
      if (this.k >= 1) {
        const p = this.to!;
        this.explore.setDown(p.x, p.z, p.yaw, p.orbit[0], p.orbit[1], p.orbit[2], p.home);
        this.phase = 2;
        this.k = 0;
      }
    } else {
      this.k = Math.min(1, this.k + dt / IN);
      this.veil.style.opacity = (1 - smooth(this.k)).toFixed(3);
      if (this.k >= 1) {
        this.veil.style.display = "none";
        this.phase = 0;
        this.to = null;
        return;
      }
    }
    requestAnimationFrame(this.tick);
  };
}
