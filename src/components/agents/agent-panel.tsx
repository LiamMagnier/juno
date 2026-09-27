"use client";

import * as React from "react";
import { X } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { AgentFace } from "@/components/agents/agent-face";
import { useAgentDetail } from "@/components/agents/use-agents";
import { AgentPanelNow } from "@/components/agents/agent-panel-now";
import { AgentPanelComputer } from "@/components/agents/agent-panel-computer";
import { AgentPanelSetup } from "@/components/agents/agent-panel-setup";
import type { ClientAgentActivity, ClientAgentDetail } from "@/lib/agents/types";
import type { ClientAgentComputerFile } from "@/components/agents/agents-transport";

export type AgentPanelTab = "now" | "computer" | "setup";

export function normalizeAgentPanelTab(raw: string | null | undefined): AgentPanelTab | null {
  if (!raw) return null;
  if (raw === "now" || raw === "computer" || raw === "setup") return raw;
  if (raw === "profile" || raw === "goals" || raw === "routines" || raw === "activity") return "setup";
  return "now";
}

export function AgentPanel({
  agentId,
  tab,
  onTabChange,
  onClose,
  initialDetail,
  staticPreview = false,
  initialComputerMode = "watch",
  mockActivity,
  mockFiles,
  initialExpandedSetupRow,
}: {
  agentId: string;
  tab: AgentPanelTab;
  onTabChange: (next: AgentPanelTab) => void;
  onClose: () => void;
  initialDetail?: ClientAgentDetail | null;
  staticPreview?: boolean;
  initialComputerMode?: "watch" | "control";
  mockActivity?: ClientAgentActivity[];
  mockFiles?: ClientAgentComputerFile[];
  initialExpandedSetupRow?: string;
}) {
  const { detail, error, refresh } = useAgentDetail(agentId, initialDetail ?? null);
  const [computerMode, setComputerMode] = React.useState<"watch" | "control">(initialComputerMode);

  React.useEffect(() => {
    setComputerMode(initialComputerMode);
  }, [initialComputerMode]);

  const showComputerTab = detail ? detail.computerConfigured : true;
  const activeTab: AgentPanelTab = !showComputerTab && tab === "computer" ? "now" : tab;

  const options = React.useMemo<SegmentedOption<AgentPanelTab>[]>(() => {
    const list: SegmentedOption<AgentPanelTab>[] = [{ value: "now", label: "Now" }];
    if (showComputerTab) {
      list.push({ value: "computer", label: "Computer" });
    }
    list.push({ value: "setup", label: "Setup" });
    return list;
  }, [showComputerTab]);

  const handleTakeControlFromNow = () => {
    setComputerMode("control");
    onTabChange("computer");
  };

  return (
    <aside
      aria-label={detail ? `${detail.agent.name} panel` : "Agent panel"}
      className="flex h-full w-full flex-col bg-background"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {detail ? (
            <>
              <AgentFace avatar={detail.agent.avatar} state={detail.agent.state} size="xs" />
              <span className="truncate text-ui font-medium text-foreground">{detail.agent.name}</span>
            </>
          ) : (
            <Skeleton className="h-4 w-28" />
          )}
        </div>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={onClose}
          aria-label="Close agent panel"
          className="text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Tabs: Now · Computer · Setup (no count badge) */}
      <div className="shrink-0 border-b border-border/70 px-4 py-2">
        <SegmentedControl
          ariaLabel="Agent panel view"
          value={activeTab}
          onChange={(next) => {
            if (next !== "computer") setComputerMode("watch");
            onTabChange(next as AgentPanelTab);
          }}
          options={options}
          className="w-full"
        />
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {error && !detail ? (
          <LoadError title="Couldn’t load agent" description={error} onRetry={refresh} />
        ) : !detail ? (
          <div className="space-y-4" role="status" aria-label="Loading agent panel">
            <Skeleton className="h-24 w-full rounded-card" />
            <Skeleton className="h-16 w-full rounded-card" />
            <Skeleton className="h-16 w-full rounded-card" />
          </div>
        ) : activeTab === "computer" ? (
          <AgentPanelComputer
            detail={detail}
            onChanged={refresh}
            initialMode={computerMode}
            staticPreview={staticPreview}
            mockFiles={mockFiles}
          />
        ) : activeTab === "setup" ? (
          <AgentPanelSetup
            detail={detail}
            onChanged={refresh}
            initialExpandedRow={initialExpandedSetupRow}
          />
        ) : (
          <AgentPanelNow
            detail={detail}
            onChanged={refresh}
            onTakeControl={handleTakeControlFromNow}
            mockActivity={mockActivity}
          />
        )}
      </div>
    </aside>
  );
}
