"use client";

import * as React from "react";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { AgentJobBoard } from "@/components/agents/agent-job-board";

/**
 * Chat-first agent hiring (`/agents/new`, `docs/design/agents-v2/BRIEF.md` §4.8.4):
 * the job board, same as the empty roster. A row picks a starting point and
 * opens the thread; "Start from scratch" is its own row. A GET never creates
 * anything.
 */
export function AgentStart({ initialTemplate }: { initialTemplate: string | null }) {
  return (
    <AppPage measure="wide">
      <AppPageHeader
        heading="New agent"
        lede="Pick a job to open a thread with your new agent, or start from scratch."
        backHref="/agents"
        backLabel="Agents"
      />
      <AgentJobBoard initialTemplateId={initialTemplate} formHref={initialTemplate ? `/agents/new?form=1&template=${encodeURIComponent(initialTemplate)}` : "/agents/new?form=1"} />
    </AppPage>
  );
}
