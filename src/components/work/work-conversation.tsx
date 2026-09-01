"use client";

import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import { readEvent, str } from "@/components/work/work-payload";
import { AgentStatusBadge } from "@/components/ui/agent-status-badge";
import {
  WorkThreadComposer,
  type WorkComposerMode,
} from "@/components/work/composer/work-thread-composer";
import { PendingSteers, derivePendingSteers } from "@/components/work/steering/pending-steers";
import { WorkVoicePanel, useWorkVoice } from "@/components/work/voice";

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
 *
 * ── Voice is the composer's own button, not a second one ───────────────────
 *
 * Talking about a task is started from the composer's primary action — wave
 * bars while the field is empty, Send the moment anything is typed — exactly as
 * in `chat/composer.tsx`. This component owns only the open/closed state and
 * the docking, so the live panel and its aura sit in the same wrapper as the
 * composer they belong to. On a build with no `NEXT_PUBLIC_VOICE_RELAY_URL`
 * `useWorkVoice` hands back no handler and the button is a plain Send.
 */

/** Re-exported so the thread page keeps one import for the conversation. */
export type { WorkComposerMode };

/**
 * The stand-in for an absent event stream, hoisted so it is the same array on
 * every render. A `= []` default literal would be a new identity each pass,
 * which re-runs the voice briefing's memo about once a second while a run is
 * live for a result that never changes.
 */
const NO_EVENTS: readonly ClientWorkEvent[] = [];

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
  run = null,
  events = NO_EVENTS,
}: {
  session: ClientWorkSession;
  turns: readonly Turn[];
  sending: boolean;
  /** What the box does right now. There is always one. */
  mode: WorkComposerMode;
  /** Resolves true when the words landed; false leaves them in the box. */
  onSend: (text: string) => Promise<boolean>;
  /**
   * The newest attempt and the raw event stream, for the voice briefing only.
   *
   * Optional because the voice conversation degrades honestly without them
   * rather than not opening: `buildWorkVoiceBriefing` always writes the goal,
   * the status and the rules of the call, and the plan / open questions /
   * Juno's own words are the sections that need the stream. The panel's opening
   * sentence says which of the two it got, so an unbriefed session cannot
   * claim to know a plan nobody read to it.
   */
  run?: ClientWorkRun | null;
  events?: readonly ClientWorkEvent[];
}) {
  const voice = useWorkVoice();
  // Stable identity: this page re-renders about once a second while a run is
  // live, and the panel keeps this object in the deps of the callback that
  // actually posts to the task. A fresh literal every frame would rebuild that
  // callback every frame for a value that only changes when the mode does.
  const voiceSend = React.useMemo(
    () => ({ intent: mode, sending, onSend }),
    [mode, onSend, sending]
  );

  /*
   * Memoised on the event list, not recomputed per render: this component
   * re-renders about once a second while a run is live, and the derivation
   * walks the whole stream backwards. It is cheap per call and free per second
   * this way.
   */
  const pendingSteers = React.useMemo(() => derivePendingSteers(events), [events]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="space-y-5">
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="font-mono text-label text-muted-foreground">What you asked for</p>
            {session.status && (
              <AgentStatusBadge
                status={
                  session.status === "running" || session.status === "preparing"
                    ? "running"
                    : session.status === "waiting_approval"
                      ? "waiting_approval"
                      : session.status === "waiting_input"
                        ? "waiting_for_input"
                        : session.status === "completed"
                          ? "completed"
                          : session.status === "failed"
                            ? "failed"
                            : session.status === "cancelled" || session.status === "paused"
                              ? "cancelled"
                              : "idle"
                }
                size="sm"
              />
            )}
          </div>
          <div className="flex justify-end">
            <p className="max-w-[85%] whitespace-pre-wrap rounded-card bg-secondary px-3.5 py-2.5 text-body text-secondary-foreground">
              {session.goal}
            </p>
          </div>
        </div>

        {/* The transcript is set on `body`, the same rung the composer below now
            writes in. It was 14px here against the composer's 16 — the same words
            before and after sending, two sizes apart, neither on the scale. */}
        {turns.map((turn) =>
          turn.role === "you" ? (
            <div key={turn.id} className="flex flex-col items-end">
              {turn.unprompted && (
                <p className="mb-1 pr-1 font-mono text-micro text-muted-foreground">
                  You added this
                </p>
              )}
              <p className="max-w-[85%] whitespace-pre-wrap rounded-card bg-secondary px-3.5 py-2.5 text-body text-secondary-foreground">
                {turn.text}
              </p>
            </div>
          ) : (
            <Markdown key={turn.id} content={turn.text} className="text-body" />
          )
        )}

      </div>

      {/* Pinned, in every state and at every width. `bg-background` on the
          wrapper rather than on the composer alone, because the composer is a
          rounded-sm card and the transcript would otherwise scroll visibly through
          the corners and through the gap below it. The fade above is one line
          tall: enough to read as depth without borrowing a shadow, which this
          surface does not use. */}
      {/*
        `composer-aura-host` + `isolate` are what let the voice field light this
        composer the way it lights chat's. The aura paints at `z-index: -1`, so
        it needs a stacking context here to mean "behind the composer" rather
        than "behind whichever distant ancestor happens to make one" — and the
        host rule is where the aura's tint and its easing live. Both are inert
        until `WorkVoicePanel` mounts something that reads them.

        No `transition-[padding]` utility on this element, deliberately: Tailwind
        emits utilities after components at equal specificity, so it would
        replace the whole `transition` declaration in `.composer-aura-host` and
        silently drop the custom-property easing with it.
      */}
      <div className="composer-aura-host sticky bottom-0 isolate z-10 mt-6 bg-background pb-2 pt-1">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-full h-8 bg-gradient-to-t from-background to-transparent"
        />
        {/* A fragment: its aura has to be a SIBLING of the composer, not an
            ancestor's child, for `z-index: -1` to land behind it. */}
        {voice.open && (
          <WorkVoicePanel
            session={session}
            run={run}
            events={events}
            send={voiceSend}
            onClose={voice.close}
          />
        )}
        {/* Instructions already sent that the run has not taken a turn on yet.
            Above the field rather than in the transcript, because the question
            it answers — "did my redirect land?" — is asked at the moment of
            typing the next one, and an answer buried forty lines up in the
            scrollback is an answer nobody finds. See `pending-steers.tsx` for
            why there is no edit or reorder here. */}
        <PendingSteers steers={pendingSteers} />
        <WorkThreadComposer
          session={session}
          mode={mode}
          sending={sending}
          onSend={onSend}
          onOpenVoiceMode={voice.onOpenVoiceMode}
          voiceActive={voice.open}
        />
      </div>
    </div>
  );
}
