/**
 * Packing a document's blocks into retrievable chunks.
 *
 * The extractor produces `KnowledgeBlock` rows — one paragraph, heading, table
 * cell or slide title each — which is the right granularity for a citation and
 * the wrong one for retrieval: a single paragraph rarely carries enough context
 * to be judged relevant, and a whole document carries far too much. Chunks sit
 * in between, and they exist so that the answer can point at page 4 rather than
 * at the file.
 *
 * Three properties this module owes the rest of the system:
 *
 *  1. Every chunk records the `blockIds` it was packed from, in order. That is
 *     the citation target — retrieval resolves those ids back to their pages,
 *     slides and cell ranges. A chunk that loses its block ids is unciteable
 *     and therefore worthless here, however good its text is.
 *  2. Document order is preserved, and `ordinal` is dense and monotonic, so
 *     context packing can restore reading order after relevance has scrambled
 *     it.
 *  3. Chunks never split mid-sentence. A half-sentence embeds badly (the vector
 *     describes a fragment nobody wrote) and reads worse — a model shown
 *     "…therefore we should not" will finish the thought itself.
 *
 * Deliberately pure: no `server-only`, no Prisma, no provider. The indexer
 * writes the rows; this decides what they contain, and that decision is the
 * part worth testing without a database.
 */

/** A block as this module needs it — the subset of `KnowledgeBlock` that matters. */
export interface ChunkableBlock {
  id: string;
  /** Position in the document. Ties are broken by input order. */
  ordinal: number;
  /** KnowledgeBlock.type — only `heading` is treated specially. */
  type: string;
  text: string;
  /** Breadcrumb of enclosing headings, outermost first. */
  heading?: readonly string[];
}

/** A chunk, shaped for `KnowledgeChunk` minus the columns the database owns. */
export interface PackedChunk {
  /** Dense, 0-based, in document order. */
  ordinal: number;
  text: string;
  /** Estimated, not counted — see `estimateTokens`. */
  tokens: number;
  /** The blocks this text came from, in order, deduplicated. */
  blockIds: string[];
}

export interface ChunkOptions {
  /** Ceiling for one chunk, breadcrumb included. */
  maxTokens?: number;
  /**
   * How much of the previous chunk to repeat at the start of the next one.
   * Overlap exists because the sentence that answers a question is often the
   * one either side of a boundary; without it, a fact stated across a paragraph
   * break is retrievable from neither chunk.
   */
  overlapTokens?: number;
  /**
   * Below this, a chunk is too small to break early on a heading. Without it a
   * document of one-line headings produces one chunk per heading, each too thin
   * to embed usefully.
   */
  minTokens?: number;
  /**
   * Prefix each chunk with its heading breadcrumb. On by default: the section
   * title is frequently the only place the subject is named ("Refunds" followed
   * by three paragraphs of "the customer may…"), so a chunk without it matches
   * neither a lexical nor a semantic query for the subject.
   */
  includeHeadingBreadcrumb?: boolean;
}

export const DEFAULT_CHUNK_OPTIONS: Required<ChunkOptions> = {
  maxTokens: 320,
  overlapTokens: 48,
  minTokens: 64,
  includeHeadingBreadcrumb: true,
};

/** Breadcrumb separator, matching how the chunk reads back to a model. */
const BREADCRUMB_SEPARATOR = " › ";

/**
 * Token estimate, not a token count.
 *
 * No tokenizer is loaded here on purpose: the budget has to hold for whichever
 * embedding provider the policy allows, and their tokenizers disagree. What the
 * budget needs is to never *under*-count badly enough to overflow a provider's
 * input limit.
 *
 * The usual chars/4 rule is calibrated on English and is wrong by roughly 4x
 * for CJK, where a single character is typically its own token. A Chinese
 * document chunked on chars/4 alone would produce chunks four times the
 * intended size and get truncated provider-side — silently, because truncation
 * is not an error. So CJK codepoints are counted at one token each and the rest
 * at the usual ratio.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x3040 && code <= 0x30ff) || // kana
      (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
      (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
      (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
      (code >= 0xf900 && code <= 0xfaff) // CJK compatibility
    ) {
      cjk++;
    }
  }
  const rest = Math.max(0, text.length - cjk);
  return Math.ceil(cjk + rest / 4);
}

/**
 * Sentence boundaries, best-effort and deliberately over-eager.
 *
 * Over-splitting is free — the packer immediately regroups the pieces — while
 * under-splitting is not, because an unsplittable run longer than the budget
 * has to be cut somewhere blind. So this errs towards more boundaries: Latin
 * terminators, CJK terminators, and blank lines.
 *
 * It does not try to understand abbreviations ("Fig. 4", "e.g."). A chunk that
 * begins at "4 shows the trend" is a cosmetic wart; the alternative is an
 * abbreviation list that is wrong in every language nobody tested.
 */
export function splitSentences(text: string): string[] {
  const pieces = text
    .split(/(?<=[.!?。！？…])[ \t]+|\n{2,}/g)
    .map((piece) => piece.trim())
    .filter(Boolean);
  return pieces.length > 0 ? pieces : [];
}

/**
 * One packable fragment: at most a block, at least a sentence.
 *
 * Fragments carry their block id rather than a reference to the block, because
 * a block that had to be split contributes several fragments that must all
 * cite the same id.
 */
interface Fragment {
  blockId: string;
  text: string;
  tokens: number;
  heading: readonly string[];
  isHeading: boolean;
  /** True when this fragment starts a new block, deciding the join character. */
  startsBlock: boolean;
}

/** Hard-split a run with no sentence boundary left, at a word boundary if one exists. */
function splitOversizedRun(text: string, maxTokens: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (estimateTokens(rest) > maxTokens) {
    // Convert the token budget back to characters with the same ratio the
    // estimate uses, then walk back to the last space so a word survives whole.
    const approxChars = Math.max(1, Math.floor((rest.length * maxTokens) / estimateTokens(rest)));
    let cut = approxChars;
    const lastSpace = rest.lastIndexOf(" ", approxChars);
    if (lastSpace > approxChars * 0.6) cut = lastSpace;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
    if (!rest) break;
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

function toFragments(block: ChunkableBlock, budget: number): Fragment[] {
  const heading = block.heading ?? [];
  const isHeading = block.type === "heading";
  const text = block.text.trim();
  if (!text) return [];

  const whole = estimateTokens(text);
  if (whole <= budget) {
    return [{ blockId: block.id, text, tokens: whole, heading, isHeading, startsBlock: true }];
  }

  // Too big for one chunk: sentences first, and only then a blind cut.
  const sentences = splitSentences(text).flatMap((sentence) =>
    estimateTokens(sentence) > budget ? splitOversizedRun(sentence, budget) : [sentence]
  );
  return sentences.map((sentence, index) => ({
    blockId: block.id,
    text: sentence,
    tokens: estimateTokens(sentence),
    heading,
    isHeading,
    startsBlock: index === 0,
  }));
}

function breadcrumbFor(fragments: readonly Fragment[], enabled: boolean): string {
  if (!enabled) return "";
  const heading = fragments[0]?.heading ?? [];
  const trail = heading.map((part) => part.trim()).filter(Boolean);
  return trail.length > 0 ? trail.join(BREADCRUMB_SEPARATOR) : "";
}

function renderChunk(fragments: readonly Fragment[], breadcrumb: string): string {
  let body = "";
  for (let i = 0; i < fragments.length; i++) {
    const fragment = fragments[i];
    if (i > 0) body += fragment.startsBlock ? "\n\n" : " ";
    body += fragment.text;
  }
  return breadcrumb ? `${breadcrumb}\n${body}` : body;
}

/**
 * Pack one document's blocks into chunks.
 *
 * Greedy rather than optimal. An optimal packing would balance chunk sizes, but
 * balance is not what retrieval wants: it wants boundaries in the places a
 * human would put them, which is what the heading break and the sentence
 * boundaries buy. Greedy in document order also means the output is stable —
 * reindexing an unchanged document produces byte-identical chunks, so the
 * embeddings do not have to be recomputed.
 *
 * Blocks from more than one document must not be passed together; chunks are
 * per-document by construction and `documentId` is the caller's to attach.
 */
export function packDocumentChunks(
  blocks: readonly ChunkableBlock[],
  options: ChunkOptions = {}
): PackedChunk[] {
  const { maxTokens, overlapTokens, minTokens, includeHeadingBreadcrumb } = {
    ...DEFAULT_CHUNK_OPTIONS,
    ...options,
  };

  const ordered = blocks
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => block.text.trim().length > 0)
    .sort((a, b) => a.block.ordinal - b.block.ordinal || a.index - b.index)
    .map(({ block }) => block);

  // The breadcrumb is charged against the same budget, so reserve room for the
  // largest one in the document rather than discovering mid-pack that a chunk
  // no longer fits once its heading is prepended.
  const breadcrumbCost = includeHeadingBreadcrumb
    ? ordered.reduce(
        (max, block) =>
          Math.max(max, estimateTokens((block.heading ?? []).join(BREADCRUMB_SEPARATOR))),
        0
      )
    : 0;
  const fragmentBudget = Math.max(16, maxTokens - breadcrumbCost);

  const fragments = ordered.flatMap((block) => toFragments(block, fragmentBudget));
  if (fragments.length === 0) return [];

  const chunks: PackedChunk[] = [];
  let current: Fragment[] = [];
  let currentTokens = 0;

  const emit = () => {
    if (current.length === 0) return;
    const breadcrumb = breadcrumbFor(current, includeHeadingBreadcrumb);
    const text = renderChunk(current, breadcrumb);
    const blockIds: string[] = [];
    for (const fragment of current) {
      if (blockIds[blockIds.length - 1] !== fragment.blockId) blockIds.push(fragment.blockId);
    }
    chunks.push({ ordinal: chunks.length, text, tokens: estimateTokens(text), blockIds });

    // Seed the next chunk with the tail of this one. Never the whole chunk:
    // that would make no progress and loop forever on a document whose every
    // fragment is larger than the overlap budget.
    const carried: Fragment[] = [];
    let carriedTokens = 0;
    for (let i = current.length - 1; i > 0; i--) {
      const fragment = current[i];
      if (carriedTokens + fragment.tokens > overlapTokens) break;
      carried.unshift(fragment);
      carriedTokens += fragment.tokens;
    }
    // The carried tail opens a new chunk, so its first fragment reads as the
    // start of a block whatever it was before.
    current = carried.map((fragment, index) =>
      index === 0 ? { ...fragment, startsBlock: true } : fragment
    );
    currentTokens = carriedTokens;
  };

  for (const fragment of fragments) {
    const wouldOverflow = currentTokens > 0 && currentTokens + fragment.tokens > fragmentBudget;
    // A heading starts a section, and a section is the unit a reader thinks in.
    // Only honoured once the current chunk is substantial, or a run of headings
    // becomes a run of one-line chunks.
    const startsSection = fragment.isHeading && fragment.startsBlock && currentTokens >= minTokens;
    if (wouldOverflow || startsSection) emit();
    current.push(fragment);
    currentTokens += fragment.tokens;
  }
  // The trailing chunk may repeat the previous one's overlap and nothing else,
  // which is a duplicate rather than a chunk.
  if (current.length > 0) {
    const previous = chunks[chunks.length - 1];
    const breadcrumb = breadcrumbFor(current, includeHeadingBreadcrumb);
    const text = renderChunk(current, breadcrumb);
    if (!previous || !previous.text.includes(text)) emit();
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/** The locator fields of a `KnowledgeBlock` — where the text physically is. */
export interface BlockLocation {
  page?: number | null;
  slide?: number | null;
  sheet?: string | null;
  cellRange?: string | null;
  path?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  heading?: readonly string[] | null;
}

function range(from: number, to: number, singular: string, plural: string): string {
  return from === to ? `${singular} ${from}` : `${plural} ${from}–${to}`;
}

/**
 * The human-readable "where" for a citation: "page 4", "pages 4–6",
 * "Sheet2!B7", "src/app.ts:10–20".
 *
 * Which fields are set depends entirely on the format, and that is the whole
 * point of the schema carrying all of them — a PDF citation that could only say
 * "in report.pdf" is not a citation, it is a filename.
 *
 * Written in English because its only consumer is the system prompt, where the
 * model reads it alongside the passage. A locator rendered into the UI needs a
 * localized formatter instead; this one would not be extracted by
 * scripts/generate-i18n-catalog.mjs and should not be.
 */
export function describeLocator(blocks: readonly BlockLocation[]): string {
  if (blocks.length === 0) return "";

  const pages = blocks.map((b) => b.page).filter((p): p is number => typeof p === "number");
  if (pages.length > 0) return range(Math.min(...pages), Math.max(...pages), "page", "pages");

  const slides = blocks.map((b) => b.slide).filter((s): s is number => typeof s === "number");
  if (slides.length > 0) return range(Math.min(...slides), Math.max(...slides), "slide", "slides");

  const sheeted = blocks.filter((b) => b.sheet);
  if (sheeted.length > 0) {
    const sheet = sheeted[0].sheet!;
    const cells = sheeted.filter((b) => b.sheet === sheet).map((b) => b.cellRange).filter(Boolean);
    // Cell ranges are already A1-style; the first and last bound the span
    // without this module having to parse column letters.
    if (cells.length === 0) return sheet;
    return cells.length === 1 ? `${sheet}!${cells[0]}` : `${sheet}!${cells[0]}:${cells[cells.length - 1]}`;
  }

  const lines = blocks
    .flatMap((b) => [b.lineStart, b.lineEnd])
    .filter((n): n is number => typeof n === "number");
  const path = blocks.find((b) => b.path)?.path;
  if (lines.length > 0) {
    const span = `${Math.min(...lines)}–${Math.max(...lines)}`;
    return path ? `${path}:${span}` : `lines ${span}`;
  }
  if (path) return path;

  // Nothing physical was recorded — the heading trail is still better than
  // pointing at the file as a whole.
  const heading = blocks.find((b) => b.heading && b.heading.length > 0)?.heading;
  return heading ? heading.join(BREADCRUMB_SEPARATOR) : "";
}
