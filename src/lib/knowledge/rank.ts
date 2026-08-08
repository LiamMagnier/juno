/**
 * The pure half of hybrid retrieval: query terms in, ordered citations out.
 *
 * `retrieve.ts` owns the database and the embedding provider; everything here
 * is arithmetic on rows that have already been fetched. The split is the same
 * one `background-provider-policy.ts` makes and for the same reason — the parts
 * that decide *what the model is shown* are the parts that must be testable
 * without a Postgres instance and without a paid API key.
 *
 * The pipeline, in order:
 *
 *   lexical ranking (Postgres) ─┐
 *                               ├─ reciprocal-rank fusion ─ rerank ─ pack
 *   semantic ranking (cosine) ──┘
 *
 * Fusion rather than a weighted sum of the two scores, because the two scores
 * are not comparable: `ts_rank_cd` is an unbounded relevance number whose scale
 * depends on document length, and cosine is a bounded similarity whose useful
 * range for a given embedding model is often 0.6–0.9. Any weighting of the two
 * is a constant somebody tuned once against one corpus. Ranks have no such
 * problem — position 1 means the same thing on both sides.
 */
import { estimateTokens } from "@/lib/knowledge/chunk";

// ---------------------------------------------------------------------------
// The lexical query
// ---------------------------------------------------------------------------

/**
 * Postgres text-search configuration.
 *
 * `simple` on purpose. `english` stems and strips stopwords, which is a real
 * recall win for English and a real recall *loss* for everything else: a German
 * or Turkish document run through the English snowball stemmer has its words
 * mangled by rules that do not apply to it, and Juno's users do not all write
 * in English. `simple` is lossless in every language, and the morphology that
 * stemming would have caught is exactly what the semantic leg of the hybrid is
 * for. A single-language deployment can override it.
 */
export const LEXICAL_TSCONFIG = process.env.KNOWLEDGE_TSCONFIG?.trim() || "simple";

/**
 * English stopwords, dropped from the query only.
 *
 * English-only and unapologetically so: this is a precision aid, not a
 * correctness rule. Dropping "the" costs a French document nothing, because
 * "the" was never going to be the term that found it. Terms are never all
 * dropped — a query that is nothing but stopwords keeps them.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "did", "do", "does", "for",
  "from", "had", "has", "have", "how", "i", "in", "is", "it", "its", "me", "my", "of", "on",
  "or", "our", "so", "than", "that", "the", "their", "them", "then", "there", "these", "they",
  "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
  "with", "you", "your",
]);

/** Beyond this the tsquery costs more to plan than the extra terms are worth. */
const MAX_QUERY_TERMS = 24;

/**
 * Build the `to_tsquery` expression for a user's question.
 *
 * Two decisions worth stating.
 *
 * **Injection.** The expression is bound as a parameter by the caller, so this
 * is not the injection boundary — but a tsquery is itself a small language, and
 * a query containing `!` or `<->` would either error or silently mean something
 * else. Every term is therefore stripped to letters, digits and underscores
 * before any operator is added, so no tsquery syntax can survive from user
 * input.
 *
 * **OR, not AND.** `plainto_tsquery` ANDs the terms, so a five-word question
 * finds nothing unless one chunk contains all five words. Here the terms are
 * ORed with prefix matching and precision is left to `ts_rank_cd`, which ranks
 * a chunk matching four terms above one matching one. Recall first, because a
 * chunk that is never a candidate can never be reranked into the answer.
 *
 * Returns null when there is nothing searchable — `to_tsquery('')` is an error,
 * not an empty result.
 */
export function lexicalQueryExpression(query: string): string | null {
  const raw = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .map((term) => term.trim())
    // Single characters become `a:*`, which matches most of the corpus and
    // pushes real candidates out of the LIMIT.
    .filter((term) => term.length > 1);
  if (raw.length === 0) return null;

  const filtered = raw.filter((term) => !STOPWORDS.has(term));
  const terms = [...new Set(filtered.length > 0 ? filtered : raw)].slice(0, MAX_QUERY_TERMS);
  return terms.map((term) => `${term}:*`).join(" | ");
}

// ---------------------------------------------------------------------------
// Semantic similarity
// ---------------------------------------------------------------------------

/**
 * Cosine similarity, or 0 for vectors that cannot be compared.
 *
 * Length mismatch returns 0 rather than throwing because it has a real cause:
 * a chunk embedded before the deployment changed embedding model. `retrieve.ts`
 * filters those out by `embeddingModel` first — comparing two models' vectors
 * produces a number with no meaning — and this is the second line of defence
 * for the case where two models happen to share a dimension count.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Reciprocal-rank fusion
// ---------------------------------------------------------------------------

/**
 * The constant from the original RRF paper. It damps the top of each list: with
 * k = 60 the difference between rank 1 and rank 2 is small, so one list being
 * confidently wrong cannot outvote the other list being quietly right.
 */
export const RRF_K = 60;

export interface FusedEntry {
  id: string;
  score: number;
  /** Position in each input ranking, 1-based; null where the list omitted it. */
  ranks: (number | null)[];
}

/**
 * Merge ranked id lists into one ranking.
 *
 * Stable in the sense that matters here: the output depends only on the
 * *positions* in the inputs, and equal scores are broken by id, so the same
 * inputs always produce the same order regardless of how the lists were built
 * or which order they were passed in. Retrieval that reshuffles between two
 * identical questions looks broken even when both orders are defensible.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  k: number = RRF_K
): FusedEntry[] {
  const scores = new Map<string, number>();
  const positions = new Map<string, (number | null)[]>();
  const width = rankings.length;

  rankings.forEach((ranking, listIndex) => {
    ranking.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
      let row = positions.get(id);
      if (!row) {
        row = new Array<number | null>(width).fill(null);
        positions.set(id, row);
      }
      // A list that somehow contains an id twice keeps the better position.
      if (row[listIndex] === null || rank < row[listIndex]!) row[listIndex] = rank;
    });
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, ranks: positions.get(id)! }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

/** A retrieved chunk, with everything a citation and a rerank both need. */
export interface RetrievalCandidate {
  chunkId: string;
  documentId: string;
  fileName: string;
  mimeType: string;
  /** The project the *document* belongs to, which may not be the asked project. */
  projectId: string | null;
  /** Position of the chunk in its document — the key to restoring reading order. */
  ordinal: number;
  text: string;
  blockIds: string[];
  /** When the document was indexed, or created if it never finished indexing. */
  documentAt: Date;
}

export interface ScoredPassage extends RetrievalCandidate {
  score: number;
  /** 1-based position in each leg, or null when that leg did not return it. */
  lexicalRank: number | null;
  semanticRank: number | null;
  /** "page 4". Resolved from the blocks after packing — see chunk.describeLocator. */
  locator: string;
}

export interface RerankOptions {
  now?: Date;
  /** The project the question is being asked inside, if any. */
  projectId?: string | null;
  /** Multiplier applied to a document already in that project. */
  scopeBoost?: number;
  recencyHalfLifeDays?: number;
  /** How much a brand-new document may gain over an ancient one. */
  recencyWeight?: number;
  /** Applied per already-selected passage from the same document. */
  diversityDecay?: number;
  limit?: number;
}

export const DEFAULT_RERANK: Required<Omit<RerankOptions, "now" | "projectId">> = {
  scopeBoost: 0.25,
  recencyHalfLifeDays: 180,
  recencyWeight: 0.15,
  diversityDecay: 0.72,
  limit: 12,
};

const DAY_MS = 86_400_000;

/**
 * Reorder fused candidates on recency, scope and source diversity.
 *
 * All three are nudges, never overrides, and the weights say so: relevance can
 * be beaten by a factor of about 1.4 in total, which is enough to separate two
 * comparable passages and not enough to promote an irrelevant one. The failure
 * this guards against is a retrieval system that answers from last year's
 * superseded policy because that document happened to use the question's words
 * more often.
 *
 * Diversity is a selection pass rather than a score, because it is inherently
 * order-dependent: the penalty on a document's second passage only exists once
 * its first has been chosen. Without it, one long document with a matching
 * heading occupies every slot and the answer cites a single source — which is
 * both worse context and a less trustworthy answer.
 */
export function rerankPassages(
  passages: readonly ScoredPassage[],
  options: RerankOptions = {}
): ScoredPassage[] {
  // Resolved one by one rather than by spreading over the defaults: an options
  // object carrying an explicit `limit: undefined` — which is exactly what
  // `{ ...maybeOptions, limit: caller.limit }` produces — would spread that
  // undefined straight over the default and rerank to nothing.
  const scopeBoost = options.scopeBoost ?? DEFAULT_RERANK.scopeBoost;
  const recencyHalfLifeDays = options.recencyHalfLifeDays ?? DEFAULT_RERANK.recencyHalfLifeDays;
  const recencyWeight = options.recencyWeight ?? DEFAULT_RERANK.recencyWeight;
  const diversityDecay = options.diversityDecay ?? DEFAULT_RERANK.diversityDecay;
  const limit = options.limit ?? DEFAULT_RERANK.limit;
  const now = (options.now ?? new Date()).getTime();
  const askedProject = options.projectId ?? null;

  const adjusted = passages.map((passage) => {
    const ageDays = Math.max(0, (now - passage.documentAt.getTime()) / DAY_MS);
    const recency = 1 + recencyWeight * Math.pow(2, -ageDays / recencyHalfLifeDays);
    const scope = askedProject && passage.projectId === askedProject ? 1 + scopeBoost : 1;
    return { passage, weight: passage.score * recency * scope };
  });

  const selected: ScoredPassage[] = [];
  const seenPerDocument = new Map<string, number>();
  const remaining = [...adjusted];

  while (selected.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const seen = seenPerDocument.get(remaining[i].passage.documentId) ?? 0;
      const value = remaining[i].weight * Math.pow(diversityDecay, seen);
      // Ties break on chunk id so the order does not depend on row order.
      if (
        value > bestValue ||
        (value === bestValue && remaining[i].passage.chunkId < remaining[bestIndex].passage.chunkId)
      ) {
        bestValue = value;
        bestIndex = i;
      }
    }
    const [picked] = remaining.splice(bestIndex, 1);
    seenPerDocument.set(
      picked.passage.documentId,
      (seenPerDocument.get(picked.passage.documentId) ?? 0) + 1
    );
    selected.push({ ...picked.passage, score: bestValue });
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Context packing
// ---------------------------------------------------------------------------

/** Longest overlap this looks for when stitching two neighbouring chunks. */
const MAX_STITCH_CHARS = 800;
/** Shorter than this, a shared tail is a coincidence rather than an overlap. */
const MIN_STITCH_CHARS = 24;
/** How far into the second chunk the overlap may start — past the breadcrumb. */
const STITCH_SEARCH_WINDOW = 240;

/**
 * Join two neighbouring chunks without repeating the part they share.
 *
 * Chunks overlap on purpose (see chunk.ts) so a fact stated across a paragraph
 * break is findable from either side. Once both neighbours are in the context
 * that overlap is pure waste — it spends the token budget twice on the same
 * sentences and reads to the model as emphasis it was never given.
 *
 * The search starts at the largest plausible overlap and walks down, and it
 * allows the shared text to start a little way into the second chunk rather
 * than exactly at its first character, because the second chunk begins with its
 * heading breadcrumb.
 */
export function stitchOverlapping(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  if (a.includes(b)) return a;
  if (b.includes(a)) return b;

  const maxOverlap = Math.min(a.length, b.length, MAX_STITCH_CHARS);
  for (let size = maxOverlap; size >= MIN_STITCH_CHARS; size--) {
    const tail = a.slice(a.length - size);
    const at = b.indexOf(tail);
    if (at !== -1 && at <= STITCH_SEARCH_WINDOW) return `${a}${b.slice(at + size)}`;
  }
  return `${a}\n\n${b}`;
}

export interface PackOptions {
  /** Ceiling on the whole knowledge section of the prompt. */
  tokenBudget?: number;
  maxPassages?: number;
}

export const DEFAULT_PACK: Required<PackOptions> = {
  tokenBudget: 2_400,
  maxPassages: 8,
};

export interface PackedContext {
  /** In reading order: documents by best score, passages by ordinal. */
  passages: ScoredPassage[];
  tokens: number;
  /** Passages that were relevant enough to select but did not fit. */
  droppedForBudget: number;
}

/**
 * Turn a ranked list into the section the model actually reads.
 *
 * Selection happens in relevance order and packing happens in *document* order,
 * and the difference matters: a model shown page 9 above page 4 will narrate
 * the document backwards. Neighbouring chunks are merged as they are laid out,
 * so a run of three adjacent chunks arrives as one continuous passage with one
 * citation covering all of it, rather than three overlapping ones.
 */
export function packContext(
  passages: readonly ScoredPassage[],
  options: PackOptions = {}
): PackedContext {
  const tokenBudget = options.tokenBudget ?? DEFAULT_PACK.tokenBudget;
  const maxPassages = options.maxPassages ?? DEFAULT_PACK.maxPassages;

  const chosen: ScoredPassage[] = [];
  let tokens = 0;
  let dropped = 0;
  for (const passage of passages) {
    if (chosen.length >= maxPassages) {
      dropped++;
      continue;
    }
    const cost = estimateTokens(passage.text);
    if (tokens + cost > tokenBudget) {
      // Keep going rather than stopping: a later passage may be small enough to
      // fit, and dropping it too would waste budget the user is paying for.
      dropped++;
      continue;
    }
    chosen.push(passage);
    tokens += cost;
  }

  const byDocument = new Map<string, ScoredPassage[]>();
  for (const passage of chosen) {
    const list = byDocument.get(passage.documentId) ?? [];
    list.push(passage);
    byDocument.set(passage.documentId, list);
  }

  const merged: ScoredPassage[] = [];
  for (const list of byDocument.values()) {
    list.sort((a, b) => a.ordinal - b.ordinal);
    // The run in progress is the last entry `merged` gained for THIS document —
    // held in the array rather than in a local, so a chain of adjacent chunks
    // extends one passage instead of appending several.
    const runStart = merged.length;
    for (const passage of list) {
      const open = merged.length > runStart ? merged[merged.length - 1] : undefined;
      if (open && passage.ordinal - open.ordinal <= 1) {
        merged[merged.length - 1] = {
          ...open,
          // The merged passage keeps the run's best score, because that is what
          // ordered the documents against each other.
          score: Math.max(open.score, passage.score),
          lexicalRank: minRank(open.lexicalRank, passage.lexicalRank),
          semanticRank: minRank(open.semanticRank, passage.semanticRank),
          text: stitchOverlapping(open.text, passage.text),
          blockIds: dedupe([...open.blockIds, ...passage.blockIds]),
          // Advance the anchor so the next adjacent chunk keeps merging.
          ordinal: passage.ordinal,
        };
        continue;
      }
      merged.push({ ...passage });
    }
  }

  // Restore reading order: the most relevant document first, then its passages
  // in the order they appear in the file.
  const bestPerDocument = new Map<string, number>();
  for (const passage of merged) {
    bestPerDocument.set(
      passage.documentId,
      Math.max(bestPerDocument.get(passage.documentId) ?? -Infinity, passage.score)
    );
  }
  merged.sort(
    (a, b) =>
      bestPerDocument.get(b.documentId)! - bestPerDocument.get(a.documentId)! ||
      (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0) ||
      a.ordinal - b.ordinal
  );

  return {
    passages: merged,
    tokens: merged.reduce((sum, passage) => sum + estimateTokens(passage.text), 0),
    droppedForBudget: dropped,
  };
}

function minRank(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function dedupe(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
