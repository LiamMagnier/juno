"use client";

import * as React from "react";
import { Check, ChevronDown, GitBranch, GitPullRequest, Laptop, PanelRightClose, Terminal } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { Composer } from "./composer";
import { DIFF, DIFF_PATH } from "./fixtures";
import { Lens } from "./lens";
import { AppMark } from "./marks";
import { CodeSidebar, MobileBar } from "./sidebar";

/*
 * Juno Code on the same system, to prove it scales to the dense pro tool.
 * The composer is the same object; only its context row changes (repository,
 * branch, where it runs, and the mode). Tool activity is set one line per
 * step with paths in the label face; the diff is the right panel, in the mono,
 * with the only semantic tints in the product (added, removed) kept near 10%.
 */

function ContextButton({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <button type="button" className={cn("in-ctx", className)}>
      {children}
      <ChevronDown size={11} motion="none" className="in-ink-3" />
    </button>
  );
}

export function CodeContext({ mode = "code" }: { mode?: "ask" | "plan" | "code" }) {
  return (
    <>
      <ContextButton>
        <AppMark id="github" size={14} />
        <span>juno-web</span>
      </ContextButton>
      <ContextButton>
        <GitBranch size={14} motion="none" className="in-ink-3" />
        <span className="in-mono in-fs-12">main</span>
      </ContextButton>
      <ContextButton>
        <Laptop size={14} motion="none" className="in-ink-3" />
        <span>This Mac</span>
      </ContextButton>
      <span className="flex-1" />
      <div className="in-seg" data-size="sm" role="radiogroup" aria-label="Mode">
        {(["ask", "plan", "code"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className="in-seg__item">
            {m === "ask" ? "Ask" : m === "plan" ? "Plan" : "Code"}
          </button>
        ))}
      </div>
    </>
  );
}

function CodeStart() {
  return (
    <div className="in-home">
      <div className="in-home__center">
        <h1 className="in-t-display in-home__greet">What should we work on?</h1>
        <div className="in-home__composer">
          <Composer context={<CodeContext />} placeholder="Describe a change, a bug or a question" />
        </div>
        <div className="in-home__chips">
          <button type="button" className="in-chip">
            <Terminal size={15} motion="none" />
            Fix the flaky webhook test
          </button>
          <button type="button" className="in-chip">
            <GitPullRequest size={15} motion="none" />
            Review pull request 482
          </button>
          <button type="button" className="in-chip">
            <GitBranch size={15} motion="none" />
            Plan the index migration
          </button>
        </div>
      </div>
    </div>
  );
}

function Step({ state = "done", verb, object, meta }: { state?: "done" | "live"; verb: string; object: string; meta?: React.ReactNode }) {
  return (
    <li className="in-step">
      <span className="in-step__glyph">{state === "live" ? <Lens state="working" size={14} /> : <Check size={13} motion="none" />}</span>
      <span className={state === "live" ? "in-ink" : "in-ink-2"}>{verb}</span>
      <span className="in-mono min-w-0 truncate in-fs-12 in-ink-2">{object}</span>
      {meta ? <span className="in-mono ml-auto shrink-0 pl-3 in-fs-115 in-ink-3">{meta}</span> : null}
    </li>
  );
}

function DiffPanel() {
  return (
    <aside className="in-diff" aria-label="Changes">
      <div className="flex items-center gap-2 px-4 pt-2">
        <div className="in-tabs flex-1" role="tablist">
          <button type="button" role="tab" aria-selected="true" className="in-tab">
            Changes
          </button>
          <button type="button" role="tab" aria-selected="false" className="in-tab">
            Preview
          </button>
          <button type="button" role="tab" aria-selected="false" className="in-tab">
            Terminal
          </button>
        </div>
        <button type="button" className="in-iconbtn" data-size="sm" aria-label="Close panel">
          <PanelRightClose size={16} motion="none" />
        </button>
      </div>
      <div className="in-scroll px-4 pb-4 pt-3">
        <div className="in-diff__file">
          <div className="in-diff__head">
            <ChevronDown size={12} motion="none" className="in-ink-3" />
            <span className="in-mono min-w-0 flex-1 truncate in-fs-12">{DIFF_PATH}</span>
            <span className="in-mono in-fs-115" style={{ color: "var(--in-add-ink)" }}>
              +9
            </span>
            <span className="in-mono in-fs-115" style={{ color: "var(--in-del-ink)" }}>
              −2
            </span>
          </div>
          <div className="in-diff__body in-mono" role="table" aria-label={`Diff of ${DIFF_PATH}`}>
            {DIFF.map((l, i) =>
              l.kind === "hunk" ? (
                <div key={i} className="in-diff__hunk" role="row">
                  {l.text}
                </div>
              ) : (
                <div key={i} className="in-diff__line" data-kind={l.kind} role="row">
                  <span className="in-diff__num">{l.old ?? ""}</span>
                  <span className="in-diff__num">{l.new ?? ""}</span>
                  <span className="in-diff__sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                  <span className="in-diff__code">{l.text || " "}</span>
                </div>
              ),
            )}
          </div>
        </div>
        <div className="in-diff__file mt-3">
          <div className="in-diff__head">
            <ChevronDown size={12} motion="none" className="-rotate-90 in-ink-3" />
            <span className="in-mono min-w-0 flex-1 truncate in-fs-12">tests/billing/renewals.test.ts</span>
            <span className="in-mono in-fs-115" style={{ color: "var(--in-add-ink)" }}>
              +31
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}

function CodeSession() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="in-thread-head !h-[56px] gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate in-fs-135 font-medium">Fix renewal date rounding</p>
          <p className="truncate in-fs-12 in-ink-3"><span className="in-mono in-fs-115">juno-web/fix/renewal-rounding</span> on This Mac</p>
        </div>
        <button type="button" className="in-btn" data-variant="secondary" data-size="sm">
          <GitPullRequest size={14} motion="none" />
          Open pull request
        </button>
      </header>
      <div className="flex min-h-0 flex-1 border-t" style={{ borderColor: "var(--in-hairline)" }}>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="in-scroll">
            <div className="mx-auto flex max-w-[640px] flex-col px-6 pb-12 pt-6">
              <div className="in-user-msg">Renewals due at 23:30 UTC show up a day early for accounts in Auckland. Fix the rounding and add a test.</div>
              <ol className="mt-7 flex flex-col">
                <Step verb="Read" object="src/lib/billing/renewals.ts" meta="212 lines" />
                <Step verb="Searched" object="renewalWindow(" meta="6 results" />
                <Step verb="Read" object="src/lib/billing/timezones.ts" />
                <Step verb="Edited" object="src/lib/billing/renewals.ts" meta="+9 −2" />
                <Step verb="Wrote" object="tests/billing/renewals.test.ts" meta="+31" />
              </ol>
              <div className="in-answer mt-4">
                <p>
                  The window was counted in UTC hours and rounded, so a renewal after midday UTC rolled into the next day for any account east of it. It now counts calendar days in the account&apos;s own time zone, and uses the plan&apos;s notice period instead of a fixed 30 days.
                </p>
                <p>The new test covers Auckland, Lisbon and Honolulu at 23:30 on the last day of the period.</p>
              </div>
              <ol className="mt-4 flex flex-col">
                <Step state="live" verb="Running" object="npm test -- billing" meta="38 of 42" />
              </ol>
            </div>
          </div>
          <div className="in-dock px-6">
            <div className="mx-auto max-w-[640px]">
              <Composer size="docked" context={<CodeContext />} placeholder="Steer, or ask about the change" />
            </div>
          </div>
        </div>
        <DiffPanel />
      </div>
    </div>
  );
}

export function CodeScene({ view }: { view: "start" | "session" }) {
  return (
    <div className="in-shell">
      <CodeSidebar activeSession={view === "session" ? 0 : undefined} />
      <main className="in-panel">
        <MobileBar className="in-only-mobile" />
        {view === "start" ? <CodeStart /> : <CodeSession />}
      </main>
    </div>
  );
}
