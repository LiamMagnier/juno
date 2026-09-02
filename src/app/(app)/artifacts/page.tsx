"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Code2, FileCode2, FileText, GitBranch, PenTool, Globe, Image as ImageIcon, Loader2, MessagesSquare, PanelRightOpen, Search, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ShareDialog } from "@/components/share/share-dialog";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { extensionForLanguage, runtimeFor } from "@/lib/artifact-runtime";
import type { ArtifactType } from "@/lib/message-content";
import { staggerDelay } from "@/lib/motion";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";

const ICONS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
  DESIGN: PenTool,
};

/** Filter-chip labels — what the artifact IS, not its file format. */
const TYPE_LABELS: Record<ArtifactType, string> = {
  HTML: "Sites",
  REACT: "Components",
  CODE: "Code",
  MARKDOWN: "Documents",
  SVG: "Graphics",
  MERMAID: "Diagrams",
  DESIGN: "Designs",
};

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  HTML: "html",
  REACT: "tsx",
  SVG: "svg",
  MARKDOWN: "md",
  MERMAID: "mmd",
  DESIGN: "juno.design.json",
  CODE: "txt",
};

interface Item {
  id: string;
  identifier: string;
  title: string;
  type: ArtifactType;
  language: string | null;
  version: number;
  conversationId: string;
  conversationTitle: string;
  createdAt: string;
  updatedAt: string;
}

/** The hover-raised row: flat on the page at rest, a raised card under the pointer. */
const rowClass =
  "group relative flex w-full items-center gap-3 rounded-control border border-transparent px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] duration-fast ease-out-soft hover:border-border/60 hover:bg-card hover:shadow-raised motion-reduce:transition-none";

export default function ArtifactsPage() {
  const router = useRouter();
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [error, setError] = React.useState<null | "network" | "offline">(null);
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<ArtifactType | "ALL">("ALL");
  const [renameTarget, setRenameTarget] = React.useState<Item | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renaming, setRenaming] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<Item | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [shareTarget, setShareTarget] = React.useState<Item | null>(null);
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/artifacts");
      if (!r.ok) throw new Error();
      setItems((await r.json()).items);
    } catch {
      setError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "network");
      setItems((prev) => prev ?? []);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  // Coming back online retries on its own — the offline state is a waiting
  // state, not a dead end.
  React.useEffect(() => {
    if (error !== "offline") return;
    const onOnline = () => load();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [error, load]);

  const loading = items === null;
  const presentTypes = React.useMemo(() => {
    const seen = new Set<ArtifactType>();
    for (const item of items ?? []) seen.add(item.type);
    return (Object.keys(TYPE_LABELS) as ArtifactType[]).filter((t) => seen.has(t));
  }, [items]);

  const filtered = React.useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (typeFilter !== "ALL" && item.type !== typeFilter) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        item.conversationTitle.toLowerCase().includes(q) ||
        runtimeFor(item.type, item.language).label.toLowerCase().includes(q)
      );
    });
  }, [items, query, typeFilter]);

  const [startingDesign, setStartingDesign] = React.useState(false);

  /** Start a design from nothing, and open it.
   *
   *  An artifact belongs to a conversation, so the route creates both — which is
   *  why this is a POST and a redirect rather than client-side state. */
  const startDesign = React.useCallback(async () => {
    setStartingDesign(true);
    try {
      const res = await fetch("/api/design", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Untitled design", preset: "phone" }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Could not start a design.");
      router.push(data.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start a design.");
      setStartingDesign(false);
    }
  }, [router]);

  const empty = !loading && !error && items.length === 0;
  const noResults = !loading && !error && items.length > 0 && filtered.length === 0;

  const openRename = (item: Item) => {
    setRenameTarget(item);
    setRenameValue(item.title);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title || title === renameTarget.title) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    try {
      const res = await fetch(`/api/artifacts/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw new Error();
      setItems((prev) => prev?.map((i) => (i.id === renameTarget.id ? { ...i, title } : i)) ?? prev);
      setRenameTarget(null);
    } catch {
      toast.error("Could not rename the artifact.");
    } finally {
      setRenaming(false);
    }
  };

  const submitDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/artifacts/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setItems((prev) => prev?.filter((i) => i.id !== deleteTarget.id) ?? prev);
      setDeleteTarget(null);
      toast.success("Artifact deleted");
    } catch {
      toast.error("Could not delete the artifact.");
    } finally {
      setDeleting(false);
    }
  };

  const download = async (item: Item) => {
    setDownloadingId(item.id);
    try {
      const res = await fetch(`/api/artifacts/${item.id}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      const content: string = data?.artifact?.content ?? "";
      const ext = extensionForLanguage(item.language) || DOWNLOAD_EXTENSIONS[item.type] || "txt";
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${item.identifier}.${ext}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not download the source.");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <AppPage measure="reading">
      <AppPageHeader
        eyebrow="Canvas"
        heading="Artifacts"
        icon={AppIcons.artifacts}
        lede="Everything Juno built with you, newest first."
        actions={
          <>
            {!loading && !empty && !error && (
              <span className="font-mono text-caption tabular-nums text-muted-foreground">
                {items.length} {items.length === 1 ? "artifact" : "artifacts"}
              </span>
            )}
            <Button size="sm" variant="secondary" onClick={startDesign} disabled={startingDesign} className="gap-1.5">
              <PenTool className="size-3.5" aria-hidden />
              {startingDesign ? "Creating…" : "New design"}
            </Button>
          </>
        }
      />

      {/* Search + type filters — only once there is something to filter. */}
      {!loading && !empty && !error && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 basis-48 sm:max-w-xs">
            <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search artifacts…"
              aria-label="Search artifacts"
              className="pl-9"
            />
          </div>
          {presentTypes.length > 1 && (
            <SegmentedControl<ArtifactType | "ALL">
              value={typeFilter}
              onChange={setTypeFilter}
              ariaLabel="Filter by type"
              className="h-9 w-fit max-w-full shrink-0"
              optionClassName="whitespace-nowrap"
              options={(["ALL", ...presentTypes] as const).map((t) => ({
                value: t,
                label: t === "ALL" ? "All" : TYPE_LABELS[t],
                count: t === "ALL" ? items.length : items.filter((item) => item.type === t).length,
              }))}
            />
          )}
        </div>
      )}

      {error ? (
        <EmptyState
          tone="error"
          className="mt-6 motion-safe:animate-rise-in"
          icon={error === "offline" ? WifiOff : undefined}
          title={error === "offline" ? "You’re offline" : "Couldn’t load your artifacts"}
          description={
            error === "offline"
              ? "Your artifacts will load again the moment the connection returns."
              : "Something went wrong on the way here."
          }
          action={
            <Button variant="secondary" size="sm" onClick={load}>
              Try again
            </Button>
          }
        />
      ) : loading ? (
        <ul className="mt-5 space-y-1" aria-label="Loading artifacts">
          {[...Array(6)].map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-3 py-2.5" style={staggerDelay(i, "tight")}>
              <Skeleton className="size-9 shrink-0 rounded-field" />
              <span className="min-w-0 flex-1 space-y-2">
                <Skeleton className="block h-3 w-48 max-w-full rounded-xs" />
                <Skeleton className="block h-2.5 w-28 rounded-xs" />
              </span>
              <Skeleton className="hidden h-2.5 w-16 rounded-xs sm:block" />
            </li>
          ))}
        </ul>
      ) : empty ? (
        <EmptyState
          className="mt-6 motion-safe:animate-rise-in"
          icon={AppIcons.artifacts}
          title="Nothing here yet"
          description="Ask Juno to build a page, component, document or diagram — or to design a screen — and it opens in the Canvas and collects here."
          action={
            <>
              <Button size="sm" onClick={() => router.push("/chat")}>
                Start building
              </Button>
              <Button size="sm" variant="secondary" onClick={startDesign} disabled={startingDesign} className="gap-1.5">
                <PenTool className="size-3.5" aria-hidden />
                {startingDesign ? "Creating…" : "New design"}
              </Button>
            </>
          }
        />
      ) : noResults ? (
        // One no-results shape across projects / artifacts / library.
        <EmptyState
          className="mt-6"
          size="panel"
          icon={Search}
          title="No matching artifacts"
          description={`Nothing fits ${query.trim() ? `“${query.trim()}”` : "these filters"}.`}
          action={
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => {
                setQuery("");
                setTypeFilter("ALL");
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <ul className="mt-5 space-y-1" aria-label={`${filtered.length} ${filtered.length === 1 ? "artifact" : "artifacts"}`}>
          {filtered.map((item, i) => {
            const Icon = ICONS[item.type] ?? FileCode2;
            const rt = runtimeFor(item.type, item.language);
            const href = `/chat/${item.conversationId}?artifact=${encodeURIComponent(item.identifier)}`;
            return (
              <li
                key={item.id}
                style={staggerDelay(i, "tight")}
                className={`${rowClass} motion-safe:animate-rise-in [animation-fill-mode:backwards]`}
              >
                {/* The kind glyph on an inset tile — the row's one piece of depth at rest. */}
                <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
                  <Icon className="size-4" aria-hidden />
                </span>

                {/* The stretched link: the whole row opens the artifact; the
                    actions menu sits above it (relative z-10) so it stays
                    clickable. */}
                <Link
                  href={href}
                  className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-control after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                >
                  <span className="block truncate text-sm font-medium">{item.title || "Untitled artifact"}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">in “{item.conversationTitle}”</span>
                </Link>

                <span className="hidden shrink-0 items-center gap-1.5 font-mono text-caption tabular-nums text-muted-foreground sm:flex">
                  <span>{rt.label}</span>
                  {item.version > 1 && (
                    <>
                      <span aria-hidden className="size-1 rounded-full bg-border" />
                      <span>v{item.version}</span>
                    </>
                  )}
                  <span aria-hidden className="size-1 rounded-full bg-border" />
                  <time dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString()}>
                    {timeAgo(item.updatedAt)}
                  </time>
                </span>

                <div className="relative z-10 flex shrink-0 items-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Actions for ${item.title || "artifact"}`}
                        className="text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
                      >
                        {downloadingId === item.id ? (
                          <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden />
                        ) : (
                          <ActionIcons.more className="size-4" aria-hidden />
                        )}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem onSelect={() => router.push(href)}>
                        <PanelRightOpen className="size-4" aria-hidden /> Open in canvas
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => router.push(`/chat/${item.conversationId}`)}>
                        <MessagesSquare className="size-4" aria-hidden /> Open conversation
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => openRename(item)}>
                        <ActionIcons.edit className="size-4" aria-hidden /> Rename
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => download(item)}>
                        <ActionIcons.download className="size-4" aria-hidden /> Download source
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setShareTarget(item)}>
                        <ActionIcons.share className="size-4" aria-hidden /> Share
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive" onSelect={() => setDeleteTarget(item)}>
                        <ActionIcons.delete className="size-4" aria-hidden /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Rename */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && !renaming && setRenameTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename artifact</DialogTitle>
            <DialogDescription>The new name shows everywhere this artifact appears.</DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitRename();
            }}
          >
            <Input
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              aria-label="Artifact name"
              autoFocus
              maxLength={200}
            />
            <DialogFooter className="mt-4">
              <Button type="button" variant="ghost" size="sm" onClick={() => setRenameTarget(null)} disabled={renaming}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={renaming || !renameValue.trim()}>
                {renaming ? "Renaming…" : "Rename"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete */}
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete “{deleteTarget?.title || "artifact"}”?</DialogTitle>
            <DialogDescription>
              Every version is removed and any public share link stops working. The conversation it came from is untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={submitDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share */}
      {shareTarget && (
        <ShareDialog
          kind="ARTIFACT"
          artifactId={shareTarget.id}
          open={!!shareTarget}
          onOpenChange={(open) => !open && setShareTarget(null)}
        />
      )}
    </AppPage>
  );
}
