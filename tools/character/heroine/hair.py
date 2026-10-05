"""Her hair: shoulder-length, wavy, warm chestnut, a side-swept fringe, under a straw hat.

Built from layered clump meshes (flattened, tapering tubes with rounded tips) over a scalp cap.
Each clump grows from a root on the scalp by a simple combing march: it lies along the skull
(pushed out to its layer's offset) while gravity and the comb direction bend it, then falls past
the ears to the shoulders, resting on the shirt, with S-waves and an outward flick at the tip.
Normals blend toward the hair mass (a soft volume round the head) so the toon light falls on the
whole shape cleanly; inner layers are darker. Eight short bone chains carry wind sway.
"""
import numpy as np

from . import head, rig, shape
from .common import (assign_material, frames_along, gauss, hash1, make_mesh, material, norm, orient,
                     set_colors, set_float, set_normals, smooth, srgb, tube)

HC = head.HC
PART_X = -0.030           # side part on her right (x < 0), the fringe sweeps to her left
CAP = 0.0045              # scalp cap above the skin
NR = 10                   # vertices round each lock
HAIR = "#6f4630"
HAIR_LT = "#9e6c48"
HAIR_DK = "#3e2517"


def scalp_point(dirs, off):
    """Points on the head skin along unit directions from the skull centre, pushed out by off."""
    r = shape.radial_hit(head.skin_field, HC, dirs, rmax=0.2, steps=70, iters=20)
    return HC + dirs * (r + off)[:, None] if np.ndim(off) else HC + dirs * (r + off)[:, None]


def shell_push(P, off):
    """Push points out of the head/neck/torso shell at distance off (keeps hair off the skin)."""
    P = np.array(P, dtype=float)
    for _ in range(3):
        d = head.skin_field(P)
        inside = d < off
        if not inside.any():
            break
        # Finite-difference gradient of the skin field.
        e = 1e-3
        g = np.stack([(head.skin_field(P + np.array([e, 0, 0])) - head.skin_field(P - np.array([e, 0, 0]))),
                      (head.skin_field(P + np.array([0, e, 0])) - head.skin_field(P - np.array([0, e, 0]))),
                      (head.skin_field(P + np.array([0, 0, e])) - head.skin_field(P - np.array([0, 0, e])))], axis=1)
        g = norm(g)
        P = np.where(inside[:, None], P + g * (off - d)[:, None], P)
    return P


def hairline_z(theta):
    """Hairline height (head-local) round the head: theta 0 front, + toward her left."""
    th = np.asarray(theta, dtype=float)
    a = np.abs(np.angle(np.exp(1j * th)))  # 0 front .. pi back
    # Forehead, temples, sideburn in front of the ear, behind the ear, nape.
    return np.interp(a, [0.0, 0.5, 0.95, 1.25, 1.55, 1.9, 2.4, np.pi], [0.066, 0.058, 0.030, 0.000, -0.010, -0.040, -0.072, -0.080])


def cap_mesh():
    """Scalp cap: a spherical grid from the crown down to the hairline, 4.5 mm off the skin."""
    C, R = 40, 18
    th = np.linspace(0, 2 * np.pi, C, endpoint=False)
    # Polar angle of the hairline per column: bisect the height the skin ray hits.
    zt = hairline_z(th) - 0.004
    lo, hi = np.full(C, 0.05), np.full(C, np.pi * 0.9)
    for _ in range(22):
        mid = 0.5 * (lo + hi)
        d = np.stack([np.sin(mid) * np.sin(th), -np.sin(mid) * np.cos(th), np.cos(mid)], axis=1)
        z = scalp_point(d, 0.0)[:, 2] - HC[2]
        above = z > zt
        lo = np.where(above, mid, lo)
        hi = np.where(above, hi, mid)
    phis = 0.5 * (lo + hi)
    rows = []
    for k in range(R):
        f = 0.04 + 0.96 * (k / (R - 1))
        ph = phis * f
        d = np.stack([np.sin(ph) * np.sin(th), -np.sin(ph) * np.cos(th), np.cos(ph)], axis=1)
        # The edge rows tuck down onto the skin (no step at the hairline).
        off = CAP * (1 - 0.8 * smooth(0.82, 1.0, f))
        rows.append(scalp_point(d, off))
    rings = np.stack(rows)
    V, F = tube(rings, closed=True, cap_start=True)
    F = orient(V, F, lambda Cn: np.broadcast_to(HC, Cn.shape))
    return V, F


# ---------------------------------------------------------------- strands


def grow(root, comb, length, layer_off, fall_z, out_k=0.27, steps=None, wave=(0.010, 0.006, 0.075, 0.0), flick=0.016, seed=0.0, lift=0.0):
    """March a strand from root: along the skull toward comb, then down; returns (n,3) points."""
    n = steps or max(12, int(length / 0.0125))
    ds = length / (n - 1)
    p = np.array(root, float)
    d = norm(np.asarray(comb, float))
    pts = [p.copy()]
    for k in range(1, n):
        s = k / (n - 1)
        # Below the fall line gravity wins; above it the hair follows the comb over the skull.
        zrel = p[2] - HC[2]
        g = smooth(fall_z + 0.03, fall_z - 0.02, zrel)
        down = np.array([0, 0, -1.0])
        # Hanging hair drifts a little outward (volume) from the head's axis.
        ax = np.array([0, 0.012, p[2]])
        outv = p - ax
        outv[2] = 0
        outv = norm(outv) if np.linalg.norm(outv) > 1e-6 else np.zeros(3)
        want = norm(d * (1 - 0.6 * g) + down * (0.25 + 1.4 * g) + outv * out_k * g + np.array([0, 0, lift]) * (1 - g))
        d = norm(d * 0.72 + want * 0.28)
        p = p + d * ds
        p = shell_push(p[None, :], layer_off + 0.002 * s)[0]
        pts.append(p.copy())
    P = np.array(pts)
    # Keep off the shoulders and back: the shirt is ~2 cm off the skin there.
    P = _off_torso(P, 0.026)
    # Waves (sideways and in/out), growing down the length, and the outward flick at the tip.
    T, Nn, B = frames_along(P)
    s = np.linspace(0, 1, len(P))
    a_side, a_out, lam, ph = wave
    L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
    ramp = smooth(0.25, 0.6, s)
    ax_pts = np.stack([np.zeros(len(P)), np.full(len(P), 0.012), P[:, 2]], axis=1)
    O = P - ax_pts
    O[:, 2] *= 0.3
    O = norm(O - T * np.einsum("ij,ij->i", O, T)[:, None])
    Wd = norm(np.cross(T, O))
    ang = 2 * np.pi * L / lam + ph
    P = P + Wd * (a_side * ramp * np.sin(ang))[:, None] + O * (a_out * ramp * np.cos(ang * 0.5 + seed))[:, None]
    P = P + O * (flick * smooth(0.78, 1.0, s) ** 1.6)[:, None]
    P = _off_torso(P, 0.022)
    return P


def _off_torso(P, off):
    d = shape.torso_sdf(P)
    bad = d < off
    if not bad.any():
        return P
    e = 1e-3
    g = np.stack([shape.torso_sdf(P + np.array([e, 0, 0])) - shape.torso_sdf(P - np.array([e, 0, 0])),
                  shape.torso_sdf(P + np.array([0, e, 0])) - shape.torso_sdf(P - np.array([0, e, 0])),
                  shape.torso_sdf(P + np.array([0, 0, e])) - shape.torso_sdf(P - np.array([0, 0, e]))], axis=1)
    g = norm(g)
    return np.where(bad[:, None], P + g * (off - d)[:, None], P)


def clump(path, w0, h0, n_ring=None, taper0=0.55, root_flat=0.6):
    n_ring = n_ring or NR
    """Tapered, flattened tube along path, rounded tip; flat side facing out of the hair mass."""
    P = np.asarray(path, float)
    m = len(P)
    T, _, _ = frames_along(P)
    ax_pts = np.stack([np.zeros(m), np.full(m, 0.012), P[:, 2]], axis=1)
    O = P - ax_pts
    O[:, 2] *= 0.3
    O = norm(O - T * np.einsum("ij,ij->i", O, T)[:, None])
    Wd = norm(np.cross(T, O))
    s = np.linspace(0, 1, m)
    # Full through the body, tapering toward the end, then a rounded (elliptical) tip.
    tip = np.sqrt(np.clip(1 - ((s - 0.86) / 0.14).clip(0, None) ** 2, 0, 1))
    w = w0 * (0.84 + 0.16 * smooth(0.0, 0.25, s)) * (1 - 0.62 * smooth(taper0, 0.95, s)) * tip
    w = np.maximum(w, w0 * 0.03)
    h = h0 * (1 - 0.35 * s) * (1 - 0.5 * smooth(taper0, 0.95, s)) * tip
    th = np.linspace(0, 2 * np.pi, n_ring, endpoint=False)
    rings = []
    for i in range(m):
        # The outside of a clump is rounder than its underside.
        c, sn = np.cos(th), np.sin(th)
        x = w[i] * c
        y = h[i] * np.where(sn > 0, sn, sn * 0.7)
        rings.append(P[i] + np.outer(x, Wd[i]) + np.outer(y, O[i]))
    rings = np.stack(rings)
    # Rounded tip: the last ring collapses to its centre.
    rings[-1] = P[-1]
    V, F = tube(rings, closed=True, cap_start=True)
    F = orient(V, F, lambda C: _nearest(P, C))
    return V, F, O, s


def _nearest(P, C):
    out = np.zeros_like(C)
    for k in range(len(C)):
        out[k] = P[np.argmin(np.linalg.norm(P - C[k], axis=1))]
    return out


def _dir(theta, phi):
    return np.array([np.sin(phi) * np.sin(theta), -np.sin(phi) * np.cos(theta), np.cos(phi)])


# ---------------------------------------------------------------- the style


def _wave(theta, amp_side=0.0135, amp_out=0.0085, lam=0.100):
    """Waves whose phase drifts slowly round the head, so neighbouring locks wave together."""
    return (amp_side, amp_out, lam, 1.1 * theta)


def style():
    """List of clump specs: (group, root, comb, length, w0, h0, layer, fall_z, wave, flick, dark)."""
    S = []
    R = lambda th, ph, off: scalp_point(_dir(th, ph)[None, :], off)[0]
    # (The side-swept fringe is drawn separately, see FRINGE.)
    # Few, thick locks (a clean toon silhouette): 2 face-framing, 4 over the ears, 5 broad back
    # locks and 3 darker under-layer locks filling the nape; 14 long locks plus the 4-lock fringe.
    # Face-framing locks in front of the ears, to the jaw line.
    for s in (1, -1):
        th = 1.06
        root = R(s * th, 0.66, CAP + 0.004)
        comb = norm(np.array([s * 0.10, -0.30, -1.0]))
        S.append(("side" + ("L" if s > 0 else "R"), root, comb, 0.205, 0.036, 0.0105, CAP + 0.010, 0.03,
                  _wave(s * th, 0.0080, 0.0050, 0.095), 0.010, 0.0))
    # Over the ears, falling to the shoulders.
    for s in (1, -1):
        for j, th in enumerate([1.46, 1.84]):
            root = R(s * th, 0.70 - 0.04 * j, CAP + 0.004)
            comb = norm(np.array([s * 0.30, 0.30, -1.0]))
            S.append(("ear" + ("L" if s > 0 else "R"), root, comb, 0.285 + 0.012 * j, 0.055, 0.0135,
                      CAP + 0.014 + 0.002 * j, 0.012, _wave(s * th), 0.022, 0.0))
    # Back: broad overlapping locks round the back of the head to the shoulders.
    for j in range(5):
        u = j / 4
        th = 2.28 + (2 * np.pi - 4.56) * u      # from her left-back round to her right-back
        root = R(th, 0.80, CAP + 0.004)
        comb = norm(np.array([np.sin(th) * 0.22, 0.45, -1.0]))
        ln = 0.300 + 0.012 * np.cos(u * np.pi * 2.0 + 0.6) + 0.008 * hash1(j * 3.1)
        S.append(("back", root, comb, ln, 0.064, 0.0155, CAP + 0.019 + 0.0015 * (j % 2), 0.0, _wave(th), 0.024, 0.0))
    # Under layer: shorter, darker, filling the nape and behind the ears.
    for j in range(3):
        u = j / 2
        th = 1.95 + (2 * np.pi - 3.9) * u
        root = R(th, 1.02, CAP + 0.002)
        comb = norm(np.array([np.sin(th) * 0.3, 0.35, -1.0]))
        S.append(("under", root, comb, 0.220 + 0.012 * hash1(j * 7.7), 0.066, 0.0110, CAP + 0.008, 0.0,
                  _wave(th, 0.007, 0.004), 0.012, 1.0))
    return S


# Side-swept fringe, head-local (x her left, z up): root near the part on her right, a control
# point, and the tip. The tips rest along the brow line; the last locks sweep down her left
# temple outside the sunglasses. Width, thickness, layer.
FRINGE = [
    # One soft side-swept sheet: wide overlapping locks whose tips follow a smooth curve from
    # high over her right brow, across above the frames, down past her left temple.
    # Four thick overlapping locks.
    ((-0.033, 0.090), (-0.026, 0.062), (-0.011, 0.045), 0.030, 0.0062, 0),
    ((-0.017, 0.094), (0.003, 0.058), (0.023, 0.037), 0.034, 0.0066, 1),
    ((0.002, 0.094), (0.036, 0.054), (0.055, 0.027), 0.033, 0.0068, 2),
    ((0.022, 0.091), (0.062, 0.042), (0.075, -0.020), 0.027, 0.0070, 0),
]


def fringe_path(root, ctrl, tip, n=16, lift=0.0042):
    """A fringe lock on the forehead shell: quadratic Bezier in (x, z), projected out from the
    skull centre onto the skin plus its cap and a little loft in the middle."""
    t = np.linspace(0, 1, n)
    xz = ((1 - t) ** 2)[:, None] * np.array(root) + (2 * (1 - t) * t)[:, None] * np.array(ctrl) + (t ** 2)[:, None] * np.array(tip)
    P = np.stack([xz[:, 0], np.full(n, -0.12), xz[:, 1]], axis=1)
    # Direction from the skull centre toward the forehead point; hit the skin, push out.
    d = norm(P - np.array([0, 0.02, 0.0]))
    r = shape.radial_hit(head.skin_field, HC + np.array([0, 0.02, 0.0]), d, rmax=0.25, steps=90, iters=20)
    off = CAP + lift * (0.6 + 0.8 * np.sin(np.pi * np.clip(t * 1.1, 0, 1)))
    return HC + np.array([0, 0.02, 0.0]) + d * (r + off)[:, None]


GROUPS = {
    # chain name: (groups it carries, representative spec index offset)
    "hairFringe": ("fringe",),
    "hairSideL": ("sideL",),
    "hairSideR": ("sideR",),
    "hairEarL": ("earL",),
    "hairEarR": ("earR",),
    "hairBackL": ("back+",),
    "hairBack": ("back0",),
    "hairBackR": ("back-",),
}


def build(col):
    specs = style()
    objs = []
    paths = []
    allV, allF, allC, allN, allW, meta = [], [], [], [], [], []
    vo = 0
    base, lt, dk = srgb(HAIR), srgb(HAIR_LT), srgb(HAIR_DK)
    specs = [("fringe", f, None, 0, f[3], f[4], f[5], 0, None, 0, 0.0) for f in FRINGE] + specs
    for k, (grp, root, comb, ln, w0, h0, off, fall, wave, flick, dark) in enumerate(specs):
        if grp == "fringe":
            (r0, c0, t0, _w, _h, layer) = root
            P = fringe_path(r0, c0, t0, lift=0.0032 + 0.0012 * layer)
            V, F, O, s = clump(P, w0, h0, taper0=0.42)
        else:
            P = grow(root, comb, ln, off, fall, wave=wave, flick=flick * 0.7, seed=k * 0.37)
            # Soft, rounded ends on the long locks (wavy hair, not spikes); the fringe stays pointed.
            V, F, O, s = clump(P, w0, h0, taper0=0.66 if grp in ("back", "earL", "earR", "under") else 0.55)
        paths.append((grp, P))
        # Albedo: per-clump variation, darker roots and inner layers, sun-lightened ends.
        var = 0.9 + 0.2 * hash1(k * 5.3)
        nv = len(V)
        sv = np.concatenate([np.repeat(s, NR), [0.0]])[:nv]
        cc = base * var
        cc = cc[None, :] * (0.82 + 0.18 * smooth(0.0, 0.35, sv))[:, None]
        cc = cc * (1 - smooth(0.55, 1.0, sv)[:, None]) + (lt * var)[None, :] * smooth(0.55, 1.0, sv)[:, None] * 0.55 + cc * smooth(0.55, 1.0, sv)[:, None] * 0.45
        # Lock separation: each flattened clump darkens toward its two side edges, so neighbouring
        # locks read as painted strands instead of one sheet.
        cs = np.concatenate([np.tile(np.abs(np.cos(np.linspace(0, 2 * np.pi, NR, endpoint=False))), len(s)), [0.0]])[:nv]
        cc = cc * (1 - 0.22 * smooth(0.55, 1.0, cs) * smooth(0.05, 0.25, sv))[:, None]
        if dark:
            cc = cc * 0.72 + dk[None, :] * 0.1
        else:
            # A painted sheen band across the hair mass below the hat brim (zig-zag, outer side).
            rv = V - np.array([0, 0.012, 0])
            thv = np.arctan2(rv[:, 0], -rv[:, 1])
            zb = 1.512 + 0.010 * np.sin(thv * 9.0 + 0.5) + 0.004 * np.sin(thv * 23.0)
            band = np.exp(-(((V[:, 2] - zb) / 0.012) ** 2))
            ring = np.concatenate([np.tile(np.sin(np.linspace(0, 2 * np.pi, NR, endpoint=False)), len(s)), [0.0]])[:nv]
            band *= smooth(-0.2, 0.6, ring)
            cc = cc * (1 + 0.32 * band)[:, None]
        allV.append(V)
        allF += [tuple(i + vo for i in f) for f in F]
        allC.append(cc)
        allW.append(np.clip((sv - 0.2) / 0.8, 0, 1) ** 1.5)
        meta.append((grp, vo, nv, P, s))
        vo += nv
    V = np.vstack(allV)
    C = np.vstack(allC)
    ob = make_mesh("hair", V, allF, col)
    # Shaped normals: mostly the hair mass (a soft volume round the head), a little of the clump.
    me = ob.data
    n = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", n)
    Ng = n.reshape(-1, 3)
    axis = np.stack([np.zeros(len(V)), np.full(len(V), 0.016), np.clip(V[:, 2], 1.30, HC[2] + 0.02)], axis=1)
    Nv = norm(V - axis + np.array([0, 0, 0.0]) + (V[:, 2:3] > HC[2] + 0.02) * (V - HC) * 0.0)
    Nv[:, 2] += 0.25 * smooth(HC[2] - 0.1, HC[2] + 0.06, V[:, 2])
    Nv = norm(Nv)
    set_normals(ob, norm(Nv * 0.68 + Ng * 0.32))
    set_colors(ob, C)
    set_float(ob, "_wind", np.concatenate(allW))
    ob["part"] = "hair"
    assign_material(ob, material("hair", HAIR))
    # Scalp cap (darker, rigid on the head).
    Vc, Fc = cap_mesh()
    cap = make_mesh("hair_cap", Vc, Fc, col)
    me = cap.data
    n = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", n)
    set_normals(cap, norm(norm(Vc - HC) * 0.6 + n.reshape(-1, 3) * 0.4))
    set_colors(cap, np.tile(base * 0.8, (len(Vc), 1)))
    set_float(cap, "_wind", np.zeros(len(Vc)))
    cap["part"] = "hair"
    assign_material(cap, material("hair", HAIR))
    _register_chains(meta)
    global CLUMPS
    CLUMPS = meta
    return {"hair": ob, "hair_cap": cap}


CLUMPS = []
CHAINS = {}


def _chain_of(grp, P):
    if grp == "back":
        x = P[0, 0]
        return "hairBackL" if x > 0.03 else "hairBackR" if x < -0.03 else "hairBack"
    if grp == "under":
        return "hairBackL" if P[0, 0] > 0.02 else "hairBackR" if P[0, 0] < -0.02 else "hairBack"
    return {"fringe": "hairFringe", "sideL": "hairSideL", "sideR": "hairSideR", "earL": "hairEarL", "earR": "hairEarR"}[grp]


def _register_chains(meta):
    """One short chain per hair group, laid along its middle clump (3 bones from 30% of the length)."""
    CHAINS.clear()
    by = {}
    for (grp, vo, nv, P, s) in meta:
        by.setdefault(_chain_of(grp, P), []).append(P)
    for name, Ps in by.items():
        P = Ps[len(Ps) // 2]
        L = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(P, axis=0), axis=1))])
        u = np.array([0.25, 0.5, 0.75, 1.0]) * L[-1]
        pts = np.stack([np.interp(u, L, P[:, k]) for k in range(3)], axis=1)
        bones = rig.add_chain(name + "_", pts, "head")
        CHAINS[name] = (bones, pts)


def hair_weights(ob):
    """Head at the roots, then each clump's own chain bone by bone toward the tip."""
    V = np.array([v.co[:] for v in ob.data.vertices])
    n = len(V)
    W = {"head": np.ones(n)}
    if ob.name != "hair":
        return W
    W["head"] = np.zeros(n)
    for (grp, vo, nv, P, s) in CLUMPS:
        ch = _chain_of(grp, P)
        bones, pts = CHAINS[ch]
        sv = np.concatenate([np.repeat(s, NR), [0.0]])[:nv]
        # Fraction along the clump -> chain position (0.25, 0.5, 0.75 are the bone heads).
        steps = [smooth(0.18, 0.34, sv), smooth(0.42, 0.58, sv), smooth(0.66, 0.84, sv)]
        acc = np.ones(nv)
        names = ["head"] + bones
        for i, bn in enumerate(names):
            if i < len(steps):
                w = acc * (1 - steps[i])
                acc = acc * steps[i]
            else:
                w = acc
            W.setdefault(bn, np.zeros(n))
            W[bn][vo:vo + nv] += w
    return W
