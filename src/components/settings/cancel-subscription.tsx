"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useFormatLocale, formatDate } from "@/components/settings/format";
import type { CancellationRecap } from "@/lib/cancellation";

/*
 * "Cancel subscription": the online cancellation function French law requires
 * (Code de la consommation L215-1-1, D215-1 to D215-3).
 *
 * The rules it follows, and why it looks the way it does:
 *   - The label says what it does, in plain words (D215-1: "résilier votre
 *     contrat" or an unambiguous equivalent). The i18n catalogue renders it in
 *     French; it is never hidden behind "Manage billing".
 *   - It is reachable directly from where people subscribe: mount it in the
 *     plan header of Settings → Plan & usage, beside "Change plan" (the
 *     settings billing section belongs to the pricing-UI lane; see
 *     docs/pricing/LEGAL_CHECKLIST.md § Cancellation).
 *   - Before notifying, the person sees a recap they can check (D215-3): name,
 *     email, plan, the contract reference, and the date it ends. Then ONE
 *     button, "Notify cancellation", sends it. Two clicks from the section.
 *   - The confirmation goes out by email (L215-1-1 al. 3); the dialog says so.
 *   - A pending cancellation can be undone until it takes effect.
 *   - An App Store subscription cannot be cancelled here; the control says
 *     where it can be.
 *
 * Renders nothing for an account with no paid subscription.
 */

type Source = "stripe" | "app_store" | "none";

interface State {
  source: Source;
  active: boolean;
  cancelAtPeriodEnd: boolean;
  recap: CancellationRecap;
}

const APPLE_SUBSCRIPTIONS_URL = "https://apps.apple.com/account/subscriptions";

export function CancelSubscription() {
  const router = useRouter();
  const formatAt = useFormatLocale();
  const [state, setState] = React.useState<State | null>(null);
  const [open, setOpen] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [done, setDone] = React.useState<null | "cancelled" | "resumed">(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await fetch("/api/stripe/cancel", { cache: "no-store" }).catch(() => null);
    if (res?.ok) setState((await res.json()) as State);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "cancel" | "resume") => {
    setSending(true);
    setError(null);
    const res = await fetch("/api/stripe/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => null);
    const body = (res ? await res.json().catch(() => ({})) : {}) as { error?: string };
    setSending(false);
    if (!res?.ok) {
      setError(body.error ?? "Couldn’t send that. Please try again.");
      return;
    }
    setDone(action === "cancel" ? "cancelled" : "resumed");
    // After a cancel the dialog keeps showing its confirmation; the control
    // re-reads its state when the dialog closes, so the message is not
    // unmounted out from under the person reading it.
    if (action === "resume") {
      await load();
      router.refresh();
    }
  };

  if (!state || !state.active || state.source === "none") return null;

  if (state.source === "app_store") {
    return (
      <p className="text-ui text-muted-foreground">
        <span>Bought through the App Store. To cancel, open your</span>{" "}
        <a href={APPLE_SUBSCRIPTIONS_URL} className="underline underline-offset-4" rel="noopener noreferrer">
          Apple ID subscriptions
        </a>
        .
      </p>
    );
  }

  const { recap } = state;
  const endsOn = recap.endsAt ? formatDate(Date.parse(recap.endsAt), formatAt) : null;

  if (state.cancelAtPeriodEnd) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui text-muted-foreground">
          {endsOn ? (
            <>
              <span>Cancelled. Your plan ends on</span> <span>{endsOn}</span>.
            </>
          ) : (
            <span>Cancelled. Your plan ends at the end of this period.</span>
          )}
        </span>
        <Button variant="outline" size="sm" onClick={() => void act("resume")} loading={sending}>
          Keep my subscription
        </Button>
        {error && (
          <span role="alert" className="text-ui text-destructive">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (sending) return;
        if (next) {
          setDone(null);
          setError(null);
        } else if (done === "cancelled") {
          void load();
          router.refresh();
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="destructive-outline" size="sm">
          Cancel subscription
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Cancel your subscription</DialogTitle>
          <DialogDescription>Check the details below, then notify the cancellation.</DialogDescription>
        </DialogHeader>

        {done === "cancelled" ? (
          <div className="space-y-4">
            <p role="status" className="text-body text-foreground">
              {recap.email ? (
                <>
                  <span>Cancellation received. A confirmation is on its way to</span> <span>{recap.email}</span>.
                </>
              ) : (
                <span>Cancellation received.</span>
              )}
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button>Done</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ui">
              <dt className="text-muted-foreground">Name</dt>
              <dd className="min-w-0 truncate">{recap.name ?? "—"}</dd>
              <dt className="text-muted-foreground">Email</dt>
              <dd className="min-w-0 truncate">{recap.email ?? "—"}</dd>
              <dt className="text-muted-foreground">Plan</dt>
              <dd translate="no">{recap.planName}</dd>
              <dt className="text-muted-foreground">Reference</dt>
              <dd className="min-w-0 truncate font-mono text-label" translate="no">
                {recap.reference}
              </dd>
              <dt className="text-muted-foreground">Ends on</dt>
              <dd>{endsOn ?? "The end of the current period"}</dd>
            </dl>
            <p className="text-ui text-muted-foreground">
              You keep your plan until then and won’t be charged again. After that your account moves to Free, and
              your conversations and files stay. You can undo this until it takes effect.
            </p>
            <p className="text-ui text-muted-foreground">
              Want it to end sooner, with a refund for the days you won’t use? Write to support instead.
            </p>
            {error && (
              <p role="alert" className="text-body text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={sending}>
                  Keep subscription
                </Button>
              </DialogClose>
              <Button variant="destructive" onClick={() => void act("cancel")} loading={sending}>
                Notify cancellation
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
