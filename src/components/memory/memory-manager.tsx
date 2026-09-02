"use client";

import * as React from "react";
import { toast } from "sonner";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/components/app/app-provider";
import { openSettings } from "@/components/settings/settings-sections";
import { stagger } from "@/lib/utils";
import { SummaryCard } from "@/components/memory/summary-card";
import { PrivacyStrip } from "@/components/memory/privacy-strip";
import type { Memory, SummaryData } from "@/components/memory/memory-model";

/**
 * The memory manager: the consolidated summary, the instruction field that
 * edits it, and the privacy strip (pause · export · reset). One component
 * because it has two homes — the `/memory` page and the Memory section of
 * settings — and the page used to be the only copy, re-rendered inside the
 * modal with a `hideHeader` flag. Now the page is a frame around this and
 * the section is a couple of switches above it.
 */
export function MemoryManager({ compact = false }: { compact?: boolean }) {
  const { settings, setSettings } = useApp();
  const [memories, setMemories] = React.useState<Memory[] | null>(null);
  const [summary, setSummary] = React.useState<SummaryData | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [consolidating, setConsolidating] = React.useState(false);
  const [policyNotice, setPolicyNotice] = React.useState<string | null>(null);
  const [resetting, setResetting] = React.useState(false);

  const paused = !settings.memoryEnabled;

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/memory");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setMemories(data.memories ?? []);
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
        if (data.code === "background_policy_denied") {
          setPolicyNotice(data.error);
          return;
        }
        if (!res.ok) throw new Error();
        setPolicyNotice(null);
        await load();
        if (!opts?.silent) toast.success("Memory consolidated.");
      } catch {
        if (!opts?.silent) toast.error("Couldn't update memory. Try again in a moment.");
      } finally {
        setConsolidating(false);
      }
    },
    [load]
  );

  const submitInstruction = async (instruction: string): Promise<boolean> => {
    setConsolidating(true);
    try {
      const res = await fetch("/api/memory/instruct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.code === "background_policy_denied") {
        setPolicyNotice(data.error);
        return false;
      }
      if (!res.ok) throw new Error(data.error ?? "Instruction failed.");
      setPolicyNotice(null);
      await load();
      toast.success("Memory updated.");
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update memory.");
      return false;
    } finally {
      setConsolidating(false);
    }
  };

  const setPaused = async (nextPaused: boolean) => {
    const memoryEnabled = !nextPaused;
    try {
      await setSettings({ memoryEnabled });
      toast.success(
        memoryEnabled
          ? "Memory enabled — Juno will learn from conversations."
          : "Memory paused — Juno won't save new details."
      );
    } catch {
      toast.error("Couldn’t update memory preference.");
    }
  };

  const exportMemory = () => {
    const payload = { exportedAt: new Date().toISOString(), summary, memories };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `juno-memory-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    toast.success("Memory exported.");
  };

  const resetMemory = async () => {
    setResetting(true);
    try {
      const res = await fetch("/api/memory", { method: "DELETE" });
      if (!res.ok) throw new Error();
      setMemories([]);
      setSummary(null);
      toast.success("Memory cleared — Juno starts fresh.");
    } catch {
      toast.error("Couldn’t reset memory. Nothing was deleted.");
    } finally {
      setResetting(false);
    }
  };

  if (loadError) {
    return (
      <EmptyState
        tone="error"
        size={compact ? "panel" : "page"}
        icon={StatusIcons.error}
        title="Couldn’t load your memory"
        description="Check your connection and try again. Nothing has been changed."
        action={
          <Button variant="outline" size="sm" onClick={() => void load()} className="gap-1.5">
            <ActionIcons.refresh className="size-3.5" aria-hidden="true" />
            Retry
          </Button>
        }
      />
    );
  }

  if (memories === null) {
    return (
      <div className="space-y-3" aria-hidden="true">
        <Skeleton style={stagger(0)} className="h-64 w-full rounded-card" />
        <Skeleton style={stagger(1)} className="h-20 w-full rounded-card" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SummaryCard
        summary={summary}
        paused={paused}
        consolidating={consolidating}
        onRegenerate={() => void regenerate()}
        onInstruction={submitInstruction}
      />

      {policyNotice && (
        <div
          role="status"
          aria-live="polite"
          className="surface-inset flex flex-wrap items-start gap-x-3 gap-y-2 rounded-card px-4 py-3 text-sm text-foreground"
        >
          <StatusIcons.info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="min-w-0 flex-1 text-muted-foreground">{policyNotice}</p>
          <Button variant="outline" size="sm" onClick={() => openSettings("memory")}>
            Background processing
          </Button>
        </div>
      )}

      <PrivacyStrip
        paused={paused}
        onPausedChange={setPaused}
        onExport={exportMemory}
        onReset={resetMemory}
        resetting={resetting}
        empty={memories.length === 0 && !summary}
      />
    </div>
  );
}
