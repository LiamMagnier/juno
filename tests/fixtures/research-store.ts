import {
  RESEARCH_TERMINAL_STATES,
  RESEARCH_WORKING_STATES,
  type ResearchState,
} from "@/lib/research/domain";
import type {
  ResearchEventRow,
  ResearchRunRow,
  ResearchSourceRow,
  ResearchStore,
} from "@/lib/research/engine";
import type { ResearchFindingRow } from "@/lib/research/agents/protocol";

/**
 * The in-memory ResearchStore, shared by the research test files.
 *
 * A copy of the fixture tests/research-run.test.ts has always kept privately,
 * plus the findings table the agent round writes. Kept out of that file so a
 * second test file can drive the same engine without re-running the first.
 */

interface MemoryRow extends ResearchRunRow {
  planObject: Record<string, unknown>;
}

export function memoryStore() {
  const runs = new Map<string, MemoryRow>();
  const events: Array<ResearchEventRow & { runId: string }> = [];
  const sources: Array<ResearchSourceRow & { runId: string; userId: string }> = [];
  const passages: Array<{ sourceId: string; text: string; ordinal: number }> = [];
  const findings: Array<ResearchFindingRow & { runId: string }> = [];
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}_${(ids += 1)}`;

  const own = (runId: string, userId: string) => {
    const row = runs.get(runId);
    // Every ResearchRun query in production is scoped by userId; the fake
    // enforces the same thing so a test cannot pass against a store that is
    // more permissive than the real one.
    return row && row.userId === userId ? row : null;
  };

  const store: ResearchStore = {
    async createRun({ userId, goal, conversationId, budgetMicroUsd, plan }) {
      const now = new Date();
      const row: MemoryRow = {
        id: nextId("run"),
        userId,
        conversationId,
        goal,
        state: "accepted",
        plan: { ...plan },
        planObject: { ...plan },
        queries: [],
        costMicroUsd: BigInt(0),
        budgetMicroUsd,
        error: null,
        report: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: null,
      };
      runs.set(row.id, row);
      return { ...row };
    },

    async loadRun(runId, userId) {
      const row = own(runId, userId);
      return row ? { ...row } : null;
    },

    async claimRun({ runId, userId, workerId, leaseMs = 120_000 }) {
      const row = own(runId, userId);
      const now = new Date();
      if (
        !row ||
        !["accepted", ...RESEARCH_WORKING_STATES].includes(row.state as never) ||
        (row.workerLeaseUntil && row.workerLeaseUntil > now && row.workerLeaseOwner !== workerId)
      ) {
        return null;
      }
      row.workerLeaseOwner = workerId;
      row.workerLeaseUntil = new Date(now.getTime() + leaseMs);
      row.lastHeartbeatAt = now;
      row.updatedAt = now;
      return { ...row };
    },

    async moveState({ runId, userId, from, to, patch }) {
      const row = own(runId, userId);
      if (!row || !from.includes(row.state as ResearchState)) return null;
      row.state = to;
      if (patch?.plan) {
        row.planObject = { ...patch.plan };
        row.plan = row.planObject;
      }
      if (patch && "error" in patch) row.error = patch.error ?? null;
      if (patch && "report" in patch && patch.report !== undefined) row.report = patch.report;
      if (RESEARCH_TERMINAL_STATES.includes(to as never)) row.finishedAt = new Date();
      return { ...row };
    },

    async savePlan({ runId, userId, plan }) {
      const row = own(runId, userId);
      if (!row) return null;
      row.planObject = { ...plan };
      row.plan = row.planObject;
      return { ...row };
    },

    async recordQueries({ runId, userId, queries }) {
      const row = own(runId, userId);
      if (row) row.queries = [...queries];
    },

    async appendEvents({ runId, userId, events: batch }) {
      const row = own(runId, userId);
      if (!row) return { lastSeq: 0, appended: [] };
      const top = events
        .filter((event) => event.runId === runId)
        .reduce((max, event) => Math.max(max, event.seq), 0);
      const appended = batch.map((event, index) => ({
        runId,
        id: nextId("ev"),
        seq: top + index + 1,
        kind: event.kind,
        payload: event.payload ?? {},
        createdAt: new Date(),
      }));
      events.push(...appended);
      return {
        lastSeq: top + batch.length,
        appended: appended.map((event) => ({ seq: event.seq, kind: event.kind as never })),
      };
    },

    async readEvents({ runId, userId, after, limit }) {
      if (!own(runId, userId)) return [];
      return events
        .filter((event) => event.runId === runId && event.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
    },

    async progress(runId, userId) {
      const row = own(runId, userId);
      const mine = sources.filter((source) => source.runId === runId);
      return {
        planConfirmed: typeof row?.planObject.confirmedAt === "string",
        queryCount: row?.queries.length ?? 0,
        sourceCount: mine.length,
        readCount: mine.filter((source) => source.snapshot).length,
        passageCount: passages.filter((passage) =>
          mine.some((source) => source.id === passage.sourceId)
        ).length,
        hasReport: !!row?.report,
      };
    },

    async upsertSource({ runId, userId, url, title, contentHash, snapshot, authority }) {
      const existing = sources.find((source) => source.runId === runId && source.url === url);
      if (existing) {
        existing.title = title;
        // Mirrors the Prisma store: a snapshot never shrinks, and the hash moves
        // with it or not at all. See the note in src/lib/research/run.ts.
        const keepsMoreText = snapshot != null && snapshot.length > (existing.snapshot?.length ?? 0);
        if (keepsMoreText && contentHash !== undefined) existing.contentHash = contentHash;
        if (keepsMoreText) existing.snapshot = snapshot;
        if (authority !== undefined) existing.authority = authority;
        return { id: existing.id, created: false };
      }
      const row = {
        runId,
        userId,
        id: nextId("src"),
        url,
        title,
        contentHash: contentHash ?? null,
        snapshot: snapshot ?? null,
        publishedAt: null,
        authority: authority ?? null,
        fetchedAt: new Date(),
      };
      sources.push(row);
      return { id: row.id, created: true };
    },

    async savePassages({ sourceId, passages: batch }) {
      for (let i = passages.length - 1; i >= 0; i -= 1) {
        if (passages[i].sourceId === sourceId) passages.splice(i, 1);
      }
      passages.push(...batch.map((p) => ({ sourceId, text: p.text, ordinal: p.ordinal })));
      return batch.length;
    },

    async listSources(runId, userId) {
      if (!own(runId, userId)) return [];
      return sources.filter((source) => source.runId === runId).map((source) => ({ ...source }));
    },

    async addFinding(input) {
      const row = own(input.runId, input.userId);
      if (!row) throw new Error("no such run");
      const finding = {
        id: nextId("f"),
        runId: input.runId,
        workerId: input.workerId,
        round: input.round,
        objectiveId: input.objectiveId,
        sourceId: input.sourceId,
        url: input.url,
        claim: input.claim,
        quote: input.quote,
        locator: input.locator,
        confidence: input.confidence,
        createdAt: new Date(),
      };
      findings.push(finding);
      return { id: finding.id };
    },

    async listFindings(runId, userId) {
      if (!own(runId, userId)) return [];
      return findings.filter((finding) => finding.runId === runId).map(({ runId: _runId, ...rest }) => rest);
    },

    async addSpend({ runId, userId, microUsd }) {
      const row = own(runId, userId);
      if (!row) return BigInt(0);
      row.costMicroUsd += BigInt(microUsd);
      return row.costMicroUsd;
    },
  };

  return { store, events, runs, sources, findings };
}

