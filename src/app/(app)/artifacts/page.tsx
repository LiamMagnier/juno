"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import {
  ArrowLeft,
  Code2,
  Download,
  FileCode2,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Loader2,
  MessagesSquare,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Search,
  Share2,
  Trash2,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";

const ICONS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
};

/** Filter-chip labels — what the artifact IS, not its file format. */
const TYPE_LABELS: Record<ArtifactType, string> = {
  HTML: "Sites",
  REACT: "Components",
  CODE: "Code",
  MARKDOWN: "Documents",
  SVG: "Graphics",
  MERMAID: "Diagrams",
};

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  HTML: "html",
  REACT: "tsx",
  SVG: "svg",
  MARKDOWN: "md",
  MERMAID: "mmd",
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

const createdDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const createdDateWithYear = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function formatCreated(iso: string): string {
  const d = new Date(iso);
  const fmt = d.getFullYear() === new Date().getFullYear() ? createdDate : createdDateWithYear;
  return fmt.format(d);
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
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
        <div className="mb-1 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" aria-hidden />
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Canvas</span>
        </div>
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="font-serif text-display font-medium tracking-tight">Artifacts</h1>
          {!loading && !empty && !error && (
            <span className="shrink-0 font-mono text-caption text-muted-foreground tabular-nums">
              {items.length} {items.length === 1 ? "artifact" : "artifacts"}
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Everything Juno built with you, newest first.</p>

        {/* Search + type filters — only once there is something to filter. */}
        {!loading && !empty && !error && (
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative sm:max-w-xs sm:flex-1">
              <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
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
              <div role="group" aria-label="Filter by type" className="flex flex-wrap items-center gap-1.5">
                {(["ALL", ...presentTypes] as const).map((t) => {
                  const selected = typeFilter === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTypeFilter(t)}
                      aria-pressed={selected}
                      className={cn(
                        "pressable rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em]",
                        selected
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/60 text-muted-foreground hover:border-border hover:text-foreground"
                      )}
                    >
                      {t === "ALL" ? "All" : TYPE_LABELS[t]}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {error ? (
          <div className="mt-16 flex flex-col items-center gap-3 text-center motion-safe:animate-rise-in">
            {error === "offline" && <WifiOff className="h-5 w-5 text-muted-foreground/60" aria-hidden />}
            <p className="font-serif text-heading">{error === "offline" ? "You're offline" : "Couldn't load your artifacts"}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {error === "offline"
                ? "Your artifacts will load again the moment the connection returns."
                : "Something went wrong on the way here."}
            </p>
            <Button variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </div>
        ) : loading ? (
          <div className="mt-6 divide-y divide-border/50 rounded-[16px] border border-border/60">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="skeleton size-8 rounded-[10px]" style={{ animationDelay: `${i * 60}ms` }} />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="skeleton h-3.5 w-44 max-w-full rounded-full" style={{ animationDelay: `${i * 60}ms` }} />
                  <div className="skeleton h-2.5 w-64 max-w-full rounded-full" style={{ animationDelay: `${i * 60 + 40}ms` }} />
                </div>
              </div>
            ))}
          </div>
        ) : empty ? (
          <div className="mt-12 flex flex-col items-center gap-3 py-10 text-center motion-safe:animate-rise-in">
            <p className="font-serif text-heading">Nothing here yet.</p>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              Ask Juno to build a page, component, document, or diagram — it opens in the Canvas and collects here.
            </p>
            <Button size="sm" className="mt-2" onClick={() => router.push("/chat")}>
              Start building
            </Button>
          </div>
        ) : noResults ? (
          <div className="mt-12 flex flex-col items-center gap-3 py-10 text-center motion-safe:animate-fade-in">
            <p className="font-serif text-heading">No matches.</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              Nothing fits {query.trim() ? `"${query.trim()}"` : "these filters"}.
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setQuery("");
                setTypeFilter("ALL");
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <ul className="mt-6 divide-y divide-border/50 overflow-hidden rounded-[16px] border border-border/60 bg-card/40">
            {filtered.map((item, i) => {
              const Icon = ICONS[item.type] ?? FileCode2;
              const rt = runtimeFor(item.type, item.language);
              return (
                <li
                  key={item.id}
                  style={{ animationDelay: `${Math.min(i, 10) * 30}ms` }}
                  className="group relative flex items-center gap-3 px-3 py-2.5 transition-colors duration-fast ease-out-soft hover:bg-accent/40 motion-safe:animate-rise-in [animation-fill-mode:backwards] sm:px-4"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-border/60 bg-muted/50 text-muted-foreground transition-colors duration-base ease-out-soft group-hover:border-primary/25 group-hover:text-primary">
                    <Icon className="size-4" aria-hidden />
                  </span>
                  <Link
                    href={`/chat/${item.conversationId}?artifact=${encodeURIComponent(item.identifier)}`}
                    className="min-w-0 flex-1 outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-[16px] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-primary/40"
                  >
                    <span className="block truncate text-sm font-medium leading-5">{item.title || "Untitled artifact"}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      <span className="shrink-0">{rt.label}</span>
                      {item.version > 1 && (
                        <>
                          <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
                          <span className="shrink-0">v{item.version}</span>
                        </>
                      )}
                      <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
                      <span className="min-w-0 truncate normal-case tracking-normal">Updated {timeAgo(item.updatedAt)}</span>
                      <span aria-hidden className="hidden size-1 shrink-0 rounded-full bg-border sm:inline-block" />
                      <span className="hidden shrink-0 normal-case tracking-normal sm:inline">Created {formatCreated(item.createdAt)}</span>
                      <span aria-hidden className="hidden size-1 shrink-0 rounded-full bg-border md:inline-block" />
                      <span className="hidden min-w-0 truncate normal-case tracking-normal md:inline">in “{item.conversationTitle}”</span>
                    </span>
                  </Link>

                  {/* Row actions sit above the stretched link. */}
                  <div className="relative z-10 flex shrink-0 items-center gap-0.5">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${item.title || "artifact"}`}
                          className="text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 coarse:opacity-100"
                        >
                          {downloadingId === item.id ? (
                            <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
                          ) : (
                            <MoreHorizontal className="h-4 w-4" aria-hidden />
                          )}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56">
                        <DropdownMenuItem onSelect={() => router.push(`/chat/${item.conversationId}?artifact=${encodeURIComponent(item.identifier)}`)}>
                          <PanelRightOpen className="h-4 w-4" aria-hidden /> Open in canvas
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => router.push(`/chat/${item.conversationId}`)}>
                          <MessagesSquare className="h-4 w-4" aria-hidden /> Open conversation
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => openRename(item)}>
                          <Pencil className="h-4 w-4" aria-hidden /> Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => download(item)}>
                          <Download className="h-4 w-4" aria-hidden /> Download source
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setShareTarget(item)}>
                          <Share2 className="h-4 w-4" aria-hidden /> Share
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onSelect={() => setDeleteTarget(item)}
                          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" aria-hidden /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
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
            <DialogTitle className="font-serif">Rename artifact</DialogTitle>
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
            <DialogTitle className="font-serif">Delete “{deleteTarget?.title || "artifact"}”?</DialogTitle>
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
