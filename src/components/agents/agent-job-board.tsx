"use client";

/**
 * Hiring as a job board (docs/design/AGENTS.md §5.1): the seven starting
 * points are jobs, not feature cards. A tight row list on the left; one
 * selected row fills the brief on the right so the whole combination (face,
 * name, role, style, brief, autonomy) is visible before Hire.
 *
 * "Start from scratch" is its own row under a hairline, not a seventh equal tile.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ChevronRight, Plus } from "@/components/ui/icons";
import { AgentFace } from "@/components/agents/agent-face";
import { announceAgentsChanged, hireAgent } from "@/components/agents/agents-transport";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agents/templates";
import { AGENT_STYLE_LABEL } from "@/lib/agents/domain";
import { WORK_APPROVAL_MODE_LABEL } from "@/lib/work/domain";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";

export function AgentJobBoard({
  initialTemplateId,
  formHref,
  className,
}: {
  initialTemplateId?: string | null;
  /** Where "Set up with a form" goes. Omit to hide the link (empty roster already has New agent). */
  formHref?: string;
  className?: string;
}) {
  const router = useRouter();
  const jobs = React.useMemo(() => AGENT_TEMPLATES.filter((t) => t.id !== "custom"), []);
  const scratch = React.useMemo(() => AGENT_TEMPLATES.find((t) => t.id === "custom"), []);
  const [selected, setSelected] = React.useState<AgentTemplate>(() => {
    return (
      AGENT_TEMPLATES.find((t) => t.id === initialTemplateId) ??
      jobs[0] ??
      AGENT_TEMPLATES[0]
    );
  });
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const hire = async (template: AgentTemplate) => {
    if (busyId) return;
    setBusyId(template.id);
    const isScratch = template.id === "custom";
    const outcome = await hireAgent({
      name: template.names[0] ?? "New agent",
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
    const target = outcome.value.conversationId
      ? `/chat/${encodeURIComponent(outcome.value.conversationId)}`
      : `/agents/${encodeURIComponent(outcome.value.id)}`;
    router.push(target);
  };

  const rows = scratch ? [...jobs, scratch] : jobs;
  const busy = busyId !== null;

  return (
    <div className={cn("@container grid grid-cols-1 gap-6 @[48rem]:grid-cols-[minmax(0,1fr)_20rem] @[48rem]:gap-8", className)}>
      {/* The job board */}
      <ul className="overflow-hidden rounded-card border border-border bg-card" role="radiogroup" aria-label="Starting points">
        {rows.map((template, index) => {
          const isScratch = template.id === "custom";
          const isSelected = selected.id === template.id;
          const isBusy = busyId === template.id;
          return (
            <li
              key={template.id}
              style={staggerDelay(index, "tight")}
              className="motion-safe:animate-rise-in [animation-fill-mode:backwards]"
            >
              {isScratch ? <div className="h-px bg-border" aria-hidden="true" /> : null}
              <button
                type="button"
                role="radio"
                aria-checked={isSelected}
                disabled={busy}
                onMouseEnter={() => setSelected(template)}
                onFocus={() => setSelected(template)}
                onClick={() => {
                  setSelected(template);
                  void hire(template);
                }}
                data-face-trigger
                className={cn(
                  "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors duration-fast ease-out-soft",
                  "hover:bg-accent",
                  isSelected ? "bg-selected" : undefined,
                  isBusy && "bg-selected"
                )}
              >
                <AgentFace
                  avatar={template.avatar}
                  size="sm"
                  state={isBusy ? "working" : "idle"}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-foreground">
                    {isScratch ? "Start from scratch" : template.label}
                  </span>
                  <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                    {template.promise}
                  </span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                  motion="none"
                />
              </button>
            </li>
          );
        })}
      </ul>

      {/* The brief: the combination whole, before Hire */}
      <aside className="@[48rem]:sticky @[48rem]:top-6 @[48rem]:self-start">
        <div className="rounded-card border border-border bg-card p-4">
          <div
            data-face-trigger
            className="mx-auto grid size-24 place-items-center rounded-control bg-muted/40"
          >
            <AgentFace
              avatar={selected.avatar}
              state={busyId === selected.id ? "working" : "idle"}
              size="lg"
              name={selected.names[0] ?? "New agent"}
            />
          </div>
          <p className="mt-3 text-center text-body font-medium text-foreground">
            {selected.names[0] ?? "New agent"}
          </p>
          <p className="mt-0.5 text-center text-ui text-muted-foreground">
            {selected.id === "custom" ? "You decide the job" : selected.role}
          </p>

          <p className="mt-3 text-ui text-foreground">{selected.promise}</p>

          {selected.id === "custom" ? null : (
            <p className="mt-2 line-clamp-4 text-caption text-muted-foreground">
              {selected.instructions}
            </p>
          )}

          <dl className="mt-3 space-y-1 border-t border-border pt-3 text-caption text-muted-foreground">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="font-mono text-label">Voice</dt>
              <dd className="text-foreground">{AGENT_STYLE_LABEL[selected.style]}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="font-mono text-label">Autonomy</dt>
              <dd className="text-foreground">{WORK_APPROVAL_MODE_LABEL[selected.approvalMode]}</dd>
            </div>
          </dl>

          <p className="mt-3 text-caption text-muted-foreground">
            It always asks before it sends, publishes, pays or deletes.
          </p>

          <Button
            className="mt-4 w-full"
            loading={busyId === selected.id}
            disabled={busy}
            onClick={() => void hire(selected)}
          >
            {busyId === selected.id ? "Hiring" : "Hire"}
          </Button>

          {formHref ? (
            <p className="mt-3 text-center text-caption text-muted-foreground">
              <Link href={formHref} className="text-foreground underline-offset-4 hover:underline">
                Set up with a form
              </Link>
            </p>
          ) : null}
        </div>
      </aside>
    </div>
  );
}

/** The empty roster's opening: a short serif line, then the board. */
export function FirstHireBoard({ formHref }: { formHref?: string }) {
  return (
    <section aria-labelledby="first-hire" className="motion-safe:animate-rise-in">
      <h2 id="first-hire" className="text-title font-serif font-medium">
        Hire your first agent
      </h2>
      <p className="mt-1 max-w-prose text-body text-muted-foreground">
        Pick a job to open a thread right away. Nothing it does that sends, pays or deletes happens without you.
      </p>
      <AgentJobBoard className="mt-5" formHref={formHref ?? "/agents/new?form=1"} />
    </section>
  );
}

/** Quiet primary for headers that hire. */
export function NewAgentButton() {
  return (
    <Button asChild size="sm" className="gap-1.5">
      <Link href="/agents/new">
        <Plus className="size-3.5" aria-hidden="true" /> New agent
      </Link>
    </Button>
  );
}
