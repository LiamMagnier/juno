import { spawn } from "node:child_process";
import process from "node:process";

/*
 * Every web → native sync gate from spec §A4 that runs without Xcode, in one
 * run, reporting every outcome (the pattern of check-native-design.mjs: a
 * chain would stop at the first red and hide the rest).
 *
 * These are the Linux half of the mechanism, and each is also its own named
 * step in .github/workflows/native.yml (`contract` job) or native-parity.yml.
 * The Swift half — that the apps *read* what these gates keep fresh — is
 * `npm run native:consumption:test` (JunoTokenConsumptionTests and friends),
 * which needs a Mac.
 *
 *   npm run native:sync:check
 */

const GATES = [
  // The generated Swift API contract matches contracts/openapi/juno-native-v1.yaml.
  "native:contract:check",
  // The capability and Work contracts' generated Swift.
  "capabilities:check",
  "work:contract:check",
  // globals.css + tailwind.config.ts → JunoGeneratedTokens.swift.
  "design:tokens:check",
  // The web's icon registries → both apps' symbol catalogs and JunoIcon.
  "native:icons:check",
  // The Design document's zod schemas → contracts/design JSON Schema.
  "design:contract:check",
  // The Design editor bundle the Mac hosts is stamped with its sources' hash.
  "design:editor:check",
  // A change to a web file the apps mirror carries "native: done" / "native: n/a".
  "native:parity:label",
];

const results = [];
for (const gate of GATES) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", "--silent", gate], { cwd: process.cwd(), stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  results.push({ gate, code });
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
  console.error(
    `\n  ✗ [native-sync] ${failed.length} of ${GATES.length} gate(s) failed: `
      + `${failed.map((result) => result.gate).join(", ")}\n`,
  );
  process.exit(1);
}

console.log(`\n[native-sync] all ${GATES.length} gates hold: ${GATES.join(", ")}.`);
