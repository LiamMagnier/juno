"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { buildSandboxDoc } from "@/components/canvas/sandbox-frame";

/**
 * Inline Mermaid diagram for chat messages, rendered through the exact same
 * sandboxed-iframe mechanism the canvas uses for MERMAID artifacts:
 * buildSandboxDoc wraps the code with the Mermaid 11 CDN and the iframe runs
 * with an opaque origin (allow-scripts only, no allow-same-origin), so diagram
 * code can never touch the app, cookies, or storage. Malformed mermaid fails
 * inside the sandbox — this component only owns the frame and its states.
 */
export const MermaidBlock = React.memo(function MermaidBlock({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const srcDoc = React.useMemo(() => buildSandboxDoc("MERMAID", code), [code]);

  // New source => the iframe reloads; bring the skeleton back until onLoad.
  React.useEffect(() => {
    setLoaded(false);
  }, [srcDoc]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn’t copy to clipboard");
    }
  };

  return (
    <div className="my-4 overflow-hidden rounded-[18px] border border-border/70 bg-card/90 shadow-pop">
      <div className="flex items-center justify-between border-b border-border/60 bg-[linear-gradient(180deg,hsl(var(--sheen)),transparent)] px-3 py-2 backdrop-blur-md">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Diagram · Mermaid
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy diagram source"}
          className="pressable inline-flex items-center gap-1.5 rounded-[10px] border border-transparent px-2 py-1 font-mono text-[11px] text-muted-foreground hover:border-border/60 hover:bg-background/55 hover:text-foreground coarse:px-2.5 coarse:py-1.5"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {/* Mermaid's default theme is drawn for a light canvas — stays white in both app themes. */}
      <div className="relative bg-white">
        <iframe
          title="Mermaid diagram"
          srcDoc={srcDoc}
          // Opaque origin (no allow-same-origin) so diagram code cannot reach the app.
          sandbox="allow-scripts"
          className="h-72 w-full border-0 bg-white"
          onLoad={() => setLoaded(true)}
        />
        {!loaded && <div aria-hidden="true" className="skeleton absolute inset-0" />}
      </div>
    </div>
  );
});
