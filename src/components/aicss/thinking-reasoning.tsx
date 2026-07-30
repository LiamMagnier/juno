"use client";

import * as React from "react";
import { ThinkingState } from "@/components/aicss/thinking-state";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────────
 * AIcss "Thinking + Reasoning" — the live trace, and the one component here that
 * needed rewriting rather than porting.
 *
 * AIcss ships it as a self-running demo: six hardcoded sentences on a
 * setTimeout ladder, an elapsed time computed from the sum of those delays. That
 * is a film of a component. This takes the same geometry, the same easing and
 * the same masking, and drives them from lines that actually arrived.
 *
 * WHY THE TRANSCRIPT CAN CARRY THIS AT ALL. `activity-timeline.tsx` deliberately
 * refused to preview streaming reasoning, and the reason was sound: provider
 * summaries arrive as half-finished sentences, stray code and media queries, and
 * a raw growing <pre> of that above the answer made the transcript look broken.
 * The refusal was about the CONTAINER, not the content. This container is a
 * fixed viewport of 40px slots, each clamped to two lines, that grows to 180px
 * and then scrolls behind a mask. Nothing reflows under the reader, nothing
 * unbounded arrives, and a half-finished sentence is simply the last of six
 * quiet grey lines. The content is still evidence rather than headline — it is
 * only now legible evidence.
 *
 * DROPPED FROM THE ORIGINAL: `width: 360px` and `min-height: 206px` on the root.
 * Both exist to stop AIcss's fixed preview cell jumping as the viewport grows.
 * In a transcript the header is the first child and stays put on its own, and a
 * 206px floor would punch a permanent hole above every answer.
 * ───────────────────────────────────────────────────────────────────────────── */

/** Geometry — keep in sync with `.aicss-tr-*` in globals.css. */
const SENT_H = 40; // 2 lines × 20px
const GAP = 4;
const MAX_H = 180; // the viewport grows with content to here, then scrolls
const FADE = 16; // top/bottom fade once capped

export function ThinkingReasoning({
  lines,
  streaming,
  /** Preformatted by the caller, so this never becomes a second opinion on how
   *  long the run took. See `formatSpan` in thought-process-panel.tsx. */
  duration,
  label = "Thinking…",
  showHeader = true,
  className,
  id,
}: {
  lines: string[];
  streaming?: boolean;
  duration?: string | null;
  label?: string;
  /**
   * Drop the header and render the viewport alone.
   *
   * For the live strip, where the row above is ALREADY the shimmering label and
   * is also the control that opens the thought-process panel. Two headers would
   * say "Thinking" twice, and a header inside that row would be a <button>
   * inside a <button> — which is invalid and which browsers resolve by dropping
   * one of them.
   */
  showHeader?: boolean;
  className?: string;
  id?: string;
}) {
  // While the run is live the trace is always open; once it settles it folds
  // into its own summary and the reader can put it back.
  const [open, setOpen] = React.useState(false);
  const [fade, setFade] = React.useState({ top: false, bottom: true });
  const viewportRef = React.useRef<HTMLDivElement>(null);

  const done = !streaming;
  // Headless has no control to fold it with, so it is never folded.
  const expanded = showHeader ? (done ? open : true) : true;
  const count = lines.length;
  const contentH = count > 0 ? count * SENT_H + (count - 1) * GAP : 0;
  const capped = contentH > MAX_H;
  const viewH = capped ? MAX_H : contentH;
  // Native scrolling belongs to the reader, so it is armed only once nothing is
  // arriving. While streaming the stream is translated instead, which is what
  // keeps the newest line pinned without fighting a scroll position.
  const scrollable = done && expanded;
  const translate = scrollable ? 0 : capped ? MAX_H - FADE - contentH : 0;

  const showTop = scrollable ? fade.top : capped;
  const showBottom = scrollable ? fade.bottom : capped;
  const mask = capped
    ? `linear-gradient(to bottom, transparent 0, #000 ${showTop ? FADE : 0}px, #000 calc(100% - ${
        showBottom ? FADE : 0
      }px), transparent 100%)`
    : undefined;

  const onScroll = () => {
    const el = viewportRef.current;
    if (!el) return;
    setFade({
      top: el.scrollTop > 1,
      bottom: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
    });
  };

  const toggle = () => {
    const next = !open;
    if (next) {
      setFade({ top: false, bottom: true });
      if (viewportRef.current) viewportRef.current.scrollTop = 0;
    }
    setOpen(next);
  };

  // No lines is no block. A header alone would claim a trace that never arrived,
  // and headless it would be an empty 0px viewport holding a margin open.
  if (count === 0) return null;

  const bodyId = id ? `${id}-stream` : undefined;

  return (
    <div className={cn("aicss-tr", className)}>
      {showHeader && (
        <button
          type="button"
          className="aicss-tr-header"
          data-clickable={done ? "true" : "false"}
          aria-expanded={expanded}
          aria-controls={done && open ? bodyId : undefined}
          aria-label={done ? "Toggle thought" : undefined}
          onClick={done ? toggle : undefined}
        >
          {done ? (
            <span className="aicss-tr-label">
              <span className="aicss-tr-verb">Thought</span>
              {duration ? ` for ${duration}` : ""}
            </span>
          ) : (
            // The header IS the Thinking State component — one shimmer definition
            // for the collapsed strip, this header and the search label.
            <ThinkingState className="aicss-tr-label">{label}</ThinkingState>
          )}
          {done && (
            <svg className="aicss-tr-chevron" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path
                d="m4.5 15.75 7.5-7.5 7.5 7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
      )}

      <div className="aicss-tr-collapsible" data-collapsed={expanded ? "false" : "true"}>
        <div className="aicss-tr-inner">
          <div
            id={bodyId}
            ref={viewportRef}
            className="aicss-tr-viewport"
            data-scroll={scrollable ? "true" : "false"}
            style={{ height: `${viewH}px`, WebkitMaskImage: mask, maskImage: mask }}
            onScroll={scrollable ? onScroll : undefined}
          >
            <div className="aicss-tr-stream" style={{ transform: `translateY(${translate}px)` }}>
              {lines.map((line, i) => (
                // Keyed by position, never by the text: providers repeat both
                // titles and ordinals within one response (see the note in
                // thought-process-panel.tsx), and either would collide two lines
                // into one and drop the later text.
                <p key={i} className="aicss-tr-sentence">
                  {line}
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
