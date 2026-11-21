"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Monitor, Plus } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ClientAgent } from "@/lib/agents/types";
import { announceAgentsChanged, computerAction, pressKey, startAgentTask } from "./agents-transport";

export function OrbitAgentActions({ agent, href, onChanged }: {
  agent: ClientAgent;
  href: string;
  onChanged: () => void;
}) {
  const router = useRouter();
  const hasCloudComputer = agent.executionTarget !== "mac";
  const computerHref = `${href}?agent=computer`;
  const computer = agent.computer;
  const canWake = computer && (!computer.enabled || ["asleep", "resting", "disabled", "error"].includes(computer.status));
  const wakingRef = useRef(false);
  const [waking, setWaking] = useState(false);
  const [computerError, setComputerError] = useState<string | null>(null);

  async function wake() {
    if (wakingRef.current) return;
    wakingRef.current = true;
    setWaking(true);
    setComputerError(null);
    const outcome = await computerAction(agent.id, "wake");
    wakingRef.current = false;
    setWaking(false);
    if (outcome.kind !== "ok") {
      setComputerError(outcome.message);
      return;
    }
    if (!outcome.value) {
      setComputerError("The computer did not return a status. Open its panel to check access.");
      return;
    }
    announceAgentsChanged();
    onChanged();
    router.push(computerHref);
  }

  return (
    <div className="orbit-agent-actions">
      <div className="orbit-agent-actions__row">
        {hasCloudComputer && (canWake ? (
          <button className="orbit-agent-computer" type="button" onClick={() => void wake()} disabled={waking}>
            <Monitor aria-hidden="true" className="size-4.5" />
            <span>{waking ? "Starting…" : "Start computer"}</span>
          </button>
        ) : (
          <Link href={computerHref} className="orbit-agent-computer">
            <Monitor aria-hidden="true" className="size-4.5" />
            <span>{computer?.status === "awake" ? "View computer" : computer ? "Open computer" : "Computer access"}</span>
            <ArrowUpRight aria-hidden="true" className="size-3.5" />
          </Link>
        ))}
        <OrbitTaskDialog agent={agent} onStarted={onChanged} />
      </div>
      {computerError && <p className="orbit-agent-actions__error" role="status">{computerError}</p>}
    </div>
  );
}

function OrbitTaskDialog({ agent, onStarted }: { agent: ClientAgent; onStarted: () => void }) {
  const router = useRouter();
  const id = useId();
  const flight = useRef(false);
  const requestKey = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function edit() {
    requestKey.current = null;
    setConfirmation(null);
    setError(null);
  }

  function changeOpen(next: boolean) {
    if (flight.current) return;
    if (!next) {
      edit();
      setTitle("");
      setGoal("");
    }
    setOpen(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flight.current || !title.trim() || !goal.trim()) return;
    flight.current = true;
    setBusy(true);
    setError(null);
    requestKey.current ??= pressKey();
    const outcome = await startAgentTask(agent.id, {
      title: title.trim(), goal: goal.trim(), idempotencyKey: requestKey.current,
      ...(confirmation ? { confirmExpensive: true } : {}),
    });
    flight.current = false;
    setBusy(false);

    if (outcome.kind === "confirm") {
      setConfirmation(outcome.message);
    } else if (outcome.kind === "failed") {
      setError(outcome.message);
    } else if (!outcome.value.conversationId || !outcome.value.sessionId) {
      setError("Alevr could not confirm the task started. Check Activity before trying again.");
    } else {
      changeOpen(false);
      announceAgentsChanged();
      onStarted();
      router.push(`/chat/${encodeURIComponent(outcome.value.conversationId)}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="orbit-agent-task" disabled={agent.status === "paused"}>
          <Plus className="size-4.5" aria-hidden="true" /> New task
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a task with {agent.name}</DialogTitle>
          <DialogDescription>Describe the result you want. You can follow progress in {agent.name}’s chat and Activity.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-title`}>Task name</Label>
            <Input id={`${id}-title`} value={title} maxLength={80} disabled={busy} required onChange={(event) => { edit(); setTitle(event.target.value); }} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-goal`}>What should {agent.name} do?</Label>
            <Textarea id={`${id}-goal`} value={goal} rows={4} maxLength={4000} disabled={busy} required onChange={(event) => { edit(); setGoal(event.target.value); }} />
          </div>
          {confirmation && <p className="rounded-control bg-muted px-3 py-2 text-ui" role="status">{confirmation}</p>}
          {error && <p role="alert" className="text-ui text-destructive-ink">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => changeOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim() || !goal.trim()}>
              {busy ? "Starting…" : confirmation ? "Confirm and start" : "Start task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
