"""
Crew body shapes as implicit surfaces, and the clean quad meshes made from them.

Pure Python + numpy (no bpy), so it runs inside Blender's Python and on its own.

Coordinates are glTF's: x to the character's left as you look at it (viewer's
right), y up, z toward the viewer (the face looks down +z). The body stands on
y = 0 and is about one unit tall. Blender scripts convert with to_blender().

Every shape is built the same way so every shape has the same topology (the
live renderer morphs one into another vertex for vertex):

  1. a spherified cube (N x N quads per face, welded, no poles),
  2. each vertex pushed out from the body's core along its direction to the
     outermost crossing of the surface,
  3. a tangential relaxation that spreads the quads evenly (into ears and
     tips) while Newton steps keep every vertex on the surface,
  4. normals from the field's gradient.

The cuteness rules (D-033) live in FACE below, per shape: where the eyes sit
by default and how far a person may move them. Eyes are always LOW (at or
below the middle of the face) and WIDE apart, and the ranges never let them
climb into the uncanny upper face.
"""

from __future__ import annotations

import math
import numpy as np

# ---------------------------------------------------------------- primitives


def _len(v):
    return np.sqrt(np.maximum((v * v).sum(-1), 1e-18))


def sphere(p, c, r):
    return _len(p - np.asarray(c, float)) - r


def ellipsoid(p, c, r):
    """Inigo Quilez's ellipsoid bound: exact on the surface, good near it."""
    r = np.asarray(r, float)
    q = p - np.asarray(c, float)
    k0 = _len(q / r)
    k1 = _len(q / (r * r))
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def round_cone(p, a, b, r1, r2):
    """A capsule whose radius goes from r1 at a to r2 at b (Quilez)."""
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    ba = b - a
    l2 = float(ba @ ba)
    rr = r1 - r2
    a2 = l2 - rr * rr
    il2 = 1.0 / l2
    pa = p - a
    y = pa @ ba
    z = y - l2
    x = pa * l2 - y[:, None] * ba
    x2 = (x * x).sum(-1)
    y2 = y * y * l2
    z2 = z * z * l2
    k = math.copysign(1.0, rr) * rr * rr * x2
    out = np.empty(len(p))
    m1 = np.sign(z) * a2 * z2 > k
    m2 = np.sign(y) * a2 * y2 < k
    m3 = ~(m1 | m2)
    out[m1] = np.sqrt(x2[m1] + z2[m1]) * il2 - r2
    out[m2] = np.sqrt(x2[m2] + y2[m2]) * il2 - r1
    out[m3] = (np.sqrt(x2[m3] * a2 * il2) + y[m3] * rr) * il2 - r1
    return out


def rounded_cylinder(p, c, ra, rb, h, zscale=1.0):
    q = p - np.asarray(c, float)
    rxz = np.sqrt(q[:, 0] ** 2 + (q[:, 2] / zscale) ** 2)
    d = np.stack([rxz - ra + rb, np.abs(q[:, 1]) - h + rb], -1)
    return np.minimum(np.maximum(d[:, 0], d[:, 1]), 0.0) + _len(np.maximum(d, 0.0)) - rb


def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1.0 - h) + a * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def flat_bottom(f, p, k=0.1, y0=0.0):
    """Sit the body on the ground: cut below y0 with a soft rounded edge (plush toys sag onto their base)."""
    return smax(f, y0 - p[:, 1], k)


def star2d(px, py, r, rf, n=5):
    """Quilez's regular star, rotated so a point is up."""
    an = math.pi / n
    en = math.pi / (2.0 + rf * (n - 2.0))  # rf: 0 a polygon .. 1 sharp points
    acs = np.array([math.cos(an), math.sin(an)])
    ecs = np.array([math.cos(en), math.sin(en)])
    x = np.abs(px)
    y = py
    ang = np.arctan2(x, y)
    bn = np.mod(ang, 2.0 * an) - an
    l = np.sqrt(x * x + y * y)
    qx = l * np.cos(bn)
    qy = l * np.abs(np.sin(bn))
    qx = qx - r * acs[0]
    qy = qy - r * acs[1]
    d = qx * ecs[0] + qy * ecs[1]
    t = np.clip(-d, 0.0, r * acs[1] / ecs[1])
    qx = qx + ecs[0] * t
    qy = qy + ecs[1] * t
    return np.sqrt(qx * qx + qy * qy) * np.sign(qx)


# ---------------------------------------------------------------- the shapes
#
# Each returns f(p) < 0 inside. They are designed by eye against the cuteness
# rules: one soft mass, bottom-heavy, a little wider than deep (a face plane),
# a flattened base it sits on, and one feature that gives it a personality.


def f_pebble(p):
    # A soft egg, fuller below, a little flattened front to back.
    y = p[:, 1]
    s = 1.0 + 0.11 * (0.5 - y) / 0.5
    q = p.copy()
    q[:, 0] /= s
    q[:, 2] /= s
    f = ellipsoid(q, (0, 0.47, 0), (0.5, 0.54, 0.43))
    return flat_bottom(f, p, 0.12)


def f_mochi(p):
    # A rice cake resting on a table: wide, low, sagging into a soft skirt.
    y = p[:, 1]
    s = 1.0 + 0.1 * sstep(0.55, 0.05, y)
    q = p.copy()
    q[:, 0] /= s
    q[:, 2] /= s
    f = ellipsoid(q, (0, 0.33, 0), (0.64, 0.46, 0.53))
    return flat_bottom(f, p, 0.16)


def f_bean(p):
    # A jelly bean standing up, with a gentle backward lean.
    q = p.copy()
    q[:, 2] += 0.05 * np.sin((q[:, 1] - 0.15) * 2.4)
    q[:, 0] /= 1.0 + 0.08 * sstep(0.9, 0.2, q[:, 1])
    q2 = q.copy()
    q2[:, 2] /= 0.9
    f = round_cone(q2, (0, 0.36, 0), (0, 0.8, 0), 0.37, 0.31)
    return flat_bottom(f, p, 0.1)


def f_drop(p):
    # A water drop whose soft tip curls over to one side.
    q = p.copy()
    t = sstep(0.55, 1.25, q[:, 1])
    q[:, 0] -= 0.3 * t * t
    q[:, 2] /= 0.9
    body = sphere(q, (0, 0.43, 0), 0.47)
    tip = round_cone(q, (0, 0.52, 0), (0, 1.16, 0), 0.4, 0.075)
    f = smin(body, tip, 0.12)
    return flat_bottom(f, p, 0.12)


def f_gumdrop(p):
    # A soft pudding: broad at the base, a round little crown.
    q = p.copy()
    q[:, 2] /= 0.9
    f = round_cone(q, (0, 0.3, 0), (0, 0.66, 0), 0.56, 0.3)
    return flat_bottom(f, p, 0.1)


def f_marshmallow(p):
    # A squat, pillowy cylinder: very round edges and a slight barrel.
    q = p.copy()
    s = 1.0 + 0.06 * np.cos((q[:, 1] - 0.42) * 2.6)
    q[:, 0] /= s
    q[:, 2] /= s
    f = rounded_cylinder(q, (0, 0.42, 0), 0.54, 0.3, 0.43, zscale=0.86)
    return flat_bottom(f, p, 0.08)


def f_peanut(p):
    # Two soft lobes, the head the bigger one.
    q = p.copy()
    q[:, 2] /= 0.9
    lo = ellipsoid(q, (0, 0.33, 0), (0.4, 0.36, 0.4))
    hi = sphere(q, (0, 0.86, 0), 0.43)
    f = smin(lo, hi, 0.2)
    return flat_bottom(f, p, 0.08)


def f_star(p):
    # A puffy star cushion standing on two points.
    cx, cy = 0.0, 0.56
    d2 = star2d(p[:, 0] - cx, p[:, 1] - cy, 0.5, 0.3)
    # Pillow profile: thickness grows like the square root of the distance inward.
    T = 0.42
    R = 0.15
    f = d2 - R + (p[:, 2] ** 2) / T
    return flat_bottom(f, p, 0.04, -0.01)


def f_orb(p):
    # A ball that has settled a little onto its base.
    q = p.copy()
    q[:, 2] /= 0.92
    f = sphere(q, (0, 0.5, 0), 0.52)
    return flat_bottom(f, p, 0.12, 0.0)


def f_cub(p):
    # A round head-body with two round ears.
    q = p.copy()
    q[:, 2] /= 0.9
    s = 1.0 + 0.06 * sstep(0.6, 0.0, q[:, 1])
    q[:, 0] /= s
    head = ellipsoid(q, (0, 0.47, 0), (0.54, 0.5, 0.52))
    ears = np.minimum(
        ellipsoid(q, (-0.35, 0.88, -0.04), (0.2, 0.19, 0.13)),
        ellipsoid(q, (0.35, 0.88, -0.04), (0.2, 0.19, 0.13)),
    )
    f = smin(head, ears, 0.06)
    return flat_bottom(f, p, 0.12)


def f_kit(p):
    # A soft egg with two pointed, slightly splayed ears.
    y = p[:, 1]
    s = 1.0 + 0.08 * (0.5 - y) / 0.5
    q = p.copy()
    q[:, 0] /= s
    q[:, 2] /= s * 0.9
    head = ellipsoid(q, (0, 0.46, 0), (0.52, 0.5, 0.5))
    e1 = round_cone(q, (-0.25, 0.74, -0.03), (-0.39, 1.07, -0.05), 0.2, 0.08)
    e2 = round_cone(q, (0.25, 0.74, -0.03), (0.39, 1.07, -0.05), 0.2, 0.08)
    f = smin(head, np.minimum(e1, e2), 0.06)
    return flat_bottom(f, p, 0.12)


def rot_xy(q, c, ang):
    """Rotate points about the z axis through c (for tilted parts)."""
    x = q[:, 0] - c[0]
    y = q[:, 1] - c[1]
    ca, sa = math.cos(ang), math.sin(ang)
    out = q.copy()
    out[:, 0] = c[0] + ca * x - sa * y
    out[:, 1] = c[1] + sa * x + ca * y
    return out


def f_lop(p):
    # A round bun with two long, soft ears hanging against its sides.
    q = p.copy()
    q[:, 2] /= 0.9
    head = ellipsoid(q, (0, 0.47, 0), (0.47, 0.47, 0.47))
    ears = []
    for sx in (-1, 1):
        # Hanging: the top tucks in under the crown, the tip flares out a little.
        c = (sx * 0.44, 0.44, 0.02)
        qe = rot_xy(q, c, -sx * 0.2)
        ears.append(ellipsoid(qe, c, (0.12, 0.35, 0.18)))
    f = smin(head, np.minimum(ears[0], ears[1]), 0.05)
    return flat_bottom(f, p, 0.12)


SHAPES = {
    "pebble": f_pebble,
    "mochi": f_mochi,
    "bean": f_bean,
    "drop": f_drop,
    "gumdrop": f_gumdrop,
    "marshmallow": f_marshmallow,
    "peanut": f_peanut,
    "star": f_star,
    "orb": f_orb,
    "cub": f_cub,
    "kit": f_kit,
    "lop": f_lop,
}

# Where the core sits (rays start here; must be well inside), per shape.
CORE = {
    "pebble": (0, 0.47, 0),
    "mochi": (0, 0.3, 0),
    "bean": (0, 0.55, 0),
    "drop": (0, 0.48, 0),
    "gumdrop": (0, 0.42, 0),
    "marshmallow": (0, 0.42, 0),
    "peanut": (0, 0.62, 0),
    "star": (0, 0.52, 0),
    "orb": (0, 0.5, 0),
    "cub": (0, 0.5, 0),
    "kit": (0, 0.5, 0),
    "lop": (0, 0.5, 0),
}

# ---------------------------------------------------------------- the face
#
# Per shape: eye centre height as a fraction of the BODY height (ears and tips
# excluded: `face_top` is where the face's crown is), the horizontal distance
# of each eye from the middle as a fraction of the half-width at that height,
# and the eye radius (height of the eye) as a fraction of the body height.
# Ranges map the avatar's 0..1 controls; defaults are the cutest setting.

FACE = {
    #            y range        gap range      radius range   face_top
    "pebble": dict(y=(0.34, 0.48), gap=(0.36, 0.56), r=(0.086, 0.132), top=1.0),
    "mochi": dict(y=(0.36, 0.52), gap=(0.3, 0.48), r=(0.115, 0.172), top=0.79),
    "bean": dict(y=(0.42, 0.56), gap=(0.36, 0.56), r=(0.078, 0.115), top=1.1),
    "drop": dict(y=(0.34, 0.48), gap=(0.36, 0.56), r=(0.086, 0.127), top=0.9),
    "gumdrop": dict(y=(0.3, 0.46), gap=(0.32, 0.52), r=(0.086, 0.132), top=0.96),
    "marshmallow": dict(y=(0.4, 0.56), gap=(0.34, 0.54), r=(0.092, 0.138), top=0.85),
    "peanut": dict(y=(0.56, 0.68), gap=(0.36, 0.56), r=(0.069, 0.101), top=1.29),
    "star": dict(y=(0.4, 0.52), gap=(0.36, 0.56), r=(0.081, 0.115), top=1.0, hw=0.36),
    "orb": dict(y=(0.36, 0.5), gap=(0.36, 0.56), r=(0.086, 0.132), top=1.02),
    "cub": dict(y=(0.36, 0.5), gap=(0.36, 0.56), r=(0.086, 0.132), top=0.97),
    "kit": dict(y=(0.36, 0.5), gap=(0.36, 0.56), r=(0.086, 0.132), top=0.96),
    "lop": dict(y=(0.36, 0.5), gap=(0.36, 0.56), r=(0.086, 0.132), top=0.94, hw=0.4),
}

LABEL = {
    "pebble": "Pebble",
    "mochi": "Mochi",
    "bean": "Bean",
    "drop": "Drop",
    "gumdrop": "Gumdrop",
    "marshmallow": "Marshmallow",
    "peanut": "Peanut",
    "star": "Soft star",
    "orb": "Orb",
    "cub": "Cub",
    "kit": "Kit",
    "lop": "Lop",
}


def field(shape):
    return SHAPES[shape]


def grad(f, p, e=1.5e-3):
    ex = np.array([e, 0, 0])
    ey = np.array([0, e, 0])
    ez = np.array([0, 0, e])
    g = np.stack(
        [f(p + ex) - f(p - ex), f(p + ey) - f(p - ey), f(p + ez) - f(p - ez)],
        -1,
    ) / (2 * e)
    return g


def normal(f, p):
    g = grad(f, p)
    return g / _len(g)[:, None]


def newton(f, p, steps=3):
    for _ in range(steps):
        v = f(p)
        g = grad(f, p)
        g2 = np.maximum((g * g).sum(-1), 1e-12)
        p = p - (v / g2)[:, None] * g
    return p


# ---------------------------------------------------------------- the mesh


def quad_sphere(n):
    """A welded spherified cube: (verts (V,3) unit directions, quads (Q,4), uvs per quad corner (Q,4,2))."""
    faces = [
        # (normal axis, sign, u axis, v axis) in a right-handed order so quads face outward
        (0, 1, 2, 1),
        (0, -1, 2, 1),
        (1, 1, 0, 2),
        (1, -1, 0, 2),
        (2, 1, 0, 1),
        (2, -1, 0, 1),
    ]
    index = {}
    verts = []
    quads = []
    uvs = []
    atlas = [(0, 0), (1, 0), (2, 0), (0, 1), (1, 1), (2, 1)]

    def vid(c):
        key = tuple(int(round(x * n)) for x in c)
        i = index.get(key)
        if i is None:
            i = len(verts)
            index[key] = i
            verts.append(c)
        return i

    for fi, (ax, sg, ua, va) in enumerate(faces):
        grid = np.zeros((n + 1, n + 1), int)
        for j in range(n + 1):
            for i in range(n + 1):
                c = [0.0, 0.0, 0.0]
                c[ax] = float(sg)
                c[ua] = -1.0 + 2.0 * i / n
                c[va] = -1.0 + 2.0 * j / n
                grid[j, i] = vid(tuple(c))
        ox, oy = atlas[fi]
        for j in range(n):
            for i in range(n):
                a, b, c_, d = grid[j, i], grid[j, i + 1], grid[j + 1, i + 1], grid[j + 1, i]
                # Orientation: the quad's normal must point along +sg on axis ax.
                pa, pb, pd = np.array(verts[a]), np.array(verts[b]), np.array(verts[d])
                nrm = np.cross(pb - pa, pd - pa)
                corner_uv = [
                    ((ox + i / n) / 3, (oy + j / n) / 2),
                    ((ox + (i + 1) / n) / 3, (oy + j / n) / 2),
                    ((ox + (i + 1) / n) / 3, (oy + (j + 1) / n) / 2),
                    ((ox + i / n) / 3, (oy + (j + 1) / n) / 2),
                ]
                if nrm[ax] * sg > 0:
                    quads.append((a, b, c_, d))
                    uvs.append(corner_uv)
                else:
                    quads.append((a, d, c_, b))
                    uvs.append([corner_uv[0], corner_uv[3], corner_uv[2], corner_uv[1]])
    v = np.array(verts, float)
    # Spherify (even spacing, no poles).
    x, y, z = v[:, 0], v[:, 1], v[:, 2]
    sx = x * np.sqrt(1 - y * y / 2 - z * z / 2 + y * y * z * z / 3)
    sy = y * np.sqrt(1 - z * z / 2 - x * x / 2 + z * z * x * x / 3)
    sz = z * np.sqrt(1 - x * x / 2 - y * y / 2 + x * x * y * y / 3)
    d = np.stack([sx, sy, sz], -1)
    d /= _len(d)[:, None]
    return d, np.array(quads, int), np.array(uvs, float)


def neighbours(quads, nv):
    nb = [set() for _ in range(nv)]
    for q in quads:
        for k in range(4):
            a, b = q[k], q[(k + 1) % 4]
            nb[a].add(b)
            nb[b].add(a)
    return [np.array(sorted(s), int) for s in nb]


def cast_outermost(f, core, dirs, tmax=2.5, steps=160):
    """For each direction, the outermost crossing of the surface along the ray from the core."""
    core = np.asarray(core, float)
    n = len(dirs)
    ts = np.linspace(tmax, 0.0, steps)
    hit = np.full(n, np.nan)
    prev_t = np.full(n, tmax)
    found = np.zeros(n, bool)
    for t in ts[1:]:
        p = core + dirs * t
        inside = (f(p) < 0) & ~found
        if inside.any():
            idx = np.where(inside)[0]
            lo = np.full(len(idx), t)  # inside
            hi = prev_t[idx]  # outside
            for _ in range(30):
                mid = 0.5 * (lo + hi)
                pm = core + dirs[idx] * mid[:, None]
                m_in = f(pm) < 0
                lo = np.where(m_in, mid, lo)
                hi = np.where(m_in, hi, mid)
            hit[idx] = 0.5 * (lo + hi)
            found[idx] = True
        prev_t = np.where(found, prev_t, t)
        if found.all():
            break
    hit = np.where(np.isnan(hit), 0.3, hit)
    return core + dirs * hit[:, None]


def relax(f, p, nb, iters=40, lam=0.5):
    for _ in range(iters):
        avg = np.stack([p[ix].mean(0) for ix in nb])
        n = normal(f, p)
        d = avg - p
        d -= (d * n).sum(-1)[:, None] * n
        p = newton(f, p + lam * d, 2)
    return p


def build(shape, n=25, relax_iters=36):
    """Vertices (V,3), normals (V,3), quads (Q,4), corner uvs (Q,4,2)."""
    f = SHAPES[shape]
    dirs, quads, uvs = quad_sphere(n)
    p = cast_outermost(f, CORE[shape], dirs)
    nb = neighbours(quads, len(p))
    p = relax(f, p, nb, relax_iters)
    nrm = normal(f, p)
    return p, nrm, quads, uvs


# ---------------------------------------------------------------- measuring


def bounds(p):
    return dict(
        bottom=float(p[:, 1].min()),
        top=float(p[:, 1].max()),
        halfWidth=float(np.abs(p[:, 0]).max()),
        halfDepth=float(np.abs(p[:, 2]).max()),
    )


def ray_front(f, x, y, zmax=1.5):
    """The front surface point at (x, y): march in from +z."""
    zs = np.linspace(zmax, -zmax, 600)
    pts = np.stack([np.full_like(zs, x), np.full_like(zs, y), zs], -1)
    v = f(pts)
    inside = np.where(v < 0)[0]
    if len(inside) == 0:
        return None
    i = inside[0]
    lo, hi = zs[i], zs[i - 1]
    for _ in range(40):
        m = 0.5 * (lo + hi)
        if f(np.array([[x, y, m]]))[0] < 0:
            lo = m
        else:
            hi = m
    pt = np.array([x, y, 0.5 * (lo + hi)])
    return pt, normal(f, pt[None])[0]


def half_width_at(f, y, zmid=0.0):
    xs = np.linspace(1.5, 0, 600)
    pts = np.stack([xs, np.full_like(xs, y), np.full_like(xs, zmid)], -1)
    v = f(pts)
    inside = np.where(v < 0)[0]
    if len(inside) == 0:
        return 0.0
    return float(xs[inside[0]])


def lerp(a, b, t):
    return a + (b - a) * t


def face_layout(shape, eyes=None):
    """Eye frames (position, normal, radius) for an avatar's eye controls (size, gap, y in 0..1)."""
    eyes = eyes or {}
    f = SHAPES[shape]
    fc = FACE[shape]
    ty = eyes.get("y", 0.35)
    tg = eyes.get("gap", 0.5)
    ts = eyes.get("size", 0.55)
    H = fc["top"]
    y = lerp(*fc["y"], ty) * H
    hw = fc.get("hw") or half_width_at(f, y, 0.0)
    x = lerp(*fc["gap"], tg) * hw
    r = lerp(*fc["r"], ts) * H
    out = []
    for sx in (-1, 1):
        hit = ray_front(f, sx * x, y)
        if hit is None:
            continue
        out.append(dict(p=hit[0], n=hit[1], r=r))
    return out


def head_top(shape):
    """The crown: where headwear sits. For eared shapes, the saddle between the ears."""
    f = SHAPES[shape]
    ys = np.linspace(1.6, 0, 1200)
    pts = np.stack([np.zeros_like(ys), ys, np.full_like(ys, -0.02)], -1)
    v = f(pts)
    i = np.where(v < 0)[0][0]
    p = np.array([0.0, ys[i], -0.02])
    return p, normal(f, p[None])[0]


def ring_at(shape, y):
    """The horizontal cross-section at height y: (centre z, radius x, radius z)."""
    f = SHAPES[shape]
    rx = half_width_at(f, y)
    zs = np.linspace(1.5, -1.5, 900)
    pts = np.stack([np.zeros_like(zs), np.full_like(zs, y), zs], -1)
    v = f(pts)
    ins = np.where(v < 0)[0]
    if len(ins) == 0:
        return 0.0, rx, rx
    zf = zs[ins[0]]
    zb = zs[ins[-1]]
    return float((zf + zb) / 2), rx, float((zf - zb) / 2)


def outline(shape, samples=96):
    """The front silhouette as a polygon (x, y), for the flat placeholder."""
    f = SHAPES[shape]
    c = np.array(CORE[shape], float)
    out = []
    for k in range(samples):
        a = 2 * math.pi * k / samples
        d = np.array([math.sin(a), math.cos(a)])
        best = 0.0
        for t in np.linspace(1.8, 0, 360):
            x = c[0] + d[0] * t
            y = c[1] + d[1] * t
            zs = np.linspace(-1, 1, 41)
            pts = np.stack([np.full_like(zs, x), np.full_like(zs, y), zs], -1)
            if (f(pts) < 0).any():
                best = t
                break
        out.append((float(c[0] + d[0] * best), float(c[1] + d[1] * best)))
    return out


def to_blender(p):
    """glTF (x, y up, z front) to Blender (x, y back, z up): (x, -z, y)."""
    p = np.asarray(p, float)
    return np.stack([p[..., 0], -p[..., 2], p[..., 1]], -1)


if __name__ == "__main__":
    import time

    for s in SHAPES:
        t0 = time.time()
        p, n, q, uv = build(s, 25, 30)
        b = bounds(p)
        eyes = face_layout(s)
        print(f"{s:12s} verts={len(p)} quads={len(q)} {b} eyes={[(e['p'].round(3).tolist(), round(e['r'], 3)) for e in eyes]} {time.time() - t0:.1f}s")


# ---------------------------------------------------------------- anchors
#
# Where accessories attach, per shape (glTF space, stretch 0). The live
# renderer reads these from the manifest; Blender compositions use them too.

NECK_Y = {
    "pebble": 0.2, "mochi": 0.16, "bean": 0.27, "drop": 0.17, "gumdrop": 0.16, "marshmallow": 0.22,
    "peanut": 0.58, "star": 0.25, "orb": 0.2, "cub": 0.18, "kit": 0.18, "lop": 0.18,
}
NECK_Y["drop"] = 0.21
CAP_DEPTH = {"gumdrop": 0.27, "drop": 0.22, "bean": 0.2, "star": 0.2, "peanut": 0.2}
EARED = {"cub": 0.35, "kit": 0.31, "lop": 0.3}


def surface_along(f, core, d):
    d = np.asarray(d, float)
    d = d / np.linalg.norm(d)
    p = cast_outermost(f, core, d[None])[0]
    return p, normal(f, p[None])[0]


def anchors(shape):
    f = SHAPES[shape]
    core = np.array(CORE[shape], float)
    fc = FACE[shape]
    H = fc["top"]
    # Crown: the top of the head (between the ears on eared shapes).
    top_p, top_n = head_top(shape)
    cap_y = top_p[1] - CAP_DEPTH.get(shape, 0.17) * H
    cz, rx, rz = ring_at(shape, cap_y)
    if shape in EARED:
        rx = min(rx, EARED[shape] - 0.04)
    crown = dict(p=top_p, n=top_n, r=float(rx), rz=float(rz), capY=float(cap_y), cz=float(cz))
    # Ears: the sides of the head a little above the eyes.
    eye_y = lerp(*fc["y"], 0.35) * H
    ear_y = eye_y + 0.16 * H
    if shape == "peanut":
        ear_y = eye_y + 0.1 * H
    ears = []
    for sx in (-1, 1):
        zs = np.linspace(-0.05, 0.05, 3)
        xs = np.linspace(1.5, 0, 900)
        pts = np.stack([sx * xs, np.full_like(xs, ear_y), np.full_like(xs, -0.03)], -1)
        v = f(pts)
        i = np.where(v < 0)[0][0]
        p = np.array([sx * xs[i], ear_y, -0.03])
        ears.append(dict(p=p, n=normal(f, p[None])[0]))
    # Neck: a ring under the face.
    ny = NECK_Y[shape] * (H if shape != "peanut" else 1.0)
    ncz, nrx, nrz = ring_at(shape, ny)
    neck = dict(y=float(ny), cz=float(ncz), rx=float(nrx), rz=float(nrz))
    # Pin: high on the viewer's right of the face.
    pin_p, pin_n = surface_along(f, core, (0.5, 0.74, 0.55))
    if shape in ("cub", "kit"):
        pin_p, pin_n = surface_along(f, core, (0.7, 0.55, 0.5))
    # The body's highest point (ear tips on eared shapes), for arcs that pass over the head.
    top = float(cast_outermost(f, core, np.array([[0.0, 1.0, 0.0]]))[0][1])
    if shape in EARED:
        top = max(top, float(cast_outermost(f, core, np.array([[0.45, 0.89, -0.05]]) / np.linalg.norm([0.45, 0.89, -0.05]))[0][1]))
    return dict(crown=crown, ears=ears, neck=neck, pin=dict(p=pin_p, n=pin_n), height=float(H), top=top)


def jsonable(x):
    if isinstance(x, dict):
        return {k: jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [jsonable(v) for v in x]
    if isinstance(x, np.ndarray):
        return [round(float(v), 4) for v in x.ravel()]
    if isinstance(x, (np.floating, float)):
        return round(float(x), 4)
    return x


def vertex_ao(shape, p, nrm, samples=48, dist=0.35, seed=7):
    """Ambient occlusion per vertex from the field itself (and the ground): 1 open .. 0 enclosed."""
    f = SHAPES[shape]
    rng = np.random.default_rng(seed)
    dirs = rng.normal(size=(samples, 3))
    dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
    occ = np.zeros(len(p))
    wsum = np.zeros(len(p))
    steps = np.linspace(0.04, dist, 7)
    for d in dirs:
        cos = nrm @ d
        m = cos > 0.05
        if not m.any():
            continue
        hit = np.zeros(m.sum(), bool)
        base = p[m] + nrm[m] * 0.01
        for t in steps:
            q = base + d * t
            hit |= (f(q) < 0) | (q[:, 1] < 0)
        occ[m] += hit * cos[m]
        wsum[m] += cos[m]
    ao = 1.0 - occ / np.maximum(wsum, 1e-6)
    return np.clip(ao, 0, 1)


def fur_shape_mask(shape, gl):
    """Fur length multiplier from the body's own form: shorter on the base it sits on,
    on thin parts (ears, tips, star points) and on ears, so their shapes read."""
    f = SHAPES[shape]
    gl = np.asarray(gl, float)
    leng = np.clip(gl[:, 1] / 0.12, 0.45, 1.0)
    nrm = normal(f, gl)
    depth = np.full(len(gl), 0.6)
    for t in np.linspace(0.04, 0.6, 15)[::-1]:
        outside = f(gl - nrm * t) > 0
        depth = np.where(outside, t, depth)
    leng *= np.clip(depth / 0.42, 0.42, 1.0)
    if shape in ("cub", "kit"):
        w = np.clip((gl[:, 1] - 0.74) / 0.08, 0, 1) * np.clip((np.abs(gl[:, 0]) - 0.12) / 0.08, 0, 1)
        leng *= 1 - 0.45 * w
    if shape == "lop":
        w = np.clip((np.abs(gl[:, 0]) - 0.36) / 0.06, 0, 1)
        leng *= 1 - 0.4 * w
    return leng
