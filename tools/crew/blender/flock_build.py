"""
Build a flocked crew character in the Blender scene from a cast spec (bpy).

  place(spec, loc=(0,0,0), yaw=0, quality=1.0) -> (root empty, [objects])
"""

from __future__ import annotations

import math
import os
import sys
import time

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import flock_bpy as B  # noqa: E402
import flock_cast as C  # noqa: E402
import flock_sdf as S  # noqa: E402

_CACHE = {}


def _gradient(mat, bottom, top, z0=0.05, z1=0.95):
    nt = mat.node_tree
    b = nt.nodes.get("Principled BSDF")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = z0
    mr.inputs["From Max"].default_value = z1
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    ramp.color_ramp.elements[0].color = (*B.hex_lin(bottom), 1)
    ramp.color_ramp.elements[1].color = (*B.hex_lin(top), 1)
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    return ramp


def material_for(part, sid):
    kind = part["kind"]
    col = part["color"]
    if kind in ("body", "felt"):
        mat = B.flock_material(f"{sid}_{part['name']}", col)
        if part.get("gradient"):
            mat = mat.copy()
            _gradient(mat, *part["gradient"])
        return mat
    if kind == "matte" or col in (C.INK, C.WHITE) or col.lower() in ("#17171c", "#fbfaf6"):
        return B.matte_material(f"m_{col}", col, rough=part.get("rough", 0.8), sheen=part.get("sheen", 0.2))
    return B.flock_material(f"{sid}_{part['name']}", col, grain=0.03)


def fuzz_mat_for(part, sid):
    if part.get("gradient"):
        bottom, top = part["gradient"]
        mat = B.fuzz_material(f"{sid}_fz_{part['name']}", C.PAL["peach"]).copy()
        nt = mat.node_tree
        b = nt.nodes.get("Principled BSDF")
        _gradient(mat, bottom, top)
        return mat
    return B.fuzz_material(f"{sid}_fz_{part['name']}", part["color"])


def build_meshes(spec):
    key = repr(sorted((k, repr(v)) for k, v in spec.items()))
    if key in _CACHE:
        return _CACHE[key]
    t0 = time.time()
    c = C.character(spec)
    out = []
    for part in c.parts:
        V, Q = S.mesh(part["f"], h=part["h"], lo=part["lo"], hi=part["hi"], relax_iters=3 if part["kind"] != "decal" else 2)
        out.append((part, V, Q))
    print(f"MESHED {spec['id']} {len(out)} parts {time.time() - t0:.1f}s")
    _CACHE[key] = (c, out)
    return c, out


def place(spec, loc=(0, 0, 0), yaw=0.0, quality=1.0, seed=1, fuzz_on=True, coll=None):
    c, meshes = build_meshes(spec)
    sid = spec["id"]
    coll = coll or bpy.data.collections.get("characters") or bpy.context.scene.collection
    root = bpy.data.objects.new(f"{sid}_root", None)
    coll.objects.link(root)
    root.location = loc
    root.rotation_euler = (0, 0, math.radians(yaw))
    objs = []
    for part, V, Q in meshes:
        if len(Q) == 0:
            continue
        ob = B.mesh_object(f"{sid}_{part['name']}", V, Q, coll, subsurf=1)
        ob.parent = root
        B.assign(ob, material_for(part, sid))
        if fuzz_on and part["fuzz"]:
            group = None
            if part["kind"] == "body" and c.excl:
                co = B.vert_co(ob)
                w = np.ones(len(co))
                for reg, ycut in c.excl:
                    r = reg(co[:, 0], co[:, 2])
                    m = np.ones(len(co), bool) if ycut is None else co[:, 1] < ycut + 0.02
                    w = np.where(m, np.minimum(w, S.sstep(0.008, 0.026, r)), w)
                B.set_group(ob, "dens", w)
                group = "dens"
            L = float(os.environ.get("FUZZ_LEN", 0.012)) * part.get("fuzz_len", 1.0)
            B.fuzz(ob, fuzz_mat_for(part, sid), length=L, quality=quality, seed=seed + len(objs), density_group=group)
        objs.append(ob)
    return root, objs, c
