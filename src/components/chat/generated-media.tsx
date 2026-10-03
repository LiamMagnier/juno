"use client";

import * as React from "react";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { ImageOff, Video as VideoIcon } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { usePrefersReducedMotion } from "@/components/effects/use-effect-theme";
import { cn } from "@/lib/utils";
import type { ClientAttachment, ClientMessage } from "@/types/chat";
import {
  EXPO,
  MORPH_MS,
  REVEAL_MS,
  TILE_STAGGER_MS,
  clampRatio,
  frameWidth,
  gridWidth,
  outputCount,
  requestedRatio,
  type GenerationModality,
} from "@/components/chat/generation-frame";

/*
 * GENERATED MEDIA IN THE TRANSCRIPT: how a picture or clip that was just made
 * arrives, and how one from history sits. The motion spec is at the top of
 * generation.css; the numbers are in generation-frame.ts.
 *
 * Phases, on the root's [data-phase]:
 *   loading    the frame holds the field (still for history, alive for a
 *              fresh result) while the browser fetches and decodes
 *   revealing  fresh only: blur → top-down resolve, frame morphs to the
 *              picture's real ratio
 *   shown      the picture, at its own ratio, with a hairline
 *   failed     a quiet note and a link to the original
 */

type Phase = "loading" | "revealing" | "shown" | "failed";

/** What a turn knew while it was generating: the shape it asked for. */
export interface GenerationHandoff {
  modality: GenerationModality;
  ratio: number;
  count: number;
}

type Progress = NonNullable<ClientMessage["progress"]>;

function handoffFor(progress: Progress): GenerationHandoff {
  return {
    modality: progress.modality,
    ratio: requestedRatio(progress.modality, progress.aspect),
    count: progress.modality === "image" ? outputCount(progress.count) : 1,
  };
}

/**
 * Remembers the shape of the generation this turn is running, so the media
 * that replaces the placeholder starts in the same box and knows to reveal.
 * A turn loaded from history never had progress, so it never reveals.
 */
export function useGenerationHandoff(progress: ClientMessage["progress"]): GenerationHandoff | null {
  const [handoff, setHandoff] = React.useState<GenerationHandoff | null>(null);
  if (progress) {
    const next = handoffFor(progress);
    if (!handoff || handoff.ratio !== next.ratio || handoff.count !== next.count || handoff.modality !== next.modality) {
      setHandoff(next);
    }
  }
  return handoff;
}

/** Ratios learned this session, so a picture scrolled back into a remounted list does not re-measure from square. */
const knownRatios = new Map<string, number>();

function attachmentRatio(attachment: ClientAttachment): number | null {
  if (attachment.width && attachment.height) return clampRatio(attachment.width / attachment.height);
  return knownRatios.get(attachment.url) ?? null;
}

/**
 * FLIP on size: when `shapeKey` changes, the element is animated from the box
 * it had to the box it now has. Width and height only, once per change; the
 * size is tracked by a ResizeObserver so a resized window never morphs from a
 * stale box.
 */
function useFrameMorph(ref: React.RefObject<HTMLElement | null>, shapeKey: string, enabled: boolean) {
  const last = React.useRef<{ w: number; h: number } | null>(null);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (el.getAnimations().length) return;
      const r = el.getBoundingClientRect();
      last.current = { w: r.width, h: r.height };
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const prev = last.current;
    last.current = { w: r.width, h: r.height };
    if (!prev || !enabled || typeof el.animate !== "function") return;
    if (Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1) return;
    el.animate(
      [
        { width: `${prev.w}px`, height: `${prev.h}px` },
        { width: `${r.width}px`, height: `${r.height}px` },
      ],
      { duration: MORPH_MS, easing: EXPO }
    );
  }, [ref, shapeKey, enabled]);
}

/** Pauses the field's drift while it is offscreen or the tab is hidden. */
function useFieldPause(ref: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let visible = true;
    const apply = () => {
      if (visible && document.visibilityState === "visible") el.removeAttribute("data-paused");
      else el.setAttribute("data-paused", "");
    };
    const io =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(([entry]) => {
            visible = entry?.isIntersecting ?? true;
            apply();
          });
    io?.observe(el);
    document.addEventListener("visibilitychange", apply);
    apply();
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", apply);
    };
  }, [ref]);
}

/**
 * The waiting field: soft ink, light and one breath of presence blue drifting
 * under grain, inside the four hairline corners of the construction. `still`
 * holds it motionless (a history picture loading, or reduced motion).
 */
export function GenerationField({ still = false }: { still?: boolean }) {
  const ref = React.useRef<HTMLDivElement>(null);
  useFieldPause(ref);
  return (
    <div ref={ref} className="gen-field" aria-hidden="true" data-paused={still ? "" : undefined}>
      <span className="gen-field__blob gen-field__blob--a" />
      <span className="gen-field__blob gen-field__blob--b" />
      <span className="gen-field__blob gen-field__blob--c" />
      <span className="gen-field__blob gen-field__blob--p" />
      <span className="gen-field__grain" />
      <span className="gen-field__tick gen-field__tick--tl" />
      <span className="gen-field__tick gen-field__tick--tr" />
      <span className="gen-field__tick gen-field__tick--bl" />
      <span className="gen-field__tick gen-field__tick--br" />
    </div>
  );
}

/** Wait for the bitmap to decode before revealing, so no blank frame is ever shown. */
function afterDecode(image: HTMLImageElement, then: () => void) {
  if (typeof image.decode === "function") void image.decode().catch(() => undefined).then(then);
  else then();
}

interface GeneratedImageProps {
  attachment: ClientAttachment;
  /** Set when this turn was generating in this session: the picture reveals into the requested shape. */
  handoff?: GenerationHandoff | null;
  /** Position in a grid: tiles resolve in a staggered sweep. */
  index?: number;
  /** Drawn as a grid tile (width from the grid column) rather than on its own. */
  tile?: boolean;
  onEdit?: () => void;
}

export function GeneratedImage({ attachment, handoff, index = 0, tile = false, onEdit }: GeneratedImageProps) {
  const reduced = usePrefersReducedMotion();
  const protectedLocalUrl = requiresViewerCredentials(attachment.url);
  const [ratio, setRatio] = React.useState(() => attachmentRatio(attachment) ?? handoff?.ratio ?? 1);
  const [phase, setPhase] = React.useState<Phase>("loading");
  const [layerSrc, setLayerSrc] = React.useState<string | null>(null);
  // Reveal once per mount, and only for a turn that was generating here.
  const fresh = React.useRef(!!handoff);
  const frameRef = React.useRef<HTMLDivElement>(null);
  useFrameMorph(frameRef, ratio.toFixed(4), !reduced);

  React.useEffect(() => {
    if (phase !== "revealing") return;
    const timer = window.setTimeout(() => setPhase("shown"), index * TILE_STAGGER_MS + REVEAL_MS + 320);
    return () => window.clearTimeout(timer);
  }, [phase, index]);

  const onLoad = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    afterDecode(image, () => {
      if (image.naturalWidth && image.naturalHeight) {
        const natural = clampRatio(image.naturalWidth / image.naturalHeight);
        knownRatios.set(attachment.url, natural);
        setRatio(natural);
      }
      if (fresh.current && !reduced) {
        fresh.current = false;
        setLayerSrc(image.currentSrc || image.src);
        setPhase("revealing");
      } else {
        fresh.current = false;
        setPhase("shown");
      }
    });
  };

  const failed = phase === "failed";
  const style = {
    "--gen-delay": `${index * TILE_STAGGER_MS}ms`,
    aspectRatio: String(ratio),
    width: tile ? "100%" : `min(100%, ${frameWidth("image", ratio)}px)`,
  } as React.CSSProperties;

  return (
    <div
      ref={frameRef}
      className="gen-root gen-frame group/media"
      data-modality="image"
      data-phase={phase}
      style={style}
    >
      {(phase === "loading" || phase === "revealing") && <GenerationField still={!handoff || reduced} />}
      {phase === "revealing" && layerSrc && (
        <>
          {/* Duplicates of the decoded bitmap (same URL, a cache hit), blurred. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={layerSrc} alt="" aria-hidden="true" className="gen-layer gen-layer--blur" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={layerSrc} alt="" aria-hidden="true" className="gen-layer gen-layer--mid" />
        </>
      )}
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={failed ? `Preview unavailable. Open ${attachment.fileName} in a new tab` : `Open ${attachment.fileName} in a new tab`}
        className="gen-sharp block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <Image
          src={attachment.url}
          alt={attachment.fileName}
          fill
          // The protected local-storage route requires the browser's session
          // cookie. Next's internal optimizer fetch does not forward it.
          unoptimized={protectedLocalUrl}
          sizes={tile ? "(max-width: 640px) 50vw, 280px" : "(max-width: 640px) calc(100vw - 2rem), 480px"}
          onLoad={onLoad}
          onError={() => setPhase("failed")}
          className="object-cover"
        />
      </a>
      {failed && (
        <a href={attachment.url} target="_blank" rel="noopener noreferrer" className="gen-note">
          <span className="flex flex-col items-center gap-2">
            <ImageOff className="size-5" aria-hidden="true" />
            <span className="font-mono text-caption">Preview unavailable · open original</span>
          </span>
          <span role="status" aria-live="polite" className="sr-only">
            Preview unavailable for {attachment.fileName}. Open the original file instead.
          </span>
        </a>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit ${attachment.fileName}`}
          // The media-overlay action: caption mono, hairline, a press that dips.
          className="absolute right-2 top-2 z-20 inline-flex h-8 items-center gap-1.5 rounded-full border border-border/60 bg-card/85 px-2.5 font-mono text-caption text-foreground/85 opacity-0 shadow-soft backdrop-blur transition-[transform,opacity,color] duration-fast ease-out-soft hover:text-foreground active:scale-[0.97] active:duration-press group-hover/media:opacity-100 focus-visible:opacity-100 coarse:h-10 coarse:opacity-100 motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <ActionIcons.edit className="size-3.5" aria-hidden="true" /> Edit
        </button>
      )}
    </div>
  );
}

/**
 * Two or more pictures from one request: a two-column grid at the width the
 * placeholder grid held, each tile resolving a beat after the one before.
 */
export function GeneratedImageGrid({
  attachments,
  handoff,
  renderTile,
}: {
  attachments: ClientAttachment[];
  handoff?: GenerationHandoff | null;
  renderTile: (attachment: ClientAttachment, index: number) => React.ReactNode;
}) {
  const ratio = handoff?.ratio ?? 1;
  return (
    <div className="gen-grid" style={{ width: `min(100%, ${gridWidth(attachments.length, ratio)}px)` }}>
      {attachments.map((a, i) => renderTile(a, i))}
    </div>
  );
}

/**
 * A generated clip: the stage takes the video's own ratio once its metadata
 * is in. Fresh, the first frame is painted to a canvas behind a heavy blur and
 * the clip resolves over it top-down; the controls appear once it has.
 */
export function GeneratedVideo({ attachment, handoff }: { attachment: ClientAttachment; handoff?: GenerationHandoff | null }) {
  const reduced = usePrefersReducedMotion();
  const [ratio, setRatio] = React.useState(() => attachmentRatio(attachment) ?? handoff?.ratio ?? 16 / 9);
  const [phase, setPhase] = React.useState<Phase>("loading");
  const fresh = React.useRef(!!handoff);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  useFrameMorph(cardRef, ratio.toFixed(4), !reduced);

  React.useEffect(() => {
    if (phase !== "revealing") return;
    const timer = window.setTimeout(() => setPhase("shown"), REVEAL_MS + 320);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const ready = phase === "shown";
  const failed = phase === "failed";
  const accessibleStatus = failed
    ? `Video preview unavailable for ${attachment.fileName}`
    : ready
      ? `${attachment.fileName} is ready`
      : `Preparing ${attachment.fileName}`;

  const onLoadedData = (event: React.SyntheticEvent<HTMLVideoElement>) => {
    const video = event.currentTarget;
    if (video.videoWidth && video.videoHeight) {
      const natural = clampRatio(video.videoWidth / video.videoHeight);
      knownRatios.set(attachment.url, natural);
      setRatio(natural);
    }
    if (fresh.current && !reduced) {
      fresh.current = false;
      // The blurred approximation is the clip's own first frame.
      const canvas = canvasRef.current;
      if (canvas && video.videoWidth) {
        canvas.width = Math.min(320, video.videoWidth);
        canvas.height = Math.round((canvas.width * video.videoHeight) / video.videoWidth);
        try {
          canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch {
          /* A cross-origin frame cannot be drawn; the field carries the blur instead. */
        }
      }
      setPhase("revealing");
    } else {
      fresh.current = false;
      setPhase("shown");
    }
  };

  return (
    <div
      ref={cardRef}
      className="gen-root gen-frame group/video"
      data-modality="video"
      data-phase={phase}
      style={{ aspectRatio: String(ratio), width: `min(100%, ${frameWidth("video", ratio)}px)` }}
    >
      {(phase === "loading" || phase === "revealing") && <GenerationField still={!handoff || reduced} />}
      <canvas ref={canvasRef} aria-hidden="true" className={cn("gen-layer gen-layer--blur", phase !== "revealing" && "hidden")} />
      <div className="gen-sharp">
        <video
          controls={ready}
          playsInline
          preload="auto"
          src={attachment.url}
          title={attachment.fileName}
          aria-label={attachment.fileName}
          aria-hidden={!ready}
          tabIndex={ready ? 0 : -1}
          onLoadStart={() => setPhase((p) => (p === "failed" ? "loading" : p))}
          onLoadedData={onLoadedData}
          onError={() => setPhase("failed")}
          className={cn("absolute inset-0 size-full", ready ? "pointer-events-auto" : "pointer-events-none")}
        />
      </div>
      {failed && (
        <a href={attachment.url} target="_blank" rel="noopener noreferrer" className="gen-note">
          <span className="flex flex-col items-center gap-2">
            <VideoIcon className="size-5 opacity-70" aria-hidden="true" />
            <span className="font-mono text-caption">Video preview unavailable · open original</span>
          </span>
        </a>
      )}
      <span role="status" aria-live="polite" className="sr-only">
        {accessibleStatus}
      </span>
      {ready && (
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${attachment.fileName} in a new tab`}
          // The same media-overlay action as an image's Edit: out of the way of
          // the native controls along the bottom edge.
          className="absolute right-2 top-2 z-20 inline-flex h-8 items-center gap-1.5 rounded-full border border-border/60 bg-card/85 px-2.5 font-mono text-caption text-foreground/85 opacity-0 shadow-soft backdrop-blur transition-[transform,opacity,color] duration-fast ease-out-soft hover:text-foreground active:scale-[0.97] active:duration-press group-hover/video:opacity-100 focus-visible:opacity-100 coarse:h-10 coarse:opacity-100 motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          Open
          <ActionIcons.external className="size-3.5" aria-hidden="true" />
        </a>
      )}
    </div>
  );
}
