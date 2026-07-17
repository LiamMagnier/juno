"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  RotateCw,
  Square,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VoiceOrb, type OrbStatus } from "@/components/signature/voice-orb";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { VOICE_PROVIDER_LABELS, VOICE_PROVIDERS } from "@/lib/voice-relay-protocol";
import { cn, formatUsd } from "@/lib/utils";

type VoiceController = ReturnType<typeof useRealtimeVoice>;

const controlClass =
  "pressable inline-flex size-9 shrink-0 items-center justify-center rounded-full text-foreground/75 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 coarse:size-10";
const MIC_ON_LABEL = "Turn microphone on";
const MIC_OFF_LABEL = "Turn microphone off";

/**
 * Voice stays a lightweight layer over the normal chat. This dock contains
 * only session controls; transcript, typing, and attachments remain in the
 * standard MessageList and Composer.
 */
export function RealtimeVoice({ voice, onClose }: { voice: VoiceController; onClose: () => void }) {
  const orbStatus: OrbStatus =
    voice.status === "error"
      ? "error"
      : voice.status === "connecting" || voice.status === "reconnecting"
        ? "thinking"
        : voice.status !== "live" || voice.muted
          ? "idle"
          : voice.assistantSpeaking
            ? "speaking"
            : "listening";

  const statusLabel =
    voice.status === "connecting"
      ? "Connecting"
      : voice.status === "reconnecting"
        ? "Reconnecting…"
        : voice.status === "error"
          ? "Voice unavailable"
          : voice.status === "ended"
            ? "Session ended"
            : voice.assistantSpeaking
              ? "Juno is speaking"
              : voice.muted
                ? "Microphone off"
                : "Listening";

  const restartable = voice.status === "ended" || voice.status === "error";

  // Relay list prices, not billing: always an estimate, hence the "~".
  const usage = voice.usage;
  const costLabel = usage && usage.estCostUsd > 0 ? `~${formatUsd(usage.estCostUsd)}` : null;
  const costTitle =
    usage && usage.estCostInUsd != null && usage.estCostOutUsd != null
      ? `Estimated session cost · you ~${formatUsd(usage.estCostInUsd)} · Juno ~${formatUsd(usage.estCostOutUsd)}`
      : "Estimated session cost";

  return (
    <section
      aria-label="Voice conversation controls"
      className="relative z-20 mx-auto mb-2 flex w-full flex-col items-center gap-1.5 px-2 motion-safe:animate-rise-in sm:px-0"
    >
      {/* Failures speak, they don't hide in a tooltip: the message names the
          fix, and the restart control sits right below it. */}
      {voice.status === "error" && voice.error && (
        <p
          role="alert"
          className="max-w-md rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-center text-xs leading-snug text-foreground shadow-soft"
        >
          {voice.error}
        </p>
      )}
      <div className="flex max-w-full items-center gap-0.5 rounded-full border border-border bg-popover/95 p-1 shadow-[0_1px_2px_hsl(var(--foreground)/0.1),0_10px_28px_-20px_hsl(var(--foreground)/0.55)] backdrop-blur-lg supports-[backdrop-filter]:bg-popover/88">
        <div className="flex min-w-0 items-center gap-2 pl-0.5 pr-1.5">
          <VoiceOrb status={orbStatus} levelRef={voice.levelRef} className="size-9" />
          {/* Stacked inside the orb's height so the cost line cannot grow the pill.
              No aria-live on the cost: it reprices every 5s and would talk over
              the conversation it is measuring. */}
          <div className="flex w-[5.75rem] flex-col justify-center gap-0.5 max-[350px]:hidden sm:w-[7.5rem]">
            <p
              aria-live="polite"
              className="truncate text-sm font-semibold leading-4 text-foreground"
              title={voice.error ?? statusLabel}
            >
              {statusLabel}
            </p>
            {costLabel && (
              <span className="truncate font-mono text-caption text-muted-foreground/60" title={costTitle}>
                {costLabel}
              </span>
            )}
          </div>
        </div>

        {restartable ? (
          <button
            type="button"
            onClick={() => void voice.start()}
            aria-label="Restart voice"
            className={cn(controlClass, "bg-foreground text-background hover:bg-foreground/90 hover:text-background")}
          >
            <RotateCw className="size-4" />
          </button>
        ) : (
          <>
            {voice.assistantSpeaking && voice.status === "live" && (
              <button
                type="button"
                onClick={voice.interrupt}
                aria-label="Interrupt Juno"
                className={cn(controlClass, "bg-foreground text-background hover:bg-foreground/90 hover:text-background")}
              >
                <Square className="size-3 fill-current" />
              </button>
            )}
            <button
              type="button"
              onClick={voice.toggleMute}
              disabled={voice.status !== "live"}
              aria-label={voice.muted ? MIC_ON_LABEL : MIC_OFF_LABEL}
              aria-pressed={voice.muted}
              className={cn(
                controlClass,
                "bg-muted/65",
                voice.muted && "bg-foreground text-background hover:bg-foreground/90 hover:text-background"
              )}
            >
              {voice.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
          </>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Voice options" className={cn(controlClass, "bg-muted/45")}>
            <ChevronDown className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" sideOffset={10} className="w-56">
            <DropdownMenuLabel>Voice model</DropdownMenuLabel>
            {VOICE_PROVIDERS.map((provider) => (
              <DropdownMenuItem
                key={provider}
                disabled={voice.availability?.[provider] === false || (voice.status === "live" && provider === voice.provider)}
                onSelect={() => (voice.status === "live" ? voice.switchProvider(provider) : void voice.start(provider))}
              >
                <span className="flex-1">{VOICE_PROVIDER_LABELS[provider]}</span>
                {provider === voice.provider && <Check className="size-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
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
                  {voice.screenSharing ? <MonitorX /> : <MonitorUp />}
                  <span className="flex-1">{voice.screenSharing ? "Stop sharing screen" : "Share screen"}</span>
                  {voice.screenSharing && <Check className="size-3.5 text-primary" />}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={onClose}
          aria-label="End voice conversation"
          className={cn(
            controlClass,
            "bg-destructive text-destructive-foreground hover:bg-destructive/90 hover:text-destructive-foreground"
          )}
        >
          <PhoneOff className="size-4" />
        </button>
      </div>
    </section>
  );
}
