"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { buildSandboxDoc } from "@/components/canvas/sandbox-frame";

/**
 * Mermaid's default theme is drawn for a light canvas, which is why this block
 * used to force `bg-white` — a full-width #fff panel dropped into a pure-black
 * transcript, the brightest object on the chat surface by a mile. The sandbox
 * document is built outside this file, so the theme is set the one way that
 * travels with the source: a `%%{init}%%` directive, which Mermaid applies at
 * parse time and which an author's own directive further down still overrides.
 *
 * Skipped when the source opens with `---` (YAML frontmatter must be the very
 * first thing in the document, so prepending anything there breaks the parse).
 */
function themedSource(code: string, dark: boolean): string {
  if (!dark) return code;
  if (code.trimStart().startsWith("---")) return code;
  return `%%{init: {"theme":"dark"}}%%\n${code}`;
}

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
  // Rendered light-first so the server HTML and the first client paint agree;
  // the effect corrects it before the iframe has finished booting.
  const [dark, setDark] = React.useState(false);

  React.useEffect(() => {
    const root = document.documentElement;
    const read = () => setDark(root.classList.contains("dark"));
    read();
    // The theme toggle swaps a class on <html>; without this the diagram keeps
    // whichever palette it was born with for the rest of the session.
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const srcDoc = React.useMemo(() => buildSandboxDoc("MERMAID", themedSource(code, dark)), [code, dark]);

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
    // `bg-card`, not `bg-card/90`. The diagram frame sits on the transcript
    // ground, which is #000, so 90% of a 6.5% fill resolved to ~5.9% and the
    // `shadow-pop` under it is black ink on black — the card had neither fill
    // nor lift to separate it from the page.
    <div className="my-4 overflow-hidden rounded-popover border border-border/70 bg-card shadow-pop">
      <div className="flex items-center justify-between border-b border-border/60 bg-[linear-gradient(180deg,hsl(var(--sheen)),transparent)] px-3 py-2 backdrop-blur-md">
        <span className="font-mono text-micro font-semibold text-muted-foreground">
          Diagram · Mermaid
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy diagram source"}
          className="pressable inline-flex items-center gap-1.5 rounded-control border border-transparent px-2 py-1 font-mono text-caption text-muted-foreground hover:border-border/60 hover:bg-accent hover:text-foreground coarse:px-2.5 coarse:py-1.5"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {/* The diagram now follows the app theme (see themedSource), so the canvas
          can sit on the same near-black rung as the block's own chrome instead
          of punching a white hole in the transcript. */}
      <div className="relative bg-card">
        <iframe
          title="Mermaid diagram"
          srcDoc={srcDoc}
          // Opaque origin (no allow-same-origin) so diagram code cannot reach the app.
          sandbox="allow-scripts"
          className="h-72 w-full border-0 bg-card"
          onLoad={() => setLoaded(true)}
        />
        {!loaded && <div aria-hidden="true" className="skeleton absolute inset-0" />}
      </div>
    </div>
  );
});
