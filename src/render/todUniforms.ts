import * as THREE from "three";

/**
 * Time-of-day uniforms shared by every scene material (spread into `G`); `world/timeofday.ts`
 * drives them from its presets.
 */
const raw = (r: number, g: number, b: number) => new THREE.Color(r, g, b);

export const TOD = {
  /** Where the sun really is (sky glow, disk, clouds, glint). `uSunDir` is the shading light. */
  uSkySun: { value: new THREE.Vector3(-0.55, 0.42, 0.72).normalize() },
  uSunGlow: { value: raw(1.0, 0.8, 0.5) },
  uSunGlowAmt: { value: new THREE.Vector2(0.16, 0.3) },
  uHaze: { value: raw(0.86, 0.84, 0.72) },
  uHazeAmt: { value: 0.45 },
  /** Wide warm band along the horizon toward the sun: x = amount, y = vertical falloff. */
  uHorizGlow: { value: raw(1.0, 0.6, 0.4) },
  uHorizGlowK: { value: new THREE.Vector2(0, 6) },
  uCloudTop: { value: raw(1.0, 0.955, 0.871) },
  uCloudMid: { value: raw(0.791, 0.799, 0.863) },
  uCloudLow: { value: raw(0.392, 0.423, 0.597) },
  uCloudRim: { value: raw(1.0, 0.96, 0.86) },
  /** x = rim mix, y = backlit silver-lining strength, z = warm underside amount. */
  uCloudK: { value: new THREE.Vector3(0.5, 0, 0) },
  uCloudUnder: { value: raw(1.0, 0.6, 0.4) },
  uWisp: { value: raw(0.95, 0.96, 0.98) },
  /** Sun disk colour × intensity (HDR, blooms); 0 = no disk. */
  uSunDisk: { value: raw(0, 0, 0) },
  uStars: { value: 0 },
  /** 0 day … 1 night: lamps, lanterns, windows, signs glow; fireflies appear. */
  uNight: { value: 0 },
  /** Overall light on lit geometry (not sky/clouds) and on the painted distant mountains. */
  uWorldTint: { value: raw(1, 1, 1) },
  uFarTint: { value: raw(1, 1, 1) },
  uFarHaze: { value: 0 },
  /** Glitter strength on the water (sun or moon path). */
  uGlint: { value: 0 },
  /** Light the glitter path follows (the sun by day, the moon at night) and its colour. */
  uGlintDir: { value: new THREE.Vector3(-0.55, 0.42, 0.72).normalize() },
  uGlintCol: { value: raw(1, 0.95, 0.85) },
  /** Painted moon: direction and disk colour × intensity (0 = hidden). */
  uMoonDir: { value: new THREE.Vector3(0.3, 0.5, -0.8).normalize() },
  uMoonCol: { value: raw(0, 0, 0) },
  /** Water look per time of day: shallow / deep body colour and the tint of reflections. */
  uWaterShallow: { value: raw(0.2, 0.62, 0.58) },
  uWaterDeep: { value: raw(0.02, 0.12, 0.3) },
  uWaterRefl: { value: raw(1, 1, 1) },
  /** 0…1 lighthouse lamp + beam. */
  uBeam: { value: 0 },
  /** Lighthouse lamp centre (world) and the beam's current heading (unit xz). */
  uLampPos: { value: new THREE.Vector3(-197, 16, -22) },
  uBeamDir: { value: new THREE.Vector2(1, 0) },
  /** Cirrus wisp opacity (calm and dim at night). */
  uWispAmt: { value: 0.5 },
  /** Light the clouds are shaded by (the sun by day, the moon at night) and how much of it reaches them. */
  uCloudLight: { value: new THREE.Vector3(-0.55, 0.42, 0.72).normalize() },
  /** Sun glitter path: x = water slope spread (path width), y = broad sheen amount. */
  uGlintShape: { value: new THREE.Vector2(0.12, 0.2) },
};

export const TOD_GLSL = /* glsl */ `
uniform vec3 uSkySun;
uniform vec3 uSunGlow;
uniform vec2 uSunGlowAmt;
uniform vec3 uHaze;
uniform float uHazeAmt;
uniform vec3 uHorizGlow;
uniform vec2 uHorizGlowK;
uniform vec3 uCloudTop;
uniform vec3 uCloudMid;
uniform vec3 uCloudLow;
uniform vec3 uCloudRim;
uniform vec3 uCloudK;
uniform vec3 uCloudUnder;
uniform vec3 uWisp;
uniform vec3 uSunDisk;
uniform float uStars;
uniform float uNight;
uniform vec3 uWorldTint;
uniform vec3 uFarTint;
uniform float uFarHaze;
uniform float uGlint;
uniform vec3 uGlintDir;
uniform vec3 uGlintCol;
uniform vec3 uMoonDir;
uniform vec3 uMoonCol;
uniform vec3 uWaterShallow;
uniform vec3 uWaterDeep;
uniform vec3 uWaterRefl;
uniform float uBeam;
uniform vec3 uLampPos;
uniform vec2 uBeamDir;
uniform float uWispAmt;
uniform vec3 uCloudLight;
uniform vec2 uGlintShape;
// Emission added after lighting (not tinted by uWorldTint), set by lamp/window/lantern surfaces.
vec3 gEmit = vec3(0.0);
`;

/** Grade-pass uniforms (post.ts): exposure/tint multiplier and saturation. */
export const TOD_GRADE = {
  uGradeMul: { value: raw(1, 1, 1) },
  uSat: { value: 1.05 },
};
