"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ArchiveRestore, ChevronRight, FileText, MoreHorizontal, Pencil, Pin, PinOff } from "lucide-react";
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
import type { WorkStatus } from "@/lib/work/domain";
import type { ClientWorkSession } from "@/lib/work/serializers";
import { patchWorkSession, WORK_SYNC_EVENT } from "@/components/work/work-transport";
import {
  WorkStatusPill,
  outputsLabel,
  statusActivity,
  workTimeAgo,
} from "@/components/work/work-vocabulary";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

/*
 * One task in a list, and the list itself.
 *
 * The row says what was asked for, what state it is in, and when it last moved.
 * Two of those are a status word and a timestamp, which between them do not
 * answer the question a person actually arrives with — what is this task doing —
 * so the row can say two more things when the caller knows them: what the state
 * MEANS as a sentence (`explain`), and how many files a finished task left
 * behind (`outputCount`). Both are opt-in per row rather than always on, because
 * a list where every row carries three lines of prose is a list nobody scans.
 *
 * It deliberately does NOT say where the task ran —
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
 *
 * MOTION. The row is the one part of Work that moves on its own, because it is
 * the part that changes on its own — the list behind it polls every thirty
 * seconds and a task can go from queued to done while nobody is looking at it.
 * Three treatments and no fourth:
 *
 *   arriving   `animate-rise-in` on a delay the LIST computed (see
 *              use-work-arrivals.ts), and only for rows that were not on screen
 *              a moment ago.
 *   executing  a slow breath along the row's edge for as long as it is running.
 *   changing   the status pill re-enters when the status underneath it changes.
 *
 * All three are declared in globals.css under "Work", which is also where the
 * argument for each duration lives.
 */

/**
 * The statuses that mean a machine is doing something right now, which is
 * narrower than `isLiveStatus` — that includes `draft`, `queued`, `paused` and
 * both `waiting_*` states, none of which are running. A breathing ring on a task
 * that is parked waiting for an answer would say the opposite of the truth, and
 * "Needs you" is a section of rows in exactly that state.
 */
const EXECUTING = new Set<WorkStatus>(["preparing", "running"]);

export function WorkSessionRow({
  session,
  /**
   * Renders what the task is doing as a sentence underneath.
   *
   * Set for the groups where the status word is not the whole story: the ones
   * waiting on a person, and the ones that are supposed to be executing — where
   * `statusActivity` will also say so if nothing has been recorded for a while.
   * Left off for finished tasks, whose pill has already said everything a list
   * row can honestly say about them.
   */
  explain = false,
  /**
   * How many files this task produced, when that is known.
   *
   * Undefined and 0 both render nothing, and they are the same instruction on
   * purpose: the count comes from a capped list (see `fetchWorkOutputCounts`),
   * so "not in the list" and "none" are indistinguishable from here. The row is
   * allowed to state a count it was given and is not allowed to state an
   * absence, which is why there is no "no files" branch below.
   */
  outputCount,
  /**
   * How long this row should wait before it arrives, or `null` for a row that
   * was already on screen and must not animate at all.
   *
   * A delay, not an index. The row's position in the list is the wrong number:
   * one new task landing at position seven is one thing arriving on an otherwise
   * still page, and making it wait 210ms for six rows that are not moving reads
   * as a dropped frame. Its position among the rows that just arrived is the
   * right number, and only the list can know that — see `useWorkArrivals`.
   */
  enterDelayMs = 0,
  /**
   * The row after a change, so the list it lives in can re-render without
   * waiting for its own poll. Optional: a caller with no list to update — the
   * thread page's header, say — has nothing useful to do with it.
   */
  onChanged,
}: {
  session: ClientWorkSession;
  explain?: boolean;
  outputCount?: number;
  enterDelayMs?: number | null;
  onChanged?: (session: ClientWorkSession) => void;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  /*
   * The entrance is decided once, at mount, and never revisited.
   *
   * `enterDelayMs` goes to `null` on the first poll after this row arrived,
   * which is correct as an answer to "is this row new" and wrong as a class to
   * put on the element: removing the animation from a row still playing it
   * snaps it to its final frame mid-flight. Polls are thirty seconds apart so
   * this would be rare, but WORK_SYNC_EVENT fires whenever any Work surface
   * changes anything, and "I archived something and the row above it flinched"
   * is the sort of bug nobody reports and everybody feels. Arriving is a fact
   * about mounting; freezing it in a ref is what makes it one.
   */
  const entrance = React.useRef(enterDelayMs);

  /*
   * A status pill only animates for a status that changed WHILE THE ROW WAS
   * WATCHED. On first mount the pill is not a change, it is the initial fact,
   * and playing it inside a row that is itself rising in is two entrances for
   * one arrival.
   *
   * The `key` on the pill is what replays it: the class alone would be added
   * once and then sit there inert through every later change, because a CSS
   * animation runs when an element mounts, not when its className is
   * recomputed. Remounting on the status is both the trigger and the truth —
   * a different status genuinely is a different pill.
   */
  const firstStatus = React.useRef(session.status);
  const statusChanged = session.status !== firstStatus.current;

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
        "group relative flex items-start rounded-field border border-border/60 bg-card/60 transition-[background-color,border-color,transform,opacity] duration-base ease-out-soft hover:border-border hover:bg-card",
        // The lift is a single pixel. The row is the full width of the column,
        // and a card that wide moving any further stops reading as "under your
        // pointer" and starts reading as "leaving the page".
        "motion-safe:hover:-translate-y-px",
        // Press feedback comes off the LINK specifically, not the card, so that
        // pressing the options button — a sibling in its own div, deliberately
        // outside the anchor — does not dip the whole row as if it had been
        // opened. `.pressable`'s 0.97 is for chips and buttons; at this width it
        // is a wobble, so the row gets a tenth of it and gives back the lift.
        "[&:has(>a:active)]:translate-y-0 motion-safe:[&:has(>a:active)]:scale-[0.997]",
        entrance.current !== null && "[animation-fill-mode:backwards] motion-safe:animate-rise-in",
        // A row whose change is still in flight. Not a spinner and not a
        // disabled state — the row is still a link, and the request usually
        // lands before this is consciously seen; it exists so a slow network
        // shows that the press was received rather than ignored.
        busy && "opacity-60",
        session.needsAttention && "border-warning/40 bg-warning/[0.04] hover:border-warning/60",
        // The breath is a box-shadow, and it lives in @layer components — so a
        // `shadow-*` utility added to this row later would win the cascade and
        // silently switch it off, wherever in this list it were written. If this
        // row ever needs elevation, the breath has to move into the shadow.
        EXECUTING.has(session.status) && "work-breathing"
      )}
      style={entrance.current === null ? undefined : { animationDelay: `${entrance.current}ms` }}
    >
      <Link href={`/work/${session.id}`} className="flex min-w-0 flex-1 items-start gap-3 px-3.5 py-3">
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {session.pinned && (
              // The pop plays exactly when the icon appears and never again,
              // because that is when this element mounts — pinning is the only
              // thing that brings it into existence. No state needed.
              <Pin
                className="h-3 w-3 shrink-0 text-muted-foreground motion-safe:animate-pop-in"
                aria-label="Pinned"
              />
            )}
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {session.title || "Untitled task"}
            </span>
            <WorkStatusPill
              key={session.status}
              status={session.status}
              // Not `motion-safe:` — that variant only exists for classes
              // Tailwind generates, and this one is hand-written in globals.css,
              // so the prefix would silently produce nothing at all. The
              // keyframe uses `both` fill mode, which means the app-wide reduce
              // rule (animation-duration: 0.001ms) leaves it parked on its final
              // frame — a settled, fully opaque pill — which is exactly right.
              className={cn(statusChanged && "work-status-shift")}
            />
          </span>
          <span className="mt-1 block truncate text-[13px] leading-relaxed text-muted-foreground">
            {session.goal}
          </span>
          {explain && (
            <span
              className={cn(
                "mt-1.5 block text-[12.5px] leading-relaxed",
                // The warning ink is spent only on the rows that are actually
                // holding a decision. A running task explained in the same
                // colour as a task that has stopped and cannot move would make
                // the two look like one problem, and there are far more of the
                // first kind.
                session.needsAttention ? "text-warning-foreground" : "text-muted-foreground"
              )}
            >
              {statusActivity(session.status, session.lastActivityAt)}
            </span>
          )}
          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-muted-foreground/70">
            <span>{workTimeAgo(session.lastActivityAt)}</span>
            {outputCount !== undefined && outputCount > 0 && (
              <>
                {/* A separator rather than a second line: this is metadata about
                    the same task at the same weight, and giving files a row of
                    their own would rank them above the goal. */}
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <FileText className="h-3 w-3" aria-hidden="true" />
                  {outputsLabel(outputCount)}
                </span>
              </>
            )}
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
          className="h-[86px] w-full rounded-field"
          style={staggerDelay(index, "tight")}
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
  /**
   * Overrides the gap above. The default is the rhythm the Work home is set in
   * and is what every caller should want; it is overridable because a stack of
   * these under a shared heading needs a smaller first gap than a section
   * standing on its own.
   */
  className,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn("mt-9", className)}>
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
