"use client";

import * as React from "react";
import { MoreHorizontal, Plus, SlidersHorizontal } from "@/components/ui/icons";
import { Folder } from "@/components/ui/icons";
import { Composer, DRAFT, type Seg } from "./composer";
import { Face } from "./face";
import { ACCOUNT, CREW, MIRA, PRESENCE_LABEL, SCOUT, THREAD_TITLE } from "./fixtures";
import { ChatSidebar, MobileBar } from "./sidebar";
import { AnswerBody, Approval, MessageActions, TaskCard, ThreadHeader, ToolLine, UserMessage } from "./thread";

/* ---------------------------------------------------------------------------
 * Home: Chat at rest
 * ------------------------------------------------------------------------- */

export function Suggestions() {
  return (
    <div className="in-home__chips" aria-label="Suggestions">
      <button type="button" className="in-chip">
        <Face face={MIRA.face} presence="waiting" size={16} live={false} />
        Answer Mira on Halvorsen
      </button>
      <button type="button" className="in-chip">
        <Face face={SCOUT.face} presence="available" size={16} live={false} />
        Read Scout&apos;s review
      </button>
      <button type="button" className="in-chip">
        <Folder size={15} motion="none" />
        Continue Atlas launch
      </button>
    </div>
  );
}

export function greeting() {
  return `Good afternoon, ${ACCOUNT.first}`;
}

export function HomeScene() {
  return (
    <div className="in-shell">
      <ChatSidebar place="home" />
      <main className="in-panel">
        <MobileBar className="in-only-mobile" />
        <div className="in-home">
          <div className="in-home__center">
            <h1 className="in-t-display in-home__greet">{greeting()}</h1>
            <div className="in-home__composer">
              <Composer initial={DRAFT} />
            </div>
            <Suggestions />
          </div>
        </div>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Thread: after send
 * ------------------------------------------------------------------------- */

export function ThreadBody({ segs = DRAFT }: { segs?: Seg[] }) {
  return (
    <div className="in-column flex flex-col pb-14 pt-6">
      <UserMessage segs={segs} />
      <div className="mt-8">
        <ToolLine />
      </div>
      <div className="mt-3">
        <AnswerBody />
        <MessageActions />
      </div>
      <div className="mt-6 flex flex-col gap-3">
        <TaskCard />
        <Approval />
      </div>
    </div>
  );
}

export function ThreadScene({ full = false }: { full?: boolean }) {
  const scroller = React.useRef<HTMLDivElement | null>(null);
  React.useLayoutEffect(() => {
    if (full) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [full]);
  return (
    <div className="in-shell" data-full={full ? "" : undefined}>
      <ChatSidebar place="thread" />
      <main className="in-panel">
        <MobileBar title={THREAD_TITLE} className="in-only-mobile" />
        <div className="in-only-desktop">
          <ThreadHeader title={THREAD_TITLE} />
        </div>
        <div ref={scroller} className="in-scroll">
          <ThreadBody />
        </div>
        <div className="in-dock">
          <div className="in-column">
            <Composer size="docked" placeholder="Reply to Juno" />
            <p className="in-dock__note">Juno can make mistakes. Tasks ask before anything they can&apos;t undo.</p>
          </div>
        </div>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Menus: the @ palette and the model popover, open
 * ------------------------------------------------------------------------- */

const MENU_DRAFT: Seg[] = [
  { t: "text", v: "Compare " },
  { t: "token", id: "q3-forecast", key: "m1" },
  { t: "text", v: " with " },
];

export function MenusScene() {
  return (
    <div className="in-shell">
      <ChatSidebar place="home" />
      <main className="in-panel">
        <div className="grid h-full grid-cols-2 gap-10 px-10 pt-[120px]">
          <div className="min-w-0">
            <p className="mb-3 in-t-label">Typing @ after “with”</p>
            <Composer initial={MENU_DRAFT} staticFocused staticPalette={{ query: "", active: 6 }} />
          </div>
          <div className="min-w-0">
            <p className="mb-3 in-t-label">The model control</p>
            <Composer initial={DRAFT} staticModel />
          </div>
        </div>
      </main>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Crew: the roster and a member's thread
 * ------------------------------------------------------------------------- */

export function CrewScene() {
  return (
    <div className="in-shell">
      <ChatSidebar place="crew" activeCrew="mira" />
      <main className="in-panel !flex-row">
        <section className="flex w-[440px] shrink-0 flex-col border-r" style={{ borderColor: "var(--in-hairline)" }} aria-label="Crew">
          <header className="flex items-end justify-between px-6 pb-4 pt-7">
            <div>
              <h1 className="in-t-title">Crew</h1>
              <p className="mt-1 in-t-small in-ink-3">
                Six teammates. <span className="in-amber">Mira needs you.</span>
              </p>
            </div>
            <button type="button" className="in-btn" data-variant="secondary" data-size="sm">
              <Plus size={14} motion="none" />
              Add to crew
            </button>
          </header>
          <div className="flex flex-col px-3">
            {CREW.map((m) => (
              <button key={m.id} type="button" className="in-roster-row" data-selected={m.id === "mira" ? "" : undefined}>
                <Face face={m.face} presence={m.presence} size={32} name={m.name} />
                <span className="min-w-0 flex-1 text-left">
                  <span className="flex items-baseline gap-2">
                    <span className="in-fs-14 font-medium leading-5">{m.name}</span>
                    <span className="in-t-small in-ink-3">{m.role}</span>
                  </span>
                  <span className="block truncate in-t-small in-ink-2">{m.now}</span>
                </span>
                <span className={m.presence === "waiting" ? "in-amber in-t-small" : "in-ink-3 in-t-small"}>{PRESENCE_LABEL[m.presence]}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="flex min-w-0 flex-1 flex-col" aria-label="Mira">
          <header className="flex items-center gap-3.5 px-6 pb-4 pt-6">
            <Face face={MIRA.face} presence="waiting" size={44} name="Mira" />
            <div className="min-w-0 flex-1">
              <p className="flex items-baseline gap-2">
                <span className="in-t-title">Mira</span>
                <span className="in-t-small in-ink-3">Accounts</span>
              </p>
              <p className="in-t-small in-ink-2">
                <span className="in-amber">Waiting for you</span> on the Halvorsen renewal
              </p>
            </div>
            <button type="button" className="in-btn" data-variant="ghost" data-size="sm">
              <SlidersHorizontal size={14} motion="none" />
              Setup
            </button>
            <button type="button" className="in-iconbtn" data-size="sm" aria-label="More">
              <MoreHorizontal size={16} motion="none" />
            </button>
          </header>
          <div className="in-scroll">
            <div className="in-column flex flex-col gap-6 pb-8 pt-4">
              <p className="text-center in-t-meta">
                <span className="in-mono">Today 09:12</span>
              </p>
              <div className="in-answer">
                <p>Morning. Halvorsen&apos;s annual plan lapsed on 31 August and they have been paying monthly since. Their usage is up 18% on the quarter, so this looks like a paperwork gap, not churn.</p>
                <p>
                  I can send Dana at Halvorsen the renewal at <strong>€96,000</strong>, or offer the <strong>€88,000</strong> two-year price you approved in June. Which should it be?
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="in-btn" data-variant="secondary">
                  Send the annual renewal
                </button>
                <button type="button" className="in-btn" data-variant="secondary">
                  Offer the two-year price
                </button>
              </div>
            </div>
          </div>
          <div className="in-dock">
            <div className="in-column">
              <Composer size="docked" placeholder="Message Mira" />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export { PRESENCE_LABEL };
