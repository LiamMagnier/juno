import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * A note the person pressed "Forget this" on is gone from everything a model
 * can see.
 *
 * "Forget this" is a soft delete (`deleteAgentNote` stamps `deletedAt`, so
 * Undo can bring the note back), which makes forgetting a property of every
 * READ rather than of the delete: one query that leaves out `deletedAt: null`
 * quietly keeps feeding the agent what it was told to forget. That is exactly
 * what `scripts/work-runner.ts` did — chat turns, reflection and the profile
 * all filtered, and the agent's autonomous runs read every note it had ever
 * been given. Nothing in the product shows the failure: the run just knows
 * something it should not.
 *
 * `scripts/work-runner.ts` imports "server-only" and cannot be imported here,
 * and neither can the store without a database, so this reads the source, in
 * the style of tests/field-encryption-coverage.test.ts: every `agentNote` read
 * under src/ and scripts/ must say `deletedAt: null` in its own arguments.
 */
const ROOT = fileURLToPath(new URL("../", import.meta.url));

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

/** Every .ts/.tsx file under `dir`, skipping node_modules and build output. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

/**
 * Reads that are allowed to see forgotten notes, and why. None of them builds
 * a prompt or answers a request.
 */
const SEES_FORGOTTEN: Record<string, string> = {
  // Key rotation re-seals every row, forgotten ones included: a forgotten note
  // left under a retired key would become unreadable to Undo.
  "scripts/rotate-message-keys.ts": "re-encrypts every row",
};

const READ = /\bagentNote\s*\.\s*(findMany|findFirst|findFirstOrThrow|findUnique|findUniqueOrThrow|count|aggregate|groupBy)\s*\(/g;

/** The text between a call's opening paren and its matching close. */
function callArguments(text: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(openParen + 1, i);
    }
  }
  throw new Error("unbalanced call");
}

function noteReads() {
  const reads: Array<{ file: string; line: number; method: string; args: string }> = [];
  for (const file of [...walk("src"), ...walk("scripts")]) {
    const text = source(file);
    for (const match of text.matchAll(READ)) {
      const at = match.index ?? 0;
      reads.push({
        file,
        line: text.slice(0, at).split("\n").length,
        method: match[1],
        args: callArguments(text, at + match[0].length - 1),
      });
    }
  }
  return reads;
}

test("every read of an agent's notes leaves out the ones it was told to forget", () => {
  const reads = noteReads();
  // Not vacuous: the store (profile, chat turn, list, count, edit), reflection
  // and the Work runner all read notes today.
  assert.ok(reads.length >= 6, `expected at least six AgentNote reads, found ${reads.length}`);
  const offenders = reads
    .filter((read) => !(read.file in SEES_FORGOTTEN))
    .filter((read) => !/\bdeletedAt:\s*null\b/.test(read.args))
    .map((read) => `${read.file}:${read.line} agentNote.${read.method}`);
  assert.deepEqual(offenders, [], "these AgentNote reads would hand forgotten notes back");
});

test("the Work runner's identity block reads only notes that are still kept", () => {
  // Named on its own because it is the reader that got it wrong: the notes an
  // agent's autonomous run opens with, next to its brief and goals.
  const runner = noteReads().filter((read) => read.file === "scripts/work-runner.ts");
  assert.equal(runner.length, 1, "expected exactly one AgentNote read in the runner");
  assert.match(runner[0].args, /userId: input\.userId/);
  assert.match(runner[0].args, /agentId: input\.session\.agentId/);
  assert.match(runner[0].args, /deletedAt: null/);
});

test("forgetting stays a soft delete that every reader has to honour", () => {
  // If this ever becomes a hard delete the filter above is belt and braces;
  // while it is a soft delete, it is the only thing that makes "Forget" true.
  const store = source("src/lib/agents/store.ts");
  const forget = store.slice(store.indexOf("export async function deleteAgentNote"));
  assert.match(forget, /agentNote\.updateMany\(\{[\s\S]*?data: \{ deletedAt: new Date\(\) \}/);
});
