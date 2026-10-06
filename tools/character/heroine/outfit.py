"""Her outfit, each piece its own mesh fitted to the body surfaces in shape.py (Blender frame):

- coral camisole: the torso surface + 2.5 mm from the waist (tucked into the shorts) to a soft
  neckline across the bust, draped from the bust; thin straps over the shoulders;
- sage linen shirt, open, knotted at the waist: a loose shell hanging from the shoulders, bust and
  shoulder blades, the fronts gathered into a knot with two short tails, a soft collar, sleeves
  rolled to just above the elbow; drape folds;
- cream high-waisted wide shorts: a hip shell welded through a crotch seam to two A-line legs,
  waistband, belt loops, button, pleats and pocket lines, rolled cuffs at mid-thigh;
- tan strap sandals: sole, toe strap, instep strap, ankle strap with a buckle, heel strap;
- wide straw hat with a teal ribbon, a bow and two tails, tilted back a little;
- tortoiseshell sunglasses: rims on the exact lens outline the face shader tints, a keyhole
  bridge, end pieces and temples back over the ears.
"""
import math

import numpy as np

from . import body, hair, head, rig, shape
from .common import (assign_material, frames_along, gauss, hash1, make_mesh, material, norm, orient,
                     set_colors, set_float, set_normals, smooth, spline_points, srgb, tube, vnoise3)

S = shape
HC = head.HC
COL = {
    "shirt": "#b9d0b3", "shirt_in": "#a2b99d", "cami": "#e9846a", "shorts": "#efe3cb", "shorts_sh": "#d9c9aa",
    "leather": "#b07a4a", "sole": "#7a4d2f", "bed": "#d2a979", "metal": "#c9a35a", "straw": "#e2c58c",
    "straw_dk": "#c9a46a", "ribbon": "#3e9aae", "ribbon_dk": "#2f7c8e", "tort": "#4a2614", "amber": "#a8662c",
}


def _axis_y(z):
    return S.torso_axis(z)


def torso_r(theta, z, off=0.0):
    """Radius of the torso surface (+ off) from the torso axis, along horizontal angle theta
    (0 = front, + toward her left), at height z. Arrays broadcast."""
    shp = np.broadcast(theta, z).shape
    th = np.broadcast_to(np.asarray(theta, float), shp).ravel()
    zz = np.broadcast_to(np.asarray(z, float), shp).ravel()
    of = np.broadcast_to(np.asarray(off, float), shp).ravel()
    O = np.stack([np.zeros_like(zz), _axis_y(zz), zz], axis=1)
    D = np.stack([np.sin(th), -np.cos(th), np.zeros_like(th)], axis=1)
    r = S.radial_hit(S.torso_sdf, O, D, rmax=0.35, steps=110, iters=20)
    return (r + of).reshape(shp)


def ring_pts(theta, z, r):
    th = np.asarray(theta, float)
    zz = np.broadcast_to(np.asarray(z, float), th.shape)
    rr = np.broadcast_to(np.asarray(r, float), th.shape)
    return np.stack([rr * np.sin(th), _axis_y(zz) - rr * np.cos(th), zz], axis=-1)


def push_out(P, sdf, off, iters=4):
    """Move points out of a signed-distance field to at least `off`, along its gradient."""
    P = np.array(P, dtype=float)
    e = 1e-3
    for _ in range(iters):
        d = sdf(P)
        bad = d < off
        if not bad.any():
            break
        Q = P[bad]
        g = np.stack([sdf(Q + [e, 0, 0]) - sdf(Q - [e, 0, 0]), sdf(Q + [0, e, 0]) - sdf(Q - [0, e, 0]),
                      sdf(Q + [0, 0, e]) - sdf(Q - [0, 0, e])], axis=1)
        P[bad] = Q + norm(g) * (off - d[bad])[:, None]
    return P


def drape_down(R, Z, slope):
    """Cloth hangs: going down a column (rows top→bottom), the radius may shrink by at most
    slope per metre of drop. R, Z: (rows, cols)."""
    R = R.copy()
    for k in range(1, R.shape[0]):
        dz = np.abs(Z[k - 1] - Z[k])
        R[k] = np.maximum(R[k], R[k - 1] - slope * dz)
    return R


def _mk(name, V, F, colors, col, part, kind, wind=None, mat=None, normals=None):
    ob = make_mesh(name, V, F, col)
    set_colors(ob, colors)
    set_float(ob, "_wind", wind if wind is not None else np.zeros(len(V)))
    if normals is not None:
        set_normals(ob, normals)
    ob["part"] = part
    ob["cloth"] = kind
    assign_material(ob, material(mat or kind, "#888888"))
    return ob


def _tile(hexs, n):
    return np.tile(srgb(hexs), (n, 1))


# ---------------------------------------------------------------- shorts (built first: the shirt
# hangs outside them)

SH_TOP, SH_CROTCH, SH_HEM = 1.072, 0.792, 0.630


def _shorts_hip_r(th, z):
    """Hip shell radius: snug at the waist, roomy over the hips, hanging from the seat."""
    ease = 0.0045 + 0.0075 * smooth(1.05, 0.93, z)
    return torso_r(th, z, ease)


def shorts_profile(th, z):
    """Shorts surface radius (from the torso axis) at angles th for z in the hip shell range."""
    return _shorts_hip_r(th, z)


def shorts(col):
    N = 48
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)
    zs = np.concatenate([np.linspace(SH_TOP, 0.94, 7), np.linspace(0.925, SH_CROTCH, 7)])
    Z = np.repeat(zs[:, None], N, axis=1)
    TH = np.broadcast_to(th, Z.shape)
    Rr = _shorts_hip_r(TH, Z)
    Rr = drape_down(Rr, Z, 0.22)
    # Front pleats, two each side, fading down from the waistband.
    for sgn in (1, -1):
        for xc in (0.045, 0.075):
            tc = math.asin(min(0.95, xc / 0.13)) * sgn
            Rr += 0.0026 * gauss(TH, tc, 0.05) * smooth(1.07, 1.03, Z) * smooth(0.86, 1.0, Z)
    hip = ring_pts(TH, Z, Rr)                       # rows x N
    # Crotch seam under the body (x = 0) from the back centre to the front centre.
    fc, bc = hip[-1, 0], hip[-1, N // 2]
    K = 7
    t = np.linspace(0, 1, K + 2)[1:-1]
    seam = np.stack([np.zeros(K), bc[1] + (fc[1] - bc[1]) * t, SH_CROTCH - 0.028 * np.sin(np.pi * t)], axis=1)
    V = hip.reshape(-1, 3).tolist()
    F = []
    rows = len(zs)
    for r in range(rows - 1):
        for c in range(N):
            a, b = r * N + c, r * N + (c + 1) % N
            F.append((a, a + N, b + N, b))
    seam_i = list(range(len(V), len(V) + K))
    V += seam.tolist()
    last = (rows - 1) * N
    legs_top = {
        1: [last + c for c in range(0, N // 2 + 1)] + seam_i[::-1],            # front→her left→back, seam back→front
        -1: [last + (N // 2 + c) % N for c in range(0, N // 2 + 1)] + seam_i,  # back→her right→front, seam front→back
    }
    V = np.array(V)
    allV = [V]
    nV = len(V)
    leg_rings = {}
    for s in (1, -1):
        top = V[legs_top[s]]
        L = len(top)
        cen = np.array([s * 0.098, 0.004, SH_CROTCH])
        ang = np.arctan2((top[:, 0] - cen[0]) * s, -(top[:, 1] - cen[1]))
        # The first ring starts under the crotch seam's dip, so the cloth there never folds back up.
        lz = np.linspace(SH_CROTCH - 0.034, SH_HEM, 9)
        rings = [top]
        for k, z in enumerate(lz):
            f = smooth(SH_CROTCH, SH_CROTCH - 0.07, z)
            # A-line: hangs straight from the hip, a touch wider at the hem.
            c = np.array([s * (0.100 + 0.006 * (SH_CROTCH - z) / 0.16), 0.006, z])
            a = 0.084 + 0.010 * (SH_CROTCH - z) / 0.16
            b = 0.090 + 0.006 * (SH_CROTCH - z) / 0.16
            ell = np.stack([c[0] + s * a * np.sin(ang), c[1] - b * np.cos(ang), np.full(L, z)], axis=1)
            # Blend from the hip-shell ring at the crotch into the hanging leg, then keep clear of
            # the thigh's true surface (8 mm) everywhere.
            top = rings[0]
            P = top * (1 - f) + ell * f
            P[:, 2] = top[:, 2] * (1 - f) + z * f
            P = body.leg_clear(s, P, 0.008)
            # The inner side of each leg hangs flat against the midline (a seam, no open slot whose
            # shaded inner walls read as a dark gap from the front). This moves cloth away from
            # the thigh, never into it. It starts right under the crotch seam (a weaker pull there
            # had left a slot just below it, dark from the front and back).
            xi = P[:, 0] * s
            inner = smooth(0.075, 0.012, xi)
            P[:, 0] = s * (xi * (1 - inner) + 0.0012 * inner)
            # The two legs never cross the middle.
            P[:, 0] = np.where(P[:, 0] * s < 0.0012, s * 0.0012, P[:, 0])
            rings.append(P)
        leg_rings[s] = np.stack(rings)
        R = np.stack(rings[1:])
        base = len(np.vstack(allV))
        allV.append(R.reshape(-1, 3))
        # Faces between the top loop (shared indices) and the first leg ring, then down the leg.
        idx_top = legs_top[s]
        for c in range(L):
            c2 = (c + 1) % L
            F.append((idx_top[c], base + c, base + c2, idx_top[c2]))
        for r in range(len(lz) - 1):
            for c in range(L):
                c2 = (c + 1) % L
                a, b = base + r * L + c, base + r * L + c2
                F.append((a, a + L, b + L, b))
    V = np.vstack(allV)
    F = orient(V, F, lambda C: np.stack([np.where(C[:, 2] < SH_CROTCH, np.sign(C[:, 0]) * 0.098, 0.0), _axis_y(C[:, 2]) * (C[:, 2] >= SH_CROTCH) + 0.006 * (C[:, 2] < SH_CROTCH), C[:, 2]], axis=1))
    # Colour: cream, a soft shade in the pleats, a pocket line slanting from the waistband.
    C = _tile(COL["shorts"], len(V))
    x, y, z = V[:, 0], V[:, 1], V[:, 2]
    pocket = np.zeros(len(V))
    for s in (1, -1):
        # Slant from (x 0.085, z 1.04) down to (x 0.135, z 0.94) on the front.
        u = np.clip(((x * s - 0.085) * 0.05 + (1.04 - z) * 0.1) / (0.05 ** 2 + 0.1 ** 2), 0, 1)
        px, pz = 0.085 + 0.05 * u, 1.04 - 0.1 * u
        d = np.hypot(x * s - px, z - pz)
        pocket = np.maximum(pocket, (1 - smooth(0.0015, 0.004, d)) * (y < -0.02) * (x * s > 0.07))
    fly = (1 - smooth(0.001, 0.003, np.abs(x - 0.012))) * (y < -0.05) * smooth(1.04, 1.03, z) * smooth(0.86, 0.9, z)
    C = C * (1 - 0.3 * np.maximum(pocket, fly)[:, None])
    C = C * (1 - 0.08 * smooth(0.95, 1.0, z)[:, None] * 0)
    ob = _mk("shorts", V, F, C, col, "cloth", "shorts")
    # Down the inseam the legs' flat inner walls meet the front and back in a crease. They shade
    # as the cloth across the join would (facing front or back), so it reads as closed shorts with
    # no dark slot and no normal break for the ink to draw.
    me = ob.data
    n = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", n)
    k = (1 - smooth(0.006, 0.05, np.abs(x))) * smooth(SH_CROTCH + 0.012, SH_CROTCH - 0.01, z)
    fb = np.stack([np.zeros(len(V)), np.where(y < 0.006, -1.0, 1.0), np.zeros(len(V))], axis=1)
    set_normals(ob, norm(n.reshape(-1, 3) * (1 - k[:, None]) + fb * k[:, None]))
    # Waistband, belt loops, button, rolled cuffs.
    parts = [ob]
    wbV, wbF = _band(lambda thv, zv: _shorts_hip_r(thv, zv) + 0.0032, 1.040, SH_TOP + 0.002, 48, 4, round_top=True)
    parts.append(_mk("shorts_band", wbV, wbF, _tile(COL["shorts"], len(wbV)) * 0.97, col, "cloth", "shorts"))
    lpV, lpF = [], []
    for k, thl in enumerate([-2.2, -0.75, 0.75, 2.2, math.pi]):
        r0 = float(_shorts_hip_r(np.array([thl]), np.array([1.056]))[0]) + 0.006
        bx = _box_on_ring(thl, 1.056, r0, 0.010, 0.030, 0.003)
        lpF += [tuple(i + len(lpV) for i in f) for f in bx[1]]
        lpV += bx[0].tolist()
    r0 = float(_shorts_hip_r(np.array([0.06]), np.array([1.056]))[0]) + 0.007
    bt = _disc_on_ring(0.06, 1.056, r0, 0.0065, 0.003)
    lpF += [tuple(i + len(lpV) for i in f) for f in bt[1]]
    lpV += bt[0].tolist()
    lpV = np.array(lpV)
    parts.append(_mk("shorts_loops", lpV, lpF, _tile(COL["shorts_sh"], len(lpV)), col, "cloth", "shorts"))
    for s in (1, -1):
        hem = leg_rings[s][-1]
        cuV, cuF = _cuff(hem, s, 0.032, 0.0065)
        parts.append(_mk(f"shorts_cuff_{'L' if s > 0 else 'R'}", cuV, cuF, _tile(COL["shorts"], len(cuV)) * 0.99, col, "cloth", "shorts_leg"))
    return parts


def _band(rfun, z0, z1, N, rows, round_top=False):
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)
    zs = np.linspace(z0, z1, rows)
    rings = []
    for k, z in enumerate(zs):
        r = rfun(th, np.full(N, z))
        if round_top and k == rows - 1:
            r = r - 0.002
        rings.append(ring_pts(th, z, r))
    # Inner lip at the top so the band reads as a folded edge.
    rings.append(ring_pts(th, z1, rfun(th, np.full(N, z1)) - 0.005))
    R = np.stack(rings)
    V, F = tube(R, closed=True)
    F = orient(V, F, lambda C: np.stack([np.zeros(len(C)), _axis_y(C[:, 2]), C[:, 2]], axis=1))
    return V, F


def _box_on_ring(th, z, r, w, h, d):
    c = ring_pts(np.array([th]), z, np.array([r]))[0]
    out = np.array([math.sin(th), -math.cos(th), 0.0])
    tg = np.array([math.cos(th), math.sin(th), 0.0])
    up = np.array([0, 0, 1.0])
    V = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                V.append(c + tg * sx * w / 2 + up * sy * h / 2 + out * sz * d / 2)
    F = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    V = np.array(V)
    F = orient(V, F, lambda C: np.broadcast_to(c, C.shape))
    return V, F


def _disc_on_ring(th, z, r, rad, d):
    c = ring_pts(np.array([th]), z, np.array([r]))[0]
    out = np.array([math.sin(th), -math.cos(th), 0.0])
    tg = np.array([math.cos(th), math.sin(th), 0.0])
    up = np.array([0, 0, 1.0])
    a = np.linspace(0, 2 * np.pi, 10, endpoint=False)
    ring0 = c[None] + np.outer(np.cos(a) * rad, tg) + np.outer(np.sin(a) * rad, up) - out * d / 2
    ring1 = c[None] + np.outer(np.cos(a) * rad * 0.9, tg) + np.outer(np.sin(a) * rad * 0.9, up) + out * d / 2
    V, F = tube(np.stack([ring0, ring1]), closed=True, cap_end=True)
    F = orient(V, F, lambda C: np.broadcast_to(c - out * d, C.shape))
    return V, F


def _cuff(hem, s, h, t):
    """Rolled cuff over the hem ring: a soft rounded band, a little bigger than the leg."""
    cen = hem.mean(axis=0)
    out = hem - cen
    out[:, 2] = 0
    out = norm(out)
    rings = []
    for (dz, dr) in [(-0.004, 0.0015), (0.0, t * 0.9), (h * 0.35, t), (h * 0.8, t * 0.8), (h, t * 0.25), (h - 0.002, -0.001)]:
        P = hem + out * dr
        P = P.copy()
        P[:, 2] = hem[:, 2] + dz
        rings.append(P)
    V, F = tube(np.stack(rings), closed=True)
    F = orient(V, F, lambda C: np.stack([np.full(len(C), cen[0]), np.full(len(C), cen[1]), C[:, 2]], axis=1))
    return V, F


# ---------------------------------------------------------------- camisole


def _convex_ring(P):
    """Push the points of one horizontal ring out onto the ring's convex hull (in x, y), each
    along its own direction from the ring's centre."""
    xy = P[:, :2]
    c = xy.mean(axis=0)
    pts = sorted(map(tuple, xy))
    def half(seq):
        h = []
        for p in seq:
            while len(h) >= 2 and np.cross(np.subtract(h[-1], h[-2]), np.subtract(p, h[-2])) <= 0:
                h.pop()
            h.append(p)
        return h
    lo, up = half(pts), half(pts[::-1])
    hull = np.array(lo[:-1] + up[:-1])
    out = P.copy()
    for i, p in enumerate(xy):
        d = p - c
        r0 = np.linalg.norm(d)
        if r0 < 1e-9:
            continue
        d = d / r0
        best = r0
        for j in range(len(hull)):
            a, b = hull[j] - c, hull[(j + 1) % len(hull)] - c
            e = b - a
            den = d[0] * e[1] - d[1] * e[0]
            if abs(den) < 1e-12:
                continue
            t = (a[0] * e[1] - a[1] * e[0]) / den
            u = (a[0] * d[1] - a[1] * d[0]) / den
            if t > 0 and -1e-9 <= u <= 1 + 1e-9:
                best = max(best, t)
                break
        out[i, :2] = c + d * best
    return out


def cami(col):
    N = 48
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)
    a = np.abs(np.angle(np.exp(1j * th)))
    ztop = np.interp(a, [0, 0.5, 0.9, 1.6, 2.4, np.pi], [1.268, 1.276, 1.288, 1.282, 1.262, 1.250])
    zbot = 0.985
    rows = 15
    Z = np.stack([ztop + (zbot - ztop) * (k / (rows - 1)) ** 1.1 for k in range(rows)])
    TH = np.broadcast_to(th, Z.shape)
    R = torso_r(TH, Z, 0.0026)
    R = drape_down(R, Z, 0.22)
    V = ring_pts(TH, Z, R)
    # Fabric bridges the cleavage (and any other hollow) instead of following the skin into it.
    Vh = np.stack([_convex_ring(V[k]) for k in range(rows)])
    front = (1 - smooth(0.045, 0.07, np.abs(V[..., 0]))) * smooth(-0.02, -0.05, V[..., 1] - _axis_y(V[..., 2]))
    V = (V + (Vh - V) * front[..., None]).reshape(-1, 3)
    F = []
    for r in range(rows - 1):
        for c in range(N):
            a_, b_ = r * N + c, r * N + (c + 1) % N
            F.append((a_, a_ + N, b_ + N, b_))
    # A rolled top edge: one more ring just inside.
    top_in = ring_pts(th, ztop - 0.004, torso_r(th, ztop - 0.004, 0.0008)).reshape(-1, 3)
    base = len(V)
    V = np.vstack([V, top_in])
    for c in range(N):
        c2 = (c + 1) % N
        F.append((base + c, c, c2, base + c2))
    F = orient(V, F, lambda C: np.stack([np.zeros(len(C)), _axis_y(C[:, 2]), C[:, 2]], axis=1))
    C = _tile(COL["cami"], len(V))
    C *= (0.96 + 0.06 * vnoise3(V * 60.0))[:, None]
    parts = [_mk("cami", V, F, C, col, "cloth", "cami")]
    # Straps: from the front neckline over the shoulder to the back.
    sv, sf = [], []
    for s in (1, -1):
        pts = np.array([[s * 0.080, -0.07, 1.272], [s * 0.088, -0.045, 1.36], [s * 0.095, 0.005, 1.405], [s * 0.090, 0.06, 1.36], [s * 0.085, 0.085, 1.258]])
        P = spline_points(pts, 18)
        P = _on_torso(P, 0.003)
        V2, F2 = _strap(P, 0.0055, 0.0011)
        sf += [tuple(i + len(sv) for i in f) for f in F2]
        sv += V2.tolist()
    sv = np.array(sv)
    parts.append(_mk("cami_straps", sv, sf, _tile(COL["cami"], len(sv)) * 0.92, col, "cloth", "cami"))
    return parts


def _on_torso(P, off):
    """Project points onto the torso surface + off, along their horizontal direction from the axis."""
    P = np.asarray(P, float)
    O = np.stack([np.zeros(len(P)), _axis_y(P[:, 2]), P[:, 2]], axis=1)
    D = P - O
    D[:, 2] = 0
    up = P[:, 2] > 1.37
    D = norm(D)
    r = S.radial_hit(S.torso_sdf, O, D, rmax=0.3)
    Q = O + D * (r + off)[:, None]
    # Over the shoulder top, project down instead.
    if up.any():
        O2 = P[up] + np.array([0, 0, 0.12])
        D2 = np.tile([0, 0, -1.0], (up.sum(), 1))
        inside_start = S.torso_sdf(O2) < 0
        r2 = S.radial_hit(lambda X: -S.torso_sdf(X), O2, D2, rmax=0.2)
        Q2 = O2 + D2 * (r2 - off)[:, None]
        Q[up] = np.where(inside_start[:, None], Q[up], Q2)
    return Q


def _strap(P, hw, ht):
    """A flat band along path P lying on the body: width 2*hw, thickness 2*ht."""
    T, _, _ = frames_along(P)
    O = P - np.stack([np.zeros(len(P)), _axis_y(P[:, 2]), P[:, 2]], axis=1)
    O[:, 2] = np.where(P[:, 2] > 1.37, np.abs(O[:, 0]) + 0.05, O[:, 2] * 0)
    O = norm(O - T * np.einsum("ij,ij->i", O, T)[:, None])
    Wd = norm(np.cross(T, O))
    a = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], float)
    rings = np.stack([P[i] + np.outer(a[:, 0] * hw, Wd[i]) + np.outer(a[:, 1] * ht, O[i]) for i in range(len(P))])
    V, F = tube(rings, closed=True, cap_start=True, cap_end=True)
    F = orient(V, F, lambda C: _nearest(P, C) - 0.0 * C)
    return V, F


def _nearest(P, C):
    out = np.zeros_like(C)
    for k in range(len(C)):
        out[k] = P[np.argmin(np.linalg.norm(P - C[k], axis=1))]
    return out


# ---------------------------------------------------------------- shirt

KNOT = np.array([0.006, -0.108, 1.040])


def _open_half(z):
    """Half-angle of the shirt's front opening at height z (the fronts part over the cami and
    meet again at the knot)."""
    return np.interp(z, [1.035, 1.07, 1.12, 1.20, 1.30, 1.38, 1.425], [0.10, 0.22, 0.40, 0.56, 0.60, 0.50, 0.44])


def shirt(col):
    NS, rows = 60, 30
    u = np.linspace(0, 1, NS)
    ztop_back, ztop_front = 1.448, 1.405
    parts = []
    # Column angles from her left front edge round the back to her right front edge, per row:
    # neckline at the top (higher at the back), hem at the bottom (low at the back, rising to the
    # knot at the front edges).
    zr = np.linspace(0, 1, rows)
    TH = np.zeros((rows, NS))
    Z = np.zeros((rows, NS))
    th_top = _open_half(np.array(ztop_front)) + u * (2 * np.pi - 2 * _open_half(np.array(ztop_front)))
    ca = np.cos(th_top)
    z_neck = ztop_back + (ztop_front - ztop_back) * ((1 + ca) / 2) ** 0.7
    for k in range(rows):
        # Rows bunch over the shoulders (their curve needs them), sparser down the back.
        f = 0.55 * zr[k] ** 1.9 + 0.45 * zr[k] ** 1.15
        # Hem height by angle: 0.93 at the back, up to the knot at the front edges.
        th_guess = th_top
        z_hem = 0.928 + 0.112 * ((1 + np.cos(th_guess)) / 2) ** 1.7
        z = z_neck + (z_hem - z_neck) * f
        oh = _open_half(z)
        th = oh + u * (2 * np.pi - 2 * oh)
        TH[k], Z[k] = th, z
    R = torso_r(TH, Z, 0.0)
    # Ease: roomy linen, but the open fronts lie closer to her near their edges.
    edge = np.minimum(TH, 2 * np.pi - TH) - _open_half(Z)
    near = 1 - smooth(0.0, 0.45, edge)
    ease = (0.009 + 0.010 * smooth(1.30, 1.05, Z)) * (1 - 0.55 * near)
    R = R + ease
    R = np.maximum(drape_down(R, Z, 0.13) * (1 - near) + drape_down(R, Z, 0.45) * near, R)
    # Stay outside the shorts' waist and hips.
    low = Z < SH_TOP + 0.02
    if low.any():
        rs = _shorts_hip_r(TH[low], np.clip(Z[low], 0.93, SH_TOP)) + 0.0065
        R[low] = np.maximum(R[low], rs)
    # Gather toward the knot at the front: the fronts pull in and forward to it.
    Vg = ring_pts(TH, Z, R)
    # Clearance along the body's own normal too (over the shoulder tops a horizontal offset gives
    # none): 9 mm off the torso everywhere, so the camisole straps stay under the linen.
    Vg = push_out(Vg.reshape(-1, 3), S.torso_sdf, 0.009).reshape(Vg.shape)
    pull = smooth(1.12, 1.04, Z) * smooth(0.9, 0.2, np.minimum(TH, 2 * np.pi - TH))
    # The knot gathers the fronts in toward the body: they pull to a point just behind the knot.
    gather = KNOT + np.array([0.0, 0.012, 0.0])
    Vg = Vg + (gather[None, None, :] - Vg) * (0.55 * pull)[..., None] * np.array([1.0, 0.55, 0.4])
    # Drape folds: vertical at the back and sides, growing toward the hem; folds radiating from the knot.
    fold = 0.0042 * smooth(1.25, 0.95, Z) * np.sin(TH * 9.0 + 1.3 * np.sin(Z * 23.0)) * (1 - pull)
    kd = np.linalg.norm(Vg - KNOT, axis=-1)
    ka = np.arctan2(Vg[..., 2] - KNOT[2], (Vg[..., 0] - KNOT[0]))
    fold += 0.0035 * np.sin(ka * 7.0) * smooth(0.02, 0.05, kd) * (1 - smooth(0.06, 0.16, kd))
    outd = Vg - np.stack([np.zeros_like(Z), _axis_y(Z), Z], axis=-1)
    outd[..., 2] = 0
    Vg = Vg + norm(outd) * fold[..., None]
    V = Vg.reshape(-1, 3)
    F = []
    for r in range(rows - 1):
        for c in range(NS - 1):
            a, b = r * NS + c, r * NS + c + 1
            F.append((a, a + NS, b + NS, b))
    # Hem and front edges: a turned-back facing strip so the open edges have thickness.
    F = orient(V, F, lambda C: np.stack([np.zeros(len(C)), _axis_y(C[:, 2]), C[:, 2]], axis=1))
    C = _tile(COL["shirt"], len(V))
    C *= (0.97 + 0.05 * vnoise3(V * 40.0))[:, None]
    C *= (1 - 0.06 * (fold.reshape(-1) < -0.001))[:, None]
    wind = smooth(1.15, 0.93, V[:, 2]) * 0.8
    parts.append(_mk("shirt", V, F, C, col, "cloth", "shirt", wind=wind))
    # Collar, sleeves, knot.
    parts.append(_collar(col, Vg, TH))
    for s in (1, -1):
        parts.append(_sleeve(col, s))
    parts.append(_knot(col))
    return parts


def _collar(col, Vg, TH):
    """Soft shirt collar: a stand round the neck folding over into a fall that lies on the shirt,
    its points lying open on the chest beside the opening."""
    n = Vg.shape[1]
    top = Vg[0]
    a = np.minimum(TH[0], 2 * np.pi - TH[0])
    front = 1 - smooth(0.55, 1.5, a)
    axis = np.stack([np.zeros(n), _axis_y(top[:, 2]), top[:, 2]], axis=1)
    out = top - axis
    out[:, 2] = 0
    out = norm(out)
    up = np.array([0, 0, 1.0])
    # The shell's own outward normal (over the shoulders it faces up as much as out).
    dr = np.gradient(Vg, axis=0)
    dc = np.gradient(Vg, axis=1)
    Ns = norm(np.cross(dc, dr))
    flip = np.einsum("ijk,jk->ij", Ns, out) < 0
    Ns[flip] *= -1
    stand_top = top + up * (0.022 - 0.008 * front)[:, None] - out * 0.0015
    fold = stand_top + out * 0.006 + up * 0.002

    def on_shell(depth, lift):
        """Points on the shirt column `depth` below the neckline, lifted off it along its normal."""
        zt = top[:, 2] - depth
        P = np.zeros_like(top)
        for j in range(n):
            col_z = Vg[:, j, 2]
            k = np.clip(np.interp(-zt[j], -col_z, np.arange(len(col_z))), 0, len(col_z) - 1)
            k0 = int(np.floor(k))
            k1 = min(k0 + 1, len(col_z) - 1)
            w = k - k0
            P[j] = (Vg[k0, j] * (1 - w) + Vg[k1, j] * w) + norm(Ns[k0, j] * (1 - w) + Ns[k1, j] * w) * lift
        return P
    # A neat fall lying on the shirt from the neckline down, small points at the front.
    depth = 0.026 + 0.028 * front ** 1.5
    rows = [top - out * 0.001, stand_top, fold, on_shell(0.003, 0.0058), on_shell(depth * 0.5, 0.0052), on_shell(depth, 0.0040)]
    R = np.stack(rows)
    V = R.reshape(-1, 3)
    F = []
    for r in range(len(rows) - 1):
        for c in range(n - 1):
            a_, b_ = r * n + c, r * n + c + 1
            F.append((a_, a_ + n, b_ + n, b_))
    F = orient(V, F, lambda C: np.stack([np.zeros(len(C)), _axis_y(C[:, 2]), C[:, 2] + 0.03], axis=1))
    C = _tile(COL["shirt"], len(V)) * 1.02
    return _mk("shirt_collar", V, F, C, col, "cloth", "collar")


def _sleeve(col, s):
    """Loose linen sleeve from inside the shoulder to a rolled cuff just above the elbow."""
    sh, el = S.side(S.SH, s), S.side(S.ELB, s)
    d = norm(el - sh)
    t_end = 0.92
    # From inside the shoulder (hidden in the shirt) out through it: the armhole seam is where the
    # sleeve leaves the body shell, a few centimetres down the arm (a soft dropped shoulder).
    pts = [sh + (el - sh) * 0.07, sh + (el - sh) * 0.3, sh + (el - sh) * 0.6, sh + (el - sh) * t_end]
    P = spline_points(pts, 14)
    rings = []
    for i, p in enumerate(P):
        t = i / (len(P) - 1)
        u = np.clip((np.linalg.norm(p - sh)) / (S._UP_LEN + S._FORE_LEN), 0, 1)
        a = S.arm_section(u)[0]
        r = max(a[0], a[1]) - 0.004 + 0.011 * smooth(0.0, 0.3, t) + 0.004 * t
        rings.append((p, r))
    T, _, _ = frames_along(P)
    nr = 16
    ang = np.linspace(0, 2 * np.pi, nr, endpoint=False)
    out = []
    for i, (p, r) in enumerate(rings):
        f = norm(np.array([0, -1.0, 0]) - T[i] * (np.array([0, -1.0, 0]) @ T[i]))
        sd = norm(np.cross(T[i], f))
        # Soft folds and a little sag on the underside.
        rr = r * (1 + 0.05 * np.sin(ang * 3 + i * 0.6) * (i / len(rings)))
        out.append(p + np.outer(rr * np.cos(ang), f) + np.outer(rr * np.sin(ang), sd))
    Rg = np.stack(out)
    V, F = tube(Rg, closed=True)
    F = orient(V, F, lambda C: _nearest(P, C))
    C = _tile(COL["shirt"], len(V)) * (0.97 + 0.05 * vnoise3(V * 40.0))[:, None]
    sl = _mk(f"shirt_sleeve_{'L' if s > 0 else 'R'}", V, F, C, col, "cloth", "sleeve")
    sl["side"] = s
    # Rolled cuff.
    end = Rg[-1]
    cen = P[-1]
    o = norm(end - cen)
    cr = []
    for (dt, dr) in [(-0.004, 0.001), (0.0, 0.006), (0.012, 0.0085), (0.026, 0.007), (0.032, 0.002), (0.030, -0.003)]:
        cr.append(end + o * dr - T[-1] * dt)
    Vc, Fc = tube(np.stack(cr), closed=True)
    Fc = orient(Vc, Fc, lambda C: _nearest(P, C))
    cu = _mk(f"shirt_cuff_{'L' if s > 0 else 'R'}", Vc, Fc, _tile(COL["shirt"], len(Vc)) * 0.98, col, "cloth", "sleeve")
    cu["side"] = s
    return [sl, cu]


def _knot(col):
    """The knot at her waist: a soft lumpy wrap and two short tails hanging from it."""
    obs = []
    # Knot body: a squashed, lumpy ellipsoid with a wrap fold across it.
    u = np.linspace(0, np.pi, 12)
    v = np.linspace(0, 2 * np.pi, 18, endpoint=False)
    U, Vv = np.meshgrid(u, v, indexing="ij")
    rx, ry, rz = 0.030, 0.017, 0.020
    P = np.stack([rx * np.sin(U) * np.cos(Vv), ry * np.sin(U) * np.sin(Vv), rz * np.cos(U)], axis=-1)
    lump = 1 + 0.12 * np.sin(Vv * 3 + U * 2) + 0.18 * np.exp(-((U - 1.6) / 0.35) ** 2)
    P = P * lump[..., None] + KNOT
    P[..., 1] -= 0.004
    V = P.reshape(-1, 3)
    F = []
    for i in range(len(u) - 1):
        for j in range(len(v)):
            a, b = i * len(v) + j, i * len(v) + (j + 1) % len(v)
            F.append((a, a + len(v), b + len(v), b))
    F = orient(V, F, lambda C: np.broadcast_to(KNOT, C.shape))
    obs.append(_mk("shirt_knot", V, F, _tile(COL["shirt"], len(V)) * 0.96, col, "cloth", "knot"))
    # Tails: flat tapering ribbons from the knot down and out.
    for s in (1, -1):
        pts = np.array([KNOT + [s * 0.012, -0.004, -0.012], KNOT + [s * 0.030, -0.006, -0.050], KNOT + [s * 0.046, -0.002, -0.090], KNOT + [s * 0.052, 0.004, -0.118]])
        Pt = spline_points(pts, 10)
        T, _, _ = frames_along(Pt)
        out = norm(np.cross(T, np.array([s * 1.0, 0, 0])))
        out = np.where((out[:, 1] > 0)[:, None], -out, out)
        wd = norm(np.cross(T, out))
        rings = []
        for i, p in enumerate(Pt):
            t = i / (len(Pt) - 1)
            w = 0.021 * (1 - 0.5 * t) + 0.004
            h = 0.0060 * (1 - 0.45 * t) + 0.0012
            a = np.array([[-1, -1], [0, -1.3], [1, -1], [1, 1], [0, 1.3], [-1, 1]], float)
            rings.append(p + np.outer(a[:, 0] * w, wd[i]) + np.outer(a[:, 1] * h, out[i]))
        Vt, Ft = tube(np.stack(rings), closed=True, cap_end=True)
        Ft = orient(Vt, Ft, lambda C: _nearest(Pt, C))
        ob = _mk(f"shirt_tail_{'L' if s > 0 else 'R'}", Vt, Ft, _tile(COL["shirt"], len(Vt)) * 0.97, col, "cloth", "tail",
                 wind=np.linspace(0, 1, len(Vt)) * 0 + smooth(0.0, 1.0, np.repeat(np.linspace(0, 1, len(Pt)), 6).tolist() + [1.0]))
        ob["side"] = s
        names = rig.add_chain(f"knot_{'L' if s > 0 else 'R'}", Pt[[0, 4, 9]], "spine")
        ob["chain"] = ",".join(names)
        obs.append(ob)
    return obs


# ---------------------------------------------------------------- sandals


def sandals(col):
    obs = []
    for s in (1, -1):
        sf = "L" if s > 0 else "R"
        Vf, Ff = body.foot(s)
        Vf = np.asarray(Vf)
        an = S.side(S.ANKLE, s)
        toe_out = np.radians(6.0) * s
        fwd = np.array([math.sin(toe_out), -math.cos(toe_out), 0.0])
        lat = np.array([math.cos(toe_out), math.sin(toe_out), 0.0])
        heel = np.array([an[0], an[1] + 0.050, 0.0])
        # Sole: the foot's footprint outline grown 4 mm, 12 mm thick under the foot.
        loc = Vf - heel
        along = loc @ fwd
        across = loc @ lat
        bins = np.linspace(-0.004, body.FOOT_LEN + 0.004, 26)
        outl_l, outl_r = [], []
        for k in range(len(bins)):
            m = np.abs(along - bins[k]) < 0.008
            if m.sum() < 2:
                m = np.argsort(np.abs(along - bins[k]))[:6]
            lo, hi = across[m].min() - 0.004, across[m].max() + 0.004
            outl_l.append(heel + fwd * bins[k] + lat * lo)
            outl_r.append(heel + fwd * bins[k] + lat * hi)
        ring = np.array(outl_r + outl_l[::-1])
        ring = np.vstack([ring[:1], ring[1:]])
        cen = ring.mean(axis=0)
        rr = []
        for (z, k) in [(-body.SOLE, 0.985), (-body.SOLE + 0.002, 1.0), (-0.002, 1.0), (0.0, 0.985), (0.0005, 0.94)]:
            q = cen + (ring - cen) * k
            q = q.copy()
            q[:, 2] = z
            rr.append(q)
        Vs, Fs = tube(np.stack(rr), closed=True, cap_start=True, cap_end=True)
        Fs = orient(Vs, Fs, lambda C: np.broadcast_to(cen + np.array([0, 0, -body.SOLE / 2]), C.shape))
        Cs = _tile(COL["sole"], len(Vs))
        Cs[Vs[:, 2] > -0.001] = srgb(COL["bed"])
        sole = _mk(f"sandal_sole_{sf}", Vs, Fs, Cs, col, "cloth", "sandal", mat="sandal")
        sole["side"] = s
        obs.append(sole)
        # Straps: around the foot's cross-section at a few stations, and round the ankle.
        sv, sfc = [], []

        def add(V2, F2):
            nonlocal sv, sfc
            sfc += [tuple(i + len(sv) for i in f) for f in F2]
            sv += V2.tolist()

        for (ua, w) in [(0.80, 0.0055), (0.56, 0.0065)]:
            m = np.abs(along / body.FOOT_LEN - ua) < 0.03
            pts = Vf[m]
            ac = (pts - heel) @ lat
            o = np.argsort(ac)
            pts = pts[o]
            topm = pts[:, 2] > 0.004
            pts = pts[topm]
            if len(pts) < 3:
                continue
            ac = (pts - heel) @ lat
            # Order over the top from one sole edge to the other.
            ang = np.arctan2(pts[:, 2] - 0.0, ac)
            pts = pts[np.argsort(-ang)]
            c0 = pts.mean(axis=0)
            P = spline_points(pts[:: max(1, len(pts) // 7)], 16)
            off = norm(P - np.array([c0[0], c0[1], 0.012]))
            P = P + off * 0.0022
            V2, F2 = _flat_band(P, w, 0.0012, off)
            add(V2, F2)
        # Ankle strap with a buckle on the outside, heel strap down to the sole.
        a_z = 0.093
        th = np.linspace(0, 2 * np.pi, 20, endpoint=False)
        tu = 0.955
        sec = S.leg_section(tu)[0]
        lc = S.side(S.ANKLE, s) + np.array([0, -0.004, 0.0])
        P = np.stack([lc[0] + s * (sec[0] + 0.0035) * np.sin(th), lc[1] - (sec[1] + 0.0035) * np.cos(th) + 0.002, np.full(20, a_z)], axis=1)
        P = np.vstack([P, P[:1]])
        offv = norm(P - np.array([lc[0], lc[1], a_z]))
        V2, F2 = _flat_band(P, 0.0050, 0.0012, offv, closed=True)
        add(V2, F2)
        bk = np.array([lc[0] + s * (sec[0] + 0.006), lc[1] - 0.004, a_z])
        bx, bf = _small_box(bk, np.array([s * 1.0, 0, 0]), 0.012, 0.010, 0.002)
        bv = len(sv)
        add(bx, bf)
        Ph = np.array([[lc[0], lc[1] + sec[1] + 0.004, a_z - 0.004], [lc[0], lc[1] + 0.044, 0.045], [lc[0], lc[1] + 0.050, 0.012]])
        Ph = spline_points(Ph, 8)
        offh = np.tile([0, 1.0, 0], (len(Ph), 1))
        V2, F2 = _flat_band(Ph, 0.0055, 0.0012, offh)
        add(V2, F2)
        sv = np.array(sv)
        C = _tile(COL["leather"], len(sv))
        C[bv:bv + 8] = srgb(COL["metal"])
        st = _mk(f"sandal_straps_{sf}", sv, sfc, C, col, "cloth", "sandal", mat="sandal")
        st["side"] = s
        obs.append(st)
    return obs


def _flat_band(P, hw, ht, out, closed=False):
    T, _, _ = frames_along(P)
    out = norm(out - T * np.einsum("ij,ij->i", out, T)[:, None])
    wd = norm(np.cross(T, out))
    a = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], float)
    rings = np.stack([P[i] + np.outer(a[:, 0] * hw, wd[i]) + np.outer(a[:, 1] * ht, out[i]) for i in range(len(P))])
    V, F = tube(rings, closed=True, cap_start=not closed, cap_end=not closed)
    F = orient(V, F, lambda C: _nearest(P, C))
    return V, F


def _small_box(c, n, w, h, d):
    n = norm(n)
    up = np.array([0, 0, 1.0])
    t = norm(np.cross(up, n))
    V = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            for sz in (-1, 1):
                V.append(c + t * sx * w / 2 + up * sy * h / 2 + n * sz * d / 2)
    F = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    V = np.array(V)
    return V, orient(V, F, lambda C: np.broadcast_to(c, C.shape))


# ---------------------------------------------------------------- hat

HAT_O = HC + np.array([0.0, 0.010, 0.066])   # band centre (head-local origin + this)
HAT_TILT = math.radians(11.0)                 # tilted back: the front of the brim lifts


def hat_frame():
    up = np.array([0.0, math.sin(HAT_TILT), math.cos(HAT_TILT)])
    fwd = np.array([0.0, -math.cos(HAT_TILT), math.sin(HAT_TILT)])
    right = np.cross(fwd, up)  # her left (+X)
    return HAT_O, up, fwd, np.array([1.0, 0, 0])


def hat(col):
    O, up, fwd, lx = hat_frame()
    N = 72
    ph = np.linspace(0, 2 * np.pi, N, endpoint=False)          # 0 = front, + toward her left
    dirs = np.outer(np.cos(ph), fwd) + np.outer(np.sin(ph), lx)
    # Band: the skin under the band plane, plus the hair under the hat.
    r_skin = S.radial_hit(lambda X: head.skin_field(X), O, dirs, rmax=0.2, steps=80, iters=18)
    a = np.abs(np.angle(np.exp(1j * ph)))
    clear = np.interp(a, [0, 0.6, 1.4, np.pi], [0.017, 0.019, 0.023, 0.024])
    rb = r_skin + clear
    obs = []
    # Crown: from the band up, a soft rounded dome.
    crown = []
    hts = [0.0, 0.025, 0.05, 0.072, 0.088, 0.098, 0.104]
    for k, h in enumerate(hts):
        f = h / hts[-1]
        bulge = 0.010 * math.sin(math.pi * min(1.0, f * 1.4)) - 0.07 * f ** 3.2
        rr = rb + bulge + 0.004 * np.sin(ph * 3 + 1.0) * f
        crown.append(O + up * h + dirs * rr[:, None])
    top = O + up * (hts[-1] + 0.004)
    Rg = np.stack(crown)
    Vc, Fc = tube(Rg, closed=True)
    pi_ = len(Vc)
    Vc = np.vstack([Vc, top])
    n = N
    off = (len(hts) - 1) * n
    for c in range(n):
        Fc.append((pi_, off + c, off + (c + 1) % n))
    # Inner lining down to the band (so a low view never sees through the hat).
    Fc = orient(Vc, Fc, lambda C: np.broadcast_to(O + up * 0.03, C.shape))
    # Brim: top and underside joined by a rolled edge; a gentle droop and a soft wave.
    R_out = 0.212
    nr = 9
    rows_top, rows_bot = [], []
    for k in range(nr):
        f = k / (nr - 1)
        rr = rb + (R_out - rb) * f
        hgt = _brim_height(ph, f)
        rows_top.append(O + dirs * rr[:, None] + up * hgt[:, None])
        rows_bot.append(O + dirs * rr[:, None] + up * (hgt - 0.0035)[:, None])
    rim = O + dirs * (R_out + 0.003) + up * (_brim_height(ph, 1.0) - 0.00175)[:, None]
    Rb = np.stack(rows_top + [rim] + rows_bot[::-1])
    Vb, Fb = tube(Rb, closed=True)
    rb0 = float(rb.mean())
    Fb = orient(Vb, Fb, lambda C: _brim_ref(C, O, up, fwd, lx, rb0, R_out))
    Vh = np.vstack([Vc, Vb])
    Fh = Fc + [tuple(i + len(Vc) for i in f) for f in Fb]
    Ch = _tile(COL["straw"], len(Vh))
    # Darker toward the rim edge and on the underside; the inside of the crown is shaded.
    rel = Vh - O
    hh = rel @ up
    rad = np.linalg.norm(rel - np.outer(hh, up), axis=1)
    Ch *= (1 - 0.12 * smooth(0.20, 0.235, rad))[:, None]
    Ch *= (0.95 + 0.08 * vnoise3(Vh * 35.0))[:, None]
    wind = smooth(0.14, 0.235, rad) * 0.6
    obs.append(_mk("hat", Vh, Fh, Ch, col, "hat", "hat", wind=wind, mat="straw"))
    # Ribbon round the crown base, a bow at her left side toward the back, two tails.
    rib = []
    for (h, dr) in [(0.004, 0.0035), (0.010, 0.0052), (0.022, 0.0055), (0.032, 0.0042), (0.035, 0.0008)]:
        rr = rb + dr + 0.010 * math.sin(math.pi * min(1.0, h / 0.104 * 1.4))
        rib.append(O + up * h + dirs * rr[:, None])
    Vr, Fr = tube(np.stack(rib), closed=True)
    Fr = orient(Vr, Fr, lambda C: np.broadcast_to(O + up * 0.02, C.shape))
    allV, allF = [Vr], Fr
    nV = len(Vr)
    bow_ph = 1.95                                  # her left, toward the back
    bdir = math.cos(bow_ph) * fwd + math.sin(bow_ph) * lx
    rbow = float(np.interp(bow_ph, ph, rb)) + 0.012
    bc = O + up * 0.019 + bdir * rbow
    tang = np.cross(up, bdir)
    for side_ in (-1, 1):
        # Two loops of the bow.
        t = np.linspace(0, 2 * np.pi, 14, endpoint=False)
        lp = []
        for k, q in enumerate(t):
            rr = 0.024 * (0.5 - 0.5 * math.cos(q)) + 0.002
            p = bc + tang * side_ * rr * 1.0 + up * 0.011 * math.sin(q) + bdir * 0.006 * math.sin(q * 2)
            lp.append(p)
        P = np.array(lp + [lp[0]])
        Vl, Fl = _flat_band(P, 0.0085, 0.0015, np.tile(bdir, (len(P), 1)), closed=True)
        allF += [tuple(i + nV for i in f) for f in Fl]
        allV.append(Vl)
        nV += len(Vl)
    kn = O + up * 0.019 + bdir * (rbow + 0.004)
    bxV, bxF = _small_box(kn, bdir, 0.011, 0.014, 0.008)
    allF += [tuple(i + nV for i in f) for f in bxF]
    allV.append(bxV)
    nV += len(bxV)
    Vr = np.vstack(allV)
    Cr = _tile(COL["ribbon"], len(Vr))
    obs.append(_mk("hat_ribbon", Vr, allF, Cr, col, "hat", "ribbon", mat="ribbon"))
    # Tails: from the bow down over the brim and off its edge.
    for k, side_ in enumerate((-1, 1)):
        p0 = kn + tang * side_ * 0.006 - up * 0.004
        pts = [p0, p0 + bdir * 0.05 - up * 0.016 + tang * side_ * 0.01, p0 + bdir * 0.11 - up * 0.045 + tang * side_ * 0.02,
               p0 + bdir * 0.15 - up * (0.11 + 0.02 * k) + tang * side_ * 0.03, p0 + bdir * 0.165 - up * (0.17 + 0.025 * k) + tang * side_ * 0.035]
        Pt = spline_points(pts, 14)
        # Clear the brim: lift any point under the brim's top surface.
        Pt = _over_brim(Pt, O, up, rb, R_out)
        T, _, _ = frames_along(Pt)
        out = norm(np.cross(T, tang))
        Vt, Ft = _flat_band(Pt, 0.0085, 0.0012, out)
        nm = f"ribbon_{'L' if side_ < 0 else 'R'}"
        ob = _mk(f"hat_tail_{k}", Vt, Ft, _tile(COL["ribbon"], len(Vt)), col, "hat", "ribbon_tail", mat="ribbon",
                 wind=np.repeat(np.linspace(0, 1, len(Pt)), 4).tolist() + [0, 1])
        names = rig.add_chain(nm, Pt[[0, 4, 9, 13]], "hat")
        ob["chain"] = ",".join(names)
        obs.append(ob)
    rig.EXTRA.insert(0, ("hat", tuple(O - up * 0.01), tuple(O + up * 0.11), "head", (0, -1, 0)))
    return obs


def _brim_height(ph, f):
    """Brim top surface height above the band plane: a gentle droop and a soft wave."""
    return -0.030 * f ** 1.6 + 0.0075 * np.sin(ph * 5 + 0.8) * f ** 1.4 + 0.004 * np.sin(ph * 2 - 0.4) * f


def _brim_ref(C, O, up, fwd, lx, rb0, R_out):
    """Points on the brim's mid-surface (between top and underside) under face centroids, so the
    faces wind away from it: up on top, down underneath, out at the rolled edge."""
    rel = C - O
    h = rel @ up
    radial = rel - np.outer(h, up)
    rn = np.linalg.norm(radial, axis=1)
    rd = radial / np.maximum(rn, 1e-9)[:, None]
    ph = np.arctan2(rd @ lx, rd @ fwd)
    f = np.clip((rn - rb0) / (R_out - rb0), 0, 1)
    hmid = _brim_height(ph, f) - 0.00175
    return O + rd * np.minimum(rn, R_out - 0.0015)[:, None] + np.outer(hmid, up)


def _over_brim(P, O, up, rb, R_out):
    P = np.array(P)
    for i in range(len(P)):
        rel = P[i] - O
        h = rel @ up
        rad = np.linalg.norm(rel - h * up)
        if rad < R_out + 0.004:
            f = np.clip((rad - rb.mean()) / (R_out - rb.mean()), 0, 1)
            top = -0.030 * f ** 1.6 + 0.009
            if h < top:
                P[i] = P[i] + up * (top - h)
    return P


# ---------------------------------------------------------------- sunglasses


def glasses(col):
    L = head.face_layout_gltf()["lens"]
    lx, ly, hw, hh, nexp, fl, wr, ti, lz = (L[k] for k in ("x", "y", "hw", "hh", "n", "flare", "wrap", "tilt", "z"))

    def lens_pt(s, a, grow):
        """glTF head-local lens outline point → Blender world."""
        c, sn = math.cos(a), math.sin(a)
        e = 2 / nexp
        y = (hh + grow) * math.copysign(abs(sn) ** e, sn)
        x = (hw + grow) * math.copysign(abs(c) ** e, c) * (1 + fl * (y / hh))
        X, Y = lx + x, ly + y
        Zg = lz - wr * (X - lx) + ti * (Y - ly)
        return HC + np.array([s * X, -Zg, Y])

    obs = []
    allV, allF = [], []
    nV = 0
    na = 36
    for s in (1, -1):
        rings = []
        for k in range(na):
            a = 2 * math.pi * k / na
            # Rim cross-section: in the lens plane (inner edge .. outer edge), with depth.
            top = max(0.0, math.sin(a))
            outer_side = max(0.0, math.cos(a))
            wdt = 0.0030 + 0.0026 * top ** 2 + 0.0014 * outer_side ** 4   # brow bar, fine lower rim (the brows show above it)
            inner = lens_pt(s, a, -0.0005)
            outer = lens_pt(s, a, wdt)
            nrm = np.array([-wr * s, -1.0, ti])
            nrm = nrm / np.linalg.norm(nrm)
            dep = 0.0026
            rings.append([inner + nrm * dep, outer + nrm * dep * 0.85, outer - nrm * dep * 0.85, inner - nrm * dep])
        R = np.array(rings)                           # na x 4 x 3
        # Rings along the outline (closed loop), each a closed 4-gon section.
        Rl = np.concatenate([R, R[:1]], axis=0)
        V, F = tube(Rl, closed=True)
        centres = Rl.mean(axis=1)
        F = orient(V, F, lambda C: _nearest(centres, C))
        F = [tuple(i + nV for i in f) for f in F]
        allV.append(V)
        allF += F
        nV += len(V)
        # End piece and temple: from the outer edge back over the ear.
        ep = lens_pt(s, 0.15, 0.0042)
        ear_top = HC + np.array([s * 0.074, 0.040, 0.010])
        back = HC + np.array([s * 0.068, 0.072, -0.004])
        pts = np.array([ep, ep + np.array([s * 0.006, 0.010, 0.0]), HC + np.array([s * 0.078, -0.02, 0.009]), ear_top, back])
        P = spline_points(pts, 16)
        # Keep the temple off the skin.
        P = hair.shell_push(P, 0.0028)
        T, _, _ = frames_along(P)
        upv = np.array([0, 0, 1.0])
        sd = norm(np.cross(T, upv))
        a2 = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], float)
        ws = np.linspace(0.0032, 0.0022, len(P))
        rings = np.stack([P[i] + np.outer(a2[:, 0] * 0.0013, sd[i]) + np.outer(a2[:, 1] * ws[i], upv) for i in range(len(P))])
        Vt, Ft = tube(rings, closed=True, cap_end=True)
        Ft = orient(Vt, Ft, lambda C: _nearest(P, C))
        allF += [tuple(i + nV for i in f) for f in Ft]
        allV.append(Vt)
        nV += len(Vt)
    # Keyhole bridge across the nose.
    b0, b1 = lens_pt(1, math.pi * 0.9, 0.0015), lens_pt(-1, math.pi * 0.9, 0.0015)
    mid = (b0 + b1) / 2 + np.array([0, -0.002, 0.0055])
    P = spline_points([b0, mid, b1], 12)
    T, _, _ = frames_along(P)
    upv = np.array([0, 0, 1.0])
    sd = norm(np.cross(T, upv))
    a2 = np.array([[-1, -1], [1, -1], [1, 1], [-1, 1]], float)
    rings = np.stack([P[i] + np.outer(a2[:, 0] * 0.0022, sd[i]) + np.outer(a2[:, 1] * 0.0021, upv) for i in range(len(P))])
    Vb, Fb = tube(rings, closed=True, cap_start=True, cap_end=True)
    Fb = orient(Vb, Fb, lambda C: _nearest(P, C))
    allF += [tuple(i + nV for i in f) for f in Fb]
    allV.append(Vb)
    V = np.vstack(allV)
    F = allF
    # Tortoiseshell: dark brown with amber flecks and a deeper mottle.
    n1 = vnoise3(V * 420.0)
    n2 = vnoise3(V * 160.0 + 3.1)
    C = srgb(COL["tort"])[None, :] * np.ones((len(V), 1))
    fleck = smooth(0.66, 0.82, n1) * (0.6 + 0.4 * n2)
    C = C * (1 - fleck)[:, None] + srgb(COL["amber"])[None, :] * fleck[:, None]
    C *= (0.75 + 0.3 * n2)[:, None]
    obs.append(_mk("glasses", V, F, C, col, "glasses", "frame", mat="frame"))
    return obs


# ---------------------------------------------------------------- build and weights


def build(col):
    out = {}
    objs = []
    objs += shorts(col)
    objs += cami(col)
    for o in shirt(col):
        objs += o if isinstance(o, list) else [o]
    objs += sandals(col)
    objs += hat(col)
    objs += glasses(col)
    for o in objs:
        out[o.name] = o
    return out


def cloth_weights(ob):
    part = ob.get("part")
    if part == "hair":
        from .hair import hair_weights
        return hair_weights(ob)
    V = np.array([v.co[:] for v in ob.data.vertices])
    n = len(V)
    kind = ob.get("cloth", "")
    s = ob.get("side", 0)
    if part in ("hat", "glasses"):
        if kind == "ribbon_tail":
            names = ob["chain"].split(",")
            t = np.linspace(0, 1, n)
            # Along the band: vertices are in ring order.
            k = np.repeat(np.linspace(0, 1, (n - 2) // 4), 4).tolist() + [0, 1]
            k = np.array(k[:n])
            steps = [smooth(0.05, 0.25, k), smooth(0.35, 0.6, k), smooth(0.65, 0.9, k)]
            return rig._partition(["hat"] + names, steps, n)
        return {"hat": np.ones(n)} if part == "hat" else {"head": np.ones(n)}
    if kind in ("cami", "shirt", "collar", "knot"):
        W = rig.spine_weights(V)
        for sgn, sf in ((1, "L"), (-1, "R")):
            k_sh = smooth(0.08, 0.17, V[:, 0] * sgn) * smooth(1.25, 1.33, V[:, 2])
            W[f"shoulder_{sf}"] = W.get("spine2", 0) * k_sh * 0.85
            W["spine2"] = W.get("spine2", 0) * (1 - k_sh * 0.85)
            # Shirt side/shoulder panels near the arm follow the upper arm a little.
            if kind == "shirt":
                k_ar = smooth(0.15, 0.20, V[:, 0] * sgn) * smooth(1.22, 1.30, V[:, 2]) * 0.5
                W[f"upperarm_{sf}"] = W.get(f"shoulder_{sf}", 0) * k_ar
                W[f"shoulder_{sf}"] = W.get(f"shoulder_{sf}", 0) * (1 - k_ar)
        # Below the waist the shirt's hem follows the hips and thighs a little.
        if kind == "shirt":
            for sgn, sf in ((1, "L"), (-1, "R")):
                k_th = smooth(0.96, 0.90, V[:, 2]) * smooth(0.02, 0.08, V[:, 0] * sgn) * 0.35
                tot = sum(W.values())
                for bn in list(W):
                    W[bn] = W[bn] * (1 - k_th)
                W[f"thigh_{sf}"] = W.get(f"thigh_{sf}", 0) + k_th
        return W
    if kind == "tail":
        names = ob["chain"].split(",")
        k = np.array((np.repeat(np.linspace(0, 1, (n - 1) // 6), 6).tolist() + [1.0])[:n])
        steps = [smooth(0.0, 0.2, k), smooth(0.45, 0.75, k)]
        return rig._partition(["spine"] + names, steps, n)
    if kind == "sleeve":
        W = rig.arm_weights(V, s)
        # The top of the sleeve blends into the chest/shoulder like the shirt.
        sf = "L" if s > 0 else "R"
        k = smooth(S.SH[2] + 0.01, S.SH[2] - 0.05, V[:, 2])
        out = {bn: w * k for bn, w in W.items()}
        out[f"shoulder_{sf}"] = out.get(f"shoulder_{sf}", 0) + (1 - k) * 0.6
        out["spine2"] = out.get("spine2", 0) + (1 - k) * 0.4
        return out
    if kind in ("shorts", "shorts_leg"):
        W = {}
        sp = rig.spine_weights(V)
        own = 1 if ob.name.endswith("_L") else -1 if ob.name.endswith("_R") else 0
        for sgn in (1, -1):
            sf = "L" if sgn > 0 else "R"
            lw = rig.leg_weights(V, sgn, hip_blend=0.09)
            # Each side of the shorts follows its own thigh below the crotch (a per-side piece
            # such as a cuff takes only its own side; the main mesh splits at the crotch seam).
            if own:
                k_side = np.full(len(V), 1.0 if sgn == own else 0.0)
            else:
                k_side = smooth(-0.01, 0.01, V[:, 0] * sgn)
            k_leg = smooth(0.84, 0.74, V[:, 2]) * k_side
            for bn, w in lw.items():
                W[bn] = W.get(bn, 0) + w * k_leg
            for bn, w in sp.items():
                W[bn] = W.get(bn, 0) + w * (1 - k_leg) * k_side * (1 if sgn > 0 else 1)
        # Normalise the two halves.
        return W
    if kind == "sandal":
        sf = "L" if s > 0 else "R"
        lw = rig.leg_weights(V, s)
        if "sole" in ob.name:
            # The sole is rigid on the foot (no shin), so it lies flat on the ground in stance.
            W = {f"toe_{sf}": lw.get(f"toe_{sf}", np.zeros(n))}
            W[f"foot_{sf}"] = 1.0 - W[f"toe_{sf}"]
            return W
        return {k: v for k, v in lw.items() if k in (f"foot_{sf}", f"toe_{sf}", f"shin_{sf}")}
    return rig.spine_weights(V)
