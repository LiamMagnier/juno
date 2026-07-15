"use client";

import * as React from "react";

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
    <div className="flex flex-wrap gap-2" role="group" aria-label="Suggested follow-ups">
      {suggestions.map((suggestion, i) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onPick(suggestion)}
          style={{ animationDelay: `${i * 60}ms` }}
          // Same chip anatomy as the empty-state pills. Hover is a LIFT, not a
          // colour wash — coral stays reserved for selected state.
          className="relative inline-flex max-w-full shrink-0 items-center rounded-full border border-border/70 bg-card/70 px-3.5 py-2 text-left font-sans text-sm leading-5 text-foreground/80 shadow-soft backdrop-blur transition-[transform,background-color,border-color,box-shadow,color] duration-base ease-spring [animation-fill-mode:backwards] hover:z-10 hover:-translate-y-0.5 hover:border-border hover:bg-card hover:text-foreground hover:shadow-float active:translate-y-0 active:scale-[0.98] motion-safe:animate-fade-in motion-reduce:transition-none"
        >
          <span className="truncate">{suggestion}</span>
        </button>
      ))}
    </div>
  );
}
