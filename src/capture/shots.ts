import * as THREE from "three";
import { SEA_Y, roadX } from "../world/bay/road";
import { ISLAND, LIGHTHOUSE } from "../world/bay/terrain";

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
