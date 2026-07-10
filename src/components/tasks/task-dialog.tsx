"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApp } from "@/components/app/app-provider";
import { planRank, effectiveMinPlan } from "@/lib/plans";
import { DEFAULT_MODEL } from "@/lib/models";
import { PROVIDERS } from "@/lib/providers";
import { cn } from "@/lib/utils";
import {
  CADENCES,
  DEFAULT_TASK_TIMEZONE,
  WEEKDAY_LABELS,
  ordinal,
  type TaskCadence,
  type TaskItem,
} from "@/components/tasks/task-model";

const pad = (n: number) => String(n).padStart(2, "0");

// Mon–Sun for the weekly picker (stored as 0=Sun … 6=Sat).
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function TaskDialog({
  open,
  onOpenChange,
  task,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null = create; a task = edit it. */
  task: TaskItem | null;
  onSaved: (task: TaskItem, isNew: boolean) => void;
}) {
  const { models, quota } = useApp();
  const plan = quota.plan;

  // Chat models the plan actually allows — same gate the model selector applies.
  const allowedModels = React.useMemo(
    () =>
      models.filter(
        (m) => m.modality === "chat" && !m.comingSoon && planRank(plan) >= planRank(effectiveMinPlan(m.minPlan))
      ),
    [models, plan]
  );

  const [name, setName] = React.useState("");
  const [prompt, setPrompt] = React.useState("");
  const [model, setModel] = React.useState("");
  const [cadence, setCadence] = React.useState<TaskCadence>("DAILY");
  const [time, setTime] = React.useState("08:00");
  const [weekday, setWeekday] = React.useState(1);
  const [monthday, setMonthday] = React.useState(1);
  const [timezone, setTimezone] = React.useState(DEFAULT_TASK_TIMEZONE);
  const [timezoneOpen, setTimezoneOpen] = React.useState(false);
  const [webSearch, setWebSearch] = React.useState(true);
  const [saving, setSaving] = React.useState(false);

  // (Re)seed the form each time the dialog opens — for the task being edited,
  // or with fresh defaults for a new one.
  React.useEffect(() => {
    if (!open) return;
    setName(task?.name ?? "");
    setPrompt(task?.prompt ?? "");
    setModel(
      task?.model ??
        (allowedModels.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : allowedModels[0]?.id ?? "")
    );
    setCadence(task?.cadence ?? "DAILY");
    setTime(task ? `${pad(task.hour)}:${pad(task.minute)}` : "08:00");
    setWeekday(task?.weekday ?? 1);
    setMonthday(task?.monthday ?? 1);
    setTimezone(task?.timezone ?? DEFAULT_TASK_TIMEZONE);
    setTimezoneOpen((task?.timezone ?? DEFAULT_TASK_TIMEZONE) !== DEFAULT_TASK_TIMEZONE);
    setWebSearch(task?.webSearch ?? true);
    setSaving(false);
    // allowedModels is intentionally read once per open — reseeding on model
    // list refreshes would stomp an in-progress edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task]);

  const submit = async () => {
    const [hour, minute] = time.split(":").map(Number);
    if (!name.trim() || !prompt.trim() || !model || !Number.isFinite(hour) || !Number.isFinite(minute)) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        prompt: prompt.trim(),
        model,
        cadence,
        hour,
        minute,
        weekday: cadence === "WEEKLY" ? weekday : null,
        monthday: cadence === "MONTHLY" ? monthday : null,
        timezone: timezone.trim() || DEFAULT_TASK_TIMEZONE,
        webSearch,
      };
      const res = await fetch(task ? `/api/tasks/${task.id}` : "/api/tasks", {
        method: task ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Could not save the task.");
      onSaved(data.task, !task);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the task.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-serif">{task ? "Edit task" : "New task"}</DialogTitle>
          <DialogDescription>
            {task
              ? "Adjust what runs, on which model, and when."
              : "Juno runs this prompt on a schedule — results land in a chat thread."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="task-name">Name</Label>
            <Input
              id="task-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              placeholder="Daily AI news brief"
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-prompt">Prompt</Label>
            <Textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              maxLength={4000}
              rows={4}
              placeholder="Summarize today's most important AI news in five short bullet points, with sources."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="task-model">Model</Label>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger id="task-model">
                <SelectValue placeholder="Pick a model" />
              </SelectTrigger>
              <SelectContent>
                {allowedModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                    <span className="text-muted-foreground"> · {PROVIDERS[m.provider].label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Schedule</Label>
            <div className="grid grid-cols-4 gap-0.5 rounded-lg bg-muted p-0.5" role="radiogroup" aria-label="Cadence">
              {CADENCES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={cadence === c.id}
                  onClick={() => setCadence(c.id)}
                  className={cn(
                    "rounded-md px-1 py-1.5 text-xs font-medium transition-colors duration-fast",
                    cadence === c.id
                      ? "bg-background text-foreground shadow-soft"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              {cadence === "WEEKLY" && (
                <Select value={String(weekday)} onValueChange={(v) => setWeekday(Number(v))}>
                  <SelectTrigger className="w-32" aria-label="Weekday">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAY_ORDER.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {WEEKDAY_LABELS[d]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {cadence === "MONTHLY" && (
                <Select value={String(monthday)} onValueChange={(v) => setMonthday(Number(v))}>
                  <SelectTrigger className="w-32" aria-label="Day of month">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {ordinal(d)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-32"
                aria-label="Time of day"
              />
            </div>
            {timezoneOpen ? (
              <Input
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder={DEFAULT_TASK_TIMEZONE}
                aria-label="Timezone (IANA name)"
              />
            ) : (
              <button
                type="button"
                onClick={() => setTimezoneOpen(true)}
                className="text-xs text-muted-foreground underline-offset-2 transition-colors duration-fast hover:text-foreground hover:underline"
              >
                Timezone: {timezone} — change
              </button>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 px-3.5 py-3">
            <div>
              <Label htmlFor="task-web-search">Web search</Label>
              <p className="text-xs text-muted-foreground">Let the model search the web when it supports it.</p>
            </div>
            <Switch id="task-web-search" checked={webSearch} onCheckedChange={setWebSearch} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim() || !prompt.trim() || !model}>
            {saving ? "Saving…" : task ? "Save changes" : "Create task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
