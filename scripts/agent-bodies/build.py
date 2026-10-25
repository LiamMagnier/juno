"""Agent bodies in 3D (Blender): an inflated clay height field built from each
shape's exact 2D silhouette, rendered front-orthographic so it registers with
the 64-unit face grid the eyes are drawn on. Two passes per shape:
  shade  - diffuse only, white clay: the browser multiplies the agent's tone by it
  spec   - specular/coat highlights on black: the browser screens it on top
"""
import sys, math
import numpy as np
from PIL import Image
from scipy import ndimage
import bpy

SHAPES = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else ["orb"]
N = 420            # mesh grid resolution
RES = 512          # render size
R_EDGE = 9.0       # edge rounding radius (grid units of 64)
DOME = 3.5         # extra crown height

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 64
    sc.cycles.use_denoising = True
    sc.render.resolution_x = sc.render.resolution_y = RES
    sc.render.film_transparent = True
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    world = bpy.data.worlds.new("w"); sc.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (1, 1, 1, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.16
    return sc

def params(shape):
    return (1.1, 0.4, 2.0) if shape.startswith("mark-") else (R_EDGE, DOME, 6.0)

def heightfield(shape):
    r_edge, dome, blur = params(shape)
    m = np.asarray(Image.open(f"mask-{shape}.png").convert("RGBA"))[:, :, 3].astype(np.float32) / 255.0
    inside = m > 0.5
    d = ndimage.distance_transform_edt(inside) * (64.0 / m.shape[0])
    t = np.clip(d / r_edge, 0, 1)
    h = r_edge * np.sqrt(1 - (1 - t) ** 2)
    # The crown is a blurred copy of the silhouette, not a distance field: a
    # distance field ridges along the medial axis (a square becomes a pyramid).
    soft = ndimage.gaussian_filter(inside.astype(np.float32), sigma=m.shape[0] * (0.02 if shape.startswith("mark-") else 0.16))
    soft = (soft - soft[inside].min()) / max(soft.max() - soft[inside].min(), 1e-3)
    h += dome * np.clip(soft, 0, 1)
    h = ndimage.gaussian_filter(h * inside, sigma=blur)
    return m, h

def mesh(shape, h):
    H = h.shape[0]
    xs = np.linspace(0, 64, N)
    coords = np.linspace(0, H - 1, N)
    cy, cx = np.meshgrid(coords, coords, indexing="ij")
    sub = ndimage.map_coordinates(h, [cy, cx], order=3, mode="nearest")   # rows = image y (down)
    gx, gy = np.meshgrid(xs, xs)
    verts = np.stack([gx, 64 - gy, sub], -1).reshape(-1, 3)
    faces = []
    for r in range(N - 1):
        base = r * N
        for c in range(N - 1):
            a = base + c
            faces.append((a, a + N, a + N + 1, a + 1))
    me = bpy.data.meshes.new(shape)
    me.from_pydata(verts.tolist(), [], faces)
    uv = me.uv_layers.new()
    uvs = np.stack([gx / 64, 1 - gy / 64], -1).reshape(-1, 2)
    loop_uv = np.array([uvs[l.vertex_index] for l in me.loops]).reshape(-1)
    uv.data.foreach_set("uv", loop_uv)
    me.shade_smooth() if hasattr(me, "shade_smooth") else None
    for p in me.polygons: p.use_smooth = True
    ob = bpy.data.objects.new(shape, me)
    bpy.context.scene.collection.objects.link(ob)
    sub = ob.modifiers.new("smooth", "SUBSURF"); sub.levels = 1; sub.render_levels = 1
    return ob

def material(kind, maskimg):
    mat = bpy.data.materials.new(kind); mat.use_nodes = True
    nt = mat.node_tree; n = nt.nodes; l = nt.links
    bsdf = n["Principled BSDF"]
    if kind == "shade":
        bsdf.inputs["Base Color"].default_value = (1, 1, 1, 1)
        bsdf.inputs["Roughness"].default_value = 1.0
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    else:
        bsdf.inputs["Base Color"].default_value = (0, 0, 0, 1)
        bsdf.inputs["Roughness"].default_value = 0.42
        bsdf.inputs["Specular IOR Level"].default_value = 0.45
        bsdf.inputs["Coat Weight"].default_value = 0.25
        bsdf.inputs["Coat Roughness"].default_value = 0.2
    tex = n.new("ShaderNodeTexImage"); tex.image = maskimg
    tex.image.colorspace_settings.name = "Non-Color"
    mix = n.new("ShaderNodeMixShader"); tr = n.new("ShaderNodeBsdfTransparent")
    out = n["Material Output"]
    l.new(tex.outputs["Alpha"], mix.inputs[0])
    l.new(tr.outputs[0], mix.inputs[1]); l.new(bsdf.outputs[0], mix.inputs[2])
    l.new(mix.outputs[0], out.inputs[0])
    return mat

def lights():
    def area(name, loc, rot, size, power):
        d = bpy.data.lights.new(name, "AREA"); d.size = size; d.energy = power
        o = bpy.data.objects.new(name, d); o.location = loc; o.rotation_euler = rot
        bpy.context.scene.collection.objects.link(o)
    # key: top-left, in front; fill: right, low; top: a soft skylight
    area("key", (-10, 90, 70), (math.radians(-45), math.radians(-28), 0), 70, 300000)
    area("fill", (90, 10, 60), (math.radians(30), math.radians(45), 0), 60, 90000)
    area("top", (32, 80, 30), (math.radians(-70), 0, 0), 40, 60000)

def camera():
    cd = bpy.data.cameras.new("cam"); cd.type = "ORTHO"; cd.ortho_scale = 64
    co = bpy.data.objects.new("cam", cd); co.location = (32, 32, 120)
    bpy.context.scene.collection.objects.link(co); bpy.context.scene.camera = co

for shape in SHAPES:
    sc = reset()
    m, h = heightfield(shape)
    ob = mesh(shape, h)
    img = bpy.data.images.load(bpy.path.abspath(f"//mask-{shape}.png") if False else __import__("os").path.abspath(f"mask-{shape}.png"))
    lights(); camera()
    for kind in ("shade", "spec"):
        ob.data.materials.clear(); ob.data.materials.append(material(kind, img))
        sc.render.filepath = __import__("os").path.abspath(f"out/{shape}-{kind}.png")
        bpy.ops.render.render(write_still=True)
    print("done", shape, flush=True)
