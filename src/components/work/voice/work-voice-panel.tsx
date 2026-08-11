"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/components/app/app-provider";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { PLANS } from "@/lib/plans";
import {
  buildWorkVoiceBriefing,
  workVoiceCatchUp,
  type WorkVoiceBriefingInput,
} from "@/components/work/voice/work-voice-briefing";
import {
  WorkVoiceSurface,
  type WorkVoiceSend,
  type WorkVoiceSendIntent,
} from "@/components/work/voice/work-voice-surface";

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
 *
 * Everything the panel LOOKS like — the aura, the transcript, which line is
 * sendable, what a refusal leaves behind — is `WorkVoiceSurface`, shared with
 * the home composer's version of this conversation. Only the briefing and the
 * catch-up are this file's.
 */

/** Re-exported so a caller needs one import for the whole feature. */
export type { WorkVoiceSend, WorkVoiceSendIntent };

/** True when this build has a relay to talk to. Inlined at build time. */
export function isWorkVoiceConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_VOICE_RELAY_URL);
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
 * `onOpenVoiceMode` is deliberately `undefined` — not a no-op — when this
 * deployment has no relay, when the account's plan has no voice, and while a
 * session is already live. The composer's primary button reads that exact
 * absence to decide whether it is a voice launcher or a plain Send, so a handler
 * that existed but did nothing would leave a wave-bar button on a build with no
 * voice, and a second launcher pointing at a panel already on screen.
 *
 * The PLAN check is here rather than at each call site, and it was missing: this
 * hook gated on the relay URL alone while chat gated on `PLANS[quota.plan].voice`
 * as well (`chat-view.tsx`). On a free plan that difference was a live defect
 * with a user-visible ending — the wave bars drew, the panel mounted, and
 * `/api/voice/relay-token` answered 403 "Voice mode requires a paid plan", so
 * the upsell landed inside an opened voice session instead of the button simply
 * never appearing. One gate in one place is also what stops the Work home
 * composer inheriting the same bug by copying this hook.
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
  const { quota } = useApp();
  const allowed = isWorkVoiceConfigured() && PLANS[quota.plan].voice;
  const openVoice = React.useCallback(() => setOpen(true), []);
  const close = React.useCallback(() => setOpen(false), []);
  return {
    // A session can outlive the gate only if the plan changed mid-page, which a
    // downgrade genuinely can — gating the mount too keeps the two in step.
    open: open && allowed,
    onOpenVoiceMode: allowed && !open ? openVoice : undefined,
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
 * It returns a FRAGMENT, not a box — see `WorkVoiceSurface`, whose first child
 * is the aura for exactly that reason.
 */
export function WorkVoicePanel({ session, run, events, send, onClose }: WorkVoicePanelProps) {
  const voice = useRealtimeVoice();
  const briefingInput = React.useMemo<WorkVoiceBriefingInput>(
    () => ({ session, run, events }),
    [events, run, session]
  );

  /** The digest of what the model has actually been told, briefing or catch-up. */
  const [toldDigest, setToldDigest] = React.useState<string | null>(null);
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

  const liveDigest = React.useMemo(
    () => buildWorkVoiceBriefing(briefingInput).digest,
    [briefingInput]
  );
  const staleBy = toldDigest !== null && toldDigest !== liveDigest;

  const catchUp = React.useCallback(() => {
    const text = workVoiceCatchUp(briefingInput);
    if (!voiceRef.current.sendText(text)) return;
    contextPushes.current.add(text);
    setToldDigest(buildWorkVoiceBriefing(briefingInput).digest);
  }, [briefingInput]);

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
    <WorkVoiceSurface
      label="Voice conversation about this task"
      voice={voice}
      hiddenTexts={contextPushes.current}
      send={send}
      onClose={close}
      explanation={
        <>
          {briefedFromStream
            ? "Juno was told this task’s goal, plan and latest activity when you started talking."
            : "Juno was told this task’s goal and where it has got to when you started talking."}{" "}
          This is a separate conversation about the task: it can&rsquo;t see anything else, it
          can&rsquo;t change the task, and nothing said here reaches the run unless you send it.
        </>
      }
      notice={
        staleBy ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-field border border-border/60 bg-muted/40 px-3 py-2">
            <p className="font-mono text-label text-muted-foreground">
              The task has moved on since Juno was briefed
            </p>
            <Button type="button" variant="outline" size="sm" onClick={catchUp} className="gap-2">
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Bring Juno up to date
            </Button>
          </div>
        ) : undefined
      }
    />
  );
}
