"use client";

import * as React from "react";
import Link from "next/link";
import { MessageSquare, Plus, Pin, FolderInput, Search } from "@/components/ui/icons";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W } from "@/components/ui/menu-recipe";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { IconSwap } from "@/components/ui/icon-swap";
import { PRODUCT_NAME } from "@/lib/brand/names";

export interface ProjectConversationItem {
  id: string;
  title: string;
  lastMessageAt: string;
  pinned: boolean;
}

interface ProjectChatListProps {
  projectId: string;
  conversations: ProjectConversationItem[];
  allProjects?: { id: string; name: string }[];
  onTogglePin: (id: string, current: boolean) => void;
  onMoveChat?: (chatId: string, targetProjectId: string) => void;
  onDeleteChat?: (chat: ProjectConversationItem) => void;
  onNewChat: () => void;
  className?: string;
}

export function ProjectChatList({
  projectId,
  conversations,
  allProjects = [],
  onTogglePin,
  onMoveChat,
  onDeleteChat,
  onNewChat,
  className,
}: ProjectChatListProps) {
  const [query, setQuery] = React.useState("");

  const filtered = React.useMemo(() => {
    if (!query.trim()) return conversations;
    const q = query.toLowerCase();
    return conversations.filter((c) => c.title.toLowerCase().includes(q));
  }, [conversations, query]);

  const pinned = filtered.filter((c) => c.pinned);
  const unpinned = filtered.filter((c) => !c.pinned);

  const rowProps = { allProjects, currentProjectId: projectId, onTogglePin, onMoveChat, onDeleteChat };

  return (
    <div className={cn("space-y-4", className)}>
      {/* One row at every width, every control 36px (44 on touch): the field
          fills the row up to New chat. Its count appears only while a search
          is narrowing the list, inside the field beside what was typed. */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats in this project"
            className={cn("pl-9", query.trim() && "pr-16")}
          />
          {query.trim() && (
            <span
              aria-live="polite"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-caption tabular-nums text-muted-foreground motion-safe:animate-fade-in"
            >
              {filtered.length} of {conversations.length}
            </span>
          )}
        </div>
        <Button type="button" variant="secondary" onClick={onNewChat} className="shrink-0">
          <Plus className="size-4" aria-hidden="true" />
          New chat
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          size="panel"
          className="motion-safe:animate-rise-in"
          icon={query ? Search : MessageSquare}
          title={query ? "No matching chats" : "No chats in this project yet"}
          description={
            query
              ? "Try another search term."
              : `Start one above. ${PRODUCT_NAME} reads the project’s instructions and files first.`
          }
          action={
            query ? (
              <Button variant="ghost" size="sm" onClick={() => setQuery("")} className="text-muted-foreground">
                Clear search
              </Button>
            ) : undefined
          }
        />
      ) : (
        // `-mx-3`: the rows keep their 12px hover inset and their icons sit
        // on the column's edge. Where the page is wide enough to have a
        // margin (the two-column Overview), the icons hang into it instead
        // (16px icon + 12px gap further out), so the chat titles sit on the
        // same line as the tabs, the composer and the section labels.
        <div className="-mx-3 space-y-5 @4xl/page:-ml-10">
          {pinned.length > 0 && (
            <section aria-label="Pinned chats">
              <SectionLabel label="Pinned" count={pinned.length} />
              <ul className="space-y-px">
                {pinned.map((chat, i) => (
                  <ChatRow key={chat.id} chat={chat} index={i} {...rowProps} />
                ))}
              </ul>
            </section>
          )}

          {unpinned.length > 0 && (
            <section aria-label="Recent chats">
              {pinned.length > 0 && (
                <SectionLabel label="Recent" count={unpinned.length} />
              )}
              <ul className="space-y-px">
                {unpinned.map((chat, i) => (
                  <ChatRow key={chat.id} chat={chat} index={pinned.length + i} {...rowProps} />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A group's label with its count as a muted number after it, the rail's
 * section-label voice. Its inset matches the rows' text, including where the
 * rows' icons hang into the margin.
 */
function SectionLabel({ label, count }: { label: string; count: number }) {
  return (
    <p className="mb-1 flex items-center gap-1.5 px-3 text-caption font-medium tracking-[0.01em] text-muted-foreground @4xl/page:pl-10">
      {label}
      <span className="font-normal tabular-nums text-muted-foreground/70">{count.toLocaleString()}</span>
    </p>
  );
}

/**
 * One chat: the house hover-raised row. The title is the link; pin / move /
 * delete arrive on hover or focus (always present on a coarse pointer).
 */
function ChatRow({
  chat,
  index,
  allProjects,
  currentProjectId,
  onTogglePin,
  onMoveChat,
  onDeleteChat,
}: {
  chat: ProjectConversationItem;
  index: number;
  allProjects: { id: string; name: string }[];
  currentProjectId: string;
  onTogglePin: (id: string, current: boolean) => void;
  onMoveChat?: (chatId: string, targetProjectId: string) => void;
  onDeleteChat?: (chat: ProjectConversationItem) => void;
}) {
  const otherProjects = allProjects.filter((p) => p.id !== currentProjectId);

  return (
    <li
      className="group flex min-h-14 w-full items-center gap-3 rounded-control px-3 py-2 text-left transition-colors duration-fast ease-out-soft focus-within:bg-accent/60 hover:bg-accent motion-reduce:transition-none [animation-fill-mode:backwards] motion-safe:animate-rise-in"
      style={staggerDelay(index, "tight")}
    >
      <MessageSquare
        className="size-4 shrink-0 text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground motion-reduce:transition-none"
        aria-hidden="true"
      />
      <Link
        href={`/chat/${chat.id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs"
      >
        <span className="truncate text-ui font-medium tracking-[-0.006em] text-foreground">{chat.title}</span>
        <span className="text-caption tabular-nums text-muted-foreground">
          Updated {timeAgo(chat.lastMessageAt)}
        </span>
      </Link>

      {/* The resting "pinned" mark fades out as the action cluster fades in,
          rather than blinking out with `hidden` — it keeps its 14px, so the
          title never reflows under the pointer. */}
      {/* The resting mark sits on the row's end, centred in the last key's
          28px, so pinned marks form one column down the list; it fades out
          as the action cluster fades in over the same place. */}
      <div className="relative flex shrink-0 items-center">
      {chat.pinned && (
        <Pin
          weight="fill"
          className="pointer-events-none absolute right-[7px] top-1/2 size-3.5 -translate-y-1/2 text-primary transition-opacity duration-fast ease-out-soft group-focus-within:opacity-0 group-hover:opacity-0 coarse:opacity-0 motion-reduce:transition-none"
          aria-hidden="true"
        />
      )}

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100 motion-reduce:transition-none">
        <Pressable
          kind="icon"
          size="sm"
          onClick={() => onTogglePin(chat.id, chat.pinned)}
          aria-label={chat.pinned ? "Unpin chat" : "Pin chat"}
          title={chat.pinned ? "Unpin" : "Pin"}
          aria-pressed={chat.pinned}
          selected={chat.pinned}
          className={cn(chat.pinned && "text-primary hover:text-primary")}
        >
          <IconSwap
            swapped={chat.pinned}
            from={<Pin className="size-3.5" />}
            to={<Pin weight="fill" className="size-3.5" />}
          />
        </Pressable>

        {onMoveChat && otherProjects.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pressable kind="icon" size="sm" aria-label="Move chat to another project" title="Move to project">
                <FolderInput className="size-3.5" aria-hidden="true" />
              </Pressable>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_W}>
              <DropdownMenuLabel>Move to project</DropdownMenuLabel>
              {otherProjects.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => onMoveChat(chat.id, p.id)}
                  className="truncate"
                >
                  {p.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {onDeleteChat && (
          <Pressable
            kind="icon"
            size="sm"
            onClick={() => onDeleteChat(chat)}
            aria-label={`Delete “${chat.title}”`}
            title="Delete"
            className="danger-hover"
          >
            <ActionIcons.delete className="size-3.5" aria-hidden="true" />
          </Pressable>
        )}
      </div>
      </div>
    </li>
  );
}
