"""glTF export of the Heroine collection (meshes skinned to the armature, every clip as its own
animation, custom attributes and extras on)."""
import json
import os

import bpy

from .common import COLL, scene


def export(path, meta=None):
    sc = scene()
    col = bpy.data.collections[COLL]
    arm = next(o for o in col.all_objects if o.type == "ARMATURE")
    if meta is not None:
        # The face layout, foot contacts and material roles travel in the armature's extras.
        arm["heroine"] = json.dumps(meta)
    vl = bpy.context.view_layer
    for o in vl.objects:
        o.select_set(False)
    for o in col.all_objects:
        if o.name in vl.objects:
            o.select_set(True)
    vl.objects.active = arm
    os.makedirs(os.path.dirname(path), exist_ok=True)
    gl = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    opts = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        # Only the Heroine scene: other scenes in a live session (and their selections) stay out.
        use_active_scene=True,
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="NONE",
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_attributes=True,
        export_extras=True,
        export_skins=True,
        export_def_bones=False,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_force_sampling=True,
        export_frame_step=1,
        export_optimize_animation_size=True,
        export_anim_slide_to_zero=True,
        export_rest_position_armature=True,
        export_morph=False,
        export_leaf_bone=False,
        export_lights=False,
        export_cameras=False,
    )
    import contextlib
    import io
    log = io.StringIO()
    with contextlib.redirect_stdout(log):
        bpy.ops.export_scene.gltf(**{k: v for k, v in opts.items() if k in gl or k == "filepath"})
    errs = [ln for ln in log.getvalue().splitlines() if "ERROR" in ln or "WARNING" in ln]
    for ln in errs[:20]:
        print("[export]", ln)
    return os.path.getsize(path)
