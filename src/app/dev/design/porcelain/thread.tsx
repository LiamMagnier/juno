"use client";

import * as React from "react";
import { Check, ChevronRight, Circle, Copy, FileSpreadsheet, FileText, Globe, RefreshCw, Square, ThumbsDown, ThumbsUp } from "@/components/ui/icons";
import { Face } from "./face";
import { ACCOUNTS_TABLE, MIRA, MIRA_PLAN, SLACK_POST } from "./fixtures";
import { AppMark, Num, Orbit } from "./glyphs";
import { DraftText, DRAFT, type Seg } from "./composer";

/* ------------------------------------------------------------------ */
/* The person's message                                                */
/* ------------------------------------------------------------------ */
export function UserMessage({ segs = DRAFT, className }: { segs?: Seg[]; className?: string }) {
  return (
    <div className={`pc-bubble ${className ?? ""}`}>
      <DraftText segs={segs} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Collapsed tool activity: one line, the trace one disclosure down.   */
/* ------------------------------------------------------------------ */
export function ActivityLine({ children }: { children: React.ReactNode }) {
  return (
    <button type="button" className="pc-activity" aria-expanded={false}>
      <span className="pc-activity__marks" aria-hidden>
        <FileSpreadsheet className="pc-mark--sheet" />
        <FileText />
        <Globe />
      </span>
      <span>{children}</span>
      <ChevronRight />
    </button>
  );
}

/** Juno thinking, inline: the orbit at work, then the words (the state for a reader). */
export function ThinkingLine({ children, reduced }: { children: React.ReactNode; reduced?: boolean }) {
  return (
    <p className="pc-thinking" role="status">
      <Orbit state="thinking" size={16} still={reduced} className="pc-orbit--line" />
      <span>{children}</span>
    </p>
  );
}

/* ------------------------------------------------------------------ */
/* The answer: heading, a short list, a small table.                   */
/* ------------------------------------------------------------------ */
export function Answer({ actions = true }: { actions?: boolean }) {
  return (
    <div>
      <div className="pc-prose">
        <h3>Renewal risk this quarter</h3>
        <p>
          Stripe shows <strong>€412,000</strong> of the <strong>€438,000</strong> the forecast expects from renewals. Three accounts make
          up the gap:
        </p>
        <ul>
          <li>
            <strong>Halvorsen</strong> moved to monthly billing in August and has not renewed the annual plan.
          </li>
          <li>
            <strong>Brightline Studio</strong> dropped two seats on 12 September.
          </li>
          <li>
            <strong>Oakridge Health</strong> has an unpaid invoice from July (see{" "}
            <a className="pc-link" href="#">
              Renewal notes.md
            </a>
            ).
          </li>
        </ul>
        <table className="pc-table">
          <thead>
            <tr>
              <th>Account</th>
              <th className="r">Forecast</th>
              <th className="r">Stripe</th>
              <th className="r">Gap</th>
            </tr>
          </thead>
          <tbody>
            {ACCOUNTS_TABLE.map((r) => (
              <tr key={r.account}>
                <td>{r.account}</td>
                <td className="r">
                  <Num>{r.forecast}</Num>
                </td>
                <td className="r">
                  <Num>{r.stripe}</Num>
                </td>
                <td className="r">
                  <Num>{r.gap}</Num>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>I&apos;ve asked Mira to check usage on all three and flag the ones worth a call.</p>
      </div>
      {actions ? (
        <div className="pc-msg-actions">
          <button type="button" className="pc-icon-btn pc-icon-btn--sm" aria-label="Copy">
            <Copy />
          </button>
          <button type="button" className="pc-icon-btn pc-icon-btn--sm" aria-label="Good answer">
            <ThumbsUp />
          </button>
          <button type="button" className="pc-icon-btn pc-icon-btn--sm" aria-label="Bad answer">
            <ThumbsDown />
          </button>
          <button type="button" className="pc-icon-btn pc-icon-btn--sm" aria-label="Retry">
            <RefreshCw />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* A live task, in the order the doc asks (§9): what it is doing, what */
/* needs you, progress in one line, the plan behind a disclosure.      */
/* ------------------------------------------------------------------ */
export function TaskCard({ planOpen = false }: { planOpen?: boolean }) {
  const done = MIRA_PLAN.filter((s) => s.state === "done").length;
  return (
    <section className="pc-card pc-task" aria-label="Task: Mira is checking usage">
      <div className="pc-task__head">
        <Face avatar={MIRA.avatar} presence="waiting" size={24} name="Mira" />
        <p className="pc-task__now">Mira is checking usage on the three accounts</p>
        <button type="button" className="pc-btn pc-btn--ghost !h-7 !px-2.5">
          <Square className="!size-3" />
          Stop
        </button>
      </div>
      <div className="pc-task__progress">
        <span className="pc-steps" aria-hidden>
          {MIRA_PLAN.map((s) => (
            <i key={s.id} data-s={s.state} />
          ))}
        </span>
        <span>
          Step {done + 1} of {MIRA_PLAN.length}: matching Stripe customers to accounts
        </span>
        <button type="button" className="pc-disclose" aria-expanded={planOpen}>
          Plan
          <ChevronRight />
        </button>
      </div>
      {planOpen ? (
        <ol className="pc-plan">
          {MIRA_PLAN.map((s) => (
            <li key={s.id} data-s={s.state}>
              {s.state === "done" ? <Check /> : s.state === "active" ? <Orbit state="thinking" size={14} /> : <Circle className="text-[color:var(--pc-ink-4)]" />}
              {s.title}
            </li>
          ))}
        </ol>
      ) : null}
      <div className="pc-ask">
        <p className="pc-needs">Mira needs you</p>
        <p className="pc-ask__q">
          Oakridge&apos;s unpaid July invoice looks like a billing error, not churn. Should I still count it as renewal risk?
        </p>
        <div className="pc-ask__opts">
          <button type="button" className="pc-btn pc-btn--secondary">
            Count it
          </button>
          <button type="button" className="pc-btn pc-btn--secondary">
            Leave it out
          </button>
          <span className="pc-small pc-quiet ml-1">or reply below</span>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Approval: Deny first, then Allow once, Always for Slack.             */
/* ------------------------------------------------------------------ */
export function Approval() {
  return (
    <section className="pc-card pc-approval" aria-label="Approval needed: post to Slack">
      <div className="pc-approval__head">
        <AppMark app="slack" className="!size-[22px]" />
        <div className="min-w-0 flex-1">
          <p className="pc-ui-m">Post the summary to #design in Slack</p>
          <p className="pc-small pc-quiet">Juno will post as you. Messages can&apos;t be unsent by Juno.</p>
        </div>
      </div>
      <blockquote className="pc-approval__quote">{SLACK_POST}</blockquote>
      <div className="pc-approval__actions">
        <button type="button" className="pc-btn pc-btn--secondary">
          Deny
        </button>
        <button type="button" className="pc-btn pc-btn--primary">
          Allow once
        </button>
        <button type="button" className="pc-btn pc-btn--ghost">
          Always for Slack
        </button>
        <a className="pc-link" href="#">
          Tell Juno what to do instead
        </a>
      </div>
    </section>
  );
}
