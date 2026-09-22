"use client";

import * as React from "react";
import { Mic, MicOff, MonitorUp, MonitorX, PhoneOff, Settings2, Square } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VoiceMeter } from "@/components/voice/voice-meter";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { PHASE_LABEL, announcementFor, voicePhaseOf, type VoicePhase } from "@/lib/voice-phase";
import {
  VOICE_PROVIDER_LABELS,
  VOICE_PROVIDERS,
  type VoiceProviderId,
} from "@/lib/voice-relay-protocol";
import { cn } from "@/lib/utils";

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
 * The voice call bar.
 *
 * WHY IT IS STILL A BAR. Both of the products this is measured against
 * retired their full-screen voice mode: ChatGPT moved voice into the chat
 * window in November 2025 and left the orb behind a setting, and Gemini
 * dismantled its dedicated Live screen through 2026 in favour of an inline,
 * collapsible layer. A takeover destroys the context the conversation is
 * about, and shipping one in 2026 would be shipping the thing both of them
 * just removed. So voice stays a mode of the conversation, and the work went
 * into making that bar tell the truth.
 *
 * WHAT IT TELLS YOU NOW. The bar used to say "Listening…" from the moment the
 * socket opened until the call ended, beside three bars at hardcoded heights
 * that never read the audio. There was no way to see that you had been heard,
 * that an answer was being composed, that a mid-call error had already killed
 * the session, or which reconnect attempt was in flight. Muted, idle and a
 * dead session were the same grey dot. `interrupt()` existed on the hook and
 * no button called it, while the label instructed you to "Speak to interrupt".
 *
 * Now the phase drives everything (`src/lib/voice-phase.ts`): the meter reads
 * the real level, the thinking gap has its own state, Stop appears exactly
 * while there is speech to stop, mute is struck through rather than dimmed,
 * and every change is announced to assistive technology — which matters more
 * here than anywhere else in the product, because this is the one mode
 * designed to be used without looking at the screen.
 *
 * The live cost meter is gone. It rendered four decimal places and ticked
 * upward mid-sentence, which made a conversation feel like a taxi ride; usage
 * is still recorded and still shown where spending belongs.
 */
export function RealtimeVoice({ voice, onClose }: { voice: VoiceController; onClose: () => void }) {
  const phase: VoicePhase = voicePhaseOf(voice);

  const meterRef = React.useRef<HTMLSpanElement | null>(null);
  const levelRef = voice.levelRef;

  // One rAF loop for the whole bar, writing one custom property. The level
  // never enters React state: at 60fps that would re-render the bar and every
  // control in it sixty times a second to move five bars.
  React.useEffect(() => {
    let raf = 0;
    const tick = () => {
      meterRef.current?.style.setProperty("--level", levelRef.current.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [levelRef]);

  // Announce phase changes. A voice mode is used without looking at it, and
  // the old bar announced nothing at all — the indicator was aria-hidden and
  // the status sat in a plain span.
  const [announcement, setAnnouncement] = React.useState("");
  const prevPhase = React.useRef<VoicePhase | null>(null);
  React.useEffect(() => {
    const next = announcementFor(phase, prevPhase.current);
    prevPhase.current = phase;
    if (next) setAnnouncement(next);
  }, [phase]);

  const live = voice.status === "live";
  const restartable = voice.status === "ended" || voice.status === "error";
  const reconnecting = voice.status === "reconnecting";
  const label = reconnecting && voice.reconnectAttempt > 0
    ? `Reconnecting · attempt ${voice.reconnectAttempt}`
    : PHASE_LABEL[phase];
  // Named only once the relay has confirmed a session; before that there is
  // nothing true to say, and a provider name shown while connecting to it is
  // a claim the call has not earned yet.
  const subtitle =
    live && voice.model
      ? `${VOICE_PROVIDER_LABELS[voice.provider]} · ${voice.model}`
      : live
        ? VOICE_PROVIDER_LABELS[voice.provider]
        : null;

  return (
    <section
      aria-label="Voice call"
      className="relative z-toolbar mx-auto mb-3 flex w-full flex-col items-center gap-2 px-2 motion-safe:animate-fade-in sm:px-0"
    >
      {/* Errors render whenever there is one, not only in one status. A relay
          failure mid-call used to set a message that nothing displayed. */}
      {voice.error && (
        <div
          role="alert"
          className="flex max-w-full items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-caption text-warning-foreground motion-safe:animate-rise-in"
        >
          <StatusIcons.warning className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{voice.error}</span>
        </div>
      )}

      {/* A notice is not a failure: the call is up and usable, it just came up
          some way other than the one that was asked for. Muted rather than
          warning-coloured, and not an alert — nothing here needs acting on. */}
      {!voice.error && voice.notice && (
        <div
          role="status"
          className="flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/60 px-3 py-1 text-caption text-muted-foreground motion-safe:animate-rise-in"
        >
          <StatusIcons.info className="size-3.5 shrink-0" />
          <span className="min-w-0">{voice.notice}</span>
        </div>
      )}

      <div
        className={cn(
          "flex w-full max-w-[min(100%,34rem)] items-center gap-1 rounded-full border border-border",
          "bg-popover p-1.5 shadow-float sm:w-auto"
        )}
      >
        {/* The status cluster OWNS the flexible width and everything else is
            shrink-0, so a long phase label truncates instead of pushing End
            off a narrow screen — which is what used to happen, because every
            child was equally willing to shrink. */}
        <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-2.5 pr-1 sm:flex-initial">
          <VoiceMeter ref={meterRef} phase={phase} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-ui font-medium text-foreground">{label}</span>
            {/* Which model is actually answering. It was knowable only from a
                relay log before, so a call that had quietly fallen back to
                another protocol looked identical to one that had not. */}
            {subtitle && (
              <span className="truncate text-micro text-muted-foreground">{subtitle}</span>
            )}
          </span>
        </div>

        {/* The one live region for the call. */}
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          {restartable ? (
            <BarButton onClick={() => void voice.start()} label="Try the call again">
              <ActionIcons.refresh className="size-4" />
              <span>Retry</span>
            </BarButton>
          ) : (
            <>
              {/* Stop exists exactly while there is speech to stop. `interrupt`
                  was on the hook from the start with no caller: on a device
                  where echo cancellation is off, or where the detector misses,
                  a caller had no way to halt a monologue while the label told
                  them to talk over it. */}
              {voice.assistantSpeaking && (
                <BarButton
                  onClick={voice.interrupt}
                  label="Stop Juno speaking"
                  // It arrives with the speech it stops, so it fades in rather
                  // than landing in the bar in one frame.
                  className="motion-safe:animate-fade-in"
                >
                  <Square className="size-3 fill-current" />
                  <span className="hidden md:inline">Stop</span>
                </BarButton>
              )}

              <BarButton
                onClick={voice.toggleMute}
                disabled={!live}
                pressed={voice.muted}
                label={voice.muted ? "Turn your microphone back on" : "Mute your microphone"}
              >
                <SwapGlyph on={voice.muted} onGlyph={<MicOff className="size-4" />} offGlyph={<Mic className="size-4" />} />
                <span className="hidden md:inline">{voice.muted ? "Unmute" : "Mute"}</span>
              </BarButton>

              {/* Screen share is a thing you DO mid-call, so it is a control,
                  not a settings row. It spent a release buried three items
                  deep in a menu that also held provider choice, where the one
                  action you might want mid-sentence was the hardest to reach. */}
              {voice.capabilities?.screenInput && live && (
                <BarButton
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
                  <span className="hidden md:inline">{voice.screenSharing ? "Sharing" : "Share"}</span>
                </BarButton>
              )}
            </>
          )}

          <VoiceSettings voice={voice} />

          {/* A hairline before End. It is the only irreversible control here,
              and grouping it with the toggles made it one more identical pill
              to mis-tap on a phone. */}
          <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border" />

          <BarButton onClick={onClose} label="End the call" tone="danger">
            <PhoneOff className="size-4" />
            <span className="hidden sm:inline">End</span>
          </BarButton>
        </div>
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
            <Settings2 className="size-4" />
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
 * One control on the bar.
 *
 * Every control is the same height and the same shape, and a disabled one
 * looks disabled — the old Mute was `disabled` during connect with no
 * disabled styling at all, so for the first seconds of every call it was
 * pixel-identical to a working button.
 */
function BarButton({
  onClick,
  label,
  disabled,
  pressed,
  tone = "default",
  className,
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  tone?: "default" | "danger";
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
            // `.pressable` owns the timing: colour on --dur-fast, the dip on
            // --dur-press. The `transition-colors` that used to sit here
            // replaced its list, so every control on the bar pressed untimed.
            "pressable inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-ui font-medium",
            "disabled:pointer-events-none disabled:opacity-40",
            "motion-reduce:active:scale-100 coarse:h-11",
            pressed
              ? "bg-foreground text-background"
              : tone === "danger"
                ? "text-foreground hover:bg-destructive/10 hover:text-destructive"
                : "text-foreground hover:bg-accent",
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
