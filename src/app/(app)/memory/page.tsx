"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Brain, Check, Loader2, Pencil, Plus, RefreshCw, Search, Sparkles, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Markdown } from "@/components/chat/markdown";
import { DottedDivider } from "@/components/signature/dotted-divider";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { useApp } from "@/components/app/app-provider";
import { cn } from "@/lib/utils";

interface Memory {
  id: string;
  content: string;
  source: "AUTO" | "MANUAL";
  createdAt: string;
}

interface MemorySummary {
  content: string;
  updatedAt: string;
  entryCount: number;
}

export default function MemoryPage() {
  const router = useRouter();
  const { settings, setSettings } = useApp();
  const [memories, setMemories] = React.useState<Memory[] | null>(null);
  const [summary, setSummary] = React.useState<MemorySummary | null>(null);
  const [consolidating, setConsolidating] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editDraft, setEditDraft] = React.useState("");

  const load = React.useCallback(async (q?: string) => {
    const res = await fetch(`/api/memory${q ? `?q=${encodeURIComponent(q)}` : ""}`);
    if (res.ok) {
      const data = await res.json();
      setMemories(data.memories);
      setSummary(data.summary ?? null);
    }
  }, []);

  const regenerate = async () => {
    setConsolidating(true);
    try {
      const res = await fetch("/api/memory/consolidate", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not regenerate the summary.");
      setSummary(data.summary ?? null);
      toast.success(data.summary ? "Summary updated." : "No memories to summarize yet.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not regenerate the summary.");
    } finally {
      setConsolidating(false);
    }
  };

  React.useEffect(() => {
    const t = setTimeout(() => load(query.trim() || undefined), 250);
    return () => clearTimeout(t);
  }, [query, load]);

  const toggleMemory = async (enabled: boolean) => {
    setSettings({ memoryEnabled: enabled });
    await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memoryEnabled: enabled }),
    });
  };

  const addMemory = async () => {
    const content = draft.trim();
    if (!content) return;
    const res = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (res.ok) {
      const data = await res.json();
      setMemories((prev) => [data.memory, ...(prev ?? [])]);
      setDraft("");
      setAdding(false);
      toast.success("Memory added");
    } else toast.error("Could not add memory.");
  };

  const saveEdit = async (id: string) => {
    const content = editDraft.trim();
    if (!content) return;
    setMemories((prev) => prev?.map((m) => (m.id === id ? { ...m, content } : m)) ?? null);
    setEditingId(null);
    const res = await fetch(`/api/memory/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) toast.error("Could not save memory.");
  };

  const remove = async (id: string) => {
    setMemories((prev) => prev?.filter((m) => m.id !== id) ?? null);
    const res = await fetch(`/api/memory/${id}`, { method: "DELETE" });
    if (!res.ok) toast.error("Could not delete memory.");
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="mb-6 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="font-serif text-title font-medium">Memory</h1>
            <p className="text-caption text-muted-foreground">What Juno remembers about you, across conversations.</p>
          </div>
        </div>

        <Card className="mb-5 flex items-center justify-between p-4 rounded-[24px]">
          <div className="flex items-center gap-3">
            <Brain className="h-5 w-5 text-primary" />
            <div>
              <p className="text-sm font-medium">Memory is {settings.memoryEnabled ? "on" : "off"}</p>
              <p className="text-xs text-muted-foreground">
                {settings.memoryEnabled ? "Juno saves and uses memories." : "Juno won't save or use memories."}
              </p>
            </div>
          </div>
          <Switch checked={settings.memoryEnabled} onCheckedChange={toggleMemory} aria-label="Toggle memory" />
        </Card>

        {settings.memoryEnabled && (summary || (memories && memories.length > 0)) && (
          <Card className="mb-5 rounded-[24px] p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                <p className="text-sm font-medium">Memory summary</p>
                {summary && (
                  <span className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                    updated {timeAgo(summary.updatedAt)}
                  </span>
                )}
              </div>
              <Button variant="outline" size="sm" className="gap-1.5" onClick={regenerate} disabled={consolidating}>
                {consolidating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                {consolidating ? "Regenerating…" : summary ? "Regenerate" : "Generate"}
              </Button>
            </div>
            {summary ? (
              <Markdown content={summary.content} className="text-sm" />
            ) : (
              <p className="text-sm text-muted-foreground">
                Juno keeps a tidy, deduped summary of what it knows about you — regenerated periodically from the saved facts
                below. Generate it now, or it’ll appear automatically as you chat.
              </p>
            )}
          </Card>
        )}

        <DottedDivider label="saved facts" className="my-5" />

        <div className="mb-3 flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search memories" className="pl-9" />
          </div>
          <Button onClick={() => setAdding((a) => !a)} className="gap-1.5">
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>

        {adding && (
          <div className="mb-3 space-y-2 rounded-lg border p-3">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="E.g. I prefer TypeScript over JavaScript."
              autoFocus
              maxLength={500}
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => { setAdding(false); setDraft(""); }}>
                Cancel
              </Button>
              <Button size="sm" onClick={addMemory}>
                Save memory
              </Button>
            </div>
          </div>
        )}

        {memories === null ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : memories.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center">
            <Sparkles className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {query ? "No memories match your search." : "No memories yet. Juno will add them as you chat."}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {memories.map((m, i) => (
              <li
                key={m.id}
                style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                className="group rounded-lg border bg-card p-3.5 shadow-soft transition-shadow duration-base hover:shadow-float motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              >
                {editingId === m.id ? (
                  <div className="space-y-2">
                    <Textarea value={editDraft} onChange={(e) => setEditDraft(e.target.value)} autoFocus maxLength={500} />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" size="icon-sm" onClick={() => setEditingId(null)} aria-label="Cancel">
                        <X className="h-4 w-4" />
                      </Button>
                      <Button size="icon-sm" onClick={() => saveEdit(m.id)} aria-label="Save">
                        <Check className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                        m.source === "AUTO" ? "bg-primary" : "bg-source"
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{m.content}</p>
                      <Badge variant="muted" className="mt-2 font-mono text-[10px] uppercase tracking-wider">
                        {m.source === "AUTO" ? "Saved by Juno" : "Added by you"}
                      </Badge>
                    </div>
                    <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 coarse:opacity-100">
                      <Button variant="ghost" size="icon-sm" onClick={() => { setEditingId(m.id); setEditDraft(m.content); }} aria-label="Edit">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon-sm" onClick={() => remove(m.id)} aria-label="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
