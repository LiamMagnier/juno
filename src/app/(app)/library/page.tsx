"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowLeft, Check, Download, FileText, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { formatBytes, cn } from "@/lib/utils";

interface LibItem {
  id: string;
  kind: "IMAGE" | "FILE";
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
  conversationId: string | null;
}

const TABS: { key: "all" | "IMAGE" | "FILE"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "IMAGE", label: "Images" },
  { key: "FILE", label: "Files" },
];

/** A small select toggle shown over each library item. */
function SelectCheck({ checked, onClick, className }: { checked: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      aria-pressed={checked}
      aria-label={checked ? "Deselect" : "Select"}
      className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center rounded-md border bg-background/80 backdrop-blur transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent hover:border-primary/70",
        className
      )}
    >
      <Check className="h-3.5 w-3.5" />
    </button>
  );
}

function ItemAction({ icon: Icon, label, onClick, tone }: { icon: typeof Pencil; label: string; onClick: () => void; tone?: "danger" }) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
      className={cn("text-muted-foreground", tone === "danger" ? "danger-hover" : "hover:text-foreground")}
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}

export default function LibraryPage() {
  const router = useRouter();
  const [items, setItems] = React.useState<LibItem[] | null>(null);
  const [error, setError] = React.useState(false);
  const [tab, setTab] = React.useState<"all" | "IMAGE" | "FILE">("all");

  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = React.useState<LibItem | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [deleteTargets, setDeleteTargets] = React.useState<LibItem[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    try {
      const r = await fetch("/api/library");
      if (!r.ok) throw new Error();
      setItems((await r.json()).items);
    } catch {
      setError(true);
      setItems([]);
    }
  }, []);
  React.useEffect(() => {
    load();
  }, [load]);

  const filtered = (items ?? []).filter((i) => tab === "all" || i.kind === tab);
  const images = filtered.filter((i) => i.kind === "IMAGE");
  const files = filtered.filter((i) => i.kind === "FILE");
  const loading = items === null;
  const empty = !loading && filtered.length === 0;

  const selectedItems = filtered.filter((i) => selected.has(i.id));
  const allSelected = filtered.length > 0 && selectedItems.length === filtered.length;

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const clearSelection = () => setSelected(new Set());
  const toggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(filtered.map((i) => i.id)));

  const openRename = (item: LibItem) => {
    setRenameValue(item.fileName);
    setRenameTarget(item);
  };

  const doRename = async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.fileName) {
      setRenameTarget(null);
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`/api/attachments/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: name }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Could not rename.");
      setItems((prev) => prev?.map((i) => (i.id === renameTarget.id ? { ...i, fileName: d.fileName ?? name } : i)) ?? prev);
      toast.success("Renamed.");
      setRenameTarget(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not rename.");
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    if (!deleteTargets || deleteTargets.length === 0) return;
    const ids = deleteTargets.map((t) => t.id);
    setBusy(true);
    const results = await Promise.allSettled(
      ids.map((id) =>
        fetch(`/api/attachments/${id}`, { method: "DELETE" }).then((r) => {
          if (!r.ok) throw new Error();
          return id;
        })
      )
    );
    const okIds = new Set(results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : [])));
    setItems((prev) => prev?.filter((i) => !okIds.has(i.id)) ?? prev);
    setSelected((prev) => {
      const next = new Set(prev);
      okIds.forEach((id) => next.delete(id));
      return next;
    });
    const failed = ids.length - okIds.size;
    if (failed) toast.error(`${failed} ${failed === 1 ? "item" : "items"} couldn’t be deleted.`);
    else toast.success(`Deleted ${okIds.size} ${okIds.size === 1 ? "item" : "items"}.`);
    setBusy(false);
    setDeleteTargets(null);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
        <div className="mb-1 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label uppercase text-muted-foreground">Library</span>
        </div>
        <h1 className="font-serif text-display font-medium tracking-tight">Your files</h1>
        <p className="mt-1 text-sm text-muted-foreground">Everything you’ve shared with Juno, in one place.</p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <div className="flex w-fit items-center gap-1 rounded-[12px] bg-muted/70 p-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                aria-pressed={tab === t.key}
                className={cn(
                  "rounded-[9px] px-3 py-1 text-[13px] font-medium transition-all duration-fast ease-out-soft",
                  tab === t.key
                    ? "bg-card text-foreground shadow-pop"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {!loading && !empty && (
            <Button variant="ghost" size="sm" onClick={toggleSelectAll} className="text-muted-foreground">
              {allSelected ? "Clear selection" : "Select all"}
            </Button>
          )}
        </div>

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 motion-safe:animate-fade-in">
            <span className="text-sm font-medium">{selected.size} selected</span>
            <div className="ml-auto flex items-center gap-1.5">
              {selectedItems.length === 1 && (
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openRename(selectedItems[0])}>
                  <Pencil className="h-3.5 w-3.5" /> Rename
                </Button>
              )}
              <Button
                variant="destructive-outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setDeleteTargets(selectedItems)}
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={clearSelection} aria-label="Clear selection">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {error ? (
          <div className="mt-12 flex flex-col items-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">Couldn’t load your library.</p>
            <Button variant="outline" size="sm" onClick={load}>Try again</Button>
          </div>
        ) : loading ? (
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="skeleton aspect-square rounded-lg" style={{ animationDelay: `${i * 50}ms` }} />
            ))}
          </div>
        ) : empty ? (
          <div className="mt-10 flex flex-col items-center gap-4 text-center">
            <div>
              <p className="font-serif text-heading">Nothing here yet.</p>
              <p className="mt-1 text-sm text-muted-foreground">Files and images you send in chat will collect here.</p>
            </div>
          </div>
        ) : (
          <div className="mt-6 space-y-8">
            {images.length > 0 && (
              <section>
                {tab === "all" && <p className="mb-2 font-mono text-label uppercase text-muted-foreground">Images</p>}
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
                  {images.map((i) => {
                    const isSel = selected.has(i.id);
                    return (
                      <div
                        key={i.id}
                        className={cn(
                          "group relative aspect-square overflow-hidden rounded-lg border bg-muted shadow-soft transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:shadow-float",
                          isSel && "ring-2 ring-primary"
                        )}
                      >
                        <a href={i.url} target="_blank" rel="noopener noreferrer" className="block h-full w-full">
                          <Image src={i.url} alt={i.fileName} fill sizes="200px" className="object-cover" />
                          <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/60 to-transparent p-2 text-caption text-white opacity-0 transition-opacity group-hover:opacity-100">
                            {i.fileName}
                          </span>
                        </a>
                        <SelectCheck
                          checked={isSel}
                          onClick={() => toggleSelect(i.id)}
                          className={cn("absolute left-2 top-2 z-10", !isSel && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}
                        />
                        <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                          <ItemAction icon={Pencil} label="Rename" onClick={() => openRename(i)} />
                          <ItemAction icon={Trash2} label="Delete" tone="danger" onClick={() => setDeleteTargets([i])} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {files.length > 0 && (
              <section>
                {tab === "all" && <p className="mb-2 font-mono text-label uppercase text-muted-foreground">Files</p>}
                <div className="grid gap-2 sm:grid-cols-2">
                  {files.map((f) => {
                    const isSel = selected.has(f.id);
                    return (
                      <div
                        key={f.id}
                        className={cn(
                          "group flex items-center gap-3 rounded-lg border bg-card p-3 shadow-soft transition-shadow duration-base hover:shadow-float",
                          isSel && "ring-2 ring-primary"
                        )}
                      >
                        <SelectCheck checked={isSel} onClick={() => toggleSelect(f.id)} />
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <FileText className="h-5 w-5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{f.fileName}</p>
                          <p className="text-caption text-muted-foreground">
                            {formatBytes(f.size)} · {timeAgo(f.createdAt)}
                            {f.conversationId ? (
                              <>
                                {" · "}
                                <Link href={`/chat/${f.conversationId}`} className="underline-offset-2 hover:text-foreground hover:underline">
                                  open chat
                                </Link>
                              </>
                            ) : null}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <ItemAction icon={Pencil} label="Rename" onClick={() => openRename(f)} />
                          <Button variant="ghost" size="icon-sm" asChild className="text-muted-foreground hover:text-foreground">
                            <a href={f.url} target="_blank" rel="noopener noreferrer" aria-label="Download">
                              <Download className="h-4 w-4" />
                            </a>
                          </Button>
                          <ItemAction icon={Trash2} label="Delete" tone="danger" onClick={() => setDeleteTargets([f])} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {/* Rename dialog */}
      <Dialog open={!!renameTarget} onOpenChange={(open) => !open && setRenameTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename file</DialogTitle>
            <DialogDescription>Give this file a clearer name.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") doRename();
            }}
            autoFocus
            aria-label="File name"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenameTarget(null)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={doRename} disabled={busy || !renameValue.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm dialog */}
      <Dialog open={!!deleteTargets} onOpenChange={(open) => !open && setDeleteTargets(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete {deleteTargets?.length === 1 ? "this file" : `${deleteTargets?.length} files`}?</DialogTitle>
            <DialogDescription>
              This permanently removes {deleteTargets?.length === 1 ? "it" : "them"} from your library and storage. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteTargets(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={busy}>
              {busy ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
