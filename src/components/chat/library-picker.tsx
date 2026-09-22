"use client";

import * as React from "react";
import { toast } from "sonner";
import { FolderOpen, Loader2 } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { FilePreview } from "@/components/chat/file-preview";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { MAX_ATTACHMENTS } from "@/lib/uploads";
import { cn } from "@/lib/utils";
import type { ClientAttachment } from "@/types/chat";
import { staggerDelay } from "@/lib/motion";

interface LibItem {
  id: string;
  kind: "IMAGE" | "FILE";
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
}

const TABS: { key: "all" | "IMAGE" | "FILE"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "IMAGE", label: "Images" },
  { key: "FILE", label: "Files" },
];

interface LibraryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with freshly-cloned, ready-to-send attachments. */
  onAttach: (attachments: ClientAttachment[]) => void;
  /** Attachments already staged in the composer — counts against the per-message cap. */
  existingCount?: number;
}

/** Pick previously-shared files/images from the Library and attach them to the
 *  current message. Selected items are cloned server-side (reusing their stored
 *  object) into fresh attachments the composer can send. */
export function LibraryPicker({ open, onOpenChange, onAttach, existingCount = 0 }: LibraryPickerProps) {
  const [items, setItems] = React.useState<LibItem[] | null>(null);
  const [error, setError] = React.useState(false);
  const [tab, setTab] = React.useState<"all" | "IMAGE" | "FILE">("all");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [attaching, setAttaching] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(false);
    setItems(null);
    try {
      const r = await fetch("/api/library");
      if (!r.ok) throw new Error();
      setItems((await r.json()).items ?? []);
    } catch {
      setError(true);
      setItems([]);
    }
  }, []);

  // Reload each time the picker opens (the library may have changed) and reset state.
  React.useEffect(() => {
    if (open) {
      setSelected(new Set());
      setTab("all");
      load();
    }
  }, [open, load]);

  const filtered = (items ?? []).filter((i) => tab === "all" || i.kind === tab);
  const loading = items === null;
  const empty = !loading && filtered.length === 0;

  // Selection headroom accounts for files already staged in the composer, so the
  // combined total can't exceed the server's per-message attachment cap.
  const remaining = Math.max(0, MAX_ATTACHMENTS - existingCount);
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < remaining) next.add(id);
      else
        toast.error(
          remaining === 0
            ? `You’ve reached the ${MAX_ATTACHMENTS}-file limit for this message.`
            : `You can attach ${remaining} more ${remaining === 1 ? "file" : "files"} to this message.`
        );
      return next;
    });

  const doAttach = async () => {
    if (selected.size === 0) return;
    setAttaching(true);
    try {
      const r = await fetch("/api/library/attach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachmentIds: [...selected] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn’t attach those files.");
      onAttach((d.attachments ?? []) as ClientAttachment[]);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn’t attach those files.");
    } finally {
      setAttaching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden p-6">
        <DialogHeader className="gap-2">
          <div className="flex items-center gap-3">
            {/* A quiet tile, not a coral one: the accent is state and the
                primary action (Attach), never the furniture of a header. */}
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-muted-foreground">
              <FolderOpen aria-hidden="true" className="size-4" />
            </div>
            <div>
              <DialogTitle className="font-sans text-title font-normal tracking-tight text-foreground">
                Add from your library
              </DialogTitle>
              <DialogDescription className="text-caption text-muted-foreground">
                Attach files and images you’ve previously shared with Juno.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* The shared filter control — the one the Library page itself draws
            for these same three tabs — so the thumb travels between segments
            on a spring instead of a raised pill snapping from one to the next,
            and the dialog reads as the page it borrows from. */}
        <SegmentedControl<"all" | "IMAGE" | "FILE">
          value={tab}
          onChange={setTab}
          ariaLabel="Filter your library"
          className="h-9 w-fit max-w-full"
          options={TABS.map((t) => ({ value: t.key, label: t.label }))}
        />

        <div className="max-h-[50vh] min-h-[16rem] overflow-y-auto pr-1">
          {error ? (
            <EmptyState
              tone="error"
              icon={StatusIcons.error}
              title="Couldn’t load your library"
              description="The request didn’t come back. Nothing has been lost — try again."
              action={
                <Button variant="outline" size="sm" onClick={load}>
                  Try again
                </Button>
              }
            />
          ) : loading ? (
            <div role="status" className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              <span className="sr-only">Loading your library…</span>
              {[...Array(8)].map((_, i) => (
                <div key={i} aria-hidden className="skeleton aspect-square rounded-field" style={staggerDelay(i)} />
              ))}
            </div>
          ) : empty ? (
            // The shared empty state, like the error state above it — two
            // states of one well, drawn by one component.
            <EmptyState
              icon={FolderOpen}
              title="Nothing here yet"
              description="Files and images you send in conversations collect here for quick reuse."
            />
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {filtered.map((i, index) => {
                const isSel = selected.has(i.id);
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => toggle(i.id)}
                    aria-pressed={isSel}
                    aria-label={i.fileName}
                    // Dealt in on the shared stagger, capped at the first
                    // eight — past that the grid is loading, not arriving.
                    style={staggerDelay(Math.min(index, 8), "tight")}
                    className={cn(
                      "surface-raised group relative aspect-square overflow-hidden rounded-field",
                      "[animation-fill-mode:backwards] motion-safe:animate-rise-in",
                      // Hover darkens the hairline; nothing lifts or casts a
                      // shadow (FLAT_UI.md §2). The press dips on --dur-press.
                      "transition-[transform,border-color] duration-fast ease-out-soft hover:border-foreground/25 active:scale-[0.98] active:duration-press motion-reduce:transition-none motion-reduce:active:scale-100",
                      isSel && "border-primary hover:border-primary"
                    )}
                  >
                    <FilePreview item={i} className="absolute inset-0" sizes="160px" />
                    {/* Selection is drawn INSIDE the tile, over the picture,
                        and fades in: an outer ring-offset painted a card-
                        coloured halo that belonged to no surface underneath
                        it, and an inset ring on the button itself would sit
                        under the preview and never be seen. */}
                    <span
                      aria-hidden="true"
                      className={cn(
                        "pointer-events-none absolute inset-0 rounded-inherit ring-1 ring-inset ring-primary transition-opacity duration-fast ease-out-soft motion-reduce:transition-none",
                        isSel ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <span
                      aria-hidden="true"
                      className={cn(
                        "absolute left-2 top-2 flex size-5 items-center justify-center rounded-xs border backdrop-blur-xs transition-colors duration-fast ease-out-soft motion-reduce:transition-none",
                        isSel
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border/80 bg-background/80 text-transparent group-hover:border-foreground/40"
                      )}
                    >
                      {/* 12px draws the set's bold cut on its own — no
                          stroke override needed to read on a 20px box. */}
                      <StatusIcons.success className="size-3" />
                    </span>
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2 text-left text-micro font-medium text-white opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none">
                      {i.fileName}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={attaching}>
            Cancel
          </Button>
          <Button
            onClick={doAttach}
            disabled={attaching || selected.size === 0}
            className="gap-1.5"
          >
            {attaching && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
            {selected.size > 0 ? `Attach ${selected.size} item${selected.size === 1 ? "" : "s"}` : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
