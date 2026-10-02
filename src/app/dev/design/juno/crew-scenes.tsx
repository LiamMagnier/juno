"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewFace } from "./crew/face";
import { CREW, crew, STATE_WORD, type CrewRow, type Segment } from "./fixtures";
import { Composer } from "./composer";
import { CrewMark, MemberPeek, Reaction, useMemberTheme } from "./crew-bridge";
import { AvatarEditor, CrewCreate, normalizeAvatar, type AvatarConfig } from "./crew";
import { ThinkingMark } from "./brand";
import { Icon } from "./icons";
import { AppMark, FileMark } from "./marks";
import { useDialogFocus, usePhone } from "./layers";
import { R, SHEET_IN, SHEET_OUT, sheetFrom, SPRING, T, useReduced } from "./motion";
import { AppFrame, ChatSidebar, face, MobileBar, usePanelAtEnd } from "./shell";

/*
 * Alevr Orbit (D-032, D-035): your agents. Each agent is a character with a
 * body, a material, a colour and eyes the person chose, and that colour
 * follows it into its own thread (the person's bubbles, the send disc). The
 * Orbit page opens on the agents themselves, big enough for each look and
 * state to read; an agent's page is its thread, with the character peeking
 * over the conversation. Words: Orbit (navigation), Your agents (the
 * descriptor), an agent by its own name, Create agent; states Ready, Thinking,
 * Working, Needs your answer, Blocked, Finished. Routes and ids keep "crew".
 *
 *   /dev/design/juno?scene=crew                               Orbit, your agents
 *   /dev/design/juno?scene=crew&flow=add                      create an agent
 *   /dev/design/juno?scene=crew&flow=customize&member=mira    customize an agent
 *   /dev/design/juno?scene=crew&member=mira                   the agent's thread
 */

/* ———————————————————————————— Roster ———————————————————————————— */

function Portrait({ m, onCustomize }: { m: CrewRow; onCustomize: (id: string) => void }) {
  const member = face(m);
  const words = m.status === "needs" || m.status === "ready" ? STATE_WORD[m.status] : (m.roster ?? m.long);
  return (
    <div className="jn-portrait" data-state={m.state}>
      <a href="#" className="jn-portrait__link" aria-label={`${m.name}, ${m.role}. ${words}. Open thread`}>
        <span className="jn-portrait__face">
          <CrewFace member={member} state={m.state} size={112} facing="front" />
        </span>
        <span className="jn-portrait__name">{m.name}</span>
        <span className="jn-portrait__role">{m.role}</span>
        <span className="jn-portrait__state" data-state={m.state} data-status={m.status}>
          {words}
        </span>
      </a>
      <button type="button" className="jib jib--sm jicon-trigger jtip jn-portrait__edit" aria-label={`${m.name}’s appearance`} data-tip="Appearance" onClick={() => onCustomize(m.id)}>
        <Icon name="edit" size={16} />
      </button>
    </div>
  );
}

function NeedsYou() {
  const reduced = useReduced();
  const [answer, setAnswer] = React.useState<string | null>(null);
  const [reconnected, setReconnected] = React.useState(false);
  const mira = crew("mira");
  const ines = crew("ines");
  // Everyone who is stopped on the person is here (Revision 2: Ines was Blocked and missing). Only the
  // question takes the attention words; Blocked is said in plain ink with the one verb that unblocks it.
  return (
    <section className="jn-crewsec" aria-label="Needs you">
      <h2 className="jn-crewsec__label">Needs you</h2>
      <div className="jn-asks">
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
        <div className="jn-ask">
          <span className="jn-ask__face">
            <CrewFace member={face(ines)} state={reconnected ? "working" : "paused"} size={32} live={false} facing="front" />
          </span>
          <div className="jn-ask__main">
            <p className="jn-ask__who">
              <b>Ines</b> is blocked <span className="ink-3">since Friday</span>
            </p>
            <p className="jn-ask__q">The Greenhouse sign-in expired, so this week’s candidate digest has not gone out.</p>
            <AnimatePresence mode="wait" initial={false}>
              {reconnected ? (
                <motion.p key="a" className="jn-ask__done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={reduced ? R : T.base}>
                  <Icon name="check" size={16} state="active" /> Greenhouse is connected again. Ines is catching up.
                </motion.p>
              ) : (
                <motion.div key="q" className="jn-ask__options" exit={{ opacity: 0 }} transition={reduced ? R : T.exit}>
                  <button type="button" className="jb jb--secondary jb--sm" onClick={() => setReconnected(true)}>
                    Reconnect Greenhouse
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Create an agent by saying what it should take care of (Revision 2, as
 * today's Agents page and ORBIT_SYSTEM ask): the sentence comes first, the
 * look after. Create agent opens the flow with the sentence carried in.
 */
function Describe({ onCreate }: { onCreate: () => void }) {
  const [text, setText] = React.useState("");
  return (
    <form
      className="jn-describe"
      onSubmit={(e) => {
        e.preventDefault();
        onCreate();
      }}
    >
      <label className="jn-describe__box">
        <span className="jn-describe__label">What should a new agent take care of?</span>
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Keep my inbox at zero and draft replies for me to send"
          aria-describedby="jn-describe-note"
        />
      </label>
      <div className="jn-describe__foot">
        <p id="jn-describe-note" className="jn-describe__note">
          It asks before sending, paying or deleting anything. You choose how it looks next.
        </p>
        <button type="submit" className="jb jb--primary jicon-trigger">
          <Icon name="create-agent" size={16} />
          Create agent
        </button>
      </div>
    </form>
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
    <AppFrame sidebar={<ChatSidebar current="crew" askOnScreen={["mira", "ines"]} />}>
      <MobileBar title="Orbit" collapse />
      <div className="jn-page jn-page--crew">
        {/* Revision 2: the serif title alone (the thin glyph beside 32 px type sat below its optical centre), and
            the first line is the descriptor and where everyone is, in words, as today's Agents page opens. */}
        <header className="jn-page__head">
          <div>
            <h1 className="t-title">Orbit</h1>
            <p className="jn-page__lede">Your agents. Mira needs your answer and Ines is blocked; Otto and Rhea are working.</p>
          </div>
        </header>

        <Describe onCreate={() => setSheet({ kind: "add" })} />

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
                <CrewMark member={face(m)} state={m.state} size={24} />
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
                    <CrewMark member={face(o)} state="available" size={16} /> {o.name}
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

/** The dialog the crew designer's flows open in: a scrim, one raised sheet, a close button. */
function CrewSheet({ sheet, onClose }: { sheet: NonNullable<Sheet>; onClose: () => void }) {
  const reduced = useReduced();
  const m = sheet.kind === "customize" ? crew(sheet.id) : null;
  const member = m ? face(m) : null;
  const [look, setLook] = React.useState<AvatarConfig | null>(() => (member ? normalizeAvatar(member.avatar, member.seed) : null));
  const [name, setName] = React.useState(m?.name ?? "");
  const ref = React.useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref, true, onClose);
  return (
    <>
      <motion.div className="jn-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: reduced ? R : SHEET_OUT }} transition={reduced ? R : T.fade} onClick={onClose} />
      <motion.div
        ref={ref}
        className="jn-crewsheet"
        role="dialog"
        aria-modal="true"
        aria-label={m ? `${m.name}’s appearance` : "Create agent"}
        data-kind={sheet.kind}
        initial={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={reduced ? { opacity: 0, transition: R } : { opacity: 0, y: 8, scale: 0.99, transition: SHEET_OUT }}
        transition={reduced ? R : T.slow}
      >
        <button type="button" className="jib jicon-trigger jicon-quiet jtip jn-crewsheet__close" aria-label="Close" data-tip="Close" data-kbd="esc" data-tip-align="end" onClick={onClose}>
          <Icon name="close" size={20} />
        </button>
        <div className="jn-crewsheet__body">
          {m && look ? (
            <>
              <h2 className="t-display jn-crewsheet__title">{name.trim() || m.name}’s appearance</h2>
              <AvatarEditor value={look} onChange={setLook} name={name} onName={setName} onSave={onClose} onCancel={onClose} />
            </>
          ) : (
            <>
              {/* The flow is the character system's; the sheet names it in Alevr's words (its own heading is hidden here). */}
              <h2 className="t-display jn-crewsheet__title jn-crewsheet__title--create">Create agent</h2>
              <CrewCreate onCancel={onClose} onDone={onClose} initial={{ name: "Nova", role: "Product analytics", seed: "nova-3c1d" }} />
            </>
          )}
        </div>
      </motion.div>
    </>
  );
}

/* ———————————————————————————— A member's own thread ———————————————————————————— */

function CrewRun({ m, time, children }: { m: CrewRow; time: string; children: React.ReactNode }) {
  return (
    <div className="jn-cmsg">
      <p className="jn-cmsg__who">
        <CrewMark member={face(m)} state="available" size={20} />
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
  const [about, setAbout] = React.useState(false);
  const phone = usePhone();
  const [typing, setTyping] = React.useState(0);
  const lastBlink = React.useRef(0);
  // P4: the character blinks when the person starts typing to it, at most once every 4 s.
  const onType = React.useCallback(() => {
    const now = performance.now();
    if (now - lastBlink.current < 4000) return;
    lastBlink.current = now;
    setTyping((n) => n + 1);
  }, []);

  usePanelAtEnd(!top);

  return (
    <AppFrame sidebar={<ChatSidebar current="crew" crewCurrent={m.id} status={{ [m.id]: answered ? "working" : "needs" }} askOnScreen={answered ? [] : [m.id]} />}>
      <div className="jn-chat jn-mthread" style={theme.style} data-member-theme={theme.family}>
        <header className="jn-mhead">
          <div className="jn-mhead__bar">
            <button type="button" className="jib jicon-trigger jn-mhead__back" aria-label="Back">
              <Icon name="chevron-left" size={20} />
            </button>
            {/* Revision 2: "Customize" was the destination's word for the agent's look. The header now reaches who the
                agent is (role, standing work, apps and what each may do), its look, and Pause, each named. */}
            <span className="jn-mhead__actions">
              <button type="button" className="jb jb--ghost jb--sm jicon-trigger jicon-quiet jn-mhead__act" aria-label={`About ${m.name}`} onClick={() => setAbout(true)}>
                <Icon name="profile" size={16} />
                <span>About {m.name}</span>
              </button>
              <button type="button" className="jb jb--ghost jb--sm jicon-trigger jicon-quiet jn-mhead__act" aria-label={`${m.name}’s appearance`} onClick={() => setSheet({ kind: "customize", id: m.id })}>
                <Icon name="appearance" size={16} />
                <span>Appearance</span>
              </button>
              <button type="button" className="jb jb--ghost jb--sm jicon-trigger jicon-quiet jn-mhead__act" aria-label={`Pause ${m.name}`}>
                <Icon name="pause" size={16} />
                <span>Pause</span>
              </button>
              <button type="button" className="jib jicon-trigger jicon-quiet jtip" aria-label="More" data-tip="More" data-tip-align="end">
                <Icon name="more" size={20} />
              </button>
            </span>
          </div>
          <div className="jn-mhead__peek">
            <MemberPeek member={member} state={answered ? "working" : "waiting"} words={answered ? "Reading seat usage" : "Needs your answer"} arrive typing={typing} size={phone ? 72 : 116} />
          </div>
        </header>

        <div className="jn-thread jn-member" role="log" aria-label={`${m.name}’s thread`}>
          <p className="jn-member__intro">
            You created {m.name} on 2 September. {m.role}: watches renewals, reads Stripe and Gmail, and posts to Slack when you allow it.
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
            <motion.div className="jn-mlive" role="status" initial={reduced ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={reduced ? R : SPRING.layout}>
              <span className="jn-mlive__mark">
                <ThinkingMark size={20} />
              </span>
              <span className="jn-mlive__text">
                <b>{m.name}</b> is reading 90 days of seat usage for Halvorsen AS in Stripe
              </span>
              <span className="jn-mlive__time num">14 s</span>
            </motion.div>
          ) : null}
        </div>
        <div className="jn-dock">
          <Composer variant="dock" initial={MEMBER_DRAFT} placeholder={`Message ${m.name}`} label={`Message ${m.name}`} onType={onType} />
        </div>
      </div>
      <AnimatePresence>{sheet ? <CrewSheet key="customize" sheet={sheet} onClose={() => setSheet(null)} /> : null}</AnimatePresence>
      <AnimatePresence>
        {about ? (
          <AgentSheet
            m={m}
            onClose={() => setAbout(false)}
            onAppearance={() => {
              setAbout(false);
              setSheet({ kind: "customize", id: m.id });
            }}
          />
        ) : null}
      </AnimatePresence>
    </AppFrame>
  );
}

/* ———————————————————————————— About an agent ———————————————————————————— */

const AGENT_APPS: { app: string; name: string; what: string; policy: string }[] = [
  { app: "stripe", name: "Stripe", what: "Read customers and invoices", policy: "Allow" },
  { app: "gmail", name: "Gmail", what: "Draft emails for you to send", policy: "Allow" },
  { app: "slack", name: "Slack", what: "Post to #renewals", policy: "Ask" },
];

/**
 * Who an agent is, from its own thread (Revision 2): its role, its standing
 * work, the apps it uses and what each may do (the same Allow, Ask, Off as
 * Customize), its look and Pause. A right-hand sheet on the material, a
 * bottom sheet on a phone; Escape closes and focus returns.
 */
function AgentSheet({ m, onClose, onAppearance }: { m: CrewRow; onClose: () => void; onAppearance: () => void }) {
  const reduced = useReduced();
  const phone = usePhone();
  const ref = React.useRef<HTMLElement | null>(null);
  useDialogFocus(ref, true, onClose);
  return (
    <>
      <motion.div className="jn-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: reduced ? R : SHEET_OUT }} transition={reduced ? R : T.fade} onClick={onClose} />
      <motion.aside
        ref={ref}
        className="jn-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`About ${m.name}`}
        initial={reduced ? { opacity: 0 } : sheetFrom(phone)}
        animate={{ x: 0, y: 0, opacity: 1 }}
        exit={reduced ? { opacity: 0, transition: R } : phone ? { y: "100%", transition: SHEET_OUT } : { opacity: 0, transition: SHEET_OUT }}
        transition={reduced ? R : SHEET_IN}
      >
        <header className="jn-sheet__head">
          <CrewMark member={face(m)} state={m.state} size={32} />
          <div className="jn-sheet__who">
            <h2 className="t-display">{m.name}</h2>
            <p className="t-meta">{m.role}, created 2 September</p>
          </div>
          <button type="button" className="jib jicon-trigger jicon-quiet jtip jn-sheet__close" aria-label="Close" data-tip="Close" data-kbd="esc" data-tip-align="end" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="jn-sheet__body">
          <section className="jn-sheet__section">
            <h3 className="jn-sheet__label">What {m.name} does</h3>
            <p className="jn-sheet__prose">Watches renewals for accounts over €10,000, checks usage before a renewal and flags the accounts worth a call.</p>
          </section>
          <section className="jn-sheet__section">
            <h3 className="jn-sheet__label">Standing work</h3>
            <div className="jn-sheet__row">
              <span className="jn-sheet__rowtext">
                Renewal check <span className="ink-3">Mondays at 9:00, next on 6 October</span>
              </span>
              <button type="button" className="jb jb--ghost jb--sm">
                Edit
              </button>
            </div>
          </section>
          <section className="jn-sheet__section">
            <h3 className="jn-sheet__label">Apps and what {m.name} may do</h3>
            {AGENT_APPS.map((a) => (
              <div key={a.app} className="jn-sheet__row">
                <AppMark id={a.app} size={20} />
                <span className="jn-sheet__rowtext">
                  {a.name} <span className="ink-3">{a.what}</span>
                </span>
                <span className="jn-sheet__policy" data-policy={a.policy.toLowerCase()}>
                  {a.policy}
                </span>
              </div>
            ))}
          </section>
          <section className="jn-sheet__section">
            <h3 className="jn-sheet__label">Appearance</h3>
            <div className="jn-sheet__row">
              <span className="jn-sheet__rowtext">Honey, felt, a flower</span>
              <button type="button" className="jb jb--secondary jb--sm" onClick={onAppearance}>
                Change
              </button>
            </div>
          </section>
        </div>
        <footer className="jn-sheet__foot">
          <button type="button" className="jb jb--link">
            Pause {m.name}
          </button>
          <p className="t-meta">Paused, {m.name} finishes nothing new and keeps everything. Standing work waits until you resume.</p>
        </footer>
      </motion.aside>
    </>
  );
}
