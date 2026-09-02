"use client";

import * as React from "react";
import Link from "next/link";
import { MessageSquare, Plus, Pin, FolderInput, Search } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pressable } from "@/components/ui/pressable";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

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
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats in this project"
            className="pl-9"
          />
        </div>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          {filtered.length} of {conversations.length}
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={onNewChat} className="ml-auto gap-1.5">
          <Plus className="size-3.5" aria-hidden="true" />
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
              : "Start one above — Juno reads the project’s instructions and files first."
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
        <div className="space-y-5">
          {pinned.length > 0 && (
            <section aria-label="Pinned chats">
              <p className="mb-1.5 px-3 font-mono text-label text-muted-foreground">
                Pinned · {pinned.length}
              </p>
              <ul className="space-y-1">
                {pinned.map((chat, i) => (
                  <ChatRow key={chat.id} chat={chat} index={i} {...rowProps} />
                ))}
              </ul>
            </section>
          )}

          {unpinned.length > 0 && (
            <section aria-label="Recent chats">
              {pinned.length > 0 && (
                <p className="mb-1.5 px-3 font-mono text-label text-muted-foreground">
                  Recent · {unpinned.length}
                </p>
              )}
              <ul className="space-y-1">
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
      className="group flex w-full items-center gap-3 rounded-control border border-transparent px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:border-border/60 hover:bg-card hover:shadow-raised motion-reduce:transition-none [animation-fill-mode:backwards] motion-safe:animate-rise-in"
      style={staggerDelay(index)}
    >
      <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Link
        href={`/chat/${chat.id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs"
      >
        <span className="truncate text-sm font-medium text-foreground">{chat.title}</span>
        <span className="font-mono text-caption tabular-nums text-muted-foreground">
          Updated {timeAgo(chat.lastMessageAt)}
        </span>
      </Link>

      {chat.pinned && (
        <Pin className="size-3.5 shrink-0 fill-current text-primary group-hover:hidden group-focus-within:hidden" aria-hidden="true" />
      )}

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100 motion-reduce:transition-none">
        <Pressable
          kind="icon"
          size="sm"
          onClick={() => onTogglePin(chat.id, chat.pinned)}
          aria-label={chat.pinned ? "Unpin chat" : "Pin chat"}
          aria-pressed={chat.pinned}
          selected={chat.pinned}
          className={cn(chat.pinned && "text-primary hover:text-primary")}
        >
          <Pin className={cn("size-3.5", chat.pinned && "fill-current")} aria-hidden="true" />
        </Pressable>

        {onMoveChat && otherProjects.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pressable kind="icon" size="sm" aria-label="Move chat to another project">
                <FolderInput className="size-3.5" aria-hidden="true" />
              </Pressable>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <p className="px-2 py-1 font-mono text-label text-muted-foreground">Move to project</p>
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
            className="danger-hover"
          >
            <ActionIcons.delete className="size-3.5" aria-hidden="true" />
          </Pressable>
        )}
      </div>
    </li>
  );
}
