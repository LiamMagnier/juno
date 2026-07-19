"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Media-generation work surface shown while /api/generate runs.
 *
 * ChatGPT / Gemini style: a soft ambient field + smooth shimmer band over a
 * clean aspect-ratio card. Status lives in a quiet footer (stage, %, elapsed).
 * No sketch metaphors — the object being made is suggested by shape only
 * (square for image, 16:9 for video).
 */

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  generating: "Generating",
  polling: "Rendering",
  downloading: "Downloading",
  uploading: "Uploading",
};

const STAGE_DETAILS: Record<"image" | "video", Record<string, string>> = {
  image: {
    queued: "Preparing…",
    generating: "Creating image…",
    polling: "Refining…",
    downloading: "Retrieving…",
    uploading: "Saving…",
  },
  video: {
    queued: "Preparing…",
    generating: "Creating video…",
    polling: "Rendering…",
    downloading: "Retrieving…",
    uploading: "Saving…",
  },
};

function friendlyLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`;
}

function stageDetail(modality: "image" | "video", stage: string): string {
  return STAGE_DETAILS[modality][stage] ?? `${friendlyLabel(stage)}…`;
}

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function normalizeProgress(pct?: number): number | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  // Bare `1` is ambiguous: prefer fractional completion (1 === complete).
  const normalized = pct >= 0 && pct <= 1 ? pct * 100 : pct;
  return Math.max(0, Math.min(100, normalized));
}

/** Soft ambient field + continuous shimmer — shared by image and video. */
function MediaShimmer({ modality }: { modality: "image" | "video" }) {
  return (
    <div className="generation-media" data-modality={modality} aria-hidden="true">
      <div className="generation-media__field">
        <span className="generation-media__orb generation-media__orb--a" />
        <span className="generation-media__orb generation-media__orb--b" />
        <span className="generation-media__orb generation-media__orb--c" />
        <span className="generation-media__sheen" />
        <span className="generation-media__pulse" />
      </div>
      {modality === "video" && (
        <div className="generation-media__play">
          <svg viewBox="0 0 24 24" fill="currentColor" className="generation-media__play-icon">
            <path d="M9 7.5v9l7.5-4.5L9 7.5z" />
          </svg>
        </div>
      )}
    </div>
  );
}

interface GenerationPlaceholderProps {
  progress: { modality: "image" | "video"; stage: string; pct?: number };
}

export function GenerationPlaceholder({ progress }: GenerationPlaceholderProps) {
  const { modality, stage, pct } = progress;
  const isVideo = modality === "video";
  const label = friendlyLabel(stage);
  const detail = stageDetail(modality, stage);

  const startRef = React.useRef(Date.now());
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, []);

  const [stageTransition, setStageTransition] = React.useState<{
    current: string;
    previous: string | null;
  }>(() => ({ current: detail, previous: null }));
  React.useEffect(() => {
    setStageTransition((current) =>
      current.current === detail
        ? current
        : { current: detail, previous: current.current }
    );
    const timer = window.setTimeout(
      () => setStageTransition((current) => ({ ...current, previous: null })),
      280
    );
    return () => window.clearTimeout(timer);
  }, [detail]);

  const displayPct = normalizeProgress(pct);
  const roundedPct = displayPct == null ? null : Math.round(displayPct);
  const ariaProgress = roundedPct == null ? "" : `, ${roundedPct} percent`;
  const longVideoWait = isVideo && elapsed >= 15;
  const ariaWait = longVideoWait ? ". Longer clips can take a couple of minutes." : "";

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label={`${isVideo ? "Video" : "Image"} generation in progress — ${label}${ariaProgress}${ariaWait}`}
      data-modality={modality}
      data-stage={stage}
      className={cn(
        "generation-placeholder w-full",
        isVideo ? "max-w-[min(100%,480px)]" : "max-w-[min(100%,360px)]"
      )}
    >
      <div className="generation-placeholder__viewport">
        <MediaShimmer modality={modality} />
      </div>

      <div className="generation-placeholder__footer" aria-hidden="true">
        <div
          className="generation-progress"
          data-determinate={displayPct != null ? "true" : "false"}
        >
          {displayPct != null ? (
            <span
              className="generation-progress__value"
              style={{ transform: `scaleX(${displayPct / 100})` }}
            />
          ) : (
            <span className="generation-progress__indeterminate" />
          )}
        </div>
        <div className="generation-placeholder__status-row">
          <span className="generation-placeholder__stage">
            {stageTransition.previous && (
              <span className="generation-placeholder__stage-previous">
                {stageTransition.previous}
              </span>
            )}
            <span
              key={stageTransition.current}
              className={cn(
                "generation-placeholder__stage-current",
                stageTransition.previous && "generation-placeholder__stage-current--entering"
              )}
            >
              {stageTransition.current}
            </span>
          </span>
          <span className="generation-placeholder__metrics">
            {longVideoWait && <span className="generation-placeholder__hint">May take a minute</span>}
            {roundedPct != null && <span>{roundedPct}%</span>}
            <span>{formatElapsed(elapsed)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
