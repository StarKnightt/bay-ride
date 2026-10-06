import * as THREE from "three";
import { SEA_Y, roadX } from "../world/bay/road";
import { ISLAND, LIGHTHOUSE, terrainH } from "../world/bay/terrain";

/**
 * Fixed vantage points for side-by-side comparison captures (?shot=1..5). Each is an absolute eye
 * position, a look target and a vertical field of view; the camera is frozen there.
 */
export interface Shot {
  name: string;
  eye: THREE.Vector3;
  look: THREE.Vector3;
  fov: number;
}

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export const SHOTS: Record<number, Shot> = {
  // Standing on the wet sand near the water's edge, eye height, along the shore toward the harbour.
  1: { name: "shoreline", eye: v(roadX(40) - 27, SEA_Y + 1.85, 40), look: v(roadX(40) - 58, SEA_Y + 0.6, 4), fov: 50 },
  // From the sea-side lane of the coast road, over the bay to the island.
  2: { name: "coast road", eye: v(roadX(60) - 1.6, 1.6, 60), look: v(ISLAND.x, SEA_Y + 4, ISLAND.z), fov: 50 },
  // Pier end, looking back at the harbour and the town on the hill.
  3: { name: "pier end", eye: v(-92, SEA_Y + 3.2, -192), look: v(30, 6, -168), fov: 50 },
  // Low over the water toward the lighthouse, the evening sun setting just beside it.
  4: { name: "lighthouse", eye: v(-82, SEA_Y + 1.3, 74), look: v(LIGHTHOUSE.x - 6, SEA_Y + 11, LIGHTHOUSE.z + 12), fov: 50 },
  // High, wide establishing view of the whole bay.
  5: { name: "establishing", eye: v(215, 100, 250), look: v(-90, 2, -80), fov: 46 },
  // Test views (not critic shots): grazing eye height along the road and along the dry sand,
  // where fine surface detail is the first thing to shimmer.
  6: { name: "road grazing", eye: v(roadX(10) + 0.6, 1.62, 10), look: v(roadX(70) + 0.6, 0.9, 70), fov: 50 },
  7: { name: "beach grazing", eye: v(roadX(30) - 13, SEA_Y + 3.4, 30), look: v(roadX(90) - 15, SEA_Y + 2.2, 90), fov: 50 },
  // Taste views at gameplay distance (not critic shots): the ride camera's height out on the bay,
  // looking at the hills and the town, and her eye height on the hill and on the beach.
  8: { name: "bay to the hills", eye: v(-150, SEA_Y + 3.2, -40), look: v(60, 22, -60), fov: 55 },
  9: { name: "bay to the north shore", eye: v(-120, SEA_Y + 3.2, 110), look: v(80, 24, 150), fov: 55 },
  10: { name: "on the hill", eye: v(roadX(-10) + 70, terrainH(roadX(-10) + 70, -10) + 1.7, -10), look: v(roadX(30) + 40, terrainH(roadX(30) + 40, 30) + 0.5, 30), fov: 55 },
  11: { name: "beach to the island", eye: v(roadX(-40) - 16, SEA_Y + 2.1, -40), look: v(ISLAND.x, SEA_Y + 6, ISLAND.z), fov: 55 },
  // On the town hill's crest (her walk bound), looking on over the land past it, and back down.
  12: { name: "crest, onward", eye: v(roadX(-60) + 196, terrainH(roadX(-60) + 196, -60) + 1.7, -60), look: v(roadX(-40) + 300, terrainH(roadX(-40) + 300, -40) + 2, -40), fov: 55 },
  13: { name: "crest, back to the bay", eye: v(roadX(-60) + 196, terrainH(roadX(-60) + 196, -60) + 1.7, -60), look: v(roadX(-90) + 20, 0, -90), fov: 55 },
  // In the town: from the coast road up between the houses.
  14: { name: "town lane", eye: v(roadX(-178) + 6, terrainH(roadX(-178) + 6, -178) + 1.65, -178), look: v(roadX(-188) + 60, terrainH(roadX(-188) + 60, -188) + 3, -188), fov: 55 },
  // Standing on the beach under the wall, along the dunes toward each headland's foot.
  15: { name: "dunes north", eye: v(roadX(140) - 15, SEA_Y + 1.8, 140), look: v(roadX(200) - 14, SEA_Y + 1.5, 200), fov: 55 },
  16: { name: "dunes south", eye: v(roadX(-205) - 9, SEA_Y + 1.8, -205), look: v(roadX(-262) - 14, SEA_Y + 1.5, -262), fov: 55 },
};

export interface CaptureParams {
  shot: Shot | null;
  /** Fixed animation time (seconds), or null to let time run. */
  time: number | null;
  hud: boolean;
}

export function captureParams(params: URLSearchParams): CaptureParams {
  const n = Number(params.get("shot"));
  const shot = SHOTS[n] ?? null;
  const tRaw = params.get("t");
  const time = tRaw !== null && Number.isFinite(Number(tRaw)) ? Number(tRaw) : null;
  const hud = !shot && params.get("hud") !== "0" && !params.has("nohud");
  return { shot, time, hud };
}

/** Put the camera on the shot and keep it there. */
export function poseCamera(cam: THREE.PerspectiveCamera, s: Shot): void {
  cam.position.copy(s.eye);
  cam.up.set(0, 1, 0);
  cam.lookAt(s.look);
  if (cam.fov !== s.fov) {
    cam.fov = s.fov;
    cam.updateProjectionMatrix();
  }
  cam.updateMatrixWorld();
}
