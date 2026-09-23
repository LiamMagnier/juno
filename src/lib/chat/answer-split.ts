/**
 * Which of a turn's text is the answer and which was commentary (SPEC §2.8).
 *
 * Text a model writes in a round that ends in client tool calls ("Let me
 * check that.") is commentary: it is kept as a timeline item, not glued to the
 * answer. The answer is the rest, plus every preserved block written in any
 * round, so memory, artifacts and the clarification wizard survive wherever
 * the model wrote them (INV-12).
 *
 * WS0 lands the signature and the constants; WS4 implements the split.
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

export function splitAnswer(_segments: readonly TextSegment[]): SplitResult {
  throw new Error("not implemented: WS4");
}
