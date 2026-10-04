import test from "node:test";
import assert from "node:assert/strict";
import {
  exclusiveSlot,
  laterResolverOf,
  planDuplicateMerges,
  planFactIngestion,
  planTimelineReconciliation,
  selectMemoriesForContext,
  slotsConflict,
  statesResolvedBy,
  transitionStateOf,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";

/*
 * The 2026-10-04 lifecycle rules: subject-aware style slots, denials,
 * transitions (states a later event ends), near-duplicate merges, and decay
 * from the last confirmation. Each is conservative; the "keep both" cases are
 * as important as the ones that retire something.
 */

const at = (iso: string) => new Date(iso);
let seq = 0;
function row(content: string, iso: string, extra: Partial<LifecycleEntry> = {}): LifecycleEntry {
  return {
    id: `r${++seq}`, content, normalized: null, category: null, projectId: null, source: "AUTO", kind: "FACT",
    confidence: 0.7, status: "active", expiresAt: null, createdAt: at(iso), observedAt: at(iso), ...extra,
  };
}

test("style slots: answer length and register are single-valued; other preferences stay additive", () => {
  assert.deepEqual(exclusiveSlot("The user prefers short answers with examples."), { slot: "answer-length", noun: "how long you like answers", value: "short" });
  assert.equal(exclusiveSlot("The user prefers detailed answers with sources.")?.value, "long");
  assert.equal(exclusiveSlot("The user likes formal replies.")?.slot, "answer-register");
  assert.equal(exclusiveSlot("The user prefers answers with code examples."), null);
  assert.equal(exclusiveSlot("The user dislikes long introductions in answers."), null, "not a preference FOR a length");
  assert.equal(exclusiveSlot("The user's manager prefers short answers."), null, "someone else's preference");
  assert.equal(exclusiveSlot("The user prefers short but detailed answers."), null, "both poles: ambiguous, left alone");
});

test("denials conflict only with the value they deny", () => {
  const works = exclusiveSlot("The user works at Initech.")!;
  const denies = exclusiveSlot("The user no longer works at Initech.")!;
  const hooli = exclusiveSlot("The user works at Hooli.")!;
  assert.equal(denies.negated, true);
  assert.equal(slotsConflict(works, denies), true);
  assert.equal(slotsConflict(hooli, denies), false);
  assert.equal(slotsConflict(works, hooli), true);
});

test("a newer detailed-answers preference supersedes the short one, in either reading order", () => {
  const older = row("The user prefers short answers with examples.", "2026-01-10T10:00:00Z");
  const plan = planFactIngestion(
    { content: "The user prefers detailed answers with sources.", source: "AUTO", observedAt: at("2026-06-10T10:00:00Z") },
    { entries: [older], suppressions: [], now: at("2026-06-10T10:00:00Z") }
  );
  assert.equal(plan.action, "create");
  assert.equal(plan.action === "create" && plan.supersedes?.entryId, older.id);

  const newer = row("The user prefers detailed answers with sources.", "2026-06-10T10:00:00Z");
  const reread = planFactIngestion(
    { content: "The user prefers short answers with examples.", source: "AUTO", observedAt: at("2026-01-10T10:00:00Z") },
    { entries: [newer], suppressions: [], now: at("2026-09-01T00:00:00Z") }
  );
  assert.equal(reread.action === "create" && reread.status, "superseded");
});

test("transitions: a job search ends when a new job is said later, not earlier; studies end with graduation", () => {
  assert.equal(transitionStateOf("The user is looking for a new job.")?.id, "job-search");
  assert.equal(transitionStateOf("The user's sister is looking for a new job."), null);
  const search = row("The user is looking for a new job.", "2026-02-01T00:00:00Z");
  assert.equal(statesResolvedBy({ content: "The user works at Hooli.", observedAt: at("2026-06-01T00:00:00Z") }, [search]).length, 1);
  assert.equal(statesResolvedBy({ content: "The user works at Hooli.", observedAt: at("2026-01-01T00:00:00Z") }, [search]).length, 0);
  const hooli = row("The user works at Hooli.", "2026-06-01T00:00:00Z");
  assert.equal(laterResolverOf({ content: search.content, observedAt: at("2026-02-01T00:00:00Z") }, [hooli])?.entry.id, hooli.id);

  const studies = row("The user studies computer science at Leeds University.", "2025-10-01T00:00:00Z");
  const plan = planFactIngestion(
    { content: "The user graduated in July.", source: "AUTO", observedAt: at("2026-07-20T00:00:00Z") },
    { entries: [studies], suppressions: [], now: at("2026-07-20T00:00:00Z") }
  );
  assert.deepEqual(plan.action === "create" ? plan.resolves?.map((r) => r.entryId) : null, [studies.id]);
  const sister = planFactIngestion(
    { content: "The user's sister graduated last month.", source: "AUTO", observedAt: at("2026-07-20T00:00:00Z") },
    { entries: [studies], suppressions: [], now: at("2026-07-20T00:00:00Z") }
  );
  assert.equal(sister.action === "create" && sister.resolves, undefined);
});

test("a typed state is never retired by a transition", () => {
  const typed = row("The user is looking for a new job.", "2026-02-01T00:00:00Z", { source: "MANUAL" });
  assert.equal(statesResolvedBy({ content: "The user works at Hooli.", observedAt: at("2026-06-01T00:00:00Z") }, [typed]).length, 0);
});

test("the re-judge pass replays denials: a denied employer is not believed again by re-reading", () => {
  const initech = row("The user works at Initech.", "2026-01-01T00:00:00Z");
  const denial = row("The user no longer works at Initech.", "2026-04-01T00:00:00Z");
  const changes = planTimelineReconciliation([initech, denial], { now: at("2026-09-01T00:00:00Z") });
  assert.deepEqual(changes.map((c) => [c.id, c.status]), [[initech.id, "superseded"]]);
  // Said again after the denial: the employer is back, the denial is history.
  const again = row("The user works at Initech.", "2026-08-01T00:00:00Z", { id: "again" });
  const later = planTimelineReconciliation([{ ...initech, status: "superseded" }, denial, again], { now: at("2026-09-01T00:00:00Z") });
  assert.ok(later.some((c) => c.id === denial.id && c.status === "superseded"));
  assert.ok(!later.some((c) => c.id === again.id));
});

test("merges keep one of two near-identical facts, its own words, and never touch different ones", () => {
  const a = row("The user prefers short answers with examples.", "2026-01-01T00:00:00Z");
  const b = row("The user prefers short answers, with examples please.", "2026-02-01T00:00:00Z");
  const merges = planDuplicateMerges([a, b]);
  assert.equal(merges.length, 1);
  assert.equal(merges[0].id, a.id, "the more recently said one carries it");
  assert.equal(merges[0].supersededById, b.id);
  assert.equal(planDuplicateMerges([row("The user has 2 cats.", "2026-01-01T00:00:00Z"), row("The user has 3 cats.", "2026-02-01T00:00:00Z")]).length, 0);
  const typed = row("The user prefers short answers with examples.", "2026-01-01T00:00:00Z", { source: "MANUAL" });
  assert.equal(planDuplicateMerges([typed, b])[0].id, b.id, "a typed fact is never the one retired");
});

test("decay counts from the last confirmation, not the first saying", () => {
  const now = at("2026-09-01T00:00:00Z");
  const old = row("The user prefers metric units.", "2025-09-01T00:00:00Z");
  const confirmed = row("The user prefers British spelling.", "2025-09-01T00:00:00Z", { lastVerifiedAt: at("2026-08-25T00:00:00Z") });
  const { selected } = selectMemoriesForContext([old, confirmed], { now, query: "" });
  assert.equal(selected[0].id, confirmed.id);
});
