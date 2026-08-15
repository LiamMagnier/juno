"use client";

import * as React from "react";
import {
  ChevronDown,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  Square,
} from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { VOICE_PROVIDER_LABELS, VOICE_PROVIDERS } from "@/lib/voice-relay-protocol";
import { cn, formatUsd } from "@/lib/utils";

type VoiceController = ReturnType<typeof useRealtimeVoice>;

/**
 * Premium Realtime Voice Bar inspired by modern Dynamic Island & ChatGPT Voice.
 *
 * Lightweight, elegant floating pill with ambient waveform indicator,
 * seamless provider selection, tactile mute toggles, and graceful fallback handling.
 */
export function RealtimeVoice({ voice, onClose }: { voice: VoiceController; onClose: () => void }) {
  const statusLabel =
    voice.status === "connecting"
      ? "Connecting…"
      : voice.status === "reconnecting"
        ? "Reconnecting…"
        : voice.status === "error"
          ? "Voice Unavailable"
          : voice.status === "ended"
            ? "Session Ended"
            : voice.assistantSpeaking
              ? "Juno is speaking"
              : voice.muted
                ? "Muted"
                : "Listening…";

  const restartable = voice.status === "ended" || voice.status === "error";
  const usage = voice.usage;
  const costLabel = usage && usage.estCostUsd > 0 ? `~${formatUsd(usage.estCostUsd)}` : null;

  return (
    <section
      aria-label="Voice conversation controls"
      className="relative z-30 mx-auto mb-3 flex w-full flex-col items-center gap-2 px-2 motion-safe:animate-fade-in sm:px-0"
    >
      {/* Alert toast for errors, sleek & non-intrusive */}
      {voice.status === "error" && voice.error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-full border border-border/80 bg-secondary/90 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-md"
        >
          <span className="size-1.5 rounded-full bg-amber-500" />
          <span>{voice.error}</span>
        </div>
      )}

      {/* Floating Dynamic Voice Pill */}
      <div className="flex max-w-full items-center gap-1.5 rounded-full border border-border/80 bg-popover/90 p-1.5 shadow-xl backdrop-blur-xl transition-all duration-base">
        {/* Live Orb & Status Info */}
        <div className="flex min-w-0 items-center gap-2.5 pl-3 pr-2">
          <div className="relative flex size-3 items-center justify-center">
            <span
              className={cn(
                "absolute size-full rounded-full opacity-75 transition-colors duration-fast",
                voice.status === "live" && !voice.muted
                  ? "bg-primary animate-ping"
                  : voice.status === "error"
                    ? "bg-amber-500/50"
                    : "bg-muted-foreground/30"
              )}
            />
            <span
              className={cn(
                "relative size-2 rounded-full transition-colors duration-fast",
                voice.status === "live" && !voice.muted
                  ? "bg-primary shadow-xs shadow-primary"
                  : voice.status === "error"
                    ? "bg-amber-500"
                    : "bg-muted-foreground"
              )}
            />
          </div>

          <div className="flex flex-col justify-center">
            <span className="truncate text-xs font-semibold tracking-tight text-foreground">
              {statusLabel}
            </span>
            <span className="truncate font-mono text-micro text-muted-foreground">
              {VOICE_PROVIDER_LABELS[voice.provider]} {costLabel ? `· ${costLabel}` : ""}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1">
          {restartable ? (
            <button
              type="button"
              onClick={() => void voice.start()}
              aria-label="Retry connection"
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-foreground px-3 text-xs font-medium text-background transition-all hover:bg-foreground/90 active:scale-95"
            >
              <ActionIcons.refresh className="size-3.5" />
              <span>Retry</span>
            </button>
          ) : (
            <>
              {voice.assistantSpeaking && voice.status === "live" && (
                <button
                  type="button"
                  onClick={voice.interrupt}
                  aria-label="Interrupt speech"
                  className="inline-flex h-8 items-center gap-1 rounded-full bg-secondary px-2.5 text-xs font-medium text-foreground transition-all hover:bg-accent active:scale-95"
                >
                  <Square className="size-3 fill-current" />
                  <span className="hidden sm:inline">Interrupt</span>
                </button>
              )}

              <button
                type="button"
                onClick={voice.toggleMute}
                disabled={voice.status !== "live"}
                aria-label={voice.muted ? "Unmute mic" : "Mute mic"}
                aria-pressed={voice.muted}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-all active:scale-95",
                  voice.muted
                    ? "bg-foreground text-background shadow-xs"
                    : "bg-secondary text-foreground hover:bg-accent"
                )}
              >
                {voice.muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                <span className="hidden sm:inline">{voice.muted ? "Unmute" : "Mute"}</span>
              </button>
            </>
          )}

          {/* Provider / Settings Dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Voice settings"
              className="inline-flex size-8 items-center justify-center rounded-full bg-secondary text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-95"
            >
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-56 rounded-menu p-1 shadow-xl">
              <DropdownMenuLabel className="font-mono text-micro uppercase text-muted-foreground">Voice Engine</DropdownMenuLabel>
              {VOICE_PROVIDERS.map((provider) => (
                <DropdownMenuItem
                  key={provider}
                  disabled={voice.availability?.[provider] === false || (voice.status === "live" && provider === voice.provider)}
                  onSelect={() => (voice.status === "live" ? voice.switchProvider(provider) : void voice.start(provider))}
                  className="rounded-control text-xs font-medium"
                >
                  <span className="flex-1">{VOICE_PROVIDER_LABELS[provider]}</span>
                  {provider === voice.provider && <StatusIcons.success className="size-3.5 text-primary" />}
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
                    className="rounded-control text-xs font-medium"
                  >
                    {voice.screenSharing ? <MonitorX className="size-3.5" /> : <MonitorUp className="size-3.5" />}
                    <span className="flex-1">{voice.screenSharing ? "Stop Screen Share" : "Share Screen"}</span>
                    {voice.screenSharing && <StatusIcons.success className="size-3.5 text-primary" />}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* End Call Button */}
          <button
            type="button"
            onClick={onClose}
            aria-label="End voice session"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-border/80 bg-secondary/80 px-3 text-xs font-medium text-foreground transition-all hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive active:scale-95"
          >
            <PhoneOff className="size-3.5" />
            <span>End</span>
          </button>
        </div>
      </div>
    </section>
  );
}
