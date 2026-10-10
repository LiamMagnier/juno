/**
 * Money is not maths.
 *
 * remark-math reads every single `$…$` as inline TeX, with none of the rules
 * TeX itself uses to tell a formula from a price. A research report about
 * subscription tiers is all prices, and it rendered like this:
 *
 *   "$100–$250 price band, Claude Max 5x ($100/month)"
 *     → italic KaTeX "100–250priceband,ClaudeMax5x(" with every space eaten,
 *
 * and a following "ChatGPT Pro $100 ($100/month) is the alternative when…"
 * became one long italic run that ran out of the column and over the sources
 * rail beside it.
 *
 * So before a block is parsed, every `$` that is not a delimiter of a real
 * formula is swapped for a private-use sentinel of the SAME LENGTH (one UTF-16
 * unit), which no Markdown or maths extension recognises, and
 * `remarkRestoreCurrency` turns it back into `$` in the parsed tree. Same
 * length matters: the renderer publishes each element's character offsets in
 * the source (`rehypeSourceOffsets`), which the citation audit maps claims
 * through, and an escape (`\$`) would shift every offset after it.
 *
 * What still counts as maths, and is left alone:
 *   - `$$…$$` display maths;
 *   - `\(…\)` and `\[…\]` (normalised to dollars later, after this pass);
 *   - `$…$` inline maths by TeX's own rules, the same ones the native renderer
 *     uses (JunoMathMarkup.swift): the opener is followed by a non-space, the
 *     closer is preceded by a non-space and NOT followed by a digit, the run
 *     does not cross a blank line, and a bare `$` that is not a valid closer
 *     proves the opener was money. On top of that, a run that opens on a digit
 *     and reads like prose (spaces, no TeX signal such as `\`, `^`, `_`, `{`,
 *     `=`) is money: "$5 and 10$" is two prices, while "$2^{10}$" and "$2$"
 *     stay formulas.
 *
 * Fenced code and inline code are verbatim and never touched.
 */

/** U+E024, private use: never typed, never a Markdown or TeX token. */
export const CURRENCY_SENTINEL = "";

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const MATH_SIGNAL = /[\\^_{}=<>]/;

/** True when the text holds a `$` this pass might rewrite. */
function hasDollar(text: string): boolean {
  return text.includes("$");
}

/**
 * The index of the `$` that closes an inline formula opened at `open`, or -1.
 * TeX's rules, exactly as the native renderer applies them.
 */
function closingInlineDollar(text: string, open: number): number {
  const bodyStart = open + 1;
  if (bodyStart >= text.length || /\s/.test(text[bodyStart])) return -1;
  let sawNewline = false;
  for (let i = bodyStart; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "`") return -1;
    if (ch === "\n") {
      if (sawNewline) return -1;
      sawNewline = true;
      continue;
    }
    if (!/\s/.test(ch)) sawNewline = false;
    if (ch === "$") {
      const prev = text[i - 1];
      const next = text[i + 1];
      const followsDigit = next !== undefined && /[0-9]/.test(next);
      if (i > bodyStart && !/\s/.test(prev) && !followsDigit) return i;
      // A `$` that cannot close ends the search: a formula never holds a bare
      // dollar sign, so the opener was money.
      return -1;
    }
  }
  return -1;
}

/** A `$…$` run that opens on a figure and reads like prose is a price, not a formula. */
function looksLikeMoney(body: string): boolean {
  return /^[0-9]/.test(body) && /\s/.test(body) && !MATH_SIGNAL.test(body);
}

/** End (exclusive) of the inline code span opening at `start`, or -1 when it never closes. */
function codeSpanEnd(text: string, start: number): number {
  let run = 0;
  while (text[start + run] === "`") run += 1;
  const fence = "`".repeat(run);
  let i = start + run;
  while (i < text.length) {
    const at = text.indexOf(fence, i);
    if (at < 0) return -1;
    let end = at + run;
    // A longer run of backticks is not this span's closer.
    if (text[end] === "`") {
      while (text[end] === "`") end += 1;
      i = end;
      continue;
    }
    return end;
  }
  return -1;
}

/** Protects the dollars in one stretch of prose (no fenced code inside it). */
function protectProse(text: string): string {
  if (!hasDollar(text)) return text;
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "`") {
      const end = codeSpanEnd(text, i);
      if (end > 0) {
        out += text.slice(i, end);
        i = end;
        continue;
      }
      let run = 0;
      while (text[i + run] === "`") run += 1;
      out += text.slice(i, i + run);
      i += run;
      continue;
    }
    if (ch !== "$") {
      out += ch;
      i += 1;
      continue;
    }
    if (text[i + 1] === "$") {
      // Display maths: verbatim to its closer. An unclosed `$$` is left as is.
      const close = text.indexOf("$$", i + 2);
      if (close > i + 2) {
        out += text.slice(i, close + 2);
        i = close + 2;
      } else {
        out += "$$";
        i += 2;
      }
      continue;
    }
    const close = closingInlineDollar(text, i);
    if (close > 0 && !looksLikeMoney(text.slice(i + 1, close))) {
      out += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    out += CURRENCY_SENTINEL;
    i += 1;
  }
  return out;
}

/**
 * Swaps every currency `$` in Markdown for `CURRENCY_SENTINEL`, leaving real
 * maths, code and the string's length exactly as they were.
 */
export function protectCurrency(markdown: string): string {
  if (!hasDollar(markdown)) return markdown;
  const lines = markdown.split("\n");
  const out: string[] = [];
  let prose: string[] = [];
  let fence: { char: string; length: number } | null = null;
  const flush = () => {
    if (prose.length) out.push(protectProse(prose.join("\n")));
    prose = [];
  };
  for (const line of lines) {
    if (fence) {
      out.push(line);
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      flush();
      fence = { char: open[1][0], length: open[1].length };
      out.push(line);
      continue;
    }
    prose.push(line);
  }
  flush();
  return out.join("\n");
}

/** The sentinel back to a dollar sign. */
export function restoreCurrency(text: string): string {
  return text.includes(CURRENCY_SENTINEL) ? text.split(CURRENCY_SENTINEL).join("$") : text;
}

interface MdNode {
  type: string;
  value?: unknown;
  url?: unknown;
  title?: unknown;
  alt?: unknown;
  children?: MdNode[];
}

/**
 * The remark half: every string the parsed tree carries gets its dollars
 * back. Runs as a transform, after every syntax extension has parsed.
 */
export function remarkRestoreCurrency() {
  const walk = (node: MdNode) => {
    for (const key of ["value", "url", "title", "alt"] as const) {
      const value = node[key];
      if (typeof value === "string" && value.includes(CURRENCY_SENTINEL)) node[key] = restoreCurrency(value);
    }
    node.children?.forEach(walk);
  };
  return (tree: MdNode) => {
    walk(tree);
  };
}
