"use client";

import * as React from "react";
import { Image as ImageIcon, Video } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A compact, determinate media-work surface for assistant messages. Images use
 * a developing print metaphor; video uses a frame strip and moving playhead.
 * Both share the same quiet status/footer system so switching modalities feels
 * related without reducing either process to a generic loading shimmer.
 */

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued…",
  generating: "Generating…",
  polling: "Rendering…",
  downloading: "Downloading…",
  uploading: "Uploading…",
};

const STAGE_DETAILS: Record<"image" | "video", Record<string, string>> = {
  image: {
    queued: "Preparing canvas",
    generating: "Developing image",
    polling: "Refining detail",
    downloading: "Retrieving image",
    uploading: "Saving to chat",
  },
  video: {
    queued: "Preparing timeline",
    generating: "Composing frames",
    polling: "Rendering sequence",
    downloading: "Retrieving video",
    uploading: "Saving to chat",
  },
};

function friendlyLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? `${stage.charAt(0).toUpperCase()}${stage.slice(1)}…`;
}

function stageDetail(modality: "image" | "video", stage: string): string {
  return STAGE_DETAILS[modality][stage] ?? friendlyLabel(stage).replace(/…$/, "");
}

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ImageDevelopment() {
  return (
    <div className="generation-image-stage" aria-hidden="true">
      <div className="generation-image-sheet">
        <span className="generation-image-corner generation-image-corner--tl" />
        <span className="generation-image-corner generation-image-corner--br" />
        <svg className="generation-image-art" viewBox="0 0 180 128" fill="none">
          <circle className="generation-image-art__sun" cx="132" cy="35" r="11" />
          <path className="generation-image-art__far" d="M16 91 54 58l25 22 23-18 62 45" />
          <path className="generation-image-art__near" d="M16 108 65 72l29 24 22-16 48 34" />
          <path className="generation-image-art__horizon" d="M16 109h148" />
        </svg>
        <span className="generation-image-scan" />
      </div>
    </div>
  );
}

function VideoFrames() {
  return (
    <div className="generation-video-stage" aria-hidden="true">
      <div className="generation-video-strip">
        {[0, 1, 2].map((frame) => (
          <span className="generation-video-frame" key={frame}>
            <span className="generation-video-frame__sun" />
            <span className="generation-video-frame__horizon" />
            <span className="generation-video-frame__subject" />
          </span>
        ))}
      </div>
      <div className="generation-video-timeline">
        <div className="generation-video-segments">
          {Array.from({ length: 8 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <span className="generation-video-playhead" />
      </div>
    </div>
  );
}

interface GenerationPlaceholderProps {
  progress: { modality: "image" | "video"; stage: string; pct?: number };
}

export function GenerationPlaceholder({ progress }: GenerationPlaceholderProps) {
  const { modality, stage, pct } = progress;
  const isVideo = modality === "video";
  const Icon = isVideo ? Video : ImageIcon;
  const label = friendlyLabel(stage);
  const detail = stageDetail(modality, stage);

  // Client-side elapsed counter — starts when the placeholder mounts.
  const startRef = React.useRef(Date.now());
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)),
      1000
    );
    return () => window.clearInterval(timer);
  }, []);

  // Stage-label crossfade: retain the outgoing label for one short transition.
  const [previousDetail, setPreviousDetail] = React.useState<string | null>(null);
  const lastDetailRef = React.useRef(detail);
  React.useEffect(() => {
    if (lastDetailRef.current === detail) return;
    setPreviousDetail(lastDetailRef.current);
    lastDetailRef.current = detail;
    const timer = window.setTimeout(() => setPreviousDetail(null), 240);
    return () => window.clearTimeout(timer);
  }, [detail]);

  // Providers may report a fraction or a percentage — normalize to 0..100.
  const displayPct = pct == null ? null : Math.max(0, Math.min(100, pct < 1 ? pct * 100 : pct));
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
        isVideo ? "aspect-video max-w-[480px]" : "aspect-square max-w-[320px]"
      )}
    >
      <div className="generation-placeholder__viewport">
        <div className="generation-placeholder__header" aria-hidden="true">
          <span className="generation-placeholder__kind">
            <Icon className="size-3.5" />
            {isVideo ? "Video" : "Image"}
          </span>
          <span className="generation-placeholder__activity">
            <span />
            {longVideoWait ? "A few minutes" : "Working"}
          </span>
        </div>

        {isVideo ? <VideoFrames /> : <ImageDevelopment />}
      </div>

      <div className="generation-placeholder__footer" aria-hidden="true">
        <div className="generation-progress" data-determinate={displayPct != null ? "true" : "false"}>
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
            {previousDetail && (
              <span className="generation-placeholder__stage-previous">{previousDetail}</span>
            )}
            <span
              key={detail}
              className={cn(
                "generation-placeholder__stage-current",
                previousDetail && "generation-placeholder__stage-current--entering"
              )}
            >
              {detail}
            </span>
          </span>
          <span className="generation-placeholder__metrics">
            {roundedPct != null && <span>{roundedPct}%</span>}
            <span>{formatElapsed(elapsed)}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
