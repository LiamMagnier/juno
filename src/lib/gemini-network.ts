export interface GeminiRequestContext {
  requestId?: string | null;
  generationId?: string | null;
  conversationId?: string | null;
  modelId: string;
  providerModel: string;
  reasoningEffort?: string | null;
  endpoint: string;
}

interface GoogleErrorEnvelope {
  error?: {
    code?: number;
    status?: string;
    message?: string;
  };
}

/** Structured Google failure retained through provider classification/logging. */
export class GeminiProviderError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly error: { code: string; status: string; message: string };
  readonly retryable: boolean;
  readonly context: GeminiRequestContext;

  constructor(input: {
    httpStatus: number;
    googleCode?: number;
    googleStatus?: string;
    message?: string;
    context: GeminiRequestContext;
  }) {
    const safeMessage = (input.message || "Google rejected the generation request").slice(0, 500);
    super(safeMessage);
    this.name = "GeminiProviderError";
    this.status = input.httpStatus;
    this.statusCode = input.httpStatus;
    this.retryable = isRetryableGeminiStatus(input.httpStatus);
    this.context = input.context;
    this.error = {
      code: String(input.googleCode ?? input.httpStatus),
      status: input.googleStatus || "UNKNOWN",
      message: safeMessage,
    };
  }
}

export function isRetryableGeminiStatus(status: number): boolean {
  return status === 500 || status === 502 || status === 503 || status === 504 || status === 529;
}

export function geminiErrorFromResponse(
  httpStatus: number,
  body: string,
  context: GeminiRequestContext,
): GeminiProviderError {
  let parsed: GoogleErrorEnvelope = {};
  try {
    parsed = JSON.parse(body) as GoogleErrorEnvelope;
  } catch {
    // A proxy can return HTML. The user never sees it; logs keep only the safe
    // structured class/status below, not the response body.
  }
  return new GeminiProviderError({
    httpStatus,
    googleCode: parsed.error?.code,
    googleStatus: parsed.error?.status,
    message: parsed.error?.message,
    context,
  });
}

function retryDelayMs(response: Response, attempt: number): number {
  const raw = response.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.min(2_000, Math.max(0, seconds * 1_000));
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(2_000, Math.max(0, date - Date.now()));
  }
  return attempt === 1 ? 250 : 750;
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    }, { once: true });
  });
}

/** Performs bounded retries only before a streaming response has begun. */
export async function requestGeminiStream(
  input: {
    url: string;
    init: RequestInit;
    signal?: AbortSignal;
    context: GeminiRequestContext;
  },
  dependencies: {
    fetchImpl?: typeof fetch;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    maxAttempts?: number;
  } = {},
): Promise<Response> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? abortableDelay;
  const maxAttempts = Math.max(1, Math.min(3, dependencies.maxAttempts ?? 3));
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetchImpl(input.url, { ...input.init, signal: input.signal });
    if (response.ok && response.body) return response;

    const body = await response.text().catch(() => "");
    const error = response.ok
      ? new GeminiProviderError({
          httpStatus: 502,
          googleStatus: "EMPTY_RESPONSE",
          message: "Google returned no streaming response body",
          context: input.context,
        })
      : geminiErrorFromResponse(response.status, body, input.context);

    console.warn(JSON.stringify({
      level: "warn",
      event: "gemini_request_failed",
      requestId: input.context.requestId || undefined,
      generationId: input.context.generationId || undefined,
      conversationId: input.context.conversationId || undefined,
      modelId: input.context.modelId,
      providerModel: input.context.providerModel,
      reasoningEffort: input.context.reasoningEffort || undefined,
      endpoint: input.context.endpoint,
      status: error.status,
      googleStatus: error.error.status,
      attempt,
      durationMs: Date.now() - startedAt,
      retryable: error.retryable,
    }));

    if (!error.retryable || attempt >= maxAttempts) throw error;
    await sleep(retryDelayMs(response, attempt), input.signal);
  }

  throw new Error("Unreachable Gemini retry state");
}
