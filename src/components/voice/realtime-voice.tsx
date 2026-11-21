"use client";

import * as React from "react";
import { flushSync } from "react-dom";
import { CallEnd, CallMic, CallMicOff, CallSettings, CallStop, MonitorUp, MonitorX } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { IconSwap } from "@/components/ui/icon-swap";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApprovalCard } from "@/components/chat/approval-card";
import { GalaxyMark } from "@/components/brand/galaxy-mark";
import { useRealtimeVoice, type VoiceToolActivity } from "@/hooks/use-realtime-voice";
import { voiceToolStatusWord } from "@/lib/voice-tool-activity";
import { canShareScreen, voiceCallView, type VoiceCallState, type VoiceCallView } from "@/lib/voice-call-state";
import { voiceRestartLabel } from "@/lib/voice-copy";
import { inputModality } from "@/lib/input-modality";
import {
  VOICE_GEMINI_DELEGATE_MODEL,
  VOICE_OPENAI_DELEGATE_MODEL,
  VOICE_PROVIDER_LABELS,
  VOICE_PROVIDER_MODELS,
  VOICE_PROVIDERS,
  VOICE_REASONING_EFFORT_LABELS,
  parseVoiceReasoningEffort,
  voiceEffortPlan,
  voiceModelLabel,
  type VoiceProviderId,
} from "@/lib/voice-relay-protocol";
import { EffortPanelContext, ReasoningSlider } from "@/components/chat/reasoning-slider";
import { cn } from "@/lib/utils";
import { readVoiceLevel } from "@/lib/voice-level";
import type { VoiceGlowTone } from "@/components/effects/use-effect-theme";
import { VoiceComposerGlow } from "@/components/voice/voice-composer-glow";
import { VoiceCallChip } from "@/components/voice/voice-call-chip";
import { PRODUCT_NAME } from "@/lib/brand/names";
import "@/components/voice/voice-call.css";

type VoiceController = ReturnType<typeof useRealtimeVoice>;

/**
 * One line per provider, describing the trade it makes, in the person's
 * words rather than the relay's ("full duplex" and "speech pipeline" were
 * engineering terms, and "full duplex" was not even true in this client).
 */
const PROVIDER_BLURB: Record<VoiceProviderId, string> = {
  openai: `Thinks with ${voiceModelLabel(VOICE_OPENAI_DELEGATE_MODEL)} · sees images`,
  gemini: `Sees your screen · thinks with ${voiceModelLabel(VOICE_GEMINI_DELEGATE_MODEL)}`,
  qwen: "Long calls · sees images and your screen",
  minimax: "Long calls · can’t see images",
  // The row's title is already the model ("Grok Voice 3.0"); the line under
  // it names the provider, as OpenAI's does, rather than saying it twice.
  xai: "xAI · can’t see images",
  mock: "Developer stand-in · no provider is called",
};

/**
 * THE VOICE CALL, AS PARTS OF THE COMPOSER.
 *
 * Voice is a mode of the conversation, not a place (ChatGPT and Gemini both
 * retired their takeover screens for the same reason; INTERACTION_SPEC C16),
 * so the composer itself becomes the call, laid out like a native call
 * screen in one row:
 *
 *   [+]  (≋ Speaking ■)                        [mic] [share] [⚙] [↑] [End]
 *
 * - LEFT, one state at a time: the state chip (voice-call-chip.tsx), a word
 *   and a meter that follows real audio, from one state model
 *   (lib/voice-call-state.ts), with Stop inside it while Alevr speaks.
 * - RIGHT, the verbs in one row: Mute, Share where the browser can share a
 *   screen, the call's settings, and End in the
 *   composer's primary slot, the only coloured control, in the destructive
 *   role. Typing during a call puts Send beside End, never in its place.
 *   Every target is 44 by 44.
 * - THE EDGE: the composer's own edge carries the light while audio moves
 *   (voice-composer-glow.tsx), graphite for you and the accent for Alevr.
 *
 * Opening the call is one entrance from the voice button: End takes the
 * button's place, the controls arrive out of it nearest first, and the chip
 * rises in on the left (voice-call.css). End leaves faster than the call
 * arrived, cross-fading back into the composer with the draft as it was.
 *
 * Chat mounts the parts into the composer's slots (`voiceCall` on
 * <Composer>), Code into its own; surfaces without a composer of their own
 * use <RealtimeVoice>, the same parts in one quiet bar.
 */

export interface VoiceCallParts {
  /** Left of the composer: the state chip, with the call's live region. */
  status: React.ReactNode;
  /** Right of the composer: Mute, Share, call settings. */
  controls: React.ReactNode;
  /** The composer's primary slot: End, whether or not a draft is typed (Send goes beside it). */
  end: React.ReactNode;
  /** The call's one state (lib/voice-call-state.ts). */
  state?: VoiceCallState;
  /** Whose light the composer's edge carries; null while no audio moves. */
  edge?: VoiceCallView["edge"];
  /** The live level (0-1) of whoever is talking. */
  level: () => number;
  /** Each voice's own envelope: your microphone and Alevr's output as heard. */
  levels: { you: () => number; alevr: () => number };
  /**
   * Kept for the dictation light's props: a call's light reads `levels`, so
   * this is always null now.
   */
  stream: MediaStream | null;
  /** Kept with `stream`: unused by the call's light. */
  sensitivity?: number;
  /** The gap after you stop, while the reply is thought through. */
  processing: boolean;
  /** No audio moves (connecting, reconnecting, ended, failed). */
  paused: boolean;
  /** Whose light, in the glow's older vocabulary (the voice lab reads it). */
  tone: VoiceGlowTone;
}

/** The realtime hook's split envelopes (lib/voice-level.ts). */
const CALL_LEVELS = {
  you: () => readVoiceLevel("user"),
  alevr: () => readVoiceLevel("assistant"),
};

/** The call's one state, from the controller (lib/voice-call-state.ts). */
function viewOf(voice: VoiceController): VoiceCallView {
  return voiceCallView({
    transport: voice.status,
    muted: voice.muted,
    userSpeaking: voice.userSpeaking,
    awaitingResponse: voice.awaitingResponse,
    assistantSpeaking: voice.assistantSpeaking,
    wasLive: voice.wasLive,
  });
}

function toneOf(view: VoiceCallView): VoiceGlowTone {
  if (view.edge === "you") return "you";
  if (view.edge === "alevr") return "juno";
  return view.state === "thinking" ? "thinking" : "muted";
}

/** Everything the composer needs to become the call. */
export function voiceCallParts({
  voice,
  onClose,
  speakerName,
}: {
  voice: VoiceController;
  onClose: () => void;
  speakerName?: string;
}): VoiceCallParts {
  const view = viewOf(voice);
  const levelRef = voice.levelRef;
  return {
    state: view.state,
    edge: view.edge,
    level: view.state === "muted" ? () => 0 : () => levelRef.current,
    levels: CALL_LEVELS,
    stream: null,
    processing: view.state === "thinking",
    paused: view.edge === null && view.state !== "thinking" && view.state !== "listening",
    tone: toneOf(view),
    status: <VoiceCallStatus voice={voice} speakerName={speakerName} />,
    controls: <VoiceCallControls voice={voice} speakerName={speakerName} onClose={onClose} />,
    end: <VoiceCallEnd onClose={onClose} ended={voice.status === "ended" || voice.status === "error"} />,
  };
}

function speakerOf(voice: VoiceController, speakerName?: string) {
  return voice.persona && speakerName ? speakerName : PRODUCT_NAME;
}

/**
 * What the call is doing, beside `+`: the state chip. The word is for eyes;
 * a screen reader hears the chip's debounced live region, which says what a
 * person acts on (connected, microphone off and on, reconnecting, ended) and
 * never narrates the turns over the model's own voice.
 */
export function VoiceCallStatus({ voice, speakerName }: { voice: VoiceController; speakerName?: string }) {
  const speaker = speakerOf(voice, speakerName);
  return (
    <VoiceCallChip
      view={viewOf(voice)}
      // Stop lives in the chip, beside the word it ends: the row's right side
      // never grows or jumps when Alevr starts talking, and a phone keeps its
      // width for Mute and End.
      stop={
        voice.assistantSpeaking ? (
          <ChipStop onClick={voice.interrupt} label={`Stop ${speaker} speaking`} />
        ) : null
      }
    />
  );
}

/** Stop, inside the chip while Alevr speaks: a small disc drawn, a 44px target. */
function ChipStop({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "pressable voice-target -my-1 -mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full coarse:size-5",
            // An ink disc, the product's stop: it reads on the pill and, on a
            // phone where the pill gives its fill back, on the composer.
            "bg-foreground text-background hover:bg-foreground/90 motion-reduce:active:scale-100"
          )}
        >
          <CallStop className="size-2.5 fill-current" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Stop speaking</TooltipContent>
    </Tooltip>
  );
}

/** Which provider and model answer, and what the call knows: the settings button's description. */
function callDetail(voice: VoiceController): string | null {
  if (voice.status !== "live") return null;
  return [
    VOICE_PROVIDER_LABELS[voice.provider],
    voiceModelLabel(voice.model),
    voice.delegate
      ? `thinking with ${voiceModelLabel(voice.delegate.model)} at ${VOICE_REASONING_EFFORT_LABELS[voice.delegate.effort].toLowerCase()} effort`
      : null,
    voice.memory ? "remembers you" : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The verbs of a call, as the composer's icon buttons, in one row.
 *
 * FOCUS. Opening a call replaces the voice button the person pressed, which
 * threw focus to <body>; it lands on Mute instead, the most-used verb that
 * ends nothing (for a keyboard; a pointer needs no focus moved). Escape anywhere in the row stops Alevr speaking, and when it
 * is not speaking ends the call (C16).
 */
export function VoiceCallControls({
  voice,
  onClose,
}: {
  voice: VoiceController;
  speakerName?: string;
  onClose?: () => void;
}) {
  const live = voice.status === "live";
  const restartable = voice.status === "ended" || voice.status === "error";
  const muteRef = React.useRef<HTMLButtonElement>(null);
  const restart = restartable ? voiceRestartLabel(voice.status === "error" ? "error" : "ended", voice.closedReason) : null;

  React.useEffect(() => {
    // Only for a keyboard, and only when focus was lost with the button that
    // opened the call: a person already elsewhere (typing in the field) keeps
    // their place, and a pointer needs no focus moved (it would only pop
    // Mute's tooltip up under nobody's cursor).
    const active = document.activeElement;
    if (inputModality() === "keyboard" && (!active || active === document.body)) muteRef.current?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    if (voice.assistantSpeaking) voice.interrupt();
    else onClose?.();
  };

  return (
    // 8px between 36px discs, so their 44px targets meet; on touch the discs
    // are 44 already and sit edge to edge, glyphs well apart.
    <div role="group" aria-label="Call controls" onKeyDown={onKeyDown} className="voice-call-controls flex shrink-0 items-center gap-2 coarse:gap-0">
      {restartable ? (
        restart && (
          // The one thing to do next after a call ends or fails, in words
          // rather than as a lone glyph beside the red disc. Its name is its
          // visible text (WCAG 2.5.3).
          <span className="voice-call-part" style={{ "--voice-i": 1 } as React.CSSProperties}>
            <button
              type="button"
              onClick={() => void voice.retry()}
              className={cn(
                "pressable voice-target inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full pl-2.5 pr-3 text-ui font-medium text-foreground",
                "hover:bg-accent motion-reduce:active:scale-100",
                // A phone keeps the chip's word and End: the verb becomes its
                // glyph in a 44px disc, its word still its name.
                "coarse:size-11 coarse:justify-center coarse:p-0"
              )}
            >
              <ActionIcons.refresh className="size-4.5" aria-hidden="true" />
              <span className="coarse:sr-only">{restart}</span>
            </button>
          </span>
        )
      ) : (
        <>
          <span className="voice-call-part" style={{ "--voice-i": 2 } as React.CSSProperties}>
            <CallButton
              ref={muteRef}
              onClick={voice.toggleMute}
              pressed={voice.muted}
              // One name and a pressed state, as call apps say it; a name that
              // flipped with the state as well read "Turn your microphone back
              // on, pressed".
              label="Mute microphone"
              tooltip={voice.muted ? "Unmute" : "Mute"}
            >
              <IconSwap swapped={voice.muted} from={<CallMic className="size-[18px]" />} to={<CallMicOff className="size-[18px]" />} />
            </CallButton>
          </span>
          {voice.capabilities?.screenInput && live && canShareScreen() && (
            <span className="voice-call-part" style={{ "--voice-i": 1 } as React.CSSProperties}>
              <CallButton
                onClick={() => {
                  if (voice.screenSharing) voice.stopScreenShare();
                  else void voice.startScreenShare();
                }}
                pressed={voice.screenSharing}
                label="Share your screen"
                tooltip={voice.screenSharing ? "Stop sharing" : "Share screen"}
              >
                <IconSwap swapped={voice.screenSharing} from={<MonitorUp className="size-4.5" />} to={<MonitorX className="size-4.5" />} />
              </CallButton>
            </span>
          )}
        </>
      )}
      <span className="voice-call-part" style={{ "--voice-i": 0 } as React.CSSProperties}>
        <VoiceSettings voice={voice} />
      </span>
    </div>
  );
}

type ScopedTransitionHost = HTMLElement & {
  startViewTransition?: (update: () => void) => { ready: Promise<void> };
};

/**
 * End, in the composer's primary slot: the same size and place as Send, so
 * the hand already knows where it is, the only coloured control in a call,
 * and in the destructive role. It stays in that slot while a draft is typed:
 * Send appears beside it, never in its place (voice audit D6).
 *
 * LEAVING. The press hands the call back to the composer through an
 * element-scoped view transition on the call's frame, so the call row
 * cross-fades into the composer's own row on the exit rung, and only the
 * composer is touched: the thread stays live and clickable. Where scoped
 * transitions are missing the swap is immediate. Focus, which was on End,
 * goes to the field for a keyboard user (the draft is exactly as it was).
 *
 * `ended`: the call has already ended or failed, and the same button now
 * leaves voice mode. It keeps its face and place, and stops claiming to end a
 * call that is no longer there.
 */
export function VoiceCallEnd({ onClose, ended = false }: { onClose: () => void; ended?: boolean }) {
  const ref = React.useRef<HTMLButtonElement>(null);
  const close = () => {
    const frame = (ref.current?.closest(".voice-call-frame") ?? null) as ScopedTransitionHost | null;
    const keyboard = inputModality() === "keyboard";
    const field = frame?.querySelector<HTMLElement>('[contenteditable="true"], textarea') ?? null;
    const update = () => {
      flushSync(onClose);
      const active = document.activeElement;
      if (keyboard && field?.isConnected && (!active || active === document.body)) field.focus({ preventScroll: true });
    };
    if (frame?.startViewTransition) {
      try {
        frame.startViewTransition(update).ready.catch(() => {});
        return;
      } catch {
        /* no transition: switch at once */
      }
    }
    update();
  };
  return (
    <span className="voice-call-end inline-flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type="button"
            onClick={close}
            aria-label={ended ? "Close voice" : "End the call"}
            className={cn(
              "pressable voice-target inline-flex size-9 shrink-0 items-center justify-center rounded-full",
              "bg-destructive text-destructive-foreground hover:brightness-[1.06] active:brightness-95",
              "motion-reduce:active:scale-100 coarse:size-11"
            )}
          >
            <CallEnd className="size-4.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{ended ? "Close voice" : "End call"}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/**
 * A call's error or notice, as one plain line above the composer: colour and
 * a glyph where it needs acting on, muted where it does not. No pill.
 *
 * It wraps rather than truncates. These are sentences whose second half says
 * what to do ("…Allow the microphone for this site in your browser settings,
 * then restart voice."), and an ellipsis on a phone cut exactly that half.
 * Centred and balanced, with the glyph on the first line.
 */
const NOTICE_LINE = "mx-auto mb-2 flex max-w-xl items-start justify-center gap-1.5 px-3 text-caption motion-safe:animate-fade-in";
const NOTICE_GLYPH = "mt-0.5 size-3.5 shrink-0";

export function VoiceCallNotices({ voice }: { voice: VoiceController }) {
  return (
    <>
      <VoiceCallNotice voice={voice} />
      <VoiceToolActivityRow voice={voice} />
    </>
  );
}

function VoiceCallNotice({ voice }: { voice: VoiceController }) {
  if (voice.error) {
    return (
      <p role="alert" className={cn(NOTICE_LINE, "text-destructive-ink")}>
        <StatusIcons.warning className={NOTICE_GLYPH} aria-hidden="true" />
        <span className="min-w-0 text-balance">{voice.error}</span>
      </p>
    );
  }
  // Why the call ended, when the person did not end it (a provider's time cap,
  // the budget), and the last minute before a cap: said, never silent.
  const quiet = voice.endedNote ?? voice.limitWarning;
  if (quiet) {
    return (
      <p role="status" className={cn(NOTICE_LINE, "text-muted-foreground")}>
        <StatusIcons.info className={NOTICE_GLYPH} aria-hidden="true" />
        <span className="min-w-0 text-balance">{quiet}</span>
      </p>
    );
  }
  if (voice.notice) {
    return (
      <p role="status" className={cn(NOTICE_LINE, "text-muted-foreground")}>
        <StatusIcons.info className={NOTICE_GLYPH} aria-hidden="true" />
        <span className="min-w-0 text-balance">{voice.notice}</span>
      </p>
    );
  }
  return null;
}

const TOOL_CHIP_GLYPH = "size-3 shrink-0";

function ToolChipGlyph({ status }: { status: VoiceToolActivity["status"] }) {
  switch (status) {
    case "running":
      // The working mark, the one working indicator (DIRECTION.md §1), not a spinner.
      return <GalaxyMark phase="working" size={12} className="shrink-0" />;
    case "awaiting_approval":
      return <StatusIcons.info className={cn(TOOL_CHIP_GLYPH, "text-primary")} aria-hidden="true" />;
    case "succeeded":
      return <StatusIcons.success className={TOOL_CHIP_GLYPH} aria-hidden="true" />;
    case "failed":
      return <StatusIcons.error className={cn(TOOL_CHIP_GLYPH, "text-destructive-ink")} aria-hidden="true" />;
    default:
      return <ActionIcons.dismiss className={TOOL_CHIP_GLYPH} aria-hidden="true" />;
  }
}

/**
 * What the call's tools are doing, as compact chips above the composer, and
 * the chat's own approval card for a change waiting on the person — the same
 * card a typed turn shows, posting the same digest-bound answer. The voice
 * asks aloud at the same time; a spoken yes works where the card says so, and
 * once said (and sent from here, through the same route) the card steps aside
 * for its chip until the outcome arrives. One quiet line when the connected
 * voice model cannot use tools at all.
 */
function VoiceToolActivityRow({ voice }: { voice: VoiceController }) {
  const chips = voice.toolActivity;
  const waiting = chips.flatMap((entry) =>
    entry.status === "awaiting_approval" && entry.approval && !entry.answeredAloud
      ? [{ ...entry, approval: entry.approval }]
      : []
  );
  const unsupported = voice.status === "live" && voice.toolsOffered === 0;
  if (chips.length === 0 && !unsupported) return null;
  return (
    <div className="mx-auto mb-2 flex w-full max-w-xl flex-col items-stretch gap-2 px-3 motion-safe:animate-fade-in">
      {unsupported && (
        <p role="status" className={cn(NOTICE_LINE, "mb-0 text-muted-foreground")}>
          <StatusIcons.info className={NOTICE_GLYPH} aria-hidden="true" />
          <span className="min-w-0 text-balance">
            This voice model can’t use your apps or {PRODUCT_NAME}’s tools. Gemini can: switch in the call’s settings.
          </span>
        </p>
      )}
      {chips.length > 0 && (
        <ul aria-label="Tools in this call" className="flex flex-wrap justify-center gap-1.5">
          {chips.map((chip) => (
            <li key={chip.id} className="min-w-0 max-w-full">
              <Badge variant="muted" className="max-w-full gap-1 font-sans font-normal">
                <ToolChipGlyph status={chip.answeredAloud ? "running" : chip.status} />
                <span className="truncate">{chip.label}</span>
                <span className="sr-only">: {voiceToolStatusWord(chip)}</span>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {waiting.map((entry) => (
        <div key={entry.id} className="flex flex-col gap-1">
          <ApprovalCard approval={entry.approval} />
          <p className="text-center text-micro text-muted-foreground">
            {entry.spoken ? "You can also say yes or no." : "This one can only be approved here, not aloud."}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * The call for surfaces with no composer of their own (Code's voice briefing,
 * Work): the same parts in one quiet bar on the floating material, with the
 * same edge light along its outline.
 */
export function RealtimeVoice({
  voice,
  onClose,
  speakerName,
}: {
  voice: VoiceController;
  onClose: () => void;
  speakerName?: string;
}) {
  const parts = voiceCallParts({ voice, onClose, speakerName });
  return (
    <section aria-label="Voice call" className="relative mx-auto mb-3 flex w-full flex-col items-center px-2 motion-safe:animate-fade-in sm:px-0">
      <VoiceCallNotices voice={voice} />
      <div className="max-w-full">
        <VoiceComposerGlow call={parts}>
          <div className="flex items-center gap-2 rounded-full border border-[var(--float-edge)] bg-popover p-1.5 shadow-float coarse:gap-1">
            {parts.status}
            {parts.controls}
            {parts.end}
          </div>
        </VoiceComposerGlow>
      </div>
    </section>
  );
}

/**
 * Everything you SET, as opposed to everything you press.
 *
 * These three choices used to share one kebab menu with Stop, Mute and screen
 * share: a flat list where "MiniMax" and "Stop sharing screen" were the same
 * kind of row, and picking a provider looked like pressing a button. They are
 * not the same kind of thing. A provider and a reasoning mode are settings for
 * the call — you choose them once and live with them — so they get a panel
 * with headings, and the verbs stay on the bar where a thumb can find them.
 *
 * The reasoning row NAMES THE MODEL each position runs, because on both
 * providers that offer it the switch is not a parameter but a different model,
 * and a toggle that silently swaps the thing answering you should say so.
 */
function VoiceSettings({ voice }: { voice: VoiceController }) {
  const voiceHeadingId = React.useId();
  const detailId = React.useId();
  const detail = callDetail(voice);
  const live = voice.status === "live";
  const reconnecting = voice.status === "reconnecting";
  const switchable = live || voice.status === "connecting" || reconnecting;
  const listRef = React.useRef<HTMLElement>(null);
  // The panel's model name opens "the models" in the composer; here they are
  // the list just above, so it takes focus to the chosen one.
  const focusVoiceList = React.useCallback(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);
  const rungs = voice.capabilities?.reasoningEfforts;
  const dialValue = voice.effort ?? voice.capabilities?.defaultReasoningEffort ?? rungs?.[0];
  const dial =
    rungs && rungs.length > 1 && dialValue && (!live || voice.delegate)
      ? { rungs, value: dialValue, plan: voiceEffortPlan(voice.provider, dialValue) }
      : null;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger
            aria-label="Call settings"
            // Which model answers and what the call knows, said when the
            // button is reached rather than riding the live region on every
            // change (it used to be appended to each announcement).
            aria-describedby={detail ? detailId : undefined}
            className={cn(
              // `.pressable` times the colour cross-fade and the dip itself;
              // a transition-* utility beside it would replace that list and
              // leave the press untimed.
              "pressable voice-target inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground",
              "hover:bg-accent hover:text-foreground",
              "data-[state=open]:bg-accent data-[state=open]:text-foreground coarse:size-11",
              "motion-reduce:active:scale-100"
            )}
          >
            <CallSettings className="size-[18px]" />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Call settings</TooltipContent>
      </Tooltip>
      {detail ? (
        <span id={detailId} className="sr-only">
          {detail}
        </span>
      ) : null}

      <PopoverContent align="end" side="top" sideOffset={10} className="w-[min(20rem,calc(100vw-1.5rem))] p-0">
        <div className="flex flex-col">
          {/* The rows are radios, so their section is the group that names
              them — a `role="radio"` with no radiogroup is announced as a
              choice between nothing. */}
          {/* `p-1`: the 8px rows sit 4px inside the 12px popover, 12 − 4 = 8. */}
          <section
            ref={listRef}
            role="radiogroup"
            aria-labelledby={voiceHeadingId}
            // A radio group is one Tab stop with the arrows inside it, as the
            // platform's own radios are; these were Tab stops each, with no
            // arrow keys at all.
            onKeyDown={(event) => {
              const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              const radios = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)') ?? []);
              const at = radios.indexOf(document.activeElement as HTMLElement);
              if (at < 0 || radios.length === 0) return;
              event.preventDefault();
              radios[(at + step + radios.length) % radios.length]?.focus();
            }}
            className="flex flex-col gap-0.5 p-1"
          >
            <h3 id={voiceHeadingId} className="px-2.5 pb-1 pt-1 text-caption font-medium text-muted-foreground">Voice</h3>
            {VOICE_PROVIDERS.map((id) => {
              const unavailable = voice.availability?.[id] === false;
              const active = id === voice.provider;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  disabled={unavailable}
                  onClick={() => (switchable ? voice.switchProvider(id) : void voice.start(id))}
                  className={cn(
                    "pressable flex items-center gap-2.5 rounded-control px-2.5 py-2 text-left",
                    "disabled:pointer-events-none disabled:opacity-40",
                    "motion-reduce:active:scale-100",
                    active ? "bg-accent" : "hover:bg-accent/60"
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    {/* The model is the name, as in ChatGPT's own picker: it
                        is what answers. The active row names what the relay
                        reports serving the call, the others their default. */}
                    <span className="truncate text-ui font-medium text-foreground">
                      {voiceModelLabel(
                        active && voice.model
                          ? voice.model
                          : active && voice.effort
                            ? (voiceEffortPlan(id, voice.effort)?.voiceModel ?? VOICE_PROVIDER_MODELS[id])
                            : VOICE_PROVIDER_MODELS[id]
                      )}
                    </span>
                    <span className="truncate text-micro text-muted-foreground">
                      {unavailable ? "Not configured on this relay" : PROVIDER_BLURB[id]}
                    </span>
                  </span>
                  {active && <StatusIcons.success className="size-3.5 shrink-0 text-primary" />}
                </button>
              );
            })}
          </section>

          {/* The thinking dial, where the provider has one: the composer's own
              effort panel (ReasoningSlider `panel`), not a look-alike. On
              OpenAI a rung is GPT-6.1 Sol's effort; on Gemini it picks the
              Live model and Gemini 3.8 Flash's level together. A live call
              with no delegate fell back to a protocol without one, and a dial
              there would set nothing. */}
          {dial && (
            <section className="border-t border-border p-3">
              <EffortPanelContext.Provider
                value={{ modelName: voiceModelLabel(dial.plan?.delegateModel) ?? "", onOpenModels: focusVoiceList }}
              >
                <ReasoningSlider
                  variant="panel"
                  options={dial.rungs.map((value) => ({ value, label: VOICE_REASONING_EFFORT_LABELS[value] }))}
                  value={dial.value}
                  defaultValue={voice.capabilities?.defaultReasoningEffort}
                  onChange={(next) => {
                    const effort = parseVoiceReasoningEffort(next);
                    if (effort) voice.setEffort(effort);
                  }}
                  disabled={voice.status === "connecting" || reconnecting}
                />
              </EffortPanelContext.Provider>
              {dial.plan && (
                <p className="pt-3 text-center text-micro leading-snug text-muted-foreground">
                  {voiceModelLabel(dial.plan.voiceModel)} answers.{" "}
                  {voiceModelLabel(dial.plan.delegateModel)} takes the harder questions at{" "}
                  {VOICE_REASONING_EFFORT_LABELS[dial.plan.delegateEffort].toLowerCase()} effort
                  {(voice.delegate?.webSearch ?? true) ? " and can search the web" : ""}.
                </p>
              )}
            </section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One control in a call: an icon button the size of the composer's own, a
 * 44px target on every pointer (`voice-target`), with its name in the
 * tooltip and the accessible label. A pressed toggle (muted, sharing) takes
 * the ink fill, so its state reads without its label.
 */
const CallButton = React.forwardRef<
  HTMLButtonElement,
  {
    onClick: () => void;
    label: string;
    /** What the tooltip says, when it should name the next action rather than the control. */
    tooltip?: string;
    disabled?: boolean;
    pressed?: boolean;
    className?: string;
    children: React.ReactNode;
  }
>(function CallButton({ onClick, label, tooltip, disabled, pressed, className, children }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            "pressable voice-target inline-flex size-9 shrink-0 items-center justify-center rounded-full",
            "disabled:pointer-events-none disabled:opacity-40",
            "motion-reduce:active:scale-100 coarse:size-11",
            pressed ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            className
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip ?? label}</TooltipContent>
    </Tooltip>
  );
});
