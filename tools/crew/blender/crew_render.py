"""
Cycles stills of the crew.

  Blender --background --factory-startup --python crew_render.py -- <mode> <out_dir> [ids...]

  portraits   one transparent portrait per member (out_dir/<id>.png)
  group       the whole crew together (out_dir/group.png)
  sheet       every shape plain, for the shape sheet (out_dir/shapes.png)

Env: RES (px), SPP (samples), Q (fur quality 0.3..1).
"""

import json
import math
import os
import sys
import time

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crew_bpy as B  # noqa: E402
import crew_compose as CC  # noqa: E402
import crew_shapes as CS  # noqa: E402

args = B.args_after_dashes()
mode = args[0]
out_dir = args[1]
only = set(args[2:])
os.makedirs(out_dir, exist_ok=True)
ROSTER = json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "roster.json")))["members"]
RES = int(os.environ.get("RES", 1024))
SPP = int(os.environ.get("SPP", 96))
Q = float(os.environ.get("Q", 1.0))


def setup():
    sc = B.reset_scene()
    CC.reset_caches()
    B.studio(sc)
    if os.environ.get("FORMAT") == "WEBP":
        sc.render.image_settings.file_format = "WEBP"
        sc.render.image_settings.color_mode = "RGBA"
        sc.render.image_settings.quality = int(os.environ.get("QUALITY", 86))
    sc.render.resolution_x = RES
    sc.render.resolution_y = RES
    sc.cycles.samples = SPP
    try:
        sc.cycles_curves.shape = os.environ.get("CURVES", "RIBBONS")
    except Exception:
        pass
    return sc


def world_bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in objs:
        if ob.type != "MESH":
            continue
        for c in ob.bound_box:
            w = ob.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def frame(sc, objs, fill=0.8, yaw=-10, elev=6, aspect=1.0):
    bpy.context.view_layer.update()
    lo, hi = world_bounds(objs)
    c = (lo + hi) / 2
    h = hi.z - max(lo.z, 0)
    w = hi.x - lo.x
    ext = max(h, w / aspect) + 0.16
    lens = 85
    fov = 2 * math.atan(36 / 2 / lens)
    dist = ext / fill / (2 * math.tan(fov / 2))
    B.camera_for(sc, target=(c.x, c.y, max(lo.z, 0) + h * 0.5), dist=dist, lens=lens, elev_deg=elev, yaw_deg=yaw)


if mode == "portraits":
    for m in ROSTER:
        if only and m["id"] not in only:
            continue
        t0 = time.time()
        sc = setup()
        root, info = CC.compose(m, yaw_deg=float(os.environ.get("YAW", -8)), fur_quality=Q)
        frame(sc, [o for o in bpy.data.objects if o.parent == root], fill=0.78)
        sc.render.filepath = os.path.join(out_dir, f"{m['id']}" + (".webp" if os.environ.get("FORMAT") == "WEBP" else ".png"))
        bpy.ops.render.render(write_still=True)
        print("WROTE", sc.render.filepath, f"{time.time() - t0:.1f}s")
elif mode == "group":
    t0 = time.time()
    sc = setup()
    sc.render.resolution_x = int(RES * 2.2)
    sc.render.resolution_y = RES
    members = [m for m in ROSTER if not only or m["id"] in only]
    n = len(members)
    spacing = 1.18
    objs = []
    for i, m in enumerate(members):
        x = (i - (n - 1) / 2) * spacing
        y = 0.18 * ((i - (n - 1) / 2) / max(1, (n - 1) / 2)) ** 2 * 3
        root, info = CC.compose(m, location=(x, y, 0), yaw_deg=-x * 4, roll_deg=(-1) ** i * 2.5, fur_quality=Q, seed=i + 1)
        objs += [o for o in bpy.data.objects if o.parent == root]
    frame(sc, objs, fill=0.92, yaw=0, elev=5, aspect=2.2)
    sc.render.filepath = os.path.join(out_dir, "group" + (".webp" if os.environ.get("FORMAT") == "WEBP" else ".png"))
    bpy.ops.render.render(write_still=True)
    print("WROTE", sc.render.filepath, f"{time.time() - t0:.1f}s")
elif mode == "sheet":
    t0 = time.time()
    sc = setup()
    shapes = list(CS.SHAPES)
    cols = 6
    sc.render.resolution_x = int(RES * 2)
    sc.render.resolution_y = int(RES * 0.75)
    objs = []
    for i, s in enumerate(shapes):
        m = {"id": s, "shape": s, "color": os.environ.get("SHEET_COLOR", "#c4cfe0"), "fur": 0.4, "eyes": {"style": "oval", "size": 0.5, "gap": 0.5, "y": 0.35}, "accessories": []}
        x = (i % cols - (cols - 1) / 2) * 1.5
        y = (i // cols) * 1.8
        root, _ = CC.compose(m, location=(x, y, 0), fur_quality=Q * 0.7, seed=i + 1)
        objs += [o for o in bpy.data.objects if o.parent == root]
    frame(sc, objs, fill=0.95, yaw=0, elev=24, aspect=2 / 0.75)
    sc.render.filepath = os.path.join(out_dir, "shapes" + (".webp" if os.environ.get("FORMAT") == "WEBP" else ".png"))
    bpy.ops.render.render(write_still=True)
    print("WROTE", sc.render.filepath, f"{time.time() - t0:.1f}s")
