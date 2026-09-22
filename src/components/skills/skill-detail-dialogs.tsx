"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function DeleteSkillDialog({
  open,
  name,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onCancel() : undefined)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            Delete <span className="break-words">“{name}”</span>?
          </DialogTitle>
          <DialogDescription>
            It’s removed from your skills and can’t run again. Chats and tasks that used it keep their history.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} loading={busy}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The picker's value for "no project": a sentinel, because an empty string is also "nothing chosen". */
const NO_PROJECT = "__none__";

/**
 * Filing a skill in a project, or taking it out of one.
 *
 * What filing changes is where Juno may pick it on its own: a filed skill is
 * offered to that project's tasks and no others. Typing its slash name
 * reaches it from anywhere either way, which the description says, because
 * that is the question somebody filing a skill is about to ask.
 */
export function MoveSkillDialog({
  open,
  slug,
  current,
  projects,
  failed = false,
  busy,
  onCancel,
  onMove,
}: {
  open: boolean;
  slug: string;
  current: string | null;
  /** Null while the list is loading. */
  projects: { id: string; name: string }[] | null;
  /** The list could not be read. */
  failed?: boolean;
  busy: boolean;
  onCancel: () => void;
  onMove: (projectId: string | null) => void;
}) {
  const [choice, setChoice] = React.useState(current ?? NO_PROJECT);
  React.useEffect(() => {
    if (open) setChoice(current ?? NO_PROJECT);
  }, [open, current]);
  const options = [{ id: NO_PROJECT, name: "" }, ...(projects ?? [])];
  const unchanged = choice === (current ?? NO_PROJECT);
  return (
    <Dialog open={open} onOpenChange={(next) => (!next && !busy ? onCancel() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Move to a project</DialogTitle>
          <DialogDescription>
            Juno picks a filed skill only for that project’s tasks. Typing{" "}
            <span className="font-mono text-foreground" translate="no">
              /{slug}
            </span>{" "}
            works anywhere.
          </DialogDescription>
        </DialogHeader>
        {failed && projects === null ? (
          <p className="rounded-field border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-ui text-destructive">
            Couldn’t load your projects. Close this and try again.
          </p>
        ) : projects === null ? (
          <div role="status" aria-label="Loading projects" className="space-y-2">
            <Skeleton className="h-11 w-full rounded-field" />
            <Skeleton className="h-11 w-full rounded-field" />
          </div>
        ) : (
          <RadioGroup
            value={choice}
            onValueChange={setChoice}
            disabled={busy}
            aria-label="Project"
            className="max-h-72 gap-0 divide-y divide-border/70 overflow-y-auto rounded-card border border-border"
          >
            {options.map((option) => (
              <label
                key={option.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors duration-fast ease-out-soft hover:bg-accent",
                  busy && "cursor-default"
                )}
              >
                <RadioGroupItem value={option.id} />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-ui",
                    option.id === NO_PROJECT ? "text-muted-foreground" : "text-foreground"
                  )}
                >
                  {option.id === NO_PROJECT ? "No project" : option.name}
                </span>
              </label>
            ))}
          </RadioGroup>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onMove(choice === NO_PROJECT ? null : choice)}
            disabled={unchanged || projects === null}
            loading={busy}
          >
            Move
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
