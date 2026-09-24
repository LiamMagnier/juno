import test from "node:test";
import assert from "node:assert/strict";
import {
  APNS_CATEGORY_NEEDS_YOU,
  APNS_CATEGORY_UPDATE,
  apnsTopicFor,
  cleanDeviceToken,
  sendApnsNotification,
  buildCodeApprovalPayload,
  buildNotifyApnsPayload,
  buildTaskCompletionPayload,
  notifyApnsOptions,
  sendCodeApprovalPushNotification,
  sendPushToUser,
  sendTaskCompletionPushNotification,
  type ApnsPayload,
} from "@/lib/apns";
import type { NotifyPush } from "@/lib/notify/push";

test("sendApnsNotification simulates push in dev environment without credentials", async () => {
  const payload: ApnsPayload = {
    aps: {
      alert: {
        title: "Test Alert",
        body: "Hello world",
      },
      sound: "default",
    },
  };

  const result = await sendApnsNotification({
    token: "<7a8b9c0d 1e2f3a4b 5c6d7e8f 9a0b1c2d>",
    payload,
    topic: "com.liammagnier.juno",
  });

  assert.equal(result.success, true);
  assert.equal(result.simulated, true);
  assert.ok(result.apnsId?.startsWith("sim_"));
});

test("buildCodeApprovalPayload constructs time-sensitive approval alert", () => {
  const payload = buildCodeApprovalPayload({
    sessionId: "sess_123",
    approvalId: "appr_456",
    toolName: "bash",
    prompt: "git push origin main",
    workspace: "juno",
  });

  assert.equal(payload.aps.category, "CODE_APPROVAL");
  assert.equal(payload.aps["interruption-level"], "time-sensitive");
  assert.equal(payload.aps["thread-id"], "code-session-sess_123");
  assert.equal(payload.sessionId, "sess_123");
  assert.equal(payload.approvalId, "appr_456");
  assert.equal(payload.toolName, "bash");
});

test("buildTaskCompletionPayload constructs completion and error alerts", () => {
  const success = buildTaskCompletionPayload({
    taskId: "task_1",
    title: "Market Analysis",
    status: "completed",
    summary: "Finished all 10 steps.",
  });
  assert.equal(success.aps.category, "TASK_COMPLETION");
  assert.equal(success.status, "completed");

  const failure = buildTaskCompletionPayload({
    taskId: "task_2",
    title: "Market Analysis",
    status: "failed",
  });
  assert.equal(failure.status, "failed");
});

test("sendCodeApprovalPushNotification gracefully handles missing DB or unconfigured users", async () => {
  const results = await sendCodeApprovalPushNotification({
    userId: "user_non_existent",
    sessionId: "sess_123",
    approvalId: "appr_456",
    toolName: "bash",
    prompt: "rm -rf /tmp/cache",
    workspace: "my-project",
  });

  assert.ok(Array.isArray(results));
  assert.equal(results.length, 0);
});

test("sendTaskCompletionPushNotification gracefully handles missing DB or unconfigured users", async () => {
  const results = await sendTaskCompletionPushNotification({
    userId: "user_non_existent",
    taskId: "task_789",
    title: "Deep Market Research",
    status: "completed",
    summary: "Found 12 sources and 4 key insights.",
  });

  assert.ok(Array.isArray(results));
  assert.equal(results.length, 0);
});

test("sendPushToUser filtered by a channel still answers [] without a database", async () => {
  const results = await sendPushToUser(
    "user_non_existent",
    { aps: { alert: { title: "t", body: "b" } } },
    { environment: "production" },
    { channel: "needs_you" }
  );
  assert.deepEqual(results, []);
});

// ---------------------------------------------------------------------------
// Topics and tokens
// ---------------------------------------------------------------------------

test("a device's own bundle id is its topic, and the fallback is a real app per platform", () => {
  const saved = process.env.APNS_BUNDLE_ID;
  delete process.env.APNS_BUNDLE_ID;
  try {
    assert.equal(apnsTopicFor({ platform: "ios", bundleId: "com.liammagnier.JunoMobile.next" }, "com.other"), "com.liammagnier.JunoMobile.next");
    assert.equal(apnsTopicFor({ platform: "ios", bundleId: null }), "com.liammagnier.JunoMobile");
    assert.equal(apnsTopicFor({ platform: "macos", bundleId: null }), "com.liammagnier.JunoDesktop");
    assert.equal(apnsTopicFor({ platform: "macos", bundleId: null }, "com.liammagnier.JunoDesktop.debug"), "com.liammagnier.JunoDesktop.debug");
    // Read at call time, not at import: the workers load .env late.
    process.env.APNS_BUNDLE_ID = "com.liammagnier.JunoMobile.debug";
    assert.equal(apnsTopicFor({ platform: "ios", bundleId: null }), "com.liammagnier.JunoMobile.debug");
    for (const platform of ["ios", "macos"]) {
      assert.notEqual(apnsTopicFor({ platform, bundleId: null }), "com.liammagnier.juno", "that bundle id is no app");
    }
  } finally {
    if (saved === undefined) delete process.env.APNS_BUNDLE_ID;
    else process.env.APNS_BUNDLE_ID = saved;
  }
});

test("a token is stored the one way however the app printed it", () => {
  assert.equal(cleanDeviceToken(" <7A8B9C0D 1e2f3a4b> "), "7a8b9c0d1e2f3a4b");
});

// ---------------------------------------------------------------------------
// notifyUser's push (the payload contract the apps route on)
// ---------------------------------------------------------------------------

function push(over: Partial<NotifyPush> = {}): NotifyPush {
  return {
    title: "Quill",
    subtitle: "Organise downloads needs your approval",
    body: "Move 14 files from Downloads to Archive.",
    threadId: "agent-agt_1",
    collapseId: "run-run_1",
    interruption: "time-sensitive",
    expiresAt: new Date("2026-09-24T12:00:00.000Z"),
    data: { runId: "run_1", sessionId: "ses_1", conversationId: "cnv_1", agentId: "agt_1" },
    ...over,
  };
}

test("a needs-you push carries the route keys as flat strings beside aps", () => {
  const payload = buildNotifyApnsPayload({
    notificationId: "ntf_1",
    path: "/agents/agt_1",
    channel: "needs_you",
    agentId: "agt_1",
    push: push(),
  });
  assert.equal(payload.aps.category, APNS_CATEGORY_NEEDS_YOU);
  assert.equal(payload.aps.category, "JUNO_NEEDS_YOU");
  assert.equal(payload.aps["thread-id"], "agent-agt_1");
  assert.equal(payload.aps["interruption-level"], "time-sensitive");
  assert.equal(payload.aps.sound, "default");
  assert.deepEqual(payload.aps.alert, {
    title: "Quill",
    subtitle: "Organise downloads needs your approval",
    body: "Move 14 files from Downloads to Archive.",
  });
  assert.equal(payload.notificationId, "ntf_1");
  assert.equal(payload.path, "/agents/agt_1");
  assert.equal(payload.kind, "agent");
  assert.equal(payload.agentId, "agt_1");
  assert.equal(payload.conversationId, "cnv_1");
  assert.equal(payload.sessionId, "ses_1");
  assert.equal(payload.runId, "run_1");
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "aps") assert.equal(typeof value, "string", `${key} must be a string for the apps' userInfo`);
  }
  assert.equal(payload.aps.badge, undefined, "the apps keep no badge state, so none is set from here");
});

test("an update is the other category, and work without an agent says so", () => {
  const payload = buildNotifyApnsPayload({
    notificationId: null,
    path: "/chat/cnv_1",
    channel: "updates",
    push: push({ title: "Organise downloads is done", subtitle: null, interruption: "active", data: { runId: "run_1" } }),
  });
  assert.equal(payload.aps.category, APNS_CATEGORY_UPDATE);
  assert.equal(payload.aps.category, "JUNO_UPDATE");
  assert.equal(payload.kind, "work");
  assert.equal("notificationId" in payload, false);
  assert.equal("agentId" in payload, false);
  assert.equal((payload.aps.alert as { subtitle?: string }).subtitle, undefined);
});

test("a passive push makes no sound", () => {
  const payload = buildNotifyApnsPayload({ notificationId: "n", path: null, channel: "updates", push: push({ interruption: "passive" }) });
  assert.equal(payload.aps.sound, undefined);
  assert.equal(payload.aps["interruption-level"], "passive");
});

test("the path is revalidated and anything that is not an app path is dropped", () => {
  for (const path of ["https://evil.example/agents/1", "//evil.example", "/\\evil", "/admin/users", "javascript:alert(1)"]) {
    const payload = buildNotifyApnsPayload({ notificationId: "n", path, channel: "updates", push: push() });
    assert.equal("path" in payload, false, `${path} reached the payload`);
  }
});

test("only route ids ride along in the payload, never sentences", () => {
  const payload = buildNotifyApnsPayload({
    notificationId: "n",
    path: null,
    channel: "needs_you",
    push: push({ data: { runId: "run_1", question: "Send the Q3 board pack to Dana?", sessionId: "has spaces in it" } }),
  });
  assert.equal(payload.runId, "run_1");
  assert.equal("question" in payload, false);
  assert.equal("sessionId" in payload, false);

  const named = buildNotifyApnsPayload({ notificationId: "n", path: null, channel: "updates", agentId: "../agents", push: push({ data: {} }) });
  assert.equal("agentId" in named, false, "the named agent's id is checked like the rest");
  assert.equal(named.kind, "work");
});

test("lock-screen text is clamped so a payload never outgrows APNs's 4 KB", () => {
  const long = "word ".repeat(2000);
  const payload = buildNotifyApnsPayload({
    notificationId: "n",
    path: "/chat/c",
    channel: "updates",
    push: push({ title: long, subtitle: long, body: long }),
  });
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4096);
  assert.match((payload.aps.alert as { body: string }).body, /…$/);
});

test("the request headers follow the interruption, the collapse id and the expiry", () => {
  const needsYou = notifyApnsOptions(push());
  assert.equal(needsYou.priority, 10);
  assert.equal(needsYou.collapseId, "run-run_1");
  assert.equal(needsYou.expiration, Math.floor(Date.parse("2026-09-24T12:00:00.000Z") / 1000));

  const passive = notifyApnsOptions(push({ interruption: "passive", collapseId: null, expiresAt: null }));
  assert.equal(passive.priority, 5);
  assert.equal(passive.collapseId, undefined);
  assert.equal(passive.expiration, undefined);

  // APNs refuses a collapse id over 64 bytes; better none than a refused push.
  assert.equal(notifyApnsOptions(push({ collapseId: "x".repeat(65) })).collapseId, undefined);
  assert.equal(notifyApnsOptions(push({ collapseId: "x".repeat(64) })).collapseId, "x".repeat(64));
});
