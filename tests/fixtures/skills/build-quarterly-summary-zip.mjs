// Rebuilds quarterly-summary.zip from the folder beside it, deterministically
// (fixed dates, sorted entries). Run: node tests/fixtures/skills/build-quarterly-summary-zip.mjs
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "quarterly-summary");
const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const zip = new JSZip();
const date = new Date("2026-10-01T00:00:00Z");
for (const path of walk(root).sort()) {
  zip.file(`quarterly-summary/${relative(root, path)}`, readFileSync(path), { date, createFolders: false });
}
writeFileSync(join(here, "quarterly-summary.zip"), await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
console.log("wrote quarterly-summary.zip");
