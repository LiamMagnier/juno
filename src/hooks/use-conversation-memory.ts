"use client";

import * as React from "react";
import { toast } from "sonner";
import { MEMORY_OFF_COPY } from "@/lib/chat/memory-off";

/*
 * "Memory off for this chat", for one conversation (src/lib/chat/memory-off.ts).
 * The composer's + and the chat's own menu both flip it, through this.
 *
 * The task mode's hook (use-conversation-task-mode.ts) is the model, for the
 * same reasons. A saved chat reads its switch from
 * `/api/conversations/[id]/memory` and saves a change there at once, so it is
 * on every device before the next message. A chat that does not exist yet
 * holds the switch here, and the first send carries it (`memoryOff` on the
 * chat request), which is how the server saves it on the conversation it
 * creates — before that first turn reads any memory.
 *
 * The moment that new chat gets its id, a switch flipped while the first
 * message was still out is saved again (that send carried the old value); one
 * nobody touched is read back instead. `createdHere` says the id is that new
 * chat's — the view's own route still names no chat — and not another chat
 * the reader opened, which must never be handed this one's switch. `known` is
 * what the app already knows about the chat (the sidebar's row), shown until
 * the read answers, so an opened chat does not blink its header mark in late.
 */

export interface ConversationMemorySwitch {
  /** This chat is kept out of memory. */
  off: boolean;
  change: (off: boolean) => void;
}

interface ServerView {
  memoryOff: unknown;
}

export function useConversationMemory(
  conversationId: string | null,
  enabled: boolean,
  known?: boolean,
  createdHere = false,
): ConversationMemorySwitch {
  const [off, setOff] = React.useState(false);
  const previousId = React.useRef<string | null>(conversationId);
  /** Bumped on every change, so a read that started before one never lands after it. */
  const revision = React.useRef(0);
  /** The switch as of the last render, for the save when a new chat gets its id. */
  const offRef = React.useRef(false);
  /** Flipped while the chat had no id: the first send may have carried the old value. */
  const touchedUnsaved = React.useRef(false);
  const knownRef = React.useRef(known);
  const createdHereRef = React.useRef(createdHere);
  React.useEffect(() => {
    offRef.current = off;
    knownRef.current = known;
    createdHereRef.current = createdHere;
  }, [off, known, createdHere]);

  React.useEffect(() => {
    const before = previousId.current;
    previousId.current = conversationId;
    if (!enabled) return;
    if (!conversationId) {
      // A new chat starts with memory on; nothing saved belongs to it yet.
      touchedUnsaved.current = false;
      if (before) setOff(false);
      return;
    }
    const created = before === null && createdHereRef.current;
    const resave = created && touchedUnsaved.current;
    touchedUnsaved.current = false;
    // An opened chat shows what the app already knew about it until the read
    // answers; a chat just created keeps what this hook was holding.
    if (!created) setOff(knownRef.current ?? false);
    const controller = new AbortController();
    const asked = revision.current;
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/memory`, {
      signal: controller.signal,
      cache: "no-store",
      ...(resave
        ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memoryOff: offRef.current }) }
        : {}),
    })
      .then((res) => (res.ok ? (res.json() as Promise<ServerView>) : null))
      .then((view) => {
        if (view && revision.current === asked) setOff(view.memoryOff === true);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [conversationId, enabled]);

  const change = React.useCallback(
    (next: boolean) => {
      if (!enabled) return;
      revision.current += 1;
      const before = off;
      setOff(next);
      if (!conversationId) {
        touchedUnsaved.current = true;
        return;
      }
      const mine = revision.current;
      fetch(`/api/conversations/${encodeURIComponent(conversationId)}/memory`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryOff: next }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const view = (await res.json()) as ServerView;
          if (revision.current === mine) setOff(view.memoryOff === true);
        })
        .catch(() => {
          if (revision.current !== mine) return;
          setOff(before);
          toast.error(MEMORY_OFF_COPY.saveFailedMessage);
        });
    },
    [conversationId, enabled, off],
  );

  return { off: enabled && off, change };
}
