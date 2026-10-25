import test from "node:test";
import assert from "node:assert/strict";
import {
  importedSourceRef,
  memoryHistory,
  memoryProvenance,
  memorySourceKind,
  provenanceDate,
  type HistoryEntry,
  type ProvenanceEntry,
} from "@/lib/memory-provenance";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Why, when and from where (src/lib/memory-provenance.ts): the one reading of
 * a fact's provenance columns, and the supersession trail through it.
 *
 * The defect this replaces: the memory page dated every fact by when Juno
 * wrote it down, so a fact re-read out of a year-old chat said "learned
 * today", and a fact's source was never named — only "From a chat".
 */

const SAID = new Date("2025-11-03T09:00:00Z");
const NOTED = new Date("2026-10-20T10:00:00Z");
const NOW = new Date("2026-10-25T12:00:00Z");

function entry(extra: Partial<ProvenanceEntry> = {}): ProvenanceEntry {
  return {
    id: "m1",
    content: "The user lives in Porto.",
    source: "AUTO",
    kind: "FACT",
    sourceRef: "conv-1",
    sourceMessageId: "msg-1",
    category: "identity",
    projectId: null,
    confidence: 0.7,
    status: "active",
    reason: null,
    expiresAt: null,
    lastUsedAt: null,
    lastVerifiedAt: NOTED,
    supersededById: null,
    createdAt: NOTED,
    observedAt: SAID,
    ...extra,
  };
}

test("source kinds: words are sources, anything else is a chat id", () => {
  assert.equal(memorySourceKind({ sourceRef: "manual" }), "manual");
  assert.equal(memorySourceKind({ sourceRef: "edit" }), "edit");
  assert.equal(memorySourceKind({ sourceRef: "native" }), "native");
  assert.equal(memorySourceKind({ sourceRef: "import" }), "import");
  assert.equal(memorySourceKind({ sourceRef: "forget" }), "forget");
  assert.equal(memorySourceKind({ sourceRef: "cm9x0abc" }), "chat");
  assert.equal(memorySourceKind({ sourceRef: null }), "unknown");
  assert.equal(memorySourceKind({ sourceRef: "  " }), "unknown");
});

test("a fact from a chat names the chat, links the message, and is dated by when it was SAID", () => {
  const p = memoryProvenance(entry(), { conversation: { id: "conv-1", title: "Moving house" }, now: NOW });
  assert.equal(p.source.kind, "chat");
  assert.equal(p.source.label, "From “Moving house”");
  assert.equal(p.source.href, "/chat/conv-1?m=msg-1");
  assert.equal(p.source.conversationUnavailable, false);
  assert.equal(p.when.saidAt, SAID.toISOString(), "said a year ago");
  assert.equal(p.when.recordedAt, NOTED.toISOString(), "written down last week");
  assert.equal(p.scope.label, "Every chat");
  assert.equal(p.status.inUse, true);
  assert.equal(p.basis.label, "Stated in a chat");
  assert.equal(p.why, `You said this in “Moving house” on ${provenanceDate(SAID)}. You said it again on ${provenanceDate(NOTED)}. It can be used in any chat.`);
});

test("a fact from a chat that can't be found stays explained, without a dead link — and without claiming a deletion", () => {
  const p = memoryProvenance(entry(), { conversation: null, now: NOW });
  assert.equal(p.source.conversationUnavailable, true);
  assert.equal(p.source.href, null);
  // Deleted, or never in this account (an import): nothing records which, so
  // nothing says "deleted".
  assert.equal(p.source.label, "From a chat that’s no longer available");
  assert.match(p.why, /in a chat that’s no longer available/);
  assert.doesNotMatch(`${p.source.label} ${p.why}`, /deleted/);
  // Not looked up at all: honest about not knowing the title.
  assert.equal(memoryProvenance(entry(), { now: NOW }).source.label, "From a chat");
});

test("inferred, typed, imported and edited facts say so", () => {
  const inferred = memoryProvenance(entry({ confidence: 0.4 }), { conversation: { id: "conv-1", title: "x" }, now: NOW });
  assert.equal(inferred.basis.stated, false);
  assert.equal(inferred.basis.label, "Inferred");
  assert.match(inferred.why, new RegExp(`${PRODUCT_NAME} inferred this`));

  const typed = memoryProvenance(entry({ source: "MANUAL", sourceRef: "manual", confidence: 0.9 }), { now: NOW });
  assert.equal(typed.source.kind, "manual");
  assert.equal(typed.source.href, null);
  assert.match(typed.why, /^You added this yourself on/);

  assert.match(memoryProvenance(entry({ sourceRef: "import" }), { now: NOW }).why, /imported from another assistant/);
  assert.match(memoryProvenance(entry({ sourceRef: "edit", source: "MANUAL" }), { now: NOW }).why, /edit you asked for/);
  assert.match(memoryProvenance(entry({ sourceRef: "native", source: "MANUAL" }), { now: NOW }).why, /another device/);
});

test("scope, status and expiry are part of the answer", () => {
  const project = memoryProvenance(entry({ projectId: "p1" }), { projectName: "Thesis", now: NOW });
  assert.deepEqual(project.scope, { kind: "project", projectId: "p1", label: "Only in Thesis" });
  assert.match(project.why, /only used in Thesis/);

  const replaced = memoryProvenance(
    entry({ status: "superseded", reason: "Replaced by something newer you said about where you live." }),
    { now: NOW }
  );
  assert.equal(replaced.status.inUse, false);
  assert.equal(replaced.status.label, "Replaced");
  assert.match(replaced.why, /Replaced by something newer you said about where you live\.$/);

  // Active in the table, but its moment has passed: not in use, and said so.
  const lapsed = memoryProvenance(entry({ category: "temporary", expiresAt: new Date("2026-10-01T00:00:00Z") }), { now: NOW });
  assert.equal(lapsed.status.value, "expired");
  assert.equal(lapsed.status.inUse, false);

  const upcoming = memoryProvenance(entry({ category: "temporary", expiresAt: new Date("2026-11-20T00:00:00Z") }), { now: NOW });
  assert.match(upcoming.why, /stops being used after 20 Nov 2026/);
});

test("sensitive facts and topic exclusions are labelled", () => {
  const health = memoryProvenance(entry({ content: "The user has asthma." }), { now: NOW });
  assert.deepEqual(health.sensitive, { topic: "health", label: "Health" });
  const topic = memoryProvenance(
    entry({ kind: "SUPPRESSION", content: "Anything about my divorce", sourceRef: "forget", source: "MANUAL", observedAt: null, createdAt: NOW }),
    { now: NOW }
  );
  assert.equal(topic.excludedTopic, "my divorce");
  assert.match(topic.why, /never to remember anything about “my divorce”/);
  assert.equal(topic.status.inUse, false, "a block-list row is never context");
});

test("a row older than the observedAt column falls back to when it was written", () => {
  const p = memoryProvenance(entry({ observedAt: null, lastVerifiedAt: null }), { now: NOW });
  assert.equal(p.when.saidAt, NOTED.toISOString());
  assert.equal(p.when.lastConfirmedAt, null);
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function row(id: string, content: string, at: string, extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id,
    content,
    status: "active",
    reason: null,
    source: "AUTO",
    kind: "FACT",
    supersededById: null,
    createdAt: new Date(at),
    observedAt: new Date(at),
    ...extra,
  };
}

test("history walks the supersession trail both ways and names what stands today", () => {
  const rows = [
    row("lisbon", "The user lives in Lisbon.", "2024-01-01", { status: "superseded", supersededById: "porto", reason: "Replaced by something newer you said about where you live." }),
    row("porto", "The user lives in Porto.", "2025-01-01", { status: "superseded", supersededById: "berlin", reason: "Replaced by something newer you said about where you live." }),
    row("berlin", "The user lives in Berlin.", "2026-01-01"),
    row("other", "The user prefers tea.", "2025-06-01"),
  ];
  const fromPorto = memoryHistory(rows, "porto")!;
  assert.deepEqual(fromPorto.earlier.map((s) => s.id), ["lisbon"]);
  assert.equal(fromPorto.entry.id, "porto");
  assert.deepEqual(fromPorto.later.map((s) => s.id), ["berlin"]);
  assert.equal(fromPorto.current?.id, "berlin");
  assert.equal(fromPorto.earlier[0].reason, "Replaced by something newer you said about where you live.");

  const fromBerlin = memoryHistory(rows, "berlin")!;
  assert.deepEqual(fromBerlin.earlier.map((s) => s.id), ["lisbon", "porto"], "oldest first");
  assert.deepEqual(fromBerlin.later, []);
  assert.equal(fromBerlin.current?.id, "berlin");

  assert.equal(memoryHistory(rows, "missing"), null);
  assert.deepEqual(memoryHistory(rows, "other")!.earlier, []);
});

test("history: a merge retires several rows into one; a forgotten end has no current belief", () => {
  const rows = [
    row("a", "Prefers short answers with examples.", "2025-01-01", { status: "superseded", supersededById: "keep" }),
    row("b", "Prefers short answers, with examples please.", "2025-02-01", { status: "superseded", supersededById: "keep" }),
    row("keep", "Prefers short answers with code examples.", "2025-03-01", { status: "suppressed", reason: "You asked to forget this." }),
  ];
  const h = memoryHistory(rows, "keep")!;
  assert.deepEqual(h.earlier.map((s) => s.id), ["a", "b"]);
  assert.equal(h.current, null, "forgotten: nothing on this trail is believed");
});

test("history survives a cycle a hand-edited row could create", () => {
  const rows = [
    row("x", "A", "2025-01-01", { status: "superseded", supersededById: "y" }),
    row("y", "B", "2025-02-01", { status: "superseded", supersededById: "x" }),
  ];
  const h = memoryHistory(rows, "x")!;
  assert.deepEqual(h.later.map((s) => s.id), ["y"]);
  assert.deepEqual(h.earlier, []);
  assert.equal(h.current, null);
});

test("an import names the chats it restored by their new ids; word sources and unknown chats pass through", () => {
  const ids = new Map([["old-conv", "new-conv"]]);
  assert.equal(importedSourceRef("old-conv", ids), "new-conv");
  assert.equal(importedSourceRef(" old-conv ", ids), "new-conv");
  for (const word of ["manual", "edit", "native", "import", "forget"]) assert.equal(importedSourceRef(word, ids), word);
  assert.equal(importedSourceRef(null, ids), null);
  // A chat the export did not carry: left as it was, so it reads as unavailable.
  assert.equal(importedSourceRef("missing-conv", ids), "missing-conv");
});

