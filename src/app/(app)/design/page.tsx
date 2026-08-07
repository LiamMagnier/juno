"use client";

/**
 * Juno Design — the surface.
 *
 * Design is a mode, not a hidden artifact type. Before this page existed the
 * only way to reach the editor was to ask Juno for a design in the right words,
 * which is not something anyone finds by looking at the app — and it was
 * reported as "I don't see it" twice, correctly.
 *
 * This is deliberately a *list plus a start button*, not a second editor: the
 * editor lives at `/design/{artifactId}`, where it gets the whole window and
 * keeps its layers rail and inspector. Opening a design from here lands there.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, PenTool, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AppIcons } from "@/lib/app-icons";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { cn } from "@/lib/utils";

interface DesignItem {
  id: string;
  title: string;
  version: number;
  conversationId: string;
  updatedAt: string;
}

/** The sizes a new design can start at. Named for what they are, so the choice
 *  is about the thing being designed rather than about numbers. */
const PRESETS = [
  { key: "phone", label: "Phone", detail: "375 × 812" },
  { key: "tablet", label: "Tablet", detail: "834 × 1194" },
  { key: "desktop", label: "Desktop", detail: "1440 × 900" },
  { key: "square", label: "Square", detail: "1080 × 1080" },
] as const;

export default function DesignPage() {
  const router = useRouter();
  const [items, setItems] = React.useState<DesignItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<DesignItem | null>(null);
  const [deleting, setDeleting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/artifacts");
        if (!res.ok) throw new Error("Could not load your designs.");
        const data = (await res.json()) as { items: (DesignItem & { type: string })[] };
        if (cancelled) return;
        setItems(data.items.filter((item) => item.type === "DESIGN"));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load your designs.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startDesign = React.useCallback(
    async (preset: string) => {
      setCreating(preset);
      try {
        const res = await fetch("/api/design", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Untitled design", preset }),
        });
        const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!res.ok || !data.url) throw new Error(data.error ?? "Could not start a design.");
        router.push(data.url);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not start a design.");
        setCreating(null);
      }
    },
    [router]
  );

  const deleteDesign = React.useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/artifacts/${deleteTarget.id}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not delete this design.");
      setItems((current) => current.filter((item) => item.id !== deleteTarget.id));
      toast.success(`${deleteTarget.title} deleted.`);
      setDeleteTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete this design.");
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting]);

  const empty = !loading && !error && items.length === 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-16 pt-10">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="flex items-center gap-2.5 font-serif text-display font-medium tracking-tight">
          <AppIcons.design className="size-[0.85em] shrink-0 text-muted-foreground/80" strokeWidth={1.6} aria-hidden />
          Design
        </h1>
        {!loading && !empty && !error && (
          <span className="shrink-0 font-mono text-caption text-muted-foreground tabular-nums">
            {items.length} {items.length === 1 ? "design" : "designs"}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Draw it yourself, or ask Juno — “design a mobile sign-in screen”. Either way it opens as an editable document
        you can select, restyle and hand to Juno Code.
      </p>

      {/* Starting a design is the primary action, so it is the first thing on
          the page rather than a button hiding above a list. */}
      <section className="mt-6" aria-label="Start a design">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              disabled={creating !== null}
              onClick={() => void startDesign(preset.key)}
              className={cn(
                "pressable group flex flex-col items-start gap-0.5 rounded-[14px] border border-border/60 bg-card/40 px-3 py-2.5 text-left transition-colors duration-fast",
                "hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                creating !== null && "opacity-60"
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {creating === preset.key ? (
                  <PenTool className="size-3.5 text-primary motion-safe:animate-pulse" aria-hidden />
                ) : (
                  <Plus className="size-3.5 text-muted-foreground group-hover:text-primary" aria-hidden />
                )}
                {preset.label}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{preset.detail}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="mt-10" aria-label="Your designs">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-[14px] bg-muted/50" />
            ))}
          </div>
        ) : error ? (
          <div className="rounded-[14px] border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : empty ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <p className="font-serif text-heading">No designs yet.</p>
            <p className="max-w-sm text-sm leading-6 text-muted-foreground">
              Pick a size above to start one, or ask Juno in any chat to design a screen.
            </p>
          </div>
        ) : (
          <>
            <p className="pb-2 font-mono text-[10px] text-muted-foreground">Recent</p>
            <ul className="space-y-1.5">
              {items.map((item) => (
                <li key={item.id}>
                  <div className="group flex items-center gap-1 rounded-[14px] border border-border/60 bg-card/40 p-1 transition-colors duration-fast hover:border-primary/40 hover:bg-accent">
                    <button
                      type="button"
                      onClick={() => router.push(`/design/${item.id}`)}
                      className="pressable flex min-w-0 flex-1 items-center gap-3 rounded-[11px] px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <AppIcons.design className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.title}</span>
                        <span className="block font-mono text-[10px] text-muted-foreground">
                          v{item.version} · {timeAgo(item.updatedAt)}
                        </span>
                      </span>
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Actions for ${item.title}`}
                          className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100"
                        >
                          <MoreHorizontal className="size-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          className="text-destructive focus:text-destructive"
                          onSelect={() => setDeleteTarget(item)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                          Delete design
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <p className="mt-10 text-caption text-muted-foreground">
        Designs are artifacts, so they keep full version history and appear in{" "}
        <Button variant="link" className="h-auto p-0 text-caption" onClick={() => router.push("/artifacts")}>
          Artifacts
        </Button>{" "}
        alongside everything else Juno built with you.
      </p>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {deleteTarget?.title}?</DialogTitle>
            <DialogDescription>
              Every version of this design and its history will be permanently removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={deleting}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => void deleteDesign()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete design"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
