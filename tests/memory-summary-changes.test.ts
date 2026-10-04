import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  coveredBySummary,
  planFactIngestion,
  selectMemoriesForContext,
  summaryPredatesForget,
  summaryPredatesMemoryChange,
  summaryRebuildDecision,
  type LifecycleEntry,
} from "@/lib/memory-lifecycle";
import { readMemorySummaryChanges, type MemorySummaryChangeReader } from "@/lib/memory-summary-changes";

const NOW = new Date("2026-10-04T10:00:00Z");
const SUMMARY_AT = new Date("2026-10-04T09:00:00Z");
const OLD = new Date("2026-08-01T10:00:00Z");
type StoredFact = LifecycleEntry & { userId: string; updatedAt: Date };
function fact(id: string, content: string, overrides: Partial<StoredFact> = {}): StoredFact {
  return {
    id, content, userId: "owner", projectId: null, kind: "FACT", status: "active",
    category: "identity", source: "AUTO", confidence: 0.7, createdAt: OLD,
    updatedAt: OLD, observedAt: OLD, normalized: null, expiresAt: null, ...overrides,
  };
}

/** The injected persistence port applies the real loader's account/scope filters. */
function reader(rows: StoredFact[]): MemorySummaryChangeReader {
  return async ({ where, orderBy, select }) => {
    // Selecting content at this boundary would disclose private facts solely
    // to decide whether existing prose is stale. Only two scalar dates belong.
    assert.ok(!("content" in select));
    const eligible = rows.filter((row) => {
      if (row.userId !== where.userId || row.projectId !== where.projectId || row.kind !== where.kind) return false;
      if (typeof where.status === "object" && Array.isArray(where.status?.in) && !where.status.in.includes(row.status)) return false;
      const expiryFilter = where.expiresAt;
      if (expiryFilter && typeof expiryFilter === "object" && "lte" in expiryFilter && expiryFilter.lte instanceof Date) {
        if (!row.expiresAt || row.expiresAt > expiryFilter.lte) return false;
      }
      return true;
    });
    eligible.sort((a, b) => orderBy.updatedAt
      ? b.updatedAt.getTime() - a.updatedAt.getTime()
      : (b.expiresAt?.getTime() ?? 0) - (a.expiresAt?.getTime() ?? 0));
    const row = eligible[0];
    return row ? select.updatedAt ? { updatedAt: row.updatedAt } : { expiresAt: row.expiresAt } : null;
  };
}

for (const projectId of [null, "project-a"]) {
  test(`a reinstatement invalidates and rebuilds old summary prose without adding a row (${projectId ?? "account"})`, async () => {
    const madrid = fact("madrid", "The user lives in Madrid.", {
      projectId, status: "superseded", supersededById: "valencia",
    });
    const valencia = fact("valencia", "The user lives in Valencia.", {
      projectId, observedAt: new Date("2026-09-01T10:00:00Z"),
    });
    const rows = [madrid, valencia];
    const summary = { content: "The user lives in Valencia.", updatedAt: SUMMARY_AT, entryCount: 2 };
    const plan = planFactIngestion({ content: madrid.content, source: "AUTO", projectId, observedAt: NOW }, {
      entries: rows, suppressions: [], now: NOW,
    });
    assert.equal(plan.action, "refresh");
    if (plan.action !== "refresh") return;
    assert.ok(plan.reinstate);
    assert.equal(plan.supersedes?.entryId, valencia.id);
    // Apply the actual ingestion plan; this is a change of beliefs, not count.
    madrid.status = "active";
    madrid.supersededById = null;
    madrid.updatedAt = NOW;
    madrid.observedAt = NOW;
    valencia.status = "superseded";
    valencia.supersededById = madrid.id;
    valencia.updatedAt = NOW;
    assert.equal(rows.length, summary.entryCount);

    const changes = await readMemorySummaryChanges({ userId: "owner", projectId, now: NOW }, reader(rows));
    const priorDecision = summaryRebuildDecision({ summary, factCount: rows.length, newestSuppressionAt: null, newestExpiryAt: null, now: NOW });
    assert.equal(priorDecision, "fresh", "the old count/forget/expiry gate misses this correction");
    assert.equal(summaryPredatesForget(summary.updatedAt, null), false);
    assert.equal(summaryPredatesMemoryChange(summary.updatedAt, changes), true);
    assert.equal(summaryRebuildDecision({ summary, factCount: rows.length, newestSuppressionAt: null, ...changes, now: NOW }), "rebuild");

    // With stale prose withheld, retrieval sees the reinstated fact even
    // though its original createdAt predates the old summary.
    const usableSummary = summaryPredatesMemoryChange(summary.updatedAt, changes) ? null : summary;
    const { selected } = selectMemoriesForContext(rows.filter((row) => !coveredBySummary(row, usableSummary, projectId)), {
      projectId, isolateProjectMemory: true, query: "Where do I live?", now: NOW,
    });
    assert.deepEqual(selected.map((row) => row.content), [madrid.content]);
    assert.equal(summaryPredatesMemoryChange(new Date(NOW.getTime() + 1), changes), false, "a rebuilt summary is usable again");
  });
}

test("timestamp reads cannot cross an account, a project, or the suppression kind", async () => {
  const local = new Date("2026-10-04T09:30:00Z");
  const rows = [
    fact("local", "Scoped fact", { projectId: "project-a", status: "superseded", updatedAt: local }),
    fact("personal", "Private personal fact", { status: "superseded", updatedAt: NOW }),
    fact("other-project", "Other project secret", { projectId: "project-b", status: "superseded", updatedAt: NOW }),
    fact("other-account", "Other account secret", { userId: "stranger", projectId: "project-a", status: "superseded", updatedAt: NOW }),
    fact("suppression", "Account-wide suppression", { kind: "SUPPRESSION", projectId: "project-a", status: "suppressed", updatedAt: NOW }),
    fact("current", "An unchanged active preference", { projectId: "project-a", updatedAt: NOW }),
  ];
  const project = await readMemorySummaryChanges({ userId: "owner", projectId: "project-a", now: NOW }, reader(rows));
  assert.deepEqual(project, { newestRetirementAt: local, newestExpiryAt: null });
  const personal = await readMemorySummaryChanges({ userId: "owner", projectId: null, now: NOW }, reader(rows));
  assert.equal(personal.newestRetirementAt?.getTime(), NOW.getTime());
});

test("expired prose is withheld before the sweep retires its still-active fact", async () => {
  const elapsed = new Date("2026-10-04T09:45:00Z");
  const rows = [
    fact("trip", "The user is travelling this week.", { expiresAt: elapsed }),
    fact("future", "The user's next trip is pending.", { expiresAt: new Date("2026-10-05T10:00:00Z") }),
    fact("foreign", "Another person's elapsed trip", { userId: "stranger", expiresAt: NOW }),
  ];
  const changes = await readMemorySummaryChanges({ userId: "owner", projectId: null, now: NOW }, reader(rows));
  assert.equal(changes.newestExpiryAt?.getTime(), elapsed.getTime());
  assert.equal(changes.newestRetirementAt, null);
  assert.equal(summaryPredatesMemoryChange(SUMMARY_AT, changes), true);
  assert.equal(selectMemoriesForContext(rows.filter((row) => row.userId === "owner"), { now: NOW }).selected.some((row) => row.id === "trip"), false);
});

test("a correction benches summary prose even while costly rebuilding is throttled", () => {
  const summary = { entryCount: 2, updatedAt: new Date(NOW.getTime() - 60_000) };
  const changes = { newestRetirementAt: NOW, newestExpiryAt: null };
  assert.equal(summaryPredatesMemoryChange(summary.updatedAt, changes), true);
  assert.equal(summaryRebuildDecision({ summary, factCount: 2, newestSuppressionAt: null, ...changes, now: NOW }), "throttled");
});

test("no mutation and pre-summary retirements cause no invalidation or extra rebuild", async () => {
  const changes = await readMemorySummaryChanges({ userId: "owner", projectId: null, now: NOW }, reader([
    fact("old", "An old superseded belief", { status: "superseded" }),
    fact("active", "An active preference restated now", { updatedAt: NOW }),
  ]));
  assert.equal(summaryPredatesMemoryChange(SUMMARY_AT, changes), false);
  assert.equal(summaryPredatesMemoryChange(SUMMARY_AT, {}), false);
  assert.equal(summaryPredatesMemoryChange(NOW, { newestRetirementAt: NOW }), false);
  assert.equal(summaryRebuildDecision({ summary: { entryCount: 2, updatedAt: SUMMARY_AT }, factCount: 2, newestSuppressionAt: null, ...changes, now: NOW }), "fresh");
});

test("a failed freshness read propagates rather than asserting obsolete prose is current", async () => {
  await assert.rejects(readMemorySummaryChanges({ userId: "owner", projectId: null, now: NOW }, async () => {
    throw new Error("Database unavailable");
  }), /Database unavailable/);
});

test("profile injection and both consolidation paths consult the same scoped lifecycle check", () => {
  const source = readFileSync(new URL("../src/lib/memory.ts", import.meta.url), "utf8");
  const profile = source.slice(source.indexOf("export async function getMemoryProfile("), source.indexOf("export async function getCodingMemory("));
  assert.match(profile, /readMemorySummaryChanges\(\{ userId, projectId: summaryScope, now \}/);
  assert.match(profile, /!summaryPredatesMemoryChange\(storedSummary.updatedAt, changes\)/);
  assert.match(profile, /isolateProjectMemory: isolate/);
  for (const [name, scope] of [["maybeConsolidate", "projectId: null"], ["maybeConsolidateProject", "projectId"]]) {
    const body = source.slice(source.indexOf(`export async function ${name}(`));
    assert.ok(body.slice(0, 2200).includes(`readMemorySummaryChanges({ userId, ${scope}, now }`));
    assert.match(body.slice(0, 2200), /summaryRebuildDecision\(\{[\s\S]*\.\.\.changes/);
  }
});
