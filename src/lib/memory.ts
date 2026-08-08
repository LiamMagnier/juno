import { prisma } from "@/lib/prisma";
import { decryptMessageText } from "@/lib/message-crypto";
import { streamChat } from "@/lib/llm";
import { MODEL_LIST, getModel, type ModelInfo } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { getModelMetrics } from "@/lib/model-metrics";
import {
  DEFAULT_BACKGROUND_PROVIDER_MODE,
  normalizeBackgroundProviderPolicy,
  resolveBackgroundCandidates,
  type BackgroundProcessingRecord,
  type BackgroundProviderPolicy,
  type BackgroundPurpose,
} from "@/lib/background-provider-policy";
import {
  DEFAULT_MEMORY_TOKEN_BUDGET,
  planFactIngestion,
  selectMemoriesForContext,
  type LifecycleEntry,
  type RetrievalResult,
} from "@/lib/memory-lifecycle";

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
 */
export async function loadBackgroundProviderPolicy(
  userId: string
): Promise<BackgroundProviderPolicy> {
  try {
    const settings = await prisma.settings.findUnique({
      where: { userId },
      select: { backgroundProviderMode: true, backgroundProviderSelected: true },
    });
    return normalizeBackgroundProviderPolicy({
      mode: settings?.backgroundProviderMode as BackgroundProviderPolicy["mode"],
      selectedProvider: settings?.backgroundProviderSelected,
      allowedProviders: deploymentProviderAllowlist(),
    });
  } catch {
    return normalizeBackgroundProviderPolicy({
      allowedProviders: deploymentProviderAllowlist(),
    });
  }
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
}) => Promise<string | null>;

export async function runUtilityPrompt<T>(opts: {
  system: string;
  userMsg: string;
  maxTokens: number;
  label: string;
  parse: (text: string) => T | null;
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
}): Promise<{ result: T | null; transient: boolean; deniedByPolicy?: boolean }> {
  if (opts.llm) {
    const text = await opts.llm(opts);
    return { result: text === null ? null : opts.parse(text), transient: false };
  }

  const decision = resolveBackgroundCandidates({
    policy: opts.policy ?? { mode: DEFAULT_BACKGROUND_PROVIDER_MODE },
    conversationProvider: opts.conversationProvider,
    candidates: utilityModelCandidates(),
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
    return { result: null, transient: false, deniedByPolicy: true };
  }

  const started = Date.now();

  const attempt = async (model: ModelInfo): Promise<{ result: T | null; transient: boolean }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    let out = "";
    try {
      for await (const ev of streamChat({
        model,
        system: opts.system,
        history: [{ role: "USER", content: opts.userMsg, attachments: [] }],
        maxTokens: opts.maxTokens,
        signal: ctrl.signal,
      })) {
        if (ev.type === "text") out += ev.text;
      }
    } catch (e) {
      const msg = ctrl.signal.aborted ? `timed out after ${ATTEMPT_TIMEOUT_MS}ms` : e instanceof Error ? e.message : String(e);
      console.error(`[${opts.label}] ${model.id} failed:`, msg);
      // A timeout usually means an overloaded provider — worth one retry.
      return { result: null, transient: ctrl.signal.aborted || isTransientProviderError(msg) };
    } finally {
      clearTimeout(timer);
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
    if (Date.now() - started > TOTAL_DEADLINE_MS) return { result: null, transient: true };
    const { result, transient } = await attempt(model);
    if (result !== null) {
      record(model);
      return { result, transient: false };
    }
    if (transient) {
      retryable.push(model);
      sawTransient = true;
    }
  }
  if (retryable.length > 0 && Date.now() - started < TOTAL_DEADLINE_MS) {
    await new Promise((r) => setTimeout(r, 2500));
    for (const model of retryable) {
      if (Date.now() - started > TOTAL_DEADLINE_MS) return { result: null, transient: true };
      const { result } = await attempt(model);
      if (result !== null) {
        record(model);
        return { result, transient: false };
      }
    }
  }
  return { result: null, transient: sawTransient };
}

// ---------------------------------------------------------------------------
// Candidates + suppression layer
// ---------------------------------------------------------------------------

export async function getSuppressions(userId: string): Promise<string[]> {
  const rows = await prisma.memoryEntry.findMany({
    where: { userId, kind: "SUPPRESSION" },
    select: { content: true },
  });
  return rows.map((r) => r.content);
}

/** The columns the lifecycle rules need to judge an existing entry. */
const LIFECYCLE_SELECT = {
  id: true,
  content: true,
  normalized: true,
  category: true,
  projectId: true,
  source: true,
  kind: true,
  confidence: true,
  status: true,
  expiresAt: true,
  createdAt: true,
} as const;

export interface SaveCandidatesResult {
  /** New rows written. */
  created: number;
  /** Already-known facts whose lastVerifiedAt was refreshed instead. */
  refreshed: number;
  /** Older beliefs this batch replaced — annotated, never deleted. */
  superseded: number;
  /** Stored but not believed: suppressed, or beaten by an explicit fact. */
  rejected: number;
}

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
  opts: { projectId?: string | null; sourceMessageId?: string | null; source?: "AUTO" | "MANUAL" } = {}
): Promise<SaveCandidatesResult> {
  const result: SaveCandidatesResult = { created: 0, refreshed: 0, superseded: 0, rejected: 0 };
  if (facts.length === 0) return result;

  const rows = await prisma.memoryEntry.findMany({ where: { userId }, select: LIFECYCLE_SELECT });
  const entries: LifecycleEntry[] = rows.filter((r) => r.kind === "FACT");
  const suppressions = rows.filter((r) => r.kind === "SUPPRESSION").map((r) => r.content);
  const now = new Date();
  const source = opts.source ?? "AUTO";
  const projectId = opts.projectId ?? null;

  for (const fact of facts) {
    const plan = planFactIngestion({ content: fact, source, projectId }, { entries, suppressions, now });

    if (plan.action === "skip") {
      if (plan.reason === "suppressed") result.rejected++;
      continue;
    }

    if (plan.action === "refresh") {
      await prisma.memoryEntry.updateMany({
        where: { id: plan.entryId, userId },
        data: {
          lastVerifiedAt: now,
          ...(plan.revive ? { status: "active", reason: "You mentioned this again, so Juno picked it back up." } : {}),
          ...(plan.expiresAt !== undefined ? { expiresAt: plan.expiresAt } : {}),
        },
      });
      const known = entries.find((e) => e.id === plan.entryId);
      if (known && plan.revive) known.status = "active";
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
        normalized: plan.normalized,
        lastVerifiedAt: now,
      },
      select: LIFECYCLE_SELECT,
    });
    entries.push(created);
    if (plan.status === "active") result.created++;
    else result.rejected++;

    if (plan.supersedes) {
      await prisma.memoryEntry.updateMany({
        where: { id: plan.supersedes.entryId, userId, status: "active" },
        data: { status: "superseded", supersededById: created.id, reason: plan.supersedes.reason },
      });
      const older = entries.find((e) => e.id === plan.supersedes!.entryId);
      if (older) older.status = "superseded";
      result.superseded++;
    }
  }
  return result;
}

/**
 * Back-compat alias for the chat route's model-emitted memory tags: returns the
 * count of NEW facts, which is all the caller uses it for.
 */
export async function saveAutoMemories(
  userId: string,
  facts: string[],
  sourceRef?: string,
  opts: { projectId?: string | null; sourceMessageId?: string | null } = {}
): Promise<number> {
  return (await saveCandidates(userId, facts, sourceRef, opts)).created;
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

function parseExtraction(text: string): { facts: string[]; digest: string | null } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    const facts = Array.isArray(obj.facts)
      ? obj.facts.filter((f: unknown): f is string => typeof f === "string" && !!f.trim()).map((f: string) => f.trim().slice(0, 500)).slice(0, 12)
      : [];
    const digest = typeof obj.digest === "string" && obj.digest.trim() ? obj.digest.trim().slice(0, 300) : null;
    return { facts, digest };
  } catch {
    return null;
  }
}

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
      select: { content: true, createdAt: true },
    })
  ).map((m) => ({ ...m, content: decryptMessageText(m.content) }));

  // Chunk digests MERGE into the stored one (newest kept when over budget) —
  // a multi-chunk conversation must not end up described by its last chunk only.
  const mergeDigest = (prev: string | null | undefined, next: string | null): string | undefined => {
    const combined = [prev, next].filter(Boolean).join(" · ");
    if (!combined) return undefined;
    return combined.length > 300 ? `…${combined.slice(-299)}` : combined;
  };

  let storedDigest: string | null = convo.memory?.digest ?? null;
  const markProcessed = async (upTo: Date, digest: string | null, createdDelta: number) => {
    const merged = mergeDigest(storedDigest, digest);
    storedDigest = merged ?? null;
    await prisma.conversationMemory.upsert({
      where: { conversationId: convo.id },
      create: {
        userId: opts.userId,
        conversationId: convo.id,
        processedAt: upTo,
        digest: merged,
        factCount: createdDelta,
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
  const chunks: { content: string; createdAt: Date }[][] = [];
  let current: { content: string; createdAt: Date }[] = [];
  let chars = 0;
  for (const m of messages) {
    const text = m.content.replace(/\s+/g, " ").trim().slice(0, 1200);
    if (!text) continue;
    if (current.length >= CHUNK_MESSAGES || (chars + text.length > CHUNK_CHARS && current.length > 0)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push({ content: text, createdAt: m.createdAt });
    chars += text.length;
  }
  if (current.length) chunks.push(current);

  const [recentFacts, suppressions] = await Promise.all([
    prisma.memoryEntry.findMany({
      where: { userId: opts.userId, kind: "FACT" },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { content: true },
    }),
    getSuppressions(opts.userId),
  ]);

  const system = `You maintain a long-term memory of durable facts about a user. From the chat messages below (all written BY the user), extract NEW durable facts worth remembering — identity, role, location, preferences, tools and languages they use, ongoing projects, goals, recurring themes. Ignore one-off task details, questions that reveal nothing durable, and anything already known. Never extract secrets, passwords, or API keys.
${suppressions.length ? `The user asked to FORGET the following — never extract anything about them:\n${suppressions.map((s) => `- ${s}`).join("\n")}\n` : ""}Already known:
${recentFacts.length ? recentFacts.map((f) => `- ${f.content}`).join("\n") : "(nothing yet)"}

Return ONLY JSON: {"facts":["<short third-person fact>", ...],"digest":"<one line: what this chat is about>"} — facts may be empty.`;

  // Loaded once per invocation, not per chunk: the policy cannot change
  // half-way through an extraction, and re-reading it would be a query per
  // chunk for an answer that does not move.
  const policy = opts.policy ?? (await loadBackgroundProviderPolicy(opts.userId));
  const conversationProvider = getModel(convo.model)?.provider ?? null;

  let created = 0;
  let processed = 0;
  const toProcess = chunks.slice(0, maxChunks);
  for (const chunk of toProcess) {
    const userMsg = `Chat title: ${convo.title}\nUser messages (oldest to newest):\n${chunk
      .map((m) => `- ${m.content}`)
      .join("\n")}\n\nReturn the JSON.`;

    const { result } = await runUtilityPrompt({
      system,
      userMsg,
      maxTokens: 500,
      label: "memory/extract",
      parse: parseExtraction,
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
}): Promise<{ processedConversations: number; created: number; remaining: number }> {
  const batch = (await pendingBackfill(opts.userId)).slice(0, opts.maxConversations ?? 2);
  let created = 0;
  for (const conversationId of batch) {
    const res = await extractConversationMemory({
      userId: opts.userId,
      conversationId,
      maxChunks: 2,
      llm: opts.llm,
    });
    created += res.created;
    if (res.chunksProcessed === 0 && !res.done) break; // model unavailable — stop the batch
  }
  const remaining = (await pendingBackfill(opts.userId)).length;
  return { processedConversations: batch.length, created, remaining };
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
  return prisma.memorySummary.findUnique({
    where: { userId },
    select: { content: true, updatedAt: true, entryCount: true },
  });
}

export interface MemoryProfile {
  summary: string | null;
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
 * What to inject into the model context, and a receipt for it.
 *
 * The summary carries the account's settled, globally-scoped memory. On top of
 * it go individual entries the summary cannot represent: facts newer than the
 * last consolidation, and every fact scoped to the project this chat belongs
 * to — those are deliberately excluded from the summary (see
 * gatherMemorySources), because a summary is account-wide and project memory
 * must not be.
 *
 * Selection is ranked against the current message and bounded by a token
 * budget, so memory competes for context on relevance rather than by being
 * recent enough to make a `take: 15`.
 */
export async function getMemoryProfile(
  userId: string,
  opts: { projectId?: string | null; query?: string; budgetTokens?: number } = {}
): Promise<MemoryProfile> {
  const projectId = opts.projectId ?? null;
  const now = new Date();
  const summary = await getMemorySummary(userId);

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
        { OR: projectId ? [{ projectId: null }, { projectId }] : [{ projectId: null }] },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 400,
    select: LIFECYCLE_SELECT,
  });

  // Facts already represented in the summary would otherwise be said twice.
  // Project-scoped facts are never in it, so they always stay.
  const candidates = rows.filter(
    (row) => row.projectId !== null || !summary || row.createdAt > summary.updatedAt
  );

  const result = selectMemoriesForContext(candidates, {
    query: opts.query,
    projectId,
    now,
    budgetTokens: opts.budgetTokens ?? DEFAULT_MEMORY_TOKEN_BUDGET,
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
    recent: result.selected.map((m) => m.content),
    used: result.selected,
    usedTokens: result.usedTokens,
    droppedForBudget: result.droppedForBudget,
  };
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
    prisma.conversationMemory.findMany({
      where: { userId, digest: { not: null } },
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
 * Regenerate the consolidated summary from the extracted memory (facts, chat
 * digests, projects, GitHub) with the suppression layer applied. Returns the
 * new Markdown, or null if there's nothing to summarize / the model failed
 * (in which case the old summary is left intact).
 */
export async function consolidateMemories(opts: {
  userId: string;
  model?: ModelInfo;
  policy?: BackgroundProviderPolicy;
  conversationProvider?: string | null;
  onDecision?: (record: BackgroundProcessingRecord) => void;
  llm?: UtilityLlm;
}): Promise<string | null> {
  const sources = await gatherMemorySources(opts.userId);
  if (sources.facts.length === 0 && sources.digests.length === 0 && sources.projectLines.length === 0) {
    await prisma.memorySummary.deleteMany({ where: { userId: opts.userId } });
    return null;
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

  let content: string | null = null;
  if (opts.llm || !opts.model) {
    // Consolidation has no single conversation behind it — it distils facts
    // already extracted from many. `same_provider` therefore has nothing to
    // match against unless the caller names the provider whose model is
    // driving this turn, which the chat route does.
    const { result } = await runUtilityPrompt({
      system,
      userMsg,
      maxTokens: 1400,
      label: "memory/consolidate",
      parse: (text) => (text.trim() ? text.trim() : null),
      policy: opts.policy ?? (await loadBackgroundProviderPolicy(opts.userId)),
      conversationProvider: opts.conversationProvider ?? opts.model?.provider ?? null,
      purpose: "memory_consolidation",
      onDecision: opts.onDecision,
      llm: opts.llm,
    });
    content = result;
  } else {
    // Caller-chosen single model (background path from the chat route).
    let out = "";
    try {
      for await (const ev of streamChat({
        model: opts.model,
        system,
        history: [{ role: "USER", content: userMsg, attachments: [] }],
        maxTokens: 1400,
      })) {
        if (ev.type === "text") out += ev.text;
      }
    } catch (e) {
      console.error(`[memory/consolidate] ${opts.model.id} failed:`, e instanceof Error ? e.message : e);
      return null;
    }
    content = out.trim() || null;
  }
  if (!content) return null;

  const factCount = await prisma.memoryEntry.count({ where: { userId: opts.userId, kind: "FACT" } });
  await prisma.memorySummary.upsert({
    where: { userId: opts.userId },
    create: { userId: opts.userId, content, entryCount: factCount },
    update: { content, entryCount: factCount },
  });
  return content;
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
 * Consolidate with provider fallback (runUtilityPrompt's walk). Returns null
 * when there is nothing to summarize or every candidate failed (old summary
 * left intact in that case). `maxCandidates` is kept for API compatibility —
 * the walk already bounds itself; callers that must stay snappy still pass it.
 */
export async function consolidateWithFallback(userId: string, _maxCandidates = Infinity): Promise<string | null> {
  if (!(await hasMemorySources(userId))) {
    await prisma.memorySummary.deleteMany({ where: { userId } });
    return null;
  }
  return consolidateMemories({ userId });
}

/**
 * Background consolidation: regenerate the summary whenever the stored fact
 * count actually changed, so it refreshes as soon as new chats add memories —
 * throttled to at most once every few minutes so a burst of messages doesn't
 * rebuild it each time. Cheap no-op otherwise — safe to call after every
 * exchange. (Previously gated on a 12h staleness window, which left the summary
 * showing "updated Nd ago" long after new chats had added facts.)
 */
export async function maybeConsolidate(userId: string, model: ModelInfo): Promise<void> {
  const [count, summary] = await Promise.all([
    prisma.memoryEntry.count({ where: { userId, kind: "FACT" } }),
    prisma.memorySummary.findUnique({ where: { userId }, select: { entryCount: true, updatedAt: true } }),
  ]);
  const changed = !summary || summary.entryCount !== count;
  // Don't rebuild more than once every few minutes, so rapid-fire messages that
  // each distill a fact don't each trigger a full consolidation.
  const MIN_INTERVAL_MS = 5 * 60 * 1000;
  const recentlyBuilt = summary != null && Date.now() - summary.updatedAt.getTime() < MIN_INTERVAL_MS;
  if (!changed || recentlyBuilt) return;
  if (count > 0) {
    await consolidateMemories({ userId, model }).catch(() => {});
  }
}
