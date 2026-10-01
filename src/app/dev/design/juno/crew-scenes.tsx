"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewFace } from "./crew/face";
import { CREW, crew, type CrewRow, type Segment } from "./fixtures";
import { Composer } from "./composer";
import { MemberPeek, Reaction, useMemberTheme, type PeekHandle } from "./crew-bridge";
import { CrewEditor } from "./crew-editor";
import { Icon } from "./icons";
import { FileMark } from "./marks";
import { R, SPRING, T, useReduced } from "./motion";
import { AppFrame, ChatSidebar, face, MobileBar } from "./shell";

/*
 * Crew (D-032). Crew members are characters: each has a body, a material, a
 * colour and eyes the person chose, and that colour follows the member into
 * its own thread (the person's bubbles, the send disc). The roster opens on
 * the team itself, big enough for each look and state to read; a member's
 * page is its thread, with the character peeking over the conversation.
 *
 *   /dev/design/juno?scene=crew                               roster
 *   /dev/design/juno?scene=crew&flow=add                      add to crew
 *   /dev/design/juno?scene=crew&flow=customize&member=mira    customize a member
 *   /dev/design/juno?scene=crew&member=mira                   the member's thread
 */

/* ———————————————————————————— Roster ———————————————————————————— */

function Portrait({ m, onCustomize }: { m: CrewRow; onCustomize: (id: string) => void }) {
  const member = face(m);
  const words = m.state === "waiting" ? "Needs your answer" : m.state === "available" ? "Free" : (m.roster ?? m.long);
  return (
    <div className="jn-portrait" data-state={m.state}>
      <a href="#" className="jn-portrait__link" aria-label={`${m.name}, ${m.role}. ${words}. Open thread`}>
        <span className="jn-portrait__face">
          <CrewFace member={member} state={m.state} size={112} facing="front" />
        </span>
        <span className="jn-portrait__name">{m.name}</span>
        <span className="jn-portrait__role">{m.role}</span>
        <span className="jn-portrait__state" data-state={m.state}>
          {words}
        </span>
      </a>
      <button type="button" className="jib jib--sm jicon-trigger jn-portrait__edit" aria-label={`Customize ${m.name}`} onClick={() => onCustomize(m.id)}>
        <Icon name="edit" size={16} />
      </button>
    </div>
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
          <CrewFace member={face(mira)} state={answer ? "working" : "waiting"} size={32} live={false} facing="front" />
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

export function CrewScene({ flow, member }: { flow?: string; member?: string }) {
  const now = CREW.filter((m) => m.state === "working" || m.state === "thinking");
  const initial: Sheet = flow === "add" ? { kind: "add" } : flow === "customize" ? { kind: "customize", id: member ?? "mira" } : null;
  const [sheet, setSheet] = React.useState<Sheet>(initial);
  return (
    <AppFrame sidebar={<ChatSidebar current="crew" />}>
      <MobileBar title="Crew" />
      <div className="jn-page jn-page--crew">
        <header className="jn-page__head">
          <div>
            <h1 className="t-title">Crew</h1>
            <p className="jn-page__lede">Six teammates. Each has its own thread, standing work and apps, and keeps working when you leave.</p>
          </div>
          <button type="button" className="jb jb--secondary jicon-trigger" onClick={() => setSheet({ kind: "add" })}>
            <Icon name="plus" size={16} />
            Add to crew
          </button>
        </header>

        <div className="jn-lineup" role="list">
          {CREW.map((m) => (
            <div role="listitem" key={m.id}>
              <Portrait m={m} onCustomize={(id) => setSheet({ kind: "customize", id })} />
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
      <AnimatePresence>{sheet ? <CrewSheet key={sheet.kind === "add" ? "add" : sheet.id} sheet={sheet} onClose={() => setSheet(null)} /> : null}</AnimatePresence>
    </AppFrame>
  );
}

/* ———————————————————————————— Add to crew / Customize ———————————————————————————— */

type Sheet = { kind: "add" } | { kind: "customize"; id: string } | null;

const DOES: Record<string, string> = {
  mira: "Watches renewals, reads Stripe and Salesforce, and posts to Slack when you allow it.",
  scout: "Researches markets and competitors and writes short briefs with sources.",
  otto: "Reconciles invoices against the ledger every month and flags differences over €50.",
  rhea: "Reads support escalations and drafts replies for you to send.",
  ines: "Screens applicants for open roles and schedules first calls.",
  tomas: "Watches alerts overnight and writes the incident summary for the morning.",
};

function CrewSheet({ sheet, onClose }: { sheet: NonNullable<Sheet>; onClose: () => void }) {
  if (sheet.kind === "add") return <CrewEditor sheet={{ kind: "add" }} onClose={onClose} />;
  const m = crew(sheet.id);
  return <CrewEditor sheet={{ kind: "customize", member: face(m), role: m.role, does: DOES[m.id] ?? m.long }} onClose={onClose} />;
}

/* ———————————————————————————— A member's own thread ———————————————————————————— */

function CrewRun({ m, time, children }: { m: CrewRow; time: string; children: React.ReactNode }) {
  return (
    <div className="jn-cmsg">
      <p className="jn-cmsg__who">
        <CrewFace member={face(m)} state="available" size={20} live={false} facing="front" />
        <b>{m.name}</b> <span className="ink-3 num">{time}</span>
      </p>
      <div className="jn-cmsg__body">{children}</div>
    </div>
  );
}

function Mine({ children, time, reaction }: { children: React.ReactNode; time?: string; reaction?: React.ReactNode }) {
  return (
    <div className="jn-umsg">
      <div className="jn-umsg__bubble">
        {reaction}
        <span className="jn-sentence">{children}</span>
      </div>
      {time ? <p className="jn-receipt">{time}</p> : null}
    </div>
  );
}

const MEMBER_DRAFT: Segment[] = [{ t: "text", v: "When that’s done, draft the renewal email to Kari at Halvorsen" }];

export function MemberScene({ id, top }: { id: string; top?: boolean }) {
  const m = crew(id);
  const member = face(m);
  const theme = useMemberTheme(member);
  const reduced = useReduced();
  const [answered, setAnswered] = React.useState(true);
  const [sheet, setSheet] = React.useState<Sheet>(null);
  const peek = React.useRef<PeekHandle | null>(null);
  const lastBlink = React.useRef(0);
  // P4: the character blinks when the person starts typing to it, at most once every 4 s.
  const onType = React.useCallback(() => {
    const now = performance.now();
    if (now - lastBlink.current < 4000) return;
    lastBlink.current = now;
    peek.current?.blink();
  }, []);

  React.useEffect(() => {
    if (top) return;
    const go = () => window.scrollTo(0, document.documentElement.scrollHeight);
    go();
    const ts = [150, 400, 900, 1500].map((ms) => window.setTimeout(go, ms));
    return () => ts.forEach((t) => window.clearTimeout(t));
  }, [top]);

  return (
    <AppFrame sidebar={<ChatSidebar current="crew" crewCurrent={m.id} />}>
      <div className="jn-chat jn-mthread" style={theme.style} data-member-theme={theme.family}>
        <header className="jn-mhead">
          <div className="jn-mhead__bar">
            <button type="button" className="jib jicon-trigger jn-mhead__back" aria-label="Back">
              <Icon name="chevron-left" size={20} />
            </button>
            <span className="jn-mhead__actions">
              <button type="button" className="jb jb--ghost jb--sm jicon-trigger jn-mhead__customize" onClick={() => setSheet({ kind: "customize", id: m.id })}>
                <Icon name="customize" size={16} />
                <span>Customize</span>
              </button>
              <button type="button" className="jib jicon-trigger" aria-label={`Pause ${m.name}`}>
                <Icon name="pause" size={20} />
              </button>
              <button type="button" className="jib jicon-trigger" aria-label="More">
                <Icon name="more" size={20} />
              </button>
            </span>
          </div>
          <div className="jn-mhead__peek">
            <MemberPeek member={member} state={answered ? "working" : "waiting"} words={answered ? "Reading seat usage…" : undefined} arrive handleRef={peek} />
          </div>
        </header>

        <div className="jn-thread jn-member" role="log" aria-label={`${m.name}’s thread`}>
          <p className="jn-member__intro">
            {m.name} joined your crew on 2 September. {m.role}: watches renewals, reads Stripe and Salesforce, and posts to Slack when you allow it.
          </p>
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
          <Mine>Check usage on Halvorsen, Brightline and Oakridge and tell me which ones are worth a call.</Mine>

          <div className="jn-daymark">Today</div>
          <CrewRun m={m} time="13:52">
            <p>Brightline and Oakridge look fine. Usage is flat, and the Oakridge invoice is a billing error on our side, not churn.</p>
            <p>Halvorsen has two Stripe customers. Which one holds the annual plan?</p>
            <AnimatePresence mode="wait" initial={false}>
              {answered ? (
                <motion.p key="done" className="jn-answered" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.base}>
                  <Icon name="check" size={16} state="active" />
                  <span>
                    You answered <b>Halvorsen AS</b>
                  </span>
                  <button type="button" className="jb jb--link" onClick={() => setAnswered(false)}>
                    Change
                  </button>
                </motion.p>
              ) : (
                <motion.div key="ask" className="jn-ask__options" exit={{ opacity: 0 }} transition={reduced ? R : T.exit}>
                  {["Halvorsen AS", "Halvorsen Group"].map((o) => (
                    <button key={o} type="button" className="jb jb--secondary jb--sm" onClick={() => setAnswered(true)}>
                      {o}
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </CrewRun>
          <Mine time="Read 13:58" reaction={answered ? <Reaction member={member} /> : null}>
            Halvorsen AS. Thanks {m.name}, that saves me a morning.
          </Mine>

          {answered ? (
            <motion.div className="jn-mlive" initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? R : SPRING.layout}>
              <CrewFace member={member} state="thinking" size={20} live={false} facing="front" />
              <span className="jn-mlive__text">
                <b>{m.name}</b> is reading 90 days of seat usage for Halvorsen AS in Stripe
              </span>
              <span className="jn-mlive__time num">14 s</span>
            </motion.div>
          ) : null}
        </div>
        <div className="jn-dock">
          <Composer variant="dock" initial={MEMBER_DRAFT} placeholder={`Message ${m.name}…`} label={`Message ${m.name}`} onType={onType} />
        </div>
      </div>
      <AnimatePresence>{sheet ? <CrewSheet key="customize" sheet={sheet} onClose={() => setSheet(null)} /> : null}</AnimatePresence>
    </AppFrame>
  );
}
