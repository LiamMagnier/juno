"use client";

import { cn } from "@/lib/utils";

/**
 * Juno's live-work signature.
 *
 * The old constellation bounced, breathed and changed colour at the same time.
 * At transcript scale that read as five unrelated loaders competing for
 * attention. This version keeps one useful gesture: emphasis travels across a
 * stable baseline. Scale + opacity carry the motion, so surrounding text never
 * appears to wobble and reduced-motion users get the same complete mark.
 */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-dot-gap text-muted-foreground", className)}
      role="status"
      aria-label="Juno is thinking"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="relative block h-dot w-dot rounded-full bg-current opacity-35 motion-safe:animate-dot-think"
          // Negative offsets make the mark feel alive on its first painted
          // frame; the stagger moves left-to-right without a waiting state.
          style={{ animationDelay: `${i * 0.16 - 1.28}s` }}
        >
          <span
            aria-hidden="true"
            className="absolute inset-0 rounded-full bg-primary opacity-0 motion-safe:animate-dot-tint"
            style={{ animationDelay: `${i * 0.16 - 1.28}s` }}
          />
        </span>
      ))}
    </span>
  );
}
