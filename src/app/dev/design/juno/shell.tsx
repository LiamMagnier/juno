"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewMark, crewMember } from "./crew-bridge";
import { ACCOUNT, CODE_SESSIONS, CREW, PINNED, RECENT, SIDE_CREW, SIDE_STATE, STATUS_FACE, WORKSPACES, type AgentStatus, type CrewRow, type SessionState } from "./fixtures";
import { AlevrLogo, CodeGlyph, OrbitGlyph, ThinkingMark } from "./brand";
import { BRAND, FEATURE_NAMES } from "@/lib/brand/names";
import { Icon } from "./icons";
import { fromKeyboard, usePopoverKeys } from "./layers";
import { POP_IN, R, T, useReduced } from "./motion";

/*
 * The shell in the Refoundation IA (§4.1, §4.2), on the framed layout (D-033):
 * the sidebar sits on the window frame, the content is an inset panel.
 *   - Rows are 32 px, 14 px text in the second ink; the current row and hover
 *     bring the first ink. Icons 16 px in a 20 px lead slot, so icons and crew
 *     faces share one column and every label starts on the same edge.
 *   - Sections are separated by space and a small label, never by lines.
 *   - Crew rows are face, name and one line of "now" in the third ink. The
 *     attention colour appears once, in Needs you; there is no pill, badge or
 *     dot anywhere.
 */

/** A roster row as the character system sees it (the stored look when the member has one). */
export const face = (m: CrewRow) => crewMember(m);

/** The application lockup in the sidebar's head: the Continuum and "Alevr" (D-037). */
export function Wordmark({ size = 19 }: { size?: number }) {
  return <AlevrLogo size={size} className="jn-wordmark" />;
}

/* S6: the sidebar collapses and returns (Command-Backslash or the head's button), a CSS transition on the frame's
   columns so a second press reverses it midway; the panel then takes the whole window, 8 px in. */
const FrameCtx = React.createContext<{ collapsed: boolean; toggle: () => void }>({ collapsed: false, toggle: () => {} });
export const useFrame = () => React.useContext(FrameCtx);

type SidePop = "account" | "activity" | null;

/**
 * A sidebar popover: on the material, grown from its trigger, dismissed by Escape or a press outside.
 * Opened from the keyboard it appears in the same frame (F0) and focus moves to its first item;
 * Escape returns focus to the trigger.
 */
function SidePopover({
  open,
  onClose,
  className,
  label,
  below,
  kbd,
  children,
}: {
  open: boolean;
  onClose: () => void;
  className: string;
  label: string;
  below: boolean;
  kbd?: boolean;
  children: React.ReactNode;
}) {
  const reduced = useReduced();
  const ref = React.useRef<HTMLDivElement | null>(null);
  usePopoverKeys(ref, open, onClose, kbd, "[data-sidepop-trigger]");
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label={label}
          className={`jn-pop jn-sidepop ${className}`}
          data-opened-by={kbd ? "keyboard" : "pointer"}
          initial={kbd ? false : reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: below ? -4 : 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, transition: reduced ? R : T.exit }}
          transition={reduced ? R : POP_IN}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

const ACTIVITY = [
  { who: "otto", text: "Otto finished reconciling August invoices", when: "2 h" },
  { who: "scout", text: "Scout shared the Q3 forecast review", when: "Yesterday" },
  { who: "rhea", text: "Rhea closed 14 escalations", when: "Monday" },
];

function Activity({ open, onClose, kbd }: { open: boolean; onClose: () => void; kbd?: boolean }) {
  return (
    <SidePopover open={open} onClose={onClose} className="jn-sidepop--activity" label="Activity" below kbd={kbd}>
      <p className="jn-pop__label">Activity</p>
      {ACTIVITY.map((a) => {
        const m = CREW.find((c) => c.id === a.who) ?? CREW[0];
        return (
          <a key={a.text} href="#" className="jn-pop__row jn-pop__row--tall jn-sidepop__item">
            <span className="jn-pop__mark">
              <CrewMark member={face(m)} state="available" size={20} />
            </span>
            <span className="jn-pop__stack">
              <span className="jn-sidepop__text">{a.text}</span>
              <span className="jn-pop__line">{a.when}</span>
            </span>
          </a>
        );
      })}
      <div className="jn-pop__sep" />
      <button type="button" className="jn-pop__row">
        <span className="jn-pop__text">See all activity</span>
      </button>
    </SidePopover>
  );
}

function AccountMenu({ open, onClose, kbd }: { open: boolean; onClose: () => void; kbd?: boolean }) {
  const [theme, setTheme] = React.useState<"Light" | "Dark" | "System">("System");
  return (
    <SidePopover open={open} onClose={onClose} className="jn-sidepop--account" label="Account" below={false} kbd={kbd}>
      <p className="jn-sidepop__email">{ACCOUNT.email}</p>
      <button type="button" className="jn-pop__row jicon-trigger jicon-quiet">
        <span className="jn-pop__mark jn-pop__mark--ink">
          <Icon name="settings" size={16} />
        </span>
        <span className="jn-pop__text">Settings</span>
        <kbd className="jn-pop__detail">⌘,</kbd>
      </button>
      <div className="jn-sidepop__theme" role="radiogroup" aria-label="Appearance">
        {(["Light", "Dark", "System"] as const).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={theme === t} className="jn-sidepop__themeopt jicon-trigger jicon-quiet" onClick={() => setTheme(t)}>
            <Icon name={t === "Light" ? "sun" : t === "Dark" ? "moon" : "contrast"} size={16} />
            <span>{t}</span>
          </button>
        ))}
      </div>
      <button type="button" className="jn-pop__row jicon-trigger jicon-quiet">
        <span className="jn-pop__mark jn-pop__mark--ink">
          <Icon name="help" size={16} />
        </span>
        <span className="jn-pop__text">Help and shortcuts</span>
      </button>
      <div className="jn-pop__sep" />
      <button type="button" className="jn-pop__row jicon-trigger jicon-quiet">
        <span className="jn-pop__mark jn-pop__mark--ink">
          <Icon name="sign-out" size={16} />
        </span>
        <span className="jn-pop__text">Sign out</span>
      </button>
    </SidePopover>
  );
}

function SideHead({ pop, setPop }: { pop: SidePop; setPop: (p: SidePop, kbd?: boolean) => void }) {
  const { toggle } = useFrame();
  return (
    <div className="jn-side__head">
      <Wordmark />
      <span className="jn-side__headtools jicon-quiet">
        {/* S10: unseen records lift the bell from the third ink to the first. No dot, no count, no fill. */}
        <button
          type="button"
          className="jib jib--sm jicon-trigger jtip"
          aria-label="Activity, 2 unseen"
          data-tip="Activity"
          data-unseen=""
          aria-expanded={pop === "activity"}
          data-sidepop-trigger=""
          onClick={(e) => setPop(pop === "activity" ? null : "activity", fromKeyboard(e))}
        >
          <Icon name="bell" size={16} />
        </button>
        <button type="button" className="jib jib--sm jicon-trigger jtip" aria-label="Hide sidebar" data-tip="Hide sidebar" data-tip-align="end" data-kbd={"⌘\\"} aria-keyshortcuts="Meta+Backslash" onClick={toggle}>
          <Icon name="sidebar" size={16} />
        </button>
      </span>
    </div>
  );
}

/** Alevr's two workspaces, each with its product glyph: Chat (the open conversation contour) and Code (brackets and a cursor). */
function WorkspaceSwitch({ active }: { active: "chat" | "code" }) {
  return (
    <div className="jseg jn-side__switch" role="tablist" aria-label="Workspace">
      <button type="button" role="tab" aria-selected={active === "chat"} className="jseg__opt">
        <span className="jn-side__switchlabel">
          <Icon name="chat" size={16} />
          Chat
        </span>
      </button>
      <button type="button" role="tab" aria-selected={active === "code"} className="jseg__opt">
        <span className="jn-side__switchlabel">
          <CodeGlyph size={16} />
          Code
        </span>
      </button>
    </div>
  );
}

/**
 * A destination row. Only the four places you go to (New chat, Projects, Library, Customize)
 * let their glyph articulate on hover (INTERACTION_SPEC I-7); every other row is quiet.
 */
function NavRow({ icon, label, kbd, current, moves = false, onSelect }: { icon: string; label: string; kbd?: string; current?: boolean; moves?: boolean; onSelect?: () => void }) {
  return (
    <a
      href="#"
      className={moves ? "jrow jicon-trigger jicon-hover jn-side__nav" : "jrow jicon-trigger jicon-quiet jn-side__nav"}
      aria-current={current ? "page" : undefined}
      aria-keyshortcuts={kbd ? kbd.replace("⌘", "Meta+") : undefined}
      onClick={(e) => {
        e.preventDefault();
        onSelect?.();
      }}
    >
      <span className="jn-side__lead">
        <Icon name={icon} size={16} />
      </span>
      <span className="jrow__text">{label}</span>
      {kbd ? <kbd className="jn-side__kbd">{kbd}</kbd> : null}
    </a>
  );
}

function Section({ label, action, children }: { label: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="jn-side__section" aria-label={label}>
      <div className="jn-side__label">
        <span>{label}</span>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * An agent's row (Alevr Orbit): its head on its disc, its name, and on the
 * right its state in words (as in the owner's frame). Ready is the rest state
 * and says nothing; "Needs your answer" is the one amber in the sidebar.
 */
export function CrewRowItem({ m, current, onSelect, quiet }: { m: CrewRow; current?: boolean; onSelect?: () => void; quiet?: boolean }) {
  const word = SIDE_STATE[m.status];
  const reduced = useReduced();
  return (
    <a
      href="#"
      onClick={(e) => {
        e.preventDefault();
        onSelect?.();
      }}
      className="jrow jn-side__crew"
      data-state={m.state}
      data-status={m.status}
      aria-current={current ? "page" : undefined}
      aria-label={`${m.name}, ${word ? word.toLowerCase() : "ready"}. ${m.long}`}
    >
      <span className="jn-side__lead">
        <CrewMark member={face(m)} state={m.state} size={20} />
      </span>
      <span className="jrow__text jn-side__crewname">{m.name}</span>
      {/* A state change cross-fades its words in place (fast); the words, not motion, carry it. */}
      <AnimatePresence mode="popLayout" initial={false}>
        {word ? (
          <motion.span
            key={word}
            className={m.status === "needs" && !quiet ? "jn-side__state jn-attn" : "jn-side__state"}
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? R : T.fast}
          >
            {word}
          </motion.span>
        ) : null}
      </AnimatePresence>
    </a>
  );
}

/**
 * The Orbit section's head: a destination (the Orbit page, "Your agents") drawn
 * as a section label with the Orbit glyph, and Create agent on the right.
 */
export function OrbitLabel({ current, onSelect }: { current?: boolean; onSelect?: () => void }) {
  return (
    <div className="jn-side__label jn-side__label--dest" data-current={current ? "" : undefined}>
      <a
        href="#"
        className="jn-side__labellink"
        aria-current={current ? "page" : undefined}
        aria-label={`${BRAND.orbit.label}, ${BRAND.orbit.description.toLowerCase()}`}
        onClick={(e) => {
          e.preventDefault();
          onSelect?.();
        }}
      >
        <OrbitGlyph size={16} className="jn-side__labelglyph" />
        <span>{BRAND.orbit.label}</span>
      </a>
      <button type="button" className="jib jib--sm jicon-trigger jicon-quiet jn-side__labelbtn jtip" aria-label={FEATURE_NAMES.createAgent.label} data-tip={FEATURE_NAMES.createAgent.label} data-tip-align="end">
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

function Account({ open, onToggle }: { open: boolean; onToggle: (kbd: boolean) => void }) {
  return (
    <button
      type="button"
      className="jrow jicon-trigger jicon-quiet jn-side__account"
      aria-label={`${ACCOUNT.name}, ${ACCOUNT.plan} plan. Account menu`}
      aria-expanded={open}
      data-sidepop-trigger=""
      onClick={(e) => onToggle(fromKeyboard(e))}
    >
      <span className="jn-avatar" aria-hidden="true">
        {ACCOUNT.initials}
      </span>
      <span className="jn-side__who">
        <span className="jn-side__whoname">{ACCOUNT.name}</span>
        <span className="jn-side__whoplan">{ACCOUNT.plan} plan</span>
      </span>
      <Icon name="chevrons-up-down" size={16} />
    </button>
  );
}

function useSidePop(initial?: SidePop) {
  const [state, setState] = React.useState<{ pop: SidePop; kbd: boolean }>({ pop: initial ?? null, kbd: false });
  const setPop = React.useCallback((pop: SidePop, kbd = false) => setState({ pop, kbd }), []);
  const close = React.useCallback(() => setState({ pop: null, kbd: false }), []);
  return { pop: state.pop, kbd: state.kbd, setPop, close };
}

/**
 * A chat row. A chat with an ask waiting says so on the right in the attention words ("Needs your
 * approval"), but never the open one: the ask is on screen, so the row stays quiet (Revision 2).
 */
function TextRow({ label, current, needs, onSelect }: { label: string; current?: boolean; needs?: boolean; onSelect?: () => void }) {
  const flag = needs && !current;
  return (
    <a
      href="#"
      className="jrow jrow--text"
      aria-current={current ? "page" : undefined}
      aria-label={flag ? `${label}, needs your approval` : undefined}
      onClick={(e) => {
        e.preventDefault();
        onSelect?.();
      }}
    >
      <span className="jrow__text">{label}</span>
      {flag ? (
        <span className="jn-side__state jn-attn" aria-hidden="true">
          Needs your approval
        </span>
      ) : null}
    </a>
  );
}

export function ChatSidebar({
  current,
  crewCurrent,
  pop: initialPop,
  threadNeeds = false,
  askOnScreen = [],
  status = {},
}: {
  current?: "thread" | "library" | "customize" | "crew";
  crewCurrent?: string;
  pop?: SidePop;
  /** The first recent chat has something waiting on the person (an approval): its row says so when it is not the open one. */
  threadNeeds?: boolean;
  /**
   * Agents whose ask is on screen right now (a task card in the open chat): their row keeps its words
   * but drops the amber, so one ask is coloured in one place (Revision 2).
   */
  askOnScreen?: string[];
  /** The agents' live state where a scene has moved it on (Mira after the person answered). */
  status?: Record<string, AgentStatus>;
}) {
  const { pop, kbd, setPop, close } = useSidePop(initialPop);
  // Navigation selection is tonal and immediate on press (the fill steps in on fast); the glyph never moves for it.
  const [here, setHere] = React.useState<string | undefined>(
    crewCurrent ? `agent:${crewCurrent}` : current === "thread" ? "recent:0" : current === "crew" ? "orbit" : current,
  );
  return (
    <nav className="jn-side" aria-label="Alevr">
      <SideHead pop={pop} setPop={setPop} />
      <Activity open={pop === "activity"} onClose={close} kbd={kbd} />
      <WorkspaceSwitch active="chat" />
      <div className="jn-side__nav-group">
        <NavRow icon="new-chat" label="New chat" kbd="⌘N" moves onSelect={() => setHere("new")} current={here === "new"} />
        <NavRow icon="search" label="Search" kbd="⌘K" />
        <NavRow icon="folder" label="Projects" moves current={here === "projects"} onSelect={() => setHere("projects")} />
        <NavRow icon="library" label="Library" current={here === "library"} moves onSelect={() => setHere("library")} />
        <NavRow icon="customize" label="Customize" current={here === "customize"} moves onSelect={() => setHere("customize")} />
      </div>
      <div className="jn-side__scroll">
        <section className="jn-side__section" aria-label="Orbit, your agents">
          <OrbitLabel current={here === "orbit"} onSelect={() => setHere("orbit")} />
          {SIDE_CREW.map((row) => {
            const st = status[row.id];
            const m = st ? { ...row, status: st, state: STATUS_FACE[st] } : row;
            return <CrewRowItem key={m.id} m={m} quiet={askOnScreen.includes(m.id)} current={here === `agent:${m.id}`} onSelect={() => setHere(`agent:${m.id}`)} />;
          })}
        </section>
        <Section label="Pinned">
          {PINNED.map((p, i) => (
            <TextRow key={p} label={p} current={here === `pinned:${i}`} onSelect={() => setHere(`pinned:${i}`)} />
          ))}
        </Section>
        <Section label="Recent">
          {RECENT.slice(0, 6).map((r, i) => (
            <TextRow key={r} label={r} current={here === `recent:${i}`} needs={threadNeeds && i === 0} onSelect={() => setHere(`recent:${i}`)} />
          ))}
        </Section>
      </div>
      <AccountMenu open={pop === "account"} onClose={close} kbd={kbd} />
      <Account open={pop === "account"} onToggle={(k) => setPop(pop === "account" ? null : "account", k)} />
    </nav>
  );
}

const SESSION_GLYPH: Record<SessionState, string> = {
  working: "progress" /* not drawn: the ThinkingMark leads a working session */,
  waiting: "hand",
  done: "check",
  failed: "alert",
};

/**
 * A Code session: its glyph, its title, and under it what it is doing in words (never a glyph alone).
 * A working session leads with the ThinkingMark, the same live mark as its transcript (Revision 2: a
 * presence-blue 30% arc read as a spinner); the rest are quiet glyphs in the third ink.
 */
function SessionRow({ s, current }: { s: (typeof CODE_SESSIONS)[number]; current?: boolean }) {
  return (
    <a href="#" className="jrow jn-side__session" data-state={s.state} aria-current={current ? "page" : undefined}>
      <span className="jn-side__lead jn-side__glyph" data-state={s.state}>
        {s.state === "working" ? <ThinkingMark size={16} /> : <Icon name={SESSION_GLYPH[s.state]} size={16} />}
      </span>
      <span className="jn-side__sessiontext">
        <span className="jn-side__sessiontitle">{s.title}</span>
        <span className={s.state === "waiting" ? "jn-side__sessionline jn-attn" : "jn-side__sessionline"}>{s.line}</span>
      </span>
    </a>
  );
}

export function CodeSidebar({ current = 0 }: { current?: number }) {
  const { pop, kbd, setPop, close } = useSidePop();
  return (
    <nav className="jn-side jn-side--code" aria-label="Alevr Code">
      <SideHead pop={pop} setPop={setPop} />
      <Activity open={pop === "activity"} onClose={close} kbd={kbd} />
      <WorkspaceSwitch active="code" />
      <div className="jn-side__nav-group">
        <NavRow icon="plus" label="New session" kbd="⌘N" moves />
        <NavRow icon="search" label="Search" kbd="⌘K" />
        <NavRow icon="customize" label="Customize" moves />
      </div>
      <div className="jn-side__scroll">
        <Section label="Sessions">
          {CODE_SESSIONS.map((s, i) => (
            <SessionRow key={s.title} s={s} current={i === current} />
          ))}
        </Section>
        <Section label="Workspaces">
          {WORKSPACES.map((w) => (
            <a key={w.name} href="#" className="jrow jicon-quiet jn-side__ws">
              <span className="jn-side__lead">
                <Icon name={w.kind === "cloud" ? "cloud" : w.kind === "desktop" ? "computer" : "laptop"} size={16} />
              </span>
              <span className="jrow__text">{w.name}</span>
              <span className="jn-side__state">{w.state}</span>
            </a>
          ))}
        </Section>
      </div>
      <AccountMenu open={pop === "account"} onClose={close} kbd={kbd} />
      <Account open={pop === "account"} onToggle={(k) => setPop(pop === "account" ? null : "account", k)} />
    </nav>
  );
}

/* The frame: the sidebar on the window, the content in an inset panel that scrolls on its own. At phone width the sidebar leaves and the panel goes full bleed. */
export function AppFrame({
  sidebar,
  children,
  className,
  collapsed: initialCollapsed = false,
  skip = { href: "#jn-main", label: "Skip to content" },
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  collapsed?: boolean;
  /** The skip link: the first stop in the frame, to the message field where there is one, else the content. */
  skip?: { href: string; label: string };
}) {
  const [collapsed, setCollapsed] = React.useState(initialCollapsed);
  const toggle = React.useCallback(() => setCollapsed((c) => !c), []);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setCollapsed((c) => !c);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const ctx = React.useMemo(() => ({ collapsed, toggle }), [collapsed, toggle]);
  return (
    <FrameCtx.Provider value={ctx}>
      <div className={className ? `jn-frame ${className}` : "jn-frame"} data-collapsed={collapsed ? "" : undefined}>
        <a className="jn-skip" href={skip.href}>
          {skip.label}
        </a>
        <div className="jn-frame__side" inert={collapsed}>
          {sidebar}
        </div>
        <main className="jn-main" id="jn-main" tabIndex={-1}>
          {children}
        </main>
        {/* The way back: one button where the sidebar's own button was, on the frame's top-left. */}
        <button
          type="button"
          className="jib jib--sm jicon-trigger jicon-quiet jtip jn-reveal"
          aria-label="Show sidebar"
          data-tip="Show sidebar"
          data-kbd={"⌘\\"}
          data-tip-align="start"
          aria-keyshortcuts="Meta+Backslash"
          tabIndex={collapsed ? 0 : -1}
          aria-hidden={!collapsed}
          onClick={toggle}
        >
          <Icon name="sidebar" size={16} />
        </button>
      </div>
    </FrameCtx.Provider>
  );
}

/** The panel that scrolls (the framed shell's main area), found from any element inside it. */
export function panelOf(el?: Element | null): HTMLElement | null {
  return ((el?.closest(".jn-main") as HTMLElement | null) ?? (document.querySelector(".jn-main") as HTMLElement | null)) || null;
}

/** Keep a scene's panel scrolled to its newest content while it settles (stills open on the latest turn). */
export function usePanelAtEnd(enabled: boolean) {
  React.useEffect(() => {
    if (!enabled) return;
    const go = () => {
      const p = panelOf();
      if (p) p.scrollTop = p.scrollHeight;
    };
    go();
    const ts = [150, 400, 900, 1500, 2200].map((ms) => window.setTimeout(go, ms));
    return () => ts.forEach((t) => window.clearTimeout(t));
  }, [enabled]);
}

/**
 * The phone's bar, on the bar material. On pages with a large title (Library,
 * Customize, Crew) the bar is empty at rest and the title collapses into it
 * once the large one scrolls under the bar (an IntersectionObserver, no
 * scroll listener), so a title is never shown twice.
 */
export function MobileBar({ title, back, collapse = false }: { title?: string; back?: boolean; collapse?: boolean }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = React.useState(!collapse);
  React.useEffect(() => {
    if (!collapse) return;
    const root = panelOf(ref.current);
    const big = root?.querySelector(".jn-page__head .t-title, .jn-page__head h1");
    if (!root || !big) return;
    const io = new IntersectionObserver(([e]) => setShown(!e.isIntersecting), { root, rootMargin: "-52px 0px 0px 0px", threshold: 0 });
    io.observe(big);
    return () => io.disconnect();
  }, [collapse]);
  return (
    <div className="jn-mbar jicon-quiet" ref={ref} data-titled={shown ? "" : undefined}>
      <button type="button" className="jib jicon-trigger" aria-label={back ? "Back" : "Open sidebar"}>
        <Icon name={back ? "chevron-left" : "menu"} size={20} />
      </button>
      <span className="jn-mbar__title" aria-hidden={!shown}>
        {title ?? <Wordmark />}
      </span>
      <button type="button" className="jib jicon-trigger" aria-label="New chat">
        <Icon name="new-chat" size={20} />
      </button>
    </div>
  );
}

/** A transient confirmation with at most one verb (on the toast material). */
export function Toast({ icon = "check", children, verb, onVerb }: { icon?: string; children: React.ReactNode; verb?: string; onVerb?: () => void }) {
  return (
    <div className="jn-toast" role="status">
      <Icon name={icon} size={16} state="active" />
      <span>{children}</span>
      {verb ? (
        <button type="button" className="jn-toast__verb" onClick={onVerb}>
          {verb}
        </button>
      ) : (
        <span style={{ width: 8 }} />
      )}
    </div>
  );
}

/* The content header: a title that is also a menu, and two quiet actions. */
export function TopBar({ title, children }: { title?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="jn-top">
      {title ? (
        <button type="button" className="jn-top__title jicon-trigger jicon-quiet">
          <span>{title}</span>
          <Icon name="chevron-down" size={16} />
        </button>
      ) : (
        <span />
      )}
      <span className="jn-top__actions">
        {children ?? (
          <>
            <button type="button" className="jib jicon-trigger jicon-quiet jtip" aria-label="Share" data-tip="Share">
              <Icon name="share" size={20} />
            </button>
            <button type="button" className="jib jicon-trigger jicon-quiet jtip" aria-label="More" data-tip="More" data-tip-align="end">
              <Icon name="more" size={20} />
            </button>
          </>
        )}
      </span>
    </header>
  );
}
