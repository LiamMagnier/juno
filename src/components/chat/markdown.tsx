"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { toast } from "sonner";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** Pull the `language-xxx` hint rehype-highlight writes onto the inner <code>. */
function langOf(children: React.ReactNode): string {
  const child = React.Children.toArray(children)[0] as
    | React.ReactElement<{ className?: string }>
    | undefined;
  const cls = child?.props?.className ?? "";
  return /language-([\w-]+)/.exec(cls)?.[1] ?? "";
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLPreElement>(null);
  const [copied, setCopied] = React.useState(false);
  const lang = langOf(children);

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
    <div className="group/code my-3 overflow-hidden rounded-lg border bg-muted">
      <div className="flex items-center justify-between border-b border-border/70 bg-background/40 py-1.5 pl-3 pr-1.5">
        <span className="font-mono text-label uppercase text-muted-foreground">{lang || "code"}</span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy code"}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors duration-fast hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre ref={ref} className="overflow-x-auto p-4">
        {children}
      </pre>
    </div>
  );
}

export const Markdown = React.memo(function Markdown({ content, className }: { content: string; className?: string }) {
  return (
    <div className={cn("prose-juno", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
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
