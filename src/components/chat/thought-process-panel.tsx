"use client";

import * as React from "react";
import {
  AlertCircle,
  BookOpen,
  Brain,
  CheckCircle2,
  Cpu,
  Gauge,
  Globe,
  PenLine,
  Search,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { Sheet, SheetClose, SheetContent } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { ActivityKind, ClientActivityEvent } from "@/types/chat";

export const ACTIVITY_ICONS: Record<ActivityKind, LucideIcon> = {
  context: BookOpen,
  model: Cpu,
  reasoning: Brain,
  search: Search,
  visit: Globe,
  write: PenLine,
  usage: Gauge,
  done: CheckCircle2,
  warning: AlertCircle,
  tool: Wrench,
};

export const ACTIVITY_TONE: Record<ActivityKind, string> = {
  context: "text-muted-foreground",
  model: "text-muted-foreground",
  reasoning: "text-primary",
  search: "text-source",
  visit: "text-source",
  write: "text-primary",
  usage: "text-muted-foreground",
  done: "text-success",
  warning: "text-warning",
  tool: "text-primary",
};

export function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function eventTime(value: string) {
  try {
    const date = new Date(value);
    if (isNaN(date.getTime())) return "";
    return date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    const match = value.match(/T(\d{2}:\d{2}:\d{2})/);
    return match?.[1] ?? "";
  }
}

/** Wall-clock span of the run, for the header meta line. Null when the stamps
 *  are unusable (single event, unparseable, or clock skew running backwards). */
function elapsedOf(events: ClientActivityEvent[]) {
  if (events.length < 2) return null;
  const start = Date.parse(events[0].createdAt);
  const end = Date.parse(events[events.length - 1].createdAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const seconds = (end - start) / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Round icon chip on the timeline rail. The opaque fill is load-bearing: it
 *  occludes the rail hairline running behind it. */
export function ActivityIcon({ kind, live }: { kind: ActivityKind; live?: boolean }) {
  const Icon = ACTIVITY_ICONS[kind];
  return (
    <span className="relative flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
      {live && <span className="absolute inset-0 rounded-full bg-primary/25 motion-safe:animate-pulse-ring-slow" />}
      <span
        className={cn(
          "relative z-10 flex size-6 items-center justify-center rounded-full border bg-background shadow-pop",
          live ? "border-primary/45" : "border-border/60"
        )}
      >
        <Icon className={cn("size-3.5", ACTIVITY_TONE[kind], live && "motion-safe:animate-icon-breathe")} />
      </span>
    </span>
  );
}

function SectionLabel({ icon: Icon, children }: { icon?: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden="true" />}
      <span className="font-mono text-label uppercase text-muted-foreground/70">{children}</span>
      <span className="h-px flex-1 bg-border/50" aria-hidden="true" />
    </div>
  );
}

export function ThoughtProcessPanel({
  open,
  onOpenChange,
  events,
  reasoning,
  streaming,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events?: ClientActivityEvent[];
  reasoning?: string | null;
  streaming?: boolean;
}) {
  const list = events ?? [];
  const hasEvents = list.length > 0;
  const hasReasoning = !!reasoning?.trim();
  const reasoningRef = React.useRef<HTMLDivElement>(null);

  // Keep the live thinking pinned to the latest token while it streams.
  React.useEffect(() => {
    if (open && streaming && reasoningRef.current) {
      reasoningRef.current.scrollTop = reasoningRef.current.scrollHeight;
    }
  }, [reasoning, streaming, open]);

  // Soft edge on the newest reasoning text so the stream reads as live. The
  // boundary sits on whitespace so the dimmed tail never splits a word; on
  // settle the tail span transitions to full opacity instead of snapping.
  const tailFrom = React.useMemo(() => {
    const text = reasoning ?? "";
    const window = 140;
    if (text.length <= window) return 0;
    const cut = text.length - window;
    const newline = text.lastIndexOf("\n");
    if (newline >= cut) return newline + 1;
    const space = text.indexOf(" ", cut);
    return space === -1 ? cut : space + 1;
  }, [reasoning]);

  const meta = React.useMemo(() => {
    const sources = list.filter((event) => event.url).length;
    const elapsed = elapsedOf(list);
    return [
      hasEvents ? `${list.length} ${list.length === 1 ? "event" : "events"}` : "reasoning only",
      sources > 0 ? `${sources} ${sources === 1 ? "source" : "sources"}` : null,
      elapsed,
    ]
      .filter(Boolean)
      .join(" · ");
  }, [list, hasEvents]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        title="Thought process"
        aria-describedby={undefined}
        className="flex w-[min(30rem,100vw-3rem)] max-w-none flex-col border-border/70 bg-card"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border/60 px-5 pb-4 pt-5">
          <span className="relative flex size-8 shrink-0 items-center justify-center" aria-hidden="true">
            {streaming && <span className="absolute inset-0 rounded-full bg-primary/20 motion-safe:animate-pulse-ring-slow" />}
            <span className="relative z-10 flex size-8 items-center justify-center rounded-full border border-border/60 bg-background shadow-pop">
              <Brain className={cn("size-4 text-primary", streaming && "motion-safe:animate-icon-breathe")} />
            </span>
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-serif text-heading text-foreground">Thought process</h2>
              {streaming && (
                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-caption uppercase tracking-[0.1em] text-primary">
                  <span className="size-1.5 rounded-full bg-primary motion-safe:animate-dot-think" aria-hidden="true" />
                  Live
                </span>
              )}
            </div>
            <p className="mt-1 truncate font-mono text-caption uppercase tracking-[0.12em] text-muted-foreground/70">{meta}</p>
          </div>

          <SheetClose className="flex size-8 shrink-0 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-[transform,box-shadow,border-color,color] duration-base ease-out-soft hover:border-border hover:text-foreground hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none coarse:size-10">
            <X className="size-4" aria-hidden="true" />
            <span className="sr-only">Close thought process</span>
          </SheetClose>
        </header>

        <div className="flex flex-1 flex-col gap-6 overflow-y-auto bg-muted/15 px-5 py-5">
          {hasReasoning && (
            <section className="flex flex-col gap-2.5">
              <SectionLabel icon={Brain}>Reasoning</SectionLabel>
              {/* Frame/scroller split: the 4px inlay gutter keeps the fade mask off
                  the border, and 16 − 4 keeps the inner radius concentric. */}
              <div className="field-well rounded-[16px] border border-border/50 bg-background/40 p-1">
                <div
                  ref={reasoningRef}
                  className="scroll-fade-y max-h-[46vh] overflow-y-auto whitespace-pre-wrap rounded-[12px] px-3.5 py-3 font-serif text-body italic text-muted-foreground/90"
                >
                  {reasoning!.slice(0, tailFrom)}
                  <span
                    className={cn(
                      "transition-opacity duration-slow ease-out-soft motion-reduce:transition-none",
                      streaming ? "opacity-60" : "opacity-100"
                    )}
                  >
                    {reasoning!.slice(tailFrom)}
                  </span>
                </div>
              </div>
            </section>
          )}

          {hasEvents && (
            <section className="flex flex-col gap-3">
              <SectionLabel>Timeline</SectionLabel>
              <ol className="relative flex flex-col gap-1">
                {/* Rail: 11.5px centres a 1px hairline under the 24px icon chips;
                    top/bottom 20px lands it on the first and last chip centres. */}
                <span className="absolute bottom-5 left-[11.5px] top-5 w-px bg-border/60" aria-hidden="true" />
                {list.map((event, index) => {
                  const live = !!streaming && index === list.length - 1;
                  return (
                    <li key={event.id} className="relative motion-safe:animate-fade-in-up">
                      <div
                        className={cn(
                          "-mx-2 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-3 rounded-[14px] px-2 py-2 transition-colors duration-base ease-out-soft motion-reduce:transition-none",
                          // Coral is reserved for active state — the newest event is exactly that.
                          live && "bg-primary/[0.06]"
                        )}
                      >
                        <ActivityIcon kind={event.kind} live={live} />
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-baseline justify-between gap-3">
                            <p className="min-w-0 flex-1 text-body font-semibold text-foreground/90">{event.title}</p>
                            <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground/55">
                              {eventTime(event.createdAt)}
                            </span>
                          </div>
                          {event.detail && (
                            <p className="mt-0.5 break-words text-sm leading-relaxed text-muted-foreground/75">{event.detail}</p>
                          )}
                          {event.url && (
                            // relative + hover:z-10 so the lift shadow is not painted
                            // over by the next event's row tint.
                            <a
                              href={event.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="relative mt-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/60 bg-background/70 px-2 py-1 font-mono text-caption text-source shadow-pop transition-[transform,box-shadow,border-color] duration-base ease-out-soft hover:z-10 hover:border-border hover:shadow-float motion-safe:hover:-translate-y-0.5 motion-reduce:transition-none"
                            >
                              <Globe className="size-3 shrink-0" aria-hidden="true" />
                              <span className="truncate">{domainOf(event.url)}</span>
                            </a>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
