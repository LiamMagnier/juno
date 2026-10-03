"use client";

import * as React from "react";
import { useLiveSeconds } from "@/components/chat/live-line";
import { GenerationField } from "@/components/chat/generated-media";
import {
  DEFAULT_RATIO,
  formatElapsed,
  frameWidth,
  gridWidth,
  outputCount,
  requestedRatio,
} from "@/components/chat/generation-frame";
import { cn } from "@/lib/utils";
import type { MediaModality } from "@/lib/models";

/**
 * Media-generation work surface shown while /api/generate runs
 * (INTERACTION_SPEC M9). The motion spec is at the top of generation.css.
 *
 * The frame is drawn at the ratio the request asked for (`progress.aspect`,
 * stamped when the generation starts; the modality's default otherwise), at
 * the same width the finished picture will take, so the result lands in this
 * box and morphs to its own shape rather than replacing it. Inside: a soft,
 * slowly drifting field, and one quiet line with the truthful stage and real
 * seconds.
 *
 * No preview, because the provider sends no partial image: the field is
 * weather, not a picture of progress. A percentage only when the provider
 * reports one (video), with a determinate hairline under it. No logo, no
 * spinner, no pill.
 */

const STAGE_DETAILS: Record<MediaModality, Record<string, string>> = {
  image: {
    queued: "Preparing",
    generating: "Composing",
    polling: "Refining",
    downloading: "Developing",
    uploading: "Saving",
  },
  video: {
    queued: "Preparing",
    generating: "Composing",
    polling: "Rendering",
    downloading: "Retrieving",
    uploading: "Saving",
  },
  audio: {
    queued: "Preparing",
    generating: "Composing",
    uploading: "Saving",
  },
};

/** What the screen reader hears before the stage word, and when the wait earns a sentence. */
const MODALITY_NAME: Record<MediaModality, string> = { image: "Image", video: "Video", audio: "Music" };
const LONG_WAIT_SECONDS: Record<MediaModality, number> = { image: 20, video: 15, audio: 20 };
const LONG_WAIT_NOTE: Record<MediaModality, string> = {
  image: "Detailed images can take a minute.",
  video: "Longer clips can take a couple of minutes.",
  audio: "A full song can take a minute or two.",
};

/** Title-case fallback for a stage the server grew after this shipped. */
function friendlyLabel(stage: string): string {
  return `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

export function stageDetail(modality: MediaModality, stage: string, pct?: number): string {
  const word = STAGE_DETAILS[modality][stage] ?? friendlyLabel(stage);
  return typeof pct === "number" && Number.isFinite(pct) && pct > 0 && pct < 100 ? `${word} ${Math.round(pct)}%` : word;
}

interface GenerationPlaceholderProps {
  progress: { modality: MediaModality; stage: string; pct?: number; aspect?: string; count?: number };
}

export function GenerationPlaceholder({ progress }: GenerationPlaceholderProps) {
  const { modality, stage, pct } = progress;
  const seconds = useLiveSeconds(true);
  const detail = stageDetail(modality, stage, pct);
  /*
   * Said once the wait is long enough to doubt: renders genuinely can run past
   * a minute, and a reader who is not told that will assume a stall and leave.
   * Per-modality thresholds because the doubt arrives at different times.
   * Inside the frame, so it never moves the thread.
   */
  const longWait = seconds >= LONG_WAIT_SECONDS[modality];
  const hasPct = typeof pct === "number" && Number.isFinite(pct) && pct > 0;
  const count = modality === "image" ? outputCount(progress.count) : 1;
  const ratio = modality === "audio" ? DEFAULT_RATIO.audio : requestedRatio(modality, progress.aspect);

  const line = (
    <div className="gen-stage">
      {/* The line names the work for a screen reader too: the stage word
          alone ("Refining") means nothing spoken. The clock is not read. */}
      <p className="gen-stage__row text-ui">
        <span className="gen-stage__word" role="status" aria-live="polite">
          <span className="sr-only">{MODALITY_NAME[modality]} generation: </span>
          {detail}
        </span>
        {seconds >= 1 && (
          <span className="gen-stage__time font-mono text-caption" aria-hidden="true">
            {formatElapsed(seconds)}
          </span>
        )}
      </p>
      {longWait && <p className="gen-stage__note text-caption motion-safe:animate-fade-in">{LONG_WAIT_NOTE[modality]}</p>}
    </div>
  );

  const progressBar = hasPct ? (
    <div className="gen-progress" aria-hidden="true">
      <span className="gen-progress__fill" style={{ "--gen-pct": Math.min(1, pct / 100) } as React.CSSProperties} />
    </div>
  ) : null;

  if (count > 1) {
    return (
      <div
        className="gen-root relative"
        data-modality={modality}
        data-stage={stage}
        data-phase="loading"
        style={{ width: `${gridWidth(count, ratio)}px`, maxWidth: "100%" }}
      >
        <div className="gen-grid">
          {Array.from({ length: count }, (_, i) => (
            <div key={i} className="gen-frame" style={{ aspectRatio: String(ratio) }}>
              <GenerationField />
            </div>
          ))}
        </div>
        {line}
      </div>
    );
  }

  return (
    <div
      // A definite width capped by the column: a percentage alone collapses
      // in an answer column that sizes to its content.
      className={cn("gen-root gen-frame", modality === "audio" && "h-[104px]")}
      data-modality={modality}
      data-stage={stage}
      data-phase="loading"
      style={modality === "audio" ? { width: "480px", maxWidth: "100%" } : { width: `${frameWidth(modality, ratio)}px`, maxWidth: "100%", aspectRatio: String(ratio) }}
    >
      <GenerationField />
      {line}
      {progressBar}
    </div>
  );
}
