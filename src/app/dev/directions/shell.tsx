"use client";

import * as React from "react";
import { AgentFace } from "@/components/agents/agent-face";
import { ProductSwitch } from "@/components/app/product-switch";
import { IconButton } from "@/components/ui/icon-button";
import {
  Bell,
  Folder,
  JunoLibrary,
  Menu,
  PanelLeftClose,
  Plus,
  Search,
  SlidersHorizontal,
  SquarePen,
  TriangleAlert,
  X,
} from "@/components/ui/icons";
import type { IconComponent } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { ACCOUNT, CREW, MIRA, PINNED, PRESENCE, RECENT, type CrewMember } from "./fixtures";
import { Wordmark } from "./glyphs";
import type { DirectionId } from "./tokens";

/*
 * The Chat workspace's sidebar in the Refoundation's information architecture
 * (PRODUCT_REFOUNDATION §4.1). The shipping `AppSidebar` still lists today's
 * destinations, so this column is composed here from its parts: the real
 * `ProductSwitch`, `AgentFace` and `IconButton`, the `.app-sidebar-frame`
 * panel, the `.sidebar-row-selected` fill, and the sidebar's own row recipe
 * (app-sidebar.tsx `navRowClass` / `listRowClass`: 32px rows, the `nav` rung,
 * a 20px glyph box that puts every glyph 16px and every label 46px from the
 * panel edge).
 */

export type SidebarPlace = "home" | "thread" | "crew" | "none";

export const ROW =
  "group relative flex h-8 w-full min-w-0 items-center gap-2.5 rounded-control px-2 text-left text-nav coarse:h-11 transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none";

export function rowState(active: boolean) {
  return active
    ? "sidebar-row-selected text-foreground"
    : "text-sidebar-foreground hover:bg-sidebar-hover hover:text-foreground";
}

function NavRow({ icon: Icon, label, hint }: { icon: IconComponent; label: string; hint?: string }) {
  return (
    <button type="button" className={cn(ROW, rowState(false))}>
      <span className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-4.5">
        <Icon aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && (
        <span className="font-mono text-micro text-muted-foreground opacity-0 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100">
          {hint}
        </span>
      )}
    </button>
  );
}

function SectionHeading({
  children,
  tone = "muted",
  action,
}: {
  children: React.ReactNode;
  tone?: "muted" | "signal";
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 px-2">
      <h3
        className={cn(
          "flex items-center gap-1.5 text-label font-medium",
          tone === "signal" ? "text-warning" : "text-muted-foreground",
        )}
      >
        {tone === "signal" && <TriangleAlert className="size-3.5" aria-hidden="true" />}
        {children}
      </h3>
      {action}
    </div>
  );
}

/** A crew member as a sidebar row: face, name, and one line of what they are doing now. */
function CrewRow({ member }: { member: CrewMember }) {
  const waiting = member.presence === "waiting";
  return (
    <button
      type="button"
      className={cn(
        "group flex w-full min-w-0 items-center gap-2.5 rounded-control px-2 py-1.5 text-left transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none",
        rowState(false),
      )}
      aria-label={`${member.name}. ${PRESENCE[member.presence].label}. ${member.now}`}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        <AgentFace avatar={member.avatar} state={PRESENCE[member.presence].face} size={20} live={false} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-nav text-foreground">{member.name}</span>
        <span className={cn("block truncate text-caption", waiting ? "text-warning" : "text-muted-foreground")}>
          {member.now}
        </span>
      </span>
    </button>
  );
}

export function DirectionSidebar({
  direction,
  place,
  onClose,
}: {
  direction: DirectionId;
  place: SidebarPlace;
  /** Present in the phone drawer: the collapse button closes the drawer. */
  onClose?: () => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between gap-2 pl-4 pr-2">
        <Wordmark direction={direction} />
        <div className="flex items-center gap-0.5">
          <IconButton variant="ghost" size="sm" label="Notifications">
            <Bell className="size-4" aria-hidden="true" />
          </IconButton>
          <IconButton variant="ghost" size="sm" label={onClose ? "Close menu" : "Collapse sidebar"} onClick={onClose}>
            {onClose ? <X className="size-4" aria-hidden="true" /> : <PanelLeftClose className="size-4" aria-hidden="true" />}
          </IconButton>
        </div>
      </header>

      <div className="px-2 pb-2">
        <ProductSwitch active="chat" plan="PRO" />
      </div>

      <nav aria-label="Chat" className="flex flex-col px-2">
        <NavRow icon={SquarePen} label="New chat" hint="⌘N" />
        <NavRow icon={Search} label="Search" hint="⌘K" />
        <NavRow icon={Folder} label="Projects" />
        <NavRow icon={JunoLibrary} label="Library" />
        <NavRow icon={SlidersHorizontal} label="Customize" />
      </nav>

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-3">
        <section aria-label="Needs you">
          <SectionHeading tone="signal">Needs you</SectionHeading>
          <button
            type="button"
            className={cn(
              "flex w-full items-start gap-2.5 rounded-control px-2 py-1.5 text-left text-nav transition-[background-color,color] duration-fast ease-out-soft motion-reduce:transition-none",
              rowState(false),
            )}
          >
            <span className="flex size-5 shrink-0 items-center justify-center pt-0.5">
              <AgentFace avatar={MIRA.avatar} state="waiting" size={20} live={false} />
            </span>
            <span className="line-clamp-2 min-w-0 flex-1 text-foreground">
              Mira wants your answer on the Halvorsen renewal
            </span>
          </button>
        </section>

        <section aria-label="Crew">
          <SectionHeading
            action={
              <IconButton variant="ghost" size="sm" label="Add to crew" className="-my-1 -mr-1.5">
                <Plus className="size-4" aria-hidden="true" />
              </IconButton>
            }
          >
            <button
              type="button"
              aria-current={place === "crew" ? "page" : undefined}
              className={cn(
                "-mx-1 inline-flex h-8 items-center rounded-control px-1 transition-colors duration-fast ease-out-soft hover:text-foreground motion-reduce:transition-none",
                place === "crew" && "text-foreground",
              )}
            >
              Crew
            </button>
          </SectionHeading>
          {CREW.slice(0, 4).map((member) => (
            <CrewRow key={member.id} member={member} />
          ))}
        </section>

        <section aria-label="Pinned">
          <SectionHeading>Pinned</SectionHeading>
          {PINNED.map((title) => (
            <button key={title} type="button" className={cn(ROW, rowState(false))}>
              <span className="min-w-0 flex-1 truncate">{title}</span>
            </button>
          ))}
        </section>

        <section aria-label="Recent">
          <SectionHeading>Recent</SectionHeading>
          {RECENT.map((title, i) => {
            const active = place === "thread" && i === 0;
            return (
              <button
                key={title}
                type="button"
                aria-current={active ? "page" : undefined}
                className={cn(ROW, rowState(active))}
              >
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </button>
            );
          })}
        </section>
      </div>

      <footer className="shrink-0 border-t border-sidebar-border px-2 py-2">
        <button type="button" className={cn("flex h-11 w-full items-center gap-2.5 rounded-control px-2 text-left", rowState(false))}>
          <span
            aria-hidden="true"
            className="grid size-7 shrink-0 place-items-center rounded-full bg-secondary font-mono text-micro font-medium text-foreground"
          >
            {ACCOUNT.initials}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-nav text-foreground">{ACCOUNT.name}</span>
            <span className="block truncate text-caption text-muted-foreground">{ACCOUNT.plan}</span>
          </span>
        </button>
      </footer>
    </div>
  );
}

/**
 * The workspace frame: the docked sidebar from `lg` up, and below it a top
 * bar whose menu button opens the same column as a drawer.
 */
export function AppFrame({
  direction,
  place,
  title,
  children,
}: {
  direction: DirectionId;
  place: SidebarPlace;
  /** The phone bar's title; the wordmark when absent. */
  title?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex min-h-dvh">
      <aside className="app-sidebar-frame dir-sidebar sticky top-0 hidden h-dvh shrink-0 lg:block">
        <DirectionSidebar direction={direction} place={place} />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-background px-2 lg:hidden">
          <IconButton variant="ghost" label="Open menu" onClick={() => setOpen(true)} aria-expanded={open}>
            <Menu className="size-5" aria-hidden="true" />
          </IconButton>
          <div className="flex min-w-0 flex-1 justify-center">
            {title ? <span className="truncate text-nav font-medium text-foreground">{title}</span> : <Wordmark direction={direction} />}
          </div>
          <IconButton variant="ghost" label="New chat">
            <SquarePen className="size-5" aria-hidden="true" />
          </IconButton>
        </div>
        {children}
      </div>

      {open && (
        <div className="fixed inset-0 z-modal lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-scrim"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Menu"
            className="app-sidebar-frame dir-layer-in absolute inset-y-0 left-0 w-[min(88vw,320px)] shadow-float"
          >
            <DirectionSidebar direction={direction} place={place} onClose={() => setOpen(false)} />
          </div>
        </div>
      )}
    </div>
  );
}
