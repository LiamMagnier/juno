"""
Cycles stills of the Alevr Orbit agents, direction A (soft matte vinyl).

  blender --background --factory-startup --python orbit_render.py -- <mode> <out_dir> [ids...]

  portraits   every character, Ready: <id>.png (transparent, one soft contact shadow)
  states      Mira in every state: mira_<state>.png
  sprites     the simplified small-size variants used in list rows: <id>_<state>_s<px>.png
              (rendered at 3x the display size)
  all         the three above

One studio, one camera angle (a slight top-down three-quarter), one contact
shadow style for every character. Env: RES (portraits, default 640), SPP (160).
"""

from __future__ import annotations

import math
import os
import sys
import time

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import flock_bpy as B  # noqa: E402
import flock_sdf as S  # noqa: E402
import orbit_cast as O  # noqa: E402

args = B.args_after_dashes()
mode = args[0]
out_dir = args[1]
only = args[2:]
os.makedirs(out_dir, exist_ok=True)
RES = int(os.environ.get("RES", 640))
SPP = int(os.environ.get("SPP", 160))
YAW = float(os.environ.get("YAW", 18))
ELEV = float(os.environ.get("ELEV", 13))
T0 = time.time()

_MESH = {}
_MATS = {}


# ---------------------------------------------------------------- materials


def vinyl(name, hexc):
    """Soft matte vinyl: a broad soft highlight, a faint satin coat, no sparkle."""
    key = ("vinyl", hexc)
    if key in _MATS:
        return _MATS[key]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*B.hex_lin(hexc), 1)
    b.inputs["Roughness"].default_value = float(os.environ.get("VROUGH", 0.5))
    b.inputs["Specular IOR Level"].default_value = 0.32
    b.inputs["Coat Weight"].default_value = float(os.environ.get("VCOAT", 0.18))
    b.inputs["Coat Roughness"].default_value = 0.42
    b.inputs["Subsurface Weight"].default_value = 0.04
    b.inputs["Subsurface Radius"].default_value = (0.06, 0.04, 0.03)
    b.inputs["Subsurface Scale"].default_value = 0.05
    _MATS[key] = mat
    return mat


def matte(name, hexc):
    """Graphic eyes and marks: dead matte, so no catchlight ever reads as a wet eye."""
    key = ("matte", hexc)
    if key in _MATS:
        return _MATS[key]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*B.hex_lin(hexc), 1)
    b.inputs["Roughness"].default_value = 1.0
    b.inputs["Specular IOR Level"].default_value = 0.04
    _MATS[key] = mat
    return mat


def glow(name, inner, outer, R0, R1, zc, tilt, roll):
    """The accretion disc: emissive, hot white-gold at the inner edge cooling to amber."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    b = nt.nodes.get("Principled BSDF")
    b.inputs["Roughness"].default_value = 0.6
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Object"], sep.inputs[0])
    # radius in the object's xy (the disc is nearly flat; tilt ignored for the ramp)
    mx = nt.nodes.new("ShaderNodeMath")
    mx.operation = "MULTIPLY"
    nt.links.new(sep.outputs["X"], mx.inputs[0])
    nt.links.new(sep.outputs["X"], mx.inputs[1])
    my = nt.nodes.new("ShaderNodeMath")
    my.operation = "MULTIPLY"
    nt.links.new(sep.outputs["Y"], my.inputs[0])
    nt.links.new(sep.outputs["Y"], my.inputs[1])
    add = nt.nodes.new("ShaderNodeMath")
    add.operation = "ADD"
    nt.links.new(mx.outputs[0], add.inputs[0])
    nt.links.new(my.outputs[0], add.inputs[1])
    sq = nt.nodes.new("ShaderNodeMath")
    sq.operation = "SQRT"
    nt.links.new(add.outputs[0], sq.inputs[0])
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = R0
    mr.inputs["From Max"].default_value = R1
    nt.links.new(sq.outputs[0], mr.inputs["Value"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (*B.hex_lin(inner), 1)
    ramp.color_ramp.elements[1].color = (*B.hex_lin(outer), 1)
    ramp.color_ramp.elements.new(0.55).color = (*B.hex_lin("#ff8a00"), 1)
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Emission Color"])
    b.inputs["Emission Strength"].default_value = float(os.environ.get("GLOW", 2.2))
    return mat


def material_for(part):
    kind = part["kind"]
    col = part["color"]
    if kind == "glow":
        return glow(f"glow_{part['name']}", *part["glow"][:2], *part["glow"][2:4], *part["glow"][4:])
    if kind in ("decal", "matte"):
        return matte(f"m_{col}", col)
    return vinyl(f"v_{part['name']}_{col}", col)


# ---------------------------------------------------------------- build


def meshes(spec):
    key = spec["id"]
    if key in _MESH:
        return _MESH[key]
    c = O.character(spec)
    out = []
    for part in c.parts:
        h = part["h"] * (1.25 if spec.get("sprite") else 1.0)
        V, Q = S.mesh(part["f"], h=h, lo=part["lo"], hi=part["hi"], relax_iters=3 if part["kind"] != "decal" else 2)
        out.append((part, V, Q))
    print(f"MESHED {spec['id']} {len(out)} parts {time.time() - T0:.0f}s", flush=True)
    _MESH[key] = (c, out)
    return c, out


def place(spec):
    c, ms = meshes(spec)
    root = bpy.data.objects.new(f"{spec['id']}_root", None)
    coll = bpy.data.collections.get("characters") or bpy.context.scene.collection
    coll.objects.link(root)
    root.location = (0, 0, spec.get("lift", 0.0))
    root.rotation_euler = (0, math.radians(spec.get("lean", 0.0)), 0)
    objs = []
    for part, V, Q in ms:
        if len(Q) == 0:
            continue
        ob = B.mesh_object(f"{spec['id']}_{part['name']}", V, Q, coll, subsurf=1)
        ob.parent = root
        B.assign(ob, material_for(part))
        if part["kind"] == "glow":
            ob.visible_shadow = False
        objs.append(ob)
    return objs


def world_bounds(objs):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    bpy.context.view_layer.update()
    for ob in objs:
        for cc in ob.bound_box:
            w = ob.matrix_world @ Vector(cc)
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
    return lo, hi


def scene(res):
    sc = B.reset_scene()
    _MATS.clear()
    B.setup_render(sc, res, res, SPP)
    B.studio(sc, floor=True)
    # One soft contact shadow: the key goes high and big, the fill casts none.
    key = bpy.data.objects.get("key")
    if key:
        key.location = (-1.6, -2.6, 5.4)
        key.data.size = 7.5
        d = Vector((0, 0, 0.45)) - key.location
        key.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    fill = bpy.data.objects.get("fill")
    if fill:
        fill.data.use_shadow = False
        # and the floor never sees it, so it adds no second shadow
        chars = bpy.data.collections.get("characters")
        if chars:
            fill.light_linking.receiver_collection = chars
    return sc


def frame(sc, objs, fill, yaw=YAW, elev=ELEV):
    lo, hi = world_bounds(objs)
    h = hi.z
    w = hi.x - lo.x
    # One scale for the whole family (bodies are about a unit tall); wide rings may
    # reach the edge rather than shrink their character.
    ext = max(1.32, h + 0.12, w * 0.9)
    dist = B.fit_dist(ext, lens=70, fill=fill)
    B.camera(sc, target=(0.5 * (lo.x + hi.x), 0, h * 0.48), dist=dist, lens=70, elev=elev, yaw=yaw)


def render(sc, path):
    t0 = time.time()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    print("WROTE", path, f"{time.time() - t0:.1f}s", flush=True)


def shot(spec, path, res, fill=0.78, yaw=YAW, elev=ELEV, spp=None):
    sc = scene(res)
    if spp:
        sc.cycles.samples = spp
    objs = place(spec)
    # The frame is set by the Ready pose so a state change never rescales the character.
    frame(sc, objs, fill, yaw, elev)
    render(sc, path)


members = [O.BY_ID[i] for i in only] if only else O.CAST

if mode in ("portraits", "all"):
    for m in members:
        shot(O.with_state(m, "ready"), os.path.join(out_dir, f"{m['id']}.png"), RES)

if mode in ("states", "all"):
    base = O.BY_ID["mira"]
    for st in O.STATES:
        shot(O.with_state(base, st), os.path.join(out_dir, f"mira_{st}.png"), RES)

if mode in ("sprites", "all"):
    # The pairs the board's product rows use, at 3x their display size.
    want = os.environ.get("SPRITES")
    pairs = [tuple(x.split(":")) for x in want.split(",")] if want else [
        ("mira", "waiting", "28"), ("otto", "working", "28"), ("ori", "thinking", "28"), ("luna", "paused", "28"), ("rhea", "finished", "28"),
        ("ori", "thinking", "20"), ("bram", "working", "20"), ("kip", "working", "20"), ("dew", "paused", "20"), ("vela", "waiting", "20"), ("sato", "finished", "20"),
        ("mira", "ready", "28"), ("mira", "ready", "20"),
    ]
    for cid, st, px in pairs:
        spec = O.sprite_spec(O.with_state(O.BY_ID[cid], st))
        # Small sizes: nearly front-on, framed tight, fewer samples.
        shot(spec, os.path.join(out_dir, f"{cid}_{st}_s{px}.png"), int(px) * 3, fill=0.92, yaw=10, elev=9, spp=96)

print("DONE", f"{time.time() - T0:.0f}s", flush=True)
