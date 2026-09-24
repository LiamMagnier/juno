"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { IconButton } from "@/components/ui/icon-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Collapse } from "@/components/ui/collapse";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionIcons, AppIcons } from "@/lib/app-icons";
import {
  AGENT_GOAL_CADENCES,
  AGENT_GOAL_CADENCE_LABEL,
  MAX_GOAL_DETAIL_CHARS,
  MAX_GOAL_TITLE_CHARS,
  type AgentGoalCadence,
  type AgentGoalStatus,
} from "@/lib/agents/domain";
import type { ClientAgentDetail, ClientAgentGoal } from "@/lib/agents/types";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { staggerDelay } from "@/lib/motion";
import {
  announceAgentsChanged,
  createGoal,
  deleteGoal,
  pressKey,
  startAgentTask,
  updateGoal,
} from "@/components/agents/agents-transport";
import { useCostConfirmation } from "@/components/agents/confirm-cost-dialog";
import { formatAgo } from "@/components/agents/agent-bits";
import { SectionTitle } from "@/components/agents/agent-now";

/**
 * Goals: what the agent works towards over time, not one job.
 *
 * A goal is not a task. "Keep my inbox under control" never finishes; it is
 * what reflection checks in on and what an idea serves. So a goal row carries
 * where things stand (the last check-in, in the agent's words), and one press
 * — Work on it — that hands the goal to the agent as a task, under the same
 * checks any task meets.
 */
export function AgentGoals({
  detail,
  onChanged,
  onStarted,
}: {
  detail: ClientAgentDetail;
  onChanged: () => void;
  onStarted: () => void;
}) {
  const { agent, goals } = detail;
  const open = goals.filter((goal) => goal.status === "active" || goal.status === "paused");
  const closed = goals.filter((goal) => goal.status === "achieved" || goal.status === "dropped");
  const [showClosed, setShowClosed] = React.useState(false);
  const { ask, dialog } = useCostConfirmation();
  const [working, setWorking] = React.useState<string | null>(null);

  const workOn = async (goal: ClientAgentGoal) => {
    setWorking(goal.id);
    const key = pressKey();
    const input = {
      title: goal.title.slice(0, 80),
      goal: [`Make real progress on this goal: ${goal.title}`, goal.detail, goal.lastCheckInNote ? `Where things stand: ${goal.lastCheckInNote}` : ""]
        .filter(Boolean)
        .join("\n\n"),
      idempotencyKey: key,
    };
    let outcome = await startAgentTask(agent.id, input);
    if (outcome.kind === "confirm") {
      const yes = await ask(goal.title, outcome.estimatedCostMicroUsd);
      if (!yes) {
        setWorking(null);
        return;
      }
      outcome = await startAgentTask(agent.id, { ...input, confirmExpensive: true });
    }
    setWorking(null);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That did not start.");
      return;
    }
    toast.success(`${agent.name} is on it.`);
    announceAgentsChanged();
    onStarted();
  };

  const setStatus = async (goal: ClientAgentGoal, status: AgentGoalStatus) => {
    const outcome = await updateGoal(agent.id, goal.id, { status });
    if (outcome.kind !== "ok") toast.error(outcome.kind === "failed" ? outcome.message : "That did not save.");
    onChanged();
  };

  const remove = async (goal: ClientAgentGoal) => {
    const outcome = await deleteGoal(agent.id, goal.id);
    if (outcome.kind !== "ok") toast.error(outcome.kind === "failed" ? outcome.message : "That did not delete.");
    onChanged();
  };

  return (
    <div className="space-y-8">
      <NewGoal agentId={agent.id} onCreated={onChanged} />
      {open.length === 0 ? (
        <EmptyState
          size="panel"
          icon={AppIcons.agents}
          title="No goals yet"
          description={`Give ${agent.name} something to work towards. It checks in on its goals and suggests what to do next.`}
        />
      ) : (
        <section aria-labelledby="agent-goals-open">
          <SectionTitle id="agent-goals-open">Working towards</SectionTitle>
          <ul className="space-y-2">
            {open.map((goal, index) => (
              <li
                key={goal.id}
                style={staggerDelay(index)}
                className="rounded-card border border-border bg-card p-4 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-body font-medium text-foreground">{goal.title}</p>
                    {goal.detail ? <p className="mt-0.5 text-ui text-muted-foreground">{goal.detail}</p> : null}
                    <p className="mt-1.5 font-mono text-caption text-muted-foreground">
                      {goal.status === "paused" ? "Paused" : AGENT_GOAL_CADENCE_LABEL[goal.cadence]}
                    </p>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton label={`More for ${goal.title}`} size="sm" variant="ghost">
                        <ActionIcons.more className="size-4" aria-hidden="true" />
                      </IconButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void setStatus(goal, "achieved")}>Mark achieved</DropdownMenuItem>
                      {goal.status === "paused" ? (
                        <DropdownMenuItem onSelect={() => void setStatus(goal, "active")}>Resume</DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => void setStatus(goal, "paused")}>Pause</DropdownMenuItem>
                      )}
                      <DropdownMenuItem onSelect={() => void setStatus(goal, "dropped")}>Drop</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem className="text-destructive" onSelect={() => void remove(goal)}>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {goal.lastCheckInNote ? (
                  <div className="mt-3 border-l-2 border-border pl-3">
                    <p className="text-ui text-foreground">{goal.lastCheckInNote}</p>
                    {goal.lastCheckInAt ? (
                      <p className="mt-0.5 font-mono text-caption text-muted-foreground">
                        Checked in {formatAgo(goal.lastCheckInAt)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {goal.status === "active" ? (
                  <div className="mt-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={working === goal.id}
                      disabled={working !== null || agent.status !== "active"}
                      onClick={() => void workOn(goal)}
                    >
                      Work on it
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      )}

      {closed.length > 0 ? (
        <section>
          <button
            type="button"
            className="text-ui text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            aria-expanded={showClosed}
            onClick={() => setShowClosed((value) => !value)}
          >
            {showClosed ? "Hide" : "Show"} {closed.length} finished {closed.length === 1 ? "goal" : "goals"}
          </button>
          <Collapse open={showClosed}>
            <ul className="mt-3 space-y-1">
              {closed.map((goal) => (
                <li key={goal.id} className="flex items-center justify-between gap-3 rounded-control px-3 py-2">
                  <span className="min-w-0 truncate text-ui text-muted-foreground">
                    {goal.status === "achieved" ? "Achieved" : "Dropped"} · {goal.title}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void setStatus(goal, "active")}>
                    Reopen
                  </Button>
                </li>
              ))}
            </ul>
          </Collapse>
        </section>
      ) : null}
      {dialog}
    </div>
  );
}

function NewGoal({ agentId, onCreated }: { agentId: string; onCreated: () => void }) {
  const [title, setTitle] = React.useState("");
  const [detail, setDetail] = React.useState("");
  const [cadence, setCadence] = React.useState<AgentGoalCadence>("weekly");
  const [saving, setSaving] = React.useState(false);
  const [more, setMore] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || saving) return;
    setSaving(true);
    const outcome = await createGoal(agentId, { title: title.trim(), detail: detail.trim(), cadence });
    setSaving(false);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That goal did not save.");
      return;
    }
    setTitle("");
    setDetail("");
    setMore(false);
    announceAgentsChanged();
    onCreated();
  };

  return (
    <form onSubmit={submit} className="rounded-card border border-border bg-card p-3">
      <div className="flex items-center gap-2">
        <Input
          value={title}
          maxLength={MAX_GOAL_TITLE_CHARS}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={() => setMore(true)}
          placeholder="A new goal, e.g. keep my week under 30 hours of meetings"
          aria-label="New goal"
        />
        <Button type="submit" size="sm" loading={saving} disabled={!title.trim()}>
          Add
        </Button>
      </div>
      <Collapse open={more}>
        <div className="space-y-3 pt-3">
          <Textarea
            value={detail}
            rows={2}
            maxLength={MAX_GOAL_DETAIL_CHARS}
            onChange={(event) => setDetail(event.target.value)}
            placeholder="What good looks like (optional)"
            aria-label="Goal detail"
          />
          <SegmentedControl
            ariaLabel="How often it checks in"
            value={cadence}
            onChange={setCadence}
            options={AGENT_GOAL_CADENCES.map((value) => ({ value, label: AGENT_GOAL_CADENCE_LABEL[value] }))}
          />
        </div>
      </Collapse>
    </form>
  );
}
