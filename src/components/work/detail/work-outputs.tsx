"use client";

import * as React from "react";
import { Check, Copy, FileText } from "lucide-react";
import type { RunPhase } from "@/components/work/detail/work-rail";
import { RailDisclosure, RailLiveCount, RailSection } from "@/components/work/detail/work-rail";
import type { PerformedActions } from "@/components/work/work-timeline";
import type { WorkProducedArtifact, WorkReference } from "@/components/work/work-detail-panels";
import { WorkActionsPerformed } from "@/components/work/work-detail-panels";
import { WorkDocuments } from "@/components/work/work-documents";
import { cn } from "@/lib/utils";
import { Pressable } from "@/components/ui/pressable";

/*
 * What the run made.
 *
 * This is a merge of three panels that were never three questions. "Documents"
 * held the artifacts with their bytes behind them; the written half of "Files
 * and sources" held every file the run changed that never became an artifact;
 * "Actions performed" held the things it did that left no file at all. A reader
 * asking "what did this produce" had to visit three headings and work out for
 * themselves that the answer was the union of them.
 *
 * One section, then, with a count in its heading — because the most common
 * version of the question is answered by the number alone, and a closed section
 * that answers it costs one line.
 *
 * ── What the count counts ────────────────────────────────────────────────────
 *
 * The number beside the heading is what THIS ATTEMPT recorded: the artifacts and
 * the changed files its own event stream reported. The document list below it
 * comes from `/api/work/artifacts`, which is scoped to the task rather than the
 * attempt, so on a task that has been retried it can hold rows this attempt knew
 * nothing about. The two are allowed to differ and the difference is the honest
 * one: "this run produced two files" is the fact somebody deciding whether to
 * retry actually needs, and it is not the same fact as "this task has four files
 * in it".
 *
 * ── Why the document list is behind a condition ──────────────────────────────
 *
 * `WorkDocuments` fetches, and an empty answer from it prints a sentence
 * explaining the emptiness — which is the thing the rail was rebuilt to stop
 * doing. So it is rendered only where there is evidence there might be something
 * to fetch: this attempt reported an artifact, or an earlier attempt exists and
 * may have. Everywhere else the section is a heading and nothing under it.
 */

export function WorkOutputsSection({
  sessionId,
  phase,
  defaultOpen,
  artifacts,
  written,
  performed,
  /** True once this task has more than one attempt. See the note above. */
  hasEarlierAttempts,
}: {
  sessionId: string;
  phase: RunPhase;
  defaultOpen: boolean;
  artifacts: readonly WorkProducedArtifact[];
  /** The `written` half of the reference list — files changed, not documents. */
  written: readonly WorkReference[];
  performed: PerformedActions;
  hasEarlierAttempts: boolean;
}) {
  const count = artifacts.length + written.length;
  const showDocuments = artifacts.length > 0 || hasEarlierAttempts;
  const settled = phase === "done" || phase === "failed";
  const performedAnything = performed.actions.length > 0 || performed.unclassified > 0;

  return (
    <RailSection
      name="outputs"
      title="Outputs"
      meta={count > 0 ? String(count) : null}
      defaultOpen={defaultOpen}
    >
      {/* The count, said out loud when it changes. The visible number updates
          silently as a run writes files, which serves a reader watching it and
          nobody else. */}
      <RailLiveCount message={count === 1 ? "1 output" : `${count} outputs`} />

      {written.length > 0 && (
        <ul className="space-y-0.5">
          {written.map((reference) => (
            <OutputRow key={reference.id} label={reference.label} detail={reference.detail} />
          ))}
        </ul>
      )}

      {showDocuments && <WorkDocuments sessionId={sessionId} fromEvents={artifacts} />}

      {/*
       * The one sentence this section is allowed to print about emptiness, and
       * the reason it is allowed: on a run that is still going, "nothing yet" is
       * not news and the absence of rows says it better. On a run that is over,
       * "it made nothing" IS the answer, and leaving the reader to infer it from
       * a blank space is leaving them to wonder whether the panel is broken.
       */}
      {count === 0 && !showDocuments && settled && (
        <p className="text-ui leading-relaxed text-muted-foreground">
          {phase === "done"
            ? "This task finished without producing a file."
            : "It stopped before producing a file."}
        </p>
      )}

      {performedAnything && (
        // Under Outputs rather than beside it: an email sent and a batch applied
        // are things this run produced, they simply produced them somewhere
        // there is no file to download. Closed by default because the rows above
        // are the ones with something to open.
        <RailDisclosure
          storageKey="outputs.performed"
          title="Actions performed"
          meta={performed.actions.length > 0 ? String(performed.actions.length) : null}
        >
          <WorkActionsPerformed performed={performed} />
        </RailDisclosure>
      )}
    </RailSection>
  );
}

/**
 * One changed file.
 *
 * There is no download here and there deliberately is not one: these rows come
 * from `files_changed`, which reports that a file was written and where it was
 * written to, not what is in it. The affordance that IS useful is the name —
 * copied, so it can be pasted into whatever opened the file — and offering a
 * download that 404s would be worse than offering nothing.
 *
 * Nothing in here prints a path. `deriveReferences` already refuses to name a
 * file the executor did not give a display name to, for the reason stated there:
 * a path in a screenshot is a path in a support ticket.
 */
function OutputRow({ label, detail }: { label: string; detail: string | null }) {
  return (
    // Not a `Pressable kind="row"`: the row itself is not pressable — the copy
    // control inside it is — so it only borrows the row rung's radius and fill
    // rather than nesting a button in a button.
    <li className="group flex items-center gap-2.5 rounded-control px-1.5 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent">
      <FileMark name={label} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui leading-snug text-foreground">{label}</span>
        {detail !== null && (
          <span className="mt-0.5 block truncate font-mono text-micro text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
      <CopyAffordance value={label} label={`Copy the name of ${label}`} />
    </li>
  );
}

/**
 * The file-type mark: the extension when the name carries one, a page glyph when
 * it does not.
 *
 * Mono rather than a per-format icon set. Juno already says "this is metadata"
 * in mono everywhere else on this page, and eight bespoke glyphs would be eight
 * things to learn in place of three letters that are already on the file.
 */
function FileMark({ name }: { name: string }) {
  const extension = fileExtension(name);
  return (
    <span
      // 32px at the 12px rung, exactly `KindBadge` in work-documents.tsx: the two
      // file marks stack in the same rail and were 28px/24px-radius here against
      // 32px/12px there — a badge so nearly circular it read as a different kind
      // of thing. `rounded-lg` is 24px in this config, not a small rung.
      // 10px, not 9px — 9px was the smallest type anywhere in Work, two rungs
      // under caption, for a three-letter extension.
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-field border border-border/60 bg-secondary font-mono text-micro uppercase text-muted-foreground"
      aria-hidden="true"
    >
      {extension ?? <FileText className="h-3.5 w-3.5" />}
    </span>
  );
}

/**
 * The trailing extension, when there is one worth showing.
 *
 * Capped at four characters and restricted to letters and digits, because the
 * label is a human name rather than a filename: "Q3 forecast v1.2" ends in
 * something that looks like an extension and is not one, and a badge reading "2"
 * says less than no badge at all.
 */
function fileExtension(name: string): string | null {
  const match = /\.([a-z0-9]{1,4})$/i.exec(name.trim());
  if (match === null) return null;
  const extension = match[1];
  return /[a-z]/i.test(extension) ? extension : null;
}

/**
 * Revealed on hover, and present without it.
 *
 * `opacity-0` alone would put this behind a gesture a touch device cannot make,
 * so the hover-hiding is scoped to pointers that can hover and the control is
 * simply always visible everywhere else. `group-focus-within` is what keeps it
 * reachable by keyboard: a button that appears only under a mouse is a button
 * that does not exist for half the people who need it.
 */
function CopyAffordance({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    []
  );

  const copy = () => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), 1_500);
      })
      // Silent. The clipboard can be refused by permission or by an insecure
      // origin, and a toast for a copy nobody watched fail is more interruption
      // than the failure is worth — the name is still on screen to select.
      .catch(() => {});
  };

  return (
    <Pressable
      kind="icon"
      onClick={copy}
      aria-label={label}
      className={cn(
        "size-7 shrink-0 transition-[opacity,background-color,color] duration-fast ease-out-soft",
        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        "[@media(hover:none)]:opacity-100"
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success-ink" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </Pressable>
  );
}
