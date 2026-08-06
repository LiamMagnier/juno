"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ChevronRight, MoreHorizontal, Pencil, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ClientWorkSession } from "@/lib/work/serializers";
import { patchWorkSession, WORK_SYNC_EVENT } from "@/components/work/work-transport";
import { WorkStatusPill, statusSentence, workTimeAgo } from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";

/*
 * One task in a list, and the list itself.
 *
 * The row says three things and stops: what was asked for, what state it is in,
 * and when it last moved. It deliberately does NOT say where the task ran —
 * the session row only knows the target that was *requested*, and a row reading
 * "Cloud" for a task that was actually substituted onto a Mac (or refused
 * outright) is the kind of confident wrong detail this whole surface exists to
 * avoid. Where it really ran is a fact about the run, and the run is one click
 * away.
 *
 * The three things a row can DO — rename, pin, archive — are the three columns
 * `PATCH /api/work/sessions/[id]` accepts and the list query already filters on.
 * They were settable by every client except this one, which meant a task pinned
 * on the Mac showed here as an ordinary row the user had no way to unpin.
 *
 * The card is a div wrapping a Link rather than a Link with controls inside it.
 * A button nested in an anchor is invalid markup, and browsers resolve it by
 * navigating on the click that was meant to open the menu — which, on the
 * archive item, is the difference between "put this away" and "open the task
 * you were trying to put away".
 */

export function WorkSessionRow({
  session,
  /** Renders the status as prose underneath — used by "Needs you". */
  explain = false,
  index = 0,
  /**
   * The row after a change, so the list it lives in can re-render without
   * waiting for its own poll. Optional: a caller with no list to update — the
   * thread page's header, say — has nothing useful to do with it.
   */
  onChanged,
}: {
  session: ClientWorkSession;
  explain?: boolean;
  index?: number;
  onChanged?: (session: ClientWorkSession) => void;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const apply = React.useCallback(
    async (
      change: { title: string } | { pinned: boolean } | { archived: boolean },
      failure: string
    ) => {
      setBusy(true);
      const result = await patchWorkSession(session.id, change);
      setBusy(false);
      if (result.kind === "ok") {
        onChanged?.(result.value);
        // The sidebar and any other mounted Work surface poll on their own
        // clock, so without this a task archived here stays in the list beside
        // it for up to thirty seconds.
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return true;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : result.kind === "failed" && result.cause === "not_found"
            ? "This task no longer exists. It may have been deleted from another device."
            : failure
      );
      return false;
    },
    [session.id, onChanged]
  );

  return (
    <div
      className={cn(
        "group relative flex items-start rounded-xl border border-border/60 bg-card/60 transition-[background-color,border-color,transform] duration-base ease-out-soft hover:border-border hover:bg-card motion-safe:animate-rise-in",
        "[animation-fill-mode:backwards]",
        session.needsAttention && "border-warning/40 bg-warning/[0.04] hover:border-warning/60"
      )}
      style={{ animationDelay: `${index * 30}ms` }}
    >
      <Link href={`/work/${session.id}`} className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {session.pinned && (
              <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Pinned" />
            )}
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {session.title || "Untitled task"}
            </span>
            <WorkStatusPill status={session.status} />
          </span>
          <span className="mt-1 block truncate text-[13px] leading-relaxed text-muted-foreground">
            {session.goal}
          </span>
          {explain && (
            <span className="mt-1.5 block text-[12.5px] leading-relaxed text-warning-foreground">
              {statusSentence(session.status)}
            </span>
          )}
          <span className="mt-1.5 block font-mono text-[10px] text-muted-foreground/70">
            {workTimeAgo(session.lastActivityAt)}
          </span>
        </span>
        <ChevronRight
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform duration-base ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground"
          aria-hidden="true"
        />
      </Link>

      <div className="shrink-0 py-2 pr-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={busy}
              // Always present rather than revealed on hover: a control that
              // only exists under a pointer is a control a touch device cannot
              // find at all, and this is the row's only way to unpin anything.
              className="h-7 w-7 text-muted-foreground/60 hover:text-foreground"
              aria-label={`Options for ${session.title || "this task"}`}
            >
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <Pencil className="text-muted-foreground" />
              <span className="flex-1">Rename</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void apply({ pinned: !session.pinned }, "Couldn’t change that. Nothing was pinned.")
              }
            >
              {session.pinned ? (
                <PinOff className="text-muted-foreground" />
              ) : (
                <Pin className="text-muted-foreground" />
              )}
              <span className="flex-1">{session.pinned ? "Unpin" : "Pin to the top"}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void apply(
                  { archived: !session.archived },
                  "Couldn’t change that. The task is where it was."
                )
              }
            >
              {session.archived ? (
                <ArchiveRestore className="text-muted-foreground" />
              ) : (
                <Archive className="text-muted-foreground" />
              )}
              <span className="flex-1">{session.archived ? "Bring back" : "Archive"}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <RenameDialog
        open={renaming}
        busy={busy}
        current={session.title}
        onOpenChange={setRenaming}
        onRename={async (title) => {
          const ok = await apply({ title }, "Couldn’t rename this. The old name still stands.");
          if (ok) setRenaming(false);
        }}
      />
    </div>
  );
}

/**
 * Renaming, with the one thing the route will not accept ruled out in the form.
 *
 * `patchSessionSchema` requires a title of at least one character after
 * trimming, so an empty box is a 400 the user reads as a bug. The button is
 * disabled instead, which says the same thing before the request rather than
 * after it.
 */
function RenameDialog({
  open,
  busy,
  current,
  onOpenChange,
  onRename,
}: {
  open: boolean;
  busy: boolean;
  current: string;
  onOpenChange: (open: boolean) => void;
  onRename: (title: string) => void;
}) {
  const [draft, setDraft] = React.useState(current);

  // Re-seeded each time the dialog opens rather than held across opens: a title
  // changed on another device would otherwise be silently overwritten by
  // whatever was in this box the last time it was closed without saving.
  React.useEffect(() => {
    if (open) setDraft(current);
  }, [open, current]);

  const trimmed = draft.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Rename this task</DialogTitle>
          <DialogDescription>
            The name is yours from here on — Juno stops re-titling a task once you have named it.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && trimmed.length > 0 && !busy) onRename(trimmed);
          }}
          disabled={busy}
          aria-label="Task name"
          autoFocus
        />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => onRename(trimmed)} disabled={busy || trimmed.length === 0}>
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The list's own loading state — never a spinner, per the page idiom. */
export function WorkSessionSkeletons({ count = 3 }: { count?: number }) {
  return (
    <div className="space-y-2.5">
      {[...Array(count)].map((_, index) => (
        <Skeleton
          key={index}
          className="h-[86px] w-full rounded-xl"
          style={{ animationDelay: `${index * 70}ms` }}
        />
      ))}
    </div>
  );
}

/** A section header in the Work home column. */
export function WorkSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-9">
      <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-mono text-label text-muted-foreground">{title}</h2>
          {hint && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground/80">{hint}</p>}
        </div>
        {action != null && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
