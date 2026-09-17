"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Pressable } from "@/components/ui/pressable";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { parseUnifiedDiff, type DiffRow } from "@/components/aicss/file-diff";
import { setPendingCodePrompt } from "@/lib/code-session-handoff";
import { ActionIcons, AppIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { classifyRisk, RISK_META } from "@/lib/code-runs";
import {
  buildReviewBundle,
  clearReviewDraft,
  readReviewDraft,
  reviewDraftSize,
  SEVERITIES,
  writeReviewDraft,
  type ReviewNote,
  type Severity,
  type Verdict,
} from "@/lib/code-review-notes";
import { pullRequestBlocker, type PullRequestMode, type PullRequestSubject } from "@/lib/code-pull-request";
import { cn } from "@/lib/utils";
import type { RunDetail, RunFile } from "@/components/code/use-code-runs";

/*
 * THE REVIEW PANE — A PANE, NEVER A MODAL, AND THE REASONS ARE BOTH PRACTICAL.
 *
 * A modal review dialog forces the reader to choose between the diff and the
 * thing they are reading it against. Every product that got this right
 * independently arrived at the same arrangement: files on one side, changes on
 * the other, the surface that sent you here still on screen. Below 52rem of
 * content column there is no room for that, so the pane covers — but it is
 * still not a dialog: it traps no focus and it makes no claim that the page
 * behind it is unusable.
 *
 * ── TWO PLACEMENTS, ONE PANE ───────────────────────────────────────────────
 *
 * `page` is the original: a card that covers below 52rem and docks beside the
 * run list above it, positioning itself. `dock` is the session view, where the
 * diff is a THIRD COLUMN beside the transcript, the thought dock and the
 * canvas — and there the parent owns the width, the border and the entrance,
 * exactly as it does for the other two. So the pane draws no geometry of its
 * own in that mode. A second copy of this component behind a breakpoint would
 * be two review panes that drift; a placement flag is the same element in both
 * arrangements.
 *
 * ── WHAT THIS PANE CAN AND CANNOT DO, STATED ONCE ──────────────────────────
 *
 * It cannot apply, stage, revert or land anything. The browser has no checkout;
 * the changes live on a Mac or on a cloud machine that has already pushed them.
 * So the vocabulary here is deliberately about JUDGEMENT rather than about
 * writes: a file is marked "Looks right" or "Needs a change", a line gets a
 * note, and all of it bundles into the next instruction the agent receives.
 *
 * That distinction is the whole reason the buttons are not called Accept and
 * Reject. An Accept button that does not accept anything is the single most
 * expensive lie a review surface can tell, and the category is already full of
 * surfaces where accept-all and reject-all are the only granularity on offer.
 * Per-file and per-line is what is actually useful, and it is what an agent can
 * act on when the notes reach it.
 */

/** Rendered lines per file before the tail is folded behind a button. */
const RENDER_LINE_CAP = 400;

type Scope = "last-turn" | "everything";

/**
 * The run this pane is reviewing, narrowed to what it actually reads.
 *
 * It used to take a whole `CodeRun`, which the run list has and the session
 * view does not — a session knows its conversation and its newest task, not a
 * list row. Narrowing the prop is what lets one pane serve both callers; a
 * `CodeRun` still satisfies it structurally, so the list's call site is
 * unchanged.
 */
export interface ReviewSubject {
  id: string;
  title: string;
  conversationId: string | null;
}

/**
 * Where the bundled notes go, and what the button therefore promises.
 *
 * Absent (the run list) the pane parks the bundle in the session hand-off and
 * navigates — the reader is not in the session, so opening it IS the delivery.
 * Present (the session view) the notes join the composer's review tray and the
 * reader sends them with whatever else they want to say, which is the whole
 * point of notes that queue into the next message: nothing is auto-sent, and a
 * review is never an instruction nobody pressed send on.
 */
export type QueueNotes = (bundle: string) => void;

export function RunReviewPane({
  run,
  detail,
  onClose,
  placement = "page",
  onQueueNotes,
  pullRequest,
}: {
  run: ReviewSubject;
  detail: RunDetail;
  onClose: () => void;
  /** "page" positions itself beside a list; "dock" fills the column it is given. */
  placement?: "page" | "dock";
  /** See `QueueNotes`. Absent falls back to the hand-off + navigate. */
  onQueueNotes?: QueueNotes;
  /** The Create PR control's subject, or null where the pane has no task to act on. */
  pullRequest?: { taskId: string; subject: PullRequestSubject; onOpened: (url: string) => void } | null;
}) {
  const router = useRouter();
  const [scope, setScope] = React.useState<Scope>("last-turn");
  const [activePath, setActivePath] = React.useState<string | null>(null);
  /*
   * NOTES OUTLIVE THE PANE. They were component state, the pane unmounts on
   * close, and a reader who closed it to check something lost every note
   * with no warning. Now they are read back from localStorage for this run
   * (the pane is keyed by run id where it is mounted, so this initialiser
   * runs per run), written on every change, and cleared only once they have
   * been sent. Per browser, like a draft. See lib/code-review-notes.ts.
   */
  const [notes, setNotes] = React.useState<ReviewNote[]>(() => readReviewDraft(run.id).notes);
  const [verdicts, setVerdicts] = React.useState<Record<string, Verdict>>(() => readReviewDraft(run.id).verdicts);
  const [drafting, setDrafting] = React.useState<{ path: string; line: number | null } | null>(null);
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    writeReviewDraft(run.id, { notes, verdicts });
  }, [run.id, notes, verdicts]);

  /*
   * "LAST TURN" IS THE HIGHEST-VALUE CONTROL ON THIS PANE.
   *
   * A run that has been going for three instructions has touched files from all
   * three, and a reader opening the diff after the third cannot tell which is
   * which. The scope names what they almost always mean — "what did it just do"
   * — without misrepresenting the repository: nothing here claims to be the
   * working tree, a commit, or a branch, because the browser cannot see any of
   * those. It is the event log, sliced at the last instruction.
   *
   * The control only appears once a turn boundary actually exists. Offering
   * "Last turn" on a single-turn run is a choice between a thing and itself.
   */
  const canScope = detail.hasTurnBoundary && detail.files.some((f) => !f.fromLastTurn);
  const files = React.useMemo(
    () => (canScope && scope === "last-turn" ? detail.files.filter((f) => f.fromLastTurn) : detail.files),
    [canScope, detail.files, scope],
  );

  // Keep a selection alive across scope changes when the file survives the
  // filter; otherwise fall to the first file rather than to an empty pane.
  React.useEffect(() => {
    if (files.length === 0) {
      setActivePath(null);
      return;
    }
    setActivePath((current) => (current && files.some((f) => f.path === current) ? current : files[0].path));
  }, [files]);

  const active = files.find((f) => f.path === activePath) ?? null;
  const risk = React.useMemo(() => classifyRisk(files), [files]);
  const added = files.reduce((sum, f) => sum + f.added, 0);
  const removed = files.reduce((sum, f) => sum + f.removed, 0);

  const addNote = (note: Omit<ReviewNote, "id">) => {
    setNotes((prev) => [...prev, { ...note, id: `${note.path}:${note.line ?? "file"}:${prev.length}` }]);
    setDrafting(null);
  };

  /**
   * Hand the whole review to the run.
   *
   * Two destinations, one bundle (`buildReviewBundle`). In the session the
   * notes join the composer's review tray and wait there for the reader to
   * press send — a review is a draft instruction, and sending it for them would
   * dispatch words they had not finished thinking. From the run list there is
   * no composer on screen, so the bundle is parked in the hand-off the New
   * session screen already uses and the session picks it up. Either way the
   * notes travel the path a typed instruction would, so a review cannot ask for
   * something the composer could not have asked for.
   */
  const deliverNotes = () => {
    const bundle = buildReviewBundle({ notes, verdicts }, { scopedToLastTurn: scope === "last-turn" && canScope });
    if (!bundle) return;
    if (onQueueNotes) {
      onQueueNotes(bundle);
      clearReviewDraft(run.id);
      setNotes([]);
      setVerdicts({});
      return;
    }
    if (!run.conversationId) return;
    setSending(true);
    setPendingCodePrompt(run.conversationId, bundle);
    // Sent means handed to the composer's own hand-off, which is durable;
    // the draft has done its job.
    clearReviewDraft(run.id);
    router.push(`/chat/${run.conversationId}`);
  };

  const pending = reviewDraftSize({ notes, verdicts });
  // The tray is in this same view, so the session can always take the notes;
  // the hand-off needs somewhere to hand them to.
  const canSend = pending > 0 && (!!onQueueNotes || !!run.conversationId);

  // Closing with unsent notes is not a loss any more — say so, quietly,
  // rather than blocking the close with a dialog over a draft that is kept.
  const close = () => {
    if (pending > 0) {
      toast.message(`Kept ${pending} unsent ${pending === 1 ? "note" : "notes"} for this run.`, {
        description: "They will be here when you open the review again.",
      });
    }
    onClose();
  };

  return (
    <aside
      aria-label={`Review changes from ${run.title}`}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden",
        placement === "dock"
          ? // A COLUMN THE PARENT SIZED. In the session view this sits beside
            // the transcript exactly as the thought dock and the canvas do, and
            // those two take their width, their border and their entrance from
            // the wrapper the view puts them in — so this must not fight for
            // any of the three. `bg-card` is the one thing it still owns: it is
            // what makes the column read as a surface rather than as a hole in
            // the transcript, and it is the same fill the thought dock uses.
            "h-full w-full bg-card"
          : cn(
              // Below 52rem of CONTENT COLUMN the pane covers, because two
              // columns do not fit; from there it is an ordinary column beside
              // the list, which stays readable. 52rem is what both halves need
              // — the 27rem pane, ~22rem of run row and the 1.25rem gap, plus
              // the gutter — and it is the column's width, not the window's:
              // `lg:` docked the pane at a 1024 window, where with the sidebar
              // out the column is 720 and the rows beside a 432px pane were
              // 220px wide. One element in both cases — a second copy behind a
              // breakpoint is two panes that drift. Full-bleed it is the page's
              // own ground; beside the list it is a raised card, the same
              // material as every other card in the product.
              "surface-raised fixed inset-0 z-modal",
              // `sticky` once docked so the pane stays put while the run list
              // scrolls past it — a review pane that scrolls away is a modal
              // with extra steps, and the whole reason it is not a modal is
              // that both halves have to stay on screen together.
              "@[52rem]/page:sticky @[52rem]/page:top-4 @[52rem]/page:z-auto @[52rem]/page:h-[calc(100dvh-9rem)] @[52rem]/page:w-[27rem] @[52rem]/page:shrink-0 @[52rem]/page:rounded-card",
            ),
      )}
    >
      <header className="flex items-start gap-3 border-b border-border/60 px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-label text-muted-foreground">Review</p>
          <h2 className="mt-1 truncate text-ui font-semibold">{run.title}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
            <span className="font-mono tabular-nums">
              <span className="text-success">+{added}</span>{" "}
              <span className="text-destructive">−{removed}</span>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close review">
          <ActionIcons.dismiss className="size-4" aria-hidden="true" />
        </Button>
      </header>

      {pullRequest && (
        <CreatePullRequest
          taskId={pullRequest.taskId}
          subject={pullRequest.subject}
          onOpened={pullRequest.onOpened}
        />
      )}

      {canScope && (
        <div className="border-b border-border/60 px-4 py-2.5">
          <SegmentedControl<Scope>
            value={scope}
            onChange={setScope}
            ariaLabel="Which changes to show"
            options={[
              { value: "last-turn", label: "Last turn" },
              { value: "everything", label: "Everything" },
            ]}
            className="w-full"
            optionClassName="flex-1 justify-center"
          />
          <p className="mt-2 text-caption text-muted-foreground">
            {scope === "last-turn"
              ? "Only what the agent changed after your most recent instruction."
              : "Every file this run has touched since it started."}
          </p>
        </div>
      )}

      {detail.loading ? (
        <div className="flex flex-1 items-center justify-center p-8">
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />
          <span className="sr-only">Loading changes</span>
        </div>
      ) : files.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
          <CodeIcons.file className="size-5 text-muted-foreground" aria-hidden="true" />
          <p className="text-ui font-medium">No file changes reported</p>
          <p className="max-w-xs text-caption text-muted-foreground">
            {canScope && scope === "last-turn"
              ? "Nothing changed after your last instruction. Switch to Everything to see earlier turns."
              : "This run did not report changing any files. It may have been a question rather than a task."}
          </p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* The risk verdict rides at the top of the pane as well as on the
              receipt, because a reader who opened the diff directly never saw
              the receipt and still deserves the reasons. */}
          <div className="border-b border-border/60 px-4 py-2.5">
            <RiskLine risk={risk} />
          </div>

          {/*
            THE FILE PICKER IS NEVER THE THING THAT GETS TRIMMED.
            Large diffs make products do one of two things, and only one of them
            is acceptable: limiting how much of a file is RENDERED costs a click,
            while limiting which files can be REACHED hides the change. So the
            picker below lists every file at every size, and the cap lives on the
            diff body alone.
          */}
          <div className="shrink-0 border-b border-border/60">
            <ScrollFade viewportClassName="max-h-40 px-2 py-2" className="min-h-0">
              <ul role="list" aria-label={`${files.length} changed files`} className="space-y-0.5">
                {files.map((file) => (
                  <li key={file.path}>
                    <FileRow
                      file={file}
                      active={file.path === activePath}
                      verdict={verdicts[file.path]}
                      noteCount={notes.filter((n) => n.path === file.path).length}
                      onSelect={() => setActivePath(file.path)}
                      onVerdict={(next) =>
                        setVerdicts((prev) => {
                          const copy = { ...prev };
                          if (copy[file.path] === next) delete copy[file.path];
                          else copy[file.path] = next;
                          return copy;
                        })
                      }
                    />
                  </li>
                ))}
              </ul>
            </ScrollFade>
          </div>

          <ScrollFade viewportClassName="p-3" className="min-h-0 flex-1">
            {active ? (
              <FileDiffBody
                file={active}
                notes={notes.filter((n) => n.path === active.path)}
                drafting={drafting?.path === active.path ? drafting.line : undefined}
                onDraft={(line) => setDrafting({ path: active.path, line })}
                onCancelDraft={() => setDrafting(null)}
                onAddNote={(severity, body) => addNote({ path: active.path, line: drafting?.line ?? null, severity, body })}
                onRemoveNote={(id) => setNotes((prev) => prev.filter((n) => n.id !== id))}
              />
            ) : null}
          </ScrollFade>
        </div>
      )}

      <footer className="shrink-0 border-t border-border/60 px-4 py-3">
        {onQueueNotes || run.conversationId ? (
          <>
            <Button className="w-full gap-1.5" disabled={!canSend || sending} onClick={deliverNotes}>
              {sending ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <ActionIcons.share className="size-3.5" aria-hidden="true" />
              )}
              {/* The verb names what actually happens. In the session the notes
                  land in the composer and WAIT — calling that "send" would be a
                  button that dispatched an instruction nobody pressed send on,
                  which is the exact behaviour this rework replaced. */}
              {pending === 0
                ? onQueueNotes
                  ? "Add your review to the next message"
                  : "Send review to the run"
                : onQueueNotes
                  ? `Add ${pending} ${pending === 1 ? "note" : "notes"} to your next message`
                  : `Send ${pending} ${pending === 1 ? "note" : "notes"} to the run`}
            </Button>
            <p className="mt-2 text-center text-caption text-muted-foreground">
              {onQueueNotes
                ? "They wait in the composer until you send — add anything else you want to say first."
                : "Opens the session with your notes as the next instruction."}
            </p>
          </>
        ) : (
          // A run started outside the web has no conversation to reply into.
          // Saying so is better than a disabled button with no explanation —
          // the reader would assume the feature is broken rather than absent.
          <p className="text-center text-caption text-muted-foreground">
            This run was started outside Juno on the web, so there is no session here to reply into.
            Open it on the machine that started it to respond.
          </p>
        )}
      </footer>
    </aside>
  );
}

/* ── File picker row ──────────────────────────────────────────────────────── */

function FileRow({
  file,
  active,
  verdict,
  noteCount,
  onSelect,
  onVerdict,
}: {
  file: RunFile;
  active: boolean;
  verdict: Verdict | undefined;
  noteCount: number;
  onSelect: () => void;
  onVerdict: (verdict: Verdict) => void;
}) {
  // The path's last segment is what a reader scans for; the directory is
  // context. Splitting them lets the filename stay legible while the folder
  // truncates from the left, which is the half that is safe to lose.
  const slash = file.path.lastIndexOf("/");
  const dir = slash === -1 ? "" : file.path.slice(0, slash + 1);
  const name = slash === -1 ? file.path : file.path.slice(slash + 1);

  return (
    <div className="flex items-center gap-1">
      <Pressable
        kind="row"
        size="sm"
        selected={active}
        aria-current={active ? "true" : undefined}
        onClick={onSelect}
        className="min-w-0 flex-1 justify-start gap-2 rounded-control"
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-0 font-mono text-caption">
          {dir && <span className="truncate text-muted-foreground">{dir}</span>}
          <span className="shrink-0 text-foreground">{name}</span>
        </span>
        {noteCount > 0 && (
          <span className="shrink-0 rounded-full bg-primary/15 px-1.5 font-mono text-caption text-primary">
            {noteCount}
            <span className="sr-only"> notes on this file</span>
          </span>
        )}
        <span className="shrink-0 font-mono text-caption tabular-nums">
          <span className="text-success">+{file.added}</span>{" "}
          <span className="text-destructive">−{file.removed}</span>
        </span>
      </Pressable>
      {/*
        PER-FILE, WHICH IS THE POINT. Accept-all / reject-all as the only
        granularity is an open gap across this whole category; a reader who is
        happy with four files out of five has no way to say so, and ends up
        writing it in prose. Both buttons are toggles, so a mis-click costs one
        click back, and neither claims to change the code.
      */}
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Mark ${name} as looking right`}
          aria-pressed={verdict === "ok"}
          onClick={() => onVerdict("ok")}
          className={cn("size-7", verdict === "ok" && "bg-success/15 text-success")}
        >
          <StatusIcons.success className="size-3.5" aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Mark ${name} as needing a change`}
          aria-pressed={verdict === "change"}
          onClick={() => onVerdict("change")}
          className={cn("size-7", verdict === "change" && "bg-warning/15 text-warning")}
        >
          <StatusIcons.warning className="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

/* ── Diff body ────────────────────────────────────────────────────────────── */

function FileDiffBody({
  file,
  notes,
  drafting,
  onDraft,
  onCancelDraft,
  onAddNote,
  onRemoveNote,
}: {
  file: RunFile;
  notes: ReviewNote[];
  /** The line currently being annotated — `undefined` when nothing is. */
  drafting: number | null | undefined;
  onDraft: (line: number | null) => void;
  onCancelDraft: () => void;
  onAddNote: (severity: Severity, body: string) => void;
  onRemoveNote: (id: string) => void;
}) {
  const [showAll, setShowAll] = React.useState(false);
  React.useEffect(() => setShowAll(false), [file.path]);

  const rows = React.useMemo(() => (file.patch ? parseUnifiedDiff(file.patch) : []), [file.patch]);
  const visible = showAll ? rows : rows.slice(0, RENDER_LINE_CAP);
  const fileNotes = notes.filter((n) => n.line === null);

  return (
    <div className="space-y-3">
      {/*
        NULL PATCH IS THE NORMAL CASE AND IT IS NOT AN ERROR. Every device host
        in the field reports which files changed and by how much, and sends no
        hunks at all; only the cloud runner transports diffs today. Drawing an
        empty diff pane here would say "nothing changed" about a change that has
        plenty of content, so the absence is named instead — and the note
        affordance stays, because a reader can still have something to say about
        a file they can see the name and the churn of.
      */}
      {!file.patch ? (
        <div className="surface-inset rounded-field border-dashed border-border/80 px-3 py-4 text-center">
          <p className="text-ui font-medium">No diff was sent for this file</p>
          <p className="mt-1 text-caption text-muted-foreground">
            {file.changeKind} · +{file.added} −{file.removed}. Runs on your Mac report which files
            changed without transporting the hunks; open the session to read them.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-field border border-border/60">
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted px-2.5 py-1.5">
            <span className="truncate font-mono text-caption text-muted-foreground">{file.path}</span>
            <span className="shrink-0 font-mono text-caption tabular-nums">
              <span className="text-success">+{file.added}</span>{" "}
              <span className="text-destructive">−{file.removed}</span>
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-caption">
              <caption className="sr-only">
                Unified diff for {file.path}. Select a line to leave a note on it.
              </caption>
              <tbody>
                {visible.map((row, i) => (
                  <DiffLine
                    key={i}
                    row={row}
                    notes={notes.filter((n) => n.line !== null && n.line === row.cur)}
                    drafting={drafting !== undefined && drafting === row.cur && row.cur !== null}
                    onDraft={() => onDraft(row.cur)}
                    onCancelDraft={onCancelDraft}
                    onAddNote={onAddNote}
                    onRemoveNote={onRemoveNote}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {/* Rendering is capped; NAVIGATION never is. The file picker above
              still lists every file, and this button reveals the rest of this
              one — the reader is never told a change exists somewhere they
              cannot get to. */}
          {!showAll && rows.length > RENDER_LINE_CAP && (
            <div className="border-t border-border/70 p-2">
              <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAll(true)}>
                Show all {rows.length.toLocaleString()} lines
              </Button>
            </div>
          )}
        </div>
      )}

      {fileNotes.length > 0 && (
        <ul role="list" aria-label="Notes on this file" className="space-y-1.5">
          {fileNotes.map((note) => (
            <li key={note.id}>
              <NoteChip note={note} onRemove={() => onRemoveNote(note.id)} />
            </li>
          ))}
        </ul>
      )}

      {drafting === null ? (
        <NoteComposer anchor="this file" onCancel={onCancelDraft} onSubmit={onAddNote} />
      ) : (
        <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={() => onDraft(null)}>
          <ActionIcons.edit className="size-3.5" aria-hidden="true" />
          Note on the whole file
        </Button>
      )}
    </div>
  );
}

/**
 * One diff line.
 *
 * THREE SIGNALS SEPARATE AN ADDITION FROM A DELETION, and none of them is the
 * colour: a sign in its own column, a left edge that is solid for one and
 * dotted for the other, and the tint. The research this surface was built
 * against turned up a real red/green complaint about exactly this control in a
 * shipping competitor, and a diff is the single worst place in a product to
 * encode meaning in hue alone.
 */
function DiffLine({
  row,
  notes,
  drafting,
  onDraft,
  onCancelDraft,
  onAddNote,
  onRemoveNote,
}: {
  row: DiffRow;
  notes: ReviewNote[];
  drafting: boolean;
  onDraft: () => void;
  onCancelDraft: () => void;
  onAddNote: (severity: Severity, body: string) => void;
  onRemoveNote: (id: string) => void;
}) {
  const annotatable = row.cur !== null;
  return (
    <>
      <tr
        className={cn(
          "group/line align-top",
          row.type === "add" && "bg-success/[0.08]",
          row.type === "del" && "bg-destructive/[0.08]",
        )}
      >
        <td className="w-9 select-none border-r border-border/50 px-1.5 text-right text-muted-foreground">
          {row.old ?? ""}
        </td>
        <td className="w-9 select-none border-r border-border/50 px-1.5 text-right text-muted-foreground">
          {row.cur ?? ""}
        </td>
        <td
          className={cn(
            "w-4 select-none border-l-2 pl-1 text-center",
            row.type === "add" && "border-l-success text-success",
            row.type === "del" && "border-l-destructive border-dotted text-destructive",
            row.type === "ctx" && "border-l-transparent text-muted-foreground",
          )}
        >
          {row.type === "add" ? "+" : row.type === "del" ? "−" : ""}
        </td>
        <td className="whitespace-pre-wrap break-words py-0.5 pl-1.5 pr-1">{row.text === "" ? " " : row.text}</td>
        <td className="w-7 pr-1 text-right">
          {annotatable && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={drafting ? onCancelDraft : onDraft}
              aria-label={drafting ? `Cancel note on line ${row.cur}` : `Add a note on line ${row.cur}`}
              aria-expanded={drafting}
              // Revealed on hover and on focus. Focus is the half that is easy
              // to forget and the half a keyboard reader depends on entirely.
              className="size-6 opacity-0 transition-opacity duration-fast ease-out-soft focus-visible:opacity-100 group-hover/line:opacity-100 motion-reduce:transition-none"
            >
              <ActionIcons.edit className="size-3" aria-hidden="true" />
            </Button>
          )}
        </td>
      </tr>
      {notes.map((note) => (
        <tr key={note.id}>
          <td colSpan={5} className="px-2 py-1">
            <NoteChip note={note} onRemove={() => onRemoveNote(note.id)} />
          </td>
        </tr>
      ))}
      {drafting && (
        <tr>
          <td colSpan={5} className="px-2 py-2">
            <NoteComposer anchor={`line ${row.cur}`} onCancel={onCancelDraft} onSubmit={onAddNote} />
          </td>
        </tr>
      )}
    </>
  );
}

function NoteChip({ note, onRemove }: { note: ReviewNote; onRemove: () => void }) {
  const meta = SEVERITIES.find((s) => s.id === note.severity)!;
  return (
    <div className="flex items-start gap-2 rounded-field border border-border/60 bg-muted px-2.5 py-1.5">
      <span
        className={cn(
          "mt-px shrink-0 rounded-full border px-1.5 font-mono text-caption",
          note.severity === "important" && "border-destructive/40 bg-destructive/10 text-destructive",
          note.severity === "nit" && "border-warning/40 bg-warning/10 text-warning",
          note.severity === "pre-existing" && "border-border/60 text-muted-foreground",
        )}
      >
        {meta.label}
      </span>
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-caption">{note.body}</p>
      <Button variant="ghost" size="icon-sm" className="size-6 shrink-0" onClick={onRemove} aria-label="Remove note">
        <ActionIcons.dismiss className="size-3" aria-hidden="true" />
      </Button>
    </div>
  );
}

function NoteComposer({
  anchor,
  onCancel,
  onSubmit,
}: {
  anchor: string;
  onCancel: () => void;
  onSubmit: (severity: Severity, body: string) => void;
}) {
  const [severity, setSeverity] = React.useState<Severity>("important");
  const [body, setBody] = React.useState("");
  const id = React.useId();

  return (
    <div className="surface-inset space-y-2 rounded-field p-2.5">
      <p className="font-mono text-label text-muted-foreground">Note on {anchor}</p>
      <SegmentedControl<Severity>
        value={severity}
        onChange={setSeverity}
        ariaLabel="How serious is this note"
        options={SEVERITIES.map((s) => ({ value: s.id, label: s.label }))}
        className="w-full"
        optionClassName="flex-1 justify-center"
      />
      <p className="text-caption text-muted-foreground">
        {SEVERITIES.find((s) => s.id === severity)!.hint}
      </p>
      <label htmlFor={id} className="sr-only">
        What should change
      </label>
      <Textarea
        id={id}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={2}
        placeholder="What should change, and why"
        className="min-h-[56px] text-ui"
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!body.trim()} onClick={() => onSubmit(severity, body.trim())}>
          Add note
        </Button>
      </div>
    </div>
  );
}

/* ── The receipt ──────────────────────────────────────────────────────────── */

/* ── Create PR ──────────────────────────────────────────────── */

/**
 * THE ONE CONTROL IN THIS PANE THAT ACTUALLY WRITES SOMETHING.
 *
 * Everything else here is judgement: the browser has no checkout, so a file is
 * marked "Looks right" or "Needs a change" and the notes become an instruction.
 * A pull request is different — the branch is already on GitHub and the server
 * holds a credential for it — so this is a real server-side write, and it is
 * built to fail loudly rather than optimistically. Nothing on screen changes
 * until GitHub has answered with a URL, and a refusal arrives as GitHub's own
 * sentence, because every failure here (no push access, a protected base, a
 * branch someone deleted) is something the reader can act on.
 *
 * WHEN IT IS NOT DRAWN AT ALL. `pullRequestBlocker` is the same function the
 * route refuses with, so a control that appears is a control that works. A
 * device run never draws it: that work is in a checkout on a Mac and nothing
 * has been pushed, and a button offering to open a pull request from it would
 * promise a push this product cannot perform.
 */
function CreatePullRequest({
  taskId,
  subject,
  onOpened,
}: {
  taskId: string;
  subject: PullRequestSubject;
  onOpened: (url: string) => void;
}) {
  const [busy, setBusy] = React.useState<PullRequestMode | null>(null);
  const [composeUrl, setComposeUrl] = React.useState<string | null>(null);
  const composeAsked = React.useRef(false);

  /*
   * The compose link is resolved when the MENU opens, not when the item is
   * pressed. Working out the base branch can cost a GitHub call, and a
   * `window.open` that happens after an await is a popup every browser blocks —
   * so by the time the reader reaches the item it is an ordinary link with an
   * href, which needs no popup permission and behaves like every other external
   * link in the product.
   */
  const resolveCompose = React.useCallback(() => {
    if (composeAsked.current) return;
    composeAsked.current = true;
    void fetch(`/api/code/tasks/${taskId}/pull-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "compose" }),
    })
      .then(async (res) => (res.ok ? ((await res.json()) as { url?: string }) : null))
      .then((data) => {
        if (typeof data?.url === "string") setComposeUrl(data.url);
      })
      .catch(() => {
        // The other two modes still work; the item stays disabled and says so.
      });
  }, [taskId]);

  const open = async (mode: "full" | "draft") => {
    setBusy(mode);
    try {
      const res = await fetch(`/api/code/tasks/${taskId}/pull-request`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; reused?: boolean; message?: string };
      if (!res.ok || typeof data.url !== "string") {
        toast.error(data.message || "GitHub would not open the pull request.");
        return;
      }
      onOpened(data.url);
      toast.success(
        data.reused
          ? "This branch already had an open pull request."
          : mode === "draft"
            ? "Draft pull request opened."
            : "Pull request opened.",
      );
    } catch {
      toast.error("Could not reach Juno to open the pull request.");
    } finally {
      setBusy(null);
    }
  };

  if (pullRequestBlocker(subject)) return null;

  return (
    <div className="shrink-0 border-b border-border/60 px-4 py-2.5">
      <DropdownMenu onOpenChange={(next) => next && resolveCompose()}>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="w-full gap-1.5" disabled={busy !== null}>
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <AppIcons.pulls className="size-3.5" aria-hidden="true" />
            )}
            {busy ? "Opening on GitHub…" : "Create pull request"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onSelect={() => void open("full")}>
            <AppIcons.pulls className="size-4" aria-hidden="true" />
            Open for review
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void open("draft")}>
            <CodeIcons.branch className="size-4" aria-hidden="true" />
            Open as a draft
          </DropdownMenuItem>
          {/* GitHub's own compose form, because someone who wants to word the
              title and body themselves should write them where they will be
              read, not in a textarea of ours that posts them elsewhere. */}
          <DropdownMenuItem asChild disabled={!composeUrl}>
            {composeUrl ? (
              <a href={composeUrl} target="_blank" rel="noopener noreferrer">
                <CodeIcons.external className="size-4" aria-hidden="true" />
                Write it on GitHub
              </a>
            ) : (
              <span>
                <CodeIcons.external className="size-4" aria-hidden="true" />
                Write it on GitHub
              </span>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <p className="mt-2 text-caption text-muted-foreground">
        From <span className="font-mono">{subject.branch}</span>, with the commits this run pushed.
      </p>
    </div>
  );
}

function RiskLine({ risk }: { risk: ReturnType<typeof classifyRisk> }) {
  const meta = RISK_META[risk.tier];
  return (
    <div className="flex items-start gap-2">
      <span
        className={cn(
          "mt-px shrink-0 rounded-full border px-2 py-0.5 font-mono text-caption",
          risk.tier === "close-review" && "border-warning/40 bg-warning/10 text-warning",
          risk.tier === "notable" && "border-border/60 text-muted-foreground",
          risk.tier === "routine" && "border-success/40 bg-success/10 text-success",
        )}
      >
        {meta.label}
      </span>
      <ul className="min-w-0 flex-1 space-y-0.5 text-caption text-muted-foreground">
        {risk.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * THE VERIFICATION RECEIPT — the thing no competitor ships.
 *
 * Every agent surface in this category lists runs and diffs them, and stops
 * there. The consequence is that reviewing a one-line copy change and reviewing
 * a schema migration are the same gesture and take the same attention, which
 * means the migration gets the copy change's attention. A receipt is the step
 * in between: what was done, what evidence exists that it works, what is NOT
 * known, and how much that matters — so that a routine change can be waved
 * through honestly and a risky one is the only place full review is spent.
 *
 * THE "NOT KNOWN" SECTION IS THE PART THAT MAKES IT TRUSTWORTHY. A receipt that
 * only lists reassurances is marketing. A check carries the exit status the
 * run reported, and where a producer reported none this says so in those
 * words rather than guessing either way.
 */
export function RunReceipt({
  detail,
  onOpenReview,
  className,
}: {
  detail: RunDetail;
  onOpenReview?: () => void;
  className?: string;
}) {
  const risk = React.useMemo(() => classifyRisk(detail.files), [detail.files]);
  const added = detail.files.reduce((sum, f) => sum + f.added, 0);
  const removed = detail.files.reduce((sum, f) => sum + f.removed, 0);

  return (
    <div className={cn("surface-inset space-y-3 rounded-field px-3 py-2.5", className)}>
      <div>
        <p className="font-mono text-label text-muted-foreground">What changed</p>
        <p className="mt-1 text-ui">
          {detail.files.length === 0 ? (
            "No file changes were reported."
          ) : (
            <>
              <span className="font-mono tabular-nums">{detail.files.length}</span>{" "}
              {detail.files.length === 1 ? "file" : "files"},{" "}
              <span className="font-mono tabular-nums text-success">+{added}</span>{" "}
              <span className="font-mono tabular-nums text-destructive">−{removed}</span>
            </>
          )}
        </p>
      </div>

      {detail.files.length > 0 && <RiskLine risk={risk} />}

      <div>
        <p className="font-mono text-label text-muted-foreground">What was checked</p>
        {detail.checks.length > 0 ? (
          <>
            <ul className="mt-1 space-y-0.5">
              {detail.checks.slice(0, 4).map((check) => (
                <li key={check.summary} className="flex min-w-0 items-center gap-1.5 font-mono text-caption text-muted-foreground">
                  {check.outcome === "ok" ? (
                    <StatusIcons.success className="size-3 shrink-0 text-success" aria-hidden="true" />
                  ) : check.outcome === "failed" ? (
                    <StatusIcons.error className="size-3 shrink-0 text-destructive" aria-hidden="true" />
                  ) : (
                    <span className="size-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{check.summary}</span>
                  <span className={cn("shrink-0", check.outcome === "failed" && "text-destructive")}>
                    {check.outcome === "ok" ? "passed" : check.outcome === "failed" ? "failed" : "not recorded"}
                  </span>
                </li>
              ))}
            </ul>
            {/* Said every time, never once in a tooltip. */}
            <p className="mt-1 text-caption text-muted-foreground">
              {detail.checks.some((check) => check.outcome === "unknown")
                ? "Where no exit status was reported, the log records only that the command ran."
                : "Exit statuses as the run reported them — a passing check is not proof the change is right."}
            </p>
          </>
        ) : (
          <p className="mt-1 text-caption text-muted-foreground">
            No test, type check or build step was reported. That is not proof none ran — only that
            none was reported.
          </p>
        )}
      </div>

      {detail.error && (
        <div>
          <p className="font-mono text-label text-muted-foreground">Reported problem</p>
          <p className="mt-1 text-caption text-destructive">{detail.error}</p>
        </div>
      )}

      {onOpenReview && detail.files.length > 0 && (
        <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={onOpenReview}>
          <CodeIcons.file className="size-3.5" aria-hidden="true" />
          Read the diff
        </Button>
      )}
    </div>
  );
}
