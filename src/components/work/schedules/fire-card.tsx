"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import {
  issueWorkFireToken,
  revokeWorkFireToken,
  type WorkFireToken,
} from "@/components/work/work-transport";
import { WorkStateNote } from "@/components/work/work-vocabulary";

/*
 * Firing an automation from somewhere else.
 *
 * The card exists only when the automation has the "Something calls it"
 * trigger, and that is the whole of its logic: a fire URL on an automation
 * nothing reads it for is a control that implies a capability the automation
 * does not have — somebody would paste it into a CI job and wait for a run that
 * cannot arrive. The trigger is added in the editor above; this appears
 * underneath it the moment it is saved.
 *
 * THE TOKEN IS SHOWN ONCE AND THEN IT IS GONE. Only its SHA-256 is stored, so
 * there is no read path that could show it again, and the card says so at the
 * moment it matters rather than in a tooltip somebody finds afterwards. Issuing
 * a second one is a ROLL: the previous token stops working, which is what
 * rolling a leaked credential means and what a person reaching for this button
 * a second time almost always wants.
 */

export function ScheduleFireCard({ schedule }: { schedule: ClientWorkSchedule }) {
  const [busy, setBusy] = React.useState(false);
  const [issued, setIssued] = React.useState<WorkFireToken | null>(null);
  const [hasToken, setHasToken] = React.useState(schedule.hasFireToken);
  const [issuedAt, setIssuedAt] = React.useState<string | null>(schedule.fireTokenIssuedAt);

  const trigger = schedule.triggers.find((entry) => entry.kind === "api");
  if (!trigger) return null;

  const url = `/api/work/schedules/${schedule.id}/fire`;

  const issue = async () => {
    setBusy(true);
    const result = await issueWorkFireToken(schedule.id);
    setBusy(false);
    if (result.kind === "ok") {
      setIssued(result.value);
      setHasToken(true);
      setIssuedAt(result.value.issuedAt);
      return;
    }
    toast.error(
      result.kind === "blocked"
        ? result.explanation
        : "Couldn’t issue a token. Whatever token this automation had still works."
    );
  };

  const revoke = async () => {
    setBusy(true);
    const result = await revokeWorkFireToken(schedule.id);
    setBusy(false);
    if (result.kind === "ok") {
      setIssued(null);
      setHasToken(false);
      setIssuedAt(null);
      toast.success("Revoked. Anything still calling with that token now gets a 401.");
      return;
    }
    toast.error("Couldn’t revoke the token. It is still working.");
  };

  return (
    <section className="rounded-surface border border-border bg-card px-4 py-3.5">
      <h2 className="font-mono text-label text-muted-foreground">Firing this from elsewhere</h2>
      <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
        A POST to this URL, carrying the token as a bearer header, starts one run. It does not move
        the schedule: whatever this automation was going to do next, it still does.
      </p>

      {/* The URL is not a secret and is always readable; the token is neither.
          Keeping them in separate blocks is what stops a reader copying the one
          they can see and wondering why it is refused.

          No radius on either block, and that is the ladder rather than an
          omission: this card is `rounded-surface` (16) with a 16px gutter, and
          outer = inner + padding leaves the inner corners square. A tonal band
          is what FLAT_UI asks for anyway — a fill where a fill is enough, and
          no second edge inside an edge. */}
      <pre className="mt-2.5 overflow-x-auto bg-secondary px-3 py-2 font-mono text-micro text-foreground">
        {`POST ${url}\nAuthorization: Bearer <token>\n{ "text": "optional" }`}
      </pre>

      {issued !== null && (
        <div className="mt-3">
          <WorkStateNote tone="warning">
            Copy this now. It is stored only as a hash, so this is the one time it can be shown —
            issuing another replaces it.
          </WorkStateNote>
          <pre className="mt-2 overflow-x-auto bg-secondary px-3 py-2 font-mono text-micro text-foreground">
            {issued.token}
          </pre>
        </div>
      )}

      <p className="mt-3 text-caption leading-relaxed text-muted-foreground">
        {hasToken
          ? issuedAt
            ? `A token was issued on ${new Date(issuedAt).toLocaleDateString()}. Issuing another stops it working.`
            : "This automation has a token. Issuing another stops it working."
          : "No token yet, so nothing outside Juno can start this."}
      </p>
      <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
        Text sent with a fire reaches the run as data from an untrusted source, after the
        instructions and marked as something to read rather than obey — and only when this
        automation’s API trigger is set to accept it.
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => void issue()} className="gap-1.5">
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {hasToken ? "Issue a new token" : "Issue a token"}
        </Button>
        {hasToken && (
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revoke()}>
            Revoke
          </Button>
        )}
      </div>
    </section>
  );
}
