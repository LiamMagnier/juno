"use client";

import * as React from "react";
import { CODE_STEPS, DIFF } from "./fixtures";
import { Composer } from "./composer";
import { Icon } from "./icons";
import { AppFrame, CodeSidebar, MobileBar, TopBar } from "./shell";
import { JunoCaret } from "./thread";

/*
 * Juno Code on the same tokens, one notch denser: 13px tool lines on 28px
 * rows, mono for paths and counts, the diff docked on the right (not
 * floating). The composer is the same object with Code's quiet context row:
 * repository, environment, and the mode (Ask, Plan, Code) as words.
 */

function ContextRow({ mode = "Code", compact = false }: { mode?: "Ask" | "Plan" | "Code"; compact?: boolean }) {
  return (
    <>
      {!compact ? (
        <>
          <button type="button" className="jn-ctx jicon-trigger">
            <Icon name="repo" size={16} />
            <span className="mono">juno-web</span>
            <Icon name="chevron-down" size={16} />
          </button>
          <button type="button" className="jn-ctx jicon-trigger">
            <Icon name="laptop" size={16} />
            This Mac
            <Icon name="chevron-down" size={16} />
          </button>
          <button type="button" className="jn-ctx jicon-trigger">
            <Icon name="branch" size={16} />
            <span className="mono">main</span>
          </button>
        </>
      ) : (
        <span className="jn-ctx jn-ctx--static">
          <Icon name="branch" size={16} />
          <span className="mono">fix/sync-cursor-lease</span>
        </span>
      )}
      <span className="jn-mode" role="radiogroup" aria-label="Mode">
        {(["Ask", "Plan", "Code"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} className="jn-mode__opt">
            {m}
          </button>
        ))}
      </span>
    </>
  );
}

export function CodeStartScene() {
  return (
    <AppFrame sidebar={<CodeSidebar current={-1} />} className="jn-frame--code">
      <div className="jn-chat">
        <MobileBar />
        <div className="jn-top jn-top--clear" aria-hidden="true" />
        <div className="jn-home jn-codehome">
          <div className="jn-home__stack">
            <h1 className="t-title jn-codehome__title">What are we changing in juno-web?</h1>
            <Composer variant="code" placeholder="Describe the change, or paste an error" context={<ContextRow mode="Code" />} />
            <div className="jn-codehome__recent">
              <p className="t-label jn-codehome__label">From this repository</p>
              <button type="button" className="jrow jicon-trigger">
                <Icon name="alert" size={16} />
                <span className="jrow__text">Fix the flaky upload test that failed on CI</span>
                <span className="jrow__meta">2 h ago</span>
              </button>
              <button type="button" className="jrow jicon-trigger">
                <Icon name="pull-request" size={16} />
                <span className="jrow__text">Review #482, cursor lease for the sync worker</span>
                <span className="jrow__meta">Yesterday</span>
              </button>
              <button type="button" className="jrow jicon-trigger">
                <Icon name="branch" size={16} />
                <span className="jrow__text">Continue fix/search-index on Cloud</span>
                <span className="jrow__meta">Monday</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

function Step({ verb, object, extra, state }: { verb: string; object: string; extra?: string; state: "done" | "active" }) {
  const [add, del] = extra?.startsWith("+") ? extra.split(" ") : [];
  return (
    <li className="jn-step" data-state={state}>
      <span className="jn-step__glyph">
        <Icon name={state === "done" ? "check" : "progress"} size={16} state={state === "active" ? "active" : "rest"} />
      </span>
      <span className="jn-step__verb">{verb}</span>
      <span className="jn-step__obj mono">{object}</span>
      {add ? (
        <span className="jn-step__diff mono num">
          <span className="jn-add">{add}</span> <span className="jn-del">{del}</span>
        </span>
      ) : extra ? (
        <span className="jn-step__extra">{extra}</span>
      ) : null}
    </li>
  );
}

export function DiffPanel() {
  const [tab, setTab] = React.useState("Diff");
  return (
    <aside className="jn-diff" aria-label="Changes">
      <div className="jn-diff__tabs" role="tablist">
        {["Diff", "Files", "Terminal", "Tests"].map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="jn-diff__tab" onClick={() => setTab(t)}>
            {t}
            {t === "Diff" ? <span className="jn-diff__count num">2</span> : null}
            {t === "Tests" ? <span className="jn-diff__count num">12</span> : null}
          </button>
        ))}
        <span className="jn-diff__tools">
          <button type="button" className="jib jib--sm jicon-trigger" aria-label="Open in editor">
            <Icon name="external" size={16} />
          </button>
        </span>
      </div>
      <div className="jn-diff__body">
        <div className="jn-diff__file" data-open="">
          <button type="button" className="jn-diff__filehead jicon-trigger" aria-expanded="true">
            <Icon name="chevron-down" size={16} />
            <span className="mono jn-diff__path">
              <span className="ink-3">src/sync/</span>worker.ts
            </span>
            <span className="mono num jn-diff__stat">
              <span className="jn-add">+14</span> <span className="jn-del">−4</span>
            </span>
          </button>
          <div className="jn-code" role="table" aria-label="Diff of src/sync/worker.ts">
            {DIFF.map((l, i) =>
              l.kind === "hunk" ? (
                <div key={i} className="jn-code__hunk mono">
                  {l.text}
                </div>
              ) : (
                <div key={i} className="jn-code__line mono" data-kind={l.kind} role="row">
                  <span className="jn-code__n num">{l.a ?? ""}</span>
                  <span className="jn-code__n num">{l.b ?? ""}</span>
                  <span className="jn-code__sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
                  <span className="jn-code__text">{l.text}</span>
                </div>
              ),
            )}
          </div>
        </div>
        <div className="jn-diff__file">
          <button type="button" className="jn-diff__filehead jicon-trigger" aria-expanded="false">
            <Icon name="chevron-right" size={16} />
            <span className="mono jn-diff__path">
              <span className="ink-3">src/sync/</span>store.ts
            </span>
            <span className="mono num jn-diff__stat">
              <span className="jn-add">+22</span> <span className="jn-del">−0</span>
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}

export function CodeScene() {
  return (
    <AppFrame sidebar={<CodeSidebar current={0} />} className="jn-frame--code">
      <div className="jn-codework">
        <div className="jn-codework__main">
          <MobileBar title="Sync worker drops cursors" back />
          <TopBar
            title={
              <>
                Sync worker drops cursors on retry <span className="jn-top__meta">juno-web, This Mac</span>
              </>
            }
          >
            <button type="button" className="jb jb--secondary jb--sm jicon-trigger">
              <Icon name="pull-request" size={16} />
              Open pull request
            </button>
            <button type="button" className="jib jicon-trigger" aria-label="Hide changes" aria-pressed="true">
              <Icon name="panel-right" size={20} />
            </button>
          </TopBar>
          <div className="jn-codework__col">
            <div className="jn-umsg">
              <div className="jn-umsg__bubble">
                <span className="jn-umsg__bg" />
                <span className="jn-sentence" style={{ position: "relative" }}>
                  Fix the cursor drop in the sync worker when a batch retries. Keep the retry budget as it is.
                </span>
              </div>
            </div>
            <p className="jn-codeprose">
              The worker writes the cursor after every successful apply, but a retry reads it again from the start of the batch, so the rows between the last write and the failure
              are skipped. I moved the cursor behind a lease that only commits when the whole batch lands.
            </p>
            <ol className="jn-steps">
              {CODE_STEPS.map((s) => (
                <Step key={s.object + s.verb} {...s} />
              ))}
            </ol>
            <div className="jn-codelive" role="status">
              <JunoCaret state="thinking" />
              <span>Running the whole sync suite</span>
              <span className="ink-3 num mono jn-codelive__count">41 of 128</span>
            </div>
          </div>
          <div className="jn-dock jn-dock--code">
            <Composer variant="code" busy placeholder="Steer, or ask about the change" context={<ContextRow compact mode="Code" />} />
          </div>
        </div>
        <DiffPanel />
      </div>
    </AppFrame>
  );
}
