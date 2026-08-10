"use client";

import * as React from "react";
import { ImageGenerationCanvas } from "@/components/aicss/image-generation";
import { ThinkingState } from "@/components/aicss/thinking-state";
import { cn } from "@/lib/utils";

/**
 * Media-generation work surface shown while /api/generate runs.
 *
 * AIcss's "Image Generation", in AIcss's own composition: the canvas, then the
 * label under it. Nothing else.
 *
 * WHAT WAS DELETED, AND WHY IT WAS ALL ONE MISTAKE. The block used to be a card
 * — border, shadow, 1.75rem radius — with a bordered footer strip carrying a
 * progress bar, a percentage and an mm:ss clock. Five chrome elements around one
 * unfinished picture:
 *
 *   - The clock counted up while nobody could act on the number. It made a
 *     20-second wait feel measured and a 60-second wait feel broken.
 *   - The percentage was fiction on every provider that reports no progress: the
 *     bar ran an indeterminate sweep that looks exactly like a determinate one.
 *   - The footer's own border cut the card in two, so the thing being made was
 *     the smaller half of its own container.
 *
 * The canvas is now the whole object, and the one moving thing on screen is the
 * label that says what is happening. The dot lattice is already Juno's mark, so
 * the placeholder looks like the app rather than like a loading state.
 */

const STAGE_DETAILS: Record<"image" | "video", Record<string, string>> = {
  image: {
    queued: "Preparing",
    generating: "Creating image",
    polling: "Refining",
    downloading: "Retrieving",
    uploading: "Saving",
  },
  video: {
    queued: "Preparing",
    generating: "Creating video",
    polling: "Rendering",
    downloading: "Retrieving",
    uploading: "Saving",
  },
};

/** Title-case fallback for a stage the server grew after this shipped. */
function friendlyLabel(stage: string): string {
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

function stageDetail(modality: "image" | "video", stage: string): string {
  return STAGE_DETAILS[modality][stage] ?? friendlyLabel(stage);
}

interface GenerationPlaceholderProps {
  progress: { modality: "image" | "video"; stage: string; pct?: number };
}

export function GenerationPlaceholder({ progress }: GenerationPlaceholderProps) {
  const { modality, stage } = progress;
  const isVideo = modality === "video";
  const detail = stageDetail(modality, stage);

  /*
   * The one number kept, and it is not a clock: video renders genuinely can run
   * past a minute, and a reader who is not told that will assume a stall and
   * leave. It appears only once the wait is already long enough to doubt, so it
   * reads as reassurance rather than as a warning printed in advance.
   */
  const [longWait, setLongWait] = React.useState(false);
  React.useEffect(() => {
    if (!isVideo) return;
    const timer = window.setTimeout(() => setLongWait(true), 15_000);
    return () => window.clearTimeout(timer);
  }, [isVideo]);

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${isVideo ? "Video" : "Image"} generation in progress — ${detail}`}
      data-modality={modality}
      data-stage={stage}
      className={cn("w-full", isVideo ? "max-w-[min(100%,440px)]" : "max-w-[min(100%,288px)]")}
    >
      <div className={cn("relative overflow-hidden rounded-field", isVideo ? "aspect-video" : "aspect-square")}>
        {/* The lattice opens up from AIcss's 11px: their canvas is 208px, and a
            pitch tuned for that reads as a texture rather than a field here. */}
        <ImageGenerationCanvas className="absolute inset-0" pitch={14} />
        {isVideo && (
          <div className="generation-media__play">
            <svg viewBox="0 0 24 24" fill="currentColor" className="generation-media__play-icon">
              <path d="M9 7.5v9l7.5-4.5L9 7.5z" />
            </svg>
          </div>
        )}
      </div>

      <div className="mt-2.5 flex flex-col gap-0.5" aria-hidden="true">
        {/* Keyed on the stage so a change fades rather than swapping under the
            shine — one element, so the two animations cannot collide. */}
        <ThinkingState key={detail} tone="strong" className="text-[0.875rem] motion-safe:animate-fade-in">
          {detail}
        </ThinkingState>
        {longWait && (
          <span className="text-body text-muted-foreground motion-safe:animate-fade-in">
            Longer clips can take a couple of minutes.
          </span>
        )}
      </div>
    </div>
  );
}
