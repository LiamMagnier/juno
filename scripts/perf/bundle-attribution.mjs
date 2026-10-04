#!/usr/bin/env node
/**
 * Which source modules make up a route's first-load JavaScript.
 *
 *   ALEVR_BUNDLE_SOURCEMAPS=1 next build
 *   node scripts/perf/bundle-attribution.mjs "/(app)/layout" "/(app)/chat/[id]/page"
 *
 * Reads .next/app-build-manifest.json for each entry's chunks, maps every byte
 * of each minified chunk back to its source file through the chunk's source
 * map, and prints the heaviest sources (minified bytes; gzip is roughly 30% of
 * that for this code). A chunk shared by two entries is counted for both, which
 * is what a first visit to either downloads.
 */
import fs from "node:fs";
import path from "node:path";
import { SourceMapConsumer } from "source-map-js";

const root = path.join(process.cwd(), ".next");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "app-build-manifest.json"), "utf8")).pages;
const entries = process.argv.slice(2);
if (!entries.length) {
  console.log(Object.keys(manifest).filter((k) => k.startsWith("/(app)")).join("\n"));
  process.exit(0);
}

function attribute(file) {
  const js = fs.readFileSync(path.join(root, file), "utf8");
  const mapPath = path.join(root, `${file}.map`);
  const bySource = new Map();
  if (!fs.existsSync(mapPath)) {
    bySource.set(`(no map) ${file}`, js.length);
    return bySource;
  }
  const consumer = new SourceMapConsumer(JSON.parse(fs.readFileSync(mapPath, "utf8")));
  const lines = js.split("\n");
  let prev = null;
  consumer.eachMapping((m) => {
    if (prev && prev.generatedLine === m.generatedLine) {
      const bytes = m.generatedColumn - prev.generatedColumn;
      const key = prev.source ?? "(unmapped)";
      bySource.set(key, (bySource.get(key) ?? 0) + bytes);
    } else if (prev) {
      const bytes = (lines[prev.generatedLine - 1]?.length ?? 0) - prev.generatedColumn;
      const key = prev.source ?? "(unmapped)";
      bySource.set(key, (bySource.get(key) ?? 0) + Math.max(0, bytes));
    }
    prev = m;
  }, null, SourceMapConsumer.GENERATED_ORDER);
  return bySource;
}

const clean = (source) =>
  source
    .replace(/^webpack:\/\/_N_E\//, "")
    .replace(/^\.\//, "")
    .replace(/\?.*$/, "")
    .replace(/^.*node_modules\/((?:@[^/]+\/)?[^/]+).*$/, "npm:$1");

for (const entry of entries) {
  const files = (manifest[entry] ?? []).filter((f) => f.endsWith(".js"));
  const total = new Map();
  let bytes = 0;
  for (const file of files) {
    for (const [source, n] of attribute(file)) {
      const key = clean(source);
      total.set(key, (total.get(key) ?? 0) + n);
      bytes += n;
    }
  }
  console.log(`\n${entry}: ${files.length} chunks, ${(bytes / 1024).toFixed(0)} KB minified`);
  for (const [source, n] of [...total].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP ?? 30))) {
    console.log(`${(n / 1024).toFixed(1).padStart(8)} KB  ${source}`);
  }
}
