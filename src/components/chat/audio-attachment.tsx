"use client";

import * as React from "react";
import { Download, Pause, Play } from "@/components/ui/icons";
import type { ClientAttachment } from "@/types/chat";
import { cn } from "@/lib/utils";

/**
 * A generated track (kind FILE, audio/*) in the transcript.
 *
 * One quiet card: the track's name in the display serif with the model that
 * made it underneath, a play control, a hairline scrubber with real elapsed and
 * total time, and a download. No waveform: drawing one means decoding the
 * whole file a second time for a picture, and a fake one would be a picture of
 * sound the track does not contain. No status words either; a track that has
 * not loaded yet simply has no length to show.
 *
 * Only one track plays at a time across the page: starting one pauses any
 * other, the way a person expects a list of songs to behave.
 */

const PLAY_EVENT = "alevr:audio-play";
const STEP_SECONDS = 5;

/** "Lyria 3.5 — Rain on a tin roof.mp3" → { title: "Rain on a tin roof", source: "Lyria 3.5" }. */
export function audioTitleParts(fileName: string): { title: string; source: string | null } {
  const bare = fileName.replace(/\.(mp3|wav|flac|ogg|m4a|aac)$/i, "").trim();
  const at = bare.indexOf(" — ");
  if (at <= 0) return { title: bare || "Untitled track", source: null };
  const title = bare.slice(at + 3).trim();
  return { title: title || "Untitled track", source: bare.slice(0, at).trim() || null };
}

/** 0:07 · 2:41 · 1:02:03. Unknown or endless lengths read as "–:––". */
export function formatTrackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–:––";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export function AudioAttachment({ attachment }: { attachment: ClientAttachment }) {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [duration, setDuration] = React.useState(Number.NaN);
  const [current, setCurrent] = React.useState(0);
  const [failed, setFailed] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const { title, source } = audioTitleParts(attachment.fileName);
  const known = Number.isFinite(duration) && duration > 0;
  const progress = known ? Math.min(1, Math.max(0, current / duration)) : 0;

  // Follow the playhead every frame while playing: `timeupdate` fires about
  // four times a second, which moves a 400px scrubber in visible steps.
  React.useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el && !dragging) setCurrent(el.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, dragging]);

  // One track at a time.
  React.useEffect(() => {
    const onOtherPlay = (e: Event) => {
      if ((e as CustomEvent<HTMLAudioElement>).detail !== audioRef.current) audioRef.current?.pause();
    };
    window.addEventListener(PLAY_EVENT, onOtherPlay);
    return () => window.removeEventListener(PLAY_EVENT, onOtherPlay);
  }, []);

  const toggle = () => {
    const el = audioRef.current;
    if (!el || failed) return;
    if (el.paused) {
      window.dispatchEvent(new CustomEvent(PLAY_EVENT, { detail: el }));
      void el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  };

  const seekTo = (seconds: number) => {
    const el = audioRef.current;
    if (!el || !known) return;
    const next = Math.min(duration, Math.max(0, seconds));
    el.currentTime = next;
    setCurrent(next);
  };

  const seekFromPointer = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    seekTo(((clientX - rect.left) / rect.width) * duration);
  };

  const onSliderKey = (e: React.KeyboardEvent) => {
    if (!known) return;
    const step = e.shiftKey ? STEP_SECONDS * 3 : STEP_SECONDS;
    const moves: Record<string, number> = {
      ArrowRight: current + step,
      ArrowUp: current + step,
      ArrowLeft: current - step,
      ArrowDown: current - step,
      PageUp: current + step * 3,
      PageDown: current - step * 3,
      Home: 0,
      End: duration,
    };
    if (e.key in moves) {
      e.preventDefault();
      seekTo(moves[e.key]);
    } else if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      toggle();
    }
  };

  const playLabel = playing ? `Pause ${title}` : `Play ${title}`;

  return (
    <figure
      data-testid="audio-attachment"
      className="group/audio w-[480px] max-w-full rounded-field border border-border/60 bg-card px-3.5 pb-3 pt-3.5 transition-colors duration-fast ease-out-soft hover:border-border motion-safe:animate-fade-in motion-reduce:transition-none"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          disabled={failed}
          aria-label={playLabel}
          aria-pressed={playing}
          className={cn(
            "jicon-trigger inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background",
            "transition-[transform,opacity] duration-fast ease-out-soft active:scale-[0.96] active:duration-press",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
            "disabled:cursor-not-allowed disabled:opacity-40 coarse:size-11 motion-reduce:transition-none motion-reduce:active:scale-100",
          )}
        >
          {playing ? (
            <Pause className="size-4" weight="fill" aria-hidden="true" />
          ) : (
            <Play className="size-4 translate-x-px" weight="fill" aria-hidden="true" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <figcaption className="truncate font-serif text-[1.0625rem] leading-6 tracking-[-0.005em] text-foreground" title={title}>
            {title}
          </figcaption>
          <p className="truncate font-mono text-caption text-muted-foreground">
            {failed ? "This track couldn't be loaded" : (source ?? "Audio")}
          </p>
        </div>
        <a
          href={attachment.url}
          download={attachment.fileName}
          aria-label={`Download ${attachment.fileName}`}
          className="jicon-trigger inline-flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-[background-color,color,transform] duration-fast ease-out-soft hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.96] active:duration-press coarse:size-10 motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <Download className="size-4" aria-hidden="true" />
        </a>
      </div>

      <div className="mt-3 flex items-center gap-3 pl-[52px] coarse:pl-14">
        <span className="w-10 shrink-0 font-mono text-caption tabular-nums text-muted-foreground" aria-hidden="true">
          {formatTrackTime(known ? current : Number.NaN)}
        </span>
        <div
          ref={trackRef}
          role="slider"
          tabIndex={known ? 0 : -1}
          aria-label={`Seek ${title}`}
          aria-valuemin={0}
          aria-valuemax={known ? Math.round(duration) : 0}
          aria-valuenow={Math.round(current)}
          aria-valuetext={known ? `${formatTrackTime(current)} of ${formatTrackTime(duration)}` : "Not loaded"}
          aria-disabled={!known}
          onKeyDown={onSliderKey}
          onPointerDown={(e) => {
            if (!known) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            seekFromPointer(e.clientX);
          }}
          onPointerMove={(e) => {
            if (dragging) seekFromPointer(e.clientX);
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          className={cn(
            "group/scrub relative flex h-6 min-w-0 flex-1 touch-none items-center rounded-full outline-none coarse:h-10",
            known ? "cursor-pointer" : "cursor-default",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
          )}
        >
          {/* The rail is a hairline; the played part is the same line in the ink colour. */}
          <span aria-hidden="true" className="relative h-[2px] w-full overflow-hidden rounded-full bg-border">
            <span
              className="absolute inset-y-0 left-0 w-full origin-left rounded-full bg-foreground"
              style={{ transform: `scaleX(${progress})` }}
            />
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground shadow-soft",
              "opacity-0 transition-opacity duration-fast ease-out-soft group-hover/scrub:opacity-100 group-focus-visible/scrub:opacity-100 motion-reduce:transition-none",
              (dragging || playing) && known && "opacity-100",
            )}
            style={{ left: `${progress * 100}%` }}
          />
        </div>
        <span className="w-10 shrink-0 text-right font-mono text-caption tabular-nums text-muted-foreground" aria-hidden="true">
          {formatTrackTime(duration)}
        </span>
      </div>

      <audio
        ref={audioRef}
        src={attachment.url}
        preload="metadata"
        onLoadedMetadata={(e) => {
          setFailed(false);
          setDuration(e.currentTarget.duration);
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={(e) => {
          setPlaying(false);
          setCurrent(e.currentTarget.duration);
        }}
        onTimeUpdate={(e) => {
          if (!dragging) setCurrent(e.currentTarget.currentTime);
        }}
        onError={() => {
          setFailed(true);
          setPlaying(false);
        }}
        className="hidden"
      />
    </figure>
  );
}
