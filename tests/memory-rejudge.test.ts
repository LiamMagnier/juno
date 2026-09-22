import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  exclusiveSlot,
  observedAtOf,
  planFactIngestion,
  planTimelineReconciliation,
  resolveContradiction,
  selectMemoriesForContext,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";
import { EXTRACTOR_VERSION } from "@/lib/memory-extraction";

/*
 * Re-reading history, judged by when things were SAID.
 *
 * The recall benchmark (memory-bench.test.ts) measured what reading history
 * newest-first did to memory: every conflict went to the OLDER statement, so
 * a year of chats re-read left Juno believing the old city, the old employer
 * and a trip that was long over. These are the rules that fixed it, one at a
 * time, and the database wiring that carries them.
 */

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const NOW = new Date("2026-09-22T12:00:00Z");
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
let seq = 0;

function fact(content: string, extra: Partial<LifecycleEntry> = {}): LifecycleEntry {
  seq += 1;
  return {
    id: `f${seq}`,
    content,
    normalized: null,
    category: "identity",
    projectId: null,
    source: "AUTO",
    kind: "FACT",
    confidence: 0.7,
    status: "active",
    expiresAt: null,
    createdAt: NOW,
    observedAt: null,
    supersededById: null,
    ...extra,
  };
}

const ingest = (
  entries: LifecycleEntry[],
  content: string,
  observedAt?: Date,
  source: "AUTO" | "MANUAL" = "AUTO"
) =>
  planFactIngestion(
    { content, source, ...(observedAt ? { observedAt } : {}) },
    { entries, suppressions: [], now: NOW, allowedSensitiveTopics: [] }
  );

// ---------------------------------------------------------------------------
// Conflicts, whichever order they arrive in
// ---------------------------------------------------------------------------

test("an older statement read after a newer one is history, not the new belief", () => {
  const porto = fact("The user lives in Porto.", { observedAt: day("2026-06-15") });
  const plan = ingest([porto], "The user lives in Lisbon.", day("2025-10-06"));
  assert.equal(plan.action, "create");
  if (plan.action !== "create") return;
  assert.equal(plan.status, "superseded");
  assert.equal(plan.supersededById, porto.id);
  assert.equal(plan.supersedes, undefined);
  assert.match(plan.reason ?? "", /Replaced by something newer you said about where you live/);
});

test("a newer statement still replaces an older one", () => {
  const lisbon = fact("The user lives in Lisbon.", { observedAt: day("2025-10-06") });
  const plan = ingest([lisbon], "The user lives in Porto.", day("2026-06-15"));
  assert.equal(plan.action === "create" && plan.status, "active");
  assert.equal(plan.action === "create" && plan.supersedes?.entryId, lisbon.id);
});

test("without a time, a fact is taken to be said now — the live chat's case", () => {
  const lisbon = fact("The user lives in Lisbon.", { observedAt: day("2025-10-06") });
  const plan = ingest([lisbon], "The user lives in Porto.");
  assert.equal(plan.action === "create" && plan.status, "active");
  assert.equal(plan.action === "create" && plan.observedAt.getTime(), NOW.getTime());
});

test("a markedly more confident fact wins in either order", () => {
  const sure = { source: "AUTO" as const, confidence: 0.95 };
  const unsure = { source: "AUTO" as const, confidence: 0.6 };
  assert.equal(resolveContradiction(sure, unsure).winner, "existing");
  assert.equal(resolveContradiction(unsure, sure).winner, "incoming");
});

test("what the user typed outranks an inference, however recent", () => {
  const typed = fact("The user lives in Lisbon.", { source: "MANUAL", observedAt: day("2025-01-01") });
  const plan = ingest([typed], "The user lives in Porto.", day("2026-09-01"));
  assert.equal(plan.action === "create" && plan.status, "contradicted");
});

// ---------------------------------------------------------------------------
// Said again
// ---------------------------------------------------------------------------

test("a fact said again after what replaced it is believed again", () => {
  const madrid = fact("The user lives in Madrid.", {
    status: "superseded",
    observedAt: day("2025-12-01"),
  });
  const valencia = fact("The user lives in Valencia.", { observedAt: day("2026-03-01") });
  madrid.supersededById = valencia.id;
  const plan = ingest([madrid, valencia], "The user lives in Madrid.", day("2026-09-01"));
  assert.equal(plan.action, "refresh");
  if (plan.action !== "refresh") return;
  assert.equal(plan.entryId, madrid.id);
  assert.ok(plan.reinstate);
  assert.equal(plan.supersedes?.entryId, valencia.id);
  assert.equal(plan.observedAt?.getTime(), day("2026-09-01").getTime());
});

test("the same fact re-read from before its replacement stays replaced", () => {
  const madrid = fact("The user lives in Madrid.", { status: "superseded", observedAt: day("2025-12-01") });
  const valencia = fact("The user lives in Valencia.", { observedAt: day("2026-03-01") });
  const plan = ingest([madrid, valencia], "The user lives in Madrid.", day("2025-11-20"));
  assert.equal(plan.action === "refresh" && plan.reinstate, undefined);
  assert.equal(plan.action === "refresh" && plan.observedAt, undefined);
});

test("restating a believed fact moves its time forward, never back", () => {
  const tea = fact("The user likes tea.", { observedAt: day("2026-05-01"), category: "preferences" });
  const later = ingest([tea], "The user likes tea.", day("2026-08-01"));
  const earlier = ingest([tea], "The user likes tea.", day("2026-01-01"));
  assert.equal(later.action === "refresh" && later.observedAt?.getTime(), day("2026-08-01").getTime());
  assert.equal(earlier.action === "refresh" && earlier.observedAt, undefined);
});

// ---------------------------------------------------------------------------
// Time-limited facts
// ---------------------------------------------------------------------------

test("a trip mentioned months ago and read today is over, and displaces nothing", () => {
  const plan = ingest([], "The user is flying to Berlin this week.", day("2026-07-01"));
  assert.equal(plan.action === "create" && plan.status, "expired");
});

test("the same trip mentioned yesterday is current, for a month from when it was said", () => {
  const plan = ingest([], "The user is flying to Berlin this week.", day("2026-09-21"));
  assert.equal(plan.action === "create" && plan.status, "active");
  assert.equal(plan.action === "create" && plan.expiresAt?.toISOString().slice(0, 10), "2026-10-21");
});

test("an expired fact said again long ago is not revived", () => {
  const trip = fact("The user is flying to Berlin this week.", {
    category: "temporary",
    status: "expired",
    expiresAt: day("2026-08-01"),
    observedAt: day("2026-07-02"),
  });
  const plan = ingest([trip], "The user is flying to Berlin this week.", day("2026-07-01"));
  assert.equal(plan.action === "refresh" && plan.revive, false);
});

// ---------------------------------------------------------------------------
// Whose attribute
// ---------------------------------------------------------------------------

test("someone else's city is not the user's", () => {
  assert.equal(exclusiveSlot("The user's sister lives in Utrecht."), null);
  assert.equal(exclusiveSlot("Their partner works at Acme."), null);
  const rotterdam = fact("The user lives in Rotterdam.");
  const plan = ingest([rotterdam], "The user's sister lives in Utrecht.");
  assert.equal(plan.action, "create");
  assert.equal(plan.action === "create" ? plan.status : null, "active");
  assert.equal(plan.action === "create" ? plan.supersedes : null, undefined);
});

test("the user's own attributes still are, possessive and all", () => {
  assert.equal(exclusiveSlot("The user's name is Sam.")?.slot, "name");
  assert.equal(exclusiveSlot("The user's time zone is CET.")?.slot, "timezone");
  assert.equal(exclusiveSlot("The user now lives in Porto.")?.slot, "location");
  assert.equal(exclusiveSlot("Lives in Porto.")?.slot, "location");
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test("fresh means recently SAID — a fact re-read today from last year is a year old", () => {
  const readToday = fact("The user drinks oat milk flat whites.", {
    category: "preferences",
    createdAt: NOW,
    observedAt: day("2025-09-22"),
  });
  const saidToday = fact("The user drinks green tea in the afternoon.", {
    category: "preferences",
    createdAt: NOW,
    observedAt: NOW,
  });
  const { selected } = selectMemoriesForContext([readToday, saidToday], { query: "", now: NOW, limit: 1 });
  assert.equal(selected[0].id, saidToday.id);
  assert.equal(observedAtOf(readToday).getTime(), day("2025-09-22").getTime());
});

// ---------------------------------------------------------------------------
// The re-judge pass
// ---------------------------------------------------------------------------

test("history judged in reading order is judged again by when it was said", () => {
  // What the old rules stored after reading newest-first: Lisbon (said first)
  // believed, Porto (said later) replaced by it.
  const porto = fact("The user lives in Porto.", {
    status: "superseded",
    observedAt: day("2026-06-15"),
    createdAt: day("2026-09-20"),
  });
  const lisbon = fact("The user lives in Lisbon.", { observedAt: day("2025-10-06"), createdAt: day("2026-09-21") });
  porto.supersededById = lisbon.id;
  const changes = planTimelineReconciliation([porto, lisbon], { now: NOW });
  const byId = new Map(changes.map((c) => [c.id, c]));
  assert.equal(byId.get(porto.id)?.status, "active");
  assert.equal(byId.get(porto.id)?.supersededById, null);
  assert.equal(byId.get(lisbon.id)?.status, "superseded");
  assert.equal(byId.get(lisbon.id)?.supersededById, porto.id);
  assert.match(byId.get(lisbon.id)?.reason ?? "", /Juno re-read your chats/);
});

test("a timeline that is already right produces no writes", () => {
  const lisbon = fact("The user lives in Lisbon.", { status: "superseded", observedAt: day("2025-10-06") });
  const porto = fact("The user lives in Porto.", { observedAt: day("2026-06-15") });
  lisbon.supersededById = porto.id;
  assert.deepEqual(planTimelineReconciliation([lisbon, porto], { now: NOW }), []);
});

test("what the user typed is never changed by the pass — it wins, and stays put", () => {
  const typed = fact("The user lives in Lisbon.", { source: "MANUAL", observedAt: day("2025-01-01") });
  const inferred = fact("The user lives in Porto.", { observedAt: day("2026-06-15") });
  const changes = planTimelineReconciliation([typed, inferred], { now: NOW });
  assert.deepEqual(
    changes.map((c) => [c.id, c.status]),
    [[inferred.id, "superseded"]]
  );
});

test("forgotten, expired and contradicted rows are not judged at all", () => {
  const forgotten = fact("The user lives in Lisbon.", { status: "suppressed", observedAt: day("2026-09-01") });
  const porto = fact("The user lives in Porto.", { observedAt: day("2026-06-15") });
  assert.deepEqual(planTimelineReconciliation([forgotten, porto], { now: NOW }), []);
});

test("a temporary fact is re-dated from when it was said — and retired if that moment passed", () => {
  const trip = fact("The user is flying to Berlin this week.", {
    category: "temporary",
    observedAt: day("2026-08-10"),
    createdAt: day("2026-09-20"),
    expiresAt: day("2026-10-20"),
  });
  const [change] = planTimelineReconciliation([trip], { now: NOW });
  assert.equal(change.status, "expired");
  assert.equal(change.expiresAt?.toISOString().slice(0, 10), "2026-09-09");
});

// ---------------------------------------------------------------------------
// The database half — wiring
// ---------------------------------------------------------------------------

test("the extractor dates each chunk's facts by the message they came from", () => {
  const memory = src("src/lib/memory.ts");
  assert.match(memory, /observedAt: chunk\.at\(-1\)\?\.createdAt,/);
});

test("the reader is told only what Juno believes, in this chat's scope", () => {
  const memory = src("src/lib/memory.ts");
  assert.match(
    memory,
    /kind: "FACT",\s+status: "active",\s+projectId: convo\.projectId \?\? null,\s+OR: \[\{ expiresAt: null \}, \{ expiresAt: \{ gt: new Date\(\) \} \}\],/
  );
  assert.equal(EXTRACTOR_VERSION, 2);
});

test("a chat continued by a newer reader keeps its older version — only a full read stamps it", () => {
  const memory = src("src/lib/memory.ts");
  const upsert = memory.slice(memory.indexOf("await prisma.conversationMemory.upsert({"));
  const update = upsert.slice(upsert.indexOf("update: {"), upsert.indexOf("});"));
  assert.equal(/extractorVersion/.test(update), false);
  assert.match(upsert.slice(0, upsert.indexOf("update: {")), /extractorVersion: EXTRACTOR_VERSION/);
});

test("a re-read never starts before the oldest thing Juno still remembers", () => {
  const memory = src("src/lib/memory.ts");
  const fn = memory.slice(memory.indexOf("export async function queueRereads("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  // A reset deletes every row, so no remaining row can be older than it.
  assert.match(body, /prisma\.memoryEntry\.findFirst\(\{ where: \{ userId \}, orderBy: \{ createdAt: "asc" \}/);
  assert.match(body, /\{ processedAt: restartAt!, extractorVersion: EXTRACTOR_VERSION \}/);
  // Only chats that were actually distilled — a reset leaves neither.
  assert.match(body, /OR: \[\{ digest: \{ not: null \} \}, \{ factCount: \{ gt: 0 \} \}\]/);
});

test("the pass dates rows from their messages in bounded batches, and writes only what it judged", () => {
  const memory = src("src/lib/memory.ts");
  const fn = memory.slice(memory.indexOf("export async function reconcileMemoryTimeline("));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /\.slice\(0, RECONCILE_DATE_BATCH\)/);
  assert.match(body, /where: \{ id: row\.id, userId, observedAt: null \}/);
  assert.match(body, /where: \{ id: change\.id, userId, status: row\.status \}/);
});

test("saveCandidates writes what the plan decided — times, reinstatements, history", () => {
  const memory = src("src/lib/memory.ts");
  const fn = memory.slice(memory.indexOf("export async function saveCandidates("));
  const body = fn.slice(0, fn.indexOf("\nexport async function saveAutoMemories("));
  assert.match(body, /\.\.\.\(plan\.reinstate \? \{ status: "active", reason: plan\.reinstate\.reason, supersededById: null \} : \{\}\)/);
  assert.match(body, /if \(plan\.supersedes\) await supersede\(plan\.supersedes\.entryId, plan\.entryId, plan\.supersedes\.reason\);/);
  assert.match(body, /observedAt: plan\.observedAt,\s+supersededById: plan\.supersededById \?\? null,/);
});

test("the dreamer re-reads once nothing new is left, and re-judges after reading", () => {
  const dreamer = src("src/lib/memory-dreamer.ts");
  assert.match(dreamer, /if \(pass\.remaining === 0\) \{\s+outcome\.rereadQueued = await queueRereads\(userId, DREAM_REREADS_PER_ACCOUNT\);/);
  assert.match(dreamer, /reconcileMemoryTimeline\(userId, now\)/);
  // …and draws accounts whose history an older reader read.
  assert.match(dreamer, /m\."extractorVersion" < \$\{EXTRACTOR_VERSION\} AND \(m\."digest" IS NOT NULL OR m\."factCount" > 0\)/);
});

test("'Learn from past chats' and every summary rebuild settle the timeline first", () => {
  assert.match(src("src/app/api/memory/backfill/route.ts"), /await reconcileMemoryTimeline\(user\.id\)/);
  const memory = src("src/lib/memory.ts");
  for (const name of ["maybeConsolidate(", "maybeConsolidateProject("]) {
    const fn = memory.slice(memory.indexOf(`export async function ${name}`));
    assert.match(fn.slice(0, fn.indexOf("\n}\n")), /await reconcileMemoryTimeline\(userId, now\)/, name);
  }
});

test("facts typed or rewritten by hand are dated now", () => {
  assert.match(src("src/app/api/memory/route.ts"), /observedAt: new Date\(\),/);
  assert.match(src("src/app/api/memory/[id]/route.ts"), /observedAt: new Date\(\),/);
  assert.equal((src("src/app/api/memory/edit/apply/route.ts").match(/observedAt: new Date\(\),/g) ?? []).length, 2);
});
