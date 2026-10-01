"""
Fur look-development: one character, Cycles, a few fur settings side by side.

  Blender --background --factory-startup --python crew_furtest.py -- <out_prefix> <shape> <hex> [variant ...]
"""

import math
import os
import sys
import time

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crew_bpy as B  # noqa: E402
import crew_shapes as CS  # noqa: E402

args = B.args_after_dashes()
prefix = args[0]
shape = args[1] if len(args) > 1 else "pebble"
hexc = args[2] if len(args) > 2 else "#f2b838"
variants = args[3:] or ["a"]

VAR = {
    "n": dict(length=0.034, count=26000, children=50, root=0.0022, tip=0.0004, clump=0.05, rough=0.014, child_radius=0.025, spread=0.7, frizz=1.2),
    "o": dict(length=0.04, count=24000, children=50, root=0.0022, tip=0.0004, clump=0.08, rough=0.016, child_radius=0.03, spread=0.6, frizz=1.0),
    "m": dict(length=0.05, count=16000, children=45, root=0.0028, tip=0.0005, clump=0.1, rough=0.022, child_radius=0.035, spread=0.85, frizz=1.0),
    "j": dict(length=0.055, count=16000, children=45, root=0.0028, tip=0.0005, clump=0.1, rough=0.025, child_radius=0.035, spread=0.7, frizz=0.8),
    "k": dict(length=0.05, count=18000, children=45, root=0.0026, tip=0.0005, clump=0.06, rough=0.03, child_radius=0.03, spread=1.0, frizz=1.2),
    "h": dict(length=0.05, count=16000, children=45, root=0.003, tip=0.0005, clump=0.08, rough=0.02, child_radius=0.03),
    "i": dict(length=0.055, count=16000, children=45, root=0.0028, tip=0.0005, clump=0.12, rough=0.03, child_radius=0.035, kink=0.006),
    "e": dict(length=0.045, count=16000, children=40, root=0.0032, tip=0.0006, clump=0.1, rough=0.006, child_radius=0.03),
    "f": dict(length=0.055, count=16000, children=50, root=0.0028, tip=0.0005, clump=0.18, rough=0.01, child_radius=0.035),
    "g": dict(length=0.04, count=20000, children=50, root=0.0025, tip=0.0004, clump=0.05, rough=0.004, child_radius=0.025),
    # length, count, children, root, clump, rough, child_radius, rough_hair, diffuse mix
    "a": dict(length=0.075, count=9000, children=50, root=0.0045, tip=0.0008, clump=0.25, rough=0.01, child_radius=0.05),
    "b": dict(length=0.1, count=9000, children=60, root=0.005, tip=0.0008, clump=0.4, rough=0.016, child_radius=0.07),
    "c": dict(length=0.06, count=12000, children=60, root=0.0038, tip=0.0006, clump=0.15, rough=0.008, child_radius=0.04),
    "d": dict(length=0.12, count=8000, children=70, root=0.0055, tip=0.001, clump=0.5, rough=0.02, child_radius=0.08),
}

for v in variants:
    t0 = time.time()
    sc = B.reset_scene()
    B.studio(sc)
    body, p = B.body_object(shape, 25, subsurf=1)
    sc.collection.objects.unlink(body)
    bpy.data.collections["characters"].objects.link(body)
    skin = B.skin_material("skin", hexc, float(os.environ.get("SKIN", 0.8)))
    furm = B.fur_material("fur", hexc)
    body.data.materials.append(skin)
    body.data.materials.append(furm)
    eye = B.eye_material()
    eyes = CS.face_layout(shape)
    for k, e in enumerate(eyes):
        e = dict(e)
        e["p"] = e["p"] + e["n"] * float(os.environ.get("EYE_OUT", 0.022))
        eo = B.oval_eye(f"eye{k}", e, e["r"] * float(os.environ.get("EYE_K", 1.12)), mat=eye, depth=0.5)
        sc.collection.objects.unlink(eo)
        bpy.data.collections["characters"].objects.link(eo)
    # Fur: none on the eyes, shorter around them (they sit in the pile).
    def dens(gl):
        w = np.ones(len(gl))
        for e in eyes:
            d = np.linalg.norm(gl - e["p"], axis=1) / e["r"]
            w = np.minimum(w, np.clip((d - 1.08) / 0.3, 0, 1))
        return w

    def leng(gl):
        w = np.ones(len(gl))
        for e in eyes:
            d = np.linalg.norm(gl - e["p"], axis=1) / e["r"]
            w = np.minimum(w, 0.25 + 0.75 * np.clip((d - 1.05) / 1.4, 0, 1))
        # A little shorter on the base (it sits on it).
        w *= np.clip(gl[:, 1] / 0.12, 0.4, 1.0)
        return w

    B.set_group(body, "density", B.vertex_weights(body, dens))
    B.set_group(body, "length", B.vertex_weights(body, leng))
    B.fur(body, 1, density_group="density", length_group="length", **VAR[v])
    b = CS.bounds(p)
    ext = max(b["top"] - b["bottom"], 2 * b["halfWidth"]) + 0.2
    dist = ext / 0.78 / (2 * math.tan(math.radians(0.5 * 23.9)))
    B.camera_for(sc, target=(0, 0, b["bottom"] + (b["top"] - b["bottom"]) * 0.5), dist=dist, lens=85, elev_deg=7, yaw_deg=float(os.environ.get("YAW", -8)))
    sc.render.resolution_x = int(os.environ.get("RES", 640))
    sc.render.resolution_y = int(os.environ.get("RES", 640))
    sc.cycles.samples = int(os.environ.get("SPP", 64))
    try:
        sc.cycles_curves.shape = os.environ.get("CURVES", "RIBBONS")
    except Exception as e:
        print("curves", e)
    out = f"{prefix}_{shape}_{v}.png"
    sc.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print("WROTE", out, f"{time.time() - t0:.1f}s")
