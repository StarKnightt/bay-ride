# Heroine character

The heroine is built entirely by script in Blender 5.1. There are no downloaded models, textures or HDRIs. The only references are `refs/character/concept_sheet.jpg` and `refs/character/face_sheet.jpg`.

## Rebuild

```
E:\blender\blender-5.1.2-windows-x64\blender.exe --background --factory-startup --python tools/character/build.py -- --out public/models/heroine.glb
```

The build lowers its own process priority to below normal. It is deterministic: a headless run and a run inside a live Blender session give byte-identical GLBs. Pass `--no-export` to build the scene without writing a file.

In a live Blender session, the build happens in a scene called `Heroine` and leaves every other scene untouched:

```python
sys.argv = ['blender', '--', '--out', r'...\public\models\heroine.glb']
runpy.run_path(r'...\tools\character\build.py', run_name='__main__')
```

### Modules in `heroine/`

| Module | Builds |
|---|---|
| `head.py` | Head, ears, face layout |
| `body.py` | Body and hands |
| `hair.py` | Clumped locks, cap and wind bones |
| `outfit.py` | Garments, sandals, hat, glasses |
| `rig.py` | Skeleton |
| `anim.py` | Clips |
| `preview.py` | Blender previews |

## Asset

- `public/models/heroine.glb` is about 1.99 MB and uncompressed. It is left uncompressed on purpose: the game has no Draco or Meshopt decoder.
- 46 meshes, 38,961 triangles, 82 bones.
- Vertex colours plus 15 named materials. The lab and the game assign toon shaders by material name: `cami`, `collar`, `face`, `frame`, `hair`, `knot`, `ribbon`, `sandal`, `shirt`, `shorts`, `shorts_leg`, `skin`, `sleeve`, `straw`, `tail`.
- Units are metres. She stands 1.64 m tall at the skull and 1.68 m at the top of her hair, with the chin at 1.44 m. Measured to the top of the hair she is 7.0 heads tall; measured to the bare skull she is 8.1. The hat crown is at 1.73 m.
- In glTF she faces +Z. Rotate her by π to face −Z.
- The face is painted in the shader (`src/lab/heroineFace.ts`) from `extras.heroine.face` on the armature: eye, brow, nose, mouth, blush, jaw and lens parameters in head-local metres.
- `extras.heroine` also carries the clip metadata below and `sole` (0.012 m, the sandal sole thickness).

## Bones (82)

| Group | Bones |
|---|---|
| Core | `root` `hips` `spine` `spine1` `spine2` `neck` `head` |
| Hat | `hat`; `ribbon_L1..3` and `ribbon_R1..3` (ribbon tails, for wind) |
| Hair wind chains (3 bones each) | `hairFringe_1..3`, `hairSideL_`, `hairSideR_`, `hairEarL_`, `hairEarR_`, `hairBackL_`, `hairBack_`, `hairBackR_` |
| Arms (per side `_L` / `_R`) | `shoulder` `upperarm` `forearm` `forearmTwist` `hand` |
| Fingers (per side) | `index1-2` `middle1-2` `ring1-2` `pinky1-2` `thumb1-3` |
| Shirt knot tails | `knot_L1-2` `knot_R1-2` |
| Legs (per side) | `thigh` `shin` `foot` `toe` |

Garment, hair and cloth weights are smoothed per mesh. The shorts' cuff rings only take weights from their own side. The sandal soles follow only `foot` and `toe`.

## Clips (30 fps)

The walk and run play in place. Move the root at `speed` to match the planted feet. Contact windows are given in seconds; a window that wraps past the loop end continues from 0.

| Clip | Duration | Loop | Speed | Contacts and events |
|---|---|---|---|---|
| `idle` | 4.0 s | yes | 0 | Both feet planted; relaxed contrapposto and breathing; hair and ribbons sway. |
| `walk` | 1.1 s | yes | 1.30 m/s | Stride 1.43 m. Left heel strike 0.000, left toe-off 0.682. Right heel strike 0.550, right toe-off 0.132. Duty 0.62. |
| `run` | 0.66 s | yes | 3.40 m/s | Stride 2.24 m. Left foot strike 0.000, left toe-off 0.238. Right foot strike 0.330, right toe-off 0.568. Duty 0.36; there is a flight phase. |
| `sit_tiller` | 4.0 s | yes | 0 | Seat height 0.29 m. Right hand on the tiller grip at (−0.30, 0.68, 0.14), in Blender coordinates relative to `root`. She sits on the port side and faces forward. |
| `jump` | 1.2 s | no | 0 | Crouch, take-off at 0.40 s, airborne, touch-down at 0.85 s, landing absorb. |

## Checks

Each script below writes its results to a JSON report in this folder. Run the scripts from inside Blender, using either a headless build or the MCP session.

### Foot contact: `inspect_motion.py` → `motion_report.json`

This check measures the skinned sandal-sole vertices on every frame.

| Clip | Lowest sole (mm) | Max slip (mm/frame) | Mean slip (mm/frame) | Min ankle gap (m) | Other |
|---|---|---|---|---|---|
| idle | −0.1 | 0.00 | 0.00 | 0.192 | |
| walk | −1.0 | 0.43 / 0.47 | 0.11 / 0.12 | 0.178 | Hips yaw ±4.5° |
| run | −0.4 | 0.78 / 0.58 | 0.26 / 0.22 | 0.142 | Hips yaw ±8° |
| sit_tiller | 0.0 | 0.00 | 0.00 | 0.276 | Hips z fixed at 0.436 m; wrist error 0.0 mm |
| jump | −0.1 | 0.65 | 0.07 | 0.202 | |

- Slip is measured on planted vertices, after removing the treadmill speed. Where two values appear, they are the left and right foot.
- A positive minimum ankle gap means the legs never cross.

### Deformation: `pose_test.py` → `pose_report.json`, `shots/posetest/`

This check applies six extreme poses and measures each mesh.

- **Edge stretch:** at the moderate limits (arms raised 95–100°, a 40–45° side kick), the edge-length ratio at p99.9 stays at or below 4.3× on the sleeves and 6.8× on the inner shorts.
- **Folded faces:** at most 0.8% of edges fold over.
- **Skin:** the body skin stays below 2×.
- **Known limits of linear skinning:**
  - Arms raised fully overhead (150°) stretch the sleeves from the shoulder (5.1×).
  - A 70° side kick creases the inner shorts leg (8.4×).
  - None of the clips reaches either pose.

### Silhouette: `silhouette.py` → `silhouette_report.json`, `shots/silhouette/overlay.png`

This check compares the idle front view, rendered orthographically, against the front figure on the concept sheet.

- **Overlap (IoU):** 0.68, even though the poses differ: the concept has her hands in her pockets and her feet apart.
- **Band widths** (fraction of figure height, concept vs model):

  | Band | Concept | Model |
  |---|---|---|
  | Hat brim | 0.146 | 0.146 |
  | Waist | 0.269 | 0.279 |
  | Shorts hem | 0.240 | 0.229 |

- The head and shoulder bands read wider on the model. The ribbon tails hang into the head band, and the idle arms hang slightly away from the body.

Run `python tools/character/silhouette.py --compare` with system Python after rendering the mask.

## Lab

- **Viewer:** `character-lab.html` with `src/lab/*`.
- **Captures:** `node scripts/charlab.mjs [--out=shots/heroine] [--only=front_noon,...]` takes headless 1920×1080 captures with the game's toon shading, then tears down its own server and browser.
