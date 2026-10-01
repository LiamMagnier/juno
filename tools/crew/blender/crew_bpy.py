"""
Blender helpers for the crew characters (bpy). Imported by the build and render scripts.

  mesh_from_arrays     a body or part as a clean quad mesh (with UVs and smooth normals)
  body_object          one body shape, ready for fur
  eye_objects          the eyes: dark glossy domes with one soft catchlight
  fur                  plush fur (particle hair, interpolated children) for Cycles
  studio               the soft studio: lights, world, a shadow-catching floor
  camera_for           a portrait camera framed on a set of objects
"""

from __future__ import annotations

import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import crew_shapes as CS  # noqa: E402


def args_after_dashes():
    argv = sys.argv
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.unit_settings.system = "METRIC"
    return sc


def srgb_to_linear(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hex_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) / 255 for i in (0, 2, 4))


def hex_lin(h):
    return tuple(srgb_to_linear(hex_rgb(h)).tolist())


# ---------------------------------------------------------------- meshes


def mesh_from_arrays(name, verts_gltf, quads, corner_uvs=None, normals_gltf=None):
    """Build a mesh object from glTF-space arrays (converted to Blender's Z-up)."""
    v = CS.to_blender(verts_gltf)
    me = bpy.data.meshes.new(name)
    me.from_pydata(v.tolist(), [], [tuple(int(i) for i in q) for q in quads])
    me.validate()
    if corner_uvs is not None:
        uvl = me.uv_layers.new(name="UVMap")
        flat = np.asarray(corner_uvs, float).reshape(-1, 2)
        uvl.data.foreach_set("uv", flat.ravel())
    for poly in me.polygons:
        poly.use_smooth = True
    if normals_gltf is not None:
        nb = CS.to_blender(normals_gltf)
        try:
            me.normals_split_custom_set_from_vertices(nb.tolist())
        except Exception:
            pass
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def body_object(shape, n=25, subsurf=1, name=None):
    p, nrm, quads, uvs = CS.build(shape, n)
    ob = mesh_from_arrays(name or f"body_{shape}", p, quads, uvs, nrm)
    if subsurf:
        m = ob.modifiers.new("subd", "SUBSURF")
        m.levels = subsurf
        m.render_levels = subsurf
    ob["shape"] = shape
    return ob, p


# ---------------------------------------------------------------- materials


def principled(name, color_hex, rough=0.5, coat=0.0, coat_rough=0.05, sheen=0.0, sheen_tint=None, spec=0.5, sss=0.0, emission=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*hex_lin(color_hex), 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = coat_rough
    if "Sheen Weight" in bsdf.inputs:
        bsdf.inputs["Sheen Weight"].default_value = sheen
        if sheen_tint is not None:
            bsdf.inputs["Sheen Tint"].default_value = (*hex_lin(sheen_tint), 1.0)
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = spec
    if sss > 0 and "Subsurface Weight" in bsdf.inputs:
        bsdf.inputs["Subsurface Weight"].default_value = sss
        bsdf.inputs["Subsurface Radius"].default_value = (0.08, 0.04, 0.03)
        bsdf.inputs["Subsurface Scale"].default_value = 0.05
    return mat


def fur_material(name, color_hex, tip_hex=None, root_dark=0.72, rough=0.55, sheen=0.35):
    """Plush fibre: a coloured hair BSDF, darker at the root, lighter (sheen) at the tip.

    Plush (polyester pile) is not hair: it is matte with a soft, bright rim,
    and its colour stays saturated through the pile. Principled Hair with
    direct colouring gets the saturation right; a little diffuse mixed in
    keeps it from reading as glossy human hair.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    info = nt.nodes.new("ShaderNodeHairInfo")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    # Dense fur scatters light many times, which deepens and saturates its colour:
    # lift the fibre colour toward white so the pile reads as the chosen colour.
    lift = float(os.environ.get("FUR_LIFT", 0.28))
    srgb = np.array(hex_rgb(color_hex))
    base = tuple(srgb_to_linear(srgb + (1 - srgb) * lift).tolist())
    tip = hex_lin(tip_hex) if tip_hex else tuple(min(1.0, c * 1.1 + 0.03) for c in base)
    root = tuple(c * root_dark for c in base)
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (*root, 1)
    ramp.color_ramp.elements[1].position = 0.55
    ramp.color_ramp.elements[1].color = (*base, 1)
    e = ramp.color_ramp.elements.new(1.0)
    e.color = (*tip, 1)
    nt.links.new(info.outputs["Intercept"], ramp.inputs["Fac"])

    # Per-strand random variation (subtle, in value only).
    rnd = nt.nodes.new("ShaderNodeMapRange")
    rnd.inputs["To Min"].default_value = 0.88
    rnd.inputs["To Max"].default_value = 1.08
    nt.links.new(info.outputs["Random"], rnd.inputs["Value"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    nt.links.new(ramp.outputs["Color"], mul.inputs[6])
    comb = nt.nodes.new("ShaderNodeCombineColor")
    for k in ("Red", "Green", "Blue"):
        nt.links.new(rnd.outputs["Result"], comb.inputs[k])
    nt.links.new(comb.outputs["Color"], mul.inputs[7])

    hair = nt.nodes.new("ShaderNodeBsdfHairPrincipled")
    try:
        hair.parametrization = "COLOR"
    except Exception:
        pass
    nt.links.new(mul.outputs[2], hair.inputs["Color"])
    hair.inputs["Roughness"].default_value = rough
    hair.inputs["Radial Roughness"].default_value = 0.85
    hair.inputs["Coat"].default_value = 0.25
    if "IOR" in hair.inputs:
        hair.inputs["IOR"].default_value = 1.45

    diff = nt.nodes.new("ShaderNodeBsdfDiffuse")
    nt.links.new(mul.outputs[2], diff.inputs["Color"])
    diff.inputs["Roughness"].default_value = 1.0

    sh = nt.nodes.new("ShaderNodeBsdfSheen") if hasattr(bpy.types, "ShaderNodeBsdfSheen") else None
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs["Fac"].default_value = float(os.environ.get("FUR_DIFFUSE", 0.6))
    nt.links.new(hair.outputs[0], mix.inputs[1])
    nt.links.new(diff.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


def skin_material(name, color_hex, dark=0.5):
    """What shows between the fibres: the body colour, darker (the pile's shadow)."""
    base = hex_lin(color_hex)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*(c * dark for c in base), 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.1
    return mat


def eye_material():
    # A dark, slightly warm black with a clear glossy coat: one crisp catchlight, no wet smear.
    return principled("eye", "#141113", rough=0.35, coat=1.0, coat_rough=0.08, spec=0.3)


# ---------------------------------------------------------------- eyes


def oval_eye(name, frame, r, aspect=0.78, depth=0.42, mat=None, style="oval"):
    """A dark dome. frame: dict(p, n) in glTF space. r: eye half-height."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=1.0)
    ob = bpy.context.object
    ob.name = name
    for p in ob.data.polygons:
        p.use_smooth = True
    if style == "button":
        sx, sy = r * 0.92, r * 0.92
    elif style == "bead":
        sx, sy = r * 0.62, r * 0.62
    else:
        sx, sy = r * aspect, r
    sz = r * depth
    # Build the eye's frame: z along the surface normal (mostly forward), y up.
    n = Vector(CS.to_blender(frame["n"]).tolist())
    fwd = Vector((0, -1, 0))
    nz = (n * 0.55 + fwd * 0.45).normalized()
    ny = Vector((0, 0, 1)) - nz * nz.z
    ny.normalize()
    nx = ny.cross(nz).normalized()
    m = Matrix(
        (
            (nx.x * sx, ny.x * sy, nz.x * sz, 0),
            (nx.y * sx, ny.y * sy, nz.y * sz, 0),
            (nx.z * sx, ny.z * sy, nz.z * sz, 0),
            (0, 0, 0, 1),
        )
    )
    pos = Vector(CS.to_blender(frame["p"]).tolist())
    m.translation = pos
    ob.matrix_world = m
    if mat is not None:
        ob.data.materials.append(mat)
    return ob


# ---------------------------------------------------------------- fur


def vertex_weights(ob, fn):
    """Assign a vertex group from fn(glTF positions) -> weights in 0..1."""
    me = ob.data
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    gl = np.stack([co[:, 0], co[:, 2], -co[:, 1]], -1)
    w = np.clip(fn(gl), 0.0, 1.0)
    return w


def set_group(ob, name, w):
    g = ob.vertex_groups.new(name=name)
    for i, x in enumerate(w):
        g.add([i], float(x), "REPLACE")
    return g


def fur(ob, mat_index, length=0.07, count=6000, children=60, root=0.0042, tip=0.0006, clump=0.35, rough=0.012, density_group=None, length_group=None, seed=1, kink=0.0, child_radius=0.06, spread=0.12, frizz=0.4):
    m = ob.modifiers.new("fur", "PARTICLE_SYSTEM")
    psys = ob.particle_systems[-1]
    ps = psys.settings
    ps.type = "HAIR"
    ps.use_advanced_hair = True
    ps.count = count
    ps.hair_length = length
    ps.hair_step = 5
    ps.render_step = 5
    ps.display_step = 3
    ps.emit_from = "FACE"
    ps.use_even_distribution = True
    ps.distribution = "JIT"
    ps.userjit = 0
    ps.material = mat_index + 1
    ps.child_type = "INTERPOLATED"
    ps.child_percent = max(1, children // 10)
    ps.rendered_child_count = children
    ps.child_radius = child_radius
    ps.child_roundness = 0.0
    ps.clump_factor = clump
    ps.clump_shape = -0.3
    ps.roughness_1 = rough
    ps.roughness_1_size = 1.0
    ps.roughness_endpoint = rough * 0.8
    ps.roughness_end_shape = 1.0
    ps.roughness_2 = rough * frizz
    ps.roughness_2_size = 2.0
    ps.child_length = 1.0
    ps.child_length_threshold = 0.22
    if kink > 0:
        ps.kink = "CURL"
        ps.kink_amplitude = kink
        ps.kink_frequency = 2.0
    ps.root_radius = root
    ps.tip_radius = tip
    ps.radius_scale = 1.0
    ps.shape = -0.1
    ps.use_close_tip = True
    # Hairs grow along the normal, with a little randomness and a soft droop.
    ps.normal_factor = length
    ps.factor_random = length * spread
    ps.brownian_factor = 0.0
    psys.seed = seed
    if density_group:
        psys.vertex_group_density = density_group
    if length_group:
        psys.vertex_group_length = length_group
    return psys


# ---------------------------------------------------------------- studio


def studio(scene, theme="light", transparent=True, floor=True, strength=1.0):
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == "METAL"
        scene.cycles.device = "GPU"
    except Exception as e:  # pragma: no cover
        print("GPU setup failed", e)
    scene.cycles.samples = 192
    scene.cycles.use_denoising = True
    try:
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
    except Exception:
        pass
    scene.cycles.max_bounces = 8
    scene.cycles.transparent_max_bounces = 16
    scene.render.film_transparent = transparent
    try:
        scene.view_settings.view_transform = os.environ.get("VT", "Khronos PBR Neutral")
        scene.view_settings.look = os.environ.get("LOOK", "None")
    except Exception as e:
        print("view transform", e)
        scene.view_settings.view_transform = "Standard"
    scene.view_settings.exposure = 0.0
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"

    world = bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    wn = world.node_tree
    bg = wn.nodes.get("Background")
    # A soft studio dome: brighter above, a warm-neutral floor bounce.
    sky = wn.nodes.new("ShaderNodeTexGradient")
    coord = wn.nodes.new("ShaderNodeTexCoord")
    sep = wn.nodes.new("ShaderNodeSeparateXYZ")
    wn.links.new(coord.outputs["Generated"], sep.inputs[0])
    ramp = wn.nodes.new("ShaderNodeValToRGB")
    mapr = wn.nodes.new("ShaderNodeMapRange")
    mapr.inputs["From Min"].default_value = -1
    mapr.inputs["From Max"].default_value = 1
    wn.links.new(sep.outputs["Z"], mapr.inputs["Value"])
    ramp.color_ramp.elements[0].color = (0.32, 0.31, 0.3, 1)
    ramp.color_ramp.elements[1].color = (0.9, 0.92, 0.95, 1)
    wn.links.new(mapr.outputs["Result"], ramp.inputs["Fac"])
    # Use the view direction rather than generated coords for the world.
    wn.links.new(coord.outputs["Generated"], sep.inputs[0])
    wn.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.55 * strength

    def area(name, loc, size, energy, color=(1, 1, 1), shape="DISK"):
        ld = bpy.data.lights.new(name, "AREA")
        ld.shape = shape
        ld.size = size
        ld.energy = energy
        ld.color = color
        ob = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(ob)
        ob.location = loc
        d = Vector((0, 0, 0.5)) - Vector(loc)
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        return ob

    chars = bpy.data.collections.get("characters") or bpy.data.collections.new("characters")
    if chars.name not in scene.collection.children:
        scene.collection.children.link(chars)

    def only_characters(ob):
        try:
            ob.light_linking.receiver_collection = chars
        except Exception as e:
            print("light linking", e)

    warm = (1.0, 0.96, 0.92)
    cool = (0.9, 0.94, 1.0)
    K = float(os.environ.get("KEY", 1.0))
    only_characters(area("key", (-2.4, -3.0, 3.4), 4.5, 420 * strength * K, warm))
    only_characters(area("fill", (3.2, -2.6, 1.4), 5.0, 190 * strength, cool))
    only_characters(area("rim", (1.4, 3.2, 2.8), 2.5, 380 * strength, (1, 1, 1) if theme == "light" else (0.86, 0.9, 1.0)))
    only_characters(area("rim2", (-2.6, 2.4, 1.8), 2.5, 180 * strength, (1, 1, 1)))
    area("top", (0, -0.3, 4.5), 3.0, 260 * strength, (1, 1, 1))

    if floor:
        bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, 0))
        fl = bpy.context.object
        fl.name = "floor"
        fl.is_shadow_catcher = True
        fl.visible_glossy = False
    return scene


def camera_for(scene, target=(0, 0, 0.5), dist=4.2, lens=85, elev_deg=6, yaw_deg=0, height_fit=None):
    cd = bpy.data.cameras.new("cam")
    cd.lens = lens
    cam = bpy.data.objects.new("cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    e = math.radians(elev_deg)
    a = math.radians(yaw_deg)
    t = Vector(target)
    cam.location = t + Vector((math.sin(a) * math.cos(e) * dist, -math.cos(a) * math.cos(e) * dist, math.sin(e) * dist))
    d = t - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return cam
