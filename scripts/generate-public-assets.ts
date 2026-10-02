/** Rebuild the exact Continuum email lockups and 1200×630 OpenGraph card.
 * Sources: committed vector lockups and the bundled Newsreader font. */
import { readFileSync, writeFileSync } from "node:fs";
import { createCanvas, GlobalFonts, loadImage } from "@napi-rs/canvas";

async function generate() {
  GlobalFonts.registerFromPath("public/fonts/newsreader-regular.ttf", "Newsreader");
  for (const tone of ["light", "dark"]) {
    const logo = await loadImage(readFileSync(`public/brand/lockup-${tone}.svg`));
    const canvas = createCanvas(348, 84);
    const ctx = canvas.getContext("2d");
    const height = 348 * logo.height / logo.width;
    ctx.drawImage(logo, 0, (84 - height) / 2, 348, height);
    writeFileSync(`public/brand/email-lockup-${tone}.png`, canvas.toBuffer("image/png"));
  }
  const logo = await loadImage(readFileSync("public/brand/lockup-light.svg"));
  const canvas = createCanvas(1200, 630);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fcfcfd";
  ctx.fillRect(0, 0, 1200, 630);
  ctx.drawImage(logo, 360, 225, 480, 480 * logo.height / logo.width);
  ctx.fillStyle = "#191b1e";
  ctx.font = '40px Newsreader';
  ctx.textAlign = "center";
  ctx.fillText("Go further.", 600, 388);
  writeFileSync("public/og.png", canvas.toBuffer("image/png"));
}
void generate();
