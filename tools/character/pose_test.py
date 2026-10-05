"""Extreme-pose deformation test (run after build.py in the same Blender session).

  import runpy; runpy.run_path(r"C:\\Code\\bay-ride\\tools\\character\\pose_test.py", run_name="__main__")

Poses the rig far past the clips (arms overhead, deep squat, wrist/spine/head twist, high side
kick with a folded elbow), then for every skinned mesh compares the deformed edges and faces with
rest: the edge-length ratio range (stretch / collapse) and the share of faces whose normal turned
more than 120 degrees (crumpling, candy-wrapping). Workbench stills go to shots/posetest/.
Leaves the armature back in its rest pose.
"""
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _turn(arm, name, axis, deg, about_own=False):
    pb = arm.pose.bones[name]
    M = pb.matrix.copy()
    ax = Vector(M.col[1][:3]).normalized() if about_own else Vector(axis)
    h = M.translation.copy()
    R = Matrix.Translation(h) @ Matrix.Rotation(math.radians(deg), 4, ax) @ Matrix.Translation(-h)
    pb.matrix = R @ M
    bpy.context.view_layer.update()


POSES = {
    "reach": [("upperarm_L", (0, 1, 0), -150), ("upperarm_R", (0, 1, 0), 150), ("head", (1, 0, 0), 25)],
    "squat": [("thigh_L", (1, 0, 0), -105), ("thigh_R", (1, 0, 0), -105),
              ("shin_L", (1, 0, 0), 125), ("shin_R", (1, 0, 0), 125), ("spine", (1, 0, 0), -25)],
    "twist": [("spine1", (0, 0, 1), 20), ("spine2", (0, 0, 1), 20), ("neck", (0, 0, 1), 20), ("head", (0, 0, 1), 45),
              ("forearmTwist_R", None, 80), ("hand_R", None, 80), ("hand_L", (1, 0, 0), 60)],
    "kick": [("thigh_L", (0, 1, 0), -70), ("shin_L", (1, 0, 0), 40),
             ("upperarm_R", (1, 0, 0), -90), ("forearm_R", (1, 0, 0), -140)],
    # The ranges the clips actually use, with margin (jump arms, run arm swing, sit, stride).
    "reach_mod": [("upperarm_L", (0, 1, 0), -95), ("upperarm_R", (1, 0, 0), -100)],
    "kick_mod": [("thigh_L", (0, 1, 0), -40), ("thigh_R", (1, 0, 0), 45), ("shin_R", (1, 0, 0), 60)],
}


CLOSE = {  # close-ups of the stressed joints: target, yaw, ortho scale
    "reach": [((0.0, 0.0, 1.38), 20, 0.62)],
    "squat": [((0.0, -0.15, 0.80), 40, 0.75)],
    "twist": [((-0.30, -0.05, 0.95), -60, 0.45), ((0.0, 0.0, 1.30), 0, 0.6)],
    "kick": [((0.12, 0.0, 0.82), 0, 0.7), ((-0.2, -0.2, 1.25), -70, 0.55)],
    "reach_mod": [((0.0, 0.0, 1.35), 20, 0.7)],
    "kick_mod": [((0.0, -0.05, 0.80), 25, 0.7)],
}


def _edge_faces(T):
    """Pairs of triangles sharing an edge."""
    from collections import defaultdict
    m = defaultdict(list)
    for fi, (a, b, c) in enumerate(T):
        for u, v in ((a, b), (b, c), (c, a)):
            m[(min(u, v), max(u, v))].append(fi)
    pairs = [f for f in m.values() if len(f) == 2]
    return np.array(pairs, dtype=np.int64).reshape(-1, 2)


def _mesh_state(ob, dg):
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    co = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    return co.reshape(-1, 3)


def _topo(ob):
    me = ob.data
    e = np.empty(len(me.edges) * 2, dtype=np.int64)
    me.edges.foreach_get("vertices", e)
    me.calc_loop_triangles()
    t = np.empty(len(me.loop_triangles) * 3, dtype=np.int64)
    me.loop_triangles.foreach_get("vertices", t)
    return e.reshape(-1, 2), t.reshape(-1, 3)


def _fn(P, T):
    n = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def run(render=True):
    from heroine import preview
    arm = bpy.data.objects["heroine"]
    col = bpy.data.collections["Heroine"]
    meshes = [o for o in col.all_objects if o.type == "MESH" and any(m.type == "ARMATURE" for m in o.modifiers)]
    ad = arm.animation_data
    keep = ad.action if ad else None
    if ad:
        ad.action = None
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    rest = {o.name: _mesh_state(o, dg) for o in meshes}
    topo = {o.name: _topo(o) for o in meshes}
    adj = {o.name: _edge_faces(topo[o.name][1]) for o in meshes}
    report = {}
    out_dir = os.path.join(REPO, "shots", "posetest")
    for pose, turns in POSES.items():
        for pb in arm.pose.bones:
            pb.matrix_basis = Matrix()
        bpy.context.view_layer.update()
        for name, axis, deg in turns:
            _turn(arm, name, axis, deg, about_own=axis is None)
        dg = bpy.context.evaluated_depsgraph_get()
        res = {}
        for o in meshes:
            P0, P1 = rest[o.name], _mesh_state(o, dg)
            E, T = topo[o.name]
            l0 = np.linalg.norm(P0[E[:, 0]] - P0[E[:, 1]], axis=1)
            l1 = np.linalg.norm(P1[E[:, 0]] - P1[E[:, 1]], axis=1)
            ok = l0 > 1e-6
            r = l1[ok] / l0[ok]
            moved = np.linalg.norm(P1 - P0, axis=1).max() > 1e-4
            if not moved:
                continue
            # Folds: neighbouring triangles that were nearly coplanar at rest and now face
            # apart by > 100 degrees (rigid motion leaves this unchanged).
            A = adj[o.name]
            fold = 0.0
            if len(A):
                n0, n1 = _fn(P0, T), _fn(P1, T)
                d0 = np.einsum("ij,ij->i", n0[A[:, 0]], n0[A[:, 1]])
                d1 = np.einsum("ij,ij->i", n1[A[:, 0]], n1[A[:, 1]])
                smooth0 = d0 > 0.7
                fold = float(((d1 < -0.17) & smooth0).sum() / max(1, smooth0.sum()))
            # Rigid motion keeps ratios at 1; report the tails.
            res[o.name] = {"edge_ratio_p001": round(float(np.percentile(r, 0.1)), 3),
                           "edge_ratio_p999": round(float(np.percentile(r, 99.9)), 3),
                           "folded_edges_pct": round(fold * 100, 2)}
        report[pose] = res
        if render:
            for yaw in (0, 35):
                preview.shoot(os.path.join(out_dir, f"{pose}_{yaw}.png"), (0, 0, 0.95), 4.0, yaw, 5, ortho=2.3, res=(700, 900))
            for k, (tgt, yaw, orth) in enumerate(CLOSE.get(pose, [])):
                preview.shoot(os.path.join(out_dir, f"{pose}_close{k}.png"), tgt, 3.0, yaw, 5, ortho=orth, res=(700, 700))
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    if ad:
        ad.action = keep
    bpy.context.view_layer.update()
    with open(os.path.join(HERE, "pose_report.json"), "w") as fh:
        json.dump(report, fh, indent=1)
    for pose, res in report.items():
        worst = sorted(res.items(), key=lambda kv: -max(kv[1]["folded_edges_pct"] * 10, abs(np.log(max(kv[1]["edge_ratio_p001"], 1e-3))), abs(np.log(kv[1]["edge_ratio_p999"]))))[:5]
        print(pose, json.dumps(dict(worst)))
    return report


if __name__ == "__main__":
    run()
