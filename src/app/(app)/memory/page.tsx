"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { useApp } from "@/components/app/app-provider";
import { cn, stagger } from "@/lib/utils";
import { SummaryCard } from "@/components/memory/summary-card";
import { EditsPanel } from "@/components/memory/edits-panel";
import { EntryList } from "@/components/memory/entry-list";
import { PrivacyStrip } from "@/components/memory/privacy-strip";
import { AppPageHeader } from "@/components/app/app-page-header";
import {
  MEMORY_EDIT_LEDGER_CAP,
  createEdits,
  deleteEditRecord,
  fetchEdits,
  migrateLegacyEdits,
  newEditId,
  updateEdit,
  type Memory,
  type MemoryEditDraft,
  type MemoryEditRecord,
  type Operation,
  type SummaryData,
} from "@/components/memory/memory-model";

function MemoryContent({ hideHeader }: { hideHeader?: boolean }) {
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

  // Drafted natural-language edits (review queue) — server-synced, so the
  // queue and every Undo follow the account rather than the device.
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
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Any localStorage-era ledger rides up first (idempotent), so a user's
        // old queue appears on every device instead of staying stranded here.
        await migrateLegacyEdits(user.id);
      } catch {
        // The local copy is kept for the next visit — see migrateLegacyEdits.
      }
      try {
        const list = await fetchEdits();
        if (!cancelled) setEdits(list);
      } catch {
        // The ledger is a convenience; the page works without it until reload.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  // Server truth when the sync succeeds; a local echo when it does not, so the
  // user's action is never silently dropped — the next load reconciles.
  const recordNewEdit = async (draft: MemoryEditDraft) => {
    try {
      setEdits(await createEdits([draft]));
    } catch {
      setEdits((prev) =>
        [
          {
            id: draft.clientId,
            instruction: draft.instruction,
            ...(draft.summary ? { summary: draft.summary } : {}),
            ...(draft.note ? { note: draft.note } : {}),
            operations: draft.operations,
            ...(draft.inverse ? { inverse: draft.inverse } : {}),
            status: draft.status,
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, MEMORY_EDIT_LEDGER_CAP)
      );
    }
  };

  const recordEditPatch = async (
    id: string,
    patch: Parameters<typeof updateEdit>[1],
    fallback: (edit: MemoryEditRecord) => MemoryEditRecord
  ) => {
    try {
      setEdits(await updateEdit(id, patch));
    } catch {
      setEdits((prev) => prev.map((edit) => (edit.id === id ? fallback(edit) : edit)));
    }
  };

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
        await recordNewEdit({
          clientId: newEditId(),
          instruction,
          status: "rejected",
          note: data.refusal,
          operations: [],
        });
        setEditsOpen(true);
        toast.info("Juno declined that instruction — see Manage edits.");
        return true;
      }

      // Auto-apply: the edits list is history + Undo, not an approval gate.
      const base: Omit<MemoryEditDraft, "status"> = {
        clientId: newEditId(),
        instruction,
        summary: data.proposal.summary,
        operations: data.proposal.operations,
      };
      try {
        const inverse = await applyOperations(data.proposal.operations);
        await recordNewEdit({ ...base, status: "applied", inverse });
        toast.success("Memory updated — undo it under Manage edits if needed.");
      } catch (e) {
        // A suppressed write is a decision, not an outage: retrying it will be
        // refused for exactly the same reason forever, so it is recorded as
        // rejected with the explanation rather than parked as pending.
        const suppressed = (e as { code?: string }).code === "suppressed";
        await recordNewEdit({
          ...base,
          status: suppressed ? "rejected" : "pending",
          ...(suppressed ? { note: (e as Error).message } : {}),
        });
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
      await recordEditPatch(edit.id, { status: "applied", inverse }, (x) => ({ ...x, status: "applied", inverse }));
      toast.success("Edit applied — summary updated.");
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        const note = (e as Error).message;
        await recordEditPatch(edit.id, { status: "rejected", note }, (x) => ({ ...x, status: "rejected", note }));
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
      await recordEditPatch(edit.id, { status: "pending", operations: redo, inverse: null }, (x) => ({
        ...x,
        status: "pending",
        operations: redo,
        inverse: undefined,
      }));
      toast.success("Edit undone — it’s back to pending.");
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        const note = (e as Error).message;
        await recordEditPatch(edit.id, { status: "rejected", note }, (x) => ({ ...x, status: "rejected", note }));
      }
      toast.error(e instanceof Error ? e.message : "Couldn’t undo that edit.");
    } finally {
      markBusy(edit.id, false);
    }
  };

  const deleteEdit = async (id: string) => {
    // Optimistic — the row leaves the screen at once; the server list, when it
    // answers, is the reconciliation.
    setEdits((prev) => prev.filter((e) => e.id !== id));
    try {
      setEdits(await deleteEditRecord(id));
    } catch {
      // Kept removed locally; the next load resyncs from the server.
    }
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
    <div className={cn(!hideHeader && "app-page-scroll")}>
      <div className={cn("mx-auto w-full max-w-2xl", hideHeader ? "px-0 py-0" : "app-page-content")}>
        {!hideHeader && (
          <AppPageHeader
            eyebrow="Memory"
            heading="What Juno remembers"
            lede="Distilled from your chats, projects, and connections — and used as context whenever you talk to Juno. Always yours to edit, in plain language."
          />
        )}

        {loadError ? (
          <div className="space-y-2.5 rounded-card border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <p>Couldn’t load your memory. Check your connection and try again.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : memories === null ? (
          <div className="space-y-3">
            {/* One block per surface that replaces it, in order and at its radius:
                summary panel, entry list, edits row, privacy strip. */}
            {/* stagger(), not a private 80ms formula: the last block was held
                back 240ms, so the loading state itself took a third of a second
                to finish arriving — which reads as the load being slower than
                it is. The shared helper is what every other list uses. */}
            <Skeleton style={stagger(0)} className="h-80 w-full rounded-panel" />
            <Skeleton style={stagger(1)} className="h-56 w-full rounded-panel" />
            <Skeleton style={stagger(2)} className="h-12 w-full rounded-card" />
            <Skeleton style={stagger(3)} className="h-16 w-full rounded-card" />
          </div>
        ) : (
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
                // bg-card, not bg-muted/30: 30% of a 9.5% token over the page's
                // black ground composites to 2.8% lightness, so this notice sat
                // between two full --card panels with effectively no fill of its
                // own. It is a panel-level message; it gets the panel's rung.
                className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-card border border-border/60 bg-card px-4 py-3 text-sm"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
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
            {/* The comment at the top of this component has said the facts are
                "listed by EntryList below" since the component landed — but the
                render tree never mounted it, so the rows, the retired-fact
                disclosure and every one of editMemory/forgetMemory/deleteMemory
                were dead code and a user who spotted a wrong fact still had
                nothing to point at. */}
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
        )}
      </div>
    </div>
  );
}

function MemoryPage() {
  return <MemoryContent />;
}

MemoryPage.Content = MemoryContent;

export default MemoryPage;
