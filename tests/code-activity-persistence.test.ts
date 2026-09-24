import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { serializeActivity } from "@/lib/chat/run-record";

/*
 * WHAT A CODE TRANSCRIPT KEEPS ACROSS A RELOAD (INV-21).
 *
 * `persistCodeTaskOutcome` (src/lib/code-task-outcome.ts) folds a run's events into
 * one ASSISTANT row, and `serializeActivity` rebuilds that row from a FIELD
 * WHITELIST on the way back out. The trap the whitelist lays is that a field
 * written on one side and not read on the other streams live and then vanishes
 * on reload — silently, and looking exactly like the feature working. The
 * unified diff did exactly that for a while.
 *
 * The whitelist now lives in the pure `src/lib/chat/run-record.ts` (SPEC §2.7),
 * so the read side is tested by running it. The write side and the two readers
 * are server-only or client components, so they are still pinned as text.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const remote = read("src/lib/code-task-outcome.ts");
const hook = read("src/hooks/use-code-session.ts");
const cards = read("src/components/code/code-run-cards.tsx");
const activity = read("src/components/code/code-activity.tsx");

const at = "2026-09-20T10:00:00.000Z";
const reload = (rows: unknown[]) => serializeActivity(JSON.parse(JSON.stringify(rows)));

test("the diff a write row carries survives the read-back whitelist", () => {
  const [row] = reload([{ id: "w1", kind: "write", title: "Edited src/app.ts", createdAt: at, patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b" }])!;
  assert.equal(row.patch, "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+b");
  // And the producer still writes it, under its caps — the whitelist is only
  // half of the round trip.
  assert.match(remote, /const MAX_PERSISTED_PATCH_CHARS = 16_000;/);
  assert.match(remote, /const MAX_PERSISTED_PATCH_BUDGET = 120_000;/);
  assert.match(remote, /\.\.\.\(keep \? \{ patch: keep \} : \{\}\)/);
});

test("a tool row's exit status survives the same way", () => {
  const [ok, failed] = reload([
    { id: "t1", kind: "tool", title: "Ran npm test", createdAt: at, exitCode: 0 },
    { id: "t2", kind: "tool", title: "Ran npm run lint", createdAt: at, exitCode: 2 },
  ])!;
  assert.equal(ok.exitCode, 0, "a zero exit code is a value, not an absence");
  assert.equal(failed.exitCode, 2);
  assert.match(remote, /payloadNum\(event\.payload, "exitCode"\)/, "persistCodeTaskOutcome does not fold exitCode");
  assert.match(hook, /num\(event\.payload, "exitCode"\)/, "the live hook does not fold exitCode");
});

test("the whitelist stays additive: a chat row gains no key it did not have", () => {
  // Both extras are spread in only when present, so a row persisted by the chat
  // pipeline — which never writes either — serialises as before.
  const [row] = reload([{ id: "c1", kind: "context", title: "Reading the conversation context", detail: "4 messages", createdAt: at }])!;
  assert.deepEqual(Object.keys(row).sort(), ["createdAt", "detail", "id", "kind", "title", "url"]);
  assert.equal("patch" in row, false);
  assert.equal("exitCode" in row, false);
  // Malformed extras are dropped, never the row.
  const [bad] = reload([{ id: "w2", kind: "write", title: "Edited", createdAt: at, patch: "", exitCode: "1" }])!;
  assert.equal(bad.patch, undefined);
  assert.equal(bad.exitCode, undefined);
});

test("both readers of the persisted row read the keys by that name", () => {
  // The changed-files card and the inline activity read `patch` at runtime
  // (the chat vocabulary does not declare it), so a rename on the write side
  // would silently empty every diff.
  assert.match(cards, /\(event as \{ patch\?: unknown \}\)\.patch/);
  assert.match(activity, /patch/);
  assert.match(activity, /exitCode/);
});
