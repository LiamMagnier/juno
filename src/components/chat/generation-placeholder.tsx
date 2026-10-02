"use client";

import * as React from "react";
import { Play } from "@/components/ui/icons";
import { LiveLine, useLiveSeconds } from "@/components/chat/live-line";
import { cn } from "@/lib/utils";

/**
 * Media-generation work surface shown while /api/generate runs
 * (INTERACTION_SPEC M9).
 *
 * The box is reserved at the shape the result will take, on the quiet tone a
 * card sits on, so nothing reflows when the picture lands. Inside it, the live
 * line every working row in the transcript uses (live-line.tsx): the Continuum
 * mark beside the truthful stage ("Creating image") and real seconds. No dot
 * lattice, no pixel mosaic, no shimmer: the old lattice was the retired mark,
 * and a mosaic that "reveals" an image the provider has not sent is a picture
 * of progress rather than progress.
 *
 * Still no percentage and no bar: most providers report no progress, and an
 * indeterminate sweep looks exactly like a determinate one.
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
  const seconds = useLiveSeconds(true);

  /*
   * Said once the wait is long enough to doubt: renders genuinely can run past
   * a minute, and a reader who is not told that will assume a stall and leave.
   * Per-modality thresholds because the doubt arrives at different times: a
   * video is expected to take a while, an image is not.
   */
  const longWait = seconds >= (isVideo ? 15 : 20);

  return (
    <div
      data-modality={modality}
      data-stage={stage}
      className={cn("w-full", isVideo ? "max-w-[min(100%,440px)]" : "max-w-[min(100%,288px)]")}
    >
      <div
        className={cn(
          "relative flex flex-col justify-end overflow-hidden rounded-field bg-muted p-3",
          isVideo ? "aspect-video" : "aspect-square"
        )}
      >
        {isVideo && (
          // The set's play mark in its house weight: it says "this will be a
          // video", not "playing". The class draws the disc around it.
          <div className="generation-media__play" aria-hidden="true">
            <Play className="generation-media__play-icon" motion="none" />
          </div>
        )}
        {/* The line names the work for a screen reader too: the stage word
            alone ("Refining") means nothing spoken. */}
        <span className="sr-only">{isVideo ? "Video" : "Image"} generation: </span>
        <LiveLine text={detail} phase="working" seconds={seconds} immediate />
      </div>
      {longWait && (
        <p className="mt-2 text-ui text-muted-foreground motion-safe:animate-fade-in" role="status">
          {isVideo ? "Longer clips can take a couple of minutes." : "Still working. Detailed images can take a minute."}
        </p>
      )}
    </div>
  );
}
