import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SUMMARY_MIN_REBUILD_INTERVAL_MS,
  coveredBySummary,
  summaryRebuildDecision,
} from "@/lib/memory-lifecycle";
import {
  PROJECT_SUMMARY_INSTRUCTIONS_CHARS,
  budgetProjectFacts,
  projectConsolidationPrompt,
  projectSummaryIsEmpty,
} from "@/lib/memory-project-summary";
import {
  memoriesInScope,
  memoryScopes,
  parseSummarySections,
  summaryExcerpt,
  type Memory,
} from "@/components/memory/memory-model";
import { buildSystemPromptSections } from "@/lib/chat/system-prompt";

/*
 * Per-project memory.
 *
 * A chat filed in a project reads memory in ISOLATION — only that project's
 * facts — and now its own summary, rebuilt the way the account's is. Almost
 * every test here is a version of one question: does anything learned in one
 * scope reach another? The account summary used to be built from every chat's
 * digest, the extractor used to be shown every project's facts, and an Undo
 * used to restore a project fact account-wide. Each of those was a way out.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const NOW = new Date("2026-09-22T12:00:00Z");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

// ---------------------------------------------------------------------------
// When a summary is rebuilt — one rule for the account and every project
// ---------------------------------------------------------------------------

const built = { entryCount: 4, updatedAt: minutesAgo(60) };
const decide = (overrides: Partial<Parameters<typeof summaryRebuildDecision>[0]>) =>
  summaryRebuildDecision({
    summary: built,
    factCount: 4,
    newestSuppressionAt: null,
    newestExpiryAt: null,
    now: NOW,
    ...overrides,
  });

test("nothing changed, nothing rebuilt", () => {
  assert.equal(decide({}), "fresh");
});

test("a new fact rebuilds; so does a deleted one", () => {
  assert.equal(decide({ factCount: 5 }), "rebuild");
  assert.equal(decide({ factCount: 3 }), "rebuild");
});

test("a forget newer than the summary rebuilds it, though the count never moved", () => {
  assert.equal(decide({ newestSuppressionAt: minutesAgo(10) }), "rebuild");
  assert.equal(decide({ newestSuppressionAt: minutesAgo(120) }), "fresh");
});

test("an expiry after the summary was written rebuilds it", () => {
  assert.equal(decide({ newestExpiryAt: minutesAgo(10) }), "rebuild");
  assert.equal(decide({ newestExpiryAt: minutesAgo(120) }), "fresh");
});

test("a first summary is built as soon as there is a fact", () => {
  assert.equal(decide({ summary: null, factCount: 1 }), "rebuild");
});

test("a scope with no facts is left alone, with or without a summary", () => {
  assert.equal(decide({ summary: null, factCount: 0 }), "fresh");
  assert.equal(decide({ factCount: 0 }), "fresh");
});

test("a burst of turns is one rebuild", () => {
  const recent = { entryCount: 4, updatedAt: minutesAgo(2) };
  assert.equal(decide({ summary: recent, factCount: 5 }), "throttled");
  assert.equal(
    decide({ summary: { entryCount: 4, updatedAt: new Date(NOW.getTime() - SUMMARY_MIN_REBUILD_INTERVAL_MS - 1) }, factCount: 5 }),
    "rebuild"
  );
});

test("the account's rebuild and every project's share that rule", () => {
  const memory = src("src/lib/memory.ts");
  const account = memory.slice(memory.indexOf("export async function maybeConsolidate("));
  const project = memory.slice(memory.indexOf("export async function maybeConsolidateProject("));
  assert.match(account.slice(0, 2400), /summaryRebuildDecision\(/);
  assert.match(project.slice(0, 2400), /summaryRebuildDecision\(/);
});

// ---------------------------------------------------------------------------
// Which facts a summary already says
// ---------------------------------------------------------------------------

test("a summary covers its own scope's facts that existed when it was written — nothing else", () => {
  const summary = { updatedAt: minutesAgo(30) };
  const old = minutesAgo(90);
  const fresh = minutesAgo(5);
  // The account summary.
  assert.equal(coveredBySummary({ projectId: null, createdAt: old }, summary, null), true);
  assert.equal(coveredBySummary({ projectId: null, createdAt: fresh }, summary, null), false);
  assert.equal(coveredBySummary({ projectId: "thesis", createdAt: old }, summary, null), false);
  // A project's summary.
  assert.equal(coveredBySummary({ projectId: "thesis", createdAt: old }, summary, "thesis"), true);
  assert.equal(coveredBySummary({ projectId: "pantry", createdAt: old }, summary, "thesis"), false);
  assert.equal(coveredBySummary({ projectId: null, createdAt: old }, summary, "thesis"), false);
  // No summary covers nothing.
  assert.equal(coveredBySummary({ projectId: null, createdAt: old }, null, null), false);
});

// ---------------------------------------------------------------------------
// The project summary prompt
// ---------------------------------------------------------------------------

const sources = {
  projectName: "Thesis",
  instructions: "Help me write my master's thesis on urban heat islands. ".repeat(40),
  facts: [
    { content: "The thesis uses APA citations.", createdAt: new Date("2026-09-01T00:00:00Z") },
    { content: "The thesis defense is in December.", createdAt: new Date("2026-09-20T00:00:00Z") },
  ],
  digests: ["Restructuring the methodology chapter"],
  suppressions: ["The user works at Acme."],
};
const prompt = projectConsolidationPrompt(sources);

test("the forget list comes first and outranks everything", () => {
  assert.match(prompt.system, /HARD RULE — SUPPRESSED CONTENT/);
  assert.ok(prompt.userMsg.startsWith("SUPPRESSED (never include any of this):\n- The user works at Acme."));
});

test("the model is shown this project's facts, dated, oldest first", () => {
  const facts = prompt.userMsg.split("FACTS (oldest to newest):")[1];
  assert.ok(facts.indexOf("[2026-09-01] The thesis uses APA citations.") < facts.indexOf("[2026-09-20] The thesis defense"));
});

test("its chats' digests ride along, for the thread of the work", () => {
  assert.match(prompt.userMsg, /CHAT DIGESTS:\n- Restructuring the methodology chapter/);
});

test("the instructions are context only, and only their start", () => {
  const line = prompt.userMsg.split("\n").find((l) => l.startsWith("Instructions (context only"));
  assert.ok(line);
  assert.ok(line.length < PROJECT_SUMMARY_INSTRUCTIONS_CHARS + 60);
  assert.match(line, /…$/);
  assert.match(prompt.system, /never restate them/);
});

test("the summary is held to this project's sources and a project's sections", () => {
  assert.match(prompt.system, /Add nothing from outside them/);
  assert.match(prompt.system, /Purpose & context, Decisions & conventions, Current state, Open threads/);
});

test("instructions alone are not memory", () => {
  assert.equal(projectSummaryIsEmpty({ facts: [], digests: [] }), true);
  assert.equal(projectSummaryIsEmpty({ facts: [], digests: ["A chat"] }), false);
});

test("the newest facts win the budget", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({ content: `Fact number ${i}.`, createdAt: minutesAgo(100 - i) }));
  const kept = budgetProjectFacts(many, 45); // three 15-character facts, exactly
  assert.deepEqual(
    kept.map((f) => f.content),
    ["Fact number 7.", "Fact number 8.", "Fact number 9."]
  );
});

// ---------------------------------------------------------------------------
// Isolation in the database half — wiring
// ---------------------------------------------------------------------------

test("a project chat reads its project's summary, never the account's", () => {
  const memory = src("src/lib/memory.ts");
  const fn = memory.slice(memory.indexOf("export async function getMemoryProfile("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /const summaryScope = isolate && projectId \? projectId : null;/);
  assert.match(body, /summaryScope \? getProjectMemorySummary\(userId, summaryScope\) : getMemorySummary\(userId\)/);
  // A forget benches a project's summary exactly as it does the account's.
  assert.match(body, /summaryPredatesForget\(storedSummary\.updatedAt, forgottenAt\)/);
  assert.match(body, /!coveredBySummary\(row, summary, summaryScope\)/);
});

test("the account summary is no longer built from project chats' digests", () => {
  const memory = src("src/lib/memory.ts");
  const fn = memory.slice(memory.indexOf("export async function gatherMemorySources("));
  assert.match(fn.slice(0, 1600), /digest: \{ not: null \}, conversation: \{ projectId: null \}/);
});

test("a project fact changes the project's summary, not the account's", () => {
  const memory = src("src/lib/memory.ts");
  const account = memory.slice(memory.indexOf("export async function maybeConsolidate("));
  assert.match(account.slice(0, 900), /count\(\{ where: \{ userId, kind: "FACT", projectId: null \} \}\)/);
  const consolidate = memory.slice(memory.indexOf("export async function consolidateMemories("));
  assert.match(consolidate, /where: \{ userId: opts\.userId, kind: "FACT", projectId: null \}/);
});

test("the extractor is shown only this scope's facts as 'already known'", () => {
  const memory = src("src/lib/memory.ts");
  assert.match(memory, /where: \{ userId: opts\.userId, kind: "FACT", projectId: convo\.projectId \?\? null \}/);
});

test("a project summary is built from that project only, and sealed at rest", () => {
  const memory = src("src/lib/memory.ts");
  const fn = memory.slice(memory.indexOf("export async function consolidateProjectMemory("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /checkProjectAccess\(userId, projectId, "VIEWER"\)/);
  assert.match(body, /userId,\s+projectId,\s+kind: "FACT",\s+status: "active"/);
  assert.match(body, /conversation: \{ projectId \}/);
  assert.match(body, /const sealed = encryptField\(content\);/);
  assert.match(body, /create: \{ userId, projectId, content: sealed, entryCount: factCount \}/);
  const read = memory.slice(memory.indexOf("export async function getProjectMemorySummary("));
  assert.match(read.slice(0, 500), /content: decryptField\(row\.content\)/);
});

test("the ownership guard and the key rotation both know the new table", () => {
  assert.match(src("src/lib/db.ts"), /\["ProjectMemorySummary", "userId"\]/);
  assert.match(src("scripts/rotate-message-keys.ts"), /rotateTextColumn\("ProjectMemorySummary\.content"/);
});

test("the chat turn and the dreamer both keep project summaries current", () => {
  assert.match(
    src("src/app/api/chat/route.ts"),
    /if \(conversation\.projectId\) \{\s+await maybeConsolidateProject\(user\.id, conversation\.projectId, modelInfo\.provider\)/
  );
  assert.match(src("src/lib/memory-dreamer.ts"), /await maybeConsolidateProject\(userId, projectId, null\)/);
});

test("a reset erases every project's summary with the facts it was built from", () => {
  const route = src("src/app/api/memory/route.ts");
  const reset = route.slice(route.indexOf("export async function DELETE"));
  assert.match(reset, /prisma\.projectMemorySummary\.deleteMany\(\{ where: \{ userId: user\.id \} \}\)/);
});

test("the account export hands project summaries back in cleartext", () => {
  const route = src("src/app/api/account/export/route.ts");
  assert.match(route, /projectMemorySummaries: projectMemorySummaries\.map/);
  assert.match(route, /content: decryptField\(summary\.content\)/);
});

test("editing, forgetting, deleting or moving a fact rebuilds every scope it touched", () => {
  const route = src("src/app/api/memory/[id]/route.ts");
  assert.match(route, /refreshSummariesLater\(user\.id, \[null, existing\.projectId\]\)/);
  assert.match(
    route,
    /refreshSummariesLater\(user\.id, \[existing\.projectId, moved \? body\.projectId \?\? null : existing\.projectId\]\)/
  );
  assert.match(route, /refreshSummariesLater\(user\.id, \[existing\.projectId\]\)/);
});

test("undoing a removed project fact restores it to its project, not account-wide", () => {
  const apply = src("src/app/api/memory/edit/apply/route.ts");
  assert.match(apply, /\.\.\.\(row\.kind === "FACT" && row\.projectId \? \{ projectId: row\.projectId \} : \{\}\)/);
  assert.match(apply, /projectId: op\.suppress \? null : op\.projectId \?\? null/);
  // A scope is a claim until the project is shown to be usable.
  assert.match(apply, /checkProjectAccess\(user\.id, projectId, "VIEWER"\)/);
  // The ledger stores what the apply route replays — zod strips unknown keys,
  // so a scope missing here would be silently dropped between Undo and apply.
  assert.match(src("src/app/api/memory/edits/ledger.ts"), /projectId: z\.string\(\)\.min\(1\)\.nullish\(\)/);
});

test("the project memory route checks access, then reads only the caller's rows", () => {
  const route = src("src/app/api/projects/[id]/memory/route.ts");
  assert.match(route, /checkProjectAccess\(user\.id, projectId, "VIEWER"\)/);
  assert.match(route, /userId,\s+projectId: id,\s+kind: "FACT" as const/);
  assert.match(route, /getProjectMemorySummary\(userId, id\)/);
});

test("the project page shows this project's memory, never the account's", () => {
  const page = src("src/app/(app)/projects/[id]/page.tsx");
  assert.match(page, /fetch\(`\/api\/projects\/\$\{encodeURIComponent\(id\)\}\/memory`\)/);
  assert.equal(/fetch\("\/api\/memory"\)/.test(page), false);
});

// ---------------------------------------------------------------------------
// The prompt names whose memory it is
// ---------------------------------------------------------------------------

test("a project chat is told its memory is the project's", () => {
  const base = { memoryEnabled: true, canvas: false, memorySummary: "## Purpose & context\nA thesis." };
  const project = buildSystemPromptSections({ ...base, memoryScope: "project" }).variable;
  const account = buildSystemPromptSections({ ...base, memoryScope: "account" }).variable;
  assert.match(project, /# What you already know from this project's chats\n## Purpose & context/);
  assert.match(account, /# What you already know about this user\n/);
  const notesOnly = buildSystemPromptSections({ memoryEnabled: true, canvas: false, memories: ["The thesis uses APA."], memoryScope: "project" }).variable;
  assert.match(notesOnly, /# What you already remember from this project's chats\n- The thesis uses APA\./);
});

// ---------------------------------------------------------------------------
// The memory page's scopes
// ---------------------------------------------------------------------------

let seq = 0;
function mem(content: string, extra: Partial<Memory> = {}): Memory {
  seq += 1;
  return {
    id: `m${seq}`,
    content,
    source: "AUTO",
    kind: "FACT",
    sourceRef: null,
    createdAt: "2026-09-01T00:00:00Z",
    category: "preferences",
    projectId: null,
    projectName: null,
    sourceMessageId: null,
    confidence: 0.7,
    status: "active",
    reason: null,
    expiresAt: null,
    lastUsedAt: null,
    lastVerifiedAt: null,
    supersededById: null,
    sensitive: null,
    ...extra,
  };
}

const rows: Memory[] = [
  mem("The user likes tea."),
  mem("The user prefers short answers."),
  mem("The thesis uses APA.", { projectId: "thesis", projectName: "Thesis" }),
  mem("The defense is in December.", { projectId: "thesis", projectName: "Thesis" }),
  mem("Pantry uses Postgres.", { projectId: "pantry", projectName: "Pantry" }),
  // Retired — a chip, but no count.
  mem("Old plan for the garden.", { projectId: "garden", projectName: "Garden", status: "superseded" }),
  mem("The user works at Acme.", { kind: "SUPPRESSION", category: "suppression" }),
];

test("everything comes first, then projects, most-remembered first", () => {
  const scopes = memoryScopes(rows, [
    { projectId: "notes", projectName: "Notes", content: "## Current state\nDrafting.", updatedAt: "2026-09-20T00:00:00Z", entryCount: 0 },
  ]);
  assert.deepEqual(
    scopes.map((s) => [s.id, s.label, s.count]),
    [
      [null, "Everything", 5],
      ["thesis", "Thesis", 2],
      ["pantry", "Pantry", 1],
      // Every fact retired, and a summary with no facts: both still get a chip.
      ["garden", "Garden", 0],
      ["notes", "Notes", 0],
    ]
  );
});

test("an account with no project memory gets no scope row at all", () => {
  assert.equal(memoryScopes([mem("The user likes tea.")], []).length, 1);
});

test("a project's slice is its facts plus the account-wide block-list", () => {
  const thesis = memoriesInScope(rows, "thesis");
  assert.deepEqual(
    thesis.map((m) => m.content),
    ["The thesis uses APA.", "The defense is in December.", "The user works at Acme."]
  );
  assert.equal(memoriesInScope(rows, null).length, rows.length);
});

// ---------------------------------------------------------------------------
// The rail's glimpse
// ---------------------------------------------------------------------------

test("the glimpse is the first section, as plain text", () => {
  const md = "## Purpose & context\nA **master's thesis** on [urban heat](https://x.test) islands.\n\n## Current state\nDrafting chapter 3.";
  assert.equal(summaryExcerpt(md), "A master's thesis on urban heat islands.");
});

test("a long glimpse is cut at a word, with an ellipsis", () => {
  const md = `## Purpose & context\n${"word ".repeat(100)}`;
  const glimpse = summaryExcerpt(md, 60);
  assert.ok(glimpse.length <= 60);
  assert.match(glimpse, /word…$/);
});

test("text before the first heading is named for its summary", () => {
  assert.equal(parseSummarySections("A thesis.", "About this project")[0].title, "About this project");
  assert.equal(parseSummarySections("Likes tea.")[0].title, "About you");
});
