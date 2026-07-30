import { toSteps } from "@/lib/reasoning-parts";

/**
 * REASONING → the lines the AIcss thinking viewport shows.
 *
 * This is a DISPLAY chunker, and the distinction matters enough to state: it
 * decides where to WRAP a trace into 40px slots. It does not decide, claim or
 * imply where the model's steps are. `reasoning-parts.ts` is emphatic that a
 * boundary is a fact from the wire and must never be re-derived from prose, and
 * nothing here breaks that rule:
 *
 *   - Provider parts present → one line per part, labelled by `toStep`, in the
 *     order the API declared. Real boundaries, used as boundaries.
 *   - No parts → wrap on the model's OWN blank lines, then, only if a paragraph
 *     is too long to read two lines at a time, at sentence ends inside it.
 *
 * The second case produces lines, not steps, and no caller numbers them, counts
 * them, or reports them as the model's stages. The steps list in
 * `ThoughtProcessPanel` still renders for providers that sent parts and for
 * nobody else.
 */

/** Longer than this and a paragraph gets broken at sentence ends for display. */
const WRAP_AT = 170;

/** Sentence end followed by whitespace — the split point, kept with its clause. */
const SENTENCE_END = /(?<=[.!?…])\s+/;

function wrapParagraph(paragraph: string): string[] {
  if (paragraph.length <= WRAP_AT) return [paragraph];
  const out: string[] = [];
  let current = "";
  for (const clause of paragraph.split(SENTENCE_END)) {
    // Start a new line once adding this clause would take the current one past
    // the budget — unless the line is still empty, in which case the clause is
    // itself oversized and gets a line of its own rather than being cut.
    if (current && current.length + clause.length + 1 > WRAP_AT) {
      out.push(current);
      current = clause;
    } else {
      current = current ? `${current} ${clause}` : clause;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * @param text  the flat reasoning trace, as persisted on the message.
 * @param parts the provider's own summary parts, or absent when it sent none.
 */
export function toReasoningLines(text?: string | null, parts?: string[] | null): string[] {
  const steps = toSteps(parts);
  if (steps) {
    // A title-only part has an empty body and is real (see toStep) — the title
    // is the line. Body-only parts fall back to their opening line, which is
    // what the panel's steps list shows too, so the two never disagree.
    return steps
      .map((step) => step.title ?? step.body.split("\n")[0])
      .map((line) => line.trim())
      .filter(Boolean);
  }

  const trace = (text ?? "").trim();
  if (!trace) return [];
  return trace
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .flatMap(wrapParagraph);
}
