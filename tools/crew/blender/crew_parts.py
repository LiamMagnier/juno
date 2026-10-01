"""
The crew's parts as geometry (pure numpy, glTF space: x across, y up, z toward the viewer).

Every accessory is a few parts modeled in a CANONICAL frame, so one mesh fits
every body shape through a handful of numbers from the manifest:

  crown      hats. Origin at the centre of the hat band, the band a unit circle
             in the xz plane; the hat is scaled by the head's radius there.
  point      things that stand on the crown or pin to the head (sprout,
             antenna, flower). Origin at the surface point, +y out of it,
             modeled in body units (the body is about 1 tall).
  rim        eyewear rims and lenses, unit radius, centred on the eye, facing +z.
  span       a unit-length piece along +x (bridges), stretched between rims.
  temple     a unit-length piece along -z (back toward the ear).
  arc        a unit half-ellipse over the head from (-1, 0) to (1, 0) through
             (0, 1) in the xy plane (headphone and headband arcs).
  ear        a piece centred on an ear point, facing +x (mirrored for the left).
  ring       neck pieces: a unit circle in the xz plane at the neck.
  front      a piece hanging on the front of the neck ring (bandana, bow, scarf tail).

Parts carry a material key; the build script turns keys into Blender
materials (Cycles) and plain PBR materials (glb).
"""

from __future__ import annotations

import math
import numpy as np

TAU = math.tau


# ---------------------------------------------------------------- builders


class Geo:
    def __init__(self):
        self.v = []
        self.f = []

    def add(self, verts, faces):
        o = sum(len(x) for x in self.v)
        self.v.append(np.asarray(verts, float))
        self.f.extend([[i + o for i in face] for face in faces])
        return self

    def merge(self, other):
        o = sum(len(x) for x in self.v)
        ov = np.concatenate(other.v) if other.v else np.zeros((0, 3))
        self.v.append(ov)
        self.f.extend([[i + o for i in face] for face in other.f])
        return self

    def arrays(self):
        return (np.concatenate(self.v) if self.v else np.zeros((0, 3))), self.f

    def transform(self, m=None, t=(0, 0, 0), s=(1, 1, 1)):
        m = np.eye(3) if m is None else np.asarray(m, float)
        self.v = [(x * np.asarray(s, float)) @ m.T + np.asarray(t, float) for x in self.v]
        return self


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def lathe(profile, seg=48, cap_top=True, cap_bottom=False):
    """Surface of revolution around y. profile: [(r, y), ...] from bottom to top."""
    g = Geo()
    prof = np.asarray(profile, float)
    n = len(prof)
    verts = []
    for j in range(seg):
        a = TAU * j / seg
        for r, y in prof:
            verts.append((r * math.sin(a), y, r * math.cos(a)))
    faces = []
    for j in range(seg):
        j2 = (j + 1) % seg
        for i in range(n - 1):
            a, b = j * n + i, j2 * n + i
            c, d = j2 * n + i + 1, j * n + i + 1
            faces.append([a, b, c, d])
    verts = np.array(verts)
    if cap_top and prof[-1, 0] > 1e-6:
        ci = len(verts)
        verts = np.vstack([verts, [[0, prof[-1, 1], 0]]])
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append([j * n + n - 1, j2 * n + n - 1, ci])
    if cap_bottom and prof[0, 0] > 1e-6:
        ci = len(verts)
        verts = np.vstack([verts, [[0, prof[0, 1], 0]]])
        for j in range(seg):
            j2 = (j + 1) % seg
            faces.append([j2 * n, j * n, ci])
    return g.add(verts, faces)


def ellipsoid(c=(0, 0, 0), r=(1, 1, 1), seg=32, rings=16, m=None):
    prof = [(math.sin(math.pi * i / rings), -math.cos(math.pi * i / rings)) for i in range(rings + 1)]
    prof[0] = (0.0, -1.0)
    prof[-1] = (0.0, 1.0)
    g = lathe(prof, seg, cap_top=False)
    return g.transform(m, c, r)


def tube(points, radius, seg=12, closed=False, caps=True, flat=1.0):
    """Sweep a circle (or a flattened ellipse) along a polyline with parallel-transport frames."""
    P = np.asarray(points, float)
    n = len(P)
    R = np.broadcast_to(np.asarray(radius, float), (n,)).copy()
    T = np.zeros_like(P)
    for i in range(n):
        if closed:
            T[i] = P[(i + 1) % n] - P[i - 1]
        else:
            T[i] = P[min(i + 1, n - 1)] - P[max(i - 1, 0)]
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    # Initial normal.
    a = np.array([0, 1, 0]) if abs(T[0][1]) < 0.9 else np.array([1, 0, 0])
    N = np.zeros_like(P)
    N[0] = np.cross(T[0], np.cross(a, T[0]))
    N[0] /= np.linalg.norm(N[0])
    for i in range(1, n):
        v = N[i - 1] - (N[i - 1] @ T[i]) * T[i]
        N[i] = v / np.linalg.norm(v)
    B = np.cross(T, N)
    verts = []
    for i in range(n):
        for k in range(seg):
            t = TAU * k / seg
            verts.append(P[i] + R[i] * (math.cos(t) * N[i] + flat * math.sin(t) * B[i]))
    faces = []
    rng = n if closed else n - 1
    for i in range(rng):
        i2 = (i + 1) % n
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append([i * seg + k, i * seg + k2, i2 * seg + k2, i2 * seg + k])
    verts = np.array(verts)
    if caps and not closed:
        c0 = len(verts)
        verts = np.vstack([verts, P[0][None], P[-1][None]])
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append([k2, k, c0])
            faces.append([(n - 1) * seg + k, (n - 1) * seg + k2, c0 + 1])
    return Geo().add(verts, faces)


def circle_pts(r=1.0, n=64, plane="xz", y=0.0, start=0.0, end=TAU, rz=None):
    rz = r if rz is None else rz
    ts = np.linspace(start, end, n)
    if plane == "xz":
        return np.stack([r * np.sin(ts), np.full_like(ts, y), rz * np.cos(ts)], -1)
    return np.stack([r * np.cos(ts), rz * np.sin(ts), np.full_like(ts, y)], -1)


def superellipse_pts(a=1.0, b=1.0, e=4.0, n=64):
    ts = np.linspace(0, TAU, n, endpoint=False)
    c, s = np.cos(ts), np.sin(ts)
    x = a * np.sign(c) * np.abs(c) ** (2 / e)
    y = b * np.sign(s) * np.abs(s) ** (2 / e)
    return np.stack([x, y, np.zeros_like(x)], -1)


def disc(r=1.0, seg=48, z=0.0, scale=(1, 1)):
    v = [(0, 0, z)] + [(r * scale[0] * math.cos(TAU * k / seg), r * scale[1] * math.sin(TAU * k / seg), z) for k in range(seg)]
    f = [[0, 1 + k, 1 + (k + 1) % seg] for k in range(seg)]
    return Geo().add(v, f)


def dome_lens(r=1.0, depth=0.18, seg=40, rings=6, shape=None):
    """A slightly convex lens facing +z (unit), optional superellipse outline."""
    verts = [(0, 0, depth)]
    faces = []
    for i in range(1, rings + 1):
        t = i / rings
        for k in range(seg):
            a = TAU * k / seg
            if shape is None:
                x, y = math.cos(a), math.sin(a)
            else:
                c, s = math.cos(a), math.sin(a)
                x = math.copysign(abs(c) ** (2 / shape), c)
                y = math.copysign(abs(s) ** (2 / shape), s)
            verts.append((r * t * x, r * t * y, depth * (1 - t * t)))
    for k in range(seg):
        faces.append([0, 1 + k, 1 + (k + 1) % seg])
    for i in range(1, rings):
        o0 = 1 + (i - 1) * seg
        o1 = 1 + i * seg
        for k in range(seg):
            k2 = (k + 1) % seg
            faces.append([o0 + k, o1 + k, o1 + k2, o0 + k2])
    return Geo().add(verts, faces)


# ---------------------------------------------------------------- the parts
#
# Each returns {part_name: (Geo, material_key, anchor_kind)}.


def part_cap():
    # A soft six-panel cap: a dome a little bigger than the band, a button, a curved brim.
    prof = [(1.14, -0.04)] + [(1.14 * math.cos(math.pi / 2 * t), 0.92 * math.sin(math.pi / 2 * t)) for t in np.linspace(0.04, 1, 14)]
    crown = lathe(prof, 56)
    button = ellipsoid((0, 0.92, 0), (0.12, 0.07, 0.12), 20, 10)
    # Brim: a curved, flattened half-disc out of the front.
    verts, faces = [], []
    nu, nv = 24, 6
    for i in range(nu + 1):
        a = -math.pi * 0.62 + math.pi * 1.24 * i / nu
        for j in range(nv + 1):
            t = j / nv
            r = 1.1 + 0.8 * t * (math.cos((a) * 0.85) ** 0.6 if abs(a) < math.pi / 2 else 0.0)
            x = math.sin(a) * r
            z = math.cos(a) * r
            y = 0.02 - 0.16 * t * t - 0.05 * (math.sin(a) ** 2) * t
            verts.append((x, y, z))
    for i in range(nu):
        for j in range(nv):
            a = i * (nv + 1) + j
            faces.append([a, a + nv + 1, a + nv + 2, a + 1])
    top = np.array(verts)
    bot = top.copy()
    bot[:, 1] -= 0.05
    nverts = len(top)
    allv = np.vstack([top, bot])
    allf = [f for f in faces] + [[x + nverts for x in f[::-1]] for f in faces]
    # Close the outer and side edges.
    for i in range(nu):
        a, b = i * (nv + 1) + nv, (i + 1) * (nv + 1) + nv
        allf.append([a, b, b + nverts, a + nverts])
    for j in range(nv):
        a, b = j, j + 1
        allf.append([b, a, a + nverts, b + nverts])
        a, b = nu * (nv + 1) + j, nu * (nv + 1) + j + 1
        allf.append([a, b, b + nverts, a + nverts])
    brim = Geo().add(allv, allf)
    return {"cap.crown": (crown, "acc", "crown"), "cap.button": (button, "acc", "crown"), "cap.brim": (brim, "acc_dark", "crown")}


def part_beanie():
    # A knit dome with a turned-up cuff and a fluffy pompom.
    prof = [(1.12, 0.32)] + [(1.1 * math.cos(math.pi / 2 * t) + 0.02, 0.32 + 0.98 * math.sin(math.pi / 2 * t)) for t in np.linspace(0.05, 1, 16)]
    dome = lathe(prof, 56)
    cuff = lathe([(1.04, -0.06), (1.16, -0.04), (1.2, 0.08), (1.2, 0.26), (1.16, 0.36), (1.06, 0.38)], 56, cap_top=False)
    pom = ellipsoid((0, 1.42, 0), (0.36, 0.33, 0.36), 28, 14)
    return {"beanie.dome": (dome, "acc", "crown"), "beanie.cuff": (cuff, "acc", "crown"), "beanie.pom": (pom, "acc_light", "crown")}


def part_bucket():
    prof = [(1.16, -0.02), (1.14, 0.2), (1.08, 0.5), (1.0, 0.72), (0.9, 0.82), (0.62, 0.87), (0.0, 0.88)]
    crown = lathe(prof, 56, cap_top=False)
    brim = lathe([(1.14, 0.0), (1.4, -0.1), (1.72, -0.24), (1.76, -0.27), (1.7, -0.28), (1.38, -0.15), (1.12, -0.06)], 56, cap_top=False)
    band = lathe([(1.17, 0.02), (1.165, 0.17)], 56, cap_top=False)
    return {"bucket.crown": (crown, "acc", "crown"), "bucket.brim": (brim, "acc", "crown"), "bucket.band": (band, "acc_dark", "crown")}


def part_sprout():
    # A short curved stem and two leaves (body units).
    stem_pts = [(0, 0, 0), (0.0, 0.06, 0.0), (0.012, 0.12, 0.0), (0.02, 0.17, 0.0)]
    stem = tube(stem_pts, [0.018, 0.016, 0.014, 0.013], 10)
    leaves = Geo()
    for side in (-1, 1):
        lf = ellipsoid((0, 0, 0), (0.085, 0.016, 0.045), 24, 10)
        # Curl the leaf up at its tip.
        v = lf.v[0]
        v[:, 1] += 0.5 * (v[:, 0] / 0.085) ** 2 * 0.04
        lf.transform(rot_z(side * 0.5) @ rot_y(0.0), (0.02 + side * 0.075, 0.18 + 0.02, 0.0))
        leaves.merge(lf)
    return {"sprout.stem": (stem, "stem", "point"), "sprout.leaves": (leaves, "leaf", "point")}


def part_antenna():
    pts = [(0, 0, 0), (0.004, 0.08, 0), (0.016, 0.16, 0.0), (0.032, 0.23, 0.0)]
    stem = tube(pts, [0.016, 0.014, 0.012, 0.011], 10)
    ball = ellipsoid((0.036, 0.275, 0), (0.075, 0.075, 0.075), 24, 12)
    return {"antenna.stem": (stem, "stem_dark", "point"), "antenna.ball": (ball, "acc", "point")}


def part_flower():
    g = Geo()
    n = 5
    for k in range(n):
        a = TAU * k / n + math.pi / 2
        p = ellipsoid((0, 0, 0), (0.052, 0.036, 0.022), 20, 8)
        v = p.v[0]
        v[:, 2] += 0.012 * (1 - (v[:, 0] / 0.052) ** 2)
        p.transform(rot_z(a), (0.05 * math.cos(a), 0.05 * math.sin(a), 0.0))
        g.merge(p)
    # Facing +y (out of the surface): rotate so the face looks along +y.
    g.transform(rot_x(-math.pi / 2))
    centre = ellipsoid((0, 0.024, 0), (0.03, 0.02, 0.03), 20, 10)
    return {"flower.petals": (g, "petal", "point"), "flower.centre": (centre, "acc", "point")}


def part_eyewear():
    rim_round = tube(circle_pts(1.0, 56, "xy"), 0.075, 8, closed=True)
    sq = superellipse_pts(1.08, 0.92, 4.5, 56)
    rim_square = tube(sq, 0.12, 8, closed=True, flat=0.9)
    lens_round = dome_lens(0.98, 0.16, 48, 6)
    lens_square = dome_lens(1.02, 0.16, 48, 6, shape=4.5)
    lens_square.transform(None, (0, 0, 0), (1.04, 0.9, 1))
    # Bridge: a gentle arch spanning x from 0 to 1.
    bx = np.linspace(0, 1, 16)
    bridge = tube(np.stack([bx, 0.18 * np.sin(bx * math.pi), np.zeros_like(bx)], -1), 0.06, 8)
    bridge_thick = tube(np.stack([bx, 0.14 * np.sin(bx * math.pi), np.zeros_like(bx)], -1), 0.1, 8, flat=0.8)
    tz = np.linspace(0, 1, 12)
    temple = tube(np.stack([np.zeros_like(tz), -0.02 * tz, -tz], -1), 0.055, 8)
    # Monocle chain: a drooping curve from the rim's bottom out to the side.
    ct = np.linspace(0, 1, 40)
    chain = tube(np.stack([0.9 * ct, -1.0 - 1.6 * np.sin(ct * math.pi) * 0.5 - ct * 0.9, -0.6 * ct], -1), 0.022, 6)
    return {
        "eyewear.rim_round": (rim_round, "metal", "rim"),
        "eyewear.rim_square": (rim_square, "acetate", "rim"),
        "eyewear.lens_round": (lens_round, "glass", "rim"),
        "eyewear.lens_square": (lens_square, "glass", "rim"),
        "eyewear.lens_shade": (lens_square, "shade", "rim"),
        "eyewear.bridge": (bridge, "metal", "span"),
        "eyewear.bridge_thick": (bridge_thick, "acetate", "span"),
        "eyewear.temple": (temple, "metal", "temple"),
        "eyewear.chain": (chain, "metal", "rim"),
    }


def part_headphones():
    # Arc: unit half-ellipse, flat band cross-section.
    t = np.linspace(0, math.pi, 64)
    arc = tube(np.stack([-np.cos(t), np.sin(t), np.zeros_like(t)], -1), 0.07, 10, flat=0.55)
    # Ear cup: a rounded cylinder facing +x, unit radius.
    cup = lathe([(0.0, -0.5), (0.86, -0.5), (1.0, -0.38), (1.0, 0.2), (0.92, 0.38), (0.7, 0.46), (0.0, 0.48)], 40, cap_top=False)
    cup.transform(rot_z(-math.pi / 2))
    pad = lathe([(0.0, 0.0), (0.82, 0.0), (0.98, 0.1), (0.98, 0.28), (0.8, 0.36), (0.0, 0.36)], 40, cap_top=False)
    pad.transform(rot_z(math.pi / 2), (-0.5, 0, 0))
    return {"headphones.arc": (arc, "acc_dark", "arc"), "headphones.cup": (cup, "acc", "ear"), "headphones.pad": (pad, "acc_dark", "ear")}


def part_headband():
    t = np.linspace(0.05, math.pi - 0.05, 64)
    band = tube(np.stack([-np.cos(t), np.sin(t), np.zeros_like(t)], -1), 0.11, 12, flat=0.7)
    knot = ellipsoid((0, 0, 0), (0.16, 0.12, 0.1), 20, 10)
    return {"headband.band": (band, "acc", "arc"), "headband.knot": (knot, "acc", "arc")}


def part_earbuds():
    bud = ellipsoid((0.0, 0, 0), (0.55, 0.5, 0.5), 20, 10)
    stem = tube([(0.1, -0.2, 0.15), (0.12, -0.8, 0.25), (0.12, -1.3, 0.3)], 0.17, 10)
    return {"earbuds.bud": (bud.merge(stem), "vinyl_white", "ear")}


def part_hoops():
    ring = tube(circle_pts(1.0, 40, "xy", y=0.0), 0.09, 8, closed=True)
    ring.transform(rot_y(math.pi / 2), (0, -1.0, 0))
    return {"hoops.ring": (ring, "metal", "ear")}


def part_scarf():
    ring = tube(circle_pts(1.0, 64, "xz"), 0.2, 12, closed=True, flat=0.8)
    ring.transform(None, (0, 0, 0), (1, 1, 1))
    # The tail: a flat band hanging from the front-right, a little wavy.
    ts = np.linspace(0, 1, 18)
    tail_pts = np.stack([0.6 + 0.05 * np.sin(ts * 3), -0.05 - 0.6 * ts, 0.84 + 0.05 * ts], -1)
    tail = tube(tail_pts, 0.15, 14, flat=0.35)
    return {"scarf.ring": (ring, "knit", "ring"), "scarf.tail": (tail, "knit", "ring")}


def part_bandana():
    # A triangle of cloth draped over the front half of the neck ring.
    verts, faces = [], []
    nu, nv = 24, 10
    for i in range(nu + 1):
        u = -1 + 2 * i / nu
        for j in range(nv + 1):
            v = j / nv
            half = (1 - v) * 0.95
            x = u * half
            a = x  # angle around the ring
            r = 1.02 + 0.03 * v
            y = -v * 0.85 * (1 - 0.25 * abs(u))
            verts.append((r * math.sin(a), y, r * math.cos(a) + 0.08 * v))
    for i in range(nu):
        for j in range(nv):
            a = i * (nv + 1) + j
            faces.append([a, a + nv + 1, a + nv + 2, a + 1])
    cloth = Geo().add(verts, faces)
    band = tube(circle_pts(1.02, 64, "xz"), 0.06, 8, closed=True)
    knot = ellipsoid((0, 0.02, -1.02), (0.12, 0.09, 0.08), 16, 8)
    return {"bandana.cloth": (cloth, "canvas", "ring"), "bandana.band": (band.merge(knot), "canvas", "ring")}


def part_bow():
    # A plump ribbon bow (body units), facing +z: two round loops, a knot, two short tails.
    g = Geo()
    for side in (-1, 1):
        loop = ellipsoid((0, 0, 0), (0.08, 0.062, 0.04), 28, 14)
        v = loop.v[0]
        # Pinch each loop toward the knot so it reads as folded ribbon.
        k = np.clip(1 - side * v[:, 0] / 0.08, 0, 2) * 0.5
        v[:, 1] *= 1 - 0.5 * k
        v[:, 2] *= 1 - 0.35 * k
        loop.transform(rot_z(side * 0.12), (side * 0.075, 0.01, 0))
        g.merge(loop)
        tt = np.linspace(0, 1, 8)
        tail = np.stack([side * (0.012 + 0.032 * tt), -0.025 - 0.06 * tt, -0.004 * tt], -1)
        g.merge(tube(tail, np.linspace(0.026, 0.022, 8), 10, flat=0.45))
    knot = ellipsoid((0, 0, 0.012), (0.034, 0.038, 0.032), 20, 10)
    return {"bow.ribbon": (g, "velvet", "front"), "bow.knot": (knot, "velvet", "front")}


def all_parts():
    out = {}
    for fn in (part_cap, part_beanie, part_bucket, part_sprout, part_antenna, part_flower, part_eyewear, part_headphones, part_headband, part_earbuds, part_hoops, part_scarf, part_bandana, part_bow):
        out.update(fn())
    return out


# Which parts make each accessory (and how the fitter places them).
ACCESSORY_PARTS = {
    "cap": ["cap.crown", "cap.button", "cap.brim"],
    "beanie": ["beanie.dome", "beanie.cuff", "beanie.pom"],
    "bucket": ["bucket.crown", "bucket.brim", "bucket.band"],
    "headband": ["headband.band", "headband.knot"],
    "sprout": ["sprout.stem", "sprout.leaves"],
    "antenna": ["antenna.stem", "antenna.ball"],
    "flower": ["flower.petals", "flower.centre"],
    "round": ["eyewear.rim_round", "eyewear.lens_round", "eyewear.bridge", "eyewear.temple"],
    "square": ["eyewear.rim_square", "eyewear.lens_square", "eyewear.bridge_thick", "eyewear.temple"],
    "shades": ["eyewear.rim_square", "eyewear.lens_shade", "eyewear.bridge_thick", "eyewear.temple"],
    "monocle": ["eyewear.rim_round", "eyewear.lens_round", "eyewear.chain"],
    "headphones": ["headphones.arc", "headphones.cup", "headphones.pad"],
    "earbuds": ["earbuds.bud"],
    "hoops": ["hoops.ring"],
    "bow": ["bow.ribbon", "bow.knot"],
    "scarf": ["scarf.ring", "scarf.tail"],
    "bandana": ["bandana.cloth", "bandana.band"],
}


# ---------------------------------------------------------------- eyes and features


def eye_parts():
    """Unit eye pieces (radius 1 in x and y, facing +z)."""
    out = {}
    out["eye.dome"] = ellipsoid((0, 0, 0), (1, 1, 1), 32, 16)
    # Sleepy: the lower part of a dome under a soft lid line.
    d = ellipsoid((0, 0, 0), (1, 1, 1), 32, 16)
    v = d.v[0]
    v[:, 1] = np.minimum(v[:, 1], 0.18 + 0.0 * v[:, 0])
    out["eye.sleepy"] = d
    out["eye.white"] = ellipsoid((0, 0, 0), (1, 1, 1), 32, 16)
    out["eye.pupil"] = ellipsoid((0, 0, 0), (1, 1, 0.25), 32, 12)
    out["eye.cover"] = ellipsoid((0, 0, 0), (1, 1, 1), 32, 16)
    out["eye.glint"] = disc(1.0, 32)
    out["eye.stitch_hi"] = ellipsoid((-0.28, 0.42, 0.9), (0.16, 0.3, 0.12), 16, 8, m=rot_z(-0.5))
    # Closed eyes: one soft stroke, ‿ (asleep) and ∩ (smiling shut). Unit width.
    t = np.linspace(0.15 * math.pi, 0.85 * math.pi, 24)
    out["eye.closed"] = tube(np.stack([np.cos(t), 0.22 - np.sin(t) * 0.5, np.zeros_like(t)], -1), 0.12, 8)
    out["eye.smiling"] = tube(np.stack([np.cos(t), np.sin(t) * 0.5 - 0.22, np.zeros_like(t)], -1), 0.12, 8)
    # Brow: a short soft stroke. Mouth: a small smile, and an "o".
    bt = np.linspace(-1, 1, 12)
    out["brow"] = tube(np.stack([bt, 0.12 * (1 - bt * bt), np.zeros_like(bt)], -1), 0.16, 8)
    st = np.linspace(0.2 * math.pi, 0.8 * math.pi, 18)
    out["mouth.smile"] = tube(np.stack([np.cos(st), 0.3 - np.sin(st) * 0.62, np.zeros_like(st)], -1), 0.12, 8)
    out["mouth.o"] = ellipsoid((0, 0, 0), (1, 1, 0.45), 24, 10)
    return out
