#!/usr/bin/env node

/**
 * Small HTTP-level post-deploy smoke gate.
 *
 * It is intentionally not a browser test: this exercises the deployed health,
 * native catalog, durable first-submission receipt, SSE completion and replay
 * contract with a dedicated staging/smoke account. Set JUNO_SMOKE_RUN_CHAT=1
 * only for an account whose plan/provider budget is reserved for this check.
 */

const baseUrl = (process.env.JUNO_SMOKE_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.JUNO_SMOKE_TOKEN ?? "";
const cookie = process.env.JUNO_SMOKE_COOKIE ?? "";
const expectedVersion = process.env.JUNO_SMOKE_EXPECTED_SHA ?? "";
const timeoutMs = Number(process.env.JUNO_SMOKE_TIMEOUT_MS ?? 20_000);

if (!baseUrl) {
  console.error("JUNO_SMOKE_BASE_URL is required.");
  process.exit(2);
}

const headers = {
  Accept: "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(cookie ? { Cookie: cookie } : {}),
};

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...headers, ...(init.headers ?? {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function json(response) {
  const text = await response.text();
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    return { text, value: null };
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const healthResponse = await request("/api/health");
  const health = await json(healthResponse);
  assert(healthResponse.ok && health.value?.ok === true, `health failed: ${health.text.slice(0, 500)}`);
  if (expectedVersion) assert(health.value.version === expectedVersion, `health version ${health.value.version} != ${expectedVersion}`);
  console.log(`PASS health ${health.value.version}`);

  // The catalog check is authenticated because it verifies the same contract
  // a native client sees, including plan and model-capability availability.
  if (!token && !cookie) {
    console.log("PASS health-only smoke (set JUNO_SMOKE_TOKEN or JUNO_SMOKE_COOKIE for catalog/replay checks)");
    return;
  }
  const modelsResponse = await request("/api/v1/models");
  const models = await json(modelsResponse);
  assert(modelsResponse.ok && Array.isArray(models.value?.models), `models failed: ${models.text.slice(0, 500)}`);
  assert(modelsResponse.headers.get("x-juno-contract-version") === "1.3.0", "native contract header drifted");
  const selected = process.env.JUNO_SMOKE_MODEL || models.value.models.find((model) => model.modality === "chat" && model.availability === "available")?.id;
  assert(selected, "no available chat model was returned for the smoke account");
  console.log(`PASS catalog ${selected}`);

  if (process.env.JUNO_SMOKE_RUN_CHAT !== "1") {
    console.log("PASS authenticated catalog smoke (set JUNO_SMOKE_RUN_CHAT=1 to exercise provider/replay)");
    return;
  }

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const clientRequestId = `smoke-request-${suffix}`;
  const clientMessageId = `smoke-message-${suffix}`;
  const body = JSON.stringify({
    message: process.env.JUNO_SMOKE_PROMPT || "Reply with exactly: Juno smoke pass.",
    model: selected,
    clientRequestId,
    clientMessageId,
    client: "web",
  });
  const firstResponse = await request("/api/chat", {
    method: "POST",
    headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
    body,
  });
  const first = await json(firstResponse);
  assert(firstResponse.ok, `chat submit failed (${firstResponse.status}): ${first.text.slice(0, 500)}`);
  assert(/(?:done|finishReason|receiptState)/i.test(first.text), "chat response never reached a terminal SSE/recovery marker");
  console.log("PASS chat submission reached a terminal response");

  let receipt = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await request(`/api/chat/receipt?clientRequestId=${encodeURIComponent(clientRequestId)}`);
    const result = await json(response);
    if (response.ok && result.value?.receiptState && result.value.receiptState !== "claimed" && result.value.receiptState !== "running") {
      receipt = result.value;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  assert(receipt, "durable chat receipt did not become terminal within 30 seconds");
  assert(receipt.userMessageId && receipt.conversationId, "terminal receipt omitted canonical ids");
  console.log(`PASS receipt ${receipt.receiptState}`);

  const replayResponse = await request("/api/chat", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body,
  });
  const replay = await json(replayResponse);
  assert(replayResponse.ok, `idempotent replay failed (${replayResponse.status}): ${replay.text.slice(0, 500)}`);
  assert(
    !replay.value?.userMessageId || replay.value.userMessageId === receipt.userMessageId,
    "idempotent replay returned a different user message",
  );
  console.log("PASS idempotent replay returned the canonical receipt");
}

main().catch((error) => {
  console.error(`FAIL production smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
