import test, { mock } from "node:test";
import assert from "node:assert/strict";

/**
 * `expireUnclaimedCloudRuns` (src/lib/work/store.ts), driven for real with the
 * database, the spend ledger, the heartbeat and the notifier stood in.
 *
 * It used to end each run and bill it in one call (`finishRun`). A spend write
 * that threw after the run had committed terminal made that call throw, the
 * sweep read the throw as "not ended", and the run was left ended with its
 * owner never told it did not start. The notice now follows the terminal write
 * alone; the billing is still tried, and its failure logged.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks \
 *     tests/work-expiry-notice.test.ts
 *
 * The wiring is pinned without module mocks in
 * tests/work-executor-presence.test.ts, which `npm test` runs.
 */

// `mock.module` needs --experimental-test-module-mocks. `npm test` runs this
// directory without it, so the suite skips there rather than failing.
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

type Row = Record<string, unknown>;

let runs: Row[] = [];
let spendCalls: string[] = [];
let notified: string[] = [];

const workRun = {
  async findMany(args: { where: Row }) {
    if (args.where.checkpoint) return [];
    return runs.filter((run) => run.status === "queued").map((run) => ({ id: run.id, userId: run.userId }));
  },
};

const db = {
  workRun,
  async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
    return fn({
      workRun: {
        async updateMany(args: { where: Row; data: Row }) {
          const run = runs.find((r) => r.id === args.where.id && r.status === "queued");
          if (!run) return { count: 0 };
          Object.assign(run, args.data);
          return { count: 1 };
        },
        async findFirst(args: { where: Row }) {
          // The "a later attempt exists" read: none here.
          if (args.where.attempt) return null;
          return runs.find((r) => r.id === args.where.id) ?? null;
        },
      },
      workSession: {
        async updateMany() {
          return { count: 1 };
        },
      },
    });
  },
};

function queuedRun(id: string, userId: string): Row {
  return {
    id,
    userId,
    sessionId: `wsi_${id}`,
    attempt: 1,
    status: "queued",
    requestedModel: "auto",
    effectiveModel: null,
    costMicroUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    spendReservationRef: `res_${id}`,
  };
}

if (!canMockModules) {
  test("queued-run expiry notice suite needs --experimental-test-module-mocks", { skip: true }, () => {});
} else {
  mock.module("@/lib/db", { namedExports: { prisma: db, prismaUnguarded: db } });
  mock.module("@/lib/spend", {
    namedExports: {
      recordWorkRunSpend: async (input: { runId: string }) => {
        spendCalls.push(input.runId);
        throw new Error("spend ledger unreachable");
      },
      releaseSpend: async () => undefined,
      reserveSpend: async () => ({ ok: true }),
    },
  });
  mock.module("@/lib/work/executor-heartbeat", {
    namedExports: {
      // Gone for good: the sweep may end queued cloud runs.
      readExecutorPresence: async () => ({ kind: "read", lastBeatAt: null, localBeatFresh: false }),
    },
  });
  mock.module("@/lib/work/notify/deliver", {
    namedExports: {
      deliverRunNotification: async (run: { runId: string }) => {
        notified.push(run.runId);
      },
    },
  });

  test("a run the expiry sweep ended is notified even when its spend write throws", async () => {
    const store = await import("@/lib/work/store");
    runs = [queuedRun("run_1", "user_1"), queuedRun("run_2", "user_2")];
    spendCalls = [];
    notified = [];
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    let expired: string[];
    try {
      expired = await store.expireUnclaimedCloudRuns({ now: new Date("2026-10-26T09:00:00Z") });
    } finally {
      console.error = original;
    }
    assert.deepEqual(expired, ["run_1", "run_2"], "both ended");
    for (const run of runs) assert.equal(run.terminalReason, "executor_unavailable");
    assert.deepEqual(spendCalls, ["run_1", "run_2"], "the billing was still tried for each");
    assert.equal(errors.length, 2, "and its failure logged, not swallowed");
    // The notices are handed off, not awaited; let them run.
    for (let i = 0; i < 20 && notified.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(notified, ["run_1", "run_2"], "each owner is told the run did not start");
  });
}
