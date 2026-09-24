/**
 * Run the live provider probes of SPEC §5.7.
 *
 *   npx tsx scripts/probes/run.ts P4 P13     # the named probes
 *   npx tsx scripts/probes/run.ts all        # every probe whose keys are set
 *   npx tsx scripts/probes/run.ts            # the list, and nothing sent
 *
 * OWNER-RUN ONLY, NEVER IN CI: every probe is a real request billed to the
 * account whose key is in the environment (the same env vars the chat
 * adapters read). Each prints its question, what its answer decides, and per
 * request the HTTP status and the start of the body. Keys are never printed.
 *
 * Nothing here changes Juno. A probe's answer is read by a person, who then
 * edits the capability record (`src/lib/model-tools.ts`) and its snapshot test.
 */

import { PROBES, type Probe } from "./probes";
import { MissingKeyError } from "./wire";

/** Enough of a body to read an error, not a whole answer. */
const PRINT_CHARS = 600;

function list(): void {
  console.log("Provider probes (SPEC §5.7). Name one or more, or `all`:\n");
  for (const probe of PROBES) console.log(`  ${probe.id.padEnd(4)} ${probe.question}`);
}

async function runOne(probe: Probe): Promise<void> {
  console.log(`\n── ${probe.id}: ${probe.question}`);
  console.log(`   Decides: ${probe.decides}`);
  try {
    for (const result of await probe.run()) {
      const body = result.body.replace(/\s+/g, " ").slice(0, PRINT_CHARS);
      console.log(`   [${result.status ?? "no response"}] ${result.label}\n      ${body}`);
    }
  } catch (error) {
    if (error instanceof MissingKeyError) console.log(`   skipped — ${error.message}`);
    else throw error;
  }
}

async function main(): Promise<void> {
  const names = process.argv.slice(2).map((name) => name.toUpperCase());
  if (names.length === 0) {
    list();
    return;
  }
  const chosen = names.includes("ALL") ? PROBES : PROBES.filter((probe) => names.includes(probe.id));
  const unknown = names.filter((name) => name !== "ALL" && !PROBES.some((probe) => probe.id === name));
  if (unknown.length) {
    console.error(`Unknown probe: ${unknown.join(", ")}`);
    list();
    process.exitCode = 1;
    return;
  }
  for (const probe of chosen) await runOne(probe);
}

void main();
