/**
 * Provider Batch APIs for background work nobody is waiting on — the rules.
 *
 * Anthropic Message Batches and the OpenAI Batch API run a request
 * asynchronously (most finish within the hour, all within 24h) and bill every
 * token at half price. That is the right trade for exactly one kind of work:
 * a job whose answer nobody is watching for. Memory dreaming — distilling past
 * chats into memory between sessions, and rebuilding the memory summaries
 * after — is the first; research and chat are not (users watch those).
 *
 * THE SHAPE. A batch cannot answer inside the call that asked, and the memory
 * pipeline is written as "call the model, use the answer". So the batch layer
 * is a `UtilityLlm` (the injectable model layer runUtilityPrompt already has)
 * that, per prompt:
 *
 *   - returns the answer when an ENDED batch already holds it (keyed by the
 *     prompt's hash), which the pipeline then applies like any reply;
 *   - otherwise records the prompt for the next batch and returns null, which
 *     every caller already treats as "model unavailable, keep the mark, retry
 *     later" — nothing is marked read, nothing is half-applied;
 *   - or, when batching cannot serve the prompt (disabled, a provider without
 *     a batch API, a circuit breaker after failed batches), answers through
 *     the ordinary synchronous walk, so the work never stalls on the batch.
 *
 * Applying is idempotent because the pipeline is: extraction marks each chunk
 * read as it is saved and saveCandidates de-duplicates, so an answer applied
 * twice (two ticks racing, a retry) learns nothing twice; and every batch
 * answer is BILLED when the batch is downloaded, once, under an idempotency
 * key per request, whether or not it is ever used — the provider charged for
 * it either way.
 *
 * Pure: no I/O. The provider calls are in providers.ts, the rows in store.ts,
 * the orchestration in dream.ts.
 */

import { createHash } from "node:crypto";

/** The providers whose Batch API Juno speaks. */
export const BATCH_PROVIDERS = ["anthropic", "openai"] as const;
export type BatchProvider = (typeof BATCH_PROVIDERS)[number];

export function isBatchProvider(provider: string): provider is BatchProvider {
  return (BATCH_PROVIDERS as readonly string[]).includes(provider);
}

/** `BATCH_API_ENABLED` — on unless set to a false-y value. */
export function batchApiEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.BATCH_API_ENABLED?.trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "off", "no"].includes(raw);
}

/**
 * Labels whose answer does not depend on the system prompt's per-call
 * context. Extraction's system prompt lists the facts already known, which
 * moves whenever a fact is learned; the answer for a chunk of conversation is
 * still the answer for that chunk (saveCandidates drops anything already
 * known). Keying on the system prompt too would orphan every batched
 * extraction the moment a sibling chunk taught a fact.
 */
const KEY_IGNORES_SYSTEM = new Set(["memory/extract"]);

/** The key a prompt's answer is stored and found under. Hex sha256, 40 chars. */
export function promptKey(input: { label: string; system: string; userMsg: string; maxTokens: number }): string {
  const parts = KEY_IGNORES_SYSTEM.has(input.label)
    ? [input.label, input.userMsg]
    : [input.label, String(input.maxTokens), input.system, input.userMsg];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
}

/** Both APIs accept `^[a-zA-Z0-9_-]{1,64}$`. Index first, so ids are unique even for a repeated prompt. */
export function customIdFor(index: number, key: string): string {
  return `r${index}_${key}`.slice(0, 64);
}

export interface PendingPrompt {
  key: string;
  label: string;
  system: string;
  userMsg: string;
  maxTokens: number;
}

/** A job's request list, deduplicated by key, capped. */
export function batchRequests(prompts: readonly PendingPrompt[], max = MAX_REQUESTS_PER_JOB): Array<PendingPrompt & { customId: string }> {
  const seen = new Set<string>();
  const out: Array<PendingPrompt & { customId: string }> = [];
  for (const prompt of prompts) {
    if (seen.has(prompt.key)) continue;
    seen.add(prompt.key);
    out.push({ ...prompt, customId: customIdFor(out.length, prompt.key) });
    if (out.length >= max) break;
  }
  return out;
}

/** One account's dreaming is small; a cap keeps one bad tick from a huge bill. */
export const MAX_REQUESTS_PER_JOB = 50;
/** Past this, an unfinished batch is treated as failed (the APIs' own window is 24h). */
export const BATCH_STALE_MS = 26 * 60 * 60_000;
/** Recent jobs the circuit breaker reads. */
export const BREAKER_WINDOW = 3;

export interface JobOutcome {
  status: string;
  requestCount: number;
  matchedCount: number;
}

/**
 * Whether an account's recent batches have stopped paying for themselves:
 * the last BREAKER_WINDOW applied-or-failed jobs all failed, or all came back
 * with answers nobody could use (the prompts moved before the batch ended).
 * Then the account's work goes through the synchronous walk — full price, but
 * never a loop of batches that are billed and thrown away.
 */
export function batchBreakerTripped(recent: readonly JobOutcome[]): boolean {
  const settled = recent.filter((job) => job.status === "applied" || job.status === "failed").slice(0, BREAKER_WINDOW);
  if (settled.length < BREAKER_WINDOW) return false;
  return settled.every((job) => job.status === "failed" || (job.requestCount > 0 && job.matchedCount === 0));
}

export interface BatchingLlmDeps<M> {
  /** Answers from ended batches for this account, by prompt key. */
  answers: ReadonlyMap<string, string>;
  /** Called once per answer actually used, for the job's matched count. */
  onAnswerUsed: (key: string) => void;
  /** The model a batch for these options would use, or null when none can (no batchable provider permitted). */
  chooseModel: (opts: BatchingLlmOptions) => M | null;
  /** Whether new prompts may be queued now: false while a batch is in flight for the account. */
  canQueue: boolean;
  /** Whether batching is on for this account at all (flag, breaker). */
  enabled: boolean;
  /** Queue a prompt for the next batch on `model`. */
  queue: (model: M, prompt: PendingPrompt) => void;
  /** The ordinary synchronous walk, for what batching cannot serve. */
  sync: (opts: BatchingLlmOptions) => Promise<string | null>;
}

export interface BatchingLlmOptions {
  system: string;
  userMsg: string;
  maxTokens: number;
  label: string;
  [key: string]: unknown;
}

export type BatchDecision = "answer" | "sync" | "queue" | "wait";

/** The decision, separated from the effects so a test can state it. */
export function batchDecision(input: {
  hasAnswer: boolean;
  enabled: boolean;
  hasModel: boolean;
  canQueue: boolean;
}): BatchDecision {
  if (input.hasAnswer) return "answer";
  if (!input.enabled || !input.hasModel) return "sync";
  return input.canQueue ? "queue" : "wait";
}

/** The `UtilityLlm` the dreamer hands the memory pipeline. */
export function createBatchingLlm<M>(deps: BatchingLlmDeps<M>) {
  return async (opts: BatchingLlmOptions): Promise<string | null> => {
    const key = promptKey(opts);
    const answer = deps.answers.get(key);
    const model = answer === undefined && deps.enabled ? deps.chooseModel(opts) : null;
    const decision = batchDecision({
      hasAnswer: answer !== undefined,
      enabled: deps.enabled,
      hasModel: model !== null,
      canQueue: deps.canQueue,
    });
    switch (decision) {
      case "answer":
        deps.onAnswerUsed(key);
        return answer!;
      case "sync":
        return deps.sync(opts);
      case "queue":
        deps.queue(model!, { key, label: opts.label, system: opts.system, userMsg: opts.userMsg, maxTokens: opts.maxTokens });
        return null;
      case "wait":
        return null;
    }
  };
}
