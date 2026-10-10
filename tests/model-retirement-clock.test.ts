import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { CURATED_CHAT_MODELS, CURATED_GEN_MODELS, RETIRED_MODELS } from "@/lib/models";

/*
 * A retirement date must never break a deploy weeks after the commit that set
 * it. On 2026-10-09 three Qwen rows reached their retiresOn, MODEL_LIST
 * dropped them by the clock, and two pinned suites failed although no code
 * had changed. These tests move the catalogue's clock (JUNO_CATALOG_TODAY,
 * which MODEL_LIST is filtered by at import) forward in a child process and
 * run the suites that pin models, so a date set today is proven harmless for
 * the day it arrives.
 */

const ROWS = [...CURATED_CHAT_MODELS, ...CURATED_GEN_MODELS];

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function atDay(day: string, script: string): unknown {
  const r = spawnSync("npx", ["tsx", "-e", script], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, JUNO_CATALOG_TODAY: day } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split("\n").pop()!);
}

test("MiMo V2.5 Pro leaves the pickers on Oct 14 (Xiaomi answers it with V2.6 Pro from then) and stored ids follow", () => {
  const probe = `import { MODEL_LIST, migrateModelId, resolveModel } from "./src/lib/models";
    const id = "mimo:mimo-v2.5-pro";
    console.log(JSON.stringify({ listed: MODEL_LIST.some((m) => m.id === id), migrated: migrateModelId(id), resolved: resolveModel(id)?.id }));`;
  const row = ROWS.find((m) => m.id === "mimo:mimo-v2.5-pro");
  if (row) {
    assert.equal(row.retiresOn, "2026-10-13", "the last day Xiaomi serves it as itself");
    assert.deepEqual(atDay("2026-10-13", probe), { listed: true, migrated: "mimo:mimo-v2.5-pro", resolved: "mimo:mimo-v2.5-pro" });
  } else {
    // models:sync has since moved it into RETIRED_MODELS.
    assert.equal(RETIRED_MODELS["mimo:mimo-v2.5-pro"], "mimo:mimo-v2.6-pro");
  }
  assert.deepEqual(atDay("2026-10-14", probe), { listed: false, migrated: "mimo:mimo-v2.6-pro", resolved: "mimo:mimo-v2.6-pro" });
});

/** Every suite that names catalogue models. A new one belongs here. */
const PINNED_SUITES = [
  "tests/model-tool-capabilities.test.ts",
  "tests/lab-web-search.test.ts",
  "tests/model-catalog-selection.test.ts",
  "tests/model-catalog-curated.test.ts",
  "tests/model-catalog-fidelity.test.ts",
  "tests/native-model-catalog.test.ts",
  "tests/september-22-models.test.ts",
  "tests/free-default-model.test.ts",
  "tests/auto-model.test.ts",
  "tests/work-models.test.ts",
  "tests/model-display-order.test.ts",
  "tests/model-reasoning-capabilities.test.ts",
  "tests/code-v2-picker-catalogue.test.ts",
  "tests/code-v2-contracts.test.ts",
  "tests/code-v2-context-tiers.test.ts",
  "tests/model-ultrafast.test.ts",
];

test("the pinned model suites pass on the day after the last scheduled retirement", { timeout: 600_000 }, () => {
  const last = ROWS.map((m) => m.retiresOn).filter((d): d is string => !!d).sort().pop();
  if (!last) return; // nothing is scheduled to retire
  const after = addDays(last, 1);
  const r = spawnSync("npx", ["tsx", "--test", ...PINNED_SUITES], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, JUNO_CATALOG_TODAY: after },
  });
  const failing = (r.stdout + r.stderr).split("\n").filter((line) => line.startsWith("✖")).slice(0, 20);
  assert.equal(r.status, 0, `on ${after} (the day after ${last}):\n${failing.join("\n")}`);
});
