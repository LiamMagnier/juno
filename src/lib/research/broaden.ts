/**
 * The wider sweep after an empty one (RESEARCH_V2 F5).
 *
 * A first sweep that finds nothing is almost always over-specified: a quoted
 * model number, a `site:` operator, a year the index has little of yet, or a
 * question pasted whole. One wider sweep, before the run gives up, searches
 * the same questions with the noise taken out. Pure, deterministic and free:
 * no model decides what "wider" means, so it cannot make the subject up.
 */

const OPERATOR = /\b(?:site|inurl|intitle|filetype|before|after):\S+/gi;
const QUESTION_WORDS =
  /^(?:what|which|who|whom|whose|when|where|why|how|is|are|was|were|do|does|did|can|could|should|would|will|has|have|had)\b\s*/i;
const FILLER = new Set([
  "the", "a", "an", "of", "in", "on", "for", "to", "and", "or", "with", "about", "between", "from", "by", "at", "as",
  "is", "are", "was", "were", "be", "been", "do", "does", "did", "that", "this", "these", "those", "it", "its",
  "there", "their", "they", "them", "than", "into", "under", "over", "really", "actually", "currently", "today",
]);

/** A query with its operators, quotes and future years removed, cut to its key terms. */
export function widenQuery(query: string, opts: { year?: number; maxTerms?: number } = {}): string {
  const maxTerms = opts.maxTerms ?? 7;
  const year = opts.year ?? new Date().getUTCFullYear();
  const stripped = query
    .replace(OPERATOR, " ")
    .replace(/["“”«»]/g, " ")
    .replace(/[?!.;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(QUESTION_WORDS, "");
  const terms = stripped
    .split(" ")
    .filter((word) => {
      const bare = word.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, "");
      if (!bare) return false;
      // A year past the current one has nothing indexed under it yet.
      if (/^\d{4}$/.test(bare) && Number(bare) > year) return false;
      return !FILLER.has(bare);
    });
  return terms.slice(0, maxTerms).join(" ");
}

/**
 * Up to `limit` wider searches: each question's key terms, then the goal's,
 * none of them already issued (compared case-insensitively) and none shorter
 * than two words.
 */
export function broadenedQueries(input: {
  goal: string;
  questions: readonly string[];
  alreadyIssued: readonly string[];
  limit: number;
  year?: number;
}): string[] {
  const seen = new Set(input.alreadyIssued.map((query) => query.trim().toLowerCase()));
  const out: string[] = [];
  const firstLine = input.goal.split("\n")[0] ?? input.goal;
  for (const source of [...input.questions, firstLine]) {
    if (out.length >= input.limit) break;
    const wide = widenQuery(source, { year: input.year });
    if (wide.split(" ").length < 2) continue;
    const key = wide.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(wide);
  }
  return out;
}
