"""Shared helpers for the heroine build: numpy geometry, Blender mesh creation, attributes.

Blender frame used everywhere in these scripts: metres, +Z up, she faces -Y, +X is HER LEFT.
The glTF export turns this into three.js space (+Y up, facing +Z, +X her left).
"""
import math

import bpy
import numpy as np

# ---------------------------------------------------------------- maths


def smooth(e0, e1, x):
    t = np.clip((np.asarray(x, dtype=float) - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def smin(a, b, k):
    """Polynomial smooth minimum (soft union of two distance fields)."""
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1.0 - h) + a * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def norm(v, axis=-1):
    n = np.linalg.norm(v, axis=axis, keepdims=True)
    return v / np.maximum(n, 1e-12)


def catmull(knots, x):
    """C1 cubic Hermite through table rows [x, v1, v2, ...] (x ascending), evaluated at x.

    Returns an array (len(x), ncols-1). Tangents are finite differences on the (non-uniform)
    knots; ends are clamped. Smooth tables give smooth surfaces (no toon banding at the knots).
    """
    T = np.asarray(knots, dtype=float)
    xs = T[:, 0]
    ys = T[:, 1:]
    n = len(xs)
    x = np.clip(np.asarray(x, dtype=float), xs[0], xs[-1])
    m = np.zeros_like(ys)
    for i in range(n):
        if i == 0:
            m[i] = (ys[1] - ys[0]) / (xs[1] - xs[0])
        elif i == n - 1:
            m[i] = (ys[-1] - ys[-2]) / (xs[-1] - xs[-2])
        else:
            m[i] = (ys[i + 1] - ys[i - 1]) / (xs[i + 1] - xs[i - 1])
    i = np.clip(np.searchsorted(xs, x, side="right") - 1, 0, n - 2)
    x0, x1 = xs[i], xs[i + 1]
    h = (x1 - x0)[:, None]
    t = ((x - x0) / (x1 - x0))[:, None]
    t2, t3 = t * t, t * t * t
    return ((2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i]
            + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1])


def gauss(x, c, s):
    return np.exp(-(((x - c) / s) ** 2))


def bezier(pts, t):
    """Cubic Bezier through 4 control points (4,3), at t (N,) -> (N,3)."""
    p0, p1, p2, p3 = [np.asarray(p, dtype=float) for p in pts]
    t = np.asarray(t, dtype=float)[:, None]
    u = 1 - t
    return u ** 3 * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t ** 3 * p3


def spline_points(ctrl, n):
    """Catmull-Rom (centripetal-ish, uniform) through control points (K,3), resampled to n points
    evenly by arc length."""
    P = np.asarray(ctrl, dtype=float)
    P = np.vstack([2 * P[0] - P[1], P, 2 * P[-1] - P[-2]])
    dense = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        for t in np.linspace(0, 1, 24, endpoint=False):
            t2, t3 = t * t, t * t * t
            dense.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3))
    dense.append(P[-2])
    D = np.array(dense)
    seg = np.linalg.norm(np.diff(D, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    u = np.linspace(0, s[-1], n)
    return np.stack([np.interp(u, s, D[:, k]) for k in range(3)], axis=1)


def frames_along(path, up_hint=(0, 0, 1)):
    """Rotation-minimising frames along a polyline: tangent T, normal N, binormal B (each (n,3))."""
    P = np.asarray(path, dtype=float)
    n = len(P)
    T = np.zeros_like(P)
    T[1:-1] = P[2:] - P[:-2]
    T[0] = P[1] - P[0]
    T[-1] = P[-1] - P[-2]
    T = norm(T)
    up = np.asarray(up_hint, dtype=float)
    N = np.zeros_like(P)
    v = np.cross(T[0], up)
    if np.linalg.norm(v) < 1e-6:
        v = np.cross(T[0], (1, 0, 0))
    N[0] = norm(np.cross(v, T[0]))
    for i in range(1, n):
        # Double reflection (Wang et al.) keeps the frame from twisting.
        v1 = P[i] - P[i - 1]
        c1 = v1 @ v1
        if c1 < 1e-14:
            N[i] = N[i - 1]
            continue
        rL = N[i - 1] - (2 / c1) * (v1 @ N[i - 1]) * v1
        tL = T[i - 1] - (2 / c1) * (v1 @ T[i - 1]) * v1
        v2 = T[i] - tL
        c2 = v2 @ v2
        N[i] = rL - (2 / c2) * (v2 @ rL) * v2 if c2 > 1e-14 else rL
        N[i] = norm(N[i])
    B = np.cross(T, N)
    return T, N, B


def rot_axis(axis, ang):
    """3x3 rotation matrix about a unit axis."""
    a = np.asarray(axis, dtype=float)
    a = a / np.linalg.norm(a)
    c, s = math.cos(ang), math.sin(ang)
    x, y, z = a
    return np.array([
        [c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
        [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
        [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)],
    ])


def hash1(i):
    """Deterministic pseudo-random in [0,1) for integer-ish input (array ok)."""
    x = np.sin(np.asarray(i, dtype=float) * 12.9898 + 78.233) * 43758.5453
    return x - np.floor(x)


def vnoise3(p, seed=0.0):
    """Smooth value noise in 3D for arrays of points (N,3) -> (N,)."""
    p = np.asarray(p, dtype=float) + seed * 17.13
    i = np.floor(p)
    f = p - i
    u = f * f * (3 - 2 * f)

    def h(ix, iy, iz):
        return hash1(ix * 127.1 + iy * 311.7 + iz * 74.7)

    x, y, z = i[:, 0], i[:, 1], i[:, 2]
    a = h(x, y, z) * (1 - u[:, 0]) + h(x + 1, y, z) * u[:, 0]
    b = h(x, y + 1, z) * (1 - u[:, 0]) + h(x + 1, y + 1, z) * u[:, 0]
    c = h(x, y, z + 1) * (1 - u[:, 0]) + h(x + 1, y, z + 1) * u[:, 0]
    d = h(x, y + 1, z + 1) * (1 - u[:, 0]) + h(x + 1, y + 1, z + 1) * u[:, 0]
    ab = a * (1 - u[:, 1]) + b * u[:, 1]
    cd = c * (1 - u[:, 1]) + d * u[:, 1]
    return ab * (1 - u[:, 2]) + cd * u[:, 2]


# ---------------------------------------------------------------- grids → faces


def grid_faces(rows, cols, closed=True, flip=False, row_offset=0):
    """Quads for a rows x cols vertex grid (row-major). closed: columns wrap around."""
    F = []
    cmax = cols if closed else cols - 1
    for r in range(rows - 1):
        for c in range(cmax):
            c2 = (c + 1) % cols
            a = row_offset + r * cols + c
            b = row_offset + r * cols + c2
            d = row_offset + (r + 1) * cols + c
            e = row_offset + (r + 1) * cols + c2
            F.append((a, d, e, b) if not flip else (a, b, e, d))
    return F


def tube(rings, closed=True, cap_start=False, cap_end=False, flip=False):
    """Vertices + quad faces for a stack of rings (R, C, 3). Caps are triangle fans to a centre
    vertex. Face winding: outward if the rings run counter-clockwise seen from the end the stack
    grows toward (use flip to swap)."""
    R, C, _ = rings.shape
    V = rings.reshape(-1, 3).tolist()
    F = grid_faces(R, C, closed, flip)
    if cap_start:
        ci = len(V)
        V.append(rings[0].mean(axis=0).tolist())
        for c in range(C if closed else C - 1):
            c2 = (c + 1) % C
            F.append((ci, c2, c) if not flip else (ci, c, c2))
    if cap_end:
        ci = len(V)
        V.append(rings[-1].mean(axis=0).tolist())
        o = (R - 1) * C
        for c in range(C if closed else C - 1):
            c2 = (c + 1) % C
            F.append((ci, o + c, o + c2) if not flip else (ci, o + c2, o + c))
    return np.array(V), F


# ---------------------------------------------------------------- Blender objects

COLL = "Heroine"


def scene():
    """The scene we build into: a dedicated "Heroine" scene in a live session (the user's own
    scenes are left alone); in a headless run, the throwaway file's own scene renamed."""
    if bpy.app.background:
        sc = bpy.context.scene
        sc.name = "Heroine"
        return sc
    sc = bpy.data.scenes.get("Heroine") or bpy.data.scenes.new("Heroine")
    win = bpy.context.window
    if win is not None and win.scene != sc:
        win.scene = sc
    return sc


def collection(name=COLL):
    sc = scene()
    col = bpy.data.collections.get(name)
    if col is None:
        col = bpy.data.collections.new(name)
    if col.name not in sc.collection.children:
        sc.collection.children.link(col)
    return col


def clear_collection(name=COLL):
    """Delete every object (and its mesh/armature data) in our collection only."""
    col = bpy.data.collections.get(name)
    if col is None:
        return
    for o in list(col.all_objects):
        data = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        if data is not None and data.users == 0:
            if isinstance(data, bpy.types.Mesh):
                bpy.data.meshes.remove(data)
            elif isinstance(data, bpy.types.Armature):
                bpy.data.armatures.remove(data)
    for a in list(bpy.data.actions):
        if a.get("heroine"):
            bpy.data.actions.remove(a)
    for m in list(bpy.data.materials):
        if m.get("heroine") and m.users == 0:
            bpy.data.materials.remove(m)


def make_mesh(name, V, F, col=None):
    """Mesh object from vertices (N,3) and faces (list of index tuples), linked to our collection."""
    me = bpy.data.meshes.new(name)
    V = np.asarray(V, dtype=float)
    me.from_pydata(V.tolist(), [], [tuple(int(i) for i in f) for f in F])
    me.validate(clean_customdata=False)
    me.update()
    ob = bpy.data.objects.new(name, me)
    (col or collection()).objects.link(ob)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def verts(ob):
    me = ob.data
    a = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", a)
    return a.reshape(-1, 3)


def set_verts(ob, V):
    me = ob.data
    me.vertices.foreach_set("co", np.asarray(V, dtype=float).reshape(-1))
    me.update()


def vertex_normals(ob):
    me = ob.data
    a = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("normal", a)
    return a.reshape(-1, 3)


def set_colors(ob, C, name="Color"):
    """Per-vertex linear RGB(A) colour attribute (exported as COLOR_0)."""
    me = ob.data
    C = np.asarray(C, dtype=float)
    if C.shape[1] == 3:
        C = np.hstack([C, np.ones((len(C), 1))])
    attr = me.color_attributes.get(name) or me.color_attributes.new(name, "FLOAT_COLOR", "POINT")
    attr.data.foreach_set("color", C.reshape(-1))
    me.color_attributes.active_color = attr
    try:
        me.color_attributes.render_color_index = list(me.color_attributes).index(attr)
    except Exception:
        pass


def set_float(ob, name, values):
    """Per-vertex float attribute; names starting with "_" export as glTF custom attributes."""
    me = ob.data
    attr = me.attributes.get(name) or me.attributes.new(name, "FLOAT", "POINT")
    attr.data.foreach_set("value", np.asarray(values, dtype=float).reshape(-1))


def set_normals(ob, N):
    """Custom per-vertex normals (shaped normals for the toon shading)."""
    me = ob.data
    N = norm(np.asarray(N, dtype=float))
    me.normals_split_custom_set_from_vertices([tuple(n) for n in N])


def srgb(hexstr, k=1.0):
    """'#rrggbb' sRGB → linear RGB tuple (what the game's THREE.Color(hex) stores)."""
    h = hexstr.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return np.array(lin) * k


def material(name, hexcol):
    """A plain named material (the game swaps it for its own toon material by name)."""
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m["heroine"] = 1
    c = srgb(hexcol)
    m.diffuse_color = (*c, 1.0)
    try:
        m.use_nodes = True
        bsdf = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs[0].default_value = (*c, 1.0)
        bsdf.inputs["Roughness"].default_value = 0.8
    except Exception:
        pass
    return m


def assign_material(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)


def material_roles(col):
    """Material name per mesh (the game maps each name to its own toon material and outline id)."""
    return sorted({m.name for o in col.all_objects if o.type == "MESH" for m in o.data.materials if m})


def delete_faces(ob, mask_faces):
    """Delete faces where mask_faces[i] is True, then drop loose vertices."""
    import bmesh
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    kill = [f for f in bm.faces if mask_faces[f.index]]
    bmesh.ops.delete(bm, geom=kill, context="FACES_ONLY")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()


def face_centers(ob):
    me = ob.data
    a = np.zeros(len(me.polygons) * 3)
    me.polygons.foreach_get("center", a)
    return a.reshape(-1, 3)


def face_vertex_indices(ob):
    return [tuple(p.vertices) for p in ob.data.polygons]


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def join(objs, name):
    """Join mesh objects into one (keeps attributes present on all)."""
    objs = [o for o in objs if o is not None]
    if len(objs) == 1:
        objs[0].name = name
        objs[0].data.name = name
        return objs[0]
    ctx = {"active_object": objs[0], "selected_editable_objects": objs, "selected_objects": objs}
    with bpy.context.temp_override(**ctx):
        bpy.ops.object.join()
    objs[0].name = name
    objs[0].data.name = name
    return objs[0]


def face_normals_np(V, F):
    V = np.asarray(V, dtype=float)
    out = np.zeros((len(F), 3))
    for i, f in enumerate(F):
        p = V[list(f)]
        n = np.zeros(3)
        for k in range(len(f)):
            n += np.cross(p[k], p[(k + 1) % len(f)])
        out[i] = n
    return norm(out)


def orient(V, F, inside):
    """Wind every face so its normal points away from `inside(centroids) -> points` (an interior
    reference per face), e.g. a fixed point or the nearest axis point."""
    V = np.asarray(V, dtype=float)
    Nf = face_normals_np(V, F)
    C = np.array([V[list(f)].mean(axis=0) for f in F])
    ref = inside(C)
    flip = np.einsum("ij,ij->i", Nf, C - ref) < 0
    return [tuple(reversed(f)) if fl else tuple(f) for f, fl in zip(F, flip)]


def laplacian(V, F, iters=2, lam=0.5, pin=None):
    """Simple uniform Laplacian smoothing of vertex positions (pin: bool mask of fixed verts)."""
    V = np.array(V, dtype=float)
    n = len(V)
    nbr = [set() for _ in range(n)]
    for f in F:
        k = len(f)
        for i in range(k):
            a, b = f[i], f[(i + 1) % k]
            nbr[a].add(b)
            nbr[b].add(a)
    idx = [np.array(sorted(s), dtype=int) for s in nbr]
    for _ in range(iters):
        avg = np.array([V[i].mean(axis=0) if len(i) else V[j] for j, i in enumerate(idx)])
        D = avg - V
        if pin is not None:
            D[pin] = 0
        V = V + lam * D
    return V
