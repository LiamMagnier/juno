"""
Cycles stills of the flocked crew (pass renders).

  Blender --background --factory-startup --python flock_render.py -- <mode> <out_dir> <sheet> [ids...]

  test       one character, front and 3/4 (quick look-dev)
  portraits  every character of the sheet: <id>_front.png, <id>_34.png (transparent, contact shadow)
  lineup     the sheet peeking from the bottom edge (transparent): lineup_<sheet>.png
  variants   customization variants of one character: var_<sheet>_<k>.png
  states     the six agent states on one character: state_<id>_<k>.png

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


def cam_dir(yaw, elev=7):
    """The world direction from the subject toward a camera at this yaw/elevation (see B.camera)."""
    a, e = math.radians(yaw), math.radians(elev)
    return (math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))


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
    if os.environ.get("VIEW") == "front":
        views = [("front", 0)]
    for m in members:
        for vname, yaw in views:
            sc = scene(RES, RES)
            root, objs, c = FB.place(m, yaw=0, quality=Q, fuzz_on=FUZZ, view=cam_dir(yaw))
            portrait_cam(sc, objs, yaw)
            render(sc, os.path.join(out_dir, f"{m['id']}_{vname}.png"))
        if mode == "portraits" and os.environ.get("ICONS", "1") == "1":
            r = int(os.environ.get("ICON_RES", 384))
            sc = scene(r, r, floor=False)
            sc.cycles.samples = max(48, SPP // 2)
            root, objs, c = FB.place(m, yaw=0, quality=Q, fuzz_on=FUZZ, view=cam_dir(0, 0))
            icon_cam(sc, objs, r)
            render(sc, os.path.join(out_dir, f"{m['id']}_icon.png"))

elif mode == "lineup":
    members = [find(i) for i in only] if only else [find(i) for i in C.LINEUP.get(sheet, [])] or cast(sheet)
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
    placed = []  # (index, depth y, root, objects) for the layered render
    for i, m in enumerate(members):
        x = pos[i] - mid
        yaw = -x * float(os.environ.get("TURN", 5))
        y = float(os.environ.get("DEPTH", 0.35)) * (i % 2)
        z = 0.0
        if os.environ.get("EYEUP"):
            # Peek like the dots key art: every eye line sits EYEUP above the
            # picture's bottom edge (z = 0); bodies sink below it as needed.
            cc, _ = FB.build_meshes(m)
            ez = m.get("eyes", {}).get("z", cc.face["z"])
            z = float(os.environ["EYEUP"]) - ez + m.get("lift", 0.0)
        layered = os.environ.get("LAYERED") == "1"
        root, ob, c = FB.place(m, loc=(x, y, z), yaw=yaw, quality=Q, seed=i * 7 + 1, fuzz_on=FUZZ and not layered, view=cam_dir(0, 0))
        lean = m.get("lean", 0.0)
        if lean:
            root.rotation_euler[1] = math.radians(lean)
        objs += ob
        placed.append((i, y, (x, y, z), yaw, m))
    span = right - left
    if os.environ.get("PPU"):
        # A fixed scale (pixels per body unit), like the dots key art: big heads.
        vis_w = W / float(os.environ["PPU"])
    else:
        vis_w = span / float(os.environ.get("FILLW", 0.88))
    vis_h = vis_w * H / W
    # The frame's bottom edge cuts the characters at z = CROP (body units):
    # they peek up from the bottom of the picture.
    crop = 0.0 if os.environ.get("EYEUP") else float(os.environ.get("CROP", 0.08))
    zc = crop + vis_h / 2
    B.camera(sc, target=(0, 0, zc), dist=30, lens=85, elev=0, yaw=0, ortho=vis_w)
    if os.environ.get("LAYERED") != "1":
        render(sc, os.path.join(out_dir, f"lineup_{sheet}.png"))
    else:
        # One character's flock per render (memory), the others present as bare
        # meshes that cast shadows and bounce light but are invisible to the
        # camera; then composite the layers back to front.
        import numpy as np

        layers = []
        for k, (i, y, loc, yaw, m) in enumerate(placed):
            for ob in list(bpy.data.objects):
                if ob.name.startswith(m["id"] + "_") and ob.type == "MESH":
                    bpy.data.objects.remove(ob, do_unlink=True)
            root, ob_k, c = FB.place(m, loc=loc, yaw=yaw, quality=Q, seed=i * 7 + 1, fuzz_on=FUZZ, view=cam_dir(0, 0))
            for ob in bpy.data.objects:
                if ob.type == "MESH" and ob.name != "floor":
                    ob.visible_camera = ob in ob_k
            path = os.path.join(out_dir, f".layer_{sheet}_{k}.png")
            render(sc, path)
            layers.append((y, path))
            # back to a bare stand-in for the next layer
            for ob in ob_k:
                bpy.data.objects.remove(ob, do_unlink=True)
            FB.place(m, loc=loc, yaw=yaw, quality=Q, seed=i * 7 + 1, fuzz_on=False)

        def load(pth):
            im = bpy.data.images.load(pth)
            w, h = im.size
            a = np.zeros(w * h * 4, np.float32)
            im.pixels.foreach_get(a)
            bpy.data.images.remove(im)
            return a.reshape(h, w, 4)

        acc = None
        for y, pth in sorted(layers, key=lambda t: -t[0]):  # far first
            L_ = load(pth)
            if acc is None:
                acc = L_
                continue
            a = L_[..., 3:4]
            da = acc[..., 3:4]
            oa = a + da * (1 - a)
            rgb = (L_[..., :3] * a + acc[..., :3] * da * (1 - a)) / np.maximum(oa, 1e-6)
            acc = np.concatenate([rgb, oa], -1)
        h, w = acc.shape[:2]
        out = bpy.data.images.new("lineup", w, h, alpha=True)
        out.pixels.foreach_set(acc.ravel())
        out.filepath_raw = os.path.join(out_dir, f"lineup_{sheet}.png")
        out.file_format = "PNG"
        out.save()
        print("WROTE", out.filepath_raw, flush=True)

elif mode == "states":
    base = find(only[0]) if only else find(C.STATES[sheet])
    for k, over in enumerate(C.state_overrides(base)):
        m = copy.deepcopy(base)
        m.update(over)
        m["id"] = f"{base['id']}_s{k}"
        sc = scene(RES, RES)
        yv = float(os.environ.get("YAW", 14))
        root, objs, c = FB.place(m, quality=Q, fuzz_on=FUZZ, view=cam_dir(yv))
        portrait_cam(sc, objs, yv)
        render(sc, os.path.join(out_dir, f"state_{base['id']}_{k}.png"))

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
        yv = float(os.environ.get("YAW", 32))
        root, objs, c = FB.place(m, quality=Q, fuzz_on=FUZZ, view=cam_dir(yv))
        portrait_cam(sc, objs, yv)
        render(sc, os.path.join(out_dir, f"var_{base['id']}_{k}.png"))
