/**
 * Exports every Alevr brand asset from the reviewed geometry modules in
 * src/components/brand, so no file can drift from the drawing the web renders.
 *
 *   npx tsx scripts/brand/export-brand-assets.ts            # write everything
 *   npx tsx scripts/brand/export-brand-assets.ts --check    # list what would be written
 *   BRAND_ICTOOL_OUT=dir npx tsx scripts/brand/export-brand-assets.ts   # also render the .icon with ictool
 *
 * SVG: public/brand/symbol-{light,dark,mono}.svg, wordmark-{light,dark}.svg,
 * lockup-{light,dark}.svg, orbit-{16,20,24}.svg, code-{16,20,24}.svg, and
 * src/app/icon.svg (the browser-tab icon: the bare mark, graphite or pale by
 * the colour scheme, with the optical master for the size it is drawn at).
 * Raster (rendered by Chrome through Playwright, the renderer people see):
 * src/app/favicon.ico (16/32/48), src/app/apple-icon.png,
 * public/brand/icon-{192,512}.png, icon-maskable-512.png, app-icon-mac.png,
 * and every PNG in the macOS and iOS AppIcon catalogs (sizes read from their
 * Contents.json; file names kept). Icon Composer: native/Brand/Alevr.icon
 * (macOS and iOS 26: a charcoal fill and the four blades as glass layers, so
 * the system draws Liquid Glass and the dark and tinted renditions).
 *
 * The application tile: V3 dark ground #18191b with the mark in V3 dark ink
 * #e8e9eb, centred on the mark's visual centre, always drawn with a master
 * whose channels stay open at its size.
 *   any (manifest 192/512): full-bleed rounded tile (22%), mark 64% of the width
 *   macOS: Apple's grid, an 824 continuous-corner squircle inside 1024 with
 *     the standard drop shadow (y 10, blur 10, black 30%), mark 64% of the body
 *   iOS, Apple touch: opaque square without alpha (the system masks it), mark 64%
 *   maskable: opaque square, mark 52% of the width, inside the 80% safe circle
 *   favicon.ico: 19% corner tile; 16 is drawn by hand on the 16 px grid
 *     (scripts/brand/favicon-frames.json), 32 uses the 26 px placement master,
 *     48 the master
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { CONTINUUM_BOUNDS, CONTINUUM_MASTER_PATHS, CONTINUUM_SQUARE_VIEWBOX, continuumDrawing } from "../../src/components/brand/continuum-geometry";
import { ALEVR_WORDMARK, ALEVR_WORDMARK_VIEWBOX } from "../../src/components/brand/alevr-wordmark-geometry";
import { ALEVR_LOCKUP, ALEVR_LOCKUP_VIEWBOX } from "../../src/components/brand/alevr-lockup-geometry";
import { CODE_GLYPH, ORBIT_GLYPH, type BrandGlyph } from "../../src/components/brand/brand-glyphs";
import FAVICON from "./favicon-frames.json";

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

type Drawing = { viewBox: string; paths: readonly { d: string }[] };

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

/**
 * The tab icon. Media queries inside an SVG image see the size it is drawn
 * at, so each size gets its own master: the 16 master below 24 px, the 32
 * master to 47 px, the master above. Graphite on a light tab strip, pale on
 * dark. Replaces the 512 px icon.png, which Chrome downscaled for a 2x tab
 * instead of using a drawing tuned for that size.
 */
function tabIconSvg(): string {
  const nest = (cls: string, d: Drawing) => `<svg class="${cls}" viewBox="${d.viewBox}" width="100%" height="100%">${d.paths.map((p) => `<path d="${p.d}"/>`).join("")}</svg>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<style>path{fill:${INK_LIGHT}}@media (prefers-color-scheme:dark){path{fill:${INK_DARK}}}` +
    `.s16,.s32,.sm{display:none}@media (max-width:23.99px){.s16{display:inline}}@media (min-width:24px) and (max-width:47.99px){.s32{display:inline}}@media (min-width:48px){.sm{display:inline}}</style>` +
    nest("s16", continuumDrawing(16)) +
    nest("s32", continuumDrawing(32)) +
    nest("sm", { viewBox: CONTINUUM_SQUARE_VIEWBOX, paths: CONTINUUM_MASTER_PATHS }) +
    `</svg>\n`
  );
}

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
  write("src/app/icon.svg", tabIconSvg());
}

/* ———————————————————————— Tiles ———————————————————————— */

type Shape = "rounded" | "square" | "maskable" | "macos" | "favicon";

/** The mark drawing for a rendered mark width (px): the optical master that keeps its channels open, or the master. */
function markFor(markWidth: number): Drawing {
  if (Math.abs(markWidth - FAVICON.mark26.size) <= 1) return { viewBox: "0 0 26 26", paths: FAVICON.mark26.blades };
  return continuumDrawing(markWidth);
}

/** Mark width as a share of the tile (or of the macOS body): 64% from 128 px, more as it shrinks. */
function markRatio(size: number, shape: Shape): number {
  if (shape === "favicon") return size <= 32 ? 26 / 32 : 38 / 48;
  if (shape === "maskable") return 0.52;
  if (size <= 16) return 0.75;
  if (size <= 32) return 0.69;
  if (size <= 64) return 0.66;
  return 0.64;
}

/** Continuous-corner rounded rectangle (the iOS and macOS squircle; PaintCode's reconstruction of UIKit's curve). */
function squircle(x: number, y: number, w: number, h: number, radius: number): string {
  const R = Math.min(radius, Math.min(w, h) / 2 / 1.52866483);
  const f = (v: number) => String(Math.round(v * 1000) / 1000);
  // A corner at (cx, cy) whose edges run inward along sx (horizontal) and sy (vertical).
  const at = (cx: number, cy: number, sx: number, sy: number) => (a: number, b: number) => `${f(cx + sx * a * R)} ${f(cy + sy * b * R)}`;
  const TR = at(x + w, y, -1, 1);
  const BR = at(x + w, y + h, -1, -1);
  const BL = at(x, y + h, 1, -1);
  const TL = at(x, y, 1, 1);
  // Clockwise: a corner entered along a horizontal edge (TR, BL) or along a vertical one (BR, TL).
  const corner = (P: (a: number, b: number) => string, vertical: boolean) => {
    const q = (a: number, b: number) => (vertical ? P(b, a) : P(a, b));
    return `C${q(1.08849323, 0)} ${q(0.86840689, 0)} ${q(0.66993427, 0.065496)}L${q(0.63149399, 0.07491176)}C${q(0.37282392, 0.16905899)} ${q(0.16905899, 0.37282392)} ${q(0.07491176, 0.63149399)}L${q(0.06549569, 0.66993493)}C${q(0, 0.86840689)} ${q(0, 1.08849323)} ${q(0, 1.52866483)}`;
  };
  return `M${TL(1.52866483, 0)}L${TR(1.52866483, 0)}${corner(TR, false)}L${BR(0, 1.52866483)}${corner(BR, true)}L${BL(1.52866483, 0)}${corner(BL, false)}L${TL(0, 1.52866483)}${corner(TL, true)}Z`;
}

/**
 * A tile as SVG. Rounded tiles from 64 px carry a hairline rim of white (9%, 6% at 64), so the
 * charcoal keeps an edge on a dark page, Dock or wallpaper; macOS also gets the brief's relief
 * (#1e1f22 to #151618, top to bottom) and Apple's drop shadow. Masked tiles get none of these:
 * the system draws their edge.
 */
function tileSvg(size: number, shape: Shape): string {
  const k = size / 1024;
  const body = shape === "macos" ? { x: 100 * k, y: 100 * k, w: 824 * k } : { x: 0, y: 0, w: size };
  const markW = Math.round(body.w * markRatio(shape === "macos" ? body.w : size, shape) * 100) / 100;
  const m = markFor(markW);
  const off = { x: body.x + (body.w - markW) / 2, y: body.y + (body.w - markW) / 2 };
  const rim = Math.max(1, size / 256);
  const rimOpacity = size >= 128 ? 0.09 : 0.06;
  let shapeEl: string;
  let defs = "";
  if (shape === "macos") {
    const d = squircle(body.x, body.y, body.w, body.w, 185.4 * k);
    defs =
      `<linearGradient id="relief" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e1f22"/><stop offset="1" stop-color="#151618"/></linearGradient>` +
      `<filter id="blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="${5 * k}"/></filter>` +
      `<clipPath id="body"><path d="${d}"/></clipPath>`;
    // The shadow is its own blurred shape under the body: a filter on the gradient-filled body
    // itself makes Chrome paint the gradient at low precision, in visible bands.
    shapeEl =
      `<path d="${d}" transform="translate(0 ${10 * k})" fill="#000" fill-opacity="0.3" filter="url(#blur)"/>` +
      `<path d="${d}" fill="url(#relief)"/>` +
      (size >= 64 ? `<path d="${d}" fill="none" stroke="#ffffff" stroke-opacity="${rimOpacity}" stroke-width="${rim * 2}" clip-path="url(#body)"/>` : "");
  } else {
    const radius = shape === "rounded" ? size * 0.22 : shape === "favicon" ? Math.round(size * 0.19) : 0;
    shapeEl =
      `<rect width="${size}" height="${size}" rx="${radius}" fill="${TILE}"/>` +
      (shape === "rounded" && size >= 64 ? `<rect x="${rim / 2}" y="${rim / 2}" width="${size - rim}" height="${size - rim}" rx="${radius - rim / 2}" fill="none" stroke="#ffffff" stroke-opacity="${rimOpacity}" stroke-width="${rim}"/>` : "");
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    (defs ? `<defs>${defs}</defs>` : "") +
    shapeEl +
    `<svg x="${off.x}" y="${off.y}" width="${markW}" height="${markW}" viewBox="${m.viewBox}" fill="${INK_DARK}">${m.paths.map((p) => `<path d="${p.d}"/>`).join("")}</svg>` +
    `</svg>`
  );
}

async function render(browser: Browser, svg: string, size: number, opaque: boolean): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
  const png = await page.locator("svg").first().screenshot({ omitBackground: !opaque, type: "png" });
  await page.close();
  return png;
}

/** The favicon's 16 px frame, from its hand-drawn pixel grid (0 tile, 9 full ink) on a 19% corner tile. */
async function favicon16(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const tile = [0x18, 0x19, 0x1b];
  const ink = [0xe8, 0xe9, 0xeb];
  const grid = FAVICON.frame16.join("");
  const buf = Buffer.alloc(16 * 16 * 4);
  const r = Math.round(16 * 0.19);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = y * 16 + x;
      const a = Number(grid[i]) / 9;
      let c = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4;
          const py = y + (sy + 0.5) / 4;
          const dx = Math.max(r - px, px - (16 - r), 0);
          const dy = Math.max(r - py, py - (16 - r), 0);
          if (dx * dx + dy * dy <= r * r) c++;
        }
      }
      for (let ch = 0; ch < 3; ch++) buf[i * 4 + ch] = Math.round(tile[ch] * (1 - a) + ink[ch] * a);
      buf[i * 4 + 3] = Math.round((c / 16) * 255);
    }
  }
  return sharp(buf, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
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
    const frames = [{ size: 16, png: await favicon16() }];
    for (const size of [32, 48]) frames.push({ size, png: await render(browser, tileSvg(size, "favicon"), size, false) });
    write("src/app/favicon.ico", packIco(frames));
    write("src/app/apple-icon.png", await opaquePng(await render(browser, tileSvg(180, "square"), 180, true)));
    write("public/brand/icon-192.png", await render(browser, tileSvg(192, "rounded"), 192, false));
    write("public/brand/icon-512.png", await render(browser, tileSvg(512, "rounded"), 512, false));
    write("public/brand/icon-maskable-512.png", await opaquePng(await render(browser, tileSvg(512, "maskable"), 512, true)));
    write("public/brand/app-icon-mac.png", await render(browser, tileSvg(512, "macos"), 512, false));

    const mac = "native/macOS/JunoDesktop/Resources/Assets.xcassets/AppIcon.appiconset";
    const macContents = JSON.parse(fs.readFileSync(path.join(ROOT, mac, "Contents.json"), "utf8")) as { images: { filename?: string; size: string; scale: string }[] };
    const macFiles = new Map<string, number>();
    for (const img of macContents.images) {
      if (!img.filename) continue;
      macFiles.set(img.filename, Number.parseFloat(img.size) * Number.parseInt(img.scale, 10));
    }
    for (const [file, px] of macFiles) write(`${mac}/${file}`, await render(browser, tileSvg(px, "macos"), px, false));

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

/* ———————————————————————— Icon Composer (macOS and iOS 26) ———————————————————————— */

/**
 * native/Brand/Alevr.icon: a charcoal fill and the four blades as separate
 * glass layers in one group, so Liquid Glass lights each blade and the dark,
 * tinted and clear renditions come from the system. Blades sit at 64% of the
 * 1024 canvas on the mark's visual centre, the placement the tiles use. Not
 * yet referenced by either Xcode project (the native lanes adopt it).
 */
function writeIconComposer() {
  const dir = "native/Brand/Alevr.icon";
  const S = 1024;
  const markW = S * 0.64;
  const [vx, vy, vw] = CONTINUUM_SQUARE_VIEWBOX.split(" ").map(Number);
  const scale = markW / vw;
  const tx = (S - markW) / 2 - vx * scale;
  const ty = (S - markW) / 2 - vy * scale;
  for (const p of CONTINUUM_MASTER_PATHS) {
    write(
      `${dir}/Assets/${p.id}.svg`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}"><path transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(6)})" fill="${INK_DARK}" d="${p.d}"/></svg>\n`,
    );
  }
  const icon = {
    fill: { solid: "srgb:0.09412,0.09804,0.10588,1.00000" },
    groups: [
      {
        layers: CONTINUUM_MASTER_PATHS.map((p) => ({ "image-name": `${p.id}.svg`, name: p.id, glass: true })),
        shadow: { kind: "neutral", opacity: 0.5 },
        translucency: { enabled: true, value: 0.4 },
      },
    ],
    "supported-platforms": { circles: ["watchOS"], squares: "shared" },
  };
  write(`${dir}/icon.json`, `${JSON.stringify(icon, null, 2)}\n`);
}

/** Render the Icon Composer document with Apple's ictool (Xcode 26) into BRAND_ICTOOL_OUT, as validation. */
function validateIconComposer() {
  const ictool = "/Applications/Xcode.app/Contents/Applications/Icon Composer.app/Contents/Executables/ictool";
  const outDir = process.env.BRAND_ICTOOL_OUT;
  if (CHECK || !outDir || !fs.existsSync(ictool)) return;
  fs.mkdirSync(outDir, { recursive: true });
  const renditions: [string, string][] = [["macOS", "Default"], ["macOS", "Dark"], ["iOS", "Default"], ["iOS", "Dark"], ["iOS", "TintedDark"], ["iOS", "ClearLight"]];
  for (const [platform, rendition] of renditions) {
    const out = path.join(outDir, `alevr-icon-${platform}-${rendition}.png`);
    try {
      const args = [path.join(ROOT, "native/Brand/Alevr.icon"), "--export-image", "--output-file", out, "--platform", platform, "--rendition", rendition, "--width", "1024", "--height", "1024", "--scale", "1"];
      execFileSync(ictool, args, { stdio: "pipe" });
      console.log(`ictool ${platform} ${rendition} -> ${out}`);
    } catch (e) {
      console.warn(`ictool ${platform} ${rendition} failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
}

async function main() {
  writeSvgs();
  await writeRasters();
  writeIconComposer();
  validateIconComposer();
  console.log(`${CHECK ? "would write" : "wrote"} ${written.length} files:\n  ${written.join("\n  ")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
