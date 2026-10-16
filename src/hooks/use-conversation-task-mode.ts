"use client";

import * as React from "react";
import { toast } from "sonner";
import { DEFAULT_WORK_PERMISSION_POLICY } from "@/lib/work/domain";
import { parseChatTaskMode, type ChatTaskMode } from "@/lib/chat/task-approval-mode";

/*
 * The chat composer's task mode, for one conversation
 * (src/lib/chat/task-approval-mode.ts).
 *
 * A saved chat reads its mode from `/api/conversations/[id]/task-mode` and
 * saves a change there at once, so the choice is on every device before the
 * next message. A chat that does not exist yet holds the choice here, and the
 * first send carries it (`taskApprovalMode` on the chat request), which is how
 * the server saves it on the conversation it creates.
 *
 * The moment that new chat gets its id, the hook saves what it holds once
 * more rather than reading it back. A read could only undo a choice made while
 * the first message was still out (that send carried the old one), and the
 * answer to the save says what a read would have: whether the chat's project
 * asks more often than the choice, which the composer then shows.
 */

export interface ConversationTaskMode {
  /** What the reader chose for this chat, or null for the default. */
  chosen: ChatTaskMode | null;
  /** What a task started now runs as, after a stricter agent or project. */
  effective: ChatTaskMode;
  /** Which layer made `effective` stricter than the choice, when one did. */
  narrowedBy: TaskModeNarrowing;
  change: (next: ChatTaskMode) => void;
}

export type TaskModeNarrowing = "project" | "agent" | null;

interface ServerView {
  chosen: unknown;
  effective: unknown;
  narrowedBy: unknown;
}

function parseNarrowing(value: unknown): TaskModeNarrowing {
  return value === "project" || value === "agent" ? value : null;
}

export function useConversationTaskMode(conversationId: string | null, enabled: boolean): ConversationTaskMode {
  const [chosen, setChosen] = React.useState<ChatTaskMode | null>(null);
  const [effective, setEffective] = React.useState<ChatTaskMode | null>(null);
  const [narrowedBy, setNarrowedBy] = React.useState<TaskModeNarrowing>(null);
  const previousId = React.useRef<string | null>(conversationId);
  /** Bumped on every change, so a read that started before one never lands after it. */
  const revision = React.useRef(0);
  /** The choice as of the last render, for the save when a new chat gets its id. */
  const chosenRef = React.useRef<ChatTaskMode | null>(null);
  React.useEffect(() => {
    chosenRef.current = chosen;
  }, [chosen]);

  const apply = React.useCallback((view: ServerView) => {
    setChosen(parseChatTaskMode(view.chosen));
    setEffective(parseChatTaskMode(view.effective));
    setNarrowedBy(parseNarrowing(view.narrowedBy));
  }, []);

  React.useEffect(() => {
    const before = previousId.current;
    previousId.current = conversationId;
    if (!enabled) return;
    if (!conversationId) {
      // A new chat starts at the default; nothing saved belongs to it yet.
      if (before) {
        setChosen(null);
        setEffective(null);
        setNarrowedBy(null);
      }
      return;
    }
    // The chat this hook was holding a choice for has just been created: keep
    // what is shown, save it again, and learn whether its project narrows it.
    const created = before === null;
    const held = chosenRef.current;
    if (!created) {
      setChosen(null);
      setEffective(null);
      setNarrowedBy(null);
    }
    const controller = new AbortController();
    const asked = revision.current;
    fetch(`/api/conversations/${encodeURIComponent(conversationId)}/task-mode`, {
      signal: controller.signal,
      cache: "no-store",
      ...(created && held
        ? { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: held }) }
        : {}),
    })
      .then((res) => (res.ok ? (res.json() as Promise<ServerView>) : null))
      .then((view) => {
        if (view && revision.current === asked) apply(view);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [apply, conversationId, enabled]);

  const change = React.useCallback(
    (next: ChatTaskMode) => {
      revision.current += 1;
      const before = { chosen, effective, narrowedBy };
      setChosen(next);
      // Until the server says otherwise, the choice is what runs.
      setEffective(next);
      setNarrowedBy(null);
      if (!conversationId) return;
      const mine = revision.current;
      fetch(`/api/conversations/${encodeURIComponent(conversationId)}/task-mode`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: next }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(String(res.status));
          const view = (await res.json()) as ServerView;
          if (revision.current === mine) apply(view);
        })
        .catch(() => {
          if (revision.current !== mine) return;
          setChosen(before.chosen);
          setEffective(before.effective);
          setNarrowedBy(before.narrowedBy);
          toast.error("Couldn’t save how often tasks ask. Try again.");
        });
    },
    [apply, chosen, conversationId, effective, narrowedBy],
  );

  return {
    chosen,
    effective: effective ?? chosen ?? DEFAULT_WORK_PERMISSION_POLICY,
    narrowedBy,
    change,
  };
}
