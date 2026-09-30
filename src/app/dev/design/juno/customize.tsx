"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { APP_ORDER_AVAILABLE, APP_ORDER_CONNECTED, APPS, POLICY_LABEL, type Policy } from "./fixtures";
import { Icon } from "./icons";
import { AppMark } from "./marks";
import { Segmented } from "./composer";
import { R, T, useReduced } from "./motion";
import { AppFrame, ChatSidebar, MobileBar } from "./shell";

/*
 * Customize › Apps. A directory that reads as a list of the services Juno can
 * act in: connected first (with when each was last used), then the rest. An
 * app's sheet says, per action, whether Juno may do it, asks first or never
 * does, in the three words Allow, Ask, Off; reads are a plain on/off.
 */

const SUBNAV = [
  { id: "apps", label: "Apps", icon: "app" },
  { id: "skills", label: "Skills", icon: "skill" },
  { id: "routines", label: "Routines", icon: "routine" },
  { id: "memory", label: "Memory", icon: "memory" },
  { id: "instructions", label: "Instructions", icon: "instructions" },
];

const POLICIES = ["allow", "ask", "off"] as const;

/* Allow, Ask, Off (K4): a small segmented whose thumb moves on the standard spring. */
export function PolicyControl({ value, label }: { value: Policy; label: string }) {
  const [v, setV] = React.useState<Policy>(value);
  return <Segmented options={POLICIES} value={v} onChange={setV} label={label} size="sm" layoutKey={`policy-${label}`} labels={POLICY_LABEL} />;
}

function Switch({ on: initial }: { on: boolean }) {
  const [on, setOn] = React.useState(initial);
  return <button type="button" role="switch" aria-checked={on} className="jswitch" onClick={() => setOn((o) => !o)} aria-label={on ? "On" : "Off"} />;
}

export function AppSheet({ id, onClose }: { id: string; onClose?: () => void }) {
  const reduced = useReduced();
  const app = APPS[id];
  const reads = app.actions.filter((a) => a.kind === "read");
  const changes = app.actions.filter((a) => a.kind === "change");
  return (
    <>
      <motion.div className="jn-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? R : T.fade} onClick={onClose} />
      <motion.aside
        className="jn-sheet"
        role="dialog"
        aria-label={`${app.name} settings`}
        initial={reduced ? { opacity: 0 } : { x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={reduced ? { opacity: 0 } : { x: 40, opacity: 0 }}
        transition={reduced ? R : T.sheet}
      >
        <header className="jn-sheet__head">
          <AppMark id={id} size={32} />
          <div className="jn-sheet__who">
            <h2 className="t-display">{app.name}</h2>
            <p className="t-meta">Connected {app.id === "slack" ? "since 3 June" : "this month"}</p>
          </div>
          <button type="button" className="jib jicon-trigger jn-sheet__close" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </header>
        <div className="jn-sheet__body">
          <section className="jn-sheet__section">
            <h3 className="jn-sheet__label">Account</h3>
            <div className="jn-sheet__row">
              <span className="jn-sheet__rowtext">{app.account}</span>
              <button type="button" className="jb jb--ghost jb--sm">
                Switch
              </button>
            </div>
          </section>
          <section className="jn-sheet__section">
            <h3 className="jn-sheet__label">What Juno can read</h3>
            {reads.map((a) => (
              <div key={a.label} className="jn-sheet__row">
                <span className="jn-sheet__rowtext">{a.label}</span>
                <Switch on={a.policy !== "off"} />
              </div>
            ))}
          </section>
          <section className="jn-sheet__section">
            <h3 className="jn-sheet__label">What Juno can change</h3>
            <p className="jn-sheet__hint">Allow runs without asking. Ask shows you the exact message first. Off never happens.</p>
            {changes.map((a) => (
              <div key={a.label} className="jn-sheet__row">
                <span className="jn-sheet__rowtext">{a.label}</span>
                {a.floor ? <span className="jn-sheet__floor">Always asks</span> : <PolicyControl value={a.policy} label={a.label} />}
              </div>
            ))}
          </section>
          <section className="jn-sheet__section">
            <h3 className="jn-sheet__label">Last used</h3>
            <div className="jn-sheet__row">
              <span className="jn-sheet__rowtext">
                Today at 14:02, posting to #design in <a href="#" className="jn-inlink">Q3 forecast against Stripe revenue</a>
              </span>
            </div>
          </section>
        </div>
        <footer className="jn-sheet__foot">
          <button type="button" className="jb jb--link jn-sheet__disconnect">
            Disconnect {app.name}
          </button>
          <p className="t-meta">Juno loses access at once. Mira’s renewal check stops posting. Nothing in {app.name} is deleted.</p>
        </footer>
      </motion.aside>
    </>
  );
}

function AppRow({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const app = APPS[id];
  return (
    <li>
      <button type="button" className="jn-approw jicon-trigger" onClick={() => onOpen(id)}>
        <span className="jn-approw__mark">
          <AppMark id={id} size={22} />
        </span>
        <span className="jn-approw__text">
          <span className="jn-approw__name">{app.name}</span>
          <span className="jn-approw__line">{app.line}</span>
        </span>
        {app.connected ? (
          <>
            <span className="jn-approw__status">Connected</span>
            <Icon name="chevron-right" size={16} className="ink-3" />
          </>
        ) : (
          <span className="jb jb--secondary jb--sm">Connect</span>
        )}
      </button>
    </li>
  );
}

export function CustomizeScene({ app }: { app?: string }) {
  const [open, setOpen] = React.useState<string | null>(app && APPS[app] ? app : null);
  return (
    <AppFrame sidebar={<ChatSidebar current="customize" />}>
      <MobileBar title="Apps" />
      <div className="jn-page jn-page--customize">
        <nav className="jn-subnav" aria-label="Customize">
          <p className="jn-subnav__title">Customize</p>
          {SUBNAV.map((s) => (
            <a key={s.id} href="#" className="jrow jicon-trigger" aria-current={s.id === "apps" ? "page" : undefined}>
              <Icon name={s.icon} size={16} />
              <span className="jrow__text">{s.label}</span>
            </a>
          ))}
        </nav>
        <div className="jn-custom">
          <header className="jn-page__head">
            <div>
              <h1 className="t-title">Apps</h1>
              <p className="jn-page__lede">The services Juno can work in. You decide what each one may do.</p>
            </div>
            <button type="button" className="jb jb--secondary jicon-trigger">
              <Icon name="plus" size={16} />
              Add a custom app
            </button>
          </header>
          <label className="jfield jn-custom__search">
            <Icon name="search" size={16} />
            <input placeholder="Search apps" aria-label="Search apps" />
          </label>
          <section className="jn-custom__group" aria-label="Connected">
            <h2 className="jn-custom__label">
              Connected <span className="num">{APP_ORDER_CONNECTED.length}</span>
            </h2>
            <ul className="jn-applist">
              {APP_ORDER_CONNECTED.map((id) => (
                <AppRow key={id} id={id} onOpen={setOpen} />
              ))}
            </ul>
          </section>
          <section className="jn-custom__group" aria-label="More apps">
            <h2 className="jn-custom__label">More apps</h2>
            <ul className="jn-applist">
              {APP_ORDER_AVAILABLE.map((id) => (
                <AppRow key={id} id={id} onOpen={setOpen} />
              ))}
            </ul>
          </section>
        </div>
      </div>
      <AnimatePresence>{open ? <AppSheet key={open} id={open} onClose={() => setOpen(null)} /> : null}</AnimatePresence>
    </AppFrame>
  );
}
