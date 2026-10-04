"use client";

import * as React from "react";
import { ChevronRight } from "@/components/ui/icons";
import { Collapse } from "@/components/ui/collapse";
import { NeedsLead, QuietButton, TELL_INSTEAD_LABEL, VerbButton } from "@/components/chat/decision";
import { TIMING } from "@/lib/interaction";
import { PERMISSION_GRANT_LABEL } from "@/lib/permissions/taxonomy";
import { Textarea } from "@/components/ui/textarea";
import type { WorkRiskLevel } from "@/lib/work/domain";
import type { WorkApprovalDecisionInput } from "@/components/work/work-transport";
import type { WorkApprovalCard } from "@/components/work/work-decisions";
import { actionLabel, workTimeAgo } from "@/components/work/work-vocabulary";
import {
  actionVerb,
  mayStopAsking,
  previewBody,
  previewTarget,
} from "@/components/work/approvals/action-verbs";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

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
  edit: `This writes to a file. ${PRODUCT_NAME} can show you what changed afterwards.`,
  command: "This runs a command on the machine this task is on.",
  sensitive: `This touches something private. ${PRODUCT_NAME} asks every time, whatever you have allowed before.`,
  irreversible: `This cannot be undone — not by ${PRODUCT_NAME}, and not from this page afterwards.`,
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

  // Arming (INTERACTION_SPEC T6): for `approvalArm` after the card appears, or
  // after the action it shows changes, the verb ignores activation.
  const [armed, setArmed] = React.useState(false);
  React.useEffect(() => {
    setArmed(false);
    const timer = window.setTimeout(() => setArmed(true), TIMING.approvalArm);
    return () => window.clearTimeout(timer);
  }, [approval.id, digest]);

  if (!answerable) {
    // Settled: one quiet line, the receipt of what was decided.
    return (
      <p className="flex flex-wrap items-baseline gap-x-2 text-ui leading-relaxed text-muted-foreground">
        <span className="text-foreground/75">{approval.summary}</span>
        <span>{describeDecision(approval, expired)}</span>
      </p>
    );
  }

  return (
    // Listed exactly like a question (decision.tsx): the attention words, then
    // what, then the payload as a quote and one button family. It sits inside
    // the task card, so it draws no box of its own.
    <div role="group" aria-label={`Needs your approval: ${approval.summary}`}>
      <p className="text-body text-foreground">
        <NeedsLead>Needs your approval:</NeedsLead> {approval.summary}
      </p>

      {(body !== null || target !== null) && (
        <div className="mt-2 pl-3.5 shadow-[inset_2px_0_0_hsl(var(--border))]">
          {target !== null && (
            <p className="text-ui text-muted-foreground">
              To <span className="text-foreground">{target}</span>
            </p>
          )}
          {body !== null && <PreviewBody body={body} as={verb.bodyAs} className={target !== null ? "mt-1" : undefined} />}
        </div>
      )}

      <p className="mt-2 text-ui leading-relaxed text-foreground/75">{RISK_CONSEQUENCE[approval.risk]}</p>

      {parameters.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowParameters((current) => !current)}
            aria-expanded={showParameters}
            className="-ml-2 mt-1 inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none coarse:min-h-11"
          >
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none",
                showParameters && "rotate-90"
              )}
              aria-hidden="true"
            />
            Exactly what will be done
          </button>
          <Collapse open={showParameters} innerClassName="pt-1">
            <dl className="space-y-1">
              {parameters.map(([key, value]) => (
                <div key={key} className="flex gap-2 font-mono text-micro leading-relaxed">
                  <dt className="w-20 shrink-0 text-muted-foreground">{key}</dt>
                  <dd className="min-w-0 break-all text-foreground">{String(value)}</dd>
                </div>
              ))}
            </dl>
          </Collapse>
        </>
      )}

      {digest === null ? (
        <p className="mt-2.5 text-ui leading-relaxed text-foreground">
          {`This request did not arrive with the signature ${PRODUCT_NAME} needs to accept an answer from the web. Decide it in the ${PRODUCT_NAME} app on the Mac that raised it.`}
        </p>
      ) : amending ? (
        <div className="mt-3">
          <label htmlFor={`amend-${approval.id}`} className="text-ui text-muted-foreground">
            {`What should ${PRODUCT_NAME} do instead?`}
          </label>
          <Textarea
            id={`amend-${approval.id}`}
            value={amendment}
            onChange={(event) => setAmendment(event.target.value)}
            rows={3}
            placeholder="Send it to the finance alias instead, and drop the last paragraph."
            className="mt-1.5"
          />
          {/* The honest sentence: the signature covers the action as raised,
              so this refuses it and passes the instruction on. */}
          <p className="mt-1.5 text-ui leading-relaxed text-muted-foreground">
            {`${PRODUCT_NAME} will not do this one. It will be told what you want instead, and will carry on from there.`}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <QuietButton
              disabled={busy}
              onClick={() => {
                setAmending(false);
                setAmendment("");
              }}
            >
              Back
            </QuietButton>
            <VerbButton
              label="Send this instruction"
              armed={trimmedAmendment.length > 0}
              busy={busy}
              onClick={() => onDecide(approval, "denied", trimmedAmendment)}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <QuietButton disabled={busy} onClick={() => onDecide(approval, "denied")}>
              Not now
            </QuietButton>
            {/* The verb, the one filled control. Its accessible name restates
                the summary: "Send" alone, read out of context, is not enough to
                decide on. A standing permission waits behind its caret, with
                its exact scope. */}
            <VerbButton
              label={verb.verb}
              accessibleLabel={`${verb.verb}: ${approval.summary}`}
              armed={armed}
              busy={busy}
              danger={approval.risk === "irreversible"}
              onClick={() => onDecide(approval, "allowed")}
              menuLabel={`More ways to ${verb.verb.toLowerCase()}`}
              alternatives={
                mayStopAsking(approval.action, approval.risk)
                  ? [
                      { label: `${verb.verb} once`, line: `${PRODUCT_NAME} asks again next time.`, onSelect: () => onDecide(approval, "allowed") },
                      {
                        label: PERMISSION_GRANT_LABEL.allow_for_task,
                        line: `Covers “${actionLabel(approval.action)}” for the rest of this task only. It lapses when the task ends.`,
                        onSelect: () => onDecide(approval, "allowed_always"),
                      },
                    ]
                  : undefined
              }
            />
            <QuietButton disabled={busy} className="@[28rem]:ml-auto" onClick={() => setAmending(true)}>
              {TELL_INSTEAD_LABEL}
            </QuietButton>
          </div>

          {approval.expiresAt !== null && (
            <p className="mt-2.5 text-ui text-muted-foreground">
              {`Unanswered, this expires and ${PRODUCT_NAME} stops rather than acting on it.`}
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
      return `Expired unanswered — ${PRODUCT_NAME} stopped rather than acting on a stale approval`;
    case "superseded":
      return "Replaced by a later request";
    case "pending":
      return expired
        ? `Expired unanswered — ${PRODUCT_NAME} stopped rather than acting on a stale approval`
        : "Waiting";
  }
}
