/**
 * Textures for crew avatars, generated in code (browser only).
 *
 *   Procedural: speckle, terrazzo, marble, knit, linen, wood grain, plus the
 *   fine fibre felt wears when nothing is chosen. Each is 512 px, seamlessly
 *   tileable (so the triplanar mapping in the engine can repeat it on any
 *   form without a seam), deterministic from (id, family, seed), and carries
 *   its own colour: the family is baked in, so chips, veins and stitches get
 *   their own tones instead of a flat multiply.
 *
 *   Uploaded: `prepareUpload` validates a person's image (PNG, JPEG or WebP by
 *   type and by its first bytes, 5 MB at most), decodes it with its EXIF
 *   orientation applied, centre-crops it square, downscales it to 512 px,
 *   flattens transparency onto the family colour and re-encodes it as JPEG,
 *   which also drops every metadata field (location, camera) on the way.
 */

import { FAMILY, type AvatarColor, type ProceduralTexture } from "./avatar";
import { hashSeed, prng } from "./identity";

export const TEX_SIZE = 512;

type RGB = [number, number, number];

function hexRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const shade = (c: RGB, k: number): RGB => (k >= 0 ? mix(c, [255, 255, 255], k) : mix(c, [0, 0, 0], -k));
const css = (c: RGB, a = 1) => `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0} / ${a})`;
const lum = (c: RGB) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Periodic value noise: tiles every `period` cells, so every octave tiles the texture. */
function periodicNoise(seed: number, period: number) {
  const r = prng(seed);
  const g = new Float32Array(period * period);
  for (let i = 0; i < g.length; i++) g[i] = r();
  return (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const x0 = ((xi % period) + period) % period;
    const y0 = ((yi % period) + period) % period;
    const x1 = (x0 + 1) % period;
    const y1 = (y0 + 1) % period;
    const a = g[y0 * period + x0];
    const b = g[y0 * period + x1];
    const c = g[y1 * period + x0];
    const d = g[y1 * period + x1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

/** Fractal noise over [0, size): each octave doubles the period so the sum still tiles. */
function fbm(seed: number, base: number, octaves: number) {
  const layers = Array.from({ length: octaves }, (_, o) => periodicNoise(seed + o * 101, base << o));
  return (x: number, y: number) => {
    let s = 0;
    let amp = 0.5;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const f = (base << o) / TEX_SIZE;
      s += layers[o](x * f, y * f) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return s / norm;
  };
}

function canvas(size = TEX_SIZE): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d canvas unavailable");
  return [c, ctx];
}

/** Draw `fn` at the 9 wrap offsets so shapes crossing an edge reappear on the other side. */
function wrapped(x: number, y: number, r: number, fn: (x: number, y: number) => void) {
  for (const ox of [-TEX_SIZE, 0, TEX_SIZE]) {
    for (const oy of [-TEX_SIZE, 0, TEX_SIZE]) {
      const px = x + ox;
      const py = y + oy;
      if (px + r < 0 || py + r < 0 || px - r > TEX_SIZE || py - r > TEX_SIZE) continue;
      fn(px, py);
    }
  }
}

/** A low-frequency mottle under everything: real glazes and stone are never one flat colour. */
function mottle(ctx: CanvasRenderingContext2D, base: RGB, seed: number, amount: number, grain = 0.02) {
  const img = ctx.createImageData(TEX_SIZE, TEX_SIZE);
  const n = fbm(seed, 4, 4);
  const r = prng(seed ^ 0x9e3779b9);
  const d = img.data;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const k = (n(x, y) - 0.5) * 2 * amount + (r() - 0.5) * grain;
      const c = shade(base, k);
      const i = (y * TEX_SIZE + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function speckle(color: AvatarColor, seed: number) {
  const [c, ctx] = canvas();
  const f = FAMILY[color];
  const base = hexRgb(f.base);
  mottle(ctx, base, seed, 0.035);
  const r = prng(seed * 7 + 3);
  const dark = lum(base) < 0.35;
  const fleck: RGB = dark ? [236, 233, 226] : shade(hexRgb(f.eye), 0.12);
  const light: RGB = dark ? shade(base, -0.3) : [250, 248, 244];
  for (let i = 0; i < 2600; i++) {
    const x = r() * TEX_SIZE;
    const y = r() * TEX_SIZE;
    const rad = 0.45 + Math.pow(r(), 3) * 1.9;
    const isLight = r() < 0.18;
    const ratio = 0.7 + r() * 0.3;
    const rot = r() * Math.PI;
    ctx.fillStyle = css(isLight ? light : fleck, isLight ? 0.55 : 0.35 + r() * 0.5);
    wrapped(x, y, rad, (px, py) => {
      ctx.beginPath();
      ctx.ellipse(px, py, rad, rad * ratio, rot, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  return c;
}

function terrazzo(color: AvatarColor, seed: number) {
  const [c, ctx] = canvas();
  const f = FAMILY[color];
  const base = hexRgb(f.base);
  const dark = lum(base) < 0.35;
  mottle(ctx, shade(base, dark ? 0.02 : 0.1), seed, 0.03);
  const r = prng(seed * 13 + 5);
  const chips: RGB[] = [
    [240, 237, 231],
    [61, 62, 66],
    shade(base, -0.28),
    shade(base, 0.35),
    hexRgb(FAMILY[color === "clay" ? "sage" : color === "sage" ? "clay" : "ochre"].base),
  ];
  const weights = [0.3, 0.16, 0.26, 0.2, 0.08];
  const pickChip = () => {
    let t = r();
    for (let i = 0; i < chips.length; i++) {
      t -= weights[i];
      if (t <= 0) return chips[i];
    }
    return chips[0];
  };
  for (let i = 0; i < 300; i++) {
    const x = r() * TEX_SIZE;
    const y = r() * TEX_SIZE;
    const big = r() < 0.12;
    const rad = big ? 9 + r() * 9 : 2.2 + Math.pow(r(), 1.6) * 6.5;
    const sides = 5 + Math.floor(r() * 3);
    const rot = r() * Math.PI * 2;
    const jag = Array.from({ length: sides }, () => 0.62 + r() * 0.45);
    const col = pickChip();
    ctx.fillStyle = css(col);
    wrapped(x, y, rad * 1.2, (px, py) => {
      ctx.beginPath();
      for (let s = 0; s < sides; s++) {
        const a = rot + (s / sides) * Math.PI * 2;
        const rr = rad * jag[s];
        const qx = px + Math.cos(a) * rr;
        const qy = py + Math.sin(a) * rr;
        if (s === 0) ctx.moveTo(qx, qy);
        else ctx.lineTo(qx, qy);
      }
      ctx.closePath();
      ctx.fill();
    });
  }
  return c;
}

function marble(color: AvatarColor, seed: number) {
  const [c, ctx] = canvas();
  const f = FAMILY[color];
  const base = hexRgb(f.base);
  const dark = lum(base) < 0.35;
  const pale = dark ? base : shade(base, 0.32);
  const vein: RGB = dark ? [214, 210, 202] : shade(mix(base, [70, 72, 78], 0.55), -0.1);
  const n = fbm(seed, 3, 5);
  const m = fbm(seed + 17, 6, 3);
  const img = ctx.createImageData(TEX_SIZE, TEX_SIZE);
  const d = img.data;
  const cycles = 3;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const t = ((x + y) / TEX_SIZE) * cycles + n(x, y) * 2.6;
      const s = Math.abs(Math.sin(t * Math.PI));
      const v = Math.pow(1 - s, 9) * 0.85 + Math.pow(1 - s, 40) * 0.4;
      const cloud = (m(x, y) - 0.5) * 0.08;
      const col = mix(shade(pale, cloud), vein, Math.min(1, v));
      const i = (y * TEX_SIZE + x) * 4;
      d[i] = col[0];
      d[i + 1] = col[1];
      d[i + 2] = col[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function knit(color: AvatarColor, seed: number) {
  const [c, ctx] = canvas();
  const base = hexRgb(FAMILY[color].base);
  ctx.fillStyle = css(shade(base, -0.34));
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  const r = prng(seed * 29 + 11);
  const cell = 16;
  for (let row = 0; row < TEX_SIZE / cell; row++) {
    for (let col = 0; col < TEX_SIZE / cell; col++) {
      const cx = col * cell + cell / 2;
      const cy = row * cell + cell / 2;
      const j = (r() - 0.5) * 0.08;
      for (const side of [-1, 1]) {
        const g = ctx.createRadialGradient(cx + side * 3.4, cy - 1, 0.5, cx + side * 3.4, cy, 7.5);
        g.addColorStop(0, css(shade(base, 0.16 + j)));
        g.addColorStop(0.55, css(shade(base, j)));
        g.addColorStop(1, css(shade(base, -0.26 + j)));
        ctx.fillStyle = g;
        wrapped(cx + side * 3.6, cy, 10, (px, py) => {
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(side * 0.5);
          ctx.beginPath();
          ctx.ellipse(0, 0, 3.6, 8.2, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        });
      }
    }
  }
  // Fibre fuzz over the stitches.
  const img = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const k = (r() - 0.5) * 14;
    d[i] += k;
    d[i + 1] += k;
    d[i + 2] += k;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function linen(color: AvatarColor, seed: number) {
  const [c, ctx] = canvas();
  const base = hexRgb(FAMILY[color].base);
  const r = prng(seed * 31 + 7);
  const rows = new Float32Array(TEX_SIZE / 2).map(() => (r() - 0.5) * 2);
  const cols = new Float32Array(TEX_SIZE / 2).map(() => (r() - 0.5) * 2);
  const slub = fbm(seed + 3, 8, 3);
  const img = ctx.createImageData(TEX_SIZE, TEX_SIZE);
  const d = img.data;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const ty = rows[(y >> 1) % rows.length];
      const tx = cols[(x >> 1) % cols.length];
      // Over-under: which thread is on top alternates in a checker of 2 px cells.
      const over = ((x >> 1) + (y >> 1)) & 1;
      const thread = over ? ty : tx;
      const edge = over ? (y & 1 ? -0.05 : 0.03) : x & 1 ? -0.05 : 0.03;
      const k = thread * 0.045 + edge + (slub(x, y) - 0.5) * 0.08 + (r() - 0.5) * 0.03;
      const col = shade(base, k);
      const i = (y * TEX_SIZE + x) * 4;
      d[i] = col[0];
      d[i + 1] = col[1];
      d[i + 2] = col[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function grain(color: AvatarColor, seed: number) {
  const [c, ctx] = canvas();
  const wood = hexRgb(FAMILY[color].wood);
  const lateWood = shade(wood, -0.18);
  // Low-frequency warp (the figure) plus a fine one (the fibres), both periodic.
  const warp = fbm(seed, 2, 3);
  const fibre = fbm(seed + 9, 16, 2);
  const streak = periodicNoise(seed + 5, 128);
  const img = ctx.createImageData(TEX_SIZE, TEX_SIZE);
  const d = img.data;
  const rings = 22;
  for (let y = 0; y < TEX_SIZE; y++) {
    for (let x = 0; x < TEX_SIZE; x++) {
      const t = (y / TEX_SIZE) * rings + (warp(x, y) - 0.5) * 2.4 + (fibre(x, y) - 0.5) * 0.25;
      const fr = t - Math.floor(t);
      // Early wood fades into a narrow, darker late-wood line.
      const band = fr < 0.82 ? Math.pow(fr / 0.82, 3.2) * 0.35 : 0.35 + (1 - (fr - 0.82) / 0.18) * 0.35;
      const s = (streak(x * 0.25, y) - 0.5) * 0.06;
      const col = shade(mix(wood, lateWood, band), s);
      const i = (y * TEX_SIZE + x) * 4;
      d[i] = col[0];
      d[i + 1] = col[1];
      d[i + 2] = col[2];
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/** The fine fibre felt wears by default: soft, irregular, never a pattern. */
function fibre(color: AvatarColor, seed: number) {
  const [c, ctx] = canvas();
  const base = hexRgb(FAMILY[color].base);
  mottle(ctx, base, seed, 0.04, 0.07);
  const r = prng(seed * 17 + 1);
  ctx.lineCap = "round";
  for (let i = 0; i < 2200; i++) {
    const x = r() * TEX_SIZE;
    const y = r() * TEX_SIZE;
    const a = r() * Math.PI * 2;
    const len = 3 + r() * 9;
    const light = r() < 0.5;
    ctx.strokeStyle = css(shade(base, light ? 0.14 : -0.12), 0.35);
    ctx.lineWidth = 0.6 + r() * 0.5;
    wrapped(x, y, len, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + Math.cos(a + 0.6) * len * 0.5, py + Math.sin(a + 0.6) * len * 0.5, px + Math.cos(a) * len, py + Math.sin(a) * len);
      ctx.stroke();
    });
  }
  return c;
}

/** A ceramic glaze: a slow mottle, a faint crawl of lighter glaze and rare pinholes. Never a pattern. */
function glaze(color: AvatarColor, seed: number) {
  const [c, ctx] = canvas();
  const base = hexRgb(FAMILY[color].base);
  mottle(ctx, base, seed, 0.03, 0.012);
  const r = prng(seed * 19 + 2);
  const dark = lum(base) < 0.35;
  for (let i = 0; i < 140; i++) {
    const x = r() * TEX_SIZE;
    const y = r() * TEX_SIZE;
    const rad = 0.5 + r() * 0.8;
    ctx.fillStyle = css(dark ? shade(base, 0.25) : shade(base, -0.28), 0.5);
    wrapped(x, y, rad, (px, py) => {
      ctx.beginPath();
      ctx.arc(px, py, rad, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  return c;
}

export type TextureId = ProceduralTexture | "fibre" | "glaze";

const GEN: Record<TextureId, (color: AvatarColor, seed: number) => HTMLCanvasElement> = {
  speckle,
  terrazzo,
  marble,
  knit,
  linen,
  grain,
  fibre,
  glaze,
};

/** How many times a texture repeats across one body unit in the triplanar mapping. */
export const TEXTURE_SCALE: Record<TextureId, number> = {
  speckle: 0.42,
  terrazzo: 0.4,
  marble: 0.3,
  knit: 0.9,
  linen: 0.8,
  grain: 0.42,
  fibre: 0.5,
  glaze: 0.32,
};

const cache = new Map<string, HTMLCanvasElement>();
export function proceduralTexture(id: TextureId, color: AvatarColor, seed = 1): HTMLCanvasElement {
  const key = `${id}|${color}|${seed}`;
  let c = cache.get(key);
  if (!c) {
    c = GEN[id](color, hashSeed(key) % 100000);
    cache.set(key, c);
  }
  return c;
}

const swatches = new Map<string, string>();
/** A small square of the texture for the editor's option tiles. */
export function textureSwatch(id: TextureId, color: AvatarColor, px = 64): string {
  const key = `${id}|${color}|${px}`;
  let s = swatches.get(key);
  if (!s) {
    const src = proceduralTexture(id, color);
    const [c, ctx] = canvas(px);
    // Show the texture at roughly the scale it wears on a face.
    const crop = Math.round(TEX_SIZE * Math.min(1, 0.55 / TEXTURE_SCALE[id] / 2));
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, 0, 0, crop, crop, 0, 0, px, px);
    s = c.toDataURL("image/png");
    swatches.set(key, s);
  }
  return s;
}

/* ——————————————————————————— Uploads ——————————————————————————— */

export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export class UploadError extends Error {}

async function sniff(file: Blob): Promise<"image/png" | "image/jpeg" | "image/webp" | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const ascii = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  return null;
}

/**
 * Validate and prepare an uploaded image as an avatar texture. Resolves to a
 * 512 x 512 JPEG data URL; rejects with an UploadError whose message is the
 * sentence the editor shows.
 */
export async function prepareUpload(file: File, color: AvatarColor): Promise<string> {
  if (!(UPLOAD_TYPES as readonly string[]).includes(file.type)) throw new UploadError("Choose a PNG, JPEG or WebP image.");
  if (file.size > UPLOAD_MAX_BYTES) throw new UploadError("That image is larger than 5 MB. Choose a smaller one.");
  const kind = await sniff(file);
  if (!kind) throw new UploadError("That file isn't a PNG, JPEG or WebP image.");
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new UploadError("That image couldn't be read. Try another one.");
  }
  if (bmp.width < 64 || bmp.height < 64) {
    bmp.close();
    throw new UploadError("That image is too small. Use one at least 64 px on each side.");
  }
  const side = Math.min(bmp.width, bmp.height);
  const sx = (bmp.width - side) / 2;
  const sy = (bmp.height - side) / 2;
  const [c, ctx] = canvas(TEX_SIZE);
  ctx.fillStyle = FAMILY[color].base;
  ctx.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  ctx.imageSmoothingQuality = "high";
  // Downscale in halves for large sources, so the result is not aliased.
  let src: CanvasImageSource = bmp;
  let s = side;
  let ox = sx;
  let oy = sy;
  while (s > TEX_SIZE * 2) {
    const half = Math.round(s / 2);
    const [hc, hctx] = canvas(half);
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(src, ox, oy, s, s, 0, 0, half, half);
    src = hc;
    s = half;
    ox = 0;
    oy = 0;
  }
  ctx.drawImage(src, ox, oy, s, s, 0, 0, TEX_SIZE, TEX_SIZE);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.86);
}

const imageCache = new Map<string, Promise<HTMLCanvasElement>>();
const imageDone = new Map<string, HTMLCanvasElement>();
const imageKey = (url: string, color: AvatarColor, tint: number) => `${url.length}|${hashSeed(url)}|${color}|${Math.round(tint * 100)}`;

/** The texture canvas if it has already been prepared (so a sprite can draw it in the same frame). */
export function imageTextureSync(url: string, color: AvatarColor, tint: number): HTMLCanvasElement | null {
  return imageDone.get(imageKey(url, color, tint)) ?? null;
}
/**
 * An uploaded image as a texture canvas, pulled toward the colour family by
 * `tint` (0..1): the image is desaturated by that amount and its luminance
 * carried by the family colour, so a photo sits with the crew instead of
 * shouting over it.
 */
export function imageTexture(url: string, color: AvatarColor, tint: number): Promise<HTMLCanvasElement> {
  const key = imageKey(url, color, tint);
  let p = imageCache.get(key);
  if (!p) {
    p = new Promise<HTMLCanvasElement>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => {
        const [c, ctx] = canvas(TEX_SIZE);
        ctx.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
        if (tint > 0) {
          const fam = hexRgb(FAMILY[color].base);
          const data = ctx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
          const d = data.data;
          for (let i = 0; i < d.length; i += 4) {
            const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
            const t = Math.min(1, 0.35 + l * 1.05);
            const tr = fam[0] * t * 1.12;
            const tg = fam[1] * t * 1.12;
            const tb = fam[2] * t * 1.12;
            d[i] = d[i] + (tr - d[i]) * tint;
            d[i + 1] = d[i + 1] + (tg - d[i + 1]) * tint;
            d[i + 2] = d[i + 2] + (tb - d[i + 2]) * tint;
          }
          ctx.putImageData(data, 0, 0);
        }
        imageDone.set(key, c);
        if (imageDone.size > 24) imageDone.delete(imageDone.keys().next().value as string);
        resolve(c);
      };
      img.onerror = () => reject(new Error("image failed to load"));
      img.src = url;
    });
    if (imageCache.size > 24) imageCache.clear();
    imageCache.set(key, p);
  }
  return p;
}
