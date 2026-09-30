"use client";

import * as React from "react";
import {
  Bell,
  BookOpen,
  Check,
  ChevronsUpDown,
  Folder,
  Laptop,
  Menu,
  PanelLeft,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
  Cloud,
} from "@/components/ui/icons";
import { ACCOUNT, CODE_SESSIONS, CREW, RECENT } from "./fixtures";
import { Face } from "./face";
import { Point } from "./point";

/*
 * The sidebar in the Refoundation IA (§4.1, §4.2). Canvas's rules for it:
 * single-line rows at 32px, icons in the third ink, section labels tiny and
 * quiet, crew rows are face + name (a trailing attention word only when the
 * member needs you), and nothing is coloured except faces and that one word.
 */

export function Logo() {
  return (
    <span className="cv-logo">
      <Point size={18} />
      Juno
    </span>
  );
}

function SideHead() {
  return (
    <div className="cv-side__head">
      <Logo />
      <button type="button" className="cv-ibtn" aria-label="Activity">
        <Bell className="cv-i" />
      </button>
      <button type="button" className="cv-ibtn" aria-label="Hide sidebar">
        <PanelLeft className="cv-i" />
      </button>
    </div>
  );
}

function WorkspaceSwitch({ active }: { active: "chat" | "code" }) {
  return (
    <div className="cv-switch" role="tablist" aria-label="Workspace">
      <button type="button" role="tab" aria-selected={active === "chat"} className="cv-switch__opt">
        Chat
      </button>
      <button type="button" role="tab" aria-selected={active === "code"} className="cv-switch__opt">
        Code
      </button>
    </div>
  );
}

function Account() {
  return (
    <button type="button" className="cv-account">
      <span className="cv-avatar" aria-hidden="true">
        {ACCOUNT.initials}
      </span>
      <span className="cv-account__name">{ACCOUNT.name}</span>
      <ChevronsUpDown className="cv-i-sm ink-3" />
    </button>
  );
}

export function ChatSidebar({ current, crewCurrent }: { current?: string; crewCurrent?: boolean }) {
  return (
    <nav className="cv-side" aria-label="Chat">
      <SideHead />
      <WorkspaceSwitch active="chat" />
      <div className="cv-side__scroll">
        <div className="cv-nav">
          <a className="cv-row" href="#new" aria-current={current === "new" ? "page" : undefined}>
            <SquarePen className="cv-i" />
            <span className="cv-row__text">New chat</span>
            <span className="cv-row__hint">⌘N</span>
          </a>
          <a className="cv-row" href="#search">
            <Search className="cv-i" />
            <span className="cv-row__text">Search</span>
            <span className="cv-row__hint">⌘K</span>
          </a>
          <a className="cv-row" href="#projects">
            <Folder className="cv-i" />
            <span className="cv-row__text">Projects</span>
          </a>
          <a className="cv-row" href="#library">
            <BookOpen className="cv-i" />
            <span className="cv-row__text">Library</span>
          </a>
          <a className="cv-row" href="#customize">
            <SlidersHorizontal className="cv-i" />
            <span className="cv-row__text">Customize</span>
          </a>
        </div>

        <div className="cv-side__section">
          <div className="cv-side__label">
            <span>Crew</span>
            <button type="button" className="cv-ibtn" aria-label="Add to crew">
              <Plus className="cv-i-sm" />
            </button>
          </div>
          <div className="cv-nav">
            {CREW.slice(0, 4).map((m) => (
              <a
                key={m.id}
                className="cv-row"
                href={`#crew-${m.id}`}
                aria-current={crewCurrent && m.id === "mira" ? "page" : undefined}
              >
                <Face member={m} presence={m.presence} size={18} />
                <span className="cv-row__text">{m.name}</span>
                {m.presence === "waiting" ? <span className="cv-row__attn">Needs you</span> : null}
              </a>
            ))}
          </div>
        </div>

        <div className="cv-side__section">
          <div className="cv-side__label">
            <span>Recent</span>
          </div>
          <div className="cv-nav">
            {RECENT.map((title, i) => (
              <a
                key={title}
                className="cv-row cv-row--muted"
                href={`#chat-${i}`}
                aria-current={current === "thread" && i === 0 ? "page" : undefined}
              >
                <span className="cv-row__text">{title}</span>
              </a>
            ))}
          </div>
        </div>
      </div>
      <Account />
    </nav>
  );
}

const SESSION_GLYPH = {
  working: <Point state="working" size={14} />,
  waiting: <Point size={14} />,
  done: <Check className="cv-i-sm ink-3" />,
};

export function CodeSidebar() {
  return (
    <nav className="cv-side" aria-label="Code">
      <SideHead />
      <WorkspaceSwitch active="code" />
      <div className="cv-side__scroll">
        <div className="cv-nav">
          <a className="cv-row" href="#new">
            <SquarePen className="cv-i" />
            <span className="cv-row__text">New session</span>
            <span className="cv-row__hint">⌘N</span>
          </a>
          <a className="cv-row" href="#search">
            <Search className="cv-i" />
            <span className="cv-row__text">Search</span>
            <span className="cv-row__hint">⌘K</span>
          </a>
          <a className="cv-row" href="#customize">
            <SlidersHorizontal className="cv-i" />
            <span className="cv-row__text">Customize</span>
          </a>
        </div>
        <div className="cv-side__section">
          <div className="cv-side__label">
            <span>Today</span>
          </div>
          <div className="cv-nav">
            {CODE_SESSIONS.map((s, i) => (
              <a key={s.title} className="cv-row" href={`#s-${i}`} aria-current={i === 0 ? "page" : undefined}>
                <span className="cv-sess-glyph">{SESSION_GLYPH[s.state]}</span>
                <span className="cv-row__text">{s.title}</span>
                {s.state === "waiting" ? <span className="cv-row__attn">Needs you</span> : <span className="cv-row__meta">{s.where === "Cloud" ? "Cloud" : ""}</span>}
              </a>
            ))}
          </div>
        </div>
        <div className="cv-side__section">
          <div className="cv-side__label">
            <span>Workspaces</span>
          </div>
          <div className="cv-nav">
            <a className="cv-row cv-row--muted" href="#w1">
              <Laptop className="cv-i" />
              <span className="cv-row__text">This Mac</span>
            </a>
            <a className="cv-row cv-row--muted" href="#w2">
              <Laptop className="cv-i" />
              <span className="cv-row__text">Studio Mac</span>
            </a>
            <a className="cv-row cv-row--muted" href="#w3">
              <Cloud className="cv-i" />
              <span className="cv-row__text">Cloud, juno-web</span>
            </a>
          </div>
        </div>
      </div>
      <Account />
    </nav>
  );
}

/** The phone's bar: menu (the sidebar as a sheet), the place, new chat. */
export function MobileBar({ title, thread = false, clear = false }: { title?: string; thread?: boolean; clear?: boolean }) {
  return (
    <header className="cv-mbar" data-clear={clear ? "" : undefined}>
      <button type="button" className="cv-ibtn" aria-label="Menu">
        <Menu className="cv-i" />
      </button>
      <span className={thread ? "cv-mbar__title cv-mbar__title--thread" : "cv-mbar__title"}>{title ?? "Juno"}</span>
      <button type="button" className="cv-ibtn" aria-label="New chat">
        <SquarePen className="cv-i" />
      </button>
    </header>
  );
}

export function AppFrame({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="cv-app">
      {sidebar}
      <main className="cv-main">{children}</main>
    </div>
  );
}

