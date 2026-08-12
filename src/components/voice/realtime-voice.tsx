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
import { useRealtimeVoice } from "@/hooks/use-realtime-voice";
import { VOICE_PROVIDER_LABELS, VOICE_PROVIDERS } from "@/lib/voice-relay-protocol";
import { cn, formatUsd } from "@/lib/utils";

type VoiceController = ReturnType<typeof useRealtimeVoice>;

const controlClass =
  "pressable inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-control px-2.5 text-xs font-medium text-foreground/75 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 coarse:h-10";
const MIC_ON_LABEL = "Turn microphone on";
const MIC_OFF_LABEL = "Turn microphone off";

/**
 * Voice stays a lightweight layer over the normal chat. This dock contains
 * only session controls; transcript, typing, and attachments remain in the
 * standard MessageList and Composer.
 *
 * The state of the conversation is reported by ``VoiceAura`` — the waves in the
 * chat column behind the composer — rather than by a glyph inside this pill.
 * The dock kept the words (what is happening, what it costs) and gave up the
 * picture: an orb small enough to sit in a toolbar can only ever be decoration,
 * while the same signal spread across the column is legible from across the
 * room and asks for none of your attention to read. The aura itself is mounted
 * by ChatView, because it has to be a sibling of the composer to sit behind it.
 */
export function RealtimeVoice({ voice, onClose }: { voice: VoiceController; onClose: () => void }) {
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
      className="relative z-20 mx-auto mb-2 flex w-full flex-col items-center gap-1.5 px-2 motion-safe:animate-fade-in sm:px-0"
    >
      {/* Failures speak, they don't hide in a tooltip: the message names the
          fix, and the restart control sits right below it. */}
      {voice.status === "error" && voice.error && (
        <p
          role="alert"
          className="max-w-md rounded-field border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-center text-xs leading-snug text-foreground motion-safe:animate-fade-in"
        >
          {voice.error}
        </p>
      )}
      {/* `overlay-glass` rather than the hand-rolled border + bg-popover + shadow-none
          this carried. The dock floats over the transcript, and `shadow-none` was
          deleting the one elevation cue it had: on dark the rim light in
          --shadow-glass is the only thing that separates a floating pill from the
          column behind it, and the utility beat any shadow the class could set. */}
      <div className="overlay-glass flex max-w-full items-center gap-1 rounded-card p-1.5">
        {/* Hidden whole on the narrowest phones rather than emptied: with the
            orb gone this wrapper holds only the words, and keeping its padding
            around nothing left a visible dent in the pill. */}
        <div className="flex min-w-0 items-center gap-2 pl-2 pr-1.5 max-[350px]:hidden">
          {/* Held to the control row's height (h-9, matching the buttons beside
              it) so the cost line cannot grow the pill. No aria-live on the
              cost: it reprices every 5s and would talk over the conversation it
              is measuring. */}
          <span
            aria-hidden
            className={cn(
              // The live state gets the product's one breathing curve, so a session that
              // is actually listening is distinguishable from one that has stalled.
              "size-2 shrink-0 rounded-full",
              voice.status === "live"
                ? "bg-success motion-safe:animate-status-glow"
                : voice.status === "error"
                  ? "bg-destructive"
                  : "bg-warning"
            )}
          />
          <div className="flex h-9 w-[6.5rem] flex-col justify-center gap-0.5 sm:w-[8.5rem]">
            <p aria-live="polite" className="truncate text-sm font-semibold leading-4 text-foreground" title={voice.error ?? statusLabel}>
              {statusLabel}
            </p>
            <span className="truncate text-caption text-muted-foreground" title={costLabel ? costTitle : undefined}>
              {VOICE_PROVIDER_LABELS[voice.provider]}{costLabel ? ` · ${costLabel}` : ""}
            </span>
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
            <span className="hidden sm:inline">Retry</span>
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
                <span className="hidden sm:inline">Interrupt</span>
              </button>
            )}
            <button
              type="button"
              onClick={voice.toggleMute}
              disabled={voice.status !== "live"}
              aria-label={voice.muted ? MIC_ON_LABEL : MIC_OFF_LABEL}
              aria-pressed={voice.muted}
              // No resting fill. --muted is 9.5% and the dock is a 13% popover
              // rung, so `bg-muted/65` painted a patch DARKER than the pill it
              // sits in and left nothing for `hover:bg-muted` to move to. Mute
              // state is already carried by aria-pressed and the foreground fill
              // below; the unpressed control is a quiet one like the rest.
              className={cn(
                controlClass,
                voice.muted && "bg-foreground text-background hover:bg-foreground/90 hover:text-background"
              )}
            >
              {voice.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
              <span className="hidden sm:inline">{voice.muted ? "Unmute" : "Mute"}</span>
            </button>
          </>
        )}

        <DropdownMenu>
          {/* Same fix as the mute button: `bg-muted/45` marked no state at all,
              it just made the two quiet controls in one row disagree — /65 and
              /45 being two different answers to the same question. */}
          <DropdownMenuTrigger aria-label="Voice options" className={cn(controlClass, "w-9 px-0")}>
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
            "bg-destructive/10 text-destructive hover:bg-destructive hover:text-destructive-foreground"
          )}
        >
          <PhoneOff className="size-4" />
          <span className="hidden sm:inline">End</span>
        </button>
      </div>
    </section>
  );
}
