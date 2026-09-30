"use client";

import * as React from "react";
import { CrewFace } from "./crew/face";
import { ACCOUNT, CODE_SESSIONS, CREW, RECENT, WORKSPACES, type CrewRow, type SessionState } from "./fixtures";
import { Icon } from "./icons";

/*
 * The shell in the Refoundation IA (§4.1, §4.2). Rules:
 *   - The sidebar is one whisper of tone below the content, with no rule line.
 *   - Rows are 32px, one line, 14px; icons in the third ink, 16px.
 *   - Sections are separated by space and a small label, never by lines.
 *   - Crew rows are face, name and one line of "now" in the third ink. State
 *     lives in the face; there is no pill, badge or dot anywhere.
 */

export const face = (m: CrewRow) => ({ id: m.id, name: m.name, role: m.role, seed: m.seed });

export function Wordmark() {
  return <span className="jn-wordmark">Juno</span>;
}

function SideHead() {
  return (
    <div className="jn-side__head">
      <Wordmark />
      <span className="jn-side__headtools">
        <button type="button" className="jib jib--sm jicon-trigger" aria-label="Activity">
          <Icon name="bell" size={16} />
        </button>
        <button type="button" className="jib jib--sm jicon-trigger" aria-label="Hide sidebar">
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
      <Icon name={icon} size={16} />
      <span className="jrow__text">{label}</span>
      {kbd ? <span className="jn-side__kbd">{kbd}</span> : null}
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

export function CrewRowItem({ m, current }: { m: CrewRow; current?: boolean }) {
  return (
    <a href="#" className="jrow jn-side__crew" aria-current={current ? "page" : undefined}>
      <span className="jrow__lead">
        <CrewFace member={face(m)} state={m.state} size={20} />
      </span>
      <span className="jn-side__crewname">{m.name}</span>
      <span className="jrow__text jn-side__crewnow">{m.now}</span>
    </a>
  );
}

function Account() {
  return (
    <button type="button" className="jrow jn-side__account">
      <span className="jn-avatar" aria-hidden="true">
        {ACCOUNT.initials}
      </span>
      <span className="jrow__text">{ACCOUNT.name}</span>
      <span className="jrow__meta">{ACCOUNT.plan}</span>
    </button>
  );
}

export function ChatSidebar({ current, crewCurrent }: { current?: "thread" | "library" | "customize" | "crew"; crewCurrent?: string }) {
  const mira = CREW[0];
  return (
    <nav className="jn-side" aria-label="Juno">
      <SideHead />
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
            <span className="jrow__lead">
              <CrewFace member={face(mira)} state="waiting" size={20} />
            </span>
            <span className="jrow__text">
              <span className="jn-side__needwho">Mira</span> asks which Halvorsen account
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
            <CrewRowItem key={m.id} m={m} current={crewCurrent === m.id || (current === "crew" && !crewCurrent && false)} />
          ))}
        </Section>
        <Section label="Recent">
          {RECENT.slice(0, 6).map((r, i) => (
            <a key={r} href="#" className="jrow" aria-current={current === "thread" && i === 0 ? "page" : undefined}>
              <span className="jrow__text">{r}</span>
            </a>
          ))}
        </Section>
      </div>
      <Account />
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
  return (
    <nav className="jn-side jn-side--code" aria-label="Juno Code">
      <SideHead />
      <WorkspaceSwitch active="code" />
      <div className="jn-side__nav-group">
        <NavRow icon="new-chat" label="New session" kbd="⌘N" />
        <NavRow icon="search" label="Search" kbd="⌘K" />
        <NavRow icon="customize" label="Customize" />
      </div>
      <div className="jn-side__scroll">
        <Section label="Needs you">
          <a href="#" className="jrow jn-side__need">
            <span className="jrow__lead jn-side__glyph" data-state="waiting">
              <Icon name="hand" size={16} />
            </span>
            <span className="jrow__text">Approve the migration plan</span>
          </a>
        </Section>
        <Section label="Sessions">
          {CODE_SESSIONS.map((s, i) => (
            <a key={s.title} href="#" className="jrow jn-side__session" aria-current={i === current ? "page" : undefined}>
              <span className="jrow__lead jn-side__glyph" data-state={s.state}>
                <Icon name={SESSION_GLYPH[s.state]} size={16} state={s.state === "working" ? "active" : "rest"} />
              </span>
              <span className="jrow__text">{s.title}</span>
              <span className="jrow__meta">{s.where === "This Mac" ? "" : s.where}</span>
            </a>
          ))}
        </Section>
        <Section label="Workspaces">
          {WORKSPACES.map((w) => (
            <a key={w.name} href="#" className="jrow">
              <Icon name={w.kind === "cloud" ? "cloud" : "laptop"} size={16} />
              <span className="jrow__text">{w.name}</span>
            </a>
          ))}
        </Section>
      </div>
      <Account />
    </nav>
  );
}

/* The frame: sidebar and content. At phone width the sidebar leaves and a bar takes its place. */
export function AppFrame({ sidebar, children, className }: { sidebar: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={className ? `jn-frame ${className}` : "jn-frame"}>
      {sidebar}
      <main className="jn-main">{children}</main>
    </div>
  );
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
