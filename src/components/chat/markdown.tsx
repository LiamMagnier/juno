"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
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

export const Markdown = React.memo(function Markdown({ content, className, streaming }: { content: string; className?: string; streaming?: boolean }) {
  return (
    <div className={cn("prose-juno", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock streaming={streaming}>{children}</CodeBlock>,
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
