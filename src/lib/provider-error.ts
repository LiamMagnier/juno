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
   * user's request. These must never be described to a customer in terms they
   * cannot act on — there is no BYOK, so "top up that account" is advice about
   * an account they do not own.
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
    error?: { message?: string; type?: string; code?: string } | string;
  };
  const errObj = typeof e?.error === "object" && e.error !== null ? e.error : undefined;
  const parts = [
    errObj?.message,
    typeof e?.error === "string" ? e.error : "",
    e?.message,
    errObj?.type,
    errObj?.code,
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
//
// The negated forms are spelled out because xAI phrases an unfunded team as
// "The team does not have any credits." — which contains neither "no credits"
// nor "balance", and so used to fall through to the 403 rule below and be
// reported as a dead key.
const BILLING = /balance|insufficient|recharge|billing|out of credit|no credits|(?:not have any|have no|hasn't got any|without any)\s+credits?|credit.{0,20}too low|exceeded your current quota|quota.{0,20}exceed|arrearage|余额|充值/i;
const AUTH = /invalid.*api.?key|invalid x-api-key|authentication|unauthenticated|unauthorized|api key not valid|incorrect api key|expired.*(key|token)/i;
const RATE = /rate.?limit|too many requests|overloaded|concurrent|tpm|rpm/i;
const CONTEXT = /context length|context window|maximum context|too many tokens|prompt is too long|input is too long|reduce the length|string too long|exceeds.{0,20}token/i;
const FILTER = /content.?(filter|policy)|safety|blocked by|prohibited|risk control|data_inspection/i;
const NOT_FOUND = /not found|does not exist|unknown model|no such model|model_not_found|unsupported model/i;
const CAPACITY = /server error|unavailable|bad gateway|gateway timeout|no body|internal error|try again later/i;
const NETWORK = /econnreset|econnrefused|enotfound|etimedout|socket hang up|network|fetch failed|aborted/i;

/**
 * Classify without composing a message. Ordering matters: several providers
 * report an unfunded account as 429, so the billing test must beat the
 * rate-limit test, and Anthropic reports it as a 400 `billing_error`.
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
  // 403 is the provider saying this key may not do this. An unfunded team also
  // answers 403 on xAI, but that body is caught by the billing test above; what
  // reaches here is a genuine permission refusal. Either way it is an account
  // fault: an operator has to touch the provider account before it works again.
  if (status === 403) return { class: "auth", status, raw };
  if (CONTEXT.test(raw)) return { class: "context", status, raw };
  if (FILTER.test(raw)) return { class: "content_filter", status, raw };
  if (status === 429 || RATE.test(raw)) return { class: "rate_limit", status, raw };
  if (status === 404 || NOT_FOUND.test(raw)) return { class: "not_found", status, raw };
  if ((typeof status === "number" && status >= 500) || CAPACITY.test(raw)) {
    return { class: "capacity", status, raw };
  }
  return { class: "unknown", status, raw };
}

const RETRYABLE: Record<ProviderErrorClass, boolean> = {
  auth: false,
  billing: false,
  rate_limit: true,
  context: false,
  content_filter: false,
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
  capacity: false,
  not_found: false,
  network: false,
  unknown: false,
};

/**
 * Turn a provider/SDK error into something safe to show, plus the full detail
 * for logs.
 *
 * The rule that motivates this: a Juno subscriber was being shown "Claude
 * reports no remaining balance or quota. Top up that account, or pick another
 * model." There is no BYOK — "that account" is Juno's, and "top up" is an
 * instruction the customer cannot carry out. Auth and billing therefore
 * collapse to one neutral sentence, while context-length, content-filter and
 * rate-limit stay specific because those *are* actionable.
 */
export function normalizeProviderError(err: unknown, providerLabel?: string): NormalizedProviderError {
  const { class: klass, status, raw } = classifyProviderError(err);
  const who = providerLabel ?? "This model";
  const label = providerLabel ?? "provider";

  let userMessage: string;
  switch (klass) {
    case "auth":
    case "billing":
      // Deliberately says nothing about keys, balances or quotas.
      userMessage = `${who} is temporarily unavailable. Try another model.`;
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
