"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { FileText, MessageSquare, Plus, Search, MoreVertical, Trash2, Pencil, SlidersHorizontal, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { AppIcons } from "@/lib/app-icons";
import { readStarredProjects, removeStarredProject, toggleStarredProject } from "@/lib/starred-projects";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { staggerDelay } from "@/lib/motion";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPageHeader } from "@/components/app/app-page-header";

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
        <AppPageHeader
          eyebrow="Projects"
          heading="Your projects"
          icon={AppIcons.projects}
          lede="A topic’s chats, instructions, and files, kept together."
          actions={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5 text-muted-foreground">
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

              <Button onClick={() => { setName(""); setOpen(true); }} size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" /> New project
              </Button>
            </>
          }
        />

        {/* Search — only once there is something to filter. Rendered
            unconditionally it sat a live "Search projects…" box directly on top of
            "No projects yet" on a brand-new account, and on top of the error
            message after a failed load. */}
        {!loading && !empty && !error && (
          <div className="relative mt-6">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              className="h-10 w-full pl-9"
            />
          </div>
        )}

        {error ? (
          <EmptyState
            tone="error"
            className="mt-10"
            title="Couldn’t load your projects"
            description="Check your connection and try once more."
            action={
              <Button variant="outline" size="sm" onClick={load}>Try again</Button>
            }
          />
        ) : loading ? (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {[...Array(6)].map((_, i) => (
              <div
                key={i}
                className="surface-raised flex h-40 flex-col justify-between rounded-card border border-border/70 p-5"
                style={staggerDelay(i)}
              >
                <div className="space-y-2.5">
                  <div className="skeleton h-4 w-1/2 rounded-full" style={staggerDelay(i)} />
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
          <EmptyState
            className="mt-10"
            icon={AppIcons.projects}
            title="No projects yet"
            description="Create one to keep a topic’s chats, instructions, and files together."
            action={
              <Button onClick={() => { setName(""); setOpen(true); }} className="gap-1.5">
                <Plus className="h-4 w-4" /> New project
              </Button>
            }
          />
        ) : filteredItems.length === 0 ? (
          // One no-results shape across projects / artifacts / library: panel size,
          // Search mark, "No matching …", ghost Clear filters.
          <EmptyState
            className="mt-6"
            size="panel"
            icon={Search}
            title="No matching projects"
            description="Try another search term."
            action={
              <Button variant="ghost" size="sm" onClick={() => setQuery("")} className="text-muted-foreground">
                Clear filters
              </Button>
            }
          />
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {filteredItems.map((p, i) => (
              // No fixed height: an explicit one beats the grid's stretch, so a row
              // pairing a cover card (260px) with a plain one (160px) left ~100px of
              // dead space under the short card. Only the cover strip is sized now.
              // `interactive` rather than a hand-rolled hover — the local version wore
              // shadow-float (the out-of-flow rung, outranking every dropdown) and
              // transition-all, both of which card.tsx calls out by name.
              <Card
                key={p.id}
                variant="interactive"
                style={staggerDelay(i)}
                className="relative flex h-full min-h-40 flex-col justify-between overflow-hidden rounded-card p-0 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
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
                        {/* Stretched link: the whole card used to be a div with an
                            onClick, so a keyboard user could only reach this title —
                            the cover, the preview and the footer were all inert. The
                            `after` overlay makes the card one real link and removes
                            the `closest("button")` hit-test the onClick needed. */}
                        <Link
                          href={`/projects/${p.id}`}
                          className="flex-1 truncate font-serif text-lg font-semibold outline-none transition-colors hover:text-primary after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-primary/40"
                        >
                          {p.name}
                        </Link>

                        {/* Card actions menu — above the stretched link. */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Actions for ${p.name}`}
                              className="relative z-10 h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
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
                            {/* Tint, not an inverted fill — the family's one destructive
                                focus treatment until DropdownMenuItem gains a variant. */}
                            <DropdownMenuItem onSelect={() => setDeletingProject(p)} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
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
