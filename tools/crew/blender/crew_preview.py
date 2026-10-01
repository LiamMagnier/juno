"""
Quick silhouette preview of every body shape with default eyes (Workbench or Eevee).

  Blender --background --factory-startup --python crew_preview.py -- <out.png> [engine]
"""

import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crew_bpy as B  # noqa: E402
import crew_shapes as CS  # noqa: E402

args = B.args_after_dashes()
out = args[0] if args else "/tmp/crew_preview.png"
engine = args[1] if len(args) > 1 else "EEVEE"

sc = B.reset_scene()
shapes = list(CS.SHAPES)
cols = 6
spacing = 1.6
eye = B.eye_material()
for i, s in enumerate(shapes):
    ob, p = B.body_object(s, 25, subsurf=1)
    col = i % cols
    row = i // cols
    ox = (col - (cols - 1) / 2) * spacing
    oz = -row * 1.7
    mat = B.principled(f"m_{s}", "#c9d6ea", rough=0.8, sheen=0.5)
    ob.data.materials.append(mat)
    ob.location = (ox, 0, oz)
    for k, e in enumerate(CS.face_layout(s)):
        # face_layout positions are relative to the unshifted mesh; shift like the body.
        e = dict(e)
        eo = B.oval_eye(f"eye_{s}_{k}", e, e["r"], mat=eye)
        eo.location.x += ox
        eo.location.z += oz
sc.render.engine = "BLENDER_EEVEE" if engine == "EEVEE" else "BLENDER_WORKBENCH"
cd = bpy.data.cameras.new("cam")
cd.type = "ORTHO"
cd.ortho_scale = cols * spacing + 0.4
cam = bpy.data.objects.new("cam", cd)
sc.collection.objects.link(cam)
sc.camera = cam
cam.location = (0, -10, -0.35)
cam.rotation_euler = (math.radians(90), 0, 0)
ld = bpy.data.lights.new("sun", "SUN")
ld.energy = 3.5
lo = bpy.data.objects.new("sun", ld)
sc.collection.objects.link(lo)
lo.rotation_euler = (math.radians(50), math.radians(-20), math.radians(-30))
w = bpy.data.worlds.new("w")
sc.world = w
w.use_nodes = True
w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.9, 0.9, 0.9, 1)
w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
sc.render.resolution_x = 1800
sc.render.resolution_y = 700
sc.render.filepath = out
bpy.ops.render.render(write_still=True)
print("WROTE", out)
