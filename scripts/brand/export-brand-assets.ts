/**
 * Exports every Alevr brand asset from the reviewed geometry modules in
 * src/components/brand, so no file can drift from the drawing the web renders.
 *
 *   npx tsx scripts/brand/export-brand-assets.ts            # write everything
 *   npx tsx scripts/brand/export-brand-assets.ts --check    # list what would be written
 *
 * SVG: public/brand/symbol-{light,dark,mono}.svg, wordmark-{light,dark}.svg,
 * lockup-{light,dark}.svg, orbit-{16,20,24}.svg, code-{16,20,24}.svg.
 * Raster (rendered by Chrome through Playwright, the renderer people see):
 * src/app/favicon.ico (16/32/48), src/app/icon.png, src/app/apple-icon.png,
 * public/brand/icon-{192,512}.png, icon-maskable-512.png, app-icon-mac.png,
 * and every PNG in the macOS and iOS AppIcon catalogs (sizes read from their
 * Contents.json; file names kept).
 *
 * The application tile: an opaque charcoal square (V3 dark ground #18191b)
 * with the pale mark (V3 dark ink #e8e9eb) at 64% of the width, centred on the
 * mark's visual centre. Small tiles give the mark more of the width and use the
 * optical master whose channels stay open at that size. Rounded tiles use the
 * existing catalog's 22% corner; iOS and Apple touch are square and opaque
 * (the system masks them); maskable keeps the mark inside the 80% safe circle.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import {
  CONTINUUM_BOUNDS,
  CONTINUUM_MASTER_PATHS,
  CONTINUUM_OPTICAL,
  CONTINUUM_SQUARE_VIEWBOX,
  type ContinuumOpticalSize,
} from "../../src/components/brand/continuum-geometry";
import { ALEVR_WORDMARK, ALEVR_WORDMARK_VIEWBOX } from "../../src/components/brand/alevr-wordmark-geometry";
import { ALEVR_LOCKUP, ALEVR_LOCKUP_VIEWBOX } from "../../src/components/brand/alevr-lockup-geometry";
import { CODE_GLYPH, ORBIT_GLYPH, type BrandGlyph } from "../../src/components/brand/brand-glyphs";

const ROOT = path.resolve(__dirname, "../..");
const CHECK = process.argv.includes("--check");
const INK_LIGHT = "#191b1e";
const INK_DARK = "#e8e9eb";
const TILE = "#18191b";

const written: string[] = [];
function write(rel: string, data: string | Buffer) {
  written.push(rel);
  if (CHECK) return;
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/* ———————————————————————— SVG files ———————————————————————— */

const svgDoc = (viewBox: string, body: string, title = "Alevr") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;
const tight = `${CONTINUUM_BOUNDS.x} ${CONTINUUM_BOUNDS.y} ${CONTINUUM_BOUNDS.width} ${CONTINUUM_BOUNDS.height}`;
const blades = (fill: string) => `<g fill="${fill}">${CONTINUUM_MASTER_PATHS.map((p) => `<path id="${p.id}" d="${p.d}"/>`).join("")}</g>`;
const word = (fill: string) => `<g fill="${fill}">${ALEVR_WORDMARK.glyphs.map((g) => `<path d="${g.d}"/>`).join("")}</g>`;
const lockup = (fill: string) =>
  `<g fill="${fill}"><g transform="${ALEVR_LOCKUP.markTransform}">${CONTINUUM_MASTER_PATHS.map((p) => `<path id="${p.id}" d="${p.d}"/>`).join("")}</g><g transform="${ALEVR_LOCKUP.wordTransform}">${ALEVR_WORDMARK.glyphs.map((g) => `<path d="${g.d}"/>`).join("")}</g></g>`;
const glyphSvg = (g: BrandGlyph, title: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${g.size}" height="${g.size}" viewBox="0 0 ${g.size} ${g.size}" fill="none" stroke="currentColor" stroke-width="${g.stroke}" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${title}"><title>${title}</title>${g.paths.map((d) => `<path d="${d}"/>`).join("")}</svg>\n`;

function writeSvgs() {
  write("public/brand/symbol-light.svg", svgDoc(tight, blades(INK_LIGHT)));
  write("public/brand/symbol-dark.svg", svgDoc(tight, blades(INK_DARK)));
  write("public/brand/symbol-mono.svg", svgDoc(tight, blades("#000000")));
  write("public/brand/wordmark-light.svg", svgDoc(ALEVR_WORDMARK_VIEWBOX, word(INK_LIGHT)));
  write("public/brand/wordmark-dark.svg", svgDoc(ALEVR_WORDMARK_VIEWBOX, word(INK_DARK)));
  write("public/brand/lockup-light.svg", svgDoc(ALEVR_LOCKUP_VIEWBOX, lockup(INK_LIGHT)));
  write("public/brand/lockup-dark.svg", svgDoc(ALEVR_LOCKUP_VIEWBOX, lockup(INK_DARK)));
  for (const n of [16, 20, 24] as const) {
    write(`public/brand/orbit-${n}.svg`, glyphSvg(ORBIT_GLYPH[n], "Orbit"));
    write(`public/brand/code-${n}.svg`, glyphSvg(CODE_GLYPH[n], "Code"));
  }
}

/* ———————————————————————— Tiles ———————————————————————— */

type Shape = "rounded" | "square" | "favicon";

/** The mark drawing that keeps its channels open at a rendered mark width (px). */
function markFor(markWidth: number): { viewBox: string; paths: readonly { d: string }[] } {
  if (markWidth >= 36) return { viewBox: CONTINUUM_SQUARE_VIEWBOX, paths: CONTINUUM_MASTER_PATHS };
  const sizes: ContinuumOpticalSize[] = [16, 20, 24, 32];
  // The nearest optical master; scaling it by up to ~20% keeps every channel near a pixel or wider.
  const n = sizes.reduce((best, s) => (Math.abs(s - markWidth) < Math.abs(best - markWidth) ? s : best), 16 as ContinuumOpticalSize);
  return { viewBox: `0 0 ${n} ${n}`, paths: CONTINUUM_OPTICAL[n].blades };
}

/** Mark width as a share of the tile: 64% from 128 px, more as the tile shrinks. */
function markRatio(size: number, shape: Shape): number {
  if (shape === "favicon") return size <= 16 ? 14 / 16 : size <= 32 ? 26 / 32 : 38 / 48;
  if (size <= 16) return 0.75;
  if (size <= 32) return 0.69;
  if (size <= 64) return 0.66;
  return 0.64;
}

/**
 * `relief` (macOS only, per the identity brief): the tile lifts 4% at the top and settles 3%
 * at the bottom. Rounded tiles from 64 px carry a hairline rim of white (9%, 6% at 64), so the charcoal keeps
 * an edge on a dark Dock, a dark page or a dark wallpaper; masked tiles get neither (the
 * system draws their edge).
 */
function tileSvg(size: number, shape: Shape, relief = false): string {
  const radius = shape === "rounded" ? size * 0.22 : shape === "favicon" ? Math.round(size * 0.19) : 0;
  const markW = Math.round(size * markRatio(size, shape));
  const m = markFor(markW);
  const off = (size - markW) / 2;
  const rim = Math.max(1, size / 256);
  const fill = relief ? "url(#relief)" : TILE;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    (relief ? `<defs><linearGradient id="relief" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e1f22"/><stop offset="1" stop-color="#151618"/></linearGradient></defs>` : "") +
    `<rect width="${size}" height="${size}" rx="${radius}" fill="${fill}"/>` +
    (shape === "rounded" && size >= 64 ? `<rect x="${rim / 2}" y="${rim / 2}" width="${size - rim}" height="${size - rim}" rx="${radius - rim / 2}" fill="none" stroke="#ffffff" stroke-opacity="${size >= 128 ? 0.09 : 0.06}" stroke-width="${rim}"/>` : "") +
    `<svg x="${off}" y="${off}" width="${markW}" height="${markW}" viewBox="${m.viewBox}" fill="${INK_DARK}">${m.paths.map((p) => `<path d="${p.d}"/>`).join("")}</svg>` +
    `</svg>`;
}

async function render(browser: Browser, svg: string, size: number, opaque: boolean): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
  const png = await page.locator("svg").first().screenshot({ omitBackground: !opaque, type: "png" });
  await page.close();
  return png;
}

/** PNG-in-ICO (Windows Vista+ and every current browser read PNG frames). */
function packIco(frames: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const dir = Buffer.alloc(16 * frames.length);
  let offset = 6 + dir.length;
  frames.forEach((f, i) => {
    const o = i * 16;
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, o);
    dir.writeUInt8(f.size >= 256 ? 0 : f.size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(f.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += f.png.length;
  });
  return Buffer.concat([header, dir, ...frames.map((f) => f.png)]);
}

/** Drop the alpha channel (App Store icons must be opaque, without alpha). */
async function opaquePng(png: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(png).flatten({ background: TILE }).removeAlpha().png().toBuffer();
}

async function writeRasters() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const frames = [];
    for (const size of [16, 32, 48]) frames.push({ size, png: await render(browser, tileSvg(size, "favicon"), size, false) });
    write("src/app/favicon.ico", packIco(frames));
    write("src/app/icon.png", await render(browser, tileSvg(512, "rounded"), 512, false));
    write("src/app/apple-icon.png", await opaquePng(await render(browser, tileSvg(180, "square"), 180, true)));
    write("public/brand/icon-192.png", await render(browser, tileSvg(192, "rounded"), 192, false));
    write("public/brand/icon-512.png", await render(browser, tileSvg(512, "rounded"), 512, false));
    write("public/brand/icon-maskable-512.png", await opaquePng(await render(browser, tileSvg(512, "square"), 512, true)));
    write("public/brand/app-icon-mac.png", await render(browser, tileSvg(512, "rounded", true), 512, false));

    const mac = "native/macOS/JunoDesktop/Resources/Assets.xcassets/AppIcon.appiconset";
    const macContents = JSON.parse(fs.readFileSync(path.join(ROOT, mac, "Contents.json"), "utf8")) as { images: { filename?: string; size: string; scale: string }[] };
    const macFiles = new Map<string, number>();
    for (const img of macContents.images) {
      if (!img.filename) continue;
      macFiles.set(img.filename, Number.parseFloat(img.size) * Number.parseInt(img.scale, 10));
    }
    for (const [file, px] of macFiles) write(`${mac}/${file}`, await render(browser, tileSvg(px, "rounded", true), px, false));

    const ios = "native/iOS/JunoMobile/Resources/Assets.xcassets/AppIcon.appiconset";
    const iosContents = JSON.parse(fs.readFileSync(path.join(ROOT, ios, "Contents.json"), "utf8")) as { images: { filename?: string; size: string; scale?: string }[] };
    for (const img of iosContents.images) {
      if (!img.filename) continue;
      const px = Number.parseFloat(img.size) * (img.scale ? Number.parseInt(img.scale, 10) : 1);
      write(`${ios}/${img.filename}`, await opaquePng(await render(browser, tileSvg(px, "square"), px, true)));
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  writeSvgs();
  await writeRasters();
  console.log(`${CHECK ? "would write" : "wrote"} ${written.length} files:\n  ${written.join("\n  ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
