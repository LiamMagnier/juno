"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { MotionConfig } from "framer-motion";
import { toast } from "sonner";
import { AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { useApp } from "@/components/app/app-provider";
import { SummaryCard } from "@/components/memory/summary-card";
import { EditsPanel } from "@/components/memory/edits-panel";
import { PrivacyStrip } from "@/components/memory/privacy-strip";
import {
  loadEdits,
  newEditId,
  saveEdits,
  type Memory,
  type MemoryEditRecord,
  type Operation,
  type SummaryData,
} from "@/components/memory/memory-model";

export default function MemoryPage() {
  const router = useRouter();
  const { user, settings, setSettings } = useApp();
  // The raw notes stay server-side as the edit substrate; the page keeps them
  // only for export and empty-state detection — they're never listed.
  const [memories, setMemories] = React.useState<Memory[] | null>(null);
  const [summary, setSummary] = React.useState<SummaryData | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [consolidating, setConsolidating] = React.useState(false);

  // Drafted natural-language edits (review queue) — persisted locally per user.
  const [edits, setEdits] = React.useState<MemoryEditRecord[]>([]);
  const [editsOpen, setEditsOpen] = React.useState(false);
  // Per-edit busy tracking — accept/undo on different edits can overlap.
  const [busyEditIds, setBusyEditIds] = React.useState<ReadonlySet<string>>(new Set());
  const markBusy = (id: string, busy: boolean) =>
    setBusyEditIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  const ledgerReady = React.useRef(false);
  React.useEffect(() => {
    setEdits(loadEdits(user.id));
    ledgerReady.current = true;
  }, [user.id]);
  React.useEffect(() => {
    if (ledgerReady.current) saveEdits(user.id, edits);
  }, [edits, user.id]);

  const [resetting, setResetting] = React.useState(false);

  const paused = !settings.memoryEnabled;

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setMemories(data.memories);
      setSummary(data.summary ?? null);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const regenerate = React.useCallback(
    async (opts?: { silent?: boolean }) => {
      setConsolidating(true);
      try {
        const res = await fetch("/api/memory/consolidate", { method: "POST" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? "Could not rebuild the summary.");
        setSummary(data.summary ?? null);
        if (!opts?.silent) toast.success(data.summary ? "Summary updated." : "Nothing to summarize yet.");
      } catch (e) {
        if (!opts?.silent) toast.error(e instanceof Error ? e.message : "Could not rebuild the summary.");
      } finally {
        setConsolidating(false);
      }
    },
    []
  );

  // Auto-maintenance on first visit: distill any conversations the extractor
  // hasn't covered yet (old chats included), then (re)build the summary if it's
  // missing or new facts arrived. No manual "generate" step anywhere.
  const [backfillRemaining, setBackfillRemaining] = React.useState<number | null>(null);
  const hadSummaryAtLoad = React.useRef<boolean | null>(null);
  const autoRan = React.useRef(false);
  React.useEffect(() => {
    if (memories === null || loadError || paused || autoRan.current) return;
    autoRan.current = true;
    if (hadSummaryAtLoad.current === null) hadSummaryAtLoad.current = summary !== null;
    let cancelled = false;
    (async () => {
      let created = 0;
      try {
        const status = await fetch("/api/memory/backfill");
        let remaining: number = status.ok ? (await status.json()).remaining ?? 0 : 0;
        if (remaining > 0) {
          setBackfillRemaining(remaining);
          let prev = Infinity;
          // Stop when done, when we stop making progress (providers down), or
          // after a sane number of rounds — it resumes on the next visit.
          for (let i = 0; i < 15 && remaining > 0 && remaining < prev && !cancelled; i++) {
            prev = remaining;
            const res = await fetch("/api/memory/backfill", { method: "POST" });
            if (!res.ok) break;
            const d = await res.json();
            created += d.created ?? 0;
            remaining = d.remaining ?? prev;
            if (!cancelled) setBackfillRemaining(remaining);
          }
        }
      } catch {
        // Best effort — the next visit picks it back up.
      }
      if (cancelled) return;
      setBackfillRemaining(null);
      if (!hadSummaryAtLoad.current || created > 0) {
        await regenerate({ silent: true });
        if (created > 0) void load();
      }
    })();
    return () => {
      cancelled = true;
    };
    // One-shot after the initial load; `summary` is read via ref on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memories, loadError, paused, regenerate, load]);

  const setPaused = async (nextPaused: boolean) => {
    const enabled = !nextPaused;
    setSettings({ memoryEnabled: enabled });
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memoryEnabled: enabled }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setSettings({ memoryEnabled: !enabled });
      toast.error(`Could not ${nextPaused ? "pause" : "resume"} memory. Try again.`);
    }
  };

  // ---- Natural-language edit flow -----------------------------------------

  const submitInstruction = async (instruction: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/memory/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn’t draft that change — try again.");

      if ("refusal" in data) {
        setEdits((prev) => [
          {
            id: newEditId(),
            instruction,
            status: "rejected",
            note: data.refusal,
            operations: [],
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
        setEditsOpen(true);
        toast.info("Juno declined that instruction — see Manage edits.");
        return true;
      }

      // Auto-apply: the edits list is history + Undo, not an approval gate.
      const base: Omit<MemoryEditRecord, "status"> = {
        id: newEditId(),
        instruction,
        summary: data.proposal.summary,
        operations: data.proposal.operations,
        createdAt: new Date().toISOString(),
      };
      try {
        const inverse = await applyOperations(data.proposal.operations);
        setEdits((prev) => [{ ...base, status: "applied", inverse }, ...prev]);
        toast.success("Memory updated — undo it under Manage edits if needed.");
      } catch (e) {
        // Applying failed (providers down) — keep it pending; Accept retries.
        setEdits((prev) => [{ ...base, status: "pending" }, ...prev]);
        setEditsOpen(true);
        toast.error(e instanceof Error ? e.message : "Couldn’t apply the change — it’s pending under Manage edits.");
      }
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn’t draft that change — try again.");
      return false;
    }
  };

  const applyOperations = async (operations: Operation[]) => {
    const res = await fetch("/api/memory/edit/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operations }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? "Couldn’t apply that edit."), { status: res.status });
    setMemories(data.memories);
    setSummary(data.summary ?? null);
    return data.inverse as Operation[];
  };

  const acceptEdit = async (edit: MemoryEditRecord) => {
    if (busyEditIds.has(edit.id)) return;
    markBusy(edit.id, true);
    try {
      const inverse = await applyOperations(edit.operations);
      setEdits((prev) => prev.map((e) => (e.id === edit.id ? { ...e, status: "applied", inverse } : e)));
      toast.success("Edit applied — summary updated.");
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        setEdits((prev) =>
          prev.map((x) => (x.id === edit.id ? { ...x, status: "rejected", note: (e as Error).message } : x))
        );
      }
      toast.error(e instanceof Error ? e.message : "Couldn’t apply that edit — nothing was changed.");
    } finally {
      markBusy(edit.id, false);
    }
  };

  const undoEdit = async (edit: MemoryEditRecord) => {
    if (!edit.inverse?.length || busyEditIds.has(edit.id)) return;
    markBusy(edit.id, true);
    try {
      // Undoing returns its own inverse: the redo operations, with fresh fact ids.
      const redo = await applyOperations(edit.inverse);
      setEdits((prev) =>
        prev.map((x) => (x.id === edit.id ? { ...x, status: "pending", operations: redo, inverse: undefined } : x))
      );
      toast.success("Edit undone — it’s back to pending.");
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        setEdits((prev) =>
          prev.map((x) => (x.id === edit.id ? { ...x, status: "rejected", note: (e as Error).message } : x))
        );
      }
      toast.error(e instanceof Error ? e.message : "Couldn’t undo that edit.");
    } finally {
      markBusy(edit.id, false);
    }
  };

  const deleteEdit = (id: string) => {
    setEdits((prev) => prev.filter((e) => e.id !== id));
  };

  // ---- Privacy controls -----------------------------------------------------

  const exportMemory = () => {
    // Suppressions are exported separately — they're a block-list, not memories.
    const payload = {
      exportedAt: new Date().toISOString(),
      summary,
      facts: (memories ?? []).filter((m) => m.kind === "FACT"),
      neverRemember: (memories ?? []).filter((m) => m.kind === "SUPPRESSION").map((m) => m.content),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "juno-memory.json";
    a.click();
    URL.revokeObjectURL(url);
    toast.success("Memory exported as juno-memory.json");
  };

  const resetMemory = async () => {
    setResetting(true);
    try {
      const res = await fetch("/api/memory", { method: "DELETE" });
      if (!res.ok) throw new Error();
      setMemories([]);
      setSummary(null);
      setEdits([]);
      toast.success("Memory reset — Juno starts fresh.");
    } catch {
      toast.error("Couldn’t reset memory. Nothing was deleted.");
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8">
        <div className="mb-1 flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" onClick={() => router.push("/chat")} aria-label="Back to chat">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <span className="font-mono text-label text-muted-foreground">Memory</span>
        </div>
        <h1 className="font-serif text-display font-medium tracking-tight">What Juno remembers</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">
          Distilled from your chats, projects, and connections — and used as context whenever you talk to Juno. Always
          yours to edit, in plain language.
        </p>

        {loadError ? (
          <div className="space-y-2.5 rounded-2xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <p>Couldn’t load your memory. Check your connection and try again.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : memories === null ? (
          <div className="space-y-3">
            <Skeleton className="h-80 w-full rounded-panel" />
            <Skeleton style={{ animationDelay: "80ms" }} className="h-12 w-full rounded-2xl" />
            <Skeleton style={{ animationDelay: "160ms" }} className="h-16 w-full rounded-2xl" />
          </div>
        ) : (
          <MotionConfig reducedMotion="user">
            <div className="space-y-3">
              <SummaryCard
                summary={summary}
                paused={paused}
                consolidating={consolidating}
                onRegenerate={() => void regenerate()}
                onInstruction={submitInstruction}
              />
              {backfillRemaining !== null && (
                <p role="status" className="flex items-center gap-2.5 px-1.5 text-caption text-muted-foreground">
                  <ThinkingDots />
                  <span>
                    Distilling your past chats into memory — {backfillRemaining}{" "}
                    {backfillRemaining === 1 ? "chat" : "chats"} to go…
                  </span>
                </p>
              )}
              <EditsPanel
                edits={edits}
                open={editsOpen}
                onOpenChange={setEditsOpen}
                busyIds={busyEditIds}
                onAccept={acceptEdit}
                onUndo={undoEdit}
                onDelete={deleteEdit}
              />
              <PrivacyStrip
                paused={paused}
                onPausedChange={setPaused}
                onExport={exportMemory}
                onReset={resetMemory}
                resetting={resetting}
                empty={memories.length === 0 && !summary}
              />
            </div>
          </MotionConfig>
        )}
      </div>
    </div>
  );
}
