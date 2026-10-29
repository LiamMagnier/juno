/**
 * One record per provider request: what it cost and why, in a form an
 * operator can aggregate.
 *
 * A turn is several requests (tool rounds, a `pause_turn` continuation, a
 * fast-mode fallback), and the per-turn trace (chat/turn/trace.ts) and the
 * spend ledger both see only the turn's total. What makes caching measurable
 * is the request: whether ITS prefix was read, how much it wrote, what it
 * paid. Each adapter calls `begin` before it sends a request and `end` with
 * that request's own usage when the response is read; the record carries:
 *
 *  - provider, model, role (chat / utility / research…), context tier
 *    (standard, or the lab's long-context surcharge tier);
 *  - fresh input, cache-read, cache-write (5m / 1h where the lab splits it),
 *    output and reasoning tokens, in one additive convention
 *    (`normalizeUsage`), plus tool fees and the request's cost at list price;
 *  - round, attempt, and the retry / fallback flags;
 *  - latency and first-token latency;
 *  - the prefix diagnostic (prefix-diagnostic.ts): segment hashes and the
 *    reason the prefix changed since the conversation's previous request.
 *
 * No prompt or response content, ever: hashes, counts and identifiers.
 *
 * Pure apart from the injected sink and clock; streamChat (src/lib/llm.ts)
 * wires the structured logger in.
 */
import type { ModelInfo } from "@/lib/models";
import { estimateGenerationCostUsd, longContextPricing, normalizeUsage, type FastMode, type GenerationCostOpts } from "@/lib/pricing";
import {
  createPrefixTracker,
  hashCacheKey,
  snapshotPrefix,
  verdictLabel,
  type PrefixTracker,
  type PrefixWire,
} from "@/lib/llm/prefix-diagnostic";

/** A request's usage in the PROVIDER's convention, as its adapter reads it. */
export interface RequestUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite5m?: number;
  cacheWrite1h?: number;
  webSearchRequests?: number;
  xSearchRequests?: number;
}

/** What a request is for. Free text so a new caller needs no edit here. */
export type RequestRole = "chat" | "utility" | "research" | "design" | "probe" | (string & {});

export interface ProviderRequestRecord {
  provider: string;
  model: string;
  role: RequestRole;
  /** "long" when the prompt crossed the lab's long-context price tier. */
  contextTier: "standard" | "long";
  round: number;
  /** The caller's attempt number for this generation (1 = first). */
  attempt: number;
  /** A later attempt of the same generation (attempt > 1). */
  retry: boolean;
  /** Served on a fallback inside the adapter (e.g. fast mode unavailable → standard). */
  fallback: boolean;
  ok: boolean;
  /** False when the provider reported no usage: the token counts are then zero, not estimates. */
  usageReported: boolean;
  tokens: {
    totalInput: number;
    fresh: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    reasoning: number;
  };
  /** cacheRead / totalInput, or null with no input. */
  cacheReadShare: number | null;
  toolFeesUsd: number;
  /** List-price cost of this request alone (tokens + tool fees). */
  costUsd: number;
  latencyMs: number;
  firstTokenMs: number | null;
  prefix: {
    /** "first" | "stable" | "<reason>[@index]" (prefix-diagnostic.ts). */
    verdict: string;
    settings: string;
    tools: string;
    system: string[];
    messages: number;
    messagesHead: string | null;
  };
  /** Hashed; never the conversation id itself. */
  cacheKey: string | null;
  requestId: string | null;
  generationId: string | null;
}

export interface BeginRequest {
  wire: PrefixWire;
  round: number;
  /** The body exactly as it is about to be sent. Read for hashes only. */
  body: unknown;
  /** Items the adapter appended for this request only (date, volatile tail). */
  volatile?: ReadonlySet<unknown>;
  fallback?: boolean;
}

export interface MeteredRequest {
  /** The first streamed token (text, reasoning or a tool call) arrived. Idempotent. */
  firstToken(): void;
  /** The response was read. Idempotent: only the first call records. */
  end(usage: RequestUsage | null, outcome?: { ok?: boolean; fallback?: boolean; fastMode?: FastMode }): ProviderRequestRecord | null;
}

export interface RequestMeter {
  begin(input: BeginRequest): MeteredRequest;
}

export interface RequestMeterContext {
  model: ModelInfo;
  role: RequestRole;
  cacheKey?: string;
  attempt?: number;
  fastMode?: FastMode;
  requestId?: string | null;
  generationId?: string | null;
}

/** The process-wide tracker production shares across generations. */
const PROCESS_TRACKER = createPrefixTracker();

export function createRequestMeter(
  context: RequestMeterContext,
  deps: {
    sink: (record: ProviderRequestRecord) => void;
    /** Server-side billing receives the same request boundaries as telemetry. */
    onUsage?: (usage: GenerationCostOpts) => void;
    tracker?: PrefixTracker;
    now?: () => number;
  }
): RequestMeter {
  const tracker = deps.tracker ?? PROCESS_TRACKER;
  const now = deps.now ?? Date.now;
  const attempt = Math.max(1, context.attempt ?? 1);
  return {
    begin(input) {
      const startedAt = now();
      const snapshot = snapshotPrefix(input.wire, input.body, input.volatile);
      const verdict = tracker.observe(context.cacheKey, snapshot);
      let firstTokenAt: number | null = null;
      let done = false;
      return {
        firstToken() {
          if (firstTokenAt === null) firstTokenAt = now();
        },
        end(usage, outcome = {}) {
          if (done) return null;
          done = true;
          const model = context.model;
          const reported = !!usage && Object.values(usage).some((v) => typeof v === "number" && v > 0);
          const u = usage ?? {};
          const n = normalizeUsage(model.provider, u);
          const fastMode = outcome.fastMode ?? context.fastMode ?? false;
          const billableUsage: GenerationCostOpts = {
            promptTokens: u.input ?? 0,
            completionTokens: u.output ?? 0,
            reasoningTokens: u.reasoning ?? null,
            totalTokens: u.total ?? null,
            cacheRead: u.cacheRead ?? null,
            cacheWrite: u.cacheWrite ?? null,
            cacheWrite5m: u.cacheWrite5m ?? null,
            cacheWrite1h: u.cacheWrite1h ?? null,
            webSearchRequests: u.webSearchRequests ?? null,
            xSearchRequests: u.xSearchRequests ?? null,
            fastMode,
          };
          const cost = reported
            ? estimateGenerationCostUsd(model, billableUsage)
            : { costUsd: 0, toolFeesUsd: 0 };
          if (reported) {
            try {
              deps.onUsage?.(billableUsage);
            } catch {
              // Incomplete receipts fall back to cumulative usage at settlement.
            }
          }
          const lc = longContextPricing(model);
          const long = !!lc && (lc.inclusive ? n.totalInput >= lc.threshold : n.totalInput > lc.threshold);
          const end = now();
          const record: ProviderRequestRecord = {
            provider: model.provider,
            model: model.providerModel,
            role: context.role,
            contextTier: long ? "long" : "standard",
            round: input.round,
            attempt,
            retry: attempt > 1,
            fallback: !!(input.fallback || outcome.fallback),
            ok: outcome.ok ?? true,
            usageReported: reported,
            tokens: {
              totalInput: n.totalInput,
              fresh: n.freshInput,
              cacheRead: n.cacheRead,
              cacheWrite: n.cacheWrite,
              cacheWrite5m: n.cacheWrite5m,
              cacheWrite1h: n.cacheWrite1h,
              output: n.output,
              reasoning: Math.max(0, u.reasoning ?? 0),
            },
            cacheReadShare: n.totalInput > 0 ? Math.round((n.cacheRead / n.totalInput) * 1000) / 1000 : null,
            toolFeesUsd: cost.toolFeesUsd,
            costUsd: cost.costUsd,
            latencyMs: Math.max(0, end - startedAt),
            firstTokenMs: firstTokenAt === null ? null : Math.max(0, firstTokenAt - startedAt),
            prefix: {
              verdict: verdictLabel(verdict),
              settings: snapshot.settings,
              tools: snapshot.tools,
              system: snapshot.system,
              messages: snapshot.messages.length,
              messagesHead: snapshot.messages.length ? snapshot.messages[snapshot.messages.length - 1] : null,
            },
            cacheKey: context.cacheKey ? hashCacheKey(context.cacheKey) : null,
            requestId: context.requestId ?? null,
            generationId: context.generationId ?? null,
          };
          try {
            deps.sink(record);
          } catch {
            // Telemetry never fails a request.
          }
          return record;
        },
      };
    },
  };
}

/**
 * Forward a round's events, telling `request` when the first token arrives,
 * and hand back the round's own return value. A consumer that stops early
 * still closes the inner generator (and with it the provider stream).
 */
export async function* withFirstToken<T extends { type: string }, R>(
  inner: AsyncGenerator<T, R>,
  request: MeteredRequest | undefined
): AsyncGenerator<T, R> {
  if (!request) return yield* inner;
  let finished = false;
  try {
    while (true) {
      const step = await inner.next();
      if (step.done) {
        finished = true;
        return step.value;
      }
      const type = step.value.type;
      if (type === "text" || type === "reasoning" || type === "tool" || type === "server_tool") request.firstToken();
      yield step.value;
    }
  } finally {
    if (!finished) await inner.return?.(undefined as R);
  }
}

/** Per-request usage from two snapshots of an adapter's cumulative counters. */
export function usageDelta(before: RequestUsage, after: RequestUsage): RequestUsage {
  const out: RequestUsage = {};
  for (const key of Object.keys(after) as Array<keyof RequestUsage>) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (delta > 0) out[key] = delta;
  }
  return out;
}
