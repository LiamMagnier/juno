"use client";

import * as React from "react";
import { ChevronDown, Loader2, Undo2 } from "lucide-react";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";
import type { EditStatus, MemoryEditRecord, Operation } from "./memory-model";

// Tinted text passes contrast on the dark theme but not the light one, so the
// light theme keeps foreground text over a slightly stronger tint.
const STATUS_CHIP: Record<EditStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "border-warning/40 bg-warning/15 text-foreground dark:bg-warning/10 dark:text-warning" },
  applied: { label: "Applied", className: "border-success/40 bg-success/15 text-foreground dark:bg-success/10 dark:text-success" },
  // bg-secondary, not bg-muted/50: half of a 9.5% token over the 6.5% card these
  // chips sit on is a 1.5-point step, so the rejected chip had no fill at all
  // while its two siblings carried real tints and read as filled.
  rejected: { label: "Rejected", className: "border-border/70 bg-secondary text-muted-foreground" },
};

function DiffLine({ sign, text }: { sign: "+" | "-"; text: string }) {
  // Both halves of one diff carry the SAME alpha. Removals were /5 against
  // additions at /10, so on the black ground the removal band all but vanished
  // and the paired +/− display stopped reading as one control.
  return (
    <div className={cn("flex gap-2 px-3 py-1.5", sign === "+" ? "bg-success/10" : "bg-destructive/10")}>
      <span
        aria-hidden="true"
        className={cn("shrink-0 select-none font-semibold", sign === "+" ? "text-success" : "text-destructive")}
      >
        {sign === "+" ? "+" : "−"}
      </span>
      <span className="sr-only">{sign === "+" ? "Adds:" : "Removes:"}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words text-foreground/85">{text}</span>
    </div>
  );
}

function OperationDiff({ operations }: { operations: Operation[] }) {
  if (operations.length === 0) return null;
  return (
    <div className="mt-3 divide-y divide-border/40 overflow-hidden rounded-field border border-border/50 font-mono text-caption leading-relaxed">
      {operations.map((op, i) => (
        <div key={i}>
          {(op.op === "update" || op.op === "remove") && <DiffLine sign="-" text={op.before} />}
          {op.op === "add" && op.suppress ? (
            // A suppression reads as "forget" to the user, even though it's
            // mechanically an addition to the block-list.
            <DiffLine sign="-" text={`Never remember: ${op.content}`} />
          ) : (
            (op.op === "update" || op.op === "add") && <DiffLine sign="+" text={op.content} />
          )}
        </div>
      ))}
    </div>
  );
}

interface EditsPanelProps {
  edits: MemoryEditRecord[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Ids of edits currently being applied/undone (disables their actions). */
  busyIds: ReadonlySet<string>;
  onAccept: (edit: MemoryEditRecord) => void;
  onUndo: (edit: MemoryEditRecord) => void;
  onDelete: (id: string) => void;
}

export function EditsPanel({ edits, open, onOpenChange, busyIds, onAccept, onUndo, onDelete }: EditsPanelProps) {
  const pendingCount = edits.filter((e) => e.status === "pending").length;
  const toggleRef = React.useRef<HTMLButtonElement>(null);

  // Deleting unmounts the whole item — park focus on the stable toggle first so
  // keyboard users aren't dropped back to the document root.
  const deleteAndRefocus = (id: string) => {
    toggleRef.current?.focus();
    onDelete(id);
  };

  return (
    <div>
      <button
        ref={toggleRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls="memory-edits-panel"
        className="group flex w-full items-center justify-between gap-3 rounded-card border border-border/60 bg-card px-4 py-3 text-left surface-raised transition-[border-color,box-shadow] duration-fast ease-out-soft hover:border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span className="flex items-center gap-2.5 text-sm font-medium">
          <ActionIcons.edit className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          Manage edits
        </span>
        <span className="flex items-center gap-2">
          {pendingCount > 0 ? (
            // Keyed on the count so a change re-mounts the chip and it pops —
            // the same "this number just moved" cue the spring used to carry.
            <span key={pendingCount} className="motion-safe:animate-pop-in">
              <Badge variant="soft">{pendingCount} pending</Badge>
            </span>
          ) : edits.length > 0 ? (
            <span className="font-mono text-caption tabular-nums text-muted-foreground">{edits.length}</span>
          ) : null}
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform duration-base ease-out-soft motion-reduce:transition-none",
              open && "rotate-180"
            )}
            aria-hidden="true"
          />
        </span>
      </button>

      {/* Grid-rows collapse, like every other disclosure — the panel stays
          mounted and `inert` keeps it unreachable while closed. */}
      <div
        id="memory-edits-panel"
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-base ease-out-soft motion-reduce:transition-none",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="min-h-0 overflow-hidden" inert={!open}>
          {edits.length === 0 ? (
            <p className="px-4 pb-1 pt-3 text-sm text-muted-foreground">
              No edits yet. Use the pencil on the summary to tell Juno what to remember, update, or forget —
              changes apply right away and show up here, with Undo if you change your mind.
            </p>
          ) : (
            <ul className="space-y-2 pt-2">
              {edits.map((edit) => {
                const busy = busyIds.has(edit.id);
                return (
                  <li
                    key={edit.id}
                    className="rounded-card border border-border/60 bg-card p-4 shadow-soft motion-safe:animate-rise-in"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="font-sans text-sm italic text-foreground/90">“{edit.instruction}”</p>
                      {/* role=status so pending → applied/rejected flips are announced. */}
                      <span role="status" className="shrink-0">
                        <Badge variant="outline" className={STATUS_CHIP[edit.status].className}>
                          {STATUS_CHIP[edit.status].label}
                        </Badge>
                      </span>
                    </div>
                    {(edit.summary || edit.note) && (
                      <p className="mt-1.5 text-caption text-muted-foreground">{edit.note ?? edit.summary}</p>
                    )}
                    <OperationDiff operations={edit.operations} />
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <span className="font-mono text-caption text-muted-foreground/70">{timeAgo(edit.createdAt)}</span>
                      <div className="flex items-center gap-1.5">
                        {edit.status === "pending" && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => deleteAndRefocus(edit.id)}
                              disabled={busy}
                              aria-label="Delete this edit"
                            >
                              <ActionIcons.delete className="size-4" />
                            </Button>
                            <Button size="sm" className="gap-1.5" onClick={() => onAccept(edit)} disabled={busy}>
                              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <StatusIcons.success className="size-3.5" />}
                              {busy ? "Applying…" : "Accept"}
                            </Button>
                          </>
                        )}
                        {edit.status === "applied" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => onUndo(edit)}
                            disabled={busy}
                          >
                            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
                            {busy ? "Undoing…" : "Undo"}
                          </Button>
                        )}
                        {edit.status === "rejected" && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => deleteAndRefocus(edit.id)}
                            aria-label="Delete this edit"
                          >
                            <ActionIcons.delete className="size-4" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
