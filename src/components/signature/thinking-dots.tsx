"use client";

import { cn } from "@/lib/utils";

/**
 * Breathing dot-constellation — the Juno "thinking" signature.
 * Three layered CSS periods per dot (wave 2.1s · tint sweep 3.4s · breathe 5.6s)
 * run out of phase, so the combined motion never reads as a visible loop.
 * Inherits currentColor for the base dots; the tint sweep is always primary.
 */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex items-end gap-dot-gap text-muted-foreground", className)}
      role="status"
      aria-label="Juno is thinking"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        // Breathe wrapper must not be display:inline or its transform is ignored.
        <span key={i} className="flex motion-safe:animate-dot-breathe" style={{ animationDelay: `${i * -1.1}s` }}>
          <span
            className="relative block h-dot w-dot rounded-full bg-current motion-safe:animate-dot-think"
            // All-negative offsets start every dot mid-flight (no dead frame, no
            // opacity pop from waiting at unanimated styles) while keeping the stagger.
            style={{ animationDelay: `${i * 0.14 - 1.12}s` }}
          >
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-full bg-primary opacity-0 motion-safe:animate-dot-tint"
              style={{ animationDelay: `${i * 0.16}s` }}
            />
          </span>
        </span>
      ))}
    </span>
  );
}
