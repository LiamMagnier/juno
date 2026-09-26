"use client";

import * as React from "react";
import { VoiceBeam } from "voice-glow";

import { AppProvider } from "@/components/app/app-provider";
import { Composer } from "@/components/chat/composer";
import { GenerationPlaceholder } from "@/components/chat/generation-placeholder";
import { MessageItem } from "@/components/chat/message-item";
import { useEffectTheme } from "@/components/effects/use-effect-theme";
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

function VoiceDemo({ processing }: { processing: boolean }) {
  const theme = useEffectTheme();
  const level = useDemoLevel();
  return (
    <VoiceBeam
      level={level}
      processing={processing}
      theme={theme ?? "light"}
      colorVariant="sunset"
      className="w-full rounded-composer"
    >
      <div className="composer-surface relative flex w-full flex-col rounded-composer">
        <p className="voice-glow-content block min-h-[3.25rem] px-4 pb-2 pt-3.5 text-body-lg text-foreground">
          Book a table for four on Friday, somewhere quiet near the office
        </p>
        <p className="voice-glow-content px-4 pb-3 text-caption text-muted-foreground">
          {processing ? "Transcribing" : "Listening"}
        </p>
      </div>
    </VoiceBeam>
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
              </div>
            </Section>
          )}
        </div>
      </main>
    </AppProvider>
  );
}
