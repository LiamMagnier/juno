import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PARKED_RUN_TTL_MS,
  codeTaskAsHealthRun,
  connectorHref,
  isParkedExpiry,
  isSkippedFire,
  pollErrorForClient,
  scheduleHealth,
  shouldNotifyTriggerFailure,
  triggerFailureNotice,
  type HealthRunRow,
  type HealthTriggerRow,
} from "@/lib/work/schedule-health";
import { serializeSchedule, type WorkScheduleRow } from "@/lib/work/schedule";

/*
 * Routine health on the web (G42). A routine broken by an expired iCloud
 * password, or failing every morning, or parked on an approval nobody will see,
 * used to read exactly like one that worked. Each case below is one of those.
 */

const NOW = new Date("2026-10-15T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

function run(overrides: Partial<HealthRunRow> = {}): HealthRunRow {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    status: "completed",
    terminalReason: "completed",
    terminalDetail: null,
    pauseReason: null,
    origin: "schedule",
    createdAt: hoursAgo(2),
    updatedAt: hoursAgo(2),
    finishedAt: hoursAgo(1.9),
    ...overrides,
  };
}

function trigger(overrides: Partial<HealthTriggerRow> = {}): HealthTriggerRow {
  return { kind: "daily", enabled: true, lastPolledAt: null, lastPollError: null, ...overrides };
}

function health(runs: HealthRunRow[], triggers: HealthTriggerRow[] = [trigger()], enabled = true) {
  return scheduleHealth({ scheduleId: "sch-1", sessionId: "ses-1", enabled, triggers, runs, now: NOW });
}

test("a trigger that cannot read its mail says so first, with Reconnect to the connector", () => {
  const result = health([run()], [
    trigger(),
    trigger({ kind: "email_filter", lastPolledAt: hoursAgo(0.1), lastPollError: "Juno could not read INBOX: authentication failed" }),
  ]);
  assert.equal(result.state, "source_error");
  assert.equal(result.tone, "error");
  assert.equal(result.label, "Can’t read mail");
  assert.equal(result.detail, "Alevr could not read INBOX: authentication failed");
  assert.deepEqual(result.action, { kind: "reconnect", href: "/connections#connector-apple-mail", label: "Reconnect" });
  const calendar = health([], [trigger({ kind: "calendar_window", lastPollError: "could not read your calendar" })]);
  assert.equal(calendar.label, "Can’t read your calendar");
  assert.equal(calendar.action?.href, connectorHref("apple-calendar"));
  // A kind this build cannot serve is fixed by changing the trigger, not by reconnecting.
  const unservable = health([], [trigger({ kind: "folder_change", lastPollError: "cannot watch a folder" })]);
  assert.deepEqual(unservable.action, { kind: "edit", href: "/automations/sch-1", label: "Change trigger" });
  // A switched-off trigger's old error is not the routine's problem.
  assert.equal(health([run()], [trigger({ kind: "email_filter", enabled: false, lastPollError: "x" })]).state, "healthy");
});

test("a run parked on an approval is waiting for you, with the time it will be given up on", () => {
  const parked = run({ status: "paused", pauseReason: "waiting", terminalReason: null, finishedAt: null, updatedAt: hoursAgo(5) });
  const result = health([parked, run()]);
  assert.equal(result.state, "waiting");
  assert.equal(result.tone, "attention");
  assert.equal(result.label, "Waiting for you");
  assert.deepEqual(result.action, { kind: "answer", href: "/work/ses-1", label: "Answer" });
  assert.equal(result.waitingExpiresAt, new Date(hoursAgo(5).getTime() + PARKED_RUN_TTL_MS).toISOString());
  // A run a person started is never given up on by the sweep.
  const byHand = health([run({ ...parked, origin: "manual" })]);
  assert.equal(byHand.state, "waiting");
  assert.equal(byHand.waitingExpiresAt, null);
  // Asking right now, before it parked.
  assert.equal(health([run({ status: "waiting_approval", terminalReason: null, finishedAt: null })]).label, "Waiting for you");
  // Paused by a person: it waits for them to resume or stop it.
  const paused = health([run({ status: "paused", pauseReason: "user", terminalReason: null, finishedAt: null })]);
  assert.equal(paused.label, "Run paused");
});

test("the parked-run expiry reads as what it was, and the store's sentence is the one it matches", () => {
  const store = readFileSync(new URL("../src/lib/work/store.ts", import.meta.url), "utf8");
  const sentence = /PARKED_ROUTINE_RUN_EXPIRED_DETAIL =\s*"([^"]+)"/.exec(store)?.[1] ?? "";
  assert.ok(sentence.length > 0, "the store still names its sentence");
  const expired = run({ status: "interrupted", terminalReason: "interrupted", terminalDetail: sentence });
  assert.equal(isParkedExpiry(expired), true);
  const result = health([expired]);
  assert.equal(result.state, "failing");
  assert.equal(result.label, "Last run stopped unanswered");
  assert.match(result.detail ?? "", /waited 24 hours/);
  assert.match(store, /PARKED_ROUTINE_RUN_TTL_MS = PARKED_RUN_TTL_MS/, "one constant for the sweep and the row");
});

test("failures are named, counted while unbroken, and point at what happened", () => {
  const failed = (reason: string) => run({ status: reason === "cancelled" ? "cancelled" : "failed", terminalReason: reason });
  const result = health([failed("failed"), failed("timed_out"), failed("failed"), run()]);
  assert.equal(result.state, "failing");
  assert.equal(result.label, "Last run failed");
  assert.equal(result.consecutiveFailures, 3);
  assert.match(result.detail ?? "", /The last 3 runs didn’t finish/);
  assert.deepEqual(result.action, { kind: "open_run", href: "/work/ses-1", label: "See what happened" });
  assert.equal(health([failed("budget_exceeded")]).label, "Last run hit its budget");
  assert.equal(health([failed("host_offline")]).label, "Last run couldn’t reach the Mac");
  // A person's cancel is not a failure.
  assert.equal(health([failed("cancelled"), failed("failed")]).state, "healthy");
});

test("a fire the scheduler never ran is skipped, not failed, with the fix that fits", () => {
  // `recordMarkerRun`: created and finished in one breath, never claimed.
  const marker = (reason: string, detail: string | null) =>
    run({ status: "failed", terminalReason: reason, terminalDetail: detail, startedAt: null });
  const budget = marker("budget_exceeded", "This run was skipped because the account has used up the budget available to it.");
  assert.equal(isSkippedFire(budget), true);
  const spent = health([budget, run()]);
  assert.equal(spent.state, "skipped");
  assert.equal(spent.tone, "attention");
  assert.equal(spent.label, "Last run skipped: budget used up");
  assert.equal(spent.detail, "This run was skipped because the account has used up the budget available to it.");
  assert.deepEqual(spent.action, { kind: "usage", href: "/settings?section=billing", label: "See usage" });
  const offline = health([marker("host_offline", null), marker("host_offline", null), run()]);
  assert.equal(offline.label, "Last run skipped: Mac offline");
  assert.match(offline.detail ?? "", /^The Mac it runs on was offline, so it didn’t start\. The last 2 didn’t run or finish\.$/);
  assert.deepEqual(offline.action, { kind: "edit", href: "/automations/sch-1", label: "Change where it runs" });
  // A run that started and then hit its ceiling is a failure of the run.
  const started = run({ status: "failed", terminalReason: "budget_exceeded", startedAt: hoursAgo(2) });
  assert.equal(isSkippedFire(started), false);
  assert.equal(health([started]).label, "Last run hit its budget");
  // A reader that never selected `startedAt` cannot claim a skip.
  assert.equal(isSkippedFire(run({ terminalReason: "host_offline" })), false);
});

test("a Code routine's runs are read through the history list's translation and open in their conversation", () => {
  const failed = codeTaskAsHealthRun({
    id: "task-1",
    status: "error",
    conversationId: "conv-9",
    runnerClaimedAt: hoursAgo(3),
    createdAt: hoursAgo(3),
    updatedAt: hoursAgo(2.5),
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.terminalReason, "failed");
  assert.equal(isSkippedFire(failed), false);
  const result = health([failed]);
  assert.equal(result.state, "failing");
  assert.deepEqual(result.action, { kind: "open_run", href: "/chat/conv-9", label: "See what happened" });
  const waitingTask = {
    id: "task-2",
    status: "awaiting_approval",
    conversationId: null,
    runnerClaimedAt: null,
    createdAt: hoursAgo(1),
    updatedAt: hoursAgo(1),
  };
  const waiting = codeTaskAsHealthRun(waitingTask);
  assert.equal(waiting.status, "waiting_approval");
  assert.equal(health([waiting, failed]).action?.href, "/code");
  const done = codeTaskAsHealthRun({ ...waitingTask, id: "task-3", status: "done" });
  assert.equal(health([done, failed]).state, "healthy");
});

test("the calm states: running, not run yet, healthy, paused", () => {
  assert.equal(health([run({ status: "running", terminalReason: null, finishedAt: null }), run()]).state, "running");
  assert.equal(health([]).state, "never_run");
  const ok = health([run()]);
  assert.equal(ok.state, "healthy");
  assert.equal(ok.label, "Healthy");
  assert.equal(ok.action, null);
  assert.equal(ok.lastRun?.status, "completed");
  const paused = health([run({ status: "failed", terminalReason: "failed" })], [trigger({ kind: "email_filter", lastPollError: "x" })], false);
  assert.equal(paused.state, "paused", "a paused routine is paused, whatever it last did");
});

test("one notification on the first failure after a good read, none on the retries", () => {
  assert.equal(shouldNotifyTriggerFailure(null, "could not read INBOX"), true);
  assert.equal(shouldNotifyTriggerFailure("could not read INBOX", "could not read INBOX"), false);
  assert.equal(shouldNotifyTriggerFailure("could not read INBOX", null), false);
  assert.equal(shouldNotifyTriggerFailure(null, null), false);
  const notice = triggerFailureNotice({
    scheduleId: "sch-1",
    scheduleName: "Invoice watcher",
    triggerKind: "email_filter",
    error: "Juno could not read INBOX: authentication failed",
  });
  assert.equal(notice.title, "“Invoice watcher” can’t read your mail");
  assert.match(notice.body, /^Alevr could not read INBOX/);
  assert.match(notice.body, /Reconnect to keep it running/);
  assert.equal(notice.path, "/automations/sch-1");
  assert.equal(notice.connectorId, "apple-mail");
});

test("poll errors reach the client as sentences with the product's name, bounded", () => {
  assert.equal(pollErrorForClient(null), null);
  assert.equal(pollErrorForClient("  "), null);
  assert.equal(pollErrorForClient("Juno has no source to watch"), "Alevr has no source to watch");
  assert.equal(pollErrorForClient("x".repeat(400))?.length, 280);
});

test("the serialized trigger carries its last poll and error; the cursor and event key stay private", () => {
  const schedule = {
    id: "sch-1", sessionId: "ses-1", name: "n", enabled: true, instructions: "i", instructionsVersion: 1,
    target: "cloud", hostId: null, timezone: "UTC", runConfig: {}, runConfigVersion: 1, runKind: "work",
    codeConfig: {}, codeConfigVersion: 1, fireSecretHash: null, fireSecretIssuedAt: null, maxCostMicroUsd: 0,
    maxTokens: 0, maxRuntimeMs: 0, unattendedPolicy: "pause_for_approval", hostOfflinePolicy: "skip",
    maxConcurrentRuns: 1, notifyPolicy: "on_attention", missedRunPolicy: "run_once", retryPolicy: {},
    lastRunAt: null, nextRunAt: null, legacyScheduledTaskId: null, createdAt: NOW, updatedAt: NOW,
  } satisfies WorkScheduleRow;
  const out = serializeSchedule(schedule, [
    {
      id: "t1", kind: "email_filter", config: {}, configVersion: 1, enabled: true,
      lastEventKey: "secret-message-id", lastFiredAt: null, dedupeWindowSec: 3600,
      lastPolledAt: hoursAgo(1), lastPollError: "Juno could not read INBOX",
      createdAt: NOW, updatedAt: NOW,
    },
  ]);
  assert.equal(out.triggers[0].lastPollError, "Alevr could not read INBOX");
  assert.equal(out.triggers[0].lastPolledAt, hoursAgo(1).toISOString());
  assert.equal("lastEventKey" in out.triggers[0], false);
  // A writer that never read the poll columns says nothing about them.
  const bare = serializeSchedule(schedule, [
    { id: "t2", kind: "daily", config: {}, configVersion: 1, enabled: true, lastEventKey: null, lastFiredAt: null, dedupeWindowSec: 0, createdAt: NOW, updatedAt: NOW },
  ]);
  assert.equal("lastPollError" in bare.triggers[0], false);
});
