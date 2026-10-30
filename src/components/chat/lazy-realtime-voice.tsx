"use client";

import * as React from "react";
import type * as VoiceEngineModule from "@/components/chat/voice-engine";
import type { VoiceController } from "@/components/chat/voice-engine";
import { DEFAULT_VOICE_PROVIDER } from "@/lib/voice-relay-protocol";

export type { VoiceController };

/** The call bar and its notices, which arrive with the engine's chunk. */
export type VoiceCallUi = Pick<typeof VoiceEngineModule, "voiceCallParts" | "VoiceCallNotices">;

const NO_LINES: VoiceController["transcript"] = [];
const NO_STREAMS: VoiceController["audioStreams"] = { mic: null, output: null };
const SILENT_LEVEL: VoiceController["levelRef"] = { current: 0 };

/**
 * The controller before voice was ever opened: the realtime hook's own
 * starting state (no call, nothing heard, nothing said), and actions that do
 * nothing because there is no call for them to act on. The chat reads it
 * exactly as it reads a live controller, so nothing that renders before voice
 * opens has to know voice is not loaded yet. One frozen object, so its
 * identity never changes and no effect that depends on it re-runs.
 */
const idle: VoiceController = {
  status: "idle",
  provider: DEFAULT_VOICE_PROVIDER,
  thinking: false,
  availability: null,
  capabilities: null,
  transcript: NO_LINES,
  usage: null,
  muted: false,
  screenSharing: false,
  assistantSpeaking: false,
  userSpeaking: false,
  awaitingResponse: false,
  reconnectAttempt: 0,
  error: null,
  notice: null,
  model: null,
  delegate: null,
  effort: null,
  memory: false,
  persona: false,
  closedReason: null,
  levelRef: SILENT_LEVEL,
  audioStreams: NO_STREAMS,
  speechInterim: "",
  start: async () => undefined,
  retry: async () => undefined,
  end: () => undefined,
  switchProvider: () => undefined,
  setThinking: () => undefined,
  setEffort: () => undefined,
  interrupt: () => undefined,
  sendText: () => false,
  sendTurn: async () => ({ accepted: false, refusal: "not-live" }),
  clearTranscript: () => undefined,
  toggleMute: () => undefined,
  startScreenShare: async () => undefined,
  stopScreenShare: () => undefined,
};
export const IDLE_VOICE: VoiceController = Object.freeze(idle);

/**
 * Realtime voice, downloaded the first time it is opened.
 *
 * `voice` is the idle stand-in until then, and the live controller after.
 * `load()` fetches the engine's chunk, mounts it (render `engine` somewhere
 * that stays mounted for the conversation's life) and resolves with the live
 * controller, or with null when the chunk could not be fetched (offline); a
 * later call tries again. Once loaded the engine stays mounted, as the hook
 * did when the chat called it directly: closing a call ends it, and leaving
 * the conversation unmounts the engine, whose own teardown ends any call.
 *
 * Browsers only let audio start inside the click that asked for it, so the
 * caller wakes the shared AudioContext in that click (`getAudioContext()`)
 * before it waits on `load()`, as the hook's own `start` does.
 */
export function useLazyRealtimeVoice(): {
  voice: VoiceController;
  ui: VoiceCallUi | null;
  load: () => Promise<VoiceController | null>;
  engine: React.ReactNode;
} {
  const [voice, setVoice] = React.useState<VoiceController>(IDLE_VOICE);
  const [engineModule, setEngineModule] = React.useState<typeof VoiceEngineModule | null>(null);
  const liveRef = React.useRef<VoiceController | null>(null);
  const pendingRef = React.useRef<{ promise: Promise<VoiceController | null>; resolve: (controller: VoiceController | null) => void } | null>(null);

  const report = React.useCallback((controller: VoiceController) => {
    const first = liveRef.current === null;
    liveRef.current = controller;
    setVoice(controller);
    if (first) {
      pendingRef.current?.resolve(controller);
      pendingRef.current = null;
    }
  }, []);

  const load = React.useCallback((): Promise<VoiceController | null> => {
    if (liveRef.current) return Promise.resolve(liveRef.current);
    if (pendingRef.current) return pendingRef.current.promise;
    let resolve: (controller: VoiceController | null) => void = () => undefined;
    const promise = new Promise<VoiceController | null>((done) => {
      resolve = done;
    });
    const pending = { promise, resolve };
    pendingRef.current = pending;
    import("@/components/chat/voice-engine").then(
      (loaded) => setEngineModule(() => loaded),
      () => {
        if (pendingRef.current === pending) pendingRef.current = null;
        pending.resolve(null);
      },
    );
    return promise;
  }, []);

  const Engine = engineModule?.VoiceEngine;
  return {
    voice,
    ui: engineModule,
    load,
    engine: Engine ? <Engine onController={report} /> : null,
  };
}
