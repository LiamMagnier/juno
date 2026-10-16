"use client";

/**
 * Good / Bad response on a Code answer, kept where the answer is kept:
 *
 * - a session on the CodeTask path has a Message row per answer, and its
 *   verdict is that row's `feedback` (POST /api/messages/[id]/feedback, the
 *   chat route, through useCodeSession's optimistic setFeedback);
 * - a session on the Mac has no Message rows (its transcript is the env
 *   server's), so its verdicts go to /api/code/feedback, keyed by turn.
 *
 * Optimistic in both cases; a refusal puts the old verdict back and says so.
 */
import * as React from "react";
import { toast } from "sonner";
import type { TurnItem } from "@/lib/code-v2/contracts";
import { groupTurns } from "@/lib/code-v2/turns";

export type Verdict = "UP" | "DOWN" | null;

interface LegacyMessage {
  id: string;
  feedback?: "UP" | "DOWN" | null;
}

/** The persisted assistant Message id behind a legacy turn's answer (`<id>-text`), or null for a live bubble. */
export function legacyAnswerMessageId(answerItemId: string | undefined): string | null {
  if (!answerItemId || !answerItemId.endsWith("-text")) return null;
  const id = answerItemId.slice(0, -"-text".length);
  return id.startsWith("code-live-") || id.startsWith("code-temp-") ? null : id;
}

export function useAnswerFeedback({
  conversationId,
  onMac,
  items,
  legacyMessages,
  setLegacyFeedback,
  model,
}: {
  conversationId: string;
  onMac: boolean;
  items: readonly TurnItem[];
  legacyMessages: readonly LegacyMessage[];
  setLegacyFeedback: (messageId: string, value: Verdict) => void;
  model?: string;
}): { get(turnId: string): Verdict; set(turnId: string, value: Verdict): void } {
  const [mac, setMac] = React.useState<Record<string, "UP" | "DOWN">>({});
  React.useEffect(() => {
    if (!onMac) return;
    let live = true;
    fetch(`/api/code/feedback?conversationId=${encodeURIComponent(conversationId)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { feedback?: Record<string, "UP" | "DOWN"> } | null) => {
        if (live && body?.feedback) setMac(body.feedback);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [onMac, conversationId]);

  const answers = React.useMemo(() => {
    if (onMac) return new Map<string, string>();
    return new Map(groupTurns(items).flatMap((t) => (t.answer ? [[t.id, t.answer.id] as const] : [])));
  }, [onMac, items]);

  const get = (turnId: string): Verdict => {
    if (onMac) return mac[turnId] ?? null;
    const id = legacyAnswerMessageId(answers.get(turnId));
    return (id && legacyMessages.find((m) => m.id === id)?.feedback) || null;
  };

  const set = (turnId: string, value: Verdict) => {
    if (!onMac) {
      const id = legacyAnswerMessageId(answers.get(turnId));
      if (id) setLegacyFeedback(id, value);
      return;
    }
    const before = mac[turnId] ?? null;
    const apply = (v: Verdict) =>
      setMac((m) => {
        const next = { ...m };
        if (v) next[turnId] = v;
        else delete next[turnId];
        return next;
      });
    apply(value);
    fetch("/api/code/feedback", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, turnKey: turnId, feedback: value, ...(model ? { model } : {}) }),
    })
      .then((r) => {
        if (r.ok) return;
        apply(before);
        toast.error("Could not save your feedback.");
      })
      .catch(() => {
        apply(before);
        toast.error("Could not save your feedback.");
      });
  };

  return { get, set };
}
