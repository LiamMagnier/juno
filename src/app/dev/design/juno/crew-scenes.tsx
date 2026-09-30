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
 * Crew. The roster opens on the team itself: every member's face at a size
 * where its state reads (the face is the status; the word under it says the
 * same), then what needs you, what is happening, and the standing work. A
 * member's page is their thread, with their name set in the display serif.
 */

function Portrait({ m, selected }: { m: CrewRow; selected?: boolean }) {
  return (
    <a href="#" className="jn-portrait" data-selected={selected ? "" : undefined} aria-label={`${m.name}, ${m.role}, ${STATE_WORD[m.state]}`}>
      <span className="jn-portrait__face">
        <CrewFace member={face(m)} state={m.state} size={64} facing="front" />
      </span>
      <span className="jn-portrait__name">{m.name}</span>
      <span className="jn-portrait__state" data-state={m.state}>
        {STATE_WORD[m.state]}
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
          <CrewFace member={face(mira)} state={answer ? "working" : "waiting"} size={32} />
        </span>
        <div className="jn-ask__main">
          <p className="jn-ask__who">
            <b>Mira</b> <span className="ink-3">in Q3 forecast against Stripe revenue, 4 min ago</span>
          </p>
          <p className="jn-ask__q">Halvorsen has two Stripe customers. Which one holds the annual plan?</p>
          <AnimatePresence mode="wait" initial={false}>
            {answer ? (
              <motion.p key="a" className="jn-ask__done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.fade}>
                <Icon name="check" size={16} state="active" /> You answered {answer}. Mira is carrying on.
              </motion.p>
            ) : (
              <motion.div key="q" className="jn-ask__options" exit={{ opacity: 0 }} transition={reduced ? R : T.menuOut}>
                {["Halvorsen AS", "Halvorsen Group", "Check both"].map((o) => (
                  <button key={o} type="button" className="jb jb--secondary jb--sm" onClick={() => setAnswer(o)}>
                    {o}
                  </button>
                ))}
                <a href="#" className="jb jb--link jn-ask__open">
                  Open the chat
                </a>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
}

export function CrewScene() {
  const now = CREW.filter((m) => m.state === "working" || m.state === "thinking");
  return (
    <AppFrame sidebar={<ChatSidebar current="crew" />}>
      <MobileBar title="Crew" />
      <div className="jn-page jn-page--crew">
        <header className="jn-page__head">
          <div>
            <h1 className="t-title">Crew</h1>
            <p className="jn-page__lede">Six teammates. Each keeps its own thread, standing work and apps.</p>
          </div>
          <button type="button" className="jb jb--secondary jicon-trigger">
            <Icon name="plus" size={16} />
            Add to crew
          </button>
        </header>

        <div className="jn-portraits" role="list">
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
                <CrewFace member={face(m)} state={m.state} size={24} />
                <span className="jn-now__name">{m.name}</span>
                <span className="jn-now__what">{m.now}</span>
                <span className="jn-now__when">{m.state === "working" ? "for 18 min" : "for 2 min"}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="jn-crewsec" aria-label="Standing work">
          <h2 className="jn-crewsec__label">Standing work</h2>
          <ul className="jn-nowlist">
            <li className="jn-now">
              <Icon name="routine" size={16} className="ink-3" />
              <span className="jn-now__what jn-now__what--ink">Renewal check</span>
              <span className="jn-now__owner">
                <CrewFace member={face(crew("mira"))} state="available" size={16} live={false} /> Mira
              </span>
              <span className="jn-now__when">Mondays at 9:00</span>
            </li>
            <li className="jn-now">
              <Icon name="routine" size={16} className="ink-3" />
              <span className="jn-now__what jn-now__what--ink">Unpaid invoices over €5,000</span>
              <span className="jn-now__owner">
                <CrewFace member={face(crew("otto"))} state="available" size={16} live={false} /> Otto
              </span>
              <span className="jn-now__when">Daily at 7:30</span>
            </li>
            <li className="jn-now">
              <Icon name="routine" size={16} className="ink-3" />
              <span className="jn-now__what jn-now__what--ink">Escalation digest to #support</span>
              <span className="jn-now__owner">
                <CrewFace member={face(crew("rhea"))} state="available" size={16} live={false} /> Rhea
              </span>
              <span className="jn-now__when">Fridays at 16:00</span>
            </li>
          </ul>
        </section>
      </div>
    </AppFrame>
  );
}

/* ———————————————————————— A member's own thread ———————————————————————— */

function CrewMessage({ m, time, children }: { m: CrewRow; time: string; children: React.ReactNode }) {
  return (
    <div className="jn-cmsg">
      <span className="jn-cmsg__face">
        <CrewFace member={face(m)} state="available" size={24} live={false} />
      </span>
      <div className="jn-cmsg__main">
        <p className="jn-cmsg__who">
          <b>{m.name}</b> <span className="ink-3 num">{time}</span>
        </p>
        <div className="jn-cmsg__body">{children}</div>
      </div>
    </div>
  );
}

export function MemberScene({ id }: { id: string }) {
  const m = crew(id);
  return (
    <AppFrame sidebar={<ChatSidebar current="crew" crewCurrent={m.id} />}>
      <div className="jn-chat">
        <MobileBar title={m.name} back />
        <TopBar>
          <button type="button" className="jb jb--ghost jb--sm jicon-trigger">
            <Icon name="pause" size={16} />
            Pause
          </button>
          <button type="button" className="jib jicon-trigger" aria-label="More">
            <Icon name="more" size={20} />
          </button>
        </TopBar>
        <div className="jn-thread jn-member">
          <header className="jn-member__head">
            <CrewFace member={face(m)} state={m.state} size={72} facing="front" />
            <div className="jn-member__who">
              <h1 className="t-title">{m.name}</h1>
              <p className="jn-member__role">
                {m.role}. Watches renewals, reads Stripe and Salesforce, posts to Slack when you allow it.
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
              <AppMark id="notion" size={16} /> 3 apps
            </span>
          </div>

          <div className="jn-daymark">Monday</div>
          <CrewMessage m={m} time="9:04">
            <p>Weekly renewal check is done. Three accounts renew in the next 45 days and one of them looks at risk.</p>
            <a href="#" className="jn-attach">
              <FileMark name="Renewal notes.md" size={20} />
              <span className="jn-attach__text">
                <span>Renewal notes, week 40</span>
                <span className="ink-3">Document, 2 pages</span>
              </span>
            </a>
          </CrewMessage>
          <div className="jn-umsg">
            <div className="jn-umsg__bubble">
              <span className="jn-umsg__bg" />
              <span className="jn-sentence" style={{ position: "relative" }}>
                Check usage on Halvorsen, Brightline and Oakridge and tell me which ones are worth a call.
              </span>
            </div>
          </div>
          <div className="jn-daymark">Today</div>
          <CrewMessage m={m} time="13:52">
            <p>Brightline and Oakridge look fine: usage is flat and the Oakridge invoice is a billing error on our side, not churn.</p>
            <p>Halvorsen has two Stripe customers and I can’t tell which one holds the annual plan.</p>
            <div className="jn-cmsg__ask">
              <p className="jn-task__needlabel">Mira needs your answer</p>
              <div className="jn-task__options">
                {["Halvorsen AS", "Halvorsen Group", "Check both"].map((o) => (
                  <button key={o} type="button" className="jb jb--secondary jb--sm">
                    {o}
                  </button>
                ))}
              </div>
            </div>
          </CrewMessage>
        </div>
        <div className="jn-dock">
          <Composer variant="dock" placeholder={`Message ${m.name}`} />
        </div>
      </div>
    </AppFrame>
  );
}
