"use client";

import * as React from "react";
import { ChevronDown, Clock, Pencil } from "lucide-react";
import { StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import type { WorkRiskLevel } from "@/lib/work/domain";
import type { WorkApprovalDecisionInput } from "@/components/work/work-transport";
import type { WorkApprovalCard } from "@/components/work/work-decisions";
import { RiskPill, actionLabel, workTimeAgo } from "@/components/work/work-vocabulary";
import {
  actionVerb,
  mayStopAsking,
  previewBody,
  previewTarget,
} from "@/components/work/approvals/action-verbs";
import { cn } from "@/lib/utils";

/*
 * One decision, asked the way a person would ask it.
 *
 * The card this replaces was correct about everything except how a decision is
 * read. It printed the summary, then the action's own name, then an unfiltered
 * `<dl>` of every string, number and boolean in the detail bag, then two buttons
 * labelled "Don't do it" and "Allow this once". Everything a reviewer needs was
 * on the screen; nothing was ranked, and the one thing that decides the answer —
 * WHAT THE MESSAGE ACTUALLY SAYS — was a row in a parameter table between
 * `threadId` and `mimeType`.
 *
 * Three changes, in order of how much they matter:
 *
 *   1. THE BUTTON CARRIES THE VERB. "Send", "Delete for good", "Buy" — never
 *      "Allow". A generic verb makes every gate identical to the muscle that
 *      presses it, which is precisely how somebody sends a draft they meant to
 *      read. See `action-verbs.ts` for the table and the argument.
 *
 *   2. THE ARTIFACT IS PREVIEWED, THE PARAMETERS ARE FOLDED. The body of the
 *      email, the list of files, the command — rendered as the thing it is,
 *      above the fold. The parameter table is still there, complete and
 *      unedited, behind "Show parameters", because the digest is computed over
 *      the whole detail and a card that showed less than the digest covers
 *      would be asking the reader to sign for something they were not shown.
 *      Folding it is not hiding it; the disclosure is one press and it is
 *      labelled with the count.
 *
 *   3. AMEND IS A REAL ANSWER. Nobody in this category ships it, and the reason
 *      is that it looks like it needs an API for editing arguments. It does not,
 *      because there is already an honest way to say "not that, this": the
 *      decision endpoint takes a `reason` alongside a refusal, and the executor
 *      puts it in front of the model. So Amend REFUSES the action and hands the
 *      run the correction — and the copy says exactly that, because a control
 *      that looked like it was editing the pending action in place would be
 *      lying about what happens next.
 *
 *      It could not work any other way. `actionDigest` is computed server-side
 *      over the action AND its detail, and the endpoint refuses a decision whose
 *      digest does not match, precisely so a re-rendered card cannot authorise
 *      something the user never saw. A client that edited the arguments and
 *      submitted the old digest would be defeating the one check that makes the
 *      whole gate trustworthy. Amend works with that guarantee rather than
 *      around it.
 */

/**
 * What answering costs, per risk level.
 *
 * The line under the buttons is the whole difference between a notification and
 * a decision. "Juno wants to send an email" tells the reader what is about to
 * happen; "once it is sent, nothing here can unsend it" tells them why they are
 * being asked, which is the only reason to stop and read.
 */
const RISK_CONSEQUENCE: Record<WorkRiskLevel, string> = {
  safe: "Nothing here changes anything outside this task.",
  edit: "This writes to a file. Juno can show you what changed afterwards.",
  command: "This runs a command on the machine this task is on.",
  sensitive: "This touches something private. Juno asks every time, whatever you have allowed before.",
  irreversible: "This cannot be undone — not by Juno, and not from this page afterwards.",
};

export function ApprovalCard({
  approval,
  expired,
  busy,
  onDecide,
}: {
  approval: WorkApprovalCard;
  expired: boolean;
  busy: boolean;
  onDecide: (
    approval: WorkApprovalCard,
    decision: WorkApprovalDecisionInput,
    reason?: string
  ) => void;
}) {
  const [showParameters, setShowParameters] = React.useState(false);
  const [amending, setAmending] = React.useState(false);
  const [amendment, setAmendment] = React.useState("");

  const answerable = approval.decision === "pending" && !expired;
  const digest = approval.actionDigest;
  const verb = actionVerb(approval.action);
  const body = previewBody(approval.detail, verb);
  const target = previewTarget(approval.detail, verb);

  const parameters = Object.entries(approval.detail).filter(
    ([, value]) =>
      typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );

  const trimmedAmendment = amendment.trim();

  if (!answerable) {
    return (
      <div className="rounded-field border border-border/60 bg-card px-3.5 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusIcons.security className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <RiskPill risk={approval.risk} />
          <span className="ml-auto font-mono text-micro tabular-nums text-muted-foreground">
            {workTimeAgo(approval.createdAt)}
          </span>
        </div>
        <p className="mt-2 text-ui leading-relaxed text-foreground">{approval.summary}</p>
        <p className="mt-1 text-ui text-muted-foreground">{actionLabel(approval.action)}</p>
        <p className="mt-2.5 flex items-center gap-1.5 font-mono text-micro text-muted-foreground">
          <Clock className="size-3" aria-hidden="true" />
          {describeDecision(approval, expired)}
        </p>
      </div>
    );
  }

  return (
    <div
      // A pending approval is the only thing on the page that stops the run
      // dead, and it competes with every other panel for the eye. The heavier
      // border and the ring are the difference between a card that is read and
      // one that is scrolled past — which, for the request holding the whole
      // task, is the difference between a decision and a task that quietly
      // never finishes.
      className="rounded-field border border-warning/60 bg-warning/[0.12] px-3.5 py-3.5 ring-1 ring-warning/40"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusIcons.security className="size-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="font-mono text-micro text-warning-foreground">Your decision</span>
        <RiskPill risk={approval.risk} />
        <span className="ml-auto font-mono text-micro tabular-nums text-muted-foreground">
          {workTimeAgo(approval.createdAt)}
        </span>
      </div>

      <p className="mt-2 text-body font-medium leading-relaxed text-foreground">{approval.summary}</p>

      {/*
        The preview — the thing the reader is actually deciding about, rendered
        as what it is rather than as a table row. `target` above it because "to
        finance@acme.com" changes the answer more than any word of the body.
      */}
      {body !== null && (
        <div className="mt-2.5 rounded-field bg-warning/10 px-3 py-2.5">
          {target !== null && (
            <p className="font-mono text-micro text-muted-foreground">
              <span className="text-warning-foreground">To</span> {target}
            </p>
          )}
          <PreviewBody body={body} as={verb.bodyAs} className={target !== null ? "mt-1.5" : undefined} />
        </div>
      )}
      {body === null && target !== null && (
        <p className="mt-2 font-mono text-micro text-muted-foreground">
          <span className="text-warning-foreground">To</span> {target}
        </p>
      )}

      {/*
        Everything the digest covers, on request. The count is in the label so
        the reader knows whether it is worth the press, and the whole set is
        rendered unedited — this is what the server will check the answer
        against.
      */}
      {parameters.length > 0 && (
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowParameters((current) => !current)}
            aria-expanded={showParameters}
            className="mt-2 h-7 gap-1.5 px-1.5 font-mono text-micro text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn(
                "size-3 transition-transform duration-fast ease-in-out",
                showParameters && "rotate-180"
              )}
              aria-hidden="true"
            />
            {showParameters ? "Hide" : "Show"} {parameters.length}{" "}
            {parameters.length === 1 ? "parameter" : "parameters"}
          </Button>
          {showParameters && (
            <dl className="mt-1.5 space-y-1 rounded-field bg-warning/10 px-2.5 py-2">
              {parameters.map(([key, value]) => (
                <div key={key} className="flex gap-2 font-mono text-micro leading-relaxed">
                  <dt className="w-20 shrink-0 text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-all text-foreground">{String(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}

      <p className="mt-2.5 text-ui leading-relaxed text-warning-foreground">
        {RISK_CONSEQUENCE[approval.risk]}
      </p>

      {digest === null ? (
        // The request arrived without the digest that proves which action is
        // being authorised, so this browser has no way to answer it that the
        // server would accept. Saying where it CAN be answered is the only
        // useful thing left; a greyed-out button would not say even that.
        <p className="mt-2.5 text-ui leading-relaxed text-warning-foreground">
          This request did not arrive with the signature Juno needs to accept an answer from the
          web. Decide it in the Juno app on the Mac that raised it.
        </p>
      ) : amending ? (
        <div className="mt-3">
          <label
            htmlFor={`amend-${approval.id}`}
            className="font-mono text-micro text-warning-foreground"
          >
            What should it do instead?
          </label>
          <Textarea
            id={`amend-${approval.id}`}
            value={amendment}
            onChange={(event) => setAmendment(event.target.value)}
            rows={3}
            placeholder="Send it to the finance alias instead, and drop the last paragraph."
            className="mt-1.5"
          />
          {/*
            The honest sentence. Amend does not edit the pending action — it
            cannot, because the signature covers the action as raised — so the
            card says what will really happen rather than letting the control's
            name imply an edit in place.
          */}
          <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
            Juno will not do this one. It will be told what you want instead, and will carry on from
            there.
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setAmending(false);
                setAmendment("");
              }}
              className="h-8"
            >
              Back
            </Button>
            <Button
              size="sm"
              disabled={busy || trimmedAmendment.length === 0}
              onClick={() => onDecide(approval, "denied", trimmedAmendment)}
              className="h-8"
            >
              Send this instruction
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Refuse first and given equal weight. The reader is being asked to
                stop and think, and a row that leads with a primary-coloured
                approve has already answered for them. */}
            <Button
              variant="destructive-outline"
              size="sm"
              disabled={busy}
              onClick={() => onDecide(approval, "denied")}
              className="h-8"
            >
              Don’t
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setAmending(true)}
              className="h-8 gap-1.5"
            >
              <Pencil className="size-3.5" aria-hidden="true" />
              Change it
            </Button>
            {/*
              The verb, and the one control on the card that is primary-coloured.
              `aria-label` restates the summary because "Send" alone, read out of
              context by a screen reader moving control to control, is not enough
              to decide on.
            */}
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onDecide(approval, "allowed")}
              aria-label={`${verb.verb}: ${approval.summary}`}
              className="h-8"
            >
              {verb.verb}
            </Button>

            {mayStopAsking(approval.action, approval.risk) && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    className="h-8 gap-1.5 text-muted-foreground"
                  >
                    More
                    <ChevronDown className="size-3.5" aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-72">
                  <DropdownMenuItem onSelect={() => onDecide(approval, "allowed_always")}>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span>{verb.verb}, and stop asking</span>
                      {/*
                        The exact scope, because a standing permission whose reach
                        the reader has to guess is one they will regret. It is
                        narrower than most products offer — this run, this action —
                        and saying so is what makes it safe to offer at all.
                      */}
                      <span className="text-caption leading-relaxed text-muted-foreground">
                        Covers “{actionLabel(approval.action)}” for the rest of this task only. It
                        lapses when the task ends.
                      </span>
                    </div>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {approval.expiresAt !== null && (
            <p className="mt-2 flex items-center gap-1.5 font-mono text-micro text-muted-foreground">
              <Clock className="size-3" aria-hidden="true" />
              Unanswered, this expires and Juno stops rather than acting on it.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The body, rendered as the kind of thing it is.
 *
 * Three renderers rather than one, because a message, a file list and a command
 * are read differently and flattening them into one `<pre>` is how the message
 * ends up in a monospace box that says "code" to the reader. Prose is the
 * default and is set in the reading face; a path list is a real list with one
 * item per line; a command is the one case that IS code and gets the monospace
 * treatment it has earned.
 *
 * `whitespace-pre-wrap` everywhere: a draft email's paragraph breaks are part of
 * what the reader is approving, and collapsing them shows a message that is not
 * the message.
 */
function PreviewBody({
  body,
  as,
  className,
}: {
  body: string;
  as: "prose" | "paths" | "command";
  className?: string;
}) {
  if (as === "paths") {
    const lines = body.split("\n").filter((line) => line.trim().length > 0);
    return (
      <ul className={cn("space-y-0.5", className)}>
        {lines.map((line, index) => (
          <li
            key={`${line}-${index}`}
            className="break-all font-mono text-micro leading-relaxed text-foreground"
          >
            {line}
          </li>
        ))}
      </ul>
    );
  }
  if (as === "command") {
    return (
      <p
        className={cn(
          "whitespace-pre-wrap break-all font-mono text-micro leading-relaxed text-foreground",
          className
        )}
      >
        {body}
      </p>
    );
  }
  return (
    <p
      className={cn(
        "max-h-64 overflow-y-auto whitespace-pre-wrap text-ui leading-relaxed text-foreground",
        className
      )}
    >
      {body}
    </p>
  );
}

export function describeDecision(approval: WorkApprovalCard, expired: boolean): string {
  switch (approval.decision) {
    case "allowed":
      return `Allowed ${workTimeAgo(approval.decidedAt ?? approval.createdAt)}`;
    case "allowed_always":
      return `Allowed for the rest of this task ${workTimeAgo(approval.decidedAt ?? approval.createdAt)}`;
    case "denied":
      return `Refused ${workTimeAgo(approval.decidedAt ?? approval.createdAt)}`;
    case "expired":
      return "Expired unanswered — Juno stopped rather than acting on a stale approval";
    case "superseded":
      return "Replaced by a later request";
    case "pending":
      return expired
        ? "Expired unanswered — Juno stopped rather than acting on a stale approval"
        : "Waiting";
  }
}
