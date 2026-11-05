"use client";

import * as React from "react";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";

/*
 * Realtime voice for a conversation, loaded only once voice is opened.
 *
 * Everything a call needs (the relay socket, the microphone worklet, playback,
 * the call bar and its notices) is in this chunk, which `useLazyRealtimeVoice`
 * (lazy-realtime-voice.tsx) imports the first time the person opens voice. A
 * conversation that never opens voice never downloads it.
 *
 * The engine renders nothing. It runs the realtime hook and hands its
 * controller up after every render of its own, so the chat reads the call the
 * way it did when it called the hook itself. It is memoised and its one prop
 * is stable, so the chat re-rendering never re-renders it: only the call's own
 * state does, and each of those reports once.
 */

export { VoiceCallNotices, voiceCallParts } from "@/components/voice/realtime-voice";

export type VoiceController = ReturnType<typeof useRealtimeVoice>;

export const VoiceEngine = React.memo(function VoiceEngine({
  onController,
}: {
  onController: (controller: VoiceController) => void;
}) {
  const voice = useRealtimeVoice();
  // A layout effect, so the chat holds the live controller before the frame
  // that follows a change is painted (the call bar never shows a stale state).
  React.useLayoutEffect(() => {
    onController(voice);
  });
  return null;
});
