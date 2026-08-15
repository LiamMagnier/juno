/**
 * A stored `report`'s markdown, prepared for the markdown renderer the app
 * already ships.
 *
 * Imported by a client component, so nothing heavy may enter this file. It is
 * imported by path rather than through `deliverables/index.ts` on purpose:
 * that barrel pulls in docx, exceljs and pptxgenjs, and a preview dialog must
 * not put three OOXML writers in the browser bundle to lay out a text file.
 *
 * ── Why a report does NOT go through the site frame ──────────────────────────
 *
 * `work-site-preview.tsx` puts a site bundle in an opaque-origin iframe under a
 * nonce CSP, and its header is careful to say the frame is where the bundle's
 * guarantees are ENFORCED rather than asserted. None of that argument carries
 * over here, because what is being rendered differs in kind.
 *
 * A site bundle is markup. Its bytes are parsed by the browser as elements, so
 * anything that reached those bytes is a candidate for execution and the only
 * reliable answer is to deny the document an origin and a network. Markdown is
 * not markup: `react-markdown` parses it to an mdast and builds a React tree,
 * and a `<script>` in the source becomes an mdast `html` node which — with no
 * `rehype-raw` anywhere in this repo — is handed to React as a STRING and comes
 * out as escaped text. There is no parse under which markdown TEXT becomes an
 * element.
 *
 * Putting it in the site frame would mean first rendering the markdown to HTML
 * so the frame had something to hold: manufacturing the exact markup the frame
 * exists to contain, in order to have a reason to contain it. The rejected
 * alternative in the other direction — "markdown feels safe, render it raw" —
 * is answered by the three paragraphs below, one per thing markdown can carry.
 *
 * ── Raw HTML ────────────────────────────────────────────────────────────────
 *
 * Escaped by the renderer, as above — and that is not leaned on. `<` is emitted
 * here as `&lt;`, so the string handed over produces no raw-HTML node at all
 * and the property holds whatever a later version of `hast-util-to-jsx-runtime`
 * decides a `raw` node should become. This is the same posture the site
 * previewer takes toward `assertSafeBundlePath`: these bytes came back out of
 * object storage, not out of the builder that was checked, and one library's
 * current behaviour is not a place to put the whole guarantee.
 *
 * It costs no fidelity. `&lt;` renders as the `<` the file has, so a report
 * whose source data contained `<script>` shows the reader that text — which is
 * also what report.ts intended, since `escapeMarkdownInline` wrote it as `\<`.
 *
 * ── Links ───────────────────────────────────────────────────────────────────
 *
 * Left alone, deliberately. A link is inert until it is clicked; react-markdown's
 * default `urlTransform` already drops `javascript:` and friends; and the chat
 * renderer's own `a` component sends every one to a new tab with
 * `rel="noopener noreferrer"`. `sourcesMarkdown` in report.ts writes the
 * citations a reviewer is meant to follow, so removing them would remove the
 * part of a report that makes it checkable.
 *
 * ── Images: the one real difference ─────────────────────────────────────────
 *
 * An `<img src="https://…">` is fetched when the preview PAINTS, and the app's
 * CSP admits `img-src … https:` (src/lib/csp.ts, which admits it on purpose so
 * source chips can load each source's own favicon). That is precisely the
 * property `site.ts` designs the bundle format NOT to have — "it cannot report
 * to anyone that it was opened" — and it must not be surrendered by the one
 * preview whose renderer is the app's own.
 *
 * So a `!` that would open an image is emitted as `&#33;`. `![alt](url)` becomes
 * a literal `!` followed by a LINK to the same url; `![alt][ref]` becomes `!`
 * followed by the same link reference. Nothing is fetched on paint, the url
 * stays visible and one click away, and not one character is invented. The
 * alternative of substituting a placeholder ("[image]") was rejected because it
 * puts words in a document that a reader is previewing precisely to check.
 *
 * ── Why the text is rewritten at all: the renderer is a CHAT renderer ────────
 *
 * `src/components/chat/markdown.tsx` is tuned for what a model streams into a
 * conversation, and two of those accommodations silently corrupt a report file:
 *
 *   `remark-math`. "Revenue was $1.2M in Q1 and $3.4M in Q2." parses as
 *   text("Revenue was ") + inlineMath("1.2M in Q1 and ") + text("3.4M in Q2."),
 *   so the preview of a figures report shows the currency markers DELETED and
 *   the span between them re-typeset by KaTeX. Every `$` outside code is
 *   therefore emitted as `&#36;` — invisible to remark-math, and rendered as
 *   the dollar sign the file actually holds. Nothing is lost by disabling math:
 *   `documentBlockSchema` has no math block, so no report contains any.
 *
 *   `normalizeMathDelimiters`. It rewrites `\[`→`$$` and `\(`→`$`, because
 *   models emit LaTeX in that form. But `report.ts` escapes `[` and `]` as
 *   `\[` `\]` in every string it writes, so a paragraph reading
 *   "See \[note\] below" is rewritten to "See $$note$$ below" and displayed as
 *   a centred equation reading "note". Those four escapes are emitted as
 *   `&#91;` `&#93;` `&#40;` `&#41;` instead: identical rendered character, no
 *   backslash left for that pass to find.
 *
 * Both failures are pinned in tests/work-report-preview.test.ts against the same
 * remark stack the component assembles, rather than asserted in this comment.
 *
 * ── Where the rewrite must NOT reach ────────────────────────────────────────
 *
 * Inside a fenced code block or an inline code span, character references are
 * not decoded — `&#36;` inside a fence renders as the eight characters
 * `&#36;`. Code regions are therefore copied byte for byte, which is also the
 * correct answer on fidelity grounds: the text of a code block is data the
 * report is quoting, and a previewer that edits it is lying about the file.
 *
 * Two residues are accepted rather than papered over:
 *
 *   `normalizeMathDelimiters` splits inline code with `/(`[^`]*`)/g`, which only
 *   understands SINGLE-backtick spans. A report's code run is fenced with two
 *   backticks when the code itself contains one (see `inlineMarkdown`), so a
 *   span that holds both a backtick and a `\[` can still be mis-segmented by
 *   that pass and have the escape rewritten inside it. Reaching it would mean
 *   rewriting the span's own delimiters, and a code span whose text this
 *   previewer edited is a worse lie than a stray `$$` inside one.
 *
 *   A fence whose info string is `mermaid` or one of the `juno-visual` aliases
 *   is rendered by the chat renderer as a diagram or a card rather than as
 *   code, where `renderBlocksHtml` would have shown a `<pre>`. That is the
 *   renderer the product uses for markdown everywhere; forcing it back to code
 *   would mean rewriting the fence's info string, which is again this previewer
 *   editing the file rather than showing it.
 */

/**
 * How much of a report is laid out in the preview.
 *
 * `ARTIFACT_MAX_BYTES.report` is 5 MB, and handing five megabytes of markdown
 * to react-markdown blocks the main thread long enough that the dialog appears
 * to have hung — the preview would cost more than the download it exists to
 * save. 200 000 characters is roughly sixty pages of prose, which is well past
 * where somebody is checking whether a report is any good and into where they
 * are reading it, and the cut is stated on screen rather than hidden.
 */
export const REPORT_PREVIEW_MAX_CHARS = 200_000;

export interface ReportPreviewText {
  /** Safe to hand to `<Markdown>`; means what the file means. */
  markdown: string;
  /** True when the file continues past what is laid out. Said on screen. */
  truncated: boolean;
  /** Image references shown as links instead of loaded. Said on screen when > 0. */
  imageRefs: number;
}

/** An open fence: which character opened it and how long the run was. */
interface Fence {
  char: string;
  length: number;
}

/**
 * Fence state after this line, by the same rules as
 * `src/components/chat/markdown.tsx`.
 *
 * Copied rather than imported because that helper is private to a `"use client"`
 * component full of React, and this module is also read by `tsx --test`, which
 * cannot parse JSX. The rules have to AGREE with that file — the two passes run
 * one after the other over the same string — so any change here belongs there
 * too, which is what tests/work-report-preview.test.ts checks by feeding both.
 */
function trackFence(fence: Fence | null, line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return fence;
  const marker = match[1];
  const rest = line.slice(match[0].length);
  if (fence) {
    const closes = marker[0] === fence.char && marker.length >= fence.length && rest.trim() === "";
    return closes ? null : fence;
  }
  // A backtick fence's info string cannot itself contain a backtick, which is
  // what keeps an inline ```code``` from being read as the start of a block.
  if (marker[0] === "`" && rest.includes("`")) return fence;
  return { char: marker[0], length: marker.length };
}

/**
 * Index of the run of exactly `length` backticks that closes a code span, or -1.
 *
 * "Exactly" is CommonMark's rule and it matters: in ``` `` a`b `` ``` the single
 * backtick in the middle must not close a span the double opened, or the rest of
 * the line would be rewritten as if it were prose.
 */
function closingBacktickRun(line: string, from: number, length: number): number {
  let i = from;
  while (i < line.length) {
    if (line[i] !== "`") {
      i += 1;
      continue;
    }
    let run = 1;
    while (line[i + run] === "`") run += 1;
    if (run === length) return i;
    i += run;
  }
  return -1;
}

/**
 * Backslash escapes re-expressed as the character references that render
 * identically, keyed by the character the backslash protects.
 *
 * The first four are the LaTeX delimiters `normalizeMathDelimiters` rewrites.
 * The fifth is an escaped BACKSLASH, and it is here because of a case the other
 * four do not cover: `\\[link](url)` is a literal backslash followed by a real
 * link, and leaving the pair intact leaves the two characters `\[` sitting in
 * the output for that pass's `/\\\[/g` to find and rewrite into `$$` — turning
 * the link's opening bracket into the start of an equation. Emitting `&#92;`
 * means no backslash survives next to a bracket to be misread as one.
 */
const ESCAPE_REFS: Record<string, string> = {
  "[": "&#91;",
  "]": "&#93;",
  "(": "&#40;",
  ")": "&#41;",
  "\\": "&#92;",
};

/** One line of prose. Code spans inside it are copied, never rewritten. */
function rewriteLine(line: string, counters: { imageRefs: number }): string {
  let out = "";
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === "\\") {
      const next = line[i + 1];
      if (next === undefined) {
        out += char;
        i += 1;
        continue;
      }
      // Both characters are consumed together, which is what keeps `\\[` from
      // being read as an escaped backslash and then, one character later, as an
      // escaped bracket that is not there. Escapes with no entry in the table —
      // `\*`, `\_`, `` \` ``, `\<`, `\>` — pass through untouched: nothing
      // downstream mistakes them for anything, and rewriting them would be
      // churn for its own sake.
      const ref = ESCAPE_REFS[next];
      out += ref ?? `${char}${next}`;
      i += 2;
      continue;
    }

    if (char === "`") {
      let run = 1;
      while (line[i + run] === "`") run += 1;
      const close = closingBacktickRun(line, i + run, run);
      if (close === -1) {
        // An unmatched run is literal text, not a span; nothing after it is code.
        out += "`".repeat(run);
        i += run;
        continue;
      }
      out += line.slice(i, close + run);
      i = close + run;
      continue;
    }

    if (char === "$") {
      out += "&#36;";
      i += 1;
      continue;
    }

    if (char === "<") {
      out += "&lt;";
      i += 1;
      continue;
    }

    // `>` is deliberately absent: it cannot open a tag, and it leads every
    // blockquote `report.ts` writes. Escaping it would turn quoted passages
    // into paragraphs beginning with a stray angle bracket.

    if (char === "!" && line[i + 1] === "[") {
      counters.imageRefs += 1;
      out += "&#33;";
      i += 1;
      continue;
    }

    out += char;
    i += 1;
  }

  return out;
}

/**
 * A report's stored markdown, as a string that means the same thing to the chat
 * renderer that the file means to a plain markdown reader.
 *
 * Line by line, because that is how `normalizeMathDelimiters` works and the two
 * passes have to agree on which regions are code. A code span that crosses a
 * newline is therefore treated as ending at the newline by both, which is the
 * one place CommonMark is not followed and the place where following it alone
 * would put the two passes at odds.
 */
export function prepareReportPreview(source: string): ReportPreviewText {
  const lines = source.split("\n");
  const counters = { imageRefs: 0 };
  const kept: string[] = [];
  let consumed = 0;
  let truncated = false;

  for (const line of lines) {
    // The budget is spent in the FILE's characters, not the rewritten ones, so
    // "the first N characters" on screen describes the document rather than
    // this function's output — a paragraph dense in `$` inflates by five
    // characters each and would otherwise silently shorten what is shown.
    if (consumed > 0 && consumed + line.length + 1 > REPORT_PREVIEW_MAX_CHARS) {
      truncated = true;
      break;
    }
    kept.push(line);
    consumed += line.length + 1;
  }

  // A single line past the whole budget — a one-line table row of a generated
  // report, or a minified blob inside a fence — would otherwise be kept in full
  // and defeat the cap it just failed.
  if (kept.length === 1 && kept[0].length > REPORT_PREVIEW_MAX_CHARS) {
    kept[0] = kept[0].slice(0, REPORT_PREVIEW_MAX_CHARS);
    truncated = true;
  }

  const out: string[] = [];
  let fence: Fence | null = null;
  for (const line of kept) {
    const wasInFence = fence !== null;
    fence = trackFence(fence, line);
    // The opening and closing marker lines count as code along with the body:
    // an info string is a language name, not prose, and rewriting it would
    // change which highlighter the renderer picks.
    out.push(wasInFence || fence !== null ? line : rewriteLine(line, counters));
  }

  return { markdown: out.join("\n"), truncated, imageRefs: counters.imageRefs };
}
