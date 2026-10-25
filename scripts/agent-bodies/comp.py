import sys, colorsys, numpy as np
from PIL import Image
TONES = {"coral": (15, 62, 64), "juniper": (152, 36, 56), "teal": (184, 46, 54), "violet": (249, 64, 72), "amber": (39, 80, 62), "sage": (105, 24, 60)}
def rgb(h, s, l): return np.array(colorsys.hls_to_rgb(h/360, l/100, s/100))
def comp(shape, tone, bg=(250,250,250)):
    sh = np.asarray(Image.open(f"out/{shape}-shade.png").convert("RGBA")).astype(float)/255
    sp = np.asarray(Image.open(f"out/{shape}-spec.png").convert("RGBA")).astype(float)/255
    col = rgb(*TONES[tone])
    body = sh[..., :3] * col
    spec = sp[..., :3] * sp[..., 3:4]
    body = 1 - (1 - body) * (1 - spec)
    a = sh[..., 3:4]
    out = body * a + np.array(bg)/255 * (1 - a)
    return Image.fromarray((out*255).clip(0,255).astype(np.uint8))
shapes = sys.argv[1].split(","); tones = list(TONES)
W = 256
sheet = Image.new("RGB", (W*len(shapes), W), (250,250,250))
for i, s in enumerate(shapes):
    sheet.paste(comp(s, tones[i % 6]).resize((W, W), Image.LANCZOS), (i*W, 0))
sheet.save("preview.png")
