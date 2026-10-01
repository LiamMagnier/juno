"""
Cycles stills of the flocked crew (pass renders).

  Blender --background --factory-startup --python flock_render.py -- <mode> <out_dir> <sheet> [ids...]

  test       one character, front and 3/4 (quick look-dev)
  portraits  every character of the sheet: <id>_front.png, <id>_34.png (transparent, contact shadow)
  lineup     the sheet peeking from the bottom edge (transparent): lineup_<sheet>.png
  variants   customization variants of one character: var_<sheet>_<k>.png

Env: RES, SPP, Q (fuzz quality 0.2..1), NOFUZZ=1.
"""

from __future__ import annotations

import copy
import json
import math
import os
import sys
import time

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flock_bpy as B  # noqa: E402
import flock_build as FB  # noqa: E402
import flock_cast as C  # noqa: E402

args = B.args_after_dashes()
mode = args[0]
out_dir = args[1]
sheet = args[2] if len(args) > 2 else "A"
only = args[3:]
os.makedirs(out_dir, exist_ok=True)
RES = int(os.environ.get("RES", 1000))
SPP = int(os.environ.get("SPP", 128))
Q = float(os.environ.get("Q", 1.0))
FUZZ = os.environ.get("NOFUZZ") != "1"


def world_bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    bpy.context.view_layer.update()
    for ob in objs:
        if ob.type != "MESH":
            continue
        for cc in ob.bound_box:
            w = ob.matrix_world @ Vector(cc)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def portrait_cam(sc, objs, yaw, fill=0.74, elev=7, lens=70):
    lo, hi = world_bounds(objs)
    h = hi.z - 0.0
    w = hi.x - lo.x
    ext = max(h, w) * 1.0 + 0.06
    dist = B.fit_dist(ext, lens=lens, fill=fill)
    B.camera(sc, target=(0.5 * (lo.x + hi.x), 0, h * 0.5), dist=dist, lens=lens, elev=elev, yaw=yaw)


def render(sc, path):
    t0 = time.time()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("WROTE", path, f"{time.time() - t0:.1f}s", flush=True)


def scene(res_x, res_y, floor=True, spread=1.0):
    sc = B.reset_scene()
    B._MAT.clear()
    B.setup_render(sc, res_x, res_y, SPP)
    B.studio(sc, floor=floor, spread=spread)
    return sc


def cast(sheet):
    return C.CAST[sheet]


def find(cid):
    for s, lst in C.CAST.items():
        for m in lst:
            if m["id"] == cid:
                return m
    raise KeyError(cid)


def icon_cam(sc, objs, res):
    lo, hi = world_bounds(objs)
    w = hi.x - lo.x
    h = hi.z - max(lo.z, 0)
    ext = max(w, h) * 1.04
    cx, cz = 0.5 * (lo.x + hi.x), max(lo.z, 0) + 0.5 * h
    B.camera(sc, target=(cx, 0, cz), dist=20, lens=85, elev=0, yaw=0, ortho=ext)


if mode in ("test", "portraits"):
    members = [find(i) for i in only] if only else cast(sheet)
    views = [("front", 0), ("34", 32)] if mode == "portraits" or os.environ.get("BOTH") else [("34", 32)]
    for m in members:
        for vname, yaw in views:
            sc = scene(RES, RES)
            root, objs, c = FB.place(m, yaw=0, quality=Q, fuzz_on=FUZZ)
            portrait_cam(sc, objs, yaw)
            render(sc, os.path.join(out_dir, f"{m['id']}_{vname}.png"))
        if mode == "portraits" and os.environ.get("ICONS", "1") == "1":
            r = int(os.environ.get("ICON_RES", 384))
            sc = scene(r, r, floor=False)
            sc.cycles.samples = max(48, SPP // 2)
            root, objs, c = FB.place(m, yaw=0, quality=Q, fuzz_on=FUZZ)
            icon_cam(sc, objs, r)
            render(sc, os.path.join(out_dir, f"{m['id']}_icon.png"))

elif mode == "lineup":
    members = [find(i) for i in only] if only else cast(sheet)
    W = int(os.environ.get("LW", 2000))
    H = int(os.environ.get("LH", 560))
    # The lights move back and grow so the whole row is lit like one portrait.
    sc = scene(W, H, floor=False, spread=float(os.environ.get("LSPREAD", 2.4)))
    n = len(members)
    # Widths first (bodies with their accessories), then pack them shoulder to
    # shoulder with a little overlap, alternating a step forward and back.
    widths = []
    for m in members:
        c, meshes = FB.build_meshes(m)
        xs_ = [V[:, 0] for part, V, Q_ in meshes if len(V)]
        lo_x = min(float(v.min()) for v in xs_)
        hi_x = max(float(v.max()) for v in xs_)
        widths.append((lo_x, hi_x))
    overlap = float(os.environ.get("OVERLAP", 0.1))
    pos = [0.0]
    for i in range(1, n):
        prev_hi = widths[i - 1][1]
        cur_lo = widths[i][0]
        wprev = widths[i - 1][1] - widths[i - 1][0]
        wcur = widths[i][1] - widths[i][0]
        pos.append(pos[-1] + prev_hi - cur_lo - overlap * min(wprev, wcur))
    left = pos[0] + widths[0][0]
    right = pos[-1] + widths[-1][1]
    mid = 0.5 * (left + right)
    objs = []
    for i, m in enumerate(members):
        x = pos[i] - mid
        yaw = -x * float(os.environ.get("TURN", 5))
        y = 0.35 * (i % 2)
        root, ob, c = FB.place(m, loc=(x, y, 0), yaw=yaw, quality=Q, seed=i * 7 + 1, fuzz_on=FUZZ)
        objs += ob
    span = right - left
    vis_w = span / float(os.environ.get("FILLW", 0.88))
    vis_h = vis_w * H / W
    crop = float(os.environ.get("CROP", 0.08))
    zc = crop + vis_h / 2
    B.camera(sc, target=(0, 0, zc), dist=30, lens=85, elev=0, yaw=0, ortho=vis_w)
    render(sc, os.path.join(out_dir, f"lineup_{sheet}.png"))

elif mode == "variants":
    if os.environ.get("VARIANTS"):
        base = find(only[0])
        vs = json.loads(os.environ["VARIANTS"])
    else:
        spec = C.VARIANTS[sheet]
        base = find(spec["base"])
        vs = [it["over"] for it in spec["items"]]
    for k, v in enumerate(vs):
        m = copy.deepcopy(base)
        m.update(v)
        m["id"] = f"{base['id']}_v{k}"
        sc = scene(RES, RES)
        root, objs, c = FB.place(m, quality=Q, fuzz_on=FUZZ)
        portrait_cam(sc, objs, float(os.environ.get("YAW", 32)))
        render(sc, os.path.join(out_dir, f"var_{base['id']}_{k}.png"))
