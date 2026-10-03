"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { FileText, MessageSquare, Plus, Search, Pin, PinOff } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Pressable } from "@/components/ui/pressable";
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
import { MENU_W } from "@/components/ui/menu-recipe";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import { removeStarredProject } from "@/lib/starred-projects";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { promptPreview } from "@/lib/prompt-preview";
import { IconSwap } from "@/components/ui/icon-swap";
import { ProjectsGridSkeleton } from "@/components/projects/projects-grid-skeleton";
import { PRODUCT_NAME } from "@/lib/brand/names";

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
      // No success toast: the pin turns over under the pointer (IconSwap) and
      // the row moves in the sidebar, so a corner notification would be a
      // second voice announcing what the reader just watched happen.
      window.dispatchEvent(new CustomEvent("starred:sync"));
      window.dispatchEvent(new CustomEvent("projects:sync"));
    } catch {
      setItems((cur) =>
        cur ? cur.map((p) => (p.id === project.id ? { ...p, starred: !next } : p)) : null
      );
      toast.error("Couldn’t update project pin.");
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
      if (!r.ok) throw new Error(d.error ?? "Couldn’t create project.");
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
      // The new name is on the card the dialog closes onto; no toast.
      window.dispatchEvent(new CustomEvent("projects:sync"));
      setEditingProject(null);
    } catch {
      toast.error("Couldn’t rename project.");
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
      toast.error("Couldn’t delete project.");
    } finally {
      setDeleting(false);
    }
  };

  const openCreate = () => {
    setName("");
    setOpen(true);
  };

  // `/projects?new=1` (the sidebar's + on the Projects section) lands with
  // the create dialog already open, then drops the flag from the URL so a
  // refresh or a back-navigation does not reopen it. Read off `location`
  // rather than useSearchParams, which would ask for a Suspense boundary
  // around a page that is otherwise plain.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("new") !== "1") return;
    url.searchParams.delete("new");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    setName("");
    setOpen(true);
  }, []);

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
        backdrop
        heading={<span className="tracking-[-0.03em]">Projects</span>}
        lede="A topic’s chats, instructions, and files, kept together."
        actions={
          /* Withheld while the page is empty, on the same argument the toolbar
             below is withheld on: the empty state already draws this button,
             in the same accent, 260px away, with a sentence explaining what it
             makes. Two identical primary buttons on one screen is not two
             chances to find it — it is a reader deciding which one is real. */
          empty ? undefined : (
            <Button onClick={openCreate}>
              <Plus className="size-4" aria-hidden="true" /> New project
            </Button>
          )
        }
      />

      {/* Toolbar — only once there is something to filter. Rendered
          unconditionally it sat a live "Search projects…" box directly on top of
          "No projects yet" on a brand-new account, and on top of the error
          message after a failed load. */}
      {!loading && !empty && !error && (
        // One row: the search takes the room (at least 16rem), the filter and
        // the sort sit together on the right edge. No free-floating "N of M":
        // the segments carry both counts, and while a search narrows the grid
        // its result count sits inside the field, beside what was typed.
        // Under 40rem of column the search takes its own line and the two
        // controls share the next, each half the width.
        <div className="flex flex-wrap items-center gap-2 [animation-fill-mode:backwards] motion-safe:animate-rise-in">
          <div className="relative w-full @[40rem]/page:w-auto @[40rem]/page:min-w-64 @[40rem]/page:flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              aria-label="Search projects"
              className={cn("pl-9", query.trim() && "pr-16")}
            />
            {query.trim() && (
              <span
                aria-live="polite"
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-caption tabular-nums text-muted-foreground motion-safe:animate-fade-in"
              >
                {filteredItems.length} of {items.length}
              </span>
            )}
          </div>
          <div className="flex w-full items-center gap-2 @[40rem]/page:w-auto">
            <SegmentedControl
              value={filter}
              onChange={setFilter}
              ariaLabel="Filter projects"
              className="h-9 flex-1 coarse:h-11 @[40rem]/page:flex-none"
              options={[
                { value: "all", label: "All", count: items.length },
                { value: "pinned", label: "Pinned", count: pinnedCount },
              ]}
            />
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
              <SelectTrigger className="min-w-0 flex-1 @[40rem]/page:w-40 @[40rem]/page:flex-none" aria-label="Sort projects">
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
          </div>
        </div>
      )}

      {error ? (
        <LoadError title="Couldn’t load your projects" onRetry={load} />
      ) : loading ? (
        <ProjectsGridSkeleton />
      ) : empty ? (
        <EmptyState
          className="mt-6"
          icon={AppIcons.projects}
          title="No projects yet"
          description="Create one to keep a topic’s chats, instructions, and files together."
          action={
            <Button onClick={openCreate}>
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
        // Three across from a 64rem CONTENT COLUMN, not a 1024px window. The
        // column loses 240px at exactly the window where `lg:` fired — the
        // sidebar stops floating and starts pushing — so 1023 drew two 447px
        // cards and 1024 drew three at 213. The same recipe on every card grid
        // in the app pages (connections, assistants, a project's work and code
        // lists, and each one's skeleton).
        <ul className="ed-arrive mt-6 grid gap-3 @[30rem]/page:grid-cols-2 @[42rem]/page:grid-cols-3" aria-label="Projects">
          {filteredItems.map((p, i) => (
            <li
              key={p.id}
              className="min-w-0 [animation-fill-mode:backwards] motion-safe:animate-rise-in"
              style={staggerDelay(i, "base", 60)}
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
              style={staggerDelay(filteredItems.length, "base", 60)}
            >
              <button
                type="button"
                onClick={openCreate}
                className="group/new flex h-full min-h-40 w-full items-center justify-center gap-2 rounded-card border border-dashed border-foreground/[.12] p-4 text-ui font-medium text-muted-foreground transition-[color,border-color,background-color,transform] duration-fast ease-out-soft hover:border-foreground/25 hover:bg-foreground/[.025] hover:text-foreground active:scale-[.99] motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <Plus className="size-4 transition-transform duration-base ease-out-expo group-hover/new:rotate-90 motion-reduce:transition-none" aria-hidden="true" />
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
            <DialogDescription>{`Name it, or leave it blank and ${PRODUCT_NAME} will name it from your first chat.`}</DialogDescription>
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
            <Button onClick={create} loading={creating}>Create project</Button>
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
            <Button onClick={rename} loading={renaming} disabled={!renameName.trim()}>Rename project</Button>
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
            <Button variant="destructive" onClick={deleteProject} loading={deleting}>Delete project</Button>
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
    // `data-icon-trigger`: the whole tile is the link (the name's stretched
    // overlay), so the folder should answer the pointer anywhere on it, not
    // only over the name. Hover is tonal and owned by the interactive variant —
    // the tile changes shade, it does not lift (ICONS_AND_MOTION §2.2).
    // The house card on the homepage's finish: a quiet raised surface whose
    // hairline firms up and which rises a single pixel on hover (160ms, the
    // soft decelerate), and settles to .99 while it is held.
    <Card
      data-icon-trigger=""
      className="group relative flex h-full flex-col p-4 transition-[border-color,background-color,transform] duration-fast ease-out-soft hover:border-foreground/[.12] hover:bg-foreground/[.015] focus-within:border-foreground/20 active:scale-[.99] motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-reduce:transition-none"
    >
      {/* The mark and the tile's actions share the top row; the name and the
          preview get the card's whole width under them. With the name beside
          the mark, the preview wrapped at a third of the tile, next to an
          empty column the hover-only actions were holding open. */}
      <div className="flex items-start justify-between gap-3">
        {p.coverUrl ? (
          <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-control border border-foreground/[.08]">
            <img src={p.coverUrl} className="size-full object-cover" alt="" />
          </span>
        ) : (
          <span className="flex size-7 shrink-0 items-center justify-center rounded-control border border-foreground/[.08] bg-foreground/[.025] text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground motion-reduce:transition-none">
            <FolderIcon className="size-3.5" aria-hidden="true" />
          </span>
        )}

        {/* Tile actions — above the stretched link. The pin stays visible while
            pinned; otherwise it, like the menu, arrives on hover or focus. */}
        <div
          className={cn(
            "relative z-10 -mr-1 flex shrink-0 items-center gap-0.5 transition-opacity duration-fast ease-out-soft focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100 motion-reduce:transition-none",
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
            title={p.starred ? "Unpin" : "Pin"}
            className={cn(p.starred && "text-primary hover:text-primary")}
          >
            {/* `motion="none"`: the tile is an icon trigger, so an articulated
                pin would sit tilted for as long as the pointer was anywhere on
                the card. The swap itself is the feedback here. */}
            <IconSwap
              swapped={!!p.starred}
              from={<Pin motion="none" className="size-3.5" />}
              to={<Pin motion="none" weight="fill" className="size-3.5" />}
            />
          </Pressable>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Pressable kind="icon" size="sm" aria-label={`Actions for ${p.name}`} title="More actions">
                <ActionIcons.more className="size-3.5" aria-hidden="true" />
              </Pressable>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={MENU_W}>
              <DropdownMenuItem onSelect={onToggleStar}>
                {p.starred ? (
                  <>
                    <PinOff className="size-4" aria-hidden="true" />
                    <span>Unpin</span>
                  </>
                ) : (
                  <>
                    <Pin className="size-4" aria-hidden="true" />
                    <span>Pin</span>
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onRename}>
                <ActionIcons.edit className="size-4" aria-hidden="true" />
                <span>Rename</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onDelete} variant="destructive">
                <ActionIcons.delete className="size-4" aria-hidden="true" />
                <span>Delete</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Link
        href={`/projects/${p.id}`}
        className="mt-3 block truncate text-body font-medium tracking-[-0.011em] text-foreground outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
      >
        {p.name}
      </Link>
      {/* Two lines held open even when the text needs one, so every card in
          a row is the same height without a min-height doing it. */}
      <p className="mt-0.5 line-clamp-2 min-h-[2lh] text-caption leading-relaxed text-muted-foreground">
        {promptPreview(p.instructions) || "No instructions yet."}
      </p>

      {/* Counts and recency in the interface face: they are furniture read
          at a glance, not telemetry, and in mono they read as a log line. */}
      <div className="mt-auto pt-3">
      <div className="flex items-center justify-between gap-3 border-t border-foreground/[.07] pt-3 text-caption tabular-nums text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5" title={`${p.conversationCount} chats`}>
            <MessageSquare className="size-3.5" aria-hidden="true" /> {p.conversationCount}
          </span>
          <span className="inline-flex items-center gap-1.5" title={`${fileCount} files`}>
            <FileText className="size-3.5" aria-hidden="true" /> {fileCount}
          </span>
        </div>
        <span className="truncate">Updated {timeAgo(p.updatedAt)}</span>
      </div>
      </div>
    </Card>
  );
}
