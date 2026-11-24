"use client";

import * as React from "react";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { LayoutGrid, List, Plus, Search } from "@/components/ui/icons";
import { LoadError } from "@/components/ui/load-error";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { removeStarredProject } from "@/lib/starred-projects";
import { cachedJson, peekJson } from "@/lib/client-cache";
import { EmptyState } from "@/components/ui/empty-state";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { AppIcons } from "@/lib/app-icons";
import { ProjectsGridSkeleton } from "@/components/projects/projects-grid-skeleton";
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
import { PROJECT_SORT_OPTIONS, visibleProjects, type ProjectFilter, type ProjectSort } from "@/lib/projects/project-view";
import { ProjectDetailsDialog } from "@/components/projects/project-details-dialog";

interface ProjectItem extends FolderProject {
  instructions: string;
  description?: string;
  updatedAt: string;
  createdAt?: string;
  lastActivityAt?: string;
  conversationCount: number;
  fileCount: number;
}

const PROJECTS_URL = "/api/projects";
function projectItems(body: unknown): ProjectItem[] | null {
  const projects = (body as { projects?: ProjectItem[] } | undefined)?.projects;
  if (!Array.isArray(projects)) return null;
  return projects.map((p) => ({ ...p, parentId: p.parentId ?? null }));
}

type NameDialog = { mode: "folder"; parent: ProjectItem } | { mode: "rename"; project: ProjectItem };

/**
 * The account's projects, as Claude lists them: one primary action (New
 * project), a search and a sort, and a grid of cards that each say what the
 * project is for and when it was last used. The top level by default, each
 * card naming the folders it holds; a search or the Pinned filter looks
 * through every level and says where each match sits. Folders are made from a
 * card's menu or inside a project, moved with Move to… or by dragging one card
 * onto another.
 *
 * With no projects yet the header keeps only its title and the empty state
 * carries the one action, so the page never offers New project twice.
 */
export default function ProjectsPage() {
  const router = useRouter();
  const hrefFor = useWorkspaceHref();
  const [items, setItems] = React.useState<ProjectItem[] | null>(null);
  const [error, setError] = React.useState(false);
  // The list the shell already holds paints before the first frame; the read
  // below refreshes it. A layout effect rather than the state initialiser: on
  // a full page load the sidebar's read can land before this page hydrates,
  // and a first render that differs from the server's is a hydration error.
  React.useLayoutEffect(() => {
    const cached = projectItems(peekJson(PROJECTS_URL));
    if (cached) setItems((cur) => cur ?? cached);
  }, []);

  const [query, setQuery] = React.useState("");
  const [filter, setFilter] = React.useState<ProjectFilter>("all");
  const [sortBy, setSortBy] = React.useState<ProjectSort>("activity");
  const [layout, setLayout] = React.useState<"grid" | "list">("grid");

  const [createOpen, setCreateOpen] = React.useState(false);
  const [createBusy, setCreateBusy] = React.useState(false);
  const [nameDialog, setNameDialog] = React.useState<NameDialog | null>(null);
  const [nameBusy, setNameBusy] = React.useState(false);
  const [moving, setMoving] = React.useState<MoveSubject | null>(null);
  const [moveBusy, setMoveBusy] = React.useState(false);
  const [deleting, setDeleting] = React.useState<ProjectItem | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const next = projectItems(await cachedJson(PROJECTS_URL, { maxAgeMs: 0 }));
      if (!next) throw new Error("malformed");
      setItems(next);
    } catch {
      setError(true);
      setItems((cur) => cur ?? []);
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
    setCreateOpen(true);
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

  const createProject = async ({ name, description }: { name: string; description: string }) => {
    setCreateBusy(true);
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || undefined, description: description || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn’t create project.");
      window.dispatchEvent(new CustomEvent("projects:sync"));
      // Busy until the new page replaces this one, so a second click cannot
      // make a second project while the route is still changing.
      router.push(hrefFor(`/projects/${d.id}`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
      setCreateBusy(false);
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
        body: JSON.stringify({ name: name || undefined, parentId: nameDialog.parent.id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn’t create project.");
      window.dispatchEvent(new CustomEvent("projects:sync"));
      // Busy until the new page replaces this one. `busy` used to drop in a
      // `finally` the moment the push was queued, while the route was still
      // changing, so the dialog sat there with an enabled "Create project"
      // and a second click made a second project.
      router.push(hrefFor(`/projects/${d.id}`));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
      setNameBusy(false);
    }
  };

  // Rename settles here (the create path navigates away while still busy).
  React.useEffect(() => {
    if (nameDialog === null) setNameBusy(false);
  }, [nameDialog]);

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
  const shown = React.useMemo(() => visibleProjects(all, { query, filter, sort: sortBy }), [all, query, filter, sortBy]);

  const loading = items === null;
  const empty = !loading && all.length === 0;
  const topCount = all.filter(isTop).length;
  const pinnedCount = all.filter((p) => p.starred).length;
  const deletingChildren = deleting ? childrenOf.get(deleting.id) ?? [] : [];
  const deletingParent = deleting?.parentId ? all.find((p) => p.id === deleting.parentId) : undefined;

  // The page's one primary action: the accent is spent here and nowhere else.
  const newProject = (
    <Button onClick={() => setCreateOpen(true)}>
      <Plus className="size-4" aria-hidden="true" /> New project
    </Button>
  );

  return (
    <AppPage measure="wide" contentClassName="pj-projects-page">
      <AppPageHeader
        heading="Projects"
        lede={empty || error ? undefined : "Pick up a conversation or give new work its own files and instructions."}
        actions={empty || error ? undefined : newProject}
      />

      {!loading && !empty && !error && (
        <div className="pj-toolbar" role="group" aria-label="Project browsing controls">
          <SearchField
            value={query}
            onValueChange={setQuery}
            label="Search projects"
            placeholder="Search projects and folders"
            className="min-w-0"
          />
          {searching && <span className="sr-only" role="status">{shown.length} of {all.length} projects</span>}
          <div className="pj-toolbar-filters">
            <SegmentedControl
              value={filter}
              onChange={setFilter}
              ariaLabel="Filter projects"
              className="min-w-0"
              // All counts what All shows: the top level. It counted folders
              // too, so it said 12 over a grid of 8 tiles, and on a phone it
              // is the only count on screen. Pinned lists every level, so it
              // counts every level.
              options={[
                { value: "all", label: "All", count: topCount },
                { value: "pinned", label: "Pinned", count: pinnedCount },
              ]}
            />
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as ProjectSort)}>
              <SelectTrigger className="min-w-0" aria-label="Sort projects">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROJECT_SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {/* The same switch as the Library's, so the two pages' toolbars
                are one object (it was a look-alike 4px shorter than the row). */}
            <SegmentedControl
              value={layout}
              onChange={setLayout}
              ariaLabel="Project layout"
              labelHidden
              className="shrink-0"
              options={[
                { value: "grid", label: "Grid view", icon: <LayoutGrid className="size-4" /> },
                { value: "list", label: "List view", icon: <List className="size-4" /> },
              ]}
            />
          </div>
        </div>
      )}

      {error ? (
        <LoadError title="Couldn’t load your projects" onRetry={load} />
      ) : loading ? (
        <ProjectsGridSkeleton />
      ) : empty ? (
        <EmptyState
          className="mt-4"
          icon={AppIcons.projects}
          title="Start your first project"
          description="Give a piece of work its own instructions and knowledge: files, Library documents, or a Google Drive folder that stays in sync. Every chat you start in it begins with them."
          action={newProject}
        />
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
        <ul className="pj pj-grid pj-project-results" data-layout={layout} aria-label="Projects">
          {shown.map((p, i) => (
            <li key={p.id} className="min-w-0">
              <ProjectTile
                project={p}
                folders={filtering ? [] : childrenOf.get(p.id) ?? []}
                pathLabel={filtering && !isTop(p) ? `In ${pathOf(all, p.id)}` : undefined}
                allProjects={all}
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

      <ProjectDetailsDialog
        open={createOpen}
        onOpenChange={(open) => !createBusy && setCreateOpen(open)}
        mode="create"
        busy={createBusy}
        onSubmit={(details) => void createProject(details)}
      />
      <ProjectNameDialog
        open={nameDialog !== null}
        onOpenChange={(open) => !open && setNameDialog(null)}
        mode={nameDialog?.mode ?? "rename"}
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
