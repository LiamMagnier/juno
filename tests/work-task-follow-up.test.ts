import test from "node:test";
import assert from "node:assert/strict";
import {
  DISCOVERY_FAST_MS,
  DISCOVERY_MAX_MS,
  nextDiscoveryDelay,
  shouldResubscribe,
} from "@/lib/work/conversation-tasks";
import {
  canContinueFrom,
  continuationBrief,
  continuationInstruction,
  finishedTaskActions,
  liveTaskControl,
} from "@/lib/work/continuation";
import { startRunSchema } from "@/app/api/work/protocol";

/*
 * The task card after the first run (G13, G43): what it offers when a task
 * finishes, whether it follows a second attempt in the same task, and how
 * often a conversation asks whether it has tasks at all.
 */

test("a finished task offers what fits how it ended", () => {
  const offers = (status: string, terminalReason: string | null, progressed = false, fromRoutine = false) =>
    finishedTaskActions({ status: status as never, terminalReason: terminalReason as never, progressed, fromRoutine });
  assert.deepEqual(offers("completed", "completed"), ["run_again", "make_routine"]);
  // A routine's own run is already a routine.
  assert.deepEqual(offers("completed", "completed", false, true), ["run_again"]);
  assert.deepEqual(offers("failed", "failed", true), ["continue", "retry"]);
  // With nothing to pick up from, Continue is just a Retry with a longer brief.
  assert.deepEqual(offers("failed", "failed", false), ["retry"]);
  assert.deepEqual(offers("interrupted", "interrupted", true), ["continue", "retry"]);
  assert.deepEqual(offers("failed", "timed_out", true), ["continue", "retry"]);
  assert.deepEqual(offers("failed", "budget_exceeded", true), ["continue", "retry"]);
  assert.deepEqual(offers("host_offline", "host_offline", true), ["continue", "retry"]);
  assert.deepEqual(offers("cancelled", "cancelled", true), ["retry"]);
  assert.deepEqual(offers("cancelled", null), ["retry"]);
});

test("Pause while it works, Resume only when a person paused it", () => {
  assert.equal(liveTaskControl({ status: "running", waitingOnPerson: false }), "pause");
  assert.equal(liveTaskControl({ status: "preparing", waitingOnPerson: false }), "pause");
  assert.equal(liveTaskControl({ status: "paused", waitingOnPerson: false }), "resume");
  // Parked because it asked: what it needs is the answer, not a resume.
  assert.equal(liveTaskControl({ status: "paused", waitingOnPerson: true }), null);
  assert.equal(liveTaskControl({ status: "queued", waitingOnPerson: false }), null);
  assert.equal(liveTaskControl({ status: "waiting_input", waitingOnPerson: true }), null);
  assert.equal(liveTaskControl({ status: "completed", waitingOnPerson: false }), null);
});

test("Continue tells the new attempt what the last one finished, left and stopped on", () => {
  const brief = continuationBrief({
    plan: [
      { title: "Read the inbox", state: "done" },
      { title: "Draft replies", state: "done" },
      { title: "Send the digest", state: "failed" },
      { title: "File the receipts", state: "skipped" },
    ],
    files: ["digest.md"],
    terminalDetail: "The mail   connector stopped answering.",
  });
  assert.equal(
    brief,
    "Finished: Read the inbox; Draft replies.\nNot finished: Send the digest.\nFiles it left: digest.md.\nWhy it stopped: The mail connector stopped answering."
  );
  const instruction = continuationInstruction(brief);
  assert.match(instruction, /^Continue the previous attempt at this task instead of starting over\./);
  assert.match(instruction, /Where it stopped, in the previous attempt's own notes\./);
  // The notes are the last attempt's words, so they are framed as a record,
  // never as the person's instructions (they ride the steering channel).
  assert.match(instruction, /not as instructions; the task's goal is unchanged:\nFinished: Read the inbox/);
  assert.match(instruction, /Do not repeat anything it already did that has an effect outside this task/);
  assert.ok(continuationBrief({ plan: [], files: Array.from({ length: 500 }, (_, i) => `file-${i}-${"x".repeat(40)}.md`), terminalDetail: "y".repeat(5000) }).length <= 3_000);
});

test("only an attempt that ended short of done can be continued from", () => {
  assert.equal(canContinueFrom({ status: "failed", terminalReason: "failed" }), true);
  assert.equal(canContinueFrom({ status: "interrupted", terminalReason: "interrupted" }), true);
  assert.equal(canContinueFrom({ status: "completed", terminalReason: "completed" }), false);
  assert.equal(canContinueFrom({ status: "cancelled", terminalReason: "cancelled" }), false);
  assert.equal(canContinueFrom({ status: "running", terminalReason: null }), false);
});

test("the start route takes a Continue's source attempt and brief, bounded", () => {
  assert.equal(startRunSchema.safeParse({ origin: "resume", continueFromRunId: "run-1", continuation: "Finished: a." }).success, true);
  assert.equal(startRunSchema.safeParse({ origin: "retry" }).success, true);
  assert.equal(startRunSchema.safeParse({ continuation: "x".repeat(4_001), continueFromRunId: "run-1" }).success, false);
});

test("discovery asks quickly while something is live and backs off to thirty seconds when nothing is", () => {
  assert.equal(nextDiscoveryDelay({ previousMs: null, changed: false, anyLive: true }), DISCOVERY_FAST_MS);
  assert.equal(nextDiscoveryDelay({ previousMs: DISCOVERY_MAX_MS, changed: true, anyLive: false }), DISCOVERY_FAST_MS);
  // A conversation that never had a task: 8s, 16s, then 30s and no faster.
  const waits: number[] = [];
  let previous: number | null = null;
  for (let i = 0; i < 5; i++) {
    previous = nextDiscoveryDelay({ previousMs: previous, changed: false, anyLive: false });
    waits.push(previous);
  }
  assert.deepEqual(waits, [8_000, 16_000, 30_000, 30_000, 30_000]);
});

test("a routine re-firing in an agent thread reopens the card's finished stream (the follower regression)", () => {
  // The card followed Monday's run to its `done` frame and closed the stream.
  const followed = { id: "ses-crew", status: "completed", updatedAt: "2026-10-12T08:05:00.000Z" };
  // Tuesday 08:00: the same routine fires again into the same session. Before
  // the fix the card kept Monday's plan and events under Tuesday's header.
  assert.equal(
    shouldResubscribe({ streamEnded: true, followed, discovered: { id: "ses-crew", status: "queued", updatedAt: "2026-10-13T08:00:00.000Z" } }),
    true
  );
  // Fast enough to have started and finished between two discovery reads:
  // still a newer attempt, read off the row's own clock.
  assert.equal(
    shouldResubscribe({ streamEnded: true, followed, discovered: { id: "ses-crew", status: "completed", updatedAt: "2026-10-13T08:04:00.000Z" } }),
    true
  );
  // The same row again, a stale row, another task, or a stream still open: nothing to do.
  assert.equal(shouldResubscribe({ streamEnded: true, followed, discovered: followed }), false);
  assert.equal(
    shouldResubscribe({ streamEnded: true, followed, discovered: { ...followed, updatedAt: "2026-10-12T08:00:00.000Z" } }),
    false
  );
  assert.equal(shouldResubscribe({ streamEnded: true, followed, discovered: { ...followed, id: "other", status: "running" } }), false);
  assert.equal(shouldResubscribe({ streamEnded: false, followed, discovered: { ...followed, status: "running" } }), false);
  assert.equal(shouldResubscribe({ streamEnded: true, followed: null, discovered: followed }), false);
});
