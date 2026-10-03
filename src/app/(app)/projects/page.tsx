"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Search } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RollingNumber } from "@/components/ui/micro";
import { removeStarredProject } from "@/lib/starred-projects";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage } from "@/components/app/app-page";
import { PageHero } from "@/components/app/editorial";
import { ProjectsGridSkeleton } from "@/components/projects/projects-grid-skeleton";
import { ProjectsOrbit } from "@/components/projects/projects-orbit";
import { ProjectCover } from "@/components/projects/project-cover";
import {
  DeleteProjectDialog,
  MoveToDialog,
  ProjectNameDialog,
  ProjectTile,
  pathOf,
  type FolderProject,
  type MoveSubject,
  type ProjectDrag,
} from "@/components/projects/project-folders";
import { MOVE_REFUSAL_MESSAGES, type DeleteChildrenMode, type MoveRefusal } from "@/lib/projects/project-tree";

interface ProjectItem extends FolderProject {
  instructions: string;
  updatedAt: string;
  conversationCount: number;
  fileCount: number;
}

type SortBy = "updated" | "name" | "conversations";
type Filter = "all" | "pinned";

const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "updated", label: "Last updated" },
  { value: "name", label: "Name" },
  { value: "conversations", label: "Most chats" },
];

type NameDialog = { mode: "create" } | { mode: "folder"; parent: ProjectItem } | { mode: "rename"; project: ProjectItem };

/**
 * The account's projects. The top level as tiles, each listing the folders it
 * holds; a search looks through every level and says where each match sits.
 * Folders are made from a tile's menu or inside a project, moved with Move to…
 * or by dragging one tile onto another.
 */
export default function ProjectsPage() {
  const router = useRouter();
  const [items, setItems] = React.useState<ProjectItem[] | null>(null);
  const [error, setError] = React.useState(false);

  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<Filter>("all");
  const [sortBy, setSortBy] = React.useState<SortBy>("updated");

  const [nameDialog, setNameDialog] = React.useState<NameDialog | null>(null);
  const [nameBusy, setNameBusy] = React.useState(false);
  const [moving, setMoving] = React.useState<MoveSubject | null>(null);
  const [moveBusy, setMoveBusy] = React.useState(false);
  const [deleting, setDeleting] = React.useState<ProjectItem | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/projects");
      if (!r.ok) throw new Error();
      const body = await r.json();
      setItems((body.projects as ProjectItem[]).map((p) => ({ ...p, parentId: p.parentId ?? null })));
    } catch {
      setError(true);
      setItems([]);
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    const handleSync = () => load();
    window.addEventListener("projects:sync", handleSync);
    window.addEventListener("starred:sync", handleSync);
    return () => {
      window.removeEventListener("projects:sync", handleSync);
      window.removeEventListener("starred:sync", handleSync);
    };
  }, [load]);

  // `/projects?new=1` (the sidebar's + on the Projects section) lands with the
  // create dialog open, then drops the flag so a refresh does not reopen it.
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("new") !== "1") return;
    url.searchParams.delete("new");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
    setNameDialog({ mode: "create" });
  }, []);

  const broadcast = () => {
    window.dispatchEvent(new CustomEvent("starred:sync"));
    window.dispatchEvent(new CustomEvent("projects:sync"));
  };

  const toggleStar = async (project: ProjectItem) => {
    const next = !project.starred;
    setItems((cur) => (cur ? cur.map((p) => (p.id === project.id ? { ...p, starred: next } : p)) : null));
    try {
      const r = await fetch(`/api/projects/${project.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ starred: next }),
      });
      if (!r.ok) throw new Error();
      // No toast: the pin turns over under the pointer.
      broadcast();
    } catch {
      setItems((cur) => (cur ? cur.map((p) => (p.id === project.id ? { ...p, starred: !next } : p)) : null));
      toast.error("Couldn’t update project pin.");
    }
  };

  const submitName = async (name: string) => {
    if (!nameDialog) return;
    setNameBusy(true);
    try {
      if (nameDialog.mode === "rename") {
        const r = await fetch(`/api/projects/${nameDialog.project.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!r.ok) throw new Error("Couldn’t rename project.");
        setItems((cur) => (cur ? cur.map((p) => (p.id === nameDialog.project.id ? { ...p, name } : p)) : null));
        window.dispatchEvent(new CustomEvent("projects:sync"));
        setNameDialog(null);
        return;
      }
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || undefined,
          ...(nameDialog.mode === "folder" ? { parentId: nameDialog.parent.id } : {}),
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn’t create project.");
      window.dispatchEvent(new CustomEvent("projects:sync"));
      router.push(`/projects/${d.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setNameBusy(false);
    }
  };

  const moveProject = async (id: string, parentId: string | null) => {
    const before = items;
    setItems((cur) => (cur ? cur.map((p) => (p.id === id ? { ...p, parentId } : p)) : null));
    const r = await fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parentId }),
    }).catch(() => null);
    if (!r || !r.ok) {
      setItems(before);
      const d = r ? await r.json().catch(() => ({})) : {};
      toast.error(d.reason ? MOVE_REFUSAL_MESSAGES[d.reason as MoveRefusal] : "Couldn’t move project.");
      return false;
    }
    const target = parentId ? items?.find((p) => p.id === parentId)?.name : null;
    toast.success(target ? `Moved into ${target}.` : "Moved to the top level.");
    window.dispatchEvent(new CustomEvent("projects:sync"));
    return true;
  };

  const moveChat = async (chatId: string, projectId: string | null) => {
    const r = await fetch(`/api/conversations/${chatId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    }).catch(() => null);
    if (!r || !r.ok) {
      toast.error("Couldn’t move chat.");
      return;
    }
    toast.success("Chat moved.");
    load();
  };

  const onDropInto = (targetId: string) => (drag: ProjectDrag) => {
    if (drag.kind === "project") void moveProject(drag.id, targetId);
    else void moveChat(drag.id, targetId);
  };

  const confirmMove = async (targetId: string | null) => {
    if (!moving || moving.kind !== "project") return;
    setMoveBusy(true);
    const ok = await moveProject(moving.id, targetId);
    setMoveBusy(false);
    if (ok) setMoving(null);
  };

  const confirmDelete = async (mode: DeleteChildrenMode) => {
    if (!deleting) return;
    setDeleteBusy(true);
    try {
      const r = await fetch(`/api/projects/${deleting.id}?children=${mode}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      toast.success("Project deleted.");
      removeStarredProject(deleting.id);
      setDeleting(null);
      broadcast();
      load();
    } catch {
      toast.error("Couldn’t delete project.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const all = React.useMemo(() => items ?? [], [items]);
  const ids = React.useMemo(() => new Set(all.map((p) => p.id)), [all]);
  const isTop = React.useCallback((p: ProjectItem) => !p.parentId || !ids.has(p.parentId), [ids]);
  const childrenOf = React.useMemo(() => {
    const map = new Map<string, ProjectItem[]>();
    for (const p of all) {
      if (!p.parentId || !ids.has(p.parentId)) continue;
      map.set(p.parentId, [...(map.get(p.parentId) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [all, ids]);

  const searching = query.trim().length > 0;
  const filtering = searching || filter !== "all";
  const shown = React.useMemo(() => {
    // The top level by default; any filter looks through every level.
    let result = filtering ? [...all] : all.filter(isTop);
    if (filter === "pinned") result = result.filter((p) => p.starred);
    if (searching) {
      const q = query.toLowerCase();
      result = result.filter((p) => p.name.toLowerCase().includes(q) || p.instructions.toLowerCase().includes(q));
    }
    result.sort((a, b) => {
      if (sortBy === "name") return a.name.localeCompare(b.name);
      if (sortBy === "conversations") return b.conversationCount - a.conversationCount;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return result;
  }, [all, isTop, query, filter, sortBy, searching, filtering]);

  const loading = items === null;
  const empty = !loading && all.length === 0;
  const topCount = all.filter(isTop).length;
  const folderCount = all.length - topCount;
  const chatCount = all.reduce((sum, p) => sum + p.conversationCount, 0);
  const pinnedCount = all.filter((p) => p.starred).length;
  // The most recently touched project wears the presence trajectory, here and on the map.
  const liveId = React.useMemo(() => {
    let best: ProjectItem | null = null;
    for (const p of all) if (!best || p.updatedAt > best.updatedAt) best = p;
    return best?.id ?? null;
  }, [all]);
  const deletingChildren = deleting ? childrenOf.get(deleting.id) ?? [] : [];
  const deletingParent = deleting?.parentId ? all.find((p) => p.id === deleting.parentId) : undefined;

  const newProject = (
    <Button variant="secondary" onClick={() => setNameDialog({ mode: "create" })}>
      <Plus className="size-4" aria-hidden="true" /> New project
    </Button>
  );

  return (
    <AppPage measure="wide">
      <PageHero
        className="mb-10"
        heading="Projects"
        lede="A topic’s chats, instructions and files, kept together. Nest folders inside a project to arrange it your way."
        actions={empty || error ? undefined : newProject}
        figures={
          loading || empty
            ? undefined
            : [
                { label: "Projects", value: <RollingNumber value={topCount} /> },
                { label: "Folders", value: <RollingNumber value={folderCount} /> },
                { label: "Chats", value: <RollingNumber value={chatCount} /> },
              ]
        }
        aside={!loading && !empty && !error ? <ProjectsOrbit projects={all} /> : undefined}
      />

      {!loading && !empty && !error && (
        <div className="flex flex-wrap items-center gap-2 [animation-fill-mode:backwards] motion-safe:animate-rise-in">
          <div className="relative w-full @[40rem]/page:w-auto @[40rem]/page:min-w-64 @[40rem]/page:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects and folders"
              aria-label="Search projects"
              className={cn("pl-9", searching && "pr-16")}
            />
            {searching && (
              <span aria-live="polite" className="pj-annot pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 motion-safe:animate-fade-in">
                {shown.length} of {all.length}
              </span>
            )}
          </div>
          <div className="flex w-full items-center gap-2 @[40rem]/page:w-auto">
            <SegmentedControl
              value={filter}
              onChange={setFilter}
              ariaLabel="Filter projects"
              className="flex-1 @[40rem]/page:flex-none"
              options={[
                { value: "all", label: "All", count: all.length },
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
        <section className="pj mt-2 grid items-center gap-8 @[48rem]/page:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] @[48rem]/page:gap-12 motion-safe:animate-rise-in">
          <div className="pj-cover relative aspect-[16/9] overflow-hidden rounded-card">
            <ProjectCover id="alevr-first-project" live aspect={16 / 9} />
          </div>
          <div className="max-w-sm">
            <h2 className="pj-name text-foreground">Start your first project</h2>
            <p className="mt-2 text-pretty text-ui leading-relaxed text-muted-foreground">
              Give a topic its own instructions and files. Every chat you start inside it begins with them, and folders keep the parts apart.
            </p>
            <Button className="mt-6" onClick={() => setNameDialog({ mode: "create" })}>
              <Plus className="size-4" aria-hidden="true" /> New project
            </Button>
          </div>
        </section>
      ) : shown.length === 0 ? (
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
        <ul className="pj pj-grid mt-6 grid gap-3 @[30rem]/page:grid-cols-2 @[42rem]/page:grid-cols-3 @[42rem]/page:gap-4 @[64rem]/page:gap-5" aria-label="Projects">
          {shown.map((p, i) => (
            <li key={p.id} className="min-w-0">
              <ProjectTile
                project={p}
                folders={filtering ? [] : childrenOf.get(p.id) ?? []}
                pathLabel={filtering && !isTop(p) ? `In ${pathOf(all, p.id)}` : undefined}
                allProjects={all}
                live={p.id === liveId}
                index={i}
                onToggleStar={() => toggleStar(p)}
                onRename={() => setNameDialog({ mode: "rename", project: p })}
                onNewFolder={() => setNameDialog({ mode: "folder", parent: p })}
                onMove={() => setMoving({ kind: "project", id: p.id, name: p.name, parentId: p.parentId })}
                onDelete={() => setDeleting(p)}
                onDropInto={onDropInto(p.id)}
              />
            </li>
          ))}
        </ul>
      )}

      <ProjectNameDialog
        open={nameDialog !== null}
        onOpenChange={(open) => !open && setNameDialog(null)}
        mode={nameDialog?.mode ?? "create"}
        parentName={nameDialog?.mode === "folder" ? nameDialog.parent.name : undefined}
        initialName={nameDialog?.mode === "rename" ? nameDialog.project.name : ""}
        busy={nameBusy}
        onSubmit={submitName}
      />
      <MoveToDialog
        open={moving !== null}
        onOpenChange={(open) => !open && setMoving(null)}
        subject={moving}
        projects={all}
        busy={moveBusy}
        onConfirm={confirmMove}
      />
      <DeleteProjectDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        project={deleting}
        parentName={deletingParent?.name}
        folderCount={deletingChildren.length}
        busy={deleteBusy}
        onConfirm={confirmDelete}
      />
    </AppPage>
  );
}
