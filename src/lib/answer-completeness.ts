/**
 * Does this answer look like it was cut off?
 *
 * WHY THIS EXISTS. Some providers end a stream without a terminal finish
 * reason — Gemini 3.8 Flash at High thinking does it on every turn we have
 * evidence for. When that happens the adapter has to decide what to tell the
 * reader, and both of the obvious answers are wrong:
 *
 *   "unknown"  is a failure state. It puts "Stream ended unexpectedly" and a
 *              red Failed over an answer the reader can see. Reported.
 *   "stop"     claims the turn finished. Reported too, and worse — an answer
 *              that breaks off mid-sentence under a calm "Done" is the product
 *              lying about completeness, and there is nothing to click.
 *
 * So look at the artefact we actually have. A finished answer ends the way
 * finished prose ends; a truncated one stops mid-word, mid-bracket or inside a
 * code fence. That is not a guess about the provider's intent, it is a
 * property of the text, and when it says "incomplete" the turn is labelled
 * `length` — which already offers Continue, which is the thing the reader
 * wants.
 *
 * IT IS DELIBERATELY BIASED TOWARD "COMPLETE". A false "incomplete" puts a
 * Continue button under a finished answer, which is noise. A false "complete"
 * hides a truncation, which is the bug this is here to stop — but only when
 * the text gives no sign at all, and text that gives no sign is usually fine.
 * Every rule below fires on positive evidence of a cut, never on the absence
 * of evidence of an ending.
 */

/**
 * Characters prose legitimately ends on. Closing brackets and quotes count:
 * an answer may end on `…the command palette (⌘K).` or on a quoted sentence.
 */
const TERMINAL = /[.!?…:;"'”’\)\]\}`>*_|]$/u;

/** CJK and other scripts whose full stops are not in the Latin set above. */
const TERMINAL_WIDE = /[。．！？；：、」』）】》]$/u;

export function looksTruncated(answer: string): boolean {
  const text = answer.trimEnd();
  if (!text) return false;

  // An odd number of fences means one is still open — the answer stopped
  // inside a code block. This is the strongest signal there is and the most
  // common shape of the failure, because a cut usually lands in the long part.
  const fences = text.match(/^[ \t]*```/gm);
  if (fences && fences.length % 2 === 1) return true;

  // Markup the model opened and never closed.
  if (countOf(text, "<juno:artifact") > countOf(text, "</juno:artifact>")) return true;

  const last = text.slice(-1);

  // Ends on an OPENING bracket: `…an interactive command palette (` — the
  // literal case that prompted this file.
  if (/[([{<]$/u.test(last)) return true;

  // Ends on a joining word or a comma — the sentence was going somewhere.
  if (/[,\-–—/]$/u.test(last)) return true;
  // Words that essentially never end a reply: articles, prepositions,
  // conjunctions, bare auxiliaries and subject pronouns. A reply ending on one
  // of these was going somewhere. Kept to words where that holds for ALMOST
  // every sentence — "however" and "too" are deliberately absent, because they
  // legitimately end one.
  if (
    /\b(?:and|or|but|the|an?|to|of|with|for|in|on|at|by|from|that|which|is|are|was|were|be|been|will|can|could|should|would|must|may|we|i|you|it|they|he|she|its|their|our|your|his|her|this|these|those|et|ou|mais|le|la|les|de|du|des|une?|pour|dans|avec|sur|par|que|qui|est|sont|nous|vous|ils|elles|leur|son|sa|ses|ce|cette)$/iu.test(
      text,
    )
  ) {
    return true;
  }

  // Anything that ends the way a sentence ends is taken at its word.
  if (TERMINAL.test(last) || TERMINAL_WIDE.test(last)) return false;

  // A bare word with no terminal punctuation. Could be a heading, a list item
  // or a table row — all legitimate endings — so this is NOT called truncated.
  // Positive evidence only; see the header.
  return false;
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}
