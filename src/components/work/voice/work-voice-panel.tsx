"use client";

import * as React from "react";
import { RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RealtimeVoice } from "@/components/voice/realtime-voice";
import { VoiceAura, voiceAuraStatus } from "@/components/voice/voice-aura";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import {
  buildWorkVoiceBriefing,
  workVoiceCatchUp,
  type WorkVoiceBriefingInput,
} from "@/components/work/voice/work-voice-briefing";

/**
 * Talking to Juno about a Work task, out loud, without pretending it is more
 * than that.
 *
 * ── What this is, exactly ──────────────────────────────────────────────────
 *
 * It is the existing realtime voice session — the same `useRealtimeVoice` hook
 * and the same relay the chat surface uses — opened with a briefing about ONE
 * Work task instead of a chat transcript. The relay accepts arbitrary history
 * at `session.start` and knows nothing about accounts beyond a user id, so
 * pointing it at a task is a matter of what you hand it, and that is
 * `work-voice-briefing.ts`.
 *
 * ── What it is not, and why the panel says so ──────────────────────────────
 *
 * The voice model has no tools. Not "no Work tools" — none at all: every
 * provider in `relay/src/providers/` is built from `seed.instructions` and
 * `seed.transcript`, and `VoiceProviderSession` exposes `sendAudio`,
 * `sendText`, `sendVideoFrame`, `interrupt`, `close`. So the voice cannot read
 * the task again, cannot answer its question, cannot approve anything and
 * cannot start or stop it. It knows what the briefing said and nothing else.
 *
 * The failure this component is written to avoid is the one where a warm voice
 * says "I've made that change for you" and nothing has been changed. Hence:
 *
 *   - the panel states the arrangement in words, on screen, the whole time it
 *     is open — not in a tooltip, not once at the start;
 *   - words only reach the task through `send.onSend`, which is the page's own
 *     composer path (answer / steer / restart / start), pressed deliberately,
 *     with what it will do named before the press;
 *   - the task moving on is surfaced as an explicit "bring Juno up to date"
 *     rather than silently re-briefed, because the only channel a live session
 *     has is `input.text` and that arrives at the model as something the USER
 *     said. Sending it behind the reader's back would put words in their mouth.
 *
 * ── There is no launcher in this file, and that is the point ───────────────
 *
 * This used to export a `WorkVoiceButton` that drew its own "Talk about this
 * task" button above the composer. That was a second entry point for the same
 * conversation sitting a few pixels from the composer's own controls, and it is
 * not how chat does it: chat's composer has ONE primary button that is the
 * voice launcher while there is nothing to send and morphs into Send the moment
 * there is (`showVoiceButton` in `chat/composer.tsx`). Work now does the same,
 * so what is left here is the live session — the panel — plus `useWorkVoice`,
 * which hands the composer the `onOpenVoiceMode` callback it expects.
 */

/** True when this build has a relay to talk to. Inlined at build time. */
export function isWorkVoiceConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VOICE_RELAY_URL);
}

/**
 * What pressing "send to task" would do, in the four cases the thread has.
 *
 * A deliberate copy of `WorkComposerMode` rather than an import of it. The
 * composer is another surface's file and this component is meant to be
 * droppable without dragging that file's shape into its signature; the four
 * kinds are the product's vocabulary, not the composer's private detail. The
 * sentences below are the composer's own, kept identical on purpose — two
 * controls on one page that describe the same send in different words is how a
 * reader concludes they do different things.
 */
export type WorkVoiceSendIntent =
  | { kind: "answer"; question: string }
  | { kind: "steer" }
  | { kind: "restart" }
  | { kind: "start" };

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
  }
}

export interface WorkVoiceSend {
  /** What sending does right now. Shown above the button, before the press. */
  intent: WorkVoiceSendIntent;
  /** A send is already in flight elsewhere on the page. Locks the button. */
  sending?: boolean;
  /**
   * The page's own send path. Resolves true when the words landed on the task,
   * false when they did not — the same contract the thread composer keeps, so
   * a refusal leaves the spoken line on screen to be sent again.
   */
  onSend: (text: string) => Promise<boolean>;
}

export interface WorkVoicePanelProps extends WorkVoiceBriefingInput {
  /** Omit to offer no way in at all: the conversation is then read-only. */
  send?: WorkVoiceSend;
  /** Ends the session and unmounts this. Always offered; never automatic. */
  onClose: () => void;
}

/**
 * Open / closed for the voice conversation, in the shape the composer wants.
 *
 * `onOpenVoiceMode` is deliberately `undefined` — not a no-op — both when this
 * deployment has no relay and while a session is already live. The composer's
 * primary button reads that exact absence to decide whether it is a voice
 * launcher or a plain Send, so a handler that existed but did nothing would
 * leave a wave-bar button on a build with no voice, and a second launcher
 * pointing at a panel already on screen. Chat gates its own `onOpenVoiceMode`
 * the same way (`!voiceOpen && !!NEXT_PUBLIC_VOICE_RELAY_URL` in `chat-view`).
 */
export function useWorkVoice(): {
  /** True when the panel should be mounted. */
  open: boolean;
  /** Pass straight to the composer. Undefined means "draw no voice affordance". */
  onOpenVoiceMode: (() => void) | undefined;
  /** Hand to the panel's `onClose`. */
  close: () => void;
} {
  const [open, setOpen] = React.useState(false);
  const configured = isWorkVoiceConfigured();
  const openVoice = React.useCallback(() => setOpen(true), []);
  const close = React.useCallback(() => setOpen(false), []);
  return {
    // A session can outlive the config check only if the env changed mid-page,
    // which it cannot — but gating the mount too keeps the two in step.
    open: open && configured,
    onOpenVoiceMode: configured && !open ? openVoice : undefined,
    close,
  };
}

/**
 * The live session.
 *
 * Mounted only while the conversation is open, and that is not tidiness.
 * `useRealtimeVoice` runs a requestAnimationFrame loop for the whole of its
 * life to smooth the level meter; a Work thread already re-renders about once a
 * second while a run streams, and adding a permanent per-frame callback to that
 * page for a conversation nobody has started is a cost with no reader.
 *
 * It returns a FRAGMENT, not a box, and the first thing in it is the aura. The
 * field paints at `z-index: -1`, so it has to be a SIBLING of the composer
 * inside `.composer-aura-host` for that to mean "behind the composer" — wrapped
 * in this component's own `<section>` it would land behind the section instead,
 * and the section's rise-in animation would trap it in a layer of its own. This
 * is the same arrangement `chat-view.tsx` uses for exactly the same reason.
 */
export function WorkVoicePanel({ session, run, events, send, onClose }: WorkVoicePanelProps) {
  const voice = useRealtimeVoice();
  const briefingInput = React.useMemo<WorkVoiceBriefingInput>(
    () => ({ session, run, events }),
    [events, run, session]
  );

  /** The digest of what the model has actually been told, briefing or catch-up. */
  const [toldDigest, setToldDigest] = React.useState<string | null>(null);
  const [sentLineIds, setSentLineIds] = React.useState<readonly number[]>([]);
  const [sending, setSending] = React.useState(false);
  const [sendFailed, setSendFailed] = React.useState(false);
  /** Exact texts pushed as context, so they can be kept out of the transcript. */
  const contextPushes = React.useRef<Set<string>>(new Set());

  // Start once, with the briefing as it stands at the press. `start` is
  // deliberately absent from the dependency list: the hook rebuilds that
  // callback whenever the provider or status changes, and following it here
  // would restart the session — mic, socket and all — mid-conversation.
  const startedRef = React.useRef(false);
  const voiceRef = React.useRef(voice);
  voiceRef.current = voice;
  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const briefing = buildWorkVoiceBriefing(briefingInput);
    setToldDigest(briefing.digest);
    void voiceRef.current.start(undefined, briefing.entries);
  }, [briefingInput]);

  const liveDigest = React.useMemo(() => buildWorkVoiceBriefing(briefingInput).digest, [briefingInput]);
  const staleBy = toldDigest !== null && toldDigest !== liveDigest;

  const catchUp = React.useCallback(() => {
    const text = workVoiceCatchUp(briefingInput);
    if (!voiceRef.current.sendText(text)) return;
    contextPushes.current.add(text);
    setToldDigest(buildWorkVoiceBriefing(briefingInput).digest);
  }, [briefingInput]);

  /*
   * The visible transcript.
   *
   * Context pushes are filtered out by exact text. They travel as `input.text`,
   * which the relay echoes straight back as a user line — correct for the
   * model, wrong for the reader, who would see a paragraph of status they never
   * said sitting in their own conversation.
   */
  const lines = React.useMemo(
    () => voice.transcript.filter((line) => !contextPushes.current.has(line.text.trim())),
    [voice.transcript]
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

  const close = React.useCallback(() => {
    voiceRef.current.end();
    onClose();
  }, [onClose]);

  /*
   * What the opening sentence is allowed to claim.
   *
   * The plan, the open questions and Juno's own words all come out of the event
   * stream; with no events the briefing is the goal and the status and nothing
   * else. Saying "goal, plan and latest activity" in that case would be the one
   * thing this whole component exists to prevent — the panel asserting the
   * model knows something it was never told.
   */
  const briefedFromStream = events.length > 0;

  return (
    <>
      <VoiceAura status={voiceAuraStatus(voice)} levelRef={voice.levelRef} />
      <section
        aria-label="Voice conversation about this task"
        className="mb-2 flex w-full flex-col gap-3 rounded-2xl border border-border/70 bg-card/80 p-3 motion-safe:animate-rise-in"
      >
        {/* The arrangement, stated plainly and kept on screen. Not a tooltip and
            not a one-time notice: the sentence has to be readable at the moment
            somebody is deciding whether to believe what they just heard. */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {briefedFromStream
            ? "Juno was told this task’s goal, plan and latest activity when you started talking."
            : "Juno was told this task’s goal and where it has got to when you started talking."}{" "}
          This is a separate conversation about the task: it can&rsquo;t see anything else, it
          can&rsquo;t change the task, and nothing said here reaches the run unless you send it.
        </p>

        {staleBy && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2">
            <p className="font-mono text-label text-muted-foreground">
              The task has moved on since Juno was briefed
            </p>
            <Button type="button" variant="outline" size="sm" onClick={catchUp} className="gap-2">
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Bring Juno up to date
            </Button>
          </div>
        )}

        {lines.length > 0 && (
          <div className="max-h-56 space-y-3 overflow-y-auto pr-1">
            {lines.map((line) =>
              line.role === "user" ? (
                <div key={line.id} className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-secondary px-3 py-2 text-[13px] leading-relaxed text-secondary-foreground">
                    {line.text}
                  </p>
                </div>
              ) : (
                <p key={line.id} className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
                  {line.text}
                </p>
              )
            )}
          </div>
        )}

        {send && sendable && (
          <div className="flex flex-col gap-2 rounded-xl border border-border/60 bg-background/60 p-2.5">
            {/* What the press does, before the press — the composer's own line,
                for the composer's own reason: a steer and a restart are not the
                same event and finding out afterwards is too late. */}
            <p className="font-mono text-label text-muted-foreground">{intentSentence(send.intent)}</p>
            <p className="text-[13px] leading-relaxed text-foreground">{sendable.text}</p>
            <p className="text-caption text-muted-foreground/80">
              These exact words go to the task. Juno&rsquo;s side of this call does not.
            </p>
            {sendFailed && (
              <p role="alert" className="text-caption text-destructive">
                Those words didn&rsquo;t land on the task. Try again, or type them in the box below.
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

        <RealtimeVoice voice={voice} onClose={close} />
      </section>
    </>
  );
}
