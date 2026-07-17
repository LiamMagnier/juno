"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, FileText, MessageSquare, Plus, Search, MoreVertical, Trash2, Pencil, SlidersHorizontal, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { readStarredProjects, removeStarredProject, toggleStarredProject } from "@/lib/starred-projects";
import { timeAgo } from "@/components/roadmap/roadmap-ui";

interface ProjectItem {
  id: string;
  name: string;
  instructions: string;
  updatedAt: string;
  conversationCount: number;
  fileCount: number;
  coverUrl?: string | null;
}

export default function ProjectsPage() {
  const router = useRouter();
  const [items, setItems] = React.useState<ProjectItem[] | null>(null);
  const [error, setError] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  // Search & Sort states
  const [query, setQuery] = React.useState("");
  const [sortBy, setSortBy] = React.useState<"updated" | "name" | "conversations">("updated");

  // Actions dialog states
  const [editingProject, setEditingProject] = React.useState<ProjectItem | null>(null);
  const [starred, setStarred] = React.useState<string[]>([]);
  const [renameName, setRenameName] = React.useState("");
  const [renaming, setRenaming] = React.useState(false);

  const [deletingProject, setDeletingProject] = React.useState<ProjectItem | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/projects");
      if (!r.ok) throw new Error();
      setItems((await r.json()).projects);
    } catch {
      setError(true);
      setItems([]);
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  // Hydrate after mount: localStorage doesn't exist during SSR, so reading it in
  // the initial state would break hydration. Also re-read on projects:sync so a
  // star toggled in the sidebar or on a detail page shows up here.
  React.useEffect(() => {
    const sync = () => setStarred(readStarredProjects());
    sync();
    window.addEventListener("projects:sync", sync);
    return () => window.removeEventListener("projects:sync", sync);
  }, []);

  const create = async () => {
    setCreating(true);
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // No name → created as "Untitled project" and auto-named from its first chat.
        body: JSON.stringify({ name: name.trim() || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not create project.");
      router.push(`/projects/${d.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
      setCreating(false);
    }
  };

  const rename = async () => {
    if (!editingProject || !renameName.trim()) return;
    setRenaming(true);
    try {
      const r = await fetch(`/api/projects/${editingProject.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: renameName.trim() }),
      });
      if (!r.ok) throw new Error();
      setItems((cur) =>
        cur ? cur.map((p) => (p.id === editingProject.id ? { ...p, name: renameName.trim() } : p)) : null
      );
      toast.success("Project renamed.");
      window.dispatchEvent(new CustomEvent("projects:sync"));
      setEditingProject(null);
    } catch {
      toast.error("Could not rename project.");
    } finally {
      setRenaming(false);
    }
  };

  const deleteProject = async () => {
    if (!deletingProject) return;
    setDeleting(true);
    try {
      const r = await fetch(`/api/projects/${deletingProject.id}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      setItems((cur) => (cur ? cur.filter((p) => p.id !== deletingProject.id) : null));
      toast.success("Project deleted.");
      // A deleted project must not linger as a ghost star in the sidebar.
      setStarred(removeStarredProject(deletingProject.id));
      window.dispatchEvent(new CustomEvent("projects:sync"));
      setDeletingProject(null);
    } catch {
      toast.error("Could not delete project.");
    } finally {
      setDeleting(false);
    }
  };

  // Search and sorting filter logic
  const filteredItems = React.useMemo(() => {
    if (!items) return [];
    let result = [...items];

    if (query.trim()) {
      const q = query.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.instructions.toLowerCase().includes(q)
      );
    }

    result.sort((a, b) => {
      if (sortBy === "name") {
        return a.name.localeCompare(b.name);
      }
      if (sortBy === "conversations") {
        return b.conversationCount - a.conversationCount;
      }
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });

    return result;
  }, [items, query, sortBy]);

  const loading = items === null;
  const empty = !loading && items.length === 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        {/* Header Block — flex-wrap: the sort + new-project cluster (~270px) plus
            the title can't share one 360px row; below ~560px the actions drop to
            their own line instead of overflowing the container. */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat" className="hover:bg-accent/40 rounded-md">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <h1 className="font-serif text-3xl font-medium tracking-tight">Projects</h1>
          </div>
          
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs text-muted-foreground">
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  Sort by: <span className="font-semibold text-foreground">{sortBy === "updated" ? "Last updated" : sortBy === "name" ? "Name" : "Conversations"}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onSelect={() => setSortBy("updated")}>
                  Last updated
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSortBy("name")}>
                  Name
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setSortBy("conversations")}>
                  Conversations
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              onClick={() => { setName(""); setOpen(true); }}
              size="sm"
              className="h-9 gap-1.5 text-xs"
            >
              <Plus className="h-4 w-4" /> New project
            </Button>
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative mb-6">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects…"
            className="h-10 w-full pl-9"
          />
        </div>

        {error ? (
          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Couldn’t load your projects.</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </div>
        ) : loading ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="surface-raised flex h-40 flex-col justify-between rounded-[28px] border border-border/70 p-5"
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <div className="space-y-2.5">
                  <div className="skeleton h-4 w-1/2 rounded-full" style={{ animationDelay: `${i * 50}ms` }} />
                  <div className="skeleton h-3 w-4/5 rounded-full" style={{ animationDelay: `${i * 50 + 40}ms` }} />
                  <div className="skeleton h-3 w-3/5 rounded-full" style={{ animationDelay: `${i * 50 + 80}ms` }} />
                </div>
                <div className="flex items-center justify-between border-t border-border/40 pt-3">
                  <div className="skeleton h-2.5 w-20 rounded-full" style={{ animationDelay: `${i * 50 + 120}ms` }} />
                  <div className="skeleton h-2.5 w-10 rounded-full" style={{ animationDelay: `${i * 50 + 160}ms` }} />
                </div>
              </div>
            ))}
          </div>
        ) : empty ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <div>
              <p className="font-serif text-heading">No projects yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Create one to keep a topic’s chats, instructions, and files together.</p>
            </div>
            <Button onClick={() => { setName(""); setOpen(true); }} className="gap-1.5">
              <Plus className="h-4 w-4" /> New project
            </Button>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">No projects match your search.</p>
            <Button variant="outline" size="sm" onClick={() => setQuery("")}>Clear search</Button>
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {filteredItems.map((p, i) => (
              <Card
                key={p.id}
                variant="default"
                style={{ animationDelay: `${Math.min(i, 12) * 40}ms` }}
                className={cn(
                  "overflow-hidden p-0 motion-safe:animate-rise-in [animation-fill-mode:backwards] flex flex-col justify-between rounded-[28px] hover:-translate-y-1 hover:border-border hover:shadow-float transition-all duration-base cursor-pointer",
                  p.coverUrl ? "h-[260px]" : "h-[160px]"
                )}
                onClick={(e) => {
                  const target = e.target as HTMLElement;
                  if (target.closest("button") || target.closest("[role='menuitem']")) {
                    return;
                  }
                  router.push(`/projects/${p.id}`);
                }}
              >
                <div className="flex-1 flex flex-col min-h-0">
                  {/* Render Cover Image only if explicitly set */}
                  {p.coverUrl && (
                    <div className="relative h-28 w-full overflow-hidden bg-muted border-b shrink-0">
                      <img src={p.coverUrl} className="h-full w-full object-cover" alt="" />
                    </div>
                  )}

                  {/* Card Body */}
                  <div className="p-5 pb-0 flex-1 flex flex-col justify-between min-h-0">
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <Link href={`/projects/${p.id}`} className="font-serif text-lg font-semibold truncate hover:text-primary transition-colors flex-1 outline-none">
                          {p.name}
                        </Link>
                        
                        {/* Card actions menu */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Project actions"
                              className="h-6 w-6 rounded-md text-muted-foreground hover:text-foreground shrink-0"
                            >
                              <MoreVertical className="h-3.5 w-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem onSelect={() => setStarred(toggleStarredProject(p.id))}>
                              {starred.includes(p.id) ? (
                                <>
                                  <PinOff className="h-4 w-4 mr-2" />
                                  <span>Unpin</span>
                                </>
                              ) : (
                                <>
                                  <Pin className="h-4 w-4 mr-2" />
                                  <span>Pin</span>
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => { setEditingProject(p); setRenameName(p.name); }}>
                              <Pencil className="h-4 w-4 mr-2" />
                              <span>Rename</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={() => setDeletingProject(p)} className="text-destructive focus:bg-destructive focus:text-destructive-foreground">
                              <Trash2 className="h-4 w-4 mr-2" />
                              <span>Delete</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {/* Preview of instructions */}
                      <p className="mt-2 text-xs text-muted-foreground/80 line-clamp-2 leading-relaxed">
                        {p.instructions ? p.instructions : "No instructions set."}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Card Footer (Metadata) */}
                <div className="px-5 pb-4 pt-3 border-t border-border/40 flex items-center justify-between text-[11px] text-muted-foreground bg-muted/10 font-mono shrink-0">
                  <span>Updated {timeAgo(p.updatedAt)}</span>
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-0.5" title={`${p.conversationCount} chats`}><MessageSquare className="h-3 w-3" /> {p.conversationCount}</span>
                    <span>•</span>
                    <span className="flex items-center gap-0.5" title={`${p.fileCount} files`}><FileText className="h-3 w-3" /> {p.fileCount - (p.coverUrl ? 1 : 0)}</span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">New project</DialogTitle>
            <DialogDescription>Name it, or leave it blank and Juno will name it from your first chat.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="proj-name">Project name <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              id="proj-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Leave blank to auto-name it"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") create();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={create} disabled={creating}>{creating ? "Creating…" : "Create project"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Dialog */}
      <Dialog open={editingProject !== null} onOpenChange={(v) => { if (!v) setEditingProject(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">Rename project</DialogTitle>
            <DialogDescription>Change the name of this project.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-name">Project name</Label>
            <Input
              id="rename-name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder="New project name"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") rename();
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditingProject(null)}>Cancel</Button>
            <Button onClick={rename} disabled={renaming || !renameName.trim()}>{renaming ? "Renaming…" : "Rename project"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Dialog */}
      <Dialog open={deletingProject !== null} onOpenChange={(v) => { if (!v) setDeletingProject(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">Delete this project?</DialogTitle>
            <DialogDescription>
              Its chats are kept (just unlinked), but the project’s instructions and files are removed. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeletingProject(null)}>Cancel</Button>
            <Button variant="destructive" onClick={deleteProject} disabled={deleting}>{deleting ? "Deleting…" : "Delete project"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
