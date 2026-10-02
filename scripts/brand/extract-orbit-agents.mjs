/**
 * Cut the Orbit agent characters out of the owner's sheet and give them a
 * subtle flocked finish.
 *
 *   node scripts/brand/extract-orbit-agents.mjs
 *
 * Source: docs/rework/brand/assets/orbit-agents-sheet.webp (6 x 3 cells, 300 px).
 * Output: public/brand/agents/<name>.webp, 300 x 300, transparent, one scale
 * for every agent so their sizes stay comparable.
 *
 * Method, per cell:
 *  1. The backdrop colour is the median of the four corners.
 *  2. A flood fill from the corners walks through backdrop and shadow (pixels
 *     close to the backdrop, or darker but with no colour of their own). What
 *     it cannot reach is the character, so dark eyes, glasses and hats stay
 *     opaque.
 *  3. Flood pixels become a black shadow whose opacity follows how much they
 *     darken the backdrop, so the shadow sits on any page colour.
 *  4. Fur: the character edge is softened, then broken up by fine per-pixel
 *     noise into short fibres, and the body gets a faint velvet grain.
 */
import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const SRC = path.join(ROOT, "docs/rework/brand/assets/orbit-agents-sheet.webp");
const OUT = path.join(ROOT, "public/brand/agents");
const CELL = 300;

/** [column, row] of each character on the sheet, by the name used on the site. */
const AGENTS = {
  hatty: [0, 0], quill: [1, 0], sprout: [2, 0], bell: [3, 0], beanie: [4, 0], gourd: [5, 0],
  toast: [1, 1], bean: [2, 1], macaron: [3, 1], acorn: [4, 1],
  star: [0, 2], moon: [1, 2], spark: [2, 2], bolt: [3, 2], drop: [4, 2], bloom: [5, 2],
};

// Deterministic noise, so a re-run produces identical files.
let seed = 0x2f6e2b1;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function blur(src, w, h, radius) {
  // Separable box blur, two passes (close to a small gaussian).
  let a = Float32Array.from(src);
  for (let pass = 0; pass < 2; pass++) {
    const b = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -radius; k <= radius; k++) { const xx = x + k; if (xx >= 0 && xx < w) { s += a[y * w + xx]; n++; } }
      b[y * w + x] = s / n;
    }
    const c = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let k = -radius; k <= radius; k++) { const yy = y + k; if (yy >= 0 && yy < h) { s += b[yy * w + x]; n++; } }
      c[y * w + x] = s / n;
    }
    a = c;
  }
  return a;
}

async function cut(data, sheetW, col, row) {
  const W = CELL, H = CELL, px = (x, y) => ((row * CELL + y) * sheetW + (col * CELL + x)) * 3;
  // 1. Backdrop
  const corners = [];
  for (const [cx, cy] of [[4, 4], [W - 12, 4], [4, H - 12], [W - 12, H - 12]]) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) corners.push(px(cx + x, cy + y));
  const bg = [0, 1, 2].map((ch) => median(corners.map((i) => data[i + ch])));
  const bgL = lum(...bg);

  // 2. Flood from the border through backdrop and shadow
  const inFlood = new Uint8Array(W * H);
  const passable = (x, y) => {
    const i = px(x, y), r = data[i], g = data[i + 1], b = data[i + 2];
    const d = Math.hypot(r - bg[0], g - bg[1], b - bg[2]);
    if (d < 14) return true;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    const bgChroma = Math.max(...bg) - Math.min(...bg);
    const L = lum(r, g, b) / bgL;
    return L < 1 && L > 0.42 && chroma < bgChroma + 14;
  };
  const stack = [];
  for (let x = 0; x < W; x++) stack.push([x, 0], [x, H - 1]);
  for (let y = 0; y < H; y++) stack.push([0, y], [W - 1, y]);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const k = y * W + x;
    if (inFlood[k] || !passable(x, y)) continue;
    inFlood[k] = 1;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  // 3 + 4. Character mask with fibres, shadow alpha, grain
  const mask = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) mask[k] = inFlood[k] ? 0 : 1;
  const soft = blur(mask, W, H, 1);
  const noise = new Float32Array(W * H);
  for (let k = 0; k < W * H; k++) noise[k] = rand();
  const fibre = blur(noise, W, H, 0); // radius 0 keeps it per-pixel; the soft edge carries the length
  const grain = blur(noise.map(() => rand()), W, H, 1);
  // Body colour spread outward (mask-weighted average), used to repaint the
  // fringe so no backdrop colour survives as a halo on dark pages.
  const chans = [0, 1, 2].map((ch) => {
    const c = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) c[y * W + x] = mask[y * W + x] * data[px(x, y) + ch];
    return blur(c, W, H, 3);
  });
  const weight = blur(mask, W, H, 3);

  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const k = y * W + x, i = px(x, y), o = k * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const edge = soft[k];
    // Fibres: inside the soft band, noise decides which pixels stay, so the
    // silhouette reads as a short, even nap rather than a clean cut.
    let a = edge;
    if (edge > 0.02 && edge < 0.98) a = Math.min(1, Math.max(0, (edge - 0.5) * 1.6 + 0.5 + (fibre[k] - 0.5) * 0.9));
    if (a > 0.01) {
      const v = 1 + (grain[k] - 0.5) * 0.09;
      // Fringe: repaint with the nearest body colour so no backdrop halo shows.
      const fringe = !mask[k] || edge < 0.98;
      const wsum = weight[k] || 1;
      const rr = fringe && weight[k] > 0.001 ? chans[0][k] / wsum : r;
      const gg = fringe && weight[k] > 0.001 ? chans[1][k] / wsum : g;
      const bb = fringe && weight[k] > 0.001 ? chans[2][k] / wsum : b;
      out[o] = Math.min(255, rr * v); out[o + 1] = Math.min(255, gg * v); out[o + 2] = Math.min(255, bb * v);
      out[o + 3] = Math.round(a * 255);
    } else {
      const L = lum(r, g, b) / bgL;
      const border = Math.min(x, y, W - 1 - x, H - 1 - y);
      const fade = Math.min(1, border / 36); // the sheet's cells end abruptly; let the shadow run out first
      const s = Math.min(1, Math.max(0, (0.965 - L) * 1.25)) * fade * fade;
      out[o] = 0; out[o + 1] = 0; out[o + 2] = 0; out[o + 3] = Math.round(s * 255);
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 4 } }).webp({ quality: 92, alphaQuality: 100 }).toBuffer();
}

const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
fs.mkdirSync(OUT, { recursive: true });
for (const [name, [col, row]] of Object.entries(AGENTS)) {
  fs.writeFileSync(path.join(OUT, `${name}.webp`), await cut(data, info.width, col, row));
}
console.log(`wrote ${Object.keys(AGENTS).length} agents to ${path.relative(ROOT, OUT)}`);
