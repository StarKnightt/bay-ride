"""Quick Blender stills for checking shapes while building (not the approval renders: those are
made in the game's own renderer by scripts/charlab.mjs). Workbench, orthographic, outlines on."""
import math
import os

import bpy
import numpy as np

from .common import collection, scene

PREV = "HeroinePreview"


def _cam(name, loc, rot, ortho=None, lens=50):
    col = collection(PREV)
    cam = bpy.data.objects.get(name)
    if cam is None:
        cd = bpy.data.cameras.new(name)
        cam = bpy.data.objects.new(name, cd)
        col.objects.link(cam)
    cam.location = loc
    cam.rotation_euler = rot
    if ortho:
        cam.data.type = "ORTHO"
        cam.data.ortho_scale = ortho
    else:
        cam.data.type = "PERSP"
        cam.data.lens = lens
    cam.data.clip_start = 0.01
    return cam


def setup(res=(900, 900)):
    sc = scene()
    sc.render.engine = "BLENDER_WORKBENCH"
    sh = sc.display.shading
    sh.light = "STUDIO"
    sh.color_type = "VERTEX"
    sh.show_object_outline = True
    sh.object_outline_color = (0.1, 0.06, 0.05)
    sh.show_cavity = False
    sh.show_shadows = False
    sh.show_specular_highlight = False
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = False
    sc.world = sc.world or bpy.data.worlds.new("HeroineWorld")
    sc.display.shading.background_type = "VIEWPORT"
    try:
        sc.display.shading.background_color = (0.85, 0.83, 0.8)
    except Exception:
        pass
    sc.render.image_settings.file_format = "PNG"
    return sc


def shoot(path, target, dist, yaw_deg, pitch_deg=0.0, ortho=None, lens=85, res=(900, 900), mask=False):
    """Render a still looking at target from yaw (0 = her front) at distance (mask: flat white
    on black, for silhouette checks)."""
    sc = setup(res)
    if mask:
        sh = sc.display.shading
        sh.light, sh.color_type, sh.single_color, sh.show_object_outline = "FLAT", "SINGLE", (1, 1, 1), False
        sh.background_color = (0, 0, 0)
    t = np.asarray(target, float)
    yaw, pit = math.radians(yaw_deg), math.radians(pitch_deg)
    # yaw 0: camera in front of her (-Y), looking +Y.
    d = np.array([math.sin(yaw) * math.cos(pit), -math.cos(yaw) * math.cos(pit), math.sin(pit)])
    loc = t + d * dist
    fwd = -d
    rx = math.atan2(math.hypot(fwd[0], fwd[1]), -fwd[2])
    rz = math.atan2(fwd[0], -fwd[1]) + math.pi if False else math.atan2(-fwd[0], fwd[1])
    cam = _cam("PrevCam", loc, (rx, 0, rz), ortho, lens)
    sc.camera = cam
    sc.render.filepath = path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.render.render(write_still=True, scene=sc.name)
    return path
