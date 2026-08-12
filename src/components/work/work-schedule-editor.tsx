"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  WORK_HOST_OFFLINE_POLICIES,
  WORK_MISSED_RUN_POLICIES,
  WORK_UNATTENDED_POLICIES,
  type WorkHostOfflinePolicy,
  type WorkMissedRunPolicy,
  type WorkUnattendedPolicy,
} from "@/lib/work/domain";
import { WORK_NOTIFY_POLICIES, type WorkNotifyPolicy } from "@/lib/work/notifications";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import type { ClientWorkGrant, ClientWorkHost } from "@/lib/work/serializers";
import {
  createWorkSchedule,
  fetchWorkHost,
  hostIsReachable,
  patchWorkSchedule,
  type WorkScheduleInput,
  type WorkTriggerDraft,
} from "@/components/work/work-transport";
import { TriggerListEditor, newTrigger } from "@/components/work/work-triggers";
import { WorkStateNote } from "@/components/work/work-vocabulary";

/*
 * Writing a schedule.
 *
 * The same form creates and edits, because the routes take the same object and
 * a second near-identical form is how the two drift — a field added to the
 * editor and forgotten in the creator produces schedules that cannot be made
 * from scratch, only made and then fixed.
 *
 * Two rules from the server shape this more than anything on screen.
 *
 * First, a saved edit sends the whole schedule, and the PATCH route is written
 * for that: it compares the submitted trigger set against the stored one and
 * only moves `nextRunAt` when the kinds that fire on a clock really changed. So
 * a rename here genuinely is a rename, and does not silently discard the run due
 * this evening.
 *
 * Second, every refusal this form can produce is one the server explains in a
 * sentence — an unknown timezone, a trigger config that cannot be parsed, a
 * local schedule with no Mac, a Mac that could never serve it. Those sentences
 * are shown as they arrive rather than replaced with a generic "check your
 * input", because they are the only thing in the exchange that knows which
 * trigger was wrong and why.
 */

interface PolicyOption<T extends string> {
  value: T;
  label: string;
  hint: string;
}

/**
 * What an unattended run may do when nobody is there to ask.
 *
 * All three are ways of NOT acting, and the vocabulary has no fourth. That is
 * the point of the group and is why it is on this form rather than behind an
 * "advanced" fold: a schedule is by definition the case where the person who
 * set it up is asleep.
 */
const UNATTENDED_OPTIONS: readonly PolicyOption<WorkUnattendedPolicy>[] = [
  {
    value: "pause_for_approval",
    label: "Stop and wait for me",
    hint: "The run parks and asks. Nothing irreversible happens until you answer.",
  },
  {
    value: "skip_irreversible",
    label: "Do the rest, and say what it skipped",
    hint: "Everything reversible gets done; the rest is reported rather than attempted.",
  },
  {
    value: "disallow_irreversible",
    label: "Treat it as a failure",
    hint: "The attempt ends the moment it needs something it cannot do unattended.",
  },
];

const HOST_OFFLINE_OPTIONS: readonly PolicyOption<WorkHostOfflinePolicy>[] = [
  { value: "wait", label: "Wait for the Mac", hint: "The fire is held until the Mac checks in again." },
  { value: "skip", label: "Skip this one", hint: "The fire is recorded as skipped and the schedule carries on." },
  {
    value: "cloud_subset",
    label: "Do the cloud part",
    hint: "Runs what does not need the Mac, and reports the part that does.",
  },
];

const MISSED_RUN_OPTIONS: readonly PolicyOption<WorkMissedRunPolicy>[] = [
  { value: "skip", label: "Let them go", hint: "Fires missed while Juno was down are not caught up." },
  { value: "run_once", label: "Catch up once", hint: "One run covers everything that was missed." },
  { value: "run_all", label: "Run every one", hint: "One run per missed fire. A weekend down is a Monday queue." },
];

/**
 * When a run writes to you.
 *
 * The four hints name the channel — email — rather than saying "notification",
 * because that is what actually arrives and a reader who has not been told will
 * go looking for a badge that does not exist. They also state the one exception
 * the code really makes: a task blocked on a person is told about under every
 * option including Never, since a run that stops to ask and never says so sits
 * there until its approval expires, and from the reader's side it simply never
 * finished. Silencing that is not a preference about noise, it is a way of
 * breaking the schedule quietly.
 */
const NOTIFY_OPTIONS: readonly PolicyOption<WorkNotifyPolicy>[] = [
  {
    value: "none",
    label: "Never",
    hint: "No email, with one exception: a run that is stuck waiting for you still writes, or it waits for ever.",
  },
  {
    value: "on_attention",
    label: "Only when it needs me",
    hint: "One email when a run has a question, wants an approval, or lost the Mac it needed. Nothing when it just finishes.",
  },
  {
    value: "on_finish",
    label: "When it finishes",
    hint: "One email per run that ends, however it ended — plus the stuck-run exception above.",
  },
  {
    value: "all",
    label: "Everything",
    hint: "Both of the above. On an hourly schedule that is an email an hour.",
  },
];

/** A draft of everything the form holds, before it becomes a request. */
interface ScheduleDraft {
  name: string;
  instructions: string;
  timezone: string;
  target: "cloud" | "local" | "automatic";
  hostId: string | null;
  enabled: boolean;
  triggers: WorkTriggerDraft[];
  unattendedPolicy: WorkUnattendedPolicy;
  hostOfflinePolicy: WorkHostOfflinePolicy;
  missedRunPolicy: WorkMissedRunPolicy;
  notifyPolicy: WorkNotifyPolicy;
  maxConcurrentRuns: number;
}

function oneOf<T extends string>(options: readonly T[], value: string, fallback: T): T {
  return (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

function draftFrom(schedule: ClientWorkSchedule): ScheduleDraft {
  return {
    name: schedule.name,
    instructions: schedule.instructions,
    timezone: schedule.timezone,
    target: oneOf(["cloud", "local", "automatic"] as const, schedule.target, "automatic"),
    hostId: schedule.hostId,
    enabled: schedule.enabled,
    triggers: schedule.triggers.map((trigger) => ({
      kind: trigger.kind,
      config:
        trigger.config !== null && typeof trigger.config === "object" && !Array.isArray(trigger.config)
          ? (trigger.config as Record<string, unknown>)
          : {},
      enabled: trigger.enabled,
      dedupeWindowSec: trigger.dedupeWindowSec,
    })),
    unattendedPolicy: oneOf(WORK_UNATTENDED_POLICIES, schedule.unattendedPolicy, "pause_for_approval"),
    hostOfflinePolicy: oneOf(WORK_HOST_OFFLINE_POLICIES, schedule.hostOfflinePolicy, "skip"),
    missedRunPolicy: oneOf(WORK_MISSED_RUN_POLICIES, schedule.missedRunPolicy, "run_once"),
    notifyPolicy: oneOf(WORK_NOTIFY_POLICIES, schedule.notifyPolicy, "on_attention"),
    maxConcurrentRuns: schedule.maxConcurrentRuns,
  };
}

/**
 * A blank schedule.
 *
 * The timezone is left empty here and filled in by an effect below, never read
 * from `Intl` during render: the server renders this component too, and a first
 * client render that consulted the browser's timezone would disagree with the
 * HTML that arrived. The daily trigger is a real default rather than an empty
 * list because a schedule with no trigger cannot be saved at all, and opening
 * on a state the save button refuses teaches the reader that the form is broken.
 */
function blankDraft(): ScheduleDraft {
  return {
    name: "",
    instructions: "",
    timezone: "",
    target: "automatic",
    hostId: null,
    enabled: true,
    triggers: [newTrigger("daily", new Date())],
    unattendedPolicy: "pause_for_approval",
    hostOfflinePolicy: "skip",
    missedRunPolicy: "run_once",
    notifyPolicy: "on_attention",
    maxConcurrentRuns: 1,
  };
}

export function WorkScheduleEditor({
  schedule,
  hosts,
  onSaved,
  onCancel,
}: {
  /** Null to create. Otherwise the schedule being edited. */
  schedule: ClientWorkSchedule | null;
  hosts: readonly ClientWorkHost[] | null;
  onSaved: (schedule: ClientWorkSchedule) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<ScheduleDraft>(() =>
    schedule === null ? blankDraft() : draftFrom(schedule)
  );
  const [saving, setSaving] = React.useState(false);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [grants, setGrants] = React.useState<ClientWorkGrant[] | null>(null);

  React.useEffect(() => {
    if (draft.timezone.length > 0) return;
    // `resolvedOptions().timeZone` is an IANA name on every browser that
    // matters, which is exactly what `isValidTimeZone` on the server checks.
    try {
      setDraft((current) => ({
        ...current,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      }));
    } catch {
      setDraft((current) => ({ ...current, timezone: "UTC" }));
    }
  }, [draft.timezone]);

  // Only a folder trigger needs these, and only a named Mac has any. The load
  // is skipped rather than attempted-and-ignored when there is no host, because
  // an empty grant list and an unasked question look identical afterwards and
  // the editor says different things about each.
  const watchesFolder = draft.triggers.some((trigger) => trigger.kind === "folder_change");
  const hostId = draft.hostId;
  React.useEffect(() => {
    if (!watchesFolder || hostId === null) {
      setGrants(null);
      return;
    }
    let cancelled = false;
    void fetchWorkHost(hostId).then((result) => {
      if (cancelled) return;
      setGrants(result.kind === "ok" ? result.value.grants : []);
    });
    return () => {
      cancelled = true;
    };
  }, [watchesFolder, hostId]);

  const reachable = (hosts ?? []).filter(hostIsReachable);
  const named = draft.hostId === null ? null : (hosts ?? []).find((host) => host.id === draft.hostId) ?? null;

  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  // The one rule the form can check before the server does, because it is the
  // one the server answers with a 400 rather than a sentence about the schedule:
  // a local schedule has to name its Mac, or a 07:00 fire lands on whichever
  // laptop happens to be awake.
  const missingHost = draft.target === "local" && draft.hostId === null;
  const canSave =
    draft.name.trim().length > 0 &&
    draft.instructions.trim().length > 0 &&
    draft.timezone.trim().length > 0 &&
    draft.triggers.length > 0 &&
    !missingHost &&
    !saving;

  const save = React.useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);

    const input: WorkScheduleInput = {
      name: draft.name.trim(),
      instructions: draft.instructions.trim(),
      timezone: draft.timezone.trim(),
      target: draft.target,
      // Cleared rather than left dangling when the target moves off a Mac: a
      // cloud schedule still carrying a host id is a row two readers disagree
      // about, and the PATCH route reads an explicit null as "unpin it".
      hostId: draft.target === "cloud" ? null : draft.hostId,
      enabled: draft.enabled,
      triggers: draft.triggers,
      unattendedPolicy: draft.unattendedPolicy,
      hostOfflinePolicy: draft.hostOfflinePolicy,
      missedRunPolicy: draft.missedRunPolicy,
      notifyPolicy: draft.notifyPolicy,
      maxConcurrentRuns: draft.maxConcurrentRuns,
    };

    const result =
      schedule === null
        ? await createWorkSchedule(input)
        : await patchWorkSchedule(schedule.id, input);
    setSaving(false);

    if (result.kind === "ok") {
      const saved = "schedule" in result.value ? result.value.schedule : result.value;
      // The server's prose about what the save did to the next fire, and to any
      // run it cancelled. Neither is derivable from the row that came back, and
      // "paused — one queued run cancelled, one still under way" is precisely
      // the thing somebody pressing pause needs to be told.
      if ("scheduling" in result.value) {
        const notes = [result.value.scheduling, result.value.runs].filter(
          (note): note is string => note !== null
        );
        if (notes.length > 0) toast.success(notes.join(" "));
      }
      onSaved(saved);
      return;
    }
    if (result.kind === "blocked") {
      setRefusal(result.explanation);
      return;
    }
    setRefusal(
      result.message ??
        (result.cause === "offline"
          ? "Couldn’t reach Juno to save this. Nothing was changed."
          : "Couldn’t save this schedule. Nothing was changed.")
    );
  }, [canSave, draft, schedule, onSaved]);

  return (
    <div className="space-y-7">
      <section className="space-y-3">
        <div>
          <Label htmlFor="schedule-name">Name</Label>
          <Input
            id="schedule-name"
            value={draft.name}
            onChange={(event) => set("name", event.target.value)}
            placeholder="Monday morning inbox sweep"
            disabled={saving}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="schedule-instructions">What it should do</Label>
          <Textarea
            id="schedule-instructions"
            value={draft.instructions}
            onChange={(event) => set("instructions", event.target.value)}
            placeholder="Describe the errand and what “done” looks like, the way you would to a person picking it up cold."
            rows={4}
            disabled={saving}
            className="mt-1"
          />
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            Every run starts from this text and nothing else, so it has to stand on its own — nobody
            is there to answer a follow-up at seven in the morning.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-2.5 font-mono text-label text-muted-foreground">When it runs</h2>
        <TriggerListEditor
          triggers={draft.triggers}
          onChange={(triggers) => set("triggers", triggers)}
          grants={grants}
          disabled={saving}
        />
        <div className="mt-3">
          <Label htmlFor="schedule-timezone">Timezone</Label>
          <Input
            id="schedule-timezone"
            value={draft.timezone}
            onChange={(event) => set("timezone", event.target.value)}
            placeholder="Europe/Paris"
            disabled={saving}
            className="mt-1 max-w-xs"
          />
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            An IANA name. Every time above is read in this zone, which is what makes 09:00 stay 09:00
            across a daylight-saving change.
          </p>
        </div>
      </section>

      <section>
        <h2 className="mb-2.5 font-mono text-label text-muted-foreground">Where it runs</h2>
        <SegmentedControl
          value={draft.target}
          onChange={(target) => set("target", target)}
          options={[
            { value: "automatic", label: "Wherever it fits" },
            { value: "cloud", label: "Cloud" },
            { value: "local", label: "One of my Macs" },
          ]}
          ariaLabel="Where this schedule runs"
          optionClassName="px-3 py-1 text-[12.5px]"
          className="max-w-md"
        />
        {draft.target !== "cloud" && (
          <div className="mt-3">
            <Label htmlFor="schedule-host">Mac</Label>
            {/* No `bg-*` utility beside `field-well`. Utilities are emitted
                after the components layer at equal specificity, so `bg-secondary`
                here silently beat the class — and `.field-well` is exactly where
                the per-theme fill belongs (page ground on light, one rung UP on
                dark, because nothing recesses below black). With the utility on,
                this select was secondary on both themes while the `Input` for
                Timezone directly below it was background on light: one form,
                two fills. `px-3.5` and `coarse:h-11` are that Input's too. */}
            <select
              id="schedule-host"
              value={draft.hostId ?? ""}
              disabled={saving || hosts === null}
              onChange={(event) => set("hostId", event.target.value === "" ? null : event.target.value)}
              className="field-well mt-1 h-9 w-full max-w-xs rounded-field border border-input px-3.5 text-sm transition-[color,border-color,box-shadow] duration-base ease-out-soft coarse:h-11 hover:border-input/80 focus-visible:border-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">
                {draft.target === "local" ? "Choose a Mac…" : "Any of my Macs"}
              </option>
              {(hosts ?? []).map((host) => (
                <option key={host.id} value={host.id}>
                  {host.displayName}
                </option>
              ))}
            </select>
            {missingHost && (
              <p className="mt-1 text-[12px] leading-relaxed text-warning-foreground">
                A schedule pinned to a Mac has to say which one. Left open, a 07:00 fire would land
                on whichever machine happened to be awake.
              </p>
            )}
            {named !== null && !hostIsReachable(named) && (
              <p className="mt-1 text-[12px] leading-relaxed text-warning-foreground">
                {named.displayName} is not reachable right now. The schedule can still be saved —
                what happens at the next fire is the offline policy below.
              </p>
            )}
            {hosts !== null && reachable.length === 0 && draft.target === "local" && (
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                None of your Macs are checking in at the moment.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="font-mono text-label text-muted-foreground">When nobody is watching</h2>
        <PolicyGroup
          label="Something it cannot undo"
          options={UNATTENDED_OPTIONS}
          value={draft.unattendedPolicy}
          disabled={saving}
          onChange={(value) => set("unattendedPolicy", value)}
        />
        <PolicyGroup
          label="The Mac is not there"
          options={HOST_OFFLINE_OPTIONS}
          value={draft.hostOfflinePolicy}
          disabled={saving}
          onChange={(value) => set("hostOfflinePolicy", value)}
        />
        <PolicyGroup
          label="Fires that were missed"
          options={MISSED_RUN_OPTIONS}
          value={draft.missedRunPolicy}
          disabled={saving}
          onChange={(value) => set("missedRunPolicy", value)}
        />
        <PolicyGroup
          label="Tell me"
          options={NOTIFY_OPTIONS}
          value={draft.notifyPolicy}
          disabled={saving}
          onChange={(value) => set("notifyPolicy", value)}
        />
        <p className="text-[11.5px] leading-relaxed text-muted-foreground">
          These arrive by email, at the address on your account, once per thing worth saying — a run
          that finishes while a retry is still in flight does not write twice.
        </p>
      </section>

      {refusal !== null && <WorkStateNote tone="error">{refusal}</WorkStateNote>}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void save()} disabled={!canSave} className="gap-1.5">
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {schedule === null ? "Create schedule" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * One policy, as a column of labelled choices with their consequences attached.
 *
 * Radio rows rather than a select, because every one of these decides what
 * happens to somebody's files at three in the morning and the difference
 * between the options is a sentence, not a word. A select hides four of those
 * sentences behind a click.
 */
function PolicyGroup<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: readonly PolicyOption<T>[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  const name = React.useId();
  return (
    <fieldset className="min-w-0" disabled={disabled}>
      {/* `text-label`, the register `Label` resolves to. A fieldset legend and a
          field label do the same job on this page and sat two paragraphs apart
          at 12px/0.10em against 12px/0 — one form, two label voices. */}
      <legend className="font-mono text-label text-muted-foreground">{label}</legend>
      <div className="mt-1.5 space-y-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            // `bg-secondary` on the chosen row, not `accent/40`: 40% of accent
            // over the black ground composites to ~5.2% lightness, BELOW
            // `--card`, so the row somebody had selected sat lower than an
            // unselected card elsewhere on the page. `secondary` is the named
            // rung one step above the ground and is what every other selected
            // row in Work fills with.
            //
            // The focus ring is drawn on the ROW rather than left to the global
            // outline on the 14px radio inside it. This is the control that
            // decides what happens to somebody's files at three in the morning,
            // and a 14px outline inside a full-width row is not where a keyboard
            // reader looks to find out where they are.
            className="flex cursor-pointer items-start gap-2.5 rounded-field border border-border/50 px-3 py-2 transition-colors duration-fast ease-out-soft hover:border-border has-[:checked]:border-foreground/25 has-[:checked]:bg-secondary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-background"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="mt-1 h-3.5 w-3.5 shrink-0 accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-foreground">{option.label}</span>
              <span className="mt-0.5 block text-[11.5px] leading-relaxed text-muted-foreground">
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
