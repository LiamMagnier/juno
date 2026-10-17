// The gate registry's command line (spec §9, §14, P0 (4) and (8)).
//
//   npx tsx scripts/qa/gates.ts list                    every gate, its owner and its live mode
//   npx tsx scripts/qa/gates.ts evaluate [--require-enforced] <dir>...
//                                                       apply modes to result files; exit 1 on an enforced failure
//                                                       (--require-enforced: also on an enforced gate with no result,
//                                                       for full runs such as CI's summary job)
//   npx tsx scripts/qa/gates.ts readme [--write]        check (or rewrite) the table in scripts/qa/README.md
//   npx tsx scripts/qa/gates.ts parity --out <results> <geometry dir>...
//                                                       combine web and native geometry exports into one
//                                                       design.bubble-composer-parity result (CI's summary job)
//   --root <dir>                                        read e2e/wave2/*/gates.ts under another root (fixtures)
//
// `evaluate` is what run-prod-e2e.sh and design-gates.yml call after the tests:
// report-only failures print as warnings and keep the exit code 0; a failure
// of a gate some package enforces, or a misconfigured gates.ts, exits 1.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GATES, gateById, type GateDefinition } from "../../e2e/support/budgets";
import { evaluateMeasurement, evaluateResults, formatSummary, loadGateConfig, readResults, repoRoot } from "../../e2e/support/gates";
import { evaluateParity, readGeometryRecords } from "../../e2e/support/parity";
import { renderReadme, stateOf } from "./lib/gate-table";

function main(argv: string[]): number {
  let root = repoRoot();
  const args: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") root = path.resolve(argv[++i] ?? ".");
    else args.push(argv[i]);
  }
  const [command, ...rest] = args;
  const config = loadGateConfig(root);

  if (command === "list") {
    for (const gate of GATES as readonly GateDefinition[]) {
      console.log(`${gate.id.padEnd(32)} ${stateOf(config, gate).padEnd(28)} owner ${gate.owners.join(", ")}  ${gate.budget}`);
    }
    for (const error of config.errors) console.error(`ERROR ${error}`);
    return config.errors.length ? 1 : 0;
  }

  if (command === "evaluate") {
    const requireEnforced = rest.includes("--require-enforced");
    const dirs = rest.filter((arg) => arg !== "--require-enforced");
    if (dirs.length === 0) {
      console.error("evaluate needs at least one results directory.");
      return 64;
    }
    const { results, errors } = readResults(dirs.map((dir) => path.resolve(dir)));
    const summary = evaluateResults(config, results, errors, { requireEnforced });
    console.log(formatSummary(summary));
    const out = path.resolve(dirs[0], "summary.json");
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          exitCode: summary.exitCode,
          errors: summary.errors,
          gates: summary.gates.filter((g) => g.status !== "unmeasured").map((g) => ({
            id: g.id,
            mode: g.mode,
            enforcedBy: g.enforcedBy,
            status: g.status,
            results: g.results.map((r) => ({ pass: r.pass, observed: r.observed, stat: r.stat, detail: r.detail, stats: r.stats, context: r.context })),
          })),
        },
        null,
        2
      )}\n`
    );
    return summary.exitCode;
  }

  if (command === "readme") {
    const file = path.join(root, "scripts", "qa", "README.md");
    const current = readFileSync(file, "utf8");
    const next = renderReadme(current, config);
    if (rest.includes("--write")) {
      if (next !== current) writeFileSync(file, next);
      console.log(next === current ? "scripts/qa/README.md is up to date." : "Rewrote the gate table in scripts/qa/README.md.");
      return 0;
    }
    if (next !== current) {
      console.error("scripts/qa/README.md's gate table is stale. Run: npx tsx scripts/qa/gates.ts readme --write");
      return 1;
    }
    console.log("scripts/qa/README.md's gate table is current.");
    return 0;
  }

  if (command === "parity") {
    const outIndex = rest.indexOf("--out");
    const out = outIndex >= 0 ? rest[outIndex + 1] : undefined;
    const dirs = rest.filter((_, i) => i !== outIndex && i !== outIndex + 1);
    if (!out || dirs.length === 0) {
      console.error("parity needs --out <results dir> and at least one geometry directory.");
      return 64;
    }
    const records = dirs.flatMap((dir) => readGeometryRecords(path.resolve(dir)));
    if (records.length === 0) {
      console.log("parity: no geometry exports found; nothing to combine.");
      return 0;
    }
    const parity = evaluateParity(records);
    const gate = gateById("design.bubble-composer-parity");
    if (!gate) throw new Error("design.bubble-composer-parity is missing from the catalog.");
    const result = evaluateMeasurement(gate, {
      pass: parity.pass,
      detail: parity.pass ? `${parity.contexts.length} contexts conform` : parity.mismatches.join("; "),
      context: { contexts: parity.contexts.join(", "), source: "combined web and native exports" },
    });
    const dir = path.resolve(out, "design.bubble-composer-parity");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "combined.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`parity: ${parity.contexts.join(", ")}: ${result.detail}`);
    return 0;
  }

  console.error("usage: gates.ts list | evaluate [--require-enforced] <dir>... | readme [--write] | parity --out <dir> <dir>...  [--root <dir>]");
  return 64;
}

process.exitCode = main(process.argv.slice(2));
