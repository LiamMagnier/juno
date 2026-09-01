"use client";

import * as React from "react";
import Link from "next/link";
import { MessageSquare, Plus, Pin, FolderInput, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
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
  onNewChat: () => void;
  className?: string;
}

export function ProjectChatList({
  projectId,
  conversations,
  allProjects = [],
  onTogglePin,
  onMoveChat,
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

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[200px] flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter chats in this project…"
            className="pl-8 h-8 text-ui font-mono bg-secondary/50"
          />
        </div>

        <Button
          type="button"
          size="sm"
          onClick={onNewChat}
          className="h-8 gap-1.5 font-mono text-caption"
        >
          <Plus className="size-3.5" />
          <span>New chat in project</span>
        </Button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          size="panel"
          className="motion-safe:animate-rise-in py-8"
          icon={MessageSquare}
          title={query ? "No matching chats" : "No chats in this project"}
          description={
            query
              ? "Try adjusting your filter keyword."
              : "Start a conversation to begin collaborating with the model in this project context."
          }
        />
      ) : (
        <div className="space-y-3">
          {pinned.length > 0 && (
            <div className="space-y-1.5">
              <span className="font-mono text-micro text-muted-foreground uppercase tracking-wider px-1">
                Pinned ({pinned.length})
              </span>
              <div className="space-y-1.5">
                {pinned.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    allProjects={allProjects}
                    currentProjectId={projectId}
                    onTogglePin={onTogglePin}
                    onMoveChat={onMoveChat}
                  />
                ))}
              </div>
            </div>
          )}

          {unpinned.length > 0 && (
            <div className="space-y-1.5">
              {pinned.length > 0 && (
                <span className="font-mono text-micro text-muted-foreground uppercase tracking-wider px-1">
                  Recent ({unpinned.length})
                </span>
              )}
              <div className="space-y-1.5">
                {unpinned.map((chat) => (
                  <ChatRow
                    key={chat.id}
                    chat={chat}
                    allProjects={allProjects}
                    currentProjectId={projectId}
                    onTogglePin={onTogglePin}
                    onMoveChat={onMoveChat}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChatRow({
  chat,
  allProjects,
  currentProjectId,
  onTogglePin,
  onMoveChat,
}: {
  chat: ProjectConversationItem;
  allProjects: { id: string; name: string }[];
  currentProjectId: string;
  onTogglePin: (id: string, current: boolean) => void;
  onMoveChat?: (chatId: string, targetProjectId: string) => void;
}) {
  const otherProjects = allProjects.filter((p) => p.id !== currentProjectId);

  return (
    <div className="group relative flex items-center gap-2 rounded-card border border-border/60 bg-card px-3.5 py-2.5 transition-all duration-fast hover:border-border hover:shadow-soft hover:bg-accent/20">
      <Link
        href={`/chat/${chat.id}`}
        className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-xs"
      >
        <span className="truncate text-body font-medium text-foreground group-hover:text-primary transition-colors">
          {chat.title}
        </span>
        <span className="font-mono text-micro text-muted-foreground">
          Last message {timeAgo(chat.lastMessageAt)}
        </span>
      </Link>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-fast pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 coarse:pointer-events-auto coarse:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onTogglePin(chat.id, chat.pinned)}
          aria-label={chat.pinned ? "Unpin chat" : "Pin chat"}
          aria-pressed={chat.pinned}
          className="size-7 text-muted-foreground hover:text-foreground"
        >
          <Pin className={cn("size-3.5", chat.pinned && "fill-primary text-primary")} />
        </Button>

        {onMoveChat && otherProjects.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Move chat"
                className="size-7 text-muted-foreground hover:text-foreground"
              >
                <FolderInput className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <p className="px-2 py-1 font-mono text-caption text-muted-foreground">
                Move to project
              </p>
              {otherProjects.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onSelect={() => onMoveChat(chat.id, p.id)}
                  className="truncate text-ui"
                >
                  {p.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}
