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
import { AlertTriangle, MoreHorizontal, PenTool, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppPageHeader } from "@/components/app/app-page-header";
import { EmptyState } from "@/components/ui/empty-state";
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
import { staggerDelay } from "@/lib/motion";

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
    <div className="app-page-scroll">
      <div className="app-page-content max-w-3xl">
        <AppPageHeader
          eyebrow="Design"
          heading="Design"
          icon={AppIcons.design}
          lede="Draw it yourself, or ask Juno. Every design opens as an editable document you can restyle and hand to Juno Code."
          actions={!loading && !empty && !error ? (
          <span className="shrink-0 font-mono text-caption text-muted-foreground tabular-nums">
            {items.length} {items.length === 1 ? "design" : "designs"}
          </span>
          ) : undefined}
        />

      {/* Starting a design is the primary action, so it is the first thing on
          the page rather than a button hiding above a list. */}
      <section aria-label="Start a design">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              disabled={creating !== null}
              onClick={() => void startDesign(preset.key)}
              className={cn(
                // No `transition-colors`: utilities are emitted after the components
                // layer, so it replaced .pressable's own transition shorthand and
                // dropped `transform` off the list — the press dipped to scale(0.97)
                // in a single frame instead of easing, on the four biggest buttons
                // on this page. .pressable already animates colour and border.
                "pressable group flex flex-col items-start gap-0.5 rounded-menu border border-border/60 bg-card px-3 py-2.5 text-left",
                "hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                creating !== null && "opacity-60"
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium">
                {creating === preset.key ? (
                  <PenTool className="size-3.5 text-primary motion-safe:animate-icon-breathe" aria-hidden />
                ) : (
                  <Plus className="size-3.5 text-muted-foreground group-hover:text-primary" aria-hidden />
                )}
                {preset.label}
              </span>
              <span className="font-mono text-caption tabular-nums text-muted-foreground">{preset.detail}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="mt-10" aria-label="Your designs">
        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              // `i * 60` is STAGGER.loose written out by hand; said in the shared
              // vocabulary it also inherits the cap this list would need if the
              // placeholder count ever grew.
              <div key={i} className="skeleton h-14 rounded-menu" style={staggerDelay(i, "loose")} />
            ))}
          </div>
        ) : error ? (
          // Through EmptyState so a failed load is fenced and role="status" the way
          // it is on every other list page — this was unfenced text in a tint that
          // disappeared on the black ground.
          <EmptyState tone="error" icon={AlertTriangle} title="Couldn’t load your designs" description={error} />
        ) : empty ? (
          <EmptyState
            icon={AppIcons.design}
            title="No designs yet."
            description="Pick a size above to start one, or ask Juno in any chat to design a screen."
          />
        ) : (
          <>
            <p className="pb-2 font-mono text-label text-muted-foreground">Recent</p>
            <ul className="space-y-1.5">
              {items.map((item) => (
                <li key={item.id}>
                  <div className="group flex items-center gap-1 rounded-menu border border-border/60 bg-card p-1 transition-colors duration-fast ease-out-soft hover:border-primary/40 hover:bg-accent">
                    <button
                      type="button"
                      onClick={() => router.push(`/design/${item.id}`)}
                      // rounded-control, not rounded-composer-control. The row shell
                      // is rounded-menu (12) with p-1, so the concentric inner corner
                      // is 8 and a 12 inside it bulges past the curve containing it —
                      // visible at the row's left edge on every design in the list.
                      // The composer rung also has no business naming a list row.
                      className="pressable flex min-w-0 flex-1 items-center gap-3 rounded-control px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-primary/10 text-primary">
                        <AppIcons.design className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{item.title}</span>
                        <span className="block font-mono text-caption tabular-nums text-muted-foreground">
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
                          className="shrink-0 text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 motion-reduce:transition-none coarse:opacity-100"
                        >
                          <MoreHorizontal className="size-4" aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuItem
                          className="text-destructive focus:bg-destructive/10 focus:text-destructive"
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
    </div>
  );
}
