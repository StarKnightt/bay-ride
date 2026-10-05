import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { uber } from "../render/materials";
import { ID, M } from "../world/geo";
import { FACE_U, heroineFaceMaterial, type FaceLayout } from "./heroineFace";

/**
 * The heroine GLB (tools/character, built in Blender) dressed in the game's own materials: each
 * Blender material name picks an uber toon surface (M.*) and outline group (ID.*); her face, head
 * and neck take the painted face material. Vertex colours carry the albedo, `_wind` the flutter
 * weight. She faces +Z (glTF front), feet on y = 0.
 */

interface Role {
  id: number;
  mt: number;
  side?: THREE.Side;
}
const ROLES: Record<string, Role> = {
  skin: { id: ID.skin, mt: M.skin },
  hair: { id: ID.hair, mt: M.hair, side: THREE.DoubleSide },
  shirt: { id: ID.rider, mt: M.linen, side: THREE.DoubleSide },
  cami: { id: ID.top, mt: M.cloth, side: THREE.DoubleSide },
  shorts: { id: ID.shorts, mt: M.linen, side: THREE.DoubleSide },
  sandal: { id: ID.shorts, mt: M.plain, side: THREE.DoubleSide },
  metal: { id: ID.shorts, mt: M.metal },
  straw: { id: ID.hat, mt: M.straw, side: THREE.DoubleSide },
  ribbon: { id: ID.top, mt: M.cloth, side: THREE.DoubleSide },
  frame: { id: ID.eye, mt: M.lacquer },
};

export interface HeroineMeta {
  face: FaceLayout;
  materials: string[];
  clips?: Record<string, { duration: number; [k: string]: unknown }>;
}

export interface Heroine {
  root: THREE.Group;
  clips: Map<string, THREE.AnimationClip>;
  mixer: THREE.AnimationMixer;
  meta: HeroineMeta;
  bones: Map<string, THREE.Bone>;
  meshes: THREE.Mesh[];
  tris: number;
}

export async function loadHeroine(url: string): Promise<Heroine> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = new THREE.Group();
  root.name = "heroine";
  root.add(gltf.scene);
  let meta: HeroineMeta | null = null;
  gltf.scene.traverse((o) => {
    const raw = (o.userData as Record<string, unknown>).heroine;
    if (typeof raw === "string") meta = JSON.parse(raw) as HeroineMeta;
  });
  if (!meta) throw new Error("heroine.glb carries no layout extras");
  const m = meta as HeroineMeta;
  const face = heroineFaceMaterial(m.face, ID.eye);
  FACE_U.uHatShade.value = m.materials.includes("straw") ? 1 : 0;
  const meshes: THREE.Mesh[] = [];
  const bones = new Map<string, THREE.Bone>();
  let tris = 0;
  gltf.scene.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.set(o.name, o as THREE.Bone);
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    const name = (mesh.material as THREE.Material).name.replace(/\.\d+$/, "");
    const n = g.attributes.position.count;
    const col = g.getAttribute("color") as THREE.BufferAttribute | undefined;
    // The uber shaders read RGB albedo (glTF colours arrive as RGBA, possibly normalised ints).
    const rgb = new Float32Array(n * 3).fill(1);
    if (col) for (let i = 0; i < n; i++) {
      rgb[i * 3] = col.getX(i);
      rgb[i * 3 + 1] = col.getY(i);
      rgb[i * 3 + 2] = col.getZ(i);
    }
    g.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
    const wind = g.getAttribute("_wind");
    g.setAttribute("aWind", wind ?? new THREE.BufferAttribute(new Float32Array(n), 1));
    if (wind) g.deleteAttribute("_wind");
    const role = ROLES[name];
    g.setAttribute("aMat", new THREE.BufferAttribute(new Float32Array(n).fill(role ? role.mt : M.skin), 1));
    mesh.material = name === "face" ? face : uber(role?.id ?? ID.skin, 1, role?.side ?? THREE.FrontSide, 0, true);
    mesh.userData.role = name;
    mesh.userData.hatPart = name === "straw" || name === "ribbon";
    // Her head shades her neck by paint too: it casts onto the ground, not onto her chest.
    mesh.userData.headPart = name === "face";
    // Skinned: the bind-pose bounds don't follow the pose.
    mesh.frustumCulled = false;
    tris += (g.index ? g.index.count : n) / 3;
    meshes.push(mesh);
  });
  const clips = new Map(gltf.animations.map((c) => [c.name, c] as [string, THREE.AnimationClip]));
  const mixer = new THREE.AnimationMixer(gltf.scene);
  return { root, clips, mixer, meta: m, bones, meshes, tris };
}

/** Pose her on a clip at time t (seconds), frozen. */
export function poseAt(h: Heroine, clip: string | null, t: number): void {
  h.mixer.stopAllAction();
  const c = clip ? h.clips.get(clip) : undefined;
  if (c) {
    const a = h.mixer.clipAction(c);
    a.reset().play();
    a.paused = false;
    h.mixer.setTime(((t % c.duration) + c.duration) % c.duration);
  } else {
    h.root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) (o as THREE.SkinnedMesh).skeleton.pose();
    });
  }
  h.root.updateMatrixWorld(true);
}
