"use client";

import * as React from "react";
import Link from "next/link";
import { ActionIcons, CodeIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { ClientWorkHost } from "@/lib/work/serializers";
import {
  ALWAYS_CONFIRM_ACTIONS,
  WORK_APPROVAL_MODE_LABEL,
  WORK_APPROVAL_MODE_SUMMARY,
  WORK_PERMISSION_POLICIES,
  DEFAULT_WORK_PERMISSION_POLICY,
} from "@/lib/work/domain";
import { WorkPageFrame } from "@/components/work/work-nav";
import { WorkHostRow } from "@/components/work/work-host-row";
import { WorkLoadError, WorkRowSkeletons } from "@/components/work/shell/work-states";
import { WORK_POLL_MS, WORK_SYNC_EVENT, fetchWorkHosts } from "@/components/work/work-transport";
import { WorkStateNote } from "@/components/work/work-vocabulary";
import { actionVerb } from "@/components/work/approvals/action-verbs";
import { cn } from "@/lib/utils";

/**
 * What Juno is allowed to do, and on which machine.
 *
 * WHY THIS PAGE EXISTS AND "HOSTS" DOES NOT. The tab this replaces was called
 * Hosts and listed Macs. "Host" is Juno's word for a machine that claims runs —
 * accurate, and a word no business user has ever used about their own laptop —
 * and it sat in a row of tabs otherwise named after things the user made. Worse,
 * it was the ONLY place in the product that talked about permissions, while the
 * permission decision people actually make dozens of times a day happens on an
 * approval card inside a task. Somebody who allowed something and wanted to know
 * what they had allowed had nowhere to go.
 *
 * So the subject is Permissions and it is answered in three parts, in the order
 * a person asks them:
 *
 *   1. WHAT ALWAYS ASKS. The floor. No setting anywhere turns these off, and
 *      saying so plainly is worth more than any control on this page — it is the
 *      one promise that makes the other two safe to read.
 *   2. HOW MUCH IT ASKS OTHERWISE. The three approval modes, explained, with
 *      where each is actually set. Deliberately read-only here: the mode is a
 *      property of a task and of a Mac, not of the account, and a control here
 *      would be a fourth place to set it that agrees with none of the others.
 *   3. WHICH MACHINES. The Mac list, unchanged in behaviour from the page it
 *      absorbs, because that part was right.
 *
 * WHAT IS HONESTLY NOT HERE. There is no list of standing "stop asking"
 * allowances, and there is no revoke button for one. A standing allowance in
 * Juno is scoped to a single run and keyed on one action — `approvalRuling`
 * reads it as "you allowed this kind of step for the rest of this task" — and it
 * lapses when the run ends. There is no table of them and no endpoint that lists
 * or clears one, so a panel here would either be empty or invented. The card
 * that grants them says the scope out loud instead, which is the honest place
 * for it, and section 2 below states the lifetime.
 */
export default function WorkPermissionsPage() {
  const [hosts, setHosts] = React.useState<ClientWorkHost[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  const load = React.useCallback(async () => {
    const result = await fetchWorkHosts();
    if (result.kind === "ok") {
      setHosts(result.value);
      setFailed(false);
      return;
    }
    // `hosts` is deliberately not touched. Before the first success it is still
    // null and the note renders instead of an empty list — an empty list and a
    // failed request are the same picture, and only one of them means "you have
    // no Macs". After a success it holds the last real answer, and a dropped
    // poll establishes nothing about the fleet that would justify replacing it.
    setFailed(true);
  }, []);

  React.useEffect(() => {
    void load();
    const tick = () => {
      if (!document.hidden) void load();
    };
    const interval = window.setInterval(tick, WORK_POLL_MS);
    window.addEventListener(WORK_SYNC_EVENT, tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(WORK_SYNC_EVENT, tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  /**
   * Revoked Macs last, and otherwise exactly the order the route sent.
   *
   * The route orders by `lastSeenAt` descending, which is right for the ones
   * that still work — the Mac you were just using is the one you came here
   * about. It is the wrong place for a revoked machine, which heartbeated
   * recently precisely because it was in use right up until it was revoked.
   */
  const ordered = React.useMemo(() => {
    const rows = hosts ?? [];
    return [
      ...rows.filter((host) => host.revokedAt === null),
      ...rows.filter((host) => host.revokedAt !== null),
    ];
  }, [hosts]);

  return (
    <WorkPageFrame
      title="Permissions"
      description="What Juno may do on your behalf, what it always stops to ask about first, and which of your Macs it can reach."
    >
      <AlwaysAsks />
      <ApprovalModes />

      <section className="mt-9">
        <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2">
          <div className="min-w-0">
            <h2 className="font-mono text-label text-muted-foreground">Your Macs</h2>
            <p className="mt-1.5 max-w-2xl text-ui leading-relaxed text-muted-foreground">
              Anything a task needs a real machine for — a folder on disk, an app, your signed-in
              browser — happens on one of these. Open one to say what it may do, or to take its
              access away.
            </p>
          </div>
          {hosts !== null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              className="h-7 shrink-0 gap-1.5 px-2 font-mono text-micro text-muted-foreground"
            >
              <ActionIcons.refresh className="size-3" aria-hidden="true" /> Refresh
            </Button>
          )}
        </div>

        {failed && hosts === null ? (
          <WorkLoadError onRetry={() => void load()}>
            Couldn’t load your Macs. This section is empty because the request failed, not because
            you have none — anything already signed in is still reachable by Juno, with whatever
            permissions it had.
          </WorkLoadError>
        ) : hosts === null ? (
          <WorkRowSkeletons count={2} />
        ) : hosts.length === 0 ? (
          <EmptyState
            icon={CodeIcons.device}
            title="No Macs yet"
            description="A Mac appears here on its own once you install Juno on it, sign in and switch Work on from the app. Until one does, every task runs in the cloud — which means a task that needs a folder on your disk, an app or your signed-in browser cannot run at all."
          />
        ) : (
          <>
            {/* Shown above a list that still has real rows in it. Blanking the
                list would state that the fleet is unknown, which the failed poll
                did not establish; the rows are what we last actually knew. */}
            {failed && (
              <WorkStateNote tone="warning" className="mb-2.5">
                These are the last answers Juno got. The most recent check failed, so a Mac may have
                woken or gone away since.
              </WorkStateNote>
            )}
            <div className="space-y-2.5">
              {ordered.map((host, index) => (
                <WorkHostRow key={host.id} host={host} index={index} />
              ))}
            </div>
          </>
        )}
      </section>
    </WorkPageFrame>
  );
}

/**
 * The floor, rendered from the list the executor actually enforces.
 *
 * `ALWAYS_CONFIRM_ACTIONS` rather than a prose list written out here, and that
 * is the entire point: a hand-written page saying "Juno always asks before
 * sending a message" is a claim that goes stale the day somebody adds an action
 * to the constant and does not think to edit a marketing sentence in a component
 * three directories away. Rendering the constant means the page cannot be wrong
 * about it — if the floor changes, this changes with it.
 *
 * The verbs come from the approval card's own table, so the promise here is
 * worded identically to the button that will eventually appear on the card. A
 * page that says "Juno asks before it sends" over a button that says "Approve"
 * is two products.
 */
function AlwaysAsks() {
  return (
    <section>
      <h2 className="font-mono text-label text-muted-foreground">Juno always asks first</h2>
      <p className="mt-1.5 max-w-2xl text-ui leading-relaxed text-muted-foreground">
        These stop and wait for you every time, under every setting on this page and every setting
        on a task. There is nothing anywhere that turns them off.
      </p>
      <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
        {ALWAYS_CONFIRM_ACTIONS.map((action) => (
          <li
            key={action}
            className="flex items-center gap-2 rounded-field border border-border/60 bg-card px-3 py-2"
          >
            <span className="size-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true" />
            <span className="min-w-0 text-ui text-foreground">{actionVerb(action).verb}</span>
            <span className="min-w-0 flex-1 truncate text-ui text-muted-foreground">
              {describeFloorAction(action)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One short phrase per floor action, so the row is not just a verb.
 *
 * Keyed on the same identifiers rather than derived from them: `humanize` would
 * turn `work.system.change_security_setting` into "Work system change security
 * setting", which is the token with the dots taken out and is exactly the
 * register this whole surface is trying to leave behind.
 */
const FLOOR_DESCRIPTION: Record<string, string> = {
  "work.file.permanent_delete": "a file, permanently",
  "work.file.empty_trash": "your trash",
  "work.app.purchase": "something in an app",
  "work.browser.purchase": "something on a website",
  "work.connector.send_message": "a message, from your account",
  "work.connector.publish": "something publicly",
  "work.connector.delete": "records in a connected app",
  "work.connector.payment": "money, to somebody",
  "work.system.change_security_setting": "a security setting",
  "work.system.change_account_setting": "an account setting",
};

function describeFloorAction(action: string): string {
  return FLOOR_DESCRIPTION[action] ?? "something it cannot undo";
}

/**
 * The three modes, explained once.
 *
 * READ-ONLY, AND THAT IS A DESIGN DECISION RATHER THAN AN OMISSION. The mode is
 * a property of a task (set on the composer, changeable mid-task from the
 * thread) and of a Mac (a ceiling the machine advertises and its owner can
 * narrow). It is not a property of the account, and there is no endpoint that
 * would make it one. A control here would therefore be a fourth place to set a
 * thing with three real owners — and the first time it disagreed with any of
 * them, the page whose whole job is to be trusted about permissions would be
 * the one that was wrong.
 *
 * So this explains and points at where each is actually set. `default` is marked
 * from the domain constant, not restated.
 */
function ApprovalModes() {
  return (
    <section className="mt-9">
      <h2 className="font-mono text-label text-muted-foreground">How much it asks otherwise</h2>
      <p className="mt-1.5 max-w-2xl text-ui leading-relaxed text-muted-foreground">
        Below that floor, how often Juno stops is set per task — on the composer before you start
        it, and from the task itself while it runs. A Mac can also hold a stricter ceiling than a
        task asks for, and the stricter of the two always wins.
      </p>
      <div className="mt-3 space-y-2">
        {WORK_PERMISSION_POLICIES.map((policy) => (
          <div
            key={policy}
            className={cn(
              "rounded-field border bg-card px-3.5 py-3",
              policy === DEFAULT_WORK_PERMISSION_POLICY ? "border-border" : "border-border/60"
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-ui font-medium text-foreground">
                {WORK_APPROVAL_MODE_LABEL[policy]}
              </span>
              {policy === DEFAULT_WORK_PERMISSION_POLICY && (
                <span className="font-mono text-micro text-muted-foreground">Default</span>
              )}
            </div>
            <p className="mt-1 text-ui leading-relaxed text-muted-foreground">
              {WORK_APPROVAL_MODE_SUMMARY[policy]}
            </p>
          </div>
        ))}
      </div>
      <p className="mt-3 max-w-2xl text-ui leading-relaxed text-muted-foreground">
        When you answer an approval with “and stop asking”, that covers that one action for the rest
        of that task only, and lapses when the task ends. Nothing you allow on one task carries over
        to another. See the decisions a task made under{" "}
        <Link href="/work" className="underline underline-offset-4 hover:text-foreground">
          its own Approvals list
        </Link>
        .
      </p>
    </section>
  );
}
