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
import { EntryList } from "@/components/memory/entry-list";
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
  // The individual facts, listed by EntryList below. They used to be held only
  // for export and empty-state detection: the summary was the entire interface,
  // which left a user who spotted a wrong fact with nothing to point at.
  const [memories, setMemories] = React.useState<Memory[] | null>(null);
  const [summary, setSummary] = React.useState<SummaryData | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [consolidating, setConsolidating] = React.useState(false);
  // A background-provider policy denial is a setting, not a blip: a toast that
  // fades leaves the user watching a button do nothing forever. It stays on
  // screen with the way out until the next attempt clears it.
  const [policyNotice, setPolicyNotice] = React.useState<string | null>(null);

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
        // A policy denial is shown even on the silent auto-run: it is the whole
        // reason the page looks empty, and staying quiet about it is what made
        // this feel broken rather than configured.
        if (data.code === "background_policy_denied") {
          setPolicyNotice(data.error);
          return;
        }
        if (!res.ok) throw new Error(data.error ?? "Could not rebuild the summary.");
        setPolicyNotice(null);
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
      // The policy refused to send the instruction anywhere. Not a failure to
      // retry — the route used to call this a rate limit and the user waited
      // for a minute that never ended.
      if (data.code === "background_policy_denied") {
        setPolicyNotice(data.error);
        toast.error("Juno isn’t allowed to process this — see the note above.");
        return false;
      }
      if (!res.ok) throw new Error(data.error ?? "Couldn’t draft that change — try again.");
      setPolicyNotice(null);

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
        // A suppressed write is a decision, not an outage: retrying it will be
        // refused for exactly the same reason forever, so it is recorded as
        // rejected with the explanation rather than parked as pending.
        const suppressed = (e as { code?: string }).code === "suppressed";
        setEdits((prev) => [
          { ...base, status: suppressed ? "rejected" : "pending", ...(suppressed ? { note: (e as Error).message } : {}) },
          ...prev,
        ]);
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
    // `code` travels with the error so callers can tell a refusal ("you asked
    // Juno to forget this") from a stale draft or a transport failure.
    if (!res.ok)
      throw Object.assign(new Error(data.error ?? "Couldn’t apply that edit."), {
        status: res.status,
        code: data.code as string | undefined,
      });
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

  // ---- Single-entry controls ------------------------------------------------

  // Per-entry busy tracking, same reason as the edits ledger: deleting one fact
  // must not freeze the controls on every other row.
  const [busyMemoryIds, setBusyMemoryIds] = React.useState<ReadonlySet<string>>(new Set());
  const markMemoryBusy = (id: string, busy: boolean) =>
    setBusyMemoryIds((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });

  const patchMemory = async (memory: Memory, body: Record<string, unknown>, failure: string): Promise<boolean> => {
    markMemoryBusy(memory.id, true);
    try {
      const res = await fetch(`/api/memory/${memory.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? failure);
      // Re-read rather than patching local state: editing a fact re-runs
      // classification and can revive a retired row, so the server's version of
      // the entry is the only one that is right.
      await load();
      return true;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : failure);
      return false;
    } finally {
      markMemoryBusy(memory.id, false);
    }
  };

  const editMemory = async (id: string, content: string): Promise<boolean> => {
    const memory = memories?.find((m) => m.id === id);
    if (!memory) return false;
    const ok = await patchMemory(memory, { content }, "Couldn’t save that change.");
    if (ok) toast.success("Memory updated.");
    return ok;
  };

  const forgetMemory = async (memory: Memory) => {
    if (await patchMemory(memory, { forget: true }, "Couldn’t forget that. Nothing was changed.")) {
      toast.success("Forgotten — Juno won’t learn it again.");
    }
  };

  const deleteMemory = async (memory: Memory) => {
    markMemoryBusy(memory.id, true);
    try {
      const res = await fetch(`/api/memory/${memory.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setMemories((prev) => (prev ?? []).filter((m) => m.id !== memory.id));
      // Deleting only removes the row: the chat it came from is still there to
      // be re-read, so say so rather than implying a promise we can't keep.
      toast.success("Deleted. Use Forget if it should never come back.");
    } catch {
      toast.error("Couldn’t delete that memory. Nothing was changed.");
    } finally {
      markMemoryBusy(memory.id, false);
    }
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
              {policyNotice && (
                // aria-live so the explanation reaches a screen reader when it
                // appears after a button press, not only on a fresh render.
                <div
                  role="status"
                  aria-live="polite"
                  className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-2xl border border-border/60 bg-muted/30 px-4 py-3 text-sm"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <p className="min-w-0 flex-1 text-muted-foreground">{policyNotice}</p>
                  <Button variant="outline" size="sm" onClick={() => router.push("/settings")}>
                    Open settings
                  </Button>
                </div>
              )}
              {backfillRemaining !== null && (
                <p role="status" className="flex items-center gap-2.5 px-1.5 text-caption text-muted-foreground">
                  <ThinkingDots />
                  <span>
                    Distilling your past chats into memory — {backfillRemaining}{" "}
                    {backfillRemaining === 1 ? "chat" : "chats"} to go…
                  </span>
                </p>
              )}
              <EntryList
                memories={memories}
                busyIds={busyMemoryIds}
                paused={paused}
                onEdit={editMemory}
                onForget={forgetMemory}
                onDelete={deleteMemory}
              />
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
