"use client";

import * as React from "react";
import { toast } from "sonner";
import { ArrowLeft, Check, Loader2, Pencil, Plus, Search, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// Mirrors the zod bounds in /api/prompts — the server stays the authority; these
// only keep the user from typing past a rejection.
const MAX_TITLE = 80;
const MAX_BODY = 10_000;

interface SavedPrompt {
  id: string;
  title: string;
  body: string;
  useCount: number;
  createdAt: string;
  updatedAt: string;
}

/** "new" = the editor is open on an unsaved prompt. */
type Editing = SavedPrompt | "new" | null;

interface PromptLibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Receives the prompt body; the caller decides how it lands in the draft. */
  onInsert: (body: string) => void;
}

/** Reusable prompt templates: save one, search the library, drop it into the composer. */
export function PromptLibraryDialog({ open, onOpenChange, onInsert }: PromptLibraryDialogProps) {
  const [prompts, setPrompts] = React.useState<SavedPrompt[] | null>(null);
  const [error, setError] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<Editing>(null);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [confirmingId, setConfirmingId] = React.useState<string | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(false);
    setPrompts(null);
    try {
      const r = await fetch("/api/prompts");
      if (!r.ok) throw new Error();
      setPrompts(((await r.json()).prompts ?? []) as SavedPrompt[]);
    } catch {
      setError(true);
      setPrompts([]);
    }
  }, []);

  // Reload on each open — prompts may have been edited elsewhere — and reset the view.
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setEditing(null);
    setConfirmingId(null);
    load();
  }, [open, load]);

  // An armed delete disarms itself, so a forgotten confirm can't be hit by a later stray click.
  React.useEffect(() => {
    if (!confirmingId) return;
    const t = setTimeout(() => setConfirmingId(null), 4000);
    return () => clearTimeout(t);
  }, [confirmingId]);

  const openEditor = (target: SavedPrompt | "new") => {
    setConfirmingId(null);
    setEditing(target);
    setTitle(target === "new" ? "" : target.title);
    setBody(target === "new" ? "" : target.body);
  };

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = prompts ?? [];
    if (!q) return all;
    return all.filter((p) => p.title.toLowerCase().includes(q) || p.body.toLowerCase().includes(q));
  }, [prompts, query]);

  const insert = (p: SavedPrompt) => {
    onInsert(p.body);
    onOpenChange(false);
    setPrompts((prev) => prev?.map((x) => (x.id === p.id ? { ...x, useCount: x.useCount + 1 } : x)) ?? prev);
    // Fire-and-forget: the counter is a nicety and must never gate the insertion.
    void fetch(`/api/prompts/${p.id}`, { method: "POST" }).catch(() => {});
  };

  const save = async () => {
    const nextTitle = title.trim();
    const nextBody = body.trim();
    if (!nextTitle || !nextBody || !editing) return;

    const target = editing === "new" ? null : editing;
    setSaving(true);
    try {
      const r = await fetch(target ? `/api/prompts/${target.id}` : "/api/prompts", {
        method: target ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: nextTitle, body: nextBody }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "Couldn't save that prompt.");
      const saved = d.prompt as SavedPrompt;
      // Saving refreshes updatedAt, which is the server's sort key — lead with it.
      setPrompts((prev) => [saved, ...(prev ?? []).filter((p) => p.id !== saved.id)]);
      setEditing(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save that prompt.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    setConfirmingId(null);
    setDeletingId(id);
    try {
      const r = await fetch(`/api/prompts/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error();
      setPrompts((prev) => prev?.filter((p) => p.id !== id) ?? prev);
    } catch {
      toast.error("Couldn't delete that prompt.");
    } finally {
      setDeletingId(null);
    }
  };

  const loading = prompts === null;
  const canSave = title.trim().length > 0 && body.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {editing ? (
          <>
            <DialogHeader>
              <DialogTitle>{editing === "new" ? "New prompt" : "Edit prompt"}</DialogTitle>
              <DialogDescription>Save a template you reuse, then drop it into any chat.</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="prompt-title" className="font-mono text-label uppercase text-muted-foreground">
                    Title
                  </label>
                  <span className="text-caption text-muted-foreground/60">
                    {title.length}/{MAX_TITLE}
                  </span>
                </div>
                <Input
                  id="prompt-title"
                  value={title}
                  maxLength={MAX_TITLE}
                  autoFocus
                  placeholder="Weekly status update"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="prompt-body" className="font-mono text-label uppercase text-muted-foreground">
                  Prompt
                </label>
                <Textarea
                  id="prompt-body"
                  value={body}
                  maxLength={MAX_BODY}
                  rows={9}
                  placeholder="Write the prompt you want to reuse…"
                  className="min-h-[14rem] resize-none"
                  onChange={(e) => setBody(e.target.value)}
                />
              </div>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={saving} className="gap-1.5">
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </Button>
              <Button onClick={save} disabled={saving || !canSave} className="gap-1.5">
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />}
                {editing === "new" ? "Save prompt" : "Save changes"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Prompt library</DialogTitle>
              <DialogDescription>Reusable prompts you’ve saved. Pick one to drop it into the composer.</DialogDescription>
            </DialogHeader>

            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search prompts…"
                  aria-label="Search prompts"
                  className="pl-8"
                />
              </div>
              <Button size="sm" className="gap-1.5" onClick={() => openEditor("new")}>
                <Plus className="h-3.5 w-3.5" /> New
              </Button>
            </div>

            <div className="max-h-[52vh] min-h-[16rem] overflow-y-auto pr-1">
              {error ? (
                <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
                  <p className="text-sm text-muted-foreground">Couldn’t load your prompts.</p>
                  <Button variant="outline" size="sm" onClick={load}>
                    Try again
                  </Button>
                </div>
              ) : loading ? (
                <div className="space-y-2">
                  {[...Array(5)].map((_, i) => (
                    // Radius tracks the real card below (rounded-xl) so the list
                    // doesn't reflow its corners when the fetch resolves.
                    <div key={i} className="skeleton h-16 rounded-xl" style={{ animationDelay: `${i * 50}ms` }} />
                  ))}
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex h-64 flex-col items-center justify-center gap-1 text-center">
                  <p className="font-serif text-heading">{query ? "No matches." : "No saved prompts yet."}</p>
                  <p className="text-sm text-muted-foreground">
                    {query ? "Try a different search." : "Save a prompt you keep retyping and it’ll live here."}
                  </p>
                </div>
              ) : (
                <ul className="space-y-2">
                  {filtered.map((p) => {
                    const confirming = confirmingId === p.id;
                    const busy = deletingId === p.id;
                    return (
                      <li
                        key={p.id}
                        className={cn(
                          // rounded-xl is 12px; rounded-lg would be 24px, which on a
                          // ~70px p-2.5 row swallows the corners.
                          "group flex items-start gap-2 rounded-xl border bg-card p-2.5 shadow-soft transition-[border-color,box-shadow,opacity] duration-base ease-out-soft hover:border-primary/35 hover:shadow-float",
                          busy && "pointer-events-none opacity-60"
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => insert(p)}
                          className="min-w-0 flex-1 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                        >
                          <p className="truncate text-sm font-medium">{p.title}</p>
                          <p className="line-clamp-2 text-caption text-muted-foreground">{p.body}</p>
                          {p.useCount > 0 && (
                            <p className="mt-1 font-mono text-caption uppercase tracking-[0.14em] text-muted-foreground/60">
                              Used {p.useCount}×
                            </p>
                          )}
                        </button>

                        <div className="flex shrink-0 items-center gap-1">
                          {confirming ? (
                            <Button
                              variant="destructive"
                              size="sm"
                              autoFocus
                              className="gap-1.5"
                              onClick={() => remove(p.id)}
                            >
                              <Check className="h-3.5 w-3.5" /> Delete
                            </Button>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Edit ${p.title}`}
                                onClick={() => openEditor(p)}
                              >
                                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={`Delete ${p.title}`}
                                className="text-destructive hover:text-destructive"
                                onClick={() => setConfirmingId(p.id)}
                              >
                                {busy ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
