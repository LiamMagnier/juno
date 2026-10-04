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
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The page's small print, and the one irreversible thing it can do.
 *
 * The privacy strip this replaces carried a second on/off switch, three
 * buttons and a paragraph in a filled box. The switch is the header's now; the
 * buttons are text links; the paragraph is the two sentences a reader needs
 * about what never reaches memory, set as a caption under everything else.
 */

const linkClass =
  "rounded-xs font-medium text-foreground underline-offset-2 transition-colors duration-fast ease-out-soft hover:underline disabled:pointer-events-none disabled:text-muted-foreground motion-reduce:transition-none";

export function MemoryFooter({
  paused,
  empty,
  onImport,
  onExport,
  onReset,
  onSettings,
  project,
  onClearProject,
}: {
  paused: boolean;
  /** Nothing is remembered anywhere: export and reset have nothing to act on. */
  empty: boolean;
  onImport: () => void;
  onExport: () => void;
  onReset: () => void;
  onSettings: () => void;
  /** The project the page is showing, when it is showing one. */
  project?: { id: string; name: string } | null;
  onClearProject?: () => void;
}) {
  return (
    <footer className="mt-10 border-t border-border pt-4 text-caption text-muted-foreground">
      <p className="flex items-start gap-2">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Incognito chats are never remembered. Sensitive subjects like health or religion are only learned if you
          allow them.
        </span>
      </p>
      <nav aria-label="Your memory data" className="ml-[1.375rem] mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <button type="button" onClick={onSettings} className={linkClass}>
          Memory settings
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={onImport} disabled={paused} className={linkClass}>
          Import
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" onClick={onExport} disabled={empty} className={linkClass}>
          Export
        </button>
        <span aria-hidden="true">·</span>
        {project && onClearProject ? (
          <>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={onClearProject} className={linkClass} data-clear-project="">
              <span>Clear</span> <span translate="no">{project.name}</span>
              <span>…</span>
            </button>
          </>
        ) : null}
        <span aria-hidden="true">·</span>
        <button type="button" onClick={onReset} disabled={empty} className={linkClass}>
          Reset memory…
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
            <Button variant="outline" onClick={() => onOpenChange(false)}>
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
    <Dialog open={project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            <span>Clear</span> <span translate="no">{project?.name}</span>
            <span>?</span>
          </DialogTitle>
          <DialogDescription>
            {`This permanently deletes what ${PRODUCT_NAME} remembers inside this project and its summary. Your account-wide memory, your chats, and other members’ memory stay as they are.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={clearing}
            onClick={async () => {
              if (project && (await onClear(project.id))) onOpenChange(false);
            }}
          >
            Clear project memory
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
