"use client";

import * as React from "react";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import {
  buildWorkComposerVoiceBriefing,
  type WorkComposerVoiceBriefingInput,
} from "@/components/work/voice/work-voice-briefing";
import { WorkVoiceSurface, type WorkVoiceSend } from "@/components/work/voice/work-voice-surface";

/**
 * Talking a task into existence, before there is a task.
 *
 * ── Why this is not `WorkVoicePanel` with a null session ───────────────────
 *
 * That panel briefs the model on a task that exists — its goal, its plan, what
 * it is waiting on — and every one of those sections reads a `ClientWorkSession`
 * or an event stream. On the home composer there is no session and no stream,
 * and a "briefing" made of five absences is not a quieter version of that
 * conversation, it is a different one: the reader is not catching up on work,
 * they are working out what to ask for. `buildWorkComposerVoiceBriefing` is
 * that conversation's opening, and it carries the run ceilings out loud for a
 * reason the task briefing never needs to — nothing here stops a friendly voice
 * agreeing to an errand no twenty-minute run can finish.
 *
 * Everything the two share — the aura's position, the transcript, which line is
 * sendable, what a refused send leaves on screen — is `WorkVoiceSurface`.
 *
 * ── Where the words go ─────────────────────────────────────────────────────
 *
 * Into the composer's own goal field, and nowhere else. There is no route that
 * persists a Work voice transcript and this deliberately does not invent one:
 * `VoiceTranscriptSession` is Conversation-and-Message shaped, a Work task is a
 * goal plus an executor plus a policy, and writing a rambling call into
 * `WorkSession.goal` would produce a task nobody wrote — the exact thing
 * `WorkSession.goal` is documented as never being. So the send intent is
 * `compose`: one deliberate press puts ONE spoken line in the box, in front of
 * the reader, who can edit it, add to it and press Start themselves.
 *
 * The rest of the call is not saved, and the panel says so rather than
 * pretending otherwise. That is the honest arrangement here, not a gap: a call
 * about what to ask for is thinking, and the artefact of it is the sentence the
 * reader chose to keep.
 */
export function WorkComposerVoicePanel({
  briefing,
  send,
  onClose,
}: {
  /**
   * The composer's state at the moment the microphone opened.
   *
   * Read ONCE, on mount — the relay seeds `history` exactly once
   * (`historySeeded` in `relay/src/session.ts`), so nothing sent after this is
   * a re-briefing, and following the prop would be a promise this transport
   * cannot keep. Later edits to the box are the reader's to mention.
   */
  briefing: WorkComposerVoiceBriefingInput;
  /** Puts one spoken line into the goal field. Resolves false if it could not. */
  send: WorkVoiceSend;
  onClose: () => void;
}) {
  const voice = useRealtimeVoice();

  // Start once. `start` is deliberately absent from the dependency list: the
  // hook rebuilds that callback whenever the provider or status changes, and
  // following it here would restart the session — mic, socket and all —
  // mid-conversation. The briefing is read through a ref for the same reason it
  // is only read once: this composer re-renders on every keystroke.
  const startedRef = React.useRef(false);
  const voiceRef = React.useRef(voice);
  voiceRef.current = voice;
  const briefingRef = React.useRef(briefing);
  briefingRef.current = briefing;
  React.useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void voiceRef.current.start(
      undefined,
      buildWorkComposerVoiceBriefing(briefingRef.current).entries
    );
  }, []);

  const close = React.useCallback(() => {
    voiceRef.current.end();
    onClose();
  }, [onClose]);

  return (
    <WorkVoiceSurface
      label="Voice conversation about the task you are writing"
      voice={voice}
      send={send}
      onClose={close}
      explanation={
        <>
          Juno was told what is in the box and how you have set it up, and nothing else. It
          can&rsquo;t create the task, start it or look anything up — when you&rsquo;re happy with
          how you&rsquo;ve worded it, send the line into the box and start it yourself. Nothing
          else said here is kept.
        </>
      }
    />
  );
}
