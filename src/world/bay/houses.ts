import * as THREE from "three";
import { ID, M, box, boxM, merge, prep, xf } from "../geo";

type Geo = THREE.BufferGeometry;
import { uber } from "../../render/materials";
import { LAYER_REFLECT, LAYER_SHADOW, onLayers } from "../../render/lightpasses";
import { roadX } from "./road";
import { terrainH } from "./terrain";
import type { Collider } from "./index";

/** Placeholder harbour houses on the hill above the road (u metres inland of the road, z). */
const SPOTS: [number, number, number][] = [
  [13, -158, 0], [15, -174, 1], [13, -191, 2], [25, -166, 3], [27, -184, 4],
  [23, -203, 5], [37, -175, 6], [39, -195, 7], [15, -212, 8], [33, -214, 9],
];
const WALLS = ["#efe5d2", "#e6d6b8", "#f3ece0", "#d8dfdc", "#ead2bc"];
const ROOFS = ["#a05a43", "#8c4c3c", "#5f7184", "#b06a4a"];

/**
 * Simple pitched-roof houses so the harbour hillside has lived-in windows after dark until the
 * town system replaces them. Fronts face the sea (-x); windows light warm at dusk and night.
 */
export function buildHouses(colliders: Collider[]): THREE.Mesh {
  const parts: Geo[] = [];
  for (const [u, z, k] of SPOTS) {
    const x = roadX(z) + u;
    const w = 6 + (k % 3), d = 5.5 + ((k * 7) % 3), floors = 1 + (k % 2 === 0 ? 1 : 0);
    const h = 3.1 * floors + 0.6;
    let y = Infinity;
    for (const [cx, cz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) y = Math.min(y, terrainH(x + (cx * w) / 2, z + (cz * d) / 2));
    y -= 0.4;
    const pitch = 0.5;
    const slab = d / 2 / Math.cos(pitch) + 0.45;
    const roofCol = ROOFS[k % ROOFS.length];
    const ridge = y + h + Math.tan(pitch) * (d / 2) * 0.98;
    const hp: Geo[] = [
      xf(boxM(w, h, d, WALLS[k % WALLS.length], M.plaster), 0, y + h / 2, 0),
      xf(boxM(w + 0.7, 0.22, slab, roofCol, M.roof), 0, (y + h + ridge) / 2, -d / 4, -pitch, 0, 0),
      xf(boxM(w + 0.7, 0.22, slab, roofCol, M.roof), 0, (y + h + ridge) / 2, d / 4, pitch, 0, 0),
      xf(gable(w, d, Math.tan(pitch) * d / 2, WALLS[k % WALLS.length]), 0, y + h - 0.05, 0),
      xf(box(0.1, 2.1, 1.1, "#4a3a2e", M.planks), -w / 2 - 0.04, y + 1.05, d * 0.28),
    ];
    for (let f = 0; f < floors; f++) {
      const wy = y + 1.7 + f * 3.1;
      const across = f === 0 ? [-0.25] : [-0.28, 0.28];
      for (const s of across) hp.push(xf(box(0.08, 1.25, 1.0, "#20262c", M.glass), -w / 2 - 0.04, wy, s * d));
      hp.push(xf(box(1.0, 1.2, 0.08, "#20262c", M.glass), 0, wy, d / 2 + 0.04));
      hp.push(xf(box(1.0, 1.2, 0.08, "#20262c", M.glass), 0, wy, -d / 2 - 0.04));
    }
    for (const g of hp) parts.push(xf(g, x, 0, z));
    colliders.push({ x, z, r: Math.min(w, d) / 2 + 0.3 });
  }
  const m = new THREE.Mesh(merge(parts), uber(ID.house, 2));
  onLayers(m, LAYER_SHADOW, LAYER_REFLECT);
  return m;
}

/** Triangular wall prism filling the space under a pitched roof (ridge along x). */
function gable(w: number, d: number, rise: number, color: string): Geo {
  const sh = new THREE.Shape([new THREE.Vector2(-d / 2, 0), new THREE.Vector2(d / 2, 0), new THREE.Vector2(0, rise)]);
  const g = new THREE.ExtrudeGeometry(sh, { depth: w - 0.1, bevelEnabled: false });
  g.translate(0, 0, -(w - 0.1) / 2);
  g.rotateY(Math.PI / 2);
  return prep(g, color, M.plaster);
}
