"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AppIcons } from "@/lib/app-icons";
import { AGENT_ROUTINE_CADENCES, AGENT_ROUTINE_CADENCE_LABEL, type AgentRoutineCadence } from "@/lib/agents/domain";
import type { ClientAgentDetail } from "@/lib/agents/types";
import { staggerDelay } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { announceAgentsChanged, createRoutine } from "@/components/agents/agents-transport";
import { formatLocalWhen } from "@/components/agents/agent-bits";
import { SectionTitle } from "@/components/agents/agent-now";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Routines: work the agent does on a clock, in its own thread.
 *
 * Each is an ordinary automation (a `WorkSchedule`) whose task belongs to the
 * agent, so everything Automations knows — missed runs, daylight saving, the
 * run history, pausing — applies unchanged, and the full editor is one press
 * away. This page offers the five clocks people actually ask for; event
 * triggers and Macs live in the editor that already handles them.
 *
 * Grok Bot's advice is the right order and the empty state says it: get one
 * good run in the thread first, then make it a routine.
 */
export function AgentRoutines({ detail, onChanged }: { detail: ClientAgentDetail; onChanged: () => void }) {
  const { agent, routines } = detail;
  return (
    <div className="space-y-8">
      <NewRoutine agentId={agent.id} agentName={agent.name} onCreated={onChanged} />
      {routines.length === 0 ? (
        <EmptyState
          size="panel"
          icon={AppIcons.automations}
          title="No routines yet"
          description={`Once ${agent.name} has done something well once, make it a routine: a weekly digest, a morning inbox pass, a price check every day.`}
        />
      ) : (
        <section aria-labelledby="agent-routines" className="@container">
          <SectionTitle id="agent-routines">Its routines</SectionTitle>
          <ul className="divide-y divide-border rounded-card border border-border">
            {routines.map((routine, index) => (
              <li
                key={routine.id}
                style={staggerDelay(index, "tight")}
                className="flex items-center gap-3 px-4 py-3 motion-safe:animate-rise-in [animation-fill-mode:backwards]"
              >
                <div className="min-w-0 flex-1">
                  <p className={cn("truncate text-ui font-medium", routine.enabled ? "text-foreground" : "text-muted-foreground")}>
                    {routine.name}
                  </p>
                  <p className="truncate text-ui text-muted-foreground">
                    {routine.enabled ? routine.schedule : `Paused · ${routine.schedule}`}
                  </p>
                </div>
                {routine.enabled && routine.nextRunAt ? (
                  <span className="hidden shrink-0 font-mono text-caption text-muted-foreground @[28rem]:inline">
                    {formatLocalWhen(new Date(routine.nextRunAt), new Date())}
                  </span>
                ) : null}
                <Button asChild size="sm" variant="ghost">
                  <Link href={`/automations/${routine.id}`}>Edit</Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function NewRoutine({ agentId, agentName, onCreated }: { agentId: string; agentName: string; onCreated: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [instructions, setInstructions] = React.useState("");
  const [cadence, setCadence] = React.useState<AgentRoutineCadence>("weekdays");
  const [time, setTime] = React.useState("09:00");
  const [weekday, setWeekday] = React.useState(1);
  const [monthday, setMonthday] = React.useState(1);
  const [saving, setSaving] = React.useState(false);

  if (!open) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        New routine
      </Button>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !instructions.trim() || saving) return;
    const [hour, minute] = time.split(":").map((part) => Number(part));
    setSaving(true);
    const outcome = await createRoutine(agentId, {
      name: name.trim(),
      instructions: instructions.trim(),
      cadence,
      hour: Number.isFinite(hour) ? hour : 9,
      minute: Number.isFinite(minute) ? minute : 0,
      ...(cadence === "weekly" ? { weekday } : {}),
      ...(cadence === "monthly" ? { monthday } : {}),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    });
    setSaving(false);
    if (outcome.kind !== "ok") {
      toast.error(outcome.kind === "failed" ? outcome.message : "That routine did not save.");
      return;
    }
    toast.success(`${agentName} will do “${name.trim()}” ${AGENT_ROUTINE_CADENCE_LABEL[cadence].toLowerCase()}.`);
    setOpen(false);
    setName("");
    setInstructions("");
    announceAgentsChanged();
    onCreated();
  };

  return (
    <form onSubmit={submit} className="@container space-y-4 rounded-card border border-border bg-card p-4 motion-safe:animate-rise-in">
      <p className="text-heading">New routine</p>
      <label className="block">
        <span className="mb-1.5 block font-mono text-label text-muted-foreground">Name</span>
        <Input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} placeholder="Weekly digest" required />
      </label>
      <label className="block">
        <span className="mb-1.5 block font-mono text-label text-muted-foreground">What it does each time</span>
        <Textarea
          value={instructions}
          rows={3}
          maxLength={4000}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="Summarise what changed this week in the topics I track, with links, in five bullets."
          required
        />
      </label>
      <div>
        <span className="mb-1.5 block font-mono text-label text-muted-foreground">When</span>
        <SegmentedControl
          ariaLabel="How often"
          value={cadence}
          onChange={setCadence}
          options={AGENT_ROUTINE_CADENCES.map((value) => ({
            value,
            label: AGENT_ROUTINE_CADENCE_LABEL[value].replace(/^Every /, "").replace(/^./, (c) => c.toUpperCase()),
          }))}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {cadence === "weekly" ? (
            <Select value={String(weekday)} onValueChange={(value) => setWeekday(Number(value))}>
              <SelectTrigger className="h-9 w-40" aria-label="Day of the week">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAYS.map((day, index) => (
                  <SelectItem key={day} value={String(index)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          {cadence === "monthly" ? (
            <label className="flex items-center gap-2 text-ui text-muted-foreground">
              Day
              <Input
                type="number"
                min={1}
                max={31}
                value={monthday}
                onChange={(event) => setMonthday(Math.min(31, Math.max(1, Number(event.target.value) || 1)))}
                className="w-20"
              />
            </label>
          ) : null}
          <label className="flex items-center gap-2 text-ui text-muted-foreground">
            {cadence === "hourly" ? "At minute" : "At"}
            <Input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="w-32"
              aria-label="Time"
            />
          </label>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={saving} disabled={!name.trim() || !instructions.trim()}>
          Create routine
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
