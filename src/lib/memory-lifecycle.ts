import { findSuppression } from "@/lib/memory-suppression";
import {
  DEFAULT_MEMORY_CATEGORY,
  MEMORY_CATEGORY_WEIGHT,
  TEMPORARY_MEMORY_TTL_DAYS,
  isMemoryCategory,
  memoryCategoryLabel,
  type MemoryCategory,
} from "@/lib/memory-categories";

/**
 * The rules that decide what Juno believes: how a fact is classified, when two
 * facts are the same fact, when a new fact overturns an old one, when a fact
 * stops being true, and which facts are worth spending context tokens on.
 *
 * All of it lives here rather than in `memory.ts` for one reason: `memory.ts`
 * reaches Prisma and the provider layer, so nothing in it can be tested. The
 * failure this prevents is the one that used to define the memory system — it
 * appended a row for every restated fact, so "the user prefers TypeScript" and
 * "prefers TypeScript" both sat in context forever, and moving city added a
 * second home rather than replacing the first.
 *
 * Every judgement here is deliberately CONSERVATIVE. Falsely merging or
 * superseding a real memory is much worse than keeping two rows that a human
 * would have merged: the first silently deletes something the user told us, the
 * second only costs a few tokens.
 *
 * Deliberately free of `server-only`, Prisma and SDK imports so it stays
 * unit-testable — same reason as background-provider-policy.ts.
 */

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Words that carry no identity of their own. Dropping them is what makes "The
 * user prefers dark mode" and "prefers dark mode" the same fact — the extractor
 * writes both phrasings depending on which model answered.
 */
const FILLER_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being", "am",
  "to", "of", "in", "on", "at", "for", "with", "that", "this", "these", "those",
  "it", "its", "their", "them", "they", "he", "she", "his", "her", "him",
  "and", "as", "by", "from", "has", "have", "had", "does", "do", "did",
  "user", "users", "currently", "also", "very", "quite", "really", "some",
]);

/**
 * Crude suffix trimming so "prefers"/"prefer" and "projects"/"project" collapse.
 * Not a real stemmer and does not try to be: it only has to be *consistent*,
 * because both sides of every comparison go through it. Words of three letters
 * or fewer are left alone — "has" must not become "ha".
 */
function stem(word: string): string {
  if (word.length <= 3) return word;
  for (const suffix of ["ing", "ed", "es", "s"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      const base = word.slice(0, word.length - suffix.length);
      // English doubles the final consonant before -ed/-ing. Without undoing
      // that, "preferred" stems to "preferr" and never meets "prefers", which
      // is exactly the pair the deduplication exists to catch.
      const doubled = (suffix === "ed" || suffix === "ing") && base.length > 3 && base.at(-1) === base.at(-2);
      return doubled ? base.slice(0, -1) : base;
    }
  }
  return word;
}

/**
 * The meaning-bearing words of a statement, in the order they were written.
 * Accents are folded (so "café" matches "cafe") and CJK is preserved as-is,
 * since it does not word-break on spaces and the ranking below only needs
 * stable tokens, not linguistically correct ones.
 */
export function significantTokens(content: string): string[] {
  return content
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9À-ɏ一-鿿]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0 && !FILLER_WORDS.has(word))
    .map(stem);
}

/**
 * The comparable form stored in `MemoryEntry.normalized`: significant words,
 * deduplicated, in sorted order.
 *
 * Sorting is the point — it is what makes "prefers dark mode" and "dark mode is
 * preferred" one fact instead of two. The tradeoff it accepts is that "Alice
 * reports to Bob" and "Bob reports to Alice" normalize identically. That is a
 * real collision, and it is the right trade: the consequence is that the second
 * statement refreshes a timestamp instead of adding a row, which loses far less
 * than the duplicate flood the alternative produced.
 */
export function normalizeFact(content: string): string {
  return [...new Set(significantTokens(content))].sort().join(" ");
}

/** Rows written before Memory v2 have no `normalized` — derive it on read. */
export function normalizedOf(entry: { content: string; normalized?: string | null }): string {
  return entry.normalized?.trim() || normalizeFact(entry.content);
}

/** Shared-token overlap, scaled against the shorter statement. */
function overlapRatio(a: string, b: string): number {
  const setA = new Set(significantTokens(a));
  const setB = new Set(significantTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * First match wins, so the order is the policy. Time-bounded phrasing is tested
 * first on purpose: "shipping the redesign this Friday" is a project sentence
 * by vocabulary and a temporary one by truth, and getting that backwards is how
 * a deadline becomes a permanent belief.
 */
const CLASSIFIER_RULES: { category: MemoryCategory; confidence: number; pattern: RegExp }[] = [
  {
    category: "suppression",
    confidence: 0.9,
    pattern: /\b(never remember|forget (?:that|this|about)|do(?:n't| not) remember|stop remembering)\b/i,
  },
  {
    category: "temporary",
    confidence: 0.55,
    pattern:
      /\b(today|tonight|tomorrow|this (?:week|weekend|month|morning|afternoon|evening)|next (?:week|month)|by (?:friday|monday|tuesday|wednesday|thursday|saturday|sunday)|deadline|due (?:on|by)|for now|at the moment|right now|jet ?lag|until (?:the|next|end))\b/i,
  },
  {
    category: "relationships",
    confidence: 0.7,
    pattern:
      /\b(wife|husband|partner|spouse|girlfriend|boyfriend|son|daughter|kids?|children|mother|father|mum|mom|dad|parents?|sister|brother|friend|manager|colleague|teammate|co-?founder|reports? to)\b/i,
  },
  {
    category: "studies",
    confidence: 0.7,
    pattern:
      /\b(stud(?:y|ies|ying)|learning|course|degree|university|college|exam|thesis|semester|lecture|revising|revision|tutorial|homework)\b/i,
  },
  {
    category: "goals",
    confidence: 0.7,
    pattern: /\b(wants? to|would like to|aims? to|plans? to|hopes? to|goals?|ambition|aspires?|working towards?)\b/i,
  },
  {
    category: "projects",
    confidence: 0.7,
    pattern: /\b(project|repo|repository|side project|startup|working on|building|shipping|launching)\b/i,
  },
  {
    category: "workflows",
    confidence: 0.65,
    pattern: /\b(workflow|pipeline|deploys?|tooling|editor|ide|terminal|stack|framework|uses?|writes? code in)\b/i,
  },
  {
    category: "preferences",
    confidence: 0.7,
    pattern:
      /\b(prefers?|likes?|dislikes?|hates?|loves?|favou?rite|rather than|instead of|enjoys?|avoids?|allergic)\b/i,
  },
  {
    category: "identity",
    confidence: 0.7,
    pattern:
      /\b(lives? in|based in|works? (?:at|for)|is an?|named|is called|years old|time ?zone|speaks?|nationality)\b/i,
  },
];

/**
 * Phrases that mean "I am correcting you". They raise confidence and, below,
 * let an otherwise-similar statement overturn an older one even when it doesn't
 * fit a known single-valued slot.
 */
const CORRECTION_MARKERS =
  /\b(actually|correction|to be clear|no longer|not any ?more|used to|has moved|moved (?:to|from)|switched (?:to|from)|stopped|changed (?:to|from)|instead of)\b/i;

export function hasCorrectionMarker(content: string): boolean {
  return CORRECTION_MARKERS.test(content);
}

export interface Classification {
  category: MemoryCategory;
  confidence: number;
}

/**
 * Category + confidence for a statement about to be stored.
 *
 * A MANUAL fact is something the user typed on the memory page, so it enters at
 * 0.9 no matter what the keyword rules made of it — the classifier's opinion of
 * a sentence never outranks the user having written it. Anything the extractor
 * inferred stays below that ceiling, which is what makes "explicit beats
 * inferred" decidable further down.
 */
export function classifyFact(content: string, opts: { source?: "AUTO" | "MANUAL" } = {}): Classification {
  const rule = CLASSIFIER_RULES.find((candidate) => candidate.pattern.test(content));
  const category = rule?.category ?? DEFAULT_MEMORY_CATEGORY;
  let confidence = rule?.confidence ?? 0.4;
  if (hasCorrectionMarker(content)) confidence = Math.min(0.85, confidence + 0.15);
  if (opts.source === "MANUAL") confidence = 0.9;
  return { category, confidence: Number(confidence.toFixed(2)) };
}

/**
 * The Memory v2 columns for a fact being written directly — a manual entry on
 * the memory page, or an applied natural-language edit — where there is no
 * candidate/existing comparison to run. Shares one implementation with the
 * extraction path so a hand-typed fact and an extracted one are classified and
 * normalized identically; if they were not, dedup would miss across the two.
 */
export function factFields(
  content: string,
  opts: { source: "AUTO" | "MANUAL"; now?: Date }
): { category: MemoryCategory; confidence: number; normalized: string; expiresAt: Date | null } {
  const { category, confidence } = classifyFact(content, { source: opts.source });
  return {
    category,
    confidence,
    normalized: normalizeFact(content),
    expiresAt: expiresAtFor(category, opts.now ?? new Date()),
  };
}

/** Temporary facts get a deadline; everything else is believed until replaced. */
export function expiresAtFor(
  category: MemoryCategory,
  now: Date,
  ttlDays: number = TEMPORARY_MEMORY_TTL_DAYS
): Date | null {
  if (category !== "temporary") return null;
  return new Date(now.getTime() + ttlDays * 86_400_000);
}

export function isExpired(entry: { expiresAt: Date | null }, now: Date): boolean {
  return entry.expiresAt !== null && entry.expiresAt.getTime() <= now.getTime();
}

// ---------------------------------------------------------------------------
// Duplicates and contradictions
// ---------------------------------------------------------------------------

/** The minimum a stored entry must expose for the lifecycle rules to judge it. */
export interface LifecycleEntry {
  id: string;
  content: string;
  normalized: string | null;
  category: string | null;
  projectId: string | null;
  source: "AUTO" | "MANUAL";
  kind: "FACT" | "SUPPRESSION";
  confidence: number;
  status: string;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface FactCandidate {
  content: string;
  source: "AUTO" | "MANUAL";
  category: MemoryCategory;
  confidence: number;
  projectId?: string | null;
}

/**
 * An existing row that says the same thing. Scope matters: a project-scoped
 * fact and a global one with identical wording are genuinely two facts, because
 * only one of them is visible outside the project.
 */
export function findDuplicate(
  candidate: { content: string; projectId?: string | null },
  entries: readonly LifecycleEntry[]
): LifecycleEntry | null {
  const key = normalizeFact(candidate.content);
  if (!key) return null;
  const scope = candidate.projectId ?? null;
  return entries.find((entry) => entry.kind === "FACT" && entry.projectId === scope && normalizedOf(entry) === key) ?? null;
}

/**
 * Attributes a person can only have one live value for at a time, with the
 * phrase that carries the value.
 *
 * This list exists because the obvious general rule — "strongly overlapping
 * statements in the same category contradict" — is wrong in the common case:
 * "learning Spanish" and "learning Japanese" overlap almost completely and are
 * both true. Only single-valued attributes can genuinely conflict, so those are
 * enumerated rather than guessed.
 */
const EXCLUSIVE_SLOTS: { slot: string; noun: string; pattern: RegExp }[] = [
  { slot: "location", noun: "where you live", pattern: /\b(?:lives?|living|based|located|resides?)\s+(?:in|at|near)\s+(.+)$/i },
  { slot: "employer", noun: "where you work", pattern: /\b(?:works?|working|employed)\s+(?:at|for)\s+(.+)$/i },
  { slot: "name", noun: "what you are called", pattern: /\b(?:name is|goes by|is called|prefers to be called)\s+(.+)$/i },
  { slot: "timezone", noun: "your time zone", pattern: /\b(?:time ?zone|utc offset)\s*(?:is|:)?\s*(.+)$/i },
  {
    slot: "editor",
    noun: "your editor",
    pattern: /\b(?:uses?|prefers?)\s+(.+?)\s+as\s+(?:their|his|her|the)\s+(?:main\s+|primary\s+)?(?:editor|ide)\b/i,
  },
  {
    slot: "primary-language",
    noun: "your main language",
    pattern: /\b(?:primary|main|preferred|favou?rite)\s+(?:programming\s+)?language\s+(?:is|:)\s*(.+)$/i,
  },
];

export interface ExclusiveSlot {
  slot: string;
  noun: string;
  value: string;
}

export function exclusiveSlot(content: string): ExclusiveSlot | null {
  for (const candidate of EXCLUSIVE_SLOTS) {
    const match = candidate.pattern.exec(content);
    if (match?.[1]?.trim()) {
      return { slot: candidate.slot, noun: candidate.noun, value: match[1].trim() };
    }
  }
  return null;
}

/** How similar two statements must be for a correction phrase to overturn one. */
const CORRECTION_OVERLAP_THRESHOLD = 0.6;

export interface Contradiction {
  entry: LifecycleEntry;
  /** The attribute they disagree about, in words the memory page can print. */
  noun: string;
}

/**
 * The active entry a new fact conflicts with, if any.
 *
 * Only entries in the same scope are considered — a project-scoped "works at
 * Acme" must not overturn the account-wide one, because the two are allowed to
 * differ by design.
 */
export function findContradiction(
  candidate: { content: string; projectId?: string | null },
  entries: readonly LifecycleEntry[]
): Contradiction | null {
  const key = normalizeFact(candidate.content);
  const scope = candidate.projectId ?? null;
  const candidateSlot = exclusiveSlot(candidate.content);
  const correcting = hasCorrectionMarker(candidate.content);

  for (const entry of entries) {
    if (entry.kind !== "FACT" || entry.status !== "active" || entry.projectId !== scope) continue;
    if (normalizedOf(entry) === key) continue; // the same fact, not a conflicting one

    const entrySlot = exclusiveSlot(entry.content);
    if (candidateSlot && entrySlot && candidateSlot.slot === entrySlot.slot) {
      if (normalizeFact(candidateSlot.value) !== normalizeFact(entrySlot.value)) {
        return { entry, noun: candidateSlot.noun };
      }
      continue;
    }

    // No known slot, but the user is explicitly correcting something and the
    // two statements are talking about the same thing.
    if (correcting && overlapRatio(candidate.content, entry.content) >= CORRECTION_OVERLAP_THRESHOLD) {
      return { entry, noun: "this" };
    }
  }
  return null;
}

/**
 * How much more confident a *stored* fact must be for it to survive a newer
 * conflicting one of the same kind. Without a margin, 0.70 vs 0.69 would flip
 * the outcome, which is noise deciding what the user is.
 */
const CONFIDENCE_MARGIN = 0.2;

const SOURCE_RANK: Record<"AUTO" | "MANUAL", number> = { MANUAL: 1, AUTO: 0 };

export interface ContradictionOutcome {
  winner: "incoming" | "existing";
  /** Stored on the losing row and shown on the memory page. */
  reason: string;
}

/**
 * Which of two conflicting facts Juno should believe.
 *
 * Explicitness outranks recency: a fact the user typed themselves is never
 * overturned by something a background model inferred from a chat, however
 * recent the inference is. That direction is deliberate — the opposite lets one
 * sloppy extraction quietly rewrite something the user stated on purpose. Only
 * when both sides carry the same kind of evidence does recency decide, and even
 * then a markedly more confident stored fact holds.
 */
export function resolveContradiction(
  existing: { source: "AUTO" | "MANUAL"; confidence: number },
  incoming: { source: "AUTO" | "MANUAL"; confidence: number },
  noun = "this"
): ContradictionOutcome {
  const existingRank = SOURCE_RANK[existing.source];
  const incomingRank = SOURCE_RANK[incoming.source];

  if (incomingRank > existingRank) {
    return { winner: "incoming", reason: `You said this yourself, so it replaced what Juno had inferred about ${noun}.` };
  }
  if (incomingRank < existingRank) {
    return { winner: "existing", reason: `Not used: it conflicts with what you told Juno about ${noun}.` };
  }
  if (existing.confidence - incoming.confidence >= CONFIDENCE_MARGIN) {
    return { winner: "existing", reason: `Not used: Juno is more confident in what it already knew about ${noun}.` };
  }
  return { winner: "incoming", reason: `Replaced by something newer you said about ${noun}.` };
}

// ---------------------------------------------------------------------------
// Ingestion plan
// ---------------------------------------------------------------------------

/**
 * True when a candidate is covered by a suppression note.
 *
 * Delegates to `findSuppression` rather than matching here. Two slices arrived
 * at this rule independently and reached DIFFERENT answers: this module
 * normalises a fact into a sorted, deduplicated token set, which is exactly
 * right for asking "is this the same fact phrased differently" and exactly
 * wrong for asking "does this suppression cover it" — substring containment
 * over a sorted token set is not containment of a phrase. Suppression is the
 * rule a user relies on when they say "forget my address", so it keeps its
 * order-preserving definition, and there is one of it.
 */
export function isSuppressedBy(candidate: string, suppressions: readonly string[]): boolean {
  // An empty candidate has nothing to remember and is refused either way.
  if (!normalizeFact(candidate)) return true;
  return findSuppression(candidate, suppressions) !== null;
}

/**
 * What storing one extracted fact should do to the database.
 *
 * Note what this vocabulary does NOT contain: a delete. Every outcome either
 * adds a row or annotates one. That is the guarantee the memory page depends
 * on — a user who asks "why did that change?" is owed the previous belief and
 * a reason, and the only way to keep that promise is for the write path to be
 * structurally incapable of dropping it.
 */
export type IngestionPlan =
  /** Nothing to store: blank, or covered by a "never remember this" note. */
  | { action: "skip"; reason: "empty" | "suppressed" }
  /**
   * Already known. Refreshes `lastVerifiedAt` instead of adding a row; a
   * restated temporary fact also gets its clock and status wound back.
   */
  | { action: "refresh"; entryId: string; revive: boolean; expiresAt: Date | null }
  /** New belief. `supersedes` is set when it displaces an older one. */
  | {
      action: "create";
      content: string;
      normalized: string;
      category: MemoryCategory;
      confidence: number;
      expiresAt: Date | null;
      status: "active" | "contradicted";
      /** Set when this new row wins a conflict — the loser is annotated, not removed. */
      supersedes?: { entryId: string; reason: string };
      /** Set when this row LOST a conflict: stored, explained, never injected. */
      reason?: string;
    };

/**
 * Decide what one extracted fact does to what Juno already believes.
 *
 * Duplicate first, then contradiction, then plain insert. The order matters:
 * a restatement of a known fact is not a contradiction of it, and checking
 * contradictions first would make every repeated sentence look like a conflict
 * with itself.
 */
export function planFactIngestion(
  candidate: { content: string; source: "AUTO" | "MANUAL"; projectId?: string | null },
  context: { entries: readonly LifecycleEntry[]; suppressions: readonly string[]; now: Date }
): IngestionPlan {
  const content = candidate.content.trim().slice(0, 500);
  if (!content) return { action: "skip", reason: "empty" };
  if (isSuppressedBy(content, context.suppressions)) return { action: "skip", reason: "suppressed" };

  const { category, confidence } = classifyFact(content, { source: candidate.source });
  const normalized = normalizeFact(content);
  const expiresAt = expiresAtFor(category, context.now);

  const duplicate = findDuplicate(candidate, context.entries);
  if (duplicate) {
    // A temporary fact restated is a temporary fact still true — put it back in
    // circulation rather than leaving a retired row the user keeps re-teaching.
    const revive = duplicate.status === "expired";
    return { action: "refresh", entryId: duplicate.id, revive, expiresAt: revive ? expiresAt : duplicate.expiresAt };
  }

  const conflict = findContradiction(candidate, context.entries);
  if (conflict) {
    const outcome = resolveContradiction(
      { source: conflict.entry.source, confidence: conflict.entry.confidence },
      { source: candidate.source, confidence },
      conflict.noun
    );
    if (outcome.winner === "incoming") {
      return {
        action: "create",
        content,
        normalized,
        category,
        confidence,
        expiresAt,
        status: "active",
        supersedes: { entryId: conflict.entry.id, reason: outcome.reason },
      };
    }
    return {
      action: "create",
      content,
      normalized,
      category,
      confidence,
      expiresAt,
      status: "contradicted",
      reason: outcome.reason,
    };
  }

  return { action: "create", content, normalized, category, confidence, expiresAt, status: "active" };
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/**
 * Roughly four characters per token across the providers Juno talks to. Exact
 * enough for a budget whose job is to stop memory crowding out the actual
 * conversation, and it never needs a tokenizer on the chat hot path.
 */
export function estimateMemoryTokens(content: string): number {
  // The framing each fact costs once injected — a bullet and a newline.
  return Math.max(1, Math.ceil(content.length / 4)) + 2;
}

/** Enough context for a handful of facts without displacing the conversation. */
export const DEFAULT_MEMORY_TOKEN_BUDGET = 600;

/** Recency half-life. A year-old fact is worth a quarter of a fresh one. */
const RECENCY_HALF_LIFE_DAYS = 90;

export interface SelectedMemory {
  id: string;
  content: string;
  category: string | null;
  projectId: string | null;
  confidence: number;
  createdAt: Date;
  tokens: number;
  /** The ranking score, kept so the receipt can explain the order. */
  score: number;
}

export interface RetrievalResult {
  selected: SelectedMemory[];
  usedTokens: number;
  budgetTokens: number;
  /** Eligible entries that lost to the budget — the receipt says how many. */
  droppedForBudget: number;
  /** Why the rest never made it, so a degraded memory page can say so. */
  excluded: { inactive: number; expired: number; outOfScope: number };
}

/**
 * Everything a project-scoped memory must never do is enforced here: an entry
 * carrying a projectId is invisible outside that project. Global entries are
 * visible everywhere, including inside projects.
 */
export function inScope(entry: { projectId: string | null }, projectId: string | null): boolean {
  return entry.projectId === null || entry.projectId === projectId;
}

/**
 * Pick the memories worth injecting for this turn, in the order they should be
 * read, within a token budget — and say exactly which ones they were.
 *
 * The return value is the point of the whole function. Injection used to be a
 * `take: 15` with no explanation attached, so the product could show that Juno
 * used "3 memories" but could not name one of them. Naming them is what makes
 * the memory receipt in chat, and "forget that one" as a follow-up, possible.
 */
export function selectMemoriesForContext(
  entries: readonly LifecycleEntry[],
  opts: {
    /** The user's message, so the ranking can prefer what this turn is about. */
    query?: string;
    /** The conversation's project, or null for an unscoped chat. */
    projectId?: string | null;
    now?: Date;
    budgetTokens?: number;
    /** Hard cap on entries regardless of budget, so a prompt stays readable. */
    limit?: number;
  } = {}
): RetrievalResult {
  const now = opts.now ?? new Date();
  const projectId = opts.projectId ?? null;
  const budgetTokens = opts.budgetTokens ?? DEFAULT_MEMORY_TOKEN_BUDGET;
  const limit = opts.limit ?? 24;
  const queryTokens = new Set(opts.query ? significantTokens(opts.query) : []);

  const excluded = { inactive: 0, expired: 0, outOfScope: 0 };
  const eligible: { entry: LifecycleEntry; score: number; tokens: number }[] = [];

  for (const entry of entries) {
    // Suppressions are a block-list, never context.
    if (entry.kind !== "FACT") continue;
    if (entry.status !== "active") {
      excluded.inactive++;
      continue;
    }
    if (isExpired(entry, now)) {
      excluded.expired++;
      continue;
    }
    if (!inScope(entry, projectId)) {
      excluded.outOfScope++;
      continue;
    }

    const entryTokens = new Set(significantTokens(entry.content));
    let overlap = 0;
    for (const token of queryTokens) if (entryTokens.has(token)) overlap++;
    const relevance = queryTokens.size > 0 ? overlap / queryTokens.size : 0;

    const ageDays = Math.max(0, (now.getTime() - entry.createdAt.getTime()) / 86_400_000);
    const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    const categoryWeight = isMemoryCategory(entry.category) ? MEMORY_CATEGORY_WEIGHT[entry.category] : 0.04;
    // A fact scoped to the project you are working in is on-topic by
    // definition, which no amount of word overlap would otherwise show.
    const scopeBoost = entry.projectId !== null && entry.projectId === projectId ? 0.15 : 0;

    const score = 0.55 * relevance + 0.25 * recency + 0.2 * entry.confidence + categoryWeight + scopeBoost;
    eligible.push({ entry, score, tokens: estimateMemoryTokens(entry.content) });
  }

  eligible.sort((a, b) => b.score - a.score || b.entry.createdAt.getTime() - a.entry.createdAt.getTime());

  const selected: SelectedMemory[] = [];
  let usedTokens = 0;
  let droppedForBudget = 0;
  for (const candidate of eligible) {
    // Keep scanning past an entry that doesn't fit rather than stopping: one
    // long fact near the top should not cost every short one behind it its
    // place. The order of what *is* taken still follows the ranking.
    if (selected.length >= limit || usedTokens + candidate.tokens > budgetTokens) {
      droppedForBudget++;
      continue;
    }
    usedTokens += candidate.tokens;
    selected.push({
      id: candidate.entry.id,
      content: candidate.entry.content,
      category: candidate.entry.category,
      projectId: candidate.entry.projectId,
      confidence: candidate.entry.confidence,
      createdAt: candidate.entry.createdAt,
      tokens: candidate.tokens,
      score: candidate.score,
    });
  }

  return { selected, usedTokens, budgetTokens, droppedForBudget, excluded };
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

const RECEIPT_MAX_ENTRIES = 4;
const RECEIPT_MAX_CHARS_PER_ENTRY = 64;

/**
 * The one-line "here is what I remembered" shown in the chat activity trail.
 *
 * It names facts rather than counting them, because a count is not a receipt:
 * "used 3 memories" gives the user nothing to correct, while the actual
 * sentences do.
 */
export function memoryReceiptDetail(result: Pick<RetrievalResult, "selected" | "droppedForBudget">): string {
  if (result.selected.length === 0) return "No stored memory applied";
  const shown = result.selected.slice(0, RECEIPT_MAX_ENTRIES).map((memory) => {
    const label = memoryCategoryLabel(memory.category);
    const text =
      memory.content.length > RECEIPT_MAX_CHARS_PER_ENTRY
        ? `${memory.content.slice(0, RECEIPT_MAX_CHARS_PER_ENTRY - 1).trimEnd()}…`
        : memory.content;
    return `${label}: ${text}`;
  });
  const hidden = result.selected.length - shown.length + result.droppedForBudget;
  if (hidden > 0) shown.push(`+${hidden} more`);
  return shown.join(" · ");
}
