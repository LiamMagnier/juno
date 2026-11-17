"use client";

import * as React from "react";
import { ShieldCheck } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The page's small print: what never reaches memory, and where to change it.
 *
 * It used to end in a row of six text links (settings, topics, import,
 * export, reset, and a clear for the project on screen), every one of them
 * also in the header's menu, and the separators doubled up when the project
 * link was absent ("Export · · Reset memory…"). The rare actions live in the
 * menu now; the footer keeps the two that belong to its sentence.
 */

const linkClass =
  "hit-24 rounded-xs font-medium text-foreground underline-offset-2 transition-colors duration-fast ease-out-soft hover:underline";

export function MemoryFooter({
  onSettings,
  onTopics,
}: {
  onSettings: () => void;
  /** Opens "Topics not remembered": the person's own exclusions. */
  onTopics?: () => void;
}) {
  return (
    <footer className="mt-12 border-t border-[var(--mem-hair)] pt-4 text-ui text-muted-foreground">
      <p className="flex max-w-prose items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          Incognito chats are never remembered. Sensitive subjects like health or religion are only learned if you
          allow them, and topics you exclude are never learned at all.
        </span>
      </p>
      <nav aria-label="Memory privacy" className="ml-6 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
        {onTopics ? (
          <>
            <button type="button" onClick={onTopics} className={linkClass} data-excluded-topics-open="">
              Topics not remembered
            </button>
            <span aria-hidden="true">·</span>
          </>
        ) : null}
        <button type="button" onClick={onSettings} className={linkClass}>
          Memory settings
        </button>
      </nav>
    </footer>
  );
}

/**
 * RESET IS A DIALOG NOW, NOT A HOLD. The hold-to-reset button suited a strip
 * that already spelled out what reset does; reached from a menu or a text link,
 * with nothing on screen saying "permanently", the confirmation has to carry
 * that sentence itself. Export sits in the dialog because the one moment an
 * export matters most is the moment before everything is erased.
 */
export function ResetDialog({
  open,
  onOpenChange,
  resetting,
  onExport,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resetting: boolean;
  onExport: () => void;
  onReset: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reset memory?</DialogTitle>
          <DialogDescription>
            {`This permanently deletes everything ${PRODUCT_NAME} remembers, the summary and every project’s memory, and its edit history. It can’t be undone. Your chats stay as they are.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:justify-between">
          <Button variant="ghost" onClick={onExport} className="sm:-ml-2">
            Export first
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={resetting}
              onClick={async () => {
                await onReset();
                onOpenChange(false);
              }}
            >
              Reset memory
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Clearing one project's memory: the same weight as reset, for a smaller thing. */
export function ClearProjectDialog({
  project,
  onOpenChange,
  clearing,
  onClear,
}: {
  project: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  clearing: boolean;
  onClear: (projectId: string) => Promise<boolean>;
}) {
  return (
    <ConfirmDialog
      open={project !== null}
      onOpenChange={onOpenChange}
      busy={clearing}
      title={
        <>
          <span>Clear</span> <span translate="no">{project?.name}</span>
          <span>?</span>
        </>
      }
      description={`This permanently deletes what ${PRODUCT_NAME} remembers inside this project and its summary. Your account-wide memory, your chats, and other members’ memory stay as they are.`}
      confirmLabel="Clear project memory"
      onConfirm={async () => {
        if (project && (await onClear(project.id))) onOpenChange(false);
      }}
    />
  );
}
