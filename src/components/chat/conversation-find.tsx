"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, Search } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { fieldFrameClass, fieldGroupClass, fieldHeightClass } from "@/components/ui/field-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  searchConversation,
  selectedMatchIndex,
  stepMatch,
  type SearchSelection,
  type SearchableMessage,
} from "@/lib/conversation-search";
import { focusTranscriptMessage } from "@/lib/chat/transcript-window";
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
  onSearch,
  onClose,
  loadingHistory = false,
  hasOlderHistory = false,
}: {
  messages: readonly SearchableMessage[];
  /**
   * Called when Find opens. A paged transcript holds only
   * its newest part; prefetch the rest before typing so every match is counted — still
   * on the client, decrypted the same way it is for reading.
   */
  onSearch?: () => void;
  onClose: () => void;
  loadingHistory?: boolean;
  hasOlderHistory?: boolean;
}) {
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    onSearch?.();
  }, [onSearch]);
  const [selection, setSelection] = React.useState<SearchSelection | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const helpId = React.useId();

  // `messages` gets a new identity on every streamed token — use-chat rebuilds
  // the array per delta — and re-scanning every body at that rate rebuilds
  // preview strings for up to 500 matches, tens of times a
  // second. Deferring lets React drop the intermediate values and run the scan
  // once the burst settles; the search is a read-only overlay, so a frame of lag
  // behind the live transcript costs nothing.
  const deferredMessages = React.useDeferredValue(messages);
  const { matches, truncated } = React.useMemo(
    () => searchConversation(deferredMessages, query),
    [deferredMessages, query]
  );
  const index = selectedMatchIndex(matches, selection);
  const current = matches[index];

  React.useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = rootRef.current;
    inputRef.current?.focus();
    return () => {
      // Closing an input otherwise drops keyboard focus on <body>. Do not
      // reclaim it if the reader deliberately moved to another control.
      const active = document.activeElement;
      if (opener?.isConnected && (active === document.body || root?.contains(active))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const currentMessageId = current?.messageId;
  const currentStart = current?.start;
  const currentEnd = current?.end;
  React.useEffect(() => {
    // The active hit, not its array offset, stays selected when a page of
    // older messages lands. A deleted hit falls back to a valid nearby hit.
    setSelection(currentMessageId !== undefined && currentStart !== undefined && currentEnd !== undefined
      ? { messageId: currentMessageId, start: currentStart, end: currentEnd, index }
      : null);
  }, [currentMessageId, currentStart, currentEnd, index, query]);

  // Scroll the current match into view. The anchor is the per-message wrapper
  // MessageList renders; jumping to the message rather than the character keeps
  // this independent of how a message is laid out.
  //
  // Keyed on the hit's message id and offsets, NOT on the match object: that object
  // is freshly allocated every time `matches` recomputes, so an object dependency
  // re-fired this effect on every token. A smooth scrollIntoView then ran
  // continuously against MessageList's own layout effect pinning scrollTop to the
  // bottom — two writers fighting over one scroll position, which read as the
  // transcript yanking and made it impossible to scroll anywhere by hand.
  React.useEffect(() => {
    if (!currentMessageId) return;
    focusTranscriptMessage(currentMessageId);
  }, [currentMessageId, currentStart, currentEnd]);

  const go = (direction: 1 | -1) => {
    const nextIndex = stepMatch(index, matches.length, direction);
    const next = matches[nextIndex];
    if (next) setSelection({ messageId: next.messageId, start: next.start, end: next.end, index: nextIndex });
  };

  return (
    <div
      ref={rootRef}
      role="search"
      aria-label="Find in conversation"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
        if (e.key !== "Escape") return;
        // The composer uses unclaimed Escape to stop a generation. Closing
        // Find must claim it, including when a navigation button has focus.
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      // Settles in over the transcript rather than cutting in above it.
      className="mx-auto w-full transcript-column px-4 py-2 motion-safe:animate-fade-in"
    >
      <div className="flex items-center gap-1 sm:gap-2">
      {/* The same field edge and keyboard line as settings and account forms;
          the glyph and count are inside that one boundary. */}
      <div className={cn(fieldFrameClass, fieldHeightClass, fieldGroupClass, "flex min-w-0 flex-1 items-center gap-2 px-3")}>
        {/* Raw `Search`: find-in-conversation. `AppIcons.search` is the app's
            search destination, and this field never leaves the thread. */}
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input
          ref={inputRef}
          data-conversation-find-input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelection(null);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "Enter" && !e.altKey && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              go(e.shiftKey ? -1 : 1);
            }
          }}
          placeholder="Find in this conversation"
          aria-label="Find in this conversation"
          aria-describedby={helpId}
          aria-keyshortcuts="Enter Shift+Enter Escape"
          className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-muted-foreground coarse:text-reading"
        />
        {query.trim() !== "" && (
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={cn(
              "shrink-0 font-mono text-caption tabular-nums",
              matches.length === 0 ? "text-muted-foreground" : "text-foreground"
            )}
          >
            {matches.length === 0 ? (loadingHistory ? "Searching…" : "No matches") : `${index + 1} of ${matches.length}${truncated ? "+" : ""}`}
          </span>
        )}
      </div>
      {/* Every glyph-only control names itself on hover. A disabled step shows
          no tooltip — Radix cannot hover a pointer-events-none target, and a
          control that cannot act needs no name. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => go(-1)}
            disabled={matches.length === 0}
            aria-label="Previous match"
          >
            <ChevronUp className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Previous match</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => go(1)}
            disabled={matches.length === 0}
            aria-label="Next match"
          >
            <ChevronDown className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Next match</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close find">
            <ActionIcons.dismiss className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Close find</TooltipContent>
      </Tooltip>
      </div>
      {/* A hit in a long answer needs context: advancing three matches in the
          same message used to move neither the transcript nor any visible
          text. This preview makes each occurrence distinct without reparsing
          or mutating the streamed markdown. */}
      {current && (
        <p className="mt-2 min-w-0 truncate text-ui text-muted-foreground" data-conversation-find-preview>
          <span className="mr-2 font-medium text-foreground">{current.role === "USER" ? "You" : "Assistant"}</span>
          <span data-no-auto-translate>
            {current.preview.slice(0, current.previewStart)}
            <mark className="rounded-xs bg-primary/15 px-0.5 text-foreground">{current.preview.slice(current.previewStart, current.previewEnd)}</mark>
            {current.preview.slice(current.previewEnd)}
          </span>
        </p>
      )}
      <div id={helpId} className={cn("text-caption text-muted-foreground", (loadingHistory || hasOlderHistory || truncated) ? "mt-1.5" : "sr-only")}>
        {loadingHistory ? (
          <span role="status">Searching older messages…</span>
        ) : hasOlderHistory ? (
          <span>
            Results cover loaded messages.
            {onSearch && <button type="button" className="ml-1 underline underline-offset-2 hover:text-foreground" onClick={onSearch}>Search older messages</button>}
          </span>
        ) : truncated ? (
          <span>Showing the first {matches.length} matches. Refine your search to see more.</span>
        ) : (
          "Enter for next match, Shift+Enter for previous, Escape to close."
        )}
      </div>
    </div>
  );
}
