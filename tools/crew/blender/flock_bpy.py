"""
Blender side of the flocked crew: meshes, the velvet flock finish, the fuzz,
graphic (matte) eye materials, the high-key studio and cameras.

The finish is a designer-toy flocking, not an animal coat:
  - the body is a clean surface with a microfibre sheen (Principled sheen),
    a very fine grain, and a soft lift at grazing angles;
  - a SHORT, dense fuzz (fibres about 1.2% of the body height) breaks the
    silhouette only by a hair, so the outline stays crisp and iconic;
  - eyes and graphic marks are matte (no catchlight, no wet shine).
"""

from __future__ import annotations

import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import flock_sdf as S  # noqa: E402


def args_after_dashes():
    argv = sys.argv
    return argv[argv.index("--") + 1 :] if "--" in argv else []


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def srgb_to_linear(c):
    c = np.asarray(c, float)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def hex_rgb(h):
    h = h.lstrip("#")
    return np.array([int(h[i : i + 2], 16) / 255 for i in (0, 2, 4)])


def pile_lift(h):
    """Dense pile self-shadows and deepens warm yellows toward amber: lift them a touch."""
    r, g, b = hex_rgb(h)
    if r > 0.85 and g > 0.62 and b < 0.6:
        return 0.16 * min(1.0, (g - 0.62) / 0.25)
    return 0.0


def hex_lin(h, lift=0.0):
    c = hex_rgb(h)
    c = c + (1 - c) * lift
    return tuple(srgb_to_linear(c).tolist())


def mix_hex(a, b, t):
    c = hex_rgb(a) * (1 - t) + hex_rgb(b) * t
    return "#" + "".join(f"{int(round(x * 255)):02x}" for x in np.clip(c, 0, 1))


# ---------------------------------------------------------------- meshes


def mesh_object(name, V, Q, coll=None, subsurf=1, smooth=True):
    me = bpy.data.meshes.new(name)
    me.from_pydata(np.asarray(V, float).tolist(), [], [tuple(int(i) for i in q) for q in Q])
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-7)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = smooth
    ob = bpy.data.objects.new(name, me)
    (coll or bpy.context.scene.collection).objects.link(ob)
    if subsurf:
        m = ob.modifiers.new("subd", "SUBSURF")
        m.levels = 0
        m.render_levels = subsurf
    return ob


def build(name, f, h, coll=None, subsurf=1, relax=3, lo=None, hi=None):
    V, Q = S.mesh(f, h=h, lo=lo, hi=hi, relax_iters=relax)
    if len(Q) == 0:
        print("EMPTY MESH", name)
        return None
    return mesh_object(name, V, Q, coll, subsurf)


# ---------------------------------------------------------------- materials

_MAT = {}


def _bsdf(mat):
    return mat.node_tree.nodes.get("Principled BSDF")


def flock_material(name, hexc, sheen=1.0, sheen_rough=0.42, rough=0.78, grain=0.06, lift=0.0, spec=0.22, sheen_lift=None):
    """Velvet flocking: matte base, microfibre sheen tinted toward a lighter colour, a fine grain."""
    key = ("flock", name, hexc, sheen, sheen_rough, rough, grain, lift)
    if key in _MAT:
        return _MAT[key]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    b = _bsdf(mat)
    lift = lift + pile_lift(hexc)
    if sheen_lift is None:
        sheen_lift = float(os.environ.get("SHEEN_LIFT", 0.3))
    if float(hex_rgb(hexc).max()) < 0.3:
        # Dark flock (black felt, nori): a quieter, greyer sheen so it stays matte.
        sheen, sheen_lift, spec = min(sheen, 0.45), 0.28, 0.12
    b.inputs["Base Color"].default_value = (*hex_lin(hexc, lift), 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = spec
    b.inputs["Sheen Weight"].default_value = sheen
    b.inputs["Sheen Roughness"].default_value = sheen_rough
    b.inputs["Sheen Tint"].default_value = (*hex_lin(mix_hex(hexc, "#ffffff", sheen_lift)), 1.0)
    if grain > 0:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        nz = nt.nodes.new("ShaderNodeTexNoise")
        nz.inputs["Scale"].default_value = 520.0
        nz.inputs["Detail"].default_value = 2.0
        nz.inputs["Roughness"].default_value = 0.6
        nt.links.new(tc.outputs["Object"], nz.inputs["Vector"])
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = grain
        bump.inputs["Distance"].default_value = 0.002
        nt.links.new(nz.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])
    _MAT[key] = mat
    return mat


def fuzz_material(name, hexc, lift=0.0):
    """The short fibres: the body colour, a little lighter at the tip, matte with a sheen."""
    key = ("fuzz", name, hexc, lift)
    if key in _MAT:
        return _MAT[key]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    b = _bsdf(mat)
    info = nt.nodes.new("ShaderNodeHairInfo")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    lift = lift + pile_lift(hexc)
    base = hex_lin(hexc, lift)
    tip = hex_lin(mix_hex(hexc, "#ffffff", float(os.environ.get("FUZZ_TIP", 0.08))), lift)
    ramp.color_ramp.elements[0].color = (*[c * 0.92 for c in base], 1)
    ramp.color_ramp.elements[1].position = 1.0
    ramp.color_ramp.elements[1].color = (*tip, 1)
    nt.links.new(info.outputs["Intercept"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.85
    b.inputs["Specular IOR Level"].default_value = 0.15
    dark = float(hex_rgb(hexc).max()) < 0.3
    fs = float(os.environ.get("FUZZ_SHEEN", 0.65))
    b.inputs["Sheen Weight"].default_value = fs * 0.5 if dark else fs
    b.inputs["Sheen Roughness"].default_value = 0.5
    _MAT[key] = mat
    return mat


def matte_material(name, hexc, rough=0.82, spec=0.12, sheen=0.25, coat=0.0):
    """Graphic parts (eyes, frames): flat colour, no catchlight."""
    key = ("matte", name, hexc, rough, spec, sheen, coat)
    if key in _MAT:
        return _MAT[key]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    b = _bsdf(mat)
    b.inputs["Base Color"].default_value = (*hex_lin(hexc), 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = spec
    b.inputs["Sheen Weight"].default_value = sheen
    b.inputs["Sheen Roughness"].default_value = 0.5
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.35
    _MAT[key] = mat
    return mat


def assign(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)


# ---------------------------------------------------------------- fuzz


def set_group(ob, name, w):
    g = ob.vertex_groups.new(name=name)
    for i, x in enumerate(w):
        if x > 0:
            g.add([i], float(x), "REPLACE")
    return g


def vert_co(ob):
    me = ob.data
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    return co.reshape(-1, 3)


def surface_area(ob):
    return sum(p.area for p in ob.data.polygons)


def fuzz(ob, mat, length=0.009, density=None, quality=1.0, seed=1, density_group=None, width=1.0, coverage=1.0):
    """Short, fine, dense flock fibres (particle hair with interpolated children).

    Flocking is many tiny straight fibres standing up from the surface: no curl,
    no clumps. They read as a fine grain on the face and a soft fuzzy rim.
    """
    E = os.environ.get
    if density is None:
        density = float(E("FUZZ_DENSITY", 52000))
    length = float(E("FUZZ_LEN_ABS", 0)) or length
    ob.data.materials.append(mat)
    ob.modifiers.new("fuzz", "PARTICLE_SYSTEM")
    psys = ob.particle_systems[-1]
    ps = psys.settings
    ps.type = "HAIR"
    ps.use_advanced_hair = True
    area = surface_area(ob)
    # coverage: the share of the surface the density group keeps (the count is
    # spread over the weighted area only, so it scales with it).
    ps.count = max(500, int(area * density * quality * coverage))
    # Flock fibres are short and straight: two segments each are enough, and
    # halve the curve memory (renders must stay well under 10 GB).
    steps = int(E("FUZZ_STEPS", 1))
    ps.hair_step = 2
    ps.render_step = steps
    ps.display_step = steps
    ps.emit_from = "FACE"
    ps.use_even_distribution = True
    ps.distribution = "RAND"
    ps.material = len(ob.data.materials)
    ps.child_type = "INTERPOLATED"
    ps.child_percent = 2
    ps.rendered_child_count = max(4, int(float(E("FUZZ_CHILDREN", 20)) * quality))
    ps.child_radius = 0.01
    ps.child_roundness = 0.0
    ps.clump_factor = 0.0
    rough = float(E("FUZZ_ROUGH", 0.03))
    ps.roughness_1 = length * rough
    ps.roughness_1_size = 1.0
    ps.roughness_endpoint = length * rough * 1.5
    ps.roughness_end_shape = 1.0
    ps.roughness_2 = 0.0
    ps.child_length = 1.0
    ps.child_length_threshold = float(E("FUZZ_LTHRESH", 0.35))
    root = float(E("FUZZ_ROOT", 0.0002))
    ps.root_radius = root * width
    ps.tip_radius = root * 0.25 * width
    ps.radius_scale = 1.0
    ps.shape = 0.0
    ps.use_close_tip = True
    ps.normal_factor = length
    ps.factor_random = length * float(E("FUZZ_SPREAD", 0.14))
    ps.brownian_factor = 0.0
    # The hair length setter rescales the emission velocities: set it last.
    ps.hair_length = length
    psys.seed = seed
    if density_group:
        psys.vertex_group_density = density_group
    return psys


# ---------------------------------------------------------------- studio


def setup_render(scene, res_x, res_y, spp=128, transparent=True):
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
    scene.cycles.samples = spp
    scene.cycles.use_denoising = True
    try:
        scene.cycles.denoiser = "OPENIMAGEDENOISE"
    except Exception:
        pass
    # OIDN on the Metal GPU reserves ~6.5 GB of unified memory (a bare cube peaks
    # at 7.5 GB with it, 1 GB without); on the CPU it costs a second or two.
    try:
        scene.cycles.denoising_use_gpu = os.environ.get("DENOISE_GPU", "0") == "1"
    except Exception:
        pass
    scene.cycles.max_bounces = 6
    scene.cycles.diffuse_bounces = 3
    scene.cycles.glossy_bounces = 2
    scene.cycles.transparent_max_bounces = 8
    scene.render.film_transparent = transparent
    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.resolution_percentage = 100
    try:
        scene.cycles_curves.shape = "THICK"
    except Exception:
        pass
    scene.view_settings.view_transform = os.environ.get("VT", "Khronos PBR Neutral")
    scene.view_settings.look = "None"
    scene.view_settings.exposure = float(os.environ.get("EXPOSURE", 0.0))
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"


def studio(scene, strength=1.0, floor=True, rim=1.0, spread=1.0):
    """High-key soft studio: big soft key and fill, a top softbox, a gentle back light for the sheen."""
    world = bpy.data.worlds.new("world")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = (0.82, 0.83, 0.86, 1)
    bg.inputs["Strength"].default_value = 0.55 * strength

    chars = bpy.data.collections.get("characters") or bpy.data.collections.new("characters")
    if chars.name not in scene.collection.children:
        scene.collection.children.link(chars)

    def area(name, loc, size, energy, color=(1, 1, 1), target=(0, 0, 0.45), shadow=True, only_chars=False):
        ld = bpy.data.lights.new(name, "AREA")
        ld.shape = "DISK"
        ld.size = size * spread
        ld.energy = energy * spread * spread
        ld.color = color
        try:
            ld.use_shadow_jitter = False
        except Exception:
            pass
        if not shadow:
            # Fill-only lights: no shadow, so the floor catches one clean contact shadow.
            try:
                ld.use_shadow = False
            except Exception:
                pass
            try:
                ld.cycles.cast_shadow = False
            except Exception:
                pass
        ob = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(ob)
        loc = tuple(v * spread for v in loc)
        ob.location = loc
        d = Vector(target) - Vector(loc)
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        if only_chars:
            # Light the characters only: the floor never sees this light, so the
            # shadow catcher records one clean contact shadow from the key.
            ob.light_linking.receiver_collection = chars
        return ob

    K = float(os.environ.get("KEY", 1.1))
    area("key", (-2.6, -3.6, 3.6), 5.5, 520 * strength * K, (1.0, 0.975, 0.95))
    FL = float(os.environ.get("FILL", 0.7))
    area("fill", (3.4, -3.4, 1.6), 6.0, 260 * strength * FL, (0.96, 0.98, 1.0), shadow=os.environ.get("FILL_SHADOW", "1") == "1")
    area("top", (0.0, -0.6, 4.6), 4.0, 260 * strength)
    area("low", (0.0, -3.5, 0.2), 4.0, 70 * strength, only_chars=True)
    area("back_l", (-2.6, 3.0, 1.9), 3.5, 160 * strength * rim, only_chars=True)
    area("back_r", (2.6, 3.0, 1.9), 3.5, 160 * strength * rim, only_chars=True)
    if floor:
        bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
        fl = bpy.context.object
        fl.name = "floor"
        fl.is_shadow_catcher = True
        fl.visible_glossy = False


def camera(scene, target, dist, lens=85, elev=6, yaw=0, ortho=None, shift=(0, 0)):
    cd = bpy.data.cameras.new("cam")
    cd.lens = lens
    cd.sensor_width = 36
    cd.shift_x, cd.shift_y = shift
    if ortho:
        cd.type = "ORTHO"
        cd.ortho_scale = ortho
    cam = bpy.data.objects.new("cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    e = math.radians(elev)
    a = math.radians(yaw)
    t = Vector(target)
    cam.location = t + Vector((math.sin(a) * math.cos(e) * dist, -math.cos(a) * math.cos(e) * dist, math.sin(e) * dist))
    d = t - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    return cam


def fit_dist(extent, lens=85, fill=0.8, sensor=36):
    fov = 2 * math.atan(sensor / 2 / lens)
    return extent / fill / (2 * math.tan(fov / 2))
