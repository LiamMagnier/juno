import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * P1's e2e gate list must name catalog gates. P0's registry parses
 * e2e/wave2/<pkg>/gates.ts as text and reports an error for every id that is
 * not in e2e/support/budgets.ts, which turns the whole runner red for every
 * package once the branches meet.
 */

const P1_CATALOG_GATES = ["design.contrast-matrix", "design.lint"];

function enforcedIds(): string[] {
  const source = readFileSync(resolve(process.cwd(), "e2e/wave2/p1-pipeline/gates.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const match = /export\s+const\s+enforce\b[^=]*=\s*\[([^\]]*)\]/.exec(source);
  assert.ok(match, "gates.ts must export `enforce` as an array literal");
  const ids = [...match[1].matchAll(/(["'`])([^"'`\\]*)\1/g)].map((m) => m[2]);
  assert.equal(match[1].replace(/(["'`])([^"'`\\]*)\1/g, "").replace(/[\s,]/g, ""), "", "only string literals");
  return ids;
}

test("P1 enforces only the catalog gates it owns", () => {
  const ids = enforcedIds();
  assert.ok(ids.length > 0);
  for (const id of ids) assert.ok(P1_CATALOG_GATES.includes(id), `"${id}" is not a P1 catalog gate`);
});

test("when P0's catalog is present, every enforced id is in it", async (t) => {
  const budgets = resolve(process.cwd(), "e2e/support/budgets.ts");
  if (!existsSync(budgets)) {
    t.skip("e2e/support/budgets.ts (P0) is not on this branch");
    return;
  }
  const catalog = readFileSync(budgets, "utf8");
  for (const id of enforcedIds()) assert.ok(catalog.includes(`id: "${id}"`), `"${id}" is not in e2e/support/budgets.ts`);
});
