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


def _bump(mat, scale, strength, distortion=0.0, kind="noise", wave=None):
    """A fine surface texture through the bump (object space, so every body shares the grain)."""
    nt = mat.node_tree
    b = nt.nodes.get("Principled BSDF")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    if kind == "wave":
        tex = nt.nodes.new("ShaderNodeTexWave")
        tex.inputs["Scale"].default_value = scale
        tex.inputs["Distortion"].default_value = distortion
        tex.bands_direction = wave or "X"
    else:
        tex = nt.nodes.new("ShaderNodeTexNoise")
        tex.inputs["Scale"].default_value = scale
        tex.inputs["Detail"].default_value = 6.0
        tex.inputs["Roughness"].default_value = 0.62
        tex.inputs["Distortion"].default_value = distortion
    nt.links.new(tc.outputs["Object"], tex.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.002
    nt.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    try:
        nt.links.new(bump.outputs["Normal"], b.inputs["Coat Normal"])
    except Exception:
        pass


def _principled(name, hexc, rough, spec=0.32, coat=0.0, coat_rough=0.4, sss=0.0, sheen=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = mat.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*B.hex_lin(hexc), 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = spec
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Coat Roughness"].default_value = coat_rough
    if sss:
        b.inputs["Subsurface Weight"].default_value = sss
        b.inputs["Subsurface Radius"].default_value = (0.08, 0.05, 0.035)
        b.inputs["Subsurface Scale"].default_value = 0.06
    if sheen:
        b.inputs["Sheen Weight"].default_value = sheen
        b.inputs["Sheen Roughness"].default_value = 0.45
    return mat


def vinyl(name, hexc):
    """Premium soft vinyl: a broad soft highlight under a faint satin coat, a soft
    subsurface glow at thin edges, and a very fine micro-texture (no sparkle)."""
    key = ("vinyl", hexc)
    if key in _MATS:
        return _MATS[key]
    mat = _principled(name, hexc, float(os.environ.get("VROUGH", 0.48)), 0.32, float(os.environ.get("VCOAT", 0.16)), 0.45, sss=0.08)
    _bump(mat, 520.0, 0.035)
    _MATS[key] = mat
    return mat


def fabric(name, hexc):
    """Cotton twill for caps, beanies and nightcaps: dead matte, a soft sheen, a fine weave."""
    key = ("fabric", hexc)
    if key in _MATS:
        return _MATS[key]
    mat = _principled(name, hexc, 0.86, 0.18, sheen=0.55)
    _bump(mat, 700.0, 0.035, distortion=0.4, kind="wave", wave="DIAGONAL")
    _MATS[key] = mat
    return mat


def lacquer(name, hexc):
    """Lacquered acetate for glasses: a clean soft gloss."""
    key = ("lacquer", hexc)
    if key in _MATS:
        return _MATS[key]
    mat = _principled(name, hexc, 0.3, 0.45, coat=0.7, coat_rough=0.12)
    _MATS[key] = mat
    return mat


def softtouch(name, hexc):
    """Soft-touch rubberised plastic for headphones and the satellite's mast."""
    key = ("soft", hexc)
    if key in _MATS:
        return _MATS[key]
    mat = _principled(name, hexc, 0.72, 0.2)
    _bump(mat, 900.0, 0.04)
    _MATS[key] = mat
    return mat


def ceramic(name, hexc):
    """Glazed ceramic for Mira's badge: a little brighter and smoother than the body."""
    key = ("ceramic", hexc)
    if key in _MATS:
        return _MATS[key]
    mat = _principled(name, hexc, 0.36, 0.4, coat=0.35, coat_rough=0.25, sss=0.05)
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
    name = part["name"]
    if kind == "decal" and (name.startswith("eye") or name.startswith("pupil") or name.startswith("white")):
        return matte(f"m_{col}", col)
    if name in FABRIC or name.startswith("leaf"):
        return fabric(f"f_{name}_{col}", col)
    if name.startswith("frames") or name.startswith("temple"):
        return lacquer(f"l_{col}", col)
    if name in SOFT or name.startswith("cup") or name.startswith("seam"):
        return softtouch(f"s_{name}_{col}", col)
    if name == "disc":
        return ceramic("c_disc", col)
    if kind in ("decal", "matte"):
        return matte(f"m_{col}", col)
    return vinyl(f"v_{name}_{col}", col)


FABRIC = {"cap", "brim", "button", "beanie", "pom", "nightcap", "hat"}
SOFT = {"band", "mast", "arm0", "arm1"}


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
    B.studio(sc, floor=True, rim=float(os.environ.get('RIM', 1.6)))
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


def clean_alpha(path, floor=0.1):
    """The shadow catcher leaves a faint wash over the whole floor (indirect light it
    'misses'), which shows as a grey box on the page. Keep only the real contact
    shadow: alpha below the floor goes to zero, the rest is rescaled."""
    im = bpy.data.images.load(path)
    w, h = im.size
    a = np.zeros(w * h * 4, np.float32)
    im.pixels.foreach_get(a)
    a = a.reshape(-1, 4)
    al = a[:, 3]
    a[:, 3] = np.clip((al - floor) / (1 - floor), 0, 1)
    im.pixels.foreach_set(a.ravel())
    im.filepath_raw = path
    im.file_format = "PNG"
    im.save()
    bpy.data.images.remove(im)


def render(sc, path):
    t0 = time.time()
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    clean_alpha(path)
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

if mode in ("custom", "all"):
    base = O.BY_ID["mira"]
    for k in range(len(O.CUSTOM)):
        shot(O.with_state(O.custom_spec(base, k), "ready"), os.path.join(out_dir, f"mira_custom{k}.png"), RES)

if mode in ("sprites",):
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
