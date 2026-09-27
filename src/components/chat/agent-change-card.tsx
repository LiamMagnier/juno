"use client";

import * as React from "react";
import { AppIcons } from "@/lib/app-icons";
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
  const [open, setOpen] = React.useState(false);

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
    <div className={cn("group/receipt py-1", undone && "opacity-60", className)}>
      <div className="flex items-center gap-2.5">
        <AppIcons.agents className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
          <span className={cn(undone ? "line-through decoration-muted-foreground/50" : "text-foreground")}>
            {change.summary}
          </span>
        </p>
        {change.changes.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="shrink-0 text-caption text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {open ? "Hide" : "Details"}
          </button>
        ) : null}
        {change.eventId && !undone ? (
          <button
            type="button"
            disabled={busy}
            onClick={handleUndo}
            className="shrink-0 text-caption font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
          >
            {busy ? "Undoing…" : "Undo"}
          </button>
        ) : undone ? (
          <span className="shrink-0 text-caption text-muted-foreground">Undone</span>
        ) : null}
      </div>

      {open && change.changes.length > 0 ? (
        <dl className="mt-2 space-y-1 pl-[1.625rem]">
          {change.changes.map((item, index) => (
            <div key={`${item.label}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-caption">
              <dt className="text-muted-foreground">{item.label}</dt>
              <dd className="text-foreground">
                {item.from ? (
                  <>
                    <span className="text-muted-foreground line-through decoration-muted-foreground/40">{item.from}</span>{" "}
                    {item.to}
                  </>
                ) : (
                  item.to
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {error && (
        <p role="alert" className="mt-1.5 pl-[1.625rem] text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default AgentChangeCard;
