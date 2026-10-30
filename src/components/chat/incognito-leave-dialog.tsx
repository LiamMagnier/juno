"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { INCOGNITO_LEAVE_COPY, setIncognitoLeaveConfirmOff } from "@/components/chat/incognito-leave";

/**
 * "End this incognito chat?" (spec §6.1, D30), asked before in-app navigation
 * leaves an incognito chat that has something in it (incognito-leave.ts).
 *
 * An alert dialog: it interrupts on purpose and needs an answer. Focus lands
 * on Keep chatting, the answer that loses nothing, so Return or Escape keeps
 * the chat; End chat is one Tab away. Don't ask again is remembered on this
 * device only, and only when the person actually ends the chat with it ticked.
 * On a phone it rises as the house sheet (dialog.tsx).
 */
export function IncognitoLeaveDialog({
  open,
  onEnd,
  onKeep,
}: {
  open: boolean;
  /** End the chat and go where the person was going. */
  onEnd: () => void;
  /** Stay in the incognito chat. */
  onKeep: () => void;
}) {
  const [dontAsk, setDontAsk] = React.useState(false);
  const keepRef = React.useRef<HTMLButtonElement>(null);
  const checkboxId = React.useId();
  // A fresh question each time it opens.
  React.useEffect(() => {
    if (open) setDontAsk(false);
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
    >
      <DialogContent
        role="alertdialog"
        className="max-w-sm"
        data-incognito-leave=""
        hideClose
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          keepRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{INCOGNITO_LEAVE_COPY.title}</DialogTitle>
          <DialogDescription>{INCOGNITO_LEAVE_COPY.body}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2.5">
          <Checkbox id={checkboxId} checked={dontAsk} onCheckedChange={(value) => setDontAsk(value === true)} />
          <label htmlFor={checkboxId} className="cursor-pointer select-none text-ui text-foreground">
            {INCOGNITO_LEAVE_COPY.dontAsk}
          </label>
        </div>
        <DialogFooter>
          <Button ref={keepRef} variant="ghost" onClick={onKeep}>
            {INCOGNITO_LEAVE_COPY.keep}
          </Button>
          <Button
            onClick={() => {
              if (dontAsk) setIncognitoLeaveConfirmOff();
              onEnd();
            }}
          >
            {INCOGNITO_LEAVE_COPY.end}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
