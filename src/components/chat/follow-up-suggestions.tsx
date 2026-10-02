"use client";

import * as React from "react";
import { ChevronDown, Plus } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import { useUiPref } from "@/lib/ui-prefs";

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
export function FollowUpSuggestions({ conversationId, onPick, visible: wanted }: FollowUpSuggestionsProps) {
  // Settings › Capabilities › Follow-up suggestions: off means never fetched.
  const [enabled] = useUiPref("followUps");
  const visible = wanted && enabled;
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
           * A hairline, not a lozenge. The composer below is the loudest
           * object on the screen by design; these are a footnote to the reply
           * above, so they are `.control-neu` — an edge at rest, the tonal
           * `--accent` fill under the pointer, and nothing that lifts or casts
           * a shadow (FLAT_UI.md §2). Never a coral wash: coral is reserved
           * for active and selected.
           *
           * `.control-neu` also owns the timing: its transition list and its
           * `:active` dip must not be overridden by a transition-* utility
           * here, or the press snaps. Dealt in on the shared stagger once the
           * reply has finished, and the `+` turns under the pointer — the one
           * gesture the row makes.
           */
          <div
            key={suggestion}
            style={staggerDelay(i)}
            className={cn(
              "group/pill control-neu relative flex min-w-0 gap-1 py-1.5 pl-2.5 pr-1.5 text-left font-sans text-ui font-normal leading-5 text-muted-foreground [animation-fill-mode:backwards] hover:text-foreground coarse:py-2 motion-safe:animate-rise-in",
              isOpen
                // Takes the whole row so the sentence has width to wrap into,
                // instead of unfurling inside a 20rem column. A stadium radius
                // on a multi-line box bows the sides into an ellipse; the card
                // rung keeps the corners honest.
                ? "w-full items-start rounded-card"
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
              // Focus is the global :focus-visible outline (globals.css); the
              // local ring both controls in this pill used to draw suppressed
              // it and substituted an accent ring — on a surface where coral is
              // reserved for chosen things, not focused ones.
              className={cn(
                // No transition or press of its own: the ink is inherited from
                // the pill, and `.control-neu:active` already dips the whole
                // pill on --dur-press when either control inside it is held.
                // A second scale here compounded into a lurch.
                "flex min-w-0 flex-1 gap-1.5 rounded-full text-left",
                isOpen ? "items-start" : "items-center"
              )}
            >
              {/* Marks the pill as "add a turn" rather than a fragment of the
                  reply it sits under. Inherits currentColor, so it warms with
                  the label on hover instead of needing a second colour to keep
                  in sync. The fade rides a wrapper: the glyph's own
                  transition list belongs to its hover turn (globals.css
                  `svg.icon[data-motion]`) and would swallow one written on it. */}
              <span
                aria-hidden="true"
                className={cn(
                  "inline-flex shrink-0 opacity-60 transition-opacity duration-fast ease-out-soft group-hover/pill:opacity-100",
                  // 14px glyph on a 20px line: 3px centres it on the first line.
                  isOpen && "mt-[3px]"
                )}
              >
                <Plus className="size-3.5" />
              </span>
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
                  // 24px minimum, the rule empty-state.tsx cites. At h-5/coarse:h-6
                  // this was a 20px box rising to 24 — the smallest target on the
                  // chat surface, and below the floor on a pointer device. The
                  // glyph stays 14px; only the box grows.
                  // `hover:bg-border`, not `/40`. The pill under this glyph is
                  // already `bg-accent` by the time the pointer reaches the
                  // chevron, and --border at 40% over --accent computes to a
                  // 1.2-point step — the chevron's own hover was invisible
                  // because it only ever fires on top of the pill's.
                  // No `motion-reduce:transition-none`: this is a tonal
                  // cross-fade, and reduced motion keeps fades on their timing
                  // (ICONS_AND_MOTION.md §2.2, rule 10). The caret's turn
                  // below is travel, so that one still snaps.
                  "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors duration-fast ease-out-soft hover:bg-border hover:text-foreground coarse:size-8",
                  // Rides the first line when the pill is a tall wrapped block.
                  isOpen ? "self-start" : "self-center"
                )}
              >
                <ChevronDown
                  aria-hidden="true"
                  className={cn(
                    // A caret is an A-to-B move with both ends on screen, so it
                    // turns on the symmetric curve (ICONS_AND_MOTION.md §2.2.6).
                    "size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none",
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
