import test from "node:test";
import assert from "node:assert/strict";
import { classifyProviderError, normalizeProviderError } from "@/lib/provider-error";

/*
 * Fixtures shaped like what each SDK actually throws. The four billing cases
 * are the ones observed live on 2026-07-31: Anthropic "credit balance is too
 * low" (400), OpenAI "no credits remaining" (429 — note NOT 402), DeepSeek
 * "Insufficient Balance" (402), xAI (403).
 */

const anthropicBilling = {
  status: 400,
  error: { type: "billing_error", message: "Your credit balance is too low to access the Anthropic API." },
  message: "400 {\"type\":\"error\",\"error\":{\"type\":\"billing_error\"}}",
};
const openaiNoCredits = {
  status: 429,
  error: { type: "insufficient_quota", message: "You have no credits remaining." },
};
const deepseekBalance = { status: 402, error: { message: "Insufficient Balance" } };
const xaiForbidden = { status: 403, error: { message: "The team does not have any credits." } };
const badKey = { status: 401, error: { message: "invalid x-api-key" } };
const realRateLimit = { status: 429, error: { message: "Rate limit reached for requests" } };
const overloaded = { status: 529, error: { message: "Overloaded" } };
const contextTooLong = {
  status: 400,
  error: { message: "prompt is too long: 250000 tokens > 200000 maximum context length" },
};
const contentFiltered = { status: 400, error: { message: "Blocked by content filter" } };
const modelGone = { status: 404, error: { message: "The model `gemini-2.5-flash` does not exist" } };
const socketDied = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
const aborted = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
const prismaError = Object.assign(new Error("Invalid `prisma.message.create()` invocation"), {
  code: "P2002",
});

test("an unfunded account is billing, whatever status the provider chose", () => {
  for (const [name, err] of Object.entries({
    anthropicBilling,
    openaiNoCredits,
    deepseekBalance,
  })) {
    assert.equal(classifyProviderError(err).class, "billing", `${name} should classify as billing`);
  }
});

test("OpenAI's out-of-credit 429 is not mistaken for throttling", () => {
  // The ordering trap: both are 429. Only the body distinguishes them.
  assert.equal(classifyProviderError(openaiNoCredits).class, "billing");
  assert.equal(classifyProviderError(realRateLimit).class, "rate_limit");
});

test("Google's throttle is not mistaken for an unfunded account", () => {
  /*
   * The mirror image of the test above, and the harder direction. OpenAI sends
   * this sentence when the account really is out of money; Google sends the
   * SAME sentence, verbatim, for an ordinary free-tier or per-minute limit.
   * What separates them is the machine-readable tag: `insufficient_quota` vs
   * `RESOURCE_EXHAUSTED`. Prose alone cannot, so the prose must not decide.
   *
   * Getting this wrong is not a cosmetic mislabel: billing is an account fault,
   * so one throttled probe marks the provider unhealthy for 30 minutes, reroutes
   * live conversations onto another lab, and pages the operator about an outage
   * that is not happening.
   */
  const googleThrottle = {
    status: 429,
    error: {
      message: "You exceeded your current quota, please check your plan and billing details.",
      status: "RESOURCE_EXHAUSTED",
    },
  };
  assert.equal(classifyProviderError(googleThrottle).class, "rate_limit");

  // Same wording, no tag at all: still a 429, so still throttling.
  const untagged = {
    status: 429,
    error: { message: "You exceeded your current quota, please check your plan and billing details." },
  };
  assert.equal(classifyProviderError(untagged).class, "rate_limit");

  // But quota wording OUTSIDE a 429 is not throttling — nothing throttles with
  // a 400 — so it stays a billing fault.
  const quotaOn400 = { status: 400, error: { message: "Project quota exceeded." } };
  assert.equal(classifyProviderError(quotaOn400).class, "billing");
});

test("a rejected or forbidden key is an auth fault", () => {
  assert.equal(classifyProviderError(badKey).class, "auth");
  assert.equal(classifyProviderError(xaiForbidden).class, "billing"); // body says credits
  assert.equal(classifyProviderError({ status: 403, error: { message: "Forbidden" } }).class, "auth");
});

test("the classes that are the deployment's fault are marked as such", () => {
  assert.equal(normalizeProviderError(badKey).accountFault, true);
  assert.equal(normalizeProviderError(deepseekBalance).accountFault, true);
  assert.equal(normalizeProviderError(realRateLimit).accountFault, false);
  assert.equal(normalizeProviderError(overloaded).accountFault, false);
  assert.equal(normalizeProviderError(contextTooLong).accountFault, false);
});

test("retryability matches the class", () => {
  assert.equal(normalizeProviderError(realRateLimit).retryable, true);
  assert.equal(normalizeProviderError(overloaded).retryable, true);
  assert.equal(normalizeProviderError(socketDied).retryable, true);
  assert.equal(normalizeProviderError(deepseekBalance).retryable, false);
  assert.equal(normalizeProviderError(badKey).retryable, false);
  assert.equal(normalizeProviderError(contextTooLong).retryable, false);
});

test("no user-facing message ever exposes how Juno's provider accounts are funded", () => {
  const forbidden = /top up|balance|quota|credit|api.?key|billing/i;
  const errors = [
    anthropicBilling,
    openaiNoCredits,
    deepseekBalance,
    xaiForbidden,
    badKey,
    realRateLimit,
    overloaded,
    contextTooLong,
    contentFiltered,
    modelGone,
    socketDied,
    aborted,
    prismaError,
    new Error("something odd"),
    {},
    null,
    undefined,
  ];
  for (const err of errors) {
    const { userMessage } = normalizeProviderError(err, "Anthropic · Claude");
    assert.doesNotMatch(
      userMessage,
      forbidden,
      `leaked account state for ${JSON.stringify(err)?.slice(0, 60)}: ${userMessage}`
    );
    // A raw provider body used to be echoed on the fallthrough; on Anthropic
    // that meant printing the JSON error envelope into the transcript.
    assert.ok(!userMessage.includes("{"), `leaked a raw body: ${userMessage}`);
    assert.ok(userMessage.length > 0);
  }
});

test("the actionable classes stay specific", () => {
  assert.match(normalizeProviderError(contextTooLong).userMessage, /context/i);
  assert.match(normalizeProviderError(contentFiltered).userMessage, /content policy/i);
  assert.match(normalizeProviderError(realRateLimit).userMessage, /busy|rate/i);
  assert.match(normalizeProviderError(modelGone, "Google").userMessage, /isn't available/i);
});

test("auth and billing collapse to the same neutral sentence", () => {
  const a = normalizeProviderError(badKey, "Anthropic · Claude").userMessage;
  const b = normalizeProviderError(anthropicBilling, "Anthropic · Claude").userMessage;
  assert.equal(a, b);
  assert.match(a, /temporarily unavailable/i);
});

test("network faults are recognised, including a client abort", () => {
  assert.equal(classifyProviderError(socketDied).class, "network");
  assert.equal(classifyProviderError(aborted).class, "network");
});

test("a non-provider error does not masquerade as a provider failure", () => {
  // route.ts feeds Prisma and internal errors through this same path.
  const normalized = normalizeProviderError(prismaError, "Anthropic · Claude");
  assert.equal(normalized.class, "unknown");
  assert.equal(normalized.accountFault, false);
  assert.doesNotMatch(normalized.userMessage, /prisma/i);
});

test("a real provider 400 is an invalid request and never described as a server error", () => {
  const invalid = {
    status: 400,
    error: { status: "INVALID_ARGUMENT", message: "Invalid thinking level" },
  };
  const normalized = normalizeProviderError(invalid, "Google · Gemini 3.7 Flash");
  assert.equal(normalized.class, "invalid_request");
  assert.equal(normalized.retryable, false);
  assert.doesNotMatch(normalized.userMessage, /server error|their end/i);
});

test("the operator message keeps the detail the user message drops", () => {
  const normalized = normalizeProviderError(deepseekBalance, "DeepSeek");
  assert.match(normalized.operatorMessage, /DeepSeek/);
  assert.match(normalized.operatorMessage, /billing/);
  assert.match(normalized.operatorMessage, /Insufficient Balance/);
  assert.equal(normalized.status, 402);
});

test("malformed input never throws", () => {
  for (const err of [null, undefined, 0, "", [], {}, new Error()]) {
    assert.doesNotThrow(() => normalizeProviderError(err));
  }
});
