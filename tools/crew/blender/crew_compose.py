"""
Compose a crew character in Blender from an avatar config (bpy).

  compose(member, location, yaw_deg, roll_deg) -> root empty

The body gets plush fur (particle hair) whose colour comes from a colour
attribute painted with the body colour, the pattern and the blush; the eyes
and the accessories are the canonical parts placed by crew_fit.
"""

from __future__ import annotations

import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crew_bpy as B  # noqa: E402
import crew_fit as F  # noqa: E402
import crew_parts as P  # noqa: E402
import crew_shapes as CS  # noqa: E402

C4 = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], float)
C4i = np.linalg.inv(C4)

_PARTS = None
_MESHES = {}
_MATS = {}


def reset_caches():
    _MESHES.clear()
    _MATS.clear()


def parts():
    global _PARTS
    if _PARTS is None:
        _PARTS = {k: v[0] for k, v in P.all_parts().items()}
        _PARTS.update(P.eye_parts())
    return _PARTS


def part_mesh(name):
    me = _MESHES.get(name)
    if me is not None:
        return me
    v, f = parts()[name].arrays()
    vb = CS.to_blender(v)
    me = bpy.data.meshes.new(name)
    me.from_pydata(vb.tolist(), [], [list(map(int, x)) for x in f])
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    _MESHES[name] = me
    return me


def bl_matrix(M):
    return Matrix((C4 @ np.asarray(M) @ C4i).tolist())


# ---------------------------------------------------------------- colour


def mix_hex(a, b, t):
    ca, cb = np.array(B.hex_rgb(a)), np.array(B.hex_rgb(b))
    c = ca + (cb - ca) * t
    return "#" + "".join(f"{int(round(x * 255)):02x}" for x in np.clip(c, 0, 1))


def darker(h, k=0.75):
    c = np.array(B.hex_rgb(h)) * k
    return "#" + "".join(f"{int(round(x * 255)):02x}" for x in np.clip(c, 0, 1))


def blush_of(body):
    r, g, b = B.hex_rgb(body)
    pinkish = r > 0.8 and b > 0.6 and g < 0.8
    return mix_hex(body, "#c9486b" if pinkish else "#f2869a", 0.55 if pinkish else 0.5)


# ---------------------------------------------------------------- materials


def bump_node(nt, kind, scale=1.0):
    coord = nt.nodes.new("ShaderNodeTexCoord")
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.35
    bump.inputs["Distance"].default_value = 0.004
    if kind == "knit":
        w = nt.nodes.new("ShaderNodeTexWave")
        w.wave_type = "BANDS"
        w.bands_direction = "Z"
        w.inputs["Scale"].default_value = 26 * scale
        w.inputs["Distortion"].default_value = 3.0
        w.inputs["Detail"].default_value = 2.0
        nt.links.new(coord.outputs["Object"], w.inputs["Vector"])
        nt.links.new(w.outputs["Fac"], bump.inputs["Height"])
        bump.inputs["Strength"].default_value = 0.6
    elif kind == "canvas":
        c = nt.nodes.new("ShaderNodeTexChecker")
        c.inputs["Scale"].default_value = 160 * scale
        nt.links.new(coord.outputs["Object"], c.inputs["Vector"])
        nt.links.new(c.outputs["Fac"], bump.inputs["Height"])
        bump.inputs["Strength"].default_value = 0.12
    else:
        n = nt.nodes.new("ShaderNodeTexNoise")
        n.inputs["Scale"].default_value = 140 * scale
        n.inputs["Detail"].default_value = 6.0
        nt.links.new(coord.outputs["Object"], n.inputs["Vector"])
        nt.links.new(n.outputs["Fac"], bump.inputs["Height"])
        bump.inputs["Strength"].default_value = 0.25
    return bump


def material(key, color=None, body="#cccccc"):
    color = color or "#3e4045"
    k = (key, color)
    if k in _MATS:
        return _MATS[k]
    if key == "eye":
        m = B.principled("eye", "#141113", rough=0.32, coat=1.0, coat_rough=0.06, spec=0.3)
    elif key == "eye_white":
        m = B.principled("eye_white", "#f6f4ef", rough=0.3, coat=0.8, coat_rough=0.08)
    elif key == "thread_hi":
        m = B.principled("thread_hi", "#f3f0ea", rough=0.5, sheen=0.5, sheen_tint="#ffffff")
    elif key == "thread":
        m = B.principled("thread", "#1d1816", rough=0.55, sheen=0.6, sheen_tint="#ffffff")
    elif key == "glass":
        m = B.principled("glass", "#ffffff", rough=0.03, spec=0.5)
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Transmission Weight"].default_value = 1.0
        bsdf.inputs["IOR"].default_value = 1.45
    elif key == "shade":
        m = B.principled("shade", "#18161a", rough=0.08, coat=1.0, coat_rough=0.03)
    elif key == "metal":
        m = B.principled(f"metal{color}", color, rough=0.28)
        m.node_tree.nodes.get("Principled BSDF").inputs["Metallic"].default_value = 1.0
    elif key == "acetate":
        m = B.principled(f"acetate{color}", color, rough=0.18, coat=1.0, coat_rough=0.05)
    elif key in ("vinyl_white",):
        m = B.principled("vinyl_white", color if color else "#f5f5f2", rough=0.3, coat=0.6, coat_rough=0.1)
    elif key == "stem":
        m = B.principled("stem", "#5f8f3f", rough=0.5, sheen=0.3)
    elif key == "leaf":
        m = B.principled("leaf", "#78b04a", rough=0.6, sheen=0.5, sheen_tint="#e8ffd0")
    elif key == "stem_dark":
        m = B.principled("stem_dark", "#2e2f33", rough=0.4)
    elif key == "petal":
        m = B.principled("petal", "#fbf9f4", rough=0.9, sheen=0.9, sheen_tint="#ffffff", sss=0.2)
    else:
        # Soft goods: felt, knit, canvas, velvet, pompom.
        base = color
        if key == "acc_dark":
            base = darker(color, 0.78)
        if key == "acc_light":
            base = mix_hex(color, "#ffffff", 0.3)
        rough = {"velvet": 0.62, "canvas": 0.85}.get(key, 0.92)
        sheen = {"velvet": 1.0, "knit": 0.7, "canvas": 0.35}.get(key, 0.8)
        # Dark goods keep their depth: their sheen is tinted, not white.
        lum = sum(B.hex_rgb(base)) / 3
        tint = mix_hex(base, "#ffffff", 0.35 + 0.5 * lum)
        if lum < 0.35:
            sheen *= 0.45
        m = B.principled(f"{key}{color}", base, rough=rough, sheen=sheen, sheen_tint=tint, spec=0.22)
        nt = m.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        kind = "knit" if key == "knit" else "canvas" if key == "canvas" else "felt"
        b = bump_node(nt, kind)
        nt.links.new(b.outputs["Normal"], bsdf.inputs["Normal"])
    _MATS[k] = m
    return m


# ---------------------------------------------------------------- the body


def fur_length(member):
    return 0.024 + float(member.get("fur", 0.45)) * 0.032


def body_colors(member, gl, frames):
    body = member["color"]
    lift = float(os.environ.get("FUR_LIFT", 0.28))
    base = np.array(B.hex_rgb(body))
    cols = np.tile(base, (len(gl), 1))
    if member.get("cheeks"):
        bl = np.array(B.hex_rgb(blush_of(body)))
        for fr in frames:
            c = fr["c"] + np.array([fr["side"] * fr["r"] * 1.15, -fr["r"] * 1.25, -fr["r"] * 0.35])
            d = np.linalg.norm(gl - c, axis=1)
            R = fr["r"] * 1.25
            w = 1 - np.clip((d - R * 0.35) / (R * 0.65), 0, 1)
            w = w * w * (3 - 2 * w)
            cols = cols + (bl - cols) * (w[:, None] * 0.9)
    pat = member.get("pattern")
    if pat and pat.get("kind") == "belly":
        pc = np.array(B.hex_rgb(pat["color"]))
        q = np.stack([gl[:, 0] / 0.32, (gl[:, 1] - 0.26) / 0.22], -1)
        w = (1 - np.clip((np.linalg.norm(q, axis=1) - 0.94) / 0.08, 0, 1)) * (gl[:, 2] > 0)
        cols = cols + (pc - cols) * w[:, None]
    # Lift toward white (dense fur deepens colour), then to linear.
    cols = cols + (1 - cols) * lift
    return B.srgb_to_linear(cols)


def furry_material(name, body_hex):
    """Fur that takes its colour from the emitter's colour attribute (pattern, blush)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    info = nt.nodes.new("ShaderNodeHairInfo")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "fur_color"
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    els = ramp.color_ramp.elements
    els[0].position = 0.0
    els[0].color = (0.62, 0.62, 0.62, 1)
    els[1].position = 0.55
    els[1].color = (1, 1, 1, 1)
    e = els.new(1.0)
    e.color = (1.12, 1.12, 1.12, 1)
    nt.links.new(info.outputs["Intercept"], ramp.inputs["Fac"])
    rnd = nt.nodes.new("ShaderNodeMapRange")
    rnd.inputs["To Min"].default_value = 0.9
    rnd.inputs["To Max"].default_value = 1.07
    nt.links.new(info.outputs["Random"], rnd.inputs["Value"])
    m1 = nt.nodes.new("ShaderNodeMix")
    m1.data_type = "RGBA"
    m1.blend_type = "MULTIPLY"
    m1.inputs["Factor"].default_value = 1.0
    nt.links.new(attr.outputs["Color"], m1.inputs[6])
    nt.links.new(ramp.outputs["Color"], m1.inputs[7])
    m2 = nt.nodes.new("ShaderNodeMix")
    m2.data_type = "RGBA"
    m2.blend_type = "MULTIPLY"
    m2.inputs["Factor"].default_value = 1.0
    nt.links.new(m1.outputs[2], m2.inputs[6])
    comb = nt.nodes.new("ShaderNodeCombineColor")
    for k in ("Red", "Green", "Blue"):
        nt.links.new(rnd.outputs["Result"], comb.inputs[k])
    nt.links.new(comb.outputs["Color"], m2.inputs[7])
    hair = nt.nodes.new("ShaderNodeBsdfHairPrincipled")
    try:
        hair.parametrization = "COLOR"
    except Exception:
        pass
    nt.links.new(m2.outputs[2], hair.inputs["Color"])
    hair.inputs["Roughness"].default_value = 0.55
    hair.inputs["Radial Roughness"].default_value = 0.85
    hair.inputs["Coat"].default_value = 0.25
    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    nt.links.new(m2.outputs[2], diff.inputs["Color"])
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = float(os.environ.get("FUR_DIFFUSE", 0.6))
    nt.links.new(hair.outputs[0], mix.inputs[1])
    nt.links.new(diff.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


def skin_from_attr(name):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    attr = nt.nodes.new("ShaderNodeAttribute")
    attr.attribute_name = "fur_color"
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    mul.inputs[7].default_value = (0.72, 0.72, 0.72, 1)
    nt.links.new(attr.outputs["Color"], mul.inputs[6])
    nt.links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 1.0
    bsdf.inputs["Specular IOR Level"].default_value = 0.1
    return mat


def covered(member, gl, anchors, frames, fur):
    """Where accessories sit on the body: (density, length) multipliers."""
    dens = np.ones(len(gl))
    leng = np.ones(len(gl))
    ids = [a["id"] if isinstance(a, dict) else a for a in member.get("accessories", [])]
    if any(i in ("cap", "beanie", "bucket") for i in ids):
        cy = anchors["crown"]["capY"] - 0.05
        w = np.clip((gl[:, 1] - cy) / 0.04, 0, 1)
        dens *= 1 - w
    if "flower" in ids:
        d = np.linalg.norm(gl - np.asarray(anchors["pin"]["p"]), axis=1)
        leng *= 0.35 + 0.65 * np.clip((d - 0.09) / 0.06, 0, 1)
    if any(i in ("sprout", "antenna") for i in ids):
        d = np.linalg.norm(gl - np.asarray(anchors["crown"]["p"]), axis=1)
        leng *= 0.5 + 0.5 * np.clip((d - 0.03) / 0.05, 0, 1)
    if "earbuds" in ids or "hoops" in ids:
        for e in anchors["ears"]:
            d = np.linalg.norm(gl - np.asarray(e["p"]), axis=1)
            leng *= 0.3 + 0.7 * np.clip((d - 0.08) / 0.06, 0, 1)
    if "headphones" in ids:
        for e in anchors["ears"]:
            d = np.linalg.norm(gl - np.asarray(e["p"]), axis=1)
            dens *= np.clip((d - 0.2) / 0.06, 0, 1)
    if any(i in ("scarf", "bandana") for i in ids):
        nk = anchors["neck"]
        d = np.abs(gl[:, 1] - nk["y"])
        leng *= 0.3 + 0.7 * np.clip((d - 0.06) / 0.05, 0, 1)
    closed = member.get("eyes", {}).get("style") == "sleepy"
    for fr in frames:
        d = np.linalg.norm(gl - fr["c"], axis=1) / fr["r"]
        if closed:
            dens *= np.clip((d - 0.75) / 0.3, 0, 1)
            leng *= 0.35 + 0.65 * np.clip((d - 0.8) / 1.0, 0, 1)
        else:
            dens *= np.clip((d - 1.08) / 0.3, 0, 1)
            leng *= 0.25 + 0.75 * np.clip((d - 1.05) / 1.4, 0, 1)
    leng *= CS.fur_shape_mask(member["shape"], gl)
    if "bow" in ids:
        d = np.linalg.norm(gl - np.asarray(anchors["pin"]["p"]), axis=1)
        leng *= 0.35 + 0.65 * np.clip((d - 0.1) / 0.06, 0, 1)
    return dens, leng


def accessory_distance(placements, gl):
    """Distance from each body point to the nearest accessory surface (glTF space)."""
    from mathutils import kdtree

    pts = []
    for pl in placements:
        part = pl["part"]
        if part.startswith("eye") or part.startswith("eyewear") or part.startswith("mouth") or part == "brow":
            continue
        v, _ = parts()[part].arrays()
        M = np.asarray(pl["M"])
        w = v @ M[:3, :3].T + M[:3, 3]
        pts.append(w)
    if not pts:
        return None
    P_ = np.concatenate(pts)
    kd = kdtree.KDTree(len(P_))
    for i, p in enumerate(P_):
        kd.insert(p.tolist(), i)
    kd.balance()
    out = np.empty(len(gl))
    for i, g in enumerate(gl):
        out[i] = kd.find(g.tolist())[2]
    return out


def link(ob, coll):
    for c in ob.users_collection:
        c.objects.unlink(ob)
    coll.objects.link(ob)


def compose(member, location=(0, 0, 0), yaw_deg=0.0, roll_deg=0.0, coll=None, fur_quality=1.0, seed=1):
    coll = coll or bpy.data.collections.get("characters")
    shape = member["shape"]
    fur = fur_length(member)
    root = bpy.data.objects.new(f"crew_{member['id']}", None)
    coll.objects.link(root)
    body, p = B.body_object(shape, 25, subsurf=1, name=f"body_{member['id']}")
    link(body, coll)
    body.parent = root
    # The pile's visible thickness: strands lean and frizz past their length.
    fur_eff = fur * 1.5
    placements, frames, anchors = F.fit(shape, member, fur_eff)

    # Colour attribute: pattern + blush, per vertex.
    me = body.data
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    gl = np.stack([co[:, 0], co[:, 2], -co[:, 1]], -1)
    cols = body_colors(member, gl, frames)
    # Cycles hands particle hair the emitter's corner (loop) colours: store per corner.
    attr = me.color_attributes.new("fur_color", "BYTE_COLOR", "CORNER")
    loops = np.zeros(len(me.loops), int)
    me.loops.foreach_get("vertex_index", loops)
    rgba = np.concatenate([cols, np.ones((len(cols), 1))], 1)[loops]
    attr.data.foreach_set("color", rgba.ravel())
    me.color_attributes.active_color = attr
    me.color_attributes.render_color_index = me.color_attributes.active_color_index

    me.materials.append(skin_from_attr(f"skin_{member['id']}"))
    me.materials.append(furry_material(f"fur_{member['id']}", member["color"]))
    dens, leng = covered(member, gl, anchors, frames, fur_eff)
    # Wherever an accessory touches the body, the pile is pressed down under it.
    d_acc = accessory_distance(placements, gl)
    if d_acc is not None:
        dens *= np.clip((d_acc - 0.004) / 0.03, 0, 1)
        leng *= np.clip((d_acc - 0.01) / (fur_eff * 1.6), 0.2, 1)
    B.set_group(body, "density", dens)
    B.set_group(body, "length", leng)
    q = fur_quality
    if os.environ.get("NOFUR"):
        me.materials[0] = me.materials[1]
    else:
      B.fur(
        body, 1, length=fur, count=int(26000 * q), children=int(50 * q), root=0.0022, tip=0.0004, clump=0.05,
        rough=0.014 * fur / 0.034, child_radius=0.025, spread=0.7, frizz=1.2, density_group="density", length_group="length", seed=seed,
      )

    for pl in placements:
        me_p = part_mesh(pl["part"])
        ob = bpy.data.objects.new(f"{member['id']}:{pl['part']}", me_p)
        coll.objects.link(ob)
        ob.matrix_world = bl_matrix(pl["M"])
        ob.parent = root
        ob.data = me_p
        m = material(pl["material"], pl.get("color"), member["color"])
        ob.material_slots and None
        if len(ob.data.materials) == 0:
            ob.data.materials.append(m)
        ob.material_slots[0].link = "OBJECT"
        ob.material_slots[0].material = m
        if pl["material"] in ("pom",) or (pl["part"] == "antenna.ball"):
            fuzz(ob, m, pl.get("color") or "#ffffff")

    st = float(member.get("stretch", 0.0))
    sy = 1 + 0.16 * st
    sxz = 1 / math.sqrt(sy)
    root.scale = (sxz, sxz, sy)
    root.rotation_euler = (0, math.radians(roll_deg), math.radians(yaw_deg))
    root.location = location
    return root, dict(placements=placements, frames=frames, anchors=anchors, points=p, fur=fur, fur_eff=fur_eff)


def fuzz(ob, mat, color):
    """A felted fuzz on small soft parts (pompoms, felt balls)."""
    fm = B.fur_material(f"fuzz{color}", color)
    ob.data = ob.data.copy()
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    ob.data.materials.append(fm)
    ob.material_slots[0].link = "DATA"
    k = sum(ob.matrix_world.to_scale()) / 3 or 1.0
    B.fur(ob, 1, length=0.012 / k, count=3000, children=30, root=0.0016, tip=0.0003, clump=0.05, rough=0.006 / k, child_radius=0.01 / k, spread=0.9, frizz=1.2)
