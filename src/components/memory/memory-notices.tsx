"use client";

import * as React from "react";
import { Loader2, MessagesSquare, PauseCircle } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Progress } from "@/components/ui/progress";

/*
 * The page's announcements: memory is off, a policy refused the work, Juno is
 * reading your older chats, or there is unread history worth reading.
 *
 * One shape for all four, a flat tonal band under the header, because they
 * are the same kind of sentence: a state of the whole page, and at most one
 * thing to do about it. Paused used to be told a different way in five places
 * (a dimmed summary, a badge, "Not in use" on every row, disabled buttons and a
 * switch at the bottom); it is one band now, and the rest of the page stays
 * readable. Each band unfolds and folds with the state it reports.
 */

function Notice({
  icon,
  children,
  action,
  live = false,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
  /** Announce changes: the band reports something that happened, not a standing state. */
  live?: boolean;
}) {
  return (
    <div
      role={live ? "status" : undefined}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-card bg-secondary px-4 py-3 text-ui text-foreground"
    >
      <span className="flex min-w-0 flex-1 items-start gap-2.5">
        <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        <span className="min-w-0">{children}</span>
      </span>
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  );
}

export function PausedNotice({ open, onTurnOn }: { open: boolean; onTurnOn: () => void }) {
  return (
    <Collapse open={open} innerClassName="pb-4">
      <Notice
        icon={<PauseCircle className="size-4" aria-hidden="true" />}
        action={
          <Button size="sm" variant="outline" onClick={onTurnOn}>
            Turn on
          </Button>
        }
      >
        <span className="font-medium">Memory is off.</span>{" "}
        <span className="text-muted-foreground">Juno isn’t using or saving memories. What’s here is kept.</span>
      </Notice>
    </Collapse>
  );
}

export function PolicyNotice({ message, onOpenSettings }: { message: string | null; onOpenSettings: () => void }) {
  return (
    <Collapse open={!!message} innerClassName="pb-4">
      <Notice
        live
        icon={<StatusIcons.info className="size-4" aria-hidden="true" />}
        action={
          <Button size="sm" variant="outline" onClick={onOpenSettings}>
            Background processing
          </Button>
        }
      >
        <span className="text-muted-foreground">{message}</span>
      </Notice>
    </Collapse>
  );
}

/**
 * Reading older chats. While it runs the band shows the job's progress; when
 * memory is thin and history is unread, it offers the job (the manager decides
 * "thin"). It never shows both, and never while memory is off.
 */
export function BackfillNotice({
  running,
  offer,
  remaining,
  total,
  onRun,
}: {
  running: boolean;
  offer: boolean;
  remaining: number;
  total: number;
  onRun: () => void;
}) {
  const done = Math.max(0, total - remaining);
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <Collapse open={running || offer} innerClassName="pb-4">
      {running ? (
        <Notice live icon={<Loader2 className="size-4 animate-spin" aria-hidden="true" />}>
          <span className="font-medium">Reading your past chats.</span>{" "}
          <span className="text-muted-foreground">You can leave this page; Juno picks up where it left off.</span>
          <Progress value={pct} aria-label="Past chats read" className="mt-2.5 h-1.5 max-w-xs" />
        </Notice>
      ) : (
        <Notice
          icon={<MessagesSquare className="size-4" aria-hidden="true" />}
          action={
            <Button size="sm" variant="outline" onClick={onRun}>
              Learn from them
            </Button>
          }
        >
          <span className="font-medium">
            {remaining === 1 ? (
              <span>1 past chat hasn’t been read yet.</span>
            ) : (
              <>
                <span className="tabular-nums">{remaining}</span> <span>past chats haven’t been read yet.</span>
              </>
            )}
          </span>{" "}
          <span className="text-muted-foreground">Juno can learn from them now.</span>
        </Notice>
      )}
    </Collapse>
  );
}
