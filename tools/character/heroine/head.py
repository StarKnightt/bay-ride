"""Her head, neck and upper chest as one welded skin piece, plus her ears.

The head is an analytic shape: horizontal cross-sections (half-width, front depth, back extent,
superellipse front) that give a soft oval face with a gently tapering jaw and a small rounded chin,
with soft sculpted features added on top (brow, a small upturned nose, cheeks, lips, chin pad). It
is sampled by rays from the skull centre on a grid that is dense across the face, then welded to a
neck and upper-chest tube sampled from the torso surface (shape.torso_sdf), so the jaw blends into
the neck with a soft fillet and there is no seam anywhere on the visible skin.

The face itself is flat-ish and smooth: eyes, brows, nose shade, lips and blush are painted by the
game's face shader in face-plane coordinates (FACE below, exported in the glTF extras), and the face
normals are blended toward an ellipsoid so the toon light and shadow on it are clean shapes.
"""
import math

import numpy as np

from . import shape
from .common import (assign_material, catmull, gauss, make_mesh, material, norm, orient, set_colors,
                     set_float, set_normals, smax, smin, smooth, srgb, tube)

HC = shape.HEAD_C

# z (head-local), half-width W (front-view outline), front depth F of the face plane at the
# midline (nose and lips are added on top), back extent B (below the ear it traces the jaw line
# from the chin back up to the jaw angle), front and back superellipse exponents (the jaw section
# is a U that stays wide toward its back).
HEADT = [
    [-0.1340, 0.0480, 0.0450, 0.0300, 2.0, 2.15],
    [-0.1220, 0.0590, 0.0675, 0.0400, 2.0, 2.15],
    [-0.1120, 0.0625, 0.0784, 0.0450, 2.05, 2.15],
    [-0.1020, 0.0640, 0.0851, 0.0480, 2.15, 2.15],
    [-0.0920, 0.0505, 0.0877, 0.0520, 2.2, 2.15],
    [-0.0800, 0.0515, 0.0888, 0.0580, 2.3, 2.15],
    [-0.0680, 0.0560, 0.0902, 0.0650, 2.45, 2.15],
    [-0.0540, 0.0622, 0.0906, 0.0760, 2.6, 2.15],
    [-0.0400, 0.0684, 0.0906, 0.0860, 2.75, 2.15],
    [-0.0230, 0.0740, 0.0905, 0.0935, 2.75, 2.15],
    [-0.0050, 0.0763, 0.0905, 0.0980, 2.7, 2.15],
    [0.0150, 0.0766, 0.0915, 0.1000, 2.5, 2.15],
    [0.0320, 0.0760, 0.0900, 0.1005, 2.35, 2.15],
    [0.0500, 0.0738, 0.0862, 0.0985, 2.25, 2.15],
    [0.0700, 0.0692, 0.0790, 0.0930, 2.15, 2.1],
    [0.0870, 0.0618, 0.0700, 0.0845, 2.1, 2.1],
    [0.1020, 0.0505, 0.0560, 0.0710, 2.05, 2.05],
    [0.1130, 0.0350, 0.0380, 0.0520, 2.0, 2.0],
    [0.1210, 0.0110, 0.0110, 0.0180, 2.0, 2.0],
]
Z0, Z1 = HEADT[0][0], HEADT[-1][0]

# Jaw: the head's underside is cut by a designed surface. Its lower border climbs from a small chin
# (menton) up to the jaw angle below the ear; on the midline the under-chin floor runs back level,
# dipping a little to the throat; behind the jaw and under the back of the skull it rises so the
# neck takes over (the occiput overhangs the nape).
MENTON = -0.1105
GONION_X, GONION_LIFT, JAW_P = 0.0475, 0.0375, 1.05


# The tables are drawn for a longer lower face; below the nose it is gathered up by LOWER (a
# shorter, softer mouth-to-chin span). zt maps a real head-local height to table height.
LOWER, ZK = 1.085, -0.036


def zt(z):
    return np.where(z < ZK, ZK + (z - ZK) * LOWER, z)


def zreal(z_table):
    return ZK + (z_table - ZK) / LOWER if z_table < ZK else z_table


def jaw_cut(x, y):
    ax = np.minimum(np.abs(x) / GONION_X, 1.45)
    lift = GONION_LIFT * ax ** JAW_P
    dip = -0.0065 * smooth(-0.068, -0.03, y) * (1 - smooth(0.0, 0.04, np.abs(x)))
    ramus = 0.022 * smooth(-0.004, 0.032, y)
    back = 0.046 * smooth(0.028, 0.072, y)
    return MENTON + lift + dip + ramus + back

# Face layout in head-local Blender coordinates (x her left, -y front, z up), shared with the
# face shader (converted to glTF in FACE_GLTF) and with the sculpted features below.
FACE = {
    "eye": {"x": 0.0318, "z": -0.0060, "hw": 0.0170, "hh": 0.0118, "tilt": 0.0013, "irx": 0.0083, "iry": 0.0099},
    "brow": {"x0": 0.0125, "x1": 0.0500, "z": 0.0198, "arch": 0.0045, "drop": 0.0030},
    "nose": {"z": -0.0410, "zb": -0.0470},
    "mouth": {"z": -0.0690, "hw": 0.0118},
    "blush": {"x": 0.0430, "z": -0.0330, "rx": 0.0150, "rz": 0.0085},
    "lens": {"x": 0.0332, "z": -0.0064, "hw": 0.0256, "hh": 0.0172, "n": 2.75, "flare": 0.13, "wrap": 0.30, "tilt": 0.10, "gap": 0.0128},
}


def _sections(z):
    s = catmull(HEADT, z)
    return s[:, 0], s[:, 1], s[:, 2], s[:, 3], s[:, 4]


def head_field(P):
    """Approximate signed distance of head-local points to the head shape (negative inside)."""
    P = np.asarray(P, dtype=float)
    x, y = P[:, 0], P[:, 1]
    z = zt(P[:, 2])
    zc = np.clip(z, Z0, Z1)
    W, F, B, pf, pb = _sections(zc)
    W = np.maximum(W, 1e-4)
    D = np.maximum((F + B) / 2, 1e-4)
    yc = (B - F) / 2
    u = np.abs(x) / W
    v = (y - yc) / D
    p = np.where(v < 0, pf, pb)
    g = np.sqrt(u ** p + v * v) - 1.0
    d = g * np.minimum(W, D)
    # Past the ends of the table (above the crown, below the chin): outside.
    d = d + np.maximum(Z0 - z, 0) * 2 + np.maximum(z - Z1, 0) * 2
    # The jaw: a soft-edged cut along the designed underside.
    return smax(d, jaw_cut(x, y) - z, 0.0055)


def features(P):
    """Soft sculpted features (outward offset in metres) at head-local points on the surface."""
    x, y = P[:, 0], P[:, 1]
    z = zt(P[:, 2])
    ax = np.abs(x)
    front = smooth(-0.035, -0.07, y)
    b = np.zeros(len(P))
    # Brow: a soft ridge over the eyes, gone by the temples.
    b += 0.0016 * gauss(z, 0.022, 0.010) * (1 - smooth(0.045, 0.064, ax))
    # Eye area sits a touch flatter, so the brow and cheek frame the painted eyes.
    b -= 0.0021 * gauss(ax, FACE["eye"]["x"], 0.017) * gauss(z, FACE["eye"]["z"], 0.012)
    # Nose: a low narrow bridge rising to a small, slightly upturned, rounded tip, soft wings.
    nz = np.array([[0.010, 0.0], [0.000, 0.0008], [-0.010, 0.0021], [-0.020, 0.0040], [-0.029, 0.0064],
                   [-0.0355, 0.0088], [-0.0395, 0.0099], [-0.0425, 0.0092], [-0.0455, 0.0064],
                   [-0.0485, 0.0028], [-0.0520, 0.0005], [-0.0545, 0.0]])
    zz = np.clip(z, nz[-1, 0], nz[0, 0])
    h = np.interp(-zz, -nz[:, 0], nz[:, 1])
    h = np.where((z > nz[0, 0]) | (z < nz[-1, 0]), 0.0, h)
    wx = np.interp(-zz, [-0.010, 0.0, 0.02, 0.036, 0.044, 0.052], [0.0060, 0.0042, 0.0045, 0.0062, 0.0074, 0.0095])
    b += h * np.exp(-((x / wx) ** 2))
    b += 0.0020 * gauss(ax, 0.0092, 0.0042) * gauss(z, -0.0455, 0.0042)
    # Philtrum, lips (soft upper lip, fuller lower lip), the dip under the lip, the chin pad.
    b -= 0.0004 * gauss(x, 0, 0.0035) * gauss(z, -0.0565, 0.004)
    b += 0.0029 * gauss(x, 0, 0.0130) * gauss(z, -0.0630, 0.0040)
    b -= 0.0008 * gauss(x, 0, 0.012) * gauss(z, -0.0690, 0.0016)
    b += 0.0032 * gauss(x, 0, 0.0108) * gauss(z, -0.0748, 0.0044)
    b -= 0.0012 * gauss(x, 0, 0.0130) * gauss(z, -0.0835, 0.0036)
    b += 0.0030 * gauss(x, 0, 0.0128) * gauss(z, -0.0970, 0.0075)
    # Cheeks: soft full apples below the eyes, gentle cheekbones; a faint temple hollow.
    b += 0.0026 * gauss(ax, 0.044, 0.016) * gauss(z, -0.036, 0.016)
    b += 0.0012 * gauss(ax, 0.058, 0.013) * gauss(z, -0.016, 0.012)
    b -= 0.0008 * gauss(ax, 0.070, 0.010) * gauss(z, 0.016, 0.012)
    return b * front


def skin_field(Pw):
    """The whole upper skin: head ∪ neck ∪ upper torso (world points), soft union."""
    Pw = np.asarray(Pw, dtype=float)
    dh = head_field(Pw - HC)
    dt = shape.torso_sdf(Pw)
    return smin(dh, dt, 0.013)


def _theta_cols(C, beta=0.5):
    s = np.arange(C) / C
    return 2 * np.pi * s - beta * np.sin(2 * np.pi * s)


def _row_warp(R):
    """Fractions 0..1 of the polar span for R rows, denser across the face (brow to chin)."""
    phi = np.linspace(0, 1, 2001)
    # Polar fraction of the front column: brow ~0.47, chin ~0.88 (of ~160 degrees).
    dens = 1.0 + 1.5 * smooth(0.36, 0.44, phi) * (1 - smooth(0.88, 0.95, phi)) + 0.5 * smooth(0.9, 1.0, phi)
    dens *= 1 - 0.45 * (1 - smooth(0.0, 0.3, phi))  # sparser over the crown (under the hat)
    cdf = np.concatenate([[0], np.cumsum((dens[1:] + dens[:-1]) / 2 * np.diff(phi))])
    cdf /= cdf[-1]
    return np.interp(np.linspace(0, 1, R), cdf, phi)


def _ray_dirs(theta, phi):
    return np.stack([np.sin(phi) * np.sin(theta), -np.sin(phi) * np.cos(theta), np.cos(phi)], axis=-1)


def build_bust(C=56, RH=42, RN=12):
    """Head + neck + upper chest skin piece. Returns (V, F, info)."""
    th = _theta_cols(C)
    # Seam under the head: just under the chin at the front, below the ear at the side, under the
    # occiput at the back. Found per column as the polar angle whose hit lands at that height.
    zs = -0.123 + 0.026 * (0.5 - 0.5 * np.cos(th)) + 0.008 * np.sin(th) ** 2
    lo = np.full(C, np.pi * 0.5)
    hi = np.full(C, np.pi * 0.995)
    for _ in range(26):
        mid = 0.5 * (lo + hi)
        d = _ray_dirs(th, mid)
        r = shape.radial_hit(skin_field, HC, d, rmax=0.2, steps=80, iters=16)
        zhit = (r[:, None] * d)[:, 2]
        above = zhit > zs
        lo = np.where(above, mid, lo)
        hi = np.where(above, hi, mid)
    phis = 0.5 * (lo + hi)

    w = _row_warp(RH)
    w = 0.035 + (1 - 0.035) * w  # first ring a little off the pole
    TH = np.broadcast_to(th, (RH, C))
    PH = w[:, None] * phis[None, :]
    D = _ray_dirs(TH, PH).reshape(-1, 3)
    r = shape.radial_hit(skin_field, HC, D, rmax=0.2, steps=90, iters=24)
    Pl = D * r[:, None]
    Pl = Pl + D * features(Pl)[:, None]
    head = (Pl + HC).reshape(RH, C, 3)

    # Neck and chest rows: horizontal rays from the neck/torso axis, per column azimuth.
    seam = head[-1]
    zseam = seam[:, 2]
    ax_y = lambda z: np.interp(z, [1.20, 1.36, 1.42, 1.50], [0.012, 0.024, 0.020, 0.012])
    alpha = np.arctan2(seam[:, 0], -(seam[:, 1] - ax_y(zseam)))
    zbot = 1.205 + 0.095 * (0.5 - 0.5 * np.cos(alpha)) + 0.03 * np.sin(alpha) ** 2
    rows = []
    for k in range(1, RN + 1):
        f = k / RN
        f = f ** 1.25  # finer just under the jaw
        z = zseam + (zbot - zseam) * f
        O = np.stack([np.zeros(C), ax_y(z), z], axis=1)
        Dh = np.stack([np.sin(alpha), -np.cos(alpha), np.zeros(C)], axis=1)
        rr = shape.radial_hit(skin_field, O, Dh, rmax=0.3, steps=120, iters=22)
        rows.append(O + Dh * rr[:, None])
    neck = np.stack(rows)
    rings = np.concatenate([head, neck], axis=0)
    V, F = tube(rings, closed=True)
    # Pole vertex at the crown with a triangle fan (rings run from the top down).
    pole = HC + np.array([0, 0.012, shape.radial_hit(skin_field, HC, np.array([[0, 0.0, 1.0]]))[0]])
    pi = len(V)
    V = np.vstack([V, pole])
    for c in range(C):
        F.append((pi, c, (c + 1) % C))

    def inside(Cn):
        ref = np.stack([np.zeros(len(Cn)), np.full(len(Cn), 0.016), Cn[:, 2]], axis=1)
        return np.where((Cn[:, 2] > HC[2] - 0.075)[:, None], HC[None, :], ref)

    F = orient(V, F, inside)
    info = {"C": C, "RH": RH, "RN": RN, "theta": th}
    return V, F, info


def face_normals(V, Ngeo):
    """Blend the geometric normals toward an egg around the skull across the face (clean toon light
    and shadow on the face), geometric on the jaw underside, the neck and everything behind."""
    L = V - HC
    # A broad, flat egg: the face reads as one gently rounded plane (anime), turning away only
    # toward its far edges.
    c = np.array([0.0, 0.040, -0.010])
    r = np.array([0.118, 0.128, 0.180])
    Ne = norm((L - c) / (r * r))
    x, y, z = L[:, 0], L[:, 1], L[:, 2]
    w = smooth(-0.02, -0.06, y) * smooth(-0.112, -0.085, z) * (1 - smooth(0.06, 0.09, z)) * (1 - smooth(0.055, 0.07, np.abs(x)) * 0.6)
    w = 0.92 * w
    return norm(Ngeo * (1 - w[:, None]) + Ne * w[:, None])


def ear(s):
    """One ear (s = +1 her left): a cupped leaf with a curled rim standing off the side of the
    head behind the jaw, mostly under her hair."""
    d0 = norm(np.array([[s * 1.0, 0.10, -0.19]]))
    r0 = shape.radial_hit(skin_field, HC, d0, rmax=0.15)[0]
    c = HC + d0[0] * r0                              # on the skin
    up = norm(np.array([0.0, 0.24, 1.0]))            # long axis tilted back
    out = norm(np.array([s * 1.0, 0.12, 0.0]))       # faces out, a little forward
    back = norm(np.cross(up, out))
    if back[1] < 0:
        back = -back
    N = 18
    t = np.linspace(0, 2 * np.pi, N, endpoint=False)
    # Egg outline (wider above, the lobe below), its front edge on the skin.
    a = 0.0250 * np.cos(t) + 0.0018 * np.cos(2 * t)
    bb = (0.0128 + 0.0022 * np.cos(t)) * np.sin(t) + 0.004
    edge = smooth(-0.9, 0.9, np.sin(t))              # 0 front edge .. 1 back edge (helix)
    rings = []
    # Ring 0 sunk into the head; then the rim, the inner fold, the bowl and the concha.
    for k, h, sink in [(1.0, -0.004, 1.0), (1.0, 0.0105, 0.0), (0.84, 0.0120, 0.0), (0.66, 0.0070, 0.0),
                       (0.42, 0.0036, 0.0), (0.18, 0.0020, 0.0)]:
        stand = h * (0.15 + 0.85 * edge) if sink == 0 else np.full(N, h)
        rings.append(c + np.outer(a * k, up) + np.outer(bb * k, back) + np.outer(stand, out))
    rings = np.stack(rings)
    V, F = tube(rings, closed=True, cap_end=True)
    inner = c - out * 0.03
    F = orient(V, F, lambda C: np.broadcast_to(inner, C.shape))
    return V, F


SKIN = "#f6d6c2"


def build(col=None):
    """Create the bust (head/neck/chest) and ear objects. Returns dict of objects + layout."""
    V, F, info = build_bust()
    ob = make_mesh("skin_bust", V, F, col)
    me = ob.data
    me.update()
    n = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", n)
    Ngeo = n.reshape(-1, 3)
    set_normals(ob, face_normals(V, Ngeo))
    L = V - HC
    base = srgb(SKIN)
    warm = srgb("#f3c4b0")
    col_ = np.tile(base, (len(V), 1))
    # A little warmth on the nose tip, the chin and around the ears (the rest is painted).
    k = 0.5 * gauss(L[:, 0], 0, 0.006) * gauss(L[:, 2], -0.04, 0.006) * smooth(-0.07, -0.095, L[:, 1])
    k += 0.25 * gauss(L[:, 0], 0, 0.012) * gauss(L[:, 2], -0.097, 0.008) * smooth(-0.06, -0.085, L[:, 1])
    col_ = col_ * (1 - k[:, None]) + warm * k[:, None]
    set_colors(ob, col_)
    set_float(ob, "_wind", np.zeros(len(V)))
    ob["part"] = "bust"
    assign_material(ob, material("face", SKIN))
    ears = []
    for s in (1, -1):
        Ve, Fe = ear(s)
        e = make_mesh("ear_" + ("L" if s > 0 else "R"), Ve, Fe, col)
        set_colors(e, np.tile(srgb("#f2c9b4"), (len(Ve), 1)))
        set_float(e, "_wind", np.zeros(len(Ve)))
        e["part"] = "ear"
        assign_material(e, material("skin", SKIN))
        ears.append(e)
    return {"bust": ob, "ears": ears, "info": info}


def to_gltf(p):
    """Blender (x, y, z) → glTF (x, z, -y)."""
    return [float(p[0]), float(p[2]), float(-p[1])]


def face_layout_gltf():
    """Face layout for the game's face shader, in glTF head-local metres: x her left, y up,
    z toward the front. Eye/brow/lens x are her left side (mirrored for the right)."""
    e, b, n, m, bl, l = (FACE[k] for k in ("eye", "brow", "nose", "mouth", "blush", "lens"))
    # Depth of the lens plane: clear of the brow, lashes and cheek around the lens outline.
    zs = []
    for a in np.linspace(0, 2 * np.pi, 32, endpoint=False):
        x = l["x"] + math.cos(a) * l["hw"] * 0.92
        z = l["z"] + math.sin(a) * l["hh"] * 0.92
        zs.append(_front_y(x, z) - 0.0055 - l["wrap"] * (x - l["x"]) + l["tilt"] * (z - l["z"]))
    yl = min(min(zs), _front_y(l["x"], l["z"]) - l["gap"])
    return {
        "headC": to_gltf(HC),
        "eye": {"x": e["x"], "y": e["z"], "hw": e["hw"], "hh": e["hh"], "tilt": e["tilt"], "irx": e["irx"], "iry": e["iry"]},
        "brow": {"x0": b["x0"], "x1": b["x1"], "y": b["z"], "arch": b["arch"], "drop": b["drop"]},
        "nose": {"y": zreal(n["z"]), "yb": zreal(n["zb"])},
        "mouth": {"y": zreal(m["z"]), "hw": m["hw"]},
        "blush": {"x": bl["x"], "y": bl["z"], "rx": bl["rx"], "ry": bl["rz"]},
        # Jaw line in table heights (see jaw_cut) and the lower-face remap back to real heights.
        "jaw": {"menton": MENTON, "gx": GONION_X, "lift": GONION_LIFT, "p": JAW_P, "zk": ZK, "lower": LOWER},
        "lens": {"x": l["x"], "y": l["z"], "hw": l["hw"], "hh": l["hh"], "n": l["n"], "flare": l["flare"],
                 "wrap": l["wrap"], "tilt": l["tilt"], "z": float(-yl)},
    }


def _front_y(x, z):
    """Head-local y of the front skin surface at (x, z) (negative = in front)."""
    d = np.array([[x, -1.0, z]])
    d[:, 1] = -1.0
    O = HC + np.array([x, 0.0, z])
    r = shape.radial_hit(skin_field, O, np.array([[0.0, -1.0, 0.0]]), rmax=0.15, steps=60, iters=24)[0]
    p = np.array([[x, -r, z]])
    return float(-r - features(p)[0])
