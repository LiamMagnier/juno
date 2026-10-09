// Renders every mock to PNG in light and dark at 1440x900 and 390x844.
// Usage: node docs/code-v2/mocks/src/render.mjs <outDir> [name...]
import { chromium } from "playwright";
import { readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const dir = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv[2];
const only = process.argv.slice(3);
mkdirSync(outDir, { recursive: true });
const names = readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.replace(/\.html$/, "")).filter((n) => !only.length || only.includes(n));
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ channel: "chrome" }); }
for (const n of names) for (const scheme of ["light", "dark"]) for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(join(dir, `${n}.html`)).href);
  await page.evaluate(() => document.fonts.ready);
  const file = join(outDir, `${n}-${tag}-${scheme}.png`);
  await page.screenshot({ path: file });
  console.log(file);
  await ctx.close();
}
await browser.close();
