"""Her animation clips, generated: idle, walk, run, sit_tiller, jump (30 fps).

Legs are solved with analytic two-bone IK against explicit foot kinematics: in stance the planted
contact (the heel, then the whole foot, then the ball while the heel lifts and the toes stay flat)
moves backward at exactly the clip's speed, so the game can lock the feet and sync the stride with
playback rate = speed / clip speed and nothing slides. The pelvis drops wherever a planted foot
would otherwise be out of reach (no knee ever locks past 99.6% of the leg). Arms swing in FK; on the
tiller the right arm is IK to the grip. Hair, ribbon and shirt-tail chains get lagged secondary
motion. Contact timings are returned for the GLB extras.
"""
import math

import bpy
import numpy as np
from mathutils import Matrix

from . import shape
from .common import norm, smooth

FPS = 30
DEG = math.pi / 180
S = shape


def rot(axis, deg):
    a = np.asarray(axis, float)
    a = a / np.linalg.norm(a)
    t = deg * DEG
    c, s = math.cos(t), math.sin(t)
    x, y, z = a
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


X, Y, Z = np.eye(3)
FWD = np.array([0, -1.0, 0])


class FK:
    """Forward kinematics on the armature's rest matrices (Blender's pose composition)."""

    def __init__(self, arm):
        bones = arm.data.bones
        self.rest = {b.name: np.array(b.matrix_local, dtype=float) for b in bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in bones}
        self.length = {b.name: b.length for b in bones}
        order, seen = [], set()

        def visit(n):
            if n in seen:
                return
            if self.parent[n]:
                visit(self.parent[n])
            seen.add(n)
            order.append(n)

        for b in bones:
            visit(b.name)
        self.order = order
        self.inv = {n: np.linalg.inv(m) for n, m in self.rest.items()}

    def solve(self, delta=None, absr=None, local=None, loc=None):
        delta, absr, local, loc = delta or {}, absr or {}, local or {}, loc or {}
        pose, basis = {}, {}
        for n in self.order:
            Rr = self.rest[n]
            p = self.parent[n]
            M0 = pose[p] @ self.inv[p] @ Rr if p else Rr.copy()
            R0 = M0[:3, :3]
            if n in absr:
                Rp = absr[n]
            elif n in delta:
                Pchg = pose[p][:3, :3] @ self.rest[p][:3, :3].T if p else np.eye(3)
                Rp = Pchg @ delta[n] @ Rr[:3, :3]
            else:
                Rp = R0
            if n in local:
                Rp = Rp @ local[n]
            t = R0.T @ np.asarray(loc[n], float) if n in loc else np.zeros(3)
            M = np.eye(4)
            M[:3, :3] = Rp
            M[:3, 3] = M0[:3, 3] + R0 @ t
            pose[n] = M
            basis[n] = (t, R0.T @ Rp)
        return pose, basis

    def head_if(self, pose, child):
        """Where `child`'s head is, given its parent's pose (before the child is posed)."""
        p = self.parent[child]
        return (pose[p] @ self.inv[p] @ self.rest[child])[:3, 3]

    def rest_head(self, n):
        return self.rest[n][:3, 3]

    def rest_axes(self, n):
        return self.rest[n][:3, :3]


def frame_from(yaxis, zhint):
    """Bone orientation (columns X, Y, Z) with Y along yaxis and Z as close to zhint as possible."""
    yv = norm(np.asarray(yaxis, float))
    zv = np.asarray(zhint, float)
    zv = norm(zv - yv * (zv @ yv))
    xv = np.cross(yv, zv)
    return np.stack([xv, yv, zv], axis=1)


def two_bone(H, A, L1, L2, pole, reach=0.996):
    d = A - H
    dist = np.linalg.norm(d)
    u = d / max(dist, 1e-9)
    dist = np.clip(dist, abs(L1 - L2) + 1e-4, (L1 + L2) * reach)
    ca = np.clip((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1)
    sa = math.sqrt(1 - ca * ca)
    v = norm(pole - u * (pole @ u))
    K = H + L1 * (ca * u + sa * v)
    return K, H + u * dist


class Body:
    """Rig-specific helpers: leg/arm IK targets and foot rigid-body kinematics."""

    def __init__(self, fk):
        self.fk = fk
        R = fk.rest_head
        self.L = {}
        for sf in ("L", "R"):
            th, sh, ft = f"thigh_{sf}", f"shin_{sf}", f"foot_{sf}"
            self.L[sf] = (np.linalg.norm(R(sh) - R(th)), np.linalg.norm(R(ft) - R(sh)))
        self.arm_L = {}
        for sf in ("L", "R"):
            ua, fa, hd = f"upperarm_{sf}", f"forearm_{sf}", f"hand_{sf}"
            self.arm_L[sf] = (np.linalg.norm(R(fa) - R(ua)), np.linalg.norm(R(hd) - R(fa)))

    def foot_points(self, sf):
        """Rest ankle, heel contact and ball contact (on the floor, z = 0)."""
        A0 = self.fk.rest_head(f"foot_{sf}")
        B = self.fk.rest_head(f"toe_{sf}")
        heel = np.array([A0[0], A0[1] + 0.050, 0.0])
        ball = np.array([B[0], B[1], 0.0])
        return A0, heel, ball

    def foot_pose(self, sf, pivot_kind, pivot_ground, pitch_up, yaw=0.0):
        """Ankle position and foot/toe orientations for a foot pivoting on the ground."""
        A0, heel, ball = self.foot_points(sf)
        Rf = rot(Z, yaw) @ rot(X, -pitch_up)
        # The ball pivot is the toe joint itself (not its floor projection), so the flat toes
        # stay exactly where they are while the heel rises.
        piv0 = heel if pivot_kind == "heel" else self.fk.rest_head(f"toe_{sf}")
        ankle = pivot_ground + np.array([0, 0, piv0[2]]) + Rf @ (A0 - piv0)
        return ankle, Rf

    def leg(self, pose, sf, ankle, Rfoot, Rtoe=None, pole=None):
        """Absolute orientations for thigh, shin, foot (and toe) reaching `ankle`."""
        fk = self.fk
        H = fk.head_if(pose, f"thigh_{sf}")
        L1, L2 = self.L[sf]
        pl = pole if pole is not None else norm(FWD + np.array([0.12 if sf == "L" else -0.12, 0, 0]))
        K, A2 = two_bone(H, ankle, L1, L2, pl)
        out = {
            f"thigh_{sf}": frame_from(K - H, pl),
            f"shin_{sf}": frame_from(A2 - K, pl),
            f"foot_{sf}": Rfoot @ fk.rest_axes(f"foot_{sf}"),
        }
        out[f"toe_{sf}"] = (Rtoe if Rtoe is not None else Rfoot) @ fk.rest_axes(f"toe_{sf}")
        return out, np.linalg.norm(ankle - H) / (L1 + L2)


# ---------------------------------------------------------------- shared posture pieces


def arms_down(s, adduct=17.0, flex=0.0, elbow=12.0, out_twist=0.0):
    """FK deltas for an arm hanging relaxed: adduction toward the body, swing, elbow bend."""
    sf = "L" if s > 0 else "R"
    d = {}
    d[f"upperarm_{sf}"] = rot(X, -flex) @ rot(Y, s * adduct) @ rot(Z, s * out_twist)
    # Elbow hinge: perpendicular to the forearm and her front.
    fa = norm(S.side(S.WRI, s) - S.side(S.ELB, s))
    hinge = norm(np.cross(FWD, fa))              # ~ +X for both arms: -angle swings the hand forward
    d[f"forearm_{sf}"] = rot(hinge, -elbow)
    return d


def hand_relax(s, curl=1.0, thumb=1.0):
    sf = "L" if s > 0 else "R"
    loc = {}
    # A relaxed hand: the curl cascades from the index to the pinky, the fingers fan a little.
    for i, name in enumerate(("index", "middle", "ring", "pinky")):
        c = (22 + 7 * i) * curl
        fan = (-1.5 + 1.2 * i) * s
        loc[f"{name}1_{sf}"] = rot(Z, fan) @ rot(X, -c)
        loc[f"{name}2_{sf}"] = rot(X, -(c * 1.45 + 6 * curl))
    loc[f"thumb1_{sf}"] = rot(Z, 9 * thumb)
    loc[f"thumb2_{sf}"] = rot(X, -16 * thumb)
    loc[f"thumb3_{sf}"] = rot(X, -20 * thumb)
    return loc


def hand_fist(s, k=1.0):
    sf = "L" if s > 0 else "R"
    loc = {}
    for i, name in enumerate(("index", "middle", "ring", "pinky")):
        loc[f"{name}1_{sf}"] = rot(X, -(62 + 6 * i) * k)
        loc[f"{name}2_{sf}"] = rot(X, -(88 + 4 * i) * k)
    loc[f"thumb1_{sf}"] = rot(Z, 14 * k) @ rot(X, -10 * k)
    loc[f"thumb2_{sf}"] = rot(X, -28 * k)
    loc[f"thumb3_{sf}"] = rot(X, -30 * k)
    return loc


HAIR_CHAINS = ("hairFringe", "hairSideL", "hairSideR", "hairEarL", "hairEarR", "hairBackL", "hairBack", "hairBackR")


def secondary(fk, t, period, swing, trail, phase=0.0, bounce=1.0):
    """Lagged sway on the hair, ribbon and shirt-tail chains (local pitch about the bone's X)."""
    loc = {}
    for n in fk.order:
        base = n.split("_")[0]
        is_hair = base in HAIR_CHAINS
        is_rib = n.startswith("ribbon_")
        is_knot = n.startswith("knot_") or n.startswith("shirtBack")
        if not (is_hair or is_rib or is_knot):
            continue
        k = int(n[-1]) if n[-1].isdigit() else 1
        lag = 0.12 * k + (0.07 if is_rib else 0.0)
        w = 2 * math.pi * (t / period - lag) + phase
        amp = swing * (0.6 + 0.4 * k) * (1.6 if is_rib else 1.0) * (0.7 if is_knot else 1.0)
        pitch = trail * (0.5 + 0.5 * k) * (1.4 if is_rib else 1.0) + amp * math.sin(w) * bounce
        sway = amp * 0.5 * math.sin(w * 0.5 + k)
        loc[n] = rot(X, pitch) @ rot(Z, sway)
    return loc


def bake(arm, fk, name, frames, loop=True):
    """Write a clip: frames = list of (delta, absr, local, loc) per frame at FPS."""
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    act["heroine"] = 1
    slot = act.slots.new(id_type="OBJECT", name=arm.name)
    layer = act.layers.new("Layer")
    strip = layer.strips.new(type="KEYFRAME")
    cb = strip.channelbag(slot, ensure=True)
    n = len(frames)
    rots = {b: np.zeros((n, 4)) for b in fk.order}
    locs = {b: np.zeros((n, 3)) for b in fk.order}
    for i, (delta, absr, local, loc) in enumerate(frames):
        pose, basis = fk.solve(delta, absr, local, loc)
        for b in fk.order:
            t, Rb = basis[b]
            q = Matrix(Rb.tolist()).to_quaternion()
            if i > 0 and np.dot(rots[b][i - 1], [q.w, q.x, q.y, q.z]) < 0:
                q.negate()
            rots[b][i] = [q.w, q.x, q.y, q.z]
            locs[b][i] = t
    fr = np.arange(n, dtype=float) + 1
    for b in fk.order:
        grp = cb.groups.new(b)
        for k in range(4):
            fc = cb.fcurves.new(f'pose.bones["{b}"].rotation_quaternion', index=k)
            fc.group = grp
            fc.keyframe_points.add(n)
            fc.keyframe_points.foreach_set("co", np.stack([fr, rots[b][:, k]], axis=1).ravel())
            fc.keyframe_points.foreach_set("interpolation", [1] * n)  # LINEAR (dense keys)
            fc.update()
        if np.abs(locs[b]).max() > 1e-7:
            for k in range(3):
                fc = cb.fcurves.new(f'pose.bones["{b}"].location', index=k)
                fc.group = grp
                fc.keyframe_points.add(n)
                fc.keyframe_points.foreach_set("co", np.stack([fr, locs[b][:, k]], axis=1).ravel())
                fc.keyframe_points.foreach_set("interpolation", [1] * n)
                fc.update()
    act.use_frame_range = True
    act.frame_start, act.frame_end = 1, n
    act.use_cyclic = loop
    return act, slot


# ---------------------------------------------------------------- clips


def idle_pose(fk, body, t, period=4.0):
    """Contrapposto on her right leg, breathing, a slow weight sway."""
    br = math.sin(2 * math.pi * t / period)            # breath
    sw = math.sin(2 * math.pi * t / period * 0.5 + 0.7)  # slow sway (half the breath rate)
    delta, absr, local, loc = {}, {}, {}, {}
    # Pelvis over her right leg, its left side dropped, turned a touch toward her free leg.
    loc["hips"] = np.array([-0.026 + 0.004 * sw, 0.004, -0.010 + 0.0015 * br])
    delta["hips"] = rot(Z, 4.0 + 1.0 * sw) @ rot(Y, 4.5 + 0.8 * sw) @ rot(X, -1.0)
    # Chest counter-tilts (right shoulder lower), breathes; the head tilts gently.
    delta["spine"] = rot(Y, -2.0) @ rot(Z, -2.0)
    delta["spine1"] = rot(Y, -2.5) @ rot(X, 0.8 * br)
    delta["spine2"] = rot(Y, -2.0) @ rot(X, 1.2 * br) @ rot(Z, -1.5)
    delta["neck"] = rot(Y, 1.5) @ rot(X, -2.0)
    delta["head"] = rot(Y, 3.5) @ rot(Z, 4.0) @ rot(X, 1.5 + 0.5 * br)
    for s in (1, -1):
        sf = "L" if s > 0 else "R"
        delta[f"shoulder_{sf}"] = rot(X, 0.0) @ rot(Y, s * (-1.0 - 0.6 * br))
        delta.update(arms_down(s, adduct=17.5 if s > 0 else 18.5, flex=4.0 if s > 0 else -2.0, elbow=14.0 if s > 0 else 9.0))
        local.update(hand_relax(s, 1.0))
        local[f"hand_{sf}"] = rot(X, -6.0) @ rot(Z, s * 4.0)
    pose, _ = fk.solve(delta, absr, local, loc)
    # Feet stay planted: her right foot under her, her left forward and turned out, heel light.
    A0r, heel_r, ball_r = body.foot_points("R")
    A0l, heel_l, ball_l = body.foot_points("L")
    ank_r, Rr = body.foot_pose("R", "heel", heel_r + np.array([0.004, 0.0, 0.0]), 0.0, -3.0)
    ank_l, Rl = body.foot_pose("L", "ball", ball_l + np.array([0.022, -0.055, 0.0]), -6.0, 14.0)
    o, _ = body.leg(pose, "R", ank_r, Rr)
    absr.update(o)
    o, _ = body.leg(pose, "L", ank_l, Rl, rot(Z, 14.0))
    absr.update(o)
    local.update(secondary(fk, t, period, 0.8, -1.0))
    return delta, absr, local, loc


LAST_DROP = [0.0]


def gait_pose(fk, body, t, T, v, duty, run=False, drop=None):
    """One frame of a walk or run cycle (t in seconds, cycle T, speed v m/s, stance duty).

    drop: pelvis lowering for this frame. None measures the drop the planted legs need (left in
    LAST_DROP); build() smooths those over the cycle and calls again with the smoothed value, so
    the pelvis never pops down at heel strike."""
    delta, absr, local, loc = {}, {}, {}, {}
    ph = (t / T) % 1.0
    TOE_OFF = -36.0 if not run else -48.0
    stance_len = v * T * duty
    # Where the heel strikes, ahead of the hip (the planted heel then slides back at v).
    y_hs = -(0.40 if not run else 0.36) * stance_len
    feet = {}
    for sf, off in (("L", 0.0), ("R", 0.5)):
        p = (ph + off) % 1.0
        A0, heel, ball = body.foot_points(sf)
        width = 0.012 if not run else 0.03            # feet a little closer to the midline
        xg = heel[0] - (width if sf == "L" else -width)
        hb = ball - heel                              # heel to ball on the floor
        if p < duty:
            yg = y_hs + v * T * p
            if run:
                # Midfoot strike: land nearly flat, roll to the ball, push off.
                if p < duty * 0.45:
                    kind, pitch, pg = "heel", 6.0 * (1 - p / (duty * 0.45)), np.array([xg, yg + hb[1] * 0.45, 0])
                    pg = np.array([xg, yg, 0])
                else:
                    f = (p - duty * 0.45) / (duty * 0.55)
                    kind, pitch = "ball", TOE_OFF * smooth(0.0, 1.0, f)
                    pg = np.array([xg + hb[0], yg + hb[1], 0])
            else:
                if p < 0.08:
                    kind, pitch = "heel", 16.0 * (1 - smooth(0, 0.08, p))
                    pg = np.array([xg, yg, 0])
                elif p < 0.40:
                    kind, pitch = "heel", 0.0
                    pg = np.array([xg, yg, 0])
                else:
                    f = (p - 0.40) / (duty - 0.40)
                    kind, pitch = "ball", TOE_OFF * smooth(0.0, 1.0, f) ** 1.1
                    pg = np.array([xg + hb[0], yg + hb[1], 0])
            ankle, Rf = body.foot_pose(sf, kind, pg, pitch, 0.0)
            toe = rot(X, 0.0)
            feet[sf] = (ankle, Rf, True, kind, pitch, 0.0)
        else:
            # Swing: from toe-off back over to the next heel strike.
            f = (p - duty) / (1 - duty)
            y0 = y_hs + v * T * duty
            pg_off = np.array([xg + hb[0], y0 + hb[1], 0])
            a_off, R_off = body.foot_pose(sf, "ball", pg_off, TOE_OFF, 0.0)
            pg_on = np.array([xg, y_hs, 0])
            a_on, R_on = body.foot_pose(sf, "heel", pg_on, 16.0 if not run else 6.0, 0.0)
            # Hermite blend whose end slopes match the ground running back at v, so the foot
            # leaves and lands without a skid.
            D = a_on[1] - a_off[1]
            m = v * T * (1 - duty) / D if abs(D) > 1e-6 else 0.0
            e = (-2 * f ** 3 + 3 * f ** 2) + m * ((f ** 3 - 2 * f ** 2 + f) + (f ** 3 - f ** 2))
            ankle = a_off * (1 - e) + a_on * e
            lift = (0.075 if not run else 0.20) * math.sin(math.pi * min(1.0, f * 1.12)) ** (1.2 if not run else 0.8)
            back = (0.0 if not run else 0.10) * math.sin(math.pi * min(1.0, f * 1.4))  # heel kick
            ankle = ankle + np.array([0, back * (1 - f), lift])
            pitch = TOE_OFF * (1 - smooth(0.0, 0.55, f)) + (16.0 if not run else 6.0) * smooth(0.55, 1.0, f) - 8.0 * math.sin(math.pi * f)
            Rf = rot(X, -pitch)
            feet[sf] = (ankle, Rf, False, "swing", pitch, f)
    # Pelvis: bob (lowest in double support / mid stance for a run), sway, yaw, roll, lean.
    w = 2 * math.pi * ph
    if not run:
        z = -0.020 - 0.012 * math.cos(2 * w)
        x = 0.011 * math.sin(w + 0.3)
        yaw, roll, lean = 4.5 * math.sin(w), 2.5 * math.sin(2 * w - 0.6), 3.0
    else:
        z = -0.050 + 0.024 * math.cos(2 * w + 0.4)
        x = 0.006 * math.sin(w)
        yaw, roll, lean = 8.0 * math.sin(w), 3.0 * math.sin(2 * w - 0.5), 9.0
    hips_loc = np.array([x, -0.01 if run else 0.0, z])
    delta["hips"] = rot(Z, -yaw) @ rot(Y, roll) @ rot(X, -lean * 0.4)
    if drop is not None:
        loc["hips"] = hips_loc - np.array([0, 0, drop])
    else:
        # Measure how far the pelvis must come down for every planted foot to be in reach.
        dz = 0.0
        for it in range(8):
            loc["hips"] = hips_loc - np.array([0, 0, dz])
            pose, _ = fk.solve(delta, absr, local, loc)
            worst = 0.0
            for sf, (ankle, Rf, planted, kind, pitch, _f) in feet.items():
                H = fk.head_if(pose, f"thigh_{sf}")
                L1, L2 = body.L[sf]
                if planted:
                    worst = max(worst, np.linalg.norm(ankle - H) / (L1 + L2))
            if worst <= 0.990:
                break
            dz += (worst - 0.988) * sum(body.L["L"])
        LAST_DROP[0] = dz
    delta["spine"] = rot(Z, yaw * 0.45) @ rot(X, -lean * 0.3)
    delta["spine1"] = rot(Z, yaw * 0.45) @ rot(X, -lean * 0.3)
    delta["spine2"] = rot(Z, yaw * 0.5) @ rot(X, -lean * 0.2) @ rot(Y, -roll * 0.6)
    delta["neck"] = rot(Z, -yaw * 0.25) @ rot(X, lean * 0.3)
    delta["head"] = rot(Z, -yaw * 0.25) @ rot(X, lean * 0.35) @ rot(Y, -roll * 0.3)
    for s in (1, -1):
        sf = "L" if s > 0 else "R"
        # The arm swings with the opposite leg.
        a = math.sin(w + (0.0 if s > 0 else math.pi))
        if not run:
            delta.update(arms_down(s, adduct=17.0, flex=-17.0 * a + 2.0, elbow=14.0 + 10.0 * max(0.0, -a)))
            local.update(hand_relax(s, 1.0))
        else:
            delta.update(arms_down(s, adduct=13.0, flex=-34.0 * a + 4.0, elbow=82.0 + 14.0 * max(0.0, -a)))
            local.update(hand_fist(s, 0.75))
        delta[f"shoulder_{sf}"] = rot(X, 3.0 * a) @ rot(Y, s * -1.0)
    pose, _ = fk.solve(delta, absr, local, loc)
    for sf, (ankle, Rf, planted, kind, pitch, f) in feet.items():
        if planted:
            Rtoe = rot(X, 0.0) if kind == "ball" else Rf      # toes flat while the heel lifts
        else:
            # Toes leave the ground flat, then ease back in line with the foot.
            Rtoe = Rf @ rot(X, pitch * (1 - smooth(0.0, 0.45, f)))
        o, r = body.leg(pose, sf, ankle, Rf, Rtoe)
        absr.update(o)
    local.update(secondary(fk, t, T / 2, 2.2 if not run else 4.5, -4.0 if not run else -12.0, bounce=1.0))
    return delta, absr, local, loc


def sit_pose(fk, body, t, period=4.0):
    """Seated on the stern bench, right hand on the tiller grip, left hand on her knee."""
    br = math.sin(2 * math.pi * t / period)
    delta, absr, local, loc = {}, {}, {}, {}
    hip_h = 0.290 + 0.096 + 0.050                      # bench top + hip joints above it + hips bone above them
    rest_h = fk.rest_head("hips")[2]
    loc["hips"] = np.array([0.0, 0.03, hip_h - rest_h])
    delta["hips"] = rot(X, 8.0) @ rot(Z, -6.0)          # sits back a little, turned toward the tiller
    delta["spine"] = rot(X, -6.0) @ rot(Z, -3.0)
    delta["spine1"] = rot(X, -4.0 + 0.8 * br) @ rot(Z, -2.0) @ rot(Y, 2.0)
    delta["spine2"] = rot(X, -2.0 + 1.2 * br) @ rot(Y, 2.5)
    delta["neck"] = rot(Z, 8.0) @ rot(X, 2.0)
    delta["head"] = rot(Z, 10.0) @ rot(X, 3.0 + 0.6 * br) @ rot(Y, -2.0)
    delta["shoulder_R"] = rot(X, -4.0) @ rot(Y, 3.0)
    delta["shoulder_L"] = rot(X, -3.0)
    pose, _ = fk.solve(delta, absr, local, loc)
    # Legs: knees up and forward of the low bench, feet flat on the boards.
    for sf, xs, yf in (("L", 0.135, -0.43), ("R", -0.125, -0.40)):
        A0, heel, ball = body.foot_points(sf)
        pg = np.array([xs, yf + 0.05, 0.0])
        ankle, Rf = body.foot_pose(sf, "heel", pg, 0.0, 8.0 if sf == "L" else -10.0)
        pole = norm(np.array([0.25 if sf == "L" else -0.25, -1.0, 0.6]))
        o, _ = body.leg(pose, sf, ankle, Rf, rot(Z, 8.0 if sf == "L" else -10.0), pole=pole)
        absr.update(o)
    # Right arm: IK to the tiller grip (30 cm to her right, 14 cm forward, 68 cm up).
    grip = np.array([-0.300, -0.140, 0.680])
    d, w, n = _hand_axes(-1)
    wrist = grip + np.array([0.005, 0.045, 0.028])      # the grip sits in the palm, ahead of the wrist
    H = fk.head_if(pose, "upperarm_R")
    L1, L2 = body.arm_L["R"]
    pole = norm(np.array([-0.4, 0.55, -0.75]))         # elbow out, back and down
    E, W2 = two_bone(H, wrist, L1, L2, pole, reach=0.985)
    absr["upperarm_R"] = frame_from(E - H, np.array([0, -1.0, 0.1]))
    absr["forearm_R"] = frame_from(W2 - E, np.array([0, -1.0, 0.3]))
    # Hand round the grip: palm down and in, knuckles forward along the tiller.
    absr["hand_R"] = frame_from(norm(grip - W2 + np.array([0.0, -0.05, -0.02])), np.array([0.2, 0.0, 1.0]))
    local.update(hand_fist(-1, 0.95))
    # Left arm: hand resting on her left knee.
    pose, _ = fk.solve(delta, absr, local, loc)
    knee = pose["shin_L"][:3, 3]
    wl = knee + np.array([0.02, 0.05, 0.055])
    H = fk.head_if(pose, "upperarm_L")
    L1, L2 = body.arm_L["L"]
    E, W2 = two_bone(H, wl, L1, L2, norm(np.array([0.6, 0.6, -0.5])), reach=0.99)
    absr["upperarm_L"] = frame_from(E - H, np.array([0, -1.0, 0.0]))
    absr["forearm_L"] = frame_from(W2 - E, np.array([0, -1.0, 0.2]))
    absr["hand_L"] = frame_from(norm(np.array([0.05, -1.0, -0.65])), np.array([0.3, 0.0, 1.0]))
    local.update(hand_relax(1, 0.8))
    local.update(secondary(fk, t, period, 0.8, -2.0))
    return delta, absr, local, loc


def _hand_axes(s):
    from .rig import hand_frame
    return hand_frame(s)


def jump_pose(fk, body, t):
    """Anticipation crouch, take-off, airborne tuck, landing squash, recover (in place: the game
    moves her root through the air between take-off and touch-down)."""
    delta, absr, local, loc = {}, {}, {}, {}
    # Crouch depth over time and the airborne window.
    T_TAKE, T_LAND = 0.40, 0.85
    # A deep anticipation crouch, and a soft landing absorb that sinks and rises back slowly. The
    # game plays its short crouch from 0.27 (the bottom), so the bottom holds to 0.31.
    crouch = 0.23 * smooth(0.0, 0.25, t) * (1 - smooth(0.31, 0.40, t)) + 0.16 * smooth(0.85, 0.94, t) * (1 - smooth(0.97, 1.2, t))
    air = smooth(0.36, 0.46, t) * (1 - smooth(0.78, 0.86, t))
    lean = 24.0 * smooth(0.05, 0.25, t) * (1 - smooth(0.30, 0.42, t)) + 5.0 * air + 14.0 * smooth(0.85, 0.93, t) * (1 - smooth(0.97, 1.2, t))
    loc["hips"] = np.array([0.0, 0.01 * lean / 16.0, -crouch])
    delta["hips"] = rot(X, -lean * 0.35)
    delta["spine"] = rot(X, -lean * 0.3)
    delta["spine1"] = rot(X, -lean * 0.25)
    delta["spine2"] = rot(X, -lean * 0.15)
    delta["head"] = rot(X, lean * 0.4)
    # Arms: swung back behind the hips in the crouch, driven up and out on take-off, relaxed and
    # asymmetric (bent elbows, the left a little higher) in the air, forward to absorb the landing.
    back = smooth(0.04, 0.24, t) * (1 - smooth(0.31, 0.37, t))
    up = smooth(0.32, 0.42, t) * (1 - smooth(0.48, 0.64, t))
    apex = smooth(0.42, 0.58, t) * (1 - smooth(0.80, 0.92, t))
    fwd_land = smooth(0.82, 0.9, t) * (1 - smooth(0.98, 1.2, t))
    for s in (1, -1):
        sf = "L" if s > 0 else "R"
        flex = -58.0 * back + 120.0 * up + (24.0 + 12.0 * s) * apex * (1 - up) + 30.0 * fwd_land
        add = 15.0 - 8.0 * back - 24.0 * up - (42.0 + 10.0 * s) * apex
        elbow = 16.0 + 10.0 * back + 18.0 * up + (38.0 - 12.0 * s) * apex + 28.0 * fwd_land
        delta.update(arms_down(s, adduct=add, flex=flex, elbow=elbow))
        local.update(hand_relax(s, 1.0 - 0.35 * up))
    pose, _ = fk.solve(delta, absr, local, loc)
    for sf in ("L", "R"):
        A0, heel, ball = body.foot_points(sf)
        push = smooth(0.30, 0.40, t) * (1 - smooth(0.42, 0.5, t))   # toes last off the ground
        Rtoe = None
        if air > 0.02 or push > 0.02:
            pitch = -35.0 * push * (1 - air) - 20.0 * air
            ankle, Rf = body.foot_pose(sf, "ball", ball, pitch, 0.0)
            # One knee higher than the other in the air.
            tuck = (0.2 if sf == "L" else 0.12) * air
            ankle = ankle + np.array([0, 0.03 * air, tuck])
            # Toes stay flat on the boards through the push, then follow the foot in the air.
            Rtoe = Rf @ rot(X, pitch * (1 - smooth(0.0, 0.6, air)))
        else:
            ankle, Rf = body.foot_pose(sf, "heel", heel, 0.0, 0.0)
        pole = norm(FWD + np.array([0.15 if sf == "L" else -0.15, 0, 0]))
        o, _ = body.leg(pose, sf, ankle, Rf, Rtoe, pole=pole)
        absr.update(o)
    local.update(secondary(fk, t, 0.6, 3.5 * air + 1.0, -6.0 * air))
    return delta, absr, local, loc


def build(arm):
    fk = FK(arm)
    body = Body(fk)
    clips = {}

    def frames_of(fn, dur, loop=True):
        n = int(round(dur * FPS)) + (1 if not loop else 0)
        return [fn(i / FPS) for i in range(n if not loop else n + 1)]

    # Idle: 4 s loop.
    fr = frames_of(lambda t: idle_pose(fk, body, t), 4.0)
    bake(arm, fk, "idle", fr)
    clips["idle"] = {"duration": 4.0, "loop": True, "contacts": {"L": [[0.0, 4.0]], "R": [[0.0, 4.0]]}}
    def gait_frames(T, v, duty, run):
        # Pass 1 measures the pelvis drop the planted legs need per frame; pass 2 uses a smoothed
        # (cyclic max-filter + blur) version so the hips glide instead of popping at heel strike.
        n = int(round(T * FPS))
        need = []
        for i in range(n):
            gait_pose(fk, body, i / FPS, T, v, duty, run)
            need.append(LAST_DROP[0])
        need = np.array(need)
        k = 4
        mx = np.array([max(need[(i + j) % n] for j in range(-k, k + 1)) for i in range(n)])
        g = np.exp(-0.5 * (np.arange(-k, k + 1) / 2.0) ** 2)
        g /= g.sum()
        sm = np.array([sum(g[j + k] * mx[(i + j) % n] for j in range(-k, k + 1)) for i in range(n)])
        sm = np.maximum(sm, need)
        return [gait_pose(fk, body, i / FPS, T, v, duty, run, drop=float(sm[i % n])) for i in range(n + 1)]

    # Walk: 1.1 s cycle at 1.30 m/s.
    T, v, duty = 1.1, 1.30, 0.62
    fr = gait_frames(T, v, duty, False)
    bake(arm, fk, "walk", fr)
    clips["walk"] = {"duration": T, "loop": True, "speed": v, "stride": v * T,
                     "contacts": {"L": [[0.0, round(duty * T, 3)]], "R": [[round(0.5 * T, 3), round((0.5 + duty) * T - T, 3)]]},
                     "events": {"heelStrikeL": 0.0, "toeOffL": round(duty * T, 3), "heelStrikeR": round(0.5 * T, 3), "toeOffR": round((duty - 0.5) * T, 3)}}
    # Run: 0.66 s cycle at 3.4 m/s.
    T, v, duty = 0.66, 3.4, 0.36
    fr = gait_frames(T, v, duty, True)
    bake(arm, fk, "run", fr)
    clips["run"] = {"duration": T, "loop": True, "speed": v, "stride": v * T,
                    "contacts": {"L": [[0.0, round(duty * T, 3)]], "R": [[round(0.5 * T, 3), round((0.5 + duty) * T, 3)]]},
                    "events": {"footStrikeL": 0.0, "toeOffL": round(duty * T, 3), "footStrikeR": round(0.5 * T, 3), "toeOffR": round((0.5 + duty) * T, 3)}}
    # Seated at the tiller: 4 s loop.
    fr = frames_of(lambda t: sit_pose(fk, body, t), 4.0)
    bake(arm, fk, "sit_tiller", fr)
    clips["sit_tiller"] = {"duration": 4.0, "loop": True, "seatHeight": 0.29,
                           "grip": [-0.30, 0.68, 0.14], "contacts": {"L": [[0.0, 4.0]], "R": [[0.0, 4.0]]}}
    # Jump: 1.2 s, once.
    fr = frames_of(lambda t: jump_pose(fk, body, t), 1.2, loop=False)
    bake(arm, fk, "jump", fr, loop=False)
    clips["jump"] = {"duration": 1.2, "loop": False, "takeOff": 0.40, "touchDown": 0.85,
                     "contacts": {"L": [[0.0, 0.40], [0.85, 1.2]], "R": [[0.0, 0.40], [0.85, 1.2]]}}
    # Leave the armature in its rest pose (no action assigned), but with animation data: the glTF
    # exporter only gathers the unassigned actions of an armature that has some.
    ad = arm.animation_data or arm.animation_data_create()
    ad.action = None
    return clips
