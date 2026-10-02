"use client";

import * as React from "react";
import { StatusIcons } from "@/lib/app-icons";
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
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { SHARE_REPORT_DETAIL_MAX, SHARE_REPORT_REASONS, type ShareReportReason } from "@/lib/share-policy";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * The Report link at the foot of a public share page, and the form behind it.
 *
 * A public link is a stranger's page shown under Juno's name, so a visitor who
 * lands on a scam needs a way to say so that does not require an account. The
 * form posts to /api/share/report, keyed on the same token that showed the
 * page; the report queues for an admin (/admin/links) and nothing is removed
 * automatically (src/lib/share-moderation.ts says why).
 *
 * The trigger is as quiet as the account link beside it: a report link that
 * shouts reads as an accusation against every page it sits on, and most pages
 * are fine. The icon set has no flag, so it wears the warning triangle, the
 * nearest mark it has for "something is wrong here".
 *
 * Errors are shown in the dialog, not toasted. The visitor has typed a
 * sentence and is looking at the form; a toast in the corner is gone before
 * they find it, and the server's own words ("This link no longer exists", the
 * rate limit) are the most useful thing on the screen at that moment.
 */

type SendState = "idle" | "sending" | "sent";

const GENERIC_ERROR = "Couldn’t send the report. Please try again.";
const NETWORK_ERROR = `Couldn’t reach ${PRODUCT_NAME}. Check your connection and try again.`;

export function ReportShareButton({ token }: { token: string }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<ShareReportReason | "">("");
  const [detail, setDetail] = React.useState("");
  const [contact, setContact] = React.useState("");
  const [state, setState] = React.useState<SendState>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const doneRef = React.useRef<HTMLButtonElement>(null);

  const reasonLabelId = React.useId();
  const detailId = React.useId();
  const contactId = React.useId();

  const sending = state === "sending";

  const onOpenChange = (next: boolean) => {
    // A report in flight finishes before the dialog can close, so the visitor
    // sees whether it went rather than wondering.
    if (!next && sending) return;
    // A draft survives closing and reopening; a sent report does not, so the
    // next open is a fresh form rather than the thank-you from last time.
    // Reset on OPEN, not on close, so the panel does not swap its contents
    // while it is animating out.
    if (next && state === "sent") {
      setReason("");
      setDetail("");
      setContact("");
      setError(null);
      setState("idle");
    }
    setOpen(next);
  };

  // The submit button unmounts with the form, and focus would fall to the
  // document; hand it to the one control in the thank-you state instead.
  React.useEffect(() => {
    if (state === "sent") doneRef.current?.focus();
  }, [state]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!reason || sending) return;
    setState("sending");
    setError(null);
    const email = contact.trim();
    try {
      const res = await fetch("/api/share/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `contact` is left out rather than sent empty: the schema treats an
        // absent address as "no reply wanted", which is what an empty field means.
        body: JSON.stringify({ token, reason, detail: detail.trim(), ...(email ? { contact: email } : {}) }),
      });
      if (res.ok) {
        setState("sent");
        return;
      }
      // 400 (a bad reason or email), 404 (the link died while the form was
      // open) and 429 (the per-address limit) each carry a sentence written
      // for the visitor. Anything else is ours, and says nothing they can use.
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const known = res.status === 400 || res.status === 404 || res.status === 429;
      setError(known && body?.error ? body.error : GENERIC_ERROR);
      setState("idle");
    } catch {
      setError(NETWORK_ERROR);
      setState("idle");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {/* The account link's own recipe, so the two read as one row of
            footer links; the glyph is the bold 12px cut, sized to the caption. */}
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-xs text-caption text-muted-foreground transition-colors duration-fast ease-out-soft hover:text-foreground focus-visible:text-foreground"
        >
          <StatusIcons.warning className="size-3 shrink-0" aria-hidden="true" />
          Report
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Report this page</DialogTitle>
          <DialogDescription>
            {`Your report goes to the ${PRODUCT_NAME} team. The person who shared this page won’t see who sent it.`}
          </DialogDescription>
        </DialogHeader>

        {state === "sent" ? (
          <div className="space-y-4 motion-safe:animate-fade-in">
            <p role="status" className="flex items-start gap-2 text-body text-foreground">
              <StatusIcons.success className="mt-1 size-4 shrink-0 text-success" aria-hidden="true" />
              <span className="min-w-0">{`Thanks. The ${PRODUCT_NAME} team will review this page.`}</span>
            </p>
            <DialogFooter>
              <DialogClose asChild>
                <Button ref={doneRef}>Done</Button>
              </DialogClose>
            </DialogFooter>
          </div>
        ) : (
          // noValidate: the server is the one judge of the email address (its
          // schema, not the browser's), and a native bubble would be a second,
          // differently-worded verdict on the same field.
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <div className="space-y-2">
              <p id={reasonLabelId} className="text-ui font-medium text-foreground">
                What’s the problem?
              </p>
              {/* Radix's radio group: one tab stop, arrows move the choice,
                  announced as a group under the question above. Each row is a
                  <label>, so the whole row is the target, not the 18px well. */}
              <RadioGroup
                value={reason}
                onValueChange={(value) => setReason(value as ShareReportReason)}
                aria-labelledby={reasonLabelId}
                required
                disabled={sending}
                className="gap-0 divide-y divide-border/70 overflow-hidden rounded-card border border-border"
              >
                {SHARE_REPORT_REASONS.map((option) => (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors duration-fast ease-out-soft hover:bg-accent"
                  >
                    <RadioGroupItem value={option.id} />
                    <span className="min-w-0 flex-1 text-ui text-foreground">{option.label}</span>
                  </label>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label htmlFor={detailId}>
                What’s wrong? <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id={detailId}
                value={detail}
                onChange={(e) => setDetail(e.target.value)}
                maxLength={SHARE_REPORT_DETAIL_MAX}
                disabled={sending}
                placeholder="Anything that helps us find it, like what it asks for or where it sends you."
                className="min-h-20"
              />
            </div>

            <Field
              id={contactId}
              type="email"
              inputMode="email"
              autoComplete="email"
              label="Email (if you’d like a reply)"
              hint={`Only the ${PRODUCT_NAME} team sees it.`}
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              maxLength={320}
              disabled={sending}
            />

            {error && (
              // The share dialog's failure line: the destructive ink and the
              // failure circle, announced when it appears.
              <p role="alert" className="flex items-start gap-2 text-body text-destructive motion-safe:animate-rise-in">
                <StatusIcons.error className="mt-1 size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{error}</span>
              </p>
            )}

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="ghost" disabled={sending}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={!reason} loading={sending}>
                Send report
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
