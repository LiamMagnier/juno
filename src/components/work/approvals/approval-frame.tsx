"use client";

import * as React from "react";
import type { Payload } from "@/components/work/work-payload";
import { cn } from "@/lib/utils";

/*
 * The screen an approval is about, with the spot marked.
 *
 * A cloud computer approval used to read "Click at (640, 400) on example.com"
 * and nothing else: a decision about a pixel nobody could see, asked every
 * time, which is how people learn to press the button without reading. The
 * Mac has always shown a crop of the screen with the target ringed
 * (StudioScreenActionCard); this is the same card for the web. The runner
 * keeps the frame it saw just before asking (`detail.frame`) and the point the
 * action lands on (`detail.point`); a click is shown zoomed in around its
 * point, and typing or a key press — which act on whatever has focus — show
 * the whole screen.
 *
 * The frame is served by the owner-only frames route and nothing else: any
 * other address in the detail is ignored, so an approval cannot be made to
 * load an image from somewhere else.
 */

export interface ApprovalFrameRef {
  src: string;
  width: number;
  height: number;
}

const FRAME_SRC = /^\/api\/work\/runs\/[A-Za-z0-9_%-]{1,200}\/frames\/[A-Za-z0-9_-]{1,128}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** `detail.frame`, when it names a frame this card may load. */
export function readApprovalFrame(detail: Payload): ApprovalFrameRef | null {
  const frame = record(detail.frame);
  const src = frame?.src;
  const width = positive(frame?.width);
  const height = positive(frame?.height);
  if (typeof src !== "string" || !FRAME_SRC.test(src) || width === null || height === null) return null;
  return { src, width, height };
}

/** `detail.point`, in the frame's pixels. */
export function readApprovalPoint(detail: Payload): { x: number; y: number } | null {
  const point = record(detail.point);
  const x = point?.x;
  const y = point?.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.max(0, x), y: Math.max(0, y) };
}

/**
 * The part of the frame to show and where the marker sits in it, as
 * percentages. Around a point: a window `1/zoom` of the frame, centred on the
 * point and kept inside the frame. Without one: the whole frame, no marker.
 */
export function approvalCrop(
  frame: { width: number; height: number },
  point: { x: number; y: number } | null,
  zoom = 2,
): {
  image: { width: string; left: string; top: string };
  marker: { left: string; top: string } | null;
  aspect: string;
} {
  if (point === null || zoom <= 1) {
    return { image: { width: "100%", left: "0%", top: "0%" }, marker: null, aspect: `${frame.width} / ${frame.height}` };
  }
  const cropWidth = frame.width / zoom;
  const cropHeight = frame.height / zoom;
  const px = Math.min(frame.width, point.x);
  const py = Math.min(frame.height, point.y);
  const x = Math.max(0, Math.min(frame.width - cropWidth, px - cropWidth / 2));
  const y = Math.max(0, Math.min(frame.height - cropHeight, py - cropHeight / 2));
  const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
  return {
    image: { width: pct(frame.width / cropWidth), left: pct(-x / cropWidth), top: pct(-y / cropHeight) },
    marker: { left: pct((px - x) / cropWidth), top: pct((py - y) / cropHeight) },
    aspect: `${frame.width} / ${frame.height}`,
  };
}

export function ApprovalFrame({
  frame,
  point,
  className,
}: {
  frame: ApprovalFrameRef;
  point: { x: number; y: number } | null;
  className?: string;
}) {
  const [broken, setBroken] = React.useState(false);
  const crop = approvalCrop(frame, point);

  if (broken) {
    return <p className={cn("text-ui text-muted-foreground", className)}>Screenshot unavailable</p>;
  }

  return (
    <figure className={cn("m-0 max-w-[360px]", className)}>
      <div
        className="relative overflow-hidden rounded-card border border-border/60 bg-muted/40"
        style={{ aspectRatio: crop.aspect }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a private, owner-only frame */}
        <img
          src={frame.src}
          alt={
            crop.marker
              ? "The screen where this will happen, with the spot ringed"
              : "The screen as it was before this step"
          }
          referrerPolicy="no-referrer"
          draggable={false}
          onError={() => setBroken(true)}
          className="absolute max-w-none select-none"
          style={{ width: crop.image.width, left: crop.image.left, top: crop.image.top }}
        />
        {crop.marker && (
          <span
            aria-hidden
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
            style={crop.marker}
          >
            {/* The filmstrip's ring, a size up and in full ink: this is the
                spot being asked about. No motion — it is read, not watched. */}
            <span className="block size-8 rounded-full border-2 border-foreground shadow-[0_0_0_3px_hsl(var(--background)/0.7)]" />
          </span>
        )}
      </div>
    </figure>
  );
}
