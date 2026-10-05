import * as THREE from "three";
import { ID, M, cyl, merge, xf } from "../world/geo";
import { uber } from "../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../render/lightpasses";
import { seaHeight, seaNormal } from "./query";

/** Most buoys the sea shader rings with foam (uniform array size). */
export const BUOY_MAX = 6;

/** Moored buoys in the bay: x, z, colour (0 red, 1 yellow, 2 white-red). */
const SPOTS: [number, number, number][] = [
  [-112, 44, 0],
  [-138, 18, 1],
  [-70, -150, 2],
  [-48, -205, 0],
  [-150, -70, 1],
  [-100, 112, 2],
];

/** Buoy positions (x, z), for anything that must steer clear of them. */
export const BUOY_XZ: readonly [number, number][] = SPOTS.map(([x, z]) => [x, z]);

/** (x, z, waterline radius, heave speed) per buoy, for foam rings in the sea shader. */
export const BUOY_U = { value: Array.from({ length: BUOY_MAX }, () => new THREE.Vector4(1e5, 1e5, 0, 0)) };

/**
 * A few mooring buoys riding the swell and chop: a squat float, a cone top and a conical day-mark,
 * pitched and rolled by the water normal. They show the motion of the sea and give the water
 * something to reflect and foam around.
 */
export class Buoys {
  readonly group = new THREE.Group();
  private readonly items: { m: THREE.Mesh; x: number; z: number; ph: number; y: number }[] = [];
  private readonly n = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly qy = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor() {
    const mat = uber(ID.pole, 1);
    const looks = [
      ["#c8423a", "#e8e2d4"],
      ["#e2b23a", "#3a3a3e"],
      ["#ece6da", "#c8423a"],
    ];
    SPOTS.forEach(([x, z, k], i) => {
      const [a, b] = looks[k];
      const g = merge([
        xf(cyl(0.62, 0.55, 0.7, a, M.metal, 14), 0, 0.05, 0),
        xf(cyl(0.66, 0.66, 0.12, b, M.metal, 14), 0, 0.42, 0),
        xf(cyl(0.12, 0.5, 0.75, a, M.metal, 12), 0, 0.85, 0),
        xf(cyl(0.05, 0.05, 0.9, "#3a3a3e", M.metal, 6), 0, 1.6, 0),
        xf(cyl(0.012, 0.21, 0.36, b, M.metal, 10), 0, 2.2, 0),
      ]);
      const m = new THREE.Mesh(g, mat);
      onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
      this.group.add(m);
      this.items.push({ m, x, z, ph: i * 1.7, y: 0 });
      if (i < BUOY_MAX) BUOY_U.value[i].set(x, z, 0.62, 0);
    });
  }

  update(t: number): void {
    this.items.forEach((b, i) => {
      // Float on the surface with a little lag and sway of its own.
      const y = seaHeight(b.x, b.z, t) - 0.18 + 0.04 * Math.sin(t * 1.3 + b.ph);
      const vy = (seaHeight(b.x, b.z, t + 0.1) - seaHeight(b.x, b.z, t - 0.1)) * 5;
      b.y = y;
      seaNormal(b.x, b.z, t, this.n);
      this.n.x *= 2.2;
      this.n.z *= 2.2;
      this.n.x += 0.05 * Math.sin(t * 0.9 + b.ph);
      this.n.normalize();
      this.q.setFromUnitVectors(this.up, this.n);
      this.qy.setFromAxisAngle(this.up, b.ph + 0.2 * Math.sin(t * 0.3 + b.ph));
      b.m.quaternion.multiplyQuaternions(this.q, this.qy);
      b.m.position.set(b.x, y, b.z);
      if (i < BUOY_MAX) BUOY_U.value[i].w = Math.max(-1, Math.min(1, vy));
    });
  }
}
