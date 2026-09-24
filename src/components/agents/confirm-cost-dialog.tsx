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
import { formatEstimate } from "@/components/agents/agents-transport";

/**
 * The one question the cost preflight asks: this will cost about $X of your
 * usage window, start it?
 *
 * A dialog rather than inline, because it is a decision about money that a
 * press on an agent's page provoked, and the answer must be given before
 * anything runs. Cancel is first and is the default focus, the way the Work
 * approval card puts Deny first: the safe answer is the one a stray Enter gives.
 */
export function ConfirmCostDialog({
  pending,
  onAnswer,
}: {
  pending: { title: string; estimatedCostMicroUsd: number } | null;
  onAnswer: (yes: boolean) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (!pending) setBusy(false);
  }, [pending]);
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => (!open ? onAnswer(false) : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start this task?</DialogTitle>
          <DialogDescription>
            {pending
              ? `“${pending.title}” will cost about ${formatEstimate(pending.estimatedCostMicroUsd)} of your usage window. It stops to ask before anything it cannot take back.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => onAnswer(false)} disabled={busy}>
            Not now
          </Button>
          <Button
            loading={busy}
            onClick={() => {
              setBusy(true);
              onAnswer(true);
            }}
          >
            Start it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Runs a start that may come back asking for a yes, and asks it.
 *
 * `run(confirm)` is called once without confirmation; if the server answers
 * `confirm`, the dialog opens and a yes calls it again with the SAME key, so
 * the confirmed start lands on the draft the first call made.
 */
export function useCostConfirmation() {
  const [pending, setPending] = React.useState<{
    title: string;
    estimatedCostMicroUsd: number;
    resolve: (yes: boolean) => void;
  } | null>(null);

  const ask = React.useCallback(
    (title: string, estimatedCostMicroUsd: number) =>
      new Promise<boolean>((resolve) => setPending({ title, estimatedCostMicroUsd, resolve })),
    []
  );

  const dialog = (
    <ConfirmCostDialog
      pending={pending}
      onAnswer={(yes) => {
        pending?.resolve(yes);
        setPending(null);
      }}
    />
  );
  return { ask, dialog };
}
