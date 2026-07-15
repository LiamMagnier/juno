"use client";

import * as React from "react";
import { ChevronDown, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface FollowUpSuggestionsProps {
  conversationId: string;
  onPick: (text: string) => void;
  /** True once the assistant's reply has finished streaming. */
  visible: boolean;
}

type FollowUpResponse = {
  suggestions?: unknown;
};

/**
 * Clickable follow-up prompts under a finished reply. Renders nothing while
 * loading and nothing when empty — deliberately no skeleton, because this sits
 * directly under the last message and any placeholder would shove the thread
 * (and the user's scroll position) on every turn.
 */
export function FollowUpSuggestions({ conversationId, onPick, visible }: FollowUpSuggestionsProps) {
  const [suggestions, setSuggestions] = React.useState<string[]>([]);
  // Per-pill, not global: each suggestion opens on its own.
  const [expanded, setExpanded] = React.useState<ReadonlySet<number>>(() => new Set());
  const [clipped, setClipped] = React.useState<readonly boolean[]>([]);
  const labelRefs = React.useRef<(HTMLSpanElement | null)[]>([]);

  React.useEffect(() => {
    // Drop immediately: suggestions belong to the turn they were fetched for,
    // and must never linger over a new reply or another conversation.
    setSuggestions([]);
    if (!visible) return;

    const controller = new AbortController();
    fetch("/api/chat/follow-ups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
      signal: controller.signal,
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: FollowUpResponse | null) => {
        const next = (Array.isArray(data?.suggestions) ? data.suggestions : [])
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim())
          .slice(0, 3);
        React.startTransition(() => {
          setSuggestions(next);
          setExpanded(new Set());
        });
      })
      .catch(() => {});

    return () => controller.abort();
  }, [conversationId, visible]);

  /*
   * A pill only earns a chevron when its own label is genuinely cut off —
   * measured, not assumed. Short suggestions fit whole, and a control that
   * expands nothing is a dead control. Re-measures on resize because the
   * cutoff moves with the composer's width.
   *
   * An expanded pill reads as "not clipped" (nothing is truncated once it
   * wraps), which would retract the chevron the user just pressed and strand
   * them with no way back. So its last collapsed reading is carried forward
   * instead of re-measured.
   */
  React.useLayoutEffect(() => {
    if (suggestions.length === 0) return;
    const measure = () =>
      setClipped((prev) =>
        suggestions.map((_, i) => {
          if (expanded.has(i)) return prev[i] ?? true;
          const el = labelRefs.current[i];
          return el != null && el.scrollWidth > el.clientWidth + 1;
        }),
      );
    measure();
    const observer = new ResizeObserver(measure);
    for (const el of labelRefs.current) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, suggestions]);

  const toggle = React.useCallback((i: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(i)) next.add(i);
      return next;
    });
  }, []);

  if (!visible || suggestions.length === 0) return null;

  return (
    // items-start, not items-center: an expanded pill is taller than its
    // collapsed neighbours and centring would float them against its midline.
    <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5" role="group" aria-label="Suggested follow-ups">
      {suggestions.map((suggestion, i) => {
        const isOpen = expanded.has(i);
        const hasChevron = isOpen || clipped[i] === true;
        return (
          /*
           * A div, not a button: the chevron is its own control, and a button
           * nested inside a button is invalid HTML that browsers reflow into
           * siblings — the pill would fall apart. So the shell carries the
           * chrome and the two real controls sit inside it, split-button style.
           *
           * Ghost, not lozenge. The composer 8px below is `bg-card/90` +
           * shadow-float + rounded-panel — the loudest object on the screen by
           * design. These are a footnote to the reply above, so they carry no
           * fill and no shadow at rest and only materialise a surface under the
           * cursor; that hierarchy is what stops them competing with it.
           *
           * Hover is a LIFT (translate + shadow), never a coral wash — coral is
           * reserved for active/selected. `shadow-soft` rather than
           * `shadow-float`: float reaches ~40px below the element, which would
           * both dive under the composer's opaque shell and get smeared through
           * its backdrop-blur. soft reaches ~6px and fits the 8px gap cleanly.
           *
           * `relative` + `hover:z-10`: a wrapped neighbour's background would
           * otherwise paint over this one's shadow and slice it into a hard edge.
           */
          <div
            key={suggestion}
            style={{ animationDelay: `${i * 55}ms` }}
            className={cn(
              "group/pill relative flex min-w-0 gap-1 border border-border/60 py-1.5 pl-2.5 pr-1.5 text-left font-sans text-sm font-normal leading-5 text-muted-foreground transition-[transform,background-color,border-color,box-shadow,color] duration-base ease-spring [animation-fill-mode:backwards] hover:z-10 hover:-translate-y-0.5 hover:border-border hover:bg-accent hover:text-foreground hover:shadow-soft coarse:py-2 motion-safe:animate-rise-in motion-reduce:transition-none",
              isOpen
                // Takes the whole row so the sentence has width to wrap into,
                // instead of unfurling inside a 20rem column. A stadium radius
                // on a multi-line box bows the sides into an ellipse; 2xl (16px
                // — this scale is non-monotonic) keeps the corners honest.
                ? "w-full items-start rounded-2xl"
                : "max-w-[min(20rem,100%)] shrink-0 items-center rounded-full"
            )}
          >
            <button
              type="button"
              onClick={() => onPick(suggestion)}
              // No `title`: the accessible name is already this exact sentence,
              // so a title would be announced again as the description — the
              // same text twice. Truncation is cosmetic; clicking sends the
              // full suggestion either way.
              className={cn(
                "flex min-w-0 flex-1 gap-1.5 rounded-full text-left transition-[color] duration-base ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98] motion-reduce:transition-none",
                isOpen ? "items-start" : "items-center"
              )}
            >
              {/* Marks the pill as "add a turn" rather than a fragment of the
                  reply it sits under. Inherits currentColor, so it warms with
                  the label on hover instead of needing a second colour to keep
                  in sync. */}
              <Plus
                aria-hidden="true"
                className={cn(
                  "h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity duration-base ease-spring group-hover/pill:opacity-100",
                  // 14px glyph on a 20px line: 3px centres it on the first line.
                  isOpen && "mt-[3px]"
                )}
              />
              <span
                ref={(el) => {
                  labelRefs.current[i] = el;
                }}
                className={isOpen ? "whitespace-normal" : "truncate"}
              >
                {suggestion}
              </span>
            </button>

            {/* Icon only, and only once this pill's own label is provably cut
                off. Kept mounted-or-absent rather than hidden so it never
                occupies width on a pill that has nothing to reveal. */}
            {hasChevron && (
              <button
                type="button"
                onClick={() => toggle(i)}
                aria-expanded={isOpen}
                aria-label={isOpen ? "Collapse suggestion" : "Show full suggestion"}
                className={cn(
                  "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-[color,background-color] duration-base ease-spring hover:bg-border/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background coarse:h-6 coarse:w-6 motion-reduce:transition-none",
                  // Rides the first line when the pill is a tall wrapped block.
                  isOpen ? "self-start" : "self-center"
                )}
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    "h-3.5 w-3.5 transition-transform duration-base ease-spring motion-reduce:transition-none",
                    isOpen && "rotate-180"
                  )}
                />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
