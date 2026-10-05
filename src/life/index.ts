import * as THREE from "three";
import type { Layout } from "../flora/place";
import { Butterflies } from "./butterflies";
import { Drift } from "./drift";
import { Fireflies } from "./fireflies";
import { Fish } from "./fish";
import { Gulls } from "./gulls";
import { cues } from "../sound/cues";

/** What the life needs to know about the moment: time, step, and the time of day's mood. */
export interface LifeTime {
  t: number;
  dt: number;
  /** 0…1 share of seabirds aloft (the time of day's `birds`). */
  birds: number;
  /** 0 day … 1 night. */
  night: number;
}

/**
 * Life in the bay: gulls over the water and on the posts, butterflies over the flower drifts,
 * fish leaping in view, petals and seeds on the breeze by day, fireflies over the grass at night.
 * Seven draws in all; the CPU work per frame is posing ~30 gulls and two fish.
 */
export class Life {
  readonly group = new THREE.Group();
  readonly gulls: Gulls;
  readonly butterflies: Butterflies;
  readonly fish: Fish;
  readonly drift: Drift;
  readonly fireflies: Fireflies;
  private readonly fwd = new THREE.Vector3();

  constructor(layout: Layout, drifts: readonly [number, number, number, number][]) {
    this.group.name = "life";
    this.gulls = new Gulls(layout.perches);
    this.butterflies = new Butterflies(drifts);
    this.fish = new Fish();
    this.drift = new Drift();
    this.fireflies = new Fireflies(layout);
    this.group.add(this.gulls.group, this.butterflies.mesh, this.fish.group, this.drift.mesh, this.fireflies.mesh);
  }

  update(time: LifeTime, cam: THREE.PerspectiveCamera, px: number, pz: number): void {
    cam.getWorldDirection(this.fwd);
    const l = Math.hypot(this.fwd.x, this.fwd.z) || 1;
    const fx = this.fwd.x / l, fz = this.fwd.z / l;
    // The ears for the placed sounds (gulls, fish).
    cues.listen(cam.position, fx, fz, px, pz, time.t);
    const day = 1 - time.night;
    this.gulls.update(time.t, time.dt, px, pz, cam.position, time.birds);
    this.butterflies.update(cam.position, day);
    this.fish.update(time.t, cam.position, fx, fz);
    this.drift.update(day);
    this.fireflies.update(time.night, px, pz, fx, fz);
  }
}
