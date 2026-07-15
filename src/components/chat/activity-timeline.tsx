"use client";

import * as React from "react";
import { PanelRight } from "lucide-react";
import { ACTIVITY_ICONS, ACTIVITY_TONE, ThoughtProcessPanel, domainOf } from "@/components/chat/thought-process-panel";
import { cn, truncate } from "@/lib/utils";
import type { ClientActivityEvent } from "@/types/chat";

/** One-line preview of the newest event. Both layers are absolutely positioned
 *  inside a fixed-height row, so text swaps never reflow the message above.
 *
 *  Crossfade without state: `prevRef` lands after paint, so during the render
 *  that introduces a new `id` it still holds the outgoing one — keying the
 *  bottom layer on it remounts and plays the exit exactly once. Re-renders that
 *  only change `detail` (the reasoning tail, which grows token by token) keep
 *  the same key and update in place, so the line never strobes. */
function PreviewLine({
  id,
  title,
  detail,
  streaming,
}: {
  id: string;
  title: string;
  detail?: string;
  streaming?: boolean;
}) {
  /*
   * Both layers are keyed by the INCOMING event's id, so a new event remounts the
   * pair together and their fade-out/fade-in run as one crossfade.
   *
   * This previously tracked `prev` in a ref committed by a post-paint effect, and
   * keyed the outgoing layer `out-${prev.id}`. That key therefore lagged a render
   * behind: on the A→B render it was still `out-A` — the same key as the previous
   * render — so React never remounted the layer, its fade-out never re-ran, and
   * `fill-mode-forwards` had already parked it at opacity 0. The outgoing text was
   * invisible and the new one popped. Deriving during render fixes the timing;
   * keying both layers off the same id fixes the pairing.
   */
  const [shown, setShown] = React.useState({ id, title, detail });
  const [outgoing, setOutgoing] = React.useState<{ title: string; detail?: string } | null>(null);
  if (id !== shown.id) {
    // A different event: hand the old text to the outgoing layer and crossfade.
    setOutgoing({ title: shown.title, detail: shown.detail });
    setShown({ id, title, detail });
  } else if (title !== shown.title || detail !== shown.detail) {
    // Same event, refined text (detail arriving late). Update in place — no
    // crossfade — but still track it, or the NEXT crossfade would fade out text
    // that has not been on screen since.
    setShown({ id, title, detail });
  }

  return (
    <span className="relative min-w-0 flex-1 self-stretch">
      {outgoing && (
        <span
          key={`out-${shown.id}`}
          aria-hidden="true"
          className="absolute inset-0 flex items-center duration-base ease-out-soft motion-safe:animate-out motion-safe:fade-out-0 motion-safe:fill-mode-forwards motion-reduce:hidden"
        >
          <span className="min-w-0 truncate text-body text-foreground/85">
            {outgoing.title}
            {outgoing.detail && <span className="text-muted-foreground/65"> — {outgoing.detail}</span>}
          </span>
        </span>
      )}

      <span
        key={`in-${shown.id}`}
        className="absolute inset-0 flex items-center duration-base ease-out-soft motion-safe:animate-in motion-safe:fade-in-0"
      >
        <span className="min-w-0 truncate text-body text-foreground/85">
          {/* Shimmer stays on the verb only: `text-shimmer` transparentises text
              fill, so spanning both would flatten the title/detail contrast. */}
          <span className={cn(streaming && "text-shimmer")}>{shown.title}</span>
          {shown.detail && <span className="text-muted-foreground/65"> — {shown.detail}</span>}
        </span>
      </span>
    </span>
  );
}

export function ActivityTimeline({
  events,
  reasoning,
  streaming,
}: {
  events?: ClientActivityEvent[];
  reasoning?: string | null;
  streaming?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  const hasEvents = !!events?.length;
  const hasReasoning = !!reasoning?.trim();
  const latest = hasEvents ? events![events!.length - 1] : undefined;

  // Reasoning-only runs still deserve a live line: fall back to the sentence
  // currently being written.
  const reasoningTail = React.useMemo(() => {
    const text = reasoning?.trim();
    if (!text) return undefined;
    const line = text.split("\n").reduce<string | undefined>((last, l) => (l.trim() ? l : last), undefined);
    return line ? truncate(line, 90) : undefined;
  }, [reasoning]);

  if (!hasEvents && !hasReasoning) return null;

  const preview = latest
    ? {
        id: latest.id,
        kind: latest.kind,
        title: latest.title,
        detail: latest.detail ?? (latest.url ? domainOf(latest.url) : undefined),
      }
    : {
        id: "reasoning",
        kind: "reasoning" as const,
        title: streaming ? "Thinking" : "Reasoning",
        detail: reasoningTail,
      };

  const Icon = ACTIVITY_ICONS[preview.kind];
  const count = hasEvents ? `${events!.length} ${events!.length === 1 ? "event" : "events"}` : "reasoning";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={hasEvents ? `Open thought process — ${count}` : "Open thought process"}
        className="group/row relative mb-3 flex h-11 w-full items-center gap-2.5 rounded-[18px] border border-border/70 bg-muted/25 pl-2.5 pr-3 text-left transition-[transform,box-shadow,border-color] duration-base ease-out-soft hover:z-10 hover:border-border hover:shadow-float motion-safe:hover:-translate-y-0.5 motion-safe:active:translate-y-0 motion-reduce:transition-none"
      >
        <span className="relative flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
          <span
            className={cn(
              "absolute inset-0 rounded-full bg-primary/25 opacity-0 transition-opacity duration-slow ease-out-soft motion-reduce:transition-none",
              streaming && "opacity-100 motion-safe:animate-pulse-ring-slow"
            )}
          />
          <span className="relative z-10 flex size-6 items-center justify-center rounded-full border border-border/60 bg-background shadow-pop">
            {/* Two spans: the breathe and the keyed glyph swap are both `animation`,
                so they cannot share an element. */}
            <span className={cn("flex", streaming && "motion-safe:animate-icon-breathe")}>
              <Icon key={preview.kind} className={cn("size-3.5 motion-safe:animate-fade-in", ACTIVITY_TONE[preview.kind])} />
            </span>
          </span>
        </span>

        <PreviewLine id={preview.id} title={preview.title} detail={preview.detail} streaming={streaming} />

        <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground/55">{count}</span>
        <PanelRight
          className="size-3.5 shrink-0 text-muted-foreground/50 transition-colors duration-base ease-out-soft group-hover/row:text-foreground/70 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </button>

      <ThoughtProcessPanel open={open} onOpenChange={setOpen} events={events} reasoning={reasoning} streaming={streaming} />
    </>
  );
}
