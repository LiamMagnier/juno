"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Code2, FileCode2, FileText, GitBranch, LayoutGrid, List as ListIcon, Globe, Image as ImageIcon, Loader2, MessagesSquare, PanelRightOpen, Search, WifiOff } from "@/components/ui/icons";
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
import { MENU_W } from "@/components/ui/menu-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShareDialog } from "@/components/share/share-dialog";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { extensionForLanguage, runtimeFor } from "@/lib/artifact-runtime";
import type { ArtifactType } from "@/lib/message-content";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ArtifactPreview } from "@/components/artifacts/artifact-preview";
import { IconSwap } from "@/components/ui/icon-swap";

const ICONS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
  DESIGN: AppIcons.design,
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
  /** The head of the newest version's source, for the grid tile. */
  preview: string | null;
}

/**
 * The list row: text on the page at rest, the tonal row fill under the pointer.
 * Nothing lifts and nothing casts — the kind glyph is the one thing that moves
 * (`data-icon-trigger` plays its `lift`), which says "this opens" without the
 * row itself pretending to be a card leaving the page.
 */
const rowClass =
  "group relative flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none";

/**
 * The two view modes, and where the choice is kept.
 *
 * Same control, same options, same storage mechanism as the Library — the two
 * pages hold the same kind of thing and a reader who set one to Grid has said
 * something about how they want to look at their own work.
 */
type ArtifactView = "list" | "grid";
const ARTIFACT_VIEW_STORAGE_KEY = "juno:artifacts:view";
const VIEW_OPTIONS = [
  { value: "list" as const, label: "List", icon: <ListIcon className="size-3.5" /> },
  { value: "grid" as const, label: "Grid", icon: <LayoutGrid className="size-3.5" /> },
];

export default function ArtifactsPage() {
  const router = useRouter();
  const [items, setItems] = React.useState<Item[] | null>(null);
  const [view, setView] = React.useState<ArtifactView>("list");
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

  // List is the default and the safe one: a browser with storage blocked gets
  // the denser view rather than nothing.
  React.useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ARTIFACT_VIEW_STORAGE_KEY);
      if (saved === "list" || saved === "grid") setView(saved);
    } catch {
      /* hardened browsing mode — the in-memory preference still works */
    }
  }, []);

  /**
   * The actions menu, defined once for both views.
   *
   * It closes over the page's handlers rather than taking eight props, which is
   * the whole reason the grid could be added without the two views drifting:
   * one definition of what you can do to an artifact, wherever you are looking
   * at it.
   *
   * A render function, called as `renderActions(item, href)`, not a component.
   * It used to be a component created inside `useCallback([downloadingId,
   * router])`, so every download that started or finished gave it a new
   * identity and React unmounted every actions button on the page and mounted
   * fresh ones. That killed two things: the more → spinner cross-fade, which
   * mounted already in its final state (a transition does not run on first
   * paint), and keyboard focus, which Radix had just returned to the trigger
   * after "Download source" and which then fell to <body> with it. Called as a
   * function, the menu is part of this page's own tree and survives the state
   * change. `download` and `openRename` are declared further down, which is
   * fine: this only runs during render, after both exist.
   */
  const renderActions = (item: Item, href: string) => (
    <DropdownMenu>
      {/* Menu trigger outside the tooltip trigger, as on the canvas header's
          overflow button, so the button's `data-state` stays the menu's (the
          inner Slot's props win) and `data-[state=open]:opacity-100` keeps
          the trigger showing while its menu is open. */}
      <Tooltip>
        <DropdownMenuTrigger asChild>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Actions for ${item.title || "artifact"}`}
              // No `transition-opacity`: Button is `.pressable`, whose own
              // shorthand already fades opacity on the fast rung — a utility
              // here would replace it and take the press's transform with it.
              className="text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
            >
              <IconSwap
                swapped={downloadingId === item.id}
                from={<ActionIcons.more className="size-4" />}
                to={<Loader2 className={cn("size-4", downloadingId === item.id && "motion-safe:animate-spin")} />}
              />
            </Button>
          </TooltipTrigger>
        </DropdownMenuTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className={MENU_W}>
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
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => setDeleteTarget(item)}
        >
          <ActionIcons.delete className="size-4" aria-hidden /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const changeView = React.useCallback((next: ArtifactView) => {
    setView(next);
    try {
      window.localStorage.setItem(ARTIFACT_VIEW_STORAGE_KEY, next);
    } catch {
      /* as above */
    }
  }, []);

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
      if (!res.ok || !data.url) throw new Error(data.error ?? "Couldn’t start a design.");
      router.push(data.url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t start a design.");
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
      toast.error("Couldn’t rename the artifact.");
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
      toast.error("Couldn’t delete the artifact.");
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
      toast.error("Couldn’t download the source.");
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    // `wide`, like Library, Projects, Work, Code and Connections. A list of
    // rows with a search field and a sort control has the same anatomy as those
    // and so has the same measure; `reading` (48rem) is for prose — Memory, a
    // roadmap detail, a knowledge document — not for a table. Artifacts was the
    // only list route at `reading`, so hopping Library → Artifacts in the
    // sidebar moved the column 16rem for no reason the user could see.
    <AppPage measure="wide">
      <AppPageHeader
        /*
         * NO EYEBROW. It read "Canvas" over a heading that reads "Artifacts",
         * on a page the sidebar row "Artifacts" takes you to — three words for
         * two things, and the one word above the title named a DIFFERENT
         * surface (the Canvas is where an artifact opens, not where the list
         * lives). docs/design/PREMIUM_AUDIT.md §3 rule 15: anything above the
         * title has to say something the title does not.
         */
        heading="Artifacts"
        lede="Everything Juno built with you, newest first."
        actions={
          <>
            {!loading && !empty && !error && (
              <span className="font-mono text-caption tabular-nums text-muted-foreground">
                {items.length} {items.length === 1 ? "artifact" : "artifacts"}
              </span>
            )}
            {/* Not while the page is empty: the empty state below already
                offers this exact button, 250px away, and a reader looking at
                two identical controls has to work out which one is the real
                one. The empty state's copy explains what it does; this one
                cannot. It comes back the moment there is a list to act on. */}
            {!empty && (
              <Button size="sm" variant="secondary" onClick={startDesign} disabled={startingDesign} className="gap-1.5">
                <AppIcons.design className="size-3.5" aria-hidden />
                {startingDesign ? "Creating…" : "New design"}
              </Button>
            )}
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
          <SegmentedControl<ArtifactView>
            value={view}
            onChange={changeView}
            options={VIEW_OPTIONS}
            ariaLabel="Artifact view"
            className="ml-auto h-9 shrink-0"
          />
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
                <AppIcons.design className="size-3.5" aria-hidden />
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
      ) : view === "grid" ? (
        /*
         * The grid.
         *
         * `auto-fill` with a 15rem floor rather than fixed breakpoints, so the
         * columns follow the actual width available — this page sits beside a
         * sidebar that collapses, and a media-query grid would be a column
         * short or a column too many for half of its states.
         *
         * The tile is the same object as the row: same link target, same
         * actions menu, same metadata, arranged for a reader who is looking
         * for something by eye rather than reading a list of names.
         */
        <ul
          className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-3"
          aria-label={`${filtered.length} ${filtered.length === 1 ? "artifact" : "artifacts"}`}
        >
          {filtered.map((item, i) => {
            const Icon = ICONS[item.type] ?? FileCode2;
            const rt = runtimeFor(item.type, item.language);
            const href = `/chat/${item.conversationId}?artifact=${encodeURIComponent(item.identifier)}`;
            return (
              <li
                key={item.id}
                style={staggerDelay(i, "tight")}
                // A tonal hover, and the glyph — not the card — is what lifts:
                // the tile is a large surface and stays on the page, while
                // `data-icon-trigger` lets the kind glyph play its `lift` — the
                // one on the metadata line, and the preview's own when the tile
                // has no source to show.
                data-icon-trigger=""
                className="group relative flex flex-col rounded-card border border-border bg-card p-2 transition-colors duration-fast ease-out-soft hover:bg-accent motion-safe:animate-rise-in [animation-fill-mode:backwards] motion-reduce:transition-none"
              >
                <ArtifactPreview
                  type={item.type}
                  preview={item.preview}
                  title={item.title}
                  // `md` (8) overrides the component's standalone default: this
                  // tile is `rounded-card` (16) with `p-2` (8), so 16 − 8 = 8.
                  // The radius belongs at the call site, beside the padding it
                  // is derived from — inside the component it can only guess.
                  className="aspect-[4/3] w-full rounded-md"
                />

                <div className="flex min-w-0 items-start gap-1 px-1 pb-0.5 pt-2">
                  {/* The stretched link covers the whole tile, preview
                      included; the actions menu sits above it. */}
                  <Link
                    href={href}
                    className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-card after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                  >
                    <span className="block truncate text-ui font-medium">{item.title || "Untitled artifact"}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 font-mono text-caption tabular-nums text-muted-foreground">
                      {/* The list row's kind mark, at metadata size: a tile
                          previewing its source otherwise had no glyph at all,
                          so the two views named the same kind two ways. */}
                      <Icon className="size-3 shrink-0" motion="lift" aria-hidden />
                      <span className="truncate">{rt.label}</span>
                      {item.version > 1 && (
                        <>
                          <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
                          <span className="shrink-0">v{item.version}</span>
                        </>
                      )}
                      <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
                      <time
                        dateTime={item.updatedAt}
                        title={new Date(item.updatedAt).toLocaleString()}
                        className="shrink-0"
                      >
                        {timeAgo(item.updatedAt)}
                      </time>
                    </span>
                  </Link>
                  <div className="relative z-10 -mr-1 flex shrink-0 items-center">
                    {renderActions(item, href)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
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
                data-icon-trigger=""
                className={`${rowClass} motion-safe:animate-rise-in [animation-fill-mode:backwards]`}
              >
                {/* The kind glyph on an inset tile — the row's one piece of depth
                    at rest, and the one thing that moves under the pointer: its
                    ink steps up to the row's foreground and the glyph lifts. */}
                <span className="surface-inset flex size-9 shrink-0 items-center justify-center rounded-field text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-foreground">
                  <Icon className="size-4" motion="lift" aria-hidden />
                </span>

                {/* The stretched link: the whole row opens the artifact; the
                    actions menu sits above it (relative z-10) so it stays
                    clickable. */}
                <Link
                  href={href}
                  className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-control after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                >
                  <span className="block truncate text-ui font-medium">{item.title || "Untitled artifact"}</span>
                  <span className="mt-0.5 block truncate text-caption text-muted-foreground">in “{item.conversationTitle}”</span>
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
                  {renderActions(item, href)}
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
