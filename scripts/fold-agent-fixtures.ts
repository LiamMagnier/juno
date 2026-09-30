/**
 * Write (or check) the `.folded.json` beside every golden agent transcript.
 *
 * Each `contracts/agent/fixtures/<name>.jsonl` is a stream of protocol events
 * as a producer would send them, and `<name>.folded.json` is the session view
 * every reducer of the protocol must produce from it. This script writes the
 * view with the TypeScript reducer (src/lib/agent-protocol/fold.ts); the Swift
 * reducer is then held to the same file by JunoAgentProtocolTests, so the two
 * cannot disagree about what a transcript means.
 *
 * A changed `.folded.json` is a change to what every surface shows — review
 * the diff as one.
 *
 *   npx tsx scripts/fold-agent-fixtures.ts           # write
 *   npx tsx scripts/fold-agent-fixtures.ts --check   # exit 1 on drift
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { agentSessionViewJSON, foldAgentEvents } from "../src/lib/agent-protocol/fold";
import { parseAgentEvent, type ParsedAgentEvent } from "../src/lib/agent-protocol/protocol.generated";

export const AGENT_FIXTURE_DIR = "contracts/agent/fixtures";

/** Transcript fixtures (every `.jsonl` but the command one), by name. */
export function agentTranscriptFixtures(root = process.cwd()): string[] {
  return readdirSync(join(root, AGENT_FIXTURE_DIR))
    .filter((file) => file.endsWith(".jsonl") && file !== "commands.jsonl")
    .map((file) => file.slice(0, -".jsonl".length))
    .sort();
}

/** Each non-empty line of a fixture, parsed as JSON. */
export function fixtureLines(name: string, root = process.cwd()): unknown[] {
  return readFileSync(join(root, AGENT_FIXTURE_DIR, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/** The events a reader keeps from a fixture: everything that parses as one. */
export function fixtureEvents(name: string, root = process.cwd()): ParsedAgentEvent[] {
  return fixtureLines(name, root)
    .map(parseAgentEvent)
    .filter((event): event is ParsedAgentEvent => event !== null);
}

export function renderFolded(name: string, root = process.cwd()): string {
  return `${JSON.stringify(agentSessionViewJSON(foldAgentEvents(fixtureEvents(name, root))), null, 2)}\n`;
}

if (process.argv[1] && resolve(process.argv[1]).endsWith("fold-agent-fixtures.ts")) {
  const check = process.argv.includes("--check");
  const stale: string[] = [];
  for (const name of agentTranscriptFixtures()) {
    const path = join(process.cwd(), AGENT_FIXTURE_DIR, `${name}.folded.json`);
    const next = renderFolded(name);
    if (check) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        current = "";
      }
      if (current !== next) stale.push(`${name}.folded.json`);
    } else {
      writeFileSync(path, next, "utf8");
      console.log(`Wrote ${AGENT_FIXTURE_DIR}/${name}.folded.json`);
    }
  }
  if (stale.length > 0) {
    console.error(
      `[agent-protocol] folded fixtures are stale: ${stale.join(", ")}. Run: npx tsx scripts/fold-agent-fixtures.ts`,
    );
    process.exit(1);
  }
  if (check) console.log("[agent-protocol] every golden transcript folds to its .folded.json.");
}
