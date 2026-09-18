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
import { parseScheduleRunConfig, type ClientWorkSchedule } from "@/lib/work/schedule";
import { parseCodeRoutineConfig } from "@/lib/work/code-routine";
import {
  CODE_PERMISSION_MODES,
  DEFAULT_CLOUD_PERMISSION_MODE,
  type CodePermissionMode,
} from "@/lib/code-environments";
import type { Plan } from "@prisma/client";
import { ceilingFieldValue, runBudgetForPlan } from "@/lib/work/budget";
import { useApp } from "@/components/app/app-provider";
import { MODEL_LIST } from "@/lib/models";
import { isWorkCapableModel } from "@/lib/work/models";
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
import { ScheduleArmingCard } from "@/components/work/schedules/arming-card";
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

/**
 * What a Code routine works in, as the form holds it.
 *
 * `repo` is one field and not two, because "owner/name" is how a repository is
 * written everywhere else a person meets one — in a clone URL, in a pull request
 * title, in the address bar — and a form that splits it is a form people paste
 * the wrong half into.
 */
interface CodeDraft {
  repo: string;
  baseRef: string;
  environmentId: string;
  permissionMode: CodePermissionMode;
}

/**
 * Splits "owner/name", or says it is not one yet.
 *
 * Refused rather than repaired: a repository is the one field of a Code routine
 * with no honest default, and guessing at half of one would produce a routine
 * that clones something nobody named.
 */
function splitRepo(value: string): { owner: string; name: string } | null {
  const [owner, name, ...rest] = value.trim().replace(/^https:\/\/github\.com\//, "").split("/");
  if (rest.length > 0 || !owner || !name) return null;
  // `.git` is what a clone URL carries and what a paste therefore carries too.
  const cleaned = name.replace(/\.git$/, "");
  return cleaned ? { owner, name: cleaned } : null;
}

/** A draft of everything the form holds, before it becomes a request. */
interface ScheduleDraft {
  name: string;
  instructions: string;
  timezone: string;
  /** What one fire produces. Fixed at creation — see `patchScheduleSchema`. */
  runKind: "work" | "code";
  code: CodeDraft;
  target: "cloud" | "local" | "automatic";
  hostId: string | null;
  enabled: boolean;
  triggers: WorkTriggerDraft[];
  unattendedPolicy: WorkUnattendedPolicy;
  hostOfflinePolicy: WorkHostOfflinePolicy;
  missedRunPolicy: WorkMissedRunPolicy;
  notifyPolicy: WorkNotifyPolicy;
  maxConcurrentRuns: number;
  /**
   * Per-run ceilings, as the reader types them: dollars, tokens and minutes.
   * Empty means "whatever my plan allows" — the dispatchers merge zeros with
   * `runBudgetForPlan`, so an empty field is the honest default, not
   * "unlimited".
   */
  budget: { costUsd: string; tokens: string; minutes: string };
  /** The model every fire runs on. Empty means the task's own. */
  model: string;
}

function oneOf<T extends string>(options: readonly T[], value: string, fallback: T): T {
  return (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * This account's ceilings in the units the fields take, for placeholders and
 * caps.
 *
 * Read from the plan, because a schedule may only ever LOWER a ceiling: a
 * placeholder or a cap showing PRO's twenty minutes to a trial account would
 * invite a number the dispatcher then silently narrows to ten, and the reader
 * would have no way to tell that from a bug.
 */
function standardCeiling(plan: Plan) {
  const budget = runBudgetForPlan(plan);
  return {
    costUsd: budget.maxCostMicroUsd / 1_000_000,
    tokens: budget.maxTokens,
    minutes: Math.round(budget.maxRuntimeMs / 60_000),
  };
}

/** A stored ceiling as a field value: zero is "standard", and shows as empty. */
function ceilingField(value: number): string {
  return value > 0 ? String(value) : "";
}

function draftFrom(schedule: ClientWorkSchedule): ScheduleDraft {
  // Read through the server's own parser, so what the form shows is what the
  // dispatcher will act on rather than whatever happens to be in the column.
  // A routine whose configuration this build cannot read opens on the blank
  // one, and the save then refuses it by name rather than storing half of it.
  const parsedCode = parseCodeRoutineConfig(schedule.codeConfig);
  const runKind = schedule.runKind === "code" ? "code" : "work";
  return {
    budget: {
      costUsd: ceilingField(schedule.budget.maxCostMicroUsd / 1_000_000),
      tokens: ceilingField(schedule.budget.maxTokens),
      minutes: ceilingField(schedule.budget.maxRuntimeMs / 60_000),
    },
    model:
      (runKind === "code"
        ? parsedCode.ok
          ? parsedCode.config.model
          : null
        : parseScheduleRunConfig(schedule.runConfig).model) ?? "",
    runKind,
    code: parsedCode.ok
      ? {
          repo: `${parsedCode.config.repo.owner}/${parsedCode.config.repo.name}`,
          baseRef: parsedCode.config.baseRef ?? "",
          environmentId: parsedCode.config.environmentId ?? "",
          permissionMode: parsedCode.config.permissionMode ?? DEFAULT_CLOUD_PERMISSION_MODE,
        }
      : blankCode(),
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
function blankCode(): CodeDraft {
  return {
    repo: "",
    baseRef: "",
    environmentId: "",
    // `full`, which is what every cloud run had before the column existed and
    // what runner-context still resolves a null to. Opening on anything
    // narrower would silently make a routine ask for approvals nobody is there
    // to give — the run would checkpoint on its first edit and sit.
    permissionMode: DEFAULT_CLOUD_PERMISSION_MODE,
  };
}

function blankDraft(): ScheduleDraft {
  return {
    name: "",
    instructions: "",
    timezone: "",
    runKind: "work",
    code: blankCode(),
    target: "automatic",
    hostId: null,
    enabled: true,
    triggers: [newTrigger("daily", new Date())],
    unattendedPolicy: "pause_for_approval",
    hostOfflinePolicy: "skip",
    missedRunPolicy: "run_once",
    notifyPolicy: "on_attention",
    maxConcurrentRuns: 1,
    budget: { costUsd: "", tokens: "", minutes: "" },
    model: "",
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
  // The account's own ceilings, which the fields below can only lower.
  const { quota } = useApp();
  const ceiling = standardCeiling(quota.plan);

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
  // Checked against this account's own ceilings, not merely against zero. The
  // `max` attributes below are advisory — a browser flags the overflow and
  // still reports the value — so without this the form saved a figure the
  // dispatcher then narrowed, which is the outcome the placeholders exist to
  // prevent.
  const budget = {
    costUsd: ceilingFieldValue(draft.budget.costUsd, ceiling.costUsd),
    tokens: ceilingFieldValue(draft.budget.tokens, ceiling.tokens),
    minutes: ceilingFieldValue(draft.budget.minutes, ceiling.minutes),
  };
  const budgetValid = budget.costUsd !== null && budget.tokens !== null && budget.minutes !== null;
  // The other rule the form can check before the server does, and the one that
  // matters most for a Code routine: a repository is the single field with no
  // honest default, so a routine saved without one would be a routine that
  // fails every morning with an error only the log ever sees.
  const isCode = draft.runKind === "code";
  const repo = isCode ? splitRepo(draft.code.repo) : null;
  const canSave =
    draft.name.trim().length > 0 &&
    draft.instructions.trim().length > 0 &&
    draft.timezone.trim().length > 0 &&
    draft.triggers.length > 0 &&
    (!isCode || repo !== null) &&
    !missingHost &&
    budgetValid &&
    !saving;

  const save = React.useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setRefusal(null);

    const code = draft.runKind === "code" ? splitRepo(draft.code.repo) : null;
    const input: WorkScheduleInput = {
      name: draft.name.trim(),
      instructions: draft.instructions.trim(),
      timezone: draft.timezone.trim(),
      // Sent on a create and on an edit alike. The PATCH route ignores the kind
      // — a routine cannot change it — and refuses a `code` block that does not
      // belong to the routine's own kind, which is the check that catches a
      // client sending the wrong half of this form.
      ...(schedule === null ? { runKind: draft.runKind } : {}),
      ...(code
        ? {
            code: {
              repo: code,
              baseRef: draft.code.baseRef.trim() || null,
              environmentId: draft.code.environmentId || null,
              permissionMode: draft.code.permissionMode,
              // The routine's model lives here for a Code routine and in
              // `runConfig` for a Work one, because the two dispatchers read
              // two different columns. One field on the form, two homes.
              model: draft.model === "" ? null : draft.model,
              reasoningEffort: null,
            },
          }
        : {}),
      // A Code routine is always cloud — the create route refuses anything else
      // — and sending its `target` from the segmented control the form hides
      // for one would depend on a default nobody chose.
      target: draft.runKind === "code" ? "cloud" : draft.target,
      // Cleared rather than left dangling when the target moves off a Mac: a
      // cloud schedule still carrying a host id is a row two readers disagree
      // about, and the PATCH route reads an explicit null as "unpin it".
      hostId: draft.runKind === "code" || draft.target === "cloud" ? null : draft.hostId,
      enabled: draft.enabled,
      triggers: draft.triggers,
      unattendedPolicy: draft.unattendedPolicy,
      hostOfflinePolicy: draft.hostOfflinePolicy,
      missedRunPolicy: draft.missedRunPolicy,
      notifyPolicy: draft.notifyPolicy,
      maxConcurrentRuns: draft.maxConcurrentRuns,
      // Whole units on the wire, in the units the columns hold. An empty field
      // is zero, which every dispatcher reads as "the standard ceiling".
      budget: {
        maxCostMicroUsd: Math.round((budget.costUsd ?? 0) * 1_000_000),
        maxTokens: Math.round(budget.tokens ?? 0),
        maxRuntimeMs: Math.round((budget.minutes ?? 0) * 60_000),
      },
      // Null clears an override; the route reads absent as "leave it", so the
      // empty choice has to be sent as null rather than dropped. A Code
      // routine's model went into its `code` block above, so this stays null
      // for one rather than writing the same id into two columns that two
      // different dispatchers read.
      model: draft.runKind === "code" || draft.model === "" ? null : draft.model,
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
  }, [canSave, draft, budget.costUsd, budget.tokens, budget.minutes, schedule, onSaved]);

  return (
    <div className="space-y-7">
      {/*
        What one fire produces, and the first question because it decides which
        of the two forms below applies. Only on a create: a routine's history is
        made of one kind of row — Work runs against one accumulating session, or
        a Code session per fire — and the PATCH route refuses to change it, so
        offering the switch on an edit would be offering a save that 400s.
      */}
      {schedule === null ? (
        <section>
          <h2 className="mb-2.5 font-mono text-label text-muted-foreground">What it runs</h2>
          <SegmentedControl
            value={draft.runKind}
            onChange={(runKind) => set("runKind", runKind)}
            options={[
              { value: "work", label: "A task" },
              { value: "code", label: "Code" },
            ]}
            ariaLabel="What this automation runs"
            optionClassName="px-3 py-1 text-ui"
            className="max-w-xs"
          />
          <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
            {isCode
              ? "Each run clones a repository on a cloud runner, works, and opens a pull request — a Code session of its own you can read and review."
              : "Each run adds to one task and one transcript, so what it learns carries from one run to the next."}
          </p>
        </section>
      ) : (
        isCode && (
          <p className="text-caption leading-relaxed text-muted-foreground">
            A Code automation. Each run is a Code session of its own, with its own branch and pull
            request.
          </p>
        )
      )}

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
            placeholder={
              isCode
                ? "Describe the change and how you would know it worked, the way you would to somebody picking up the repository cold."
                : "Describe the errand and what “done” looks like, the way you would to a person picking it up cold."
            }
            rows={4}
            disabled={saving}
            className="mt-1"
          />
          <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
            Every run starts from this text and nothing else, so it has to stand on its own — nobody
            is there to answer a follow-up at seven in the morning.
          </p>
        </div>
      </section>

      {isCode && (
        <CodeRoutineFields
          draft={draft.code}
          repo={repo}
          disabled={saving}
          onChange={(code) => set("code", code)}
        />
      )}

      <section>
        <h2 className="mb-2.5 font-mono text-label text-muted-foreground">When it runs</h2>
        <TriggerListEditor
          triggers={draft.triggers}
          onChange={(triggers) => set("triggers", triggers)}
          grants={grants}
          runKind={draft.runKind}
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
          <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
            An IANA name. Every time above is read in this zone, which is what makes 09:00 stay 09:00
            across a daylight-saving change.
          </p>
        </div>
      </section>

      {/* Where a WORK routine runs. A Code routine has one answer — a cloud
          runner with the repository checked out — so the control is absent
          rather than present-and-locked: a segmented control showing three
          choices with two of them impossible is a question the reader is
          invited to answer wrongly. */}
      {!isCode && (
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
          optionClassName="px-3 py-1 text-ui"
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
              className="field-well mt-1 h-9 w-full max-w-xs rounded-field border border-input px-3.5 text-ui transition-[color,border-color,box-shadow] duration-base ease-out-soft coarse:h-11 hover:border-input/80 focus-visible:border-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
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
              <p className="mt-1 text-caption leading-relaxed text-warning-foreground">
                A schedule pinned to a Mac has to say which one. Left open, a 07:00 fire would land
                on whichever machine happened to be awake.
              </p>
            )}
            {named !== null && !hostIsReachable(named) && (
              <p className="mt-1 text-caption leading-relaxed text-warning-foreground">
                {named.displayName} is not reachable right now. The schedule can still be saved —
                what happens at the next fire is the offline policy below.
              </p>
            )}
            {hosts !== null && reachable.length === 0 && draft.target === "local" && (
              <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
                None of your Macs are checking in at the moment.
              </p>
            )}
          </div>
        )}
      </section>
      )}

      {/*
        What each run may spend, and on what.
        These three fields existed on the wire — `budget`, `model` and
        `maxConcurrentRuns` on both schedule routes — and the editor sent
        defaults for all of them: zeros for the budget, nothing for the model,
        one for concurrency. Zero on a budget column means "no ceiling of the
        schedule's own"; the dispatchers now merge it with the account's plan
        ceiling, so an empty field here is that ceiling, and a number is a
        LOWER one. The placeholders say what the plan allows so the reader is
        never asked to lower a ceiling they were not told.
      */}
      <section>
        <h2 className="mb-2.5 font-mono text-label text-muted-foreground">
          {isCode ? "What each run uses" : "What each run may spend"}
        </h2>
        {/*
          The three ceilings are stamped onto a `WorkRun` at dispatch and
          enforced by the Work executor per token. A Code run is a GitHub
          Actions job whose spend goes through `/api/agent` against the
          account's own budget, and it reads none of these columns — so for a
          Code routine the fields are ABSENT rather than present and ignored.
          A cost ceiling that binds nothing is the clearest possible example of
          a control implying something the runtime cannot do.
        */}
        {!isCode && (
        <>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="schedule-budget-cost">Cost, in US dollars</Label>
            {/* A cent, not a quarter. FREE's whole run ceiling is $0.15, so
                every quarter-step above zero was above the max as well, and a
                trial account's cost field could hold nothing but empty. */}
            <Input
              id="schedule-budget-cost"
              type="number"
              inputMode="decimal"
              min={0}
              max={ceiling.costUsd}
              step="0.01"
              value={draft.budget.costUsd}
              onChange={(event) => set("budget", { ...draft.budget, costUsd: event.target.value })}
              placeholder={String(ceiling.costUsd)}
              disabled={saving}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="schedule-budget-tokens">Tokens</Label>
            <Input
              id="schedule-budget-tokens"
              type="number"
              inputMode="numeric"
              min={0}
              max={ceiling.tokens}
              step={10_000}
              value={draft.budget.tokens}
              onChange={(event) => set("budget", { ...draft.budget, tokens: event.target.value })}
              placeholder={String(ceiling.tokens)}
              disabled={saving}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="schedule-budget-minutes">Minutes of work</Label>
            <Input
              id="schedule-budget-minutes"
              type="number"
              inputMode="numeric"
              min={0}
              max={ceiling.minutes}
              step={1}
              value={draft.budget.minutes}
              onChange={(event) => set("budget", { ...draft.budget, minutes: event.target.value })}
              placeholder={String(ceiling.minutes)}
              disabled={saving}
              className="mt-1"
            />
          </div>
        </div>
        <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
          Empty means your plan’s ceiling — ${ceiling.costUsd},{" "}
          {ceiling.tokens.toLocaleString("en-US")} tokens or {ceiling.minutes}{" "}
          minutes of working time, whichever comes first. A number here lowers one of them for this
          schedule; nothing raises them. A run fired while nobody is watching is capped at $
          {Math.min(ceiling.costUsd, 1)} unless you set a lower figure.
        </p>
        {!budgetValid && (
          <p className="mt-1 text-caption leading-relaxed text-warning-foreground">
            Each ceiling has to be left empty, or a number between zero and your plan’s own —
            ${ceiling.costUsd}, {ceiling.tokens.toLocaleString("en-US")} tokens, {ceiling.minutes}{" "}
            minutes.
          </p>
        )}
        </>
        )}
        {isCode && (
          <p className="text-caption leading-relaxed text-muted-foreground">
            A Code run spends against your account’s usage like any other cloud session, and stops
            when that is spent. It carries no ceiling of its own.
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="schedule-model">Model</Label>
            {/* The same `field-well` recipe as the Mac select above, for the
                same reason. Only the models an agent runtime can drive, which
                is one line — `backendAgentCatalog` draws it for the Code runner
                and `isWorkCapableModel` is that same line stated once — so one
                control serves both kinds. The empty choice is the runtime's own
                choice, which is what every routine ran on before this field
                existed.

                Where the answer is STORED differs: a Work routine's model lives
                in `runConfig` and a Code routine's in its `codeConfig`, because
                two dispatchers read two columns. The save routes it; the reader
                answers one question once. */}
            <select
              id="schedule-model"
              value={draft.model}
              disabled={saving}
              onChange={(event) => set("model", event.target.value)}
              className="field-well mt-1 h-9 w-full rounded-field border border-input px-3.5 text-ui transition-[color,border-color,box-shadow] duration-base ease-out-soft coarse:h-11 hover:border-input/80 focus-visible:border-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">
                {isCode ? "Whatever the runner picks" : "The task’s own model"}
              </option>
              {MODEL_LIST.filter(isWorkCapableModel).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="schedule-concurrency">Runs at once</Label>
            <Input
              id="schedule-concurrency"
              type="number"
              inputMode="numeric"
              min={1}
              max={5}
              step={1}
              value={draft.maxConcurrentRuns}
              onChange={(event) => {
                const next = Math.floor(Number(event.target.value));
                if (Number.isFinite(next) && next >= 1 && next <= 5) set("maxConcurrentRuns", next);
              }}
              disabled={saving}
              className="mt-1"
            />
            <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
              How many of this schedule’s runs may be under way together. One is right for anything
              that writes a file; a fire that lands while the last is still going waits.
            </p>
          </div>
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="font-mono text-label text-muted-foreground">When nobody is watching</h2>
        {/* The three unattended policies are enforced by the Work executor,
            action by action, through `decideUnattendedAction`. The cloud Code
            runner enforces the permission mode above instead — a different
            mechanism answering the same question for a different runtime — so
            showing both to a Code routine would be two controls over one
            behaviour, one of which does nothing. */}
        {!isCode && (
          <PolicyGroup
            label="Something it cannot undo"
            options={UNATTENDED_OPTIONS}
            value={draft.unattendedPolicy}
            disabled={saving}
            onChange={(value) => set("unattendedPolicy", value)}
          />
        )}
        {/* Absent for a Code routine, which never waits on a Mac: the three
            options all answer "what should happen when the machine you chose is
            asleep", and a cloud runner is not a machine anybody chose. */}
        {!isCode && (
          <PolicyGroup
            label="The Mac is not there"
            options={HOST_OFFLINE_OPTIONS}
            value={draft.hostOfflinePolicy}
            disabled={saving}
            onChange={(value) => set("hostOfflinePolicy", value)}
          />
        )}
        <PolicyGroup
          label="Fires that were missed"
          options={MISSED_RUN_OPTIONS}
          value={draft.missedRunPolicy}
          disabled={saving}
          onChange={(value) => set("missedRunPolicy", value)}
        />
        {/* The four notification options are read by the Work run notifier
            (src/lib/work/notifications.ts), which watches `WorkRun` events. A
            Code run produces none of those: it appears in the sidebar as a Code
            session with a status dot, which is how every other Code run reports
            itself. An email preference that nothing sends email for is the same
            defect as a ceiling that binds nothing. */}
        {!isCode ? (
          <>
            <PolicyGroup
              label="Tell me"
              options={NOTIFY_OPTIONS}
              value={draft.notifyPolicy}
              disabled={saving}
              onChange={(value) => set("notifyPolicy", value)}
            />
            <p className="text-caption leading-relaxed text-muted-foreground">
              These arrive by email, at the address on your account, once per thing worth saying — a
              run that finishes while a retry is still in flight does not write twice.
            </p>
          </>
        ) : (
          <p className="text-caption leading-relaxed text-muted-foreground">
            Each run appears in the sidebar as its own Code session, with the status mark every Code
            session has — including the one that stopped to ask you something.
          </p>
        )}
      </section>

      {/*
        The read-back, immediately above the button that arms it. Built from the
        draft rather than written by hand, so it cannot describe a schedule other
        than the one about to be saved. See `arming-card.tsx` for why it is a
        permanent summary rather than a confirmation dialog.
      */}
      <ScheduleArmingCard
        triggers={draft.triggers}
        runKind={draft.runKind}
        code={{ repo, baseRef: draft.code.baseRef, permissionMode: draft.code.permissionMode }}
        target={draft.target}
        hostId={draft.hostId}
        hosts={hosts}
        timezone={draft.timezone}
        instructions={draft.instructions}
        unattendedPolicy={draft.unattendedPolicy}
        hostOfflinePolicy={draft.hostOfflinePolicy}
        enabled={draft.enabled}
      />

      {refusal !== null && <WorkStateNote tone="error">{refusal}</WorkStateNote>}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void save()} disabled={!canSave} className="gap-1.5">
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {schedule === null ? "Create schedule" : "Save changes"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** The environments a Code routine may run in, as the list route serves them. */
interface EnvironmentOption {
  id: string;
  name: string;
}

/**
 * What a Code routine clones, and what the runner may do with it.
 *
 * Four fields, and every one of them is read by the cloud runner: the
 * repository and the branch reach `git clone`, the environment decides egress,
 * variables and the setup step, and the permission mode decides what the agent
 * may do before it would have to ask. Nothing here is stored and ignored, which
 * is the rule this whole editor is written to — the Work-only controls that a
 * Code run does not read are absent from the form rather than present and inert.
 *
 * The model is deliberately NOT here: it is the same field a Work routine has,
 * one section down, and duplicating it would be two controls over one decision.
 * The save routes it into whichever column this routine's dispatcher reads.
 */
function CodeRoutineFields({
  draft,
  repo,
  disabled,
  onChange,
}: {
  draft: CodeDraft;
  /** The parsed repository, or null while what is typed is not one yet. */
  repo: { owner: string; name: string } | null;
  disabled: boolean;
  onChange: (draft: CodeDraft) => void;
}) {
  const [environments, setEnvironments] = React.useState<EnvironmentOption[] | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void fetch("/api/code/environments", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { environments?: EnvironmentOption[] } | null) => {
        if (!cancelled) setEnvironments(data?.environments ?? []);
      })
      // A failed load leaves the list null, which renders as the built-in
      // shape and nothing else. It is NOT rendered as an empty list: "you have
      // no environments" and "we could not ask" are different statements, and
      // the second must not delete a choice the reader already made.
      .catch(() => {
        if (!cancelled) setEnvironments(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = (patch: Partial<CodeDraft>) => onChange({ ...draft, ...patch });
  const named = draft.environmentId
    ? (environments ?? []).find((entry) => entry.id === draft.environmentId)
    : undefined;

  return (
    <section>
      <h2 className="mb-2.5 font-mono text-label text-muted-foreground">What it works in</h2>
      {/* `@md:` and not `md:`: this form sits inside the app shell, so the
          window's width is not this column's width (PREMIUM_AUDIT.md rule 11). */}
      <div className="@container">
        <div className="grid gap-3 @md:grid-cols-2">
          <div>
            <Label htmlFor="routine-repo">Repository</Label>
            <Input
              id="routine-repo"
              value={draft.repo}
              onChange={(event) => set({ repo: event.target.value })}
              placeholder="owner/repository"
              disabled={disabled}
              className="mt-1"
            />
            {draft.repo.trim().length > 0 && repo === null && (
              <p className="mt-1 text-caption leading-relaxed text-warning-foreground">
                Write it as owner/repository — the two halves of the address, or the clone URL
                pasted whole.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="routine-base">Branch it starts from</Label>
            <Input
              id="routine-base"
              value={draft.baseRef}
              onChange={(event) => set({ baseRef: event.target.value })}
              placeholder="The repository’s default"
              disabled={disabled}
              className="mt-1"
            />
            <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
              Every run branches from here and opens its own pull request. One run never builds on
              the last, so a Tuesday cannot depend on a Monday nobody reviewed.
            </p>
          </div>
        </div>

        <div className="mt-3 grid gap-3 @md:grid-cols-2">
          <div>
            <Label htmlFor="routine-environment">Environment</Label>
            {/* The `field-well` recipe the Mac and model selects use, for the
                reason stated at those call sites: one form, one fill. */}
            <select
              id="routine-environment"
              value={draft.environmentId}
              disabled={disabled || environments === null}
              onChange={(event) => set({ environmentId: event.target.value })}
              className="field-well mt-1 h-9 w-full rounded-field border border-input px-3.5 text-ui transition-[color,border-color,box-shadow] duration-base ease-out-soft coarse:h-11 hover:border-input/80 focus-visible:border-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <option value="">No environment</option>
              {/* The stored one, even when the list could not be read or no
                  longer holds it. Dropping it would silently reset a choice the
                  reader made, and the save would then write that reset. */}
              {draft.environmentId && !named && (
                <option value={draft.environmentId}>The one this automation already uses</option>
              )}
              {(environments ?? []).map((environment) => (
                <option key={environment.id} value={environment.id}>
                  {environment.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
              No environment is the built-in shape: no network for the agent’s own commands, no
              variables, and no setup step before the first turn.
            </p>
          </div>
          <div>
            <Label htmlFor="routine-permission">How far it may go on its own</Label>
            <div className="mt-1">
              <SegmentedControl
                value={draft.permissionMode}
                onChange={(permissionMode) => set({ permissionMode })}
                options={PERMISSION_OPTIONS}
                ariaLabel="How far a run may go on its own"
                optionClassName="px-3 py-1 text-ui"
              />
            </div>
            <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
              {PERMISSION_HINTS[draft.permissionMode]}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The three cloud permission modes, in the runner's own vocabulary.
 *
 * Read from `CODE_PERMISSION_MODES` rather than listed, so a mode added to the
 * engine cannot be missing here — the labels are a lookup, and a mode with no
 * label falls back to its own id rather than disappearing from the control.
 */
const PERMISSION_LABELS: Record<string, string> = {
  plan: "Plan only",
  "auto-edit": "Accept edits",
  full: "Auto",
};

const PERMISSION_HINTS: Record<string, string> = {
  plan: "It works out what it would do and stops. Nothing is written, so nothing is pushed.",
  "auto-edit": "It edits files without asking. Anything else it cannot decide is refused, because nobody is there to ask.",
  full: "It decides for itself, which is what every cloud run did before this control existed.",
};

const PERMISSION_OPTIONS = CODE_PERMISSION_MODES.map((mode) => ({
  value: mode,
  label: PERMISSION_LABELS[mode] ?? mode,
}));

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
              className="mt-1 size-3.5 shrink-0 accent-primary"
            />
            <span className="min-w-0">
              <span className="block text-ui font-medium text-foreground">{option.label}</span>
              <span className="mt-0.5 block text-caption leading-relaxed text-muted-foreground">
                {option.hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
