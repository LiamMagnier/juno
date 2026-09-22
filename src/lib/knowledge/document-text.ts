/**
 * A whole document, back in reading order, for a model to actually read.
 *
 * WHAT WAS WRONG. Structured extraction turns an upload into `KnowledgeBlock`
 * rows — paragraphs, headings, cells, slides, each with its locator — and then
 * the only thing that ever read them back was retrieval: the chat route
 * embedded the user's question and pulled the four or five passages that
 * scored highest. For a project of two hundred documents that is exactly
 * right. For "summarise the PDF I just attached" it is the wrong shape of
 * answer to the wrong question: RAG is a way to find the relevant part of a
 * corpus, and a corpus of one document that the user is looking at has no
 * irrelevant part. A model asked to summarise a report and handed five
 * paragraphs of it will summarise five paragraphs and sound certain.
 *
 * So the document comes back whole, in order, with its page and slide markers
 * intact — the way the other assistants do it, and the way a person would if
 * they were pasting it in. Retrieval keeps its job for the case it is good at:
 * the document too large to fit, and the project corpus.
 *
 * PURE ON PURPOSE. Assembling text out of blocks is the part with judgement in
 * it (where markers go, what counts as a heading, what gets cut when the
 * budget runs out) and the part with no database in it, so it is testable
 * without one. `documents.ts` holds the Prisma side.
 */

/** The parts of a `KnowledgeBlock` that reading order depends on. */
export interface DocumentBlock {
  ordinal: number;
  /** paragraph | heading | list_item | table | table_cell | slide_title | … */
  type: string;
  text: string;
  page?: number | null;
  slide?: number | null;
  sheet?: string | null;
  cellRange?: string | null;
  lineStart?: number | null;
}

export interface AssembledDocument {
  /** The document as text, with locator markers between its sections. */
  text: string;
  /** Characters the document has in total, before any budget was applied. */
  totalChars: number;
  /** True when `text` stops short of the end. */
  truncated: boolean;
  /** Where `text` stops, so a follow-up read can continue from it. */
  blocksIncluded: number;
  blocksTotal: number;
}

/**
 * The marker that introduces a block, or `null` when it continues the last one.
 *
 * Markers are not decoration: they are what makes a model's citation checkable.
 * "on page 7" is a claim a reader can verify in ten seconds; the same sentence
 * without the number is one they have to take on trust or re-read the document
 * to confirm. They are also what a follow-up question anchors to — "what does
 * the table on page 12 say" only works if page 12 was ever labelled.
 */
function markerFor(block: DocumentBlock, previous: DocumentBlock | null): string | null {
  if (typeof block.page === "number" && block.page !== previous?.page) {
    return `[page ${block.page}]`;
  }
  if (typeof block.slide === "number" && block.slide !== previous?.slide) {
    return `[slide ${block.slide}]`;
  }
  if (block.sheet && block.sheet !== previous?.sheet) {
    return `[sheet ${block.sheet}]`;
  }
  return null;
}

const HEADING_TYPES = new Set(["heading", "slide_title"]);

/**
 * Blocks → one string, bounded by `maxChars`.
 *
 * The bound is applied at BLOCK boundaries, not mid-sentence. A cut inside a
 * table row or a paragraph produces a fragment that reads as a complete
 * statement and is not one — and a model has no way to tell the difference.
 * Stopping at the last whole block and saying so is the version that cannot
 * mislead.
 */
export function assembleDocumentText(
  blocks: readonly DocumentBlock[],
  options: { maxChars?: number } = {},
): AssembledDocument {
  const maxChars = Math.max(0, options.maxChars ?? Number.MAX_SAFE_INTEGER);
  const ordered = [...blocks].sort((a, b) => a.ordinal - b.ordinal);

  const parts: string[] = [];
  let length = 0;
  let included = 0;
  let previous: DocumentBlock | null = null;
  let totalChars = 0;
  let stopped = false;

  for (const block of ordered) {
    const body = block.text.trim();
    // `totalChars` has to count every block, including the ones the budget
    // refuses, or "you are seeing 40% of this document" becomes a lie that
    // gets more confident the more it truncates.
    const marker = markerFor(block, previous);
    const piece = [marker, HEADING_TYPES.has(block.type) && body ? `\n${body}` : body]
      .filter(Boolean)
      .join(marker && body ? "\n" : "");
    totalChars += piece.length + 1;
    previous = block;
    if (stopped || !piece) continue;

    if (length + piece.length + 1 > maxChars) {
      stopped = true;
      continue;
    }
    parts.push(piece);
    length += piece.length + 1;
    included += 1;
  }

  return {
    text: parts.join("\n").trim(),
    totalChars,
    truncated: stopped,
    blocksIncluded: included,
    blocksTotal: ordered.length,
  };
}

/**
 * The one-line outline of a document: its headings, in order.
 *
 * What it is for is the document too large to send whole. A model given a
 * truncated document and nothing else does not know what it is missing, so it
 * cannot tell whether the answer is in the part it was refused — and it will
 * answer anyway. Given the headings it knows the shape of the whole thing and
 * can ask `read_document` for the section it needs by name.
 */
export function documentOutline(
  blocks: readonly DocumentBlock[],
  options: { limit?: number } = {},
): string[] {
  const limit = options.limit ?? 60;
  const out: string[] = [];
  for (const block of [...blocks].sort((a, b) => a.ordinal - b.ordinal)) {
    if (!HEADING_TYPES.has(block.type)) continue;
    const text = block.text.trim().replace(/\s+/g, " ");
    if (!text) continue;
    const locator =
      typeof block.page === "number"
        ? ` (page ${block.page})`
        : typeof block.slide === "number"
          ? ` (slide ${block.slide})`
          : "";
    out.push(`${text.slice(0, 120)}${locator}`);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * How much of an attachment's text one model may be sent.
 *
 * A FIXED CEILING WAS THE BUG. Every adapter sliced attachment text at the
 * same 100 000 characters regardless of what it was talking to, which is two
 * different failures wearing one number: on a 32k-token model it is a quarter
 * of a million characters of context the request cannot hold, and on Gemini's
 * million-token window it throws away nine tenths of a document that would
 * have fitted with room to spare. The share — not the constant — is the thing
 * worth keeping fixed.
 *
 * A THIRD of the window, at four characters to the token. Attachments are not
 * the only thing in a prompt: the system prompt, the conversation, retrieved
 * passages, memories and the answer itself all come out of the same budget,
 * and a document that crowds out the conversation it was attached to is not
 * more useful for being complete. The floor keeps the smallest models useful
 * (8 000 characters is still several pages); the ceiling is where a document
 * stops being something to read and starts being something to search, which
 * is what `read_document` is for.
 */
export function attachmentTextBudget(contextTokens: number | undefined): number {
  const tokens = Number.isFinite(contextTokens) && (contextTokens ?? 0) > 0 ? contextTokens! : 128_000;
  const chars = Math.floor((tokens / 3) * 4);
  return Math.min(400_000, Math.max(8_000, chars));
}
