"use client";

import * as React from "react";
import { toast } from "sonner";
import { EyeOff, X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PRODUCT_NAME } from "@/lib/brand/names";

/*
 * TOPICS NOT REMEMBERED — the person's own exclusions, beside the six fixed
 * sensitive switches in Settings.
 *
 * Adding a topic is a forget: whatever is already remembered about it is
 * retired, and nothing about it is learned again, by any path (see
 * src/lib/memory-topics.ts and /api/memory/topics). Removing one lifts the
 * block for the future; it does not bring retired facts back, which is why
 * the dialog says so.
 */

interface TopicRow {
  id: string;
  topic: string;
  createdAt: string;
}

async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? "Couldn’t update your topics. Try again in a moment.";
}

export function ExcludedTopicsDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Facts were retired: the page reloads its list. */
  onChanged: () => void;
}) {
  const [topics, setTopics] = React.useState<TopicRow[] | null>(null);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setTopics(null);
    fetch("/api/memory/topics")
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res));
        return (await res.json()) as { topics: TopicRow[] };
      })
      .then((data) => live && setTopics(data.topics))
      .catch((error) => {
        if (!live) return;
        setTopics([]);
        toast.error(error instanceof Error ? error.message : "Couldn’t load your topics.");
      });
    return () => {
      live = false;
    };
  }, [open]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const topic = draft.trim();
    if (!topic || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/memory/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const data = (await res.json()) as { topics: TopicRow[]; retired: number };
      setTopics(data.topics);
      setDraft("");
      toast.success(
        data.retired > 0
          ? `${data.retired} remembered ${data.retired === 1 ? "fact" : "facts"} about it forgotten. Nothing about it will be learned again.`
          : "Nothing about it will be learned."
      );
      if (data.retired > 0) onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t add that topic.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: TopicRow) => {
    setRemoving(row.id);
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(await readError(res));
      setTopics((current) => (current ?? []).filter((item) => item.id !== row.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t remove that topic.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Topics not remembered</DialogTitle>
          <DialogDescription>
            {`${PRODUCT_NAME} forgets what it already knows about a topic you add here, and never learns anything about it again — from chats, edits or other devices. Removing a topic only allows it from now on.`}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={add} className="flex items-center gap-2">
          <label htmlFor="excluded-topic" className="sr-only">
            Topic
          </label>
          <Input
            id="excluded-topic"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="e.g. my divorce, my side business"
            maxLength={120}
            autoComplete="off"
          />
          <Button type="submit" loading={saving} disabled={!draft.trim()}>
            Add
          </Button>
        </form>
        <div className="mt-1 min-h-[3rem]" aria-live="polite">
          {topics === null ? (
            <p className="text-caption text-muted-foreground">Loading…</p>
          ) : topics.length === 0 ? (
            <p className="text-caption text-muted-foreground">No topics yet.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5" data-excluded-topics="">
              {topics.map((row) => (
                <li
                  key={row.id}
                  className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-secondary pl-2.5 pr-1 text-caption font-medium text-foreground"
                >
                  <EyeOff className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{row.topic}</span>
                  <button
                    type="button"
                    onClick={() => void remove(row)}
                    disabled={removing === row.id}
                    aria-label={`Allow ${row.topic} again`}
                    className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors duration-fast ease-out-soft hover:bg-foreground/10 hover:text-foreground disabled:opacity-50"
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
