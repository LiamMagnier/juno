/**
 * Which of a turn's text is the answer and which was commentary (SPEC §2.8).
 *
 * Text a model writes in a round that ends in client tool calls ("Let me
 * check that.") is commentary: it is kept as a timeline item, not glued to the
 * answer. The answer is the rest, plus every preserved block written in any
 * round, so memory, artifacts and the clarification wizard survive wherever
 * the model wrote them (INV-12).
 *
 * Pure and deterministic: the same segments always split the same way, so the
 * commentary rows the turn stream writes when a round ends agree with the
 * final split it makes when the turn does.
 */

/** One contiguous run of text within a round, in stream order. A round can hold several segments
 *  (an OpenAI Responses round can carry a `commentary` message item and a `final_answer` item). */
export interface TextSegment {
  round: number;
  /** Provider-declared phase (OpenAI Responses `phase`, mapped through `item_id`); null = undeclared. */
  phase: "commentary" | "answer" | null;
  text: string;
  /** The request this round belongs to ended in CLIENT tool calls (Juno, connector or native
   *  tools; `round_end.tools > 0`). Provider server-tool steps inside a response do not set it. */
  endedInTools: boolean;
}

export interface SplitResult {
  /** Persisted Message.content and done.message.content. */
  answer: string;
  /** One per commentary round with non-empty text after tag extraction. */
  commentary: Array<{ round: number; text: string }>;
}

/** The blocks cut out of commentary and kept in the answer: artifact, memory, forget, and the
 *  clarification-wizard fence (the same shapes `src/lib/message-content.ts` parses). */
export const PRESERVED_BLOCKS: readonly RegExp[] = [
  /<juno:artifact\s+[^>]*?>[\s\S]*?<\/juno:artifact>/g,
  /<juno:memory>[\s\S]*?<\/juno:memory>/g,
  /<juno:forget>[\s\S]*?<\/juno:forget>/g,
  /:::clarification-wizard[\s\S]*?:::/gi,
];

/** Commentary over this many UTF-8 bytes stays in the answer instead (INV-4). */
export const MAX_COMMENTARY_BYTES = 65_536;

const encoder = new TextEncoder();

function utf8Length(value: string): number {
  return value.length * 3 <= MAX_COMMENTARY_BYTES ? value.length : encoder.encode(value).length;
}

/**
 * Openers of the preserved blocks. A commentary round that still holds one
 * after the complete blocks were cut wrote a block it never closed; that round
 * stays answer text, because its tag must reach the parsers (INV-12) and the
 * artifact verifier refuses an unfinished block in its own words.
 */
const PRESERVED_OPENERS = /<juno:(?:artifact|memory|forget)\b|:::clarification-wizard/i;

/** Rule 1: commentary iff declared so, or undeclared in a round that ended in client tool calls. */
export function isCommentarySegment(segment: TextSegment): boolean {
  if (segment.phase === "commentary") return true;
  if (segment.phase === "answer") return false;
  return segment.endedInTools;
}

/** The complete preserved blocks of `text` in the order they occur, and what is left around them. */
export function cutPreservedBlocks(text: string): { blocks: string[]; rest: string } {
  const found: Array<{ start: number; end: number }> = [];
  for (const pattern of PRESERVED_BLOCKS) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
      found.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const blocks: string[] = [];
  let rest = "";
  let cursor = 0;
  for (const block of found) {
    // A match inside one already cut (a fence quoted in an artifact) is part of it.
    if (block.start < cursor) continue;
    rest += text.slice(cursor, block.start);
    blocks.push(text.slice(block.start, block.end));
    cursor = block.end;
  }
  rest += text.slice(cursor);
  return { blocks, rest };
}

/** Rounds' texts joined with a blank line, trimmed at the joins only (rule 3). */
function joinRounds(parts: ReadonlyArray<{ round: number; text: string }>): string {
  let out = "";
  let lastRound: number | null = null;
  for (const part of parts) {
    if (!part.text) continue;
    if (lastRound === null || part.round === lastRound) {
      out += part.text;
    } else {
      const head = out.trimEnd();
      const tail = part.text.trimStart();
      out = head && tail ? `${head}\n\n${tail}` : head + tail;
    }
    lastRound = part.round;
  }
  return out;
}

/**
 * The commentary one round holds, or `null` when the round has none or must
 * stay answer text. The turn stream calls this when a round ends in tool calls
 * and `splitAnswer` calls it for every round, so the two cannot disagree.
 */
export function commentaryForRound(
  segments: readonly TextSegment[],
  round: number
): { text: string; blocks: string[] } | null {
  const own = segments.filter((segment) => segment.round === round && isCommentarySegment(segment));
  if (!own.length) return null;
  const joined = own.map((segment) => segment.text).join("");
  const { blocks, rest } = cutPreservedBlocks(joined);
  const text = rest.trim();
  // Nothing is ever lost to a cap (rule 2): commentary lives only in
  // `activity`, which shares, versions, sync and native never carry.
  if (utf8Length(text) > MAX_COMMENTARY_BYTES) return null;
  if (PRESERVED_OPENERS.test(text)) return null;
  return { text, blocks };
}

export function splitAnswer(segments: readonly TextSegment[]): SplitResult {
  const rounds: number[] = [];
  for (const segment of segments) if (!rounds.includes(segment.round)) rounds.push(segment.round);

  const commentaryRounds = new Map<number, { text: string; blocks: string[] }>();
  for (const round of rounds) {
    const found = commentaryForRound(segments, round);
    if (found) commentaryRounds.set(round, found);
  }

  // Rule 3: the answer segments in stream order, then every block cut from a
  // commentary round, in the order it was written.
  const answerParts = segments
    .filter((segment) => !(commentaryRounds.has(segment.round) && isCommentarySegment(segment)))
    .map((segment) => ({ round: segment.round, text: segment.text }));
  const blocks = rounds.flatMap((round) => commentaryRounds.get(round)?.blocks ?? []);
  let answer = joinRounds(answerParts);
  if (blocks.length) {
    const head = answer.trimEnd();
    answer = head ? `${head}\n\n${blocks.join("\n\n")}` : blocks.join("\n\n");
  }

  // Rule 4 (DECISIONS T6): a turn whose last round wrote nothing keeps today's
  // concatenation, and nothing is shown twice.
  if (!answer.trim()) {
    return { answer: joinRounds(segments.map((segment) => ({ round: segment.round, text: segment.text }))), commentary: [] };
  }

  const commentary = rounds.flatMap((round) => {
    const found = commentaryRounds.get(round);
    return found && found.text ? [{ round, text: found.text }] : [];
  });
  return { answer, commentary };
}
