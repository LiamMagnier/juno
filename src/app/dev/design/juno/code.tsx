"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CODE_STEPS, DIFF, type DiffLine } from "./fixtures";
import { Composer, Segmented } from "./composer";
import { Icon } from "./icons";
import { EASE_OUT, R, T, useReduced } from "./motion";
import { AppFrame, CodeSidebar, MobileBar, TopBar } from "./shell";
import { LiveLine } from "./thread";

/*
 * Juno Code on the same tokens, one notch denser: 13px tool lines on 28px
 * rows, mono for paths and counts, the diff docked on the right (not
 * floating). The composer is the same object with Code's quiet context row:
 * repository, environment, and the permission mode as words: Ask, Plan,
 * Auto-edit (CODE_AGENT_SPEC's names; "Code" inside Code named nothing).
 */

const MODES = ["Ask", "Plan", "Auto-edit"] as const;
export type CodeMode = (typeof MODES)[number];
const MODE_LINE: Record<CodeMode, string> = {
  Ask: "Reads and answers, changes nothing",
  Plan: "Proposes a plan before it edits",
  "Auto-edit": "Edits files, asks before commands",
};

export function ContextRow({ mode: initialMode = "Auto-edit", compact = false }: { mode?: CodeMode; compact?: boolean }) {
  const [mode, setMode] = React.useState<CodeMode>(initialMode);
  return (
    <>
      {!compact ? (
        <>
          <button type="button" className="jn-ctx jicon-trigger jicon-quiet">
            <Icon name="repo" size={16} />
            <span className="mono">juno-web</span>
            <Icon name="chevron-down" size={16} />
          </button>
          <button type="button" className="jn-ctx jicon-trigger jicon-quiet">
            <Icon name="laptop" size={16} />
            This Mac
            <Icon name="chevron-down" size={16} />
          </button>
          <button type="button" className="jn-ctx jicon-trigger jicon-quiet">
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
      <span className="jn-mode" role="radiogroup" aria-label="Permission mode">
        {MODES.map((m, i) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className="jn-mode__opt jtip"
            data-tip={MODE_LINE[m]}
            data-tip-side="top"
            data-tip-align={i === MODES.length - 1 ? "end" : undefined}
            onClick={() => setMode(m)}
            onKeyDown={(e) => {
              const k = MODES.indexOf(mode);
              if (e.key === "ArrowRight") setMode(MODES[Math.min(MODES.length - 1, k + 1)]);
              if (e.key === "ArrowLeft") setMode(MODES[Math.max(0, k - 1)]);
            }}
          >
            {m}
          </button>
        ))}
      </span>
    </>
  );
}

export function CodeStartScene() {
  return (
    <AppFrame sidebar={<CodeSidebar current={-1} />} className="jn-frame--code" skip={{ href: "#jn-message", label: "Skip to message" }}>
      <div className="jn-chat">
        <MobileBar />
        <div className="jn-top jn-top--clear" aria-hidden="true" />
        <div className="jn-home jn-codehome">
          <div className="jn-home__stack">
            <div className="jn-home__greet">
              <h1 className="t-title jn-codehome__title">What are we changing in juno-web?</h1>
            </div>
            <Composer variant="code" placeholder="Describe the change, or paste an error" context={<ContextRow />} fieldId="jn-message" />
            <div className="jn-home__suggest jn-codehome__recent">
              <p className="t-label jn-codehome__label">From this repository</p>
              <button type="button" className="jrow jicon-trigger jicon-quiet">
                <Icon name="alert" size={16} />
                <span className="jrow__text">Fix the flaky upload test that failed on CI</span>
                <span className="jrow__meta">2 h ago</span>
              </button>
              <button type="button" className="jrow jicon-trigger jicon-quiet">
                <Icon name="pull-request" size={16} />
                <span className="jrow__text">Review #482, cursor lease for the sync worker</span>
                <span className="jrow__meta">Yesterday</span>
              </button>
              <button type="button" className="jrow jicon-trigger jicon-quiet">
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

const STORE_DIFF: DiffLine[] = [
  { kind: "hunk", text: "@@ -40,6 +40,28 @@ export class CursorStore {" },
  { kind: "ctx", a: 40, b: 40, text: "  async readCursor(stream: string) {" },
  { kind: "ctx", a: 41, b: 41, text: "    return this.db.get(`cursor:${stream}`);" },
  { kind: "ctx", a: 42, b: 42, text: "  }" },
  { kind: "add", b: 43, text: "  /** Hold a cursor for one batch; it moves only when the batch commits. */" },
  { kind: "add", b: 44, text: "  async leaseCursor(stream: string, position: Cursor) {" },
  { kind: "add", b: 45, text: "    const lease = await this.db.lease(`cursor:${stream}`, LEASE_MS);" },
  { kind: "add", b: 46, text: "    return new CursorLease(this.db, stream, position, lease);" },
  { kind: "add", b: 47, text: "  }" },
];

function DiffFile({ path, add, del, lines, open: initialOpen }: { path: [string, string]; add: number; del: number; lines: DiffLine[]; open?: boolean }) {
  const reduced = useReduced();
  const [open, setOpen] = React.useState(!!initialOpen);
  return (
    <div className="jn-diff__file" data-open={open ? "" : undefined}>
      <button type="button" className="jn-diff__filehead jicon-trigger jicon-quiet" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="jn-trace__chev" data-open={open ? "" : undefined}>
          <Icon name="chevron-right" size={16} />
        </span>
        <span className="mono jn-diff__path">
          <span className="ink-3">{path[0]}</span>
          {path[1]}
        </span>
        <span className="mono num jn-diff__stat">
          <span className="jn-add">+{add}</span> <span className="jn-del">−{del}</span>
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            key="code"
            initial={reduced ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduced ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduced ? { opacity: 0 } : { height: 0, opacity: 0, transition: T.exit }}
            transition={reduced ? R : { duration: 0.24, ease: EASE_OUT }}
            style={{ overflow: "hidden" }}
          >
            {/* Long lines wrap on a hanging indent under their own text, so nothing is cut off at the pane's edge. */}
            <div className="jn-code" role="table" aria-label={`Diff of ${path.join("")}`}>
              {lines.map((l, i) =>
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
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function DiffPanel() {
  const [tab, setTab] = React.useState("Changes");
  return (
    <aside className="jn-diff" aria-label="Changes">
      <div className="jn-diff__tabs jicon-quiet" role="tablist">
        {["Changes", "Files", "Terminal", "Tests"].map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className="jn-diff__tab" onClick={() => setTab(t)}>
            {t}
            {t === "Changes" ? <span className="jn-diff__count num">2 files</span> : null}
            {t === "Tests" ? <span className="jn-diff__count num">41 of 128</span> : null}
          </button>
        ))}
        <span className="jn-diff__tools">
          <button type="button" className="jib jib--sm jicon-trigger jtip" aria-label="Open in editor" data-tip="Open in editor" data-tip-align="end">
            <Icon name="external" size={16} />
          </button>
        </span>
      </div>
      <div className="jn-diff__body">
        <DiffFile path={["src/sync/", "worker.ts"]} add={14} del={4} lines={DIFF} open />
        <DiffFile path={["src/sync/", "store.ts"]} add={22} del={0} lines={STORE_DIFF} />
      </div>
    </aside>
  );
}

export function CodeScene({ pane: initialPane = "session" }: { pane?: "session" | "changes" }) {
  // On a narrow window the transcript and the changes are one pane each, switched here (the diff is never out of reach).
  const [pane, setPane] = React.useState<"session" | "changes">(initialPane);
  return (
    <AppFrame sidebar={<CodeSidebar current={0} />} className="jn-frame--code" skip={{ href: "#jn-message", label: "Skip to message" }}>
      <div className="jn-codework" data-pane={pane}>
        <div className="jn-codeswitch">
          <MobileBar title="Sync worker drops cursors" back />
          <div className="jn-codeswitch__seg">
            <Segmented options={["session", "changes"] as const} value={pane} onChange={setPane} label="Show" layoutKey="code-pane" labels={{ session: "Session", changes: "Changes, 2 files" }} />
          </div>
        </div>
        <div className="jn-codework__main">
          <TopBar
            title={
              <>
                Sync worker drops cursors on retry <span className="jn-top__meta">juno-web, This Mac</span>
              </>
            }
          >
            {/* Not ready while the tests run: a quiet, unavailable control that says when it will be. */}
            <button type="button" className="jb jb--secondary jb--sm jicon-trigger jicon-quiet jtip" aria-disabled="true" data-tip="Opens when the tests pass" data-ready="false">
              <Icon name="pull-request" size={16} />
              Open pull request
            </button>
            <button type="button" className="jib jicon-trigger jicon-quiet jtip" aria-label="Hide changes" data-tip="Hide changes" data-tip-align="end" aria-pressed="true">
              <Icon name="panel-right" size={20} />
            </button>
          </TopBar>
          <div className="jn-codework__col">
            <div className="jn-umsg">
              <div className="jn-umsg__bubble">
                <span className="jn-sentence">
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
            <LiveLine className="jn-codelive" glyph="test" text="Running the whole sync suite, 41 of 128 tests" seconds={38} />
          </div>
          <div className="jn-dock jn-dock--code">
            <Composer variant="code" busy placeholder="Steer, or ask about the change" context={<ContextRow compact />} fieldId="jn-message" />
          </div>
        </div>
        <DiffPanel />
      </div>
    </AppFrame>
  );
}
