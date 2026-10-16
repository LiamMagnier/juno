"use client";

import { Check, Hand, XCircle } from "@/components/ui/icons";
import { useShellString } from "@/components/ui/use-shell-string";
import { cn } from "@/lib/utils";
import { GalaxyMark, type GalaxyPriority } from "./galaxy-mark";

/**
 * THE STATUS VOCABULARY (spec §3.4, D3, D4), one component on the web.
 *
 *   running   the galaxy (a still frame unless it holds an animation slot), presence ink
 *   needsYou  the hand, signal ink; pulses once when it arrives
 *   ready     the check, foreground ink
 *   blocked   circle-x, destructive ink
 *
 * Sizes 10 (rows), 12 (lines and plan rows) and 14 (the live line). The
 * `badge` variant is a 10px hand on a 16px signal-wash disc: never a
 * colour-only dot (D4). Every mark carries its word for assistive tech
 * ("Running", "Needs you", "Ready", "Blocked", from the shared table), or
 * `showWord` prints it beside the glyph.
 *
 * It reads ONLY the role tokens (`--status-*`, brand.css), so a sign-off that
 * remaps a role (S1) changes the mapping in globals.css and nothing here.
 */

export type Status = "running" | "needsYou" | "ready" | "blocked";
export type StatusMarkSize = 10 | 12 | 14;

const WORD_KEY = {
  running: "status.running",
  needsYou: "status.needsYou",
  ready: "status.ready",
  blocked: "status.blocked",
} as const;

export interface StatusMarkProps {
  status: Status;
  size?: StatusMarkSize;
  variant?: "mark" | "badge";
  /** Print the word beside the glyph instead of only for assistive tech. */
  showWord?: boolean;
  /** needsYou: it just arrived, so the hand cross-fades in and pulses once. */
  arrived?: boolean;
  /** running: the galaxy's claim on an animation slot (`live` for the live line). */
  priority?: GalaxyPriority;
  className?: string;
}

export function StatusMark({ status, size = 12, variant = "mark", showWord = false, arrived = false, priority, className }: StatusMarkProps) {
  const t = useShellString();
  const word = t(WORD_KEY[status]);
  const badge = variant === "badge";
  const glyphSize = badge ? 10 : size;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} data-status-word={word}>
      <span
        className="alevr-status-mark"
        data-status={badge ? "needsYou" : status}
        data-variant={variant}
        data-size={glyphSize}
        data-arrived={arrived && (badge || status === "needsYou") ? "" : undefined}
        style={badge ? undefined : { width: size, height: size }}
        aria-hidden="true"
      >
        {badge ? <Hand size={10} /> : <StatusGlyph status={status} size={size} priority={priority} />}
      </span>
      {showWord ? <span className="text-label">{word}</span> : <span className="sr-only">{word}</span>}
    </span>
  );
}

function StatusGlyph({ status, size, priority }: { status: Status; size: number; priority?: GalaxyPriority }) {
  switch (status) {
    case "running":
      return <GalaxyMark phase="working" size={size} priority={priority} />;
    case "needsYou":
      return <Hand size={size} />;
    case "ready":
      return <Check size={size} />;
    case "blocked":
      return <XCircle size={size} />;
  }
}
