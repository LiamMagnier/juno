"use client";

import * as React from "react";
import hljs from "highlight.js/lib/common";
import { canonicalLang } from "@/lib/artifact-runtime";
import { cn } from "@/lib/utils";

/**
 * The house code surface: a flat, full-bleed editor/viewer — line-number
 * gutter, theme-aware syntax highlighting, no window chrome. One component
 * serves every code view (canvas Code tab, inline cards, shared pages) so code
 * reads the same everywhere; `readOnly` decides whether it also writes.
 *
 * Editing uses the classic overlay: a transparent <textarea> exactly on top of
 * the highlighted <pre>. The textarea is the real, accessible control (caret,
 * selection, IME); the pre underneath is presentation only.
 */

// Beyond this size skip highlighting entirely — plain text keeps huge files usable.
const HIGHLIGHT_LIMIT = 60_000;

/** Canonical language key → the grammar hljs/common actually ships. */
const HLJS_ALIASES: Record<string, string> = {
  tsx: "typescript",
  jsx: "javascript",
  html: "xml",
  svg: "xml",
  mermaid: "plaintext",
};

function highlightHtml(content: string, language?: string | null): string | null {
  if (content.length > HIGHLIGHT_LIMIT) return null;
  const lang = canonicalLang(language);
  const grammar = HLJS_ALIASES[lang] ?? lang;
  try {
    if (grammar && hljs.getLanguage(grammar)) {
      return hljs.highlight(content, { language: grammar, ignoreIllegals: true }).value;
    }
  } catch {
    // Bad grammar or pathological input — plain text below.
  }
  return null;
}

export interface CodeSelection {
  text: string;
  /** 1-based line range, exact (derived from the textarea's selection offsets). */
  lineStart: number;
  lineEnd: number;
  /** Viewport rect to anchor a floating toolbar near. */
  rect: { top: number; bottom: number; left: number; width: number };
}

export function CodeSurface({
  value,
  language,
  readOnly,
  onChange,
  onSave,
  onSelect,
  streaming,
  wrap,
  ariaLabel,
  className,
}: {
  value: string;
  language?: string | null;
  readOnly?: boolean;
  onChange?: (next: string) => void;
  /** Cmd/Ctrl+S and Cmd/Ctrl+Enter while editing. */
  onSave?: () => void;
  /** Selection settled or cleared — for Ask/Modify. Fires null when it collapses. */
  onSelect?: (selection: CodeSelection | null) => void;
  /** Pin the scroll to the write cursor while content streams in. */
  streaming?: boolean;
  /** Soft-wrap long lines (prose-like sources — markdown). Off = horizontal scroll. */
  wrap?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const lastPointerRef = React.useRef<{ x: number; y: number } | null>(null);
  const selectDebounceRef = React.useRef<number | null>(null);

  // Count includes the phantom row after a trailing newline — the caret can
  // sit there, so the gutter must number it or it flickers while typing at EOF.
  const lines = React.useMemo(() => value.split("\n").length, [value]);
  const gutterNumbers = React.useMemo(() => Array.from({ length: lines }, (_, i) => i + 1), [lines]);

  // Highlighting runs on a deferred copy of the value: keystrokes update the
  // visible text immediately (plain, correct), colors catch up when the main
  // thread is idle. hljs + full innerHTML re-parse never sits on the input path.
  const deferredValue = React.useDeferredValue(value);
  const highlighted = React.useMemo(() => highlightHtml(deferredValue, language), [deferredValue, language]);
  const showHighlight = highlighted != null && deferredValue === value;

  // Streaming pin only holds while the reader is already at the bottom —
  // scrolling up to read the top of a long artifact must not be fought.
  React.useEffect(() => {
    if (!streaming) return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [streaming, value]);

  const emitSelection = React.useCallback(() => {
    if (!onSelect) return;
    const ta = textareaRef.current;
    if (!ta) return;
    const { selectionStart, selectionEnd } = ta;
    if (selectionStart === selectionEnd) {
      onSelect(null);
      return;
    }
    const text = ta.value.slice(selectionStart, selectionEnd);
    if (!text.trim()) {
      onSelect(null);
      return;
    }
    const lineStart = ta.value.slice(0, selectionStart).split("\n").length;
    const lineEnd = ta.value.slice(0, selectionEnd).split("\n").length;
    // A textarea selection has no DOM Range to measure; anchor the toolbar to
    // the last pointer position when we have one, else to the editor's top.
    const box = (scrollRef.current ?? ta).getBoundingClientRect();
    const anchor = lastPointerRef.current;
    const rect = anchor
      ? { top: anchor.y, bottom: anchor.y, left: anchor.x, width: 0 }
      : { top: Math.max(box.top, 0) + 16, bottom: Math.max(box.top, 0) + 16, left: box.left + box.width / 2, width: 0 };
    onSelect({ text, lineStart, lineEnd, rect });
  }, [onSelect]);

  // Every selection change funnels through the textarea's `select` event —
  // mouse drags, shift+arrows, select-all, collapse-by-arrow, typing-over.
  // Debounced so a drag doesn't strobe the toolbar.
  const handleSelectEvent = React.useCallback(() => {
    if (!onSelect) return;
    if (selectDebounceRef.current != null) window.clearTimeout(selectDebounceRef.current);
    selectDebounceRef.current = window.setTimeout(emitSelection, 250);
  }, [emitSelection, onSelect]);

  // Unmount (tab switch, canvas close) and blur both retract the toolbar; a
  // pointer press ON the toolbar prevents default, so the bar's own buttons
  // never lose the click to this blur. Ref keeps the unmount call current.
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;
  React.useEffect(() => {
    return () => {
      if (selectDebounceRef.current != null) window.clearTimeout(selectDebounceRef.current);
      onSelectRef.current?.(null);
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Mid-IME keydowns report the real key with isComposing — acting on them
    // would corrupt the composition (Escape must close the candidate window,
    // not blur the editor).
    if (e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "Enter")) {
      if (onSave) {
        e.preventDefault();
        onSave();
      }
      return;
    }
    // Plain Tab indents; Shift+Tab is left alone so keyboard users can always
    // walk backward out of the editor.
    if (e.key === "Tab" && !e.shiftKey && !readOnly && onChange) {
      e.preventDefault();
      const ta = e.currentTarget;
      const { selectionStart, selectionEnd } = ta;
      const next = ta.value.slice(0, selectionStart) + "  " + ta.value.slice(selectionEnd);
      onChange(next);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = selectionStart + 2;
      });
    }
    if (e.key === "Escape") {
      // Escape releases the Tab-as-indent trap: retract the toolbar, drop
      // focus, and stop here — panel-level Escape (close, inspect) is the
      // NEXT press, once focus has left the editor.
      e.preventDefault();
      onSelect?.(null);
      e.currentTarget.blur();
    }
  };

  const whitespace = wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre";
  // Identical metrics on both layers — one wrong pixel and the caret drifts.
  const metrics = "font-mono text-xs leading-5 tracking-normal";

  return (
    <div
      ref={scrollRef}
      className={cn("relative h-full overflow-auto overscroll-contain bg-background/40", className)}
    >
      <div className={cn("flex min-h-full", !wrap && "w-max min-w-full")}>
        {/* Gutter — sticky through horizontal scroll, hidden when wrapping
            (wrapped visual rows would desync fixed-height numbers). */}
        {!wrap && (
          <div
            aria-hidden
            className={cn(
              "sticky left-0 z-10 shrink-0 select-none border-r border-border/40 bg-background/85 px-2 py-3 text-right text-muted-foreground/45 backdrop-blur-sm",
              metrics
            )}
          >
            {gutterNumbers.map((n) => (
              <div key={n} className="tabular-nums">
                {n}
              </div>
            ))}
          </div>
        )}

        <div className={cn("relative min-w-0 flex-1", !wrap && "w-max")}>
          <pre aria-hidden className={cn("px-3 py-3 pr-8 text-foreground/85", metrics, whitespace)}>
            {showHighlight ? (
              <code className="hljs bg-transparent p-0" dangerouslySetInnerHTML={{ __html: highlighted }} />
            ) : (
              <code>{value}</code>
            )}
            {/* Trailing newline keeps the pre as tall as the textarea's caret line. */}
            {"\n"}
          </pre>
          <textarea
            ref={textareaRef}
            data-code-surface=""
            value={value}
            readOnly={readOnly || !onChange}
            onChange={(e) => onChange?.(e.target.value)}
            onKeyDown={handleKeyDown}
            onPointerDown={(e) => {
              lastPointerRef.current = { x: e.clientX, y: e.clientY };
            }}
            onPointerUp={(e) => {
              lastPointerRef.current = { x: e.clientX, y: e.clientY };
            }}
            onSelect={handleSelectEvent}
            onBlur={() => onSelect?.(null)}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            wrap={wrap ? "soft" : "off"}
            aria-label={ariaLabel ?? "Source code"}
            className={cn(
              "absolute inset-0 h-full w-full cursor-text resize-none overflow-hidden bg-transparent px-3 py-3 pr-8",
              "text-transparent caret-foreground outline-none",
              "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40",
              metrics,
              whitespace
            )}
          />
        </div>
      </div>
    </div>
  );
}
