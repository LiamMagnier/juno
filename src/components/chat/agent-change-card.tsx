"use client";

import * as React from "react";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ClientAgentChange, ClientSetupChangeRef } from "@/types/chat";
import { PRODUCT_NAME } from "@/lib/brand/names";

export function AgentChangeCard({
  change,
  onUndone,
  className,
}: {
  change: ClientAgentChange;
  onUndone?: (eventId: string) => void;
  className?: string;
}) {
  if (change.setupChange) {
    return <SetupChangeCard change={change} setup={change.setupChange} className={className} />;
  }
  return <AgentEventChangeCard change={change} onUndone={onUndone} className={className} />;
}

function AgentEventChangeCard({
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
      // The undo route takes the event in the body (`/api/agents/{id}/undo`).
      // This card used to post to a per-event path that no route serves, so
      // every Undo answered 404.
      const res = await fetch(`/api/agents/${encodeURIComponent(change.agentId)}/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventId: change.eventId }),
      });
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
      setError(`Could not reach ${PRODUCT_NAME} to undo this change.`);
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

      <ChangeRows changes={change.changes} />

      {error && (
        <p role="alert" className="mt-1.5 text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ChangeRows({ changes }: { changes: ClientAgentChange["changes"] }) {
  if (changes.length === 0) return null;
  return (
    <dl className="mt-2 space-y-1 border-t border-border/60 pt-2">
      {changes.map((item, index) => (
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
                <span className="sr-only"> to </span>
                <span className="font-medium text-foreground">{item.to}</span>
              </>
            ) : (
              <span className="font-medium text-foreground">{item.to}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The sentence the card's footer says for each status. Plain words, no badge. */
function setupStatusLine(status: string, detail: string | null | undefined): string {
  switch (status) {
    case "applied":
      return "Applied.";
    case "undone":
      return "Undone. Nothing of it is in effect.";
    case "declined":
      return detail || "You declined this change, so nothing changed.";
    case "awaiting_approval":
      return "Waiting for your approval above.";
    case "failed":
      return detail || "This change could not be saved.";
    case "proposed":
    default:
      return detail || "Not applied yet.";
  }
}

/**
 * A setup change asked for in a crew member's thread
 * (`propose_setup_change`): what changes, before → after, what it affects, and
 * Apply / Undo. The status is read live from the change's route on mount,
 * because the transcript keeps the card as it was when the reply ended.
 *
 * Apply sends the digest the server gave for this card, so a press only ever
 * applies the change the card showed. Minimal on purpose: the visual design
 * comes with the new design system.
 */
function SetupChangeCard({
  change,
  setup,
  className,
}: {
  change: ClientAgentChange;
  setup: ClientSetupChangeRef;
  className?: string;
}) {
  const [state, setState] = React.useState<ClientSetupChangeRef>(setup);
  const [busy, setBusy] = React.useState<"apply" | "undo" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const url = `/api/agents/${encodeURIComponent(change.agentId)}/setup-changes/${encodeURIComponent(setup.id)}`;

  React.useEffect(() => {
    let cancelled = false;
    void fetch(url)
      .then(async (res) => (res.ok ? ((await res.json()) as { change?: Partial<ClientSetupChangeRef> }) : null))
      .then((data) => {
        if (cancelled || !data?.change) return;
        setState((current) => ({ ...current, ...data.change }) as ClientSetupChangeRef);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);

  const act = React.useCallback(
    async (action: "apply" | "undo") => {
      if (busy) return;
      setBusy(action);
      setError(null);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(action === "apply" ? { action, digest: state.digest } : { action }),
        });
        const data = (await res.json().catch(() => null)) as { change?: Partial<ClientSetupChangeRef>; message?: string } | null;
        if (!res.ok || !data?.change) {
          setError(data?.message ?? (action === "apply" ? "Could not apply this change." : "Could not undo this change."));
          return;
        }
        setState((current) => ({ ...current, ...data.change }) as ClientSetupChangeRef);
        window.dispatchEvent(new CustomEvent("juno:agent-updated", { detail: { agentId: change.agentId } }));
      } catch {
        setError(`Could not reach ${PRODUCT_NAME}. Nothing changed.`);
      } finally {
        setBusy(null);
      }
    },
    [busy, change.agentId, state.digest, url]
  );

  const canUndo = state.status === "applied";
  const canApply = state.status === "proposed" || state.status === "declined" || state.status === "undone";

  return (
    <div className={cn("rounded-card border border-border bg-card px-3.5 py-2.5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption text-muted-foreground">
            {state.kindLabel} · {change.agentName}
          </p>
          <p className="text-label font-medium text-foreground">{change.summary}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canApply ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy !== null}
              onClick={() => void act("apply")}
              className="h-7 px-2.5 text-caption font-medium"
            >
              {busy === "apply" ? "Applying…" : "Apply"}
            </Button>
          ) : null}
          {canUndo ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void act("undo")}
              className="h-7 px-2.5 text-caption font-medium text-muted-foreground hover:text-foreground"
            >
              {busy === "undo" ? "Undoing…" : "Undo"}
            </Button>
          ) : null}
        </div>
      </div>

      <ChangeRows changes={change.changes} />

      <p className="mt-2 text-caption text-muted-foreground">{state.affects}</p>
      <p className="mt-1 text-caption text-muted-foreground">{state.directionSentence}</p>
      <p className="mt-1 text-caption text-foreground" aria-live="polite">
        {setupStatusLine(state.status, state.detail)}
      </p>

      {error && (
        <p role="alert" className="mt-1.5 text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export default AgentChangeCard;
