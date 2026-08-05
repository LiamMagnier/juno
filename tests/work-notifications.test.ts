import test from "node:test";
import assert from "node:assert/strict";
import {
  decideNotification,
  describeNotification,
  notificationKey,
  WORK_NOTIFY_POLICIES,
} from "@/lib/work/notifications";
import { WORK_STATUSES, statusNeedsAttention, type WorkStatus } from "@/lib/work/domain";

/*
 * When to interrupt someone, and when to leave them alone.
 *
 * Both failures are real and they pull in opposite directions. A run that stops
 * to ask and never says so sits blocked until its approval expires, and from
 * the user's side it simply never finished. A run that reports every hourly
 * completion trains its owner to ignore the channel, so the one message that
 * mattered arrives in a stream they stopped reading.
 */

function decide(over: Partial<Parameters<typeof decideNotification>[0]> = {}) {
  return decideNotification({
    status: "running",
    policy: "on_attention",
    attended: false,
    alreadyNotified: false,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// Blocking always wins
// ---------------------------------------------------------------------------

test("a blocked task notifies under every policy, including none", () => {
  for (const policy of WORK_NOTIFY_POLICIES) {
    for (const status of ["waiting_input", "waiting_approval", "host_offline"] as WorkStatus[]) {
      const result = decide({ status, policy });
      assert.equal(
        result.notify,
        true,
        `${status} under ${policy} was silenced; the task then hangs and nothing says why`
      );
      assert.equal(result.notify && result.urgency, "blocking");
    }
  }
});

test("silencing a schedule is a preference about noise, not about hanging", () => {
  const result = decide({ status: "waiting_approval", policy: "none" });
  assert.equal(result.notify, true);
  assert.match(result.reason, /no notification preference silences/);
});

test("every status that needs attention is treated as blocking", () => {
  // Ties the decision to the domain's own definition rather than to a list here
  // that would drift the moment a status is added.
  for (const status of WORK_STATUSES) {
    if (!statusNeedsAttention(status)) continue;
    const result = decide({ status, policy: "none" });
    assert.equal(result.notify, true, `${status} needs attention but was not notified`);
  }
});

// ---------------------------------------------------------------------------
// Not blocking
// ---------------------------------------------------------------------------

test("none stays silent for anything that does not need a person", () => {
  assert.deepEqual(decide({ status: "completed", policy: "none" }).notify, false);
  assert.deepEqual(decide({ status: "running", policy: "none" }).notify, false);
});

test("on_attention is silent about a task that finished by itself", () => {
  const result = decide({ status: "completed", policy: "on_attention" });
  assert.equal(result.notify, false);
  assert.match(result.reason, /only notifies when it needs you/);
});

test("on_finish notifies for every terminal state, not only success", () => {
  for (const status of [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
    "budget_exceeded",
    "timed_out",
  ] as WorkStatus[]) {
    const result = decide({ status, policy: "on_finish" });
    assert.equal(result.notify, true, `${status} is an ending and the user asked to be told`);
  }
});

test("on_finish is silent mid-run", () => {
  assert.equal(decide({ status: "running", policy: "on_finish" }).notify, false);
  assert.equal(decide({ status: "preparing", policy: "on_finish" }).notify, false);
});

test("all is silent about a task the user is currently watching", () => {
  const watched = decide({ status: "running", policy: "all", attended: true });
  assert.equal(
    watched.notify,
    false,
    "a notification for something already on screen is noise"
  );
  const unattended = decide({ status: "running", policy: "all", attended: false });
  assert.equal(unattended.notify, true);
});

test("all still reports the ending of a task the user was watching", () => {
  const result = decide({ status: "completed", policy: "all", attended: true });
  assert.equal(result.notify, true, "they may have looked away by the time it landed");
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

test("nothing is notified twice", () => {
  for (const policy of WORK_NOTIFY_POLICIES) {
    const result = decide({ status: "waiting_approval", policy, alreadyNotified: true });
    assert.equal(result.notify, false, `${policy} re-notified an approval already sent`);
  }
});

test("the dedupe key distinguishes two blocks in one run", () => {
  // A session legitimately blocks several times — approval, question, approval —
  // and a session-level key would notify once and then go quiet for the rest.
  assert.notEqual(
    notificationKey("run_1", "approval_a"),
    notificationKey("run_1", "approval_b")
  );
  assert.notEqual(
    notificationKey("run_1", "approval_a"),
    notificationKey("run_2", "approval_a")
  );
  assert.equal(notificationKey("run_1", "approval_a"), notificationKey("run_1", "approval_a"));
});

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

test("no message renders a raw status into a sentence", () => {
  for (const status of WORK_STATUSES) {
    const message = describeNotification({ title: "Organise Downloads", status });
    for (const text of [message.subject, message.summary]) {
      assert.doesNotMatch(
        text,
        /_/,
        `"${text}" contains an underscore, which means a status leaked into prose`
      );
      assert.ok(text.trim().length > 0, `${status} produced an empty ${text}`);
    }
  }
});

test("a blocked message says what to do about it", () => {
  for (const status of ["waiting_input", "waiting_approval", "host_offline"] as WorkStatus[]) {
    const message = describeNotification({ title: "Organise Downloads", status });
    assert.ok(message.action, `${status} told the user nothing they could do`);
  }
});

test("the question itself is the summary when there is one", () => {
  const message = describeNotification({
    title: "Organise Downloads",
    status: "waiting_input",
    question: "Should invoices from 2023 go under Archive or under Tax?",
  });
  assert.match(message.summary, /Archive or under Tax/);
});

test("an offline host is named, and the message does not imply the local part will happen", () => {
  const message = describeNotification({
    title: "Organise Downloads",
    status: "host_offline",
    hostName: "Mac Studio",
  });
  assert.match(message.subject, /Mac Studio/);
  assert.match(message.summary, /did not run/);
  assert.doesNotMatch(
    message.summary,
    /\bwill run\b|\bqueued\b|\blater\b/,
    "any hint that the local half is still coming makes the user stop watching for it"
  );
});

test("an interrupted run says it was not restarted, and why", () => {
  const message = describeNotification({ title: "Organise Downloads", status: "interrupted" });
  assert.match(message.summary, /did not restart/);
  assert.match(message.summary, /may already have changed something/);
});

test("an empty title still produces something readable", () => {
  const message = describeNotification({ title: "   ", status: "completed" });
  assert.match(message.subject, /Your Juno task/);
});
