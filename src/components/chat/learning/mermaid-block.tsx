"use client";

import * as React from "react";
import { toast } from "sonner";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { buildSandboxDoc } from "@/components/canvas/sandbox-frame";
import { SandboxDocumentFrame, useSandboxProfile } from "@/components/canvas/sandbox-document-frame";
import { IconSwap } from "@/components/ui/icon-swap";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
 * buildSandboxDoc wraps the code with the Mermaid 11 CDN and the preview shell
 * runs it with an opaque origin (allow-scripts only, no allow-same-origin), so
 * diagram code can never touch the app, cookies, or storage. Malformed mermaid
 * fails inside the sandbox — this component only owns the frame and its states.
 */
export const MermaidBlock = React.memo(function MermaidBlock({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  // The check reverts after 1.5s; the id is held so a second copy restarts the
  // receipt and an unmount does not leave it to fire into a dead component.
  const copiedTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    []
  );
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

  // A Mermaid block inside a public share takes the share's profile: `public`
  // runs the diagram, `static` (the default there) shows its source instead.
  const profile = useSandboxProfile();
  const doc = React.useMemo(
    () => buildSandboxDoc("MERMAID", themedSource(code, dark), undefined, profile),
    [code, dark, profile]
  );

  // New source => the frame reloads; bring the skeleton back until it has drawn.
  React.useEffect(() => {
    setLoaded(false);
  }, [doc]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn’t copy to the clipboard.");
    }
  };

  return (
    // `bg-card`, not `bg-card/90`. The diagram frame sits on the transcript
    // ground, which is #000, so 90% of a 6.5% fill resolved to ~5.9%. Flat:
    // the hairline is the edge, with no `shadow-pop` under it and no sheen
    // gradient or blur on the header strip (FLAT_UI §2 — clean paper, and
    // nothing in the reading column casts a shadow).
    <div className="my-4 overflow-hidden rounded-popover border border-border/70 bg-card">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <span className="font-mono text-micro font-semibold text-muted-foreground">
          Diagram · Mermaid
        </span>
        {/* Glyph-only below `sm`, so the tooltip names it there; from `sm` up
            the word is on the button and the tooltip would only repeat it. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy diagram source"}
              className="pressable inline-flex items-center gap-1.5 rounded-control border border-transparent px-2 py-1 font-mono text-caption text-muted-foreground hover:border-border/60 hover:bg-accent hover:text-foreground coarse:px-2.5 coarse:py-1.5"
            >
              <IconSwap
                curve="spring"
                swapped={copied}
                from={<ActionIcons.copy className="size-3.5" />}
                to={<StatusIcons.success className="size-3.5 text-success-ink" />}
              />
              <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
            </button>
          </TooltipTrigger>
          <TooltipContent className="sm:hidden">{copied ? "Copied" : "Copy diagram source"}</TooltipContent>
        </Tooltip>
      </div>
      {/* The diagram now follows the app theme (see themedSource), so the canvas
          can sit on the same near-black rung as the block's own chrome instead
          of punching a white hole in the transcript. */}
      {profile === "static" ? (
        // A public share while scripted previews are off: Mermaid draws with a
        // script, so the diagram is shown as the source it was written in.
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap bg-card px-4 py-3 font-mono text-caption text-foreground">
          {code}
        </pre>
      ) : (
        <div className="relative bg-card">
          <SandboxDocumentFrame
            title="Mermaid diagram"
            html={doc}
            // Opaque origin (no allow-same-origin) so diagram code cannot reach the app.
            sandbox="allow-scripts"
            className="h-72 w-full border-0 bg-card"
            onDocumentLoad={() => setLoaded(true)}
          />
          {!loaded && <div aria-hidden="true" className="skeleton absolute inset-0" />}
        </div>
      )}
    </div>
  );
});
