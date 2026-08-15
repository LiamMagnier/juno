"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Code2, FileCode2, FileText, GitBranch, PenTool, Globe, Image as ImageIcon, Loader2, MessagesSquare, PanelRightOpen, Search, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { AppPageHeader } from "@/components/app/app-page-header";
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
    <div className="app-page-scroll">
      <div className="app-page-content max-w-3xl">
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
              <Button size="sm" variant="outline" onClick={startDesign} disabled={startingDesign} className="gap-1.5">
                <PenTool className="size-3.5" aria-hidden />
                {startingDesign ? "Creating…" : "New design"}
              </Button>
            </>
          }
        />

        {/* Search + type filters — only once there is something to filter. */}
        {!loading && !empty && !error && (
          // `sm:flex-wrap` + a floor under the search field, because this row has
          // a variable number of segments: a user with all seven artifact types
          // gets an eight-segment filter, and without both of these the filter
          // takes the width it needs and crushes the search box down to its
          // magnifier. The filter drops to its own line instead.
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:min-w-48 sm:max-w-xs sm:flex-1">
              {/* size-4, not size-3.5. Every other search field in the product
                  sets its magnifier at size-4 over the same left-3 offset and
                  the same pl-9 — projects, roadmap, knowledge — so this one
                  glyph was a half-step small in an otherwise identical field. */}
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search artifacts…"
                aria-label="Search artifacts"
                className="h-9 pl-9"
              />
            </div>
            {presentTypes.length > 1 && (
              // The shared control, not a local restatement of it. These were
              // `Pressable kind="chip"` in `font-mono text-caption` — 11px mono
              // pills, a face and a shape nothing else on the page wears — so a
              // one-of-N filter sat between an `outline` Button and the sidebar's
              // own Home/Code toggle looking like a third system. A mutually
              // exclusive filter is precisely what SegmentedControl is for, and it
              // brings the radiogroup semantics, roving tabindex and arrow-key nav
              // the hand-rolled version had to restate in a comment.
              <SegmentedControl<ArtifactType | "ALL">
                value={typeFilter}
                onChange={setTypeFilter}
                ariaLabel="Filter by type"
                className="w-fit max-w-full shrink-0"
                optionClassName="whitespace-nowrap"
                options={(["ALL", ...presentTypes] as const).map((t) => ({
                  value: t,
                  label: t === "ALL" ? "All" : TYPE_LABELS[t],
                }))}
              />
            )}
          </div>
        )}

        {error ? (
          // A failed fetch was the only state on this page rendered as unfenced
          // floating text, so the failure looked lighter than the empty state 25
          // lines below it. tone="error" also gets role="status" for free.
          <EmptyState
            tone="error"
            className="mt-10 motion-safe:animate-rise-in"
            icon={error === "offline" ? WifiOff : undefined}
            title={error === "offline" ? "You’re offline" : "Couldn’t load your artifacts"}
            description={
              error === "offline"
                ? "Your artifacts will load again the moment the connection returns."
                : "Something went wrong on the way here."
            }
            action={
              <Button variant="outline" size="sm" onClick={load}>
                Try again
              </Button>
            }
          />
        ) : loading ? (
          // The skeleton has to stand in for the shape it precedes. This was a
          // single-column divided list of 8px-avatar rows in front of a
          // three-column grid of tall cards, so the whole page reflowed the
          // moment the data landed and the placeholder previewed nothing.
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[...Array(6)].map((_, i) => (
              <li key={i} className="skeleton h-40 rounded-card" style={staggerDelay(i, "tight")} />
            ))}
          </ul>
        ) : empty ? (
          <EmptyState
            className="mt-10 motion-safe:animate-rise-in"
            icon={AppIcons.artifacts}
            title="Nothing here yet"
            description="Ask Juno to build a page, component, document or diagram — or to design a screen — and it opens in the Canvas and collects here."
            action={
              <>
                <Button size="sm" onClick={() => router.push("/chat")}>
                  Start building
                </Button>
                <Button size="sm" variant="outline" onClick={startDesign} disabled={startingDesign} className="gap-1.5">
                  <PenTool className="size-3.5" aria-hidden />
                  {startingDesign ? "Creating…" : "New design"}
                </Button>
              </>
            }
          />
        ) : noResults ? (
          // One no-results shape across projects / artifacts / library: panel size,
          // Search mark, "No matching …", ghost Clear filters.
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
          <ul className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((item, i) => {
              const Icon = ICONS[item.type] ?? FileCode2;
              const rt = runtimeFor(item.type, item.language);
              return (
                <li
                  key={item.id}
                  style={staggerDelay(i, "tight")}
                  // hover:bg-secondary, not hover:bg-accent/20: a fifth of a 13%
                  // token over the tile's own 6.5% card is 1.3 points of lift, so
                  // the hover fill was invisible and the border was carrying the
                  // whole state on its own. The rung above card is the step.
                  className="group relative flex flex-col rounded-card border border-border/65 bg-card transition-[border-color,background-color] duration-fast ease-out-soft hover:border-foreground/25 hover:bg-secondary motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                >
                  {/* Decorative top border based on language/type could go here, but a subtle layout is better */}
                  <Link
                    href={`/chat/${item.conversationId}?artifact=${encodeURIComponent(item.identifier)}`}
                    className="flex flex-1 flex-col p-4 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-card focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                  >
                    <div className="flex items-start justify-between gap-3">
                      {/* bg-accent, and a primary tint strong enough to see. The
                          tile was bg-muted/50 (1.5 points over the card it sits on)
                          lighting up to bg-primary/5 — two fills that both resolved
                          to within a point and a half of their own background, so
                          the type mark had no plate and hovering it changed nothing
                          but the icon's colour. */}
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-control border border-border/60 bg-accent text-muted-foreground transition-colors duration-base ease-out-soft group-hover:border-primary/25 group-hover:bg-primary/15 group-hover:text-primary">
                        <Icon className="size-5" aria-hidden />
                      </span>
                      {/* Row actions now sit in the top right of the card, above the stretched link. */}
                      <div className="relative z-10 flex shrink-0 items-center gap-0.5 -mr-2 -mt-1">
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
                            <DropdownMenuItem onSelect={() => router.push(`/chat/${item.conversationId}?artifact=${encodeURIComponent(item.identifier)}`)}>
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
                    </div>
                    
                    <div className="mt-4 flex-1">
                      <h3 className="line-clamp-2 text-base font-medium leading-tight">{item.title || "Untitled artifact"}</h3>
                      <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">in “{item.conversationTitle}”</p>
                    </div>

                    <div className="mt-5 flex items-center justify-between border-t border-border/40 pt-3 font-mono text-caption text-muted-foreground">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-foreground/70">{rt.label}</span>
                        {item.version > 1 && (
                          <>
                            <span aria-hidden className="size-1 rounded-full bg-border" />
                            <span>v{item.version}</span>
                          </>
                        )}
                      </div>
                      <span>{timeAgo(item.updatedAt)}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

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
    </div>
  );
}
