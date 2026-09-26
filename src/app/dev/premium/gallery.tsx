"use client";

import * as React from "react";
import { JunoVoiceGlow } from "@/components/voice/voice-composer-glow";

import { AppProvider } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import { CodeComposer } from "@/components/code/code-composer";
import { CodeStartingPoints } from "@/components/code/code-starting-points";
import { EmptyGreeting } from "@/components/chat/empty-state";
import { StarterChips } from "@/components/chat/starter-chips";
import { GenerationPlaceholder } from "@/components/chat/generation-placeholder";
import { MessageItem } from "@/components/chat/message-item";
import { RealtimeVoice, voiceCallParts } from "@/components/voice/realtime-voice";
import { TeamStatus } from "@/components/agents/team-status";
import { MetalCta } from "@/components/effects/metal-cta";
import { Button } from "@/components/ui/button";
import type { ClientAgent } from "@/lib/agents/types";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ModelId } from "@/lib/models";
import type { AppBootstrap } from "@/types/app";
import type { ChatMessage } from "@/hooks/use-chat";
import type { ClientArtifact, GenerationStatus, ReasoningEffort } from "@/types/chat";

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

const AT = new Date(Date.now() - 20_000).toISOString();

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role" | "content">): ChatMessage {
  return { createdAt: AT, attachments: [], ...partial };
}

const PHASES: Array<{ label: string; status: GenerationStatus; m: ChatMessage }> = [
  {
    label: "Thinking (reasoning, no trace yet): breathing",
    status: "thinking",
    m: message({ id: "p-think", role: "ASSISTANT", content: "", streaming: true }),
  },
  {
    label: "Searching (research phase of the run strip): searching",
    status: "thinking",
    m: message({
      id: "p-search",
      role: "ASSISTANT",
      content: "",
      streaming: true,
      activity: [
        { id: "a1", kind: "search", title: "Searching the web", detail: "prompt caching pricing", createdAt: AT },
      ],
    }),
  },
  {
    label: "Using a tool: working",
    status: "thinking",
    m: message({
      id: "p-tool",
      role: "ASSISTANT",
      content: "",
      streaming: true,
      activity: [{ id: "a2", kind: "tool", title: "Using GitHub", detail: "list pull requests", createdAt: AT }],
    }),
  },
  {
    label: "Writing (before the first visible token): composing",
    status: "writing",
    m: message({ id: "p-write", role: "ASSISTANT", content: "", streaming: true }),
  },
];

const team = (...states: string[]) => states.map((state, i) => ({ id: `a${i}`, state })) as unknown as ClientAgent[];

const NO_ARTIFACTS = new Map<string, ClientArtifact>();
const noop = () => {};

function Section({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section data-premium-section={id} className="border-t border-border py-10">
      <h2 className="text-heading">{title}</h2>
      {note && <p className="mt-1.5 max-w-prose text-body text-muted-foreground">{note}</p>}
      <div className="mt-6">{children}</div>
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <p className="mb-2 text-caption text-muted-foreground">{children}</p>;
}

/** A demo level for the glow: a spoken-phrase envelope, not a sine. */
function useDemoLevel() {
  const start = React.useRef(0);
  React.useEffect(() => {
    start.current = performance.now();
  }, []);
  return React.useCallback(() => {
    const t = (performance.now() - start.current) / 1000;
    const phrase = Math.max(0, Math.sin(t * 1.3)) ** 0.6;
    const syllable = 0.55 + 0.45 * Math.abs(Math.sin(t * 9.1) * Math.sin(t * 3.7));
    return Math.min(1, phrase * syllable * 0.9);
  }, []);
}

/** A stand-in call controller: only what the call bar reads, with a live
 *  demo level in `levelRef` the way the hook fills it from the mic. */
function useFakeCall(state: { userSpeaking: boolean; awaitingResponse: boolean }) {
  const level = useDemoLevel();
  const levelRef = React.useRef(0);
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      levelRef.current = state.awaitingResponse ? 0 : level();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [level, state.awaitingResponse]);
  return {
    status: "live",
    provider: "qwen",
    model: "qwen3-omni",
    thinking: false,
    notice: null,
    error: null,
    availability: null,
    capabilities: null,
    assistantSpeaking: false,
    userSpeaking: state.userSpeaking,
    awaitingResponse: state.awaitingResponse,
    reconnectAttempt: 0,
    transcript: [],
    muted: false,
    screenSharing: false,
    memory: false,
    persona: false,
    levelRef,
    setProvider: noop,
    toggleMute: noop,
    interrupt: noop,
    startScreenShare: noop,
    stopScreenShare: noop,
    start: noop,
    stop: noop,
  } as unknown as Parameters<typeof RealtimeVoice>[0]["voice"];
}

function CallDemo({ thinking }: { thinking: boolean }) {
  const voice = useFakeCall({ userSpeaking: !thinking, awaitingResponse: thinking });
  return <RealtimeVoice voice={voice} onClose={noop} />;
}

/** The call drawn into the real Composer: status left, controls right, End in the primary slot. */
function CallComposerDemo({
  common,
  speaking = false,
  muted = false,
}: {
  common: Omit<React.ComponentProps<typeof Composer>, "isBusy" | "status">;
  speaking?: boolean;
  muted?: boolean;
}) {
  const base = useFakeCall({ userSpeaking: !speaking && !muted, awaitingResponse: false });
  const voice = { ...base, assistantSpeaking: speaking, muted } as typeof base;
  return (
    <Composer
      {...common}
      isBusy={false}
      status="idle"
      frame="dock"
      voiceActive
      placeholder="Type while you talk…"
      voiceCall={voiceCallParts({ voice, onClose: noop })}
    />
  );
}

function VoiceDemo({ processing }: { processing: boolean }) {
  const level = useDemoLevel();
  return (
    <JunoVoiceGlow level={level} processing={processing} className="w-full rounded-composer">
      <div className="composer-surface relative flex w-full flex-col rounded-composer">
        <p className="voice-glow-content block min-h-[3.25rem] px-4 pb-2 pt-3.5 text-body-lg text-foreground">
          Book a table for four on Friday, somewhere quiet near the office
        </p>
        <p className="voice-glow-content px-4 pb-3 text-caption text-muted-foreground">
          {processing ? "Transcribing" : "Listening"}
        </p>
      </div>
    </JunoVoiceGlow>
  );
}

export function PremiumGallery({ only }: { only?: string }) {
  const [model, setModel] = React.useState<ModelId>(AUTO_MODEL_ID);
  const [effort, setEffort] = React.useState<ReasoningEffort | null>(null);
  const common = {
    conversationId: null,
    model,
    onModelChange: setModel,
    onSend: () => ({ accepted: true }),
    onStop: () => {},
    reasoningEffort: effort,
    onReasoningChange: setEffort,
    onToggleWebSearch: () => {},
    webSearchEnabled: false,
    onToggleConnector: () => {},
  };
  const show = (id: string) => !only || only === id;

  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      <main className="app-main-canvas min-h-dvh bg-background pb-24 text-foreground">
        <div className="page-gutter mx-auto w-full max-w-3xl py-12">
          <h1 className="font-serif text-page-title">Premium pass</h1>
          <p className="mt-1 text-body text-muted-foreground">Libraries.dev placements on the real components.</p>

          {show("landings") && (
            <Section id="landings" title="Empty states" note="Chat and Code, one display system: the greeting in the display face, the composer as the hero, four starting points.">
              <div className="space-y-16">
                <div className="flex flex-col items-center">
                  <div className="mb-6 flex w-full justify-center sm:mb-8">
                    <EmptyGreeting />
                  </div>
                  <div className="relative isolate w-full">
                    <Composer {...common} isBusy={false} status="idle" frame="landing" />
                    <StarterChips className="mt-3" />
                  </div>
                </div>
                <div className="flex flex-col items-center pt-24">
                  <h1 className="mb-6 text-balance text-center font-serif text-display font-normal text-foreground sm:mb-8">
                    What should we build, <span className="italic">Dev</span>?
                  </h1>
                  <div className="w-full">
                    <CodeComposer />
                    <CodeStartingPoints />
                  </div>
                </div>
              </div>
            </Section>
          )}

          {show("composer") && (
            <Section
              id="composer"
              title="Composer"
              note="The bloom on the empty landing composer until the first keystroke; the travelling beam once a reply has streamed for 3 s."
            >
              <div className="space-y-10">
                <div>
                  <Label>Landing, empty (pulse-outside)</Label>
                  <Composer {...common} isBusy={false} status="idle" frame="landing" />
                </div>
                <div>
                  <Label>Docked, streaming (travelling beam, appears after 3 s)</Label>
                  <Composer {...common} isBusy status="writing" frame="dock" />
                </div>
              </div>
            </Section>
          )}

          {show("phases") && (
            <Section
              id="phases"
              title="Live phases"
              note="The matrix holds the slot for the first 2 s, then the orb for the real phase fades in."
            >
              <div className="space-y-6">
                {PHASES.map(({ label, status, m }) => (
                  <div key={m.id}>
                    <Label>{label}</Label>
                    <MessageItem
                      message={m}
                      isLast
                      busy
                      status={status}
                      artifactsByIdentifier={NO_ARTIFACTS}
                      onOpenArtifact={noop}
                      onFeedback={noop}
                      canFeedback={false}
                    />
                  </div>
                ))}
              </div>
            </Section>
          )}

          {show("image") && (
            <Section id="image" title="Image generation" note="The pixel mosaic churns in the image's box while the job runs; the finished picture arrives as the turn's attachment.">
              <div className="flex flex-wrap gap-8">
                <GenerationPlaceholder progress={{ modality: "image", stage: "generating" }} />
                <GenerationPlaceholder progress={{ modality: "image", stage: "polling" }} />
              </div>
            </Section>
          )}

          {show("agents") && (
            <Section id="agents" title="Agents" note="The roster header's team line: the bot hops while any agent works, and says who needs you first.">
              <div className="flex flex-col gap-4">
                <TeamStatus agents={team("working", "idle", "thinking")} />
                <TeamStatus agents={team("waiting", "working")} />
                <TeamStatus agents={team("idle", "done")} />
                <TeamStatus agents={team("sleeping", "sleeping")} />
              </div>
            </Section>
          )}

          {show("upgrade") && (
            <Section id="upgrade" title="Upgrade" note="The page's one metal object: the recommended plan's upgrade button. Silver, still under reduced motion.">
              <div className="grid max-w-xl grid-cols-2 gap-4">
                <div className="surface-raised rounded-card p-5">
                  <p className="text-heading">Plus</p>
                  <p className="mt-1 text-ui text-muted-foreground">For everyday use</p>
                  <div className="mt-6">
                    <Button variant="secondary" className="w-full">Upgrade to Plus</Button>
                  </div>
                </div>
                <div className="surface-raised-lg rounded-card border-primary/60 p-5">
                  <p className="text-heading">Pro</p>
                  <p className="mt-1 text-ui text-muted-foreground">Every model, more room</p>
                  <div className="mt-6">
                    <MetalCta>
                      <Button className="w-full">Upgrade to Pro</Button>
                    </MetalCta>
                  </div>
                </div>
              </div>
            </Section>
          )}

          {show("call") && (
            <Section id="call" title="Voice call in the composer" note="No floating bar and no page wash: the composer becomes the call.">
              <div className="space-y-8">
                <div>
                  <Label>Listening</Label>
                  <CallComposerDemo common={common} />
                </div>
                <div>
                  <Label>Juno is speaking (Stop appears)</Label>
                  <CallComposerDemo common={common} speaking />
                </div>
                <div>
                  <Label>Muted</Label>
                  <CallComposerDemo common={common} muted />
                </div>
              </div>
            </Section>
          )}

          {show("voice") && (
            <Section id="voice" title="Dictation" note="Demo level here; the product feeds the open microphone stream.">
              <div className="space-y-8">
                <div>
                  <Label>Listening</Label>
                  <VoiceDemo processing={false} />
                </div>
                <div>
                  <Label>Transcribing (processing)</Label>
                  <VoiceDemo processing />
                </div>
                <div>
                  <Label>Voice mode call bar, caller speaking (the product reads the call&apos;s level)</Label>
                  <CallDemo thinking={false} />
                </div>
                <div>
                  <Label>Voice mode call bar, waiting for the answer (processing)</Label>
                  <CallDemo thinking />
                </div>
              </div>
            </Section>
          )}
        </div>
      </main>
    </AppProvider>
  );
}
