// Compose the pass sheets from the Cycles renders (HTML pages screenshotted by Chrome).
//   node tools/crew/flock/compose.mjs <pass_dir> <out_dir> [dotsRef.png] [sheets=A,B,C]
// Writes, per sheet and theme: lineup_<S>_<theme>.png (2000x1125, the dots key-art
// composition), portraits_<S>_<theme>.png, icons_<S>_<theme>.png, variants_<S>_<theme>.png,
// plus compare_<S>.png and compare_all.png (dots reference left, ours right).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "../../../package.json"));
const { chromium } = require("playwright");

const [passDir, outDir, dotsRef, sheetsArg] = process.argv.slice(2);
const sheets = (sheetsArg || "A,B,C").split(",");
fs.mkdirSync(outDir, { recursive: true });
const cast = JSON.parse(fs.readFileSync(path.join(passDir, "cast.json"), "utf8"));

const THEMES = {
  light: { bg: "#f5f3ef", ink: "#16161a", sub: "#6b6a70", chip: "#ffffff", line: "rgba(0,0,0,.08)" },
  dark: { bg: "#0b0b0d", ink: "#f4f3f0", sub: "#8d8c93", chip: "#1b1b20", line: "rgba(255,255,255,.08)" },
};
const SHEET_TITLE = {
  A: ["A", "Soft solids", "Toy-block geometry, big matte dot and pill eyes, bold felt hats"],
  B: ["B", "Snack bar", "Food icons, flat white sticker eyes and closed arcs, food-part accessories"],
  C: ["C", "Soft symbols", "Glyph shapes, round button eyes, happy half-moons, sleepy arcs, one-piece shades"],
};
const PASS = process.env.PASS_LABEL || "Alevr Orbit · agent characters · pass 1";
const HERE_REPO = path.resolve(here, "../../..");
const NEWSREADER = path.join(HERE_REPO, "native/desktop-electron/src/renderer/public/fonts/Newsreader-Variable.woff2");
const f = (p) => "file://" + path.resolve(p);
const FONT = `Inter, "SF Pro Text", -apple-system, system-ui, sans-serif`;
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=block" rel="stylesheet">
<style>@font-face{font-family:"Newsreader";src:url("${"file://" + NEWSREADER}") format("woff2");font-weight:200 800;font-display:block}</style>`;

function page(theme, w, body, extra = "") {
  const t = THEMES[theme];
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{background:${t.bg};color:${t.ink};font-family:${FONT};width:${w}px}
  .pass{font-size:16px;color:${t.sub};padding:36px 56px 0;letter-spacing:.01em}
  .hdr{display:flex;align-items:baseline;gap:18px;padding:10px 56px 8px}
  .hdr b{font-family:Newsreader,serif;font-size:48px;font-weight:600;letter-spacing:-.01em}
  .hdr span{font-size:24px;color:${t.sub}}
  .tag{font-size:20px;color:${t.sub};padding:0 56px 18px}
  .lbl{font-size:22px;font-weight:600;text-align:center;margin-top:4px}
  .lbl i{display:block;font-style:normal;font-weight:400;font-size:16px;color:${t.sub};margin-top:2px}
  .lbl .nm2{font-family:Newsreader,serif;font-size:28px;font-weight:600}
  .lbl u{display:block;width:28px;height:4px;border-radius:2px;margin:10px auto 0;text-decoration:none}
  .soft{-webkit-mask-image:radial-gradient(ellipse 72% 70% at 50% 52%,#000 62%,transparent 100%);mask-image:radial-gradient(ellipse 72% 70% at 50% 52%,#000 62%,transparent 100%)}
  ${extra}</style></head><body>${body}</body></html>`;
}

function header(S, what) {
  const [k, name, desc] = SHEET_TITLE[S];
  return `<div class="pass">${PASS}</div><div class="hdr"><b>${k} · ${name}</b><span>${what}</span></div><div class="tag">${desc}</div>`;
}

function lineupPage(S, theme) {
  // The dots key-art composition: a centred wordmark, the characters peeking up
  // from the bottom edge, shoulder to shoulder. Alevr's wordmark is upright
  // Newsreader 600, quiet (no prismatic glow).
  const t = THEMES[theme];
  const ink = theme === "dark" ? "#f6f5f2" : "#141418";
  const halo = theme === "dark" ? "text-shadow:0 0 42px rgba(255,255,255,.16)" : "";
  const body = `<div style="position:relative;width:2000px;height:1125px;overflow:hidden;background:${t.bg}">
    <div style="position:absolute;left:0;right:0;top:300px;text-align:center;font-family:Newsreader,serif;font-size:236px;font-weight:600;letter-spacing:-.025em;line-height:1;color:${ink};${halo}">Alevr Orbit</div>
    <img src="${f(path.join(passDir, S, `lineup_${S}.png`))}" style="position:absolute;left:0;bottom:0;width:2000px;display:block">
  </div>`;
  return page(theme, 2000, body);
}

function portraitsPage(S, theme) {
  const m = cast[S];
  const cell = Math.floor((2000 - 112) / m.length);
  const row = (v) => `<div style="display:flex;padding:0 56px">${m.map((c) => `<div style="width:${cell}px"><img class="soft" src="${f(path.join(passDir, S, `${c.id}_${v}.png`))}" style="width:${cell}px;height:${cell}px;display:block"></div>`).join("")}</div>`;
  const labels = `<div style="display:flex;padding:0 56px 48px">${m.map((c) => `<div style="width:${cell}px" class="lbl"><span class="nm2">${c.name}</span><i>${c.shape} · ${c.eyes.style || "dot"} eyes${c.acc.length ? " · " + c.acc.map((a) => a.id).join(", ") : ""}</i><u style="background:${c.color}"></u></div>`).join("")}</div>`;
  return page(theme, 2000, header(S, "portraits: 3/4 and front") + row("34") + row("front") + labels);
}

function iconsPage(S, theme) {
  const t = THEMES[theme];
  const m = cast[S];
  const rows = m.map((c, i) => `<div class="row">
    <div class="nm">${c.name}</div>
    ${[20, 32, 64].map((s) => `<div class="cell"><canvas data-src="${f(path.join(passDir, S, `${c.id}_icon.png`))}" data-size="${s}" width="${s}" height="${s}"></canvas><i>${s}px</i></div>`).join("")}
    <div class="sep"></div>
    ${[20, 32, 64].map((s) => `<div class="cell"><div class="chip" style="width:${Math.round(s * 1.25)}px;height:${Math.round(s * 1.25)}px"><canvas data-src="${f(path.join(passDir, S, `${c.id}_icon.png`))}" data-size="${s}" width="${s}" height="${s}"></canvas></div><i>chip ${s}</i></div>`).join("")}
    <div class="sep"></div>
    ${[[20, 5], [32, 3]].map(([s, k]) => `<div class="cell"><canvas data-src="${f(path.join(passDir, S, `${c.id}_icon.png`))}" data-size="${s}" data-zoom="${k}" width="${s * k}" height="${s * k}" style="image-rendering:pixelated"></canvas><i>${s}px ×${k}</i></div>`).join("")}
  </div>`).join("");
  const extra = `.row{display:flex;align-items:center;gap:34px;padding:10px 56px;border-top:1px solid ${t.line}}
  .nm{width:150px;font-family:Newsreader,serif;font-size:28px;font-weight:600}
  .cell{display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:70px}
  .cell i{font-style:normal;font-size:14px;color:${t.sub};margin-top:6px}
  .chip{border-radius:50%;background:${t.chip};display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px ${t.line}}
  .sep{width:1px;align-self:stretch;background:${t.line}}`;
  const script = `<script>
  async function draw(){
    const cs=[...document.querySelectorAll('canvas[data-src]')];
    await Promise.all(cs.map(c=>new Promise(r=>{const im=new Image();im.onload=()=>{
      const s=+c.dataset.size, k=+(c.dataset.zoom||1);
      // area-average downscale in steps (what a browser shows for a large source)
      let src=im, w=im.width;
      while(w/2>=s*1.6){const t=document.createElement('canvas');t.width=t.height=Math.round(w/2);const x=t.getContext('2d');x.imageSmoothingQuality='high';x.drawImage(src,0,0,t.width,t.height);src=t;w=t.width;}
      const small=document.createElement('canvas');small.width=small.height=s;const sx=small.getContext('2d');sx.imageSmoothingQuality='high';sx.drawImage(src,0,0,s,s);
      const ctx=c.getContext('2d');ctx.imageSmoothingEnabled=k===1;ctx.drawImage(small,0,0,s*k,s*k);r();};im.src=c.dataset.src;})));
    document.body.dataset.ready='1';
  }
  draw();</script>`;
  return page(theme, 2000, header(S, "icon readability at 20, 32 and 64 px (true pixels, then magnified)") + rows + `<div style="height:40px"></div>` + script, extra);
}

function variantsPage(S, theme) {
  const v = cast[`${S}_variants`];
  const cell = 600;
  const items = v.items.map((it) => `<div style="width:${cell}px"><img class="soft" src="${f(path.join(passDir, S, it.file))}" style="width:${cell}px;height:${cell}px;display:block"><div class="lbl">${it.title}<i>${it.desc}</i></div></div>`).join("");
  return page(theme, 2000, header(S, `customization: ${v.name}, base and two variants`) + `<div style="display:flex;gap:44px;padding:10px 56px 56px">${items}</div>`);
}

function comparePage(list) {
  // dots reference left, ours right (dark lineups), one row per sheet
  const rows = list.map((S) => `<div style="display:flex;gap:0">
      <div style="position:relative"><img src="${f(dotsRef)}" style="width:1000px;height:562px;object-fit:cover;display:block"><div class="cap">reference · OpenAI dots key art</div></div>
      <div style="position:relative"><img src="${f(path.join(outDir, `lineup_${S}_dark.png`))}" style="width:1000px;height:562px;display:block"><div class="cap">ours · Alevr Orbit · ${SHEET_TITLE[S][0]} ${SHEET_TITLE[S][1]}</div></div>
    </div>`).join("");
  return page("dark", 2000, rows, `.cap{position:absolute;left:24px;top:18px;font-size:20px;color:#8d8c93}`);
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
async function shoot(html, file, w, h) {
  const tmp = path.join(outDir, ".page.html");
  fs.writeFileSync(tmp, html);
  const ctx = await browser.newContext({ viewport: { width: w, height: h || 800 }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  await pg.goto("file://" + tmp, { waitUntil: "load" });
  await pg.evaluate(() => document.fonts.ready);
  await pg.waitForFunction(() => !document.querySelector("canvas[data-src]") || document.body.dataset.ready === "1", null, { timeout: 30000 });
  await pg.waitForTimeout(150);
  await pg.screenshot({ path: file, fullPage: !h });
  await ctx.close();
  console.log("WROTE", file);
}

for (const S of sheets) {
  for (const theme of ["dark", "light"]) {
    await shoot(lineupPage(S, theme), path.join(outDir, `lineup_${S}_${theme}.png`), 2000, 1125);
    await shoot(portraitsPage(S, theme), path.join(outDir, `portraits_${S}_${theme}.png`), 2000);
    await shoot(iconsPage(S, theme), path.join(outDir, `icons_${S}_${theme}.png`), 2000);
    if (cast[`${S}_variants`]) await shoot(variantsPage(S, theme), path.join(outDir, `variants_${S}_${theme}.png`), 2000);
  }
  if (dotsRef) await shoot(comparePage([S]), path.join(outDir, `compare_${S}.png`), 2000, 562);
}
if (dotsRef) await shoot(comparePage(sheets), path.join(outDir, `compare_all.png`), 2000, 562 * sheets.length);
await browser.close();
