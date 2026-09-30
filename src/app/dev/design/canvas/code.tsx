"use client";

import * as React from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  GitBranch,
  GitPullRequest,
  Laptop,
  MoreHorizontal,
  PanelRight,
  Terminal,
} from "@/components/ui/icons";
import { GitHubMark } from "@/components/connections/connector-logos";
import { DIFF } from "./fixtures";
import { Composer } from "./composer";
import { Point } from "./point";
import { AppFrame, CodeSidebar, MobileBar } from "./shell";

/*
 * Juno Code on the same system: the canvas at rest, then a dense working
 * session. Density comes from a tighter rhythm and the mono face, never from
 * more colour; the diff is the one place green and red appear, as tints.
 */

function ModeSwitch({ mode = "Code" }: { mode?: "Ask" | "Plan" | "Code" }) {
  return (
    <div className="cv-seg cv-mode" role="radiogroup" aria-label="Mode">
      {(["Ask", "Plan", "Code"] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={m === mode} className="cv-seg__opt">
          {m}
        </button>
      ))}
    </div>
  );
}

function ContextRow() {
  return (
    <div className="cv-ctx" aria-label="Where this runs">
      <button type="button" className="cv-ctx__btn">
        <GitHubMark className="cv-mark" />
        liam/juno-web
        <ChevronDown className="cv-i-sm" />
      </button>
      <button type="button" className="cv-ctx__btn">
        <GitBranch className="cv-i" />
        main
        <ChevronDown className="cv-i-sm" />
      </button>
      <button type="button" className="cv-ctx__btn">
        <Laptop className="cv-i" />
        This Mac
        <ChevronDown className="cv-i-sm" />
      </button>
    </div>
  );
}

export function CodeStartScene() {
  return (
    <AppFrame sidebar={<CodeSidebar />}>
      <div className="cv-chat">
        <div className="cv-gridlayer" aria-hidden="true" />
        <MobileBar title="Code" clear />
        <div className="cv-top" data-clear="" aria-hidden="true" />
        <div className="cv-home">
          <h1 className="cv-greet">What should change in juno-web?</h1>
          <Composer
            placeholder="Describe a change, or ask about the code"
            approval={<ContextRow />}
            lead={<ModeSwitch mode="Code" />}
            modelLabel="Auto"
          />
          <div className="cv-chips">
            <button type="button" className="cv-chip">
              <Point size={16} />
              Continue the sync worker fix
            </button>
            <button type="button" className="cv-chip">
              <GitPullRequest className="cv-i" />
              Review pull request 482
            </button>
            <button type="button" className="cv-chip">
              <Terminal className="cv-i" />
              Run the flaky upload test
            </button>
          </div>
        </div>
      </div>
    </AppFrame>
  );
}

const TOOLS = [
  { verb: "Read", obj: "src/sync/worker.ts" },
  { verb: "Searched for", obj: "writeCursor, 4 files" },
  { verb: "Edited", obj: "src/sync/worker.ts", add: 14, del: 4 },
  { verb: "Edited", obj: "src/sync/store.ts", add: 22, del: 0 },
  { verb: "Ran", obj: "npm test -- sync", result: "12 passed" },
];

export function CodeScene() {
  return (
    <AppFrame sidebar={<CodeSidebar />}>
      <div className="cv-session">
        <div className="cv-session__main">
          <MobileBar title="Sync worker drops cursors" thread />
          <header className="cv-top">
            <span className="cv-top__title">
              Sync worker drops cursors on retry <span className="ink-3">&nbsp; juno-web, This Mac</span>
            </span>
            <span className="cv-top__actions">
              <button type="button" className="cv-btn cv-btn--ghost cv-btn--sm">
                <GitPullRequest className="cv-i" />
                Open pull request
              </button>
              <button type="button" className="cv-ibtn" aria-label="Hide panel" aria-pressed="true">
                <PanelRight className="cv-i" />
              </button>
              <button type="button" className="cv-ibtn" aria-label="More">
                <MoreHorizontal className="cv-i" />
              </button>
            </span>
          </header>
          <div className="cv-thread cv-thread--code">
            <div className="cv-sheet">
              <div className="cv-sheet__bg" />
              <span className="cv-sentence">Fix the cursor drop in the sync worker when a batch retries. Keep the retry budget as it is.</span>
            </div>
            <div className="cv-answer cv-answer--code">
              <p>
                The worker writes the cursor after every successful apply, but a retry reads it again from the start of the
                batch, so the rows between the last write and the failure are skipped. I moved the cursor behind a lease that
                only commits when the whole batch lands.
              </p>
            </div>
            <ol className="cv-tools" aria-label="What Juno did">
              {TOOLS.map((t, i) => (
                <li key={i} className="cv-tool">
                  <Check className="cv-i-sm ink-3" />
                  <span className="cv-tool__verb">{t.verb}</span>
                  <span className="cv-tool__obj">{t.obj}</span>
                  {t.add !== undefined ? (
                    <span className="cv-tool__delta num">
                      <span className="cv-add">+{t.add}</span> <span className="cv-del">−{t.del}</span>
                    </span>
                  ) : null}
                  {t.result ? <span className="cv-tool__result">{t.result}</span> : null}
                </li>
              ))}
            </ol>
            <div className="cv-presence" role="status">
              <Point state="working" size={16} />
              Running the whole sync suite
              <span className="ink-3 num">&nbsp; 1 min</span>
            </div>
          </div>
          <div className="cv-dock">
            <div className="cv-dock__fade" />
            <Composer placeholder="Steer, or ask about the change" lead={<ModeSwitch mode="Code" />} />
          </div>
        </div>

        <aside className="cv-inspector" aria-label="Changes">
          <div className="cv-tabs" role="tablist">
            {["Diff", "Files", "Terminal", "Tests"].map((t, i) => (
              <button key={t} type="button" role="tab" aria-selected={i === 0} className="cv-tab">
                {t}
                {t === "Diff" ? <span className="cv-tab__count num">2</span> : null}
              </button>
            ))}
          </div>
          <div className="cv-filehead">
            <ChevronDown className="cv-i-sm ink-3" />
            <FileCode className="cv-i ink-3" />
            <span className="cv-filehead__name">src/sync/worker.ts</span>
            <span className="cv-tool__delta num">
              <span className="cv-add">+14</span> <span className="cv-del">−4</span>
            </span>
          </div>
          <div className="cv-diff" role="table" aria-label="Diff of src/sync/worker.ts">
            {DIFF.map((l, i) =>
              l.kind === "hunk" ? (
                <div key={i} className="cv-diff__hunk" role="row">
                  {l.text}
                </div>
              ) : (
                <div key={i} className="cv-diff__line" data-kind={l.kind} role="row">
                  <span className="cv-diff__n num">{l.a ?? ""}</span>
                  <span className="cv-diff__n num">{l.b ?? ""}</span>
                  <span className="cv-diff__sign" aria-hidden="true">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}
                  </span>
                  <span className="cv-diff__code">{l.text}</span>
                </div>
              ),
            )}
          </div>
          <div className="cv-filehead cv-filehead--closed">
            <ChevronRight className="cv-i-sm ink-3" />
            <FileCode className="cv-i ink-3" />
            <span className="cv-filehead__name">src/sync/store.ts</span>
            <span className="cv-tool__delta num">
              <span className="cv-add">+22</span> <span className="cv-del">−0</span>
            </span>
          </div>
        </aside>
      </div>
    </AppFrame>
  );
}
