"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  MoreHorizontal,
  PhoneOff,
  RotateCw,
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
import { cn } from "@/lib/utils";

type VoiceController = ReturnType<typeof useRealtimeVoice>;

/**
 * A compact, chat-native voice dock. The conversation itself stays in the
 * normal MessageList and the normal composer remains the only typing/upload
 * surface, so voice never becomes a separate full-screen product.
 */
export function RealtimeVoice({ voice, onClose }: { voice: VoiceController; onClose: () => void }) {
  const orbStatus: OrbStatus =
    voice.status === "error"
      ? "error"
      : voice.status === "connecting"
        ? "thinking"
        : voice.status !== "live" || voice.muted
          ? "idle"
          : voice.assistantSpeaking
            ? "speaking"
            : "listening";

  const statusLabel =
    voice.status === "connecting"
      ? "Connecting"
      : voice.status === "error"
        ? "Voice unavailable"
        : voice.status === "ended"
          ? "Session ended"
          : voice.assistantSpeaking
            ? "Juno is speaking"
            : voice.muted
              ? "Microphone off"
              : "Listening";

  const orbAction = () => {
    if (voice.assistantSpeaking) voice.interrupt();
    else if (voice.status === "live") voice.toggleMute();
    else if (voice.status === "ended" || voice.status === "error") void voice.start();
  };
  const orbActionLabel =
    voice.assistantSpeaking
      ? "Interrupt Juno"
      : voice.status === "live"
        ? voice.muted
          ? "Turn microphone on"
          : "Turn microphone off"
        : voice.status === "ended" || voice.status === "error"
          ? "Restart voice"
          : statusLabel;

  return (
    <section
      aria-label="Voice conversation controls"
      className="relative z-20 mx-auto mb-2 flex w-full justify-center px-2 motion-safe:animate-rise-in sm:px-0"
    >
      <div className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-background/90 p-1.5 shadow-[0_14px_42px_-18px_hsl(var(--foreground)/0.32)] ring-1 ring-white/5 backdrop-blur-2xl supports-[backdrop-filter]:bg-background/78">
        <button
          type="button"
          onClick={orbAction}
          disabled={voice.status === "connecting"}
          aria-label={orbActionLabel}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-full outline-none transition-transform duration-fast hover:scale-[1.04] active:scale-95 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait coarse:size-12"
        >
          <VoiceOrb status={orbStatus} levelRef={voice.levelRef} className="size-11 coarse:size-12" />
        </button>

        <div className="min-w-0 w-[7.75rem] px-1.5 sm:w-[9.25rem]">
          <p aria-live="polite" className="flex items-center gap-2 truncate text-sm font-medium leading-5">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                voice.status === "live"
                  ? voice.muted
                    ? "bg-muted-foreground/55"
                    : "bg-success shadow-[0_0_0_3px_hsl(var(--success)/0.12)]"
                  : voice.status === "error"
                    ? "bg-destructive"
                    : "bg-warning motion-safe:animate-pulse"
              )}
            />
            <span className="truncate">{voice.error ?? statusLabel}</span>
          </p>
          <p className="truncate pl-3.5 text-[11px] leading-4 text-muted-foreground">
            {VOICE_PROVIDER_LABELS[voice.provider]}
            {voice.usage && voice.usage.estCostUsd > 0 ? ` · ~$${voice.usage.estCostUsd.toFixed(3)}` : " · realtime"}
          </p>
        </div>

        <span aria-hidden className="mx-0.5 h-7 w-px shrink-0 bg-border/70" />

        {(voice.status === "ended" || voice.status === "error") ? (
          <button
            type="button"
            onClick={() => void voice.start()}
            aria-label="Restart voice"
            className="pressable inline-flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground coarse:size-11"
          >
            <RotateCw className="size-4" />
          </button>
        ) : (
          <>
            {voice.capabilities?.screenInput && (
              <button
                type="button"
                onClick={() => (voice.screenSharing ? voice.stopScreenShare() : void voice.startScreenShare())}
                aria-label={voice.screenSharing ? "Stop sharing screen" : "Share screen with Juno"}
                aria-pressed={voice.screenSharing}
                className={cn(
                  "pressable hidden size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground md:inline-flex coarse:size-11",
                  voice.screenSharing && "bg-primary/10 text-primary"
                )}
              >
                {voice.screenSharing ? <MonitorX className="size-4" /> : <MonitorUp className="size-4" />}
              </button>
            )}

            <button
              type="button"
              onClick={voice.toggleMute}
              disabled={voice.status !== "live"}
              aria-label={voice.muted ? "Turn microphone on" : "Turn microphone off"}
              aria-pressed={voice.muted}
              className={cn(
                "pressable inline-flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-45 coarse:size-11",
                voice.muted && "bg-foreground text-background hover:bg-foreground/90 hover:text-background"
              )}
            >
              {voice.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            </button>
          </>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Voice options"
            className="pressable inline-flex size-10 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring coarse:size-11 sm:w-auto sm:gap-1 sm:px-3"
          >
            <MoreHorizontal className="size-4 sm:hidden" />
            <span className="hidden max-w-20 truncate text-xs sm:inline">{VOICE_PROVIDER_LABELS[voice.provider]}</span>
            <ChevronDown className="hidden size-3 sm:block" />
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
          className="pressable inline-flex size-10 items-center justify-center rounded-full bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground coarse:size-11"
        >
          <PhoneOff className="size-4" />
        </button>
      </div>
    </section>
  );
}
