"use client";

import * as React from "react";
import { toast } from "sonner";
import { FolderOpen, Loader2 } from "lucide-react";
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
      if (!r.ok) throw new Error(d.error ?? "Couldn't attach those files.");
      onAttach((d.attachments ?? []) as ClientAttachment[]);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't attach those files.");
    } finally {
      setAttaching(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl overflow-hidden rounded-2xl border border-border/70 bg-card/95 p-6 backdrop-blur-xl shadow-2xl">
        <DialogHeader className="gap-2">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary">
              <FolderOpen className="size-4.5" />
            </div>
            <div>
              <DialogTitle className="font-serif text-xl font-normal tracking-tight text-foreground">
                Add from your library
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground">
                Attach files and images you’ve previously shared with Juno.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* Tab Filters */}
        <div className="flex w-fit items-center gap-1 rounded-full border border-border/60 bg-secondary/80 p-1 shadow-xs">
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-pressed={isActive}
                className={cn(
                  "pressable rounded-full px-3.5 py-1 text-xs transition-all duration-200",
                  isActive
                    ? "bg-card font-medium text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>

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
                <div key={i} aria-hidden className="skeleton aspect-square rounded-xl" style={staggerDelay(i)} />
              ))}
            </div>
          ) : empty ? (
            <div className="flex min-h-[16rem] flex-col items-center justify-center rounded-2xl border border-dashed border-border/70 bg-secondary/30 p-8 text-center">
              <div className="flex size-11 items-center justify-center rounded-full border border-border/60 bg-secondary text-muted-foreground shadow-xs">
                <FolderOpen className="size-5" />
              </div>
              <h3 className="mt-3 font-serif text-base font-normal text-foreground">Nothing here yet</h3>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                Files and images you send in conversations collect here for quick reuse.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {filtered.map((i) => {
                const isSel = selected.has(i.id);
                return (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => toggle(i.id)}
                    aria-pressed={isSel}
                    aria-label={i.fileName}
                    className={cn(
                      "group relative aspect-square overflow-hidden rounded-xl border border-border/60 bg-secondary/50 shadow-xs",
                      "transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md active:translate-y-0 active:scale-[0.98]",
                      isSel && "border-primary ring-2 ring-primary/80 ring-offset-2 ring-offset-card"
                    )}
                  >
                    <FilePreview item={i} className="absolute inset-0" sizes="160px" />
                    <span
                      className={cn(
                        "absolute left-2 top-2 flex size-5 items-center justify-center rounded-md border backdrop-blur-xs transition-colors duration-150",
                        isSel
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border/80 bg-background/80 text-transparent group-hover:border-primary/70"
                      )}
                    >
                      <StatusIcons.success className="size-3.5 stroke-[2.5]" />
                    </span>
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2 text-left text-micro font-medium text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
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
            {attaching && <Loader2 className="size-3.5 animate-spin" />}
            {selected.size > 0 ? `Attach ${selected.size} item${selected.size === 1 ? "" : "s"}` : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
