"""
Export the crew kit for the live renderers.

  Blender --background --factory-startup --python crew_export.py -- <repo_root>

Writes:
  public/crew/models/crew-bodies.glb   every body shape at two levels of detail. All shapes
                                       share one topology, so each LOD is ONE mesh whose
                                       morph targets are the other shapes (the editor morphs
                                       between them; the renderer bakes each shape once).
                                       Per-shape ambient occlusion rides along as custom
                                       vertex attributes (_ao_<shape>).
  public/crew/models/crew-parts.glb    the eyes, features and accessory parts, each a node
                                       in its canonical frame (extras: material, anchor).
  public/crew/models/crew-kit.usdc     the same bodies and parts for RealityKit (Reality
                                       Composer Pro / usdzconvert make the .usdz).
  public/crew/textures/fur-strands.png the tileable strand field the shell fur samples.
  public/crew/manifest.json            shapes (bounds, face rules, anchors, outline),
                                       accessories (slot, parts, materials), eye styles.
"""

import json
import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import crew_bpy as B  # noqa: E402
import crew_parts as P  # noqa: E402
import crew_shapes as CS  # noqa: E402

args = B.args_after_dashes()
ROOT = args[0] if args else os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
OUT = os.path.join(ROOT, "public", "crew")
os.makedirs(os.path.join(OUT, "models"), exist_ok=True)
os.makedirs(os.path.join(OUT, "textures"), exist_ok=True)

SHAPES = list(CS.SHAPES)
LODS = {"lod0": 25, "lod1": 12}

B.reset_scene()
sc = bpy.context.scene


def r4(x):
    return CS.jsonable(x)


# ---------------------------------------------------------------- bodies

built = {}
for lod, n in LODS.items():
    for s in SHAPES:
        p, nrm, quads, uvs = CS.build(s, n, 36 if lod == "lod0" else 24)
        ao = CS.vertex_ao(s, p, nrm, samples=40 if lod == "lod0" else 24)
        fm = CS.fur_shape_mask(s, p)
        built[(lod, s)] = (p, nrm, quads, uvs, ao, fm)

body_objs = []
for lod in LODS:
    base_shape = SHAPES[0]
    p0, n0, quads, uvs = built[(lod, base_shape)][:4]
    ob = B.mesh_from_arrays(f"body.{lod}", p0, quads, uvs, n0)
    me = ob.data
    # Per-shape AO as custom point attributes (glTF custom attributes start with "_").
    for s in SHAPES:
        ao = built[(lod, s)][4]
        a = me.attributes.new(f"_ao_{s}", "FLOAT", "POINT")
        a.data.foreach_set("value", ao.astype(np.float32))
        fm = me.attributes.new(f"_fur_{s}", "FLOAT", "POINT")
        fm.data.foreach_set("value", built[(lod, s)][5].astype(np.float32))
    # Shapes as shape keys (the first is the basis).
    ob.shape_key_add(name=base_shape, from_mix=False)
    for s in SHAPES[1:]:
        k = ob.shape_key_add(name=s, from_mix=False)
        pb = CS.to_blender(built[(lod, s)][0])
        k.data.foreach_set("co", pb.astype(np.float32).ravel())
    ob["kit"] = "body"
    ob["lod"] = lod
    ob["shapes"] = ",".join(SHAPES)
    body_objs.append(ob)

# Anchor empties per body shape (crown, ears, neck, pin): the same numbers as the manifest,
# as nodes, for tools that place accessories by hierarchy (Reality Composer Pro, Blender).
anchor_objs = []
for s in SHAPES:
    an = CS.anchors(s)
    if s == "lop":
        an["neck"]["rx"] = min(an["neck"]["rx"], 0.5)
    pts = {
        "crown": (an["crown"]["p"], an["crown"]["n"]),
        "ear_l": (an["ears"][0]["p"], an["ears"][0]["n"]),
        "ear_r": (an["ears"][1]["p"], an["ears"][1]["n"]),
        "pin": (an["pin"]["p"], an["pin"]["n"]),
        "neck": ((0.0, an["neck"]["y"], an["neck"]["cz"]), (0.0, 1.0, 0.0)),
    }
    for k, (p, n) in pts.items():
        em = bpy.data.objects.new(f"anchor.{s}.{k}", None)
        sc.collection.objects.link(em)
        em.location = CS.to_blender(np.asarray(p, float)).tolist()
        nb = Vector(CS.to_blender(np.asarray(n, float)).tolist())
        em.rotation_euler = nb.to_track_quat("Z", "Y").to_euler()
        em["shape"] = s
        em["anchor"] = k
        if k == "neck":
            em.scale = (an["neck"]["rx"], an["neck"]["rz"], 1.0)
        if k == "crown":
            em["r"] = float(an["crown"]["r"])
            em["rz"] = float(an["crown"]["rz"])
            em["capY"] = float(an["crown"]["capY"])
        anchor_objs.append(em)

for o in bpy.data.objects:
    o.select_set(o in body_objs or o in anchor_objs)
bpy.context.view_layer.objects.active = body_objs[0]
bodies_path = os.path.join(OUT, "models", "crew-bodies.glb")
bpy.ops.export_scene.gltf(
    filepath=bodies_path,
    export_format="GLB",
    use_selection=True,
    export_apply=False,
    export_texcoords=True,
    export_normals=True,
    export_tangents=False,
    export_materials="NONE",
    export_attributes=True,
    export_morph=True,
    export_morph_normal=True,
    export_extras=True,
    export_yup=True,
    export_draco_mesh_compression_enable=False,
)
print("WROTE", bodies_path, os.path.getsize(bodies_path))

# ---------------------------------------------------------------- parts

part_objs = []
allp = P.all_parts()
eyes = P.eye_parts()
meta = {}
for name, (geo, mat_key, anchor) in list(allp.items()) + [(k, (g, "eye", "eye")) for k, g in eyes.items()]:
    v, f = geo.arrays()
    me = bpy.data.meshes.new(name)
    me.from_pydata(CS.to_blender(v).tolist(), [], [list(map(int, x)) for x in f])
    me.validate()
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    sc.collection.objects.link(ob)
    ob["material"] = mat_key
    ob["anchor"] = anchor
    ob["part"] = name
    part_objs.append(ob)
    meta[name] = dict(material=mat_key, anchor=anchor, verts=len(v), tris=sum(len(x) - 2 for x in f))

for o in bpy.data.objects:
    o.select_set(o in part_objs)
parts_path = os.path.join(OUT, "models", "crew-parts.glb")
bpy.ops.export_scene.gltf(
    filepath=parts_path,
    export_format="GLB",
    use_selection=True,
    export_texcoords=False,
    export_normals=True,
    export_materials="NONE",
    export_extras=True,
    export_yup=True,
    export_draco_mesh_compression_enable=False,
)
print("WROTE", parts_path, os.path.getsize(parts_path))

# ---------------------------------------------------------------- USD (RealityKit)

for o in bpy.data.objects:
    o.select_set(o.name.startswith("body.lod0") or o in part_objs or o.name.startswith("anchor."))
usd_path = os.path.join(OUT, "models", "crew-kit.usdc")
try:
    bpy.ops.wm.usd_export(filepath=usd_path, selected_objects_only=True, export_materials=False, export_shapekeys=True, export_uvmaps=True, export_normals=True)
    print("WROTE", usd_path, os.path.getsize(usd_path))
except Exception as e:  # pragma: no cover
    print("USD export failed", e)

# ---------------------------------------------------------------- textures


def strand_texture(size=256, cells=48, seed=11):
    """Tileable strand field: R strand height, G distance to the strand centre, B per-strand random, A clump id."""
    rng = np.random.default_rng(seed)
    cx = (np.arange(cells)[None, :] + 0.15 + 0.7 * rng.random((cells, cells))) / cells
    cy = (np.arange(cells)[:, None] + 0.15 + 0.7 * rng.random((cells, cells))) / cells
    h = 0.5 + 0.5 * rng.random((cells, cells)) ** 0.7
    rnd = rng.random((cells, cells))
    # Clumps: a coarser cell id so neighbouring strands share a lean.
    clump = rng.random((cells // 6 + 1, cells // 6 + 1))
    u = (np.arange(size) + 0.5) / size
    U, V = np.meshgrid(u, u)
    ci = np.floor(U * cells).astype(int)
    cj = np.floor(V * cells).astype(int)
    best = np.full(U.shape, 9.0)
    bh = np.zeros(U.shape)
    br = np.zeros(U.shape)
    bc = np.zeros(U.shape)
    for dj in (-1, 0, 1):
        for di in (-1, 0, 1):
            ii = (ci + di) % cells
            jj = (cj + dj) % cells
            dx = cx[jj, ii] - U
            dy = cy[jj, ii] - V
            dx -= np.round(dx)
            dy -= np.round(dy)
            d = np.sqrt(dx * dx + dy * dy)
            m = d < best
            best = np.where(m, d, best)
            bh = np.where(m, h[jj, ii], bh)
            br = np.where(m, rnd[jj, ii], br)
            bc = np.where(m, clump[jj // 6, ii // 6], bc)
    g = np.clip(best / (0.75 / cells), 0, 1)
    # Alpha stays opaque (browsers premultiply PNG alpha, which would quantise RGB).
    img = np.stack([bh, g, br, np.ones_like(bc)], -1)
    return img


def save_png(path, rgba):
    hgt, wid = rgba.shape[:2]
    im = bpy.data.images.new(os.path.basename(path), wid, hgt, alpha=True, float_buffer=False)
    im.colorspace_settings.name = "Non-Color"
    im.pixels.foreach_set(np.flipud(rgba).astype(np.float32).ravel())
    im.filepath_raw = path
    im.file_format = "PNG"
    im.save()
    print("WROTE", path, os.path.getsize(path))


save_png(os.path.join(OUT, "textures", "fur-strands.png"), strand_texture())

# ---------------------------------------------------------------- manifest

ACCESSORIES = {
    "cap": dict(label="Soft cap", slot="head", fit="crown"),
    "beanie": dict(label="Beanie", slot="head", fit="crown"),
    "bucket": dict(label="Bucket hat", slot="head", fit="crown"),
    "headband": dict(label="Headband", slot="head", fit="arc"),
    "sprout": dict(label="Sprout", slot="head", fit="point"),
    "antenna": dict(label="Antenna", slot="head", fit="point"),
    "flower": dict(label="Flower pin", slot="pin", fit="pin"),
    "bow": dict(label="Bow", slot="pin", fit="pin"),
    "round": dict(label="Round glasses", slot="eyes", fit="eyes"),
    "square": dict(label="Square frames", slot="eyes", fit="eyes"),
    "shades": dict(label="Sunglasses", slot="eyes", fit="eyes"),
    "monocle": dict(label="Monocle", slot="eyes", fit="eyes"),
    "headphones": dict(label="Headphones", slot="ears", fit="ears"),
    "earbuds": dict(label="Earbuds", slot="ears", fit="ears"),
    "hoops": dict(label="Earrings", slot="ears", fit="ears"),
    "scarf": dict(label="Scarf", slot="neck", fit="ring"),
    "bandana": dict(label="Bandana", slot="neck", fit="ring"),
}
for k, a in ACCESSORIES.items():
    a["parts"] = P.ACCESSORY_PARTS[k]

shapes = {}
for s in SHAPES:
    p = built[("lod0", s)][0]
    an = CS.anchors(s)
    if s == "lop":
        an["neck"]["rx"] = min(an["neck"]["rx"], 0.5)
    shapes[s] = dict(
        label=CS.LABEL[s],
        bounds=r4(CS.bounds(p)),
        face=r4(CS.FACE[s]),
        anchors=r4(an),
        outline=r4(CS.outline(s, 72)),
        eared=s in CS.EARED,
    )

manifest = dict(
    version=1,
    units="glTF space: x across (viewer's right), y up, z toward the viewer; the body stands on y = 0, about 1 tall",
    models=dict(bodies="models/crew-bodies.glb", parts="models/crew-parts.glb", usd="models/crew-kit.usdc"),
    textures=dict(strands="textures/fur-strands.png"),
    lods=dict(lod0=dict(grid=LODS["lod0"], tris=len(built[("lod0", SHAPES[0])][2]) * 2), lod1=dict(grid=LODS["lod1"], tris=len(built[("lod1", SHAPES[0])][2]) * 2)),
    morphOrder=SHAPES,
    shapes=shapes,
    accessories=ACCESSORIES,
    parts=meta,
    fur=dict(lengthMin=0.024, lengthPerUnit=0.032, visibleScale=1.5),
    eyes={k: dict(across=v[0], up=v[1], depth=v[2]) for k, v in __import__("crew_fit").EYE_SHAPE.items()},
    palette={
        "marigold": "#efb23f", "apricot": "#f09f72", "coral": "#e4715e", "raspberry": "#c9486b", "blossom": "#eeb0c2",
        "lilac": "#b7a5e3", "iris": "#6c71d8", "cobalt": "#3d69cf", "sky": "#93c4e6", "lagoon": "#2e968d", "mint": "#a6d9c1",
        "moss": "#84a456", "oat": "#e4d7c1", "cocoa": "#8a5d47", "graphite": "#3e4045", "cloud": "#efefec",
    },
    accessoryDefaults=dict(gold="#c9a660", ink="#2c2d31", earbuds="#f6f6f4", sprout="#78b04a", petal="#fbf9f4", note="other accessories default to the body's complement (accessory-colors.ts)"),
    roster=json.load(open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "roster.json")))["members"],
)
# The numbers the live renderer needs synchronously (the flat placeholder, the fitter):
# a small generated module, so a page draws silhouettes without fetching anything.
def hw_table(s, samples=24):
    f = CS.SHAPES[s]
    top = shapes[s]["bounds"]["top"]
    return [round(CS.half_width_at(f, top * (i + 0.5) / samples), 4) for i in range(samples)]


ts_shapes = {}
for s in SHAPES:
    d = dict(shapes[s])
    d["outline"] = [[round(x, 3), round(y, 3)] for x, y in CS.outline(s, 56)]
    d["hw"] = hw_table(s)
    ts_shapes[s] = d
import hashlib

h = hashlib.sha1()
for fn in (bodies_path, parts_path, os.path.join(OUT, "textures", "fur-strands.png")):
    h.update(open(fn, "rb").read())
kit_hash = h.hexdigest()[:10]
ts = (
    "/* Generated by tools/crew/blender/crew_export.py from the Blender kit. Do not edit by hand. */\n"
    "/* eslint-disable */\n\n"
    "import type { KitAccessory, KitShape } from \"./kit-types\";\n\n"
    f"/** A hash of the kit's files: the loader appends it so a new export is never served from a stale cache. */\nexport const KIT_HASH = \"{kit_hash}\";\n\n"
    f"export const MORPH_ORDER = {json.dumps(SHAPES)} as const;\n\n"
    f"export const SHAPE_DATA: Record<(typeof MORPH_ORDER)[number], KitShape> = {json.dumps(ts_shapes, separators=(',', ':'))};\n\n"
    f"export const ACCESSORY_DATA: Record<string, KitAccessory> = {json.dumps(ACCESSORIES, separators=(',', ':'))};\n"
)
ts_path = os.path.join(ROOT, "src", "app", "dev", "design", "juno", "crew", "kit-data.ts")
open(ts_path, "w").write(ts)
print("WROTE", ts_path, len(ts))

mpath = os.path.join(OUT, "manifest.json")
json.dump(manifest, open(mpath, "w"), indent=1)
print("WROTE", mpath, os.path.getsize(mpath))
