"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Hand, Monitor, X } from "@/components/ui/icons";
import { AgentPresence } from "@/components/agents/agent-presence";
import { AgentFaceStudio } from "@/components/agents/agent-face-studio";
import { formatLocalWhen, localStateSentence } from "@/components/agents/agent-bits";
import { useAgentDetail } from "@/components/agents/use-agents";
import { useCostConfirmation } from "@/components/agents/confirm-cost-dialog";
import {
  announceAgentsChanged,
  computerAction,
  decideIdea,
  deleteNote,
  retireAgent,
  updateAgent,
  updateGoal,
  updateRoutine,
} from "@/components/agents/agents-transport";
import type { ClientAgentDetail, ClientAgentIdea } from "@/lib/agents/types";
import type { WorkPermissionPolicy } from "@/lib/work/domain";
import { cn } from "@/lib/utils";

/**
 * `profile` is the agent's profile in the chat's side slot; `computer` is its
 * computer, full screen over the thread (docs/design/agents-rework/DIRECTION.md).
 */
export type AgentPanelTab = "profile" | "computer";

/** Old links said `now`, `setup`, `goals`…: every one of them now means the profile. */
export function normalizeAgentPanelTab(raw: string | null | undefined): AgentPanelTab | null {
  if (!raw) return null;
  return raw === "computer" ? "computer" : "profile";
}

/** Composer focus, for "Message": the profile's one invitation is to talk. */
export const COMPOSER_FOCUS_EVENT = "juno:composer-focus";

const ASKS_COPY: Record<WorkPermissionPolicy, string> = {
  conservative: "Asks before anything that changes something.",
  balanced: "Works on its own and asks before anything important.",
  permissive: "Just does it, and still asks before sending, paying or deleting.",
};

/**
 * The profile: what the agent is, in prose. Almost nothing here is a form. It can
 * be paused, an app or note removed, its computer turned off, and it can retire;
 * every other change is made by telling it.
 */
export function AgentPanel({
  agentId,
  onClose,
  onOpenComputer,
  initialDetail,
}: {
  agentId: string;
  onClose: () => void;
  onOpenComputer?: () => void;
  initialDetail?: ClientAgentDetail | null;
}) {
  const { detail, error, refresh } = useAgentDetail(agentId, initialDetail ?? null);

  return (
    <aside
      aria-label={detail ? `${detail.agent.name}’s profile` : "Agent profile"}
      className="relative flex h-full w-full flex-col bg-background"
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        onClick={onClose}
        aria-label="Close profile"
        className="absolute right-3 top-3 z-10 text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" aria-hidden="true" />
      </Button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && !detail ? (
          <div className="p-6">
            <LoadError title="Couldn’t load this agent" description={error} onRetry={refresh} />
          </div>
        ) : !detail ? (
          <div className="flex flex-col items-center gap-4 px-6 pt-14" role="status" aria-label="Loading profile">
            <Skeleton className="size-24 rounded-full" />
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-48" />
          </div>
        ) : (
          <AgentProfile detail={detail} onChanged={refresh} onClose={onClose} onOpenComputer={onOpenComputer} />
        )}
      </div>
    </aside>
  );
}

export function AgentProfile({
  detail,
  onChanged,
  onClose,
  onOpenComputer,
}: {
  detail: ClientAgentDetail;
  onChanged: () => void;
  onClose?: () => void;
  onOpenComputer?: () => void;
}) {
  const { agent } = detail;
  const [confirm, setConfirm] = React.useState<null | "retire" | "computer-off" | "computer-on">(null);
  const [studio, setStudio] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const activeGoals = detail.goals.filter((goal) => goal.status === "active");
  const needsYou = agent.state === "waiting" || agent.needsYou > 0;
  const task = agent.task;
  const computer = detail.computerConfigured ? detail.computer ?? null : null;
  const canGetComputer = !!detail.computerConfigured && (!computer || computer.status === "disabled");

  const act = async (key: string, fn: () => Promise<{ kind: string; message?: string }>) => {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    if (res.kind === "failed") {
      toast.error(res.message ?? "That didn’t work. Try again.");
      return false;
    }
    announceAgentsChanged();
    onChanged();
    return true;
  };

  const message = () => {
    onClose?.();
    window.dispatchEvent(new CustomEvent(COMPOSER_FOCUS_EVENT));
  };

  // The task's panel in the thread (`WorkRunPanel`), found by the session it
  // draws. A thread follows one task at a time, so any panel is the fallback.
  const showInChat = () => {
    onClose?.();
    const panels = Array.from(document.querySelectorAll<HTMLElement>("[data-work-run-panel]"));
    const el = panels.find((panel) => panel.dataset.workRunPanel === task?.sessionId) ?? panels[0];
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="px-6 pb-10 pt-12">
      <header className="flex flex-col items-center text-center">
        <button
          type="button"
          onClick={() => setStudio(true)}
          className="group flex flex-col items-center rounded-panel outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Customize ${agent.name}`}
        >
          <AgentPresence
            avatar={agent.avatar}
            state={agent.state}
            size={96}
            haloScale={2.1}
            gaze
            className="transition-transform duration-base ease-spring group-hover:scale-[1.04] group-active:scale-[0.98] motion-reduce:transform-none"
          />
          <span className="mt-3 text-caption text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft group-hover:opacity-100 group-focus-visible:opacity-100 coarse:opacity-100">
            Customize
          </span>
        </button>
        <h2 className="mt-3 font-serif text-title italic leading-[1.15] text-foreground">{agent.name}</h2>
        {agent.role.trim() ? <p className="mt-1 text-body text-muted-foreground">{agent.role.trim()}</p> : null}
        <p className="mt-4 max-w-xs text-ui text-muted-foreground">Change anything by telling {agent.name}.</p>
        <Button type="button" size="sm" className="mt-4 rounded-full px-5" onClick={message}>
          Message
        </Button>
      </header>

      <div className="mt-10 space-y-9">
        {needsYou || task ? (
          <Section title={needsYou ? "Needs you" : "Working on"}>
            <div className="flex items-start gap-3">
              {needsYou ? <Hand className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
              <div className="min-w-0 flex-1">
                <p className={cn("text-body", needsYou ? "font-medium text-primary" : "text-foreground")}>
                  {task?.title ?? localStateSentence(agent, agent.state)}
                </p>
                <button
                  type="button"
                  onClick={showInChat}
                  className="mt-1 text-ui text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {needsYou ? "Answer in chat" : "Show in chat"}
                </button>
              </div>
            </div>
          </Section>
        ) : null}

        <IdeasSection detail={detail} onChanged={onChanged} />

        {activeGoals.length > 0 ? (
          <Section title="Working toward">
            <ul className="space-y-3">
              {activeGoals.map((goal) => (
                <li key={goal.id} className="flex items-start gap-3">
                  <Checkbox
                    id={`goal-${goal.id}`}
                    disabled={busy === goal.id}
                    onCheckedChange={() =>
                      void act(goal.id, () => updateGoal(agent.id, goal.id, { status: "achieved" }))
                    }
                    aria-label={`Mark “${goal.title}” achieved`}
                    className="mt-1"
                  />
                  <label htmlFor={`goal-${goal.id}`} className="min-w-0 flex-1 cursor-pointer">
                    <span className="block text-body text-foreground">{goal.title}</span>
                    {goal.lastCheckInNote ? (
                      <span className="mt-0.5 block text-ui text-muted-foreground">{goal.lastCheckInNote}</span>
                    ) : null}
                  </label>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {detail.routines.length > 0 ? (
          <Section title="When it works">
            <ul className="space-y-3.5">
              {detail.routines.map((routine) => (
                <li key={routine.id} className="flex items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-body", routine.enabled ? "text-foreground" : "text-muted-foreground")}>
                      {routine.name}
                    </span>
                    <span className="block text-ui text-muted-foreground">
                      {routine.enabled
                        ? routine.nextRunAt
                          ? `${routine.schedule}. Next ${formatLocalWhen(new Date(routine.nextRunAt), new Date())}.`
                          : routine.schedule
                        : "Paused"}
                    </span>
                  </span>
                  <Switch
                    checked={routine.enabled}
                    disabled={busy === routine.id}
                    onCheckedChange={(on) => void act(routine.id, () => updateRoutine(routine.id, on))}
                    aria-label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
                  />
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {detail.notes.length > 0 ? (
          <Section title="What it knows">
            <ul className="space-y-2.5">
              {detail.notes.map((note) => (
                <li key={note.id} className="group flex items-start gap-3">
                  <p className="min-w-0 flex-1 text-body text-foreground">{note.content}</p>
                  <button
                    type="button"
                    disabled={busy === note.id}
                    onClick={() => void act(note.id, () => deleteNote(agent.id, note.id))}
                    aria-label="Forget this"
                    className="mt-0.5 shrink-0 rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
                  >
                    <X className="size-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {agent.connectorIds.length > 0 || (computer && computer.status !== "disabled") || canGetComputer ? (
          <Section title="What it can use">
            <ul className="space-y-3">
              {computer && computer.status !== "disabled" ? (
                <li className="flex items-center gap-3">
                  <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body text-foreground">Its own computer</span>
                    <span className="block text-ui text-muted-foreground">{computerWords(computer.status)}</span>
                  </span>
                  {onOpenComputer ? (
                    <Button type="button" size="sm" variant="outline" className="rounded-full" onClick={onOpenComputer}>
                      Open
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => setConfirm("computer-off")}
                  >
                    Turn off
                  </Button>
                </li>
              ) : null}
              {canGetComputer ? (
                <li className="flex items-center gap-3">
                  <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-body text-foreground">A computer of its own</span>
                    <span className="block text-ui text-muted-foreground">To sign in to sites, run code and keep files.</span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="rounded-full"
                    loading={busy === "computer"}
                    onClick={() => setConfirm("computer-on")}
                  >
                    Give it one
                  </Button>
                </li>
              ) : null}
              {agent.connectorIds.map((id) => (
                <li key={id} className="group flex items-center gap-3">
                  <span className="min-w-0 flex-1 text-body text-foreground">{appName(id)}</span>
                  <button
                    type="button"
                    disabled={busy === `app-${id}`}
                    onClick={() =>
                      void act(`app-${id}`, () =>
                        updateAgent(agent.id, { connectorIds: agent.connectorIds.filter((c) => c !== id) })
                      )
                    }
                    className="text-ui text-muted-foreground opacity-0 transition-opacity duration-fast ease-out-soft hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        <Section title="How much it asks">
          <p className="text-body text-foreground">{ASKS_COPY[agent.approvalMode]}</p>
          <p className="mt-1 text-ui text-muted-foreground">Ask {agent.name} to change this.</p>
        </Section>
      </div>

      <footer className="mt-12 flex items-center justify-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="rounded-full"
          loading={busy === "pause"}
          onClick={() =>
            void act("pause", () =>
              updateAgent(agent.id, { status: agent.status === "paused" ? "active" : "paused" })
            )
          }
        >
          {agent.status === "paused" ? "Resume" : "Pause"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="rounded-full text-muted-foreground hover:text-destructive"
          onClick={() => setConfirm("retire")}
        >
          Retire
        </Button>
      </footer>

      <AgentFaceStudio agent={agent} open={studio} onOpenChange={setStudio} onSaved={() => onChanged()} />

      <Dialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === "retire"
                ? `Retire ${agent.name}?`
                : confirm === "computer-on"
                  ? `Give ${agent.name} a computer?`
                  : `Turn off ${agent.name}’s computer?`}
            </DialogTitle>
            <DialogDescription>
              {confirm === "retire"
                ? "Its routines stop and it leaves your agents. This conversation stays in your history."
                : confirm === "computer-on"
                  ? "It gets a private desktop on your server. What it signs in to and the files it keeps stay there between tasks, until you reset or turn it off."
                  : "The computer is deleted, with everything it signed in to and every file on it."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={confirm === "computer-on" ? "default" : "destructive"}
              onClick={() => {
                const which = confirm;
                setConfirm(null);
                if (which === "retire") {
                  void act("retire", () => retireAgent(agent.id)).then((ok) => {
                    if (ok) window.location.assign("/agents");
                  });
                } else if (which === "computer-on") {
                  void act("computer", () => computerAction(agent.id, "enable"));
                } else {
                  void act("computer", () => computerAction(agent.id, "disable"));
                }
              }}
            >
              {confirm === "retire" ? "Retire" : confirm === "computer-on" ? "Give it one" : "Turn off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-ui font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
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
      if (!yes) {
        setBusy(null);
        return;
      }
      outcome = await decideIdea(agent.id, idea.id, action, true);
    }
    setBusy(null);
    if (outcome.kind === "failed") {
      toast.error(outcome.message);
      return;
    }
    announceAgentsChanged();
    onChanged();
  };

  if (ideas.length === 0) return null;
  return (
    <Section title="Ideas">
      <ul className="space-y-5">
        {ideas.slice(0, 3).map((idea) => (
          <li key={idea.id}>
            <p className="text-body text-foreground">{idea.title}</p>
            {idea.detail ? <p className="mt-0.5 text-ui text-muted-foreground">{idea.detail}</p> : null}
            <div className="mt-2 flex items-center gap-1">
              <Button
                type="button"
                size="sm"
                className="rounded-full px-4"
                loading={busy === idea.id}
                onClick={() => void decide(idea, "start")}
              >
                Start
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="rounded-full text-muted-foreground"
                disabled={busy === idea.id}
                onClick={() => void decide(idea, "dismiss")}
              >
                Not now
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {dialog}
    </Section>
  );
}

function computerWords(status: string): string {
  switch (status) {
    case "awake":
      return "Awake";
    case "resting":
      return "Resting. Opens instantly.";
    case "waking":
    case "starting":
      return "Waking up";
    case "error":
      return "Couldn’t be reached";
    default:
      return "Asleep. Wakes when it starts working.";
  }
}

const APP_NAMES: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  google_calendar: "Google Calendar",
  googledrive: "Google Drive",
  notion: "Notion",
  slack: "Slack",
  github: "GitHub",
  linear: "Linear",
  outlook: "Outlook",
};

function appName(id: string): string {
  const key = id.toLowerCase();
  if (APP_NAMES[key]) return APP_NAMES[key];
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
