import { cn } from "@/lib/utils";
import type { EditStatus, Operation } from "@/components/memory/memory-model";

/*
 * What an instruction would change, as lines a reader can check.
 *
 * Shared by the proposal under the prompt bar and the history in the activity
 * sheet, so a change looks the same when it is offered and when it is looked
 * back on. Set in the page's own sans at the row size: these are sentences
 * about a person, and the monospace it used to be set in made them read as a
 * patch file.
 */

function DiffLine({ sign, text }: { sign: "+" | "-"; text: string }) {
  // Both halves carry the same alpha, so a paired removal and addition read as
  // one change rather than one loud line and one faint one.
  return (
    <div className={cn("flex gap-2.5 px-3 py-2", sign === "+" ? "bg-success/10" : "bg-destructive/10")}>
      <span
        aria-hidden="true"
        className={cn("w-2 shrink-0 select-none text-center font-medium", sign === "+" ? "text-success" : "text-destructive")}
      >
        {sign === "+" ? "+" : "−"}
      </span>
      <span className="sr-only">{sign === "+" ? "Adds:" : "Removes:"}</span>
      <span className={cn("min-w-0 whitespace-pre-wrap break-words", sign === "-" && "text-muted-foreground line-through decoration-muted-foreground/40")}>
        {text}
      </span>
    </div>
  );
}

export function OperationDiff({ operations, className }: { operations: Operation[]; className?: string }) {
  if (operations.length === 0) return null;
  return (
    <div className={cn("divide-y divide-border overflow-hidden rounded-control text-ui", className)}>
      {operations.map((op, i) => (
        <div key={i}>
          {(op.op === "update" || op.op === "remove") && <DiffLine sign="-" text={op.before} />}
          {op.op === "add" && op.suppress ? (
            // A suppression reads as "forget" to the reader, even though it is
            // mechanically an addition to the block-list.
            <DiffLine sign="-" text={op.content} />
          ) : (
            (op.op === "update" || op.op === "add") && <DiffLine sign="+" text={op.content} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * The state of an edit, in words and one quiet tone. Tinted text passes
 * contrast on the dark ground but not the light one, so the light theme keeps
 * foreground ink over a slightly stronger tint.
 */
const STATUS_TOKEN: Record<EditStatus, { label: string; className: string }> = {
  pending: { label: "Waiting for you", className: "bg-warning/15 text-foreground dark:bg-warning/10 dark:text-warning" },
  applied: { label: "Applied", className: "bg-success/15 text-foreground dark:bg-success/10 dark:text-success" },
  rejected: { label: "Not applied", className: "bg-secondary text-muted-foreground" },
};

export function EditStatusToken({ status }: { status: EditStatus }) {
  const token = STATUS_TOKEN[status];
  return (
    // role=status so a flip from waiting to applied is announced where it happened.
    <span role="status" className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-caption font-medium", token.className)}>
      {token.label}
    </span>
  );
}
