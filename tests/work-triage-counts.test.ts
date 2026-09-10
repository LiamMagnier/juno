import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WORK_STATUSES, type WorkStatus } from "@/lib/work/domain";
import { tallyTriageCounts, type SessionStatusTally } from "@/app/api/work/protocol";
import { matchesTriage } from "@/components/work/inbox/triage";
import type { ClientWorkSession } from "@/lib/work/serializers";

/*
 * The inbox's counts, from the server's group-by.
 *
 * The pills used to count the page they could see — the newest forty rows —
 * so a task waiting on an approval since last week fell out of "Needs you" and
 * out of its number. `GET /api/work/sessions/counts` tallies the whole account
 * from one `groupBy(status, needsAttention)`, and this file holds the two
 * things that make that tally trustworthy: it agrees with the predicate the
 * inbox filters rows by, and it never counts a row it cannot name.
 */

const ROUTE = new URL("../src/app/api/work/sessions/counts/route.ts", import.meta.url);

function session(status: ClientWorkSession["status"], needsAttention: boolean): ClientWorkSession {
  return {
    id: `${status}-${needsAttention}`,
    projectId: null,
    conversationId: null,
    title: "",
    titleSource: "default",
    goal: "",
    status,
    needsAttention,
    requestedTarget: "automatic",
    preferredHostId: null,
    requestedModel: null,
    reasoningEffort: null,
    permissionPolicy: "balanced",
    pinned: false,
    archived: false,
    lastActivityAt: "",
    createdAt: "",
    updatedAt: "",
  };
}

test("the server tally and the inbox filter agree on every status", () => {
  // Every (status, needsAttention) cell, counted once, then compared against
  // what `matchesTriage` would say about a row in that cell. The two are one
  // definition (`matchesFilter`) read from two places, and this is the check
  // that keeps them so.
  const rows: Array<SessionStatusTally & { status: WorkStatus }> = [];
  for (const status of WORK_STATUSES) {
    for (const needsAttention of [true, false]) rows.push({ status, needsAttention, count: 1 });
  }
  const counts = tallyTriageCounts(rows);
  const ctx = { scheduled: false, unread: false };
  const expect = (state: "needs_you" | "in_progress" | "done" | "all") =>
    rows.filter((row) => matchesTriage(session(row.status, row.needsAttention), state, ctx)).length;

  assert.equal(counts.all, expect("all"));
  assert.equal(counts.needs_you, expect("needs_you"));
  assert.equal(counts.in_progress, expect("in_progress"));
  assert.equal(counts.done, expect("done"));
});

test("a task waiting on an approval is needs_you and never in_progress", () => {
  const counts = tallyTriageCounts([
    { status: "waiting_approval", needsAttention: true, count: 3 },
    { status: "running", needsAttention: false, count: 2 },
    // Terminal, and still a decision waiting on a person: wake the Mac or
    // move it to the cloud. Counted under needs_you, not done.
    { status: "host_offline", needsAttention: true, count: 1 },
    { status: "completed", needsAttention: false, count: 4 },
  ]);
  assert.deepEqual(counts, { needs_you: 4, in_progress: 2, done: 4, all: 10 });
});

test("a status this build cannot name is left out rather than miscounted", () => {
  // A row written by a newer deployment. Counting it under `all` and nowhere
  // else would make the pills disagree with the list, which cannot show it.
  const counts = tallyTriageCounts([{ status: "teleporting", needsAttention: false, count: 5 }]);
  assert.deepEqual(counts, { needs_you: 0, in_progress: 0, done: 0, all: 0 });
});

test("the counts route excludes what the list excludes and is scoped to the account", () => {
  const source = readFileSync(ROUTE, "utf8");
  assert.match(source, /userId: user\.id/);
  assert.match(source, /deletedAt: null/);
  assert.match(source, /archived: false/);
});
