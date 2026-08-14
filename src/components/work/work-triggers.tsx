"use client";

import * as React from "react";
import { Clock, Plus, Radio, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { WORK_TRIGGER_KINDS, type WorkTriggerKind } from "@/lib/work/domain";
import { TIME_TRIGGER_KINDS, isTimeTriggerKind } from "@/lib/work/schedule";
import {
  TRIGGER_KIND_LIMITS,
  TRIGGER_OPTION_LIMITS,
  isEventTriggerKind,
  type EventTriggerKind,
} from "@/lib/work/triggers";
import type { ClientWorkGrant } from "@/lib/work/serializers";
import type { WorkTriggerDraft } from "@/components/work/work-transport";
import { cn } from "@/lib/utils";

/*
 * What starts a schedule, in a form.
 *
 * There are fourteen trigger kinds and this covers all fourteen, because the
 * ones left out of an editor are the ones nobody can create — a schedule that
 * fires on an email arriving has been storable since the tables were written and
 * has never once been creatable from a browser.
 *
 * The split down the middle is the server's, not a presentational one:
 * `TIME_TRIGGER_KINDS` in schedule.ts fire on a clock and are the only kinds
 * that contribute to `nextRunAt`, and the rest fire on something happening and
 * are matched by `evaluateTrigger` in triggers.ts. The two lists are imported
 * rather than restated, so a kind added on either side turns up here without
 * anyone having to remember this file.
 *
 * Every config below is stored in the shape the server's parser produces, not
 * the shape a form finds convenient. `normalizeTriggerDrafts` re-parses whatever
 * arrives and stores its own output, so a field this editor gets wrong is not a
 * validation message — it is a schedule that saves without complaint and then
 * never fires. Numbers are numbers here for exactly that reason: `{ hour: "9" }`
 * is refused by `parseTimeTrigger` with "this trigger needs an hour, 0 to 23".
 *
 * COVERING ALL FOURTEEN IS NOT THE SAME AS OFFERING ALL FOURTEEN
 *
 * Three event kinds have no producer in this build and two more have options
 * their source cannot answer, and both facts are read from the server's own
 * tables — `TRIGGER_KIND_LIMITS` and `TRIGGER_OPTION_LIMITS` in triggers.ts —
 * rather than restated here. That import is the point of the arrangement: the
 * poller refuses the same rows for the same reasons, `normalizeTriggerDrafts`
 * refuses to store them, and this file cannot drift into offering a control the
 * other two have already decided will never do anything. The sentence a reader
 * sees at the field is the sentence the server would have refused them with.
 *
 * A limited kind is still rendered when a schedule already holds one, because a
 * row stored by an older build has to be visible to be removed. What it is not
 * given is its form: a folder picker on a trigger nothing will ever fire is the
 * exact control this whole arrangement exists to stop.
 */

interface TriggerMeta {
  label: string;
  /** What this kind does, in the sentence a picker can show under its name. */
  hint: string;
}

const TRIGGER_META: Record<WorkTriggerKind, TriggerMeta> = {
  once: { label: "Once", hint: "One date and time, then never again." },
  hourly: { label: "Hourly", hint: "Every hour, at the minute you choose." },
  daily: { label: "Daily", hint: "Every day at one time." },
  weekdays: { label: "Weekdays", hint: "Monday to Friday at one time." },
  weekly: { label: "Weekly", hint: "One day of the week, at one time." },
  monthly: { label: "Monthly", hint: "One day of the month. The 31st means the last day of a short one." },
  yearly: { label: "Yearly", hint: "One date each year." },
  cron: { label: "Cron", hint: "A five-field crontab line, for anything the others cannot say." },
  email_filter: { label: "An email arrives", hint: "Matched on sender, subject, labels and attachments." },
  calendar_window: { label: "A meeting is coming up", hint: "Fires a set number of minutes before it starts." },
  topic_monitor: { label: "A topic is mentioned", hint: "Fires when enough sources mention your terms." },
  connector_event: { label: "A connected app sends an event", hint: "Named connector, named events." },
  folder_change: { label: "A folder changes", hint: "Watches a folder you granted on one of your Macs." },
  manual: { label: "Only when you press Run", hint: "Nothing starts this on its own." },
};

export function triggerLabel(kind: string): string {
  return kind in TRIGGER_META ? TRIGGER_META[kind as WorkTriggerKind].label : kind;
}

const EVENT_TRIGGER_KINDS = WORK_TRIGGER_KINDS.filter((kind) => !isTimeTriggerKind(kind));

/**
 * Why this build cannot fire a kind at all, or null when it can.
 *
 * A plain string is checked rather than the kind being tested against a list of
 * supported ones, so a kind that gains a producer needs no edit here: the entry
 * leaves `TRIGGER_KIND_LIMITS`, this returns null, and the control appears.
 */
function kindLimit(kind: string): string | null {
  return isEventTriggerKind(kind) ? (TRIGGER_KIND_LIMITS[kind] ?? null) : null;
}

/** Why one option of a servable kind cannot be honoured, or null. */
function optionLimit(kind: EventTriggerKind, field: string): string | null {
  return TRIGGER_OPTION_LIMITS[kind]?.find((limit) => limit.field === field)?.message ?? null;
}

// ---------------------------------------------------------------------------
// Reading and writing an untyped config
// ---------------------------------------------------------------------------

type Config = Record<string, unknown>;

function intAt(config: Config, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringAt(config: Config, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function boolAt(config: Config, key: string): boolean {
  return config[key] === true;
}

/**
 * A list field as one line of comma-separated text, and back.
 *
 * The server lower-cases and trims every entry itself (`stringList` in
 * triggers.ts), so this deliberately does neither: repeating the normalisation
 * here would show the reader their own typing rewritten as they left the field,
 * and the two copies would drift the first time one side changed.
 */
function listAt(config: Config, key: string): string {
  const value = config[key];
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join(", ") : "";
}

function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The starting configuration for a kind the reader has just picked.
 *
 * Real defaults rather than empty objects: a `daily` with no hour is refused by
 * the server, and an editor that opens on a refusal teaches the reader that the
 * form is broken. Nine in the morning is the hour a scheduled errand is
 * overwhelmingly for.
 */
export function defaultTriggerConfig(kind: WorkTriggerKind, now: Date): Config {
  switch (kind) {
    case "once":
      return {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: 9,
        minute: 0,
      };
    case "hourly":
      return { minute: 0 };
    case "daily":
    case "weekdays":
      return { hour: 9, minute: 0 };
    case "weekly":
      return { weekday: 1, hour: 9, minute: 0 };
    case "monthly":
      return { monthday: 1, hour: 9, minute: 0 };
    case "yearly":
      return { month: 1, monthday: 1, hour: 9, minute: 0 };
    case "cron":
      return { expression: "0 9 * * 1-5" };
    case "email_filter":
      return {
        from: [],
        excludeFrom: [],
        subjectContains: [],
        excludeSubjectContains: [],
        labels: [],
        requireAttachment: false,
      };
    case "calendar_window":
      return {
        leadMinutes: 10,
        calendarIds: [],
        titleContains: [],
        minDurationMinutes: 0,
        requireAttendees: false,
      };
    case "topic_monitor":
      return { terms: [], requireAll: false, minSources: 1 };
    case "connector_event":
      return { connector: "", events: [], attributes: {} };
    case "folder_change":
      return { grantId: "", suffixes: [], minChangedFiles: 1 };
    case "manual":
      return {};
  }
}

export function newTrigger(kind: WorkTriggerKind, now: Date): WorkTriggerDraft {
  return { kind, config: defaultTriggerConfig(kind, now), enabled: true };
}

// ---------------------------------------------------------------------------
// Saying what a trigger does
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function clock(config: Config): string {
  const hour = intAt(config, "hour", 0);
  const minute = intAt(config, "minute", 0);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * One trigger as a sentence, for a list that has no room for a form.
 *
 * Written from the stored config rather than from a label the editor kept
 * alongside it, so a schedule created on the Mac reads here exactly as it
 * behaves — including one whose config this build cannot make sense of, which
 * falls back to naming the kind rather than inventing a time.
 */
export function describeTrigger(trigger: { kind: string; config: unknown }): string {
  const config: Config =
    trigger.config !== null && typeof trigger.config === "object" && !Array.isArray(trigger.config)
      ? (trigger.config as Config)
      : {};

  switch (trigger.kind) {
    case "once": {
      const month = MONTH_NAMES[intAt(config, "month", 1) - 1] ?? "";
      return `Once, on ${intAt(config, "day", 1)} ${month} ${intAt(config, "year", 0)} at ${clock(config)}`;
    }
    case "hourly":
      return `Every hour at ${String(intAt(config, "minute", 0)).padStart(2, "0")} past`;
    case "daily":
      return `Every day at ${clock(config)}`;
    case "weekdays":
      return `Every weekday at ${clock(config)}`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[intAt(config, "weekday", 0)] ?? "week"} at ${clock(config)}`;
    case "monthly":
      return `On day ${intAt(config, "monthday", 1)} of each month at ${clock(config)}`;
    case "yearly":
      return `Every ${intAt(config, "monthday", 1)} ${MONTH_NAMES[intAt(config, "month", 1) - 1] ?? ""} at ${clock(config)}`;
    case "cron":
      return `Cron: ${stringAt(config, "expression") || "not set"}`;
    case "email_filter": {
      const from = listAt(config, "from");
      return from ? `When an email arrives from ${from}` : "When any email arrives";
    }
    case "calendar_window":
      return `${intAt(config, "leadMinutes", 10)} minutes before a meeting starts`;
    case "topic_monitor": {
      const terms = listAt(config, "terms");
      return terms ? `When sources mention ${terms}` : "When a topic is mentioned";
    }
    case "connector_event": {
      const connector = stringAt(config, "connector");
      return connector ? `When ${connector} sends an event` : "When a connected app sends an event";
    }
    case "folder_change":
      return "When a granted folder changes";
    case "manual":
      return "Only when you press Run now";
    default:
      // A kind written by a newer deployment. Naming it is more useful than
      // pretending to read a config this build has no parser for.
      return trigger.kind;
  }
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export function TriggerListEditor({
  triggers,
  onChange,
  /** The Mac a folder trigger would watch, so its grants can be offered by name. */
  grants,
  disabled,
}: {
  triggers: readonly WorkTriggerDraft[];
  onChange: (triggers: WorkTriggerDraft[]) => void;
  grants: readonly ClientWorkGrant[] | null;
  disabled: boolean;
}) {
  const replace = (index: number, next: WorkTriggerDraft) => {
    onChange(triggers.map((trigger, position) => (position === index ? next : trigger)));
  };

  return (
    <div className="space-y-2.5">
      {triggers.map((trigger, index) => (
        <div
          key={`${trigger.kind}-${index}`}
          className="rounded-field border border-border/60 bg-card px-3.5 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            {isTimeTriggerKind(trigger.kind) ? (
              <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            ) : (
              <Radio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
              {triggerLabel(trigger.kind)}
            </span>
            <label className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-micro text-muted-foreground">
                {trigger.enabled ? "On" : "Off"}
              </span>
              <Switch
                checked={trigger.enabled}
                disabled={disabled}
                onCheckedChange={(enabled) => replace(index, { ...trigger, enabled })}
                aria-label={`${triggerLabel(trigger.kind)} trigger enabled`}
              />
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled || triggers.length === 1}
              onClick={() => onChange(triggers.filter((_, position) => position !== index))}
              // The last one cannot go: `createScheduleSchema` requires at least
              // one trigger, so an empty list is a save that 400s. Refusing the
              // removal is a clearer answer than accepting it and then failing.
              //
              // The advice changes when the last one is a kind this build cannot
              // fire, because "change this one instead" is then advice the reader
              // cannot follow — there is no form to change. Such a schedule also
              // cannot be saved at all until the trigger goes, so the order of
              // the two steps is the whole of what they need to know.
              title={
                triggers.length !== 1
                  ? "Remove this trigger"
                  : kindLimit(trigger.kind)
                    ? "A schedule needs at least one trigger. Add one that works, then remove this."
                    : "A schedule needs at least one trigger. Change this one instead."
              }
              aria-label="Remove this trigger"
              className="text-muted-foreground/70 hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </Button>
          </div>

          <p className="mt-1 font-mono text-micro text-muted-foreground">
            {describeTrigger(trigger)}
          </p>

          <div className="mt-3">
            <TriggerConfigFields
              trigger={trigger}
              grants={grants}
              disabled={disabled}
              onChange={(config) => replace(index, { ...trigger, config })}
            />
          </div>
        </div>
      ))}

      <AddTriggerMenu
        disabled={disabled}
        onAdd={(kind) => onChange([...triggers, newTrigger(kind, new Date())])}
      />
    </div>
  );
}

function AddTriggerMenu({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (kind: WorkTriggerKind) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add a trigger
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuLabel className="font-mono text-label">On a clock</DropdownMenuLabel>
        {TIME_TRIGGER_KINDS.map((kind) => (
          <DropdownMenuItem key={kind} onSelect={() => onAdd(kind)} className="flex-col items-start gap-0.5">
            <span className="text-ui">{TRIGGER_META[kind].label}</span>
            <span className="text-caption leading-relaxed text-muted-foreground">
              {TRIGGER_META[kind].hint}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-mono text-label">On something happening</DropdownMenuLabel>
        {EVENT_TRIGGER_KINDS.map((kind) => {
          // The kind's own limit replaces its hint rather than joining it. The
          // hint describes what the kind is for, and reading "fires when enough
          // sources mention your terms" directly above "Juno has nowhere to
          // watch for a topic" is how somebody concludes the entry is a bug and
          // goes looking for the setting that turns it on.
          const limit = kindLimit(kind);
          return (
            <DropdownMenuItem
              key={kind}
              disabled={limit !== null}
              onSelect={() => onAdd(kind)}
              className="flex-col items-start gap-0.5"
            >
              <span className="text-ui">{TRIGGER_META[kind].label}</span>
              <span className="text-caption leading-relaxed text-muted-foreground">
                {limit ?? TRIGGER_META[kind].hint}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ─────────────────────────── the field kit ──────────────────────────────── */

/**
 * A labelled field.
 *
 * The label is only bound with `htmlFor` when the child really is a form
 * control. Several of these render a sentence instead — a folder trigger whose
 * Mac has granted nothing has no control to offer — and a `<label for>` pointing
 * at a paragraph is a promise to a screen reader that clicking the label will
 * focus something.
 */
const LABELLABLE = new Set(["input", "select", "textarea"]);

function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const id = React.useId();
  const control =
    React.isValidElement(children) && typeof children.type === "string"
      ? LABELLABLE.has(children.type)
      : React.isValidElement(children);

  return (
    <div className={cn("min-w-0", className)}>
      {control ? (
        <Label htmlFor={id}>{label}</Label>
      ) : (
        // `text-label`, which is what `Label` above resolves to. Both branches
        // draw the same field label and only one of them is bound to a control,
        // so the pair was rendering 12px at 0.10em tracking beside 12px at none
        // — visibly two registers for one role, in one column of fields.
        <p className="font-mono text-label text-muted-foreground">{label}</p>
      )}
      <div className="mt-1">
        {control && React.isValidElement(children)
          ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
          : children}
      </div>
      {hint !== undefined && (
        <p className="mt-1 text-caption leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        // Clamped on the way out rather than on the way in, so a reader typing
        // "19" past a max of 12 is not fighting the field at "1". What leaves
        // this component is always a number the server's parser accepts.
        onChange={(event) => {
          const next = Number(event.target.value);
          if (!Number.isFinite(next)) return;
          onChange(Math.min(max, Math.max(min, Math.round(next))));
        }}
        className="h-9"
      />
    </Field>
  );
}

function TextField({
  label,
  value,
  placeholder,
  hint,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  hint?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <Input
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="h-9"
      />
    </Field>
  );
}

function ChoiceField({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  options: readonly { value: number; label: string }[];
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      {/* A native select rather than the Radix one: this sits inside a form of
          a dozen fields, and a listbox that traps focus for each of them is
          slower to fill in than the control every platform already has.

          NO `bg-*` utility beside `field-well`. Tailwind emits utilities after
          the components layer at equal specificity, so the `bg-secondary` that
          was here beat the class outright — and `.field-well` is precisely where
          the per-theme answer lives (page fill on light, one rung UP on dark,
          because nothing recesses below black). Carrying the utility meant this
          select was secondary on BOTH themes while the `Input` and `Textarea`
          two fields above it were background on light: three controls in one
          form, two fills.

          The ring is the same `ring-2 ring-ring` every other control in Work
          focuses with — a 1px border tint was the only keyboard indicator here,
          which is a focus bug rather than a style choice. `px-3.5` and
          `coarse:h-11` are Input's, for the same reason: a native select and a
          text field in one column that disagree about their gutter and their
          touch height read as two form kits. */}
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="field-well h-9 w-full rounded-field border border-input px-3.5 text-sm transition-[color,border-color,box-shadow] duration-base ease-out-soft coarse:h-11 hover:border-input/80 focus-visible:border-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

function SwitchField({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    // `px-3.5 py-2.5`, the metrics the identical switch row in
    // work-host-settings.tsx uses. One object — a bordered row with a label and
    // a Switch — was drawn at two gutters and two heights in two Work forms.
    <label className="flex items-center justify-between gap-3 rounded-field border border-border/50 px-3.5 py-2.5">
      <span className="min-w-0 text-ui leading-relaxed text-foreground">{label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

/**
 * An option the source cannot answer, said where its control would have been.
 *
 * A disabled control was the other candidate and is worse: a switch that will
 * not move reads as a permission problem, or as something a higher plan unlocks,
 * when the truth is that the reader's mail is fetched by something that never
 * sees an attachment. There is nothing here to switch on, so there is no switch.
 *
 * `asked` is the case that makes this more than a note. A trigger stored before
 * this build knew better can still carry the condition, and `triggerSupport`
 * refuses that trigger — the poller records it and it matches nothing — so
 * without a way to withdraw the condition the reader would be looking at a
 * trigger that cannot work and cannot be fixed.
 */
function UnservableOption({
  label,
  message,
  asked,
  disabled,
  onClear,
}: {
  label: string;
  message: string;
  asked: boolean;
  disabled: boolean;
  onClear: () => void;
}) {
  return (
    // `px-3.5`, the gutter every other bordered block in this editor uses. Three
    // sibling blocks in one trigger card — this, the switch row and the limit
    // note below — were on px-3, px-3 and px-3.5.
    <div className="rounded-field border border-border/50 bg-secondary px-3.5 py-2.5">
      {/* `text-label` — this stands where a `Field`'s label would, and that is
          the register `Field` and `Label` both use. */}
      <p className="font-mono text-label text-muted-foreground">{label}</p>
      <p className="mt-1 text-caption leading-relaxed text-muted-foreground">{message}</p>
      {asked && (
        <>
          <p className="mt-1.5 text-caption leading-relaxed text-warning-foreground">
            This trigger still asks for it, so it will not start a run until the condition is
            removed.
          </p>
          <Button variant="outline" size="sm" disabled={disabled} onClick={onClear} className="mt-2">
            Remove this condition
          </Button>
        </>
      )}
    </div>
  );
}

const WEEKDAY_OPTIONS = WEEKDAY_NAMES.map((label, value) => ({ value, label }));
const MONTH_OPTIONS = MONTH_NAMES.map((label, index) => ({ value: index + 1, label }));

/* ───────────────────────── per-kind configuration ───────────────────────── */

function TriggerConfigFields({
  trigger,
  grants,
  disabled,
  onChange,
}: {
  trigger: WorkTriggerDraft;
  grants: readonly ClientWorkGrant[] | null;
  disabled: boolean;
  onChange: (config: Config) => void;
}) {
  const config = trigger.config;
  const set = (patch: Config) => onChange({ ...config, ...patch });
  const setList = (key: string, raw: string) => set({ [key]: parseList(raw) });

  // Before the switch, so no kind can acquire a form by being added below and
  // forgetting this. A kind with no producer gets its sentence and nothing else:
  // filling in a folder picker, or a list of terms, on a trigger that nothing
  // will ever fire is the precise thing this arrangement exists to stop, and it
  // is worse than an absent control because the reader finishes it and waits.
  //
  // The stored config is left untouched. It is not this editor's to discard, it
  // is what the reader would need if the kind ever gains a producer, and the one
  // action that helps — removing the trigger — is on the row above.
  //
  // The forms for these three kinds are still written out below, unreachable
  // while their entry is in `TRIGGER_KIND_LIMITS` and deliberately kept. The
  // work of adding a producer is in the poller and in that table; the editor
  // then needs no edit at all, which is the property that stops "we shipped the
  // watcher" and "you can configure the watcher" from being two releases apart.
  const limit = kindLimit(trigger.kind);
  if (limit) {
    return (
      <div className="rounded-field border border-warning/40 bg-warning/10 px-3.5 py-2.5">
        <p className="text-ui leading-relaxed text-warning-foreground">{limit}</p>
        <p className="mt-1.5 text-caption leading-relaxed text-muted-foreground">
          The schedule cannot be saved while this trigger is on it. Remove it, and everything else
          you have set up here is kept.
        </p>
      </div>
    );
  }

  switch (trigger.kind) {
    case "manual":
      return (
        <p className="text-ui leading-relaxed text-muted-foreground">
          Nothing to configure. This schedule sits still until you press Run now.
        </p>
      );

    case "once":
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <NumberField
            label="Year"
            value={intAt(config, "year", new Date().getFullYear())}
            min={1970}
            max={9999}
            disabled={disabled}
            onChange={(year) => set({ year })}
          />
          <ChoiceField
            label="Month"
            value={intAt(config, "month", 1)}
            options={MONTH_OPTIONS}
            disabled={disabled}
            onChange={(month) => set({ month })}
          />
          <NumberField
            label="Day"
            value={intAt(config, "day", 1)}
            min={1}
            max={31}
            disabled={disabled}
            hint="A day that does not exist in the month is refused when you save."
            onChange={(day) => set({ day })}
          />
          <NumberField
            label="Hour"
            value={intAt(config, "hour", 9)}
            min={0}
            max={23}
            disabled={disabled}
            onChange={(hour) => set({ hour })}
          />
          <NumberField
            label="Minute"
            value={intAt(config, "minute", 0)}
            min={0}
            max={59}
            disabled={disabled}
            onChange={(minute) => set({ minute })}
          />
        </div>
      );

    case "hourly":
      return (
        <NumberField
          label="Minutes past the hour"
          value={intAt(config, "minute", 0)}
          min={0}
          max={59}
          disabled={disabled}
          onChange={(minute) => set({ minute })}
        />
      );

    case "daily":
    case "weekdays":
      return (
        <div className="grid grid-cols-2 gap-3">
          <NumberField
            label="Hour"
            value={intAt(config, "hour", 9)}
            min={0}
            max={23}
            disabled={disabled}
            onChange={(hour) => set({ hour })}
          />
          <NumberField
            label="Minute"
            value={intAt(config, "minute", 0)}
            min={0}
            max={59}
            disabled={disabled}
            onChange={(minute) => set({ minute })}
          />
        </div>
      );

    case "weekly":
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <ChoiceField
            label="Day"
            value={intAt(config, "weekday", 1)}
            options={WEEKDAY_OPTIONS}
            disabled={disabled}
            onChange={(weekday) => set({ weekday })}
          />
          <NumberField
            label="Hour"
            value={intAt(config, "hour", 9)}
            min={0}
            max={23}
            disabled={disabled}
            onChange={(hour) => set({ hour })}
          />
          <NumberField
            label="Minute"
            value={intAt(config, "minute", 0)}
            min={0}
            max={59}
            disabled={disabled}
            onChange={(minute) => set({ minute })}
          />
        </div>
      );

    case "monthly":
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <NumberField
            label="Day of the month"
            value={intAt(config, "monthday", 1)}
            min={1}
            max={31}
            disabled={disabled}
            hint="31 means the last day of a shorter month, not a month that is skipped."
            onChange={(monthday) => set({ monthday })}
          />
          <NumberField
            label="Hour"
            value={intAt(config, "hour", 9)}
            min={0}
            max={23}
            disabled={disabled}
            onChange={(hour) => set({ hour })}
          />
          <NumberField
            label="Minute"
            value={intAt(config, "minute", 0)}
            min={0}
            max={59}
            disabled={disabled}
            onChange={(minute) => set({ minute })}
          />
        </div>
      );

    case "yearly":
      return (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <ChoiceField
            label="Month"
            value={intAt(config, "month", 1)}
            options={MONTH_OPTIONS}
            disabled={disabled}
            onChange={(month) => set({ month })}
          />
          <NumberField
            label="Day"
            value={intAt(config, "monthday", 1)}
            min={1}
            max={31}
            disabled={disabled}
            onChange={(monthday) => set({ monthday })}
          />
          <NumberField
            label="Hour"
            value={intAt(config, "hour", 9)}
            min={0}
            max={23}
            disabled={disabled}
            onChange={(hour) => set({ hour })}
          />
          <NumberField
            label="Minute"
            value={intAt(config, "minute", 0)}
            min={0}
            max={59}
            disabled={disabled}
            onChange={(minute) => set({ minute })}
          />
        </div>
      );

    case "cron":
      return (
        <TextField
          label="Expression"
          value={stringAt(config, "expression")}
          placeholder="0 9 * * 1-5"
          // The parser's own rules, stated where they are needed rather than
          // discovered from a refusal: it takes five fields, `*`, ranges and
          // steps, and it refuses MON/JAN outright because schedulers disagree
          // about whether SUN is 0 or 7.
          hint="Five fields: minute hour day-of-month month day-of-week. Numbers only — 0 or 7 for Sunday."
          disabled={disabled}
          onChange={(expression) => set({ expression })}
        />
      );

    case "email_filter": {
      // Read once, and each one decides between a control and a sentence rather
      // than being assumed absent. When the mail reader gains labels, the entry
      // leaves `TRIGGER_OPTION_LIMITS`, this reads null, and the field comes
      // back — which is the only way the two stay in step without somebody
      // remembering that this file also has an opinion.
      const labelsLimit = optionLimit("email_filter", "labels");
      const attachmentLimit = optionLimit("email_filter", "requireAttachment");
      return (
        <div className="space-y-3">
          <TextField
            label="From"
            value={listAt(config, "from")}
            placeholder="@stripe.com, invoices@"
            hint="Any one of these matching the sender is enough. Substrings, so a bare domain works. Empty means any sender."
            disabled={disabled}
            onChange={(raw) => setList("from", raw)}
          />
          <TextField
            label="Never from"
            value={listAt(config, "excludeFrom")}
            hint="Checked before anything else. A match here vetoes the trigger."
            disabled={disabled}
            onChange={(raw) => setList("excludeFrom", raw)}
          />
          <TextField
            label="Subject contains"
            value={listAt(config, "subjectContains")}
            hint="Every phrase listed must appear."
            disabled={disabled}
            onChange={(raw) => setList("subjectContains", raw)}
          />
          <TextField
            label="Subject must not contain"
            value={listAt(config, "excludeSubjectContains")}
            hint="Any one of these appearing vetoes the trigger."
            disabled={disabled}
            onChange={(raw) => setList("excludeSubjectContains", raw)}
          />
          {labelsLimit ? (
            <UnservableOption
              label="Labels"
              message={labelsLimit}
              asked={listAt(config, "labels").length > 0}
              disabled={disabled}
              onClear={() => set({ labels: [] })}
            />
          ) : (
            <TextField
              label="Labels"
              value={listAt(config, "labels")}
              hint="Every label listed must be on the message."
              disabled={disabled}
              onChange={(raw) => setList("labels", raw)}
            />
          )}
          {attachmentLimit ? (
            <UnservableOption
              label="Attachments"
              message={attachmentLimit}
              asked={boolAt(config, "requireAttachment")}
              disabled={disabled}
              onClear={() => set({ requireAttachment: false })}
            />
          ) : (
            <SwitchField
              label="Only when the message has an attachment"
              checked={boolAt(config, "requireAttachment")}
              disabled={disabled}
              onChange={(requireAttachment) => set({ requireAttachment })}
            />
          )}
        </div>
      );
    }

    case "calendar_window": {
      const attendeesLimit = optionLimit("calendar_window", "requireAttendees");
      return (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Minutes before it starts"
              value={intAt(config, "leadMinutes", 10)}
              min={0}
              max={24 * 60}
              disabled={disabled}
              onChange={(leadMinutes) => set({ leadMinutes })}
            />
            <NumberField
              label="Shortest meeting (minutes)"
              value={intAt(config, "minDurationMinutes", 0)}
              min={0}
              max={24 * 60}
              disabled={disabled}
              onChange={(minDurationMinutes) => set({ minDurationMinutes })}
            />
          </div>
          <TextField
            label="Title contains"
            value={listAt(config, "titleContains")}
            hint="Any one of these is enough. Empty means any title."
            disabled={disabled}
            onChange={(raw) => setList("titleContains", raw)}
          />
          <TextField
            label="Calendars"
            value={listAt(config, "calendarIds")}
            hint="Empty means every calendar the connector exposes."
            disabled={disabled}
            onChange={(raw) => setList("calendarIds", raw)}
          />
          {attendeesLimit ? (
            <UnservableOption
              label="Attendees"
              message={attendeesLimit}
              asked={boolAt(config, "requireAttendees")}
              disabled={disabled}
              onClear={() => set({ requireAttendees: false })}
            />
          ) : (
            <SwitchField
              label="Skip blocks with no other attendees"
              checked={boolAt(config, "requireAttendees")}
              disabled={disabled}
              onChange={(requireAttendees) => set({ requireAttendees })}
            />
          )}
        </div>
      );
    }

    case "topic_monitor":
      return (
        <div className="space-y-3">
          <TextField
            label="Terms"
            value={listAt(config, "terms")}
            placeholder="acquisition, funding round"
            disabled={disabled}
            onChange={(raw) => setList("terms", raw)}
          />
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Sources needed"
              value={intAt(config, "minSources", 1)}
              min={1}
              max={50}
              disabled={disabled}
              hint="How many independent sources must have mentioned it."
              onChange={(minSources) => set({ minSources })}
            />
            <div className="flex items-end pb-1">
              <SwitchField
                label="Every term, not just one"
                checked={boolAt(config, "requireAll")}
                disabled={disabled}
                onChange={(requireAll) => set({ requireAll })}
              />
            </div>
          </div>
        </div>
      );

    case "connector_event":
      return (
        <div className="space-y-3">
          <TextField
            label="Connector"
            value={stringAt(config, "connector")}
            placeholder="github"
            hint="Required. A connector-event trigger with no connector is refused when you save."
            disabled={disabled}
            onChange={(connector) => set({ connector })}
          />
          <TextField
            label="Events"
            value={listAt(config, "events")}
            placeholder="issue.opened, pull_request.merged"
            hint="Empty means every event that connector sends."
            disabled={disabled}
            onChange={(raw) => setList("events", raw)}
          />
        </div>
      );

    case "folder_change":
      return (
        <div className="space-y-3">
          <Field
            label="Folder"
            hint="Folders are granted on the Mac itself, in the Juno app. This list is what that Mac has given Juno access to."
          >
            {grants === null ? (
              <p className="text-ui leading-relaxed text-muted-foreground">
                Pick the Mac this schedule runs on, above, and its granted folders appear here.
              </p>
            ) : grants.length === 0 ? (
              <p className="text-ui leading-relaxed text-warning-foreground">
                That Mac has not given Juno access to any folder yet, so there is nothing for this
                trigger to watch. Grant one in the Juno app on that Mac.
              </p>
            ) : (
              // Same shape as the interval select above, and for the same
              // reasons: no `bg-*` beside `field-well` (the utility beats the
              // class and forces one theme's fill onto both), Input's `px-3.5`
              // and Input's `coarse:h-11`.
              <select
                value={stringAt(config, "grantId")}
                disabled={disabled}
                onChange={(event) => set({ grantId: event.target.value })}
                className="field-well h-9 w-full rounded-field border border-input px-3.5 text-sm transition-[color,border-color,box-shadow] duration-base ease-out-soft coarse:h-11 hover:border-input/80 focus-visible:border-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">Choose a folder…</option>
                {grants.map((grant) => (
                  <option key={grant.id} value={grant.id}>
                    {grant.displayName}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              label="File types"
              value={listAt(config, "suffixes")}
              placeholder=".csv, .xlsx"
              hint="Empty means any file."
              disabled={disabled}
              onChange={(raw) => setList("suffixes", raw)}
            />
            <NumberField
              label="Files changed"
              value={intAt(config, "minChangedFiles", 1)}
              min={1}
              max={1000}
              disabled={disabled}
              hint="Fewer than this and the change is ignored."
              onChange={(minChangedFiles) => set({ minChangedFiles })}
            />
          </div>
        </div>
      );

    default:
      // A kind this build has no editor for, which a newer deployment can
      // legitimately have stored. Its configuration is left exactly as it is
      // rather than offered up to a form that would rewrite it into something
      // this build understands and the scheduler does not.
      return (
        <p className="text-ui leading-relaxed text-muted-foreground">
          This trigger was set up by a newer version of Juno. It is left untouched, and saving does
          not change it.
        </p>
      );
  }
}
