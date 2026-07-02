"use client";

import * as React from "react";
import {
  AlertCircle,
  BookOpen,
  Brain,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Gauge,
  Globe,
  PenLine,
  Search,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ActivityKind, ClientActivityEvent } from "@/types/chat";

const ICONS: Record<ActivityKind, LucideIcon> = {
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

const ICON_TONE: Record<ActivityKind, string> = {
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

function domainOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function eventTime(value: string) {
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

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const Icon = ICONS[kind];
  return (
    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 shadow-pop">
      <Icon className={cn("size-3.5", ICON_TONE[kind])} aria-hidden="true" />
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
  const hasEvents = !!events?.length;
  const hasReasoning = !!reasoning?.trim();
  const userToggledRef = React.useRef(false);
  const [open, setOpen] = React.useState(!!streaming);
  const reasoningRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (streaming && (hasEvents || hasReasoning) && !userToggledRef.current) setOpen(true);
  }, [hasEvents, hasReasoning, streaming]);

  // Keep the live thinking scrolled to the latest token while it streams.
  React.useEffect(() => {
    if (streaming && open && reasoningRef.current) {
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

  if (!hasEvents && !hasReasoning) return null;

  return (
    <div className="mb-3 overflow-hidden rounded-[18px] border border-border/70 bg-muted/25">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          userToggledRef.current = true;
          setOpen((value) => !value);
        }}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors duration-fast hover:bg-muted/40"
      >
        <span className="relative flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
          <span
            className={cn(
              "absolute -inset-[5px] rounded-full bg-primary/25 opacity-0 transition-opacity duration-slow ease-out-soft",
              streaming && "opacity-100 motion-safe:animate-pulse-ring-slow"
            )}
          />
          <Brain className={cn("relative size-3.5 text-primary", streaming && "motion-safe:animate-icon-breathe")} />
        </span>
        {/* Key swap crossfades live → settled instead of snapping the label. */}
        <span
          key={streaming ? "live" : "settled"}
          className={cn(
            "font-mono text-label uppercase text-muted-foreground/90 motion-safe:animate-fade-in",
            streaming && "text-shimmer"
          )}
        >
          {streaming ? "Thinking" : "Thought process"}
        </span>
        <span className="ml-auto font-mono text-caption tabular-nums text-muted-foreground/60">
          {hasEvents ? `${events!.length} ${events!.length === 1 ? "event" : "events"}` : "reasoning"}
        </span>
        <ChevronDown className={cn("size-3.5 text-muted-foreground/70 transition-transform duration-base ease-out-soft", open && "rotate-180")} />
      </button>

      {/* Grid-rows collapse: the body stays mounted so open/close animate height. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          <div className="border-t border-border/60 bg-background/25 px-3.5 py-3 flex flex-col gap-3">
            {hasReasoning && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-1.5 px-0.5">
                  <Brain className="size-3.5 text-primary/80" aria-hidden="true" />
                  <span className="font-mono text-label uppercase text-muted-foreground/80">Reasoning</span>
                </div>
                {/* Frame and scroller are separate so the fade mask dissolves the
                    text at the edges without eating the border or background. */}
                <div className="field-well rounded-[14px] border border-border/40 bg-background/40">
                  <div
                    ref={reasoningRef}
                    className="scroll-fade-y max-h-72 overflow-y-auto whitespace-pre-wrap px-3.5 py-3 font-serif text-body italic text-muted-foreground/90"
                  >
                    {reasoning!.slice(0, tailFrom)}
                    <span
                      className={cn(
                        "transition-opacity duration-slow ease-out-soft",
                        streaming ? "opacity-60" : "opacity-100"
                      )}
                    >
                      {reasoning!.slice(tailFrom)}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {hasEvents && (
              <div className="flex flex-col gap-2">
                {hasReasoning && <div className="border-t border-border/40 my-1" />}
                <div className="flex items-center gap-1.5 px-0.5">
                  <span className="font-mono text-label uppercase text-muted-foreground/80">Timeline</span>
                </div>
                <ol className="flex flex-col gap-2.5">
                  {events!.map((event) => (
                    <li
                      key={event.id}
                      className="grid grid-cols-[auto_minmax(0,1fr)] gap-2.5 px-0.5 items-start motion-safe:animate-fade-in-up"
                    >
                      <ActivityIcon kind={event.kind} />
                      <div className="min-w-0 pt-0.5">
                        <div className="flex min-w-0 items-center justify-between gap-2">
                          <p className="min-w-0 flex-1 truncate text-body font-semibold text-foreground/85">{event.title}</p>
                          <span className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground/60">{eventTime(event.createdAt)}</span>
                        </div>
                        {event.detail && <p className="mt-0.5 break-words text-sm leading-relaxed text-muted-foreground/75">{event.detail}</p>}
                        {event.url && (
                          <a
                            href={event.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 inline-flex max-w-full items-center gap-1 text-sm text-source hover:text-source/80 transition-colors duration-fast underline-offset-2 hover:underline"
                          >
                            <Globe className="size-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{domainOf(event.url)}</span>
                          </a>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
