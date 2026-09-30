"use client";

import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import { USER_BUBBLE_CLASS } from "@/components/chat/user-bubble";
import { SlackMark } from "@/components/connections/connector-logos";
import { WorkProgressChecklist } from "@/components/work/detail/work-progress";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ChevronRight, FileText, Globe, PenTool, Square, TriangleAlert } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { MIRA, MIRA_PLAN, READS, SLACK_POST } from "./fixtures";
import { PointsProgress, SignatureGlyph } from "./glyphs";
import type { DirectionId } from "./tokens";

/*
 * The transcript pieces the new chat needs and today's components do not
 * draw: the one-line activity summary, the task card in the order §9 sets
 * (doing, needs you, progress, plan behind a disclosure) and the approval
 * with its four answers. Each is composed from real primitives — `Button`,
 * `Collapse`, `WorkProgressChecklist`, `AgentFace`, `USER_BUBBLE_CLASS` —
 * and none of them wears a status pill.
 */

/** A user turn whose sentence carries context tokens, in the real bubble recipe. */
export function TokenUserTurn({ children }: { children: React.ReactNode }) {
  return (
    <div className="group flex flex-col items-end">
      <h2 className="sr-only">You said</h2>
      <div className="flex max-w-[85%] flex-col items-end">
        <div className={cn(USER_BUBBLE_CLASS, "dir-bubble relative w-full break-words")}>{children}</div>
      </div>
    </div>
  );
}

/** "Read 3 files and searched the web", folded; one press lists what was read. */
export function ActivityLine() {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="mb-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="-mx-1.5 inline-flex min-h-8 items-center gap-1.5 rounded-control px-1.5 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none"
      >
        <ChevronRight
          className={cn("size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none", open && "rotate-90")}
          aria-hidden="true"
        />
        Read 3 files and searched the web
      </button>
      <Collapse open={open} innerClassName="pt-1.5">
        <ul id={id} className="space-y-1 border-l border-border pl-3.5 ml-1.5">
          {READS.map((r) => (
            <li key={r.object} className="flex items-center gap-2 text-ui text-muted-foreground">
              {r.verb.startsWith("Searched") ? <Globe className="size-3.5" aria-hidden="true" /> : <FileText className="size-3.5" aria-hidden="true" />}
              <span>
                {r.verb} <span className="text-foreground">{r.object}</span>
              </span>
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

/**
 * A live task, handed to a crew member. What they are doing (one sentence),
 * what needs you (a question with one-press answers), progress (one line,
 * the plan one press away). No status pill: the sentence is the status.
 */
export function TaskCard({ direction }: { direction: DirectionId }) {
  const [planOpen, setPlanOpen] = React.useState(false);
  const [answer, setAnswer] = React.useState<string | null>(null);
  const titleId = React.useId();
  const planId = React.useId();
  return (
    <section aria-labelledby={titleId} className="rounded-panel border border-border bg-card p-2">
      <header className="flex items-start gap-3 px-2 pb-1 pt-1.5">
        <AgentFace avatar={MIRA.avatar} state="waiting" size={28} name="Mira" live={false} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-body font-medium leading-snug text-foreground">
            Mira is checking usage on the three accounts behind the gap
          </h3>
          <p className="mt-0.5 text-ui text-muted-foreground">Task from this chat, started 4 minutes ago</p>
        </div>
        <Button type="button" variant="ghost" size="sm" className="-mr-1 gap-1.5 text-muted-foreground">
          <Square className="size-3 fill-current" aria-hidden="true" />
          Stop
        </Button>
      </header>

      <div className="dir-nest-panel-2 mt-2 bg-secondary px-3 py-3">
        <p className="flex items-center gap-1.5 text-label font-medium text-warning">
          <TriangleAlert className="size-3.5" aria-hidden="true" />
          Mira needs you
        </p>
        <p className="mt-1.5 text-body text-foreground">
          Halvorsen is in Stripe twice, as Halvorsen AB and Halvorsen Group. Treat them as one customer?
        </p>
        {answer ? (
          <p role="status" className="mt-2.5 text-ui text-muted-foreground">
            You answered: <span className="text-foreground">{answer}</span>
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setAnswer("One customer")}>
              One customer
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setAnswer("Keep them separate")}>
              Keep them separate
            </Button>
          </div>
        )}
      </div>

      <div className="px-2 pb-1 pt-3">
        {direction === "graphite" && (
          <div className="mb-2.5 max-w-[16rem]">
            <PointsProgress steps={MIRA_PLAN.length} current={1} />
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p className="text-ui text-muted-foreground">
            <span className="font-mono tabular-nums text-foreground">2 of 4</span>
            <span className="mx-1.5" aria-hidden="true">
              ·
            </span>
            Matching Stripe customers to accounts
          </p>
          <button
            type="button"
            aria-expanded={planOpen}
            aria-controls={planId}
            onClick={() => setPlanOpen((v) => !v)}
            className="-mr-1.5 inline-flex min-h-8 items-center gap-1 rounded-control px-1.5 text-ui text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-accent hover:text-foreground motion-reduce:transition-none"
          >
            Plan
            <ChevronRight
              className={cn("size-3.5 transition-transform duration-base ease-in-out motion-reduce:transition-none", planOpen && "rotate-90")}
              aria-hidden="true"
            />
          </button>
        </div>
        <Collapse open={planOpen} innerClassName="pt-3">
          <div id={planId}>
            <WorkProgressChecklist steps={MIRA_PLAN} />
          </div>
        </Collapse>
      </div>
    </section>
  );
}

/**
 * The approval for an action that leaves the product. Deny comes first, the
 * standing grant is named by the app it covers, and the fourth answer hands
 * the decision back as words (DECISIONS D-012). Amber is the heading's ink
 * and its icon; the card itself is the ordinary surface.
 */
export function ApprovalPanel() {
  const [decision, setDecision] = React.useState<string | null>(null);
  const titleId = React.useId();
  return (
    <section role="group" aria-labelledby={titleId} className="rounded-card border border-border bg-card px-4 py-4">
      <p className="flex items-center gap-1.5 text-label font-medium text-warning">
        <TriangleAlert className="size-3.5" aria-hidden="true" />
        Needs your approval
      </p>
      <h3 id={titleId} className="mt-1.5 text-body font-medium text-foreground">
        Post the summary to #design in Slack
      </h3>
      <p className="mt-1 flex items-center gap-1.5 text-ui text-muted-foreground">
        <SlackMark className="size-3.5" />
        Slack, posting as Liam Magnier
      </p>

      <figure className="mt-3 rounded-control border border-border bg-secondary px-3 py-2.5">
        <figcaption className="text-caption font-medium text-muted-foreground">#design</figcaption>
        <blockquote className="mt-1 text-ui leading-relaxed text-foreground">{SLACK_POST}</blockquote>
      </figure>

      {decision ? (
        <p role="status" className="mt-3 text-ui text-muted-foreground">
          {decision}
        </p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => setDecision("Not posted. Juno will not post this message.")}>
              Deny
            </Button>
            <Button type="button" onClick={() => setDecision("Allowed once. Posting to #design.")}>
              Allow once
            </Button>
            <Button type="button" variant="outline" onClick={() => setDecision("Allowed for Slack. Juno will post without asking in this chat.")}>
              Always for this app
            </Button>
          </div>
          <button
            type="button"
            className="-mx-1.5 mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-control px-1.5 text-ui text-primary transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none"
          >
            <PenTool className="size-3.5" aria-hidden="true" />
            Tell Juno what to do instead
          </button>
          <p className="mt-2 text-caption text-muted-foreground">A post cannot be taken back. Unanswered, this expires in 14 minutes.</p>
        </>
      )}
    </section>
  );
}

/** Juno's side of a turn: the mark in the margin on wide screens, then the content. */
export function JunoTurn({ direction, children }: { direction: DirectionId; children: React.ReactNode }) {
  return (
    <div className="relative">
      <h2 className="sr-only">Juno said</h2>
      <span className="absolute -left-9 top-0.5 hidden text-muted-foreground lg:block" aria-hidden="true">
        <SignatureGlyph direction={direction} size={18} />
      </span>
      {children}
    </div>
  );
}
