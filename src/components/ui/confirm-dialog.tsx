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

/**
 * THE CONFIRMATION ("Delete X?", "Reset memory?", "Sign out of every
 * device?"). About thirty of these were assembled by hand from DialogContent,
 * and they had drifted into three widths (384, 448 and 512 for one paragraph),
 * two Cancel styles (ghost and outline), a ✕ beside a Cancel that did the
 * same thing, and dialogs that could be dismissed halfway through the request
 * they were confirming. This is the one shape:
 *
 *   - One width (`max-w-sm`), the dialog's own title and description rungs.
 *   - Cancel leading, the action trailing: the ghost-cancel / solid-confirm
 *     pair the controls gallery documents. A phone stacks the action on top.
 *   - Cancel is the only way out besides Escape, so there is no ✕.
 *   - Focus lands on Cancel, the safe action, so Return never confirms by
 *     accident (and a keyboard user starts from the choice that undoes nothing).
 *   - `role="alertdialog"`: it interrupts to ask about a consequence, which is
 *     what that role announces.
 *   - While `busy`, the action shows its spinner (Button `loading`), Cancel is
 *     disabled and nothing closes the dialog, so the request it confirms is
 *     never orphaned behind a closed dialog.
 *
 * `tone="default"` is for a confirmation whose action is not destructive (it
 * takes the primary fill). `children` sit between the description and the
 * actions (a "Don't ask again" checkbox, a typed confirmation).
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "destructive",
  onConfirm,
  busy = false,
  confirmDisabled = false,
  ...rest
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  confirmLabel: React.ReactNode;
  cancelLabel?: React.ReactNode;
  tone?: "destructive" | "default";
  onConfirm: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
} & Pick<React.ComponentPropsWithoutRef<typeof DialogContent>, "onCloseAutoFocus"> & {
    /** Test and styling hooks, passed to the panel (e.g. `data-canvas-close-dialog`). */
    [data: `data-${string}`]: string | undefined;
  }) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        role="alertdialog"
        hideClose
        className="max-w-sm"
        {...(description ? {} : { "aria-describedby": undefined })}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus({ preventScroll: true });
        }}
        {...rest}
      >
        <DialogHeader>
          <DialogTitle className="break-words">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        <DialogFooter>
          <Button ref={cancelRef} type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={tone === "destructive" ? "destructive" : "default"}
            loading={busy}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
