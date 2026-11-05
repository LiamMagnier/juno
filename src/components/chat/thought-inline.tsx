"use client";

import * as React from "react";
import { PanelRight } from "@/components/ui/icons";
import { AppIcons, CodeIcons, ComposerIcons } from "@/lib/app-icons";
import { ReceiptGlyph } from "@/components/chat/tool-receipt";
import { SourceFavicon, isRenderableSourceUrl } from "@/components/chat/source-chip";
import { compactTrace, traceTail, type CompactRow } from "@/lib/chat/compact-trace";
import { formatSpan, isCutShortNotice, type RunModel } from "@/components/chat/thought-process-model";
import { cn } from "@/lib/utils";

/*
 * The inline copy, as a `…_LABEL` constant the i18n extractor walks in full
 * (scripts/generate-i18n-catalog.mjs). Counts ride beside these words, never
 * inside them, so one translation serves every number.
 */
export const THOUGHT_INLINE_LABEL = {
  region: "Thought process",
  openFull: "Open full trace",
  sources: "Sources",
  memories: "Memories used",
  more: "more in the full trace",
  reasoningScroller: "Reasoning",
} as const;

/** How many source titles and memories are named before the rest are counted. */
const NAMED_SOURCES = 3;
const NAMED_MEMORIES = 3;

/**
 * THE RUN, READ IN PLACE — the disclosure under the live line.
 *
 * Pressing the run strip unfolds this beneath it (Collapse: grid rows 0fr →
 * 1fr with a fade, snapped under reduced motion), so the reasoning, searches,
 * tool and skill receipts and the memories the turn drew on can be read
 * without the conversation giving way to a panel. It stays open after the
 * answer lands, in the past tense, for as long as the reader wants it.
 *
 * It is a reading view of the same RunModel the dock draws — built once, by
 * the strip's one clock — folded into fewer rows (compact-trace.ts). The full
 * trace, with filters, find and every tool's arguments, is one press further:
 * the dock on a wide screen, a bottom sheet on a phone.
 */
export function ThoughtInline({
  id,
  run,
  streaming,
  onOpenFull,
  fullOpen,
  fullControls,
  fullButtonRef,
}: {
  id: string;
  run: RunModel;
  streaming?: boolean;
  onOpenFull: () => void;
  /** The full trace is showing (dock or sheet). */
  fullOpen: boolean;
  /** The DOM id of whatever `onOpenFull` shows, while it shows. */
  fullControls?: string;
  /** "Open full trace" itself, so focus can come back to it when the dock closes. */
  fullButtonRef?: React.Ref<HTMLButtonElement>;
}) {
  const rows = React.useMemo(() => inlineRows(run), [run]);
  const lastReasoning = React.useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].kind === "reasoning") return rows[i].id;
    return null;
  }, [rows]);

  return (
    <div
      id={id}
      role="region"
      aria-label={THOUGHT_INLINE_LABEL.region}
      // Model text and run receipts: AutoTranslate leaves them as written.
      data-no-auto-translate
      className="mb-3 ml-1 border-l border-border/70 pl-4"
    >
      {rows.length > 0 && (
        <ol className="space-y-3 pt-1">
          {rows.map((row) => (
            <li key={row.id} className="min-w-0">
              <InlineRow row={row} live={!!streaming && row.id === lastReasoning} />
            </li>
          ))}
        </ol>
      )}
      <button
        ref={fullButtonRef}
        type="button"
        onClick={onOpenFull}
        aria-expanded={fullOpen}
        aria-controls={fullOpen ? fullControls : undefined}
        className={cn(
          "-ml-2 mt-2 inline-flex h-7 items-center gap-1 rounded-control px-2 text-caption text-muted-foreground",
          "transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground coarse:h-11",
          fullOpen && "bg-accent text-foreground",
        )}
      >
        {THOUGHT_INLINE_LABEL.openFull}
        {/* A side panel in the app, not a page elsewhere: the panel glyph,
            not the external-link arrow. */}
        <PanelRight className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The rows the inline trace draws, from the run's compact rows.
 *
 * A settled write step says only that the answer was written, and the answer
 * is right below: it is a row that tells the reader nothing. One that was
 * cut short is kept, because it says where the answer stopped, and it takes
 * the reason with it: the finish's notice ("Response hit the token limit · …",
 * "Stopped by user · …") becomes its detail line instead of a second row, so
 * one cut reads as one row, not as two failures stacked.
 */
export function inlineRows(run: Pick<RunModel, "steps">): CompactRow[] {
  const rows = compactTrace(run).filter((row) => !(row.kind === "step" && row.stepKind === "write" && !row.running && !row.failed));
  const write = rows.findIndex((row) => row.kind === "step" && row.stepKind === "write" && row.failed);
  if (write < 0) return rows;
  let notice = -1;
  for (let i = write - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === "step" && row.stepKind === "notice" && isCutShortNotice(row.label)) {
      notice = i;
      break;
    }
  }
  if (notice < 0) return rows;
  const reason = rows[notice] as Extract<CompactRow, { kind: "step" }>;
  const cut = rows[write] as Extract<CompactRow, { kind: "step" }>;
  return rows.flatMap((row, i) => (i === notice ? [] : i === write ? [{ ...cut, detail: reason.label }] : [row]));
}

function InlineRow({ row, live }: { row: CompactRow; live: boolean }) {
  if (row.kind === "reasoning") return <ReasoningSection heading={row.heading} text={row.text} live={live} />;
  if (row.kind === "sources") return <SourcesRow sources={row.sources} />;
  if (row.kind === "memory") return <MemoryRow items={row.items} />;
  return (
    <div className="flex min-w-0 items-start gap-2.5 text-ui">
      <span
        aria-hidden="true"
        className={cn(
          "mt-[3px] flex size-4 shrink-0 items-center justify-center text-muted-foreground",
          // The panel's ink for a step that ended badly (thought-process-panel
          // StepRow): amber, a caution, not the red of a destructive act.
          row.failed && "text-warning",
          // Work happening now wears the one live colour and breathes, as the
          // panel's running marker does; a still dot read as a list bullet.
          row.running && "text-presence motion-safe:animate-icon-breathe",
        )}
      >
        <StepGlyph row={row} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* Wraps, never cut: on a phone a CSS ellipsis ended a long search
              or notice mid-word. */}
          <span className={cn("min-w-0 break-words text-pretty", "text-foreground", row.failed && "text-warning")}>
            {row.label}
          </span>
          {row.ms !== null && !row.running && (
            <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{formatSpan(row.ms)}</span>
          )}
        </div>
        {row.detail && <p className="mt-0.5 line-clamp-2 break-words text-caption text-muted-foreground">{row.detail}</p>}
      </div>
    </div>
  );
}

/** The reasoning mark: a small dot in the row's ink, inline and as a section's lead. */
function ThinkDot() {
  return <span className="size-1.5 rounded-full bg-current" />;
}

function StepGlyph({ row }: { row: Extract<CompactRow, { kind: "step" }> }) {
  if (row.icon) return <ReceiptGlyph kind={row.icon} className="size-3.5" />;
  if (row.stepKind === "think") return <ThinkDot />;
  // The panel's own markers (thought-process-panel StepMarker), so a step
  // wears the same drawing inline and in the full trace.
  const Glyph =
    row.stepKind === "search"
      ? ComposerIcons.web
      : row.stepKind === "notice"
        ? CodeIcons.error
        : row.stepKind === "write"
          ? AppIcons.artifacts
          : row.stepKind === "remember"
            ? ComposerIcons.memory
            : AppIcons.connections;
  return <Glyph className="size-3.5" />;
}

/**
 * The model's own reasoning, in its own paragraphs. A part's bold heading, when
 * it wrote one, leads. Bounded with its own scroller so a long trace never
 * pushes the answer a screen down; while it streams, only the tail is shown,
 * so the section reads what the model is on now.
 */
function ReasoningSection({ heading, text, live }: { heading: string | null; text: string; live: boolean }) {
  const shown = live ? traceTail(text) : { text, clipped: false };
  const paragraphs = shown.text
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className="min-w-0">
      {/* Led like every other row, the mark on the glyph column and the
          model's heading (or "Reasoning") on the label column, so the prose
          under it reads as this row's body, not a stray grey paragraph. */}
      <div className="flex min-w-0 items-start gap-2.5 text-ui">
        <span aria-hidden="true" className="mt-[3px] flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <ThinkDot />
        </span>
        <p className="min-w-0 text-foreground">{heading ?? THOUGHT_INLINE_LABEL.reasoningScroller}</p>
      </div>
      <div
        // Focusable so a keyboard can scroll it; named so a screen reader says what it is.
        tabIndex={0}
        aria-label={heading ?? THOUGHT_INLINE_LABEL.reasoningScroller}
        className="mt-1 max-h-72 space-y-2 overflow-y-auto overscroll-contain rounded-sm pl-[26px] pr-1 text-ui leading-relaxed text-muted-foreground"
      >
        {paragraphs.map((p, i) => (
          <p key={i} className="whitespace-pre-wrap break-words">
            {i === 0 && shown.clipped ? `… ${p}` : p}
          </p>
        ))}
      </div>
    </div>
  );
}

function SourcesRow({ sources }: { sources: { url: string; domain: string; title: string }[] }) {
  const named = sources.slice(0, NAMED_SOURCES);
  const rest = sources.length - named.length;
  return (
    <div className="min-w-0 text-ui">
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="flex shrink-0 -space-x-1.5">
          {sources.slice(0, 5).map((s) => (
            <SourceFavicon key={s.url} url={s.url} variant="cluster" className="ring-2 ring-background" />
          ))}
        </span>
        <span className="text-foreground">{THOUGHT_INLINE_LABEL.sources}</span>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">{sources.length}</span>
      </div>
      {/* On the label column, as the memory list is. */}
      <ul className="mt-1.5 space-y-1 pl-[26px]">
        {named.map((s) => (
          // Two lines, wrapped at words, never cut mid-word by a CSS
          // ellipsis on a phone ("…evidence fr…").
          <li key={s.url} className="line-clamp-2 min-w-0 break-words text-pretty text-caption">
            {isRenderableSourceUrl(s.url) ? (
              <a
                href={s.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground underline-offset-2 transition-colors duration-fast hover:text-foreground hover:underline"
              >
                {s.title}
                {/* An untitled source's title IS its domain: say it once. */}
                {s.title !== s.domain && <span>{` · ${s.domain}`}</span>}
              </a>
            ) : (
              <span className="text-muted-foreground">{s.title}</span>
            )}
          </li>
        ))}
        {rest > 0 && (
          <li className="text-caption text-muted-foreground">
            <span className="font-mono tabular-nums">{`+${rest}`}</span> {THOUGHT_INLINE_LABEL.more}
          </li>
        )}
      </ul>
    </div>
  );
}

function MemoryRow({ items }: { items: string[] }) {
  const named = items.slice(0, NAMED_MEMORIES);
  const rest = items.length - named.length;
  return (
    <div className="min-w-0 text-ui">
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <ComposerIcons.memory className="size-3.5" />
        </span>
        <span className="text-foreground">{THOUGHT_INLINE_LABEL.memories}</span>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">{items.length}</span>
      </div>
      <ul className="mt-1.5 space-y-1 pl-[26px]">
        {named.map((item, i) => (
          <li key={i} className="line-clamp-2 break-words text-caption text-muted-foreground">
            {item}
          </li>
        ))}
        {rest > 0 && (
          <li className="text-caption text-muted-foreground">
            <span className="font-mono tabular-nums">{`+${rest}`}</span> {THOUGHT_INLINE_LABEL.more}
          </li>
        )}
      </ul>
    </div>
  );
}
