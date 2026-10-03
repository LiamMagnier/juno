"use client";

import * as React from "react";
import Link from "next/link";
import { AgentFace } from "@/components/agents/agent-face";
import { formatAgo } from "@/components/agents/agent-bits";
import { JunoMark } from "@/components/brand/logo";
import { isPressing } from "@/components/notifications/inbox-model";
import type { ClientNotification } from "@/lib/notify/types";
import { cn } from "@/lib/utils";

/**
 * One notification: who it is from, what happened, when, and whether it has
 * been read.
 *
 * Text on the panel, like a sidebar row (docs/design/PREMIUM_AUDIT.md rule 3):
 * no edge and no fill until the pointer or the keyboard lands on it, and then
 * the popover's own `accent`, cross-faded on the `fast` rung the sidebar's list
 * rows use. No per-kind glyph (rule 4, glyphs mark destinations): the leading
 * mark says WHO, an agent's face for an agent's news and Juno's mark for
 * Juno's own, and the words say what.
 *
 * NO DOT (the owner's rule: no status dots anywhere). Unread is said in the
 * type: an unread title is set in foreground ink at the medium weight, a read
 * one steps down to muted ink at the regular weight, so the difference holds
 * for a reader who cannot tell colours apart. A row that is asking for
 * something (an approval, a question) and is still unread carries its time in
 * presence blue, the one live thing in the list. The state is also in words,
 * for a screen reader.
 *
 * A row that goes somewhere is a link, so it can be opened in a new tab like
 * any other; a row with nowhere to go is a button that only marks it read.
 */
export function NotificationRow({
  notification: n,
  onOpen,
}: {
  notification: ClientNotification;
  /** The row was pressed. `navigating` is false for a modified click that opens a new tab. */
  onOpen: (navigating: boolean) => void;
}) {
  const unread = !n.readAt;
  const className =
    "flex w-full min-w-0 items-start gap-2.5 rounded-control px-2.5 py-2 text-left transition-[background-color,color] duration-fast ease-out-soft hover:bg-accent focus-visible:bg-accent motion-reduce:transition-none";
  const body = (
    <>
      {/* The face at rest (`idle`): a notification is a moment that has
          passed, not the agent's live state, and an idle face never loops. */}
      <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center">
        {n.agent ? <AgentFace avatar={n.agent.avatar} size="xs" /> : <JunoMark className="size-4" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-nav", unread ? "font-medium text-foreground" : "text-muted-foreground")}>
          {unread ? <span className="sr-only">{isPressing(n) ? "Unread, needs you: " : "Unread: "}</span> : null}
          {n.title}
        </span>
        <span className="mt-0.5 line-clamp-2 text-caption text-muted-foreground">
          <span className={cn("ed-annot", unread && isPressing(n) && "ed-presence")}>{formatAgo(n.createdAt)}</span>
          {n.body ? <span className="ml-1.5">{n.body}</span> : null}
        </span>
      </span>
    </>
  );

  if (n.href) {
    return (
      <Link
        href={n.href}
        prefetch={false}
        onClick={(event) => onOpen(!(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey))}
        className={className}
      >
        {body}
      </Link>
    );
  }
  return (
    <button type="button" onClick={() => onOpen(false)} className={className}>
      {body}
    </button>
  );
}
