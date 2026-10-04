import { cache } from "react";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { decryptMessageText } from "@/lib/message-crypto";
import { decryptField, encryptField } from "@/lib/field-crypto";
import { streamChat } from "@/lib/llm";
import { MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { getModelMetrics } from "@/lib/model-metrics";
import {
  DEFAULT_BACKGROUND_PROVIDER_MODE,
  normalizeBackgroundProviderPolicy,
  resolveBackgroundCandidates,
  type BackgroundDenialReason,
  type BackgroundProcessingRecord,
  type BackgroundProviderMode,
  type BackgroundProviderPolicy,
  type BackgroundPurpose,
} from "@/lib/background-provider-policy";
import {
  DEFAULT_MEMORY_TOKEN_BUDGET,
  factsCoveredByForget,
  memoryForgetActivity,
  normalizeFact,
  memoryUpdateActivity,
  planFactIngestion,
  planTimelineReconciliation,
  coveredBySummary,
  selectMemoriesForContext,
  summaryPredatesForget,
  summaryPredatesMemoryChange,
  summaryRebuildDecision,
  type LifecycleEntry,
  type MemoryUpdateActivity,
  type RetrievalResult,
  type SemanticEvidence,
} from "@/lib/memory-lifecycle";
import { readMemorySummaryChanges } from "@/lib/memory-summary-changes";
import {
  SENSITIVE_TOPICS,
  SENSITIVE_TOPIC_META,
  normalizeSensitiveTopics,
  type SensitiveTopic,
} from "@/lib/memory-sensitive";
import { MEMORY_CONTENT_LIMIT, normalizeStatement } from "@/lib/memory-suppression";
import {
  budgetProjectFacts,
  projectConsolidationPrompt,
  projectSummaryIsEmpty,
} from "@/lib/memory-project-summary";
import { checkProjectAccess } from "@/lib/project-collaboration";
import {
  EXTRACTION_KNOWN_FACTS,
  EXTRACTOR_VERSION,
  extractionSystemPrompt,
  extractionUserMessage,
  parseExtraction,
} from "@/lib/memory-extraction";
import { CODING_MEMORY_CATEGORIES, selectCodingMemories } from "@/lib/code-memory-prompt";
import { configuredEmbeddingModels, embedQuery, embedTexts } from "@/lib/knowledge/embed";
// The same pricing helper `utilityCompletion` in src/lib/research/tools.ts bills
// through, deliberately: a second way of turning usage into money is how an
// estimate and a bill drift apart, and this number is about to be compared
// against a reservation by the research engine.
import { estimateGenerationCostUsd } from "@/lib/pricing";
import { recordSpend } from "@/lib/spend";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * Incremental memory architecture
 * -------------------------------
 * raw messages → per-chat extraction → memory candidates (MemoryEntry FACT,
 * with sourceRef + timestamps) → global summary (MemorySummary) → suppression
 * layer (MemoryEntry SUPPRESSION, highest priority) → visible memory UI.
 *
 * Every conversation carries a high-water mark (ConversationMemory.processedAt):
 * messages up to it have been distilled into facts. New messages advance the
 * mark incrementally; old conversations are covered by the resumable backfill.
 * Consolidation reads ONLY extracted facts + digests — never raw chat dumps.
 *
 * Suppressions store the *statement to forget* verbatim. They filter candidate
 * ingestion deterministically (normalized match/containment), are excluded from
 * chat context, and instruct the consolidator to omit the content — so a
 * forgotten thing cannot come back, even when old chats are re-extracted.
 */

// ---------------------------------------------------------------------------
// Provider walk for small utility prompts
// ---------------------------------------------------------------------------

/**
 * Configured models eligible for background memory work — up to two FREE
 * models per provider, fastest first within each provider, ordered
 * provider-diverse (every provider's best, then the second-string models).
 * Utility prompts are small and structured, so speed and cost beat raw
 * intelligence here. Free-tier quotas and overloads are often per-MODEL, so a
 * second model from the same provider is a real fallback.
 */
export function utilityModelCandidates(): ModelInfo[] {
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of MODEL_LIST) {
    if (m.minPlan !== "FREE" || m.modality !== "chat" || m.comingSoon || !isProviderConfigured(m.provider)) continue;
    const arr = byProvider.get(m.provider) ?? [];
    arr.push(m);
    byProvider.set(m.provider, arr);
  }
  const tiers = [...byProvider.values()].map((arr) =>
    arr
      .sort((a, b) => getModelMetrics(b).speed - getModelMetrics(a).speed || a.cost - b.cost)
      .slice(0, 2)
  );
  return [...tiers.map((a) => a[0]), ...tiers.flatMap((a) => a.slice(1))].slice(0, 10);
}

/**
 * The account's background-processing policy.
 *
 * Fails closed: an account with no Settings row, or a row this build cannot
 * read, gets the privacy-preserving default rather than the old
 * walk-every-provider behaviour.
 *
 * `cache()`d per request: the chat route asks for this twice on its own (once
 * for the memory profile, once for knowledge retrieval) and the policy cannot
 * change between the two. One Settings read, not three.
 */
/** The two columns this reads, for callers that hold the row already. */
export type BackgroundProviderSettings = {
  backgroundProviderMode: string | null;
  backgroundProviderSelected: string | null;
};

/**
 * `settings` skips the read entirely.
 *
 * The chat route loads the whole Settings row before it resolves a model, and
 * then asked for these two columns twice more on the way to the provider — on
 * the path a reader is watching "Starting your request" on. A caller that has
 * the row passes it; one that does not still gets the lookup.
 */
export const loadBackgroundProviderPolicy = cache(async function loadBackgroundProviderPolicy(
  userId: string,
  settings?: BackgroundProviderSettings | null
): Promise<BackgroundProviderPolicy> {
  try {
    const row = settings !== undefined
      ? settings
      : await prisma.settings.findUnique({
          where: { userId },
          select: { backgroundProviderMode: true, backgroundProviderSelected: true },
        });
    return normalizeBackgroundProviderPolicy({
      mode: row?.backgroundProviderMode as BackgroundProviderPolicy["mode"],
      selectedProvider: row?.backgroundProviderSelected,
      allowedProviders: deploymentProviderAllowlist(),
    });
  } catch {
    return normalizeBackgroundProviderPolicy({
      allowedProviders: deploymentProviderAllowlist(),
    });
  }
});

/**
 * The provider `same_provider` matches account-level background work against.
 *
 * Memory work started from the memory manager has no conversation behind it, so
 * for a long time it passed no provider at all — and `same_provider`, the
 * default every account is migrated to, matches nothing against null. The
 * result was that "Regenerate summary" and every natural-language memory edit
 * were denied on a stock account and the route blamed rate limits for it.
 * The honest stand-in is the model the user picked to chat with: the provider
 * they have already chosen to see this content. It is a stored column with a
 * schema default, so this resolves for every account.
 */
export async function accountBackgroundProvider(userId: string): Promise<string | null> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { userId },
      select: { defaultModel: true },
    });
    return settings?.defaultModel ? getModel(settings.defaultModel)?.provider ?? null : null;
  } catch {
    return null;
  }
}

/**
 * The policy for utility work that has no account behind it AND carries none of
 * the user's content.
 *
 * There is exactly one: translating Juno's own interface catalog. Those strings
 * are shipped literals — "New chat", "Settings" — identical for every visitor,
 * cached process-wide, and read by people who may not be signed in at all.
 *
 * That caller passed no policy, so it inherited `same_provider` and was matched
 * against a null provider it could never have: every request was denied, the
 * route threw "Translation model returned invalid JSON", and the ENTIRE
 * interface silently fell back to English for every non-English locale. The
 * same failure the memory editor had, on a surface where it was even quieter.
 *
 * `same_provider` protects the user's content, and there is no user and no
 * content here — so the honest rule is the deployment's own allowlist and
 * nothing narrower. Stated explicitly at the call site rather than defaulted,
 * because a caller that has not thought about the policy must still fail closed.
 */
export function platformUtilityPolicy(): BackgroundProviderPolicy {
  return normalizeBackgroundProviderPolicy({
    mode: "any_allowed_provider",
    allowedProviders: deploymentProviderAllowlist(),
  });
}

/**
 * Deployment-wide allowlist, for enterprise and regional policy. Bounds every
 * account's own mode; absent by default so single-tenant deployments are
 * unaffected.
 */
function deploymentProviderAllowlist(): string[] | null {
  const raw = process.env.BACKGROUND_PROVIDER_ALLOWLIST?.trim();
  if (!raw) return null;
  const list = raw.split(/[,\s]+/).filter(Boolean);
  return list.length > 0 ? list : null;
}

/** Billing/credit failures won't fix themselves; rate limits usually do. */
function isTransientProviderError(message: string): boolean {
  if (/credit|balance|billing|suspended|insufficient|402/i.test(message)) return false;
  return /429|rate.?limit|too many requests|overloaded|访问量过大|速率限制/i.test(message);
}

const ATTEMPT_TIMEOUT_MS = 20_000; // one slow/hung provider must not stall the walk
const TOTAL_DEADLINE_MS = 45_000; // stay well inside the routes' 60s budget

/**
 * Injectable model layer: given a prompt, return raw text (or null on failure).
 * Production uses the provider walk; tests inject a deterministic fake.
 */
export type UtilityLlm = (opts: {
  system: string;
  userMsg: string;
  maxTokens: number;
  label: string;
  /*
   * Everything else the caller gave runUtilityPrompt, passed through as is
   * (it hands its whole options object to the layer). A layer that falls back
   * to the real provider walk — the Batch API layer does, for work it cannot
   * batch — needs them to stay inside the caller's policy and ledger.
   */
  userId?: string | null;
  policy?: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  purpose?: BackgroundPurpose;
  parse?: (text: string) => unknown;
}) => Promise<string | null>;

export async function runUtilityPrompt<T>(opts: {
  system: string;
  userMsg: string;
  maxTokens: number;
  label: string;
  parse: (text: string) => T | null;
  /**
   * The account this walk bills to — or null when there is genuinely no account
   * behind it.
   *
   * Required, and required as a union rather than defaulted, because the bug
   * this closes was silence: every caller here spent real provider tokens that
   * never reached the ApiSpend ledger, so background work was invisible to the
   * monthly ceiling (`effectiveBudget`/`checkBudget`) and to the usage page. A
   * `userId?: string` would let the next caller reintroduce that by omission;
   * a required field makes each one state, at the call site, whose money this
   * is.
   *
   * Exactly one caller passes null today: the public UI-translation route,
   * which has no session and caches its result process-wide for every visitor.
   * Its spend is a platform cost, not any one account's — and ApiSpend.userId
   * is a foreign key with nowhere to point.
   */
  userId: string | null;
  /** Override the provider walk (tests / callers with their own model). */
  llm?: UtilityLlm;
  /**
   * Where this job is allowed to send the user's content. Omitting it applies
   * the privacy-preserving default rather than the old walk-everything
   * behaviour, so a caller that has not been taught about the policy fails
   * closed instead of silently crossing providers.
   */
  policy?: BackgroundProviderPolicy;
  /** Provider of the model the user actually chose for this conversation. */
  conversationProvider?: string | null;
  purpose?: BackgroundPurpose;
  /** Receives what was decided, for the audit trail. Never given content. */
  onDecision?: (record: BackgroundProcessingRecord) => void;
  /**
   * Walk the eligible models cheapest first (by cost tier, fastest within a
   * tier) instead of fastest first. For work where a cost-1 model is as good
   * as any — summarising history — and that runs often enough to matter.
   */
  cheapestFirst?: boolean;
}): Promise<{
  result: T | null;
  transient: boolean;
  deniedByPolicy?: boolean;
  /** Set with `deniedByPolicy`, so a caller can say WHICH rule refused. */
  deniedReason?: BackgroundDenialReason;
  mode?: BackgroundProviderMode;
  /**
   * What the provider walk really spent, micro-USD, across EVERY attempt.
   *
   * The ACCOUNT ledger is not this value's job: the walk writes its own
   * ApiSpend rows as it goes (see the `finally` below), so a caller that
   * ignores this number is still billed. What it reports is the same spend to
   * a caller that keeps a SECOND ledger of its own.
   *
   * Additive and optional, because almost every caller of this function —
   * titles, moderation, memory extraction, follow-ups, translations — keeps no
   * such ledger and correctly ignores it. The one caller that cannot is the
   * research citation judge:
   * it runs inside a budgeted run whose ceiling is enforced BEFORE each stage,
   * and a stage that never says what it cost is a stage the ceiling cannot see.
   * The run's reported cost under-stated the audit by the whole of it.
   *
   * Computed here rather than by that caller because this is the only place
   * that knows which model actually answered. The walk falls through providers
   * until one replies, so pricing "the utility model" from outside would be
   * pricing a call that may never have been made — and two cost calculations
   * that can disagree is the exact bug this exists to close.
   *
   * Absent (not zero) when `llm` is injected: the caller supplied its own model
   * layer, so this function neither chose nor billed anything and has no
   * honest number to report. Zero means a call was genuinely free or never
   * happened — a policy denial, say.
   */
  costMicroUsd?: number;
}> {
  if (opts.llm) {
    const text = await opts.llm(opts);
    return { result: text === null ? null : opts.parse(text), transient: false };
  }

  const decision = resolveBackgroundCandidates({
    policy: opts.policy ?? { mode: DEFAULT_BACKGROUND_PROVIDER_MODE },
    conversationProvider: opts.conversationProvider,
    candidates: opts.cheapestFirst
      ? [...utilityModelCandidates()].sort((a, b) => a.cost - b.cost)
      : utilityModelCandidates(),
  });

  if (decision.candidates.length === 0) {
    // Skipped, not fallen back. Falling back to some other provider is the
    // exact behaviour the policy exists to forbid, so there is nothing else
    // this can honestly do.
    opts.onDecision?.({
      purpose: opts.purpose ?? "memory_extraction",
      mode: decision.mode,
      effectiveProvider: null,
      effectiveModel: null,
      deniedReason: decision.deniedReason,
    });
    console.info(
      `[${opts.label}] skipped: background provider policy '${decision.mode}' left no eligible model (${decision.deniedReason}).`
    );
    return {
      result: null,
      transient: false,
      deniedByPolicy: true,
      deniedReason: decision.deniedReason,
      mode: decision.mode,
      // Refused before any model was reached, so the walk really did cost
      // nothing. Stated rather than omitted: absent means "unknown".
      costMicroUsd: 0,
    };
  }

  const started = Date.now();
  /** Micro-USD spent so far by this walk. See `costMicroUsd` on the result. */
  let spentMicroUsd = 0;

  const attempt = async (model: ModelInfo): Promise<{ result: T | null; transient: boolean }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    let out = "";
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    try {
      for await (const ev of streamChat({
        model,
        system: opts.system,
        history: [{ role: "USER", content: opts.userMsg, attachments: [] }],
        maxTokens: opts.maxTokens,
        signal: ctrl.signal,
      })) {
        if (ev.type === "text") out += ev.text;
        // The provider's own counts, which beat the character floor below.
        // Read whether or not the reply ends up being parseable: the tokens
        // were burned either way.
        else if (ev.type === "usage") {
          inputTokens = ev.input ?? inputTokens;
          outputTokens = ev.output ?? outputTokens;
        }
      }
    } catch (e) {
      const msg = ctrl.signal.aborted ? `timed out after ${ATTEMPT_TIMEOUT_MS}ms` : e instanceof Error ? e.message : String(e);
      console.error(`[${opts.label}] ${model.id} failed:`, msg);
      // A timeout usually means an overloaded provider — worth one retry.
      return { result: null, transient: ctrl.signal.aborted || isTransientProviderError(msg) };
    } finally {
      clearTimeout(timer);
      /*
       * Bill the attempt in `finally`, so a timeout, an abort and an unusable
       * reply are all counted. Charging only the attempt that SUCCEEDED was the
       * tempting shape and it under-reports exactly the runs that hurt: a walk
       * that burns two overloaded providers before the third answers spent
       * three calls' worth of tokens, and the provider charged for all three.
       * Same reasoning, and the same helper, as `utilityCompletion` in
       * src/lib/research/tools.ts.
       */
      const billed = estimateGenerationCostUsd(model, {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        promptChars: opts.system.length + opts.userMsg.length,
        completionChars: out.length,
      });
      spentMicroUsd += Math.round(billed.costUsd * 1_000_000);
      /*
       * ONE LEDGER ROW PER ATTEMPT, from the same `billed` figure the walk's
       * own total is accumulated from — so the number the research engine
       * reserves against and the number the monthly ceiling enforces cannot
       * disagree. Two computations of one charge is the drift this avoids.
       *
       * Per attempt rather than one summed row at the end, because ApiSpend is
       * "one row per billable model call" and a walk can call two providers
       * before a third answers: a single row would have to pick one model id
       * for tokens spent on three, and the usage page's per-model breakdown
       * would blame the wrong provider for the overload it routed around.
       *
       * Awaited, not fired-and-forgotten. Most of these walks run inside a
       * route handler or an `after()` hook that ends the moment the caller
       * gets its answer, and a floating insert there is a charge that lands
       * only if the process happens to live long enough. `recordSpend` already
       * swallows its own failures (a ledger outage must never break a title);
       * the catch is for the finally block itself, where a throw would replace
       * the model's answer with an error about billing.
       */
      if (opts.userId) {
        await recordSpend({
          userId: opts.userId,
          model: model.id,
          kind: "utility",
          promptTokens: billed.promptTokens,
          completionTokens: billed.completionTokens,
          costUsd: billed.costUsd || undefined,
          promptChars: opts.system.length + opts.userMsg.length,
          completionChars: out.length,
        }).catch(() => {});
      }
    }
    const parsed = opts.parse(out);
    if (parsed === null) console.error(`[${opts.label}] ${model.id} unusable output (${out.length} chars)`);
    return { result: parsed, transient: false };
  };

  const record = (model: ModelInfo) =>
    opts.onDecision?.({
      purpose: opts.purpose ?? "memory_extraction",
      mode: decision.mode,
      effectiveProvider: model.provider,
      effectiveModel: model.id,
    });

  const retryable: ModelInfo[] = [];
  let sawTransient = false;
  for (const model of decision.candidates) {
    if (Date.now() - started > TOTAL_DEADLINE_MS) {
      return { result: null, transient: true, costMicroUsd: spentMicroUsd };
    }
    const { result, transient } = await attempt(model);
    if (result !== null) {
      record(model);
      return { result, transient: false, costMicroUsd: spentMicroUsd };
    }
    if (transient) {
      retryable.push(model);
      sawTransient = true;
    }
  }
  if (retryable.length > 0 && Date.now() - started < TOTAL_DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 2500));
    for (const model of retryable) {
      if (Date.now() - started > TOTAL_DEADLINE_MS) {
        return { result: null, transient: true, costMicroUsd: spentMicroUsd };
      }
      const { result } = await attempt(model);
      if (result !== null) {
        record(model);
        return { result, transient: false, costMicroUsd: spentMicroUsd };
      }
    }
  }
  // Every candidate failed, and every one of them still cost something.
  return { result: null, transient: sawTransient, costMicroUsd: spentMicroUsd };
}

// ---------------------------------------------------------------------------
// Candidates + suppression layer
// ---------------------------------------------------------------------------

// Matching and the write door itself live in @/lib/memory-suppression, which
// carries no Prisma import so the rule stays testable. Everything here is the
// database half.

/** The statements this account asked Juno to never remember. */
export async function getSuppressions(userId: string): Promise<string[]> {
  const rows = await prisma.memoryEntry.findMany({
    where: { userId, kind: "SUPPRESSION" },
    select: { content: true },
  });
  return rows.map((r) => r.content);
}

/**
 * When the account last asked Juno to forget something, or null if never.
 *
 * Read on every chat turn that has a summary, so it is one indexed lookup —
 * `@@index([userId, kind])` narrows to the account's suppressions, which are a
 * handful of rows, and only the newest timestamp is selected.
 */
export async function newestSuppressionAt(userId: string): Promise<Date | null> {
  const row = await prisma.memoryEntry.findFirst({
    where: { userId, kind: "SUPPRESSION" },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

export interface ForgetOutcome {
  /** The statements recorded as suppressions (new ones only). */
  statements: string[];
  /** Active facts retired because a statement covered them. */
  retired: number;
}

/**
 * Forget, from inside a conversation.
 *
 * The same act as the memory page's Forget, reached by saying so: every active
 * fact a statement covers is retired (kept, marked `suppressed`, with a reason —
 * the trail survives), and the statement is written to the block-list so the
 * extractor cannot relearn it from the chat it came from. What counts as
 * "covered" is the block-list's own rule, via `factsCoveredByForget`.
 *
 * A statement that matches no stored fact is still recorded. The thing to
 * forget may only ever have existed in the consolidated summary's prose, and
 * the suppression is exactly what keeps the next consolidation from writing it
 * again — skipping it would make "forget that" depend on an implementation
 * detail the user cannot see.
 *
 * One transaction, so a forget is never half-applied: retiring the facts
 * without the suppression would let the next backfill bring them straight back.
 */
export async function forgetStatements(
  userId: string,
  statements: readonly string[],
  opts: {
    /** Where the forget was asked for, for the row's provenance. */
    conversationId?: string | null;
    /** Receives the chat-timeline receipt; never called when nothing was recorded. */
    onActivity?: (event: MemoryUpdateActivity) => void;
  } = {}
): Promise<ForgetOutcome> {
  const cleaned = [
    ...new Map(
      statements
        .map((statement) => statement.trim().slice(0, MEMORY_CONTENT_LIMIT))
        .filter((statement) => normalizeStatement(statement))
        .map((statement) => [normalizeStatement(statement), statement] as const)
    ).values(),
  ].slice(0, 8);
  if (cleaned.length === 0) return { statements: [], retired: 0 };

  const rows = await prisma.memoryEntry.findMany({
    where: { userId },
    select: { id: true, content: true, kind: true, status: true },
  });
  const existingSuppressions = new Set(
    rows.filter((row) => row.kind === "SUPPRESSION").map((row) => normalizeStatement(row.content))
  );

  const retireIds = new Set<string>();
  for (const statement of cleaned) {
    for (const id of factsCoveredByForget(statement, rows)) retireIds.add(id);
  }
  // A statement already on the block-list needs no second row — and writing
  // one would move `newestSuppressionAt` forward for nothing, benching a summary
  // that was already rebuilt without it.
  const fresh = cleaned.filter((statement) => !existingSuppressions.has(normalizeStatement(statement)));
  if (fresh.length === 0 && retireIds.size === 0) return { statements: [], retired: 0 };

  const now = new Date();
  await prisma.$transaction([
    prisma.memoryEntry.updateMany({
      where: { userId, id: { in: [...retireIds] }, status: "active" },
      data: {
        status: "suppressed",
        reason: `You asked ${PRODUCT_NAME} to forget this in a conversation.`,
        supersededById: null,
      },
    }),
    ...fresh.map((statement) =>
      prisma.memoryEntry.create({
        data: {
          userId,
          content: statement,
          source: "MANUAL",
          kind: "SUPPRESSION",
          sourceRef: opts.conversationId ?? "forget",
          category: "suppression",
          confidence: 1,
          // The column holds the LIFECYCLE's comparable form on every row,
          // suppressions included — that is what the page's Forget and the
          // applied edit both write. The order-preserving form above is only
          // for comparing statements in memory.
          normalized: normalizeFact(statement),
          lastVerifiedAt: now,
        },
      })
    ),
  ]);

  const outcome = { statements: fresh.length > 0 ? fresh : cleaned, retired: retireIds.size };
  const activity = memoryForgetActivity(outcome);
  if (activity) opts.onActivity?.(activity);
  return outcome;
}

/** The columns the lifecycle rules need to judge an existing entry. */
const LIFECYCLE_SELECT = {
  id: true,
  content: true,
  normalized: true,
  category: true,
  projectId: true,
  sourceRef: true,
  sourceMessageId: true,
  source: true,
  kind: true,
  confidence: true,
  status: true,
  expiresAt: true,
  createdAt: true,
  // When it was said, and what replaced it — the two things judging a fact
  // against the timeline needs (planFactIngestion, planTimelineReconciliation).
  observedAt: true,
  supersededById: true,
  // The vector space marker only — never the vector itself, which is thousands
  // of floats a duplicate check has no use for. Rows lacking one are the
  // organic backfill queue: refreshing such a row re-embeds it below.
  embeddingModel: true,
} as const;

// ---------------------------------------------------------------------------
// Embedding at write time
// ---------------------------------------------------------------------------

/** Test seam matching knowledge/embed's batch call. */
export type MemoryEmbedder = typeof embedTexts;

/**
 * Writes are user-visible round-trips (a chat turn's tail, a memory-page
 * save), so a hung embeddings endpoint gets this long and then the rows stay
 * lexical-only — well under embed.ts's own 30s per-request ceiling.
 */
const WRITE_EMBED_TIMEOUT_MS = 8_000;

/**
 * Attach vectors to freshly written facts, best effort.
 *
 * Same background-provider contract as the knowledge index: the policy decides
 * where content may be sent, denial and provider failure both degrade to
 * lexical-only retrieval for these rows, and nothing here can ever fail the
 * write that called it. The account's existing vector space is preferred so a
 * fact written today stays comparable with the facts written last month —
 * mixing spaces would make the stored vectors mutually meaningless.
 */
export async function embedMemoryEntries(opts: {
  userId: string;
  rows: readonly { id: string; content: string }[];
  policy?: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  embed?: MemoryEmbedder;
}): Promise<void> {
  if (opts.rows.length === 0) return;
  // Cheap pre-check only on the real provider path; an injected embedder is
  // the test's business.
  if (!opts.embed && configuredEmbeddingModels().length === 0) return;
  try {
    const [policy, conversationProvider, pinned] = await Promise.all([
      opts.policy ? Promise.resolve(opts.policy) : loadBackgroundProviderPolicy(opts.userId),
      opts.conversationProvider !== undefined
        ? Promise.resolve(opts.conversationProvider)
        : accountBackgroundProvider(opts.userId),
      prisma.memoryEntry.findFirst({
        where: { userId: opts.userId, embeddingModel: { not: null } },
        orderBy: { updatedAt: "desc" },
        select: { embeddingModel: true },
      }),
    ]);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), WRITE_EMBED_TIMEOUT_MS);
    let outcome: Awaited<ReturnType<MemoryEmbedder>>;
    try {
      outcome = await (opts.embed ?? embedTexts)({
        texts: opts.rows.map((row) => row.content),
        policy,
        conversationProvider,
        preferModelId: pinned?.embeddingModel ?? null,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!outcome.ok) return;

    await prisma.$transaction(
      opts.rows.map((row, i) =>
        prisma.memoryEntry.updateMany({
          where: { id: row.id, userId: opts.userId },
          data: { embedding: outcome.vectors[i], embeddingModel: outcome.model.id },
        })
      )
    );
  } catch (error) {
    // A missing vector costs one row its semantic leg; a thrown error here
    // would cost the user the fact itself.
    console.error("[memory] embedding failed:", error instanceof Error ? error.message : error);
  }
}

export interface SaveCandidatesResult {
  /** New rows written. */
  created: number;
  /** Already-known facts whose lastVerifiedAt was refreshed instead. */
  refreshed: number;
  /** Older beliefs this batch replaced — annotated, never deleted. */
  superseded: number;
  /** Stored but not believed: suppressed, or beaten by an explicit fact. */
  rejected: number;
  /**
   * Stored as history: said before something that now holds its place, or a
   * temporary fact whose moment had passed by the time it was read. What
   * re-reading old chats mostly produces, and neither a new belief nor a
   * refusal.
   */
  history: number;
  /** Facts Juno had stopped believing and believes again, because they were said again later. */
  reinstated: number;
  /**
   * Refused because they fall under a sensitive topic this account has not
   * opted into — counted apart from `rejected` because nothing was written at
   * all, and because a user who has just seen "nothing was remembered from
   * that chat" is owed the reason that has a switch attached to it.
   */
  sensitiveSkipped: number;
  /** The distinct topics behind `sensitiveSkipped`, for that explanation. */
  sensitiveTopics: SensitiveTopic[];
}

/**
 * The sensitive topics an account has opted into, normalized.
 *
 * Fails closed, like `loadBackgroundProviderPolicy` and for the same reason: an
 * account with no Settings row, or a row this build cannot read, gets the
 * private default rather than an accidental yes. `cache()`d per request because
 * a chat turn asks for it on the extraction path and the page asks again to
 * render the flags.
 */
export const loadAllowedSensitiveTopics = cache(async function loadAllowedSensitiveTopics(
  userId: string
): Promise<SensitiveTopic[]> {
  try {
    const row = await prisma.settings.findUnique({
      where: { userId },
      select: { memorySensitiveTopics: true },
    });
    return normalizeSensitiveTopics(row?.memorySensitiveTopics);
  } catch {
    return [];
  }
});

/**
 * Persist candidate facts through the Memory v2 lifecycle: classify, detect
 * duplicates by normalized form, and let a genuinely conflicting fact supersede
 * the older one rather than sitting beside it.
 *
 * The write loop is deliberately one fact at a time against an in-memory view
 * that is updated as it goes — two facts in the same extraction batch can be
 * duplicates of each other, and a batch-wide snapshot taken once would let both
 * through.
 */
export async function saveCandidates(
  userId: string,
  facts: string[],
  sourceRef?: string,
  opts: {
    projectId?: string | null;
    sourceMessageId?: string | null;
    source?: "AUTO" | "MANUAL";
    /**
     * When these facts were said — the source message's time. Omitted means
     * now, which is right for a fact learned during its own chat and wrong for
     * one read out of history, which is why the extractor always passes it.
     */
    observedAt?: Date;
    /** Where embedding this content may be sent; loaded from the account when omitted. */
    policy?: BackgroundProviderPolicy;
    conversationProvider?: string | null;
    embed?: MemoryEmbedder;
    /**
     * Sensitive topics this account permits. Loaded from Settings when
     * omitted — never defaulted to "all", so a caller that has not been taught
     * about the gate refuses rather than storing a diagnosis.
     */
    allowedSensitiveTopics?: readonly SensitiveTopic[];
    /**
     * Receives the "Memory updated" receipt when this batch created a fact —
     * shaped for the chat activity timeline, so the caller can forward it to
     * `sendActivity` unchanged. Never called for a batch that only refreshed
     * or rejected: an announcement with nothing new behind it is noise.
     */
    onActivity?: (event: MemoryUpdateActivity) => void;
  } = {}
): Promise<SaveCandidatesResult> {
  const result: SaveCandidatesResult = {
    created: 0,
    refreshed: 0,
    superseded: 0,
    rejected: 0,
    history: 0,
    reinstated: 0,
    sensitiveSkipped: 0,
    sensitiveTopics: [],
  };
  if (facts.length === 0) return result;

  const [rows, allowedSensitiveTopics] = await Promise.all([
    prisma.memoryEntry.findMany({ where: { userId }, select: LIFECYCLE_SELECT }),
    opts.allowedSensitiveTopics
      ? Promise.resolve(opts.allowedSensitiveTopics)
      : loadAllowedSensitiveTopics(userId),
  ]);
  const entries: LifecycleEntry[] = rows.filter((r) => r.kind === "FACT");
  const suppressions = rows.filter((r) => r.kind === "SUPPRESSION").map((r) => r.content);
  const now = new Date();
  const source = opts.source ?? "AUTO";
  const projectId = opts.projectId ?? null;
  // Rows owed a vector after this batch: everything created, plus refreshed
  // rows written before embedding existed — restating an old fact is the one
  // moment it is naturally back in hand, so the backfill rides along for free.
  const toEmbed: { id: string; content: string }[] = [];
  const createdContents: string[] = [];

  // Supersede an older belief — only if it is still believed, so a race with
  // another writer can never un-retire a row by overwriting its status.
  const supersede = async (entryId: string, byId: string, reason: string) => {
    await prisma.memoryEntry.updateMany({
      where: { id: entryId, userId, status: "active" },
      data: { status: "superseded", supersededById: byId, reason },
    });
    const older = entries.find((e) => e.id === entryId);
    if (older && older.status === "active") {
      older.status = "superseded";
      older.supersededById = byId;
    }
    result.superseded++;
  };

  for (const fact of facts) {
    const plan = planFactIngestion(
      { content: fact, source, projectId, ...(opts.observedAt ? { observedAt: opts.observedAt } : {}) },
      { entries, suppressions, now, allowedSensitiveTopics }
    );

    if (plan.action === "skip") {
      if (plan.reason === "suppressed") result.rejected++;
      if (plan.reason === "sensitive") {
        result.sensitiveSkipped++;
        if (!result.sensitiveTopics.includes(plan.topic)) result.sensitiveTopics.push(plan.topic);
      }
      continue;
    }

    if (plan.action === "refresh") {
      await prisma.memoryEntry.updateMany({
        where: { id: plan.entryId, userId },
        data: {
          lastVerifiedAt: now,
          ...(plan.revive ? { status: "active", reason: `You mentioned this again, so ${PRODUCT_NAME} picked it back up.` } : {}),
          ...(plan.reinstate ? { status: "active", reason: plan.reinstate.reason, supersededById: null } : {}),
          ...(plan.expiresAt !== undefined ? { expiresAt: plan.expiresAt } : {}),
          ...(plan.observedAt ? { observedAt: plan.observedAt } : {}),
        },
      });
      const known = entries.find((e) => e.id === plan.entryId);
      if (known && (plan.revive || plan.reinstate)) {
        known.status = "active";
        if (plan.reinstate) known.supersededById = null;
      }
      if (known && plan.expiresAt !== undefined) known.expiresAt = plan.expiresAt;
      if (known && plan.observedAt) known.observedAt = plan.observedAt;
      if (known && !known.embeddingModel) toEmbed.push({ id: known.id, content: known.content });
      if (plan.reinstate) {
        result.reinstated++;
        if (known) createdContents.push(known.content);
      }
      if (plan.supersedes) await supersede(plan.supersedes.entryId, plan.entryId, plan.supersedes.reason);
      result.refreshed++;
      continue;
    }

    const created = await prisma.memoryEntry.create({
      data: {
        userId,
        content: plan.content,
        source,
        kind: "FACT",
        sourceRef,
        category: plan.category,
        projectId,
        sourceMessageId: opts.sourceMessageId ?? null,
        confidence: plan.confidence,
        status: plan.status,
        reason: plan.reason ?? null,
        expiresAt: plan.expiresAt,
        observedAt: plan.observedAt,
        supersededById: plan.supersededById ?? null,
        normalized: plan.normalized,
        lastVerifiedAt: now,
      },
      select: LIFECYCLE_SELECT,
    });
    entries.push(created);
    if (plan.status === "active") {
      result.created++;
      createdContents.push(plan.content);
    } else if (plan.status === "superseded" || plan.status === "expired") {
      result.history++;
    } else {
      result.rejected++;
    }
    toEmbed.push({ id: created.id, content: plan.content });

    if (plan.supersedes) await supersede(plan.supersedes.entryId, created.id, plan.supersedes.reason);
  }

  await embedMemoryEntries({
    userId,
    rows: toEmbed,
    policy: opts.policy,
    conversationProvider: opts.conversationProvider,
    embed: opts.embed,
  });

  if (opts.onActivity) {
    // A fact believed again is as much an update as a new one — "back in
    // Madrid" changes what Juno believes, and the receipt should say so.
    const activity = memoryUpdateActivity(
      { created: result.created + result.reinstated, superseded: result.superseded },
      createdContents
    );
    if (activity) opts.onActivity(activity);
  }
  return result;
}

/**
 * Back-compat alias for the chat route's model-emitted memory tags: returns how
 * many facts this changed into believed ones — new, or believed again — which
 * is all the caller uses it for.
 */
export async function saveAutoMemories(
  userId: string,
  facts: string[],
  sourceRef?: string,
  opts: {
    projectId?: string | null;
    sourceMessageId?: string | null;
    conversationProvider?: string | null;
    /** Forwarded to saveCandidates — the chat route's `sendActivity` fits it. */
    onActivity?: (event: MemoryUpdateActivity) => void;
  } = {}
): Promise<number> {
  const result = await saveCandidates(userId, facts, sourceRef, opts);
  return result.created + result.reinstated;
}

/**
 * Retire temporary facts whose moment has passed.
 *
 * Retrieval already refuses to inject an expired entry, so this is not what
 * keeps them out of context — it is what stops the memory page from listing a
 * flight from three months ago as something Juno currently believes. Cheap
 * enough to run on any page load: one indexed updateMany over
 * `@@index([userId, expiresAt])`.
 */
export async function sweepExpiredMemories(userId: string, now: Date = new Date()): Promise<number> {
  const { count } = await prisma.memoryEntry.updateMany({
    where: { userId, status: "active", expiresAt: { not: null, lte: now } },
    data: { status: "expired", reason: "This was only true for a while, and that while has passed." },
  });
  return count;
}

// ---------------------------------------------------------------------------
// Per-chat extraction (incremental, high-water marked)
// ---------------------------------------------------------------------------

const CHUNK_MESSAGES = 40; // user messages per extraction call
const CHUNK_CHARS = 12_000;

/**
 * Distill unprocessed user messages of one conversation into memory facts.
 * Advances the conversation's high-water mark chunk by chunk, so partial
 * progress is kept and the job is resumable. Returns what happened.
 */
export async function extractConversationMemory(opts: {
  userId: string;
  conversationId: string;
  /** Bound LLM cost per invocation; remaining chunks are picked up next run. */
  maxChunks?: number;
  /** Loaded from the account when omitted. */
  policy?: BackgroundProviderPolicy;
  onDecision?: (record: BackgroundProcessingRecord) => void;
  llm?: UtilityLlm;
}): Promise<{ created: number; chunksProcessed: number; done: boolean }> {
  const maxChunks = opts.maxChunks ?? 3;
  const convo = await prisma.conversation.findFirst({
    where: { id: opts.conversationId, userId: opts.userId },
    select: {
      id: true,
      title: true,
      // The provider the user actually chose is what `same_provider` matches
      // background work against.
      model: true,
      projectId: true,
      lastMessageAt: true,
      memory: { select: { processedAt: true, factCount: true, digest: true } },
    },
  });
  if (!convo) return { created: 0, chunksProcessed: 0, done: true };

  const since = convo.memory?.processedAt;
  // Message bodies are encrypted at rest — decrypt at the read boundary.
  const messages = (
    await prisma.message.findMany({
      where: { conversationId: convo.id, role: "USER", ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "asc" },
      select: { id: true, content: true, createdAt: true },
    })
  ).map((m) => ({ ...m, content: decryptMessageText(m.content) }));

  // Chunk digests MERGE into the stored one (newest kept when over budget) —
  // a multi-chunk conversation must not end up described by its last chunk only.
  const mergeDigest = (prev: string | null | undefined, next: string | null): string | undefined => {
    // A chat read again (a re-read after the reader improved) describes itself
    // the same way twice; the digest says it once.
    const said = (prev ?? "").split(" · ").map((part) => part.replace(/^…/, "").trim().toLowerCase());
    const fresh = next && !said.includes(next.trim().toLowerCase()) ? next : null;
    const combined = [prev, fresh].filter(Boolean).join(" · ");
    if (!combined) return undefined;
    return combined.length > 300 ? `…${combined.slice(-299)}` : combined;
  };

  let storedDigest: string | null = convo.memory?.digest ?? null;
  const markProcessed = async (upTo: Date, digest: string | null, createdDelta: number) => {
    const merged = mergeDigest(storedDigest, digest);
    storedDigest = merged ?? null;
    await prisma.conversationMemory.upsert({
      // Scoped: unscoped, the ownership guard refused this upsert, the chat was
      // never marked read, and every turn re-ran (and re-paid for) extraction.
      where: { conversationId: convo.id, userId: opts.userId },
      create: {
        userId: opts.userId,
        conversationId: convo.id,
        processedAt: upTo,
        digest: merged,
        factCount: createdDelta,
        // A chat read from its first message by this reader. Continuing an
        // older one does NOT restamp it: its earlier messages were still read
        // by the older reader, and `queueRereads` is what brings those back.
        extractorVersion: EXTRACTOR_VERSION,
      },
      update: {
        processedAt: upTo,
        ...(merged ? { digest: merged } : {}),
        factCount: { increment: createdDelta },
      },
    });
  };

  if (messages.length === 0) {
    // Nothing new to read — cover the chat so backfill doesn't revisit it.
    await markProcessed(convo.lastMessageAt, null, 0);
    return { created: 0, chunksProcessed: 0, done: true };
  }

  // Chunk by count + chars.
  const chunks: { id: string; content: string; createdAt: Date }[][] = [];
  let current: { id: string; content: string; createdAt: Date }[] = [];
  let chars = 0;
  for (const m of messages) {
    const text = m.content.replace(/\s+/g, " ").trim().slice(0, 1200);
    if (!text) continue;
    if (current.length >= CHUNK_MESSAGES || (chars + text.length > CHUNK_CHARS && current.length > 0)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push({ id: m.id, content: text, createdAt: m.createdAt });
    chars += text.length;
  }
  if (current.length) chunks.push(current);

  const [recentFacts, suppressions, allowedSensitiveTopics] = await Promise.all([
    // "Already known" means BELIEVED, IN THIS SCOPE (extractor v2).
    //
    // In this scope: the one the facts below will be saved into, and the one
    // duplicate detection compares against (`findDuplicate` matches on scope
    // exactly). This listed the newest facts from anywhere, so a project
    // chat's extractor was shown another project's notes as known — a
    // cross-project leak into the prompt, and a recall bug: told it already
    // knew "uses pnpm", the model skipped it, and the project that had just
    // heard it never learned it.
    //
    // Believed: a fact Juno stopped believing is not known, it is news when
    // said again. Listing replaced facts too meant "I live in Madrid again"
    // was skipped as already known, and the city that had replaced Madrid
    // stayed believed. The recall benchmark found that one.
    prisma.memoryEntry.findMany({
      where: {
        userId: opts.userId,
        kind: "FACT",
        status: "active",
        projectId: convo.projectId ?? null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { createdAt: "desc" },
      take: EXTRACTION_KNOWN_FACTS,
      select: { content: true },
    }),
    getSuppressions(opts.userId),
    loadAllowedSensitiveTopics(opts.userId),
  ]);

  // Belt AND braces. `saveCandidates` refuses a sensitive candidate whatever
  // the model returns, so this line changes no outcome — but an extractor that
  // is not asked for a diagnosis does not put one in a prompt, and the
  // difference between "refused at the door" and "never requested" is the
  // difference between the content having been sent to a provider and not.
  const offLimits = SENSITIVE_TOPICS.filter((topic) => !allowedSensitiveTopics.includes(topic));

  const system = extractionSystemPrompt({
    offLimitsLabels: offLimits.map((topic) => SENSITIVE_TOPIC_META[topic].label.toLowerCase()),
    suppressions,
    known: recentFacts.map((f) => f.content),
  });

  // Loaded once per invocation, not per chunk: the policy cannot change
  // half-way through an extraction, and re-reading it would be a query per
  // chunk for an answer that does not move.
  const policy = opts.policy ?? (await loadBackgroundProviderPolicy(opts.userId));
  const conversationProvider = getModel(convo.model)?.provider ?? null;

  let created = 0;
  let processed = 0;
  const toProcess = chunks.slice(0, maxChunks);
  for (const chunk of toProcess) {
    const userMsg = extractionUserMessage({ title: convo.title, messages: chunk.map((m) => m.content) });

    const { result } = await runUtilityPrompt({
      system,
      userMsg,
      maxTokens: 500,
      label: "memory/extract",
      parse: parseExtraction,
      userId: opts.userId,
      policy,
      conversationProvider,
      purpose: "memory_extraction",
      onDecision: opts.onDecision,
      llm: opts.llm,
    });
    if (!result) break; // model unavailable — keep the mark, retry later

    // A chat that belongs to a project teaches project-scoped memory: course
    // notes learned in "Japanese" must not surface in an unrelated work chat.
    const { created: createdInChunk } = await saveCandidates(opts.userId, result.facts, convo.id, {
      projectId: convo.projectId,
      // When the user said these: the chunk's last message, the same one the
      // row's sourceMessageId points at. For a chat distilled as it happens
      // that is moments ago; for history re-read it is when it was said —
      // which is what lets an old statement lose to a newer one however late
      // it is read.
      observedAt: chunk.at(-1)?.createdAt,
      // The extractor returns facts for a bounded group rather than a
      // per-fact source map. Point at the last user message in that group —
      // the conversation id remains the authoritative provenance, and this
      // optional anchor gives the UI a useful place to reopen the source.
      sourceMessageId: chunk.at(-1)?.id ?? null,
      // Embedding the new facts is background work on the same content the
      // extraction just processed, so it answers to the same policy and the
      // same conversation provider rather than resolving its own.
      policy,
      conversationProvider,
      // Resolved once above with the suppressions, for the same reason the
      // policy is: it cannot change half-way through an extraction.
      allowedSensitiveTopics,
    });
    created += createdInChunk;
    const isLastChunkOverall = processed + 1 === chunks.length;
    await markProcessed(
      isLastChunkOverall ? convo.lastMessageAt : chunk[chunk.length - 1].createdAt,
      result.digest,
      createdInChunk
    );
    processed++;
  }

  return { created, chunksProcessed: processed, done: processed >= chunks.length };
}

// ---------------------------------------------------------------------------
// Re-reading — history read by an older reader, read again
// ---------------------------------------------------------------------------

/**
 * Queue chats an older reader distilled to be read again by this one.
 *
 * WHY. Each reader version fixes things the previous one missed — v2 stops
 * telling the model it "already knows" other scopes' facts and facts Juno no
 * longer believes, both of which made it skip real ones (see
 * EXTRACTOR_VERSION). Chats read before that stay short of those facts until
 * they are read again. ChatGPT's memory re-reads history in the background
 * for the same reason; this is the part of Juno's dreamer that does.
 *
 * WHERE IT STARTS — and why never from the beginning. A reset marks every
 * chat as read and deletes every fact, precisely so old chats are never
 * learned from again. Re-reading "from the start" after a reader upgrade
 * would quietly undo that, and nothing stored says when an account last reset.
 * But every row a reset leaves is newer than the reset, so the oldest thing
 * Juno still remembers is a point no reset can be later than: a chat is
 * re-read only from there. For an account that never reset, that is roughly
 * when it started remembering; for one that did, it is after the reset.
 *
 * Only chats that were actually distilled — a digest or a fact to show for it
 * — and only in the chat's own scope, like any reading. Chats with nothing
 * after the restart point are simply stamped as current: there is nothing an
 * older reader read there that this one should read again.
 *
 * Returns how many were queued; the backfill picks them up on its next pass
 * (they are behind their last message again, which is what "pending" means).
 */
export async function queueRereads(userId: string, limit: number): Promise<number> {
  const [oldest, candidates] = await Promise.all([
    prisma.memoryEntry.findFirst({ where: { userId }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    prisma.conversationMemory.findMany({
      where: {
        userId,
        extractorVersion: { lt: EXTRACTOR_VERSION },
        OR: [{ digest: { not: null } }, { factCount: { gt: 0 } }],
      },
      orderBy: { updatedAt: "desc" },
      take: limit * 4,
      select: { id: true, processedAt: true, conversation: { select: { lastMessageAt: true } } },
    }),
  ]);
  let queued = 0;
  for (const row of candidates) {
    if (queued >= limit) break;
    const restartAt = oldest?.createdAt ?? null;
    const worthReading =
      restartAt !== null &&
      row.processedAt.getTime() > restartAt.getTime() &&
      row.conversation.lastMessageAt.getTime() > restartAt.getTime();
    await prisma.conversationMemory.updateMany({
      where: { id: row.id, userId, extractorVersion: { lt: EXTRACTOR_VERSION } },
      data: worthReading
        ? { processedAt: restartAt!, extractorVersion: EXTRACTOR_VERSION }
        : { extractorVersion: EXTRACTOR_VERSION },
    });
    if (worthReading) queued++;
  }
  return queued;
}

// ---------------------------------------------------------------------------
// Re-judging — the timeline, judged again
// ---------------------------------------------------------------------------

/** Rows dated from their source message per pass — each is a write, and a sync event. */
const RECONCILE_DATE_BATCH = 200;

/**
 * Judge what Juno believes against the whole timeline, and fix what the
 * order of reading got wrong. The rules are planTimelineReconciliation's
 * (memory-lifecycle.ts); this is the database half.
 *
 * First it recovers WHEN undated rows were said. Rows written before
 * `observedAt` existed carry none, but most carry a sourceMessageId, and that
 * message's time is the answer. Recovered a bounded batch at a time — each
 * write is also a native-sync event, and a year of rows rewritten at once
 * would send every device to re-download all of memory.
 *
 * Every change is conditional on the row still being in the state it was
 * judged in, so a chat writing at the same moment can never be overwritten
 * by a judgement made about the row as it was a moment ago.
 */
export async function reconcileMemoryTimeline(
  userId: string,
  now: Date = new Date()
): Promise<{ changed: number; dated: number }> {
  const rows = await prisma.memoryEntry.findMany({ where: { userId, kind: "FACT" }, select: LIFECYCLE_SELECT });

  let dated = 0;
  const undated = rows.filter((row) => !row.observedAt && row.sourceMessageId).slice(0, RECONCILE_DATE_BATCH);
  if (undated.length > 0) {
    const messages = await prisma.message.findMany({
      where: { id: { in: undated.map((row) => row.sourceMessageId!) }, conversation: { userId } },
      select: { id: true, createdAt: true },
    });
    const saidAt = new Map(messages.map((message) => [message.id, message.createdAt]));
    for (const row of undated) {
      const at = saidAt.get(row.sourceMessageId!);
      if (!at) continue;
      const { count } = await prisma.memoryEntry.updateMany({
        where: { id: row.id, userId, observedAt: null },
        data: { observedAt: at },
      });
      if (count > 0) {
        row.observedAt = at;
        dated++;
      }
    }
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  let changed = 0;
  for (const change of planTimelineReconciliation(rows, { now })) {
    const row = byId.get(change.id);
    if (!row) continue;
    const { count } = await prisma.memoryEntry.updateMany({
      where: { id: change.id, userId, status: row.status },
      data: {
        status: change.status,
        reason: change.reason,
        ...(change.supersededById !== undefined ? { supersededById: change.supersededById } : {}),
        ...(change.expiresAt ? { expiresAt: change.expiresAt } : {}),
      },
    });
    changed += count;
  }
  return { changed, dated };
}

// ---------------------------------------------------------------------------
// Backfill (resumable background job)
// ---------------------------------------------------------------------------

/** Conversations whose messages aren't fully distilled into memory yet. */
export async function pendingBackfill(userId: string): Promise<string[]> {
  const convos = await prisma.conversation.findMany({
    where: { userId },
    orderBy: { lastMessageAt: "desc" },
    select: { id: true, lastMessageAt: true, memory: { select: { processedAt: true } } },
  });
  return convos.filter((c) => !c.memory || c.lastMessageAt > c.memory.processedAt).map((c) => c.id);
}

/**
 * Process a bounded batch of not-yet-distilled conversations (newest first).
 * Call repeatedly until `remaining` is 0 — progress survives between calls.
 */
export async function backfillMemories(opts: {
  userId: string;
  maxConversations?: number;
  llm?: UtilityLlm;
  /** Batch API mode: a queued prompt returns nothing by design, so keep going (see the loop). */
  continueOnUnavailable?: boolean;
}): Promise<{ processedConversations: number; created: number; remaining: number }> {
  const batch = (await pendingBackfill(opts.userId)).slice(0, opts.maxConversations ?? 2);
  let created = 0;
  // Only conversations actually read count. The page's "Learn from past chats"
  // loop stops when a batch processes nothing, which is its only signal that no
  // model is answering; reporting the batch size instead kept it POSTing up to
  // its 40-batch cap against a dead provider.
  let processed = 0;
  for (const conversationId of batch) {
    const res = await extractConversationMemory({
      userId: opts.userId,
      conversationId,
      maxChunks: 2,
      llm: opts.llm,
    });
    created += res.created;
    if (res.chunksProcessed === 0 && !res.done) {
      // The Batch API layer returns nothing for every prompt it QUEUES, and
      // should queue one chunk from each pending conversation, not stop at
      // the first. Everyone else: nothing back means no model is answering.
      if (opts.continueOnUnavailable) continue;
      break; // model unavailable — stop the batch
    }
    processed++;
  }
  const remaining = (await pendingBackfill(opts.userId)).length;
  return { processedConversations: processed, created, remaining };
}

// ---------------------------------------------------------------------------
// Context injection (what the chat sees)
// ---------------------------------------------------------------------------

export interface MemorySummary {
  content: string;
  updatedAt: Date;
  entryCount: number;
}

export async function getMemorySummary(userId: string): Promise<MemorySummary | null> {
  const row = await prisma.memorySummary.findUnique({
    where: { userId },
    select: { content: true, updatedAt: true, entryCount: true },
  });
  // Encrypted at rest since field-crypto.ts — the distilled profile is a
  // denser statement of who the user is than any single message. Rows written
  // before the backfill carry no prefix and pass straight through.
  return row ? { ...row, content: decryptField(row.content) } : null;
}

export interface MemoryProfile {
  summary: string | null;
  /**
   * Whose summary `summary` is: the account's, or — for a chat reading in
   * project isolation — that project's own. The prompt names it accordingly.
   */
  summaryScope: "account" | "project";
  /** The selected facts, as the system prompt wants them. */
  recent: string[];
  /**
   * The same facts with their identity intact, so the turn can show a receipt
   * naming what it remembered instead of only how many.
   */
  used: RetrievalResult["selected"];
  usedTokens: number;
  /** Ranked high enough but cut by the token budget — the receipt says so. */
  droppedForBudget: number;
}

/**
 * The chat turn cannot wait long on an embeddings endpoint that is having a
 * bad minute: past this, selection proceeds lexically and the reply starts.
 * Deliberately tighter than the write-side ceiling — a slow write embed costs
 * nothing visible, a slow read embed delays the first token.
 */
const QUERY_EMBED_TIMEOUT_MS = 4_000;

/**
 * Embed the user's message into the space the stored facts live in, or explain
 * (by returning null) why selection will be lexical this turn. Fail-closed at
 * every step, exactly like RAG's degraded honesty: no vectors stored, policy
 * denial, provider failure and timeout all land in the same place — a working
 * lexical selection rather than a dead turn.
 */
async function semanticEvidenceFor(opts: {
  userId: string;
  query: string;
  candidates: readonly { id: string; embeddingModel: string | null }[];
  conversationProvider?: string | null;
  embed?: typeof embedQuery;
}): Promise<SemanticEvidence | null> {
  if (!opts.embed && configuredEmbeddingModels().length === 0) return null;

  // Pin the query to the space most stored facts already occupy. No stored
  // vector at all means there is nothing to compare against — skip the
  // provider call rather than paying for a vector with no counterpart.
  const spaces = new Map<string, number>();
  for (const row of opts.candidates) {
    if (row.embeddingModel) spaces.set(row.embeddingModel, (spaces.get(row.embeddingModel) ?? 0) + 1);
  }
  const preferModelId = [...spaces.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0];
  if (!preferModelId) return null;

  try {
    const [policy, conversationProvider] = await Promise.all([
      loadBackgroundProviderPolicy(opts.userId),
      opts.conversationProvider !== undefined
        ? Promise.resolve(opts.conversationProvider)
        : accountBackgroundProvider(opts.userId),
    ]);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), QUERY_EMBED_TIMEOUT_MS);
    let embedded: Awaited<ReturnType<typeof embedQuery>>;
    try {
      embedded = await (opts.embed ?? embedQuery)({
        text: opts.query,
        policy,
        conversationProvider,
        preferModelId,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!embedded.ok) return null;

    // The vectors ride a second, filtered query rather than the candidate load:
    // they are thousands of floats per row, and only rows in the answering
    // model's space can be compared at all.
    const withVectors = await prisma.memoryEntry.findMany({
      where: {
        userId: opts.userId,
        id: { in: opts.candidates.map((c) => c.id) },
        embeddingModel: embedded.model.id,
      },
      select: { id: true, embedding: true },
    });
    if (withVectors.length === 0) return null;
    return {
      queryVector: embedded.vector,
      vectors: new Map(withVectors.map((row) => [row.id, row.embedding])),
    };
  } catch (error) {
    console.error("[memory] query embedding failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * What to inject into the model context, and a receipt for it.
 *
 * TWO SHAPES, by scope. An ordinary chat gets the account's summary — its
 * settled, account-wide memory — plus the individual facts it cannot yet
 * represent. A chat filed in a project reads in isolation (the default
 * whenever a projectId is given): only that project's facts, and that
 * project's OWN summary (ProjectMemorySummary), never the account's. Either
 * way a fact rides as a note of its own exactly when its summary does not
 * already say it — see `coveredBySummary`.
 *
 * Selection is ranked against the current message — semantically when vectors
 * exist for both sides, lexically otherwise — and bounded by a token budget,
 * so memory competes for context on relevance rather than by being recent
 * enough to make a `take: 15`.
 */
export async function getMemoryProfile(
  userId: string,
  opts: {
    projectId?: string | null;
    query?: string;
    budgetTokens?: number;
    /** Provider of this turn's model, for `same_provider` policies. */
    conversationProvider?: string | null;
    /** When true, strictly restricts retrieval to this project's memories, excluding personal global memory. */
    isolateProjectMemory?: boolean;
    /** Test seam: the query-embedding call. */
    embed?: typeof embedQuery;
  } = {}
): Promise<MemoryProfile> {
  const projectId = opts.projectId ?? null;
  const isolate = opts.isolateProjectMemory ?? (projectId !== null);
  const now = new Date();
  // The scope the injected summary speaks for: this project's when the chat
  // reads in isolation, the account's otherwise. Never the account's inside a
  // project — that is the isolation.
  const summaryScope = isolate && projectId ? projectId : null;
  const [storedSummary, forgottenAt, changes] = await Promise.all([
    summaryScope ? getProjectMemorySummary(userId, summaryScope) : getMemorySummary(userId),
    newestSuppressionAt(userId),
    readMemorySummaryChanges({ userId, projectId: summaryScope, now }, (args) => prisma.memoryEntry.findFirst(args)),
  ]);
  // A summary written before the newest "forget" still says the forgotten
  // thing, in prose, and would be injected whole — so it sits this turn out and
  // the ranked facts, which already exclude everything retired, stand in. The
  // next consolidation rewrites it without the forgotten content and it comes
  // back. See `summaryPredatesForget` for how this used to leak. A forget is
  // account-wide, so it benches a project's summary exactly as it does the
  // account's.
  // Corrections can reinstate an existing row without changing the count.
  // Expiry may happen before the background sweep. Neither obsolete belief
  // may remain in prose while the active facts say something different.
  const summary =
    storedSummary &&
    !summaryPredatesForget(storedSummary.updatedAt, forgottenAt) &&
    !summaryPredatesMemoryChange(storedSummary.updatedAt, changes) ? storedSummary : null;

  const scopeCondition = isolate && projectId
    ? { projectId }
    : { OR: projectId ? [{ projectId: null }, { projectId }] : [{ projectId: null }] };

  const rows = await prisma.memoryEntry.findMany({
    where: {
      userId,
      kind: "FACT",
      status: "active",
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        // Scope is enforced in the query as well as in the ranking: a fact
        // belonging to another project must never even be loaded into this
        // request, let alone ranked and dropped.
        scopeCondition,
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 400,
    select: LIFECYCLE_SELECT,
  });

  // Facts already represented in the summary would otherwise be said twice.
  // Only facts of the summary's own scope can be in it — a project fact is
  // never in the account's summary — so everything else always stays.
  const candidates = rows.filter((row) => !coveredBySummary(row, summary, summaryScope));

  const query = opts.query?.trim();
  const semantic =
    query && candidates.length > 0
      ? await semanticEvidenceFor({
          userId,
          query,
          candidates,
          conversationProvider: opts.conversationProvider,
          embed: opts.embed,
        })
      : null;

  const result = selectMemoriesForContext(candidates, {
    query: opts.query,
    projectId,
    isolateProjectMemory: isolate,
    now,
    budgetTokens: opts.budgetTokens ?? DEFAULT_MEMORY_TOKEN_BUDGET,
    ...(semantic ? { semantic } : {}),
  });

  // "Used" has to mean used. Without this the memory page can show what Juno
  // knows but not what it actually leans on, and nothing can ever age out on
  // the basis of never being read.
  if (result.selected.length > 0) {
    await prisma.memoryEntry
      .updateMany({ where: { userId, id: { in: result.selected.map((m) => m.id) } }, data: { lastUsedAt: now } })
      .catch((error) => {
        // A failed bookkeeping write must never cost the user their reply.
        console.error("[memory] could not stamp lastUsedAt:", error instanceof Error ? error.message : error);
      });
  }

  return {
    summary: summary?.content ?? null,
    summaryScope: summaryScope ? "project" : "account",
    recent: result.selected.map((m) => m.content),
    used: result.selected,
    usedTokens: result.usedTokens,
    droppedForBudget: result.droppedForBudget,
  };
}

/**
 * The narrow slice of memory a Juno Code run is shown — see
 * src/lib/code-memory-prompt.ts for why it is narrow.
 *
 * Lexical ranking only, deliberately: `getMemoryProfile` may embed the query,
 * and here the query is the task text, which would be one more copy of the
 * user's code request sent to an embeddings provider at the moment they
 * pressed Run. The candidates are a few dozen short preferences; token overlap
 * and recency rank them well enough, and the task text stays where it is.
 *
 * Empty when memory is paused. `lastUsedAt` is stamped on what was shown, for
 * the same reason chat stamps it: "used" on the memory page has to mean used.
 */
export async function getCodingMemory(userId: string, query: string): Promise<string[]> {
  try {
    const [settings, rows] = await Promise.all([
      prisma.settings.findUnique({ where: { userId }, select: { memoryEnabled: true } }),
      prisma.memoryEntry.findMany({
        where: {
          userId,
          kind: "FACT",
          status: "active",
          projectId: null,
          category: { in: [...CODING_MEMORY_CATEGORIES] },
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: LIFECYCLE_SELECT,
      }),
    ]);
    if (settings?.memoryEnabled === false) return [];
    const selected = selectCodingMemories(rows, { query });
    if (selected.length > 0) {
      await prisma.memoryEntry
        .updateMany({ where: { userId, id: { in: selected.map((m) => m.id) } }, data: { lastUsedAt: new Date() } })
        .catch(() => {});
    }
    return selected.map((m) => m.content);
  } catch (error) {
    // A Code run without its background is a Code run; one that fails to
    // start because memory could not be read is a bug.
    console.error("[memory] coding memory unavailable:", error instanceof Error ? error.message : error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Consolidation — extracted facts + digests only, never raw chats
// ---------------------------------------------------------------------------

const FACT_CHAR_BUDGET = 45_000;

interface MemorySources {
  facts: { content: string; createdAt: Date }[];
  suppressions: string[];
  digests: string[];
  projectLines: string[];
  githubLines: string[];
}

/** Best-effort: active GitHub repos via the user's connector token. Never throws. */
async function gatherGithubContext(userId: string): Promise<string[]> {
  try {
    const row = await prisma.connection.findUnique({
      where: { userId_provider: { userId, provider: "github" } },
      select: { accessToken: true },
    });
    if (!row) return [];
    const { decryptSecret } = await import("@/lib/crypto");
    const token = decryptSecret(row.accessToken);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("https://api.github.com/user/repos?sort=pushed&per_page=15", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "Juno" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const repos = (await res.json()) as { name?: string; description?: string | null; language?: string | null; fork?: boolean }[];
    if (!Array.isArray(repos)) return [];
    return repos
      .filter((r) => r?.name && !r.fork)
      .slice(0, 12)
      .map((r) => `${r.name}${r.language ? ` (${r.language})` : ""}${r.description ? ` — ${String(r.description).slice(0, 120)}` : ""}`);
  } catch {
    return [];
  }
}

export async function gatherMemorySources(userId: string): Promise<MemorySources> {
  const [entries, digestRows, projectRows, githubLines] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { content: true, createdAt: true, kind: true, status: true, projectId: true, expiresAt: true },
    }),
    // Digests of chats OUTSIDE projects only. A project chat's digest is part
    // of that project's memory and goes into that project's summary; here it
    // put "reworking the thesis methodology" into the "top of mind" of every
    // unrelated chat — the one path project memory still had out of its
    // project after its facts were scoped.
    prisma.conversationMemory.findMany({
      where: { userId, digest: { not: null }, conversation: { projectId: null } },
      orderBy: { updatedAt: "desc" },
      take: 40,
      select: { digest: true },
    }),
    prisma.project.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      select: { name: true, instructions: true },
    }),
    gatherGithubContext(userId),
  ]);

  // Newest facts always make the budget; drop the OLDEST when over.
  //
  // Only ACTIVE, ACCOUNT-WIDE, unexpired facts are summarized. The summary is
  // injected into every conversation, so a project-scoped fact reaching it
  // would defeat project scope entirely — the fact would be invisible as a row
  // and quoted verbatim in the prose. Superseded and contradicted rows are
  // excluded for the same reason in time rather than space: they are what Juno
  // used to believe.
  const now = new Date();
  const factRows = entries.filter(
    (e) =>
      e.kind === "FACT" &&
      e.status === "active" &&
      e.projectId === null &&
      (e.expiresAt === null || e.expiresAt > now)
  );
  const facts: MemorySources["facts"] = [];
  let used = 0;
  for (let i = factRows.length - 1; i >= 0; i--) {
    const f = factRows[i];
    if (used + f.content.length > FACT_CHAR_BUDGET) break;
    facts.unshift({ content: f.content, createdAt: f.createdAt });
    used += f.content.length;
  }

  return {
    facts,
    suppressions: entries.filter((e) => e.kind === "SUPPRESSION").map((e) => e.content),
    digests: digestRows.map((d) => d.digest!).filter(Boolean),
    projectLines: projectRows.map(
      (p) => `${p.name}${p.instructions ? ` — instructions: ${p.instructions.replace(/\s+/g, " ").slice(0, 300)}` : ""}`
    ),
    githubLines,
  };
}

/**
 * What a consolidation attempt did. It is a union rather than `string | null`
 * because the three ways of getting nothing are not the same thing to a user:
 * there was nothing to summarize, the policy refused to let it run, or the
 * models failed. Collapsing them is how "Regenerate summary" ended up telling
 * people to wait out a rate limit that did not exist.
 */
export type ConsolidationOutcome =
  | { status: "updated"; content: string }
  /** No facts, digests or projects — any stale summary was removed. */
  | { status: "empty" }
  | { status: "denied"; reason?: BackgroundDenialReason; mode: BackgroundProviderMode }
  /** Every permitted model failed; the previous summary is left intact. */
  | { status: "failed"; transient: boolean };

/**
 * Regenerate the consolidated summary from the extracted memory (facts, chat
 * digests, projects, GitHub) with the suppression layer applied.
 */
export async function consolidateMemories(opts: {
  userId: string;
  policy?: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  onDecision?: (record: BackgroundProcessingRecord) => void;
  llm?: UtilityLlm;
}): Promise<ConsolidationOutcome> {
  const sources = await gatherMemorySources(opts.userId);
  if (sources.facts.length === 0 && sources.digests.length === 0 && sources.projectLines.length === 0) {
    await prisma.memorySummary.deleteMany({ where: { userId: opts.userId } });
    return { status: "empty" };
  }

  const system = `You maintain a tidy long-term memory profile of a user, used to personalize future conversations. Distill the extracted memory below into a clean, deduplicated, well-organized summary in Markdown.

HARD RULE — SUPPRESSED CONTENT: the user explicitly asked to forget the statements listed under "SUPPRESSED". They must NOT appear in the summary in any form, direct or paraphrased. This outranks every other source.

Sources:
1. FACTS — durable facts extracted from the user's chats over time (oldest to newest, with dates; most recent wins on contradictions).
2. CHAT DIGESTS — one-line topics of their conversations (for themes, not facts).
3. PROJECTS — their workspaces and instructions.
4. GITHUB — their active repositories, when connected.

Rules:
- Group content under "## " section headings, and INCLUDE A SECTION ONLY IF IT HAS CONTENT. Prefer these, in this order: Work context, Personal context, Preferences, Projects & goals, Top of mind.
- Write in the third person as concise prose (a short paragraph per section) — synthesize, don't list.
- Keep only durable, non-sensitive information. Never include secrets, passwords, or API keys.
- Output ONLY the Markdown summary — no preamble, no closing remarks.`;

  const day = (d: Date) => d.toISOString().slice(0, 10);
  const block = (title: string, lines: string[]) =>
    lines.length ? `${title}:\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
  const userMsg = [
    block("SUPPRESSED (never include any of this)", sources.suppressions),
    block("FACTS (oldest to newest)", sources.facts.map((f) => `[${day(f.createdAt)}] ${f.content}`)),
    block("CHAT DIGESTS", sources.digests),
    block("PROJECTS", sources.projectLines),
    block("GITHUB REPOSITORIES (most recently active)", sources.githubLines),
    "Write the consolidated Markdown memory summary.",
  ]
    .filter(Boolean)
    .join("\n\n");

  // ONE path, and it is the policy-checked one.
  //
  // This used to branch: `opts.llm || !opts.model` went through
  // runUtilityPrompt (policy-checked), and everything else streamed the
  // caller's model directly with no resolveBackgroundCandidates call at all.
  // maybeConsolidate() always passed a model, so the production path — the one
  // that runs after almost every chat turn — was the unchecked one, and the
  // user's distilled memory went to whatever provider the chat route happened
  // to pick for its cheap background model, policy or no policy.
  //
  // The `model` parameter is gone rather than merely policy-filtered. It was
  // `utilityModelCandidates()[0]` — the globally fastest free model across every
  // configured provider — which is precisely what the walk below picks anyway
  // once the policy has had its say. Keeping it would also have left a quieter
  // version of the same hole: matching `same_provider` against the background
  // model's OWN provider lets the background model approve itself.
  //
  // Consolidation has no single conversation behind it — it distils facts
  // already extracted from many — so `same_provider` matches the provider
  // driving this turn when the caller names one, and otherwise the account's
  // own default chat model rather than nothing at all.
  const conversationProvider =
    opts.conversationProvider ?? (await accountBackgroundProvider(opts.userId));

  const { result, transient, deniedByPolicy, deniedReason, mode } = await runUtilityPrompt({
    system,
    userMsg,
    maxTokens: 1400,
    label: "memory/consolidate",
    parse: (text) => (text.trim() ? text.trim() : null),
    userId: opts.userId,
    policy: opts.policy ?? (await loadBackgroundProviderPolicy(opts.userId)),
    conversationProvider,
    purpose: "memory_consolidation",
    onDecision: opts.onDecision,
    llm: opts.llm,
  });

  if (deniedByPolicy) {
    return { status: "denied", reason: deniedReason, mode: mode ?? DEFAULT_BACKGROUND_PROVIDER_MODE };
  }
  // The old summary is deliberately left alone on failure: a stale profile is
  // better than none, and the next run replaces it.
  if (!result) return { status: "failed", transient };

  const content = result;
  // Account-wide facts only: the count is what `maybeConsolidate` compares to
  // decide the summary is stale, and a fact learned in a project changes that
  // project's summary, never this one.
  const factCount = await prisma.memoryEntry.count({
    where: { userId: opts.userId, kind: "FACT", projectId: null },
  });
  const sealed = encryptField(content);
  await prisma.memorySummary.upsert({
    where: { userId: opts.userId },
    create: { userId: opts.userId, content: sealed, entryCount: factCount },
    update: { content: sealed, entryCount: factCount },
  });
  // The outcome reports the CLEARTEXT: callers render it or feed it to a
  // prompt, and none of them hold a key.
  return { status: "updated", content };
}

/** Anything at all to distill — facts, chat history, or projects. */
export async function hasMemorySources(userId: string): Promise<boolean> {
  const [notes, messages, projects] = await Promise.all([
    prisma.memoryEntry.count({ where: { userId } }),
    prisma.message.count({ where: { conversation: { userId }, role: "USER" } }),
    prisma.project.count({ where: { userId } }),
  ]);
  return notes > 0 || messages > 0 || projects > 0;
}

/**
 * Consolidate with provider fallback (runUtilityPrompt's walk), reporting which
 * of "nothing to do", "policy refused" and "the models failed" happened —
 * see ConsolidationOutcome. `maxCandidates` is kept for API compatibility: the
 * walk already bounds itself, but callers that must stay snappy still pass it.
 */
export async function consolidateWithFallback(
  userId: string,
  _maxCandidates = Infinity
): Promise<ConsolidationOutcome> {
  if (!(await hasMemorySources(userId))) {
    await prisma.memorySummary.deleteMany({ where: { userId } });
    return { status: "empty" };
  }
  return consolidateMemories({ userId });
}

/**
 * Background consolidation: regenerate the summary whenever what it was built
 * from actually changed, so it refreshes as soon as new chats add memories —
 * throttled to at most once every few minutes so a burst of messages doesn't
 * rebuild it each time. Cheap no-op otherwise — safe to call after every
 * exchange. The rule itself, shared with every project's summary, is
 * `summaryRebuildDecision`.
 *
 * Account-wide facts only. A fact learned inside a project is that project's
 * business (maybeConsolidateProject); counting it here rebuilt the account
 * summary — an LLM call — for a change it would never contain.
 */
export async function maybeConsolidate(
  userId: string,
  conversationProvider: string | null,
  /** The dreamer's Batch API layer; absent everywhere else. */
  llm?: UtilityLlm
): Promise<void> {
  const now = new Date();
  const [count, summary, forgottenAt, changes] = await Promise.all([
    prisma.memoryEntry.count({ where: { userId, kind: "FACT", projectId: null } }),
    prisma.memorySummary.findUnique({ where: { userId }, select: { entryCount: true, updatedAt: true } }),
    newestSuppressionAt(userId),
    readMemorySummaryChanges({ userId, projectId: null, now }, (args) => prisma.memoryEntry.findFirst(args)),
  ]);
  const decision = summaryRebuildDecision({
    summary,
    factCount: count,
    newestSuppressionAt: forgottenAt,
    ...changes,
    now,
  });
  if (decision !== "rebuild") return;
  // Settle the timeline first, so the summary about to be written from these
  // facts is written from the right ones.
  await reconcileMemoryTimeline(userId, now).catch(() => {});
  // The CONVERSATION's provider, not the background model's — see
  // consolidateMemories. Passing the model that is about to do the work would
  // make `same_provider` a tautology.
  await consolidateMemories({ userId, conversationProvider, llm }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Project summaries — the same distillation, one project at a time
// ---------------------------------------------------------------------------

/** One person's summary of one project, decrypted. */
export async function getProjectMemorySummary(userId: string, projectId: string): Promise<MemorySummary | null> {
  const row = await prisma.projectMemorySummary.findUnique({
    where: { userId_projectId: { userId, projectId } },
    select: { content: true, updatedAt: true, entryCount: true },
  });
  return row ? { ...row, content: decryptField(row.content) } : null;
}

export interface ProjectMemorySummaryView extends MemorySummary {
  projectId: string;
  projectName: string;
}

/** Every project summary this person has, most recently rebuilt first. */
export async function listProjectMemorySummaries(userId: string): Promise<ProjectMemorySummaryView[]> {
  const rows = await prisma.projectMemorySummary.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: {
      projectId: true,
      content: true,
      updatedAt: true,
      entryCount: true,
      project: { select: { name: true } },
    },
  });
  return rows.map((row) => ({
    projectId: row.projectId,
    projectName: row.project.name,
    content: decryptField(row.content),
    updatedAt: row.updatedAt,
    entryCount: row.entryCount,
  }));
}

/**
 * Regenerate one project's summary from what was learned in it.
 *
 * The account summary's machinery, narrowed to a project: its facts, its
 * chats' digests, its name — and every suppression, because a forget is
 * account-wide. Same policy-checked provider walk, same encryption at rest,
 * same outcome union, so a caller can tell "nothing to summarise" from "the
 * policy refused" from "the models failed". See src/lib/memory-project-summary.ts
 * for what the model is shown and why.
 *
 * Access is re-checked here rather than trusted: someone removed from a shared
 * project keeps their facts from it (they are theirs), but a summary is
 * something a chat reads, and they can no longer chat there — so there is
 * nothing to build, and whatever was built before is removed.
 */
export async function consolidateProjectMemory(opts: {
  userId: string;
  projectId: string;
  policy?: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  onDecision?: (record: BackgroundProcessingRecord) => void;
  llm?: UtilityLlm;
}): Promise<ConsolidationOutcome> {
  const { userId, projectId } = opts;
  const removeSummary = () => prisma.projectMemorySummary.deleteMany({ where: { userId, projectId } });

  const { allowed } = await checkProjectAccess(userId, projectId, "VIEWER");
  if (!allowed) {
    await removeSummary();
    return { status: "empty" };
  }

  const now = new Date();
  const [project, factRows, suppressions, digestRows] = await Promise.all([
    // Unguarded, one line after `checkProjectAccess` allowed this reader: a
    // member reads a project they do not own, and the guard would refuse the
    // owner-scoped query they cannot make. The same choice listProjectMembers
    // documents.
    prismaUnguarded.project.findUnique({ where: { id: projectId }, select: { name: true, instructions: true } }),
    prisma.memoryEntry.findMany({
      where: {
        userId,
        projectId,
        kind: "FACT",
        status: "active",
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: "asc" },
      select: { content: true, createdAt: true },
    }),
    getSuppressions(userId),
    prisma.conversationMemory.findMany({
      where: { userId, digest: { not: null }, conversation: { projectId } },
      orderBy: { updatedAt: "desc" },
      take: 40,
      select: { digest: true },
    }),
  ]);
  if (!project) {
    await removeSummary();
    return { status: "empty" };
  }

  const sources = {
    projectName: project.name,
    instructions: project.instructions,
    facts: budgetProjectFacts(factRows),
    digests: digestRows.map((row) => row.digest!).filter(Boolean),
    suppressions,
  };
  if (projectSummaryIsEmpty(sources)) {
    await removeSummary();
    return { status: "empty" };
  }

  const { system, userMsg } = projectConsolidationPrompt(sources);
  const conversationProvider = opts.conversationProvider ?? (await accountBackgroundProvider(userId));
  const { result, transient, deniedByPolicy, deniedReason, mode } = await runUtilityPrompt({
    system,
    userMsg,
    maxTokens: 1000,
    label: "memory/consolidate-project",
    parse: (text) => (text.trim() ? text.trim() : null),
    userId,
    policy: opts.policy ?? (await loadBackgroundProviderPolicy(userId)),
    conversationProvider,
    purpose: "memory_consolidation",
    onDecision: opts.onDecision,
    llm: opts.llm,
  });

  if (deniedByPolicy) {
    return { status: "denied", reason: deniedReason, mode: mode ?? DEFAULT_BACKGROUND_PROVIDER_MODE };
  }
  // As for the account: a failure leaves the previous summary in place.
  if (!result) return { status: "failed", transient };

  const content = result;
  // Every FACT in the project, whatever its status — the change detector
  // `maybeConsolidateProject` compares against, exactly as for the account.
  const factCount = await prisma.memoryEntry.count({ where: { userId, projectId, kind: "FACT" } });
  const sealed = encryptField(content);
  await prisma.projectMemorySummary.upsert({
    where: { userId_projectId: { userId, projectId } },
    create: { userId, projectId, content: sealed, entryCount: factCount },
    update: { content: sealed, entryCount: factCount },
  });
  return { status: "updated", content };
}

/**
 * Rebuild one project's summary if — and only if — something it was built
 * from changed: the account rule (`summaryRebuildDecision`) over the
 * project's own facts. Safe to call after every turn in the project.
 */
export async function maybeConsolidateProject(
  userId: string,
  projectId: string,
  conversationProvider: string | null,
  /** The dreamer's Batch API layer; absent everywhere else. */
  llm?: UtilityLlm
): Promise<void> {
  const now = new Date();
  const [count, summary, forgottenAt, changes] = await Promise.all([
    prisma.memoryEntry.count({ where: { userId, projectId, kind: "FACT" } }),
    prisma.projectMemorySummary.findUnique({
      where: { userId_projectId: { userId, projectId } },
      select: { entryCount: true, updatedAt: true },
    }),
    newestSuppressionAt(userId),
    readMemorySummaryChanges({ userId, projectId, now }, (args) => prisma.memoryEntry.findFirst(args)),
  ]);
  const decision = summaryRebuildDecision({
    summary,
    factCount: count,
    newestSuppressionAt: forgottenAt,
    ...changes,
    now,
  });
  if (decision !== "rebuild") return;
  await reconcileMemoryTimeline(userId, now).catch(() => {});
  await consolidateProjectMemory({ userId, projectId, conversationProvider, llm }).catch(() => {});
}

/**
 * The projects whose summaries may be out of date, for the dreamer: every
 * project this person has facts in, newest activity first. The staleness test
 * itself is `maybeConsolidateProject`'s, run per project.
 */
export async function projectsWithMemory(userId: string, limit: number): Promise<string[]> {
  const rows = await prisma.memoryEntry.groupBy({
    by: ["projectId"],
    where: { userId, kind: "FACT", projectId: { not: null } },
    _max: { updatedAt: true },
    orderBy: { _max: { updatedAt: "desc" } },
    take: limit,
  });
  return rows.map((row) => row.projectId).filter((id): id is string => id !== null);
}

/**
 * Rebuild the summaries a change touched, after the response has gone.
 *
 * `null` is the account's own summary; any other value is a project's. A row
 * edited, forgotten, deleted or moved between scopes changes what the summary
 * of every scope it was ever in should say, and until rebuilt that summary
 * quotes the old version in prose — the account's to every chat, a project's
 * to every chat in that project.
 */
export async function refreshSummaries(userId: string, scopes: Iterable<string | null>): Promise<void> {
  for (const scope of new Set(scopes)) {
    if (scope === null) await consolidateWithFallback(userId).catch(() => {});
    else await consolidateProjectMemory({ userId, projectId: scope }).catch(() => {});
  }
}
