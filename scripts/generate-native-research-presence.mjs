import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CONTINUUM_OPTICAL, CONTINUUM_MASTER_PATHS, CONTINUUM_SQUARE_VIEWBOX } from "../src/components/brand/continuum-geometry.ts";

const target = fileURLToPath(new URL("../native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoResearchPresence.swift", import.meta.url));
const [originX, originY] = CONTINUUM_SQUARE_VIEWBOX.split(" ").map(Number);
function coordinates(path, normalize = false) {
  assert.match(path, /^M[-\d. ]+(?:C[-\d. ]+)+Z$/);
  const numbers = path.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert.equal((numbers.length - 2) % 6, 0, "Expected move point followed by cubic segments");
  return numbers.map((n, i) => normalize ? Number((n - (i % 2 === 0 ? originX : originY)).toFixed(4)) : n);
}
const masters = new Map([[0, CONTINUUM_MASTER_PATHS.map(p => coordinates(p.d, true))]]);
for (const size of [16, 20, 24, 32]) {
  assert.equal(CONTINUUM_OPTICAL[size].blades.length, 4);
  masters.set(size, CONTINUUM_OPTICAL[size].blades.map(p => coordinates(p.d)));
}
const generated = Array.from(masters, ([size, blades]) => `        ${size}: [\n${blades.map(points => `            [${points.join(", ")}]`).join(",\n")}\n        ]`).join(",\n");
const source = await readFile(target, "utf8");
const prefix = "    private static let optical: [Int: [[CGFloat]]] = [\n";
const from = source.indexOf(prefix) + prefix.length;
const to = source.indexOf("\n    ]\n}", from);
assert.ok(from >= prefix.length && to > from, "Generated section missing");
const updated = source.slice(0, from) + generated + source.slice(to);
if (process.argv.includes("--check")) {
  assert.equal(source, updated, "Native research geometry drifted; run node scripts/generate-native-research-presence.mjs");
  console.log("Native Research Continuum geometry matches all four web optical masters and the master.");
} else {
  await writeFile(target, updated);
  console.log("Generated Native Research Continuum geometry.");
}
