"""Her armature and skin weights.

Bones (glTF / three.js names; Blender's '.' is avoided because three strips it from node names):
  root > hips > spine > spine1 > spine2 > neck > head
  spine2 > shoulder_L > upperarm_L > forearm_L > (forearmTwist_L, hand_L > thumb1-3_L, index1-2_L,
           middle1-2_L, ring1-2_L, pinky1-2_L)
  hips > thigh_L > shin_L > foot_L > toe_L                          (and the same for _R)
  head > hat > ribbon_L1-3, ribbon_R1-3 ; head > hair chains (hair_*)
  spine > knot_L1-2, knot_R1-2 (shirt knot tails), shirtBack1 (back hem)

Weights come from smooth analytic fields evaluated on every mesh (skin and clothes alike), so a
garment and the skin under it deform with the same blend and stay apart.
"""
import bpy
import numpy as np
from mathutils import Vector

from . import shape
from .common import collection, norm, smooth

S = shape


def _v(p):
    return Vector((float(p[0]), float(p[1]), float(p[2])))


def hand_frame(s):
    """Hand axes for side s: d along the hand, w across (thumb -> little finger), n out of the palm."""
    d = norm(S.side(S.WRI, s) - S.side(S.ELB, s))
    d = norm(d + np.array([s * 0.06, 0.02, 0.0]))
    n0 = norm(np.array([-s * 1.0, 0.30, 0.0]))
    w = norm(np.cross(d, n0)) * s
    n = norm(np.cross(w, d)) * s
    return d, w, n


# Finger layout in the hand frame: knuckle (d, w), lengths of the two bones, relaxed curl (rad).
FINGERS = {
    "index": (0.088, -0.0235, 0.040, 0.030, 0.20),
    "middle": (0.091, -0.0075, 0.044, 0.033, 0.24),
    "ring": (0.087, 0.0085, 0.041, 0.031, 0.28),
    "pinky": (0.079, 0.0225, 0.032, 0.025, 0.32),
}
THUMB = {"base": (0.024, -0.018, 0.005), "len": (0.036, 0.030, 0.026)}


def finger_points(s):
    """Joint points for every finger (world, bind pose): name -> [p0, p1, p2] (and thumb 4)."""
    d, w, n = hand_frame(s)
    W = S.side(S.WRI, s)
    out = {}
    for name, (kd, kw, l1, l2, curl) in FINGERS.items():
        p0 = W + d * kd + w * kw * s + n * 0.004
        # Fingers fan a little and curl toward the palm.
        fan = kw * 0.9
        dd = norm(d + w * s * fan)
        a1 = curl * 0.5
        d1 = norm(dd * np.cos(a1) + n * np.sin(a1))
        p1 = p0 + d1 * l1
        a2 = curl * 1.5
        d2 = norm(dd * np.cos(a2) + n * np.sin(a2))
        p2 = p1 + d2 * l2
        out[name] = [p0, p1, p2]
    bd, bw, bn = THUMB["base"]
    t0 = W + d * bd + w * bw * s + n * bn
    # A relaxed thumb lies along the hand beside the index finger, a little out and palmward.
    td = norm(d * 0.78 + w * (-s) * 0.42 + n * 0.32)
    t1 = t0 + td * THUMB["len"][0]
    td2 = norm(td + d * 0.25 + n * 0.12)
    t2 = t1 + td2 * THUMB["len"][1]
    td3 = norm(td2 + n * 0.25)
    t3 = t2 + td3 * THUMB["len"][2]
    out["thumb"] = [t0, t1, t2, t3]
    return out


def bone_defs():
    """[(name, head, tail, parent, roll_axis)] in the bind pose (Blender frame)."""
    B = []
    fwd = (0, -1, 0)
    j = S.J
    B.append(("root", (0, 0, 0), (0, 0, 0.12), None, fwd))
    B.append(("hips", j["hips"], j["spine"], "root", fwd))
    B.append(("spine", j["spine"], j["spine1"], "hips", fwd))
    B.append(("spine1", j["spine1"], j["spine2"], "spine", fwd))
    B.append(("spine2", j["spine2"], j["neck"], "spine1", fwd))
    B.append(("neck", j["neck"], j["head"], "spine2", fwd))
    B.append(("head", j["head"], j["head_end"], "neck", fwd))
    for s, sf in ((1, "L"), (-1, "R")):
        sh, el, wr = S.side(S.SH, s), S.side(S.ELB, s), S.side(S.WRI, s)
        B.append((f"shoulder_{sf}", (s * 0.022, 0.006, 1.374), sh, "spine2", fwd))
        B.append((f"upperarm_{sf}", sh, el, f"shoulder_{sf}", fwd))
        B.append((f"forearm_{sf}", el, wr, f"upperarm_{sf}", fwd))
        B.append((f"forearmTwist_{sf}", el + (wr - el) * 0.5, wr, f"forearm_{sf}", fwd))
        d, w, n = hand_frame(s)
        B.append((f"hand_{sf}", wr, wr + d * 0.088, f"forearm_{sf}", tuple(-n)))
        fp = finger_points(s)
        for name in ("index", "middle", "ring", "pinky"):
            p0, p1, p2 = fp[name]
            B.append((f"{name}1_{sf}", p0, p1, f"hand_{sf}", tuple(-n)))
            B.append((f"{name}2_{sf}", p1, p2, f"{name}1_{sf}", tuple(-n)))
        t = fp["thumb"]
        B.append((f"thumb1_{sf}", t[0], t[1], f"hand_{sf}", tuple(-n)))
        B.append((f"thumb2_{sf}", t[1], t[2], f"thumb1_{sf}", tuple(-n)))
        B.append((f"thumb3_{sf}", t[2], t[3], f"thumb2_{sf}", tuple(-n)))
        hp, kn, an, ba, to = (S.side(p, s) for p in (S.HIP, S.KNEE, S.ANKLE, S.BALL, S.TOE))
        B.append((f"thigh_{sf}", hp, kn, "hips", fwd))
        B.append((f"shin_{sf}", kn, an, f"thigh_{sf}", fwd))
        B.append((f"foot_{sf}", an, ba, f"shin_{sf}", (0, 0, 1)))
        B.append((f"toe_{sf}", ba, to, f"foot_{sf}", (0, 0, 1)))
    return B


EXTRA = []  # hair / cloth helper chains appended by the hair and outfit builders


def add_chain(prefix, points, parent, roll=(0, -1, 0)):
    """Register a helper chain (hair lock, ribbon tail, shirt tail): bones prefix1..N along points."""
    names = []
    for i in range(len(points) - 1):
        nm = f"{prefix}{i + 1}"
        EXTRA.append((nm, tuple(points[i]), tuple(points[i + 1]), parent if i == 0 else names[-1], roll))
        names.append(nm)
    return names


def build_armature(name="heroine"):
    col = collection()
    arm = bpy.data.armatures.new(name)
    ob = bpy.data.objects.new(name, arm)
    col.objects.link(ob)
    vl = bpy.context.view_layer
    prev = vl.objects.active
    vl.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    eb = arm.edit_bones
    for (nm, h, t, parent, roll) in bone_defs() + EXTRA:
        b = eb.new(nm)
        b.head = _v(h)
        b.tail = _v(t)
        b.align_roll(_v(roll))
        if parent:
            b.parent = eb[parent]
            b.use_connect = False
        b.use_deform = nm != "root"
    bpy.ops.object.mode_set(mode="OBJECT")
    vl.objects.active = prev if prev and prev.name in vl.objects else ob
    arm.display_type = "STICK"
    return ob


# ---------------------------------------------------------------- weights


def _chain(P, joints, bones, blends, parent=None, parent_blend=0.0):
    """Weights along a chain of joints (K,3) for bones (K-1): each bone owns its segment, blending
    with the next across each inner joint over +-blends[i] metres; the start blends into `parent`."""
    J = np.asarray(joints, dtype=float)
    n = len(P)
    seg_len = np.linalg.norm(np.diff(J, axis=0), axis=1)
    cum = np.concatenate([[0], np.cumsum(seg_len)])
    best = np.full(n, np.inf)
    sparam = np.zeros(n)
    for i in range(len(J) - 1):
        a, b = J[i], J[i + 1]
        ab = b - a
        t = np.clip(((P - a) @ ab) / (ab @ ab), -0.4 if i == 0 else 0.0, 1.0 if i < len(J) - 2 else 1.6)
        q = a + t[:, None] * ab
        dist = np.linalg.norm(P - q, axis=1)
        better = dist < best
        best = np.where(better, dist, best)
        sparam = np.where(better, cum[i] + t * seg_len[i], sparam)
    nb = len(bones)
    # Partition of unity along s: smooth steps at each inner joint.
    steps = [smooth(cum[i + 1] - blends[i], cum[i + 1] + blends[i], sparam) for i in range(nb - 1)]
    W = _partition(bones, steps, n)
    if parent is not None and parent_blend > 0:
        k = 1 - smooth(-parent_blend, parent_blend, sparam)
        for bn in list(W):
            W[bn] = W[bn] * (1 - k)
        W[parent] = W.get(parent, 0) + k
    return W, sparam


def _partition(bones, steps, n):
    """Bone weights from nested 0..1 steps: w0 = 1-s0, w1 = s0(1-s1), ..., wN = s0..s(N-1)."""
    W = {}
    acc = np.ones(n)
    for i, bn in enumerate(bones):
        if i < len(steps):
            W[bn] = W.get(bn, 0) + acc * (1 - steps[i])
            acc = acc * steps[i]
        else:
            W[bn] = W.get(bn, 0) + acc
    return W


def spine_weights(P, head_from=None):
    """Torso chain by height: hips, spine, spine1, spine2, neck, head. head_from (n,) can override
    the neck/head boundary per vertex (the jaw line on the skin)."""
    z = P[:, 2]
    names = ["hips", "spine", "spine1", "spine2", "neck", "head"]
    knots = [S.J["spine"][2], S.J["spine1"][2], S.J["spine2"][2], S.J["neck"][2], S.J["head"][2]]
    blends = [0.05, 0.05, 0.06, 0.035, 0.022]
    steps = [smooth(k - b, k + b, z) for k, b in zip(knots, blends)]
    if head_from is not None:
        steps[-1] = head_from
    return _partition(names, steps, len(P))


def _merge(dst, src, k):
    for bn, w in src.items():
        dst[bn] = dst.get(bn, 0) + w * k
    return dst


def arm_weights(P, s):
    sf = "L" if s > 0 else "R"
    sh, el, wr = S.side(S.SH, s), S.side(S.ELB, s), S.side(S.WRI, s)
    d, w, n = hand_frame(s)
    kn = wr + d * 0.088
    J = [S.side(np.array([0.06, 0.006, 1.372]), s), sh, el, wr, kn]
    W, sp = _chain(P, J, [f"shoulder_{sf}", f"upperarm_{sf}", f"forearm_{sf}", f"hand_{sf}"], [0.05, 0.045, 0.03])
    # Distal half of the forearm follows the twist bone (no candy-wrap when the hand rolls).
    seg = np.linalg.norm(wr - el)
    s_el = np.linalg.norm(J[1] - J[0]) + np.linalg.norm(el - sh)
    tw = smooth(s_el + 0.25 * seg, s_el + 0.85 * seg, sp)
    fa = W.get(f"forearm_{sf}", 0)
    W[f"forearmTwist_{sf}"] = fa * tw
    W[f"forearm_{sf}"] = fa * (1 - tw)
    return W


def finger_weights(P, s, W):
    """Split the hand weight among the fingers by nearest finger segment beyond the knuckles."""
    sf = "L" if s > 0 else "R"
    fp = finger_points(s)
    hw = W.get(f"hand_{sf}", np.zeros(len(P)))
    best = np.full(len(P), np.inf)
    owner = np.full(len(P), -1)
    segs = []
    for name in ("index", "middle", "ring", "pinky"):
        p0, p1, p2 = fp[name]
        segs += [(f"{name}1_{sf}", p0, p1), (f"{name}2_{sf}", p1, p2)]
    t = fp["thumb"]
    segs += [(f"thumb1_{sf}", t[0], t[1]), (f"thumb2_{sf}", t[1], t[2]), (f"thumb3_{sf}", t[2], t[3])]
    tpar = np.zeros(len(P))
    for k, (bn, a, b) in enumerate(segs):
        ab = b - a
        tt = np.clip(((P - a) @ ab) / (ab @ ab), 0, 1.3)
        dist = np.linalg.norm(P - (a + tt[:, None] * ab), axis=1)
        better = dist < best
        best = np.where(better, dist, best)
        owner = np.where(better, k, owner)
        tpar = np.where(better, tt, tpar)
    out = dict(W)
    out[f"hand_{sf}"] = hw.copy()
    for k, (bn, a, b) in enumerate(segs):
        m = owner == k
        if not m.any():
            continue
        first = bn.endswith(f"1_{sf}") and not bn.startswith("thumb1")
        # Proximal bones blend from the hand across the knuckle; later bones from their parent.
        if bn.startswith("thumb1"):
            k_on = smooth(-0.1, 0.35, tpar)
        elif first:
            k_on = smooth(-0.18, 0.12, tpar)
        else:
            k_on = smooth(-0.22, 0.22, tpar)
        kw = np.where(m & (best < 0.03), k_on, 0.0) * hw
        if first or bn.startswith("thumb1"):
            out[f"hand_{sf}"] = out[f"hand_{sf}"] - kw
            out[bn] = out.get(bn, 0) + kw
        else:
            par = segs[k - 1][0]
            moved = np.minimum(kw, out.get(par, np.zeros(len(P))))
            out[par] = out.get(par, 0) - moved
            out[bn] = out.get(bn, 0) + moved
    return out


def leg_weights(P, s, hip_blend=0.055):
    sf = "L" if s > 0 else "R"
    J = [S.side(S.HIP, s) + np.array([0, 0, 0.06]), S.side(S.HIP, s), S.side(S.KNEE, s), S.side(S.ANKLE, s), S.side(S.BALL, s), S.side(S.TOE, s)]
    W, sp = _chain(P, J[1:], [f"thigh_{sf}", f"shin_{sf}", f"foot_{sf}", f"toe_{sf}"], [0.045, 0.03, 0.02])
    # The top of the thigh blends into the pelvis along a hip crease (front lower than the side).
    z = P[:, 2]
    crease = S.HIP[2] - 0.02 + 0.03 * smooth(0.0, 0.08, np.abs(P[:, 0]) - 0.04) + 0.02 * smooth(0.0, 0.08, P[:, 1])
    k = smooth(crease - hip_blend * 0.4, crease + hip_blend, z)
    for bn in list(W):
        W[bn] = W[bn] * (1 - k)
    W["hips"] = W.get("hips", 0) + k
    return W


def finalize(W, n, maxinf=4):
    """Normalise to 1 with at most maxinf influences per vertex. Returns dict bone -> array."""
    names = [k for k in W if np.any(np.asarray(W[k]) > 1e-4)]
    M = np.stack([np.clip(np.broadcast_to(np.asarray(W[k], dtype=float), (n,)), 0, None) for k in names], axis=1)
    if M.shape[1] > maxinf:
        idx = np.argsort(-M, axis=1)[:, maxinf:]
        np.put_along_axis(M, idx, 0.0, axis=1)
    tot = M.sum(axis=1, keepdims=True)
    M = np.where(tot > 1e-8, M / np.maximum(tot, 1e-8), 0)
    return {nm: M[:, i] for i, nm in enumerate(names)}


def lift(col, arm_ob, dz):
    """Raise every mesh vertex and every bone but the root by dz (the sandal sole)."""
    for ob in col.all_objects:
        if ob.type == "MESH":
            me = ob.data
            a = np.zeros(len(me.vertices) * 3)
            me.vertices.foreach_get("co", a)
            a = a.reshape(-1, 3)
            a[:, 2] += dz
            me.vertices.foreach_set("co", a.reshape(-1))
            me.update()
    vl = bpy.context.view_layer
    prev = vl.objects.active
    vl.objects.active = arm_ob
    bpy.ops.object.mode_set(mode="EDIT")
    for b in arm_ob.data.edit_bones:
        if b.name == "root":
            continue
        b.head.z += dz
        b.tail.z += dz
    bpy.ops.object.mode_set(mode="OBJECT")
    vl.objects.active = prev if prev and prev.name in vl.objects else arm_ob


def apply_weights(ob, W, arm_ob):
    """Write vertex groups and an Armature modifier, parent to the armature (identity transform)."""
    for vg in list(ob.vertex_groups):
        ob.vertex_groups.remove(vg)
    for bn, w in W.items():
        vg = ob.vertex_groups.new(name=bn)
        idx = np.nonzero(w > 1e-4)[0]
        for i in idx:
            vg.add([int(i)], float(w[i]), "REPLACE")
    for m in list(ob.modifiers):
        if m.type == "ARMATURE":
            ob.modifiers.remove(m)
    mod = ob.modifiers.new("Armature", "ARMATURE")
    mod.object = arm_ob
    ob.parent = arm_ob
    ob.matrix_parent_inverse.identity()
