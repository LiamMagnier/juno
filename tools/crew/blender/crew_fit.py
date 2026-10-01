"""
Fitting accessories and features onto a body (pure numpy, glTF space).

fit(shape, cfg, fur) -> list of placements {part, matrix (4x4), material, color}
for the eyes, the features and the accessories. The live renderer mirrors
these rules in fit.ts with the manifest's numbers; keep the two in step.
"""

from __future__ import annotations

import math
import numpy as np

import crew_shapes as CS


def basis(z, up=(0, 1, 0)):
    """Columns x, y, z with z along `z` and y as close to `up` as possible."""
    z = np.asarray(z, float)
    z = z / np.linalg.norm(z)
    up = np.asarray(up, float)
    y = up - (up @ z) * z
    if np.linalg.norm(y) < 1e-6:
        y = np.array([0, 0, -1.0]) - (np.array([0, 0, -1.0]) @ z) * z
    y /= np.linalg.norm(y)
    x = np.cross(y, z)
    return np.stack([x, y, z], 1)


def basis_y(yv, fwd=(0, 0, 1)):
    """Columns x, y, z with y along `yv` and z as close to `fwd` as possible."""
    yv = np.asarray(yv, float)
    yv = yv / np.linalg.norm(yv)
    f = np.asarray(fwd, float)
    z = f - (f @ yv) * yv
    if np.linalg.norm(z) < 1e-6:
        z = np.array([0, 0, 1.0])
    z /= np.linalg.norm(z)
    x = np.cross(yv, z)
    return np.stack([x, yv, z], 1)


def mat(R=None, t=(0, 0, 0), s=(1, 1, 1)):
    M = np.eye(4)
    R = np.eye(3) if R is None else np.asarray(R, float)
    M[:3, :3] = R @ np.diag(np.asarray(s, float) if np.ndim(s) else [s, s, s])
    M[:3, 3] = t
    return M


def rz(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def rx(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def ry(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


EYE_SHAPE = {
    # style: (x scale, y scale, depth) relative to the eye radius
    "oval": (0.74, 1.0, 0.5),
    "button": (0.9, 0.9, 0.5),
    "bead": (0.6, 0.6, 0.55),
    "sleepy": (0.92, 0.92, 0.45),
    "wide": (1.0, 1.04, 0.55),
    "googly": (1.12, 1.12, 0.62),
    "stitched": (0.72, 0.96, 0.16),
}


def face_normal(e):
    n = np.asarray(e["n"], float)
    v = n * 0.55 + np.array([0, 0, 1.0]) * 0.45
    return v / np.linalg.norm(v)


def eyes_fit(shape, cfg, fur, eye_scale=1.0):
    eyes = CS.face_layout(shape, cfg.get("eyes", {}))
    style = cfg.get("eyes", {}).get("style", "oval")
    sx, sy, sd = EYE_SHAPE[style]
    out = []
    frames = []
    for i, e in enumerate(eyes):
        r = e["r"] * eye_scale
        n = face_normal(e)
        R = basis(n)
        # The eye sits on the pile: pushed out of the skin by part of the fur length.
        c = e["p"] + e["n"] * (fur * 0.42)
        frames.append(dict(c=c, n=n, R=R, r=r, side=-1 if i == 0 else 1))
        if style in ("oval", "button", "bead"):
            out.append(dict(part="eye.dome", M=mat(R, c, (r * sx, r * sy, r * sd)), material="eye"))
        elif style == "sleepy":
            out.append(dict(part="eye.closed", M=mat(R, c + n * r * 0.1, (r * 0.85, r * 0.85, r * 0.85)), material="eye"))
        elif style == "stitched":
            out.append(dict(part="eye.dome", M=mat(R, c, (r * sx, r * sy, r * sd)), material="thread"))
            out.append(dict(part="eye.stitch_hi", M=mat(R, c, (r * sx, r * sy, r * sd)), material="thread_hi"))
        elif style in ("wide", "googly"):
            out.append(dict(part="eye.white", M=mat(R, c, (r * sx, r * sy, r * sd)), material="eye_white"))
            pr = 0.62 if style == "wide" else 0.56
            pc = c + R @ np.array([0.0, -0.12 * r if style == "googly" else 0.0, r * sd * 0.98])
            out.append(dict(part="eye.pupil", M=mat(R, pc, (r * pr, r * pr, r * 0.2)), material="eye"))
            if style == "googly":
                out.append(dict(part="eye.cover", M=mat(R, c, (r * sx * 1.02, r * sy * 1.02, r * sd * 1.25)), material="glass"))
    return out, frames


def accessory_fit(shape, acc_id, color, fur, frames, anchors):
    a = anchors
    H = a["height"]
    pad = fur * 0.55
    out = []

    def P(part, M, material):
        out.append(dict(part=part, M=M, material=material, color=color))

    if acc_id in ("cap", "beanie", "bucket"):
        cr = a["crown"]
        r = max(cr["r"], 0.34) + fur * 0.85
        rzz = max(cr["rz"], 0.3) + fur * 0.85
        ravg = 0.5 * (r + rzz)
        B = np.array([0.0, cr["capY"], cr["cz"]])
        tilt = rz(-0.1) @ rx(-0.05)
        parts = {"cap": ["cap.crown", "cap.button", "cap.brim"], "beanie": ["beanie.dome", "beanie.cuff", "beanie.pom"], "bucket": ["bucket.crown", "bucket.brim", "bucket.band"]}[acc_id]
        mats = {
            "cap.crown": "acc", "cap.button": "acc", "cap.brim": "acc_dark",
            "beanie.dome": "acc", "beanie.cuff": "knit", "beanie.pom": "pom",
            "bucket.crown": "canvas", "bucket.brim": "canvas", "bucket.band": "acc_dark",
        }
        for part in parts:
            P(part, mat(tilt, B, (r, ravg * (0.9 if acc_id == "beanie" else 1.0), rzz)), mats[part])
    elif acc_id in ("sprout", "antenna"):
        cr = a["crown"]
        R = basis_y(cr["n"])
        c = np.asarray(cr["p"]) + np.asarray(cr["n"]) * fur * 0.45
        s = 2.0 if acc_id == "sprout" else 1.2
        for part, m in (("sprout.stem", "stem"), ("sprout.leaves", "leaf")) if acc_id == "sprout" else (("antenna.stem", "stem_dark"), ("antenna.ball", "acc")):
            P(part, mat(R, c, s), m)
    elif acc_id == "flower":
        pn = a["pin"]
        R = basis_y(pn["n"], (0, 1, 0.3))
        c = np.asarray(pn["p"]) + np.asarray(pn["n"]) * fur * 0.8
        P("flower.petals", mat(R, c, 2.3), "petal")
        P("flower.centre", mat(R, c, 2.3), "acc")
    elif acc_id == "bow":
        pn = a["pin"]
        n = np.asarray(pn["n"], float)
        R = basis(n * 0.6 + np.array([0, 0, 1.0]) * 0.4) @ rz(-0.35)
        c = np.asarray(pn["p"]) + n * fur * 0.75
        P("bow.ribbon", mat(R, c, 1.9), "velvet")
        P("bow.knot", mat(R, c, 1.9), "velvet")
    elif acc_id in ("round", "square", "shades", "monocle"):
        if len(frames) < 2:
            return out
        k = 1.85 if acc_id in ("round", "monocle") else 1.72
        nf = frames[0]["n"] + frames[1]["n"]
        nf = nf / np.linalg.norm(nf)
        R = basis(nf)
        cs = []
        for fr in frames:
            depth = fr["r"] * 0.55
            cs.append(fr["c"] + nf * (depth + 0.012 + fur * 0.25))
        s = max(fr["r"] for fr in frames) * k
        rim = "eyewear.rim_round" if acc_id in ("round", "monocle") else "eyewear.rim_square"
        lens = {"round": "eyewear.lens_round", "monocle": "eyewear.lens_round", "square": "eyewear.lens_square", "shades": "eyewear.lens_shade"}[acc_id]
        rim_mat = "metal" if acc_id in ("round", "monocle") else "acetate"
        lens_mat = "shade" if acc_id == "shades" else "glass"
        which = [1] if acc_id == "monocle" else [0, 1]
        for i in which:
            P(rim, mat(R, cs[i], s), rim_mat)
            P(lens, mat(R, cs[i], s), lens_mat)
        if acc_id == "monocle":
            P("eyewear.chain", mat(R, cs[1], s), "metal")
        else:
            x = R[:, 0]
            a0 = cs[0] + x * s * (1.0 if acc_id == "round" else 1.06)
            a1 = cs[1] - x * s * (1.0 if acc_id == "round" else 1.06)
            L = float(np.linalg.norm(a1 - a0))
            bridge = "eyewear.bridge" if acc_id == "round" else "eyewear.bridge_thick"
            P(bridge, mat(R, a0, (L, s * 0.9, s * 0.9)), rim_mat)
            ear_z = a["ears"][0]["p"][2]
            for i, sgn in ((0, -1), (1, 1)):
                o = cs[i] + x * sgn * s * (1.0 if acc_id == "round" else 1.08)
                L = max(0.05, float(o[2] - ear_z))
                P("eyewear.temple", mat(R, o, (s, s, L)), rim_mat)
    elif acc_id in ("headphones", "headband"):
        e0, e1 = a["ears"]
        cr = a["crown"]
        ex = abs(e1["p"][0]) + fur * 1.1
        ey = e1["p"][1]
        cz = e1["p"][2] + (0.08 if acc_id == "headband" else 0.05)
        top = (a.get("top", cr["p"][1]) if acc_id == "headphones" else cr["p"][1]) + fur * (1.0 if acc_id == "headphones" else 0.8)
        ry_ = top - ey
        if acc_id == "headphones":
            cup = 0.23
            P("headphones.arc", mat(None, (0, ey, cz), (ex + 0.09, ry_ + 0.03, 1.8)), "acc_dark")
            for e, side in ((e0, -1), (e1, 1)):
                Rr = ry(0 if side > 0 else math.pi)
                c = np.array([side * (abs(e["p"][0]) + fur * 0.9 + cup * 0.32), e["p"][1], e["p"][2] + 0.05])
                P("headphones.cup", mat(Rr, c, cup), "acc")
                P("headphones.pad", mat(Rr, c, cup), "acc_dark")
        else:
            ex_h = abs(e1["p"][0]) + fur * 0.8
            ry_h = cr["p"][1] + fur * 0.85 - ey
            Rb = rx(0.42)
            P("headband.band", mat(Rb, (0, ey, e1["p"][2]), (ex_h, ry_h, 0.8)), "velvet")
            kp = Rb @ np.array([math.cos(1.0) * ex_h, math.sin(1.0) * ry_h, 0.0]) + np.array([0, ey, e1["p"][2] + 0.02])
            P("headband.knot", mat(rz(-0.6), kp, 0.7), "velvet")
    elif acc_id in ("earbuds", "hoops"):
        for e, side in ((a["ears"][0], -1), (a["ears"][1], 1)):
            Rr = ry(0 if side > 0 else math.pi)
            c = np.array([side * (abs(e["p"][0]) + fur * 0.95 + 0.03), e["p"][1] - (0.02 if acc_id == "earbuds" else 0.04), e["p"][2] + 0.06])
            if acc_id == "earbuds":
                P("earbuds.bud", mat(Rr, c, 0.15), "vinyl_white")
            else:
                P("hoops.ring", mat(Rr, c, 0.1), "metal")
    elif acc_id in ("scarf", "bandana"):
        nk = a["neck"]
        rxx = nk["rx"] + fur * 0.8
        rzz = nk["rz"] + fur * 0.8
        rr = 0.5 * (rxx + rzz)
        c = (0, nk["y"], nk["cz"])
        if acc_id == "scarf":
            P("scarf.ring", mat(None, c, (rxx, rr, rzz)), "knit")
            P("scarf.tail", mat(None, c, (rxx, rr, rzz)), "knit")
        else:
            P("bandana.cloth", mat(None, (0, nk["y"] + 0.04, nk["cz"]), (rxx, rr * 0.8, rzz)), "canvas")
            P("bandana.band", mat(None, (0, nk["y"] + 0.04, nk["cz"]), (rxx, rr * 0.8, rzz)), "canvas")
    elif acc_id == "bow_neck":
        nk = a["neck"]
        c = np.array([0, nk["y"] + 0.02, nk["cz"] + nk["rz"] + fur * 0.85])
        P("bow.ribbon", mat(rx(-0.2), c, 1.7), "velvet")
        P("bow.knot", mat(rx(-0.2), c, 1.7), "velvet")
    return out


def fit(shape, cfg, fur=0.034, eye_scale=1.0):
    anchors = CS.anchors(shape)
    if shape == "lop":
        anchors["neck"]["rx"] = min(anchors["neck"]["rx"], 0.5)
    eye_parts, frames = eyes_fit(shape, cfg, fur, eye_scale)
    out = list(eye_parts)
    for a in cfg.get("accessories", []):
        aid = a["id"] if isinstance(a, dict) else a
        col = a.get("color") if isinstance(a, dict) else None
        out.extend(accessory_fit(shape, aid, col, fur, frames, anchors))
    return out, frames, anchors
