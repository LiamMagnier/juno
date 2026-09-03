import test from "node:test";
import assert from "node:assert/strict";
import {
  sendApnsNotification,
  buildCodeApprovalPayload,
  buildTaskCompletionPayload,
  sendCodeApprovalPushNotification,
  sendTaskCompletionPushNotification,
  type ApnsPayload,
} from "@/lib/apns";

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
