"""Numeric motion-state checks for the heroine's clips (run after build.py, same Blender session).

Inside the running Blender:
  import runpy; runpy.run_path(r"C:\\Code\\bay-ride\\tools\\character\\inspect_motion.py", run_name="__main__")
Headless:
  blender --background --factory-startup --python tools/character/build.py -- --no-export
          --python tools/character/inspect_motion.py
Writes tools/character/motion_report.json and prints a summary.

Per frame and per foot it evaluates the skinned sandal soles and reads:
  - the lowest sole vertex height (ground penetration if < 0, airborne if > a few mm),
  - slip: for sole vertices on the ground (z < 3 mm) in two consecutive frames, how far they moved
    against the in-place treadmill (the ground runs backward at the clip speed: +Y in Blender),
  - the ankle bone height, the hips facing (yaw of the hips' forward vector) and leg crossover.
sit_tiller also reports the right hand's distance to the tiller grip and the hips height.
"""
import json
import os

import bpy
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 30
GROUND = 0.003


def _sole_world(ob, dg):
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    n = len(me.vertices)
    co = np.empty(n * 3)
    me.vertices.foreach_get("co", co)
    ev.to_mesh_clear()
    M = np.array(ob.matrix_world)
    P = co.reshape(-1, 3) @ M[:3, :3].T + M[:3, 3]
    return P


def run():
    arm = bpy.data.objects["heroine"]
    meta = json.loads(arm["heroine"])["clips"]
    soles = {s: bpy.data.objects["sandal_sole_" + s] for s in "LR"}
    scene = bpy.context.scene
    ad = arm.animation_data
    report = {}
    for name in ("idle", "walk", "run", "sit_tiller", "jump"):
        act = bpy.data.actions[name]
        ad.action = act
        if act.slots:
            ad.action_slot = act.slots[0]
        f0, f1 = (int(x) for x in act.frame_range)
        clip = meta[name]
        v = clip.get("speed", 0.0)
        rows, prev = [], {}
        slip_max = {"L": 0.0, "R": 0.0}
        slip_sum = {"L": 0.0, "R": 0.0}
        slip_n = {"L": 0, "R": 0}
        for f in range(f0, f1 + 1):
            scene.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get()
            t = (f - f0) / FPS
            row = {"f": f, "t": round(t, 3)}
            for s in "LR":
                P = _sole_world(soles[s], dg)
                row["min_z_" + s] = round(float(P[:, 2].min()), 4)
                g = P[:, 2] < GROUND
                row["grounded_" + s] = int(g.sum())
                if s in prev:
                    both = g & prev[s][1]
                    if both.sum() >= 3:
                        d = P[both] - prev[s][0][both]
                        # Treadmill: a planted point should move +Y by v / FPS each frame.
                        d[:, 1] -= v / FPS
                        sl = float(np.linalg.norm(d[:, :2], axis=1).mean())
                        row["slip_" + s] = round(sl * 1000, 2)   # mm per frame
                        slip_max[s] = max(slip_max[s], sl)
                        slip_sum[s] += sl
                        slip_n[s] += 1
                prev[s] = (P, g)
            pb = arm.pose.bones
            M = arm.matrix_world
            hips = pb["hips"]
            fwd = (M.to_3x3() @ hips.matrix.to_3x3()).col[2]   # bone Z axis points forward (-Y at rest)
            row["hips_yaw_deg"] = round(float(np.degrees(np.arctan2(fwd.x, -fwd.y))), 1)
            row["hips_z"] = round(float((M @ hips.head).z), 4)
            aL, aR = (M @ pb["foot_L"].head), (M @ pb["foot_R"].head)
            row["ankle_z_L"], row["ankle_z_R"] = round(aL.z, 4), round(aR.z, 4)
            row["ankle_dx"] = round(aL.x - aR.x, 4)   # > 0: no crossover (her left is +X)
            if name == "sit_tiller":
                gx, gy, gz = clip["grip"]
                grip = np.array([gx, -gz, gy])      # glTF (x, y up, z) -> Blender
                # anim.sit_pose aims the wrist 4.5 cm behind and 2.8 cm above the grip (the grip
                # sits in the palm); report both the wrist error and the knuckles-to-grip distance.
                wrist_t = grip + np.array([0.005, 0.045, 0.028])
                row["wrist_err"] = round(float(np.linalg.norm(np.array(M @ pb["hand_R"].head) - wrist_t)), 4)
                row["grip_dist"] = round(float(np.linalg.norm(np.array(M @ pb["hand_R"].tail) - grip)), 4)
            rows.append(row)
        ad.action = None
        summ = {
            "frames": f1 - f0 + 1,
            "speed": v,
            "min_sole_z": round(min(min(r["min_z_L"], r["min_z_R"]) for r in rows), 4),
            "slip_max_mm_per_frame": {s: round(slip_max[s] * 1000, 2) for s in "LR"},
            "slip_mean_mm_per_frame": {s: round(slip_sum[s] / max(1, slip_n[s]) * 1000, 2) for s in "LR"},
            "planted_frame_pairs": slip_n,
            "hips_yaw_range_deg": [min(r["hips_yaw_deg"] for r in rows), max(r["hips_yaw_deg"] for r in rows)],
            "min_ankle_dx": min(r["ankle_dx"] for r in rows),
        }
        if name == "sit_tiller":
            summ["grip_dist_max"] = max(r["grip_dist"] for r in rows)
            summ["wrist_err_max"] = max(r["wrist_err"] for r in rows)
            summ["hips_z_range"] = [min(r["hips_z"] for r in rows), max(r["hips_z"] for r in rows)]
        report[name] = {"summary": summ, "frames": rows}
    out = os.path.join(HERE, "motion_report.json")
    with open(out, "w") as fh:
        json.dump(report, fh, indent=1)
    for k, r in report.items():
        print(k, json.dumps(r["summary"]))
    return report


if __name__ == "__main__":
    run()
