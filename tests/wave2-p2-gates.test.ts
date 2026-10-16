import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

/**
 * P2's e2e gate list (spec §9, P2 acceptance: "This package's gates.ts
 * enforces the galaxy-cap and CVD gates"). P0's registry parses
 * e2e/wave2/<pkg>/gates.ts as text, so it must stay a literal list of catalog
 * ids; an unknown id turns the whole runner red once the branches meet. Also
 * checks P2's enforce file names every file the package owns.
 */

function enforcedIds(): string[] {
  const source = readFileSync(resolve(process.cwd(), "e2e/wave2/p2-foundations/gates.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const match = /export\s+const\s+enforce\b[^=]*=\s*\[([^\]]*)\]/.exec(source);
  assert.ok(match, "gates.ts must export `enforce` as an array literal");
  assert.equal(match[1].replace(/(["'`])([^"'`\\]*)\1/g, "").replace(/[\s,]/g, ""), "", "only string literals");
  return [...match[1].matchAll(/(["'`])([^"'`\\]*)\1/g)].map((m) => m[2]);
}

test("P2 enforces exactly the galaxy-cap and CVD gates", () => {
  assert.deepEqual(enforcedIds().sort(), ["a11y.cvd-status-shapes", "motion.galaxy-cap"]);
});

test("when P0's catalog is present, every enforced id is in it", (t) => {
  const budgets = resolve(process.cwd(), "e2e/support/budgets.ts");
  if (!existsSync(budgets)) {
    t.skip("e2e/support/budgets.ts (P0) is not on this branch");
    return;
  }
  const catalog = readFileSync(budgets, "utf8");
  for (const id of enforcedIds()) assert.ok(catalog.includes(`id: "${id}"`), `"${id}" is not in e2e/support/budgets.ts`);
});

test("eslint-rules/enforce/p2.json lists every file P2 owns and none it does not", () => {
  const data = JSON.parse(readFileSync(resolve(process.cwd(), "eslint-rules/enforce/p2.json"), "utf8")) as { package: string; web: string[]; native: string[] };
  assert.equal(data.package, "p2");
  for (const owned of [
    "src/lib/motion.ts",
    "src/lib/interaction.ts",
    "src/lib/perf-marks.ts",
    "src/lib/view-transition.ts",
    "src/lib/sheet-gesture.ts",
    "src/lib/ui-prefs.ts",
    "src/lib/composer-keys.ts",
    "src/hooks/use-first-visit.ts",
    "src/hooks/use-insert-hold.ts",
    "src/hooks/use-composer-height.ts",
    "src/hooks/use-keyboard-inset.ts",
    "src/hooks/use-modifier-key-label.ts",
    "src/components/brand/**",
    "src/components/approvals/**",
    "src/components/app/page-transition.tsx",
    "src/components/providers.tsx",
    "src/components/ui/sheet.tsx",
    "src/components/ui/user-bubble.tsx",
  ]) {
    assert.ok(data.web.includes(owned), `${owned} is not enforced`);
  }
  assert.ok(!data.web.some((g) => g.includes("composer-shell")), "composer-shell.tsx belongs to P5");
  for (const glob of data.web) {
    if (glob.includes("*")) continue;
    assert.ok(existsSync(resolve(process.cwd(), glob)), `${glob} does not exist`);
  }
});
