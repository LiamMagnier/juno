"use client";

import { cn } from "@/lib/utils";

// Clockwise around the perimeter, then through the centre. The staggered
// overlays overlap slightly, leaving a soft trail rather than nine hard blinks.
const MATRIX_SEQUENCE = [0, 1, 2, 5, 8, 7, 6, 3, 4];

/**
 * Compact 3×3 thinking matrix. Nine quiet points establish the mark while one
 * darker point and its faint trail travel through the grid. Reduced motion
 * leaves the centre point emphasized without changing the footprint.
 */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span
      className={cn("relative inline-grid h-[18px] w-[18px] shrink-0 grid-cols-3 gap-[3px] text-muted-foreground", className)}
      aria-hidden="true"
    >
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((gridIndex) => {
        const sequenceIndex = MATRIX_SEQUENCE.indexOf(gridIndex);
        return (
          <span key={gridIndex} className="relative block h-1 w-1">
            <span className="absolute inset-0 rounded-full bg-current opacity-25" />
            <span
              className={cn(
                "absolute inset-0 rounded-full bg-foreground opacity-0 motion-safe:animate-thinking-matrix",
                gridIndex === 4 ? "motion-reduce:opacity-90" : "motion-reduce:opacity-0"
              )}
              // Start mid-cycle so the matrix is already alive on first paint.
              style={{ animationDelay: `${sequenceIndex * 0.2 - 1.8}s` }}
            />
          </span>
        );
      })}
    </span>
  );
}
