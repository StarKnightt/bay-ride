"""Her visible limbs: arms with hands and fingers, legs, feet with toes (Blender frame).

The torso is never seen bare (camisole, shirt and shorts cover it), so the limbs are clean ring
tubes whose upper ends tuck inside the sleeves and shorts; the ankle join hides under the sandal's
ankle strap. Every piece carries a custom "part" property the skinning pass reads.
"""
import numpy as np

from . import rig, shape
from .common import (assign_material, catmull, frames_along, gauss, make_mesh, material, norm, orient,
                     set_colors, set_float, smooth, spline_points, srgb, tube)

S = shape
SKIN = "#f6d6c2"
SOLE = 0.012  # sandal sole: she is lifted onto it at the end of the build


def _ring_tube(path, sec_fn, n_ring, front_hint, closed_end=None):
    """Rings along a sampled path. sec_fn(i, t, th) -> radius offsets in (side, front) frame:
    returns (x_side, y_front) arrays for ring i at parameter t (0..1)."""
    T, N, B = frames_along(path)
    rings = []
    m = len(path)
    for i in range(m):
        t = i / (m - 1)
        # Orient the ring frame: "front" = the hint projected off the tangent.
        f = np.asarray(front_hint, float)
        f = norm(f - T[i] * (f @ T[i]))
        sd = norm(np.cross(T[i], f))
        th = np.linspace(0, 2 * np.pi, n_ring, endpoint=False)
        xs, ys = sec_fn(i, t, th)
        rings.append(path[i] + np.outer(xs, sd) + np.outer(ys, f))
    return np.stack(rings)


# ---------------------------------------------------------------- arms and hands


def arm(s):
    """Upper arm (inside the sleeve) to the knuckles, one tube; fingers are separate tubes."""
    sh, el, wr = S.side(S.SH, s), S.side(S.ELB, s), S.side(S.WRI, s)
    d, w, n = rig.hand_frame(s)
    kn = wr + d * 0.090
    ctrl = [sh + np.array([0, 0, 0.03]), sh, sh + (el - sh) * 0.5, el, el + (wr - el) * 0.5, wr, wr + d * 0.045, kn]
    path = spline_points(ctrl, 32)
    # Cumulative length to map rings to the arm table (t 0..1 shoulder..wrist) and the palm.
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    l_sh = np.linalg.norm(path[np.argmin(np.linalg.norm(path - sh, axis=1))] - path[0])
    i_sh = np.argmin(np.linalg.norm(path - sh, axis=1))
    i_wr = np.argmin(np.linalg.norm(path - wr, axis=1))
    s_sh, s_wr = L[i_sh], L[i_wr]
    # Ring frame: "front" is the thumb side (w, toward -Y) so the wrist is wide front-to-back.
    front = -w * s if s > 0 else -w * s

    def sec(i, t, th):
        u = (L[i] - s_sh) / (s_wr - s_sh)
        c, sn = np.cos(th), np.sin(th)
        if u <= 1.0:
            uu = np.clip(u, 0, 1)
            a = S.arm_section(uu)[0]
            r_fb, r_io = a[1], a[0]
            # Elbow point at the back, a soft forearm belly on the outer-front.
            back_bump = 0.004 * gauss(uu, 0.5, 0.05) * smooth(0.3, 1.0, -c)
            belly = 0.003 * gauss(uu, 0.64, 0.08) * smooth(0.0, 1.0, c * 0.6 + sn * 0.8 * s)
            xs = (r_io + belly * 0.5) * sn
            ys = (r_fb + back_bump * 0 + belly) * c - back_bump * smooth(0.3, 1.0, -c) * 0
            ys = ys - back_bump * (c < 0)
            return xs, ys
        # Palm: widens across (w) and flattens through the hand (n), dorsal side rounder.
        v = np.clip((L[i] - s_wr) / (L[-1] - s_wr), 0, 1)
        half_w = 0.026 + 0.017 * smooth(0.0, 0.55, v) - 0.004 * smooth(0.8, 1.0, v)
        half_t = 0.0175 - 0.004 * smooth(0.0, 0.7, v)
        xs = half_t * sn * (1.0 - 0.18 * (sn * s < 0))
        ys = half_w * np.sign(c) * np.abs(c) ** 0.8
        # Thenar pad on the thumb side of the palm.
        xs = xs - s * 0.004 * gauss(v, 0.35, 0.2) * smooth(0.2, 1.0, c) * (sn * s < 0)
        return xs, ys

    rings = _ring_tube(path, sec, 16, front)
    V, F = tube(rings, closed=True, cap_end=True)
    ax = lambda C: _nearest_on(path, C)
    F = orient(V, F, ax)
    return V, F


def _nearest_on(path, C):
    P = np.asarray(path)
    out = np.zeros_like(C)
    for k in range(len(C)):
        out[k] = P[np.argmin(np.linalg.norm(P - C[k], axis=1))]
    return out


def finger(points, r0, r1, flat=0.85, nring=6, back=0.016):
    """A finger: tube through its joints (first point inside the palm), rounded tip."""
    P = np.asarray(points, float)
    d0 = norm(P[1] - P[0])
    ctrl = [P[0] - d0 * back] + list(P)
    path = spline_points(ctrl, 10)
    tip_dir = norm(path[-1] - path[-2])
    # Rounded tip: two more rings closing in.
    path = np.vstack([path, path[-1] + tip_dir * r1 * 0.55, path[-1] + tip_dir * r1 * 0.9])
    m = len(path)

    def sec(i, t, th):
        rr = r0 + (r1 - r0) * min(1.0, i / (m - 3))
        if i == 0:
            rr *= 0.6                     # the root tucks into the palm
        if i == m - 2:
            rr *= 0.75
        if i == m - 1:
            rr *= 0.35
        # Knuckle and joint creases: a touch slimmer between, fuller at the joints.
        return rr * np.cos(th) * 1.0, rr * flat * np.sin(th)

    rings = _ring_tube(path, sec, nring, (0, 0, 1))
    V, F = tube(rings, closed=True, cap_start=True, cap_end=True)
    F = orient(V, F, lambda C: _nearest_on(path, C))
    return V, F


def hand_fingers(s):
    fp = rig.finger_points(s)
    out = []
    radii = {"index": (0.0083, 0.0066), "middle": (0.0086, 0.0068), "ring": (0.0080, 0.0064), "pinky": (0.0070, 0.0056)}
    for name, (r0, r1) in radii.items():
        out.append(finger(fp[name], r0, r1))
    out.append(finger(fp["thumb"], 0.0128, 0.0084, flat=0.8, back=0.006))
    return out


# ---------------------------------------------------------------- legs and feet


def leg(s):
    """Hip (inside the shorts) to just below the ankle (inside the foot)."""
    hp, kn, an = S.side(S.HIP, s), S.side(S.KNEE, s), S.side(S.ANKLE, s)
    ctrl = [hp + np.array([0, 0, 0.05]), hp, hp + (kn - hp) * 0.5, kn, kn + (an - kn) * 0.5, an, an + np.array([0, 0.004, -0.022])]
    path = spline_points(ctrl, 36)
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    i_h = np.argmin(np.linalg.norm(path - hp, axis=1))
    i_a = np.argmin(np.linalg.norm(path - an, axis=1))

    def sec(i, t, th):
        u = np.clip((L[i] - L[i_h]) / (L[i_a] - L[i_h]), 0, 1.05)
        a = S.leg_section(min(u, 1.0))[0]
        hw, hd, fwd = a[0], a[1], a[2]
        c, sn = np.cos(th), np.sin(th)        # c: toward the front, sn: toward her outside
        # Calf: the belly sits high and inside at the back; a neat knee; Achilles narrows the back.
        calf = 0.0085 * gauss(u, 0.69, 0.07) * smooth(0.1, 1.0, -c) * (0.7 + 0.3 * smooth(-1, 1, -sn))
        kneecap = 0.0045 * gauss(u, 0.515, 0.025) * smooth(0.5, 1.0, c)
        quad = 0.004 * gauss(u, 0.27, 0.11) * smooth(0.2, 1.0, c)
        inner = 0.004 * gauss(u, 0.16, 0.11) * smooth(0.2, 1.0, -sn)
        achilles = -0.006 * smooth(0.84, 0.94, u) * smooth(0.5, 1.0, -c) * (1 - smooth(0.0, 0.6, np.abs(sn)))
        malle = 0.003 * gauss(u, 0.983, 0.025) * smooth(0.6, 1.0, np.abs(sn))
        r_side = hw + inner + malle
        r_fb = hd + np.where(c > 0, kneecap + quad, calf + achilles)
        return r_side * sn * s, r_fb * c + fwd

    rings = _ring_tube(path, sec, 18, (0, -1, 0))
    LEG_RINGS[s] = (path, rings)
    V, F = tube(rings, closed=True, cap_end=True)
    F = orient(V, F, lambda C: _nearest_on(path, C))
    return V, F


LEG_RINGS = {}


def leg_clear(s, P, margin):
    """Push points (n,3) out of the leg (side s) to at least `margin` beyond its true surface,
    radially from the leg's centre line at their height."""
    if s not in LEG_RINGS:
        leg(s)
    path, rings = LEG_RINGS[s]
    P = np.array(P, dtype=float)
    pz = path[:, 2]
    order = np.argsort(pz)
    for k in range(len(P)):
        z = P[k, 2]
        if z < pz.min() or z > pz.max():
            continue
        i = int(np.clip(np.interp(z, pz[order], order.astype(float)), 0, len(path) - 1))
        c = path[i]
        ring = rings[i]
        rel = ring[:, :2] - c[:2]
        ang = np.arctan2(rel[:, 0], -rel[:, 1])
        rad = np.hypot(rel[:, 0], rel[:, 1])
        o = np.argsort(ang)
        q = P[k, :2] - c[:2]
        a = np.arctan2(q[0], -q[1])
        r_leg = np.interp(a, ang[o], rad[o], period=2 * np.pi)
        r = np.hypot(q[0], q[1])
        need = r_leg + margin
        if r < need:
            q = q / max(r, 1e-6) * need
            P[k, :2] = c[:2] + q
    return P


# Foot along its length u (0 heel back .. 1 toe tips): half width, top height, sole lift, lateral
# shift of the section centre (+ = outside), and how much of the toe line is reached on the inside.
FOOT_T = [
    [0.00, 0.011, 0.026, 0.012, 0.000],
    [0.04, 0.024, 0.046, 0.004, 0.000],
    [0.11, 0.029, 0.070, 0.000, 0.000],
    [0.20, 0.0305, 0.090, 0.000, 0.000],
    [0.30, 0.0325, 0.082, 0.000, -0.001],
    [0.42, 0.0355, 0.063, 0.002, -0.002],
    [0.55, 0.0395, 0.050, 0.001, -0.002],
    [0.66, 0.0435, 0.040, 0.000, -0.001],
    [0.75, 0.0445, 0.032, 0.000, 0.000],
    [0.83, 0.0425, 0.026, 0.001, 0.001],
    [0.91, 0.0370, 0.021, 0.002, 0.002],
    [0.965, 0.0280, 0.017, 0.004, 0.001],
    [1.00, 0.0130, 0.012, 0.006, 0.000],
]
FOOT_LEN = 0.232


def foot(s):
    an = S.side(S.ANKLE, s)
    toe_out = np.radians(6.0) * s
    fwd = np.array([np.sin(toe_out), -np.cos(toe_out), 0.0])
    lat = np.array([np.cos(toe_out), np.sin(toe_out), 0.0])  # toward her outside for s=+1
    heel = np.array([an[0], an[1] + 0.050, 0.0]) - fwd * 0.0
    n_len, n_ring = 24, 16
    us = np.linspace(0, 1, n_len)
    us = us - 0.035 * np.sin(np.pi * us) * (1 - us)  # a little denser at the toes
    tab = catmull(FOOT_T, us)
    rings = []
    for k, u in enumerate(us):
        hw, top, lift, shift = tab[k, 0], tab[k, 1], tab[k, 2], tab[k, 3]
        c = heel + fwd * (u * FOOT_LEN) + lat * s * shift * 0
        th = np.linspace(0, 2 * np.pi, n_ring, endpoint=False)
        cs, sn = np.cos(th), np.sin(th)
        # Rounded box section: flat sole, domed top, inside edge (arch) lifting mid-foot.
        x = hw * np.sign(cs) * np.abs(cs) ** 0.62
        zmid = (top + lift) / 2
        zh = (top - lift) / 2
        z = zmid + zh * np.sign(sn) * np.abs(sn) ** np.where(sn < 0, 0.35, 0.9)
        inside = (x * s) < 0
        arch = 0.010 * gauss(u, 0.45, 0.12) * smooth(0.0, 1.0, -x * s / max(hw, 1e-4)) * (sn < 0)
        z = z + arch
        # Toe line: the big toe reaches furthest; toes taper down to the little toe.
        if u > 0.82:
            reach = 1.0 - 0.75 * smooth(-1.0, 1.0, x * s / max(hw, 1e-4))
            z = np.where(sn > 0, z - (1 - reach) * 0.004, z)
        # Grooves between the toes on top.
        if u > 0.84:
            g = np.zeros_like(x)
            for gx in (-0.017, -0.004, 0.008, 0.019):
                g += 0.0016 * gauss(x * s, gx, 0.0016)
            z = z - g * smooth(0.0, 0.5, sn) * smooth(0.84, 0.92, u)
        P = c[None, :] + np.outer(x, lat) + np.outer(z, [0, 0, 1])
        rings.append(P)
    rings = np.stack(rings)
    # Toe tips: pull the outside edge back (the little toe is shorter).
    for k, u in enumerate(us):
        if u > 0.8:
            off = (rings[k] - (heel + fwd * u * FOOT_LEN)) @ lat
            back = 0.022 * smooth(-0.01, 0.045, off * s) * smooth(0.8, 1.0, u)
            rings[k] = rings[k] - np.outer(back, fwd)
    V, F = tube(rings, closed=True, cap_start=True, cap_end=True)
    center = lambda C: np.stack([np.full(len(C), heel[0]), C[:, 1], np.clip(C[:, 2], 0.02, 0.05)], axis=1)
    F = orient(V, F, center)
    return V, F


# ---------------------------------------------------------------- build and skin


def _skin_obj(name, V, F, col, part, side_=0):
    ob = make_mesh(name, V, F, col)
    set_colors(ob, np.tile(srgb(SKIN), (len(V), 1)))
    set_float(ob, "_wind", np.zeros(len(V)))
    ob["part"] = part
    ob["side"] = side_
    assign_material(ob, material("skin", SKIN))
    return ob


def build(col):
    out = {}
    for s, sf in ((1, "L"), (-1, "R")):
        V, F = arm(s)
        a = _skin_obj(f"arm_{sf}", V, F, col, "arm", s)
        # Knuckles, elbows a touch rosier; nails a little lighter and pinker at the finger tips.
        Vs = V
        fp = rig.finger_points(s)
        fingers = []
        for k, (Vf, Ff) in enumerate(hand_fingers(s)):
            f = _skin_obj(f"finger{k}_{sf}", Vf, Ff, col, "arm", s)
            fingers.append(f)
        Vl, Fl = leg(s)
        lg = _skin_obj(f"leg_{sf}", Vl, Fl, col, "leg", s)
        Vf, Ff = foot(s)
        ft = _skin_obj(f"foot_{sf}", Vf, Ff, col, "leg", s)
        out[f"arm_{sf}"] = a
        out[f"leg_{sf}"] = lg
        out[f"foot_{sf}"] = ft
    return out


def cull_hidden(col):
    """Delete skin that is always covered: the scalp under the hair cap, the torso under the
    camisole, the upper arms inside the sleeves and the thighs inside the shorts (no poke-through,
    fewer triangles). Margins keep skin visible a little way inside every opening."""
    from . import hair, head
    from .common import delete_faces, face_vertex_indices, verts
    for ob in list(col.all_objects):
        if ob.type != "MESH":
            continue
        part = ob.get("part", "")
        V = verts(ob)
        hid = np.zeros(len(V), dtype=bool)
        if part == "bust":
            L = V - head.HC
            th = np.arctan2(L[:, 0], -L[:, 1])
            hid |= L[:, 2] > hair.hairline_z(th) + 0.013
            # Under the camisole (its neckline is ~1.27 m at the front, lower at the back).
            a = np.abs(th)
            ztop = np.interp(a, [0, 0.5, 0.9, 1.6, 2.4, np.pi], [1.268, 1.276, 1.288, 1.282, 1.262, 1.250])
            hid |= (V[:, 2] < ztop - 0.03) & (L[:, 2] < -0.15)
        elif part == "arm":
            s = ob.get("side", 1)
            sh, el = S.side(S.SH, s), S.side(S.ELB, s)
            d = el - sh
            t = ((V - sh) @ d) / (d @ d)
            hid |= t < 0.83 - 0.18
        elif part == "leg" and ob.name.startswith("leg"):
            hid |= V[:, 2] > 0.70
        if not hid.any():
            continue
        F = face_vertex_indices(ob)
        kill = np.array([all(hid[i] for i in f) for f in F])
        delete_faces(ob, kill)


def weights_for(ob):
    """Bone weights for one mesh object by its part."""
    from .head import HC, head_field
    V = np.array([v.co[:] for v in ob.data.vertices])
    part = ob.get("part", "")
    s = ob.get("side", 0)
    n = len(V)
    if part == "arm":
        W = rig.arm_weights(V, s)
        W = rig.finger_weights(V, s, W)
    elif part == "leg":
        W = rig.leg_weights(V, s)
    elif part in ("bust", "ear"):
        hf = head_field(V - HC)
        tf = S.torso_sdf(V)
        k_head = smooth(-0.006, 0.006, tf - hf)
        if part == "ear":
            k_head = np.ones(n)
        W = rig.spine_weights(V, head_from=None)
        # Neck/head split along the jaw on the skin; shoulders take the chest near the arms.
        neck_head = W.get("neck", 0) + W.get("head", 0)
        W["head"] = neck_head * k_head + (1 - neck_head) * 0 if True else 0
        W["neck"] = neck_head * (1 - k_head)
        # Above the neck joint everything that is not head is neck.
        for sgn, sf in ((1, "L"), (-1, "R")):
            k_sh = smooth(0.07, 0.15, V[:, 0] * sgn) * smooth(1.27, 1.34, V[:, 2]) * 0.75
            W[f"shoulder_{sf}"] = W.get("spine2", 0) * k_sh
            W["spine2"] = W.get("spine2", 0) * (1 - k_sh)
    elif part == "head_rigid":
        W = {"head": np.ones(n)}
    elif part == "custom":
        W = None
    else:
        W = rig.spine_weights(V)
    return W


def skin_all(col, arm_ob):
    from .outfit import cloth_weights
    for ob in col.all_objects:
        if ob.type != "MESH":
            continue
        part = ob.get("part", "")
        if part in ("cloth", "hair", "hat", "glasses"):
            W = cloth_weights(ob)
        else:
            W = weights_for(ob)
        if W is None:
            continue
        W = rig.finalize(W, len(ob.data.vertices))
        rig.apply_weights(ob, W, arm_ob)
