"use client";

import * as React from "react";
import { Activity, ChevronDown } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ConnectorMark } from "@/components/connections/connector-logos";
import { makeLiveLogEntry, type LogEntry, type LogStatus } from "@/lib/mcp-dashboard-fixture";
import { cn } from "@/lib/utils";

const OPEN_KEY = "juno:mcp:log-open";

function clock(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function pretty(value: object): string {
  return JSON.stringify(value, null, 2);
}

function prettyResult(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}

function LogStatusPill({ status }: { status: LogStatus }) {
  const ok = status === "ok";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[10px] uppercase tracking-wider",
        ok ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"
      )}
    >
      <span className={cn("h-1 w-1 rounded-full", ok ? "bg-success" : "bg-destructive")} />
      {status}
    </span>
  );
}

function JsonBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 px-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">{label}</p>
      <pre className="overflow-x-auto rounded-md border bg-muted/60 p-2.5 font-mono text-[11px] leading-relaxed text-foreground/85">
        {value}
      </pre>
    </div>
  );
}

function LogRow({
  entry,
  label,
  index,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  label: string;
  index: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className="overflow-hidden rounded-md motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto] items-center gap-x-2.5 rounded-md px-2 py-1.5 text-left transition-colors duration-fast ease-out-soft hover:bg-muted/40"
      >
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">{clock(entry.at)}</span>
        <span className="inline-flex items-center gap-1 rounded-full border bg-background/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          <ConnectorMark id={entry.connectorId} className="h-3 w-3 shrink-0" />
          <span className="hidden max-w-16 truncate sm:inline">{label}</span>
        </span>
        <span className="truncate font-mono text-[12px] text-foreground/90">{entry.tool}</span>
        <LogStatusPill status={entry.status} />
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground/70">{entry.durationMs}ms</span>
        <ChevronDown
          className={cn(
            "size-3.5 text-muted-foreground/70 transition-transform duration-base ease-out-soft",
            expanded && "rotate-180"
          )}
        />
      </button>
      {/* Animated height collapse; content is static text, so it can stay mounted. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft",
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!expanded}>
          <div className="grid gap-2.5 px-2 pb-2.5 pt-1 sm:grid-cols-2">
            <JsonBlock label="Params" value={pretty(entry.params)} />
            <JsonBlock label="Result" value={prettyResult(entry.result)} />
          </div>
        </div>
      </div>
    </li>
  );
}

export function ToolLogPanel({
  entries,
  onAppend,
  labels,
}: {
  entries: LogEntry[];
  /** Called with a fixture-generated entry while the Live switch is on. */
  onAppend: (entry: LogEntry) => void;
  /** connectorId -> display label, for the server chips. */
  labels: Record<string, string>;
}) {
  const [open, setOpen] = React.useState(false);
  const [live, setLive] = React.useState(false);
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(new Set());
  // Rows stay mounted after the first open so the height collapse can animate;
  // `inert` keeps the hidden rows out of the tab order while closed.
  const [everOpened, setEverOpened] = React.useState(false);
  React.useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  // Collapsed by default; reopen if the user left it open last time.
  React.useEffect(() => {
    try {
      if (window.localStorage.getItem(OPEN_KEY) === "1") setOpen(true);
    } catch {}
  }, []);

  const toggleOpen = () => {
    const next = !open;
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_KEY, next ? "1" : "0");
    } catch {}
  };

  // Live feed — random 4-7s cadence, rescheduled after each entry.
  React.useEffect(() => {
    if (!live) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      t = setTimeout(() => {
        onAppend(makeLiveLogEntry());
        schedule();
      }, 4000 + Math.random() * 3000);
    };
    schedule();
    return () => clearTimeout(t);
  }, [live, onAppend]);

  const toggleEntry = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-muted/30">
      <div className="flex items-center">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggleOpen}
          className="flex min-w-0 flex-1 items-center gap-2.5 px-3.5 py-2.5 text-left transition-colors duration-fast ease-out-soft hover:bg-muted/40"
        >
          <Activity className="size-3.5 text-primary" />
          <span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground/90">
            Activity log
          </span>
          {live && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-primary/70 opacity-75 motion-safe:animate-ping" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
          )}
          <span className="ml-auto font-mono text-[10.5px] text-muted-foreground/60">
            {entries.length} {entries.length === 1 ? "call" : "calls"}
          </span>
          <ChevronDown
            className={cn(
              "size-3.5 text-muted-foreground/70 transition-transform duration-base ease-out-soft",
              open && "rotate-180"
            )}
          />
        </button>
        <div className="flex shrink-0 items-center gap-2 border-l border-border/60 px-3.5 py-2.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Live</span>
          <Switch checked={live} onCheckedChange={setLive} aria-label="Toggle live tool activity" />
        </div>
      </div>

      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-base ease-out-soft",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          {everOpened && (
            <div className="border-t border-border/60 bg-background/25 p-2">
              <ol className="flex flex-col gap-0.5">
                {entries.map((entry, i) => (
                  <LogRow
                    key={entry.id}
                    entry={entry}
                    index={i}
                    label={labels[entry.connectorId] ?? entry.connectorId}
                    expanded={expandedIds.has(entry.id)}
                    onToggle={() => toggleEntry(entry.id)}
                  />
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
