"use client";

import * as React from "react";
import {
  Bell,
  BookOpen,
  Check,
  Cloud,
  Folder,
  Laptop,
  Menu,
  Monitor,
  PanelLeft,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
} from "@/components/ui/icons";
import { Face } from "./face";
import { ACCOUNT, CODE_SESSIONS, CREW, RECENT } from "./fixtures";
import { Orbit, Wordmark } from "./glyphs";

/*
 * The sidebar in the new IA (PRODUCT_REFOUNDATION §4.1 and §4.2).
 *
 * Quiet by construction: single-line 32px rows, muted glyphs, labels at 12px.
 * Crew rows are a face and a name; the one trailing word appears only when a
 * member needs you. There is no separate "Needs you" block on this screen:
 * Mira's row carries it, which is the calm version of the same fact.
 */

export function Sidebar({
  mode = "chat",
  current,
  crewCount = 4,
}: {
  mode?: "chat" | "code";
  /** Which row is the current page. */
  current?: string;
  crewCount?: number;
}) {
  return (
    <aside className="pc-side" aria-label="Sidebar">
      <div className="pc-side__head">
        <Wordmark />
        <span className="flex items-center">
          <button type="button" className="pc-icon-btn pc-icon-btn--sm" aria-label="Activity">
            <Bell />
          </button>
          <button type="button" className="pc-icon-btn pc-icon-btn--sm" aria-label="Collapse sidebar">
            <PanelLeft />
          </button>
        </span>
      </div>
      <div className="pc-side__scroll">
        <div className="pc-seg-ws" role="group" aria-label="Workspace">
          <button type="button" aria-pressed={mode === "chat"}>
            Chat
          </button>
          <button type="button" aria-pressed={mode === "code"}>
            Code
          </button>
        </div>
        {mode === "chat" ? <ChatNav current={current} crewCount={crewCount} /> : <CodeNav current={current} />}
      </div>
      <div className="pc-side__foot">
        <span className="pc-avatar" aria-hidden>
          {ACCOUNT.initials}
        </span>
        <span className="pc-ui flex-1 truncate">{ACCOUNT.name}</span>
        <span className="pc-small pc-quiet">{ACCOUNT.plan}</span>
      </div>
    </aside>
  );
}

function ChatNav({ current, crewCount }: { current?: string; crewCount: number }) {
  return (
    <>
      <nav aria-label="Chat" className="flex flex-col gap-px">
        <a className="pc-row" href="#" aria-current={current === "new" ? "page" : undefined}>
          <SquarePen />
          <span className="pc-row__label">New chat</span>
          <span className="pc-row__hint">⌘N</span>
        </a>
        <a className="pc-row" href="#">
          <Search />
          <span className="pc-row__label">Search</span>
          <span className="pc-row__hint">⌘K</span>
        </a>
        <a className="pc-row" href="#">
          <Folder />
          <span className="pc-row__label">Projects</span>
        </a>
        <a className="pc-row" href="#">
          <BookOpen />
          <span className="pc-row__label">Library</span>
        </a>
        <a className="pc-row" href="#">
          <SlidersHorizontal />
          <span className="pc-row__label">Customize</span>
        </a>
      </nav>
      <div className="pc-side__label">
        <a href="#" className="hover:text-[color:var(--pc-ink)]">
          Crew
        </a>
        <button type="button" aria-label="Add to crew">
          <Plus />
        </button>
      </div>
      <nav aria-label="Crew" className="flex flex-col gap-px">
        {CREW.slice(0, crewCount).map((m) => (
          <a key={m.id} className="pc-row" href="#" aria-current={current === m.id ? "page" : undefined}>
            <Face avatar={m.avatar} presence={m.presence} size={20} />
            <span className="pc-row__label">{m.name}</span>
            {m.presence === "waiting" ? <span className="pc-needs">Needs you</span> : null}
          </a>
        ))}
      </nav>
      <div className="pc-side__label">Recent</div>
      <nav aria-label="Recent chats" className="flex flex-col gap-px">
        {RECENT.map((r) => (
          <a key={r} className="pc-row pc-row--recent" href="#" aria-current={current === r ? "page" : undefined}>
            <span className="pc-row__label">{r}</span>
          </a>
        ))}
      </nav>
    </>
  );
}

function CodeNav({ current }: { current?: string }) {
  return (
    <>
      <nav aria-label="Code" className="flex flex-col gap-px">
        <a className="pc-row" href="#" aria-current={current === "new" ? "page" : undefined}>
          <SquarePen />
          <span className="pc-row__label">New session</span>
          <span className="pc-row__hint">⌘N</span>
        </a>
        <a className="pc-row" href="#">
          <Search />
          <span className="pc-row__label">Search</span>
          <span className="pc-row__hint">⌘K</span>
        </a>
        <a className="pc-row" href="#">
          <SlidersHorizontal />
          <span className="pc-row__label">Customize</span>
        </a>
      </nav>
      <div className="pc-side__label">Sessions</div>
      <nav aria-label="Sessions" className="flex flex-col gap-px">
        {CODE_SESSIONS.map((s) => (
          <a key={s.id} className="pc-row pc-row--recent" href="#" aria-current={current === s.id ? "page" : undefined}>
            <span className="pc-row__label">{s.title}</span>
            {s.state === "running" ? (
              <Orbit state="thinking" size={14} label="Running" className="pc-quiet" />
            ) : s.state === "needs" ? (
              <span className="pc-needs">Needs you</span>
            ) : (
              <Check className="size-3.5 shrink-0 text-[color:var(--pc-ink-4)]" aria-label="Done" />
            )}
          </a>
        ))}
      </nav>
      <div className="pc-side__label">Workspaces</div>
      <nav aria-label="Workspaces" className="flex flex-col gap-px">
        <a className="pc-row pc-row--recent" href="#">
          <Laptop />
          <span className="pc-row__label">This Mac</span>
        </a>
        <a className="pc-row pc-row--recent" href="#">
          <Monitor />
          <span className="pc-row__label">Studio Mac</span>
        </a>
        <a className="pc-row pc-row--recent" href="#">
          <Cloud />
          <span className="pc-row__label">Cloud</span>
        </a>
      </nav>
    </>
  );
}

/** Phone top bar: menu, the place, new chat. */
export function MobileTop({ title }: { title?: string }) {
  return (
    <div className="pc-mtop">
      <button type="button" className="pc-icon-btn" aria-label="Open sidebar">
        <Menu />
      </button>
      {title ? <span className="pc-ui truncate px-2">{title}</span> : <Wordmark />}
      <button type="button" className="pc-icon-btn" aria-label="New chat">
        <SquarePen />
      </button>
    </div>
  );
}
