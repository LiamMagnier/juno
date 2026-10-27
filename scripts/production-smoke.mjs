#!/usr/bin/env node

/**
 * Small HTTP-level post-deploy smoke gate.
 *
 * It is intentionally not a browser test: this exercises the deployed health,
 * native catalog, durable first-submission receipt, SSE completion and replay
 * contract with a dedicated staging/smoke account. Authenticated runs always
 * exercise the provider/replay path, so the account's plan/provider budget must
 * be reserved for this check.
 */

const baseUrl = (process.env.JUNO_SMOKE_BASE_URL ?? "").replace(/\/$/, "");
const token = process.env.JUNO_SMOKE_TOKEN ?? "";
const cookie = process.env.JUNO_SMOKE_COOKIE ?? "";
const expectedVersion = process.env.JUNO_SMOKE_EXPECTED_SHA ?? "";
const timeoutMs = Number(process.env.JUNO_SMOKE_TIMEOUT_MS ?? 20_000);
const requireAuth = process.env.JUNO_SMOKE_REQUIRE_AUTH === "1";
const requireVoiceEntitlement = process.env.JUNO_SMOKE_REQUIRE_VOICE_TOKEN === "1";

if (!baseUrl) {
  console.error("JUNO_SMOKE_BASE_URL is required.");
  process.exit(2);
}

const headers = {
  Accept: "application/json",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
  ...(cookie ? { Cookie: cookie } : {}),
};

/** Cookie-authenticated mutations require a same-origin Origin (see src/lib/csrf.ts). */
function headersForRequest(init = {}) {
  const merged = { ...headers, ...(init.headers ?? {}) };
  const method = (init.method ?? "GET").toUpperCase();
  const isMutation = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  if (cookie && isMutation && !merged.Origin) {
    merged.Origin = baseUrl;
    merged["Sec-Fetch-Site"] ??= "same-origin";
  }
  return merged;
}

async function request(path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: headersForRequest(init),
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

/**
 * The error frame in an SSE body: its sentence (`quoted`) and, from a chat
 * wire 1.1 server, its machine-readable `errorClass` — or null if the stream
 * carried none.
 *
 * QUOTE THE ERROR, DO NOT MERELY NAME IT. The caller used to assert "chat smoke
 * returned an error event" and stop there. When that fired on a real deploy the
 * release rolled back correctly and left nobody a way to find out WHY: the SSE
 * body was in this process's memory and nowhere else, the server-side log was
 * on the VM, and the run log said only that an error had occurred. Diagnosing
 * it meant re-deploying with better logging. The sentence it prints instead —
 * naming the provider and the reason — is what told us, on the very next run,
 * that the failure was one dead credential rather than anything in the release.
 *
 * The `message` field of a Juno error frame is already reader-facing copy
 * (providerErrorMessage), so it carries no secret the smoke account could not
 * see on screen; the raw fallback is trimmed so a stack trace or an echoed
 * prompt cannot reach a public build log.
 */
function readErrorFrame(text) {
  const frame = text.match(/\{[^\n]*"type"\s*:\s*"error"[^\n]*\}/i);
  if (!frame) return null;
  try {
    const parsed = JSON.parse(frame[0]);
    if (parsed && typeof parsed.message === "string") {
      return {
        quoted: `${parsed.message}${parsed.finishReason ? ` (finishReason: ${parsed.finishReason})` : ""}`,
        errorClass: typeof parsed.errorClass === "string" ? parsed.errorClass : null,
      };
    }
  } catch {
    // Not a whole frame on one line — the trimmed raw match is still better
    // than the sentence this replaced.
  }
  return { quoted: frame[0].slice(0, 400), errorClass: null };
}

async function main() {
  if (requireAuth && !token && !cookie) {
    throw new Error("authenticated production smoke requires JUNO_SMOKE_TOKEN or JUNO_SMOKE_COOKIE");
  }
  if (requireAuth && process.env.JUNO_SMOKE_RUN_CHAT !== "1") {
    throw new Error("authenticated production smoke requires JUNO_SMOKE_RUN_CHAT=1");
  }

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
  /*
   * ONE MODEL IS A HOSTAGE, A LIST IS A GATE.
   *
   * `JUNO_SMOKE_MODEL` takes an ordered, comma-separated list of candidates and
   * the chat stage below uses the first that actually streams. A single value
   * behaves exactly as it always did.
   *
   * The reason is a real deploy. The gate was pinned to one provider —
   * deliberately, so that a stale VM-only setting could not roll back a good
   * release by calling something unfunded — and then THAT provider's key went
   * dead. The pin written to stop an unfunded provider from rolling back good
   * code became a hardcoded pin TO an unfunded one, and every release after it
   * rolled back on a sentence about somebody's billing:
   *
   *   Alibaba · Qwen cannot be used right now because its API connection is
   *   not configured correctly. Choose another model.
   *
   * The release was fine. The catalog check passed on the same model one line
   * earlier, because a catalog entry is configuration and this is a credential.
   *
   * A smoke's job is to prove THE RELEASE's chat path works end to end, and for
   * that it needs a working model, not one particular one. A dead key is an ops
   * problem: it deserves a warning on every deploy until somebody fixes it, and
   * it must not revert code that has nothing to do with it, and neither must
   * an account that ran out of credit. So a provider-account failure (dead key
   * or exhausted credit) moves to the next candidate and shouts; ANY OTHER
   * error frame fails at once, because that is the release; and all candidates
   * failing on their accounts fails too, because an account that cannot reach
   * a single provider cannot serve anyone.
   */
  const requested = (process.env.JUNO_SMOKE_MODEL || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = requested.length
    ? requested
    : [models.value.models.find((model) => model.modality === "chat" && model.availability === "available")?.id].filter(Boolean);
  assert(candidates.length, "no available chat model was returned for the smoke account");
  console.log(`PASS catalog ${candidates.join(", ")}`);

  assert(process.env.JUNO_SMOKE_RUN_CHAT === "1", "authenticated smoke must run the provider/replay path");

  /**
   * How a candidate's failure is known to be its provider ACCOUNT's (a dead
   * key, or credit run out) rather than the release's. Both are the account's
   * state: the second rolled back a healthy release on 2026-10-26 because
   * Qwen's credit ran out while the next two candidates were fine. Rate
   * limits, capacity and every other error frame still fail at once.
   *
   * Two signals, the first preferred:
   *  - `errorClass` on the error frame (chat wire 1.1, additive — the native
   *    API contract this script pins at 1.3.0 above does not move for it):
   *    `auth` or `billing`, exactly `isAccountFault` in provider-health-policy.
   *  - the sentence `provider-error.ts` emits for those two classes and no
   *    other, for a frame without a class. The sentence no longer names the
   *    platform's funding state ("temporarily unavailable"), and is worded
   *    apart from `capacity`'s on purpose (tests/production-smoke.test.ts
   *    holds the copy to it).
   *
   * It fails SAFE: if the copy is ever reworded and no class is sent, nothing
   * matches, every failure is treated as the release's, and the deploy rolls
   * back. That is the same behaviour this gate had before the list existed.
   */
  const PROVIDER_ACCOUNT_FAILURE = /is temporarily unavailable\. Choose another model, or try again later\./i;
  const ACCOUNT_FAULT_CLASSES = new Set(["auth", "billing"]);

  let selected = null;
  let clientRequestId = null;
  let body = null;
  const accountFailures = [];

  for (const candidate of candidates) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    // A fresh pair per attempt. Reusing one across candidates would make the
    // second submission a replay of the first, and the replay check below would
    // then be verifying the failed attempt's receipt.
    const attemptRequestId = `smoke-request-${suffix}`;
    const attemptBody = JSON.stringify({
      message: process.env.JUNO_SMOKE_PROMPT || "Reply with exactly: Juno smoke pass.",
      model: candidate,
      clientRequestId: attemptRequestId,
      clientMessageId: `smoke-message-${suffix}`,
      client: "web",
    });
    const attemptResponse = await request("/api/chat", {
      method: "POST",
      headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
      body: attemptBody,
    });
    const attempt = await json(attemptResponse);
    assert(attemptResponse.ok, `chat submit failed (${attemptResponse.status}) on ${candidate}: ${attempt.text.slice(0, 500)}`);
    assert(
      /(?:done|finishReason|receiptState)/i.test(attempt.text),
      `chat response never reached a terminal SSE/recovery marker on ${candidate}`,
    );

    const errorFrame = readErrorFrame(attempt.text);
    const quoted = errorFrame?.quoted ?? null;
    const accountFault =
      !!errorFrame &&
      (errorFrame.errorClass !== null
        ? ACCOUNT_FAULT_CLASSES.has(errorFrame.errorClass)
        : PROVIDER_ACCOUNT_FAILURE.test(errorFrame.quoted));
    if (accountFault) {
      // Not this release's fault, and loud about it: a GitHub Actions warning
      // annotation survives in the run summary where a plain line scrolls away.
      // The first candidate is the account default (deploy.yml SMOKE_MODEL), so
      // a skip there means every account that never chose a model is failing;
      // the app's own provider-health alert mails the operator for that lab.
      const isDefault = candidate === candidates[0] && requested.length > 0;
      console.log(
        `::warning::${candidate}${isDefault ? " (the account default)" : ""} is unusable in production (${
          errorFrame.errorClass ?? "account fault"
        }) — ${quoted}`,
      );
      console.log(`SKIP ${candidate} (provider account); trying the next candidate`);
      accountFailures.push(`${candidate}: ${quoted}`);
      continue;
    }
    assert(!quoted, `chat smoke returned an error event on ${candidate}: ${quoted}`);

    selected = candidate;
    clientRequestId = attemptRequestId;
    body = attemptBody;
    break;
  }

  assert(
    selected,
    "every candidate model failed on its provider account (key or credit), so this account cannot reach any provider — " +
      accountFailures.join(" | "),
  );
  console.log(
    `PASS chat submission reached a terminal response on ${selected}` +
      (accountFailures.length ? ` (after ${accountFailures.length} unusable provider(s))` : ""),
  );

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
  assert(receipt.receiptState === "completed", `durable chat receipt ended in ${receipt.receiptState}, not completed`);
  assert(receipt.userMessageId && receipt.conversationId, "terminal receipt omitted canonical ids");
  console.log(`PASS receipt ${receipt.receiptState}`);

  const replayResponse = await request("/api/chat", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body,
  });
  const replay = await json(replayResponse);
  const duplicate = replayResponse.status === 409 && replay.value?.code === "REQUEST_ALREADY_SUBMITTED";
  assert(replayResponse.ok || duplicate, `idempotent replay failed (${replayResponse.status}): ${replay.text.slice(0, 500)}`);
  assert(
    replay.value?.userMessageId === undefined || replay.value.userMessageId === receipt.userMessageId,
    "idempotent replay returned a different user message",
  );
  assert(
    replay.value?.conversationId === undefined || replay.value.conversationId === receipt.conversationId,
    "idempotent replay returned a different conversation",
  );
  console.log("PASS idempotent replay returned the canonical receipt");

  // Token issuance is an account-entitlement check, not the relay's
  // infrastructure health check. deploy.sh separately requires the PM2 relay,
  // /healthz, an enabled provider and an authenticated WebSocket ping/pong. A
  // dedicated chat smoke account may legitimately be on a plan without Voice;
  // that 403 must not roll back an otherwise healthy production release.
  const voiceTokenResponse = await request("/api/voice/relay-token");
  const voiceToken = await json(voiceTokenResponse);
  if (voiceTokenResponse.ok) {
    assert(voiceToken.value?.token && voiceToken.value?.url, "voice relay-token succeeded without token/url");
    assert(/^wss?:\/\//i.test(voiceToken.value.url), `voice relay-token returned a non-WebSocket URL: ${voiceToken.value.url}`);
    console.log(`PASS voice relay-token returned URL: ${voiceToken.value.url}`);
  } else if (!requireVoiceEntitlement && voiceTokenResponse.status === 403 && /paid plan/i.test(voiceToken.text)) {
    console.log("PASS voice entitlement policy (smoke account is not Voice-enabled; relay infrastructure is verified separately)");
  } else {
    throw new Error(`voice relay-token failed (${voiceTokenResponse.status}): ${voiceToken.text.slice(0, 500)}`);
  }
}

main().catch((error) => {
  console.error(`FAIL production smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
