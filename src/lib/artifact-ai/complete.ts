import type { Plan } from "@prisma/client";
import type { ModelInfo } from "@/lib/models";
import type { RecordSpendInput } from "@/lib/spend";
import type { LlmEvent } from "@/types/llm";
import { createStreamBudgetGuard, type StreamBudgetRates } from "@/lib/chat-budget-guard";
import { cacheUsageFrom, estimateGenerationCostUsd, type CacheUsage } from "@/lib/pricing";
import { isUnconsumedProviderRejection } from "@/lib/utility-attempt";
import type { CompletionStreamEvent } from "@/lib/artifact-ai/protocol";

/**
 * `window.alevr.complete`: a model call an artifact makes, billed to the
 * person looking at it.
 *
 * WHOSE MONEY. The viewer's, always — on their own canvas that is the owner,
 * on a shared or published page it is the signed-in visitor, and never the
 * artifact's author (src/lib/artifact-ai/access.ts hands this module only the
 * viewer's id). A stranger's page can therefore spend nothing of the person
 * who shared it, and only what a visitor agreed to of the visitor's.
 *
 * WHICH MODEL. The viewer's default background model: the same candidates and
 * the same provider policy as titles and memory (`utilityModelCandidates`,
 * `resolveBackgroundCandidates` with the account's mode and the provider of
 * its chat model), so an app's prompt goes where the person's own background
 * work is already allowed to go, and nowhere else. No tools, no connectors, no
 * web search: text in, text out.
 *
 * WHAT IT COSTS, in the order a chat turn asks:
 *
 *   1. admission (`admitMeteredCall`): the month, the 5-hour and weekly
 *      windows, and this call's own estimate against what is left. The
 *      estimate is an upper bound — the prompt at ~4 characters a token plus
 *      the whole `maxTokens` reply — so a spent account is refused before any
 *      provider is reached;
 *   2. a hold (`reserveSpend`) for that estimate, so a page firing calls in
 *      parallel cannot have each one admitted against the same balance;
 *   3. the mid-stream guard (`createStreamBudgetGuard`), which stops the reply
 *      when the running cost reaches what the account has left;
 *   4. one ledger row per provider attempt, written in `finally` so a timeout,
 *      an abort or a reply the app never read is still billed (rejections the
 *      provider never consumed are not: `isUnconsumedProviderRejection`), and
 *      the hold settled to the real total.
 *
 * Every request is metered by the adapter itself (src/lib/llm/request-meter.ts)
 * with the role `artifact`, which is what the production `stream` passes.
 *
 * Free of I/O: the route supplies the dependencies (src/lib/artifact-ai/server.ts)
 * and the tests supply fakes.
 */

/** Models tried, at most: the first, and one fallback when the first fails before writing anything. */
export const MAX_COMPLETION_ATTEMPTS = 2;

/** The floor on the hold, so a one-word prompt still reserves something real. */
const MIN_ESTIMATE_MICRO_USD = 500;

const CHARS_PER_TOKEN = 4;

/** Said to the model when the app gives no system prompt of its own. */
export const DEFAULT_ARTIFACT_SYSTEM =
  "You are answering a request from an interactive app the user is running. Reply with exactly what the request asks for, in the format it asks for, with no preamble.";

export interface ArtifactCompletionInput {
  viewerId: string;
  plan: Plan;
  prompt: string;
  system?: string;
  maxTokens: number;
}

export interface ArtifactCompletionDeps {
  /** The viewer's eligible background models, in preference order. Empty: the policy allows none. */
  resolveModels(viewerId: string): Promise<ModelInfo[]>;
  admit(input: { userId: string; plan: Plan; estimateMicroUsd: number }): Promise<
    | { allowed: true; remainingMicroUsd: number | null }
    | { allowed: false; body: Record<string, unknown> }
  >;
  reserve(input: { userId: string; plan: Plan; ref: string; estimateMicroUsd: number }): Promise<{ allowed: boolean }>;
  settle(userId: string, ref: string, actualMicroUsd: number): Promise<unknown>;
  /** Stream one model's reply. Production: `streamChat` with role "artifact" and no tools. */
  stream(input: { model: ModelInfo; system: string; prompt: string; maxTokens: number; signal: AbortSignal }): AsyncIterable<LlmEvent>;
  record(input: RecordSpendInput): Promise<unknown>;
  rates(model: ModelInfo): StreamBudgetRates;
  newRef(): string;
  /** A provider failed: feeds provider health like any other background call. */
  onProviderFault?(model: ModelInfo, error: unknown): void;
}

export interface CompletionAdmission {
  viewerId: string;
  ref: string;
  models: ModelInfo[];
  system: string;
  prompt: string;
  maxTokens: number;
  /** Room left for this call, micro-USD; null when the account's cap is switched off. */
  ceilingMicroUsd: number | null;
}

export type CompletionRefusal = {
  ok: false;
  status: 402 | 409;
  body: Record<string, unknown> & { error: string; code: "budget_exceeded" | "model_unavailable" };
};

/** An upper bound on one call to `model`: the prompt plus the whole reply cap. */
export function estimateCompletionMicroUsd(rates: StreamBudgetRates, promptChars: number, maxTokens: number): number {
  const input = Math.ceil(promptChars / CHARS_PER_TOKEN) * rates.input;
  const output = maxTokens * rates.output;
  return Math.max(MIN_ESTIMATE_MICRO_USD, Math.ceil(input + output));
}

/**
 * Everything before the first token: model, admission, hold. A refusal here
 * reaches no provider and costs nothing.
 */
export async function admitArtifactCompletion(
  input: ArtifactCompletionInput,
  deps: ArtifactCompletionDeps
): Promise<{ ok: true; admission: CompletionAdmission } | CompletionRefusal> {
  const models = (await deps.resolveModels(input.viewerId)).slice(0, MAX_COMPLETION_ATTEMPTS);
  if (models.length === 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "No model is available for apps under your background-processing settings. Check Settings › Memory › Background work.",
        code: "model_unavailable",
      },
    };
  }
  const system = input.system?.trim() ? input.system : DEFAULT_ARTIFACT_SYSTEM;
  const promptChars = system.length + input.prompt.length;
  // The dearest of the models this call may end up on: a fallback is billed too.
  const estimateMicroUsd = Math.max(...models.map((m) => estimateCompletionMicroUsd(deps.rates(m), promptChars, input.maxTokens)));

  const admitted = await deps.admit({ userId: input.viewerId, plan: input.plan, estimateMicroUsd });
  if (!admitted.allowed) {
    const message = typeof admitted.body.error === "string" ? admitted.body.error : "You've reached a usage limit.";
    return { ok: false, status: 402, body: { ...admitted.body, error: message, code: "budget_exceeded", limit: admitted.body.code ?? null } };
  }
  const ref = deps.newRef();
  const held = await deps.reserve({ userId: input.viewerId, plan: input.plan, ref, estimateMicroUsd });
  if (!held.allowed) {
    return { ok: false, status: 402, body: { error: "You've reached your usage limit for now.", code: "budget_exceeded", limit: "reservation" } };
  }
  return {
    ok: true,
    admission: {
      viewerId: input.viewerId,
      ref,
      models,
      system,
      prompt: input.prompt,
      maxTokens: input.maxTokens,
      ceilingMicroUsd: admitted.remainingMicroUsd,
    },
  };
}

/**
 * The reply, as the route streams it. Ends with exactly one `done` or `error`
 * unless `signal` aborts (the page went away), in which case it just stops.
 * Billing and the hold's settlement happen whichever way it ends, including
 * when the consumer stops reading early.
 */
export async function* streamArtifactCompletion(
  admission: CompletionAdmission,
  deps: ArtifactCompletionDeps,
  signal: AbortSignal
): AsyncGenerator<CompletionStreamEvent> {
  let spentMicroUsd = 0;
  const promptChars = admission.system.length + admission.prompt.length;
  try {
    for (let attempt = 0; attempt < admission.models.length; attempt++) {
      const model = admission.models[attempt];
      const ctrl = new AbortController();
      const stopWithPage = () => ctrl.abort();
      if (signal.aborted) return;
      signal.addEventListener("abort", stopWithPage, { once: true });

      let out = "";
      let reasoningChars = 0;
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      let cacheUsage: CacheUsage = {};
      let received = false;
      let rejectedUnconsumed = false;
      let halted = false;
      const guard = createStreamBudgetGuard({
        ceilingMicroUsd: admission.ceilingMicroUsd == null ? null : Math.max(0, admission.ceilingMicroUsd - spentMicroUsd),
        rates: deps.rates(model),
        inputChars: promptChars,
        usage: () => ({
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          cacheReadTokens: cacheUsage.cacheRead,
          cacheWriteTokens: cacheUsage.cacheWrite,
          cacheWrite5mTokens: cacheUsage.cacheWrite5m,
          cacheWrite1hTokens: cacheUsage.cacheWrite1h,
          // Anthropic's input count excludes the cache buckets; the others include them.
          promptTokensIncludeCacheRead: model.provider !== "anthropic",
          outputChars: out.length,
          reasoningChars,
        }),
        onHalt: () => {
          halted = true;
          ctrl.abort();
        },
      });

      try {
        try {
          for await (const ev of deps.stream({
            model,
            system: admission.system,
            prompt: admission.prompt,
            maxTokens: admission.maxTokens,
            signal: ctrl.signal,
          })) {
            received = true;
            if (ev.type === "text" && ev.text) {
              // Counted either way (it was generated, so it is billed), but
              // never sent to a page that has already gone.
              out += ev.text;
              if (!signal.aborted) yield { type: "text", text: ev.text };
            } else if (ev.type === "reasoning") {
              reasoningChars += ev.text.length;
            } else if (ev.type === "usage") {
              inputTokens = ev.input ?? inputTokens;
              outputTokens = ev.output ?? outputTokens;
              cacheUsage = cacheUsageFrom(ev, cacheUsage);
            }
            guard.enforce();
            if (halted || signal.aborted) break;
          }
        } catch (err) {
          if (!halted && !signal.aborted) {
            rejectedUnconsumed = isUnconsumedProviderRejection(err, { receivedEvent: received, aborted: ctrl.signal.aborted });
            deps.onProviderFault?.(model, err);
            // Another model only while nothing has reached the app: a reply that
            // changed provider half-way would be two answers glued together.
            if (out.length === 0 && attempt < admission.models.length - 1) continue;
            yield { type: "error", code: "failed", message: "The model could not finish this reply. Try again." };
            return;
          }
        }
        if (signal.aborted) return;
        if (halted) {
          yield { type: "error", code: "budget_exceeded", message: "This reply was stopped because your usage limit was reached." };
          return;
        }
        yield { type: "done", model: model.id };
        return;
      } finally {
        signal.removeEventListener("abort", stopWithPage);
        if (!rejectedUnconsumed) {
          const billed = estimateGenerationCostUsd(model, {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            ...cacheUsage,
            promptChars,
            completionChars: out.length + reasoningChars,
          });
          spentMicroUsd += Math.round(billed.costUsd * 1_000_000);
          // Awaited: the route's stream closes the moment this generator ends,
          // and a charge left floating would land only if the process lived.
          await deps
            .record({
              userId: admission.viewerId,
              model: model.id,
              kind: "utility",
              source: "web",
              promptTokens: billed.promptTokens,
              completionTokens: billed.completionTokens,
              ...cacheUsage,
              costUsd: billed.costUsd || undefined,
              promptChars,
              completionChars: out.length,
              reasoningChars,
            })
            .catch(() => undefined);
        }
      }
    }
  } finally {
    await deps.settle(admission.viewerId, admission.ref, spentMicroUsd).catch(() => undefined);
  }
}
