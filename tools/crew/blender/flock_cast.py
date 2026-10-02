"""
The flocked crew: bodies, graphic eyes and bold accessories as fields (numpy only).

Three candidate style sheets (pass 1), six characters each:

  A  "Soft solids"   toy-block geometry (pill, soft cube, gumdrop, bell, mochi,
                     button); small matte DOT eyes; bold oversized felt hats.
  B  "Snack bar"     food icons (onigiri, toast, jelly bean, macaron, acorn,
                     peach bun); flat white STICKER eyes with black pupils and
                     closed arcs; food-part accessories built into the shape.
  C  "Soft symbols"  glyph shapes (soft star, crescent, sparkle, bolt, droplet,
                     flower); round button eyes, happy half-moons, sleepy arcs,
                     one-piece shades. Agents never become planets.

Rules every character follows (the creepiness diagnosis):
  - graphic eyes only: matte black shapes, white stickers with a black pupil,
    closed arcs, or opaque shades. No catchlight, iris or wet shine.
  - no mouth, no blush. Eyes low on the face (below the middle of the mass).
  - one bold iconic silhouette, readable at 20 px; accessories matte and big.

A character is a list of parts: dict(name, f, h, kind, color, fuzz, lo, hi).
kind: "body" (velvet flock + fuzz), "felt" (flocked accessory + fuzz),
"matte" (graphic, no fuzz), "decal" (raised applique on the body, matte).
"""

from __future__ import annotations

import math
import os

import numpy as np

import flock_sdf as S
from flock_sdf import smin, smax

INK = "#17171c"
EYE_SCALE = float(os.environ.get("EYE_SCALE", 1.8))
WHITE = "#fbfaf6"

# ---------------------------------------------------------------- palette
# Clean, saturated, premium (not neon); the softer ones are for customization.
PAL = {
    "cobalt": "#2f5cff",
    "tomato": "#ff5a3c",
    "tangerine": "#ff8a1f",
    "sunflower": "#ffd21f",
    "chartreuse": "#b4e02a",
    "emerald": "#1fc48d",
    "aqua": "#1cc4d8",
    "violet": "#7d5cff",
    "magenta": "#ff3d9a",
    "bubblegum": "#ff8cc6",
    "lilac": "#b8a4ff",
    "butter": "#ffe07c",
    "sky": "#8ccbff",
    "peach": "#ffb08a",
    "mint": "#9eeac7",
    "rice": "#f6f1e6",
    "crust": "#e7a03c",
    "crumb": "#ffe0a0",
    "cocoa": "#8a5636",
    "nori": "#1f2a24",
    "cream": "#fff3dd",
}


# ---------------------------------------------------------------- helpers


def flat(f, k=0.05):
    """Sit on the floor: cut at z = 0 with a soft (plush) edge."""
    return lambda p: smax(f(p), -p[:, 2], k)


def pillow2d(d2, t0, bulge, rb, p, cap=0.3):
    """Extrude a 2D field in y into a pillow: thicker toward the middle, rounded edges."""
    t = t0 + bulge * np.sqrt(np.clip(-d2, 0.0, cap) / cap)
    return smax(d2, np.abs(p[:, 1]) - t, rb)


def tri2(x, z, c, r):
    """Quilez's equilateral triangle (point up), centred at c, 'radius' r."""
    k = math.sqrt(3.0)
    X = np.abs(x - c[0]) - r
    Z = z - c[1] + r / k
    m = X + k * Z > 0
    X2 = np.where(m, (X - k * Z) / 2, X)
    Z2 = np.where(m, (-k * X - Z) / 2, Z)
    X2 = X2 - np.clip(X2, -2 * r, 0.0)
    return -np.sqrt(X2 * X2 + Z2 * Z2) * np.sign(Z2)


def poly2(x, z, pts):
    """Quilez's exact distance to a simple polygon (x, z vertices, either winding)."""
    v = np.asarray(pts, float)
    d = (x - v[0, 0]) ** 2 + (z - v[0, 1]) ** 2
    s = np.ones_like(x)
    n = len(v)
    for i in range(n):
        j = i - 1
        ex, ez = v[j, 0] - v[i, 0], v[j, 1] - v[i, 1]
        wx, wz = x - v[i, 0], z - v[i, 1]
        t = np.clip((wx * ex + wz * ez) / (ex * ex + ez * ez), 0.0, 1.0)
        bx, bz = wx - ex * t, wz - ez * t
        d = np.minimum(d, bx * bx + bz * bz)
        c1 = z >= v[i, 1]
        c2 = z < v[j, 1]
        c3 = ex * wz > ez * wx
        flip = (c1 & c2 & c3) | (~c1 & ~c2 & ~c3)
        s = np.where(flip, -s, s)
    return s * np.sqrt(d)


# ---------------------------------------------------------------- bodies
# Each returns (f, face) where face = dict(z, gap, w, h, ycut): the default eye
# line, the eye spacing (centre to centre) and size.


def b_pill():
    def f(p):
        q = p / np.array([1.0, 0.84, 1.0])
        return S.capsule(q, (0, 0, 0.36), (0, 0, 0.68), 0.38)

    return flat(f, 0.06), dict(z=0.50, gap=0.20, w=0.056, h=0.094)


def b_cube():
    def f(p):
        b = S.round_box(p, (0, 0, 0.43), (0.44, 0.38, 0.43), 0.17)
        s = S.sphere(p, (0, 0, 0.43), 0.6)
        return b * 0.78 + s * 0.22

    return flat(f, 0.05), dict(z=0.40, gap=0.22, w=0.058, h=0.096)


def b_gumdrop():
    def f(p):
        return S.round_cone(p, (0, 0, 0.30), (0, 0, 0.78), 0.46, 0.2)

    return flat(f, 0.07), dict(z=0.36, gap=0.21, w=0.056, h=0.092)


def b_bell():
    def f(p):
        z = p[:, 2]
        rho = np.sqrt(p[:, 0] ** 2 + (p[:, 1] / 0.92) ** 2)
        dome = S.sphere(p * np.array([1, 1 / 0.92, 1]), (0, 0, 0.6), 0.35)
        t = np.clip((0.6 - z) / 0.6, 0, 1)
        R = 0.35 + 0.15 * t**2.4
        skirt = smax((rho - R) * 0.92, np.maximum(z - 0.6, -z), 0.02)
        g = smin(dome, skirt, 0.06)
        lip = S.torus(p * np.array([1, 1 / 0.92, 1]), (0, 0, 0.075), 0.45, 0.07)
        g = smin(g, lip, 0.05)
        knob = S.sphere(p, (0, 0, 1.0), 0.08)
        return smin(g, knob, 0.035)

    return flat(f, 0.03), dict(z=0.42, gap=0.2, w=0.054, h=0.09)


def b_mochi():
    def f(p):
        z = p[:, 2]
        s = 1 + 0.17 * np.clip((0.42 - z) / 0.42, 0, 1.4)
        q = p.copy()
        q[:, 0] /= s
        q[:, 1] /= s
        return S.ellipsoid(q, (0, 0, 0.34), (0.5, 0.42, 0.44))

    return flat(f, 0.09), dict(z=0.33, gap=0.24, w=0.06, h=0.098)


def b_button():
    def f(p):
        # A round disc standing on its edge, softly domed front and back.
        rho = np.sqrt(p[:, 0] ** 2 + (p[:, 2] - 0.5) ** 2)
        d2 = rho - 0.5
        return pillow2d(d2, 0.17, 0.08, 0.16, p)

    return flat(f, 0.08), dict(z=0.44, gap=0.22, w=0.058, h=0.096)


def b_onigiri():
    def f(p):
        d2 = tri2(p[:, 0], p[:, 2], (0, 0.40), 0.36) - 0.2
        return pillow2d(d2, 0.17, 0.07, 0.15, p)

    return flat(f, 0.06), dict(z=0.38, gap=0.22, w=0.06, h=0.1)


def toast2(x, z):
    body = S.rrect2(x, z, (0, 0.36), 0.42, 0.36, 0.12)
    top = S.ellipse2(x, z, (0, 0.74), 0.5, 0.26)
    return smin(body, top, 0.06)


def b_toast():
    def f(p):
        return pillow2d(toast2(p[:, 0], p[:, 2]), 0.14, 0.03, 0.1, p)

    return flat(f, 0.03), dict(z=0.42, gap=0.24, w=0.06, h=0.1)


def b_bean():
    def f(p):
        q = S.rot(p, (0, 0, 0.5), "y", math.radians(-10))
        a = S.arc2(q[:, 0], q[:, 2], (0.56, 0.5), 0.56, math.radians(148), math.radians(212), 0.0)
        return np.sqrt(a * a + (q[:, 1] / 0.86) ** 2) - 0.34

    return flat(f, 0.06), dict(z=0.46, gap=0.2, w=0.056, h=0.094, dx=-0.03)


def b_macaron():
    def f(p):
        z = p[:, 2]
        lo = S.cyl_z(p, (0, 0, 0.17), 0.46, 0.13, 0.11)
        hi = S.ellipsoid(p, (0, 0, 0.56), (0.47, 0.47, 0.22))
        hi = smax(hi, 0.44 - z, 0.06)
        return smin(lo, hi, 0.02)

    return flat(f, 0.04), dict(z=0.55, gap=0.24, w=0.058, h=0.09)


def b_acorn():
    def f(p):
        z = p[:, 2]
        s = 1 + 0.10 * np.clip((z - 0.25) / 0.5, -0.6, 1)
        q = p.copy()
        q[:, 0] /= s
        q[:, 1] /= s
        return S.ellipsoid(q, (0, 0, 0.42), (0.4, 0.36, 0.46))

    return flat(f, 0.07), dict(z=0.40, gap=0.2, w=0.054, h=0.09)


def b_bun():
    def f(p):
        a = S.ellipsoid(p, (0, 0, 0.4), (0.48, 0.44, 0.42))
        b = S.round_cone(p, (0, 0, 0.5), (0, 0.02, 0.93), 0.3, 0.035)
        return smin(a, b, 0.16)

    return flat(f, 0.08), dict(z=0.36, gap=0.24, w=0.058, h=0.096)


def b_star():
    def f(p):
        c = np.array([0.0, 0.0, 0.5])
        q = p / np.array([1.0, 0.6, 1.0])
        g = S.sphere(q, c, 0.28)
        for i in range(5):
            a = math.pi / 2 + i * 2 * math.pi / 5
            tip = c + 0.46 * np.array([math.cos(a), 0, math.sin(a)])
            g = smin(g, S.round_cone(q, c, tip, 0.24, 0.115), 0.09)
        return g * 0.6

    return flat(f, 0.04), dict(z=0.44, gap=0.2, w=0.054, h=0.09)


def b_moon():
    def f(p):
        x, z = p[:, 0], p[:, 2]
        outer = S.circle2(x, z, (0, 0.5), 0.5)
        bite = S.circle2(x, z, (0.36, 0.78), 0.34)
        d2 = smax(outer, -bite, 0.08)
        return pillow2d(d2, 0.15, 0.1, 0.14, p)

    return flat(f, 0.08), dict(z=0.38, gap=0.2, w=0.054, h=0.09, dx=-0.08)


def b_sparkle():
    def f(p):
        c = np.array([0.0, 0.0, 0.58])
        q = p / np.array([1.0, 0.6, 1.0])
        g = S.ellipsoid(q, c, (0.25, 0.25, 0.27))
        for dx, dz, ln in ((0, 1, 0.52), (0, -1, 0.52), (1, 0, 0.42), (-1, 0, 0.42)):
            tip = c + ln * np.array([dx, 0, dz])
            g = smin(g, S.round_cone(q, c, tip, 0.2, 0.065), 0.15)
        return g * 0.6

    return flat(f, 0.05), dict(z=0.54, gap=0.18, w=0.05, h=0.084)


def b_planet():
    def f(p):
        return S.sphere(p, (0, 0, 0.48), 0.48)

    return flat(f, 0.1), dict(z=0.34, gap=0.22, w=0.056, h=0.094)


def b_drop():
    def f(p):
        a = S.sphere(p, (0, 0, 0.42), 0.43)
        b = S.round_cone(p, (0, 0, 0.5), (0, 0, 1.08), 0.32, 0.03)
        return smin(a, b, 0.18)

    return flat(f, 0.08), dict(z=0.36, gap=0.22, w=0.056, h=0.094)


def b_flower():
    def f(p):
        x, z = p[:, 0], p[:, 2] - 0.52
        d = S.circle2(x, z, (0, 0), 0.3)
        for i in range(5):
            a = math.pi / 2 + i * 2 * math.pi / 5
            d = smin(d, S.circle2(x, z, (0.33 * math.cos(a), 0.33 * math.sin(a)), 0.22), 0.05)
        return pillow2d(d, 0.12, 0.1, 0.11, p)

    return flat(f, 0.04), dict(z=0.48, gap=0.16, w=0.046, h=0.08)


def b_peanut():
    def f(p):
        lo = S.ellipsoid(p, (0, 0, 0.33), (0.4, 0.36, 0.34))
        hi = S.ellipsoid(p, (0, 0, 0.8), (0.33, 0.3, 0.29))
        return smin(lo, hi, 0.16)

    return flat(f, 0.08), dict(z=0.78, gap=0.19, w=0.054, h=0.09)


BOLT = [(-0.06, 1.1), (0.4, 1.1), (0.14, 0.62), (0.4, 0.62), (-0.2, -0.04), (-0.02, 0.48), (-0.32, 0.48)]


def b_bolt():
    def f(p):
        d2 = poly2(p[:, 0], p[:, 2], BOLT) - 0.075
        return pillow2d(d2, 0.15, 0.08, 0.13, p, cap=0.2)

    return flat(f, 0.04), dict(z=0.80, gap=0.18, w=0.05, h=0.084, dx=0.05)


BODIES = {
    "bolt": b_bolt,
    "peanut": b_peanut,
    "pill": b_pill,
    "cube": b_cube,
    "gumdrop": b_gumdrop,
    "bell": b_bell,
    "mochi": b_mochi,
    "button": b_button,
    "onigiri": b_onigiri,
    "toast": b_toast,
    "bean": b_bean,
    "macaron": b_macaron,
    "acorn": b_acorn,
    "bun": b_bun,
    "star": b_star,
    "moon": b_moon,
    "sparkle": b_sparkle,
    "planet": b_planet,
    "drop": b_drop,
    "flower": b_flower,
}


# ---------------------------------------------------------------- context


class Ctx:
    """A body and everything derived from it that the parts need."""

    def __init__(self, shape):
        self.shape = shape
        self.f, self.face = BODIES[shape]()
        self.fn = S.normalized(self.f)
        self.lo, self.hi = S.bounds(self.f, h=0.02)
        self.parts = []
        self.excl = []  # 2D regions where the fuzz is left out (under decals)

    def top(self, x=0.0, y=0.0):
        return float(S.ray_down(self.f, [x], [y])[0])

    def front(self, x, z):
        return S.surface_point(self.f, x, z)

    def add(self, name, f, h, kind, color, lo=None, hi=None, fuzz=None, **kw):
        if fuzz is None:
            fuzz = kind in ("body", "felt")
        d = dict(name=name, f=f, h=h, kind=kind, color=color, fuzz=fuzz, lo=lo, hi=hi)
        d.update(kw)
        self.parts.append(d)
        return d

    def decal(self, name, region, box, color, off0=0.002, off1=0.012, ycut=0.0, excl=True, h=0.0025, zmin=None):
        """box: (x0, x1, z0, z1) of the region in face coordinates."""
        x0, x1, z0, z1 = box
        f = S.decal(self.fn, region, off0, off1, ycut=ycut, zmin=zmin)
        ys = []
        for x in np.linspace(x0, x1, 5):
            for z in np.linspace(z0, z1, 5):
                y = S.ray_front(self.f, [x], [z])[0]
                if not np.isnan(y):
                    ys.append(y)
        y0 = (min(ys) if ys else self.lo[1]) - 0.04
        y1 = (max(ys) if ys else 0.0) + 0.06
        if ycut is None:
            y0, y1 = self.lo[1] - 0.03, self.hi[1] + 0.03
        m = 0.02
        lo = (x0 - m, y0, z0 - m)
        hi = (x1 + m, min(y1, (ycut if ycut is not None else 9) + 0.01), z1 + m)
        if excl:
            self.excl.append((region, ycut))
        return self.add(name, f, h, "decal", color, lo=lo, hi=hi, fuzz=False)


# ---------------------------------------------------------------- eyes


# Line-like eyes (closed arcs) read heavier than filled ovals at the same
# scale and merge into a brow or a moustache when big: they scale less.
STYLE_SCALE = {"arc": 0.77, "sleep": 0.77, "smile": 0.83, "sleepy": 0.83, "dash": 0.78, "sticker": 0.88}


def eye_frame(c, eyes):
    fc = c.face
    z = eyes.get("z", fc["z"]) + eyes.get("dz", 0.0)
    gap = fc["gap"] * eyes.get("gap", 1.0)
    k = eyes.get("size", 1.0) * EYE_SCALE * STYLE_SCALE.get(eyes.get("style", "dot"), 1.0)
    w = fc["w"] * k
    h = fc["h"] * k
    dx = fc.get("dx", 0.0) + eyes.get("dx", 0.0)
    return z, gap, w, h, dx


def add_eyes(c, eyes):
    style = eyes.get("style", "dot")
    z, gap, w, h, dx = eye_frame(c, eyes)
    color = eyes.get("color", INK)
    for i, sx in enumerate((-1, 1)):
        cx = dx + sx * gap / 2
        st = style
        if style == "wink":
            st = "dot" if sx < 0 else "arc"
        if st == "dot":
            reg = lambda x, zz, cx=cx: S.ellipse2(x, zz, (cx, z), w / 2, h / 2)
            c.decal(f"eye{i}", reg, (cx - w, cx + w, z - h, z + h), color, 0.004, 0.022)
        elif st == "pill":
            reg = lambda x, zz, cx=cx: S.seg2(x, zz, (cx, z - h * 0.32), (cx, z + h * 0.32), w * 0.46)
            c.decal(f"eye{i}", reg, (cx - w, cx + w, z - h, z + h), color, 0.004, 0.022)
        elif st == "arc":
            # A closed, content eye: an upward arc (the lid line).
            R = w * 1.05
            reg = lambda x, zz, cx=cx: S.arc2(x, zz, (cx, z - R * 0.55), R, math.radians(28), math.radians(152), w * 0.2)
            c.decal(f"eye{i}", reg, (cx - 1.5 * R, cx + 1.5 * R, z - R, z + R), color, 0.004, 0.02)
        elif st == "round":
            r = w * eyes.get("round", 0.66)
            reg = lambda x, zz, cx=cx: S.circle2(x, zz, (cx, z), r)
            c.decal(f"eye{i}", reg, (cx - 1.4 * r, cx + 1.4 * r, z - 1.4 * r, z + 1.4 * r), color, 0.004, 0.022)
        elif st == "sleep":
            # Peacefully closed: a downward arc (the lashes line), a little lower.
            R = w * 1.0
            reg = lambda x, zz, cx=cx: S.arc2(x, zz, (cx, z + R * 0.45), R, math.radians(208), math.radians(332), w * 0.2)
            c.decal(f"eye{i}", reg, (cx - 1.5 * R, cx + 1.5 * R, z - R, z + R), color, 0.004, 0.02)
        elif st == "smile":
            # A happy half-moon: domed on top, flat underneath.
            r = w * 0.78
            reg = lambda x, zz, cx=cx: smax(S.ellipse2(x, zz, (cx, z - r * 0.35), r, r * 1.05), (z - r * 0.35) - zz + 0.0, 0.006)
            c.decal(f"eye{i}", reg, (cx - 1.4 * r, cx + 1.4 * r, z - r, z + 1.2 * r), color, 0.002, 0.013)
        elif st == "sleepy":
            # Relaxed: flat on top, round underneath.
            r = w * 0.8
            reg = lambda x, zz, cx=cx: smax(S.ellipse2(x, zz, (cx, z + r * 0.3), r, r * 0.95), zz - (z + r * 0.3), 0.006)
            c.decal(f"eye{i}", reg, (cx - 1.4 * r, cx + 1.4 * r, z - 1.2 * r, z + r), color, 0.002, 0.013)
        elif st == "dash":
            reg = lambda x, zz, cx=cx: S.seg2(x, zz, (cx - w * 0.55, z), (cx + w * 0.55, z), w * 0.2)
            c.decal(f"eye{i}", reg, (cx - w * 1.2, cx + w * 1.2, z - w, z + w), color, 0.002, 0.012)
        elif st == "sticker":
            r = w * eyes.get("white", 1.05)
            gx, gz = eyes.get("look", (0.0, 0.0))
            reg = lambda x, zz, cx=cx: S.ellipse2(x, zz, (cx, z), r, r * 1.08)
            c.decal(f"white{i}", reg, (cx - 1.3 * r, cx + 1.3 * r, z - 1.4 * r, z + 1.4 * r), WHITE, 0.004, 0.019)
            pr = r * eyes.get("pupil", 0.5)
            px, pz = cx + gx * (r - pr) * 0.85, z + gz * (r - pr) * 0.85
            reg2 = lambda x, zz, px=px, pz=pz: S.circle2(x, zz, (px, pz), pr)
            c.decal(f"pupil{i}", reg2, (px - 1.3 * pr, px + 1.3 * pr, pz - 1.3 * pr, pz + 1.3 * pr), color, 0.016, 0.024, excl=False, h=0.002)


# ---------------------------------------------------------------- accessories


def acc_bucket(c, color, tilt=-7, size=1.0, sink=0.17):
    zt = c.top() - sink * size
    s = size
    ang = math.radians(tilt)

    def f(p):
        q = S.rot(p, (0, 0, zt), "y", ang)
        q = (q - np.array([0, 0, zt])) / s

        def prof(r, z):
            crown = S.rrect2(r, z, (0, 0.15), 0.33, 0.18, 0.13)
            brim = S.seg2(r, z, (0.26, 0.03), (0.47, -0.085), 0.036)
            return smin(crown, brim, 0.05)

        return S.lathe(q, (0, 0, 0), prof) * s

    return c.add("hat", f, 0.007, "felt", color)


def acc_beanie(c, color, cuff_z=None, pom=True, rib=True, pom_color=None):
    """A knit beanie that hugs the head: the body inflated, ribbed, a fat cuff, a big pompom."""
    zt = c.top()
    cz = cuff_z if cuff_z is not None else zt - 0.30
    fn = c.fn

    def f(p):
        d = fn(p)
        ang = np.arctan2(p[:, 1], p[:, 0])
        ribs = 0.006 * np.sin(ang * 26) if rib else 0
        shell = d - 0.05 - ribs
        cap = smax(shell, cz - p[:, 2], 0.03)
        cuff = smax(d - 0.075, np.abs(p[:, 2] - (cz + 0.035)) - 0.05, 0.035)
        g = smin(cap, cuff, 0.01)
        return g

    c.add("beanie", f, 0.006, "felt", color, lo=(c.lo[0] - 0.12, c.lo[1] - 0.12, cz - 0.08), hi=(c.hi[0] + 0.12, c.hi[1] + 0.12, zt + 0.12))
    if pom:
        pr = 0.12
        c.add("pom", lambda p: S.sphere(p, (0, 0, zt + 0.05 + pr * 0.75), pr), 0.006, "felt", pom_color or color, fuzz_len=2.0)


def acc_cap(c, color, back=False):
    zt = c.top()
    cz = zt - 0.24
    fn = c.fn
    sgn = 1 if back else -1

    def crown(p):
        d = fn(p)
        return smax(d - 0.035, cz - p[:, 2], 0.02)

    c.add("cap", crown, 0.006, "felt", color, lo=(c.lo[0] - 0.1, c.lo[1] - 0.1, cz - 0.05), hi=(c.hi[0] + 0.1, c.hi[1] + 0.1, zt + 0.1))
    yb = float(S.ray_front(c.f, [0.0], [cz + 0.02])[0]) if not back else -float(S.ray_front(lambda p: c.f(p * np.array([1, -1, 1])), [0.0], [cz + 0.02])[0])

    def brim(p):
        q = S.rot(p, (0, yb, cz + 0.02), "x", math.radians(-8 * sgn))
        d2 = S.ellipse2(q[:, 0], q[:, 1], (0, yb + sgn * 0.17), 0.32, 0.22)
        d2 = smax(d2, -sgn * (q[:, 1] - yb) - 0.02, 0.02)
        return smax(d2, np.abs(q[:, 2] - (cz + 0.02)) - 0.018, 0.016)

    c.add("brim", brim, 0.005, "felt", color, lo=(-0.45, yb - 0.5, cz - 0.12), hi=(0.45, yb + 0.5, cz + 0.15))
    c.add("button", lambda p: S.sphere(p, (0, 0, zt + 0.03), 0.04), 0.004, "felt", color)


def acc_cone(c, color, ball=WHITE, tilt=12, h=0.46, r=0.22):
    zt = c.top()
    ang = math.radians(tilt)
    base = np.array([0.0, 0.0, zt - 0.07])
    tip = base + np.array([math.sin(ang) * h, 0, math.cos(ang) * h])
    c.add("cone", lambda p: S.round_cone(p, base, tip, r, 0.022), 0.005, "felt", color)
    c.add("ball", lambda p: S.sphere(p, tip + np.array([0, 0, 0.025]), 0.085), 0.004, "felt", ball, fuzz_len=1.6)


def acc_sprout(c, color=PAL["chartreuse"], tilt=6):
    zt = c.top()
    a = np.array([0.0, 0.0, zt - 0.05])
    b = np.array([0.02, 0.0, zt + 0.14])
    c.add("stem", lambda p: S.capsule(p, a, b, 0.028), 0.004, "felt", color)

    def leaf(p, side):
        q = S.rot(p, b, "y", side * math.radians(-62))
        q = S.rot(q, b, "x", math.radians(10))
        return S.ellipsoid(q, b + np.array([0, 0, 0.13]), (0.08, 0.03, 0.14))

    c.add("leafL", lambda p: leaf(p, -1), 0.004, "felt", color)
    c.add("leafR", lambda p: leaf(p, 1), 0.004, "felt", color)


def acc_frames(c, eyes, color=INK, shape="square"):
    """Chunky square frames, oversized, in front of the eyes."""
    z, gap, w, h, dx = eye_frame(c, eyes)
    hw = min(w * 1.75, gap * 0.42)
    hh = max(h * 0.86, hw * 0.92)
    ys = [c.front(dx + s * gap / 2, z)[0][1] for s in (-1, 1)]
    yf = min(ys) - 0.03
    t = 0.024

    def d2(x, zz):
        d = None
        for s in (-1, 1):
            cx = dx + s * gap / 2
            outer = S.rrect2(x, zz, (cx, z), hw, hh, hh * 0.55)
            ring = np.abs(outer + t) - t
            d = ring if d is None else np.minimum(d, ring)
        bridge = S.seg2(x, zz, (dx - gap / 2 + hw, z + hh * 0.2), (dx + gap / 2 - hw, z + hh * 0.2), t * 0.9)
        return np.minimum(d, bridge)

    c.add("frames", lambda p: S.extrude_y(p, d2(p[:, 0], p[:, 2]), yf - 0.02, yf + 0.02, 0.012), 0.003, "matte", color, lo=(-0.6, yf - 0.05, z - 0.25), hi=(0.6, yf + 0.05, z + 0.25))
    # temples, back into the head
    for i, s in enumerate((-1, 1)):
        x0 = dx + s * (gap / 2 + hw - t)
        a = np.array([x0, yf, z + hh * 0.3])
        b = np.array([x0 + s * 0.12, yf + 0.36, z + hh * 0.5])
        c.add(f"temple{i}", lambda p, a=a, b=b: S.capsule(p, a, b, 0.016), 0.003, "matte", color)


def acc_visor(c, eyes, color=INK):
    """Opaque chunky shades hugging the face: two big rounded-square lenses on a thick brow bar."""
    z, gap, w, h, dx = eye_frame(c, eyes)
    lw = gap * 0.41
    lh = h * 0.84
    hw = gap / 2 + lw

    def reg(x, zz):
        d = None
        for sx in (-1, 1):
            cx = dx + sx * gap / 2
            lens = S.rrect2(x, zz, (cx, z), lw, lh, lh * 0.62)
            d = lens if d is None else np.minimum(d, lens)
        bridge = S.seg2(x, zz, (dx - gap / 2 + lw * 0.5, z + lh * 0.45), (dx + gap / 2 - lw * 0.5, z + lh * 0.45), lh * 0.2)
        return smin(d, bridge, 0.008)

    c.decal("visor", reg, (dx - hw - 0.02, dx + hw + 0.02, z - lh - 0.02, z + lh + 0.02), color, 0.008, 0.034, ycut=0.06, h=0.003)


def acc_nightcap(c, color, pom=WHITE):
    zt = c.top(-0.05)
    a = np.array([-0.06, 0.0, zt - 0.1])
    b = a + np.array([0.06, 0.0, 0.28])
    d = b + np.array([0.24, 0.0, 0.05])
    e = d + np.array([0.12, 0.0, -0.12])

    def f(p):
        g = S.round_cone(p, a, b, 0.23, 0.14)
        g = smin(g, S.round_cone(p, b, d, 0.14, 0.07), 0.05)
        g = smin(g, S.round_cone(p, d, e, 0.07, 0.035), 0.03)
        return g

    c.add("nightcap", f, 0.006, "felt", color)
    c.add("pom", lambda p: S.sphere(p, e + np.array([0.01, 0, -0.03]), 0.08), 0.004, "felt", pom, fuzz_len=1.8)


def acc_ring(c, color, roll=-14, pitch=14, R=0.62, zc=0.56):
    """A bold flat ring round the planet, tipped so its front arc passes above the face."""

    def f(p):
        q = S.rot(p, (0, 0, zc), "y", math.radians(roll))
        q = S.rot(q, (0, 0, zc), "x", math.radians(pitch))
        rho = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)
        return smax(np.abs(rho - R) - 0.09, np.abs(q[:, 2] - zc) - 0.026, 0.024)

    c.add("ring", f, 0.006, "felt", color, lo=(-0.95, -0.95, 0.0), hi=(0.95, 0.95, 1.2))


def acc_bow(c, color, x=0.2, side=1):
    """A big flat ribbon bow, facing front: two pinched lobes and a round knot."""
    zt = c.top(x)
    yk = float(S.ray_front(c.f, [x], [zt - 0.06])[0])
    k = np.array([x, min(yk, 0.0) + 0.02, zt - 0.02])
    tilt = math.radians(-14 * side)

    def f(p):
        q = S.rot(p, k, "y", tilt)
        g = None
        for sx in (-1, 1):
            end = k + np.array([sx * 0.15, 0.0, 0.035])
            lobe = S.round_cone(q, k, end, 0.03, 0.085)
            lobe = smax(lobe, np.abs(q[:, 1] - k[1]) - 0.042, 0.03)
            g = lobe if g is None else smin(g, lobe, 0.02)
        knot = S.ellipsoid(q, k + np.array([0, -0.012, 0.0]), (0.045, 0.05, 0.05))
        return smin(g, knot, 0.015)

    c.add("bow", f, 0.004, "felt", color)


def acc_butter(c, color=PAL["butter"]):
    zt = c.top(0.05)
    k = np.array([0.05, -0.02, zt + 0.02])
    f = lambda p: S.round_box(S.rot(S.rot(p, k, "z", math.radians(22)), k, "y", math.radians(-8)), k + np.array([0, 0, 0.03]), (0.13, 0.1, 0.05), 0.03)
    c.add("butter", f, 0.004, "matte", color, sheen=0.1, rough=0.55)


def acc_leaf(c, color=PAL["emerald"], x=0.04):
    zt = c.top()
    b = np.array([0.0, 0.03, zt - 0.02])

    def f(p):
        q = S.rot(p, b, "y", math.radians(-58))
        q = S.rot(q, b, "x", math.radians(-14))
        leaf = S.ellipsoid(q, b + np.array([0, 0, 0.14]), (0.085, 0.025, 0.15))
        return leaf

    c.add("leaf", f, 0.004, "felt", color)
    c.add("stem", lambda p: S.capsule(p, b - np.array([0, 0, 0.04]), b + np.array([-0.01, 0, 0.06]), 0.022), 0.004, "felt", PAL["cocoa"])


def acc_acorncap(c, color=PAL["cocoa"]):
    zt = c.top()
    cz = zt - 0.27
    fn = c.fn

    def f(p):
        d = fn(p)
        ang = np.arctan2(p[:, 1], p[:, 0])
        bumps = 0.007 * np.sin(ang * 18) * np.sin(p[:, 2] * 120)
        cap = smax(d - 0.05 - bumps, cz - p[:, 2], 0.03)
        lip = smax(d - 0.075, np.abs(p[:, 2] - (cz + 0.02)) - 0.035, 0.03)
        return smin(cap, lip, 0.02)

    c.add("acorncap", f, 0.006, "felt", color, lo=(c.lo[0] - 0.12, c.lo[1] - 0.12, cz - 0.08), hi=(c.hi[0] + 0.12, c.hi[1] + 0.12, zt + 0.12))
    a = np.array([0, 0, zt + 0.02])
    b = np.array([0.05, 0, zt + 0.15])
    c.add("stalk", lambda p: S.round_cone(p, a, b, 0.04, 0.03), 0.004, "felt", color)


def acc_antenna(c, color=INK, ball=None):
    zt = c.top()
    a = np.array([0.0, 0.0, zt - 0.03])
    b = np.array([0.04, 0.0, zt + 0.2])
    c.add("antenna", lambda p: S.capsule(p, a, b, 0.022), 0.003, "matte", color)
    c.add("antball", lambda p: S.sphere(p, b + np.array([0.01, 0, 0.04]), 0.075), 0.004, "felt", ball or color, fuzz_len=1.6)


def acc_halo(c, color=PAL["butter"]):
    zt = c.top()
    zc = zt + 0.12

    def f(p):
        q = S.rot(p, (0, 0, zc), "x", math.radians(16))
        return S.torus(q, (0, 0, zc), 0.22, 0.035)

    c.add("halo", f, 0.004, "matte", color, sheen=0.4)


def acc_clip(c, color, x=0.2):
    """A big star hair clip on the side of the head."""
    z = c.face["z"] + 0.32
    p0, n0 = c.front(x, z)

    def reg(xx, zz):
        return S.star2(xx, zz, (x, z), 0.085, 0.5) - 0.012

    c.decal("clip", reg, (x - 0.1, x + 0.1, z - 0.1, z + 0.1), color, 0.004, 0.03, h=0.003)


def acc_nori(c, color, hw=0.9, z1=0.2):
    """The onigiri nori: a matte wrapper round the base (well below the eyes, so it never reads as a mouth)."""

    def reg(x, zz):
        return S.rrect2(x, zz, (0, (z1 - 0.3) / 2), hw, (z1 + 0.3) / 2, 0.03)

    c.decal("nori", reg, (-hw - 0.02, hw + 0.02, -0.02, z1 + 0.02), color, 0.0, 0.012, ycut=None, h=0.0035)


def acc_band(c, color, z0, z1):
    """A band that wraps all the way round (macaron filling, onigiri nori)."""

    def reg(x, zz):
        return np.abs(zz - 0.5 * (z0 + z1)) - 0.5 * (z1 - z0)

    c.decal("band", reg, (c.lo[0], c.hi[0], z0, z1), color, 0.0, 0.012, ycut=None, h=0.004)


ACCESSORIES = {
    "bucket": lambda c, a, e: acc_bucket(c, a.get("color", INK), a.get("tilt", -7), a.get("size", 1.0), a.get("sink", 0.17)),
    "beanie": lambda c, a, e: acc_beanie(c, a.get("color", INK), pom_color=a.get("pom")),
    "cap": lambda c, a, e: acc_cap(c, a.get("color", INK), a.get("back", False)),
    "cone": lambda c, a, e: acc_cone(c, a.get("color", INK), a.get("ball", WHITE)),
    "sprout": lambda c, a, e: acc_sprout(c, a.get("color", PAL["chartreuse"])),
    "frames": lambda c, a, e: acc_frames(c, e, a.get("color", INK)),
    "visor": lambda c, a, e: acc_visor(c, e, a.get("color", INK)),
    "nightcap": lambda c, a, e: acc_nightcap(c, a.get("color", INK), a.get("pom", WHITE)),
    "ring": lambda c, a, e: acc_ring(c, a.get("color", INK)),
    "bow": lambda c, a, e: acc_bow(c, a.get("color", INK), a.get("x", 0.2)),
    "butter": lambda c, a, e: acc_butter(c, a.get("color", PAL["butter"])),
    "leaf": lambda c, a, e: acc_leaf(c, a.get("color", PAL["emerald"])),
    "acorncap": lambda c, a, e: acc_acorncap(c, a.get("color", PAL["cocoa"])),
    "antenna": lambda c, a, e: acc_antenna(c, a.get("color", INK), a.get("ball")),
    "halo": lambda c, a, e: acc_halo(c, a.get("color", PAL["butter"])),
    "clip": lambda c, a, e: acc_clip(c, a.get("color", INK), a.get("x", 0.2)),
    "band": lambda c, a, e: acc_band(c, a.get("color", INK), a["z0"], a["z1"]),
    "nori": lambda c, a, e: acc_nori(c, a.get("color", PAL["nori"])),
}


# ---------------------------------------------------------------- the crew

CAST = {
    # A — soft solids, dot eyes, felt hats
    "A": [
        dict(id="pip", name="Pip", shape="pill", color=PAL["tomato"], eyes=dict(style="dot"), acc=[dict(id="bucket", color=INK)]),
        dict(id="cubby", name="Cubby", shape="cube", color=PAL["cobalt"], eyes=dict(style="dot", gap=1.35), acc=[dict(id="frames", color=INK)]),
        dict(id="gus", name="Gus", shape="gumdrop", color=PAL["violet"], eyes=dict(style="dot"), acc=[dict(id="sprout", color=PAL["chartreuse"])]),
        dict(id="belle", name="Belle", shape="bell", color=PAL["aqua"], eyes=dict(style="pill"), acc=[]),
        dict(id="momo", name="Momo", shape="mochi", color=PAL["magenta"], eyes=dict(style="arc"), acc=[dict(id="beanie", color=PAL["butter"], pom=WHITE)]),
        dict(id="bo", name="Bo", shape="peanut", color=PAL["sunflower"], eyes=dict(style="dot", size=1.12), acc=[dict(id="cone", color=PAL["cobalt"], ball=WHITE)]),
    ],
    # B — snack bar, sticker eyes and arcs
    "B": [
        dict(id="nori", name="Nori", shape="onigiri", color=PAL["rice"], eyes=dict(style="dot", z=0.47), acc=[dict(id="nori", color=PAL["nori"])]),
        dict(id="toasty", name="Toasty", shape="toast", color=PAL["crust"], crumb=PAL["crumb"], eyes=dict(style="sticker", look=(0.3, 0.2)), acc=[dict(id="butter")]),
        dict(id="jelly", name="Jelly", shape="bean", color=PAL["magenta"], eyes=dict(style="sticker", look=(-0.35, 0.1)), acc=[]),
        dict(id="mac", name="Mac", shape="macaron", color=PAL["lilac"], eyes=dict(style="arc"), acc=[], lift=0.06),
        dict(id="acorn", name="Hazel", shape="acorn", color=PAL["tangerine"], eyes=dict(style="sticker", look=(0.0, 0.3)), acc=[dict(id="acorncap", color=PAL["cocoa"])]),
        dict(id="bun", name="Peaches", shape="bun", color=PAL["peach"], gradient=("#fff1e4", "#ff7aa8"), eyes=dict(style="arc"), acc=[dict(id="leaf", color=PAL["emerald"])]),
    ],
    # C — soft symbols: round button eyes, happy half-moons, sleepy arcs, one-piece shades
    "C": [
        dict(id="sol", name="Sol", shape="star", color=PAL["sunflower"], eyes=dict(style="smile", gap=1.15, z=0.47), acc=[]),
        dict(id="luna", name="Luna", shape="moon", color=PAL["cobalt"], eyes=dict(style="sleep"), acc=[dict(id="nightcap", color=PAL["sky"], pom=WHITE)]),
        dict(id="zap", name="Zip", shape="sparkle", color=PAL["aqua"], eyes=dict(style="round"), acc=[]),
        dict(id="volt", name="Volt", shape="bolt", color=PAL["tangerine"], eyes=dict(style="round", z=0.8, round=0.8, gap=1.2), acc=[dict(id="visor", color=INK)], lift=0.14),
        dict(id="drip", name="Drip", shape="drop", color=PAL["emerald"], eyes=dict(style="sleep"), acc=[]),
        dict(id="daisy", name="Daisy", shape="flower", color=PAL["bubblegum"], center=PAL["butter"], eyes=dict(style="round", gap=1.15), acc=[]),
    ],
}


# Lineup order for the key art (alternate heights, hats and colours).
LINEUP = {
    "A": ["pip", "gus", "cubby", "momo", "belle", "bo"],
    "B": ["toasty", "jelly", "nori", "acorn", "mac", "bun"],
    "C": ["luna", "zap", "sol", "drip", "volt", "daisy"],
}


def character(spec):
    c = Ctx(spec["shape"])
    c.add("body", c.f, spec.get("h", 0.011), "body", spec["color"], lo=c.lo, hi=c.hi, gradient=spec.get("gradient"))
    if spec["shape"] == "toast":
        crumb = spec.get("crumb", PAL["crumb"])
        reg = lambda x, z: toast2(x, z) + 0.065
        c.decal("crumb", reg, (-0.5, 0.5, 0.0, 1.0), crumb, 0.0, 0.006, ycut=0.0, h=0.004, excl=True)
    if spec["shape"] == "macaron":
        c.add("filling", lambda p: S.cyl_z(p, (0, 0, 0.36), 0.43, 0.07, 0.05), 0.005, "felt", PAL["cream"])
    if spec["shape"] == "flower":
        reg = lambda x, z: S.circle2(x, z, (0, 0.52), 0.25)
        c.decal("center", reg, (-0.3, 0.3, 0.22, 0.82), spec.get("center", PAL["butter"]), 0.0, 0.01, ycut=0.0, h=0.004)
    eyes = spec.get("eyes", {})
    if not any(a["id"] == "visor" for a in spec.get("acc", [])):
        add_eyes(c, eyes)
    for a in spec.get("acc", []):
        ACCESSORIES[a["id"]](c, a, eyes)
    return c


# ---------------------------------------------------------------- customization
# Two variants of one character per sheet: colour, eyes and accessory swapped.

VARIANTS = {
    "A": dict(
        base="momo",
        items=[
            dict(title="Sky, dot eyes, bucket hat", over=dict(color=PAL["sky"], eyes=dict(style="dot"), acc=[dict(id="bucket", color=PAL["tomato"], size=1.12, sink=0.13)])),
            dict(title="Chartreuse, pill eyes, party cone", over=dict(color=PAL["chartreuse"], eyes=dict(style="pill"), acc=[dict(id="cone", color=PAL["violet"], ball=WHITE)])),
        ],
    ),
    "B": dict(
        base="jelly",
        items=[
            dict(title="Emerald, closed arcs, bow", over=dict(color=PAL["emerald"], eyes=dict(style="arc"), acc=[dict(id="bow", color=PAL["tomato"], x=0.12)])),
            dict(title="Sunflower, stickers looking up, beanie", over=dict(color=PAL["sunflower"], eyes=dict(style="sticker", look=(0.0, 0.45)), acc=[dict(id="beanie", color=PAL["cobalt"], pom=WHITE)])),
        ],
    ),
    "C": dict(
        base="drip",
        items=[
            dict(title="Violet, stickers looking up, butter beanie", over=dict(color=PAL["violet"], eyes=dict(style="sticker", look=(0.1, 0.45)), acc=[dict(id="beanie", color=PAL["butter"], pom=WHITE)])),
            dict(title="Sky, round eyes, tomato bucket hat", over=dict(color=PAL["sky"], eyes=dict(style="round"), acc=[dict(id="bucket", color=PAL["tomato"], size=1.0, sink=0.2)])),
        ],
    ),
}


# ---------------------------------------------------------------- states
# Alevr Orbit's truthful agent states, told by a brief eye/pose change on the
# same character (the words always sit beside it; no state by colour alone).

STATE_LABELS = ["Ready", "Thinking", "Working", "Needs your answer", "Blocked", "Finished"]
STATES = {"A": "pip", "B": "jelly", "C": "zap"}


def state_overrides(base):
    e = dict(base.get("eyes", {}))
    st = e.get("style", "dot")

    def w(**kw):
        d = dict(e)
        d.update(kw)
        return d

    sticker = st == "sticker"
    thinking = w(look=(0.5, 0.55)) if sticker else w(dz=0.035, dx=e.get("dx", 0.0) + 0.03, size=e.get("size", 1.0) * 0.92)
    needs = w(look=(0.0, 0.0), white=1.14, pupil=0.56) if sticker else w(size=e.get("size", 1.0) * 1.2)
    return [
        dict(),
        dict(eyes=thinking),
        dict(eyes=w(style="sleepy")),
        dict(eyes=needs, lean=-8),
        dict(eyes=w(style="dash")),
        dict(eyes=w(style="arc")),
    ]
