"use client";

import * as React from "react";
import { useTheme } from "next-themes";

import { AppProvider } from "@/components/app/app-provider";
import { ApprovalCard } from "@/components/chat/approval-card";
import { Composer } from "@/components/chat/composer";
import { MessageItem } from "@/components/chat/message-item";
import { Button } from "@/components/ui/button";
import { composerFieldClass, composerIconButtonClass } from "@/components/ui/composer-shell";
import { Check, Send } from "@/components/ui/icons";
import { VoiceCallNotices, voiceCallParts } from "@/components/voice/realtime-voice";
import { JunoVoiceGlow, glowModeFor } from "@/components/voice/voice-composer-glow";
import type { GlowMode } from "@/components/voice/voice-glow-engine";
import type { GlowVariant } from "@/components/voice/voice-glow-renderer";
import { VoiceGlowStageContext, type GlowClock, type VoiceGlowProps, type VoiceGlowStage } from "@/components/voice/voice-glow-stage";
import type { ClientActionApproval } from "@/lib/action-approval";
import { ActionIcons } from "@/lib/app-icons";
import { AUTO_MODEL_ID } from "@/lib/auto-model";
import type { ModelId } from "@/lib/models";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/hooks/use-chat";
import type { AppBootstrap } from "@/types/app";
import type { ReasoningEffort } from "@/types/chat";

import { RefinedBeamGlow, TodayGlow } from "./beam-glows";
import { LAB_CELLS, PLAY_SCENES, SCENES, type CallSnapshot, type GlowPlay, type GlowState, type Scene } from "./scenes";

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

/* —————————————————————————— the call, as the hook reports it —————————————————————————— */

type VoiceController = Parameters<typeof voiceCallParts>[0]["voice"];

const STATIC_LEVEL = { current: 0 };

function fakeVoice(s: CallSnapshot): VoiceController {
  return {
    status: s.status,
    provider: "gemini",
    model: s.status === "live" ? "gemini-3.8-live" : null,
    thinking: false,
    notice: null,
    error: s.error,
    availability: null,
    capabilities: null,
    assistantSpeaking: s.assistantSpeaking,
    userSpeaking: s.userSpeaking,
    awaitingResponse: s.awaitingResponse,
    reconnectAttempt: s.status === "reconnecting" ? 1 : 0,
    transcript: [],
    muted: s.muted,
    screenSharing: false,
    memory: false,
    persona: false,
    levelRef: STATIC_LEVEL,
    audioStreams: { mic: null, output: null },
    retry: noop,
    interrupt: noop,
    toggleMute: noop,
    startScreenShare: noop,
    stopScreenShare: noop,
    switchProvider: noop,
    setThinking: noop,
    start: noop,
  } as unknown as VoiceController;
}

/** The light's mode at a scene moment, through the product's own mapping (voiceCallParts → glowModeFor). */
function modeOf(scene: Scene, ms: number): GlowMode {
  if (scene.dictation) {
    const d = scene.dictation(ms);
    return glowModeFor({ processing: d.transcribing, paused: d.closing, tone: d.transcribing ? "thinking" : "you" });
  }
  const s = scene.call(ms);
  if (!s) return "off";
  const parts = voiceCallParts({ voice: fakeVoice(s), onClose: noop });
  return glowModeFor(parts);
}

function sameSnapshot(a: CallSnapshot | null, b: CallSnapshot | null) {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.status === b.status &&
    a.muted === b.muted &&
    a.userSpeaking === b.userSpeaking &&
    a.awaitingResponse === b.awaitingResponse &&
    a.assistantSpeaking === b.assistantSpeaking &&
    a.error === b.error
  );
}

/* —————————————————————————— scene time —————————————————————————— */

declare global {
  interface Window {
    /** Clip capture: freeze every scene on the page at `ms` (dev only). */
    __voiceGlowSetTime?: (ms: number) => void;
    __voiceGlowReady?: boolean;
  }
}

/**
 * One clock for the page. Frozen (a still, or a clip being captured frame by
 * frame through `window.__voiceGlowSetTime`) or running (looping `loopMs`).
 * React renders on discrete change only; the light samples `now()` per frame.
 */
function usePageClock(frozenAt: number | undefined, loopMs: number | undefined) {
  const [frozen, setFrozen] = React.useState<number | undefined>(frozenAt);
  const origin = React.useRef<number | null>(null);
  React.useEffect(() => {
    window.__voiceGlowSetTime = (ms: number) => setFrozen(ms);
    window.__voiceGlowReady = true;
    return () => {
      delete window.__voiceGlowSetTime;
      delete window.__voiceGlowReady;
    };
  }, []);
  const clock = React.useMemo<GlowClock>(() => {
    if (frozen !== undefined) return { now: () => frozen, frozen: true };
    return {
      now: () => {
        const t = performance.now();
        if (origin.current === null) origin.current = t;
        const ms = t - origin.current;
        return loopMs ? ms % loopMs : ms;
      },
      frozen: false,
    };
  }, [frozen, loopMs]);
  return clock;
}

/** A scene value that re-renders only when it changes. */
function useSceneValue<T>(clock: GlowClock, read: (ms: number) => T, same: (a: T, b: T) => boolean): T {
  const [value, setValue] = React.useState<T>(() => read(clock.now()));
  const readRef = React.useRef(read);
  const sameRef = React.useRef(same);
  React.useLayoutEffect(() => {
    readRef.current = read;
    sameRef.current = same;
  });
  React.useEffect(() => {
    if (clock.frozen) {
      setValue((cur) => {
        const next = readRef.current(clock.now());
        return sameRef.current(cur, next) ? cur : next;
      });
      return;
    }
    let raf = 0;
    const tick = () => {
      setValue((cur) => {
        const next = readRef.current(clock.now());
        return sameRef.current(cur, next) ? cur : next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock]);
  return value;
}

function useForcedTheme(theme: "light" | "dark" | undefined) {
  const { setTheme } = useTheme();
  React.useEffect(() => {
    if (theme) setTheme(theme);
  }, [theme, setTheme]);
}

/* —————————————————————————— the real composer in a call —————————————————————————— */

function useComposerCommon() {
  const [model, setModel] = React.useState<ModelId>(AUTO_MODEL_ID);
  const [effort, setEffort] = React.useState<ReasoningEffort | null>(null);
  return {
    conversationId: null,
    model,
    onModelChange: setModel,
    onSend: () => ({ accepted: true }),
    onStop: noop,
    reasoningEffort: effort,
    onReasoningChange: setEffort,
    onToggleWebSearch: noop,
    webSearchEnabled: false,
    onToggleConnector: noop,
  };
}

const APPROVAL: ClientActionApproval = {
  id: "dev-approval",
  surface: "voice",
  sessionId: "dev",
  conversationId: null,
  connectorId: "gmail",
  connectorLabel: "Gmail",
  toolName: "gmail__send_email",
  action: "Send an email",
  riskClass: "external_write",
  preview: "To Sam Ortiz: “Table for four, Friday 7:30 at Lune. See you there.”",
  detail: { to: "sam.ortiz@example.com", subject: "Friday", body: "Table for four, Friday 7:30 at Lune. See you there." },
  receiptDigest: "dev",
  status: "pending",
  decision: null,
  canAllowScope: false,
  derivedFromUntrusted: false,
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  decidedAt: null,
  completedAt: null,
  createdAt: AT,
};

function CallComposer({ scene, clock }: { scene: Scene; clock: GlowClock }) {
  const common = useComposerCommon();
  const snapshot = useSceneValue(clock, scene.call, sameSnapshot);
  const voice = React.useMemo(() => (snapshot ? fakeVoice(snapshot) : null), [snapshot]);
  return (
    <div className="relative w-full">
      {voice && <VoiceCallNotices voice={voice} />}
      {scene.approval && (
        <div className="mb-3">
          <ApprovalCard approval={APPROVAL} />
        </div>
      )}
      <Composer
        {...common}
        isBusy={false}
        status="idle"
        frame="dock"
        voiceActive={!!voice}
        placeholder={voice ? "Type while you talk…" : undefined}
        voiceCall={voice ? voiceCallParts({ voice, onClose: noop }) : undefined}
        onOpenVoiceMode={voice ? undefined : noop}
      />
    </div>
  );
}

/**
 * Dictation, in the composer's own geometry (composer-dictation.tsx: the same
 * field class, the same controls row, the same light). A stand-in for the
 * real component, which opens the microphone and the recogniser on mount.
 */
function DictationComposer({ scene, clock }: { scene: Scene; clock: GlowClock }) {
  const d = useSceneValue(clock, scene.dictation!, (a, b) => a.transcribing === b.transcribing && a.closing === b.closing);
  return (
    <JunoVoiceGlow processing={d.transcribing} paused={d.closing} tone={d.transcribing ? "thinking" : "you"} className="w-full rounded-composer">
      <div role="group" aria-label="Dictation" className="composer-surface relative flex w-full flex-col rounded-composer">
        <div className={cn(composerFieldClass, "max-h-40 overflow-y-auto")}>
          <p className="whitespace-pre-wrap text-foreground">
            Book a table for four on Friday, somewhere quiet near the office
          </p>
        </div>
        <div className="flex flex-nowrap items-center gap-1 px-2.5 pb-2.5 pt-0.5">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel dictation" className={composerIconButtonClass}>
            <ActionIcons.dismiss className="size-4" />
          </Button>
          <span role="status" aria-live="polite" className={cn("min-w-0 truncate pl-1.5 text-ui text-muted-foreground", d.transcribing && "shimmer-text")}>
            {d.transcribing ? "Transcribing" : "Listening"}
          </span>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Button type="button" variant="ghost" size="sm" disabled={d.transcribing} aria-label="Stop dictation and edit the text">
              <Check className="size-4" />
              Done
            </Button>
            <button
              type="button"
              disabled={d.transcribing}
              aria-label="Send what you dictated"
              className="pressable grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:bg-secondary disabled:text-muted-foreground/70 coarse:size-11"
            >
              <Send weight="bold" aria-hidden="true" className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </JunoVoiceGlow>
  );
}

/** The stage for one scene: synthetic voices, the scene's mode timeline, the page clock. */
function useSceneStage(scene: Scene, clock: GlowClock, extra: Partial<VoiceGlowStage>): VoiceGlowStage {
  return React.useMemo(
    () => ({
      clock,
      levels: { you: (ms?: number) => scene.you(ms ?? clock.now()), alevr: (ms?: number) => scene.alevr(ms ?? clock.now()) },
      modeAt: (ms: number) => modeOf(scene, ms),
      ...extra,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, clock, extra.variant, extra.render, extra.reduced, extra.solid]
  );
}

function SceneComposer({ scene, clock, extra }: { scene: Scene; clock: GlowClock; extra: Partial<VoiceGlowStage> }) {
  const stage = useSceneStage(scene, clock, extra);
  return (
    <VoiceGlowStageContext.Provider value={stage}>
      {scene.dictation ? <DictationComposer scene={scene} clock={clock} /> : <CallComposer scene={scene} clock={clock} />}
    </VoiceGlowStageContext.Provider>
  );
}

/* —————————————————————————— the state gallery —————————————————————————— */

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

function StateView({ scene, clock, extra }: { scene: Scene; clock: GlowClock; extra: Partial<VoiceGlowStage> }) {
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
          <SceneComposer scene={scene} clock={clock} extra={extra} />
        </div>
      </div>
    </main>
  );
}

/* —————————————————————————— the lab —————————————————————————— */

interface Direction {
  key: string;
  name: string;
  variant?: GlowVariant;
  beam?: "today" | "refined";
  what: string;
  verdict: string;
  chosen?: boolean;
}

const DIRECTIONS: Direction[] = [
  {
    key: "A",
    name: "Edge light",
    variant: "edge",
    what: "The composer’s own 1px edge takes the speaker’s tone from the bottom centre, and the light spreads around the outline with the voice, falling off softly outside. Nothing inside the box.",
    verdict:
      "Chosen. It is still the glow (centred at the bottom, rising with the voice) turned inside out: the light leaves the object instead of filling it, so the field and the V3 edge stay crisp. The shape is the composer’s own outline, and presence on the edge is already how this product says “live”. Thinking is the Continuum handoff along the bottom edge, from your end to Alevr’s. Taken from D: when you talk over Alevr the two lights part toward their own sides instead of mixing at the centre. Cost: a WebGL canvas (shared, drawn only on change).",
    chosen: true,
  },
  {
    key: "B",
    name: "Horizon",
    variant: "horizon",
    what: "No edge. Light pools beneath the composer like a horizon, blooming from the speaker’s side: yours from the right, where your turns sit; Alevr’s from the left.",
    verdict:
      "Rejected. The calmest picture, but it lights the page under the composer rather than the composer, so on a phone it lands in the home-indicator strip and against the screen edge, and on ivory a light below an object reads as a coloured shadow. It also says less: who speaks is told by a side, which a glance at a dark corner cannot read.",
  },
  {
    key: "C",
    name: "Refined beam",
    beam: "refined",
    what: "Today’s package, as far as its props go: one colour family per voice, no idle breathing, no hue drift, no warp, no fringe, and the bloom masked to the bottom band of the box.",
    verdict:
      "Rejected. Much quieter than today, and honest about the work it reuses, but it is still the library’s chat-input demo: the light is clipped inside the box, so it still sits behind the controls row; on ivory a masked ember turns brown; and the hump is the package’s shape, not Alevr’s. Its ceiling is “less wrong”.",
  },
  {
    key: "D",
    name: "Two voices",
    variant: "duet",
    what: "The edge light again, but each voice is anchored at its own bottom corner, yours right and Alevr’s left, and grows toward the centre; talking over Alevr lights both ends and they meet.",
    verdict:
      "Close second. The best at interruption and the most literal handoff, but a light that lives in the corners leaves the centre of the composer dark while one person talks, climbs the sides to the top corners, and asymmetry reads as a fault at a glance. Its two anchors survive in the winner: the thinking pass runs from your end to Alevr’s, and two voices at once part toward them.",
  },
  {
    key: "Today",
    name: "The glow (1.8.1)",
    beam: "today",
    what: "Production: voice-glow’s chat-input effect retuned warm/cool.",
    verdict:
      "Replaced. A pink haze across the composer’s lower half and over its controls, teal for the assistant, candy on ivory, breathing while nobody speaks, and no dark mode of its own.",
  },
];

function LabCell({ direction, cell, clock: pageClock, base, stills }: { direction: Direction; cell: (typeof LAB_CELLS)[number]; clock: GlowClock; base: Partial<VoiceGlowStage>; stills: boolean }) {
  // A still lab freezes each moment at its own scene's still.
  const stillAt = cell.scene.stillAt;
  const clock = React.useMemo<GlowClock>(() => (stills ? { now: () => stillAt, frozen: true } : pageClock), [stills, stillAt, pageClock]);
  const render = React.useMemo(() => {
    if (!direction.beam) return undefined;
    const scene = cell.scene;
    const voices = { you: (ms?: number) => scene.you(ms ?? clock.now()), alevr: (ms?: number) => scene.alevr(ms ?? clock.now()) };
    const Beam = direction.beam === "today" ? TodayGlow : RefinedBeamGlow;
    function BeamRender(props: VoiceGlowProps) {
      return <Beam props={props} voices={voices} now={clock.now} />;
    }
    return BeamRender;
  }, [direction.beam, cell.scene, clock]);
  const extra = React.useMemo(() => ({ ...base, variant: direction.variant, render }), [base, direction.variant, render]);
  return (
    <div className="min-w-0">
      <p className="mb-2 text-caption text-muted-foreground">{cell.label}</p>
      <SceneComposer scene={cell.scene} clock={clock} extra={extra} />
    </div>
  );
}

function Lab({ clock, base, stills, rows }: { clock: GlowClock; base: Partial<VoiceGlowStage>; stills: boolean; rows?: string[] }) {
  const shown = rows ? DIRECTIONS.filter((d) => rows.includes(d.key)) : DIRECTIONS;
  return (
    <main className="app-main-canvas min-h-dvh bg-background pb-24 text-foreground">
      <div className="mx-auto w-full max-w-[1360px] px-10 py-10">
        <h1 className="font-serif text-page-title">The voice light</h1>
        <p className="mt-1 max-w-3xl text-body text-muted-foreground">
          Four refinements of the glow, in the real composer, on the same synthetic voices, against today. Ember is you, presence ink is Alevr, the handoff beam is thinking, graphite is muted. Silence is still in every one of them.
        </p>
        <div className="mt-8 divide-y divide-border border-t border-border">
          {shown.map((d) => (
            <section key={d.key} className="grid grid-cols-[260px_minmax(0,1fr)] gap-10 py-8">
              <div>
                <h2 className="text-body font-medium">
                  <span className="mr-2 text-muted-foreground">{d.key}</span>
                  {d.name}
                </h2>
                <p className="mt-2 text-caption text-muted-foreground">{d.what}</p>
                <p className={cn("mt-3 text-caption", d.chosen ? "text-foreground" : "text-muted-foreground")}>{d.verdict}</p>
              </div>
              <div className="grid grid-cols-2 gap-x-10 gap-y-8">
                {LAB_CELLS.map((cell) => (
                  <LabCell key={cell.id} direction={d} cell={cell} clock={clock} base={base} stills={stills} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

/* —————————————————————————— entry —————————————————————————— */

export function VoiceGlowGallery({
  state,
  play,
  theme,
  t,
  still,
  reduced,
  solid,
  rows,
}: {
  rows?: string[];
  state: GlowState;
  play?: GlowPlay;
  theme?: "light" | "dark";
  t?: number;
  still?: boolean;
  reduced?: boolean;
  solid?: boolean;
}) {
  useForcedTheme(theme);
  const scene = play ? PLAY_SCENES[play] : state === "lab" ? null : SCENES[state];
  // The lab's moments are each cell's still; a still freezes the state's chosen moment.
  const frozenAt = t ?? (still ? scene?.stillAt : undefined);
  const clock = usePageClock(frozenAt, play ? PLAY_SCENES[play].endsAt : undefined);
  const extra = React.useMemo(() => ({ reduced, solid }), [reduced, solid]);
  return (
    <AppProvider bootstrap={BOOTSTRAP}>
      {/* Stills and clips: no Next.js dev badge over the composer. */}
      <style>{"nextjs-portal{display:none!important}"}</style>
      <VoiceGlowStageContext.Provider value={extra}>
        {scene ? <StateView scene={scene} clock={clock} extra={extra} /> : <Lab clock={clock} base={extra} stills={!!still && t === undefined} rows={rows} />}
      </VoiceGlowStageContext.Provider>
    </AppProvider>
  );
}
