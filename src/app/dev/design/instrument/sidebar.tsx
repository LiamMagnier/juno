"use client";

import * as React from "react";
import {
  Bell,
  ChevronsUpDown,
  Cloud,
  Folder,
  JunoLibrary,
  Laptop,
  MessageCircleQuestion,
  PanelLeftClose,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
} from "@/components/ui/icons";
import type { IconComponent } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { Face } from "./face";
import { ACCOUNT, CODE_SESSIONS, CREW, RECENT } from "./fixtures";
import { Lens, Wordmark } from "./lens";
import { Initials } from "./marks";

/*
 * The sidebar in the Refoundation IA (PRODUCT_REFOUNDATION §4.1 / §4.2).
 * Single-line 30px rows, muted 16px glyphs, section labels in the small
 * label rung. A crew row is the face and the name; the only trailing word is
 * the amber "Needs you" on a member who is waiting. There is no separate
 * Needs you fold while the only thing waiting is a crew member: it would list
 * Mira twice.
 */

export type ChatPlace = "home" | "thread" | "crew" | "none";

function NavRow({ icon: Icon, label, hint, selected }: { icon: IconComponent; label: string; hint?: string; selected?: boolean }) {
  return (
    <button type="button" className="in-row" data-selected={selected ? "" : undefined} aria-current={selected ? "page" : undefined}>
      <span className="in-row__icon">
        <Icon size={16} motion="none" />
      </span>
      <span className="in-row__label">{label}</span>
      {hint ? <span className="in-row__hint in-kbd in-mono">{hint}</span> : null}
    </button>
  );
}

function SectionHead({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="in-section__head group">
      <h3 className="in-t-label">{children}</h3>
      {action}
    </div>
  );
}

function Head() {
  return (
    <div className="in-sidebar__head">
      <Wordmark />
      <div className="flex items-center">
        <button type="button" className="in-iconbtn" data-size="sm" aria-label="Notifications">
          <Bell size={16} motion="none" />
        </button>
        <button type="button" className="in-iconbtn" data-size="sm" aria-label="Collapse sidebar">
          <PanelLeftClose size={16} motion="none" />
        </button>
      </div>
    </div>
  );
}

export function WorkspaceSwitch({ value }: { value: "chat" | "code" }) {
  return (
    <div className="in-seg mx-0 mb-3" role="group" aria-label="Workspace">
      <button type="button" className="in-seg__item" aria-pressed={value === "chat"}>
        Chat
      </button>
      <button type="button" className="in-seg__item" aria-pressed={value === "code"}>
        Code
      </button>
    </div>
  );
}

function Account() {
  return (
    <button type="button" className="in-account mt-2 w-full">
      <Initials text={ACCOUNT.initials} size={22} />
      <span className="min-w-0 flex-1 truncate text-left in-fs-135">{ACCOUNT.name}</span>
      <ChevronsUpDown size={14} motion="none" className="in-ink-3" />
    </button>
  );
}

export function ChatSidebar({ place = "home", activeCrew, recentCount = 6 }: { place?: ChatPlace; activeCrew?: string; recentCount?: number }) {
  return (
    <nav className="in-sidebar" aria-label="Chat workspace">
      <Head />
      <WorkspaceSwitch value="chat" />
      <div className="in-sidebar__scroll">
        <div className="flex flex-col gap-px">
          <NavRow icon={SquarePen} label="New chat" hint="⌘N" selected={place === "home"} />
          <NavRow icon={Search} label="Search" hint="⌘K" />
          <NavRow icon={Folder} label="Projects" />
          <NavRow icon={JunoLibrary} label="Library" />
          <NavRow icon={SlidersHorizontal} label="Customize" />
        </div>

        <section className="in-section" aria-label="Crew">
          <SectionHead
            action={
              <button type="button" className="in-iconbtn opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" data-size="sm" aria-label="Add to crew" style={{ width: 22, height: 22 }}>
                <Plus size={14} motion="none" />
              </button>
            }
          >
            Crew
          </SectionHead>
          <div className="flex flex-col gap-px">
            {CREW.map((m) => {
              const dim = m.presence === "paused" || m.presence === "offline";
              return (
                <button key={m.id} type="button" className="in-row" data-dim={dim ? "" : undefined} data-selected={activeCrew === m.id ? "" : undefined}>
                  <span className="in-row__icon">
                    <Face face={m.face} presence={m.presence} size={18} />
                  </span>
                  <span className="in-row__label">{m.name}</span>
                  {m.presence === "waiting" ? <span className="in-row__trail in-amber">Needs you</span> : null}
                </button>
              );
            })}
          </div>
        </section>

        <section className="in-section" aria-label="Recent">
          <SectionHead>Recent</SectionHead>
          <div className="flex flex-col gap-px">
            {RECENT.slice(0, recentCount).map((r, i) => (
              <button key={r} type="button" className="in-row" data-selected={place === "thread" && i === 0 ? "" : undefined}>
                <span className="in-row__label">{r}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      <Account />
    </nav>
  );
}

function SessionGlyph({ state }: { state: "working" | "waiting" | "done" }) {
  if (state === "working") return <Lens state="working" size={14} />;
  if (state === "waiting") return <MessageCircleQuestion size={15} motion="none" className="in-amber" />;
  return (
    <svg viewBox="0 0 14 14" width={14} height={14} aria-hidden="true" className="in-ink-3">
      <path d="M3.2 7.4 5.8 10 10.8 4.4" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CodeSidebar({ activeSession }: { activeSession?: number }) {
  return (
    <nav className="in-sidebar" aria-label="Code workspace">
      <Head />
      <WorkspaceSwitch value="code" />
      <div className="in-sidebar__scroll">
        <div className="flex flex-col gap-px">
          <NavRow icon={SquarePen} label="New session" hint="⌘N" selected={activeSession === undefined} />
          <NavRow icon={Search} label="Search" hint="⌘K" />
          <NavRow icon={SlidersHorizontal} label="Customize" />
        </div>
        <section className="in-section" aria-label="Sessions">
          <SectionHead>Sessions</SectionHead>
          <div className="flex flex-col gap-px">
            {CODE_SESSIONS.map((s, i) => (
              <button key={s.title} type="button" className="in-row" data-selected={activeSession === i ? "" : undefined}>
                <span className="in-row__icon">
                  <SessionGlyph state={s.state} />
                </span>
                <span className="in-row__label">{s.title}</span>
                {s.state === "waiting" ? <span className="in-row__trail in-amber">Needs you</span> : <span className="in-row__trail in-ink-3 in-mono in-fs-11">{s.where === "This Mac" ? "Mac" : s.where === "Cloud" ? "Cloud" : "Studio"}</span>}
              </button>
            ))}
          </div>
        </section>
        <section className="in-section" aria-label="Workspaces">
          <SectionHead>Workspaces</SectionHead>
          <div className="flex flex-col gap-px">
            <button type="button" className="in-row">
              <span className="in-row__icon"><Laptop size={16} motion="none" /></span>
              <span className="in-row__label">This Mac</span>
            </button>
            <button type="button" className="in-row">
              <span className="in-row__icon"><Laptop size={16} motion="none" /></span>
              <span className="in-row__label">Studio Mac</span>
            </button>
            <button type="button" className="in-row">
              <span className="in-row__icon"><Cloud size={16} motion="none" /></span>
              <span className="in-row__label">Cloud</span>
            </button>
          </div>
        </section>
      </div>
      <Account />
    </nav>
  );
}

export function MobileBar({ title, className }: { title?: string; className?: string }) {
  return (
    <div className={cn("flex h-12 shrink-0 items-center justify-between px-2", className)}>
      <button type="button" className="in-iconbtn" aria-label="Open sidebar">
        <svg viewBox="0 0 20 20" width={18} height={18} aria-hidden="true">
          <path d="M3.5 6.5h13M3.5 13.5h8" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
        </svg>
      </button>
      {title ? <span className="min-w-0 truncate in-fs-14 font-medium">{title}</span> : <Wordmark />}
      <button type="button" className="in-iconbtn" aria-label="New chat">
        <SquarePen size={18} motion="none" />
      </button>
    </div>
  );
}
