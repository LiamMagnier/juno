import type { SearchMark, SearchSnippet } from "@/lib/search/types";

/**
 * How a palette row's text is prepared before it is drawn: the matched words
 * in a title, and a content snippet cut so its match is on screen.
 */

/** Characters of context kept before a snippet's first match. */
export const SNIPPET_LEAD = 24;
/**
 * And after it: lead + match + tail is about 80 characters, two lines on a
 * 390px phone (~42 a line) and one on a desktop row (~86).
 */
export const SNIPPET_TAIL = 48;

/**
 * The same two for a row wider than a phone's: the server's own radius
 * (SNIPPET_RADIUS, lib/search/query.ts), so nothing is cut. A desktop row
 * shows ~86 characters a line, so the server's ~140 already fit its two
 * lines, and trimming the lead there only traded the words that say what the
 * match is about ("a partial index on (user_id, updated_at)") for a fragment
 * ("…updated_at)"). Wide rows still get the ellipsis clean-up below.
 */
export const SNIPPET_LEAD_WIDE = 64;
export const SNIPPET_TAIL_WIDE = 64;

const ELLIPSIS = "…";

/**
 * How much further back than `lead` the cut may move to open on a whole
 * token ("…(user_id, updated_at) keeps the sync…" rather than
 * "…updated_at) keeps the sync…"). The tail gives the same characters back,
 * so the snippet still fits its two lines.
 */
export const SNIPPET_LEAD_SLACK = 16;

const OPENERS = "([{";
const CLOSERS = ")]}";

/**
 * Whether a line may open at `start` and read as whole text up to `end`: it
 * does not open on punctuation that belongs to what came before (a closing
 * bracket, a comma, a full stop), and no bracket is closed before `end`
 * whose opener the cut would drop. A start just after a space can still be
 * inside a token: "updated_at)" is a word by spaces, but a fragment of
 * "(user_id, updated_at)".
 */
function opensCleanly(text: string, start: number, end: number): boolean {
  if (/^[)\]},.;:!?…]/.test(text.slice(start, start + 1))) return false;
  let depth = 0;
  for (let i = start; i < end; i++) {
    if (OPENERS.includes(text[i])) depth++;
    else if (CLOSERS.includes(text[i]) && --depth < 0) return false;
  }
  return true;
}

/**
 * Where the lead cut lands: the first word start at or after `first - lead`,
 * when it opens cleanly. When it does not, the nearest clean start up to
 * SNIPPET_LEAD_SLACK further back, which keeps the token whole; else the next
 * clean one ahead; else the match itself opens the line.
 */
function leadCut(text: string, first: number, lead: number): number {
  const target = first - lead;
  const clean = (s: number) => opensCleanly(text, s, first);
  const starts: number[] = [];
  for (let i = text.indexOf(" ", Math.max(0, target - SNIPPET_LEAD_SLACK - 1)); i !== -1 && i + 1 < first; i = text.indexOf(" ", i + 1)) {
    if (text[i + 1] !== " ") starts.push(i + 1);
  }
  const atTarget = starts.find((s) => s >= target);
  if (atTarget === undefined) return first;
  if (clean(atTarget)) return atTarget;
  const behind = starts.filter((s) => s < target && s >= target - SNIPPET_LEAD_SLACK && clean(s)).pop();
  if (behind !== undefined) return behind;
  return starts.find((s) => s > atTarget && clean(s)) ?? first;
}

/**
 * Where `query` sits in `label`, as one mark, so a title that matched is
 * highlighted the way a server hit's title is. Case-insensitive. A match at
 * the start of a word is preferred over one inside a word ("pric" in
 * "Pricing" rather than in "Caprice"); `wordStartOnly` refuses the second
 * kind outright, for rows that only ever match at a word start.
 */
export function matchMarks(label: string, query: string, { wordStartOnly = false } = {}): SearchMark[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hay = label.toLowerCase();
  let inside = -1;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    if (i === 0 || !/[\p{L}\p{N}]/u.test(hay[i - 1])) return [{ start: i, end: i + needle.length }];
    if (inside === -1) inside = i;
  }
  if (inside === -1 || wordStartOnly) return [];
  return [{ start: inside, end: inside + needle.length }];
}

/**
 * A snippet whose first match is in view on a narrow row.
 *
 * The server keeps up to 64 characters in front of the first match (it serves
 * a desktop row that shows ~86), and a 390px phone shows ~42 per line, so on
 * a phone most body hits drew no highlighted word at all and looked
 * irrelevant to the query. This cuts the lead to about `lead` characters, at
 * a word boundary that opens cleanly (never inside a bracketed token or on
 * punctuation; see `leadCut`), behind an ellipsis, and moves the marks with it; and the
 * text after the first match to about `tail`, so the whole of it fits the
 * row's two lines rather than being clamped mid-word.
 *
 * It also takes the space out from beside an ellipsis ("updated_at) …"),
 * which is the unfinished-looking cut the product does not draw anywhere.
 */
export function focusSnippet(snippet: SearchSnippet, lead = SNIPPET_LEAD, tail = SNIPPET_TAIL): SearchSnippet {
  let text = snippet.text;
  let marks = snippet.marks;
  const shift = (by: number) => {
    marks = marks.map((m) => ({ start: m.start + by, end: m.end + by }));
  };

  // Where the lead is cut, decided on the server's text: on a word that
  // opens cleanly (`leadCut`). A cut moved back to keep a token whole takes
  // those characters from the tail, so the two lines still hold it all.
  const first = marks[0]?.start;
  const headCut = first !== undefined && first > lead + 2 ? leadCut(text, first, lead) : null;
  const extra = headCut !== null && first !== undefined ? Math.max(0, first - headCut - lead) : 0;

  // The tail next, while the offsets are still the server's. Cut at the
  // last space before the limit, so the line ends on a whole word.
  const firstEnd = marks[0]?.end;
  const tailRoom = tail - extra;
  if (firstEnd !== undefined && text.length - firstEnd > tailRoom + 2) {
    const limit = firstEnd + tailRoom;
    const space = text.lastIndexOf(" ", limit);
    const cut = space > firstEnd ? space : limit;
    text = text.slice(0, cut).trimEnd() + ELLIPSIS;
  }

  if (headCut !== null) {
    text = ELLIPSIS + text.slice(headCut);
    shift(ELLIPSIS.length - headCut);
  }

  // "… the" → "…the" at the start, "the …" → "the…" at the end, and three
  // dots written out are the one ellipsis glyph.
  const leading = text.match(/^(?:…|\.\.\.)\s*/);
  if (leading && leading[0] !== ELLIPSIS) {
    text = ELLIPSIS + text.slice(leading[0].length);
    shift(ELLIPSIS.length - leading[0].length);
  }
  text = text.replace(/\s*(?:…|\.\.\.)$/, ELLIPSIS);
  // A mark never reaches past the text it marks.
  marks = marks.filter((m) => m.start >= 0 && m.end <= text.length);
  return { text, marks };
}
