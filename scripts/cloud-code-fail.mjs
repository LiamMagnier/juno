#!/usr/bin/env node
// @ts-check
/**
 * Cloud Juno Code — failure backstop.
 *
 * Runs as the workflow's `if: failure()` step. The driver
 * (scripts/cloud-code-runner.mjs) already posts a terminal `failed` status from
 * its own catch for ordinary errors; this covers the case where the driver was
 * hard-killed (OOM, cancellation, timeout) before it could. It reconstructs
 * auth from the ephemeral handoff file the driver wrote after fetching
 * runner-context, so a crashed runner never leaves the task hanging.
 *
 * Best-effort and silent on any problem: if the handoff file is absent (we
 * crashed before obtaining the fresh token) there is nothing to authenticate
 * with, so we simply exit 0 and let the server's own timeout reap the task.
 * Never logs the token.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RUNNER_TEMP = process.env.RUNNER_TEMP || os.tmpdir();
const AUTH_HANDOFF_PATH = path.join(RUNNER_TEMP, "juno-runner-auth.json");

async function main() {
  let handoff;
  try {
    handoff = JSON.parse(fs.readFileSync(AUTH_HANDOFF_PATH, "utf8"));
  } catch {
    console.log("[cloud-code-fail] no auth handoff; the driver already finalized or never got a token.");
    return;
  }
  const { taskId, callbackBase, taskToken } = handoff ?? {};
  if (!taskId || !callbackBase || !taskToken) {
    console.log("[cloud-code-fail] handoff incomplete; nothing to post.");
    return;
  }

  try {
    const res = await fetch(`${String(callbackBase).replace(/\/+$/, "")}/api/code/tasks/${taskId}/events`, {
      method: "POST",
      headers: { Authorization: `Bearer ${taskToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        events: [{ kind: "error", payload: { message: "The Cloud Code runner terminated unexpectedly." } }],
        status: "failed",
        afterControlSeq: 0,
      }),
    });
    console.log(`[cloud-code-fail] posted failed status (HTTP ${res.status}).`);
  } catch (err) {
    console.log("[cloud-code-fail] could not reach Juno:", err instanceof Error ? err.message : String(err));
  } finally {
    try {
      fs.rmSync(AUTH_HANDOFF_PATH, { force: true });
    } catch {
      /* ignore */
    }
  }
}

main().then(() => process.exit(0));
