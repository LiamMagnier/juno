"use client";

import * as React from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Hand, Plus } from "@/components/ui/icons";
import { useConversationWork } from "@/components/chat/use-conversation-work";
import { WorkRunPanel } from "@/components/chat/work-run-panel";
import { isTerminalStatus } from "@/lib/work/domain";
import type { ClientAgentActivity, ClientAgentDetail, ClientAgentIdea } from "@/lib/agents/types";
import { AppIcons } from "@/lib/app-icons";
import { staggerDelay } from "@/lib/motion";
import {
  announceAgentsChanged,
  createGoal,
  decideIdea,
  reflect,
  updateGoal,
} from "@/components/agents/agents-transport";
import { useCostConfirmation } from "@/components/agents/confirm-cost-dialog";
import { AgentActivity } from "@/components/agents/agent-activity";
import { formatLocalWhen } from "@/components/agents/agent-bits";

export function AgentPanelNow({
  detail,
  onChanged,
  onTakeControl,
  mockActivity,
}: {
  detail: ClientAgentDetail;
  onChanged: () => void;
  onTakeControl?: () => void;
  mockActivity?: ClientAgentActivity[];
}) {
  const { agent } = detail;
  const work = useConversationWork(agent.conversationId);
  const [refreshKey, setRefreshKey] = React.useState(0);
  const [newGoalTitle, setNewGoalTitle] = React.useState("");
  const [addingGoal, setAddingGoal] = React.useState(false);
  const [goalBusyId, setGoalBusyId] = React.useState<string | null>(null);

  // Keep the reflect-on-open call when this tab opens, never forced.
  React.useEffect(() => {
    if (mockActivity) return;
    void reflect(agent.id, false).then((res) => {
      if (res.kind === "ok" && res.value.kind === "reflected") {
        onChanged();
        setRefreshKey((k) => k + 1);
      }
    });
  }, [agent.id, mockActivity, onChanged]);

  const live = work.session !== null && !isTerminalStatus(work.session.status);
  const needsAttention = Boolean(work.session?.needsAttention || agent.needsYou > 0);
  const hasComputer = Boolean(detail.computer && detail.computer.status !== "disabled");
  const activeGoals = detail.goals.filter((g) => g.status === "active");
  const upcoming = detail.routines.filter((routine) => routine.enabled && routine.nextRunAt).slice(0, 3);

  const handleAddGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    const title = newGoalTitle.trim();
    if (!title) return;
    setAddingGoal(true);
    const outcome = await createGoal(agent.id, { title, cadence: "none" });
    setAddingGoal(false);
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    setNewGoalTitle("");
    announceAgentsChanged();
    onChanged();
    setRefreshKey((k) => k + 1);
  };

  const handleAchieveGoal = async (goalId: string) => {
    setGoalBusyId(goalId);
    const outcome = await updateGoal(agent.id, goalId, { status: "achieved" });
    setGoalBusyId(null);
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    toast.success("Goal marked achieved.");
    announceAgentsChanged();
    onChanged();
    setRefreshKey((k) => k + 1);
  };

  const scrollToRunInChat = () => {
    const el = document.querySelector("[data-work-run-panel], [data-work-task-card]");
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  return (
    <div className="space-y-6">
      {/* Needs you & Working on */}
      {work.session ? (
        <section aria-label={needsAttention ? "Needs you" : "Working on"} className="space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-ui font-medium text-foreground">
              {needsAttention ? "Needs you" : live ? "Working on" : "Recent task"}
            </h3>
            <div className="flex items-center gap-2">
              {needsAttention && hasComputer && onTakeControl ? (
                <Button size="sm" variant="secondary" onClick={onTakeControl} className="gap-1.5">
                  <Hand className="size-3.5 text-primary" aria-hidden="true" />
                  Take control
                </Button>
              ) : null}
              <button
                type="button"
                onClick={scrollToRunInChat}
                className="text-caption text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Show in chat
              </button>
            </div>
          </div>
          <WorkRunPanel work={work} actor={agent.name} />
        </section>
      ) : agent.task ? (
        <section aria-label={agent.task.needsAttention ? "Needs you" : "Working on"} className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-ui font-medium text-foreground">
              {agent.task.needsAttention ? "Needs you" : "Working on"}
            </h3>
            {agent.task.needsAttention && hasComputer && onTakeControl ? (
              <Button size="sm" variant="secondary" onClick={onTakeControl} className="gap-1.5">
                <Hand className="size-3.5 text-primary" aria-hidden="true" />
                Take control
              </Button>
            ) : null}
          </div>
          <div className="rounded-card border border-border bg-card p-3.5">
            <p className="text-ui font-medium text-foreground">{agent.task.title}</p>
            <p className="mt-1 text-caption text-muted-foreground">
              {agent.task.needsAttention
                ? `${agent.name} stopped and is waiting for your input.`
                : `${agent.name} is working on this task.`}
            </p>
          </div>
        </section>
      ) : (
        <EmptyState
          size="panel"
          icon={AppIcons.agents}
          title={agent.status === "paused" ? `${agent.name} is paused` : `${agent.name} is free`}
          description={
            agent.status === "paused"
              ? "Resume it to start something new. Its goals, notes and routines are kept."
              : "Message it in the chat to take on work, set a goal, or add a routine."
          }
        />
      )}

      {/* Goals */}
      <section aria-labelledby="panel-goals" className="space-y-2.5">
        <h3 id="panel-goals" className="text-ui font-medium text-foreground">
          Goals
        </h3>
        {activeGoals.length > 0 ? (
          <ul className="divide-y divide-border rounded-card border border-border bg-card">
            {activeGoals.map((goal) => (
              <li key={goal.id} className="flex items-start gap-2.5 px-3 py-2.5">
                <Checkbox
                  id={`goal-${goal.id}`}
                  checked={goal.status === "achieved"}
                  disabled={goalBusyId === goal.id}
                  onCheckedChange={() => void handleAchieveGoal(goal.id)}
                  aria-label={`Mark "${goal.title}" achieved`}
                  className="mt-0.5"
                />
                <label htmlFor={`goal-${goal.id}`} className="min-w-0 flex-1 cursor-pointer text-ui text-foreground">
                  <span className="block">{goal.title}</span>
                  {goal.lastCheckInNote ? (
                    <span className="mt-0.5 block text-caption text-muted-foreground">{goal.lastCheckInNote}</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ui text-muted-foreground">No active goals yet.</p>
        )}
        <form onSubmit={(e) => void handleAddGoal(e)} className="flex items-center gap-2">
          <Input
            value={newGoalTitle}
            onChange={(e) => setNewGoalTitle(e.target.value)}
            placeholder="Add a goal…"
            aria-label="Add goal"
            className="h-8 text-ui"
          />
          <Button type="submit" size="sm" variant="secondary" loading={addingGoal} disabled={!newGoalTitle.trim()}>
            <Plus className="size-3.5" aria-hidden="true" />
            Add
          </Button>
        </form>
      </section>

      {/* Ideas */}
      <IdeasSection detail={detail} onChanged={onChanged} />

      {/* Next up */}
      {upcoming.length > 0 ? (
        <section aria-labelledby="panel-next-up" className="space-y-2.5">
          <h3 id="panel-next-up" className="text-ui font-medium text-foreground">
            Next up
          </h3>
          <ul className="divide-y divide-border rounded-card border border-border bg-card">
            {upcoming.map((routine) => (
              <li key={routine.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="min-w-0">
                  <span className="block truncate text-ui font-medium text-foreground">{routine.name}</span>
                  <span className="block truncate text-caption text-muted-foreground">{routine.schedule}</span>
                </span>
                <span className="shrink-0 font-mono text-caption text-muted-foreground">
                  {formatLocalWhen(new Date(routine.nextRunAt as string), new Date())}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Activity */}
      <section aria-labelledby="panel-activity" className="space-y-2">
        <h3 id="panel-activity" className="text-ui font-medium text-foreground">
          Activity
        </h3>
        <AgentActivity agentId={agent.id} refreshKey={refreshKey} limit={8} initialItems={mockActivity} />
      </section>
    </div>
  );
}

function IdeasSection({ detail, onChanged }: { detail: ClientAgentDetail; onChanged: () => void }) {
  const { agent, ideas } = detail;
  const [busy, setBusy] = React.useState<string | null>(null);
  const { ask, dialog } = useCostConfirmation();

  const decide = async (idea: ClientAgentIdea, action: "start" | "dismiss") => {
    setBusy(idea.id);
    let outcome = await decideIdea(agent.id, idea.id, action);
    if (outcome.kind === "confirm") {
      const yes = await ask(idea.title, outcome.estimatedCostMicroUsd);
      outcome = yes ? await decideIdea(agent.id, idea.id, action, true) : outcome;
      if (!yes) {
        setBusy(null);
        return;
      }
    }
    setBusy(null);
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    if (outcome.kind === "ok" && action === "start") toast.success(`${agent.name} started “${idea.title}”.`);
    announceAgentsChanged();
    onChanged();
  };

  if (ideas.length === 0) return null;
  return (
    <section aria-labelledby="panel-ideas" className="space-y-2.5">
      <h3 id="panel-ideas" className="text-ui font-medium text-foreground">
        Ideas
      </h3>
      <ul className="space-y-2">
        {ideas.map((idea, index) => (
          <li
            key={idea.id}
            style={staggerDelay(index)}
            className="rounded-card border border-border bg-card p-3.5 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
          >
            <p className="text-ui font-medium text-foreground">{idea.title}</p>
            {idea.detail ? <p className="mt-1 text-caption text-muted-foreground">{idea.detail}</p> : null}
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                loading={busy === idea.id}
                disabled={busy !== null || agent.status !== "active"}
                onClick={() => void decide(idea, "start")}
              >
                Start
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void decide(idea, "dismiss")}>
                Not now
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {dialog}
    </section>
  );
}
