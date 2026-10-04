import "server-only";

import type { ModelInfo } from "@/lib/models";
import {
  DEFAULT_BACKGROUND_PROVIDER_MODE,
  resolveBackgroundCandidates,
} from "@/lib/background-provider-policy";
import { runUtilityPrompt, utilityModelCandidates, type UtilityLlm } from "@/lib/memory";
import { recordSpend } from "@/lib/spend";
import {
  BATCH_STALE_MS,
  batchApiEnabled,
  batchBreakerTripped,
  batchRequests,
  createBatchingLlm,
  isBatchProvider,
  type BatchingLlmOptions,
  type PendingPrompt,
} from "@/lib/batch/plan";
import { batchCapable, liveBatchTransport, type BatchTransport } from "@/lib/batch/providers";
import {
  answersFrom,
  createBatchJob,
  markBatchApplied,
  markBatchEnded,
  markBatchFailed,
  openBatchJobs,
  recentBatchOutcomes,
  runningBatchJobs,
} from "@/lib/batch/store";

/*
 * Memory dreaming through the Batch APIs: the orchestration. The rules are in
 * plan.ts; this is what the dreamer (scripts/memory-dreamer.ts) calls, on its
 * existing ten-minute tick — the only scheduler batching needs:
 *
 *   tick N:   pollBatchJobs() finds nothing; the account's dream pass runs
 *             with the batching layer, which queues its prompts; finish()
 *             submits them as one batch per model.
 *   tick N+k: pollBatchJobs() sees the batch ended, BILLS every answer at
 *             the batch price (once, by idempotency key) and stores them; the
 *             account's next pass reads the answers like any model reply and
 *             queues whatever comes next (the following chunk, the summary).
 *
 * Every failure falls back to the synchronous walk: batching off
 * (BATCH_API_ENABLED=false), no batch-capable provider the account's policy
 * permits, a submission the provider refused (the dreamer re-runs the pass
 * synchronously), or a breaker tripped by batches that failed or went unused.
 */

const PURPOSE = "memory_dreaming";

export interface PollOutcome {
  ended: number;
  failed: number;
  stillRunning: number;
}

/**
 * Poll every running batch once. Ended ones are billed and stored; failed or
 * stale ones are marked failed (their prompts are simply queued again by the
 * next pass, or answered synchronously once the breaker trips).
 */
export async function pollBatchJobs(transport: BatchTransport = liveBatchTransport, now: Date = new Date()): Promise<PollOutcome> {
  const outcome: PollOutcome = { ended: 0, failed: 0, stillRunning: 0 };
  if (!batchApiEnabled()) return outcome;
  for (const job of await runningBatchJobs()) {
    try {
      if (!job.providerBatchId || !isBatchProvider(job.provider)) {
        await markBatchFailed(job.id, job.userId, "no provider batch");
        outcome.failed += 1;
        continue;
      }
      if (now.getTime() - new Date(job.createdAt).getTime() > BATCH_STALE_MS) {
        await markBatchFailed(job.id, job.userId, "stale");
        outcome.failed += 1;
        continue;
      }
      const status = await transport.status(job.provider, job.providerBatchId);
      if (status === "in_progress") {
        outcome.stillRunning += 1;
        continue;
      }
      if (status === "failed") {
        await markBatchFailed(job.id, job.userId, "provider reported failure");
        outcome.failed += 1;
        continue;
      }
      const results = await transport.results(job.provider, job.providerBatchId);
      /*
       * Billed BEFORE the row is marked ended, one ledger row per request with
       * a usage figure, under an idempotency key: a crash between the two is
       * retried on the next tick and the unique index turns the second charge
       * into a no-op. Billed whether or not the answer is ever used — the
       * provider charged for it either way — at the batch price, which is what
       * the provider charged.
       */
      for (const result of results) {
        if (!result.usage || (result.usage.input === 0 && result.usage.output === 0)) continue;
        await recordSpend({
          userId: job.userId,
          model: job.model,
          kind: "utility",
          promptTokens: result.usage.input,
          completionTokens: result.usage.output,
          cacheRead: result.usage.cacheRead || undefined,
          cacheWrite: result.usage.cacheWrite || undefined,
          batch: true,
          idempotencyKey: `batch:${job.id}:${result.customId}`,
        });
      }
      await markBatchEnded({ id: job.id, userId: job.userId, requests: job.requests, results });
      outcome.ended += 1;
    } catch (error) {
      // One job's failure is that job's; it is polled again next tick.
      console.error(`[batch] job=${job.id} poll failed:`, error instanceof Error ? error.message : String(error));
    }
  }
  return outcome;
}

/** The cheapest batch-capable model the account's policy permits for these options. */
function chooseBatchModel(opts: BatchingLlmOptions): ModelInfo | null {
  const decision = resolveBackgroundCandidates({
    policy: (opts.policy as Parameters<typeof resolveBackgroundCandidates>[0]["policy"]) ?? {
      mode: DEFAULT_BACKGROUND_PROVIDER_MODE,
    },
    conversationProvider: (opts.conversationProvider as string | null | undefined) ?? null,
    candidates: utilityModelCandidates(),
  });
  return [...decision.candidates].filter(batchCapable).sort((a, b) => a.cost - b.cost)[0] ?? null;
}

export interface BatchDreaming {
  /** The model layer for the dream pass. */
  llm: UtilityLlm;
  /**
   * After the pass: close the batches it read and submit what it queued.
   * `submitFailed` asks the caller to run the pass again synchronously.
   */
  finish(): Promise<{ submitted: number; queued: number; submitFailed: boolean }>;
}

/**
 * The batching layer for one account's dream pass, or null when batching is
 * off — the caller then runs the pass exactly as before.
 */
export async function prepareBatchDreaming(
  userId: string,
  transport: BatchTransport = liveBatchTransport
): Promise<BatchDreaming | null> {
  if (!batchApiEnabled()) return null;
  const [open, outcomes] = await Promise.all([openBatchJobs(userId), recentBatchOutcomes(userId)]);
  const ended = open.filter((job) => job.status === "ended");
  const inFlight = open.some((job) => job.status === "submitted");
  const answers = answersFrom(ended);
  const used = new Set<string>();
  const queued = new Map<string, { model: ModelInfo; prompts: PendingPrompt[] }>();

  const llm = createBatchingLlm<ModelInfo>({
    answers,
    onAnswerUsed: (key) => used.add(key),
    enabled: !batchBreakerTripped(outcomes),
    canQueue: !inFlight,
    chooseModel: chooseBatchModel,
    queue: (model, prompt) => {
      const entry = queued.get(model.id) ?? { model, prompts: [] };
      entry.prompts.push(prompt);
      queued.set(model.id, entry);
    },
    // The ordinary walk, inside the caller's own policy and ledger. Returns
    // the raw text only when the caller's parser accepts it, so the walk still
    // falls through to the next model on an unusable reply.
    sync: async (opts) => {
      const parse = typeof opts.parse === "function" ? (opts.parse as (text: string) => unknown) : null;
      const { result } = await runUtilityPrompt<string>({
        system: opts.system,
        userMsg: opts.userMsg,
        maxTokens: opts.maxTokens,
        label: opts.label,
        userId: (opts.userId as string | null | undefined) ?? userId,
        policy: opts.policy as Parameters<typeof runUtilityPrompt>[0]["policy"],
        conversationProvider: opts.conversationProvider as string | null | undefined,
        purpose: opts.purpose as Parameters<typeof runUtilityPrompt>[0]["purpose"],
        parse: (text) => (parse && parse(text) === null ? null : text),
      });
      return result;
    },
  });

  return {
    llm: llm as UtilityLlm,
    async finish() {
      for (const job of ended) {
        const matched = job.requests.filter((request) => used.has(request.key)).length;
        await markBatchApplied(job.id, userId, matched);
      }
      let submitted = 0;
      let queuedCount = 0;
      let submitFailed = false;
      for (const { model, prompts } of queued.values()) {
        const requests = batchRequests(prompts);
        queuedCount += requests.length;
        if (requests.length === 0) continue;
        const descriptor = requests.map(({ customId, key, label }) => ({ customId, key, label }));
        try {
          const providerBatchId = await transport.submit(
            model,
            requests.map(({ customId, system, userMsg, maxTokens }) => ({ customId, system, userMsg, maxTokens }))
          );
          await createBatchJob({ userId, provider: model.provider, model: model.id, purpose: PURPOSE, providerBatchId, requests: descriptor });
          submitted += 1;
        } catch (error) {
          submitFailed = true;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[batch] account=${userId} submit to ${model.provider} failed:`, message);
          // Recorded as a failed job so the breaker sees a provider that keeps refusing.
          await createBatchJob({
            userId,
            provider: model.provider,
            model: model.id,
            purpose: PURPOSE,
            providerBatchId: null,
            requests: descriptor,
            status: "failed",
            error: message.slice(0, 500),
          }).catch(() => undefined);
        }
      }
      return { submitted, queued: queuedCount, submitFailed };
    },
  };
}
