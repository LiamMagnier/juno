"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ArchiveRestore, CalendarClock, ChevronRight, Pin, PinOff } from "lucide-react";
import { ActionIcons, CodeIcons } from "@/lib/app-icons";
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
import type { WorkStatus } from "@/lib/work/domain";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import type { ClientWorkSession } from "@/lib/work/serializers";
import {
  patchWorkSession,
  startWorkRun,
  workIdempotencyKey,
  WORK_SYNC_EVENT,
} from "@/components/work/work-transport";
import { WorkStatusPill, workTimeAgo } from "@/components/work/work-vocabulary";
import { cadenceLine } from "@/components/work/inbox/cadence";
import {
  canRunAgain,
  quietLine,
  rowStatus,
  WORK_QUIET_AFTER_MS,
  type RowTone,
} from "@/components/work/inbox/triage";
import { cn } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";

/*
 * One task, as a line in an inbox.
 *
 * The row this replaces said three things — title, goal, status pill — and
 * optionally a fourth, a sentence about the state, which the list turned OFF
 * for finished tasks on the reasoning that the pill had already said everything.
 * That reasoning holds for a history and breaks for an inbox: a finished task is
 * precisely the one a person has to make a decision about, and "Done" is not a
 * decision aid. So the sentence is now unconditional and is the row's SPINE
 * rather than an optional extra — every row states what it is waiting for, in
 * words, all the time.
 *
 * FOUR MARKS, AND NONE OF THEM COLOUR ALONE.
 *
 *   unread     a filled dot in the gutter, plus the title in full weight and
 *              `aria-label` saying so. A dot on its own is invisible to a
 *              screen reader and to anybody who cannot separate the two greys.
 *   attention  a warm border and fill, plus the word in the pill, plus the
 *              status line in warning ink. Three signals, one meaning.
 *   live       the breathing edge, plus the pill, plus a present-tense line.
 *   scheduled  a calendar mark with the cadence spelled out beside it.
 *
 * The three things a row can DO are still the three columns
 * `PATCH /api/work/sessions/[id]` accepts — rename, pin, archive — plus one it
 * could always have offered and never did: Run again, which is
 * `POST /sessions/[id]/runs` with `origin: "retry"`. Re-running a finished task
 * from the list is the single most common thing a person wants from an inbox of
 * agent work, and making them open the task to find the button was the surface
 * charging a click for its own layout.
 *
 * The card is a div wrapping a Link rather than a Link with controls inside it.
 * A button nested in an anchor is invalid markup, and browsers resolve it by
 * navigating on the click that was meant to open the menu — which, on the
 * archive item, is the difference between "put this away" and "open the task
 * you were trying to put away".
 */

/**
 * The statuses that mean a machine is doing something right now, which is
 * narrower than `isLiveStatus` — that includes `draft`, `queued`, `paused` and
 * both `waiting_*` states, none of which are running. A breathing ring on a task
 * parked waiting for an answer would say the opposite of the truth.
 */
const EXECUTING = new Set<WorkStatus>(["preparing", "running"]);

/**
 * The status line's ink, per tone.
 *
 * `attention` and `bad` are the only two that leave muted, and they are
 * deliberately different ramps rather than one "problem" colour: a task waiting
 * for a decision is not broken, and painting it in the failure red teaches the
 * reader to ignore the failure red. Both are the AA text ramps
 * (`--warning-foreground`, `--destructive-ink`) rather than the fill tones — see
 * the textColor block in tailwind.config.ts.
 */
const TONE_INK: Record<RowTone, string> = {
  neutral: "text-muted-foreground",
  live: "text-muted-foreground",
  attention: "text-warning-foreground",
  good: "text-muted-foreground",
  bad: "text-destructive",
};

export function InboxRow({
  session,
  /** How many files this task produced, when the list has been told. */
  outputCount,
  /** The schedule driving this task, when one does. */
  schedule = null,
  /** True when this browser has not opened the task since it last moved. */
  unread = false,
  /**
   * Where this row comes in the cascade of rows that JUST ARRIVED, or `null` for
   * a row that was already on screen and must not animate at all.
   */
  enterRank = 0,
  /** The row after a change, so the list can re-render without waiting to poll. */
  onChanged,
  /** Called when the row is opened, so the list can clear its unread mark. */
  onOpen,
}: {
  session: ClientWorkSession;
  outputCount?: number;
  schedule?: ClientWorkSchedule | null;
  unread?: boolean;
  enterRank?: number | null;
  onChanged?: (session: ClientWorkSession) => void;
  onOpen?: (session: ClientWorkSession) => void;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  /*
   * The entrance is decided once, at mount, and never revisited. The list polls
   * every thirty seconds; a row that recomputed its entrance on each response
   * would twitch at the reader for as long as the page was open.
   */
  const entrance = React.useRef(enterRank);

  /*
   * The silence check needs the clock, and a clock read during render is the
   * hydration bug this codebase names by name. Read once in an effect and
   * refreshed on the list's own poll, which is what `session.lastActivityAt`
   * changing under us amounts to.
   */
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!EXECUTING.has(session.status)) {
      setNow(null);
      return;
    }
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [session.status]);

  const status = rowStatus(session, { outputCount, schedule });
  const quietMs = now === null ? 0 : now - Date.parse(session.lastActivityAt);
  const quiet = Number.isFinite(quietMs) && quietMs >= WORK_QUIET_AFTER_MS;

  const apply = React.useCallback(
    async (change: Parameters<typeof patchWorkSession>[1], failure: string) => {
      setBusy(true);
      const result = await patchWorkSession(session.id, change);
      setBusy(false);
      if (result.kind === "ok") {
        onChanged?.(result.value);
        // The sidebar and any other Work list on screen poll on this event, so a
        // pin made here reaches them now rather than in up to thirty seconds.
        window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
        return;
      }
      toast.error(
        result.kind === "blocked"
          ? result.explanation
          : result.kind === "failed" && result.cause === "not_found"
            ? "This task no longer exists. It may have been deleted from another device."
            : failure
      );
    },
    [session.id, onChanged]
  );

  /**
   * Another attempt at the same goal, from the list.
   *
   * `origin: "retry"` rather than `"manual"`, because that is what this is and
   * the distinction is recorded on the run: a retry is a second go at a goal
   * that already has a transcript, and reporting it as a first dispatch would
   * make the attempt counter on the task page lie. No `requiredCapabilities` is
   * sent — the list does not know the previous attempt's requirements, and
   * sending a guess would have the server judge the retry against a bar nobody
   * set. The task page, which does know, passes them.
   */
  const runAgain = React.useCallback(async () => {
    setBusy(true);
    const result = await startWorkRun(session.id, {
      origin: "retry",
      idempotencyKey: workIdempotencyKey(),
    });
    setBusy(false);
    if (result.kind === "ok") {
      toast.success("Started again.");
      window.dispatchEvent(new CustomEvent(WORK_SYNC_EVENT));
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t start it again. Nothing was dispatched."
    );
  }, [session.id]);

  const cadence = schedule === null ? null : cadenceLine(schedule);

  return (
    <div
      className={cn(
        "group relative flex items-start rounded-field border border-border/60 bg-card transition-[background-color,border-color,transform,opacity] duration-base ease-out-soft hover:border-border hover:bg-secondary",
        // The row's only affordance is an anchor filling it, and an anchor with
        // no visible focus ring is a keyboard user with no idea where they are.
        // Drawn on the card so it frames the whole row rather than the text.
        "[&:has(>a:focus-visible)]:ring-2 [&:has(>a:focus-visible)]:ring-ring [&:has(>a:focus-visible)]:ring-offset-2 [&:has(>a:focus-visible)]:ring-offset-background",
        "motion-safe:hover:-translate-y-px",
        "[&:has(>a:active)]:translate-y-0 motion-safe:[&:has(>a:active)]:scale-[0.997]",
        entrance.current !== null && "[animation-fill-mode:backwards] motion-safe:animate-rise-in",
        busy && "opacity-60",
        session.needsAttention && "border-warning/40 bg-warning/[0.08] hover:border-warning/60",
        EXECUTING.has(session.status) && "work-breathing"
      )}
      style={entrance.current === null ? undefined : staggerDelay(entrance.current, "tight")}
    >
      <Link
        href={`/work/${session.id}`}
        onClick={() => onOpen?.(session)}
        className="flex min-w-0 flex-1 items-start gap-2.5 rounded-field py-3 pl-3 pr-3.5 focus-visible:outline-none"
      >
        {/*
          The unread gutter. A fixed-width column rather than an inline mark, so
          every title in the list starts on the same x — a dot that pushes its
          own row's text sideways makes the list look ragged and makes the unread
          rows harder to scan, not easier.
        */}
        <span className="flex w-2 shrink-0 justify-center pt-[0.44rem]" aria-hidden="true">
          {unread && <span className="size-2 rounded-full bg-primary" />}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {session.pinned && (
              <Pin
                className="size-3 shrink-0 text-muted-foreground motion-safe:animate-pop-in"
                aria-label="Pinned"
              />
            )}
            <span
              className={cn(
                "min-w-0 truncate text-body leading-snug text-foreground",
                // Weight, not colour, carries unread on the title — the same
                // convention every mail client uses, and the one that survives
                // both themes and a monochrome display.
                unread ? "font-semibold" : "font-medium"
              )}
            >
              {session.title || "Untitled task"}
            </span>
            {/* The word "Unread" exists for a reader who cannot see the dot.
                Visually hidden rather than omitted: `sr-only` is the only way
                the dot and the announcement stay in sync automatically. */}
            {unread && <span className="sr-only">Unread</span>}
            <WorkStatusPill status={session.status} />
          </span>

          <span className="mt-1 block truncate text-ui leading-relaxed text-muted-foreground">
            {session.goal}
          </span>

          {/*
            The status line — the row's reason for existing. `role="status"` is
            deliberately NOT set here: forty live regions in one list would have
            a screen reader announce the whole page on every poll. The task page
            owns the live region for the task the reader is actually in.
          */}
          <span className={cn("mt-1.5 block text-ui leading-relaxed", TONE_INK[status.tone])}>
            {quiet ? `${status.line} ${quietLine(quietMs)}` : status.line}
          </span>

          <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-micro tabular-nums text-muted-foreground">
            <span>{workTimeAgo(session.lastActivityAt)}</span>
            {cadence !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <CalendarClock className="size-3" aria-hidden="true" />
                  {cadence}
                </span>
              </>
            )}
            {outputCount !== undefined && outputCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <CodeIcons.file className="size-3" aria-hidden="true" />
                  {outputCount === 1 ? "1 file" : `${outputCount} files`}
                </span>
              </>
            )}
          </span>
        </span>

        <ChevronRight
          className="mt-0.5 size-4 shrink-0 text-muted-foreground/70 transition-[transform,color] duration-base ease-out-soft group-hover:translate-x-0.5 group-hover:text-foreground"
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
              // Always present rather than revealed on hover: a control that only
              // exists under a pointer is a control a touch device cannot find,
              // and this is the row's only way to unpin anything.
              className="size-7 text-muted-foreground hover:text-foreground"
              aria-label={`Options for ${session.title || "this task"}`}
            >
              <ActionIcons.more className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {canRunAgain(session) && (
              <DropdownMenuItem onSelect={() => void runAgain()}>
                <ActionIcons.refresh className="text-muted-foreground" />
                <span className="flex-1">Run it again</span>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setRenaming(true)}>
              <ActionIcons.edit className="text-muted-foreground" />
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
        onRename={(title) => {
          setRenaming(false);
          void apply({ title }, "Couldn’t rename it. The old name is still in place.");
        }}
      />
    </div>
  );
}

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

  // Re-seeded whenever the dialog opens rather than held from the last time.
  // A dialog that reopens with a half-typed name from twenty minutes ago is a
  // dialog that renames things nobody meant to rename.
  React.useEffect(() => {
    if (open) setDraft(current);
  }, [open, current]);

  const trimmed = draft.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Rename this task</DialogTitle>
          <DialogDescription>
            Only the name changes. What Juno was asked to do stays as it was.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && trimmed.length > 0 && !busy) onRename(trimmed);
          }}
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
