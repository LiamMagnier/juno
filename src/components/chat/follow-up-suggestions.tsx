"use client";

import * as React from "react";
import { Plus } from "lucide-react";

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
        React.startTransition(() => setSuggestions(next));
      })
      .catch(() => {});

    return () => controller.abort();
  }, [conversationId, visible]);

  if (!visible || suggestions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" role="group" aria-label="Suggested follow-ups">
      {suggestions.map((suggestion, i) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onPick(suggestion)}
          // No `title`: the accessible name is already this exact sentence, so a
          // title would be announced again as the description — the same text
          // twice. Truncation is cosmetic; clicking sends the full suggestion.
          style={{ animationDelay: `${i * 55}ms` }}
          /*
           * Ghost, not lozenge. The composer 8px below is `bg-card/90` +
           * shadow-float + rounded-panel — the loudest object on the screen by
           * design. These are a footnote to the reply above, so they carry no
           * fill and no shadow at rest and only materialise a surface under the
           * cursor; that hierarchy is what stops them competing with it.
           *
           * Hover is a LIFT (translate + shadow), never a coral wash — coral is
           * reserved for active/selected. `shadow-soft` rather than the pills'
           * `shadow-float`: float reaches ~40px below the element, which would
           * both dive under the composer's opaque shell and get smeared through
           * its backdrop-blur. soft reaches ~6px and fits the 8px gap cleanly.
           *
           * `relative` + `hover:z-10`: a wrapped neighbour's background would
           * otherwise paint over this one's shadow and slice it into a hard edge.
           */
          className="group/pill relative inline-flex min-w-0 max-w-[min(20rem,100%)] shrink-0 items-center gap-1.5 rounded-full border border-border/60 py-1.5 pl-2.5 pr-3 text-left font-sans text-sm font-normal leading-5 text-muted-foreground transition-[transform,background-color,border-color,box-shadow,color] duration-base ease-spring [animation-fill-mode:backwards] hover:z-10 hover:-translate-y-0.5 hover:border-border hover:bg-accent hover:text-foreground hover:shadow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0 active:scale-[0.98] coarse:py-2 motion-safe:animate-rise-in motion-reduce:transition-none"
        >
          {/* Marks the pill as "add a turn" rather than a fragment of the reply
              it sits under. Inherits currentColor, so it warms with the label on
              hover instead of needing a second colour to keep in sync. */}
          <Plus
            aria-hidden="true"
            className="h-3.5 w-3.5 shrink-0 opacity-60 transition-opacity duration-base ease-spring group-hover/pill:opacity-100"
          />
          <span className="truncate">{suggestion}</span>
        </button>
      ))}
    </div>
  );
}
