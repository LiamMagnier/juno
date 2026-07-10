"use client";

import * as React from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import { InlineVisualBlock } from "@/components/chat/inline-visual-block";
import { MermaidBlock } from "@/components/chat/learning/mermaid-block";
import { cn } from "@/lib/utils";

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

const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm];
const REHYPE_PLUGINS: Options["rehypePlugins"] = [[rehypeHighlight, { detect: true, ignoreMissing: true }]];

/** One parsed block. Memoized so streamed chunks only re-render the final block. */
const MarkdownBlock = React.memo(function MarkdownBlock({ content, streaming }: { content: string; streaming?: boolean }) {
  const components = React.useMemo<Components>(
    () => ({
      pre: ({ children }) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
      a: ({ children, ...props }) => (
        <a {...props} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ),
    }),
    [streaming],
  );
  return (
    <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
      {content}
    </ReactMarkdown>
  );
});

export const Markdown = React.memo(function Markdown({ content, className, streaming }: { content: string; className?: string; streaming?: boolean }) {
  const blocks = React.useMemo(() => splitIntoBlocks(content), [content]);
  return (
    <div className={cn("prose-juno", className)}>
      {blocks.map((block, i) => (
        <MarkdownBlock
          key={i}
          content={streaming && i === blocks.length - 1 ? closeDangling(block) : block}
          streaming={streaming}
        />
      ))}
    </div>
  );
});
