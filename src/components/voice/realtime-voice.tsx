"use client";

import * as React from "react";
import { Mic, MicOff, MonitorUp, MonitorX, MoreHorizontal, PhoneOff, Square } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VoiceMeter } from "@/components/voice/voice-meter";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { PHASE_LABEL, announcementFor, voicePhaseOf, type VoicePhase } from "@/lib/voice-phase";
import { VOICE_PROVIDER_LABELS, VOICE_PROVIDERS } from "@/lib/voice-relay-protocol";
import { cn } from "@/lib/utils";

type VoiceController = ReturnType<typeof useRealtimeVoice>;

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
          className="flex max-w-full items-center gap-2 rounded-full border border-warning/40 bg-warning/10 px-3 py-1 text-caption text-warning-foreground"
        >
          <StatusIcons.warning className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{voice.error}</span>
        </div>
      )}

      <div className="flex max-w-full items-center gap-1 rounded-full border border-border bg-popover p-1.5 shadow-float">
        <div className="flex min-w-0 items-center gap-2.5 pl-2.5 pr-1">
          <VoiceMeter ref={meterRef} phase={phase} />
          <span className="min-w-0 truncate text-ui font-medium text-foreground">{label}</span>
        </div>

        {/* The one live region for the call. */}
        <span role="status" aria-live="polite" className="sr-only">
          {announcement}
        </span>

        <div className="flex items-center gap-1">
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
                <BarButton onClick={voice.interrupt} label="Stop Juno speaking">
                  <Square className="size-3 fill-current" />
                  <span className="hidden sm:inline">Stop</span>
                </BarButton>
              )}

              <BarButton
                onClick={voice.toggleMute}
                disabled={!live}
                pressed={voice.muted}
                label={voice.muted ? "Turn your microphone back on" : "Mute your microphone"}
              >
                {voice.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                <span className="hidden sm:inline">{voice.muted ? "Unmute" : "Mute"}</span>
              </BarButton>
            </>
          )}

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger
                  aria-label="Call options"
                  className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground coarse:size-11"
                >
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Call options</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-56">
              <DropdownMenuLabel className="font-mono text-caption text-muted-foreground">Voice</DropdownMenuLabel>
              {VOICE_PROVIDERS.map((provider) => (
                <DropdownMenuItem
                  key={provider}
                  disabled={voice.availability?.[provider] === false || provider === voice.provider}
                  onSelect={() =>
                    live || voice.status === "connecting" || reconnecting
                      ? voice.switchProvider(provider)
                      : void voice.start(provider)
                  }
                >
                  <span className="flex-1">{VOICE_PROVIDER_LABELS[provider]}</span>
                  {provider === voice.provider && <StatusIcons.success className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              ))}
              {/* Screen share lived in two places at once — an inline button and
                  this row — with different labels and different breakpoints. */}
              {voice.capabilities?.screenInput && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={(event) => {
                      event.preventDefault();
                      if (voice.screenSharing) voice.stopScreenShare();
                      else void voice.startScreenShare();
                    }}
                  >
                    {voice.screenSharing ? <MonitorX className="size-4" /> : <MonitorUp className="size-4" />}
                    <span className="flex-1">{voice.screenSharing ? "Stop sharing screen" : "Share screen"}</span>
                    {voice.screenSharing && <StatusIcons.success className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <BarButton onClick={onClose} label="End the call" tone="danger">
            <PhoneOff className="size-4" />
            <span>End</span>
          </BarButton>
        </div>
      </div>
    </section>
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
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  tone?: "default" | "danger";
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
            "pressable inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-ui font-medium",
            "transition-colors duration-fast ease-out-soft",
            "disabled:pointer-events-none disabled:opacity-40",
            "coarse:h-11",
            pressed
              ? "bg-foreground text-background"
              : tone === "danger"
                ? "text-foreground hover:bg-destructive/10 hover:text-destructive"
                : "text-foreground hover:bg-accent"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
