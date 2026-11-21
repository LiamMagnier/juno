"use client";

import * as React from "react";
import { toast } from "sonner";
import { AppIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchField } from "@/components/ui/search-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ContextTokenMark } from "@/components/chat/context-token-mark";
import { fileIconKey } from "@/lib/mentions/types";
import { formatBytes } from "@/lib/utils";
import { staggerDelay } from "@/lib/motion";
import { useLibrary } from "@/components/library/use-library";

/** The most a project takes from the Library in one go (the route's own cap). */
const MAX_PICK = 20;

/**
 * Add files already in the Library to a project's knowledge. Each pick is
 * cloned into the project on the same stored object, so nothing is uploaded
 * twice and the Library keeps its own copy (POST
 * /api/projects/[id]/knowledge/library). The route recognises copies by their
 * stored object and can import distinct files with the same name.
 */
export function ProjectLibraryDialog({
  open,
  onOpenChange,
  projectId,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  onAdded: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const [search, setSearch] = React.useState("");
  const { items: rows, error: failed, pending, reload, hasMore, loadMore, loadingMore } = useLibrary({ q: search, kind: "FILE", sort: "newest", deleted: false }, open);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [adding, setAdding] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setSearch("");
    setSelected(new Set());
  }, [open]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const toggle = (id: string, next: boolean) =>
    setSelected((current) => {
      const updated = new Set(current);
      if (next) {
        if (updated.size >= MAX_PICK) {
          toast.error(`Add up to ${MAX_PICK} files at a time.`);
          return current;
        }
        updated.add(id);
      } else updated.delete(id);
      return updated;
    });

  const add = async () => {
    if (!selected.size || adding) return;
    setAdding(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/knowledge/library`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentIds: [...selected] }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; attachments?: unknown[]; alreadyAdded?: number };
      if (!response.ok) throw new Error(data.error ?? "Couldn’t add those files.");
      if (data.attachments?.length) onAdded();
      else if (data.alreadyAdded) toast.info("Those files are already in this project.");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t add those files.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !adding && onOpenChange(next)}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-secondary text-muted-foreground" aria-hidden="true">
              <AppIcons.library className="size-4" />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-ui font-semibold text-foreground">Add from Library</DialogTitle>
              <DialogDescription className="text-caption text-muted-foreground">
                Files you’ve uploaded or shared in chats. The project gets its own copy; the Library keeps yours.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <SearchField value={query} onValueChange={setQuery} label="Search your Library" busy={pending && !!search} />

        <div className="-mx-2 max-h-[46vh] min-h-[16rem] overflow-y-auto overscroll-contain px-2">
          {failed ? (
            <EmptyState tone="error" size="panel" icon={StatusIcons.error} title="Couldn’t load your Library" description="Check your connection and try again." action={<Button variant="outline" size="sm" onClick={() => void reload()}>Try again</Button>} />
          ) : rows === null ? (
            <div role="status" className="flex flex-col gap-1.5">
              <span className="sr-only">Loading your Library…</span>
              {[...Array(6)].map((_, index) => (
                <div key={index} aria-hidden className="skeleton h-11 rounded-inner" style={staggerDelay(index)} />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState
              size="panel"
              title={search ? "Nothing matches" : "Your Library has no files yet"}
              description={search ? `No file in your Library is called “${search}”.` : "Files you upload or share in a chat collect here."}
            />
          ) : (
            <div role="list" aria-label="Library files" className="space-y-px">
              {rows.map((row) => {
                const id = `pj-lib-${row.id}`;
                const checked = selected.has(row.id);
                return (
                  <div
                    role="listitem"
                    key={row.id}
                    data-selected={checked ? "" : undefined}
                    className="pj-pick flex min-h-11 items-center gap-3 rounded-inner px-2 py-1.5 transition-colors duration-fast ease-out-soft hover:bg-accent"
                  >
                    <Checkbox id={id} checked={checked} disabled={pending || adding} onCheckedChange={(next) => toggle(row.id, next === true)} />
                    <ContextTokenMark source={{ kind: "file", id: row.id, icon: fileIconKey(row.mimeType, row.fileName) }} size={20} />
                    <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
                      <span className="block truncate text-ui font-medium text-foreground">{row.fileName}</span>
                      <span className="block truncate text-caption text-muted-foreground">
                        {formatBytes(row.size)}
                      </span>
                    </label>
                  </div>
                );
              })}
              {hasMore && <Button variant="ghost" size="sm" disabled={pending} loading={loadingMore} onClick={() => void loadMore()}>Show more</Button>}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={adding}>
            Cancel
          </Button>
          <Button onClick={() => void add()} disabled={selected.size === 0} loading={adding}>
            {selected.size ? `Add ${selected.size} ${selected.size === 1 ? "file" : "files"}` : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
