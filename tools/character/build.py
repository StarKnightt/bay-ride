"""Build the heroine and export her as a GLB.

Headless (what the repo expects; below-normal priority):
  E:\\blender\\blender-5.1.2-windows-x64\\blender.exe --background --factory-startup \\
      --python tools/character/build.py -- --out public/models/heroine.glb
Inside a running Blender (it builds into its own "Heroine" scene and leaves other scenes alone):
  import runpy; runpy.run_path(r"C:\\Code\\bay-ride\\tools\\character\\build.py", run_name="__main__")
Options after "--": --out <glb> (default public/models/heroine.glb), --no-export, --stage <name>
(stop after head|body|hair|outfit|rig|anim).
"""
import importlib
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = os.path.join(REPO, "public", "models", "heroine.glb")
    stage, export = None, True
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--out":
            out = os.path.abspath(argv[i + 1])
            i += 1
        elif a == "--no-export":
            export = False
        elif a == "--stage":
            stage = argv[i + 1]
            i += 1
        i += 1
    return out, stage, export


def _lower_priority():
    """Long CPU work runs below normal priority (the user's rule for headless runs)."""
    try:
        import bpy
        if not bpy.app.background:
            return
        if os.name == "nt":
            import ctypes
            ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
        else:
            os.nice(10)
    except Exception as e:  # pragma: no cover
        print("[build] could not lower priority:", e)


def main(out=None, stage=None, export=True):
    import heroine
    from heroine import common, shape, head, body, hair, outfit, rig, anim, export as ex
    for m in (common, shape, head, body, hair, outfit, rig, anim, ex):
        importlib.reload(m)
    t0 = time.time()
    common.scene()
    col = common.collection()
    common.clear_collection()
    rig.EXTRA.clear()
    parts = {}
    parts.update(head.build(col))
    if stage != "head":
        parts.update(body.build(col))
    if stage not in ("head", "body"):
        parts.update(hair.build(col))
    if stage not in ("head", "body", "hair"):
        parts.update(outfit.build(col))
        body.cull_hidden(col)
    arm = rig.build_armature()
    body.skin_all(col, arm)
    # She stands on her sandal soles: lift every mesh and bone (not the root) by the sole, so the
    # walker origin (root, y = 0) is the ground under them.
    rig.lift(col, arm, body.SOLE)
    face = head.face_layout_gltf()
    face["headC"][1] += body.SOLE
    meta = {"face": face, "materials": common.material_roles(col), "sole": body.SOLE}
    if stage not in ("head", "body", "hair", "outfit", "rig"):
        meta["clips"] = anim.build(arm)
    arm["heroine"] = json.dumps(meta)
    tris = sum(common.tri_count(o) for o in col.all_objects if o.type == "MESH")
    print(f"[build] {len([o for o in col.all_objects if o.type == 'MESH'])} meshes, {tris} triangles, "
          f"{len(arm.data.bones)} bones, {time.time() - t0:.1f}s")
    if export:
        out = out or os.path.join(REPO, "public", "models", "heroine.glb")
        n = ex.export(out, meta)
        print(f"[build] wrote {out} ({n / 1024:.0f} KiB)")
    return parts


if __name__ == "__main__":
    o, st, e = _args()
    _lower_priority()
    main(o, st, e)
