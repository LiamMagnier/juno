"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Box,
  Check,
  Command,
  Folder,
  Library,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeft,
  Pencil,
  Search,
  Shapes,
  Plus,
  Trash2,
  X,
  Star,
} from "lucide-react";
import { usePathname } from "next/navigation";
import { UserMenu } from "@/components/app/user-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApp } from "@/components/app/app-provider";
import { dateGroup, cn } from "@/lib/utils";
import type { ClientConversation } from "@/types/chat";

type ConfirmState = { title: string; description: string; confirmLabel: string; onConfirm: () => void } | null;

export function AppSidebar({
  collapsed,
  onToggleCollapse,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const {
    conversations,
    folders,
    setFolders,
    updateConversation,
    removeConversation,
    activeConversationId,
    setSidebarOpen,
  } = useApp();
  const [query, setQuery] = React.useState("");
  const [folderFilter, setFolderFilter] = React.useState<string | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmState>(null);
  // Date grouping (Today/Yesterday/…) depends on the local clock, so defer the
  // list to after mount to keep SSR and the first client render in agreement.
  const [mounted, setMounted] = React.useState(false);
  const [projects, setProjects] = React.useState<{ id: string; name: string }[]>([]);
  const [starredProjectIds, setStarredProjectIds] = React.useState<string[]>([]);

  const loadProjects = React.useCallback(async () => {
    try {
      const res = await fetch("/api/projects");
      if (res.ok) {
        const data = await res.json();
        const nextProjects = Array.isArray(data.projects) ? data.projects : [];
        React.startTransition(() => setProjects(nextProjects));
      }
    } catch {}
  }, []);

  const loadStarred = React.useCallback(() => {
    if (typeof window !== "undefined") {
      try {
        const starred = JSON.parse(localStorage.getItem("starredProjects") || "[]");
        setStarredProjectIds(Array.isArray(starred) ? starred : []);
      } catch {
        setStarredProjectIds([]);
      }
    }
  }, []);

  React.useEffect(() => {
    setMounted(true);
    loadProjects();
    loadStarred();

    const handleSync = () => {
      loadProjects();
      loadStarred();
    };

    window.addEventListener("projects:sync", handleSync);
    window.addEventListener("starred:sync", handleSync);
    return () => {
      window.removeEventListener("projects:sync", handleSync);
      window.removeEventListener("starred:sync", handleSync);
    };
  }, [loadProjects, loadStarred]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return conversations.filter(
      (c) => (!q || c.title.toLowerCase().includes(q)) && (!folderFilter || c.folderId === folderFilter)
    );
  }, [conversations, query, folderFilter]);

  const pinned = React.useMemo(() => filtered.filter((c) => c.pinned), [filtered]);
  const groups = React.useMemo(() => {
    const map = new Map<string, ClientConversation[]>();
    for (const c of filtered.filter((c) => !c.pinned)) {
      const g = dateGroup(c.lastMessageAt);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(c);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const newChat = () => {
    router.push("/chat");
    // If we're already on /chat the router.push is a no-op, so also
    // dispatch a reset event so ChatView clears any stale state.
    window.dispatchEvent(new CustomEvent("juno:new-chat"));
    setSidebarOpen(false);
  };


  const deleteFolder = (id: string) => {
    setConfirm({
      title: "Delete this folder?",
      description: "Conversations inside it are kept — they just move out of the folder.",
      confirmLabel: "Delete folder",
      onConfirm: async () => {
        setFolders(folders.filter((f) => f.id !== id));
        if (folderFilter === id) setFolderFilter(null);
        for (const c of conversations) if (c.folderId === id) updateConversation(c.id, { folderId: null });
        const res = await fetch(`/api/folders/${id}`, { method: "DELETE" });
        if (!res.ok) toast.error("Could not delete folder.");
      },
    });
  };

  // Collapsed icon rail (desktop only).
  if (collapsed) {
    return (
      <div className="flex h-full flex-col items-center bg-sidebar py-3 text-sidebar-foreground">
        <button
          onClick={onToggleCollapse}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-fast hover:scale-105 active:scale-95 hover:bg-sidebar-accent"
        >
          <PanelLeft className="h-[18px] w-[18px] text-muted-foreground" />
        </button>
        <div className="mt-3 flex flex-col items-center gap-1">
          <RailIcon onClick={newChat} label="New chat">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted-foreground/15 text-foreground transition-transform duration-fast hover:scale-105 active:scale-95">
              <Plus className="h-4 w-4" />
            </span>
          </RailIcon>
          <RailIcon href="/library" active={pathname === "/library"} label="Library"><Library className="h-[18px] w-[18px] transition-transform duration-fast hover:scale-110" /></RailIcon>
          <RailIcon href="/artifacts" active={pathname === "/artifacts"} label="Artifacts"><Shapes className="h-[18px] w-[18px] transition-transform duration-fast hover:scale-110" /></RailIcon>
          <RailIcon href="/projects" active={!!pathname?.startsWith("/projects")} label="Projects"><Box className="h-[18px] w-[18px] transition-transform duration-fast hover:scale-110" /></RailIcon>
          <RailIcon onClick={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))} label="Search (⌘K)">
            <Search className="h-[18px] w-[18px]" />
          </RailIcon>
        </div>
        <div className="mt-auto">
          <UserMenu compact />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center justify-between px-3 pb-7 pt-3">
        <Link href="/chat" onClick={() => setSidebarOpen(false)} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="font-serif text-2xl font-normal tracking-normal text-foreground pl-1">
            Juno
          </span>
        </Link>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => window.dispatchEvent(new CustomEvent("juno:command-palette"))}
            aria-label="Search — command palette (⌘K)"
          >
            <Search className="h-4 w-4" />
          </Button>
          {onToggleCollapse && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="hidden md:inline-flex"
              onClick={onToggleCollapse}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => setSidebarOpen(false)} aria-label="Close menu">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Primary nav (Claude-style rows) */}
      <nav className="space-y-0.5 px-2 pt-1">
        <NavRow
          onClick={newChat}
          icon={
            <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-muted-foreground/15 text-foreground transition-transform duration-fast group-hover:scale-105">
              <Plus className="h-3.5 w-3.5" />
            </span>
          }
          label="New chat"
        />
        <NavRow href="/library" active={pathname === "/library"} onClick={() => setSidebarOpen(false)} icon={<Library className="h-[18px] w-[18px]" />} label="Library" />
        <NavRow href="/artifacts" active={pathname === "/artifacts"} onClick={() => setSidebarOpen(false)} icon={<Shapes className="h-[18px] w-[18px]" />} label="Artifacts" />
        <NavRow href="/projects" active={!!pathname?.startsWith("/projects")} onClick={() => setSidebarOpen(false)} icon={<Box className="h-[18px] w-[18px]" />} label="Projects" />
      </nav>

      <div className="pt-2" />

      {folders.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          <FolderChip active={folderFilter === null} onClick={() => setFolderFilter(null)}>All</FolderChip>
          {folders.map((f) => (
            <FolderChip
              key={f.id}
              active={folderFilter === f.id}
              onClick={() => setFolderFilter(f.id)}
              onDelete={() => deleteFolder(f.id)}
            >
              {f.name}
            </FolderChip>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!mounted ? (
          <div className="space-y-1 px-1 pt-1">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="skeleton h-8 rounded-lg" style={{ animationDelay: `${i * 60}ms` }} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground" aria-live="polite">
            {query ? (
              <>No chats match “{query}”.</>
            ) : (
              <>No conversations yet.<br />Start one above.</>
            )}
          </p>
        ) : (
          <>
            {(() => {
              const starredProjects = projects.filter((p) => starredProjectIds.includes(p.id));
              const hasStarred = starredProjects.length > 0 || pinned.length > 0;
              if (!hasStarred) return null;
              return (
                <Section label="Starred" count={starredProjects.length + pinned.length} icon={Star}>
                  {/* Starred Projects */}
                  {starredProjects.map((p) => (
                    <div
                      key={p.id}
                      className="group relative flex items-center rounded-md pr-1 transition-all duration-fast hover:bg-sidebar-accent hover:translate-x-0.5"
                    >
                      <Link
                        href={`/projects/${p.id}`}
                        onClick={() => setSidebarOpen(false)}
                        className="flex min-w-0 flex-1 items-center gap-2 truncate px-3 py-2 text-sm text-sidebar-foreground/80 hover:text-foreground font-medium"
                        title={p.name}
                      >
                        <Box className="h-4 w-full max-w-[16px] shrink-0 text-muted-foreground/75 transition-transform duration-fast group-hover:scale-105" />
                        <span className="truncate">{p.name}</span>
                      </Link>
                    </div>
                  ))}
                  {/* Starred/Pinned Chats */}
                  {pinned.map((c) => (
                    <ConversationRow
                      key={c.id}
                      conversation={c}
                      active={c.id === activeConversationId}
                      renaming={renamingId === c.id}
                      setRenaming={setRenamingId}
                      projects={projects}
                      onUpdate={updateConversation}
                      onRemove={removeConversation}
                      onNavigate={() => setSidebarOpen(false)}
                      onRequestConfirm={setConfirm}
                    />
                  ))}
                </Section>
              );
            })()}
            {groups.map(([label, items]) => (
              <Section key={label} label={label} count={items.length}>
                {items.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    active={c.id === activeConversationId}
                    renaming={renamingId === c.id}
                    setRenaming={setRenamingId}
                    projects={projects}
                    onUpdate={updateConversation}
                    onRemove={removeConversation}
                    onNavigate={() => setSidebarOpen(false)}
                    onRequestConfirm={setConfirm}
                  />
                ))}
              </Section>
            ))}
          </>
        )}
      </div>

      <div className="border-t border-sidebar-border p-2">
        <UserMenu />
      </div>

      {/* New-folder dialog (replaces window.prompt) */}

      {/* Confirm dialog (replaces window.confirm) */}
      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                confirm?.onConfirm();
                setConfirm(null);
              }}
            >
              {confirm?.confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RailIcon({
  href,
  onClick,
  label,
  active,
  children,
}: {
  href?: string;
  onClick?: () => void;
  label: string;
  active?: boolean;
  children: React.ReactNode;
}) {
  const cls = cn(
    "flex h-9 w-9 items-center justify-center rounded-lg transition-all duration-fast hover:scale-105 active:scale-95",
    active ? "bg-sidebar-accent text-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-foreground"
  );
  if (href) {
    return (
      <Link href={href} title={label} aria-label={label} aria-current={active ? "page" : undefined} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className={cls}>
      {children}
    </button>
  );
}

function NavRow({
  href,
  onClick,
  icon,
  label,
  active,
}: {
  href?: string;
  onClick?: () => void;
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  const cls = cn(
    "group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-[15px] font-medium transition-all duration-fast hover:bg-sidebar-accent hover:translate-x-0.5",
    active
      ? "bg-sidebar-accent font-semibold text-foreground"
      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground"
  );
  const inner = (
    <>
      <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center text-muted-foreground/80 transition-transform duration-fast group-hover:scale-105 group-hover:text-foreground">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} onClick={onClick} aria-current={active ? "page" : undefined} className={cls}>
        {inner}
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} className={cn(cls, "w-full text-left")}>
      {inner}
    </button>
  );
}

function Section({
  label,
  count,
  icon: Icon,
  children,
}: {
  label: string;
  count?: number;
  icon?: typeof Star;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground/75" />}
        <span className="font-mono text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground/80">{label}</span>
        {count != null && <span className="font-mono text-[10px] text-muted-foreground/50">{count}</span>}
      </div>
      <div className="space-y-0.5 px-2">{children}</div>
    </div>
  );
}

function FolderChip({
  active,
  onClick,
  onDelete,
  children,
}: {
  active: boolean;
  onClick: () => void;
  onDelete?: () => void;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "group/chip inline-flex items-center rounded-full border text-xs transition-colors duration-fast",
        active ? "border-primary/40 bg-primary/10 text-primary" : "hover:bg-sidebar-accent"
      )}
    >
      <button onClick={onClick} aria-pressed={active} className={cn("inline-flex items-center gap-1 py-1 pl-2.5", onDelete ? "pr-1" : "pr-2.5")}>
        <Folder className="h-3 w-3" /> {children}
      </button>
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          aria-label="Delete folder"
          className="mr-1 rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/chip:opacity-100 coarse:opacity-100"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

function ConversationRow({
  conversation,
  active,
  renaming,
  setRenaming,
  projects,
  onUpdate,
  onRemove,
  onNavigate,
  onRequestConfirm,
}: {
  conversation: ClientConversation;
  active: boolean;
  renaming: boolean;
  setRenaming: (id: string | null) => void;
  projects: { id: string; name: string }[];
  onUpdate: (id: string, patch: Partial<ClientConversation>) => void;
  onRemove: (id: string) => void;
  onNavigate: () => void;
  onRequestConfirm: (c: ConfirmState) => void;
}) {
  const router = useRouter();
  const [draft, setDraft] = React.useState(conversation.title);

  const patch = async (data: Partial<Pick<ClientConversation, "title" | "pinned" | "folderId" | "projectId">>) => {
    onUpdate(conversation.id, data);
    const res = await fetch(`/api/conversations/${conversation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (!res.ok) toast.error("Update failed.");
  };

  const commitRename = () => {
    const title = draft.trim();
    setRenaming(null);
    if (title && title !== conversation.title) patch({ title });
  };

  const remove = () => {
    onRequestConfirm({
      title: "Delete this conversation?",
      description: "This permanently removes the conversation and its messages. This can't be undone.",
      confirmLabel: "Delete chat",
      onConfirm: async () => {
        onRemove(conversation.id);
        const res = await fetch(`/api/conversations/${conversation.id}`, { method: "DELETE" });
        if (!res.ok) {
          toast.error("Delete failed.");
          return;
        }
        if (active) {
          router.push("/chat");
          // Force ChatView to reset even if the URL was already /chat
          // (e.g. the chat was created on /chat and replaced via shallow URL).
          window.dispatchEvent(new CustomEvent("juno:new-chat"));
        }
      },
    });
  };

  if (renaming) {
    return (
      <div className="flex items-center gap-1 px-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoFocus
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(null);
          }}
          className="h-8"
        />
        <Button size="icon-sm" variant="ghost" onClick={commitRename} aria-label="Save">
          <Check className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group relative flex items-center rounded-md pr-1 transition-all duration-fast hover:translate-x-0.5",
        active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent"
      )}
    >
      <Link
        href={`/chat/${conversation.id}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn("flex min-w-0 flex-1 items-center gap-2 truncate px-3 py-2 text-[14px] font-medium text-sidebar-foreground/90 hover:text-foreground", active && "font-semibold text-foreground")}
        title={conversation.title}
      >
        {conversation.pinned && <Star className="h-3.5 w-3.5 shrink-0 fill-primary text-primary transition-transform duration-fast group-hover:scale-105" />}
        <span className="truncate">{conversation.title}</span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="rounded-sm p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
            aria-label="Conversation options"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={() => patch({ pinned: !conversation.pinned })}>
            <Star className={cn("h-4 w-4", conversation.pinned ? "fill-primary text-primary" : "")} />
            <span>{conversation.pinned ? "Unstar" : "Star"}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setDraft(conversation.title);
              setRenaming(conversation.id);
            }}
          >
            <Pencil className="h-4 w-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Box className="h-4 w-4" /> Add to project
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-56">
              <DropdownMenuItem onSelect={() => patch({ projectId: null })}>
                {conversation.projectId == null ? <Check className="h-4 w-4" /> : <span className="h-4 w-4" />} No project
              </DropdownMenuItem>
              {projects.map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => patch({ projectId: p.id })}>
                  {conversation.projectId === p.id ? <Check className="h-4 w-4" /> : <Box className="h-4 w-4" />}
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => router.push("/projects")}>
                <Plus className="h-4 w-4" /> New project…
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={remove}
            className="text-destructive focus:bg-destructive focus:text-destructive-foreground"
          >
            <Trash2 className="h-4 w-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
