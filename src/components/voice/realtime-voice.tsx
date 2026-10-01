"use client";

import * as React from "react";
import { CallEnd, CallMic, CallMicOff, CallSettings, CallStop, MonitorUp, MonitorX } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { announcementFor, voicePhaseOf, type VoicePhase } from "@/lib/voice-phase";
import {
  VOICE_PROVIDER_LABELS,
  VOICE_PROVIDERS,
  type VoiceProviderId,
} from "@/lib/voice-relay-protocol";
import { cn } from "@/lib/utils";
import type { VoiceGlowTone } from "@/components/effects/use-effect-theme";
import { JunoVoiceGlow } from "@/components/voice/voice-composer-glow";
import { PRODUCT_NAME } from "@/lib/brand/names";

type VoiceController = ReturnType<typeof useRealtimeVoice>;

/**
 * One line per provider, describing the trade it makes.
 *
 * Kept to what the relay's own registry says each one can do
 * (relay/src/providers/registry.ts) rather than to marketing: these decide a
 * call, so a wrong word here costs someone a conversation.
 */
const PROVIDER_BLURB: Record<VoiceProviderId, string> = {
  openai: "Full duplex · reasoning runs on a backend model",
  gemini: "Lowest latency · screen sharing · reasoning mode",
  qwen: "Long calls · sees images and your screen",
  minimax: "Speech pipeline · no vision, no screen",
  mock: "Developer stand-in · no provider is called",
};

/**
 * THE VOICE CALL, AS PARTS OF THE COMPOSER.
 *
 * Voice is a mode of the conversation, not a place (ChatGPT and Gemini both
 * retired their takeover screens for the same reason), so a call no longer
 * stacks a second floating bar on top of the composer. The composer itself
 * becomes the call: its left side says what the call is doing, its right side
 * holds the controls, and its primary button ends the call (or sends, when
 * something has been typed). Chat mounts the parts into the composer's slots
 * (`voiceCall` on <Composer>); surfaces without a composer of their own still
 * use <RealtimeVoice>, the same parts in one quiet bar.
 *
 * What the call says is still the phase (`src/lib/voice-phase.ts`): the meter
 * reads the real level, Stop exists exactly while there is speech to stop,
 * mute is struck through, and every change is announced, because this is the
 * one mode designed to be used without looking at the screen.
 *
 * No glow, no page wash. The ambient aura that tinted the whole column during
 * a call and the light along the old bar's edge made the screen look busy
 * without saying anything the label and the meter do not.
 */

export interface VoiceCallParts {
  /** Left of the composer: the level meter and the phase, plus the live region. */
  status: React.ReactNode;
  /** Right of the composer: Stop, Mute, Share, call settings. */
  controls: React.ReactNode;
  /** The composer's primary slot while the draft is empty. */
  end: React.ReactNode;
  /** The live level (0-1) of whoever is talking, read once per frame by the glow. */
  level: () => number;
  /**
   * The audio of whoever holds the floor, when there is one to hear: your
   * microphone while you talk, Juno's output AS IT PLAYS while Juno talks.
   * The glow analyses it in low / mid / high bands, so its lobes move with
   * the syllables rather than a single volume. Wins over `level` when set.
   */
  stream: MediaStream | null;
  /** Gain on the analysed stream: Juno's output is hotter than a microphone. */
  sensitivity?: number;
  /** The gap after you stop, while the reply is thought through. */
  processing: boolean;
  /** No call up (connecting, ended, muted): the glow holds still. */
  paused: boolean;
  /** Whose light: warm while you talk, cool while Juno talks, both while it thinks. */
  tone: VoiceGlowTone;
}

/** The glow's light for a phase: the call's state, told in colour. */
function toneFor(phase: VoicePhase): VoiceGlowTone {
  switch (phase) {
    case "speaking":
      return "juno";
    case "thinking":
      return "thinking";
    case "listening":
    case "user-speaking":
      return "you";
    default:
      return "muted";
  }
}

/** Juno's voice arrives mastered, near full scale; a room microphone doesn't. */
const OUTPUT_SENSITIVITY = 2.2;

/** Whose audio the glow should listen to in a phase, if any. */
function streamFor(
  phase: VoicePhase,
  streams: { mic: MediaStream | null; output: MediaStream | null }
): MediaStream | null {
  switch (phase) {
    case "speaking":
      return streams.output;
    case "listening":
    case "user-speaking":
      return streams.mic;
    default:
      // Thinking gathers into a beam, muted holds a low grey: neither is
      // driven by audio.
      return null;
  }
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
  const phase = voicePhaseOf(voice);
  const levelRef = voice.levelRef;
  return {
    // Muted: a low, even grey band, visibly on and visibly quiet, rather than
    // a frozen frame of whatever was said last.
    level: phase === "muted" ? () => 0.12 : () => levelRef.current,
    stream: streamFor(phase, voice.audioStreams),
    sensitivity: phase === "speaking" ? OUTPUT_SENSITIVITY : undefined,
    processing: phase === "thinking",
    paused: phase === "idle" || phase === "connecting" || phase === "error",
    tone: toneFor(phase),
    status: <VoiceCallStatus voice={voice} speakerName={speakerName} />,
    controls: <VoiceCallControls voice={voice} speakerName={speakerName} />,
    end: <VoiceCallEnd onClose={onClose} />,
  };
}

function speakerOf(voice: VoiceController, speakerName?: string) {
  return voice.persona && speakerName ? speakerName : PRODUCT_NAME;
}

/**
 * What the call is doing, for assistive technology only. On screen the glow
 * is the state (warm while you talk, cool while Juno talks, a travelling beam
 * while it thinks, still grey when muted); no meter or status line competes
 * with it. A voice mode is used without looking at the screen, so every phase
 * change is still announced, and which provider and model are answering is
 * said once the call is up.
 */
export function VoiceCallStatus({ voice, speakerName }: { voice: VoiceController; speakerName?: string }) {
  const phase: VoicePhase = voicePhaseOf(voice);
  const speaker = speakerOf(voice, speakerName);
  const [announcement, setAnnouncement] = React.useState("");
  const prevPhase = React.useRef<VoicePhase | null>(null);
  React.useEffect(() => {
    const next = announcementFor(phase, prevPhase.current, speaker);
    prevPhase.current = phase;
    if (next) setAnnouncement(next);
  }, [phase, speaker]);

  const live = voice.status === "live";
  const detail = live
    ? [VOICE_PROVIDER_LABELS[voice.provider], voice.model, voice.memory ? "remembers you" : null]
        .filter(Boolean)
        .join(", ")
    : null;

  return (
    <span role="status" aria-live="polite" className="sr-only">
      {announcement}
      {detail ? ` ${detail}.` : null}
    </span>
  );
}

/** The verbs of a call, as the composer's icon buttons. */
export function VoiceCallControls({ voice, speakerName }: { voice: VoiceController; speakerName?: string }) {
  const live = voice.status === "live";
  const restartable = voice.status === "ended" || voice.status === "error";
  const speaker = speakerOf(voice, speakerName);

  return (
    <div className="voice-call-controls flex shrink-0 items-center gap-0.5">
      {restartable ? (
        <CallButton onClick={() => void voice.retry()} label="Try the call again">
          <ActionIcons.refresh className="size-4" />
        </CallButton>
      ) : (
        <>
          {voice.assistantSpeaking && (
            <CallButton onClick={voice.interrupt} label={`Stop ${speaker} speaking`} className="motion-safe:animate-fade-in">
              <CallStop className="size-4" />
            </CallButton>
          )}
          <CallButton
            onClick={voice.toggleMute}
            disabled={!live}
            pressed={voice.muted}
            label={voice.muted ? "Turn your microphone back on" : "Mute your microphone"}
          >
            <SwapGlyph on={voice.muted} onGlyph={<CallMicOff className="size-[18px]" />} offGlyph={<CallMic className="size-[18px]" />} />
          </CallButton>
          {voice.capabilities?.screenInput && live && (
            <CallButton
              onClick={() => {
                if (voice.screenSharing) voice.stopScreenShare();
                else void voice.startScreenShare();
              }}
              pressed={voice.screenSharing}
              label={voice.screenSharing ? "Stop sharing your screen" : "Share your screen"}
            >
              <SwapGlyph
                on={voice.screenSharing}
                onGlyph={<MonitorX className="size-4" />}
                offGlyph={<MonitorUp className="size-4" />}
              />
            </CallButton>
          )}
        </>
      )}
      <VoiceSettings voice={voice} />
    </div>
  );
}

/**
 * End, in the composer's primary slot: the same size and place as Send, so
 * the hand already knows where it is, and the only coloured control in a call.
 */
export function VoiceCallEnd({ onClose }: { onClose: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClose}
          aria-label="End the call"
          className={cn(
            "pressable inline-flex size-9 shrink-0 items-center justify-center rounded-full",
            "bg-destructive text-destructive-foreground shadow-sm hover:brightness-[1.06]",
            "motion-reduce:active:scale-100 coarse:size-11"
          )}
        >
          <CallEnd className="size-5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>End call</TooltipContent>
    </Tooltip>
  );
}

/**
 * A call's error or notice, as one plain line above the composer: colour and
 * a glyph where it needs acting on, muted where it does not. No pill.
 */
export function VoiceCallNotices({ voice }: { voice: VoiceController }) {
  if (voice.error) {
    return (
      <p role="alert" className="mb-2 flex items-center justify-center gap-1.5 px-3 text-caption text-destructive-ink motion-safe:animate-fade-in">
        <StatusIcons.warning className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{voice.error}</span>
      </p>
    );
  }
  if (voice.notice) {
    return (
      <p role="status" className="mb-2 flex items-center justify-center gap-1.5 px-3 text-caption text-muted-foreground motion-safe:animate-fade-in">
        <StatusIcons.info className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{voice.notice}</span>
      </p>
    );
  }
  return null;
}

/**
 * The call for surfaces with no composer of their own (Code's voice briefing,
 * Work): the same parts in one quiet bar, on the popover material, with no
 * glow along its edge.
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
      <JunoVoiceGlow
        stream={parts.stream}
        sensitivity={parts.sensitivity}
        level={parts.level}
        processing={parts.processing}
        paused={parts.paused}
        tone={parts.tone}
        className="relative rounded-full"
      >
        <div className="voice-glow-host flex items-center gap-1 rounded-full border border-border bg-popover p-1.5 shadow-float">
          {parts.status}
          {parts.controls}
          {parts.end}
        </div>
      </JunoVoiceGlow>
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
  const live = voice.status === "live";
  const reconnecting = voice.status === "reconnecting";
  const switchable = live || voice.status === "connecting" || reconnecting;

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger
            aria-label="Call settings"
            className={cn(
              // `.pressable` times the colour cross-fade and the dip itself;
              // a transition-* utility beside it would replace that list and
              // leave the press untimed.
              "pressable inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground",
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

      <PopoverContent align="end" side="top" sideOffset={10} className="w-[min(20rem,calc(100vw-1.5rem))] p-0">
        <div className="flex flex-col">
          {/* The rows are radios, so their section is the group that names
              them — a `role="radio"` with no radiogroup is announced as a
              choice between nothing. */}
          <section role="radiogroup" aria-labelledby={voiceHeadingId} className="flex flex-col gap-0.5 p-2">
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
                    <span className="truncate text-ui font-medium text-foreground">
                      {VOICE_PROVIDER_LABELS[id]}
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

          {/* Only where there is a choice to make. A row that cannot change
              anything is furniture, and this one carries a cost warning that
              would be a lie on a provider with no reasoning mode. */}
          {voice.capabilities?.thinkingChoice && (
            <section className="border-t border-border p-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-control px-2.5 py-2 transition-colors duration-fast ease-out-soft hover:bg-accent/60">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
                  <span className="text-ui font-medium text-foreground">Reasoning</span>
                  <span className="text-micro text-muted-foreground">
                    {voice.thinking
                      ? "Thinks before answering, and narrates while it does. Slower, and more per minute."
                      : "Answers at conversational speed."}
                  </span>
                  {voice.model && (
                    <span className="truncate pt-0.5 font-mono text-micro text-muted-foreground/70">
                      {voice.model}
                    </span>
                  )}
                </span>
                <Switch
                  checked={voice.thinking}
                  onCheckedChange={(next) => voice.setThinking(next)}
                  aria-label="Reasoning"
                  className="mt-0.5 shrink-0"
                />
              </label>
            </section>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One control in a call: an icon button the size of the composer's own, with
 * its name in the tooltip and the accessible label. A pressed toggle (muted,
 * sharing) takes the ink fill, so its state reads without its label.
 */
function CallButton({
  onClick,
  label,
  disabled,
  pressed,
  className,
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(
            "pressable inline-flex size-9 shrink-0 items-center justify-center rounded-full",
            "disabled:pointer-events-none disabled:opacity-40",
            "motion-reduce:active:scale-100 coarse:size-11",
            pressed ? "bg-foreground text-background" : "text-muted-foreground hover:bg-accent hover:text-foreground",
            className
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Two glyphs for one control's two states, cross-faded in one grid cell.
 *
 * Mute ⇄ unmute and share ⇄ stop sharing used to swap drawings in a single
 * frame. They trade opacity and a small scale on `--dur-fast` now
 * (ICONS_AND_MOTION.md §2.2.7), so the control is seen to change state rather
 * than to be replaced. The fade rides wrappers: a glyph's own transition list
 * belongs to its hover articulation. Reduced motion keeps the fade.
 */
function SwapGlyph({ on, onGlyph, offGlyph }: { on: boolean; onGlyph: React.ReactNode; offGlyph: React.ReactNode }) {
  const face =
    "col-start-1 row-start-1 grid place-items-center transition-[opacity,transform] duration-fast ease-out-soft motion-reduce:transition-opacity";
  return (
    <span aria-hidden="true" className="grid place-items-center">
      <span className={cn(face, on ? "scale-75 opacity-0" : "opacity-100")}>{offGlyph}</span>
      <span className={cn(face, on ? "opacity-100" : "scale-75 opacity-0")}>{onGlyph}</span>
    </span>
  );
}
