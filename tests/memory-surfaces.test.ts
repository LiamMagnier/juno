import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  WORK_MEMORY_MAX_CHARS,
  workMemoryContext,
  workMemoryEnabled,
} from "@/lib/work/memory-context";
import {
  CODING_MEMORY_CATEGORIES,
  foldMemoryIntoPrompt,
  selectCodingMemories,
} from "@/lib/code-memory-prompt";
import type { LifecycleEntry } from "@/lib/memory-lifecycle";

/*
 * Memory beyond chat.
 *
 * Chat read the memory profile on every turn; Work and Code read none of it, so
 * the surfaces doing the longer, more consequential work were the ones working
 * blind. Claude closed the same gap between chat and Cowork in August 2026.
 *
 * The two surfaces get DIFFERENT amounts on purpose, and most of this file is
 * about the difference. Work runs on Juno's own servers and gets the profile a
 * chat gets. Code's prompt is stored on the task row and handed to whatever
 * runs it — on a cloud run, a GitHub Actions machine in the user's repository —
 * so it gets how the user works and what they are building, and nothing about
 * who they are.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// Work
// ---------------------------------------------------------------------------

test("a Work run sees the summary and the ranked notes", () => {
  const body = workMemoryContext({
    summary: "## Work context\nThe user runs a hospital pharmacy team.",
    recent: ["The user writes in British English."],
  });
  assert.match(body ?? "", /hospital pharmacy/);
  assert.match(body ?? "", /More recent notes:\n- The user writes in British English\./);
});

test("notes alone are labelled as notes, not as 'more recent' than nothing", () => {
  assert.equal(workMemoryContext({ summary: null, recent: ["The user prefers one-page reports."] }), "Notes:\n- The user prefers one-page reports.");
});

test("nothing remembered, no block — not a sentence about absence", () => {
  assert.equal(workMemoryContext({ summary: null, recent: [] }), null);
  assert.equal(workMemoryContext({ summary: "   ", recent: ["  "] }), null);
});

test("an oversized profile is cut at a line and says it was cut", () => {
  const huge = Array.from({ length: 400 }, (_, i) => `Line ${i} of a very long consolidated summary.`).join("\n");
  const body = workMemoryContext({ summary: huge, recent: [] }) ?? "";
  assert.ok(body.length < WORK_MEMORY_MAX_CHARS + 200);
  assert.match(body, /\[Cut off here — the rest of what Alevr remembers was left out to keep room for the task\.\]$/);
  // Cut on a line boundary, so no fact ends mid-sentence.
  assert.match(body.split("\n\n[Cut off")[0], /summary\.$/);
});

test("a paused memory keeps Work out of it; a missing settings row does not", () => {
  assert.equal(workMemoryEnabled({ memoryEnabled: false }), false);
  assert.equal(workMemoryEnabled({ memoryEnabled: true }), true);
  // The column defaults to true and the chat bootstrap reads a missing row as
  // enabled — a run must not disagree with the chat about the same account.
  assert.equal(workMemoryEnabled(null), true);
});

test("the runner reads memory inside the untrusted envelope, before the task", () => {
  const runner = src("scripts/work-runner.ts");
  const opening = runner.slice(runner.indexOf("async function openingContext"));
  const fn = opening.slice(0, opening.indexOf("\n}\n"));
  // Memory is a source like the project and the files: it goes through the
  // same loop that wraps every source with `wrapUntrusted`, and the task is
  // appended after all of them.
  assert.match(fn, /const memory = await memorySource\(/);
  assert.match(fn, /if \(memory\) sources\.push\(memory\);/);
  assert.match(fn, /input\.runtime\.wrapUntrusted\(untrustedLabel\(source\.label\), source\.body\)/);
  assert.match(fn, /what Juno\s*"\s*\+\s*"remembers about the user/);
});

test("the runner ranks memory under the run's own provider", () => {
  const runner = src("scripts/work-runner.ts");
  // `same_provider` policies match background work against the provider the
  // user chose; for a run, that is the provider it executes on.
  assert.match(runner, /conversationProvider: input\.provider/);
  assert.match(runner, /provider: choice\.provider,/);
});

test("the runner never lets memory fail a run", () => {
  const runner = src("scripts/work-runner.ts");
  const fn = runner.slice(runner.indexOf("async function memorySource"));
  assert.match(fn.slice(0, 1600), /catch \(error\) \{[\s\S]*return null;/);
});

// ---------------------------------------------------------------------------
// Code — the privacy boundary
// ---------------------------------------------------------------------------

const now = new Date("2026-09-22T12:00:00Z");
let seq = 0;
function fact(content: string, category: string | null, extra: Partial<LifecycleEntry> = {}): LifecycleEntry {
  seq += 1;
  return {
    id: `f${seq}`,
    content,
    normalized: null,
    category,
    projectId: null,
    source: "AUTO",
    kind: "FACT",
    confidence: 0.7,
    status: "active",
    expiresAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    ...extra,
  };
}

const store: LifecycleEntry[] = [
  fact("The user uses pnpm and Vitest.", "workflows"),
  fact("The user prefers small commits with tests.", "preferences"),
  fact("The user is building a meal-planning app called Pantry.", "projects"),
  fact("The user lives in Lisbon.", "identity"),
  fact("The user's partner is called Sam.", "relationships"),
  fact("The user wants to run a marathon.", "goals"),
  fact("The user is studying for the AWS exam.", "studies"),
  fact("The user is flying to Berlin this week.", "temporary"),
  // A coding-category fact that is still sensitive.
  fact("The user prefers dark mode because of migraines.", "preferences"),
  // Right category, wrong scope or state.
  fact("The user uses Bun for the thesis project.", "workflows", { projectId: "thesis" }),
  fact("The user used to use Yarn.", "workflows", { status: "superseded" }),
  fact("The user is pairing on the parser today.", "workflows", { expiresAt: new Date("2026-09-20T00:00:00Z") }),
];

const shown = () => selectCodingMemories(store, { query: "add a pnpm script and tests", now }).map((m) => m.content);

test("Code sees how the user works and what they are building", () => {
  const facts = shown();
  assert.ok(facts.includes("The user uses pnpm and Vitest."));
  assert.ok(facts.includes("The user prefers small commits with tests."));
  assert.ok(facts.includes("The user is building a meal-planning app called Pantry."));
});

test("Code never sees who the user is, the people around them, or their plans", () => {
  const facts = shown().join("\n");
  for (const leak of ["Lisbon", "Sam", "marathon", "AWS exam", "Berlin"]) {
    assert.equal(facts.includes(leak), false, `${leak} reached a Code prompt`);
  }
});

test("a sensitive fact is kept out of Code even in an allowed category", () => {
  assert.equal(shown().some((fact) => /migraine/i.test(fact)), false);
});

test("project-scoped, retired and expired facts never reach Code", () => {
  const facts = shown().join("\n");
  assert.equal(facts.includes("Bun"), false);
  assert.equal(facts.includes("Yarn"), false);
  assert.equal(facts.includes("pairing on the parser"), false);
});

test("the allowed categories are exactly the three coding ones", () => {
  assert.deepEqual([...CODING_MEMORY_CATEGORIES].sort(), ["preferences", "projects", "workflows"]);
});

test("the fold goes after the task, framed as background the task outranks", () => {
  const folded = foldMemoryIntoPrompt("Add a lint script.", ["The user uses pnpm."]);
  assert.ok(folded.startsWith("Add a lint script.\n\n---\n"));
  assert.match(folded, /where it and the task disagree, the task wins/);
  assert.match(folded, /- The user uses pnpm\.$/);
});

test("no facts, or no task, leaves the prompt exactly as it was", () => {
  assert.equal(foldMemoryIntoPrompt("Add a lint script.", []), "Add a lint script.");
  assert.equal(foldMemoryIntoPrompt("", ["The user uses pnpm."]), "");
});

test("the task route folds memory into the AGENT prompt only, never the transcript", () => {
  const route = src("src/app/api/code/tasks/route.ts");
  assert.match(route, /const agentPrompt = foldMemoryIntoPrompt\(/);
  assert.match(route, /await getCodingMemory\(user\.id, prompt\)/);
  // The user's visible message is still the raw composer text.
  assert.match(route, /content: encryptMessageText\(prompt\)/);
});

test("Code's memory is ranked lexically — the task text is not sent to an embeddings provider", () => {
  const body = src("src/lib/memory.ts");
  const fn = body.slice(body.indexOf("export async function getCodingMemory"));
  const scope = fn.slice(0, fn.indexOf("\n}\n"));
  assert.equal(/embedQuery|semanticEvidenceFor|getMemoryProfile/.test(scope), false);
  assert.match(scope, /if \(settings\?\.memoryEnabled === false\) return \[\];/);
});
