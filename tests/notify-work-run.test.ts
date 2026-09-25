import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { planWorkRunNotification, workRunChannel, workRunPath, type WorkRunNotifyFacts } from "@/lib/notify/work-run";
import { clampPushText, pushIsLive, pushRouteIds, pushSwitchFilter, webPushText } from "@/lib/notify/push";
import { describeNotification } from "@/lib/work/notifications";

/*
 * A Work run's notification: what the inbox row says, what the lock screen
 * says, which switch governs it and where it opens — and the wiring that makes
 * it go out at all, pinned as source because the modules that send it import
 * `server-only` and cannot be loaded here.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

const AGENT = { id: "agt_1", name: "Quill", avatar: { shape: "orb" } };
const EXPIRES = new Date("2026-09-24T12:00:00.000Z");

function facts(over: Partial<WorkRunNotifyFacts> = {}): WorkRunNotifyFacts {
  const status = over.status ?? "waiting_approval";
  return {
    runId: "run_1",
    sessionId: "ses_1",
    conversationId: "cnv_1",
    status,
    urgency: "blocking",
    message: describeNotification({ title: "Organise downloads", status, actorName: over.agent === null ? null : "Quill" }),
    agent: AGENT,
    approval: { id: "apr_1", expiresAt: EXPIRES },
    questionId: null,
    quoted: { question: null, approvalSummary: null },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------

test("an agent's approval rings the needs-you switch, now, until it expires", () => {
  const plan = planWorkRunNotification(facts());
  assert.equal(plan.channel, "needs_you");
  assert.equal(plan.priority, "urgent");
  assert.equal(plan.type, "work_approval");
  assert.equal(plan.actionable, true);
  assert.equal(plan.path, "/agents/agt_1");
  assert.equal(plan.agent, AGENT);
  assert.ok(plan.push);
  assert.equal(plan.push.title, "Quill", "an agent's task arrives from the agent");
  assert.equal(plan.push.subtitle, "Organise downloads needs your approval");
  assert.equal(plan.push.body, "Quill is waiting for you to approve one action.");
  assert.equal(plan.push.interruption, "time-sensitive");
  assert.equal(plan.push.threadId, "agent-agt_1");
  assert.equal(plan.push.collapseId, "run-run_1");
  assert.equal(plan.push.expiresAt, EXPIRES);
  assert.deepEqual(plan.push.data, { runId: "run_1", sessionId: "ses_1", conversationId: "cnv_1", agentId: "agt_1" });
  assert.equal(plan.actionData?.approvalId, "apr_1");
  assert.equal(plan.actionData?.runId, "run_1", "the decision route clears rows by this key");
});

test("a question is needs-you too, with no expiry", () => {
  const plan = planWorkRunNotification(facts({ status: "waiting_input", approval: null, questionId: "q_1" }));
  assert.equal(plan.channel, "needs_you");
  assert.equal(plan.push?.interruption, "time-sensitive");
  assert.equal(plan.push?.expiresAt, null);
  assert.equal(plan.actionData?.questionId, "q_1");
});

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

test("a finished task is an update, and takes the needs-you push's slot on the device", () => {
  const plan = planWorkRunNotification(facts({ status: "completed", urgency: "informational", approval: null }));
  assert.equal(plan.channel, "updates");
  assert.equal(plan.priority, "normal");
  assert.equal(plan.type, "work_completed");
  assert.equal(plan.actionable, false);
  assert.equal(plan.push?.interruption, "active");
  assert.equal(plan.push?.collapseId, planWorkRunNotification(facts()).push?.collapseId);
  assert.equal(planWorkRunNotification(facts({ status: "failed", urgency: "informational", approval: null })).type, "work_failed");
});

test("a host that went away needs the person, but does not break through Focus", () => {
  const plan = planWorkRunNotification(facts({ status: "host_offline", urgency: "blocking", approval: null }));
  assert.equal(plan.channel, "needs_you");
  assert.equal(plan.actionable, false);
  assert.equal(plan.push?.interruption, "active");
});

test("without an agent the task speaks for itself, in its conversation or its resolver", () => {
  const plan = planWorkRunNotification(facts({ agent: null }));
  assert.equal(plan.path, "/chat/cnv_1");
  assert.equal(plan.push?.title, "Organise downloads needs your approval");
  assert.equal(plan.push?.subtitle, null);
  assert.equal(plan.push?.threadId, "work-ses_1");
  assert.equal("agentId" in (plan.push?.data ?? {}), false);
  assert.equal(workRunPath({ agent: null, conversationId: null, sessionId: "ses_1" }), "/work/ses_1");
  assert.equal(workRunChannel("informational"), "updates");
});

// ---------------------------------------------------------------------------
// Restricted runs
// ---------------------------------------------------------------------------

test("a restricted run's words stay off the lock screen and off the row", () => {
  // deliver.ts passes null detail when `mayIncludeRunDetail` says no; the
  // message is then the generic sentence and the row stores nothing quotable.
  const plan = planWorkRunNotification(facts());
  assert.equal("approvalSummary" in (plan.actionData ?? {}), false);
  assert.equal("question" in (plan.actionData ?? {}), false);

  const summary = "Send the Q3 board pack to Dana";
  const quoted = planWorkRunNotification(
    facts({
      message: describeNotification({ title: "Board pack", status: "waiting_approval", approvalSummary: summary }),
      quoted: { question: null, approvalSummary: summary },
    })
  );
  assert.equal(quoted.actionData?.approvalSummary, summary, "a run that may be quoted still is");
  assert.equal(quoted.push?.body, summary);
});

test("deliver.ts gates the run's words once, for every channel", () => {
  const deliver = read("../src/lib/work/notify/deliver.ts");
  assert.match(deliver, /question: mayQuote \? occasion\.question : null,/);
  assert.match(deliver, /approvalSummary: mayQuote \? occasion\.approvalSummary : null,/);
  assert.match(deliver, /\.\.\.quoted,\n  \}\);/, "the message is described from the gated words");
  assert.doesNotMatch(deliver, /occasion\.question \?\? null/, "the raw question is never stored");
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test("the inbox and the pushes go out before, and apart from, the email gate", () => {
  const deliver = read("../src/lib/work/notify/deliver.ts");
  const notify = deliver.indexOf("await notifyUser({");
  const emailGate = deliver.indexOf("if (!isEmailEnabled()) return false;");
  assert.ok(notify > 0 && emailGate > 0);
  assert.ok(deliver.indexOf("sendRunEmail(run,") > notify, "email follows the inbox");
  assert.match(deliver, /claimDelivery\("app", key, now\)/);
  assert.match(deliver, /claimDelivery\("email", key, now\)/);
  assert.doesNotMatch(deliver, /prismaUnguarded\.notification\.create/, "one writer of rows: notifyUser");
  // Email keeps its historical key, so nothing already emailed is sent again.
  assert.match(deliver, /channel === "email" \? `work:notify:\$\{key\}`/);
});

test("a parked run is read for what it waits on, and an ended one clears its asks", () => {
  const deliver = read("../src/lib/work/notify/deliver.ts");
  assert.match(deliver, /run\.status === "paused" \? await parkedStatus\(/);
  assert.match(deliver, /if \(isTerminalStatus\(run\.status\)\) \{\n\s+await markRunNotificationsRead\(run\.userId, run\.id, now\);/);
  assert.match(deliver, /runNotifyPolicy\(\{/);
  assert.match(deliver, /actorName: agent\?\.name \?\? null,/);
  assert.match(deliver, /where: \{ id: run\.session\.agentId, userId: run\.userId, deletedAt: null \}/);
});

test("an unattended cloud run notifies the moment it blocks; an attended one when it parks", () => {
  const runner = read("../scripts/work-runner.ts");
  const immediate = runner.match(
    /if \(!isAttendedOrigin\(run\.origin\)\)(?: \{\n\s+|\s)void deliverRunNotification\(\{ runId: input\.runId, userId: input\.userId(, settleMs: [\d_]+)? \}\);/g
  );
  assert.equal(immediate?.length, 2, "one after askQuestion's and one after requestApproval's setSessionAttention");
  // The question's event is queued behind the run's earlier ones; the approval
  // row is written before the call, so only the question waits for it.
  assert.equal(immediate?.filter((call) => call.includes("settleMs")).length, 1);
  for (const status of ["waiting_input", "waiting_approval"]) {
    const attention = runner.indexOf(`status: "${status}",\n        });\n`);
    const call = runner.indexOf("if (!isAttendedOrigin(run.origin))", attention);
    assert.ok(attention > 0 && call > attention && call - attention < 600, `${status}: the call follows setSessionAttention`);
  }
  assert.match(runner, /const notified = await deliverRunNotification\(\{ runId, userId \}\);/, "the park path still notifies");
});

test("a waiting run looks again, briefly, for the question it has just asked", () => {
  const deliver = read("../src/lib/work/notify/deliver.ts");
  assert.match(deliver, /while \(occasion === null && Date\.now\(\) < settleUntil\) \{/);
  // Zero unless asked for: the park path must not sit on its worker.
  assert.match(deliver, /Math\.max\(0, input\.settleMs \?\? 0\)/);
});

test("an APNs refusal is read from the status, and older pushes follow the switches", () => {
  const apns = read("../src/lib/apns.ts");
  // A 502 with an empty body has no reason to read and is still not a delivery.
  assert.match(apns, /if \(res\.ok\) \{\n\s+return \{\n\s+success: true,/);
  assert.match(apns, /if \(retried\.ok\) \{/);
  assert.doesNotMatch(apns, /if \(!res\.reason\)|if \(!retried\.reason\)/);
  assert.match(apns, /sendPushToUser\(params\.userId, payload, undefined, \{ channel: "needs_you" \}\)/, "Code approvals ask");
  assert.match(apns, /sendPushToUser\(params\.userId, payload, undefined, \{ channel: "updates" \}\)/);
});

test("a Mac's run notifies when its ending arrives", () => {
  const route = read("../src/app/api/work/hosts/[id]/events/route.ts");
  assert.match(route, /if \(finished\?\.finished\) \{\n\s+after\(\(\) => deliverRunNotification\(\{ runId: run\.id, userId: user\.id \}\)\);/);
  assert.ok(route.indexOf("deliverRunNotification({") > route.indexOf("await finishRun({"));
});

test("a decided approval clears the run's asks, and names the client that decided", () => {
  const route = read("../src/app/api/work/approvals/[id]/decision/route.ts");
  assert.match(route, /await markRunNotificationsRead\(user\.id, approval\.runId, now\)/);
  assert.ok(route.indexOf("markRunNotificationsRead(") > route.indexOf("const recorded = await prisma.workApproval.updateMany("));
  assert.match(route, /decidedVia: via \}/);
  assert.doesNotMatch(route, /decidedVia: "web"/);
});

test("notifyUser writes the row before it pushes, and pushes on the channel's switch", () => {
  const lib = read("../src/lib/notifications.ts");
  const body = lib.slice(lib.indexOf("export async function notifyUser("));
  assert.ok(body.indexOf("writeInAppRow(input)") < body.indexOf("pushEverywhere("));
  assert.match(lib, /\{ channel: input\.channel \}\n\s+\)/, "APNs filtered by the device switch");
  assert.match(lib, /sendWebPushToUser\(/);
  assert.match(lib, /expiresAt: push\.expiresAt \?\? null,/, "a browser's push expires with the approval too");
  assert.match(lib, /if \(!pushIsLive\(push, new Date\(\)\)\) return 0;/);
  // tests import apns.ts; it must never pull the server-only notifications in.
  assert.doesNotMatch(read("../src/lib/apns.ts"), /@\/lib\/notifications"/);
});

test("revoking a native sign-in stops its pushes", () => {
  const auth = read("../src/lib/native-auth.ts");
  const revoke = auth.slice(auth.indexOf("export async function revokeNativeDevice("));
  assert.match(revoke, /devicePushToken\.updateMany\(\{\n\s+where: \{ userId, deviceSessionId, active: true \},\n\s+data: \{ active: false \},/);
  assert.match(auth, /tx\.devicePushToken\.updateMany\(/, "refresh-token reuse revokes the sign-in, and its pushes");
  const route = read("../src/app/api/v1/devices/apns/route.ts");
  assert.match(route, /deviceSessionId: user\.deviceSessionId,/);
  assert.match(route, /rateLimit\(\{ key: `apns-register:\$\{user\.id\}`/);
});

// ---------------------------------------------------------------------------
// The push shape both transports share
// ---------------------------------------------------------------------------

test("an expired approval is not pushed", () => {
  const now = new Date("2026-09-24T12:00:00.000Z");
  assert.equal(pushIsLive({ expiresAt: new Date(now.getTime() - 1) }, now), false);
  assert.equal(pushIsLive({ expiresAt: now }, now), false);
  assert.equal(pushIsLive({ expiresAt: new Date(now.getTime() + 1) }, now), true);
  assert.equal(pushIsLive({ expiresAt: null }, now), true);
});

test("each channel has its own switch", () => {
  assert.deepEqual(pushSwitchFilter("needs_you"), { notifyNeedsYou: true });
  assert.deepEqual(pushSwitchFilter("updates"), { notifyUpdates: true });
});

test("only known route ids that look like ids leave in a push", () => {
  assert.deepEqual(pushRouteIds({ runId: "run_1", agentId: "a b", note: "x", sessionId: "ses-1" }), { runId: "run_1", sessionId: "ses-1" });
  assert.deepEqual(pushRouteIds(undefined), {});
});

test("a browser shows the subtitle at the head of the body", () => {
  assert.deepEqual(webPushText({ title: "Quill", subtitle: "Organise downloads is done", body: "Quill finished the task." }), {
    title: "Quill",
    body: "Organise downloads is done. Quill finished the task.",
  });
  assert.deepEqual(webPushText({ title: "Done", subtitle: "Is it done?", body: "Yes." }).body, "Is it done? Yes.");
  assert.deepEqual(webPushText({ title: "Done", subtitle: null, body: "Yes." }), { title: "Done", body: "Yes." });
});

test("clamping cuts on a word, with an ellipsis, and leaves short text alone", () => {
  assert.equal(clampPushText("  short   text ", 40), "short text");
  const cut = clampPushText("the quick brown fox jumps over the lazy dog", 20);
  assert.ok(cut.length <= 20);
  assert.match(cut, /^the quick brown…$/);
});
