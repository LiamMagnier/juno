"""
A tiny image montage with Blender's image API (no PIL needed).

  Blender --background --factory-startup --python flock_montage.py -- <out.png> <cols> <bg hex> <cell px> img ...

Transparent images are composited over bg; each image is fitted into a square cell.
"""

import sys

import bpy
import numpy as np

argv = sys.argv[sys.argv.index("--") + 1 :]
out, cols, bg, cell = argv[0], int(argv[1]), argv[2], int(argv[3])
files = argv[4:]
bgc = np.array([int(bg.lstrip("#")[i : i + 2], 16) / 255 for i in (0, 2, 4)])


def load(path):
    im = bpy.data.images.load(path)
    w, h = im.size
    px = np.zeros(w * h * 4, np.float32)
    im.pixels.foreach_get(px)
    a = px.reshape(h, w, 4)
    return a


def resize(a, size):
    h, w = a.shape[:2]
    s = size / max(h, w)
    nh, nw = max(1, int(h * s)), max(1, int(w * s))
    # box filter via area sampling
    ys = (np.arange(nh) + 0.5) / s - 0.5
    xs = (np.arange(nw) + 0.5) / s - 0.5
    k = max(1, int(round(1 / s)))
    acc = np.zeros((nh, nw, 4), np.float32)
    n = 0
    for dy in range(k):
        for dx in range(k):
            yy = np.clip((ys + (dy - (k - 1) / 2)).round().astype(int), 0, h - 1)
            xx = np.clip((xs + (dx - (k - 1) / 2)).round().astype(int), 0, w - 1)
            acc += a[yy][:, xx]
            n += 1
    return acc / n


rows = (len(files) + cols - 1) // cols
H, W = rows * cell, cols * cell
canvas = np.ones((H, W, 4), np.float32)
canvas[..., :3] = bgc
for i, f in enumerate(files):
    a = resize(load(f), cell)
    h, w = a.shape[:2]
    r, c = i // cols, i % cols
    y0 = H - (r + 1) * cell + (cell - h) // 2
    x0 = c * cell + (cell - w) // 2
    al = a[..., 3:4]
    region = canvas[y0 : y0 + h, x0 : x0 + w, :3]
    canvas[y0 : y0 + h, x0 : x0 + w, :3] = a[..., :3] * al + region * (1 - al)
img = bpy.data.images.new("montage", W, H, alpha=False)
img.pixels.foreach_set(canvas.ravel())
img.filepath_raw = out
img.file_format = "PNG"
img.save()
print("WROTE", out)
