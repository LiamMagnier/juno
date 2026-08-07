"use client";

import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import type { ClientWorkEvent, ClientWorkSession } from "@/lib/work/serializers";
import { readEvent, str } from "@/components/work/work-payload";
import {
  WorkThreadComposer,
  type WorkComposerMode,
} from "@/components/work/composer/work-thread-composer";

/*
 * The conversation half of a Work thread: what you asked for, what Juno has
 * said back, and the box for saying more.
 *
 * It obeys the flat-transcript law — one column, user turns as right-aligned
 * `bg-secondary` bubbles, Juno's turns as full-width prose with no card, no
 * shadow and no glass. The depth in this page belongs to the composer and the
 * approval controls, which are chrome.
 *
 * The composer lives in `composer/work-thread-composer.tsx` and is pinned to
 * the bottom of this column in every state. It used to be conditional, and the
 * condition was the bug: a finished task, a draft and a refused dispatch all
 * removed the field and left a sentence pointing at a button elsewhere.
 */

/** Re-exported so the thread page keeps one import for the conversation. */
export type { WorkComposerMode };

interface Turn {
  id: string;
  role: "you" | "juno";
  text: string;
  /** True for a turn the user volunteered rather than one that answered a question. */
  unprompted: boolean;
}

/**
 * The readable conversation, pulled out of the event stream.
 *
 * Only three kinds carry prose a person addressed to another: what Juno said,
 * what it asked, and what the user typed. Everything else in the stream is
 * machinery and belongs in the timeline, where it can be skimmed rather than
 * read.
 *
 * The last of those three arrives under two kinds. `question_answered` is an
 * answer to something Juno asked; `user_message` is an instruction the user
 * offered unprompted, which the executor folds into the run before its next
 * step. Both are the user's words and both belong in this column; only the label
 * differs.
 *
 * A `question_answered` row carrying `steering: true` and no id is the same
 * instruction written before the vocabulary had a kind for it. Those rows are in
 * the log and an older Mac or phone still writes them, so they are read as what
 * they are rather than shown as answers to a question nobody asked.
 */
export function deriveTurns(events: readonly ClientWorkEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    if (event.visibility !== "user") continue;
    const payload = readEvent(event);
    if (event.kind === "assistant_message") {
      const text = str(payload, "text", "message");
      if (text) turns.push({ id: event.id, role: "juno", text, unprompted: false });
    }
    if (event.kind === "question_asked") {
      const text = str(payload, "question", "text");
      if (text) turns.push({ id: event.id, role: "juno", text, unprompted: false });
    }
    if (event.kind === "question_answered") {
      const text = str(payload, "text", "answer");
      if (text) {
        turns.push({ id: event.id, role: "you", text, unprompted: payload.steering === true });
      }
    }
    if (event.kind === "user_message") {
      const text = str(payload, "text");
      if (text) turns.push({ id: event.id, role: "you", text, unprompted: true });
    }
  }
  return turns;
}

export function WorkConversation({
  session,
  turns,
  sending,
  mode,
  onSend,
  onStartVoice,
}: {
  session: ClientWorkSession;
  turns: readonly Turn[];
  sending: boolean;
  /** What the box does right now. There is always one. */
  mode: WorkComposerMode;
  /** Resolves true when the words landed; false leaves them in the box. */
  onSend: (text: string) => Promise<boolean>;
  /**
   * Opens a spoken conversation about this task, if this deployment has one.
   *
   * Forwarded rather than owned: Work has no realtime voice surface yet, and
   * the composer draws the button only when a handler arrives. Passing it is
   * one prop from the thread page the day one exists.
   */
  onStartVoice?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-5">
        <div>
          <p className="mb-1.5 font-mono text-label text-muted-foreground">What you asked for</p>
          <div className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2.5 text-[14px] leading-relaxed text-secondary-foreground">
              {session.goal}
            </p>
          </div>
        </div>

        {turns.map((turn) =>
          turn.role === "you" ? (
            <div key={turn.id} className="flex flex-col items-end">
              {turn.unprompted && (
                <p className="mb-1 pr-1 font-mono text-[10px] text-muted-foreground/70">
                  You added this
                </p>
              )}
              <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3.5 py-2.5 text-[14px] leading-relaxed text-secondary-foreground">
                {turn.text}
              </p>
            </div>
          ) : (
            <Markdown key={turn.id} content={turn.text} className="text-[14px]" />
          )
        )}

      </div>

      {/* Pinned, in every state and at every width. `bg-background` on the
          wrapper rather than on the composer alone, because the composer is a
          rounded card and the transcript would otherwise scroll visibly through
          the corners and through the gap below it. The fade above is one line
          tall: enough to read as depth without borrowing a shadow, which this
          surface does not use. */}
      <div className="sticky bottom-0 z-10 mt-6 bg-background pb-2 pt-1">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent"
        />
        <WorkThreadComposer
          session={session}
          mode={mode}
          sending={sending}
          onSend={onSend}
          onStartVoice={onStartVoice}
        />
      </div>
    </div>
  );
}
