import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MEMORY_IMPORT_MAX_FACTS,
  MEMORY_IMPORT_PROMPT,
  looksLikeSecret,
  parseImportedMemories,
  reviewImportCandidates,
} from "@/lib/memory-import";
import type { LifecycleEntry } from "@/lib/memory-lifecycle";

/*
 * Importing memory from another assistant.
 *
 * Neither ChatGPT nor Claude exports memory as a file; both will answer a
 * question. So Juno hands the user a prompt, the user pastes the answer back,
 * and a DETERMINISTIC parser turns it into candidates the user reviews. The
 * paste is another product's output and is never put in front of a model —
 * that is the property most of the wiring tests below protect.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

test("a bulleted answer yields its bullets and nothing around them", () => {
  const answer = `Sure! Here's everything I remember about you:

- The user is a product designer in Lisbon.
- The user prefers short answers with examples.
- The user is building a meal-planning app called Pantry.

Let me know if you'd like me to add anything!`;
  assert.deepEqual(parseImportedMemories(answer), [
    "The user is a product designer in Lisbon.",
    "The user prefers short answers with examples.",
    "The user is building a meal-planning app called Pantry.",
  ]);
});

test("numbered lists, stars and round bullets all count", () => {
  const answer = "1. The user likes tea.\n2) The user runs marathons.\n* The user speaks Portuguese.\n• The user uses Figma.";
  assert.deepEqual(parseImportedMemories(answer), [
    "The user likes tea.",
    "The user runs marathons.",
    "The user speaks Portuguese.",
    "The user uses Figma.",
  ]);
});

test("dates and emphasis are stripped; the fact is kept", () => {
  assert.deepEqual(parseImportedMemories("- [2025-03-04] **The user** moved to Porto."), ["The user moved to Porto."]);
  assert.deepEqual(parseImportedMemories("- 2025-03-04: The user adopted a cat."), ["The user adopted a cat."]);
});

test("without bullets, headings, section labels and chatter are dropped", () => {
  const answer = `Here is what I have saved:
# About you
Work:
The user is a staff engineer.
The user prefers dark mode.
I hope this helps!`;
  assert.deepEqual(parseImportedMemories(answer), ["The user is a staff engineer.", "The user prefers dark mode."]);
});

test("two phrasings of one fact arrive as one candidate", () => {
  // The lifecycle's own normalized form, so the review never offers a
  // duplicate the write path would collapse anyway.
  assert.deepEqual(parseImportedMemories("- The user prefers dark mode.\n- Prefers dark mode."), [
    "The user prefers dark mode.",
  ]);
});

test("stray bullets and numbers are not facts", () => {
  assert.deepEqual(parseImportedMemories("- \n- 42\n- ok\n- The user likes jazz."), ["The user likes jazz."]);
});

test("a Juno export round-trips, and its block-list is not imported as facts", () => {
  const exported = JSON.stringify({
    exportedAt: "2026-09-22T00:00:00Z",
    summary: null,
    memories: [
      { content: "The user likes tea.", kind: "FACT" },
      { content: "The user works at Acme.", kind: "SUPPRESSION" },
      { content: "The user speaks French.", kind: "FACT" },
    ],
  });
  // Importing a suppression as a fact would turn "forget this" into
  // "remember this" — the exact inversion the kind field exists to prevent.
  assert.deepEqual(parseImportedMemories(exported), ["The user likes tea.", "The user speaks French."]);
});

test("a plain JSON array of strings or {text} objects works", () => {
  assert.deepEqual(parseImportedMemories('["The user likes tea.", {"text": "The user owns a bike."}]'), [
    "The user likes tea.",
    "The user owns a bike.",
  ]);
});

test("the list is capped", () => {
  const long = Array.from({ length: MEMORY_IMPORT_MAX_FACTS + 50 }, (_, i) => `- The user owns record number ${i}.`).join("\n");
  assert.equal(parseImportedMemories(long).length, MEMORY_IMPORT_MAX_FACTS);
});

test("the prompt asks for exactly the shape the parser reads", () => {
  assert.match(MEMORY_IMPORT_PROMPT, /One fact per line, each line starting with "- "/);
  assert.match(MEMORY_IMPORT_PROMPT, /third person, starting with "The user"/);
  assert.match(MEMORY_IMPORT_PROMPT, /No headings/);
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("a password, key or card number is recognised as a secret", () => {
  for (const line of [
    "The user's Wi-Fi password is hunter2.",
    "The user's API key: sk-proj-abcdefghijklmnop1234",
    "The user's PIN is 4821.",
    "The user's card number is 4111 1111 1111 1111.",
    "The user keeps ghp_abcdefghijklmnopqrstuvwxyz0123 in their notes.",
  ]) {
    assert.equal(looksLikeSecret(line), true, line);
  }
});

test("mentioning passwords is not having one", () => {
  for (const line of [
    "The user prefers passkeys over passwords.",
    "The user is building a password manager.",
    "The user uses 1Password.",
    "The user's favourite token is the Ethereum logo.",
  ]) {
    assert.equal(looksLikeSecret(line), false, line);
  }
});

// ---------------------------------------------------------------------------
// The review
// ---------------------------------------------------------------------------

const known: LifecycleEntry = {
  id: "k",
  content: "The user likes tea.",
  normalized: null,
  category: "preferences",
  projectId: null,
  source: "AUTO",
  kind: "FACT",
  confidence: 0.7,
  status: "active",
  expiresAt: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const review = (allowed: string[] = []) =>
  reviewImportCandidates(
    [
      "The user speaks Portuguese.",
      "The user likes tea.",
      "The user works at Acme.",
      "The user has ADHD.",
      "The user's Wi-Fi password is hunter2.",
    ],
    { entries: [known], suppressions: ["The user works at Acme."], allowedSensitiveTopics: allowed }
  );

test("a new fact starts ticked", () => {
  const row = review().find((c) => c.content === "The user speaks Portuguese.");
  assert.equal(row?.status, "new");
  assert.equal(row?.selected, true);
});

test("a fact Juno already knows starts unticked", () => {
  const row = review().find((c) => c.content === "The user likes tea.");
  assert.equal(row?.status, "known");
  assert.equal(row?.selected, false);
});

test("a statement the user asked to forget is marked, and cannot start ticked", () => {
  const row = review().find((c) => c.content === "The user works at Acme.");
  assert.equal(row?.status, "forgotten");
  assert.equal(row?.selected, false);
});

test("a sensitive fact starts unticked unless its topic is opted in", () => {
  const off = review().find((c) => c.content === "The user has ADHD.");
  assert.equal(off?.sensitive, "health");
  assert.equal(off?.selected, false);
  const on = review(["health"]).find((c) => c.content === "The user has ADHD.");
  assert.equal(on?.selected, true);
});

test("a secret is marked and never starts ticked, even when nothing else applies", () => {
  const row = review().find((c) => c.content.includes("hunter2"));
  assert.equal(row?.status, "secret");
  assert.equal(row?.selected, false);
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the paste is never sent to a model", () => {
  // The whole design rests on this: another product's output, parsed by rules,
  // never put in front of a model where a line in it could act as an order.
  for (const path of ["src/lib/memory-import.ts", "src/app/api/memory/import/preview/route.ts"]) {
    const body = src(path);
    for (const forbidden of ["runUtilityPrompt", "streamChat", "@/lib/llm", "utilityCompletion"]) {
      assert.equal(body.includes(forbidden), false, `${path} reaches a model via ${forbidden}`);
    }
  }
});

test("the preview writes nothing", () => {
  const body = src("src/app/api/memory/import/preview/route.ts");
  assert.equal(/\.(create|update|upsert|delete)(Many)?\(/.test(body), false);
});

test("the commit is MANUAL, traceable, and drops secrets again server-side", () => {
  const body = src("src/app/api/memory/import/route.ts");
  assert.match(body, /saveCandidates\(user\.id, facts, "import", \{ source: "MANUAL" \}\)/);
  assert.match(body, /\.filter\(\(fact\) => !looksLikeSecret\(fact\)\)/);
});

test("an imported fact says where it came from on the memory page", () => {
  assert.match(src("src/components/memory/entry-row.tsx"), /sourceRef === "import"\) return "Imported from another assistant"/);
});
