/**
 * One place that decides what a provider failure *means*.
 *
 * Two callers need the same judgement for different reasons:
 *  - the chat pipeline, which has to say something true to a customer without
 *    leaking how Juno's provider accounts are funded;
 *  - the provider health probe (src/lib/provider-health.ts), which has to tell
 *    "this key is dead" apart from "this provider is busy".
 *
 * Deliberately free of `server-only` and of any SDK import so it stays unit
 * testable — that is why `providerErrorMessage` had no coverage before.
 */

export type ProviderErrorClass =
  /** Key rejected, revoked or malformed. */
  | "auth"
  /** Account out of credit/quota. Juno's account, not the user's. */
  | "billing"
  /** Transient throttling. Retry works. */
  | "rate_limit"
  /** The request was too big for the model's context window. */
  | "context"
  /** The provider's safety system refused. */
  | "content_filter"
  /** Provider rejected a syntactically/semantically invalid request (4xx). */
  | "invalid_request"
  /** Provider-side fault: 5xx, overloaded, gateway errors. */
  | "capacity"
  /** No such model at this provider. */
  | "not_found"
  /** Never reached the provider: DNS, socket, timeout, abort. */
  | "network"
  | "unknown";

export interface NormalizedProviderError {
  class: ProviderErrorClass;
  /** Worth trying the same request again shortly. */
  retryable: boolean;
  /**
   * True when the fault is with *Juno's* provider account rather than with the
   * user's request. They are still shown honestly to the customer, but without
   * leaking credentials, account identifiers, or a raw provider response.
   */
  accountFault: boolean;
  /** Safe to render to a customer. */
  userMessage: string;
  /** Full detail, for logs and operator alerts. Never rendered to a user. */
  operatorMessage: string;
  status: number | null;
}

interface ExtractedError {
  status: number | null;
  raw: string;
  name: string | null;
}

/** Pull a status and a message out of the many error shapes the SDKs throw. */
function extract(err: unknown): ExtractedError {
  const e = err as {
    status?: number;
    statusCode?: number;
    name?: string;
    message?: string;
    code?: string;
    error?: { message?: string; type?: string; code?: string; status?: string | number } | string;
  };
  const errObj = typeof e?.error === "object" && e.error !== null ? e.error : undefined;
  const parts = [
    errObj?.message,
    typeof e?.error === "string" ? e.error : "",
    e?.message,
    errObj?.type,
    errObj?.code,
    // Google puts its machine-readable class here rather than in `type` or
    // `code` — RESOURCE_EXHAUSTED is the one signal that separates its throttle
    // from an out-of-credit account, whose prose is word-for-word identical.
    typeof errObj?.status === "string" ? errObj.status : "",
    e?.code,
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  return {
    status: typeof e?.status === "number" ? e.status : typeof e?.statusCode === "number" ? e.statusCode : null,
    raw: parts.join(" | "),
    name: typeof e?.name === "string" ? e.name : null,
  };
}

// "You exceeded your current quota", "credit balance is too low",
// "Insufficient Balance", "no credits remaining", 余额不足 / 请充值.
// Covers, verbatim: "Your credit balance is too low" (Anthropic), "You have no
// credits remaining" (OpenAI), "Insufficient Balance" (DeepSeek), "The team
// does not have any credits" (xAI), plus the Chinese-provider phrasings.
const BILLING = /balance|insufficient|recharge|billing.?error|arrearage|(?:out of|no|any|zero|without)\s+(?:remaining\s+)?credits?|credit.{0,20}too low|余额|充值/i;
// "You exceeded your current quota, please check your plan and billing details"
// is sent BOTH by OpenAI for a genuinely unfunded account and by Google for an
// ordinary free-tier or per-minute rate limit. The sentence cannot separate
// them; only OpenAI tags it `insufficient_quota`, which BILLING catches above on
// `insufficient`. So the bare wording is deliberately NOT in BILLING — matching
// it there made one throttled Gemini probe mark the whole provider account
// faulted for the 30-minute unhealthy TTL, reroute live chats off it, and page
// the operator about a provider that was fine.
const QUOTA = /exceeded your current quota|quota.{0,20}exceed|billing/i;
const AUTH = /invalid.*api.?key|invalid x-api-key|authentication|unauthenticated|unauthorized|api key not valid|incorrect api key|expired.*(key|token)/i;
const RATE = /rate.?limit|too many requests|overloaded|concurrent|tpm|rpm|resource_exhausted/i;
const CONTEXT = /context length|context window|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|string too long|exceeds.{0,20}token/i;
const FILTER = /content.?(filter|policy)|safety|blocked by|prohibited|risk control|data_inspection/i;
const NOT_FOUND = /not found|does not exist|unknown model|no such model|model_not_found|unsupported model/i;
const NETWORK = /econnreset|econnrefused|enotfound|etimedout|socket hang up|network|fetch failed|aborted/i;

/**
 * Classify without composing a message. Ordering matters: several providers
 * report an unfunded account as 429, so the billing test must beat the
 * rate-limit test, and Anthropic reports it as a 400 `billing_error`.
 *
 * The exception is bare quota wording, which is checked AFTER the rate-limit
 * test — see QUOTA. Misreading a throttle as a billing fault is expensive here:
 * `isAccountFault` turns it into a 30-minute unhealthy verdict for the whole
 * provider, plus a reroute and an operator page.
 */
export function classifyProviderError(err: unknown): {
  class: ProviderErrorClass;
  status: number | null;
  raw: string;
} {
  const { status, raw, name } = extract(err);

  if (name === "AbortError" || NETWORK.test(raw)) return { class: "network", status, raw };
  if (BILLING.test(raw) || status === 402) return { class: "billing", status, raw };
  if (status === 401 || AUTH.test(raw)) return { class: "auth", status, raw };
  // 403 is the provider saying this key may not do this. xAI answers 403 on an
  // unfunded team. Treat it as an account fault either way: both mean an
  // operator has to touch the provider account before it works again.
  if (status === 403) return { class: "auth", status, raw };
  if (CONTEXT.test(raw)) return { class: "context", status, raw };
  if (FILTER.test(raw)) return { class: "content_filter", status, raw };
  if (status === 429 || RATE.test(raw)) return { class: "rate_limit", status, raw };
  // Quota wording that survived the 429 test above. Nothing throttles with a
  // non-429, so at this point "quota"/"billing" is the account fault it sounds
  // like rather than Google's throttle phrasing.
  if (QUOTA.test(raw)) return { class: "billing", status, raw };
  if (status === 404 || NOT_FOUND.test(raw)) return { class: "not_found", status, raw };
  if (typeof status === "number" && status >= 500) {
    return { class: "capacity", status, raw };
  }
  if (status === 400 || status === 422) return { class: "invalid_request", status, raw };
  return { class: "unknown", status, raw };
}

const RETRYABLE: Record<ProviderErrorClass, boolean> = {
  auth: false,
  billing: false,
  rate_limit: true,
  context: false,
  content_filter: false,
  invalid_request: false,
  capacity: true,
  not_found: false,
  network: true,
  unknown: false,
};

/** Classes where the deployment's own provider account is what is broken. */
const ACCOUNT_FAULT: Record<ProviderErrorClass, boolean> = {
  auth: true,
  billing: true,
  rate_limit: false,
  context: false,
  content_filter: false,
  invalid_request: false,
  capacity: false,
  not_found: false,
  network: false,
  unknown: false,
};

/**
 * Turn a provider/SDK error into something safe to show, plus the full detail
 * for logs.
 *
 * Keep errors concrete enough for someone to understand why retrying will not
 * help. We identify the class (credits, key configuration, rate limit, context
 * length, etc.), but never pass through the raw provider body because it can
 * contain credentials, account identifiers, or opaque SDK envelopes.
 */
export function normalizeProviderError(err: unknown, providerLabel?: string): NormalizedProviderError {
  const { class: klass, status, raw } = classifyProviderError(err);
  const who = providerLabel ?? "This model";
  const label = providerLabel ?? "provider";

  let userMessage: string;
  switch (klass) {
    case "auth":
      userMessage = `${who} cannot be used right now because its API connection is not configured correctly. Choose another model.`;
      break;
    case "billing":
      userMessage = `${who} cannot respond because its API credits or provider quota are exhausted. Choose another model while service is restored.`;
      break;
    case "rate_limit":
      userMessage = `${who} is busy or rate-limiting right now. Try again in a moment.`;
      break;
    case "context":
      userMessage =
        "This conversation is too long for the model's context window. Start a new chat, or pick a model with a larger context.";
      break;
    case "content_filter":
      userMessage = `${who} declined to answer this request under its content policy.`;
      break;
    case "invalid_request":
      userMessage = `${who} couldn't accept this request. Try again, or choose another model.`;
      break;
    case "capacity":
      userMessage = `${who} is temporarily unavailable (a server error on their end). Please try again in a moment.`;
      break;
    case "not_found":
      userMessage = `That model isn't available from ${label} right now. Pick another model.`;
      break;
    case "network":
      userMessage = "The connection to the model was interrupted. Please try again.";
      break;
    default:
      // Never echo a raw provider body: on Anthropic the SDK message is the
      // whole JSON error envelope, which then rendered into the transcript.
      userMessage = "Juno ran into a problem generating a response. Please try again.";
  }

  const operatorMessage = [
    providerLabel ? `[${providerLabel}]` : null,
    klass,
    status !== null ? `status=${status}` : null,
    raw ? raw.slice(0, 500) : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    class: klass,
    retryable: RETRYABLE[klass],
    accountFault: ACCOUNT_FAULT[klass],
    userMessage,
    operatorMessage,
    status,
  };
}
