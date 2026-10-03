"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ChevronDown,
  Code2,
  FileCode2,
  FileText,
  GitBranch,
  LayoutGrid,
  List as ListIcon,
  Globe,
  Image as ImageIcon,
  Loader2,
  Maximize2,
  MessagesSquare,
  Monitor,
  PanelRightOpen,
  Plus,
  Search,
  Smartphone,
  Square,
  Tablet,
  WifiOff,
} from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { cardVariants } from "@/components/ui/card";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W } from "@/components/ui/menu-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ShareDialog } from "@/components/share/share-dialog";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { extensionForLanguage, runtimeFor } from "@/lib/artifact-runtime";
import {
  artifactHref,
  conversationArtifactHref,
  effectiveHomeFilter,
  homeHrefForType,
  homeNewFromParam,
  homeTypeChips,
  homeTypeFromParam,
  type HomeTypeFilter,
} from "@/lib/artifacts-home";
import { DESIGN_PRESETS, START_DESIGN_ERROR, startDesign, type DesignPresetKey } from "@/lib/design/presets";
import type { ArtifactType } from "@/lib/message-content";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { ArtifactPreview } from "@/components/artifacts/artifact-preview";
import { IconSwap } from "@/components/ui/icon-swap";
import ArtifactsLoading from "./loading";
import { FEATURE_NAMES, PRODUCT_NAME } from "@/lib/brand/names";

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

/**
 * Each preset's shape, in the New menu. The device a size is FOR, which is how
 * the presets are named, so the glyph and the word say one thing.
 */
const PRESET_GLYPHS: Record<DesignPresetKey, typeof Code2> = {
  phone: Smartphone,
  tablet: Tablet,
  desktop: Monitor,
  square: Square,
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
  /** Null when the artifact has no chat: made outside one, or its chat was deleted. */
  conversationId: string | null;
  conversationTitle: string | null;
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
  "group relative flex w-full items-center gap-4 rounded-control px-3 py-3.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent motion-reduce:transition-none";

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

/**
 * `/artifacts` — everything made, and where a design starts.
 *
 * Design is a type here, not a place (04-MERGE-PLAN §1.1, §4). `/design`
 * redirects to `?type=DESIGN`; the presets it led with are the first section
 * of New, and are pinned above the list while the Designs filter is on; a
 * design opens at `/a/{id}` like everything else.
 *
 * `useSearchParams` needs a Suspense boundary above it in a client page, or
 * Next bails the route out of static rendering. It sits here rather than in a
 * layout so the page's own skeleton stands in for it, as on /settings.
 */
export default function ArtifactsPage() {
  return (
    <React.Suspense fallback={<ArtifactsLoading />}>
      <ArtifactsHome />
    </React.Suspense>
  );
}

function ArtifactsHome() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlType = homeTypeFromParam(searchParams.get("type"));
  const urlNew = homeNewFromParam(searchParams.get("new"));

  const [items, setItems] = React.useState<Item[] | null>(null);
  const [view, setView] = React.useState<ArtifactView>("list");
  const [error, setError] = React.useState<null | "network" | "offline">(null);
  const [query, setQuery] = React.useState("");
  const [typeFilter, setTypeFilter] = React.useState<HomeTypeFilter>(urlType);
  const [renameTarget, setRenameTarget] = React.useState<Item | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [renaming, setRenaming] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<Item | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [shareTarget, setShareTarget] = React.useState<Item | null>(null);
  const [downloadingId, setDownloadingId] = React.useState<string | null>(null);
  const [newMenuOpen, setNewMenuOpen] = React.useState(false);
  /** The preset being created, from the moment it is chosen until the page is left. */
  const [creating, setCreating] = React.useState<DesignPresetKey | null>(null);

  /*
   * A filter that ARRIVES while the page is already open.
   *
   * The initial state reads `?type=` once. A second arrival — ⌘K's "Design",
   * or a `/design` bookmark followed from this very page — changes the URL
   * without remounting the page, so the chip would stay where it was. Adjusted
   * during render (React's "storing information from previous renders"), not
   * in an effect, so the list never paints once under the old filter.
   *
   * A chip the reader presses writes the URL too (`changeTypeFilter`), which
   * lands here as the value the state already holds: no loop.
   */
  const [adoptedType, setAdoptedType] = React.useState<HomeTypeFilter>(urlType);
  if (adoptedType !== urlType) {
    setAdoptedType(urlType);
    setTypeFilter(urlType);
  }

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
   * A render function, called as `renderActions(item)`, not a component. It
   * used to be a component created inside `useCallback([downloadingId,
   * router])`, so every download that started or finished gave it a new
   * identity and React unmounted every actions button on the page and mounted
   * fresh ones. That killed two things: the more → spinner cross-fade, which
   * mounted already in its final state (a transition does not run on first
   * paint), and keyboard focus, which Radix had just returned to the trigger
   * after "Download source" and which then fell to <body> with it. Called as a
   * function, the menu is part of this page's own tree and survives the state
   * change. `download` and `openRename` are declared further down, which is
   * fine: this only runs during render, after both exist.
   *
   * Open and Open in conversation are two places now, not two words for one.
   * Open is the artifact's own page (`/a/{id}`), where the row goes. Open in
   * conversation is the chat it was made in, with the panel open on it — where
   * a page still previews live and where Juno changes it.
   */
  const renderActions = (item: Item) => (
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
        <DropdownMenuItem onSelect={() => router.push(artifactHref(item.id))}>
          <Maximize2 className="size-4" aria-hidden /> Open
        </DropdownMenuItem>
        {item.conversationId && (
          <DropdownMenuItem onSelect={() => router.push(conversationArtifactHref(item.conversationId!, item.identifier))}>
            <PanelRightOpen className="size-4" aria-hidden /> Open in conversation
          </DropdownMenuItem>
        )}
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

  /**
   * Set the filter, and say so in the URL.
   *
   * `replaceState`, not a router push: a chip is not a place in history, and a
   * router navigation would ask the server for a page this client already
   * has. `null` state on purpose — Next copies its own entry state over and
   * syncs `useSearchParams`, so the adoption above sees the value it holds.
   * A reload or a copied link now keeps the reader's filter.
   */
  const changeTypeFilter = React.useCallback((next: HomeTypeFilter) => {
    setTypeFilter(next);
    try {
      window.history.replaceState(null, "", homeHrefForType(window.location.search, next));
    } catch {
      /* the filter still applies; only the URL did not follow */
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

  /*
   * `?new=design` — a link that arrives with New open on the presets.
   *
   * Only once the list has settled: before that the page does not know whether
   * New is in the header or in the empty state, and a menu opened against the
   * first would be left pointing at a button that has gone. The flag then comes
   * off the URL, so a reload or Back does not open the menu a second time.
   */
  React.useEffect(() => {
    if (urlNew !== "design" || items === null) return;
    setNewMenuOpen(true);
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("new");
      window.history.replaceState(null, "", url.pathname + url.search);
    } catch {
      /* the menu is open; the flag stays in a URL nobody reloads */
    }
  }, [urlNew, items]);

  const loading = items === null;

  const counts = React.useMemo(() => {
    const byType = new Map<ArtifactType, number>();
    for (const item of items ?? []) byType.set(item.type, (byType.get(item.type) ?? 0) + 1);
    return byType;
  }, [items]);

  // Designs always has a chip; every other kind only while it has something
  // under it (see homeTypeChips). The filter applied is the one with a chip on
  // screen, so a kind that empties never strands the list behind it (L31).
  const chips = React.useMemo(() => homeTypeChips(counts.keys()), [counts]);
  const activeFilter = effectiveHomeFilter(typeFilter, chips);
  const designsView = activeFilter === "DESIGN";

  const filtered = React.useMemo(() => {
    if (!items) return [];
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (activeFilter !== "ALL" && item.type !== activeFilter) return false;
      if (!q) return true;
      return (
        item.title.toLowerCase().includes(q) ||
        (item.conversationTitle ?? "").toLowerCase().includes(q) ||
        runtimeFor(item.type, item.language).label.toLowerCase().includes(q)
      );
    });
  }, [items, query, activeFilter]);

  /**
   * Start a design at a preset, and open it where every artifact opens.
   *
   * `creating` is not cleared on success: the page is on its way out, and a
   * button that went idle between the POST and the editor's first paint would
   * invite a second design. On failure it clears and the toast says why, in
   * the route's words when it gave some ("Your plan does not include the
   * canvas.").
   */
  const createDesign = React.useCallback(
    async (preset: DesignPresetKey) => {
      setCreating(preset);
      try {
        const id = await startDesign(preset);
        router.push(artifactHref(id));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : START_DESIGN_ERROR);
        setCreating(null);
      }
    },
    [router]
  );

  const empty = !loading && !error && items.length === 0;
  const noResults = !loading && !error && items.length > 0 && filtered.length === 0;
  // The Designs filter with no designs under it: not "no matching artifacts",
  // which blames a search nobody typed, and not the page's first-run empty
  // state, which talks about everything else. This is where a `/design`
  // bookmark lands for someone who has not made one yet.
  const designsEmpty = !loading && !error && designsView && !counts.get("DESIGN");
  // The page's own empty state carries New itself; the header's comes back the
  // moment there is anything else on the page to act on.
  const firstRunEmpty = empty && !designsView;

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
      toast.success("Moved to Recently deleted.");
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

  /**
   * New ▾ — the page's one way to make something here.
   *
   * Its first section is Design, and choosing a size creates the design at
   * once and lands on it (04-MERGE-PLAN §4.2, §7.1): no dialog, no name to
   * think of first. Everything else Juno makes is made in a conversation, so
   * the header's menu ends on that door; the empty state leaves it off,
   * because "Start building" sits beside it saying the same.
   *
   * One open state for both placements. Only one is ever mounted, and
   * `?new=design` has to open whichever that is.
   *
   * While a design is being made the trigger shows the spinner (Button's own
   * `loading`: it holds its width and refuses a second press) and every preset
   * is disabled, in the menu and in the pinned row.
   */
  const renderNewMenu = (placement: "header" | "empty") => (
    <DropdownMenu open={newMenuOpen} onOpenChange={setNewMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant={placement === "header" ? "default" : "secondary"}
          loading={creating !== null}
          className="gap-1.5"
        >
          {placement === "header" ? (
            <>
              <Plus className="size-3.5" aria-hidden />
              New
            </>
          ) : (
            <>
              <AppIcons.design className="size-3.5" aria-hidden />
              New design
            </>
          )}
          <ChevronDown className="-mr-0.5 size-3.5 opacity-70" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={placement === "header" ? "end" : "center"} className={MENU_W}>
        <DropdownMenuLabel>Design</DropdownMenuLabel>
        {DESIGN_PRESETS.map((preset) => {
          const Glyph = PRESET_GLYPHS[preset.key];
          return (
            <DropdownMenuItem
              key={preset.key}
              disabled={creating !== null}
              onSelect={() => void createDesign(preset.key)}
            >
              <Glyph className="size-4" aria-hidden />
              {preset.label}
              <span className="ml-auto font-mono text-caption tabular-nums text-muted-foreground">{preset.detail}</span>
            </DropdownMenuItem>
          );
        })}
        {placement === "header" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => router.push("/chat")}>
              <MessagesSquare className="size-4" aria-hidden />{` Ask ${PRODUCT_NAME} in a new chat`}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    // `wide`, like Library, Projects, Work, Code and Connections. A list of
    // rows with a search field and a sort control has the same anatomy as those
    // and so has the same measure; `reading` (48rem) is for prose — Memory, a
    // roadmap detail, a knowledge document — not for a table. Artifacts was the
    // only list route at `reading`, so hopping Library → Artifacts in the
    // sidebar moved the column 16rem for no reason the user could see.
    <AppPage measure="wide">
      <AppPageHeader
        backHref="/library"
        backLabel={FEATURE_NAMES.library.label}
        /*
         * NO EYEBROW. It read "Canvas" over a heading that reads "Artifacts",
         * on a page the sidebar row "Artifacts" takes you to — three words for
         * two things, and the one word above the title named a DIFFERENT
         * surface (the Canvas is where an artifact opens, not where the list
         * lives). docs/design/PREMIUM_AUDIT.md §3 rule 15: anything above the
         * title has to say something the title does not.
         */
        heading={FEATURE_NAMES.artifacts.label}
        /*
         * WHAT IS HERE, NOT "EVERYTHING". It read "Everything Juno built with
         * you, newest first", and neither half was true: generated images and
         * a task's files are made with Juno and do not appear here (they join
         * when the index reads them, 04-MERGE-PLAN §4.2), and the list is in
         * order of last change, not of making. So it names the kinds it holds,
         * Designs first, because this page is where designs live now.
         */
        lede={`Designs, sites, documents, diagrams and code made with ${PRODUCT_NAME}.`}
        actions={
          <>
            {/* Not while the first-run empty state shows: it already offers
                New, 250px away, and a reader looking at two identical controls
                has to work out which one is the real one. The empty state's
                copy explains what it does; this one cannot. It comes back the
                moment there is a list to act on. */}
            {!firstRunEmpty && renderNewMenu("header")}
          </>
        }
      />

      {/* Search, count and view on one row; the type filter on its own row
          under it. Eight kinds do not fit beside a search field at any width
          this column has, so the row used to wrap into three: search, the
          kinds, then the view toggle stranded at the right on a line of its
          own. The kinds scroll sideways inside their strip instead. */}
      {!loading && !empty && !error && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1 basis-48 sm:max-w-xs">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search what you made"
                aria-label="Search what you made"
                className="pl-9"
              />
            </div>
            <span className="ed-annot ml-auto" aria-live="polite">
              {filtered.length === items.length ? items.length : `${filtered.length} of ${items.length}`}{" "}
              {items.length === 1 ? "artifact" : "artifacts"}
            </span>
            <SegmentedControl<ArtifactView>
              value={view}
              onChange={changeView}
              options={VIEW_OPTIONS}
              ariaLabel="Artifact view"
              className="shrink-0"
            />
          </div>
          {/* Shown while a filter is on even when it is the only chip — an
              account of nothing but designs, opened at `?type=DESIGN`, should
              still see which filter it is looking through. */}
          {(chips.length > 1 || activeFilter !== "ALL") && (
            <div className="no-scrollbar -mx-1 overflow-x-auto px-1">
              <SegmentedControl<HomeTypeFilter>
                value={activeFilter}
                onChange={changeTypeFilter}
                ariaLabel="Filter by type"
                // `w-max`, not `w-fit`: fit-content shrinks to the strip, and
                // the grid's equal columns then crush eight labels into each
                // other on a phone instead of letting the strip scroll.
                className="w-max"
                columns="content"
                optionClassName="whitespace-nowrap"
                options={(["ALL", ...chips] as const).map((t) => ({
                  value: t,
                  label: t === "ALL" ? "All" : TYPE_LABELS[t],
                  count: t === "ALL" ? items.length : (counts.get(t) ?? 0),
                }))}
              />
            </div>
          )}
        </div>
      )}

      {/*
       * THE PRESETS, PINNED ABOVE THE DESIGNS.
       *
       * `/design` led with these four, and it now redirects here with Designs
       * on (04-MERGE-PLAN §5.3). A person following that bookmark should find
       * the thing they came for where they left it — the first thing under the
       * filters — not have to learn that it moved into a menu. New ▾ holds the
       * same four for every other view. This row is a bridge: the plan keeps it
       * for sixty days after the redirect ships, then New alone carries it.
       */}
      {designsView && !loading && !error && (
        <section aria-label="Start a design" className={cn(!empty && "mt-5")}>
          {/* Four across from 40rem of the page, not of the window: inside the
              shell the page is what the sidebar leaves, and `sm:` put four
              presets in a column the window's width had said nothing about. */}
          <div className="grid grid-cols-2 gap-2 @[40rem]/page:grid-cols-4">
            {DESIGN_PRESETS.map((preset) => (
              <button
                key={preset.key}
                type="button"
                disabled={creating !== null}
                onClick={() => void createDesign(preset.key)}
                className={cn(
                  // No `transition-colors`: utilities are emitted after the
                  // components layer, so it would replace .pressable's own
                  // transition shorthand and drop `transform` off the list — the
                  // press would dip to scale(0.97) in a single frame. The house
                  // tile: cut from the control material (raised at rest, lifted
                  // on hover, pressed while held) at the card rung.
                  "control-neu pressable group flex flex-col items-start gap-0.5 rounded-card px-3 py-2.5 text-left",
                  creating !== null && "opacity-60"
                )}
              >
                <span className="flex items-center gap-1.5 text-ui font-medium">
                  {/* The plus hands over to the Design mark while the document
                      is being made, cross-fading in place, and only that mark
                      breathes — it is live state, the one thing allowed to loop. */}
                  <IconSwap
                    curve="spring"
                    swapped={creating === preset.key}
                    from={
                      <Plus
                        className="size-3.5 text-muted-foreground transition-colors duration-fast ease-out-soft group-hover:text-primary"
                        aria-hidden
                      />
                    }
                    to={
                      <AppIcons.design
                        className={cn("size-3.5 text-primary", creating === preset.key && "motion-safe:animate-icon-breathe")}
                        aria-hidden
                      />
                    }
                  />
                  {preset.label}
                </span>
                <span className="font-mono text-caption tabular-nums text-muted-foreground">{preset.detail}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {error ? (
        error === "offline" ? (
          <EmptyState
            tone="error"
            icon={WifiOff}
            title="You’re offline"
            description="Your artifacts will load again the moment the connection returns."
          />
        ) : (
          <LoadError title="Couldn’t load your artifacts" onRetry={load} />
        )
      ) : loading ? (
        <div role="status" aria-label="Loading artifacts">
          <div className="flex flex-wrap items-center gap-2" aria-hidden="true">
            <Skeleton className="h-9 w-full max-w-xs rounded-field" />
            <Skeleton className="ml-auto h-9 w-40 rounded-menu" />
          </div>
          <ul className="-mx-3 mt-5 space-y-1" aria-hidden="true">
            {[...Array(6)].map((_, i) => (
              <li key={i} className="flex items-center gap-4 px-3 py-3.5" style={staggerDelay(i, "tight")}>
                <span className="min-w-0 flex-1 space-y-2.5">
                  <Skeleton className="block h-3.5 w-48 max-w-full rounded-xs" />
                  <Skeleton className="block h-2.5 w-28 rounded-xs" />
                </span>
                <Skeleton className="hidden h-2.5 w-40 rounded-xs sm:block" />
              </li>
            ))}
          </ul>
        </div>
      ) : designsEmpty ? (
        <EmptyState
          className="mt-6"
          size="panel"
          icon={AppIcons.design}
          title="No designs yet"
          description={`Pick a size above to start one, or ask ${PRODUCT_NAME} in any chat to design a screen.`}
        />
      ) : empty ? (
        <EmptyState
          className="mt-6 motion-safe:animate-rise-in"
          icon={AppIcons.artifacts}
          title="No artifacts yet"
          description={`Ask ${PRODUCT_NAME} to build a page, a document or a diagram, or start a design from a blank frame.`}
          action={
            <>
              <Button size="sm" onClick={() => router.push("/chat")}>
                Start building
              </Button>
              {renderNewMenu("empty")}
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
                changeTypeFilter("ALL");
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
            return (
              <li
                key={item.id}
                style={staggerDelay(i, "tight")}
                // The house interactive card: it lifts onto the larger throw
                // under the pointer, like every tile that opens something, and
                // `data-icon-trigger` lets the kind glyph play its `lift` too.
                data-icon-trigger=""
                className={cn(
                  cardVariants({ variant: "interactive" }),
                  "group relative flex flex-col p-2 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
                )}
              >
                <ArtifactPreview
                  type={item.type}
                  preview={item.preview}
                  title={item.title}
                  // A design's poster is fetched by id and pinned to the
                  // version this list read, so it caches until the next one.
                  artifactId={item.id}
                  version={item.version}
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
                    href={artifactHref(item.id)}
                    className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-card after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                  >
                    <span className="block truncate text-ui font-medium">{item.title || "Untitled artifact"}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-caption tabular-nums text-muted-foreground">
                      {/* The list row's kind mark, at metadata size: a tile
                          previewing its source otherwise had no glyph at all,
                          so the two views named the same kind two ways. */}
                      <Icon className="size-3 shrink-0" motion="lift" aria-hidden />
                      <span className="truncate">
                        {rt.label}
                        {item.version > 1 && <span className="ml-1.5">v{item.version}</span>}
                      </span>
                      <time
                        dateTime={item.updatedAt}
                        title={new Date(item.updatedAt).toLocaleString()}
                        className="ml-auto shrink-0"
                      >
                        {timeAgo(item.updatedAt)}
                      </time>
                    </span>
                  </Link>
                  <div className="relative z-10 -mr-1 flex shrink-0 items-center">
                    {renderActions(item)}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        /*
         * The list, in the editorial language Projects and Memory set: no
         * glyph-in-a-tile at the head of every row (six of the same square
         * down the left edge was the loudest thing in the list, and said
         * nothing the kind column does not), a serif name, the chat it came
         * from in the interface sans, and kind, version and age as a mono
         * annotation in fixed columns, the way the eye reads a column down a
         * list. Rows sit on hairlines rather than floating on hover alone.
         * On a phone the columns fold into one mono line under the name.
         * Grid view keeps the pictures (a design's poster, a site's render).
         */
        <ul
          className="ed-list -mx-3 mt-5"
          aria-label={`${filtered.length} ${filtered.length === 1 ? "artifact" : "artifacts"}`}
        >
          {filtered.map((item, i) => {
            const rt = runtimeFor(item.type, item.language);
            const age = (
              <time dateTime={item.updatedAt} title={new Date(item.updatedAt).toLocaleString()}>
                {timeAgo(item.updatedAt)}
              </time>
            );
            return (
              <li
                key={item.id}
                style={staggerDelay(i, "tight")}
                className={`${rowClass} motion-safe:animate-rise-in [animation-fill-mode:backwards]`}
              >
                {/* The stretched link: the whole row opens the artifact; the
                    actions menu sits above it (relative z-10) so it stays
                    clickable. */}
                <Link
                  href={artifactHref(item.id)}
                  className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:rounded-control after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                >
                  <span className="ed-name block truncate text-foreground">{item.title || "Untitled artifact"}</span>
                  <span className="mt-1 block truncate text-ui text-muted-foreground">
                    {item.conversationTitle ? `in “${item.conversationTitle}”` : "Not in a chat"}
                  </span>
                  <span className="ed-annot mt-1.5 block truncate sm:hidden">
                    {rt.label}
                    {item.version > 1 && ` · v${item.version}`} · {age}
                  </span>
                </Link>

                <span className="ed-annot hidden w-24 shrink-0 truncate sm:block">{rt.label}</span>
                <span className="ed-annot hidden w-8 shrink-0 sm:block">{item.version > 1 ? `v${item.version}` : ""}</span>
                <span className="ed-annot hidden w-16 shrink-0 text-right sm:block">{age}</span>

                <div className="relative z-10 flex shrink-0 items-center">
                  {renderActions(item)}
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
              <Button type="button" variant="ghost" onClick={() => setRenameTarget(null)} disabled={renaming}>
                Cancel
              </Button>
              <Button type="submit" loading={renaming} disabled={!renameValue.trim()}>
                Rename
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
              It moves to Recently deleted for 30 days with every version, and any public link to it stops working
              until it is restored. The conversation it came from is untouched.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={submitDelete} loading={deleting}>
              Delete
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
