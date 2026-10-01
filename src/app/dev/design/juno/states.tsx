"use client";

import * as React from "react";
import { CrewMark } from "./crew-bridge";
import { CREW } from "./fixtures";
import { Composer } from "./composer";
import { Icon } from "./icons";
import { AppMark, FileMark, LinearMark } from "./marks";
import { face } from "./shell";
import { LiveLine } from "./thread";

/*
 * The states between the happy frames, on the same tokens: loading, empty,
 * error, blocked, offline, queued and slow. Each is drawn where it lives
 * (a thread, the dock, the Library, an app's row, a Code run), says what
 * happened in plain words, and offers the one next step. Nothing shimmers,
 * nothing blinks, nothing turns red unless something was destroyed.
 *
 *   /dev/design/juno?scene=states
 */

function Cell({ cap, label, children, tall }: { cap: string; label: string; children: React.ReactNode; tall?: boolean }) {
  return (
    <section className="jn-state" aria-label={label} data-tall={tall ? "" : undefined}>
      <p className="jn-state__cap">
        <b>{label}</b> {cap}
      </p>
      <div className="jn-state__panel">{children}</div>
    </section>
  );
}

/* Loading: the shape of what is coming, in the panel's own tones; static (no shimmer, §1.6). */
function ThreadLoading() {
  return (
    <div className="jn-skel" aria-busy="true" aria-label="Opening the thread">
      <span className="jn-skel__bubble" />
      <span className="jn-skel__line" style={{ width: "34%", height: 14, marginTop: 28 }} />
      <span className="jn-skel__line" style={{ width: "92%" }} />
      <span className="jn-skel__line" style={{ width: "86%" }} />
      <span className="jn-skel__line" style={{ width: "58%" }} />
      <span className="jn-skel__card" />
    </div>
  );
}

function AnswerFailed() {
  return (
    <div className="jn-stateblock">
      <p className="jn-stateblock__text">
        Stripe shows €412,000 of the €438,000 the forecast expects from renewals. Three accounts make up the gap: Halvorsen moved to monthly
      </p>
      <div className="jn-stateline" role="alert">
        <Icon name="alert" size={16} />
        <span>The answer stopped after 41 words: the connection dropped.</span>
      </div>
      <div className="jn-stateactions">
        <button type="button" className="jb jb--secondary jb--sm">
          Try again
        </button>
        <button type="button" className="jb jb--ghost jb--sm">
          Keep what arrived
        </button>
      </div>
    </div>
  );
}

function SlowFirstWord() {
  return (
    <div className="jn-stateblock">
      <LiveLine text="Still reading Halvorsen annual report 2026.pdf, 64 pages" seconds={24} />
      <p className="jn-stateline jn-stateline--quiet">
        <span>Long files take a while. You can keep writing; Alevr answers when it has read it.</span>
        <button type="button" className="jb jb--link">
          Answer now
        </button>
      </p>
    </div>
  );
}

function AppBlocked() {
  return (
    <div className="jn-stateblock">
      <div className="jn-blocked">
        <LinearMark size={20} />
        <div className="jn-blocked__main">
          <p className="jn-blocked__title">Linear isn’t connected, so Alevr can’t read the Atlas issues</p>
          <p className="jn-blocked__line">Connecting opens Linear to sign in. Creating an issue will still ask you first.</p>
        </div>
        <button type="button" className="jb jb--primary jb--sm">
          Connect Linear
        </button>
      </div>
    </div>
  );
}

function OfflineDock() {
  return (
    <div className="jn-statedock">
      <Composer
        initial={[{ t: "text", v: "When that’s done, draft the renewal email to Kari at Halvorsen" }]}
        variant="dock"
        dockRow={
          <div className="jn-dockrow" role="status">
            <Icon name="offline" size={16} className="ink-3" />
            <span className="jn-dockrow__text">
              You’re offline. <span className="ink-3">This sends when you’re back.</span>
            </span>
            <button type="button" className="jb jb--ghost jb--sm">
              Cancel
            </button>
          </div>
        }
      />
    </div>
  );
}

function FirstRun() {
  return (
    <div className="jn-firstrun">
      <p className="t-display">Good afternoon, Liam</p>
      <p className="jn-firstrun__line">Alevr works in your apps and files. Connect one to start, or just ask.</p>
      <div className="jn-firstrun__apps">
        {["gmail", "slack", "drive", "github"].map((id) => (
          <button key={id} type="button" className="jn-chip">
            <AppMark id={id} size={16} />
            {id === "gmail" ? "Gmail" : id === "slack" ? "Slack" : id === "drive" ? "Google Drive" : "GitHub"}
          </button>
        ))}
      </div>
      <div className="jn-firstrun__side">
        <p className="jn-side__label">
          <span>Orbit</span>
        </p>
        <p className="jn-firstrun__empty">Your agents carry standing work forward, like a Monday renewal check.</p>
        <button type="button" className="jb jb--secondary jb--sm jicon-trigger jicon-quiet">
          <Icon name="create-agent" size={16} />
          Create agent
        </button>
      </div>
    </div>
  );
}

function LibraryEmpty() {
  return (
    <div className="jn-empty jn-empty--compact">
      <p className="t-display">Nothing here yet</p>
      <p className="jn-empty__line">Folios, what Alevr makes, and the files you give it land here.</p>
      <button type="button" className="jb jb--secondary jb--sm jicon-trigger jicon-quiet">
        <Icon name="upload" size={16} />
        Upload
      </button>
    </div>
  );
}

function Uploads() {
  return (
    <ul className="jn-uploads">
      <li className="jn-upload">
        <FileMark name="Q4 plan.pdf" size={20} />
        <span className="jn-upload__main">
          <span className="jn-upload__name">Q4 plan.pdf</span>
          <span className="jn-upload__line num">Uploading, 3.1 of 5.0 MB</span>
        </span>
        <span className="jn-upload__glyph">
          <Icon name="progress" size={16} value={0.62} />
        </span>
        <button type="button" className="jb jb--ghost jb--sm">
          Cancel
        </button>
      </li>
      <li className="jn-upload" data-failed="">
        <FileMark name="Site walkthrough.mp4" size={20} />
        <span className="jn-upload__main">
          <span className="jn-upload__name">Site walkthrough.mp4</span>
          <span className="jn-upload__line">Not uploaded: it is 1.4 GB, and the limit is 512 MB</span>
        </span>
        <button type="button" className="jb jb--secondary jb--sm">
          Choose another
        </button>
      </li>
    </ul>
  );
}

function ExpiredApp() {
  return (
    <div className="jn-approw jn-approw--state">
      <span className="jn-approw__mark">
        <AppMark id="gmail" size={22} />
      </span>
      <span className="jn-approw__text">
        <span className="jn-approw__name">Gmail</span>
        <span className="jn-approw__line jn-approw__line--warn">Sign-in expired 2 days ago. Alevr can’t read or send mail.</span>
      </span>
      <button type="button" className="jb jb--secondary jb--sm">
        Reconnect
      </button>
    </div>
  );
}

function TestsFailed() {
  return (
    <div className="jn-stateblock">
      <ol className="jn-steps">
        <li className="jn-step" data-state="done">
          <span className="jn-step__glyph">
            <Icon name="check" size={16} />
          </span>
          <span className="jn-step__verb">Edited</span>
          <span className="jn-step__obj mono">src/sync/worker.ts</span>
        </li>
        <li className="jn-step" data-state="failed">
          <span className="jn-step__glyph">
            <Icon name="alert" size={16} />
          </span>
          <span className="jn-step__verb">Ran</span>
          <span className="jn-step__obj mono">npm test -- sync</span>
          <span className="jn-step__extra">3 of 128 failed</span>
        </li>
      </ol>
      <p className="jn-stateline jn-stateline--quiet">
        <span>
          <b className="jn-state__strong">retry keeps the lease</b> and two others fail in <span className="mono">worker.test.ts</span>: the lease is never released after the last attempt.
        </span>
      </p>
      <div className="jn-stateactions">
        <button type="button" className="jb jb--primary jb--sm">
          Fix the 3 failures
        </button>
        <button type="button" className="jb jb--secondary jb--sm">
          Show output
        </button>
      </div>
    </div>
  );
}

/** Agents that are not working say why in words, with the verb that moves them on: Blocked (and the fix), Finished (and what). */
function CrewPaused() {
  const ines = CREW.find((m) => m.id === "ines") ?? CREW[0];
  const tomas = CREW.find((m) => m.id === "tomas") ?? CREW[0];
  return (
    <div className="jn-stateblock">
      {[ines, tomas].map((m) => (
        <div key={m.id} className="jn-crewstate">
          <CrewMark member={face(m)} state={m.state} size={24} />
          <span className="jn-crewstate__main">
            <span className="jn-crewstate__name">{m.name}</span>
            <span className="jn-crewstate__line">{m.long}</span>
          </span>
          <button type="button" className="jb jb--secondary jb--sm">
            {m.status === "blocked" ? "Reconnect Greenhouse" : "Open the review"}
          </button>
        </div>
      ))}
    </div>
  );
}

export function StatesScene() {
  return (
    <main className="jn-states">
      <header className="jn-states__head">
        <h1 className="t-title">States</h1>
        <p className="jn-page__lede">The frames between the happy ones: loading, empty, error, blocked, offline and slow. Each says what happened in plain words and offers the one next step.</p>
      </header>
      <div className="jn-states__grid">
        <Cell label="Loading." cap="Opening a long thread: its shape in the panel’s own tones, still, until the words arrive.">
          <ThreadLoading />
        </Cell>
        <Cell label="Slow." cap="After 10 s the live line admits it and offers a way out (§3.10).">
          <SlowFirstWord />
        </Cell>
        <Cell label="Error." cap="An answer cut off: what arrived stays, the reason is one line, the fix is the first button.">
          <AnswerFailed />
        </Cell>
        <Cell label="Blocked." cap="An app the message needs is not connected: said before anything runs, with the one verb that unblocks it.">
          <AppBlocked />
        </Cell>
        <Cell label="Offline." cap="The message waits in the dock and says when it will go.">
          <OfflineDock />
        </Cell>
        <Cell label="Failed run." cap="Code: which step failed, why, in one sentence, and the next move.">
          <TestsFailed />
        </Cell>
        <Cell label="First run." cap="No chats and no crew yet: the home teaches by offering the first connection.">
          <FirstRun />
        </Cell>
        <Cell label="Empty." cap="The Library before anything lands in it.">
          <LibraryEmpty />
        </Cell>
        <Cell label="Uploading and refused." cap="Real progress, a reason in words, a way forward.">
          <Uploads />
        </Cell>
        <Cell label="Expired." cap="An app whose sign-in lapsed: what Alevr can no longer do, and Reconnect.">
          <ExpiredApp />
        </Cell>
        <Cell label="Blocked and finished." cap="An agent that stopped says why in words, with the one verb that moves it on.">
          <CrewPaused />
        </Cell>
      </div>
    </main>
  );
}
