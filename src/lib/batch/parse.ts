/**
 * Request bodies and result parsing for the two Batch APIs. Pure, so the wire
 * shapes are pinned by tests without a network or a key.
 *
 *   Anthropic: POST /v1/messages/batches  { requests: [{ custom_id, params }] }
 *              results: one object per request, { custom_id, result: { type:
 *              "succeeded" | "errored" | "canceled" | "expired", message? } }
 *   OpenAI:    a JSONL file of { custom_id, method: "POST", url, body },
 *              uploaded with purpose "batch"; POST /v1/batches; the output
 *              file is JSONL of { custom_id, response: { status_code, body },
 *              error }. Results arrive in any order on both: keyed by id.
 */

export interface BatchItem {
  customId: string;
  system: string;
  userMsg: string;
  maxTokens: number;
}

export interface BatchItemUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface BatchItemResult {
  customId: string;
  ok: boolean;
  text: string | null;
  error: string | null;
  usage: BatchItemUsage | null;
}

export type BatchStatus = "in_progress" | "ended" | "failed";

const n = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

// ── Anthropic ────────────────────────────────────────────────────────────────

/** One Message Batches request, with the thinking settings the sync path would send. */
export function anthropicBatchRequest(
  item: BatchItem,
  input: { model: string; maxTokens: number; thinking?: unknown; outputConfig?: unknown }
): { custom_id: string; params: Record<string, unknown> } {
  return {
    custom_id: item.customId,
    params: {
      model: input.model,
      max_tokens: input.maxTokens,
      system: item.system,
      messages: [{ role: "user", content: item.userMsg }],
      ...(input.thinking ? { thinking: input.thinking } : {}),
      ...(input.outputConfig ? { output_config: input.outputConfig } : {}),
    },
  };
}

export function anthropicBatchStatus(processingStatus: string | null | undefined): BatchStatus {
  return processingStatus === "ended" ? "ended" : "in_progress";
}

/** One line of `messages.batches.results(id)`. */
export function parseAnthropicBatchResult(row: unknown): BatchItemResult | null {
  const r = row as {
    custom_id?: string;
    result?: {
      type?: string;
      message?: {
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string | null;
        usage?: Record<string, unknown>;
      };
      error?: { error?: { message?: string; type?: string }; type?: string };
    };
  };
  if (!r?.custom_id) return null;
  const type = r.result?.type;
  if (type !== "succeeded") {
    const message = r.result?.error?.error?.message ?? r.result?.error?.type ?? type ?? "unknown";
    return { customId: r.custom_id, ok: false, text: null, error: String(message), usage: null };
  }
  const message = r.result?.message;
  const text = (message?.content ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const u = message?.usage ?? {};
  // The request DID run and bill even when it was refused or cut off.
  const usage: BatchItemUsage = {
    input: n(u.input_tokens),
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens),
    cacheWrite: n(u.cache_creation_input_tokens),
  };
  const refused = message?.stop_reason === "refusal";
  return {
    customId: r.custom_id,
    ok: !refused && text.trim().length > 0,
    text: refused ? null : text,
    error: refused ? "refusal" : text.trim() ? null : "empty",
    usage,
  };
}

// ── OpenAI ───────────────────────────────────────────────────────────────────

/** One JSONL line of an OpenAI batch input file (Chat Completions). */
export function openAIBatchLine(
  item: BatchItem,
  input: { model: string; maxCompletionTokens: number; reasoningEffort?: string | null }
): string {
  return JSON.stringify({
    custom_id: item.customId,
    method: "POST",
    url: "/v1/chat/completions",
    body: {
      model: input.model,
      messages: [
        { role: "system", content: item.system },
        { role: "user", content: item.userMsg },
      ],
      max_completion_tokens: input.maxCompletionTokens,
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
    },
  });
}

export function openAIBatchStatus(status: string | null | undefined, hasOutput: boolean): BatchStatus {
  switch (status) {
    case "completed":
      return "ended";
    // An expired or cancelled batch keeps whatever finished: read it if there is any.
    case "expired":
    case "cancelled":
      return hasOutput ? "ended" : "failed";
    case "failed":
      return "failed";
    default:
      return "in_progress";
  }
}

/** Every line of an output (or error) file. */
export function parseOpenAIBatchOutput(jsonl: string): BatchItemResult[] {
  const out: BatchItemResult[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: {
      custom_id?: string;
      response?: { status_code?: number; body?: Record<string, unknown> } | null;
      error?: { message?: string; code?: string } | null;
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!row.custom_id) continue;
    const status = row.response?.status_code ?? 0;
    const body = (row.response?.body ?? {}) as {
      choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      error?: { message?: string };
    };
    if (row.error || status < 200 || status >= 300) {
      out.push({
        customId: row.custom_id,
        ok: false,
        text: null,
        error: row.error?.message ?? body.error?.message ?? `status ${status}`,
        usage: null,
      });
      continue;
    }
    const text = body.choices?.[0]?.message?.content ?? "";
    // OpenAI's prompt_tokens include the cached portion, as on the live API.
    const usage: BatchItemUsage = {
      input: n(body.usage?.prompt_tokens),
      output: n(body.usage?.completion_tokens),
      cacheRead: n(body.usage?.prompt_tokens_details?.cached_tokens),
      cacheWrite: 0,
    };
    out.push({ customId: row.custom_id, ok: text.trim().length > 0, text, error: text.trim() ? null : "empty", usage });
  }
  return out;
}
