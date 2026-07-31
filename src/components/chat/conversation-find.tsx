"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  findInConversation,
  stepMatch,
  type SearchableMessage,
} from "@/lib/conversation-search";
import { cn } from "@/lib/utils";

/**
 * Find within the open conversation.
 *
 * Server-side search matches conversation TITLES only, because message bodies
 * are encrypted at rest and SQL `contains` cannot see them — a good security
 * decision that left Juno unable to find a phrase in the conversation you were
 * currently reading, which every incumbent can do.
 *
 * The open transcript is the one place the plaintext legitimately exists: the
 * client already holds it to render it. Searching there adds no server surface
 * and weakens the at-rest guarantee not at all. It is not cross-conversation
 * search — that would require giving up the encryption — but it is most of the
 * value.
 *
 * Matching lives in @/lib/conversation-search, tested; this is the control.
 */
export function ConversationFind({
  messages,
  onClose,
}: {
  messages: readonly SearchableMessage[];
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [index, setIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const matches = React.useMemo(() => findInConversation(messages, query), [messages, query]);

  React.useEffect(() => setIndex(0), [query]);
  React.useEffect(() => inputRef.current?.focus(), []);

  // Scroll the current match into view. The anchor is the per-message wrapper
  // MessageList renders; jumping to the message rather than the character keeps
  // this independent of how a message is laid out.
  const current = matches[index];
  React.useEffect(() => {
    if (!current) return;
    document
      .querySelector(`[data-message-id="${CSS.escape(current.messageId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [current]);

  const go = (direction: 1 | -1) => setIndex((i) => stepMatch(i, matches.length, direction));

  return (
    <div
      role="search"
      aria-label="Find in conversation"
      className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 py-2"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-input bg-background px-3 py-1.5 field-well transition-[border-color] duration-base ease-out-soft focus-within:border-foreground/70">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") {
              e.preventDefault();
              go(e.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Find in this conversation"
          aria-label="Find in this conversation"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {query.trim() !== "" && (
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "shrink-0 font-mono text-caption tabular-nums",
              matches.length === 0 ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {matches.length === 0 ? "No matches" : `${index + 1} of ${matches.length}`}
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => go(-1)}
        disabled={matches.length === 0}
        aria-label="Previous match"
      >
        <ChevronUp className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => go(1)}
        disabled={matches.length === 0}
        aria-label="Next match"
      >
        <ChevronDown className="h-4 w-4" />
      </Button>
      <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close find">
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
