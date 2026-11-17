"use client";

import * as React from "react";
import { useTheme } from "next-themes";

import { AppProvider } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { VoiceCallNotices, voiceCallParts } from "@/components/voice/realtime-voice";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ModelId } from "@/lib/models";
import { publishVoiceBands, voiceLevelRef } from "@/lib/voice-level";
import type { ChatMessage } from "@/hooks/use-chat";
import type { AppBootstrap } from "@/types/app";
import type { ReasoningEffort } from "@/types/chat";

import type { StageState } from "./states";

/* Only what the rendered components read is filled in. */
const BOOTSTRAP = {
  user: { id: "dev", name: "Dev", email: null, image: null },
  settings: {
    theme: "system",
    accent: "coral",
    defaultModel: AUTO_MODEL_ID,
    personality: "default",
    customInstructions: "",
    responseLanguage: "auto",
    uiLocale: "en",
    memoryEnabled: true,
    memorySensitiveTopics: [],
    memoryBackgroundLearning: false,
    backgroundProviderMode: "same_provider",
    voiceId: null,
    favoriteModels: [],
    emailBudgetAlerts: false,
    emailWeeklyDigest: false,
  },
  quota: { plan: "PRO", used: 0, limit: null, remaining: null },
  spend: {},
  conversations: [],
  folders: [],
  features: {
    billing: false,
    purchasablePlans: [],
    purchasableAnnualPlans: [],
    serverStt: false,
    serverTts: false,
    ttsProvider: null,
    storage: true,
    webSearch: true,
    deepResearch: true,
    email: false,
    providers: ["anthropic", "openai", "google"],
    isOwner: false,
  },
} as unknown as AppBootstrap;

const noop = () => {};
const AT = new Date(Date.now() - 40_000).toISOString();

type Controller = Parameters<typeof voiceCallParts>[0]["voice"];

interface CallState {
  status: "connecting" | "live" | "reconnecting" | "ended" | "error";
  muted: boolean;
  userSpeaking: boolean;
  awaitingResponse: boolean;
  assistantSpeaking: boolean;
  wasLive: boolean;
  error: string | null;
  closedReason: string | null;
  endedNote: string | null;
}

const LIVE: CallState = {
  status: "live",
  muted: false,
  userSpeaking: false,
  awaitingResponse: false,
  assistantSpeaking: false,
  wasLive: true,
  error: null,
  closedReason: null,
  endedNote: null,
};

function snapshotFor(state: StageState): CallState | null {
  switch (state) {
    case "composer":
      return null;
    case "connecting":
      return { ...LIVE, status: "connecting", wasLive: false };
    case "listening":
      return { ...LIVE, userSpeaking: true };
    case "thinking":
      return { ...LIVE, awaitingResponse: true };
    case "speaking":
      return { ...LIVE, assistantSpeaking: true };
    case "muted":
      return { ...LIVE, muted: true };
    case "muted-speaking":
      return { ...LIVE, muted: true, assistantSpeaking: true };
    case "reconnecting":
      return { ...LIVE, status: "reconnecting" };
    case "error":
      return { ...LIVE, status: "error", error: "Gemini 3.8 Live stopped responding. Try again." };
    case "ended":
      return { ...LIVE, status: "ended", closedReason: "session-limit", endedNote: "Ended: calls with Gemini 3.8 Live last up to 15 minutes." };
  }
}

const GEMINI_CAPS = {
  videoInput: true,
  screenInput: true,
  trueS2S: true,
  needsClientTranscript: false,
  thinkingChoice: false,
  reasoningEfforts: ["low", "medium", "high"],
  defaultReasoningEffort: "low",
  maxSessionSec: 900,
};

function controllerFor(call: CallState, actions: { set: (next: Partial<CallState>) => void }): Controller {
  const live = call.status === "live";
  return {
    ...call,
    provider: "gemini",
    model: call.wasLive ? "gemini-3.8-live" : null,
    delegate: live ? { model: "gemini-3.8-flash", effort: "low", webSearch: true } : null,
    effort: null,
    thinking: false,
    notice: null,
    limitWarning: null,
    availability: null,
    capabilities: call.wasLive ? GEMINI_CAPS : null,
    reconnectAttempt: call.status === "reconnecting" ? 1 : 0,
    transcript: [],
    screenSharing: false,
    memory: live,
    persona: false,
    toolActivity: [],
    toolsOffered: null,
    levelRef: { current: 0 },
    audioStreams: { mic: null, output: null },
    retry: async () => actions.set({ ...LIVE, status: "connecting", wasLive: false, closedReason: null, endedNote: null, error: null }),
    interrupt: () => actions.set({ assistantSpeaking: false }),
    toggleMute: () => actions.set({ muted: !call.muted }),
    startScreenShare: async () => undefined,
    stopScreenShare: noop,
    switchProvider: noop,
    setThinking: noop,
    setEffort: noop,
    start: async () => undefined,
  } as unknown as Controller;
}

declare global {
  interface Window {
    /** Move the stage's call to a state (dev only). */
    __voiceStage?: (state: StageState) => void;
  }
}

/**
 * Synthetic speech on the call's level bus: syllables at about four a second
 * in phrases, so the meter and the edge move as they would on a voice.
 */
function useSyntheticVoices(call: CallState | null) {
  const callRef = React.useRef(call);
  callRef.current = call;
  React.useEffect(() => {
    let raf = 0;
    const bands = new Float32Array(5);
    const start = performance.now();
    const tick = (now: number) => {
      const t = (now - start) / 1000;
      const c = callRef.current;
      const syllable = (offset: number) => {
        const phrase = 0.7 + 0.3 * Math.sin((t + offset) * Math.PI * 0.45);
        const beat = 0.5 + 0.5 * Math.sin((t + offset) * Math.PI * 2 * 3.7) * Math.sin((t + offset) * Math.PI * 2 * 1.3 + 0.6);
        return Math.min(1, phrase * (0.35 + 0.5 * beat));
      };
      const you = c && c.status === "live" && !c.muted && !c.assistantSpeaking && c.userSpeaking ? syllable(0) : c && c.status === "live" && !c.muted && !c.assistantSpeaking ? 0.04 : 0;
      const alevr = c && c.status === "live" && c.assistantSpeaking ? syllable(0.7) : 0;
      voiceLevelRef("user").current = you;
      voiceLevelRef("assistant").current = alevr;
      const active = Math.max(you, alevr);
      bands[0] = active * (0.8 + 0.2 * Math.sin(t * 9));
      bands[1] = active * (0.6 + 0.3 * Math.sin(t * 13 + 1));
      bands[2] = active * (0.45 + 0.3 * Math.sin(t * 7 + 2));
      bands[3] = active * (0.3 + 0.2 * Math.sin(t * 11 + 3));
      bands[4] = active * (0.18 + 0.15 * Math.sin(t * 17 + 4));
      publishVoiceBands(bands);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
}

function useForcedTheme(theme: "light" | "dark" | undefined) {
  const { setTheme } = useTheme();
  React.useEffect(() => {
    if (theme) setTheme(theme);
  }, [theme, setTheme]);
}

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "content">): ChatMessage {
  return { createdAt: AT, attachments: [], ...partial };
}

const THREAD: ChatMessage[] = [
  message({ id: "u1", role: "USER", content: "Find somewhere quiet for four near the office on Friday." }),
  message({
    id: "a1",
    role: "ASSISTANT",
    content: "Lune on Carver Street has a table at 7:30 and a back room that stays quiet. Want me to book it and tell Sam?",
  }),
];
const NO_ARTIFACTS = new Map();

/** Drawn on the client only: a call never renders on the server in the product, and the share button reads the browser. */
function ClientOnly({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : null;
}

function Stage({ initial, ios }: { initial: StageState; ios: boolean }) {
  const [call, setCall] = React.useState<CallState | null>(() => snapshotFor(initial));
  const [model, setModel] = React.useState<ModelId>(AUTO_MODEL_ID);
  const [effort, setEffort] = React.useState<ReasoningEffort | null>(null);
  useSyntheticVoices(call);

  React.useEffect(() => {
    window.__voiceStage = (state) => setCall(snapshotFor(state));
    return () => {
      delete window.__voiceStage;
    };
  }, []);

  // iOS Safari has no getDisplayMedia: take it away, then draw again, so the
  // phone stills show the phone's row.
  const [, redraw] = React.useState(0);
  React.useLayoutEffect(() => {
    if (!ios || typeof MediaDevices === "undefined") return;
    delete (MediaDevices.prototype as { getDisplayMedia?: unknown }).getDisplayMedia;
    redraw((n) => n + 1);
  }, [ios]);

  const set = React.useCallback((next: Partial<CallState>) => setCall((cur) => (cur ? { ...cur, ...next } : cur)), []);
  const voice = call ? controllerFor(call, { set }) : null;

  // The voice button opens a call: connecting, then up and listening.
  const open = React.useCallback(() => {
    setCall(snapshotFor("connecting"));
    window.setTimeout(() => setCall((cur) => (cur?.status === "connecting" ? { ...LIVE, userSpeaking: true } : cur)), 1600);
  }, []);

  return (
    <main className="app-main-canvas flex min-h-dvh flex-col bg-background text-foreground">
      <div className="page-gutter mx-auto flex w-full max-w-3xl flex-1 flex-col pt-10">
        <div className="flex-1 space-y-6">
          {THREAD.map((m, i) => (
            <MessageItem
              key={m.id}
              message={m}
              isLast={i === THREAD.length - 1}
              busy={false}
              status="idle"
              artifactsByIdentifier={NO_ARTIFACTS}
              onOpenArtifact={noop}
              onFeedback={noop}
              canFeedback={false}
            />
          ))}
        </div>
        <div className="sticky bottom-0 pb-8 pt-6">
          {voice && <VoiceCallNotices voice={voice} />}
          <Composer
            conversationId={null}
            model={model}
            onModelChange={setModel}
            onSend={() => ({ accepted: true })}
            onStop={noop}
            reasoningEffort={effort}
            onReasoningChange={setEffort}
            onToggleWebSearch={noop}
            webSearchEnabled={false}
            onToggleConnector={noop}
            isBusy={false}
            status="idle"
            frame="dock"
            voiceActive={!!voice}
            placeholder={voice ? "Add to the conversation" : undefined}
            voiceCall={voice ? voiceCallParts({ voice, onClose: () => setCall(null) }) : undefined}
            onOpenVoiceMode={voice ? undefined : open}
          />
        </div>
      </div>
    </main>
  );
}

export function VoiceCallStage({ state, theme, reduced, ios }: { state: StageState; theme?: "light" | "dark"; reduced: boolean; ios: boolean }) {
  useForcedTheme(theme);
  React.useEffect(() => {
    if (!reduced) return;
    const root = document.documentElement;
    const was = root.getAttribute("data-motion");
    root.setAttribute("data-motion", "reduced");
    return () => {
      if (was === null) root.removeAttribute("data-motion");
      else root.setAttribute("data-motion", was);
    };
  }, [reduced]);
  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <style>{"nextjs-portal{display:none!important}"}</style>
      <ClientOnly>
        <Stage initial={state} ios={ios} />
      </ClientOnly>
    </AppProvider>
  );
}
