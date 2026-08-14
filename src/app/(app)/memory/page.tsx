"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApp } from "@/components/app/app-provider";
import { cn, stagger } from "@/lib/utils";
import { SummaryCard } from "@/components/memory/summary-card";
import { PrivacyStrip } from "@/components/memory/privacy-strip";
import { AppPageHeader } from "@/components/app/app-page-header";
import type { Memory, SummaryData } from "@/components/memory/memory-model";

function MemoryContent({ hideHeader }: { hideHeader?: boolean }) {
  const router = useRouter();
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
      toast.success(memoryEnabled ? "Memory enabled — Juno will learn from conversations." : "Memory paused — Juno won't save new details.");
    } catch {
      toast.error("Couldn’t update memory preference.");
    }
  };

  const exportMemory = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      summary,
      memories,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `juno-memory-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
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

  return (
    <div className={cn(!hideHeader && "app-page-scroll")}>
      <div className={cn("mx-auto w-full max-w-2xl", hideHeader ? "px-0 py-0" : "app-page-content")}>
        {!hideHeader && (
          <AppPageHeader
            eyebrow="Memory"
            heading="What Juno remembers"
            lede="Distilled from your conversations and preferences to make answers relevant and personalized."
          />
        )}

        {loadError ? (
          <div className="space-y-2.5 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <div className="flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
              <p>Couldn’t load your memory. Check your connection and try again.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : memories === null ? (
          <div className="space-y-3">
            <Skeleton style={stagger(0)} className="h-64 w-full rounded-2xl" />
            <Skeleton style={stagger(1)} className="h-20 w-full rounded-2xl" />
          </div>
        ) : (
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
                className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-2xl border border-white/10 bg-[#161616] px-4 py-3 text-sm"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-neutral-400" aria-hidden="true" />
                <p className="min-w-0 flex-1 text-neutral-300">{policyNotice}</p>
                <Button variant="outline" size="sm" onClick={() => router.push("/settings")}>
                  Open settings
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
