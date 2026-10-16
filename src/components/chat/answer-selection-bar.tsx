"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Info, MessageCircleQuestion, TextQuote } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { Check } from "@/components/ui/icons";
import {
  ANSWER_TEXT_ATTR,
  answerQuoteFor,
  blockquoteFor,
  isPassage,
  nextToolbarIndex,
  normalizePassage,
  placeSelectionBar,
  type Box,
} from "@/lib/answer-selection";
import type { AnswerQuote, ComposerQuote } from "@/lib/quote-context";
import { cn } from "@/lib/utils";

/*
 * Bar copy, as a `…_LABEL` constant the i18n extractor walks in full.
 */
export const SELECTION_BAR_LABEL = {
  toolbar: "Selection actions",
  ask: "Ask",
  quote: "Quote",
  explain: "Explain",
  copy: "Copy",
  copied: "Copied",
  hint: "Selection actions are available. Press Tab to reach them.",
} as const;

// The canvas and document viewer's key, verbatim: `rounded-control` (8) seated
// 4px inside the bar's `rounded-card` (12), 44px tall on touch.
const ACTION = "h-7 gap-1.5 rounded-control px-2.5 coarse:h-11 coarse:px-3.5";

const HIGHLIGHT = "juno-quote";
const HIGHLIGHT_STYLE_ID = "juno-quote-highlight-style";
// A softened selection wash: the passage being asked about stays marked in the
// answer while the question is written, without looking like a live selection.
// Half the ::selection wash (globals.css) on each theme; under forced colours
// the system's own highlight pair, since a tinted wash would be dropped.
const HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT}){background-color:hsl(var(--primary) / 0.12);}
.dark ::highlight(${HIGHLIGHT}){background-color:hsl(var(--primary) / 0.2);}
@media (forced-colors: active){::highlight(${HIGHLIGHT}){background-color:Highlight;color:HighlightText;}}`;

interface Captured {
  messageId: string;
  text: string;
  range: Range;
  /** The transcript's scroller: the box the bar is kept inside. */
  bounds: HTMLElement | null;
}

/** The nearest ancestor that scrolls vertically, or null. */
function scrollParent(el: Element | null): HTMLElement | null {
  for (let node = el?.parentElement ?? null; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The answer a selection lies in — both ends inside one settled answer, inside `scope` — or null. */
function readSelection(scope: HTMLElement | null): Captured | null {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!scope || !sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const start = elementOf(range.startContainer)?.closest(`[${ANSWER_TEXT_ATTR}]`);
  const end = elementOf(range.endContainer)?.closest(`[${ANSWER_TEXT_ATTR}]`);
  if (!start || start !== end || !scope.contains(start)) return null;
  const messageId = start.getAttribute(ANSWER_TEXT_ATTR);
  if (!messageId) return null;
  const text = normalizePassage(sel.toString());
  if (!isPassage(text)) return null;
  return { messageId, text, range: range.cloneRange(), bounds: scrollParent(start) };
}

function boxOf(rect: DOMRect | { top: number; bottom: number; left: number; right: number }): Box {
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

const supportsHighlight = () => typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";

/**
 * SELECT A PASSAGE IN ANY ANSWER — Ask, Quote, Explain, Copy (G10).
 *
 * One instance per chat, listening to the document's selection. When a
 * selection lies wholly inside one settled answer (message-item marks the
 * prose with `data-answer-text`), a small bar rises beside it:
 *
 *   Ask      the passage becomes the composer's quote chip, the same chip a
 *            canvas or document selection makes, and the composer takes focus.
 *            The passage stays highlighted in the answer while you write
 *            (CSS Custom Highlight API), until the chip is sent or removed.
 *   Quote    the passage goes into the draft as a Markdown blockquote, after
 *            whatever is already written.
 *   Explain  sends "explain this passage" at once.
 *   Copy     copies the passage.
 *
 * Keyboard: Tab from a selection moves into the bar, arrows move along it,
 * Escape dismisses it and clears the selection. Touch: the bar sits below the
 * selection so the system callout above it stays reachable, and every key is
 * 44px tall. Motion: it pops in on the floating-layer spring and out on the
 * exit rung; both are opacity-only under reduced motion.
 */
function AnswerSelectionBarImpl({
  scopeRef,
  activeQuote,
  canSend,
  onAsk,
  onQuote,
  onExplain,
}: {
  scopeRef: React.RefObject<HTMLElement | null>;
  /** The composer's quote right now — the highlight follows it. */
  activeQuote: ComposerQuote | null;
  /** Explain sends a turn; it is offered only when one can be sent. */
  canSend: boolean;
  onAsk: (quote: AnswerQuote) => void;
  onQuote: (markdown: string) => void;
  onExplain: (quote: AnswerQuote) => void;
}) {
  const [captured, setCaptured] = React.useState<Captured | null>(null);
  const [closing, setClosing] = React.useState<Captured | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [, reposition] = React.useReducer((n: number) => n + 1, 0);
  const [size, setSize] = React.useState<{ width: number; height: number } | null>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const barKeys = () => Array.from(barRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
  const capturedRef = React.useRef<Captured | null>(null);
  capturedRef.current = captured;
  // The quote this bar handed the composer, and the range it came from.
  const asked = React.useRef<{ quote: AnswerQuote; range: Range } | null>(null);
  const coarse = React.useMemo(
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches,
    [],
  );

  const dismiss = React.useCallback((opts?: { clearSelection?: boolean }) => {
    const current = capturedRef.current;
    if (!current) return;
    if (opts?.clearSelection) window.getSelection()?.removeAllRanges();
    setClosing(current);
    setCaptured(null);
    setCopied(false);
  }, []);

  // The exit plays on the exit rung, then the closing copy unmounts.
  React.useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(null), 160);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // Follow the selection. Debounced: a drag fires selectionchange per pixel,
  // and touch handles fire it the whole time they move.
  React.useEffect(() => {
    let timer: number | null = null;
    const read = () => {
      const next = readSelection(scopeRef.current);
      if (next) {
        setClosing(null);
        setCopied(false);
        setCaptured(next);
        return;
      }
      // Pressing a key in the bar moves focus, not the selection; only a
      // selection that genuinely went away closes it.
      if (barRef.current?.contains(document.activeElement)) return;
      if (capturedRef.current) dismiss();
    };
    const onChange = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(read, coarse ? 260 : 160);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [coarse, dismiss, scopeRef]);

  // Ride with the selection while the transcript scrolls under it.
  React.useEffect(() => {
    if (!captured) return;
    const onMove = () => reposition();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [captured]);

  React.useLayoutEffect(() => {
    const el = barRef.current;
    if (el) setSize({ width: el.offsetWidth, height: el.offsetHeight });
  }, [captured, canSend]);

  // Keyboard: Tab reaches the bar from the selection, Escape leaves it.
  React.useEffect(() => {
    if (!captured) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const inBar = !!barRef.current?.contains(document.activeElement);
      // Back to the transcript the selection was in, not to <body>.
      const goHome = () => (captured.bounds ?? scopeRef.current)?.focus({ preventScroll: true });
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss({ clearSelection: true });
        if (inBar) goHome();
        return;
      }
      if (e.key === "Tab" && inBar) {
        // The bar is portalled to the end of <body>, so the browser's next
        // stop from it is the address bar. Leaving it (either way) closes it
        // and returns to the transcript, where Tab carries on from the
        // conversation; the selection stays for a second look.
        e.preventDefault();
        dismiss();
        goHome();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey && !inBar && !isEditable(document.activeElement)) {
        const first = barRef.current?.querySelector<HTMLButtonElement>("button");
        if (!first) return;
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [captured, dismiss, scopeRef]);

  // The highlight follows the composer's quote: on while the chip this bar
  // made is waiting, off the moment it is sent, removed or replaced.
  React.useEffect(() => {
    if (!supportsHighlight()) return;
    const mine = asked.current;
    if (mine && activeQuote === mine.quote) {
      CSS.highlights.set(HIGHLIGHT, new Highlight(mine.range));
      return;
    }
    CSS.highlights.delete(HIGHLIGHT);
    if (mine && activeQuote !== mine.quote) asked.current = null;
  }, [activeQuote]);
  React.useEffect(() => {
    // The highlight's colour lives in <head>, not beside the bar: the bar is
    // gone the moment Ask is pressed, and the mark has to outlive it.
    if (!document.getElementById(HIGHLIGHT_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = HIGHLIGHT_STYLE_ID;
      style.textContent = HIGHLIGHT_CSS;
      document.head.appendChild(style);
    }
    return () => {
      if (supportsHighlight()) CSS.highlights.delete(HIGHLIGHT);
    };
  }, []);

  const shown = captured ?? closing;
  if (!shown || typeof document === "undefined") return null;

  const ask = () => {
    if (!captured) return;
    const quote = answerQuoteFor(captured.messageId, captured.text);
    asked.current = { quote, range: captured.range };
    dismiss({ clearSelection: true });
    onAsk(quote);
  };
  const quote = () => {
    if (!captured) return;
    const markdown = blockquoteFor(captured.text);
    dismiss({ clearSelection: true });
    onQuote(markdown);
  };
  const explain = () => {
    if (!captured || !canSend) return;
    const q = answerQuoteFor(captured.messageId, captured.text);
    dismiss({ clearSelection: true });
    onExplain(q);
  };
  const copy = () => {
    if (!captured) return;
    void navigator.clipboard
      ?.writeText(captured.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => dismiss(), 900);
      })
      .catch(() => {});
  };

  const keys: Array<{ id: string; onClick: () => void; node: React.ReactNode; label?: string; hidden?: boolean }> = [
    {
      id: "ask",
      onClick: ask,
      node: (
        <>
          <MessageCircleQuestion className="size-3.5" aria-hidden />
          {SELECTION_BAR_LABEL.ask}
        </>
      ),
    },
    {
      id: "quote",
      onClick: quote,
      node: (
        <>
          <TextQuote className="size-3.5" aria-hidden />
          {SELECTION_BAR_LABEL.quote}
        </>
      ),
    },
    {
      id: "explain",
      onClick: explain,
      hidden: !canSend,
      node: (
        <>
          <Info className="size-3.5" aria-hidden />
          {SELECTION_BAR_LABEL.explain}
        </>
      ),
    },
    {
      id: "copy",
      onClick: copy,
      label: copied ? SELECTION_BAR_LABEL.copied : SELECTION_BAR_LABEL.copy,
      node: <IconSwap swapped={copied} from={<ActionIcons.copy className="size-3.5" />} to={<Check className="size-3.5" />} />,
    },
  ];
  const visibleKeys = keys.filter((k) => !k.hidden);

  const rect = shown.range.getBoundingClientRect();
  const boundsRect = shown.bounds?.getBoundingClientRect();
  const bounds: Box = boundsRect
    ? boxOf(boundsRect)
    : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };
  const placed = placeSelectionBar({
    selection: boxOf(rect),
    bar: size ?? { width: 260, height: 38 },
    bounds,
    prefer: coarse ? "below" : "above",
  });
  const degenerate = !rect.width && !rect.height;

  return createPortal(
    <>
      <div
        ref={barRef}
        role="toolbar"
        aria-label={SELECTION_BAR_LABEL.toolbar}
        aria-orientation="horizontal"
        // Keep the selection: a press on the bar must not collapse the range it acts on.
        onPointerDown={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          const list = barKeys();
          const index = list.findIndex((k) => k === document.activeElement);
          const next = nextToolbarIndex(e.key, index, list.length);
          if (next === null || index < 0) return;
          e.preventDefault();
          list[next]?.focus();
        }}
        style={{
          top: placed.top,
          left: placed.left,
          visibility: size && placed.visible && !degenerate ? "visible" : "hidden",
        }}
        className={cn(
          "surface-float overlay-glass fixed z-toolbar flex items-center gap-0.5 rounded-card p-1",
          captured ? "motion-safe:animate-pop-in" : "pointer-events-none animate-pop-out",
        )}
      >
        {visibleKeys.map((key, i) => (
          <React.Fragment key={key.id}>
            {i > 0 && <span aria-hidden className="h-4 w-px bg-border/70" />}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={key.onClick}
              // Roving tabindex: the bar is one Tab stop, arrows move inside it.
              tabIndex={i === 0 ? 0 : -1}
              aria-label={key.label}
              className={cn(ACTION, key.id === "copy" && "px-2 coarse:px-3")}
            >
              {key.node}
            </Button>
          </React.Fragment>
        ))}
      </div>
      {/* Mounted with the bar and filled once it is live, so the region
          exists before its words change and is actually announced. */}
      <span className="sr-only" role="status" aria-live="polite">
        {captured && size ? SELECTION_BAR_LABEL.hint : ""}
      </span>
    </>,
    document.body,
  );
}

/** Memoised: chat-view re-renders per streamed token, and this needs none of them. */
export const AnswerSelectionBar = React.memo(AnswerSelectionBarImpl);
