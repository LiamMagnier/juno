"use client";

import { cn } from "@/lib/utils";

/** Monospace dot-wave that ripples left→right — the Juno "thinking" indicator. */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-end gap-[3px] text-muted-foreground", className)} role="status" aria-label="Juno is thinking">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="h-[5px] w-[5px] rounded-full bg-current motion-safe:animate-dot-wave"
          style={{ animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}
