/**
 * HTML to readable text in one linear pass (SPEC §6.4 item 1, gap-web W2).
 *
 * This replaces the regular expressions `search-engine.ts` used to strip page
 * chrome, pick the main region, collect links and rewrite anchors. Each was a
 * lazy `[\s\S]*?` between an opening and a closing tag, so a page that opened a
 * `<nav>`, `<article>`, `<a href>` or `<script>` and never closed it made the
 * engine retry from every opening tag to the end of the document: quadratic in
 * the page size, on the server's one event loop, for bytes a stranger chose.
 * Four megabytes of `<nav>` held the process for minutes.
 *
 * The replacement is a tokenizer that walks the document once with `indexOf`,
 * followed by passes over the token list that are each linear too:
 *
 * - raw-text elements (`script`, `style`, `noscript`, `iframe`, `template`,
 *   `svg`, …) are dropped whole; `title` is kept as text, as before. When one is
 *   never closed, the opening tag is dropped and nothing else ("an unclosed
 *   opening tag strips nothing"), and the failed search is remembered so the
 *   next unclosed one of the same kind costs nothing ("never rescans");
 * - chrome (`nav`, `header`, `footer`, `aside`, `form`, `dialog`) and the main
 *   region (`article`, then `main`) are matched with a depth counter per tag,
 *   so a nested `<nav>` removes the whole outer one instead of leaving its tail;
 * - anchors follow the browser's rule that a new `<a>` ends the previous one,
 *   so an unclosed `<a href>` never swallows the links after it.
 *
 * The output keeps the old extractor's shape and its markdown-ish conversion
 * (headings, list items, quotes, emphasis, `[text](href)`), so Research and
 * Work read the same text they always did on well-formed pages
 * (`tests/web-extract.test.ts` holds the parity). Entities are now decoded
 * once, in one pass, where the old chain decoded `&amp;lt;` twice.
 *
 * `htmlToCleanTextAsync` yields to the event loop every 64 KB of input and
 * every few thousand tokens, so even the largest page Research accepts never
 * holds the loop for more than a few milliseconds at a time. A worker pool is
 * a follow-up (SPEC §14).
 *
 * Pure and free of `server-only`.
 */

import { isDisallowedHost } from "@/lib/search/url-safety";
import {
  assignedState,
  linkedDataToText,
  MAX_BLOB_CHARS,
  MAX_BLOBS,
  MAX_BLOBS_CHARS,
  scriptBlobKind,
  stateToText,
  type ScriptBlob,
} from "@/lib/web/embedded-data";
import { cellText, renderTable, spanOf, tableAsParagraphs, type TableCell, type TableRow } from "@/lib/web/html-table";
import { decodeHtmlEntities } from "@/lib/web/url-canon";

/** One outbound link kept from a fetched page, for the bounded hop stage. */
export interface PageLink {
  href: string;
  text: string;
}

export interface HtmlText {
  title?: string;
  text: string;
  author?: string;
  publishedAt?: Date;
  /** Resolved, SSRF-filtered, de-duplicated — in the order the page listed them. */
  links: PageLink[];
  /**
   * The markup says "client-rendered shell": an empty framework root, a plea to
   * enable JavaScript, a `<noscript>` that talks about JavaScript. Combine with
   * the text length through `looksLikeShell`.
   */
  shellMarkup: boolean;
  /**
   * Text that came from the page's data rather than its markup: `json-ld`
   * when JSON-LD added an article body, offers or an FAQ; `app-state` when the
   * visible text was a client-rendered shell and the framework's hydration
   * state held the page (`embedded-data.ts`). Absent when the markup alone was
   * read.
   */
  recovered?: "json-ld" | "app-state";
}

/** Links kept per page. Beyond this the tail is site navigation, not citations. */
export const MAX_PAGE_LINKS = 120;
/** Roughly how much visible text a `<main>`/`<article>` must hold to be believed. */
const MAIN_REGION_MIN_CHARS = 600;
/** Input consumed between two yields to the event loop. */
const YIELD_EVERY_CHARS = 64 * 1024;
/** Tokens processed between two yields in the passes after tokenizing. */
const YIELD_EVERY_TOKENS = 8 * 1024;

const TEXT = 0;
const OPEN = 1;
const CLOSE = 2;

interface Token {
  t: typeof TEXT | typeof OPEN | typeof CLOSE;
  /** Lowercase tag name; "" for text. */
  name: string;
  /** Text: the slice [start, end) of the document. Tags: unused. */
  start: number;
  end: number;
  /** Raw attribute text, kept only for the tags that are read later. */
  attrs?: string;
  selfClosing?: boolean;
}

/** Elements whose content is not markup: dropped whole (title aside, which is kept as text). */
const RAW_TEXT = new Set(["script", "style", "noscript", "iframe", "template", "svg", "math", "xmp", "noembed", "noframes", "title"]);
/** Page chrome, removed before anything else reads the body. */
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside", "form", "dialog"]);
const REGION_TAGS = ["article", "main"] as const;
/** Inline emphasis the conversion keeps as markdown, only when the element is closed. */
const EMPHASIS: Readonly<Record<string, string>> = { strong: "**", b: "**", em: "*", i: "*", code: "`" };
const HEADINGS: ReadonlySet<string> = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** Tags whose attributes are read after tokenizing. */
const KEEP_ATTRS = new Set(["a", "meta", "div", "td", "th"]);
/** Table structure the output pass lays out as a grid (`html-table.ts`). */
const TABLE_PARTS = new Set(["tr", "td", "th", "thead", "tbody", "tfoot", "caption"]);
/**
 * Below this much visible text a page is read with its app state appended
 * (when it ships one): a real page has said more than this in its markup.
 */
const APP_STATE_BELOW_CHARS = 600;
/** Recovered text shorter than this is configuration, not a page. */
const RECOVERED_MIN_CHARS = 200;

function isNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isNameChar(code: number): boolean {
  return isNameStart(code) || (code >= 48 && code <= 57) || code === 45 || code === 58 || code === 95;
}

/** `<` followed by this begins a tag, a comment, a doctype or a processing instruction. */
function startsMarkup(code: number): boolean {
  return code === 33 || code === 47 || code === 63 || isNameStart(code);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 12;
}

/**
 * Attribute values by lowercase name. Values are entity-decoded, quoted or
 * not. Linear in the attribute text; the first occurrence of a name wins, as in
 * a browser.
 */
export function parseAttributes(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = raw.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(raw.charCodeAt(i)) || raw[i] === "/")) i += 1;
    const nameStart = i;
    while (i < n && !isSpace(raw.charCodeAt(i)) && raw[i] !== "=" && raw[i] !== "/" && raw[i] !== ">") i += 1;
    if (i === nameStart) {
      i += 1;
      continue;
    }
    const name = raw.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(raw.charCodeAt(i))) i += 1;
    let value = "";
    if (raw[i] === "=") {
      i += 1;
      while (i < n && isSpace(raw.charCodeAt(i))) i += 1;
      const quote = raw[i];
      if (quote === '"' || quote === "'") {
        const close = raw.indexOf(quote, i + 1);
        const end = close < 0 ? n : close;
        value = raw.slice(i + 1, end);
        i = end + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(raw.charCodeAt(i)) && raw[i] !== ">") i += 1;
        value = raw.slice(valueStart, i);
      }
    }
    if (!out.has(name)) out.set(name, decodeHtmlEntities(value));
  }
  return out;
}

/** The markup signals of a client-rendered shell, as the old `isPotentialSpa` read them. */
const JS_PLEA = /enable javascript|javascript is required|requires javascript/i;
const FRAMEWORK_ROOT_IDS = new Set(["root", "app", "__next"]);

/** Whether a page is a client-rendered shell: too little text, or shell markup. */
export function looksLikeShell(textLength: number, shellMarkup: boolean): boolean {
  return textLength < 150 || shellMarkup;
}

interface Tokenized {
  tokens: Token[];
  title?: string;
  noscriptMentionsJs: boolean;
  /** JSON-LD and app-state blobs from `<script>` bodies, bounded (`embedded-data.ts`). */
  blobs: ScriptBlob[];
}

/**
 * Finds `</name` at or after `from`, case-insensitively, or -1. `misses`
 * remembers, per name, the position after which no closing tag exists, so a
 * document of a million unclosed `<script>`s is scanned once, not a million
 * times.
 */
function findClose(html: string, name: string, from: number, misses: Map<string, number>): number {
  const knownMiss = misses.get(name);
  if (knownMiss !== undefined && from >= knownMiss) return -1;
  for (let at = html.indexOf("</", from); at >= 0; at = html.indexOf("</", at + 2)) {
    if (html.length - at - 2 < name.length) break;
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() !== name) continue;
    const after = html.charCodeAt(at + 2 + name.length);
    if (Number.isNaN(after) || !isNameChar(after)) return at;
  }
  misses.set(name, Math.min(from, misses.get(name) ?? from));
  return -1;
}

/** The end (exclusive) of a tag that starts at `from`, quotes respected; the document's end if it never closes. */
function tagEnd(html: string, from: number): number {
  const n = html.length;
  let quote = 0;
  let lastNonSpace = 0;
  for (let j = from; j < n; j += 1) {
    const code = html.charCodeAt(j);
    if (quote) {
      if (code === quote) quote = 0;
      continue;
    }
    if ((code === 34 || code === 39) && lastNonSpace === 61) {
      quote = code;
      continue;
    }
    if (code === 62) return j + 1;
    if (!isSpace(code)) lastNonSpace = code;
  }
  return n;
}

function* tokenize(html: string): Generator<void, Tokenized> {
  const n = html.length;
  const tokens: Token[] = [];
  const misses = new Map<string, number>();
  let title: string | undefined;
  let noscriptMentionsJs = false;
  const blobs: ScriptBlob[] = [];
  let blobChars = 0;
  let nextYield = YIELD_EVERY_CHARS;
  let i = 0;

  const pushText = (start: number, end: number) => {
    if (end > start) tokens.push({ t: TEXT, name: "", start, end });
  };

  while (i < n) {
    if (i >= nextYield) {
      nextYield = i + YIELD_EVERY_CHARS;
      yield;
    }
    // A `<` that cannot start markup ("a < b") is text: skip it here rather
    // than emit a token per character, which a page of `<<<<` would exploit.
    let lt = html.indexOf("<", i);
    while (lt >= 0 && !startsMarkup(html.charCodeAt(lt + 1))) {
      if (lt >= nextYield) {
        nextYield = lt + YIELD_EVERY_CHARS;
        yield;
      }
      lt = html.indexOf("<", lt + 1);
    }
    if (lt < 0) {
      pushText(i, n);
      break;
    }
    pushText(i, lt);
    const next = html.charCodeAt(lt + 1);

    if (next === 33 /* ! */) {
      if (html.startsWith("<!--", lt)) {
        const close = html.indexOf("-->", lt + 4);
        i = close < 0 ? n : close + 3;
      } else {
        const gt = html.indexOf(">", lt + 2);
        i = gt < 0 ? n : gt + 1;
      }
      continue;
    }
    if (next === 63 /* ? */) {
      const gt = html.indexOf(">", lt + 2);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    if (next === 47 /* / */) {
      let j = lt + 2;
      if (!isNameStart(html.charCodeAt(j))) {
        // `</` not followed by a name is a bogus comment in HTML.
        const gt = html.indexOf(">", j);
        i = gt < 0 ? n : gt + 1;
        continue;
      }
      while (j < n && isNameChar(html.charCodeAt(j))) j += 1;
      const name = html.slice(lt + 2, j).toLowerCase();
      const gt = html.indexOf(">", j);
      i = gt < 0 ? n : gt + 1;
      tokens.push({ t: CLOSE, name, start: lt, end: i });
      continue;
    }
    let j = lt + 1;
    while (j < n && isNameChar(html.charCodeAt(j))) j += 1;
    const name = html.slice(lt + 1, j).toLowerCase();
    const end = tagEnd(html, j);
    // A tag cut off by the end of the document is dropped with it.
    if (end >= n && html.charCodeAt(n - 1) !== 62) {
      i = n;
      break;
    }
    const selfClosing = html.charCodeAt(end - 2) === 47;
    i = end;

    // `<script src=…/>` still opens a script in HTML; only foreign content
    // (`<svg/>`, `<math/>`) honours the self-closing slash.
    if (RAW_TEXT.has(name) && !(selfClosing && (name === "svg" || name === "math"))) {
      const close = findClose(html, name, end, misses);
      if (close >= 0) {
        const gt = html.indexOf(">", close);
        const after = gt < 0 ? n : gt + 1;
        if (name === "title") {
          // Kept as text, as the old extractor did, and read as the title once.
          if (title === undefined) {
            const value = decodeHtmlEntities(html.slice(end, close)).replace(/\s+/g, " ").trim();
            if (value) title = value;
          }
          tokens.push({ t: OPEN, name, start: lt, end });
          pushText(end, close);
          tokens.push({ t: CLOSE, name, start: close, end: after });
        } else if (name === "noscript" && !noscriptMentionsJs) {
          noscriptMentionsJs = /javascript/i.test(html.slice(end, close));
        } else if (name === "script" && close - end <= MAX_BLOB_CHARS && blobs.length < MAX_BLOBS && blobChars + (close - end) <= MAX_BLOBS_CHARS) {
          // The page's data: JSON-LD, a JSON island, or `window.__STATE__ = {…}`.
          const attrs = parseAttributes(html.slice(j, selfClosing ? end - 2 : end - 1));
          const kind = scriptBlobKind(attrs.get("type"), attrs.get("id"));
          if (kind) {
            const body = html.slice(end, close);
            blobChars += body.length;
            blobs.push({ kind, body, ...(attrs.get("id") ? { name: attrs.get("id") } : {}) });
          } else if (!attrs.has("src") && /__/.test(html.slice(end, Math.min(close, end + 200)))) {
            const assigned = assignedState(html.slice(end, close));
            if (assigned) {
              blobChars += assigned.json.length;
              blobs.push({ kind: "state", body: assigned.json, name: assigned.name });
            }
          }
        }
        i = after;
        continue;
      }
      // Unclosed: drop the opening tag and read on. `misses` makes this cheap.
      continue;
    }

    const token: Token = { t: OPEN, name, start: lt, end, ...(selfClosing ? { selfClosing } : {}) };
    if (KEEP_ATTRS.has(name)) token.attrs = html.slice(j, selfClosing ? end - 2 : end - 1);
    tokens.push(token);
  }

  return { tokens, ...(title !== undefined ? { title } : {}), noscriptMentionsJs, blobs };
}

/**
 * For each opening tag of the given names, the index of its matching close,
 * by a depth counter per name. Unmatched tags are absent: they strip nothing.
 */
function* pairTags(tokens: readonly Token[], names: ReadonlySet<string>): Generator<void, Map<number, number>> {
  const pairs = new Map<number, number>();
  const stacks = new Map<string, number[]>();
  for (let k = 0; k < tokens.length; k += 1) {
    if (k % YIELD_EVERY_TOKENS === 0 && k > 0) yield;
    const token = tokens[k];
    if (token.t === TEXT || !names.has(token.name)) continue;
    if (token.t === OPEN) {
      if (token.selfClosing) continue;
      const stack = stacks.get(token.name);
      if (stack) stack.push(k);
      else stacks.set(token.name, [k]);
    } else {
      const open = stacks.get(token.name)?.pop();
      if (open !== undefined) pairs.set(open, k);
    }
  }
  return pairs;
}

/**
 * Anchors, the way a browser closes them: a new `<a>` ends any open one. Maps
 * each `<a>` that is properly closed to its `</a>`; the rest render as a space.
 */
function* pairAnchors(tokens: readonly Token[]): Generator<void, Map<number, number>> {
  const pairs = new Map<number, number>();
  let open = -1;
  for (let k = 0; k < tokens.length; k += 1) {
    if (k % YIELD_EVERY_TOKENS === 0 && k > 0) yield;
    const token = tokens[k];
    if (token.name !== "a") continue;
    if (token.t === OPEN) open = token.selfClosing ? -1 : k;
    else if (token.t === CLOSE && open >= 0) {
      pairs.set(open, k);
      open = -1;
    }
  }
  return pairs;
}

/** Visible characters in tokens (from, to): tags as spaces, whitespace collapsed, trimmed. Stops at `enough`. */
function visibleLength(html: string, tokens: readonly Token[], keep: Uint8Array, from: number, to: number, enough: number): number {
  let count = 0;
  let started = false;
  let pendingSpace = false;
  for (let k = from + 1; k < to && count < enough; k += 1) {
    if (!keep[k]) continue;
    const token = tokens[k];
    if (token.t !== TEXT) {
      if (started) pendingSpace = true;
      continue;
    }
    for (let c = token.start; c < token.end; c += 1) {
      if (isSpace(html.charCodeAt(c))) {
        if (started) pendingSpace = true;
      } else {
        if (pendingSpace) count += 1;
        pendingSpace = false;
        count += 1;
        started = true;
      }
    }
  }
  return count;
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function* extract(html: string, baseUrl: string | undefined): Generator<void, HtmlText> {
  const { tokens, title, noscriptMentionsJs, blobs } = yield* tokenize(html);
  yield;

  // Metadata and shell markup come from the WHOLE document: <title> and
  // <meta> live in <head>, which the main-region pick below throws away.
  let author: string | undefined;
  let publishedAt: Date | undefined;
  let frameworkRoot = false;
  for (let k = 0; k < tokens.length; k += 1) {
    if (k % YIELD_EVERY_TOKENS === 0 && k > 0) yield;
    const token = tokens[k];
    if (token.t !== OPEN || token.attrs === undefined) continue;
    if (token.name === "meta" && (author === undefined || publishedAt === undefined)) {
      const attrs = parseAttributes(token.attrs);
      const content = attrs.get("content");
      if (!content) continue;
      const key = (attrs.get("name") ?? attrs.get("property") ?? attrs.get("itemprop") ?? attrs.get("http-equiv") ?? "").toLowerCase();
      if (publishedAt === undefined && /published_time|date|pubdate/.test(key) && Number.isFinite(Date.parse(content))) {
        publishedAt = new Date(content);
      } else if (author === undefined && key.includes("author")) {
        author = content.trim() || undefined;
      }
    } else if (token.name === "div" && !frameworkRoot && token.attrs.includes("id")) {
      const id = parseAttributes(token.attrs).get("id");
      if (id && FRAMEWORK_ROOT_IDS.has(id)) {
        const following = tokens[k + 1];
        const blankBetween = following?.t === TEXT && !html.slice(following.start, following.end).trim();
        const closeAt = blankBetween ? tokens[k + 2] : following;
        frameworkRoot = !!token.selfClosing || (closeAt?.t === CLOSE && closeAt.name === "div");
      }
    }
  }
  yield;

  // Chrome out, by a depth counter per tag. `keep[k]` is 0 for dropped
  // tokens; a removed element leaves its opening token behind as one space,
  // which is what the old replace put in its place.
  const keep = new Uint8Array(tokens.length).fill(1);
  const removed = new Set<number>();
  const structural = yield* pairTags(tokens, new Set([...CHROME_TAGS, ...REGION_TAGS]));
  for (let k = 0; k < tokens.length; k += 1) {
    if (k % YIELD_EVERY_TOKENS === 0 && k > 0) yield;
    const token = tokens[k];
    if (token.t !== OPEN || !CHROME_TAGS.has(token.name)) continue;
    const close = structural.get(k);
    if (close === undefined) continue;
    keep.fill(0, k + 1, close + 1);
    removed.add(k);
    k = close;
  }
  yield;

  // The part of the document that is the document: a kept <article>, then a
  // kept <main>, trusted only when it holds enough visible text to BE the page.
  let from = -1;
  let to = tokens.length;
  for (const region of REGION_TAGS) {
    let open = -1;
    for (let k = 0; k < tokens.length; k += 1) {
      if (k % YIELD_EVERY_TOKENS === 0 && k > 0) yield;
      if (keep[k] === 1 && tokens[k].t === OPEN && tokens[k].name === region) {
        open = k;
        break;
      }
    }
    if (open < 0) continue;
    const close = structural.get(open);
    if (close === undefined || !keep[close]) continue;
    if (visibleLength(html, tokens, keep, open, close, MAIN_REGION_MIN_CHARS) >= MAIN_REGION_MIN_CHARS) {
      from = open;
      to = close;
      break;
    }
  }
  yield;

  const anchors = yield* pairAnchors(tokens);
  const emphasis = yield* pairTags(tokens, new Set(Object.keys(EMPHASIS)));
  const closesEmphasis = new Set(emphasis.values());
  // A heading is converted only when it is closed; `<li>`'s end tag is
  // optional in HTML, so a list item never waits for one.
  const headings = yield* pairTags(tokens, HEADINGS);
  const closesHeading = new Set(headings.values());

  // Links, from the body region only: a footer sitemap would otherwise be the
  // top links on every page of the site and crowd out the ones the text cited.
  const links: PageLink[] = [];
  const seen = new Set<string>();
  const out: string[] = [];
  let anchor: { href: string; text: string[]; closeAt: number; collect: boolean } | null = null;
  let lineContext = 0; // > 0 inside a heading: its text stays on one line

  /*
   * The outermost open table, laid out as a grid when it closes
   * (`html-table.ts`). Cells collect their own text; a table nested inside a
   * cell flows into that cell as text. `</td>`, `</tr>` and `</thead>` are
   * optional in HTML, so a new cell or row closes the previous one.
   */
  let table: {
    rows: TableRow[];
    row: TableCell[] | null;
    rowHead: boolean;
    cell: { parts: string[]; header: boolean; colspan: number; rowspan: number } | null;
    loose: string[];
    head: boolean;
    nested: number;
  } | null = null;
  let afterTerm = false; // the last <dl> item was a <dd>: a second value joins with ";"
  const emit = (piece: string) => {
    if (!table) out.push(piece);
    else if (table.cell) table.cell.parts.push(piece);
    else table.loose.push(piece);
  };
  const endCell = () => {
    if (!table?.cell) return;
    const { parts, header, colspan, rowspan } = table.cell;
    (table.row ??= []).push({ text: cellText(parts.join("")), header, colspan, rowspan });
    table.cell = null;
  };
  const endRow = () => {
    if (!table) return;
    endCell();
    if (table.row?.length) table.rows.push({ cells: table.row, head: table.rowHead });
    table.row = null;
  };
  const endTable = () => {
    if (!table) return;
    endRow();
    const current = table;
    table = null;
    const caption = flatten(current.loose.join(" "));
    const markdown = renderTable(current.rows);
    out.push("\n\n");
    if (caption) out.push(`${caption}\n\n`);
    out.push(markdown ?? tableAsParagraphs(current.rows));
    out.push("\n\n");
  };

  for (let k = from + 1; k < to; k += 1) {
    if (k % YIELD_EVERY_TOKENS === 0) yield;
    if (!keep[k]) continue;
    const token = tokens[k];

    if (token.t === TEXT) {
      let piece = decodeHtmlEntities(html.slice(token.start, token.end));
      // A plain replace, not `\s*\n\s*`: that pattern is quadratic on a long
      // run of spaces, which is exactly what a hostile page would send.
      if (lineContext > 0) piece = piece.replace(/\r?\n/g, " ");
      emit(piece);
      if (anchor?.collect && anchor.text.length < 64) anchor.text.push(piece);
      continue;
    }

    const name = token.name;
    const inCell = !!table?.cell;
    // Table structure first: the outermost table only.
    if (name === "table") {
      if (token.t === OPEN && !token.selfClosing) {
        if (table) table.nested += 1;
        else table = { rows: [], row: null, rowHead: false, cell: null, loose: [], head: false, nested: 0 };
        emit(" ");
      } else if (token.t === CLOSE && table) {
        if (table.nested > 0) {
          table.nested -= 1;
          emit(" ");
        } else endTable();
      } else emit(" ");
      continue;
    }
    if (table && TABLE_PARTS.has(name)) {
      if (table.nested > 0) {
        emit(" ");
        continue;
      }
      if (token.t === OPEN) {
        if (name === "thead") table.head = true;
        else if (name === "tbody" || name === "tfoot") {
          endRow();
          table.head = false;
        } else if (name === "tr") {
          endRow();
          table.row = [];
          table.rowHead = table.head;
        } else if (name === "td" || name === "th") {
          endCell();
          if (!table.row) {
            table.row = [];
            table.rowHead = table.head;
          }
          const attrs = token.attrs !== undefined ? parseAttributes(token.attrs) : undefined;
          table.cell = { parts: [], header: name === "th", colspan: spanOf(attrs?.get("colspan")), rowspan: spanOf(attrs?.get("rowspan")) };
        }
        // <caption> text lands in `loose` and is written above the table.
      } else {
        if (name === "td" || name === "th") endCell();
        else if (name === "tr") endRow();
        else if (name === "thead") {
          endRow();
          table.head = false;
        }
      }
      continue;
    }

    if (token.t === OPEN) {
      if (removed.has(k)) {
        emit(" ");
        continue;
      }
      if (name === "a") {
        const paired = anchors.get(k);
        // Closed, and closed where this pass will see it: kept and inside the region.
        const close = paired !== undefined && keep[paired] === 1 && paired < to ? paired : undefined;
        const href = close !== undefined && token.attrs !== undefined ? parseAttributes(token.attrs).get("href") : undefined;
        if (close === undefined || href === undefined) {
          emit(" ");
          continue;
        }
        // Inside a cell the link's words are the value; the href is still collected.
        if (!inCell) emit("[");
        anchor = { href, text: [], closeAt: close, collect: !!baseUrl && links.length < MAX_PAGE_LINKS };
        continue;
      }
      if (inCell) {
        // A cell is one line: block structure inside it is a space.
        if (EMPHASIS[name] && emphasis.has(k)) emit(EMPHASIS[name]);
        else emit(" ");
        continue;
      }
      if (HEADINGS.has(name) && headings.has(k)) {
        emit(name <= "h3" ? "\n\n## " : "\n\n### ");
        lineContext += 1;
      } else if (name === "li") emit("\n- ");
      else if (name === "dt") {
        emit("\n- ");
        afterTerm = false;
      } else if (name === "dd") {
        emit(afterTerm ? "; " : ": ");
        afterTerm = true;
      } else if (name === "p") emit("\n\n");
      else if (name === "blockquote") emit("\n> ");
      else if (name === "br") emit("\n");
      else if (name === "hr") emit("\n---\n");
      else if (EMPHASIS[name] && emphasis.has(k)) emit(EMPHASIS[name]);
      else emit(" ");
      continue;
    }

    // Closing tags.
    if (name === "a") {
      if (anchor && anchor.closeAt === k) {
        if (!inCell) emit(`](${anchor.href})`);
        if (anchor.collect && baseUrl) {
          let resolved: string | null = null;
          try {
            resolved = new URL(anchor.href, baseUrl).toString();
          } catch {
            resolved = null;
          }
          // The same guard the fan-out applies to search results. A page is an
          // untrusted party handing us URLs, and this is the one that reaches fetch().
          if (resolved && !isDisallowedHost(resolved) && !seen.has(resolved) && links.length < MAX_PAGE_LINKS) {
            seen.add(resolved);
            links.push({ href: resolved, text: flatten(anchor.text.join(" ")).slice(0, 200) });
          }
        }
        anchor = null;
      } else emit(" ");
      continue;
    }
    if (inCell) {
      if (EMPHASIS[name] && closesEmphasis.has(k)) emit(EMPHASIS[name]);
      else emit(" ");
      if (HEADINGS.has(name) && closesHeading.has(k)) lineContext = Math.max(0, lineContext - 1);
      continue;
    }
    if (HEADINGS.has(name) && closesHeading.has(k)) {
      emit("\n\n");
      lineContext = Math.max(0, lineContext - 1);
    } else if (name === "li" || name === "dd" || name === "dt") {
      // Nothing: the next item starts its own line.
    } else if (name === "dl") {
      emit("\n\n");
      afterTerm = false;
    } else if (name === "p") emit("\n\n");
    else if (name === "blockquote") emit("\n");
    else if (EMPHASIS[name] && closesEmphasis.has(k)) emit(EMPHASIS[name]);
    else emit(" ");
  }
  // A table the region never closed is still a table.
  endTable();
  yield;

  // Normalise spacing exactly as the old extractor did: trim each line, keep a
  // blank line only after a non-blank one, collapse runs, trim the whole.
  const lines = out.join("").split("\n");
  const kept: string[] = [];
  let previousRaw = "";
  for (let k = 0; k < lines.length; k += 1) {
    if (k % (YIELD_EVERY_TOKENS * 8) === 0 && k > 0) yield;
    const line = lines[k].trim();
    if (line || (k > 0 && previousRaw)) kept.push(line);
    previousRaw = line;
  }
  let text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  yield;

  /*
   * The page's data (embedded-data.ts). JSON-LD is read on every page: an
   * article body the markup did not render, offers with prices, an FAQ —
   * each appended only when the visible text does not already hold it — and
   * its date and author fill the gaps the <meta> tags left. A framework's
   * hydration state is read only when the markup was a shell, because on a
   * server-rendered page it repeats the text and adds plumbing.
   */
  let recovered: HtmlText["recovered"];
  if (blobs.length > 0) {
    const ld = linkedDataToText(blobs);
    publishedAt ??= ld.publishedAt;
    author ??= ld.author;
    const extra: string[] = [];
    if (ld.articleBody && !text.includes(ld.articleBody.slice(0, 80))) extra.push(ld.articleBody);
    const ldLines = ld.text
      .split("\n")
      .filter((line) => !line.trim() || line.startsWith("|") || !text.includes(line.replace(/^[A-Z][\w ]{0,30}: /, "").slice(0, 120)));
    if (ldLines.some((line) => line.trim() && !line.startsWith("Headline:"))) extra.push(ldLines.join("\n").trim());
    const before = text.length;
    if (text.length < APP_STATE_BELOW_CHARS) {
      const state = stateToText(blobs);
      if (state.length >= RECOVERED_MIN_CHARS) {
        extra.push(state);
        recovered = "app-state";
      }
    }
    const added = extra.join("\n\n").trim();
    if (added) {
      text = [text, added].filter(Boolean).join("\n\n");
      if (!recovered && text.length - before >= RECOVERED_MIN_CHARS / 2) recovered = "json-ld";
      if (!recovered && before < RECOVERED_MIN_CHARS && text.length >= RECOVERED_MIN_CHARS) recovered = "json-ld";
    }
  }

  return {
    ...(title !== undefined ? { title } : {}),
    text,
    ...(author !== undefined ? { author } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
    links,
    shellMarkup: frameworkRoot || noscriptMentionsJs || JS_PLEA.test(html),
    ...(recovered ? { recovered } : {}),
  };
}

/**
 * Clean and convert raw HTML into readable structured markdown text.
 *
 * `baseUrl` is what turns the page's relative hrefs into followable links; omit
 * it and `links` comes back empty rather than full of unusable fragments.
 * Synchronous; for anything a stranger could have sent, prefer the async form,
 * which keeps the event loop responsive while it works.
 */
export function htmlToCleanText(html: string, baseUrl?: string): HtmlText {
  const steps = extract(html, baseUrl);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof setImmediate === "function") setImmediate(resolve);
    else setTimeout(resolve, 0);
  });

/**
 * `htmlToCleanText`, yielding to the event loop between slices of work, and
 * stopping with an AbortError as soon as `signal` aborts.
 */
export async function htmlToCleanTextAsync(html: string, baseUrl?: string, signal?: AbortSignal): Promise<HtmlText> {
  const steps = extract(html, baseUrl);
  for (;;) {
    if (signal?.aborted) throw abortError();
    const step = steps.next();
    if (step.done) return step.value;
    await yieldToLoop();
  }
}
