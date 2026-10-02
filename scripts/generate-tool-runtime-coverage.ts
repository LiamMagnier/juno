/**
 * Write or check the tool runtime coverage record.
 *
 *   npx tsx scripts/generate-tool-runtime-coverage.ts           # write
 *   npx tsx scripts/generate-tool-runtime-coverage.ts --check   # verify, exit 1 on drift or a broken rule
 *
 * Outputs (never edit the generated parts by hand):
 *   - contracts/capabilities/tool-runtime-coverage.json: every current chat
 *     model × {roundTrip, parallel, toolImages, runCodeE2E, skillE2E} and every
 *     surface × runtime cell. Recorded verdicts are carried over; new models
 *     arrive untested; departed models leave.
 *   - the two tables between the coverage markers in
 *     docs/rework/TOOL_RUNTIME_COVERAGE.md.
 *
 * The rules live in src/lib/tool-runtime-coverage.ts and are also run by
 * tests/tool-runtime-coverage.test.ts, so `npm test` fails when a model is
 * marked compatible without evidence or a current model has no row.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { CURATED_CHAT_MODELS } from "../src/lib/models";
import { providerAdapterFor } from "../src/lib/provider-routing";
import {
  buildCoverage,
  renderCoverageTables,
  spliceGenerated,
  validateCoverage,
  type CatalogModel,
  type ToolRuntimeCoverage,
} from "../src/lib/tool-runtime-coverage";

const root = process.cwd();
const JSON_PATH = resolve(root, "contracts/capabilities/tool-runtime-coverage.json");
const DOC_PATH = resolve(root, "docs/rework/TOOL_RUNTIME_COVERAGE.md");
const check = process.argv.includes("--check");

/** The current selectable chat models, by the catalog's own status. */
export function currentChatCatalog(): CatalogModel[] {
  return CURATED_CHAT_MODELS.filter(
    (m) => (m.status ?? "current") === "current" && ((m as { modality?: string }).modality ?? "chat") === "chat",
  ).map((m) => ({
    id: m.id,
    provider: m.provider,
    adapter: providerAdapterFor(m),
    vision: m.vision,
    agenticTools: m.agenticTools,
  }));
}

function readJson(): ToolRuntimeCoverage | null {
  try {
    return JSON.parse(readFileSync(JSON_PATH, "utf8")) as ToolRuntimeCoverage;
  } catch {
    return null;
  }
}

const catalog = currentChatCatalog();
const previous = readJson();
const next = buildCoverage(catalog, previous);
const json = `${JSON.stringify(next, null, 2)}\n`;
const tables = renderCoverageTables(next);
const docBefore = readFileSync(DOC_PATH, "utf8");
const doc = spliceGenerated(spliceGenerated(docBefore, "models", tables.models), "matrix", tables.matrix);
const problems = validateCoverage(next, catalog);

if (check) {
  const failures: string[] = [...problems];
  if (!previous) failures.push("contracts/capabilities/tool-runtime-coverage.json is missing or not JSON.");
  else if (`${JSON.stringify(previous, null, 2)}\n` !== json) failures.push("tool-runtime-coverage.json is stale: run the generator.");
  if (doc !== docBefore) failures.push("docs/rework/TOOL_RUNTIME_COVERAGE.md tables are stale: run the generator.");
  if (failures.length) {
    for (const f of failures) console.error(`coverage: ${f}`);
    process.exit(1);
  }
  console.log(`Tool runtime coverage holds: ${next.models.length} models, ${next.matrix.length} surface × runtime cells.`);
} else {
  if (problems.length) {
    for (const p of problems) console.error(`coverage: ${p}`);
    process.exit(1);
  }
  writeFileSync(JSON_PATH, json);
  writeFileSync(DOC_PATH, doc);
  console.log(`Wrote ${JSON_PATH} and the tables in ${DOC_PATH} (${next.models.length} models).`);
}
