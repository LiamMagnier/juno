"use client";

import * as React from "react";
import { Captions, CaptionsOff, ChevronDown, Mic, MicOff, MonitorUp, MonitorX, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { VoiceOrb, type OrbStatus } from "@/components/signature/voice-orb";
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { VOICE_PROVIDER_LABELS, VOICE_PROVIDERS, type VoiceProviderId } from "@/lib/voice-relay-protocol";
import { cn } from "@/lib/utils";

/**
 * Full-screen realtime voice conversation (relay-backed, true speech-to-speech
 * where the provider supports it). Distinct from the legacy VoiceMode
 * (STT -> chat -> TTS): this one streams audio both ways continuously.
 */
export function RealtimeVoice({ onClose, defaultProvider }: { onClose: () => void; defaultProvider?: VoiceProviderId }) {
  const voice = useRealtimeVoice({ defaultProvider });
  const [captionsOn, setCaptionsOn] = React.useState(true);
  const startedRef = React.useRef(false);

  React.useEffect(() => {
    if (!startedRef.current) {
      startedRef.current = true;
      void voice.start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    voice.end();
    onClose();
  };

  const orbStatus: OrbStatus =
    voice.status === "error"
      ? "error"
      : voice.status === "connecting"
        ? "thinking"
        : voice.assistantSpeaking
          ? "speaking"
          : "listening";

  const lastUser = [...voice.transcript].reverse().find((l) => l.role === "user");
  const lastAssistant = [...voice.transcript].reverse().find((l) => l.role === "assistant");

  const statusLabel =
    voice.status === "connecting"
      ? "Connecting…"
      : voice.status === "error"
        ? (voice.error ?? "Something went wrong")
        : voice.status === "ended"
          ? voice.closedReason === "session-limit"
            ? "Session limit reached"
            : "Session ended"
          : voice.assistantSpeaking
            ? "Speaking…"
            : voice.muted
              ? "Muted"
              : "Listening…";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground motion-safe:animate-[fade-in_360ms_var(--ease-out-expo)_both]">
      {/* Top bar */}
      <div className="flex items-center justify-between px-5 pt-5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCaptionsOn((c) => !c)}
            aria-label={captionsOn ? "Hide captions" : "Show captions"}
            className="pressable inline-flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {captionsOn ? <Captions className="h-4.5 w-4.5" /> : <CaptionsOff className="h-4.5 w-4.5" />}
          </button>
          {voice.capabilities?.videoInput && (
            <button
              type="button"
              onClick={() => (voice.screenSharing ? voice.stopScreenShare() : void voice.startScreenShare())}
              aria-label={voice.screenSharing ? "Stop screen share" : "Share your screen"}
              className={cn(
                "pressable inline-flex h-9 w-9 items-center justify-center rounded-full hover:bg-accent",
                voice.screenSharing ? "text-primary" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {voice.screenSharing ? <MonitorX className="h-4.5 w-4.5" /> : <MonitorUp className="h-4.5 w-4.5" />}
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          {voice.usage && voice.usage.estCostUsd > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">~${voice.usage.estCostUsd.toFixed(3)}</span>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger className="pressable inline-flex h-9 items-center gap-1.5 rounded-full border border-border/60 px-3.5 text-sm text-foreground hover:bg-accent">
              {VOICE_PROVIDER_LABELS[voice.provider]}
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Voice provider</DropdownMenuLabel>
              {VOICE_PROVIDERS.map((p) => (
                <DropdownMenuItem key={p} onSelect={() => voice.switchProvider(p)} disabled={voice.status !== "live"}>
                  {VOICE_PROVIDER_LABELS[p]}
                  {p === voice.provider && <span className="ml-auto text-xs text-muted-foreground">Active</span>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Orb */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-8 px-6">
        <button
          type="button"
          onClick={voice.interrupt}
          aria-label="Interrupt Juno"
          className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <VoiceOrb status={orbStatus} levelRef={voice.levelRef} className="h-52 w-52 sm:h-64 sm:w-64" />
        </button>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {statusLabel}
        </p>
        {voice.status === "ended" && (
          <button
            type="button"
            onClick={() => void voice.start()}
            className="pressable rounded-full border border-border/60 px-4 py-2 text-sm hover:bg-accent"
          >
            Start again
          </button>
        )}
      </div>

      {/* Captions */}
      {captionsOn && (lastUser || lastAssistant || voice.speechInterim) && (
        <div className="mx-auto w-full max-w-xl space-y-1.5 px-6 pb-4">
          {(lastUser || voice.speechInterim) && (
            <p className="truncate text-center text-sm text-muted-foreground">
              {lastUser?.text || voice.speechInterim}
            </p>
          )}
          {lastAssistant && <p className="line-clamp-2 text-center text-sm text-foreground">{lastAssistant.text}</p>}
        </div>
      )}

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-8 pb-8">
        <button
          type="button"
          onClick={voice.toggleMute}
          aria-label={voice.muted ? "Unmute microphone" : "Mute microphone"}
          className={cn(
            "pressable inline-flex h-13 w-13 items-center justify-center rounded-full border",
            voice.muted
              ? "border-destructive/50 bg-destructive/10 text-destructive"
              : "border-border/60 text-foreground hover:bg-accent"
          )}
        >
          {voice.muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={close}
          aria-label="End voice conversation"
          className="pressable inline-flex h-13 w-13 items-center justify-center rounded-full bg-destructive text-destructive-foreground hover:opacity-90"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
}
