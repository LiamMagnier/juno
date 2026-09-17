"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Pressable } from "@/components/ui/pressable";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Textarea } from "@/components/ui/textarea";
import { parseUnifiedDiff, type DiffRow } from "@/components/aicss/file-diff";
import { ActionIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { classifyRisk, RISK_META } from "@/lib/code-runs";
import { cn } from "@/lib/utils";

/*
 * THE REVIEW PANE — NOT A MODAL, AND ITS HOST IS NOW THE SESSION.
 *
 * It was built beside the run list: files on one side, changes on the other,
 * the other eleven runs still on screen, and a docked 27rem column from 52rem
 * of content width. The list is gone (docs/design/TWO_PRODUCTS.md §3), and with
 * it the second half that arrangement existed to keep visible — so the docked
 * variant went too rather than being kept for a column that no longer sits
 * beside it. Inside a session transcript a sticky 27rem pane would take its
 * width from the transcript and stand over the composer, which is the one
 * control that must never be covered.
 *
 * What is left is what the pane already did on every narrow window: it covers.
 * It is still not a dialog — it traps no focus and it makes no claim that the
 * page behind it is unusable — and it is opened from the session's changed-
 * files card, which is the only place in the product that knows a run has
 * written something worth reading.
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

/**
 * The three severities a note can carry.
 *
 * Named for the reader's intent rather than for a colour, and kept to three
 * because a severity list long enough to need thought is one nobody uses. The
 * middle tier exists so a genuine nit can be sent WITHOUT the agent treating it
 * as a defect, and `pre-existing` exists so a reader can point at something
 * wrong that this run did not cause — which is the note people most often
 * swallow, because every other review surface makes it look like a complaint
 * about the work in front of them.
 */
const SEVERITIES = [
  { id: "important", label: "Important", hint: "Should change before this lands." },
  { id: "nit", label: "Nit", hint: "Worth fixing, not worth blocking." },
  { id: "pre-existing", label: "Pre-existing", hint: "Already wrong before this run touched it." },
] as const;

type Severity = (typeof SEVERITIES)[number]["id"];

interface Note {
  id: string;
  path: string;
  /** The new-file line number the note is anchored to, when one was picked. */
  line: number | null;
  severity: Severity;
  body: string;
}

/** Per-file verdict. Absent means the reader has not said. */
type Verdict = "ok" | "change";

type Scope = "last-turn" | "everything";

/**
 * One file as this pane reads it.
 *
 * Declared here rather than imported from the run list's hook, which is where
 * it used to come from: that hook is parked for the sidebar, and importing a
 * type from it kept a live surface pointing at a module nothing mounts. The
 * shape is unchanged, so `RunDetail.files` still satisfies it structurally and
 * a sidebar can hand this pane its rows with no translation layer.
 */
export interface ReviewFile {
  path: string;
  changeKind: string;
  added: number;
  removed: number;
  /**
   * Null means NO PATCH ARRIVED, never "the change was empty" — every device
   * host in the field sends path/kind/counts and no hunks.
   */
  patch: string | null;
  /** Written after the reader's most recent instruction. Drives "Last turn". */
  fromLastTurn: boolean;
}

/** The changes a review is about, and whether they are all here yet. */
export interface ReviewChangeset {
  loading: boolean;
  files: ReviewFile[];
  /** True once a turn boundary exists, so "Last turn" can be offered honestly. */
  hasTurnBoundary: boolean;
}

export function RunReviewPane({
  run,
  detail,
  onSend,
  onClose,
}: {
  run: { id: string; title: string };
  detail: ReviewChangeset;
  /**
   * Hand the assembled review to whoever mounted the pane, as plain text.
   *
   * The pane used to park the text against the conversation and navigate to
   * it, because it was mounted on a different page from the run. Its host is
   * now the session itself, where that navigation would be a round trip to the
   * screen already on display — so the host takes the text and puts it in its
   * own composer instead. Either way the notes travel exactly the path a typed
   * instruction would, which is what stops a review asking for something the
   * composer could not have asked for.
   */
  onSend: (text: string) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = React.useState<Scope>("last-turn");
  const [activePath, setActivePath] = React.useState<string | null>(null);
  /*
   * NOTES OUTLIVE THE PANE. They were component state, the pane unmounts on
   * close, and a reader who closed it to check something lost every note
   * with no warning. Now they are read back from localStorage for this run
   * (the pane is keyed by run id where it is mounted, so this initialiser
   * runs per run), written on every change, and cleared only once they have
   * been sent. Per browser, like a draft.
   */
  const [notes, setNotes] = React.useState<Note[]>(() => readReviewDraft(run.id).notes);
  const [verdicts, setVerdicts] = React.useState<Record<string, Verdict>>(() => readReviewDraft(run.id).verdicts);
  const [drafting, setDrafting] = React.useState<{ path: string; line: number | null } | null>(null);

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

  const addNote = (note: Omit<Note, "id">) => {
    setNotes((prev) => [...prev, { ...note, id: `${note.path}:${note.line ?? "file"}:${prev.length}` }]);
    setDrafting(null);
  };

  /**
   * Hand the whole review to the run as its next instruction.
   *
   * This is the "notes bundle into the agent's next message" behaviour. The
   * text is assembled here and given to `onSend`; what happens to it after that
   * belongs to the host, because only the host knows whether the composer it
   * should land in is on this screen or another one.
   */
  const sendNotes = () => {
    if (notes.length === 0 && Object.keys(verdicts).length === 0) return;
    const lines: string[] = [];
    lines.push(
      scope === "last-turn" && canScope
        ? "Review notes on your last turn:"
        : "Review notes on the changes so far:",
    );
    lines.push("");
    for (const severity of SEVERITIES) {
      const group = notes.filter((n) => n.severity === severity.id);
      if (group.length === 0) continue;
      lines.push(`${severity.label}:`);
      for (const note of group) {
        lines.push(`- ${note.path}${note.line ? `:${note.line}` : ""} — ${note.body}`);
      }
      lines.push("");
    }
    const needsChange = Object.entries(verdicts).filter(([, v]) => v === "change").map(([p]) => p);
    const looksRight = Object.entries(verdicts).filter(([, v]) => v === "ok").map(([p]) => p);
    if (needsChange.length > 0) lines.push(`Files I marked as needing a change: ${needsChange.join(", ")}`);
    if (looksRight.length > 0) lines.push(`Files I marked as looking right: ${looksRight.join(", ")}`);

    onSend(lines.join("\n").trim());
    // Sent means handed to the composer, where the reader can see it and edit
    // it before it goes; the per-run draft has done its job.
    clearReviewDraft(run.id);
    // Closing is part of sending: the notes are now in a field behind this
    // pane, and leaving the pane over them would hide the thing just written.
    onClose();
  };

  const noteCount = notes.length;
  const verdictCount = Object.keys(verdicts).length;
  const canSend = noteCount + verdictCount > 0;

  // Closing with unsent notes is not a loss any more — say so, quietly,
  // rather than blocking the close with a dialog over a draft that is kept.
  const close = () => {
    const unsent = noteCount + verdictCount;
    if (unsent > 0) {
      toast.message(`Kept ${unsent} unsent ${unsent === 1 ? "note" : "notes"} for this run.`, {
        description: "They will be here when you open the review again.",
      });
    }
    onClose();
  };

  return (
    <aside
      aria-label={`Review changes from ${run.title}`}
      // It covers, at every width. The docked 27rem variant this used to carry
      // from 52rem of content column was there so the run list stayed beside
      // it; there is no list, and the surface that mounts it now is a
      // transcript with a composer pinned to the bottom, where a sticky column
      // would narrow the transcript and stand over the field.
      className="surface-raised fixed inset-0 z-modal flex flex-col overflow-hidden"
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
        <Button className="w-full gap-1.5" disabled={!canSend} onClick={sendNotes}>
          <ActionIcons.share className="size-3.5" aria-hidden="true" />
          {noteCount + verdictCount === 0
            ? "Send review to the run"
            : `Send ${noteCount + verdictCount} ${noteCount + verdictCount === 1 ? "note" : "notes"} to the run`}
        </Button>
        {/* Said rather than assumed: the notes land in the field, not in the
            run, so a reader who wanted to add a sentence before sending still
            can. A button that dispatched straight into a live run would be the
            one place on this surface where a press cannot be taken back. */}
        <p className="mt-2 text-center text-caption text-muted-foreground">
          Puts your notes in the composer as the next instruction.
        </p>
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
  file: ReviewFile;
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
  file: ReviewFile;
  notes: Note[];
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
  notes: Note[];
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

function NoteChip({ note, onRemove }: { note: Note; onRemove: () => void }) {
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

/* ── Review drafts, per run, per browser ─────────────────────────────────── */

const REVIEW_DRAFT_PREFIX = "juno:code:review:";

type ReviewDraft = { notes: Note[]; verdicts: Record<string, Verdict> };
const EMPTY_DRAFT: ReviewDraft = { notes: [], verdicts: {} };

function readReviewDraft(runId: string): ReviewDraft {
  if (typeof window === "undefined") return EMPTY_DRAFT;
  try {
    const raw = window.localStorage.getItem(`${REVIEW_DRAFT_PREFIX}${runId}`);
    if (!raw) return EMPTY_DRAFT;
    const parsed = JSON.parse(raw) as Partial<ReviewDraft>;
    const notes = Array.isArray(parsed.notes)
      ? parsed.notes.filter(
          (n): n is Note =>
            !!n && typeof n === "object" && typeof n.id === "string" && typeof n.path === "string" && typeof n.body === "string",
        )
      : [];
    const verdicts: Record<string, Verdict> = {};
    if (parsed.verdicts && typeof parsed.verdicts === "object") {
      for (const [path, verdict] of Object.entries(parsed.verdicts)) {
        if (verdict === "ok" || verdict === "change") verdicts[path] = verdict;
      }
    }
    return { notes, verdicts };
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeReviewDraft(runId: string, draft: ReviewDraft): void {
  if (typeof window === "undefined") return;
  try {
    const key = `${REVIEW_DRAFT_PREFIX}${runId}`;
    if (draft.notes.length === 0 && Object.keys(draft.verdicts).length === 0) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(draft));
    }
  } catch {
    // Storage can be unavailable (private mode, quota); the draft is a courtesy.
  }
}

function clearReviewDraft(runId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(`${REVIEW_DRAFT_PREFIX}${runId}`);
  } catch {
    /* nothing to clear */
  }
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

/** What the receipt reads: the changeset, plus the evidence only the run's own
 *  event log carries. `RunDetail` satisfies it — see the note on the receipt. */
export interface ReceiptDetail {
  files: ReviewFile[];
  checks: readonly { summary: string; outcome: "ok" | "failed" | "unknown" }[];
  /** The run's own error text, when it reported one. */
  error: string | null;
}

/**
 * THE VERIFICATION RECEIPT — the thing no competitor ships.
 *
 * PARKED, DELIBERATELY, AND WITH THE HOOK THAT FEEDS IT. Nothing mounts this
 * today. `checks` is the reason: it is built by `useRunDetail` in
 * use-code-runs.ts, which walks a run's event log for commands that look like
 * verification and reads how each one ended, and no surface in the product
 * derives that from a transcript. The pane above was re-homed onto the session
 * because it needs only the files a session already has; the receipt needs the
 * event log, so it waits where its data waits, for the sidebar package that
 * brings `useRunDetail` back. Writing it again from a git ref is the cost of
 * deleting it, and the sentences below are the argument, not the markup.
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
  detail: ReceiptDetail;
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
