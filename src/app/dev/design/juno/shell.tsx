"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CrewFace } from "./crew/face";
import { crewMember } from "./crew-bridge";
import { ACCOUNT, CODE_SESSIONS, CREW, PINNED, RECENT, WORKSPACES, type CrewRow, type SessionState } from "./fixtures";
import { Icon } from "./icons";
import { R, T, useReduced } from "./motion";

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

export function Wordmark() {
  return <span className="jn-wordmark">Juno</span>;
}

/* S6: the sidebar collapses and returns (Command-Backslash or the head's button), a CSS transition on the frame's
   columns so a second press reverses it midway; the panel then takes the whole window, 8 px in. */
const FrameCtx = React.createContext<{ collapsed: boolean; toggle: () => void }>({ collapsed: false, toggle: () => {} });
export const useFrame = () => React.useContext(FrameCtx);

type SidePop = "account" | "activity" | null;

/** A sidebar popover: on the material, grown from its trigger, dismissed by Escape or a press outside. */
function SidePopover({ open, onClose, className, label, below, children }: { open: boolean; onClose: () => void; className: string; label: string; below: boolean; children: React.ReactNode }) {
  const reduced = useReduced();
  const ref = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current && t && !ref.current.contains(t) && !t.closest("[data-sidepop-trigger]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={ref}
          role="dialog"
          aria-label={label}
          className={`jn-pop jn-sidepop ${className}`}
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: below ? -4 : 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, transition: reduced ? R : T.exit }}
          transition={reduced ? R : T.base}
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

function Activity({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <SidePopover open={open} onClose={onClose} className="jn-sidepop--activity" label="Activity" below>
      <p className="jn-pop__label">Activity</p>
      {ACTIVITY.map((a) => {
        const m = CREW.find((c) => c.id === a.who) ?? CREW[0];
        return (
          <a key={a.text} href="#" className="jn-pop__row jn-pop__row--tall jn-sidepop__item">
            <span className="jn-pop__mark">
              <CrewFace member={face(m)} state="available" size={20} live={false} />
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

function AccountMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [theme, setTheme] = React.useState<"Light" | "Dark" | "System">("System");
  return (
    <SidePopover open={open} onClose={onClose} className="jn-sidepop--account" label="Account" below={false}>
      <p className="jn-sidepop__email">{ACCOUNT.email}</p>
      <button type="button" className="jn-pop__row jicon-trigger">
        <span className="jn-pop__mark jn-pop__mark--ink">
          <Icon name="settings" size={16} />
        </span>
        <span className="jn-pop__text">Settings</span>
        <kbd className="jn-pop__detail">⌘,</kbd>
      </button>
      <div className="jn-sidepop__theme" role="radiogroup" aria-label="Appearance">
        {(["Light", "Dark", "System"] as const).map((t) => (
          <button key={t} type="button" role="radio" aria-checked={theme === t} className="jn-sidepop__themeopt jicon-trigger" onClick={() => setTheme(t)}>
            <Icon name={t === "Light" ? "sun" : t === "Dark" ? "moon" : "laptop"} size={16} />
            <span>{t}</span>
          </button>
        ))}
      </div>
      <button type="button" className="jn-pop__row jicon-trigger">
        <span className="jn-pop__mark jn-pop__mark--ink">
          <Icon name="help" size={16} />
        </span>
        <span className="jn-pop__text">Help and shortcuts</span>
      </button>
      <div className="jn-pop__sep" />
      <button type="button" className="jn-pop__row jicon-trigger">
        <span className="jn-pop__mark jn-pop__mark--ink">
          <Icon name="sign-out" size={16} />
        </span>
        <span className="jn-pop__text">Sign out</span>
      </button>
    </SidePopover>
  );
}

function SideHead({ pop, setPop }: { pop: SidePop; setPop: (p: SidePop) => void }) {
  const { toggle } = useFrame();
  return (
    <div className="jn-side__head">
      <Wordmark />
      <span className="jn-side__headtools">
        {/* S10: unseen records turn the bell's glyph solid. No dot, no count. */}
        <button
          type="button"
          className="jib jib--sm jicon-trigger"
          aria-label="Activity, 2 unseen"
          aria-expanded={pop === "activity"}
          data-sidepop-trigger=""
          onClick={() => setPop(pop === "activity" ? null : "activity")}
        >
          <Icon name="bell" size={16} state={pop === "activity" ? "rest" : "active"} />
        </button>
        <button type="button" className="jib jib--sm jicon-trigger" aria-label="Hide sidebar" aria-keyshortcuts="Meta+Backslash" onClick={toggle}>
          <Icon name="sidebar" size={16} />
        </button>
      </span>
    </div>
  );
}

function WorkspaceSwitch({ active }: { active: "chat" | "code" }) {
  return (
    <div className="jseg jn-side__switch" role="tablist" aria-label="Workspace">
      <button type="button" role="tab" aria-selected={active === "chat"} className="jseg__opt">
        Chat
      </button>
      <button type="button" role="tab" aria-selected={active === "code"} className="jseg__opt">
        Code
      </button>
    </div>
  );
}

function NavRow({ icon, label, kbd, current }: { icon: string; label: string; kbd?: string; current?: boolean }) {
  return (
    <a href="#" className="jrow jicon-trigger jn-side__nav" aria-current={current ? "page" : undefined}>
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

export function CrewRowItem({ m, current, now }: { m: CrewRow; current?: boolean; now?: string }) {
  return (
    <a href="#" className="jrow jn-side__crew" aria-current={current ? "page" : undefined}>
      <span className="jn-side__lead">
        <CrewFace member={face(m)} state={m.state} size={20} live={false} />
      </span>
      <span className="jn-side__crewname">{m.name}</span>
      <span className="jrow__text jn-side__crewnow">{now ?? m.now}</span>
    </a>
  );
}

function Account({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="jrow jicon-trigger jn-side__account"
      aria-label={`${ACCOUNT.name}, ${ACCOUNT.plan} plan. Account menu`}
      aria-expanded={open}
      data-sidepop-trigger=""
      onClick={onToggle}
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
  const [pop, setPop] = React.useState<SidePop>(initial ?? null);
  const close = React.useCallback(() => setPop(null), []);
  return { pop, setPop, close };
}

export function ChatSidebar({ current, crewCurrent, pop: initialPop }: { current?: "thread" | "library" | "customize" | "crew"; crewCurrent?: string; pop?: SidePop }) {
  const mira = CREW[0];
  const { pop, setPop, close } = useSidePop(initialPop);
  return (
    <nav className="jn-side" aria-label="Juno">
      <SideHead pop={pop} setPop={setPop} />
      <Activity open={pop === "activity"} onClose={close} />
      <WorkspaceSwitch active="chat" />
      <div className="jn-side__nav-group">
        <NavRow icon="new-chat" label="New chat" kbd="⌘N" />
        <NavRow icon="search" label="Search" kbd="⌘K" />
        <NavRow icon="folder" label="Projects" />
        <NavRow icon="library" label="Library" current={current === "library"} />
        <NavRow icon="customize" label="Customize" current={current === "customize"} />
      </div>
      <div className="jn-side__scroll">
        <Section label="Needs you">
          <a href="#" className="jrow jn-side__need">
            <span className="jn-side__lead">
              <CrewFace member={face(mira)} state="waiting" size={20} live={false} />
            </span>
            <span className="jrow__text">
              Mira <span className="jn-attn">wants your answer</span>
            </span>
          </a>
        </Section>
        <Section
          label="Crew"
          action={
            <button type="button" className="jib jib--sm jicon-trigger jn-side__labelbtn" aria-label="Add to crew">
              <Icon name="plus" size={16} />
            </button>
          }
        >
          {CREW.slice(0, 4).map((m) => (
            <CrewRowItem key={m.id} m={m} current={crewCurrent === m.id} now={m.state === "waiting" ? "Waiting on you" : undefined} />
          ))}
        </Section>
        <Section label="Pinned">
          {PINNED.map((p) => (
            <a key={p} href="#" className="jrow jrow--text">
              <span className="jrow__text">{p}</span>
            </a>
          ))}
        </Section>
        <Section label="Recent">
          {RECENT.slice(0, 6).map((r, i) => (
            <a key={r} href="#" className="jrow jrow--text" aria-current={current === "thread" && i === 0 ? "page" : undefined}>
              <span className="jrow__text">{r}</span>
            </a>
          ))}
        </Section>
      </div>
      <AccountMenu open={pop === "account"} onClose={close} />
      <Account open={pop === "account"} onToggle={() => setPop(pop === "account" ? null : "account")} />
    </nav>
  );
}

const SESSION_GLYPH: Record<SessionState, string> = {
  working: "progress",
  waiting: "hand",
  done: "check",
  failed: "alert",
};

export function CodeSidebar({ current = 0 }: { current?: number }) {
  const { pop, setPop, close } = useSidePop();
  return (
    <nav className="jn-side jn-side--code" aria-label="Juno Code">
      <SideHead pop={pop} setPop={setPop} />
      <Activity open={pop === "activity"} onClose={close} />
      <WorkspaceSwitch active="code" />
      <div className="jn-side__nav-group">
        <NavRow icon="new-chat" label="New session" kbd="⌘N" />
        <NavRow icon="search" label="Search" kbd="⌘K" />
        <NavRow icon="customize" label="Customize" />
      </div>
      <div className="jn-side__scroll">
        <Section label="Needs you">
          <a href="#" className="jrow jn-side__need">
            <span className="jn-side__lead jn-side__glyph" data-state="waiting">
              <Icon name="hand" size={16} />
            </span>
            <span className="jrow__text">
              Postgres index <span className="jn-attn">wants approval</span>
            </span>
          </a>
        </Section>
        <Section label="Sessions">
          {CODE_SESSIONS.map((s, i) => (
            <a key={s.title} href="#" className="jrow jn-side__session" aria-current={i === current ? "page" : undefined}>
              <span className="jn-side__lead jn-side__glyph" data-state={s.state === "waiting" ? "waiting-quiet" : s.state}>
                <Icon name={SESSION_GLYPH[s.state]} size={16} state={s.state === "working" ? "active" : "rest"} value={s.state === "working" ? 0.62 : undefined} />
              </span>
              <span className="jrow__text">{s.title}</span>
              {s.where === "This Mac" ? null : <span className="jn-side__sessionwhere">{s.where}</span>}
            </a>
          ))}
        </Section>
        <Section label="Workspaces">
          {WORKSPACES.map((w) => (
            <a key={w.name} href="#" className="jrow">
              <span className="jn-side__lead">
                <Icon name={w.kind === "cloud" ? "cloud" : "laptop"} size={16} />
              </span>
              <span className="jrow__text">{w.name}</span>
            </a>
          ))}
        </Section>
      </div>
      <AccountMenu open={pop === "account"} onClose={close} />
      <Account open={pop === "account"} onToggle={() => setPop(pop === "account" ? null : "account")} />
    </nav>
  );
}

/* The frame: the sidebar on the window, the content in an inset panel that scrolls on its own. At phone width the sidebar leaves and the panel goes full bleed. */
export function AppFrame({ sidebar, children, className, collapsed: initialCollapsed = false }: { sidebar: React.ReactNode; children: React.ReactNode; className?: string; collapsed?: boolean }) {
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
        <div className="jn-frame__side" inert={collapsed}>
          {sidebar}
        </div>
        <main className="jn-main">{children}</main>
        {/* The way back: one button where the sidebar's own button was, on the frame's top-left. */}
        <button type="button" className="jib jib--sm jicon-trigger jn-reveal" aria-label="Show sidebar" aria-keyshortcuts="Meta+Backslash" tabIndex={collapsed ? 0 : -1} aria-hidden={!collapsed} onClick={toggle}>
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

export function MobileBar({ title, back }: { title?: string; back?: boolean }) {
  return (
    <div className="jn-mbar">
      <button type="button" className="jib jicon-trigger" aria-label={back ? "Back" : "Open sidebar"}>
        <Icon name={back ? "chevron-left" : "menu"} size={20} />
      </button>
      <span className="jn-mbar__title">{title ?? <Wordmark />}</span>
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
        <button type="button" className="jn-top__title jicon-trigger">
          <span>{title}</span>
          <Icon name="chevron-down" size={16} />
        </button>
      ) : (
        <span />
      )}
      <span className="jn-top__actions">
        {children ?? (
          <>
            <button type="button" className="jib jicon-trigger" aria-label="Share">
              <Icon name="share" size={20} />
            </button>
            <button type="button" className="jib jicon-trigger" aria-label="More">
              <Icon name="more" size={20} />
            </button>
          </>
        )}
      </span>
    </header>
  );
}
