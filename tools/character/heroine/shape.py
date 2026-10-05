"""Her body measurements and analytic surfaces (Blender frame: +Z up, facing -Y, +X her left).

About 1.66 m tall, 7.3 heads (head 0.228 m chin to crown), long legs (crotch 0.77 m), a fit,
athletic build: square-ish soft shoulders, a slightly fuller bust, a slim waist over womanly hips,
full thighs and toned calves. Everything that has to agree between the skin, the clothes and the
rig (joint positions, the torso surface the camisole and shirt are fitted to) lives here.
"""
import numpy as np

from .common import catmull, norm, smin, smooth

# ---------------------------------------------------------------- joints (bind pose)

HEAD_C = np.array([0.0, 0.0, 1.540])  # head-local origin: centre of the skull at eye height
CROWN_Z = HEAD_C[2] + 0.120
CHIN_Z = HEAD_C[2] - 0.110

J = {
    "root": (0.0, 0.0, 0.0),
    "hips": (0.0, 0.004, 0.935),
    "spine": (0.0, 0.006, 1.020),
    "spine1": (0.0, 0.004, 1.115),
    "spine2": (0.0, 0.010, 1.225),
    "neck": (0.0, 0.020, 1.395),
    "head": (0.0, 0.010, 1.478),
    "head_end": (0.0, 0.0, 1.668),
}
# Arms hang in a relaxed A (25 degrees out from vertical), elbows a touch bent, palms in.
SH = np.array([0.168, 0.016, 1.368])
_ARM_OUT = np.radians(25.0)
_UP_LEN, _FORE_LEN = 0.272, 0.236
_d_up = np.array([np.sin(_ARM_OUT), 0.012, -np.cos(_ARM_OUT)])
_d_up /= np.linalg.norm(_d_up)
ELB = SH + _d_up * _UP_LEN
_d_fo = np.array([np.sin(_ARM_OUT - np.radians(4)), -0.07, -np.cos(_ARM_OUT - np.radians(4))])
_d_fo /= np.linalg.norm(_d_fo)
WRI = ELB + _d_fo * _FORE_LEN
HIP = np.array([0.088, 0.002, 0.885])
KNEE = np.array([0.096, -0.010, 0.468])
ANKLE = np.array([0.101, 0.022, 0.074])
BALL = np.array([0.106, -0.112, 0.018])
TOE = np.array([0.109, -0.168, 0.012])


def side(p, s):
    """Mirror a left-side point (+X) to side s (+1 her left, -1 her right)."""
    p = np.array(p, dtype=float)
    p[..., 0] *= s
    return p


# ---------------------------------------------------------------- torso surface (SDF)


def _ellipsoid(P, c, r):
    """Approximate signed distance to an axis-aligned ellipsoid."""
    q = (P - c) / r
    k0 = np.linalg.norm(q, axis=1)
    k1 = np.linalg.norm(q / r, axis=1)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def _capsule(P, a, b, ra, rb):
    a, b = np.asarray(a, float), np.asarray(b, float)
    pa, ba = P - a, b - a
    h = np.clip((pa @ ba) / (ba @ ba), 0, 1)
    return np.linalg.norm(pa - h[:, None] * ba, axis=1) - (ra + (rb - ra) * h)


def torso_sdf(P):
    """Her torso as a smooth union of soft volumes: ribcage, bust, waist, pelvis, glutes, upper
    back, shoulders, neck and thigh tops. Used to fit the camisole, shirt and shorts and to sample
    the visible upper chest."""
    P = np.asarray(P, dtype=float)
    d = _ellipsoid(P, np.array([0.0, 0.014, 1.232]), np.array([0.118, 0.090, 0.150]))
    # Upper back / trapezius and the shoulder caps.
    d = smin(d, _ellipsoid(P, np.array([0.0, 0.036, 1.318]), np.array([0.118, 0.066, 0.075])), 0.03)
    for s in (-1, 1):
        d = smin(d, _capsule(P, (s * 0.04, 0.026, 1.374), (s * 0.152, 0.016, 1.338), 0.048, 0.047), 0.03)
        d = smin(d, _ellipsoid(P, np.array([s * 0.166, 0.012, 1.318]), np.array([0.046, 0.054, 0.068])), 0.022)
        # Bust: rounded, a touch full, lifted, set slightly apart.
        d = smin(d, _ellipsoid(P, np.array([s * 0.054, -0.052, 1.222]), np.array([0.058, 0.054, 0.056])), 0.032)
        # Glutes.
        d = smin(d, _ellipsoid(P, np.array([s * 0.062, 0.050, 0.872]), np.array([0.075, 0.064, 0.086])), 0.035)
        # Thigh tops.
        d = smin(d, _capsule(P, (s * 0.090, 0.004, 0.86), (s * 0.097, -0.004, 0.62), 0.088, 0.072), 0.03)
    # Waist and abdomen (slim, soft), pelvis (womanly hips).
    d = smin(d, _ellipsoid(P, np.array([0.0, 0.004, 1.070]), np.array([0.112, 0.080, 0.105])), 0.05)
    d = smin(d, _ellipsoid(P, np.array([0.0, 0.010, 0.915]), np.array([0.158, 0.104, 0.112])), 0.05)
    # Neck.
    d = smin(d, _capsule(P, (0, 0.030, 1.36), (0, 0.012, 1.49), 0.050, 0.046), 0.025)
    return d


def torso_axis(z):
    """Torso axis (x=0) y position at height z: a little forward at the chest, back at the hips."""
    z = np.asarray(z, dtype=float)
    return 0.004 + 0.012 * smooth(1.30, 1.42, z) + 0.008 * smooth(1.05, 0.88, z)


def radial_hit(field, origin, dirs, rmax=0.4, steps=96, iters=22):
    """First outward zero crossing of field along rays origin + r*dir (vectorised).

    origin (N,3) or (3,), dirs (N,3) unit. Returns r (N,)."""
    dirs = np.asarray(dirs, dtype=float)
    n = len(dirs)
    O = np.broadcast_to(np.asarray(origin, dtype=float), (n, 3))
    rs = np.linspace(0.0, rmax, steps)
    prev = field(O)
    lo = np.zeros(n)
    hi = np.full(n, rmax)
    found = np.zeros(n, dtype=bool)
    for k in range(1, steps):
        cur = field(O + dirs * rs[k])
        hit = (~found) & (prev < 0) & (cur >= 0)
        lo[hit] = rs[k - 1]
        hi[hit] = rs[k]
        found |= hit
        prev = cur
        if found.all():
            break
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        inside = field(O + dirs * mid[:, None]) < 0
        lo = np.where(inside, mid, lo)
        hi = np.where(inside, hi, mid)
    return 0.5 * (lo + hi)


# ---------------------------------------------------------------- limbs

# Leg cross-sections along the leg (t = 0 hip joint .. 1 ankle): half-width (side to side),
# half-depth (front to back), forward offset of the section centre (+ = front), and a calf /
# knee-cap shaping term. Full thighs, a neat knee, a toned calf with its belly high and inside.
LEG_T = [
    # t     hw      hd     fwd     calf      (knee at t = 0.515, the hip-to-knee share of the leg)
    [0.00, 0.086, 0.084, 0.000, 0.0],
    [0.09, 0.083, 0.080, 0.004, 0.0],
    [0.21, 0.075, 0.073, 0.007, 0.0],
    [0.34, 0.066, 0.064, 0.008, 0.0],
    [0.43, 0.057, 0.055, 0.006, 0.0],
    [0.48, 0.051, 0.050, 0.004, 0.3],   # above the knee
    [0.515, 0.048, 0.048, 0.003, 0.6],  # knee
    [0.56, 0.046, 0.047, 0.000, 0.4],
    [0.63, 0.047, 0.050, -0.006, 0.0],
    [0.70, 0.050, 0.054, -0.010, 0.0],  # calf belly
    [0.79, 0.045, 0.048, -0.008, 0.0],
    [0.885, 0.036, 0.038, -0.004, 0.0],
    [0.955, 0.030, 0.032, -0.002, 0.0],
    [1.00, 0.028, 0.031, 0.000, 0.0],
]

# Arm cross-sections (t = 0 shoulder joint .. 1 wrist): half-width across the arm (in the arm's
# side plane), half-depth (front to back), toned (a soft deltoid, slim elbow, forearm tapering to a
# neat flat wrist).
ARM_T = [
    [0.00, 0.050, 0.050],
    [0.10, 0.045, 0.046],
    [0.25, 0.040, 0.041],
    [0.40, 0.036, 0.037],
    [0.50, 0.032, 0.033],   # elbow
    [0.56, 0.033, 0.032],
    [0.64, 0.035, 0.031],   # forearm belly
    [0.76, 0.031, 0.027],
    [0.88, 0.026, 0.021],
    [1.00, 0.025, 0.018],   # wrist
]


def leg_section(t):
    return catmull(LEG_T, np.atleast_1d(t))


def arm_section(t):
    return catmull(ARM_T, np.atleast_1d(t))
