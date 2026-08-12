"use client";

import * as React from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { RealtimeVoice } from "@/components/voice/realtime-voice";
import { VoiceAura, voiceAuraStatus } from "@/components/voice/voice-aura";
import type { useRealtimeVoice } from "@/hooks/use-realtime-voice";

/**
 * What a spoken conversation about Work LOOKS like, for both of the places that
 * hold one.
 *
 * There are two: a running task (`work-voice-panel.tsx`) and a task nobody has
 * written yet (`work-home-voice-panel.tsx`). They differ in exactly two things —
 * what the model was told at the start, and what pressing the button does with
 * a spoken line — and in nothing else. Everything that is the same is here:
 * where the aura sits, how the transcript reads, which line is sendable, what a
 * refused send leaves on screen, and the fact that the dock is the last thing in
 * the box.
 *
 * It was extracted the moment the second surface existed rather than after both
 * had drifted. The contract this holds is not cosmetic — "only the last thing
 * you finished saying can be sent, once" is the whole safety story of talking to
 * a system that can act — and two copies of it is two answers to what a press
 * does.
 */

/**
 * What pressing "send" would do, in the five cases Work has.
 *
 * A deliberate copy of `WorkComposerMode` plus the composer case, rather than an
 * import of it: the four thread kinds are the product's vocabulary rather than
 * one composer's private detail, and this component is meant to be droppable
 * without dragging a composer's shape into its signature. The sentences below
 * are the composers' own, kept identical on purpose — two controls on one page
 * describing the same send in different words is how a reader concludes they do
 * different things.
 */
export type WorkVoiceSendIntent =
  | { kind: "answer"; question: string }
  | { kind: "steer" }
  | { kind: "restart" }
  | { kind: "start" }
  /**
   * Nothing exists yet. The words go into the composer's own field, where the
   * reader edits them and presses Start themselves.
   *
   * This is the one intent that does not reach a server, and that is the point
   * of it. A Work task is a goal plus an executor plus a policy, not a list of
   * messages, so persisting a rambling transcript AS the task would produce a
   * goal nobody wrote. The spoken line lands in the box in front of the reader —
   * the same rule `acceptPreflight` follows for the same reason.
   */
  | { kind: "compose" };

function intentSentence(intent: WorkVoiceSendIntent): string {
  switch (intent.kind) {
    case "answer":
      return `Answering: ${intent.question}`;
    case "steer":
      return "Not an answer to anything — this is kept on the task";
    case "restart":
      return "This attempt is over — sending starts another and hands it this message";
    case "start":
      return "Not started yet — sending starts this task and hands it this message";
    case "compose":
      return "Nothing has started — this goes into the task box, for you to edit";
  }
}

function sendButtonLabel(intent: WorkVoiceSendIntent): string {
  switch (intent.kind) {
    case "answer":
      return "Send as my answer";
    case "steer":
      return "Add this to the task";
    case "restart":
      return "Start again with this";
    case "start":
      return "Start the task with this";
    case "compose":
      return "Put this in the task box";
  }
}

/** What the words do once they leave the call, said before the press. */
function landingSentence(intent: WorkVoiceSendIntent): string {
  return intent.kind === "compose"
    ? "These exact words go into the task box, where you can change them. Juno’s side of this call does not."
    : "These exact words go to the task. Juno’s side of this call does not.";
}

export interface WorkVoiceSend {
  /** What sending does right now. Shown above the button, before the press. */
  intent: WorkVoiceSendIntent;
  /** A send is already in flight elsewhere on the page. Locks the button. */
  sending?: boolean;
  /**
   * The surface's own send path. Resolves true when the words landed, false when
   * they did not — the same contract the composers keep, so a refusal leaves the
   * spoken line on screen to be sent again.
   */
  onSend: (text: string) => Promise<boolean>;
}

export function WorkVoiceSurface({
  label,
  voice,
  explanation,
  notice,
  hiddenTexts,
  send,
  onClose,
}: {
  /** Names the box for assistive tech. Says which conversation this is. */
  label: string;
  voice: ReturnType<typeof useRealtimeVoice>;
  /** The arrangement, in words, kept on screen the whole time. Never a tooltip. */
  explanation: React.ReactNode;
  /** An out-of-band banner — today, the thread's "bring Juno up to date". */
  notice?: React.ReactNode;
  /**
   * Exact texts that were pushed as context and must not read as the reader's
   * own words. They travel as `input.text`, which the relay echoes back as a
   * user line — correct for the model, wrong for the person, who would see a
   * paragraph of status they never said sitting in their own conversation.
   */
  hiddenTexts?: ReadonlySet<string>;
  /** Omit to offer no way in at all: the conversation is then read-only. */
  send?: WorkVoiceSend;
  /** Ends the session and unmounts the host. Always offered; never automatic. */
  onClose: () => void;
}) {
  const [sentLineIds, setSentLineIds] = React.useState<readonly number[]>([]);
  const [sending, setSending] = React.useState(false);
  const [sendFailed, setSendFailed] = React.useState(false);

  const lines = React.useMemo(
    () =>
      hiddenTexts === undefined
        ? voice.transcript
        : voice.transcript.filter((line) => !hiddenTexts.has(line.text.trim())),
    [hiddenTexts, voice.transcript]
  );

  /** The last thing the reader finished saying, and has not already sent. */
  const sendable = React.useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.role !== "user" || !line.final || !line.text.trim()) continue;
      return sentLineIds.includes(line.id) ? null : line;
    }
    return null;
  }, [lines, sentLineIds]);

  const submit = React.useCallback(async () => {
    if (!send || !sendable || sending || send.sending) return;
    setSending(true);
    setSendFailed(false);
    try {
      const landed = await send.onSend(sendable.text.trim());
      if (landed) setSentLineIds((current) => [...current, sendable.id]);
      else setSendFailed(true);
    } finally {
      setSending(false);
    }
  }, [send, sendable, sending]);

  return (
    <>
      {/* First, and outside the box: the field paints at `z-index: -1`, so it
          has to be a SIBLING of the composer inside `.composer-aura-host` for
          that to mean "behind the composer". Inside the section below it would
          land behind the section instead, trapped in a layer of its own. */}
      <VoiceAura status={voiceAuraStatus(voice)} levelRef={voice.levelRef} />
      <section
        aria-label={label}
        // `bg-popover`, the documented floating-layer rung. This panel sits over
        // the composer while a call is live, and at card lightness it read as part
        // of the page rather than as a layer above it — with the send-preview well
        // nested inside it ending up the darkest thing on screen.
        className="mb-2 flex w-full flex-col gap-3 rounded-card border border-border/70 bg-popover p-3 motion-safe:animate-rise-in"
      >
        <p className="text-xs leading-relaxed text-muted-foreground">{explanation}</p>

        {notice}

        {lines.length > 0 && (
          // The one region in Work that overflows constantly — a live call adds a
          // line every few seconds — was the only scroller with no edge treatment,
          // so there was nothing saying the transcript continued past the crop.
          <ScrollFade className="max-h-56" viewportClassName="space-y-3 pr-1">
            {lines.map((line) =>
              line.role === "user" ? (
                <div key={line.id} className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-card bg-secondary px-3 py-2 text-[13px] leading-relaxed text-secondary-foreground">
                    {line.text}
                  </p>
                </div>
              ) : (
                <p
                  key={line.id}
                  className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground"
                >
                  {line.text}
                </p>
              )
            )}
          </ScrollFade>
        )}

        {send && sendable && (
          // `bg-secondary`, not `bg-card`. A surface token is only valid on its
          // own surface: `card` is the rung for something resting on the PAGE,
          // and this well sits inside a `bg-popover` panel — 6.5% nested in 13%,
          // i.e. six points DARKER than its own parent, which reads as a hole
          // punched through the panel rather than as a well cut into it. Inside
          // a popover the recessed rung is `secondary`, one step below it, and
          // it is what the transcript bubbles above already use.
          <div className="flex flex-col gap-2 rounded-field border border-border/60 bg-secondary p-2.5">
            {/* What the press does, before the press: a steer and a restart are
                not the same event and finding out afterwards is too late. */}
            <p className="font-mono text-label text-muted-foreground">
              {intentSentence(send.intent)}
            </p>
            <p className="text-[13px] leading-relaxed text-foreground">{sendable.text}</p>
            <p className="text-caption text-muted-foreground">{landingSentence(send.intent)}</p>
            {sendFailed && (
              <p role="alert" className="text-caption text-destructive">
                Those words didn&rsquo;t land. Try again, or type them in the box below.
              </p>
            )}
            <Button
              type="button"
              size="sm"
              onClick={() => void submit()}
              disabled={sending || send.sending === true}
              className="self-end gap-2"
            >
              <Send className="size-3.5" aria-hidden="true" />
              {sending ? "Sending…" : sendButtonLabel(send.intent)}
            </Button>
          </div>
        )}

        <RealtimeVoice voice={voice} onClose={onClose} />
      </section>
    </>
  );
}
