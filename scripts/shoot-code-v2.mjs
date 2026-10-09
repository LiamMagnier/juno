// Screenshots of the /dev/code-v2 gallery (light + dark, 1440x900 + 390x844).
// Usage: node scripts/shoot-code-v2.mjs <baseUrl> <outDir> [state...]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const [base, outDir, ...only] = process.argv.slice(2);
const STATES = ["streaming", "needs-you", "limited", "subagents", "best-of-n", "model-picker", "tiers", "orchestrate", "plan", "empty", "offline", "no-provider", "connections"];
mkdirSync(outDir, { recursive: true });
let browser;
try { browser = await chromium.launch({ channel: "chrome", headless: true }); } catch { browser = await chromium.launch(); }
const sizes = (process.env.SIZES ?? "desktop,mobile").split(",");
const schemes = (process.env.SCHEMES ?? "light,dark").split(",");
for (const state of STATES.filter((s) => !only.length || only.includes(s))) {
  for (const scheme of schemes) for (const [w, h, tag] of [[1440, 900, "desktop"], [390, 844, "mobile"]].filter((x) => sizes.includes(x[2]))) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, colorScheme: scheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && !m.text().includes("MissingSecret") && errors.push(m.text().slice(0, 300)));
    await page.goto(`${base}/dev/code-v2?state=${state}&bare=1&theme=${scheme}&motion=reduced`, { waitUntil: "networkidle", timeout: 120000 });
    await page.waitForSelector(".cv2", { timeout: 60000 });
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.waitForTimeout(700);
    const file = join(outDir, `${state}-${tag}-${scheme}.png`);
    await page.screenshot({ path: file });
    console.log(file, errors.length ? `ERRORS: ${errors.slice(0, 3).join(" | ")}` : "");
    await ctx.close();
  }
}
await browser.close();
