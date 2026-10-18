"""
Alevr Orbit agents, direction A ("Simple 3D", chosen by the owner): soft matte
vinyl toys. The same SDF bodies, graphic eyes and accessories as the flock
sheets (flock_cast.py, flock_sdf.py) with new bodies and parts, and no fibres:
the finish is a soft matte vinyl (orbit_render.py).

Twelve characters. Five simple forms (Mira, the hero, is a rounded triangle
holding a cream disc) and seven exclusive ones from Alevr's own geometry: the
Orbit glyph's two separated elliptical arcs round a body, a black hole with a
glowing accretion disc, a ringed planet, a crescent moon, a comet, a pulsar
star and a satellite. Rules (D-034): real soft volumes only, bold matte
accessories, graphic eyes (one system for everyone: matte black ovals at the
same scale, the same arcs for the states), no mouth, no blush.

numpy only (no bpy).
"""

from __future__ import annotations

import copy
import math

import numpy as np

import flock_cast as C
import flock_sdf as S
from flock_sdf import smax, smin

INK = C.INK
WHITE = C.WHITE
PAL = dict(C.PAL)
PAL.update(
    {
        "alevr": "#1f3fd9",  # the presence ultramarine (#2d49c9), lifted for a toy body
        "periwinkle": "#6f7bff",
        "night": "#1e1b2e",
        "silver": "#e8e5de",
        "flare": "#e0420a",
        "flare_hot": "#ffd23a",
    }
)

flat = C.flat
pillow2d = C.pillow2d

# ---------------------------------------------------------------- bodies


def b_mira():
    """A rounded triangle with real depth: thick in the middle, every edge soft."""

    def f(p):
        d2 = C.tri2(p[:, 0], p[:, 2], (0, 0.42), 0.38) - 0.19
        return pillow2d(d2, 0.2, 0.13, 0.19, p, cap=0.28)

    return flat(f, 0.06), dict(z=0.36, gap=0.22, w=0.056, h=0.094)


def b_orb():
    def f(p):
        return S.ellipsoid(p, (0, 0, 0.46), (0.45, 0.42, 0.47))

    return flat(f, 0.08), dict(z=0.4, gap=0.22, w=0.056, h=0.094)


def b_planet():
    def f(p):
        return S.sphere(p, (0, 0, 0.46), 0.44)

    return flat(f, 0.09), dict(z=0.42, gap=0.22, w=0.056, h=0.094)


def b_moon():
    """A crescent as a true volume: a ball less an offset ball, horns rounded."""

    def f(p):
        # The bite goes straight through (a cylinder along y), so the inner edge
        # reads as a crescent from any side, not as a scoop; every edge is round.
        q = p / np.array([1.0, 0.62, 1.0])
        outer = S.sphere(q, (0, 0, 0.5), 0.5) * 0.62
        bite = S.circle2(p[:, 0], p[:, 2], (0.32, 0.7), 0.37)
        return smax(outer, -bite, 0.09) - 0.01

    return flat(f, 0.07), dict(z=0.36, gap=0.19, w=0.054, h=0.09, dx=-0.1)


def b_comet():
    """The comet's head (the tail is its own part, in a paler tone)."""

    def f(p):
        return S.sphere(p, (0.22, 0, 0.36), 0.34)

    return flat(f, 0.08), dict(z=0.33, gap=0.19, w=0.054, h=0.09, dx=0.24)


def b_pulsar():
    """A four-point star with fat, soft points: Alevr's spark as a body."""

    def f(p):
        c = np.array([0.0, 0.0, 0.56])
        q = p / np.array([1.0, 0.62, 1.0])
        g = S.ellipsoid(q, c, (0.27, 0.27, 0.28))
        for dx, dz, ln in ((0, 1, 0.5), (0, -1, 0.5), (1, 0, 0.46), (-1, 0, 0.46)):
            tip = c + ln * np.array([dx, 0, dz])
            g = smin(g, S.round_cone(q, c, tip, 0.2, 0.075), 0.16)
        return g * 0.62

    return flat(f, 0.05), dict(z=0.52, gap=0.18, w=0.05, h=0.084)


def b_satellite():
    def f(p):
        return S.round_box(p, (0, 0, 0.44), (0.33, 0.3, 0.36), 0.22)

    return flat(f, 0.06), dict(z=0.4, gap=0.2, w=0.054, h=0.09)


for _k, _f in {
    "mira": b_mira,
    "orb": b_orb,
    "planet2": b_planet,
    "moon2": b_moon,
    "comet": b_comet,
    "pulsar": b_pulsar,
    "satellite": b_satellite,
}.items():
    C.BODIES[_k] = _f

# ---------------------------------------------------------------- parts


def acc_disc(c, color, x=0.43, z=0.25, r=0.22, t=0.09, yaw=-56, sink=0.95):
    """Mira's cream disc: a thick soft coin held against her lower right side,
    partly sunk into the body so it sits in it rather than floating on it."""
    y0 = float(S.ray_front(c.f, [x], [z])[0])
    k = np.array([x + 0.02, y0 + t * sink, z])
    a = math.radians(yaw)

    def f(p):
        q = S.rot(p, k, "z", a)
        q = S.rot(q, k, "x", math.radians(90))
        return S.cyl_z(q, k, r, t, rb=t * 0.85)

    c.add("disc", f, 0.005, "part", color)


def acc_orbit_arcs(c, color, R=0.68, zc=0.42, tilt=26, roll=-14, tube=0.062):
    """The Orbit glyph round the body: two separated elliptical arcs, a real tube,
    tipped so the long arc passes in front under the eyes and rises behind."""
    pitch = math.radians(tilt)
    rl = math.radians(roll)
    gaps = [(math.radians(150), math.radians(176)), (math.radians(326), math.radians(352))]

    def f(p):
        q = S.rot(p, (0, 0, zc), "y", rl)
        q = S.rot(q, (0, 0, zc), "x", -pitch)
        x, y, z = q[:, 0], q[:, 1] / 0.62, q[:, 2] - zc  # an ellipse in plan
        a1 = S.arc2(x, y, (0, 0), R, gaps[0][1], gaps[1][0], 0.0)
        a2 = S.arc2(x, y, (0, 0), R, gaps[1][1], gaps[0][0] + 2 * math.pi, 0.0)
        d = np.minimum(a1, a2) * 0.8
        return np.sqrt(d * d + z * z) - tube

    c.add("orbit", f, 0.005, "part", color, lo=(-R - 0.2, -R - 0.2, zc - 0.5), hi=(R + 0.2, R + 0.2, zc + 0.5))


def acc_ring(c, color, R0=0.57, R1=0.88, zc=0.46, tilt=24, roll=-4, t=0.05):
    """A planet's ring: a broad soft band with thickness (lens-shaped section)."""
    pitch = math.radians(tilt)
    rl = math.radians(roll)

    def f(p):
        q = S.rot(p, (0, 0, zc), "y", rl)
        q = S.rot(q, (0, 0, zc), "x", pitch)
        rho = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)
        mid = 0.5 * (R0 + R1)
        half = 0.5 * (R1 - R0)
        u = np.clip(np.abs(rho - mid) / half, 0, 1)
        th = t * np.sqrt(np.maximum(1 - u * u, 0.0)) + 0.012
        band = smax(np.abs(rho - mid) - half, np.abs(q[:, 2] - zc) - th, 0.02)
        return band

    c.add("ring", f, 0.005, "part", color, lo=(-R1 - 0.1, -R1 - 0.1, zc - 0.45), hi=(R1 + 0.1, R1 + 0.1, zc + 0.45))


def acc_disc_glow(c, inner, outer, R0=0.52, R1=0.74, zc=0.44, tilt=11, roll=-8):
    """A black hole's accretion disc: a thick, soft, glowing torus-like disc,
    hottest at the inner edge (an emissive gradient, set up in orbit_render)."""
    pitch = math.radians(tilt)
    rl = math.radians(roll)

    def f(p):
        q = S.rot(p, (0, 0, zc), "y", rl)
        q = S.rot(q, (0, 0, zc), "x", -pitch)
        rho = np.sqrt(q[:, 0] ** 2 + q[:, 1] ** 2)
        mid = 0.5 * (R0 + R1)
        half = 0.5 * (R1 - R0)
        u = np.clip((rho - R0) / (R1 - R0), 0, 1)
        th = 0.045 * (1 - u) ** 0.8 + 0.014
        return smax(np.abs(rho - mid) - half, np.abs(q[:, 2] - zc) - th, 0.03)

    # The photon ring: a thin bright hoop round the body, facing the viewer.
    c.add("photon", lambda p: S.torus(S.rot(p, (0, 0, 0.46), "z", math.radians(18)), (0, 0, 0.46), 0.5, 0.026, axis="y"), 0.004, "glow", inner, glow=(inner, inner, 0.0, 1.0, zc, tilt, roll))
    c.add("accretion", f, 0.005, "glow", inner, lo=(-R1 - 0.1, -R1 - 0.1, zc - 0.45), hi=(R1 + 0.1, R1 + 0.1, zc + 0.45), glow=(inner, outer, R0, R1, zc, tilt, roll))


def acc_tail(c, color):
    """The comet's swept tail: soft overlapping lobes thinning to a point, curving up and back."""
    head = np.array([0.22, 0.06, 0.36])
    pts = []
    for i in range(13):
        t = i / 12
        pts.append((head + np.array([-1.18 * t, 0.12 + 0.06 * t, 0.62 * t ** 1.6]), 0.3 * (1 - t) ** 1.35 + 0.018))

    def f(p):
        g = None
        for (a, ra), (b, rb) in zip(pts[:-1], pts[1:]):
            s = S.round_cone(p, a, b, ra, rb)
            g = s if g is None else smin(g, s, 0.06)
        q = p / np.array([1.0, 0.62, 1.0])
        g = g / 1.0
        g = np.maximum(g, (np.abs(p[:, 1] - 0.14) - 0.22))  # a flattened, swept ribbon of a tail
        return smax(g, -S.sphere(p, head, 0.3), 0.04)

    c.add("tail", f, 0.006, "part", color, lo=(-1.1, -0.3, 0.0), hi=(0.6, 0.5, 1.2))


def acc_panels(c, color, frame=PAL["silver"]):
    """The satellite's two solar wings on short arms."""
    zc = 0.46
    for i, s in enumerate((-1, 1)):
        a = np.array([s * 0.28, 0.06, zc])
        b = np.array([s * 0.48, 0.06, zc])
        c.add(f"arm{i}", lambda p, a=a, b=b: S.capsule(p, a, b, 0.045), 0.004, "part", frame)
        k = np.array([s * 0.7, 0.06, zc])
        c.add(f"panel{i}", lambda p, k=k, s=s: S.round_box(S.rot(p, k, "z", math.radians(-14 * s)), k, (0.22, 0.05, 0.17), 0.04), 0.004, "part", color)
        # the cell seams: two chalk bars across the wing's face
        for j, dz in enumerate((-0.06, 0.06)):
            c.add(f"seam{i}{j}", lambda p, k=k, s=s, dz=dz: S.round_box(S.rot(p, k, "z", math.radians(-14 * s)), k + np.array([0, -0.05, dz]), (0.21, 0.012, 0.011), 0.008), 0.0035, "part", PAL["chalk"])


def acc_dish(c, color):
    zt = c.top()
    a = np.array([0.04, 0.0, zt - 0.04])
    b = np.array([0.12, 0.0, zt + 0.14])
    c.add("mast", lambda p: S.capsule(p, a, b, 0.024), 0.004, "part", color)
    c.add("tip", lambda p: S.sphere(p, b + np.array([0.02, 0, 0.04]), 0.07), 0.004, "part", PAL["flare"])


C.ACCESSORIES.update(
    {
        "disc": lambda c, a, e: acc_disc(c, a.get("color", PAL["cream"])),
        "orbit_arcs": lambda c, a, e: acc_orbit_arcs(c, a.get("color", PAL["alevr"])),
        "ring2": lambda c, a, e: acc_ring(c, a.get("color", PAL["lilac"])),
        "accretion": lambda c, a, e: acc_disc_glow(c, a.get("inner", PAL["flare_hot"]), a.get("outer", PAL["flare"])),
        "tail": lambda c, a, e: acc_tail(c, a.get("color", PAL["butter"])),
        "panels": lambda c, a, e: acc_panels(c, a.get("color", PAL["alevr"])),
        "dish": lambda c, a, e: acc_dish(c, a.get("color", PAL["graphite"])),
    }
)

# ---------------------------------------------------------------- the twelve

EYES = dict(style="dot")

CAST = [
    dict(id="mira", name="Mira", role="Renewals", kind="simple", shape="mira", color=PAL["alevr"], eyes=dict(EYES), acc=[dict(id="disc", color=PAL["cream"])]),
    dict(id="otto", name="Tyco", role="Finance ops", kind="simple", shape="pill", color=PAL["tomato"], eyes=dict(EYES), acc=[dict(id="cap", color=PAL["sunflower"])]),
    dict(id="bram", name="Ada", role="Release notes", kind="simple", shape="cube", color=PAL["violet"], eyes=dict(style="dot", gap=1.35, size=0.84), acc=[dict(id="frames", color=INK)]),
    dict(id="dew", name="Io", role="Data", kind="simple", shape="drop", color=PAL["aqua"], eyes=dict(EYES), acc=[]),
    dict(id="rhea", name="Lyra", role="Support", kind="simple", shape="gumdrop", color=PAL["emerald"], eyes=dict(EYES), acc=[dict(id="headphones", color=PAL["graphite"], cup=PAL["graphite"], r=0.2)]),
    dict(id="ori", name="Elli", role="Orchestration", kind="cosmic", shape="orb", color=PAL["sunflower"], eyes=dict(style="dot", z=0.52), acc=[dict(id="orbit_arcs", color=PAL["alevr"])]),
    dict(id="vanta", name="Umbra", role="Deep research", kind="cosmic", shape="planet2", color=PAL["night"], eyes=dict(style="dot", color=WHITE, z=0.58), acc=[dict(id="accretion")]),
    dict(id="sato", name="Cass", role="Planning", kind="cosmic", shape="planet2", color=PAL["tangerine"], eyes=dict(style="dot", z=0.56), acc=[dict(id="ring2", color=PAL["lilac"])]),
    dict(id="luna", name="Lune", role="Overnight runs", kind="cosmic", shape="moon2", color=PAL["periwinkle"], eyes=dict(style="dot"), acc=[dict(id="nightcap", color=PAL["sky"], pom=WHITE)]),
    dict(id="kip", name="Hale", role="Quick tasks", kind="cosmic", shape="comet", color=PAL["bubblegum"], eyes=dict(EYES), acc=[dict(id="tail", color="#ffbcd9")]),
    dict(id="vela", name="Vela", role="Monitoring", kind="cosmic", shape="pulsar", color=PAL["chartreuse"], eyes=dict(EYES), acc=[]),
    dict(id="sputnik", name="Echo", role="Integrations", kind="cosmic", shape="satellite", color=PAL["chalk"], eyes=dict(EYES), acc=[dict(id="band", color=PAL["alevr"], z0=0.6, z1=0.68), dict(id="panels", color=PAL["alevr"]), dict(id="dish", color=PAL["graphite"])]),
]

BY_ID = {m["id"]: m for m in CAST}

# The truthful agent states, on the eyes (and a small pose change).
STATES = ["ready", "thinking", "working", "waiting", "paused", "finished", "blocked"]


def with_state(spec, state):
    m = copy.deepcopy(spec)
    e = dict(m.get("eyes", {}))
    size = e.get("size", 1.0)
    if state == "thinking":
        e.update(dz=0.04, dx=e.get("dx", 0.0) + 0.035, size=size * 0.92)
        m["lean"] = 4
    elif state == "working":
        # Busy: eyes down at the work, a little narrower; a lean into it.
        e.update(dz=-0.045, dx=e.get("dx", 0.0) - 0.01, size=size * 0.9)
        m["lean"] = -6
    elif state == "waiting":
        e.update(size=size * 1.18)
        m["lean"] = -7
        m["lift"] = 0.05
    elif state == "paused":
        e.update(style="sleep")
    elif state == "finished":
        e.update(style="arc")
    elif state == "blocked":
        e.update(style="dash")
    m["eyes"] = e
    m["id"] = f"{spec['id']}_{state}"
    return m


# Parts a 20-28 px sprite leaves out (too fine to read), and how much bigger its eyes are.
SPRITE_DROP = {"pom", "button", "temple0", "temple1", "tip", "mast", "arm0", "arm1"}
SPRITE_EYES = 1.55


def sprite_spec(spec):
    m = copy.deepcopy(spec)
    e = dict(m.get("eyes", {}))
    e["size"] = e.get("size", 1.0) * SPRITE_EYES
    m["eyes"] = e
    m["sprite"] = True
    m["id"] = spec["id"] + "_spr"
    return m


def character(spec):
    c = C.character({k: v for k, v in spec.items() if k not in ("sprite",)})
    if spec.get("sprite"):
        c.parts = [p for p in c.parts if p["name"] not in SPRITE_DROP]
    return c


# ---------------------------------------------------------------- customization
# A character is body shape + colour + accessory + eye style. Accessories are
# separate parts fitted to any body from its own field (top, front, sides).

SWATCHES = [
    ("Alevr blue", PAL["alevr"]), ("Tomato", PAL["tomato"]), ("Tangerine", PAL["tangerine"]), ("Sunflower", PAL["sunflower"]),
    ("Chartreuse", PAL["chartreuse"]), ("Emerald", PAL["emerald"]), ("Aqua", PAL["aqua"]), ("Violet", PAL["violet"]),
    ("Bubblegum", PAL["bubblegum"]), ("Graphite", PAL["graphite"]),
]

ACCESSORY_CHOICES = {
    "none": [],
    "badge": [dict(id="disc", color=PAL["cream"])],
    "cap": [dict(id="cap", color=PAL["sunflower"])],
    "glasses": [dict(id="frames", color=INK)],
    "headphones": [dict(id="headphones", color=PAL["graphite"], cup=PAL["graphite"], r=0.2)],
    "nightcap": [dict(id="nightcap", color=PAL["sky"], pom=WHITE)],
    "beanie": [dict(id="beanie", color=PAL["butter"], pom=WHITE)],
    "orbit": [dict(id="orbit_arcs", color=PAL["alevr"])],
}

EYE_CHOICES = {"dots": dict(style="dot"), "pills": dict(style="pill"), "stickers": dict(style="sticker"), "happy": dict(style="arc")}

CUSTOM = [
    ("Alevr blue · badge · dots", dict(color=PAL["alevr"], acc="badge", eyes="dots")),
    ("Tomato · no accessory · pills", dict(color=PAL["tomato"], acc="none", eyes="pills")),
    ("Emerald · headphones · pills", dict(color=PAL["emerald"], acc="headphones", eyes="pills")),
    ("Sunflower · glasses · dots", dict(color=PAL["sunflower"], acc="glasses", eyes="dots")),
    ("Violet · nightcap · happy", dict(color=PAL["violet"], acc="nightcap", eyes="happy")),
    ("Aqua · orbit ring · stickers", dict(color=PAL["aqua"], acc="orbit", eyes="stickers")),
]


def custom_spec(base, k):
    title, o = CUSTOM[k]
    m = copy.deepcopy(base)
    m["color"] = o["color"]
    m["acc"] = copy.deepcopy(ACCESSORY_CHOICES[o["acc"]])
    m["eyes"] = dict(EYE_CHOICES[o["eyes"]])
    m["id"] = f"{base['id']}_custom{k}"
    return m


def icon_spec(spec, eyes=1.22):
    """The flat 48 px icon: every part kept, eyes a little bigger than the portrait's."""
    m = copy.deepcopy(spec)
    e = dict(m.get("eyes", {}))
    e["size"] = e.get("size", 1.0) * eyes
    m["eyes"] = e
    m["id"] = spec["id"] + "_icon"
    return m
