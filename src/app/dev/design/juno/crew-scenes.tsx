"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewFace } from "./crew/face";
import { CREW, crew, STATE_WORD, type CrewRow } from "./fixtures";
import { Composer } from "./composer";
import { Icon } from "./icons";
import { AppMark, FileMark } from "./marks";
import { R, T, useReduced } from "./motion";
import { AppFrame, ChatSidebar, face, MobileBar, TopBar } from "./shell";

/*
 * Crew. The roster opens on the team itself: a lineup of faces at a size where
 * form, material and state all read (the face is the status; the words under
 * it say the same), then what needs you, what is happening, and the standing
 * work. A member's page is their thread, with their name in the display serif.
 */

function Portrait({ m }: { m: CrewRow }) {
  return (
    <a href="#" className="jn-portrait" aria-label={`${m.name}, ${m.role}, ${m.long}`}>
      <span className="jn-portrait__face">
        <CrewFace member={face(m)} state={m.state} size={96} facing="front" />
      </span>
      <span className="jn-portrait__name">{m.name}</span>
      <span className="jn-portrait__role">{m.role}</span>
      <span className="jn-portrait__state" data-state={m.state}>
        {m.state === "waiting" ? "Needs your answer" : m.state === "available" ? "Free" : (m.roster ?? m.long)}
      </span>
    </a>
  );
}

function NeedsYou() {
  const reduced = useReduced();
  const [answer, setAnswer] = React.useState<string | null>(null);
  const mira = crew("mira");
  return (
    <section className="jn-crewsec" aria-label="Needs you">
      <h2 className="jn-crewsec__label">Needs you</h2>
      <div className="jn-ask">
        <span className="jn-ask__face">
          <CrewFace member={face(mira)} state={answer ? "working" : "waiting"} size={32} live={false} />
        </span>
        <div className="jn-ask__main">
          <p className="jn-ask__who">
            <b>Mira</b> <span className="jn-attn">needs your answer</span> <span className="ink-3">in Q3 forecast against Stripe revenue, 4 min ago</span>
          </p>
          <p className="jn-ask__q">Halvorsen has two Stripe customers. Which one holds the annual plan?</p>
          <AnimatePresence mode="wait" initial={false}>
            {answer ? (
              <motion.p key="a" className="jn-ask__done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.base}>
                <Icon name="check" size={16} state="active" /> You answered {answer}. Mira is carrying on.
              </motion.p>
            ) : (
              <motion.div key="q" className="jn-ask__options" exit={{ opacity: 0 }} transition={reduced ? R : T.exit}>
                {["Halvorsen AS", "Halvorsen Group"].map((o) => (
                  <button key={o} type="button" className="jb jb--secondary jb--sm" onClick={() => setAnswer(o)}>
                    {o}
                  </button>
                ))}
                <a href="#" className="jb jb--link jn-ask__open">
                  Something else, in the chat
                </a>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

const ROUTINES = [
  { name: "Renewal check", owner: "mira", when: "Mondays at 9:00, next Monday" },
  { name: "Unpaid invoices over €5,000", owner: "otto", when: "Every weekday at 7:30, next tomorrow" },
  { name: "Escalation digest to #support", owner: "rhea", when: "Fridays at 16:00, next Friday" },
];

export function CrewScene() {
  const now = CREW.filter((m) => m.state === "working" || m.state === "thinking");
  return (
    <AppFrame sidebar={<ChatSidebar current="crew" />}>
      <MobileBar title="Crew" />
      <div className="jn-page jn-page--crew">
        <header className="jn-page__head">
          <div>
            <h1 className="t-title">Crew</h1>
            <p className="jn-page__lede">Six teammates. Each has its own thread, standing work and apps, and keeps working when you leave.</p>
          </div>
          <button type="button" className="jb jb--secondary jicon-trigger">
            <Icon name="plus" size={16} />
            Add to crew
          </button>
        </header>

        <div className="jn-lineup" role="list">
          {CREW.map((m) => (
            <div role="listitem" key={m.id}>
              <Portrait m={m} />
            </div>
          ))}
        </div>

        <NeedsYou />

        <section className="jn-crewsec" aria-label="Happening now">
          <h2 className="jn-crewsec__label">Happening now</h2>
          <ul className="jn-nowlist">
            {now.map((m) => (
              <li key={m.id} className="jn-now">
                <CrewFace member={face(m)} state={m.state} size={24} live={false} />
                <span className="jn-now__name">{m.name}</span>
                <span className="jn-now__what">{m.long}</span>
                <span className="jn-now__when">{m.state === "working" ? "for 18 min" : "for 2 min"}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="jn-crewsec" aria-label="Standing work">
          <h2 className="jn-crewsec__label">Standing work</h2>
          <ul className="jn-nowlist">
            {ROUTINES.map((r) => {
              const o = crew(r.owner);
              return (
                <li key={r.name} className="jn-now jn-now--routine">
                  <Icon name="routine" size={16} className="ink-3" />
                  <span className="jn-now__what jn-now__what--ink">{r.name}</span>
                  <span className="jn-now__owner">
                    <CrewFace member={face(o)} state="available" size={16} live={false} /> {o.name}
                  </span>
                  <span className="jn-now__when">{r.when}</span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </AppFrame>
  );
}

/* ———————————————————————— A member's own thread ———————————————————————— */

function CrewRun({ m, time, children }: { m: CrewRow; time: string; children: React.ReactNode }) {
  return (
    <div className="jn-cmsg">
      <p className="jn-cmsg__who">
        <CrewFace member={face(m)} state="available" size={20} live={false} />
        <b>{m.name}</b> <span className="ink-3 num">{time}</span>
      </p>
      <div className="jn-cmsg__body">{children}</div>
    </div>
  );
}

export function MemberScene({ id }: { id: string }) {
  const m = crew(id);
  const [choice, setChoice] = React.useState<string | null>(null);
  return (
    <AppFrame sidebar={<ChatSidebar current="crew" crewCurrent={m.id} />}>
      <div className="jn-chat">
        <MobileBar title={m.name} back />
        <TopBar>
          <button type="button" className="jb jb--ghost jb--sm jicon-trigger">
            <Icon name="edit" size={16} />
            Appearance
          </button>
          <button type="button" className="jb jb--ghost jb--sm jicon-trigger">
            <Icon name="pause" size={16} />
            Pause
          </button>
          <button type="button" className="jib jicon-trigger" aria-label="More">
            <Icon name="more" size={20} />
          </button>
        </TopBar>
        <div className="jn-thread jn-member" role="log">
          <header className="jn-member__head">
            <span className="jn-member__face">
              <CrewFace member={face(m)} state={m.state} size={64} facing="front" label />
            </span>
            <div className="jn-member__who">
              <h1 className="t-title">{m.name}</h1>
              <p className="jn-member__role">{m.role}. Watches renewals, reads Stripe and Salesforce, and posts to Slack when you allow it.</p>
              <p className="jn-member__state">
                {m.state === "waiting" ? <span className="jn-attn">Needs your answer on the Halvorsen renewal</span> : <span className="ink-2">{STATE_WORD[m.state]}</span>}
              </p>
            </div>
          </header>
          <div className="jn-member__facts">
            <span>
              <Icon name="routine" size={16} /> Renewal check, Mondays at 9:00
            </span>
            <span className="jn-member__apps">
              <AppMark id="stripe" size={16} />
              <AppMark id="slack" size={16} />
              <AppMark id="notion" size={16} /> Uses 3 apps
            </span>
            <span>Asks before posting or changing anything</span>
          </div>

          <div className="jn-daymark">Monday</div>
          <CrewRun m={m} time="9:04">
            <p>The weekly renewal check is done. Three accounts renew in the next 45 days and one of them looks at risk.</p>
            <a href="#" className="jn-attach">
              <FileMark name="Renewal notes.md" size={20} />
              <span className="jn-attach__text">
                <span>Renewal notes, week 40</span>
                <span className="ink-3">Document, 2 pages</span>
              </span>
            </a>
          </CrewRun>
          <div className="jn-umsg">
            <div className="jn-umsg__bubble">
              <span className="jn-sentence">Check usage on Halvorsen, Brightline and Oakridge and tell me which ones are worth a call.</span>
            </div>
          </div>
          <div className="jn-daymark">Today</div>
          <CrewRun m={m} time="13:52">
            <p>Brightline and Oakridge look fine. Usage is flat, and the Oakridge invoice is a billing error on our side, not churn.</p>
            <p>Halvorsen has two Stripe customers and I can’t tell which one holds the annual plan.</p>
            <div className="jn-cmsg__ask">
              <p className="jn-task__ask">
                <b className="jn-attn">Needs your answer:</b> which customer holds the annual plan?
              </p>
              <div className="jn-q" role="radiogroup" aria-label="Which customer holds the annual plan?">
                {[
                  ["Halvorsen AS", "Annual plan, €96,000, renews 30 November"],
                  ["Halvorsen Group", "Monthly since August, €6,033 a month"],
                ].map(([v, line], i) => (
                  <button key={v} type="button" role="radio" aria-checked={choice === v} className="jn-q__opt" onClick={() => setChoice(v)}>
                    <span className="jn-q__radio" aria-hidden="true" />
                    <span className="jn-q__text">
                      <span>{v}</span>
                      <span className="jn-q__line">{line}</span>
                    </span>
                    <span className="jkbd jn-q__key" aria-hidden="true">
                      {i + 1}
                    </span>
                  </button>
                ))}
              </div>
              <div className="jn-q__actions">
                <button type="button" className="jb jb--ghost jb--sm">
                  Skip
                </button>
                <button type="button" className="jb jb--primary jb--sm" aria-disabled={!choice}>
                  Continue
                </button>
              </div>
            </div>
          </CrewRun>
        </div>
        <div className="jn-dock">
          <Composer variant="dock" placeholder={`Message ${m.name}…`} label={`Message ${m.name}`} />
        </div>
      </div>
    </AppFrame>
  );
}
