"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { FileText, MessageSquare, Plus, Search, Pin, PinOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Pressable } from "@/components/ui/pressable";
import { Skeleton } from "@/components/ui/skeleton";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { removeStarredProject } from "@/lib/starred-projects";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { promptPreview } from "@/lib/prompt-preview";

interface ProjectItem {
  id: string;
  name: string;
  instructions: string;
  updatedAt: string;
  conversationCount: number;
  fileCount: number;
  coverUrl?: string | null;
  starred?: boolean;
}

type SortBy = "updated" | "name" | "conversations";
type Filter = "all" | "pinned";

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "updated", label: "Last updated" },
  { value: "name", label: "Name" },
  { value: "conversations", label: "Most chats" },
];

export default function ProjectsPage() {
  const router = useRouter();
  const [items, setItems] = React.useState<ProjectItem[] | null>(null);
  const [error, setError] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  // Search, filter & sort
  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sortBy, setSortBy] = React.useState<SortBy>("updated");

  // Actions dialog states
  const [editingProject, setEditingProject] = React.useState<ProjectItem | null>(null);
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

  React.useEffect(() => {
    const handleSync = () => {
      load();
    };
    window.addEventListener("projects:sync", handleSync);
    window.addEventListener("starred:sync", handleSync);
    return () => {
      window.removeEventListener("projects:sync", handleSync);
      window.removeEventListener("starred:sync", handleSync);
    };
  }, [load]);

  const toggleStar = async (project: ProjectItem) => {
    const next = !project.starred;
    setItems((cur) =>
      cur ? cur.map((p) => (p.id === project.id ? { ...p, starred: next } : p)) : null
    );
    try {
      const r = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred: next }),
      });
      if (!r.ok) throw new Error();
      toast.success(next ? "Project pinned!" : "Project unpinned.");
      window.dispatchEvent(new CustomEvent("starred:sync"));
      window.dispatchEvent(new CustomEvent("projects:sync"));
    } catch {
      setItems((cur) =>
        cur ? cur.map((p) => (p.id === project.id ? { ...p, starred: !next } : p)) : null
      );
      toast.error("Could not update project pin.");
    }
  };

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
      removeStarredProject(deletingProject.id);
      window.dispatchEvent(new CustomEvent("starred:sync"));
      window.dispatchEvent(new CustomEvent("projects:sync"));
      setDeletingProject(null);
    } catch {
      toast.error("Could not delete project.");
    } finally {
      setDeleting(false);
    }
  };

  const openCreate = () => {
    setName("");
    setOpen(true);
  };

  const pinnedCount = React.useMemo(() => (items ?? []).filter((p) => p.starred).length, [items]);

  // Search, filter and sort
  const filteredItems = React.useMemo(() => {
    if (!items) return [];
    let result = [...items];

    if (filter === "pinned") result = result.filter((p) => p.starred);

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
  }, [items, query, filter, sortBy]);

  const loading = items === null;
  const empty = !loading && items.length === 0;
  const filtering = query.trim().length > 0 || filter !== "all";

  return (
    <AppPage measure="wide">
      <AppPageHeader
        eyebrow="Projects"
        heading="Projects"
        icon={AppIcons.projects}
        lede="A topic’s chats, instructions, and files, kept together."
        actions={
          <Button onClick={openCreate} size="sm" className="gap-1.5">
            <Plus className="size-4" aria-hidden="true" /> New project
          </Button>
        }
      />

      {/* Toolbar — only once there is something to filter. Rendered
          unconditionally it sat a live "Search projects…" box directly on top of
          "No projects yet" on a brand-new account, and on top of the error
          message after a failed load. */}
      {!loading && !empty && !error && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              className="pl-9"
            />
          </div>
          <SegmentedControl
            value={filter}
            onChange={setFilter}
            ariaLabel="Filter projects"
            options={[
              { value: "all", label: "All", count: items.length },
              { value: "pinned", label: "Pinned", count: pinnedCount },
            ]}
          />
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
            <SelectTrigger className="w-44" aria-label="Sort projects">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto font-mono text-caption tabular-nums text-muted-foreground">
            {filteredItems.length} of {items.length}
          </span>
        </div>
      )}

      {error ? (
        <EmptyState
          tone="error"
          className="mt-6"
          title="Couldn’t load your projects"
          description="Check your connection and try once more."
          action={
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          }
        />
      ) : loading ? (
        <ProjectsGridSkeleton />
      ) : empty ? (
        <EmptyState
          className="mt-6"
          icon={AppIcons.projects}
          title="No projects yet"
          description="Create one to keep a topic’s chats, instructions, and files together."
          action={
            <Button onClick={openCreate} className="gap-1.5">
              <Plus className="size-4" aria-hidden="true" /> New project
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
          description={filter === "pinned" && !query ? "Pin a project to see it here." : "Try another search term."}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setQuery("");
                setFilter("all");
              }}
              className="text-muted-foreground"
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Projects">
          {filteredItems.map((p, i) => (
            <li
              key={p.id}
              className="min-w-0 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i)}
            >
              <ProjectTile
                project={p}
                onToggleStar={() => toggleStar(p)}
                onRename={() => {
                  setEditingProject(p);
                  setRenameName(p.name);
                }}
                onDelete={() => setDeletingProject(p)}
              />
            </li>
          ))}
          {!filtering && (
            <li
              className="min-w-0 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(filteredItems.length)}
            >
              <button
                type="button"
                onClick={openCreate}
                className="surface-inset flex h-full min-h-40 w-full items-center justify-center gap-2 rounded-card border-dashed border-border/80 p-4 text-sm text-muted-foreground transition-[color,border-color] duration-fast ease-out-soft hover:border-foreground/30 hover:text-foreground motion-reduce:transition-none"
              >
                <Plus className="size-4" aria-hidden="true" />
                New project
              </button>
            </li>
          )}
        </ul>
      )}

      {/* Create Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>Name it, or leave it blank and Juno will name it from your first chat.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="proj-name">Project name <span className="font-normal text-muted-foreground">(optional)</span></Label>
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
            <DialogTitle>Rename project</DialogTitle>
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
            <DialogTitle>Delete this project?</DialogTitle>
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
    </AppPage>
  );
}

/**
 * One project in the grid — the house tile: icon tile, name, two-line
 * instructions preview, metadata footer. The whole tile is one link (the name
 * carries a stretched `after:` overlay); the pin and the menu sit above it.
 */
function ProjectTile({
  project: p,
  onToggleStar,
  onRename,
  onDelete,
}: {
  project: ProjectItem;
  onToggleStar: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const FolderIcon = AppIcons.projects;
  const fileCount = Math.max(0, p.fileCount - (p.coverUrl ? 1 : 0));
  return (
    <Card variant="interactive" className="group relative flex h-full min-h-40 flex-col p-4">
      <div className="flex items-start gap-3">
        {p.coverUrl ? (
          <span className="surface-inset flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-field">
            <img src={p.coverUrl} className="size-full object-cover" alt="" />
          </span>
        ) : (
          <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground">
            <FolderIcon className="size-4" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 flex-1 pt-0.5">
          <Link
            href={`/projects/${p.id}`}
            className="block truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {p.name}
          </Link>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {promptPreview(p.instructions) || "No instructions yet."}
          </p>
        </div>

        {/* Tile actions — above the stretched link. The pin stays visible while
            pinned; otherwise it, like the menu, arrives on hover or focus. */}
        <div
          className={cn(
            "relative z-10 -mr-1 -mt-1 flex shrink-0 items-center gap-0.5 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100 motion-reduce:transition-none",
            p.starred ? "opacity-100" : "opacity-0"
          )}
        >
          <Pressable
            kind="icon"
            size="sm"
            selected={!!p.starred}
            aria-pressed={!!p.starred}
            aria-label={p.starred ? `Unpin ${p.name}` : `Pin ${p.name}`}
            onClick={onToggleStar}
            className={cn(p.starred && "text-primary hover:text-primary")}
          >
            <Pin className={cn("size-3.5", p.starred && "fill-current")} aria-hidden="true" />
          </Pressable>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pressable kind="icon" size="sm" aria-label={`Actions for ${p.name}`}>
                <ActionIcons.more className="size-3.5" aria-hidden="true" />
              </Pressable>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onSelect={onToggleStar}>
                {p.starred ? (
                  <>
                    <PinOff className="mr-2 size-4" aria-hidden="true" />
                    <span>Unpin</span>
                  </>
                ) : (
                  <>
                    <Pin className="mr-2 size-4" aria-hidden="true" />
                    <span>Pin</span>
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onRename}>
                <ActionIcons.edit className="mr-2 size-4" aria-hidden="true" />
                <span>Rename</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:bg-destructive/10 focus:text-destructive">
                <ActionIcons.delete className="mr-2 size-4" aria-hidden="true" />
                <span>Delete</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-3 font-mono text-caption tabular-nums text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1" title={`${p.conversationCount} chats`}>
            <MessageSquare className="size-3" aria-hidden="true" /> {p.conversationCount}
          </span>
          <span className="inline-flex items-center gap-1" title={`${fileCount} files`}>
            <FileText className="size-3" aria-hidden="true" /> {fileCount}
          </span>
        </div>
        <span>Updated {timeAgo(p.updatedAt)}</span>
      </div>
    </Card>
  );
}

/** The grid, in placeholder form — identical to `loading.tsx` so nothing shifts. */
function ProjectsGridSkeleton() {
  return (
    <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading projects">
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          className="surface-raised flex min-h-40 flex-col rounded-card p-4 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
          style={staggerDelay(i)}
        >
          <div className="flex items-start gap-3">
            <Skeleton className="size-9 shrink-0 rounded-field" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-4/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
          <div className="mt-auto flex items-center justify-between border-t border-border/60 pt-3">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-2.5 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}
