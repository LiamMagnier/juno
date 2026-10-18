"""
Short per-state loops of an Orbit agent in 3D (Cycles image sequences), and a
3x3 gaze grid for hover.

  blender --background --factory-startup --python orbit_motion.py -- <out_dir> [id]

Why pre-rendered sequences rather than a live three.js character: the Cycles
look (soft vinyl, subsurface, one contact shadow) is the approved look, and
ORBIT_SYSTEM.md asks for zero GPU work at rest and cached images at small
sizes. A state loop is about a second and a half of small motion, so a short
sequence (12 fps, played by the page) carries it; the page adds the hover
spring and the press squish as CSS transforms on top, and picks the gaze frame
nearest the pointer. Reduced motion shows the state's first frame.

Every state follows docs/design/agents-rework/MOTION.md and the brief:
  ready     a tiny breathing squash, one blink
  thinking  eyes up and aside, drifting; three small Alevr-blue dots orbit the head
  working   eyes down, a steady focused bob and lean
  waiting   one lift and lean toward the viewer, eyes wider, one pulse, then hold
  paused    eyes closed, slow breathing
  finished  one happy hop with squash, happy arcs, then settle
  blocked   one small shake, dash eyes
Env: RES (default 320), SPP (96), FPS (12).
"""

from __future__ import annotations

import copy
import math
import os
import sys
import time

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.argv = [a for a in sys.argv]  # keep Blender's argv
import flock_bpy as B  # noqa: E402

# orbit_render runs its CLI at import; borrow its helpers by exec'ing only the defs.
_src = open(os.path.join(HERE, "orbit_render.py")).read()
_defs = _src.split("members = [O.BY_ID[i] for i in only]")[0]
_args = B.args_after_dashes()
_ns = {"__file__": os.path.join(HERE, "orbit_render.py"), "__name__": "orbit_render_defs"}
sys.argv = sys.argv[: sys.argv.index("--") + 1] + ["none", _args[0]] if "--" in sys.argv else sys.argv
exec(compile(_defs, "orbit_render.py", "exec"), _ns)
import types  # noqa: E402
R = types.SimpleNamespace(**{k: v for k, v in _ns.items() if not k.startswith("__")})
import orbit_cast as O  # noqa: E402

out_dir = os.path.join(_args[0], "motion")
cid = _args[1] if len(_args) > 1 else "mira"
os.makedirs(out_dir, exist_ok=True)
RES = int(os.environ.get("RES", 320))
SPP = int(os.environ.get("SPP", 96))
T0 = time.time()

EYE_NAMES = ("eye", "white", "pupil")


def is_eye(name):
    return name.startswith(EYE_NAMES)


def ease(t):
    return 0.5 - 0.5 * math.cos(math.pi * min(1, max(0, t)))


def spring(t, bounce=0.18):
    """A settling spring 0 -> 1 (the reward spring's overshoot)."""
    if t <= 0:
        return 0.0
    return 1 - math.exp(-6.5 * t) * math.cos(9.0 * t * (1 + bounce))


# ---------------------------------------------------------------- the states
# Each returns frames: dict(lift, lean (toward viewer, deg), tilt (sideways, deg),
# sx, sz (squash), eyes (overrides), dots (phase or None)).


def f_ready(n=20):
    out = []
    for i in range(n):
        t = i / n
        b = math.sin(2 * math.pi * t)
        blink = i in (13, 14)
        out.append(dict(sx=1 - 0.006 * b, sz=1 + 0.014 * b, eyes=dict(style="dash") if blink else {}))
    return out


def f_thinking(n=24):
    out = []
    for i in range(n):
        t = i / n
        drift = math.sin(2 * math.pi * t)
        k = round((drift + 1) * 1.0)  # three gaze steps, so only three eye meshes
        out.append(dict(tilt=3 + 1.5 * drift, eyes=dict(dz=0.045, dx=0.015 + 0.02 * k, size=0.92), dots=t))
    return out


def f_working(n=16):
    out = []
    for i in range(n):
        t = i / n
        b = math.sin(2 * math.pi * t * 2)
        out.append(dict(lift=0.008 * max(0, b), lean=-5 - 1.5 * b, sx=1 + 0.008 * b, sz=1 - 0.01 * b, eyes=dict(dz=-0.045, dx=-0.01, size=0.9)))
    return out


def f_waiting(n=16):
    out = []
    for i in range(n):
        t = i / (n - 1)
        s = spring(t * 1.6)
        pulse = math.sin(math.pi * min(1, max(0, (t - 0.35) / 0.3))) * 0.035
        out.append(dict(lift=0.05 * s, lean=-8 * s, sx=1 + pulse, sz=1 + pulse, eyes=dict(size=1.18)))
    return out


def f_paused(n=24):
    out = []
    for i in range(n):
        b = math.sin(2 * math.pi * i / n)
        out.append(dict(lift=-0.006, sx=1 - 0.004 * b, sz=1 + 0.01 * b, eyes=dict(style="sleep")))
    return out


def f_finished(n=16):
    out = []
    for i in range(n):
        t = i / (n - 1)
        if t < 0.15:  # anticipation
            u = t / 0.15
            out.append(dict(sx=1 + 0.05 * ease(u), sz=1 - 0.07 * ease(u), eyes=dict(style="arc")))
        elif t < 0.55:  # the hop
            u = (t - 0.15) / 0.4
            out.append(dict(lift=0.13 * math.sin(math.pi * u), sx=1 - 0.03 * math.sin(math.pi * u), sz=1 + 0.05 * math.sin(math.pi * u), eyes=dict(style="arc")))
        else:  # land, squash, settle
            u = (t - 0.55) / 0.45
            sq = math.exp(-5 * u) * math.cos(10 * u)
            out.append(dict(sx=1 + 0.05 * sq, sz=1 - 0.06 * sq, eyes=dict(style="arc")))
    return out


def f_blocked(n=12):
    out = []
    for i in range(n):
        t = i / (n - 1)
        out.append(dict(tilt=5 * math.exp(-4 * t) * math.sin(2 * math.pi * 3 * t), eyes=dict(style="dash")))
    return out


STATES = {"ready": f_ready, "thinking": f_thinking, "working": f_working, "waiting": f_waiting, "paused": f_paused, "finished": f_finished, "blocked": f_blocked}

# ---------------------------------------------------------------- scene


def eye_key(e):
    return tuple(sorted((k, round(v, 3) if isinstance(v, float) else v) for k, v in e.items()))


base = O.BY_ID[cid]
sc = R.scene(RES)
sc.cycles.samples = SPP
coll = bpy.data.collections.get("characters") or sc.collection
root = bpy.data.objects.new("root", None)
coll.objects.link(root)
c0, ms0 = R.meshes(O.with_state(base, "ready"))
body_objs = []
for part, V, Q in ms0:
    if len(Q) == 0 or is_eye(part["name"]):
        continue
    ob = B.mesh_object(f"p_{part['name']}", V, Q, coll, subsurf=1)
    ob.parent = root
    B.assign(ob, R.material_for(part))
    body_objs.append(ob)
# A fixed frame with headroom for the hop, set from the resting body.
lo, hi = R.world_bounds(body_objs)
ext = max(1.32, hi.z + 0.3, (hi.x - lo.x) * 0.9)
dist = B.fit_dist(ext, lens=70, fill=0.78)
B.camera(sc, target=(0.5 * (lo.x + hi.x), 0, hi.z * 0.52), dist=dist, lens=70, elev=R.ELEV, yaw=R.YAW)

eye_sets = {}


def eyes_for(over):
    k = eye_key(over)
    if k in eye_sets:
        return eye_sets[k]
    spec = copy.deepcopy(base)
    e = dict(spec.get("eyes", {}))
    if "size" in over:
        e["size"] = e.get("size", 1.0) * over["size"]
    for kk, v in over.items():
        if kk != "size":
            e[kk] = v
    spec["eyes"] = e
    spec["id"] = f"{cid}_eyes_{len(eye_sets)}"
    _, ms = R.meshes(spec)
    objs = []
    for part, V, Q in ms:
        if len(Q) == 0 or not is_eye(part["name"]):
            continue
        ob = B.mesh_object(f"e{len(eye_sets)}_{part['name']}", V, Q, coll, subsurf=1)
        ob.parent = root
        B.assign(ob, R.material_for(part))
        objs.append(ob)
    eye_sets[k] = objs
    return objs


dots = []
dot_mat = R.vinyl("dot", O.PAL["alevr"])
for i in range(3):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.034 + 0.008 * i, segments=32, ring_count=16)
    d = bpy.context.object
    bpy.ops.object.shade_smooth()
    B.assign(d, dot_mat)
    if d.name not in coll.objects:
        for cl in d.users_collection:
            cl.objects.unlink(d)
        coll.objects.link(d)
    dots.append(d)


def pose(fr):
    root.location = (0, 0, fr.get("lift", 0.0))
    root.rotation_euler = (math.radians(fr.get("lean", 0.0)), math.radians(fr.get("tilt", 0.0)), 0)
    root.scale = (fr.get("sx", 1.0), fr.get("sx", 1.0), fr.get("sz", 1.0))
    want = eyes_for(fr.get("eyes", {}))
    for objs in eye_sets.values():
        for ob in objs:
            ob.hide_render = objs is not want
    ph = fr.get("dots")
    for i, d in enumerate(dots):
        d.hide_render = ph is None
        if ph is not None:
            a = 2 * math.pi * (ph + i / 3)
            cx, cz = 0.36, hi.z + 0.06
            d.location = (cx + 0.2 * math.cos(a), 0.12 * math.sin(a), cz + 0.07 * math.sin(a) + 0.03 * i)


def render(path):
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    R.clean_alpha(path)


only = os.environ.get("STATES")
for name, fn in STATES.items():
    if only and name not in only.split(","):
        continue
    frames = fn()
    for i, fr in enumerate(frames):
        pose(fr)
        render(os.path.join(out_dir, f"{cid}_{name}_{i:02d}.png"))
    print("STATE", name, len(frames), f"{time.time() - T0:.0f}s", flush=True)

# Hover: a 3x3 gaze grid (eyes toward the pointer), resting pose.
if not only or "gaze" in only:
    for gz in (-1, 0, 1):
        for gx in (-1, 0, 1):
            pose(dict(eyes=dict(dx=0.035 * gx, dz=0.03 * gz, size=1.04)))
            render(os.path.join(out_dir, f"{cid}_gaze_{gx + 1}{gz + 1}.png"))
    print("GAZE", f"{time.time() - T0:.0f}s", flush=True)
print("DONE", f"{time.time() - T0:.0f}s", flush=True)
