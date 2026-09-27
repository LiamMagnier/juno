"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AppPage, AppPageHeader } from "@/components/app/app-page";
import { cardVariants } from "@/components/ui/card";
import { AgentFace } from "@/components/agents/agent-face";
import { announceAgentsChanged, hireAgent } from "@/components/agents/agents-transport";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agents/templates";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Chat-first agent hiring (`/agents/new`, `docs/design/agents-v2/BRIEF.md` §4.8.4):
 * renders a face preview and the 7 templates plus "Start from scratch".
 * Pressing one POSTs `/api/agents` (`name` = template's first suggested name, or
 * "New agent", with the template's defaults), then `router.push`es to the thread.
 * A GET never creates anything.
 */
export function AgentStart({ initialTemplate }: { initialTemplate: string | null }) {
  const router = useRouter();
  const [hovered, setHovered] = React.useState<AgentTemplate>(() => {
    return AGENT_TEMPLATES.find((t) => t.id === initialTemplate) ?? AGENT_TEMPLATES[0];
  });
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const handlePick = async (template: AgentTemplate) => {
    if (busyId) return;
    setBusyId(template.id);
    const defaultName = template.names[0] ?? "New agent";
    const isScratch = template.id === "custom";
    const outcome = await hireAgent({
      name: defaultName,
      role: isScratch ? "" : template.role,
      avatar: template.avatar,
      style: template.style,
      instructions: isScratch ? "" : template.instructions,
      approvalMode: template.approvalMode,
      connectorIds: [],
      template: template.id,
      ...(template.firstGoal ? { firstGoal: template.firstGoal } : {}),
    });
    setBusyId(null);
    if (outcome.kind !== "ok") {
      toast.error(outcome.message);
      return;
    }
    announceAgentsChanged();
    const conversationId = outcome.value.conversationId;
    if (conversationId) {
      router.push(`/chat/${encodeURIComponent(conversationId)}`);
    } else {
      router.push(`/agents/${encodeURIComponent(outcome.value.id)}`);
    }
  };

  return (
    <AppPage measure="wide">
      <AppPageHeader
        heading="New agent"
        lede="Pick a starting point to open a thread with your new agent, or start from scratch."
      />

      <div className="mb-6 flex items-center gap-4 border-y border-border/60 py-3.5 motion-safe:animate-rise-in">
        <div
          data-face-trigger
          className="grid size-14 shrink-0 place-items-center rounded-2xl border border-border/70 bg-muted/30"
        >
          <AgentFace
            avatar={hovered.avatar}
            state={busyId ? "working" : "idle"}
            size="md"
            name={hovered.names[0] ?? "New agent"}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-micro uppercase tracking-wider text-muted-foreground">
            Starting point preview
          </p>
          <p className="mt-0.5 truncate text-body font-semibold text-foreground">
            {hovered.names[0] ?? "New agent"}{" "}
            <span className="font-normal text-muted-foreground">· {hovered.label}</span>
          </p>
          <p className="mt-0.5 truncate text-caption text-muted-foreground">
            {hovered.firstGoal ? `First goal: “${hovered.firstGoal}”` : hovered.promise}
          </p>
        </div>
      </div>

      <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {AGENT_TEMPLATES.map((template, index) => {
          const isScratch = template.id === "custom";
          const isBusy = busyId === template.id;
          const isSelected = hovered.id === template.id;
          return (
            <li
              key={template.id}
              style={staggerDelay(index)}
              className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              <button
                type="button"
                disabled={busyId !== null}
                onMouseEnter={() => setHovered(template)}
                onFocus={() => setHovered(template)}
                onClick={() => void handlePick(template)}
                className={cn(
                  cardVariants({ variant: "interactive" }),
                  "flex h-full w-full items-start gap-3 p-3.5 text-left transition-colors",
                  isSelected && "border-foreground/30 bg-accent/30",
                  isBusy && "border-foreground/40 bg-selected"
                )}
              >
                <AgentFace avatar={template.avatar} size="sm" state={isBusy ? "working" : "idle"} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-ui font-semibold text-foreground">
                      {isScratch ? "Start from scratch" : template.label}
                    </span>
                    <span className="shrink-0 font-mono text-micro text-muted-foreground">
                      {template.names[0]}
                    </span>
                  </span>
                  <span className="mt-1 line-clamp-2 block text-caption leading-relaxed text-muted-foreground">
                    {template.promise}
                  </span>
                  <span className="mt-2 block truncate font-mono text-micro text-muted-foreground">
                    {template.firstGoal ? `→ “${template.firstGoal}”` : "→ Custom brief & tools"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-6 text-center text-caption text-muted-foreground">
        Prefer to configure everything up front?{" "}
        <Link
          href={initialTemplate ? `/agents/new?form=1&template=${encodeURIComponent(initialTemplate)}` : "/agents/new?form=1"}
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          Set up with a form
        </Link>
      </p>
    </AppPage>
  );
}
