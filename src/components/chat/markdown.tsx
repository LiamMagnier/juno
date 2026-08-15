"use client";

import * as React from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { AicssCodeBlock, splitHighlightedLines } from "@/components/aicss/code-block";
import { InlineVisualBlock } from "@/components/chat/inline-visual-block";
import { MermaidBlock } from "@/components/chat/learning/mermaid-block";
import { SourceChip } from "@/components/chat/source-chip";
import { cn } from "@/lib/utils";
import type { ClientSource } from "@/types/chat";

/** Pull the `language-xxx` hint rehype-highlight writes onto the inner <code>. */
function langOf(children: React.ReactNode): string {
  const child = React.Children.toArray(children)[0] as
    | React.ReactElement<{ className?: string }>
    | undefined;
  const cls = child?.props?.className ?? "";
  return /language-([\w-]+)/.exec(cls)?.[1] ?? "";
}

function textOf(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function isVisualLang(lang: string): boolean {
  return ["juno-visual", "juno-ui", "juno-block", "visual", "visual-block"].includes(lang.toLowerCase());
}

type Fence = { char: string; length: number };

/** CommonMark-ish fence tracking: fence state after seeing `line`. */
function trackFence(fence: Fence | null, line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return fence;
  const marker = match[1];
  const rest = line.slice(match[0].length);
  if (fence) {
    const closes = marker[0] === fence.char && marker.length >= fence.length && rest.trim() === "";
    return closes ? null : fence;
  }
  // A backtick fence's info string can't contain backticks (e.g. inline ```code```).
  if (marker[0] === "`" && rest.includes("`")) return fence;
  return { char: marker[0], length: marker.length };
}

/**
 * Normalize the `\(…\)` / `\[…\]` LaTeX delimiters many models emit into the
 * `$…$` / `$$…$$` form remark-math understands — leaving fenced code blocks and
 * inline code spans untouched so literal backslash-brackets in code survive.
 */
function normalizeMathDelimiters(markdown: string): string {
  if (!markdown.includes("\\(") && !markdown.includes("\\[")) return markdown;
  let fence: Fence | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const wasInFence = fence !== null;
      fence = trackFence(fence, line);
      // Leave fence markers and any line inside a fenced block verbatim.
      if (wasInFence || fence !== null) return line;
      // Transform only the segments outside inline code spans. In a JS replacement
      // string `$$` is a literal `$`, so `$$$$` emits `$$` and `$$` emits `$`.
      return line
        .split(/(`[^`]*`)/g)
        .map((seg) =>
          seg.startsWith("`")
            ? seg
            : seg
                .replace(/\\\[/g, "$$$$")
                .replace(/\\\]/g, "$$$$")
                .replace(/\\\(/g, "$$")
                .replace(/\\\)/g, "$$"),
        )
        .join("");
    })
    .join("\n");
}

interface SourceBlock {
  text: string;
  /** Where this block's first character sits in the markdown it was cut from. */
  offset: number;
}

/**
 * Split raw markdown into stable top-level blocks — on blank lines, keeping
 * fenced code intact and indented continuations (nested list content) attached —
 * so streaming only re-parses the final, still-growing block.
 *
 * Each block carries the offset it was cut at, which is what lets a character
 * position in the SOURCE be turned back into an element in the rendered DOM
 * (see `rehypeSourceOffsets`). Without it every block's parse positions start
 * again at zero and the twelfth paragraph of a report claims to begin at
 * character 0, which is the same answer as the first paragraph.
 */
function splitIntoBlocks(markdown: string): SourceBlock[] {
  const lines = markdown.split("\n");
  const blocks: SourceBlock[] = [];
  let current: string[] = [];
  // Offset of the first line held in `current`, and of the line being read.
  let start = 0;
  let cursor = 0;
  let fence: Fence | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = cursor;
    // `split("\n")` ate one character per line; the offsets have to put it back.
    cursor += line.length + 1;
    const wasInFence = fence !== null;
    fence = trackFence(fence, line);
    if (!wasInFence && fence === null && line.trim() === "") {
      if (current.length === 0) continue;
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      // An indented follow-up line continues the current block (list/quote content).
      if (next !== undefined && /^[ \t]/.test(next)) current.push(line);
      else {
        blocks.push({ text: current.join("\n"), offset: start });
        current = [];
      }
      continue;
    }
    if (current.length === 0) start = lineStart;
    current.push(line);
  }
  if (current.length > 0) blocks.push({ text: current.join("\n"), offset: start });
  return blocks;
}

/**
 * Cheaply close dangling markdown in the still-growing final block so streaming
 * text doesn't flash raw fences, backticks, or `**` markers.
 */
function closeDangling(block: string): string {
  let fence: Fence | null = null;
  for (const line of block.split("\n")) fence = trackFence(fence, line);
  if (fence) return `${block}\n${fence.char.repeat(fence.length)}`;
  let closed = block;
  if ((closed.match(/(?<!\\)`/g) ?? []).length % 2 === 1) closed += "`";
  // Count `**` outside code spans so `a ** b` in inline code doesn't miscount.
  const inline = closed.replace(/(?<!\\)`[^`]*`/g, "");
  if ((inline.match(/\*\*/g) ?? []).length % 2 === 1) closed += "**";
  // Close a dangling math delimiter (display `$$` before inline `$`) so KaTeX
  // source doesn't flash raw while the expression is still streaming in.
  const math = inline.replace(/\\\$/g, "");
  if ((math.match(/\$\$/g) ?? []).length % 2 === 1) closed += "$$";
  else if ((math.replace(/\$\$/g, "").match(/\$/g) ?? []).length % 2 === 1) closed += "$";
  return closed;
}

/**
 * A fenced block, in AIcss's numbered-gutter shell.
 *
 * What that replaced: a hairline frame with the language in the header and a
 * hover-revealed copy button over a plain <pre>. The frame and the one action
 * survive; the gutter is new, and it is the reason for the change — a model that
 * says "line 14" is now pointing at something the reader can find without
 * counting. Highlighting is preserved through `splitHighlightedLines`, which cuts
 * rehype-highlight's token tree at the newlines instead of re-highlighting per
 * line (which would break every multi-line string and block comment).
 */
function CodeBlock({ children, streaming }: { children: React.ReactNode; streaming?: boolean }) {
  const lang = langOf(children);
  const raw = textOf(children).replace(/\n$/, "");

  if (isVisualLang(lang)) {
    return <InlineVisualBlock source={raw} streaming={streaming} />;
  }

  const isMermaid = lang.toLowerCase() === "mermaid";
  if (isMermaid && !streaming) {
    return <MermaidBlock code={raw} />;
  }

  return (
    <AicssCodeBlock
      className="my-4"
      label={lang || "code"}
      code={raw}
      // Mid-stream, a fence's highlighting is re-derived on every delta and the
      // token tree churns; splitting the raw text is stable and identical to look
      // at until the closing fence lands.
      lines={streaming ? undefined : splitHighlightedLines(children)}
      maxBodyHeight={520}
      action={
        isMermaid ? (
          <span className="ml-auto px-2 py-1 font-mono text-caption text-muted-foreground/80">
            Diagram renders when complete…
          </span>
        ) : undefined
      }
    />
  );
}

/*
 * ---- Inline citations -------------------------------------------------------
 * `buildResearchContext` (deep-research.ts) hands the model a 1-based numbered
 * source list and asks it to cite as `[1]`/`[2][3]`, so on THAT path a marker maps
 * to `sources[n - 1]` BY POSITION. Those markers become favicon chips.
 *
 * It is the ONLY path with that contract. `buildSearchContext` (web-search.ts) has
 * the same shape but zero call sites — it is dead code, so citing it as
 * justification would be citing something that never runs. On the native-search
 * paths (Claude/Gemini/xAI provider tools) sources arrive from grounding metadata
 * and the model is never shown an index, so a `[1]` there is coincidental prose and
 * resolving it positionally would attach a confidently WRONG source to a claim.
 *
 * Hence chips render only for sources flagged `cited` (see ClientSource). Anything
 * unflagged, unresolvable, or out of range stays literal text.
 */

/** mdast doesn't model custom nodes, so the walk uses a structural shape instead. */
type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, string> };
};

const CITATION_RE = /\[(\d{1,3})\]/g;

/**
 * The marker a rendered citation chip wears in the DOM.
 *
 * A constant rather than the literal it was, because it is now load-bearing in
 * two places at once: it is how a chip is recognised on the way IN, and how it
 * is skipped on the way back OUT (`readAnchoredText` below). A chip is text the
 * RENDERER injected — it draws its source number as a digit — so a paragraph
 * ending "…rose sharply[3]." reads back as "…rose sharply3." unless it is left
 * out, and then matches no claim the audit ever extracted.
 */
const CITATION_ATTR = "data-cite";

/** Citation-marked pieces of `value`, or null when it holds no resolvable marker. */
function splitCitations(value: string, sourceCount: number): MdNode[] | null {
  if (!value.includes("[")) return null;
  const out: MdNode[] = [];
  let last = 0;
  CITATION_RE.lastIndex = 0;
  for (let m = CITATION_RE.exec(value); m; m = CITATION_RE.exec(value)) {
    const index = Number(m[1]);
    // Models invent indices past the list they were given. Leave those as the
    // literal text the model wrote rather than render a chip pointing nowhere.
    if (index < 1 || index > sourceCount) continue;
    if (m.index > last) out.push({ type: "text", value: value.slice(last, m.index) });
    out.push({
      type: "junoCitation",
      // An unknown mdast node carrying hName/hProperties survives mdast→hast as
      // this element, which the `span` component below picks back up.
      data: { hName: "span", hProperties: { [CITATION_ATTR]: String(index) } },
      children: [],
    });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return null;
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

function remarkCitations(sourceCount: number) {
  const walk = (node: MdNode) => {
    const children = node.children;
    if (!children) return;
    // Inline code and math arrive as value-bearing nodes (not `text`), so they're
    // skipped for free. Link labels are skipped deliberately: a chip nested in
    // another link would be an unclickable link inside a link.
    if (node.type === "link" || node.type === "linkReference" || node.type === "definition") return;

    const out: MdNode[] = [];
    let changed = false;
    for (let i = 0; i < children.length; ) {
      if (children[i].type !== "text") {
        walk(children[i]);
        out.push(children[i]);
        i++;
        continue;
      }
      // Coalesce the whole run of adjacent text nodes before matching: micromark
      // can split a literal `[7]` across siblings when an earlier `[` fails to
      // resolve as a link, and a split marker still has to match.
      const start = i;
      let value = "";
      while (i < children.length && children[i].type === "text") value += children[i++].value ?? "";
      const pieces = splitCitations(value, sourceCount);
      if (pieces) {
        out.push(...pieces);
        changed = true;
      } else {
        out.push(...children.slice(start, i));
      }
    }
    if (changed) node.children = out;
  };
  return function attacher() {
    return function transformer(tree: MdNode) {
      walk(tree);
    };
  };
}

const REMARK_PLUGINS = [remarkGfm, remarkMath] satisfies Options["remarkPlugins"];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  [rehypeHighlight, { detect: true, ignoreMissing: true }],
  // `throwOnError: false` keeps a malformed/incomplete expression (common mid-stream)
  // as red source text instead of crashing the whole render.
  [rehypeKatex, { throwOnError: false, output: "htmlAndMathml" }],
];

/*
 * ---- Streaming word entrance ------------------------------------------------
 * Each word of the still-growing final block mounts inside a span that plays
 * one short blur/fade on the token vocabulary (--dur-base sits inside the
 * 150–300ms band where this reads as text arriving rather than as the UI
 * lagging). It composes with the stream-tail mask and the caret in globals.css
 * instead of replacing them: the mask dims the unsettled LINE, this fades the
 * arriving WORD, and neither needs to know the other exists.
 *
 * WHY THIS DOES NOT STROBE, even though the tail block is re-parsed on every
 * delta: words are wrapped from the block's first character and are never
 * unwrapped mid-stream, so the rendered child list only ever APPENDS.
 * hast-util-to-jsx-runtime keys siblings per tag-name position ("span-3"), and
 * an append-only list never shifts those positions — so React updates every
 * existing span in place, and a CSS animation restarts only when its element
 * actually re-enters the DOM. Each word animates exactly once, on arrival; the
 * still-growing last word keeps updating its text inside its original span and
 * keeps its timeline. (Unwrapping settled words early would slide every later
 * span down a slot and replay its entrance — THAT, not the wrapping, is what
 * would strobe.)
 *
 * Zero residue: everything is gated on `animateTail`, true only for the final
 * block of a streaming message, so completion re-renders the message with no
 * spans, no classes and no <style> — the DOM of a finished message is
 * identical to one that never streamed.
 */

/* The rule lives here rather than in globals.css because it should exist for
 * exactly as long as its spans do: mounted with the stream, gone with it.
 * Reduced motion drops it entirely — same ambient tier as .stream-tail: the
 * words simply appear, already settled. */
const STREAM_WORD_CSS = `
.stream-word{animation:stream-word-in var(--dur-base) var(--ease-out-soft);}
@keyframes stream-word-in{from{opacity:0;filter:blur(3px);}to{opacity:1;filter:blur(0);}}
@media (prefers-reduced-motion: reduce){.stream-word{animation:none;}}
`;

/** hast doesn't ship types here either — same structural shape as MdNode. */
type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  /** micromark's parse positions, kept by mdast→hast for every parsed node. */
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  children?: HastNode[];
};

/** Subtrees where wrapping words would be wrong, not just useless: a fence's
 *  text is data (CodeBlock re-reads it verbatim), and KaTeX's spans are layout
 *  boxes whose children must stay exactly as it emitted them. */
function isStreamWordExempt(node: HastNode): boolean {
  if (node.type !== "element") return false;
  if (node.tagName === "code" || node.tagName === "pre") return true;
  const cls = node.properties?.className;
  const classes = Array.isArray(cls) ? cls.join(" ") : typeof cls === "string" ? cls : "";
  return classes.includes("katex");
}

function rehypeStreamWords() {
  const wrap = (node: HastNode) => {
    if (isStreamWordExempt(node)) return;
    const children = node.children;
    if (!children) return;
    const out: HastNode[] = [];
    let changed = false;
    for (const child of children) {
      if (child.type !== "text" || !child.value || child.value.trim() === "") {
        wrap(child);
        out.push(child);
        continue;
      }
      changed = true;
      // Whitespace stays in bare text nodes between the spans, so line
      // breaking happens exactly where it did before wrapping.
      for (const piece of child.value.split(/(\s+)/)) {
        if (!piece) continue;
        out.push(
          piece.trim() === ""
            ? { type: "text", value: piece }
            : {
                type: "element",
                tagName: "span",
                properties: { className: ["stream-word"] },
                children: [{ type: "text", value: piece }],
              },
        );
      }
    }
    if (changed) node.children = out;
  };
  return function transformer(tree: HastNode) {
    wrap(tree);
  };
}

/*
 * ---- Source offsets ---------------------------------------------------------
 * A rendered answer is the only copy of the text a reader is looking at, and
 * several things about that text are recorded as CHARACTER RANGES into the
 * markdown instead — `ResearchClaim.answerSpan` above all, which is where in
 * the answer a validated claim was extracted from. Markdown rendering normally
 * throws that mapping away: the DOM knows nothing about the string it came from.
 *
 * WHAT WAS REJECTED, and why. The obvious alternative is to skip offsets and
 * search the rendered text for the claim's own sentence. It cannot stand alone:
 * a report that says the same sentence twice (an executive summary that repeats
 * a finding, which is the house style of every report this renders) gives two
 * equally good matches and no way to choose, and choosing wrong in a CITATION
 * feature means telling a reader "this sentence is what source [3] backs" about
 * a sentence source [3] was never shown. So position locates and text verifies —
 * see `locateClaimInAnswer` in citation-audit.tsx, which refuses to point
 * anywhere when the two disagree.
 *
 * Stamped unconditionally rather than behind a prop: the audit strip is rendered
 * by MessageItem as a SIBLING of the answer with no channel between them, so an
 * opt-in flag would have to be threaded through a component that has no idea the
 * audit exists. Two data attributes per block is the cheaper price.
 */

/*
 * Offsets into the markdown this block was parsed from — start inclusive, end
 * exclusive. Not exported: the attribute names are an implementation detail of
 * `blocksForSourceOffset`, and a caller reading them itself would be a second
 * place that has to agree about what "contains this offset" means.
 */
const SOURCE_START_ATTR = "data-src-start";
const SOURCE_END_ATTR = "data-src-end";

/*
 * The elements a SENTENCE can live in, and deliberately not every positioned
 * node. Stamping inline nodes too (`strong`, `em`, `a`) would make the deepest
 * element containing a claim's first character an emphasis span half way through
 * the sentence — a smaller target that cannot pass the "does this element hold
 * the whole claim" check, so every emphasised sentence would go unlocatable.
 *
 * `pre` is absent because the `pre` component below rebuilds the node as
 * AicssCodeBlock and drops these attributes anyway, and a fenced block is not
 * prose a claim is drawn from.
 */
const SOURCE_OFFSET_TAGS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "td",
  "th",
  "dd",
  "dt",
  "figcaption",
]);

/**
 * Publish each block element's position in the source string.
 *
 * `base` is the block's own offset within the whole message, because each
 * MarkdownBlock parses one block in isolation and micromark numbers from zero
 * within whatever it was handed.
 *
 * The one place this is approximate is a block `normalizeMathDelimiters`
 * rewrote: `\(` becomes `$`, so positions after it are short by one per
 * delimiter. The block's own base offset is exact regardless (normalisation is
 * line-for-line and never moves a block boundary), so the error can only ever
 * pick a neighbouring element INSIDE the right block — which the caller's text
 * check then rejects rather than pointing at.
 */
function rehypeSourceOffsets(base: number) {
  const walk = (node: HastNode) => {
    if (node.type === "element" && node.tagName && SOURCE_OFFSET_TAGS.has(node.tagName)) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (typeof start === "number" && typeof end === "number") {
        node.properties = {
          ...node.properties,
          [SOURCE_START_ATTR]: String(base + start),
          [SOURCE_END_ATTR]: String(base + end),
        };
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  // An attacher returning the transformer, the same shape `remarkCitations`
  // uses: a plugin entry is CALLED by unified to build its transformer, so
  // handing the array a bare transformer gets it invoked once at freeze time
  // with no tree at all.
  return function attacher() {
    return function transformer(tree: HastNode) {
      walk(tree);
    };
  };
}

/**
 * The smallest stamped elements inside `root` whose source range covers
 * `offset`, innermost only.
 *
 * A list item's paragraph and the item around it both cover the same character,
 * and scrolling to the item when the paragraph is known would be throwing away
 * precision that is already in hand — so anything containing another hit is
 * dropped. More than one survivor is possible and is NOT an error: a message
 * renders one Markdown per text part and each part numbers from its own zero,
 * so the same offset legitimately names a block in each. Resolving that is the
 * caller's job, and the honest resolution is to refuse (see `locateClaimInAnswer`).
 */
export function blocksForSourceOffset(root: ParentNode, offset: number): HTMLElement[] {
  const hits = [...root.querySelectorAll<HTMLElement>(`[${SOURCE_START_ATTR}]`)].filter((el) => {
    const start = Number(el.getAttribute(SOURCE_START_ATTR));
    const end = Number(el.getAttribute(SOURCE_END_ATTR));
    return Number.isFinite(start) && Number.isFinite(end) && offset >= start && offset < end;
  });
  return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
}

/** A text node and where its data starts in the string `readAnchoredText` returned. */
export interface AnchoredTextSegment {
  node: Text;
  start: number;
}

/**
 * A block's prose as the SOURCE had it, plus the map back to the text nodes it
 * is spread across — so a match in the string can become a DOM Range.
 *
 * Citation chips are skipped whole (see CITATION_ATTR). Everything else is taken
 * verbatim, including KaTeX's twin HTML/MathML output, which double-prints an
 * expression; a claim containing maths therefore fails to match and goes
 * unlocatable rather than being pointed at with an offset that is out by the
 * length of a formula.
 */
export function readAnchoredText(block: HTMLElement): { text: string; segments: AnchoredTextSegment[] } {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeType === Node.ELEMENT_NODE
        ? // REJECT drops the whole subtree; SKIP would descend into the chip and
          // pick its index digit back up, which is the failure this exists to avoid.
          (node as Element).hasAttribute(CITATION_ATTR)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP
        : NodeFilter.FILTER_ACCEPT,
  });
  const segments: AnchoredTextSegment[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    segments.push({ node: textNode, start: text.length });
    text += textNode.data;
  }
  return { text, segments };
}

/** A DOM Range over `[start, end)` of the string `readAnchoredText` returned. */
export function rangeFromAnchoredText(
  segments: readonly AnchoredTextSegment[],
  start: number,
  end: number
): Range | null {
  const point = (index: number) => {
    // `<=` on the far edge so a boundary between two text nodes resolves to the
    // end of the first rather than to nothing at all.
    const seg = segments.find((s) => index >= s.start && index <= s.start + s.node.data.length);
    return seg ? { node: seg.node, offset: index - seg.start } : null;
  };
  const from = point(start);
  const to = point(end);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

/** One parsed block. Memoized so streamed chunks only re-render the final block. */
const MarkdownBlock = React.memo(function MarkdownBlock({
  content,
  offset,
  streaming,
  animateTail,
  sources,
}: {
  content: string;
  /** Where this block starts in the message, for the source-offset attributes. */
  offset: number;
  streaming?: boolean;
  /** True only for the final, still-growing block of a streaming message —
   *  the one block whose words get the entrance treatment. */
  animateTail?: boolean;
  sources?: ClientSource[];
}) {
  // Positional [n] resolution is licensed ONLY by the numbered-corpus contract,
  // which deep research marks with `cited`. It flags every source it supplies, so
  // this is all-or-nothing per message: either the model was given the numbered
  // list, or brackets in its prose mean nothing and must stay literal text.
  const sourceCount = sources?.some((s) => s.cited) ? sources.length : 0;
  const remarkPlugins = React.useMemo<Options["remarkPlugins"]>(
    () => (sourceCount > 0 ? [...REMARK_PLUGINS, remarkCitations(sourceCount)] : REMARK_PLUGINS),
    [sourceCount],
  );
  // rehypeStreamWords is appended last so it walks the tree AFTER highlight and
  // KaTeX have claimed their subtrees — the exemption test needs their classes
  // in place. The offset stamp is indifferent to both: it only ever touches
  // nodes carrying a parse position, and everything those two plugins invent
  // has none.
  const rehypePlugins = React.useMemo<Options["rehypePlugins"]>(
    () => [
      ...(REHYPE_PLUGINS ?? []),
      rehypeSourceOffsets(offset),
      ...(animateTail ? [rehypeStreamWords] : []),
    ],
    [animateTail, offset],
  );
  const components = React.useMemo<Components>(
    () => ({
      pre: ({ children }) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
      // Wide tables scroll inside their own container instead of stretching the
      // message column past the viewport on phones.
      table: ({ node: _node, ...props }) => (
        <div className="overflow-x-auto">
          <table {...props} />
        </div>
      ),
      a: ({ children, node: _node, ...props }) => (
        <a {...props} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
      // Only remarkCitations emits `data-cite`; every other span here (KaTeX
      // emits a great many) falls straight through untouched.
      span: ({ node: _node, ...props }) => {
        const cite = (props as Record<string, string | undefined>)[CITATION_ATTR];
        const source = cite ? sources?.[Number(cite) - 1] : undefined;
        if (!source) return <span {...props} />;
        // The wrapper keeps the marker in the DOM. SourceChip renders its index
        // as a digit and does not forward unknown props, so without something
        // carrying `data-cite` out here a chip is indistinguishable from prose
        // when a block's text is read back — and "…rose sharply[3]." comes back
        // as "…rose sharply3.", which matches no claim the audit extracted.
        return (
          <span {...{ [CITATION_ATTR]: cite }}>
            <SourceChip source={source} index={Number(cite)} />
          </span>
        );
      },
    }),
    [streaming, sources],
  );
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
      {content}
    </ReactMarkdown>
  );
});

export const Markdown = React.memo(function Markdown({
  content,
  className,
  streaming,
  sources,
}: {
  content: string;
  className?: string;
  streaming?: boolean;
  /** Web-search / deep-research sources backing this message, in citation order. */
  sources?: ClientSource[];
}) {
  // Split FIRST, normalise per block. Whole-document normalisation ran before
  // the split and cost the blocks their offsets: `\(` → `$` shortens the text,
  // so a block's position in the normalised string is not its position in the
  // message the claim offsets were measured against. Per-block is equivalent —
  // the transform is line-for-line, and splitIntoBlocks never cuts inside a
  // fence, so every block starts with fence state closed exactly as the whole
  // document did.
  const blocks = React.useMemo(
    () => splitIntoBlocks(content).map((block) => ({ ...block, text: normalizeMathDelimiters(block.text) })),
    [content],
  );
  return (
    <>
      <div className={cn("prose-juno", className)} data-streaming={streaming ? "true" : undefined} data-no-auto-translate>
        {blocks.map((block, i) => (
          <MarkdownBlock
            key={i}
            content={streaming && i === blocks.length - 1 ? closeDangling(block.text) : block.text}
            offset={block.offset}
            streaming={streaming}
            animateTail={streaming && i === blocks.length - 1}
            sources={sources}
          />
        ))}
      </div>
      {/* A SIBLING of the prose div, after it — never inside it, where it would
          steal `p:last-child` from the caret's selector or trip the
          `.prose-juno > * + *` spacing; never before it, where wrappers'
          space-y utilities would count it and shove the prose down. A
          display:none element generates no box, so trailing it is inert. */}
      {streaming ? <style>{STREAM_WORD_CSS}</style> : null}
    </>
  );
});
