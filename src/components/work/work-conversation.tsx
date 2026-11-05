"use client";

import * as React from "react";
import { Markdown } from "@/components/chat/markdown";
import type { ClientWorkEvent, ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";
import { deriveTurns, type Turn } from "@/components/work/work-turns";
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

// The readable turns live in work-turns.ts (no React, no voice), so the chat's
// run panel can read them without this component's composer and voice.
export { deriveTurns };

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
          {/* No status badge here. The header's pill (`WorkStatusPill`) is the
              one status widget on the page; a second one in this column ran
              its own vocabulary and mapped `paused` to "cancelled". */}
          <p className="mb-1.5 font-mono text-label text-muted-foreground">What you asked for</p>
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
        `isolate` is what lets the voice field light this composer the way it
        lights chat's. The aura paints at `z-index: -1`, so it needs a stacking
        context here to mean "behind the composer" rather than "behind whichever
        distant ancestor happens to make one". Inert until `WorkVoicePanel`
        mounts something that reads it.
      */}
      <div className="sticky bottom-0 isolate z-10 mt-6 bg-background pb-2 pt-1">
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
