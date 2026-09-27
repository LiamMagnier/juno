"use client";

import * as React from "react";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ClientAgentChange } from "@/types/chat";

export function AgentChangeCard({
  change,
  onUndone,
  className,
}: {
  change: ClientAgentChange;
  onUndone?: (eventId: string) => void;
  className?: string;
}) {
  const [undone, setUndone] = React.useState(Boolean(change.undone));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (change.undone) setUndone(true);
  }, [change.undone]);

  const handleUndo = React.useCallback(async () => {
    if (!change.eventId || busy || undone) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(change.agentId)}/events/${encodeURIComponent(change.eventId)}/undo`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(data?.message ?? "Could not undo this change.");
        return;
      }
      setUndone(true);
      onUndone?.(change.eventId);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("juno:agent-updated", { detail: { agentId: change.agentId } }));
      }
    } catch {
      setError("Could not reach Juno to undo this change.");
    } finally {
      setBusy(false);
    }
  }, [busy, change.agentId, change.eventId, onUndone, undone]);

  return (
    <div
      className={cn(
        "rounded-card border border-border bg-card px-3.5 py-2.5",
        undone && "opacity-70",
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <AppIcons.agents className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="truncate text-label font-medium text-foreground">
            {undone ? `Reverted: ${change.summary}` : change.summary}
          </p>
        </div>
        {change.eventId && !undone ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={handleUndo}
            className="h-7 shrink-0 px-2.5 text-caption font-medium text-muted-foreground hover:text-foreground"
          >
            {busy ? "Undoing…" : "Undo"}
          </Button>
        ) : undone ? (
          <span className="shrink-0 text-caption text-muted-foreground">Undone</span>
        ) : null}
      </div>

      {change.changes.length > 0 && (
        <dl className="mt-2 space-y-1 border-t border-border/60 pt-2">
          {change.changes.map((item, index) => (
            <div
              key={`${item.label}-${index}`}
              className="flex flex-wrap items-baseline justify-between gap-2 text-caption"
            >
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className="text-right text-foreground">
                {item.from ? (
                  <>
                    <span className="text-muted-foreground">{item.from}</span>
                    <span className="mx-1 text-muted-foreground" aria-hidden="true">
                      →
                    </span>
                    <span className="font-medium text-foreground">{item.to}</span>
                  </>
                ) : (
                  <span className="font-medium text-foreground">{item.to}</span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {error && (
        <p role="alert" className="mt-1.5 text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default AgentChangeCard;
