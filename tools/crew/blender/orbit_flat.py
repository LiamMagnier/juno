"""
Flat 2D icons of the Orbit agents, derived from the same 3D characters.

For sizes of 48 px and under (sidebar, lists, the agents tree, chips) a shrunk
render goes soft and muddy; these are crisp vectors instead. Each icon is the
character seen straight on: for every part (body, accessories, eyes) the front
surface is found by marching rays through its signed distance field, so the
parts occlude each other exactly as in 3D; each visible region is traced into
a smooth path (marching squares, simplified, Catmull-Rom to cubic Béziers) in
its flat colour, with at most one soft tonal shade (where the surface turns
away from an upper-left light). Same silhouette, same eyes, same states.

  blender --background --factory-startup --python orbit_flat.py -- <out.json> [--ts <out.ts>]

Output: {variant: {id: {state: {"vb": 64, "layers": [[fill, d], ...]}}}} with
variant "full" (48 px) and "small" (28 px and under: bigger eyes, fine parts dropped).
numpy only (no bpy); Blender is just the Python with numpy.
"""

from __future__ import annotations

import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import flock_cast as C  # noqa: E402
import orbit_cast as O  # noqa: E402

GRID = int(os.environ.get("GRID", 176))
VB = 64.0
LIGHT = np.array([-0.55, -0.62, 0.56])
LIGHT /= np.linalg.norm(LIGHT)


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) for i in (0, 2, 4)], float)


def rgb_hex(c):
    c = np.clip(np.round(c), 0, 255).astype(int)
    return "#%02x%02x%02x" % tuple(c)


def shade_of(hexc, k=0.82):
    """The tonal shade: darker, a touch more saturated, a hair cooler."""
    c = hex_rgb(hexc)
    m = c.mean()
    c = m + (c - m) * 1.08
    return rgb_hex(c * k + np.array([0, 2, 8]) * (1 - k))


# ---------------------------------------------------------------- depth


def depth_map(f, X, Z, lo, hi, y0=-1.4, y1=1.4, dy=0.011):
    """First-hit y along +y for every grid point (inf where missed)."""
    H, W = X.shape
    D = np.full(H * W, np.inf)
    xs = X.ravel()
    zs = Z.ravel()
    sel = np.ones(H * W, bool)
    if lo is not None and hi is not None:
        sel &= (xs >= lo[0] - 0.02) & (xs <= hi[0] + 0.02) & (zs >= lo[2] - 0.02) & (zs <= hi[2] + 0.02)
        y0 = max(y0, lo[1] - 0.02)
        y1 = min(y1, hi[1] + 0.02)
    idx = np.nonzero(sel)[0]
    y = y0
    while y <= y1 and len(idx):
        P = np.stack([xs[idx], np.full(len(idx), y), zs[idx]], -1)
        v = f(P)
        hit = v < 0
        if hit.any():
            D[idx[hit]] = y
            idx = idx[~hit]
        y += dy
    return D.reshape(H, W)


def blur(A, r):
    if r <= 0:
        return A
    k = np.exp(-0.5 * (np.arange(-3 * r, 3 * r + 1) / r) ** 2)
    k /= k.sum()
    B = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 0, A)
    return np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), 1, B)


# ---------------------------------------------------------------- contours

SEG = {
    1: [("l", "b")], 2: [("b", "r")], 3: [("l", "r")], 4: [("t", "r")], 5: [("l", "t"), ("b", "r")],
    6: [("t", "b")], 7: [("l", "t")], 8: [("l", "t")], 9: [("t", "b")], 10: [("t", "r"), ("l", "b")],
    11: [("t", "r")], 12: [("l", "r")], 13: [("b", "r")], 14: [("l", "b")],
}


def contours(F, level=0.5):
    F = np.pad(F, 1, constant_values=0.0)
    H, W = F.shape
    up = F > level
    case = up[:-1, :-1] * 8 + up[:-1, 1:] * 4 + up[1:, 1:] * 2 + up[1:, :-1] * 1
    I, J = np.nonzero((case > 0) & (case < 15))
    pts = {}

    def key(i, j, e):
        if e == "t":
            return ("h", i, j)
        if e == "b":
            return ("h", i + 1, j)
        if e == "l":
            return ("v", i, j)
        return ("v", i, j + 1)

    def point(k):
        if k in pts:
            return pts[k]
        kind, i, j = k
        if kind == "h":
            v1, v2 = F[i, j], F[i, j + 1]
            t = (level - v1) / (v2 - v1 + 1e-12)
            p = (j + t - 1, i - 1)
        else:
            v1, v2 = F[i, j], F[i + 1, j]
            t = (level - v1) / (v2 - v1 + 1e-12)
            p = (j - 1, i + t - 1)
        pts[k] = p
        return p

    adj = {}
    for i, j in zip(I, J):
        for a, b in SEG[int(case[i, j])]:
            ka, kb = key(i, j, a), key(i, j, b)
            adj.setdefault(ka, []).append(kb)
            adj.setdefault(kb, []).append(ka)
    loops = []
    seen = set()
    for start in adj:
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        prev, cur = None, start
        while True:
            nxt = [n for n in adj[cur] if n != prev and n not in seen]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            seen.add(cur)
            loop.append(cur)
        if len(loop) > 4:
            loops.append(np.array([point(k) for k in loop]))
    return loops


def simplify(P, eps):
    """Douglas-Peucker on a closed loop."""
    if len(P) < 5:
        return P

    def dp(Q):
        a, b = Q[0], Q[-1]
        ab = b - a
        n = np.hypot(*ab) + 1e-12
        d = np.abs(np.cross(ab, Q - a)) / n
        i = int(np.argmax(d))
        if d[i] > eps:
            return np.vstack([dp(Q[: i + 1])[:-1], dp(Q[i:])])
        return np.vstack([a, b])

    k = len(P) // 2
    return np.vstack([dp(P[: k + 1])[:-1], dp(np.vstack([P[k:], P[:1]]))[:-1]])


def to_path(P):
    n = len(P)
    if n < 3:
        return ""
    f = lambda v: f"{v:.2f}".rstrip("0").rstrip(".")
    d = f"M{f(P[0][0])} {f(P[0][1])}"
    for i in range(n):
        p0, p1, p2, p3 = P[(i - 1) % n], P[i], P[(i + 1) % n], P[(i + 2) % n]
        c1 = p1 + (p2 - p0) / 6
        c2 = p2 - (p3 - p1) / 6
        d += f"C{f(c1[0])} {f(c1[1])} {f(c2[0])} {f(c2[1])} {f(p2[0])} {f(p2[1])}"
    return d + "Z"


# ---------------------------------------------------------------- icon


def icon(spec, grid=GRID, small=False):
    c = O.character(spec)
    parts = [p for p in c.parts]
    # A coarse look for the window, then the fine grid.
    def window(n, x0, x1, z0, z1):
        xs = np.linspace(x0, x1, n)
        zs = np.linspace(z1, z0, n)
        X, Z = np.meshgrid(xs, zs)
        return X, Z

    X, Z = window(64, -1.35, 1.35, -0.05, 1.65)
    occ = np.zeros(X.shape, bool)
    for p in parts:
        occ |= np.isfinite(depth_map(p["f"], X, Z, p.get("lo"), p.get("hi"), dy=0.03))
    zi, xi = np.nonzero(occ)
    x0, x1 = X[0, xi.min()], X[0, xi.max()]
    z0, z1 = Z[zi.max(), 0], Z[zi.min(), 0]
    cx, cz = 0.5 * (x0 + x1), 0.5 * (z0 + z1)
    half = 0.5 * max(x1 - x0, z1 - z0) * 1.1 + 0.04
    X, Z = window(grid, cx - half, cx + half, cz - half, cz + half)
    cell = 2 * half / (grid - 1)
    Ds = [depth_map(p["f"], X, Z, p.get("lo"), p.get("hi")) for p in parts]
    D = np.stack(Ds)
    # Ties at the ray step go to the part added later (a pupil over its white, a
    # decal over the body it sits on): decals sit a hair in front of the surface.
    for k, p in enumerate(parts):
        D[k] -= 1e-4 * k + (0.02 if p["kind"] == "decal" else 0.0)
    vis = np.argmin(D, axis=0)
    hitany = np.isfinite(D.min(axis=0))
    scale = VB / (grid - 1)
    layers = []
    order = []
    for k, p in enumerate(parts):
        m = (vis == k) & hitany
        if m.sum() < (2 if p["kind"] == "decal" else 6):
            continue
        order.append((float(np.median(D[k][m])), k, m))
    order.sort(key=lambda t: -t[0])  # far first
    for _, k, m in order:
        p = parts[k]
        col = p["color"]
        if p["kind"] == "glow":
            col = O.PAL["flare"] if p["name"] == "accretion" else O.PAL["flare_hot"]
        # dilate a hair so neighbours meet without a seam (nearer parts paint over)
        eye = p["kind"] == "decal"
        F = blur(m.astype(float), 0.8 if eye else 1.0)
        d = "".join(to_path(simplify(L, 0.35 if eye else 0.45) * scale) for L in contours(F, 0.45 if eye else 0.38))
        if d:
            layers.append([col, d, p["name"]])
        if p["kind"] in ("decal",) or small and p["name"] not in ("body",):
            continue
        # the one tonal shade: where the surface turns away from the light
        # The part's own surface, continuous under whatever covers it (eyes, hats),
        # so a decal never casts a ring of shade.
        own = np.isfinite(Ds[k])
        Dk = np.where(own, Ds[k], np.nanmax(np.where(own, Ds[k], np.nan)))
        Ds_ = blur(Dk, 2.0)
        gz, gx = np.gradient(Ds_, -cell, cell)  # rows go down in z
        n = np.stack([gx, -np.ones_like(gx), gz], -1)
        n /= np.linalg.norm(n, axis=-1, keepdims=True)
        lam = n @ LIGHT
        sh = m & (lam < float(os.environ.get("SHADE_T", 0.42)))
        if sh.sum() > 12:
            F2 = blur(sh.astype(float), 2.2) * m
            d = "".join(to_path(simplify(L, 0.5) * scale) for L in contours(F2, 0.5))
            if d:
                layers.append([shade_of(col), d, p["name"] + "~shade"])
    return {"vb": VB, "layers": layers}


def main():
    args = sys.argv[sys.argv.index("--") + 1 :]
    out = args[0]
    ts = args[args.index("--ts") + 1] if "--ts" in args else None
    only = os.environ.get("ONLY", "").split(",") if os.environ.get("ONLY") else None
    res = {"full": {}, "small": {}}
    for m in O.CAST:
        if only and m["id"] not in only:
            continue
        for st in O.STATES:
            s = O.with_state(m, st)
            res["full"].setdefault(m["id"], {})[st] = icon(O.icon_spec(s))
            res["small"].setdefault(m["id"], {})[st] = icon(O.sprite_spec(s), small=True)
            print("ICON", m["id"], st, flush=True)
    if not only or "mira" in only:
        for k in range(len(O.CUSTOM)):
            s = O.with_state(O.custom_spec(O.BY_ID["mira"], k), "ready")
            res["full"].setdefault(f"mira_custom{k}", {})["ready"] = icon(O.icon_spec(s))
            res["small"].setdefault(f"mira_custom{k}", {})["ready"] = icon(O.sprite_spec(s), small=True)
            print("ICON custom", k, flush=True)
    with open(out, "w") as fh:
        json.dump(res, fh, separators=(",", ":"))
    if ts:
        with open(ts, "w") as fh:
            fh.write("/* Generated by tools/crew/blender/orbit_flat.py from the 3D Orbit agents. Do not edit by hand. */\n/* eslint-disable */\n")
            fh.write("export type OrbitIcon = { vb: number; layers: [string, string, string][] };\n")
            fh.write("export const ORBIT_ICONS: Record<\"full\" | \"small\", Record<string, Record<string, OrbitIcon>>> = ")
            fh.write(json.dumps(res, separators=(",", ":")))
            fh.write(";\n")
    print("DONE", out, flush=True)


main()
