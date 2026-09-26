"use client";

import * as React from "react";
import { toast } from "sonner";
import { IconSwap } from "@/components/ui/icon-swap";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FileCode, FoldVertical, UnfoldVertical, WrapText } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { cn } from "@/lib/utils";

/**
 * AIcss "Code Block" — a tonal fill (`--secondary`, the Claude / ChatGPT
 * register) with a one-line header: the file (when the fence named one), the
 * language by name, Wrap (only when a line overflows) and Copy. Long blocks in
 * the transcript open clamped with "Show all N lines" (`collapsible`).
 *
 * The header is pulled out to the frame's edge with a negative margin, so the
 * rule under it is the card's own inlay rather than a second border drawn
 * inside it. Line numbers appear only past `GUTTER_MIN_LINES`: a model's
 * "line 14" is citable at a glance in a 40-line block, while a two-line
 * snippet with a gutter and a hairline was chrome outweighing content.
 *
 * `<pre>` is deliberately not used. Line numbers have to be un-selectable so a
 * copy is pastable, and that means one element per row — which also gives the
 * code column its own horizontal scroller, so one long line scrolls itself
 * instead of widening the whole message.
 */

/** Blocks longer than this get the numbered gutter. */
const GUTTER_MIN_LINES = 8;

/**
 * Past this many lines a collapsible block opens clamped: the first
 * `COLLAPSED_LINES` rows, a fade, and "Show all N lines". A 200-line listing
 * is a document the reader chooses to open, not a wall they scroll past to
 * reach the next paragraph. The clamp sits a few rows under the threshold so
 * "show all" never reveals a mere two lines.
 */
const COLLAPSE_MIN_LINES = 28;
const COLLAPSED_LINES = 18;
/** Row height and vertical padding of `.aicss-cb-lines` (globals.css). */
const ROW_PX = 20;
const LINES_PAD_PX = 10;

/**
 * The language names readers use. The fence's info string is an identifier
 * (`ts`, `py`, `sh`), and the header is a label, so it speaks the name. An
 * unknown language keeps its own spelling rather than being guessed at.
 */
const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", js: "JavaScript", javascript: "JavaScript",
  jsx: "JSX", mjs: "JavaScript", cjs: "JavaScript", py: "Python", python: "Python", rb: "Ruby",
  ruby: "Ruby", go: "Go", golang: "Go", rs: "Rust", rust: "Rust", swift: "Swift", kt: "Kotlin",
  kotlin: "Kotlin", java: "Java", c: "C", h: "C", cpp: "C++", "c++": "C++", cc: "C++", cs: "C#",
  csharp: "C#", php: "PHP", sh: "Shell", bash: "Bash", zsh: "Zsh", shell: "Shell", console: "Console",
  ps1: "PowerShell", powershell: "PowerShell", json: "JSON", jsonc: "JSON", yaml: "YAML", yml: "YAML",
  toml: "TOML", ini: "INI", xml: "XML", html: "HTML", css: "CSS", scss: "SCSS", sass: "Sass",
  less: "Less", sql: "SQL", md: "Markdown", markdown: "Markdown", diff: "Diff", patch: "Diff",
  dockerfile: "Dockerfile", docker: "Dockerfile", graphql: "GraphQL", gql: "GraphQL", lua: "Lua",
  r: "R", dart: "Dart", scala: "Scala", elixir: "Elixir", ex: "Elixir", hs: "Haskell",
  haskell: "Haskell", vue: "Vue", svelte: "Svelte", prisma: "Prisma", tex: "LaTeX", latex: "LaTeX",
  txt: "Text", text: "Text", plaintext: "Text", makefile: "Makefile", make: "Makefile", nginx: "Nginx",
};

/** The reader's name for a fence's language id, or the id itself. */
export function languageName(id: string): string {
  return LANGUAGE_NAMES[id.toLowerCase()] ?? id;
}

/**
 * Copy, with its own receipt: the copy glyph cross-fades to a check and the
 * word follows it ("Copied"), for 1.5s. No toast on success: a corner
 * notification for something done under the cursor is a second voice saying
 * the same thing. Exported so the diff block's header carries the same one.
 */
export function CodeCopyButton({ code, label = "Copy code" }: { code: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  // A late timer firing into an unmounted component is a React warning and a
  // wasted render, so the id is held and cleared.
  const timer = React.useRef<number | null>(null);
  React.useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn’t copy to the clipboard.");
    }
  };
  // The press is the house `.pressable` dip. `.aicss-cb-copy` declares its own
  // `transition` later in the same layer, so that list carries the press
  // transform itself (globals.css) and the dip eases. Below `sm` the word is
  // dropped and the button is glyph-only, so the tooltip carries the name
  // there; from `sm` up the label is on the button and a tooltip would only
  // repeat it.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : label}
          className="aicss-cb-copy pressable motion-reduce:active:scale-100"
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
      <TooltipContent className="sm:hidden">{copied ? "Copied" : label}</TooltipContent>
    </Tooltip>
  );
}

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
  /** The language (an id like `ts`; the header prints its name). Empty when
   *  unknown: the header then holds only the file or nothing, rather than the
   *  literal word "code" over a block that is visibly code already. */
  label,
  /** A filename the fence declared (`ts title="src/auth.ts"`, `ts:src/auth.ts`).
   *  Leads the header when present: a path is what a reader acts on. */
  filename,
  /** Raw text, for the clipboard. Highlighting is applied to `children`. */
  code,
  /** Per-line nodes when the caller has highlighted them; else `code` is split. */
  lines: highlighted,
  /** Replaces the copy button — used for the "renders when complete" note. */
  action,
  /** Cap the body and scroll it. For panels that hold several blocks at once
   *  (the tool-call ledger); the transcript clamps with `collapsible` instead. */
  maxBodyHeight,
  /** Long blocks open clamped with "Show all N lines" (the transcript). */
  collapsible,
  /** Open expanded even when long. A block that streamed in on screen starts
   *  open, so the clamp never slams shut under a reader when the fence closes. */
  defaultExpanded,
  className,
}: {
  label: string;
  filename?: string;
  code: string;
  lines?: React.ReactNode[];
  action?: React.ReactNode;
  maxBodyHeight?: number;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}) {
  const [wrap, setWrap] = React.useState(false);
  const [expanded, setExpanded] = React.useState(!!defaultExpanded);
  const [overflows, setOverflows] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const bodyId = React.useId();

  const lines = React.useMemo<React.ReactNode[]>(
    () => highlighted ?? code.replace(/\n$/, "").split("\n"),
    [highlighted, code],
  );

  const numbered = lines.length > GUTTER_MIN_LINES;
  const clampable = !!collapsible && lines.length > COLLAPSE_MIN_LINES;
  const clamped = clampable && !expanded;

  // Wrap is offered only where it changes something: a block whose longest
  // line fits has no use for the control, and a header of dead buttons is
  // chrome outweighing content. Measured, not guessed from character counts,
  // because the column is 340px on a phone and 720px on a desktop.
  React.useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(body.scrollWidth > body.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [lines]);

  const collapse = () => {
    setExpanded(false);
    // Collapsing a block taller than the window can leave the reader below it
    // with nothing on screen, so its top comes back into view when it is not
    // already there.
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: "nearest" }));
  };

  const language = label ? languageName(label) : "";

  return (
    // `data-code` carries the raw text for readers outside this component —
    // ⌘⇧; (use-global-shortcuts.ts) copies the last block from it, since there
    // is no <pre> to read and the rows hold highlighted fragments.
    <div
      ref={rootRef}
      className={cn(
        "aicss-cb group/code",
        numbered && "aicss-cb--numbered",
        wrap && "aicss-cb--wrap",
        clampable && "aicss-cb--clampable",
        className,
      )}
      data-code={code}
    >
      <div className="aicss-cb-head">
        {filename ? (
          <span className="aicss-cb-file" title={filename}>
            <FileCode className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="aicss-cb-filename">{filename}</span>
          </span>
        ) : null}
        {language ? <span className="aicss-cb-lang">{language}</span> : null}
        <span className="aicss-cb-actions">
          {(overflows || wrap) && !action ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setWrap((w) => !w)}
                  aria-pressed={wrap}
                  aria-label="Wrap lines"
                  className="aicss-cb-icon pressable motion-reduce:active:scale-100"
                >
                  <WrapText className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{wrap ? "Don’t wrap lines" : "Wrap lines"}</TooltipContent>
            </Tooltip>
          ) : null}
          {action ?? <CodeCopyButton code={code} />}
        </span>
      </div>
      {/* The one scroll region, and therefore the one tab stop: a long line
          has to be reachable without a pointer (SC 2.1.1), and the body is
          where the scrolling happens now (globals.css). `role="region"` with
          a name is what turns a focusable div into something a screen reader
          can announce rather than an unlabelled stop. */}
      <div
        ref={bodyRef}
        id={bodyId}
        tabIndex={0}
        role="region"
        aria-label={filename ? `${filename} code` : language ? `${language} code` : "Code"}
        className={cn("aicss-cb-body", maxBodyHeight && !clampable && "overflow-y-auto scroll-fade-y")}
        style={
          clamped
            ? { maxHeight: LINES_PAD_PX + COLLAPSED_LINES * ROW_PX, overflowY: "hidden" }
            : maxBodyHeight && !clampable
              ? { maxHeight: maxBodyHeight }
              : undefined
        }
      >
        {/* One box holding every line, wide enough for the longest. The gutter
            hairline hangs off THIS rather than the scroller, so it stays
            full-height and still travels with the code. */}
        <div className="aicss-cb-lines">
          {lines.map((line, i) => (
            <div className="aicss-cb-row" key={i}>
              {numbered && <span className="aicss-cb-ln">{i + 1}</span>}
              {/* A blank line still needs a box, or the row collapses and the
                  numbering stops tracking the source. */}
              <code className="aicss-cb-code">{line === "" ? " " : line}</code>
            </div>
          ))}
        </div>
      </div>
      {clampable ? (
        // Over the fade when clamped (the fade says "there is more", the
        // button says how much), a plain footer row once open.
        <div className={cn("aicss-cb-foot", clamped && "aicss-cb-foot--clamped")}>
          <button
            type="button"
            onClick={clamped ? () => setExpanded(true) : collapse}
            aria-expanded={!clamped}
            aria-controls={bodyId}
            className="aicss-cb-more pressable motion-reduce:active:scale-100"
          >
            {clamped ? <UnfoldVertical className="size-3.5" /> : <FoldVertical className="size-3.5" />}
            {clamped ? `Show all ${lines.length} lines` : "Show less"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
