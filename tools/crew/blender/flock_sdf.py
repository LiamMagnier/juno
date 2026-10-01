"""
Signed distance fields and a mesher for the flocked crew (numpy only, no bpy).

Coordinates are Blender's: x to the viewer's right, y away from the viewer,
z up. A character stands on z = 0, is about one unit tall and faces -y.

  primitives      sphere, ellipsoid, round_box, capsule, round_cone, torus ...
  2D regions      ellipse2, rrect2, arc2, seg2, star2, circle2 (for decals)
  decal()         a 2D region projected along y onto a thin shell over the body:
                  eyes, arcs and bands sit ON the surface as raised appliques
  mesh()          naive surface nets + Newton projection onto the zero set,
                  then a few tangential relaxation steps: clean, even quads
                  for any topology (crescents and holes included)
"""

from __future__ import annotations

import math
import numpy as np

# ---------------------------------------------------------------- helpers


def L(v):
    return np.sqrt(np.maximum((v * v).sum(-1), 1e-18))


def smin(a, b, k):
    if k <= 0:
        return np.minimum(a, b)
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0.0, 1.0)
    return b * (1.0 - h) + a * h - k * h * (1.0 - h)


def smax(a, b, k):
    return -smin(-a, -b, k)


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def rot(p, c, axis, ang):
    """Rotate points p about the axis ('x','y','z') through c by ang radians."""
    q = p - np.asarray(c, float)
    ca, sa = math.cos(ang), math.sin(ang)
    out = q.copy()
    if axis == "x":
        out[:, 1] = ca * q[:, 1] - sa * q[:, 2]
        out[:, 2] = sa * q[:, 1] + ca * q[:, 2]
    elif axis == "y":
        out[:, 0] = ca * q[:, 0] + sa * q[:, 2]
        out[:, 2] = -sa * q[:, 0] + ca * q[:, 2]
    else:
        out[:, 0] = ca * q[:, 0] - sa * q[:, 1]
        out[:, 1] = sa * q[:, 0] + ca * q[:, 1]
    return out + np.asarray(c, float)


# ---------------------------------------------------------------- 3D primitives


def sphere(p, c, r):
    return L(p - np.asarray(c, float)) - r


def ellipsoid(p, c, r):
    r = np.asarray(r, float)
    q = p - np.asarray(c, float)
    k0 = L(q / r)
    k1 = L(q / (r * r))
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def round_box(p, c, b, r):
    q = np.abs(p - np.asarray(c, float)) - (np.asarray(b, float) - r)
    return L(np.maximum(q, 0.0)) + np.minimum(np.max(q, -1), 0.0) - r


def capsule(p, a, b, r):
    a = np.asarray(a, float)
    b = np.asarray(b, float)
    pa = p - a
    ba = b - a
    h = np.clip((pa @ ba) / float(ba @ ba), 0.0, 1.0)
    return L(pa - h[:, None] * ba) - r


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
    k = math.copysign(1.0, rr) * rr * rr * x2 if rr != 0 else np.zeros_like(x2)
    out = np.empty(len(p))
    m1 = np.sign(z) * a2 * z2 > k
    m2 = np.sign(y) * a2 * y2 < k
    m3 = ~(m1 | m2)
    out[m1] = np.sqrt(x2[m1] + z2[m1]) * il2 - r2
    out[m2] = np.sqrt(x2[m2] + y2[m2]) * il2 - r1
    out[m3] = (np.sqrt(x2[m3] * a2 * il2) + y[m3] * rr) * il2 - r1
    return out


def torus(p, c, R, r, axis="z"):
    q = p - np.asarray(c, float)
    if axis == "z":
        a, b = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2), q[:, 2]
    elif axis == "y":
        a, b = np.sqrt(q[:, 0] ** 2 + q[:, 2] ** 2), q[:, 1]
    else:
        a, b = np.sqrt(q[:, 1] ** 2 + q[:, 2] ** 2), q[:, 0]
    return np.sqrt((a - R) ** 2 + b * b) - r


def cyl_z(p, c, r, h, rb=0.0, sx=1.0, sy=1.0):
    """A z-aligned cylinder of radius r, half height h, rounded edge rb (elliptic with sx, sy)."""
    q = p - np.asarray(c, float)
    rxy = np.sqrt((q[:, 0] / sx) ** 2 + (q[:, 1] / sy) ** 2)
    d = np.stack([rxy - r + rb, np.abs(q[:, 2]) - h + rb], -1)
    return np.minimum(np.maximum(d[:, 0], d[:, 1]), 0.0) + L(np.maximum(d, 0.0)) - rb


def lathe(p, c, prof2):
    """Revolve a 2D field prof2(r, z) about the vertical axis through c."""
    q = p - np.asarray(c, float)
    r = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)
    return prof2(r, q[:, 2])


def extrude_y(p, d2, y0, y1, rb=0.0):
    """Extrude a 2D field d2 (of x, z) between y0 and y1 (rounded by rb)."""
    yc = 0.5 * (y0 + y1)
    hy = 0.5 * (y1 - y0)
    w = np.stack([d2 + rb, np.abs(p[:, 1] - yc) - hy + rb], -1)
    return np.minimum(np.maximum(w[:, 0], w[:, 1]), 0.0) + L(np.maximum(w, 0.0)) - rb


# ---------------------------------------------------------------- 2D regions (x, z)


def circle2(x, z, c, r):
    return np.sqrt((x - c[0]) ** 2 + (z - c[1]) ** 2) - r


def ellipse2(x, z, c, a, b, ang=0.0):
    """Approximate ellipse distance (good near the boundary)."""
    X = x - c[0]
    Z = z - c[1]
    if ang:
        ca, sa = math.cos(ang), math.sin(ang)
        X, Z = ca * X + sa * Z, -sa * X + ca * Z
    k0 = np.sqrt((X / a) ** 2 + (Z / b) ** 2)
    k1 = np.sqrt((X / (a * a)) ** 2 + (Z / (b * b)) ** 2)
    return k0 * (k0 - 1.0) / np.maximum(k1, 1e-9)


def rrect2(x, z, c, hw, hh, r, ang=0.0):
    X = x - c[0]
    Z = z - c[1]
    if ang:
        ca, sa = math.cos(ang), math.sin(ang)
        X, Z = ca * X + sa * Z, -sa * X + ca * Z
    qx = np.abs(X) - hw + r
    qz = np.abs(Z) - hh + r
    return np.sqrt(np.maximum(qx, 0) ** 2 + np.maximum(qz, 0) ** 2) + np.minimum(np.maximum(qx, qz), 0) - r


def seg2(x, z, a, b, r):
    ax, az = a
    bx, bz = b
    px, pz = x - ax, z - az
    dx, dz = bx - ax, bz - az
    h = np.clip((px * dx + pz * dz) / (dx * dx + dz * dz + 1e-12), 0, 1)
    return np.sqrt((px - h * dx) ** 2 + (pz - h * dz) ** 2) - r


def arc2(x, z, c, R, a0, a1, w):
    """A round-capped stroke of half-width w along the arc of radius R from angle a0 to a1 (radians, ccw from +x)."""
    X = x - c[0]
    Z = z - c[1]
    ang = np.arctan2(Z, X)
    am = 0.5 * (a0 + a1)
    half = 0.5 * (a1 - a0)
    d = np.mod(ang - am + math.pi, 2 * math.pi) - math.pi
    inside = np.abs(d) <= half
    rr = np.sqrt(X * X + Z * Z)
    on = np.abs(rr - R)
    e0 = np.array([math.cos(a0), math.sin(a0)]) * R
    e1 = np.array([math.cos(a1), math.sin(a1)]) * R
    d0 = np.sqrt((X - e0[0]) ** 2 + (Z - e0[1]) ** 2)
    d1 = np.sqrt((X - e1[0]) ** 2 + (Z - e1[1]) ** 2)
    return np.where(inside, on, np.minimum(d0, d1)) - w


def star2(x, z, c, r, rf, n=5, ang=0.0):
    """Quilez's regular star (a point up). rf 0 a polygon .. 1 sharp points."""
    X = x - c[0]
    Z = z - c[1]
    if ang:
        ca, sa = math.cos(ang), math.sin(ang)
        X, Z = ca * X + sa * Z, -sa * X + ca * Z
    an = math.pi / n
    en = math.pi / (2.0 + rf * (n - 2.0))
    acs = (math.cos(an), math.sin(an))
    ecs = (math.cos(en), math.sin(en))
    xa = np.abs(X)
    a = np.arctan2(xa, Z)
    bn = np.mod(a, 2.0 * an) - an
    l = np.sqrt(xa * xa + Z * Z)
    qx = l * np.cos(bn) - r * acs[0]
    qy = l * np.abs(np.sin(bn)) - r * acs[1]
    d = qx * ecs[0] + qy * ecs[1]
    t = np.clip(-d, 0.0, r * acs[1] / ecs[1])
    qx = qx + ecs[0] * t
    qy = qy + ecs[1] * t
    return np.sqrt(qx * qx + qy * qy) * np.sign(qx)


def half_disc2(x, z, c, r, up=True, rb=0.0):
    """A D shape: a disc cut flat on top (up=True keeps the lower half: a 'smiling' eye is the upper half)."""
    d = circle2(x, z, c, r)
    cut = (z - c[1]) if up else (c[1] - z)
    return np.maximum(d, cut)


# ---------------------------------------------------------------- field utils


def grad(f, p, e=1.2e-3):
    g = np.empty_like(p)
    for i in range(3):
        d = np.zeros(3)
        d[i] = e
        g[:, i] = (f(p + d) - f(p - d)) / (2 * e)
    return g


def normalized(f, e=1.2e-3):
    """f divided by |grad f|: an accurate distance near the surface (shells need it)."""

    def g(p):
        v = f(p)
        gr = grad(f, p, e)
        return v / np.maximum(L(gr), 0.2)

    return g


def ray_front(f, x, z, y0=-2.0, y1=2.0, steps=160):
    """First hit of f along +y from y0 at (x, z) (sphere tracing). Returns y (nan when missed)."""
    x = np.atleast_1d(np.asarray(x, float))
    z = np.atleast_1d(np.asarray(z, float))
    y = np.full(len(x), y0)
    done = np.zeros(len(x), bool)
    for _ in range(steps):
        p = np.stack([x, y, z], -1)
        d = f(p)
        hit = d < 1e-4
        done |= hit
        y = np.where(done, y, y + np.maximum(d * 0.8, 2e-4))
        if np.all(done | (y > y1)):
            break
    y = np.where(done, y, np.nan)
    return y


def ray_down(f, x, y, z0=3.0, steps=200):
    x = np.atleast_1d(np.asarray(x, float))
    y = np.atleast_1d(np.asarray(y, float))
    z = np.full(len(x), z0)
    done = np.zeros(len(x), bool)
    for _ in range(steps):
        p = np.stack([x, y, z], -1)
        d = f(p)
        done |= d < 1e-4
        z = np.where(done, z, z - np.maximum(d * 0.8, 2e-4))
        if np.all(done | (z < -1)):
            break
    return np.where(done, z, np.nan)


def surface_point(f, x, z):
    """The front surface point at face coordinates (x, z) and its unit normal."""
    y = float(ray_front(f, [x], [z])[0])
    p = np.array([[x, y, z]])
    n = grad(f, p)[0]
    n /= np.linalg.norm(n)
    return np.array([x, y, z]), n


def bounds(f, lo=(-1.2, -1.2, -0.3), hi=(1.2, 1.2, 1.8), h=0.03):
    """Bounding box of f < 0 by coarse sampling."""
    lo = np.asarray(lo, float)
    hi = np.asarray(hi, float)
    n = np.ceil((hi - lo) / h).astype(int) + 1
    xs = [lo[i] + np.arange(n[i]) * h for i in range(3)]
    P = np.stack(np.meshgrid(*xs, indexing="ij"), -1).reshape(-1, 3)
    v = np.concatenate([f(P[i : i + 400000]) for i in range(0, len(P), 400000)])
    ins = P[v < h]
    if len(ins) == 0:
        return None
    return ins.min(0) - h, ins.max(0) + h


# ---------------------------------------------------------------- decals


def decal(body, region, off0=0.004, off1=0.016, ycut=None, rb=None, zmin=None):
    """A raised applique: the region (a 2D field of x, z) on the shell off0..off1 above the body.

    body must be (close to) a true distance near its surface: wrap it with normalized().
    ycut keeps only the front (y < ycut) so the projection does not hit the back too.
    """
    t = 0.5 * (off1 - off0)
    m = 0.5 * (off0 + off1)
    rb = t * 0.9 if rb is None else rb

    def f(p):
        d = body(p)
        shell = np.abs(d - m) - t
        r = region(p[:, 0], p[:, 2])
        g = smax(shell, r + 0.0, rb)
        if ycut is not None:
            g = np.maximum(g, p[:, 1] - ycut)
        if zmin is not None:
            g = np.maximum(g, zmin - p[:, 2])
        return g

    return f


# ---------------------------------------------------------------- mesher


def _eval(f, P, chunk=300000):
    return np.concatenate([f(P[i : i + chunk]) for i in range(0, len(P), chunk)]) if len(P) else np.zeros(0)


def surface_nets(f, lo, hi, h):
    lo = np.asarray(lo, float)
    hi = np.asarray(hi, float)
    n = np.ceil((hi - lo) / h).astype(int) + 1
    nx, ny, nz = (int(v) for v in n)
    xs = lo[0] + np.arange(nx) * h
    ys = lo[1] + np.arange(ny) * h
    zs = lo[2] + np.arange(nz) * h
    P = np.stack(np.meshgrid(xs, ys, zs, indexing="ij"), -1).reshape(-1, 3)
    F = _eval(f, P).reshape(nx, ny, nz)
    F = np.where(np.abs(F) < 1e-9, 1e-9, F)
    ins = F < 0
    cx, cy, cz = nx - 1, ny - 1, nz - 1
    acc = np.zeros((cx * cy * cz, 3))
    cnt = np.zeros(cx * cy * cz)

    def cell_id(i, j, k):
        return (i * cy + j) * cz + k

    quads = []
    for axis in range(3):
        if axis == 0:
            a, b = F[:-1, :, :], F[1:, :, :]
        elif axis == 1:
            a, b = F[:, :-1, :], F[:, 1:, :]
        else:
            a, b = F[:, :, :-1], F[:, :, 1:]
        sc = (a < 0) != (b < 0)
        I, J, K = np.nonzero(sc)
        fa = a[I, J, K]
        fb = b[I, J, K]
        t = fa / (fa - fb)
        pt = np.stack([xs[I], ys[J], zs[K]], -1)
        pt[:, axis] += t * h
        lo_in = fa < 0
        # The four cells around each edge.
        if axis == 0:
            offs = [(0, -1, -1), (0, 0, -1), (0, 0, 0), (0, -1, 0)]
        elif axis == 1:
            offs = [(-1, 0, -1), (-1, 0, 0), (0, 0, 0), (0, 0, -1)]
        else:
            offs = [(-1, -1, 0), (0, -1, 0), (0, 0, 0), (-1, 0, 0)]
        cells = []
        valid = np.ones(len(I), bool)
        for di, dj, dk in offs:
            ci, cj, ck = I + di, J + dj, K + dk
            ok = (ci >= 0) & (ci < cx) & (cj >= 0) & (cj < cy) & (ck >= 0) & (ck < cz)
            valid &= ok
            cid = cell_id(np.clip(ci, 0, cx - 1), np.clip(cj, 0, cy - 1), np.clip(ck, 0, cz - 1))
            np.add.at(acc, cid[ok], pt[ok])
            np.add.at(cnt, cid[ok], 1)
            cells.append(cid)
        cells = np.stack(cells, -1)[valid]
        flip = ~lo_in[valid]
        cells[flip] = cells[flip][:, ::-1]
        quads.append(cells)
    quads = np.concatenate(quads, 0)
    used = np.nonzero(cnt > 0)[0]
    remap = -np.ones(len(cnt), int)
    remap[used] = np.arange(len(used))
    V = acc[used] / cnt[used][:, None]
    Q = remap[quads]
    Q = Q[(Q >= 0).all(1)]
    return V, Q


def project(f, V, iters=4):
    for _ in range(iters):
        d = f(V)
        g = grad(f, V)
        g2 = np.maximum((g * g).sum(-1), 1e-6)
        V = V - (d / g2)[:, None] * g
    return V


def relax(f, V, Q, iters=3, lam=0.5):
    """Tangential Laplacian smoothing, reprojected onto the surface each step."""
    nV = len(V)
    edges = np.concatenate([Q[:, [0, 1]], Q[:, [1, 2]], Q[:, [2, 3]], Q[:, [3, 0]]], 0)
    edges = np.concatenate([edges, edges[:, ::-1]], 0)
    deg = np.bincount(edges[:, 0], minlength=nV).astype(float)
    for _ in range(iters):
        s = np.zeros_like(V)
        np.add.at(s, edges[:, 0], V[edges[:, 1]])
        avg = s / np.maximum(deg, 1)[:, None]
        g = grad(f, V)
        nrm = g / np.maximum(L(g), 1e-9)[:, None]
        dv = avg - V
        dv -= (dv * nrm).sum(-1, keepdims=True) * nrm
        V = V + lam * dv
        V = project(f, V, 2)
    return V


def mesh(f, h=0.012, lo=None, hi=None, relax_iters=3):
    if lo is None or hi is None:
        b = bounds(f, h=max(h * 2.5, 0.02))
        if b is None:
            return np.zeros((0, 3)), np.zeros((0, 4), int)
        lo, hi = b
    V, Q = surface_nets(f, lo, hi, h)
    if len(V) == 0:
        return V, Q
    V = project(f, V, 4)
    if relax_iters:
        V = relax(f, V, Q, relax_iters)
    return V, Q
