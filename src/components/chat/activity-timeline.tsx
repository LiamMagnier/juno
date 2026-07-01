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
import { Button } from "@/components/ui/button";
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
  const match = value.match(/T(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? "";
}

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const Icon = ICONS[kind];
  return (
    <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background">
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

  if (!hasEvents && !hasReasoning) return null;

  return (
    <div className="mb-3 flex flex-col gap-2 rounded-[16px] border border-border/70 bg-muted/35 px-3 py-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-expanded={open}
        onClick={() => {
          userToggledRef.current = true;
          setOpen((value) => !value);
        }}
        className="h-7 justify-start gap-2 px-2 rounded-md"
      >
        <Brain data-icon="inline-start" />
        <span className="font-mono text-xs">Thinking</span>
        {streaming && <span className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden="true" />}
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">
          {hasEvents ? `${events!.length} ${events!.length === 1 ? "event" : "events"}` : "reasoning"}
        </span>
        <ChevronDown data-icon="inline-end" className={cn("transition-transform duration-base", open && "rotate-180")} />
      </Button>

      {open && hasReasoning && (
        <div className="border-t border-border/70 pt-2">
          <div className="mb-1.5 flex items-center gap-1.5 px-1">
            <Brain className="size-3 text-primary" aria-hidden="true" />
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Reasoning</span>
          </div>
          <div
            ref={reasoningRef}
            className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md bg-background/50 px-2.5 py-2 font-serif text-[13px] italic leading-relaxed text-muted-foreground"
          >
            {reasoning}
          </div>
        </div>
      )}

      {open && hasEvents && (
        <ol className={cn("flex flex-col gap-2 border-t border-border/70 pt-2", hasReasoning && "mt-1")}>
          {events!.map((event) => (
            <li key={event.id} className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 px-1">
              <ActivityIcon kind={event.kind} />
              <div className="min-w-0 pb-1">
                <div className="flex min-w-0 items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{event.title}</p>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{eventTime(event.createdAt)}</span>
                </div>
                {event.detail && <p className="break-words text-xs leading-relaxed text-muted-foreground">{event.detail}</p>}
                {event.url && (
                  <a
                    href={event.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-source underline-offset-2 hover:underline"
                  >
                    <Globe className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{domainOf(event.url)}</span>
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
