import * as THREE from "three";
import { ID, M, box, merge } from "../geo";
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { roadDX, roadX } from "./road";
import { WALL_IN, meshH } from "./terrain";

/**
 * Concrete slipways from the promenade down over the sea wall onto the beach. The wall is too steep
 * to walk up, so these are the ways back from the sand (the one by the pier doubles as the
 * harbour's boat ramp). Each runs square to the wall line, from its top edge to where it meets the
 * sand.
 */
const SPOTS = [-205, -70, 125];
const HALF = 1.4;
const SLOPE = 1 / 3.6;

interface Ramp {
  /** Top of the wall where it starts, the seaward direction (unit), and its length along it. */
  x: number;
  z: number;
  nx: number;
  nz: number;
  len: number;
}

const RAMPS: Ramp[] = [];

/** Height of the slipway surface at (x, z), or −Infinity off every slipway (grown by `pad` m). */
export function rampH(x: number, z: number, pad = 0): number {
  for (const r of RAMPS) {
    const dx = x - r.x, dz = z - r.z;
    const s = dx * r.nx + dz * r.nz;
    if (s < -pad || s > r.len + pad) continue;
    if (Math.abs(dx * r.nz - dz * r.nx) > HALF + pad) continue;
    return -Math.max(s, 0) * SLOPE;
  }
  return -Infinity;
}

/** The slipways (call after the terrain mesh is built: they end where they meet its sand). */
export function buildSlipways(): THREE.Mesh {
  const th = Math.atan(SLOPE), T = 1.2;
  const tilt = new THREE.Matrix4().makeRotationZ(-th);
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), lat = new THREE.Vector3();
  const parts: THREE.BufferGeometry[] = [];
  for (const z of SPOTS) {
    const d = roadDX(z), k = Math.hypot(1, d);
    const r: Ramp = { x: roadX(z) + WALL_IN, z, nx: -1 / k, nz: d / k, len: 3 };
    while (r.len < 14 && -r.len * SLOPE > meshH(r.x + r.nx * r.len, z + r.nz * r.len)) r.len += 0.05;
    RAMPS.push(r);
    // A slab along local x, tilted down seaward with its top back edge on the promenade edge, its
    // foot running on under the sand.
    const L = (r.len + 0.4) / Math.cos(th);
    const g = box(L, T, HALF * 2, "#bdb6a6", M.stone);
    const ex = (-L / 2) * Math.cos(th) + (T / 2) * Math.sin(th), ey = (L / 2) * Math.sin(th) + (T / 2) * Math.cos(th);
    g.applyMatrix4(new THREE.Matrix4().makeTranslation(-ex, -ey, 0).multiply(tilt));
    n.set(r.nx, 0, r.nz);
    lat.crossVectors(n, up);
    g.applyMatrix4(new THREE.Matrix4().makeBasis(n, up, lat).setPosition(r.x, 0, z));
    parts.push(g);
  }
  const m = new THREE.Mesh(merge(parts), uber(ID.ground, 0.6));
  m.name = "slipways";
  onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
  return m;
}
