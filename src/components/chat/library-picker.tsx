"use client";

import * as React from "react";
import { toast } from "sonner";
import { Check, Loader2 } from "lucide-react";
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add from your library</DialogTitle>
          <DialogDescription>Attach files and images you’ve shared with Juno before.</DialogDescription>
        </DialogHeader>

        <div className="flex w-fit items-center gap-1 rounded-full border bg-card p-1 shadow-soft">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className={cn(
                "pressable rounded-full px-3.5 py-1.5 font-mono text-[10px] coarse:py-2.5",
                tab === t.key ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent/40 hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="max-h-[52vh] min-h-[16rem] overflow-y-auto pr-1">
          {error ? (
            <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted-foreground">Couldn’t load your library.</p>
              <Button variant="outline" size="sm" onClick={load}>Try again</Button>
            </div>
          ) : loading ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {[...Array(8)].map((_, i) => (
                <div key={i} className="skeleton aspect-square rounded-lg" style={staggerDelay(i)} />
              ))}
            </div>
          ) : empty ? (
            <div className="flex h-64 flex-col items-center justify-center gap-1 text-center">
              <p className="font-serif text-heading">Nothing here yet.</p>
              <p className="text-sm text-muted-foreground">Files and images you send in chat collect here.</p>
            </div>
          ) : (
            // ONE GRID, NOT TWO. Images were tiles and files were list rows, so
            // the same dialog taught two different ways of picking depending on
            // what you happened to have saved — and the file rows spent their
            // width on a filename and a byte count while showing nothing of the
            // file. Everything is a tile now; `FilePreview` decides what goes
            // inside one.
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
                      "group relative aspect-square overflow-hidden rounded-lg border bg-muted shadow-soft",
                      "transition-all duration-base ease-out-soft hover:-translate-y-0.5 hover:shadow-float active:translate-y-0 active:scale-[0.98] motion-reduce:transition-none",
                      isSel && "ring-2 ring-primary"
                    )}
                  >
                    <FilePreview item={i} className="absolute inset-0" sizes="160px" />
                    <span
                      className={cn(
                        "absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border bg-background/80 backdrop-blur transition-colors",
                        isSel ? "border-primary bg-primary text-primary-foreground" : "border-border text-transparent group-hover:border-primary/70"
                      )}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </span>
                    {/* The name is the caption, not the content: it appears on
                        hover over every tile, so an image and a document are
                        identified the same way. */}
                    <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/65 to-transparent p-1.5 text-left text-caption text-white opacity-0 transition-opacity group-hover:opacity-100 motion-reduce:transition-none">
                      {i.fileName}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={attaching}>
            Cancel
          </Button>
          <Button onClick={doAttach} disabled={attaching || selected.size === 0} className="gap-1.5">
            {attaching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {selected.size > 0 ? `Attach ${selected.size}` : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
