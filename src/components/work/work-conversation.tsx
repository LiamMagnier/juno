"use client";

import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import { WorkVoiceButton } from "@/components/work/voice";
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
  run,
  events,
  turns,
  sending,
  mode,
  onSend,
}: {
  session: ClientWorkSession;
  /** The newest attempt, or null when the task has never been dispatched. */
  run: ClientWorkRun | null;
  /** The transcript, for the spoken briefing. Already visibility-filtered. */
  events: readonly ClientWorkEvent[];
  turns: readonly Turn[];
  sending: boolean;
  /** What the box does right now. There is always one. */
  mode: WorkComposerMode;
  /** Resolves true when the words landed; false leaves them in the box. */
  onSend: (text: string) => Promise<boolean>;
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
        {/*
          Voice sits above the box rather than inside it.

          It is a different act from typing: it opens a conversation that reads
          the task out and can speak back, so it gets its own affordance instead
          of a third icon competing with attach and dictate on a control row —
          where the two microphones would be one pixel apart and mean different
          things. `WorkVoiceButton` renders nothing at all when the deployment
          has no relay configured, so this costs a null on every install that
          has not set one up.

          It is handed `onSend` as its `send`, so anything decided out loud
          lands on the task through exactly the same path a typed message takes,
          in whichever of the four modes the thread is currently in.
        */}
        <WorkVoiceButton
          session={session}
          run={run}
          events={events}
          // `mode` IS the intent. `WorkVoiceSendIntent` is a deliberate
          // structural copy of `WorkComposerMode` — the voice file explains why
          // it copies rather than imports — so the two stay one decision here
          // instead of a mapping that can disagree with the box beneath it.
          send={{ intent: mode, sending, onSend }}
          className="mb-2"
        />
        <WorkThreadComposer
          session={session}
          mode={mode}
          sending={sending}
          onSend={onSend}
        />
      </div>
    </div>
  );
}
