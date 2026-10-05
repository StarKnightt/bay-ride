import * as THREE from "three";
import { G, REFL, shadowDepthMaterial } from "./materials";
import type { ShadowPass } from "./precompile";

/**
 * Render layers: 0 = main view, 1 = casts sun shadow, 2 = appears in water reflections, 3 = her own
 * shadow, 4 = her hat and face stand-ins in her own shadow (drawn with an offset depth).
 */
export const LAYER_SHADOW = 1;
export const LAYER_REFLECT = 2;
export const LAYER_CHAR = 3;
export const LAYER_CHAR_HAT = 4;

export function onLayers(o: THREE.Object3D, ...layers: number[]): void {
  o.traverse((c) => {
    for (const l of layers) c.layers.enable(l);
  });
}

/**
 * One directional shadow map that follows the rider (centred ahead of her, where the camera
 * looks). Texel-snapped so shadows don't shimmer as the frustum slides.
 */
export class SunShadow {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cam: THREE.OrthographicCamera;
  readonly mat = shadowDepthMaterial();
  private readonly size: number;
  private readonly half: number;
  /** Direction toward the light for the shadow camera; defaults to the shading sun `uSunDir`. */
  dir: THREE.Vector3 | null = null;
  private bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

  constructor(size = 2048, half = 55) {
    this.size = size;
    this.half = half;
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      depthTexture: new THREE.DepthTexture(size, size, THREE.UnsignedIntType),
      type: THREE.UnsignedByteType,
    });
    this.rt.depthTexture!.minFilter = THREE.NearestFilter;
    this.rt.depthTexture!.magFilter = THREE.NearestFilter;
    this.cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 320);
    this.cam.layers.set(LAYER_SHADOW);
    G.uShadowMap.value = this.rt.depthTexture;
    G.uShadowTexel.value.set(1 / size, 1 / size);
    G.uShadowRange.value = 319;
    G.uShadowHalf.value = half;
  }

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, center: THREE.Vector3): void {
    const sun = this.dir ?? G.uSunDir.value;
    // Snap the centre to the texel grid in light space.
    const texel = (this.half * 2) / this.size;
    const lightRot = new THREE.Matrix4().lookAt(sun, new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
    const inv = lightRot.clone().invert();
    const c = center.clone().applyMatrix4(inv);
    c.x = Math.round(c.x / texel) * texel;
    c.y = Math.round(c.y / texel) * texel;
    c.applyMatrix4(lightRot);
    this.cam.position.copy(c).addScaledVector(sun, 160);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(c);
    this.cam.updateMatrixWorld();
    this.cam.updateProjectionMatrix();
    G.uShadowMat.value.copy(this.bias).multiply(this.cam.projectionMatrix).multiply(this.cam.matrixWorldInverse);
    G.uShadowCenter.value.copy(center);
    G.uShadowOn.value = 1;

    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.mat;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.cam);
    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(null);
  }
}

/**
 * Her own sun shadow, from a small map wrapped tightly round her along the same light direction
 * (about 2 mm per texel). In the bay's 110 m map her legs were two texels wide, so at a low sun
 * their long shadow broke into stepped dashes. Receivers take the darker of the two maps.
 */
export class CharShadow {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cam: THREE.OrthographicCamera;
  private bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

  /**
   * Second pass into the same map: her hat and face (LAYER_CHAR_HAT) with their depth pushed away
   * from the light, so the brim doesn't black out her face, hair and shoulders but still shades the
   * ground; null = no second pass.
   */
  readonly hatCam: THREE.OrthographicCamera;
  hatMat: THREE.Material | null = null;

  constructor(readonly mat: THREE.Material, size = 1024, half = 1.25) {
    this.rt = new THREE.WebGLRenderTarget(size, size, {
      depthTexture: new THREE.DepthTexture(size, size, THREE.UnsignedIntType),
      type: THREE.UnsignedByteType,
    });
    this.rt.depthTexture!.minFilter = THREE.NearestFilter;
    this.rt.depthTexture!.magFilter = THREE.NearestFilter;
    this.cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.5, 40);
    this.cam.layers.set(LAYER_CHAR);
    this.hatCam = this.cam.clone();
    this.hatCam.layers.set(LAYER_CHAR_HAT);
    G.uCharShadowMap.value = this.rt.depthTexture;
    G.uCharShadowTexel.value = 1 / size;
  }

  /** `center`: her middle (world); `dir`: toward the light; off when she isn't drawn. */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, center: THREE.Vector3, dir: THREE.Vector3, on: boolean): void {
    G.uCharShadowOn.value = on ? 1 : 0;
    if (!on) return;
    this.cam.position.copy(center).addScaledVector(dir, 20);
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(center);
    this.cam.updateMatrixWorld();
    G.uCharShadowMat.value.copy(this.bias).multiply(this.cam.projectionMatrix).multiply(this.cam.matrixWorldInverse);
    G.uCharShadowDir.value.copy(dir);
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = this.mat;
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    renderer.render(scene, this.cam);
    if (this.hatMat) {
      this.hatCam.position.copy(this.cam.position);
      this.hatCam.quaternion.copy(this.cam.quaternion);
      this.hatCam.updateMatrixWorld();
      const ac = renderer.autoClear;
      renderer.autoClear = false;
      scene.overrideMaterial = this.hatMat;
      renderer.render(scene, this.hatCam);
      renderer.autoClear = ac;
    }
    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(null);
  }

  /** The hat pass as a shadow pass, for the shader warm-up. */
  get hatPass(): ShadowPass[] {
    return this.hatMat ? [{ rt: this.rt, cam: this.hatCam, mat: this.hatMat }] : [];
  }
}

/**
 * Planar mirror for the flooded paddies (same maths as three's Reflector: mirrored virtual camera
 * + oblique near-plane clip), rendered at reduced resolution with only the reflect layer.
 */
export class PlanarReflection {
  readonly rt: THREE.WebGLRenderTarget;
  readonly cam = new THREE.PerspectiveCamera();
  private tex = new THREE.Matrix4();
  private readonly normal = new THREE.Vector3(0, 1, 0);

  constructor(w: number, h: number) {
    // Multisampled: at half resolution unresolved edges step in blocks once magnified on the water.
    // Colour only: the scene materials' second output (normal/id) has no target here, which keeps
    // their link-time pixel shaders valid for this pass (see mrtSplit.ts).
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
    this.cam.layers.set(LAYER_REFLECT);
    REFL.uRefl.value = this.rt.textures[0];
    REFL.uReflOn.value = 1;
  }

  setSize(w: number, h: number): void {
    this.rt.setSize(w, h);
  }

  /** Refresh every `every` frames; the texture keeps the projection it was rendered with. */
  every = 2;
  private tick = 0;

  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, planeY: number): boolean {
    if (this.tick++ % this.every !== 0) return false;
    const n = this.normal;
    const mirror = new THREE.Vector3(0, planeY, 0);
    mirror.x = camera.position.x;
    mirror.z = camera.position.z;
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const view = new THREE.Vector3().subVectors(mirror, camPos);
    if (view.dot(n) > 0) return false;
    view.reflect(n).negate().add(mirror);
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(camPos);
    const target = new THREE.Vector3().subVectors(mirror, look).reflect(n).negate().add(mirror);
    const vc = this.cam;
    vc.position.copy(view);
    vc.up.set(0, 1, 0).applyMatrix4(rot).reflect(n);
    vc.lookAt(target);
    vc.far = camera.far;
    vc.near = camera.near;
    vc.updateMatrixWorld();
    vc.projectionMatrix.copy(camera.projectionMatrix);

    this.tex.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.tex.multiply(vc.projectionMatrix).multiply(vc.matrixWorldInverse);
    REFL.uReflMat.value.copy(this.tex);
    REFL.uReflY.value = planeY;

    // Oblique clip plane: drop everything below the water surface.
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, mirror);
    plane.applyMatrix4(vc.matrixWorldInverse);
    const clip = new THREE.Vector4(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = vc.projectionMatrix.elements;
    const q = new THREE.Vector4(
      (Math.sign(clip.x) + pm[8]) / pm[0],
      (Math.sign(clip.y) + pm[9]) / pm[5],
      -1,
      (1 + pm[10]) / pm[14],
    );
    clip.multiplyScalar(2 / clip.dot(q));
    pm[2] = clip.x;
    pm[6] = clip.y;
    pm[10] = clip.z + 1 - 0.003;
    pm[14] = clip.w;
    vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();

    renderer.setRenderTarget(this.rt);
    // Alpha 0 marks texels where nothing was drawn (below the mirrored horizon); the water fills
    // them with sky instead of black.
    const alpha = renderer.getClearAlpha();
    renderer.setClearAlpha(0);
    renderer.clear();
    renderer.setClearAlpha(alpha);
    G.uNoFringe.value = 1;
    renderer.render(scene, vc);
    G.uNoFringe.value = 0;
    renderer.setRenderTarget(null);
    return true;
  }
}
