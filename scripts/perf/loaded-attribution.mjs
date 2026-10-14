#!/usr/bin/env node
/**
 * Which source modules a cold hard load of one URL actually downloads — the
 * scripts the browser fetched, not every chunk the build manifest lists for
 * the route (that list includes chunks only a branch the page did not take,
 * such as a `next/dynamic` import, would fetch).
 *
 *   ALEVR_BUNDLE_SOURCEMAPS=1 next build && next start -p 3201
 *   node scripts/perf/loaded-attribution.mjs --state <storage.json> --path /chat/<id> \
 *        [--bucket early|late|all] [--grep voice,code/] [--files]
 *
 * Prints total script bytes fetched and the heaviest sources (minified bytes,
 * attributed through each chunk's source map, as bundle-attribution.mjs does).
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { SourceMapConsumer } from "source-map-js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith("--") ? [...acc, [cur.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? "1" : all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://localhost:3201";
const root = path.join(process.cwd(), ".next");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, storageState: args.state });
const page = await context.newPage();
// Not "networkidle": the app holds event streams open for as long as it is up.
await page.goto(`${BASE}${args.path}`, { waitUntil: "load" });
await page.waitForTimeout(3000);
// Split by when the browser asked: scripts requested before DOMContentLoaded
// are the page's own first load; later ones are lazy chunks it rendered and
// prefetches of routes it links to.
const entries = await page.evaluate(() => {
  const dcl = performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd;
  return performance.getEntriesByType("resource")
    .filter((e) => e.name.includes("/_next/static/") && e.name.endsWith(".js"))
    .map((e) => ({ file: decodeURIComponent(new URL(e.name).pathname.replace("/_next/", "")), early: e.startTime <= dcl }));
});
await browser.close();
const bucket = args.bucket ?? "early";
const scripts = new Set(entries.filter((e) => bucket === "all" || (bucket === "early") === e.early).map((e) => e.file));

const clean = (source) =>
  source.replace(/^webpack:\/\/_N_E\//, "").replace(/^\.\//, "").replace(/\?.*$/, "").replace(/^.*node_modules\/((?:@[^/]+\/)?[^/]+).*$/, "npm:$1");
const total = new Map();
let bytes = 0;
for (const file of scripts) {
  const js = fs.readFileSync(path.join(root, file), "utf8");
  const mapPath = path.join(root, `${file}.map`);
  if (!fs.existsSync(mapPath)) { total.set(`(no map) ${file}`, js.length); bytes += js.length; continue; }
  const lines = js.split("\n");
  const consumer = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapPath, "utf8")));
  let prev = null;
  const add = (key, n) => { total.set(key, (total.get(key) ?? 0) + n); bytes += n; };
  consumer.eachMapping((m) => {
    if (prev && prev.generatedLine === m.generatedLine) add(clean(prev.source ?? "(unmapped)"), m.generatedColumn - prev.generatedColumn);
    else if (prev) add(clean(prev.source ?? "(unmapped)"), Math.max(0, (lines[prev.generatedLine - 1]?.length ?? 0) - prev.generatedColumn));
    prev = m;
  }, null, SourceMapConsumer.GENERATED_ORDER);
}
console.log(`${args.path} [${bucket}]: ${scripts.size} scripts, ${(bytes / 1024).toFixed(0)} KB minified`);
if (args.files) for (const f of scripts) console.log(`  ${f}`);
const rows = [...total].sort((a, b) => b[1] - a[1]);
const filters = args.grep ? args.grep.split(",") : null;
for (const [source, n] of filters ? rows.filter(([s]) => filters.some((f) => s.includes(f))) : rows.slice(0, Number(args.top ?? 40))) {
  console.log(`${(n / 1024).toFixed(1).padStart(8)} KB  ${source}`);
}
