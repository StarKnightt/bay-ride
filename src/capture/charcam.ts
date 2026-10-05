import * as THREE from "three";
import type { Explore } from "../rider/onfoot";
import type { Rider } from "../rider/rider";
import type { Boat } from "../boat/boat";
import { gaitCycle } from "../rider/rider";
import { SPAWN } from "../boat/berth";
import { PIER, deckH } from "../world/bay/pier";
import { SEA_Y, roadX } from "../world/bay/road";
import { terrainH, waterlineU } from "../world/bay/terrain";

/**
 * Character capture views (?cam=portrait | turn&a=<deg> | walk | boatseat, ?pose=wade). Each puts
 * her somewhere fixed (or on a fixed path that is a function of t) and the camera relative to her,
 * so the same t always gives the same frame. See .gauntlet/SHOTS.md.
 */
export type CharCamMode = "portrait" | "turn" | "walk" | "boatseat" | "wade";

export function charMode(params: URLSearchParams): CharCamMode | null {
  const c = params.get("cam");
  if (c === "portrait" || c === "turn" || c === "walk" || c === "boatseat") return c;
  if (params.get("pose") === "wade") return "wade";
  return null;
}

const WALK_V = 1.3;
const WADE_V = 0.85;
/** Water depth she wades in along the shore (m). */
const WADE_D = 0.14;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export class CharDirector {
  readonly angle: number;
  /** Turnaround distance and aim height (?d=, ?h=), for closer looks. */
  private dist: number;
  private aimH: number;
  private head = new THREE.Vector3();
  constructor(
    readonly mode: CharCamMode,
    params: URLSearchParams,
    private explore: Explore,
    private rider: Rider,
    private boat: Boat,
  ) {
    this.angle = (Number(params.get("a") ?? 0) * Math.PI) / 180;
    this.dist = Number(params.get("d") ?? 3.1);
    this.aimH = Number(params.get("h") ?? 0.87);
    if (mode === "wade") rider.settleT = 12;
    if (mode === "walk") rider.settleT = 6;
  }

  /** She walks the scripted path / stands for the view (not for boatseat: the boat course does). */
  get drives(): boolean {
    return this.mode !== "boatseat";
  }

  /** Shore x where the bed is WADE_D under mean sea level, at z. */
  private wadeX(z: number): number {
    const x0 = roadX(z) + waterlineU(z);
    let lo = x0 - 30, hi = x0 + 10;
    // Bed rises toward +x (the beach); find terrainH = SEA_Y - WADE_D.
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (terrainH(m, z) < SEA_Y - WADE_D) lo = m;
      else hi = m;
    }
    return (lo + hi) / 2;
  }

  drive(t: number): void {
    const e = this.explore;
    if (this.mode === "walk") {
      const x = -50 - WALK_V * t;
      e.drive(x, PIER.z - 0.85, Math.PI / 2, WALK_V, ((WALK_V * t) / gaitCycle(0, WALK_V)) * Math.PI * 2, t);
    } else if (this.mode === "wade") {
      const z = 6 + WADE_V * t;
      const x = this.wadeX(z), x2 = this.wadeX(z + 0.5);
      const yaw = Math.atan2(-(x2 - x), -0.5);
      e.drive(x, z, yaw, WADE_V, ((WADE_V * t) / gaitCycle(0, WADE_V)) * Math.PI * 2, t);
    } else {
      e.drive(SPAWN.x, SPAWN.z, SPAWN.yaw, 0, 0, t);
    }
  }

  /** Place the capture camera (after the rider has been posed). */
  camera(cam: THREE.PerspectiveCamera): void {
    const r = this.rider, w = r.walker;
    r.headWorld(this.head);
    const yaw = this.mode === "boatseat" ? this.boat.yaw : new THREE.Euler().setFromQuaternion(w.quaternion, "YXZ").y;
    const fwd = V(-Math.sin(yaw), 0, -Math.cos(yaw)), right = V(Math.cos(yaw), 0, -Math.sin(yaw));
    const p = w.position;
    let eye: THREE.Vector3, look: THREE.Vector3, fov: number;
    switch (this.mode) {
      case "portrait": {
        const a = 0.42;
        eye = this.head.clone().addScaledVector(fwd, 0.66 * Math.cos(a)).addScaledVector(right, 0.66 * Math.sin(a)).add(V(0, 0.03, 0));
        look = this.head.clone().add(V(0, -0.035, 0)).addScaledVector(right, 0.02);
        fov = 30;
        r.gazeTarget = eye.clone();
        break;
      }
      case "turn": {
        const d = this.dist;
        const dir = fwd.clone().multiplyScalar(Math.cos(this.angle)).addScaledVector(right, Math.sin(this.angle));
        eye = p.clone().addScaledVector(dir, d).add(V(0, this.aimH + 0.15 * (d / 3.1), 0));
        look = p.clone().add(V(0, this.aimH, 0));
        fov = 36;
        r.gazeTarget = null;
        break;
      }
      case "walk": {
        const deck = deckH(p.x);
        eye = V(p.x - 0.25, deck + 0.92, PIER.z + 1.3);
        look = V(p.x, deck + 0.83, p.z);
        fov = 50;
        break;
      }
      case "wade": {
        eye = p.clone().addScaledVector(fwd, 2.4).addScaledVector(right, 2.0).add(V(0, 1.25, 0));
        look = p.clone().addScaledVector(fwd, -0.4).add(V(0, 0.45, 0));
        fov = 46;
        break;
      }
      case "boatseat":
      default: {
        eye = this.head.clone().addScaledVector(fwd, 1.55).addScaledVector(right, 0.95).add(V(0, 0.12, 0));
        look = this.head.clone().add(V(0, -0.28, 0)).addScaledVector(fwd, -0.05);
        fov = 42;
        break;
      }
    }
    cam.position.copy(eye);
    cam.up.set(0, 1, 0);
    cam.lookAt(look);
    cam.fov = fov;
    cam.near = 0.05;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }
}
