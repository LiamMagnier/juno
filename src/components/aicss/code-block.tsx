"use client";

import * as React from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * AIcss "Code Block" — the numbered-gutter shell.
 *
 * Two things it does that Juno's previous code chrome did not. The header is
 * pulled out to the frame's edge with a negative margin, so the rule under it is
 * the card's own inlay rather than a second border drawn inside it. And every
 * line gets a number against a full-height hairline, which is what makes a
 * model's "line 14" citable at a glance.
 *
 * `<pre>` is deliberately not used. Line numbers have to be un-selectable so a
 * copy is pastable, and that means one element per row — which also gives the
 * code column its own horizontal scroller, so one long line scrolls itself
 * instead of widening the whole message.
 */

const CopyIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="2.5" />
    <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m4.5 12.75 6 6 9-13.5" />
  </svg>
);
const CodeIcon = () => (
  <svg className="aicss-cb-icon" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
    <path d="m8 6-6 6 6 6M16 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * Split already-highlighted content into per-line node lists.
 *
 * The numbered gutter needs one element per line, and rehype-highlight hands us
 * a tree of token <span>s in which a newline can sit anywhere — inside a block
 * comment, a template literal, a multi-line string. Rendering the tree once per
 * line is therefore not an option, and re-highlighting line by line would break
 * exactly those tokens.
 *
 * So the tree is walked and cut at every "\n": a token that straddles a line
 * break becomes one clone per line, each carrying its own slice, and each clone
 * keeps the class that coloured it. Highlighting survives the cut intact.
 */
export function splitHighlightedLines(node: React.ReactNode): React.ReactNode[] {
  const lines: React.ReactNode[][] = [[]];
  let key = 0;

  const walk = (current: React.ReactNode) => {
    if (current === null || current === undefined || current === false || current === true) return;

    if (typeof current === "string" || typeof current === "number") {
      const parts = String(current).split("\n");
      parts.forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part) lines[lines.length - 1].push(part);
      });
      return;
    }

    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }

    if (React.isValidElement(current)) {
      const element = current as React.ReactElement<{ children?: React.ReactNode }>;
      const depth = lines.length;
      // What was already on this line before the element opened. Captured now,
      // because the recursion below is free to append to it and to push more.
      const prefix = lines[depth - 1].slice();
      walk(element.props.children);
      const produced = lines
        .slice(depth - 1)
        .map((line, i) => (i === 0 ? line.slice(prefix.length) : line));
      // Rewind to the moment before the element and lay its lines back down,
      // each one wrapped in its own clone so the token's class survives the cut.
      lines.length = depth - 1;
      lines.push(prefix);
      produced.forEach((children, i) => {
        if (i > 0) lines.push([]);
        if (children.length > 0) {
          lines[lines.length - 1].push(React.cloneElement(element, { key: `s${key++}` }, ...children));
        }
      });
      return;
    }

    // Anything else (a portal, an iterable) is passed through on the current line.
    lines[lines.length - 1].push(current as React.ReactNode);
  };

  walk(node);
  // Highlighted code ends in a newline, which would otherwise number a line that
  // is not in the source.
  if (lines.length > 1 && lines[lines.length - 1].length === 0) lines.pop();
  return lines.map((line, i) => <React.Fragment key={i}>{line}</React.Fragment>);
}

export function AicssCodeBlock({
  /** The label in the header: a filename when one is known, else the language. */
  label,
  /** Raw text, for the clipboard. Highlighting is applied to `children`. */
  code,
  /** Per-line nodes when the caller has highlighted them; else `code` is split. */
  lines: highlighted,
  /** Replaces the copy button — used for the "renders when complete" note. */
  action,
  /** Cap the body and scroll it. AIcss's block is unbounded; a chat column
   *  cannot be, or one 900-line paste owns the transcript. */
  maxBodyHeight,
  className,
}: {
  label: string;
  code: string;
  lines?: React.ReactNode[];
  action?: React.ReactNode;
  maxBodyHeight?: number;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  // A late timer firing into an unmounted component is a React warning and a
  // wasted render, so the id is held and cleared.
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const lines = React.useMemo<React.ReactNode[]>(
    () => highlighted ?? code.replace(/\n$/, "").split("\n"),
    [highlighted, code],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn’t copy to clipboard");
    }
  };

  return (
    <div className={cn("aicss-cb group/code", className)}>
      <div className="aicss-cb-head">
        <span className="aicss-cb-file">
          <CodeIcon />
          <span className="aicss-cb-lang">{label}</span>
        </span>
        {action ?? (
          <button type="button" onClick={copy} aria-label={copied ? "Copied" : "Copy code"} className="aicss-cb-copy">
            {copied ? <CheckIcon /> : <CopyIcon />}
            <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
          </button>
        )}
      </div>
      <div
        className={cn("aicss-cb-body", maxBodyHeight && "overflow-y-auto scroll-fade-y")}
        style={maxBodyHeight ? { maxHeight: maxBodyHeight } : undefined}
      >
        {lines.map((line, i) => (
          <div className="aicss-cb-row" key={i}>
            <span className="aicss-cb-ln">{i + 1}</span>
            {/* A blank line still needs a box, or the row collapses and the
                numbering stops tracking the source. */}
            <code className="aicss-cb-code">{line === "" ? " " : line}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
