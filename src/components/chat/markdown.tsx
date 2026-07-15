"use client";

import * as React from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
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

/**
 * Split raw markdown into stable top-level blocks — on blank lines, keeping
 * fenced code intact and indented continuations (nested list content) attached —
 * so streaming only re-parses the final, still-growing block.
 */
function splitIntoBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: Fence | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const wasInFence = fence !== null;
    fence = trackFence(fence, line);
    if (!wasInFence && fence === null && line.trim() === "") {
      if (current.length === 0) continue;
      const next = lines.slice(i + 1).find((l) => l.trim() !== "");
      // An indented follow-up line continues the current block (list/quote content).
      if (next !== undefined && /^[ \t]/.test(next)) current.push(line);
      else {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
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

function CodeBlock({ children, streaming }: { children: React.ReactNode; streaming?: boolean }) {
  const ref = React.useRef<HTMLPreElement>(null);
  const [copied, setCopied] = React.useState(false);
  const lang = langOf(children);
  const raw = textOf(children).replace(/\n$/, "");

  if (isVisualLang(lang)) {
    return <InlineVisualBlock source={raw} streaming={streaming} />;
  }

  const isMermaid = lang.toLowerCase() === "mermaid";
  if (isMermaid && !streaming) {
    return <MermaidBlock code={raw} />;
  }

  const copy = async () => {
    const text = ref.current?.innerText ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn’t copy to clipboard");
    }
  };

  return (
    <div className="group/code my-4 overflow-hidden rounded-[18px] border border-border/70 bg-card/90 shadow-pop">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-[linear-gradient(180deg,hsl(var(--sheen)),transparent)] py-2 pl-3 pr-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex items-center gap-1.5" aria-hidden>
            <span className="size-2.5 rounded-full bg-destructive/75 ring-1 ring-black/5" />
            <span className="size-2.5 rounded-full bg-warning/75 ring-1 ring-black/5" />
            <span className="size-2.5 rounded-full bg-success/75 ring-1 ring-black/5" />
          </span>
          <span className="truncate font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{lang || "code"}</span>
        </span>
        {isMermaid ? (
          <span className="px-2 py-1 font-mono text-caption text-muted-foreground/80">Diagram renders when complete…</span>
        ) : (
          <button
            type="button"
            onClick={copy}
            aria-label={copied ? "Copied" : "Copy code"}
            className="pressable inline-flex items-center gap-1.5 rounded-[10px] border border-transparent px-2 py-1 font-mono text-caption text-muted-foreground hover:border-border/60 hover:bg-background/55 hover:text-foreground coarse:px-2.5 coarse:py-2"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success motion-safe:animate-fade-in" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
          </button>
        )}
      </div>
      <pre ref={ref} className="max-h-[520px] overflow-auto bg-background/35 p-4 text-[12.5px] leading-6 scroll-fade-y">
        {children}
      </pre>
    </div>
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
      data: { hName: "span", hProperties: { "data-cite": String(index) } },
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

/** One parsed block. Memoized so streamed chunks only re-render the final block. */
const MarkdownBlock = React.memo(function MarkdownBlock({
  content,
  streaming,
  sources,
}: {
  content: string;
  streaming?: boolean;
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
  const components = React.useMemo<Components>(
    () => ({
      pre: ({ children }) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
      a: ({ children, node: _node, ...props }) => (
        <a {...props} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
      // Only remarkCitations emits `data-cite`; every other span here (KaTeX
      // emits a great many) falls straight through untouched.
      span: ({ node: _node, ...props }) => {
        const cite = (props as { "data-cite"?: string })["data-cite"];
        const source = cite ? sources?.[Number(cite) - 1] : undefined;
        if (!source) return <span {...props} />;
        return <SourceChip source={source} index={Number(cite)} />;
      },
    }),
    [streaming, sources],
  );
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={REHYPE_PLUGINS} components={components}>
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
  const blocks = React.useMemo(() => splitIntoBlocks(normalizeMathDelimiters(content)), [content]);
  return (
    <div className={cn("prose-juno", className)} data-no-auto-translate>
      {blocks.map((block, i) => (
        <MarkdownBlock
          key={i}
          content={streaming && i === blocks.length - 1 ? closeDangling(block) : block}
          streaming={streaming}
          sources={sources}
        />
      ))}
    </div>
  );
});
