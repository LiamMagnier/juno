"use client";

import * as React from "react";
import { toast } from "sonner";
import { Maximize2 } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import {
  MERMAID_CLICK_MESSAGE,
  MERMAID_SIZE_MESSAGE,
  buildInlineMermaidDoc,
  type MermaidTheme,
} from "@/components/canvas/sandbox-frame";
import { SandboxDocumentFrame, useSandboxProfile } from "@/components/canvas/sandbox-document-frame";
import { IconSwap } from "@/components/ui/icon-swap";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/*
 * An inline Mermaid diagram in a chat answer.
 *
 * It runs in the same sandbox the canvas uses for MERMAID artifacts (opaque
 * origin, allow-scripts only; Mermaid itself with securityLevel strict), so a
 * diagram's source can never reach the app. What changed is how it sits in
 * the answer. It used to be a fixed 18rem frame holding Mermaid's light
 * default, centred: in dark mode a small diagram in a large white box. Now:
 *
 * - The colours come from the app's own tokens (read here, passed in), so the
 *   diagram is drawn on the block's surface in either theme, and redrawn when
 *   the theme changes.
 * - The drawing is fitted to the column between a minimum and maximum scale,
 *   and the frame takes exactly the drawing's height (the document reports
 *   it), so there is no empty canvas around a small chart and no microscopic
 *   text in a wide one; past the minimum it scrolls sideways instead.
 * - Clicking it, or Expand, opens it large in a dialog.
 */

const INLINE_MIN_SCALE = 0.6;
const INLINE_MAX_SCALE = 1;
const INLINE_MAX_HEIGHT = 560;

/** "30 6% 92%" (a token's HSL triplet) → "#ebe9e7". */
function hslTriplet(value: string): [number, number, number] | null {
  const m = /^\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(value);
  return m ? [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100] : null;
}

function toHex([h, s, l]: [number, number, number]): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("")}`;
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function readTheme(): MermaidTheme {
  const root = document.documentElement;
  const dark = root.classList.contains("dark");
  const css = getComputedStyle(root);
  const token = (name: string, fallback: [number, number, number]) => hslTriplet(css.getPropertyValue(name)) ?? fallback;
  const fg = token("--foreground", dark ? [30, 0.06, 0.92] : [30, 0.06, 0.1]);
  const card = token("--card", dark ? [30, 0.06, 0.12] : [0, 0, 1]);
  const muted = token("--muted-foreground", dark ? [30, 0.05, 0.62] : [30, 0.05, 0.42]);
  return {
    dark,
    surface: toHex(card),
    fill: toHex(mix(card, fg, dark ? 0.07 : 0.035)),
    stroke: toHex(mix(card, fg, dark ? 0.3 : 0.26)),
    line: toHex(muted),
    text: toHex(fg),
    muted: toHex(muted),
  };
}

function useAppTheme(): MermaidTheme | null {
  const [theme, setTheme] = React.useState<MermaidTheme | null>(null);
  React.useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme((prev) => {
      const next = readTheme();
      return prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
    read();
    // The theme toggle swaps a class on <html>: redraw in the new palette.
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["class", "data-accent"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** One sandboxed drawing that sizes itself to what it drew. */
function DiagramFrame({
  doc,
  maxHeight,
  onExpand,
  className,
}: {
  doc: string;
  maxHeight: number;
  onExpand?: () => void;
  className?: string;
}) {
  const ref = React.useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = React.useState<number | null>(null);
  const expandRef = React.useRef(onExpand);
  React.useLayoutEffect(() => {
    expandRef.current = onExpand;
  });

  React.useEffect(() => {
    setHeight(null);
  }, [doc]);

  React.useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const data = event.data as { type?: unknown; height?: unknown } | null;
      if (!data || typeof data !== "object") return;
      if (data.type === MERMAID_SIZE_MESSAGE && typeof data.height === "number" && Number.isFinite(data.height)) {
        setHeight(Math.max(64, Math.min(maxHeight, Math.round(data.height))));
      } else if (data.type === MERMAID_CLICK_MESSAGE) {
        expandRef.current?.();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [maxHeight]);

  return (
    <div className="relative" style={{ height: height ?? 160 }}>
      <SandboxDocumentFrame
        ref={ref}
        title="Diagram"
        html={doc}
        // Opaque origin (no allow-same-origin) so diagram code cannot reach the app.
        sandbox="allow-scripts"
        className={className ?? "block h-full w-full border-0 bg-transparent"}
      />
      {height === null ? <div aria-hidden="true" className="skeleton absolute inset-3 rounded-control" /> : null}
    </div>
  );
}

export const MermaidBlock = React.memo(function MermaidBlock({ code }: { code: string }) {
  const [copied, setCopied] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const copiedTimer = React.useRef<number | null>(null);
  React.useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );
  const theme = useAppTheme();
  // A Mermaid block inside a public share takes the share's profile: `public`
  // runs the diagram, `static` (the default there) shows its source instead.
  const profile = useSandboxProfile();
  const inlineDoc = React.useMemo(
    () => (theme ? buildInlineMermaidDoc(code, { theme, minScale: INLINE_MIN_SCALE, maxScale: INLINE_MAX_SCALE }, profile) : null),
    [code, theme, profile],
  );
  const largeDoc = React.useMemo(
    () => (theme && open ? buildInlineMermaidDoc(code, { theme, minScale: 0.8, maxScale: 2 }, profile) : null),
    [code, theme, profile, open],
  );

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

  const action =
    "pressable inline-flex items-center gap-1.5 rounded-control border border-transparent px-2 py-1 text-caption text-muted-foreground hover:border-border/60 hover:bg-accent hover:text-foreground coarse:px-2.5 coarse:py-1.5";

  return (
    <figure className="my-5 overflow-hidden rounded-popover border border-border/70 bg-card">
      <figcaption className="flex items-center justify-between gap-2 border-b border-border/60 py-1.5 pl-3.5 pr-1.5">
        <span className="text-caption text-muted-foreground">Diagram</span>
        <span className="flex items-center gap-0.5">
          {profile !== "static" ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" onClick={() => setOpen(true)} aria-label="Expand diagram" className={action}>
                  <Maximize2 className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">Expand</span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="sm:hidden">Expand diagram</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" onClick={copy} aria-label={copied ? "Copied" : "Copy diagram source"} className={action}>
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
        </span>
      </figcaption>
      {profile === "static" ? (
        // A public share while scripted previews are off: Mermaid draws with a
        // script, so the diagram is shown as the source it was written in.
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-4 py-3 font-mono text-caption text-foreground">{code}</pre>
      ) : inlineDoc ? (
        <DiagramFrame doc={inlineDoc} maxHeight={INLINE_MAX_HEIGHT} onExpand={() => setOpen(true)} />
      ) : (
        <div aria-hidden="true" className="skeleton m-3 h-32 rounded-control" />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(96vw,72rem)] max-w-none bg-card p-0">
          <DialogTitle className="border-b border-border/60 px-5 py-3 text-ui font-medium">Diagram</DialogTitle>
          <div className="max-h-[80vh] overflow-auto px-2 pb-2">
            {largeDoc ? <DiagramFrame doc={largeDoc} maxHeight={4000} /> : null}
          </div>
        </DialogContent>
      </Dialog>
    </figure>
  );
});
