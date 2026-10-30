"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { useReducedMotion } from "@/lib/motion-preference";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Check, Repeat } from "@/components/ui/icons";
import { QuietButton, VerbButton } from "@/components/chat/decision";
import {
  fetchScheduleForProposal,
  scheduleRoutineProposal,
} from "@/components/work/work-transport";
import { stashRoutineDraft } from "@/components/work/routine-draft";
import { formatMicroUsdAmount } from "@/lib/budgets";
import { isValidTimeZone, type ClientWorkSchedule, type JsonObject } from "@/lib/work/schedule";
import {
  describeTimeTrigger,
  parseSchedulePhrase,
  upcomingFires,
  type PhraseTriggerKind,
} from "@/lib/work/schedule-phrase";
import {
  MAX_PROPOSAL_RUN_BUDGET_MICRO_USD,
  routineScheduleBody,
  runBudgetFromUsd,
  type ClientRoutineProposal,
  type RoutineProposalNotify,
} from "@/lib/work/routine-proposal";
import { transition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";
import type { ClientActivityEvent } from "@/types/chat";

/*
 * A routine the model drafted, put in front of the person to confirm.
 *
 *   [↻] Routine                                   Every weekday at 08:00
 *       Morning inbox summary
 *       When          Every weekday at 08:00 · times are Europe/Paris
 *       Next runs     Thu 16 Oct, 08:00 · Fri 17 Oct, 08:00 · Mon 20 Oct, 08:00
 *       What it does  Summarise the new mail in my inbox…
 *       Each run      Up to $1.00 · about $0.21 estimated
 *       Tells you     After every run
 *       Unattended    Stops and waits for you before anything it can’t undo
 *   ─────────────────────────────────────────────────────────────────────
 *       [Schedule]  [Edit]  Not now
 *
 * NOTHING EXISTS UNTIL SCHEDULE. The card is the whole of the agreement: the
 * instructions in full, the next three runs, the ceiling. Schedule posts
 * exactly what is shown (`routineScheduleBody`) through the route the routine
 * editor uses; the proposal key makes a second press, or a press after a
 * reload, land on the routine the first one made — which is also how the card
 * knows, on a later visit, that it was scheduled.
 *
 * The same card, opened on Edit with no schedule yet, is a finished task's
 * "Make a routine" (`startInEdit`).
 */

type Phase = "checking" | "open" | "scheduled" | "dismissed";

interface Draft {
  name: string;
  phrase: string;
  timezone: string;
  instructions: string;
  budgetUsd: string;
  notify: RoutineProposalNotify;
}

const DISMISS_PREFIX = "alevr:routine-proposal:not-now:";

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(DISMISS_PREFIX + key) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(key: string, dismissed: boolean): void {
  try {
    if (dismissed) window.localStorage.setItem(DISMISS_PREFIX + key, "1");
    else window.localStorage.removeItem(DISMISS_PREFIX + key);
  } catch {
    // Not remembering is fine: the card comes back on the next visit.
  }
}

function draftOf(proposal: ClientRoutineProposal): Draft {
  return {
    name: proposal.name,
    phrase: proposal.schedule.phrase,
    timezone: proposal.timezone,
    instructions: proposal.instructions,
    budgetUsd: proposal.maxCostMicroUsd > 0 ? (proposal.maxCostMicroUsd / 1_000_000).toFixed(2) : "",
    notify: proposal.notifyPolicy,
  };
}

function runWhen(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  // The reader's own clock, like the routine row: a 08:00 in Paris is 07:00
  // for somebody reading in Lisbon, and that is what they need to know.
  return when.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function readerZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function RoutineProposalCard({
  proposal,
  startInEdit = false,
  onClose,
  className,
}: {
  proposal: ClientRoutineProposal;
  /** Open on Edit with the When field focused (a finished task's "Make a routine"). */
  startInEdit?: boolean;
  /** Called by Not now and Cancel when the card belongs to something else (the task card). */
  onClose?: () => void;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const titleId = React.useId();
  const fieldId = React.useId();
  const [phase, setPhase] = React.useState<Phase>("checking");
  const [editing, setEditing] = React.useState(startInEdit);
  const [saving, setSaving] = React.useState(false);
  const [schedule, setSchedule] = React.useState<ClientWorkSchedule | null>(null);
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(proposal));
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const [showAll, setShowAll] = React.useState(false);
  const whenRef = React.useRef<HTMLInputElement>(null);

  // Was it scheduled already (this tab, another tab, before a reload)? Asked
  // once, by key. A failed read is treated as "not yet": Schedule is a replay
  // if it was, so the worst case is one press that answers with the routine.
  // Keyed on whether the card has an owner, not on the callback itself: an
  // owner passing a fresh arrow each render would otherwise re-ask the server
  // on every one of its renders.
  const owned = onClose !== undefined;
  React.useEffect(() => {
    let cancelled = false;
    void fetchScheduleForProposal(proposal.key).then((result) => {
      if (cancelled) return;
      if (result.kind === "ok" && result.value) {
        setSchedule(result.value);
        setPhase("scheduled");
        return;
      }
      setPhase(!owned && readDismissed(proposal.key) ? "dismissed" : "open");
    });
    return () => {
      cancelled = true;
    };
  }, [proposal.key, owned]);

  React.useEffect(() => {
    if (phase === "open" && startInEdit) whenRef.current?.focus({ preventScroll: true });
  }, [phase, startInEdit]);

  // The schedule as the person has it now: the proposal's, or the edited phrase read live.
  const parsed = React.useMemo(() => {
    if (draft.phrase.trim() === proposal.schedule.phrase.trim() && proposal.schedule.phrase.trim()) {
      return { ok: true as const, kind: proposal.schedule.kind, config: proposal.schedule.config, assumedTime: proposal.schedule.assumedTime };
    }
    const read = parseSchedulePhrase(draft.phrase);
    return read.ok
      ? { ok: true as const, kind: read.schedule.kind, config: read.schedule.config, assumedTime: read.schedule.assumedTime }
      : { ok: false as const, message: read.message };
  }, [draft.phrase, proposal.schedule]);

  const zone = draft.timezone.trim();
  const zoneOk = isValidTimeZone(zone);
  // Empty or zero is "no limit of its own", as the field's placeholder says;
  // anything else must be a positive amount.
  const budgetText = draft.budgetUsd.trim();
  const budgetMicro = budgetText === "" || Number(budgetText) === 0 ? 0 : runBudgetFromUsd(budgetText);
  const budgetOk = budgetMicro !== null;
  const nameOk = draft.name.trim().length > 0;
  const instructionsOk = draft.instructions.trim().length > 0;
  const canSchedule = parsed.ok && zoneOk && budgetOk && nameOk && instructionsOk;

  const summary = parsed.ok ? describeTimeTrigger(parsed.kind, parsed.config) : null;
  const nextRuns = React.useMemo(() => {
    if (!parsed.ok || !zoneOk) return [];
    // Recomputed from now rather than read off the card, which was drawn when
    // the reply was: three runs from yesterday are not the next three.
    return upcomingFires(parsed.kind, parsed.config, zone, new Date(), 3).map((d) => d.toISOString());
  }, [parsed, zone, zoneOk]);
  const otherZone = zoneOk && readerZone() !== null && readerZone() !== zone;

  const schedulePress = async () => {
    if (!canSchedule || !parsed.ok || saving) return;
    setSaving(true);
    setRefusal(null);
    const body = routineScheduleBody(proposal, {
      name: draft.name,
      instructions: draft.instructions,
      schedule: { kind: parsed.kind as PhraseTriggerKind, config: parsed.config as JsonObject },
      timezone: zone,
      maxCostMicroUsd: budgetMicro ?? 0,
      notifyPolicy: draft.notify,
    });
    const result = await scheduleRoutineProposal(body);
    setSaving(false);
    if (result.kind === "ok") {
      writeDismissed(proposal.key, false);
      setSchedule(result.value);
      setEditing(false);
      setPhase("scheduled");
      return;
    }
    setRefusal(
      result.kind === "blocked"
        ? result.explanation
        : (result.message ?? `Couldn’t reach ${PRODUCT_NAME} to schedule this. Nothing was set up, so trying again is safe.`)
    );
  };

  const notNow = () => {
    if (onClose) {
      onClose();
      return;
    }
    writeDismissed(proposal.key, true);
    setPhase("dismissed");
  };

  // Stashed on the press, never while rendering: every render would otherwise
  // write a fresh session-storage entry for a link nobody followed.
  const openMoreOptions = () => {
    const id = parsed.ok
      ? stashRoutineDraft({
          name: draft.name.trim(),
          instructions: draft.instructions.trim(),
          timezone: zone,
          trigger: { kind: parsed.kind, config: parsed.config },
          budgetMicroUsd: budgetMicro ?? 0,
          notifyPolicy: draft.notify,
          connectorIds: proposal.apps.map((app) => app.id),
          proposalKey: proposal.key,
        })
      : null;
    router.push(id ? `/automations/new?draft=${encodeURIComponent(id)}` : "/automations/new");
  };

  if (phase === "checking") {
    // Holds the card's place without drawing a state it may not be in.
    return <div aria-hidden="true" className={cn("h-[3.25rem] rounded-field bg-muted/60", className)} />;
  }

  if (phase === "dismissed") {
    return (
      <p className={cn("flex items-center gap-2 text-ui text-muted-foreground", className)}>
        <Repeat className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          Routine not scheduled: <span className="text-muted-foreground">{proposal.name}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            writeDismissed(proposal.key, false);
            setPhase("open");
          }}
          className="shrink-0 rounded-control px-1 text-muted-foreground underline-offset-2 transition-colors duration-fast ease-out-soft hover:text-foreground hover:underline motion-reduce:transition-none coarse:min-h-11"
        >
          Show
        </button>
      </p>
    );
  }

  const scheduled = phase === "scheduled";

  return (
    <motion.section
      aria-labelledby={titleId}
      data-routine-proposal={proposal.key}
      data-phase={phase}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition.base}
      className={cn(
        // The task card's anatomy: a flat tone step, radius 12, no border,
        // a hairline only under Increase Contrast.
        "@container rounded-field bg-muted contrast-more:border contrast-more:border-border",
        className
      )}
    >
      <header className="flex items-start gap-3 py-3 pl-4 pr-3">
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {scheduled ? <Check className="size-4 text-foreground" aria-hidden="true" /> : <Repeat className="size-4" aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-micro text-muted-foreground">{scheduled ? "Routine scheduled" : "Routine"}</p>
          <h3 id={titleId} className="mt-0.5 line-clamp-2 text-body font-medium text-foreground">
            {scheduled && schedule ? schedule.name : draft.name.trim() || proposal.name}
          </h3>
          {/* Live only while it is not being edited: the When field's own
              read-back speaks while typing, and both at once read every
              keystroke out twice. */}
          <p className="mt-px text-ui text-muted-foreground" aria-live={editing ? "off" : "polite"}>
            {scheduled && schedule ? (
              <ScheduledLine schedule={schedule} />
            ) : summary ? (
              summary
            ) : (
              "When it runs isn’t set yet"
            )}
          </p>
        </div>
      </header>

      {/* What it will do, read back. Stays mounted and folds, so Edit opens
          as smoothly as it closes. */}
      <Collapse open={!editing && !scheduled} innerClassName="px-4 pb-1 @[30rem]:pl-12">
        <dl className="space-y-2">
          <Row label="When">
            {summary ?? "Not set"}
            {zoneOk && <span className="text-muted-foreground"> · times are {zone}</span>}
            {parsed.ok && parsed.assumedTime && (
              <span className="block text-caption text-muted-foreground">No time was given, so it runs at this time. Edit to change it.</span>
            )}
          </Row>
          {nextRuns.length > 0 && (
            <Row label="Next runs">
              <span className="tabular-nums">{nextRuns.map(runWhen).join(" · ")}</span>
              {otherZone && <span className="block text-caption text-muted-foreground">Shown in your time.</span>}
            </Row>
          )}
          <Row label="What it does">
            <span className={cn("whitespace-pre-wrap", !showAll && "line-clamp-4")}>{draft.instructions.trim()}</span>
            {draft.instructions.length > 280 && (
              <button
                type="button"
                onClick={() => setShowAll((open) => !open)}
                aria-expanded={showAll}
                className="mt-0.5 block rounded-control text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline coarse:min-h-11"
              >
                {showAll ? "Show less" : "Show all"}
              </button>
            )}
          </Row>
          {(proposal.apps.length > 0 || proposal.missingApps.length > 0) && (
            <Row label="Apps">
              {proposal.apps.length > 0 ? proposal.apps.map((app) => app.label).join(", ") : null}
              {proposal.missingApps.length > 0 && (
                <span className="block text-caption text-warning-foreground">
                  Not connected: {proposal.missingApps.join(", ")}.{" "}
                  <Link href="/connections" className="underline underline-offset-2">
                    Connect
                  </Link>
                </span>
              )}
            </Row>
          )}
          <Row label="Each run">
            {budgetMicro && budgetMicro > 0 ? <>Up to {formatMicroUsdAmount(budgetMicro)}</> : "No limit of its own"}
            {proposal.estimatedCostMicroUsd !== null && (
              <span className="text-muted-foreground"> · about {formatMicroUsdAmount(proposal.estimatedCostMicroUsd)} estimated</span>
            )}
          </Row>
          <Row label="Tells you">{draft.notify === "on_finish" ? "After every run" : "Only when it needs you"}</Row>
          <Row label="Unattended">Stops and waits for you before anything it can’t undo. Runs in {PRODUCT_NAME}’s cloud.</Row>
        </dl>
        {proposal.fromOutsideContent && (
          <p className="mt-2.5 text-caption leading-relaxed text-warning-foreground">
            Drafted while reading outside content. Check what it will do before you schedule it.
          </p>
        )}
      </Collapse>

      <Collapse open={editing && !scheduled} innerClassName="space-y-3 px-4 pb-1 @[30rem]:pl-12">
        <div>
          <Label htmlFor={`${fieldId}-name`}>Name</Label>
          <Input
            id={`${fieldId}-name`}
            value={draft.name}
            onChange={(event) => setDraft((d) => ({ ...d, name: event.target.value }))}
            disabled={saving}
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor={`${fieldId}-when`}>When</Label>
          <Input
            id={`${fieldId}-when`}
            ref={whenRef}
            value={draft.phrase}
            onChange={(event) => setDraft((d) => ({ ...d, phrase: event.target.value }))}
            placeholder="Every weekday at 8am"
            aria-describedby={`${fieldId}-when-read`}
            aria-invalid={!parsed.ok && draft.phrase.trim() !== ""}
            disabled={saving}
            className="mt-1"
          />
          <p id={`${fieldId}-when-read`} className={cn("mt-1 text-caption leading-relaxed", parsed.ok ? "text-muted-foreground" : "text-warning-foreground")} aria-live="polite">
            {parsed.ok
              ? `${summary}${nextRuns[0] ? `. Next: ${runWhen(nextRuns[0])}` : ""}`
              : draft.phrase.trim() === ""
                ? "Say it the way you would to a person: “every Monday at 9:30”, “on the 1st of every month”."
                : parsed.message}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${fieldId}-zone`}>Time zone</Label>
            <Input
              id={`${fieldId}-zone`}
              value={draft.timezone}
              onChange={(event) => setDraft((d) => ({ ...d, timezone: event.target.value }))}
              aria-invalid={!zoneOk}
              disabled={saving}
              className="mt-1"
            />
            {!zoneOk && <p className="mt-1 text-caption text-warning-foreground">Use a name like Europe/Paris.</p>}
          </div>
          <div>
            <Label htmlFor={`${fieldId}-budget`}>Most it may spend each run, in US dollars</Label>
            <Input
              id={`${fieldId}-budget`}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              max={MAX_PROPOSAL_RUN_BUDGET_MICRO_USD / 1_000_000}
              value={draft.budgetUsd}
              onChange={(event) => setDraft((d) => ({ ...d, budgetUsd: event.target.value }))}
              placeholder="No limit of its own"
              aria-invalid={!budgetOk}
              disabled={saving}
              className="mt-1"
            />
          </div>
        </div>
        <div>
          <Label htmlFor={`${fieldId}-instructions`}>What it should do</Label>
          <Textarea
            id={`${fieldId}-instructions`}
            value={draft.instructions}
            onChange={(event) => setDraft((d) => ({ ...d, instructions: event.target.value }))}
            rows={4}
            disabled={saving}
            className="mt-1"
          />
          <p className="mt-1 text-caption leading-relaxed text-muted-foreground">
            Each run starts from this text alone, so it has to stand on its own.
          </p>
        </div>
        <div>
          <p className="mb-1.5 text-ui text-foreground" id={`${fieldId}-notify`}>
            Tell me
          </p>
          <SegmentedControl
            value={draft.notify}
            onChange={(notify) => setDraft((d) => ({ ...d, notify }))}
            options={[
              { value: "on_finish", label: "After every run" },
              { value: "on_attention", label: "Only when it needs me" },
            ]}
            ariaLabel="When to tell you"
            optionClassName="px-3 py-1 text-ui"
            className="max-w-sm"
          />
        </div>
      </Collapse>

      {refusal !== null && (
        <p role="alert" className="px-4 pt-2 text-ui leading-relaxed text-destructive @[30rem]:pl-12">
          {refusal}
        </p>
      )}

      <footer className="flex flex-wrap items-center gap-2 px-4 pb-3.5 pt-3 @[30rem]:pl-12">
        <AnimatePresence mode="popLayout" initial={false}>
          {scheduled && schedule ? (
            <motion.div
              key="scheduled"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.base }}
              exit={{ opacity: 0, transition: transition.exit }}
              className="flex flex-wrap items-center gap-2"
            >
              <QuietButton asChild>
                <Link href={`/automations/${schedule.id}`}>Open routine</Link>
              </QuietButton>
              <span className="text-caption text-muted-foreground">You can pause or change it there.</span>
            </motion.div>
          ) : (
            <motion.div
              key="decide"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: transition.base }}
              exit={{ opacity: 0, transition: transition.exit }}
              className="flex flex-wrap items-center gap-2"
            >
              <VerbButton
                label="Schedule"
                accessibleLabel={`Schedule ${draft.name.trim() || proposal.name}`}
                armed={canSchedule && !saving}
                busy={saving}
                onClick={() => void schedulePress()}
              />
              {editing ? (
                <>
                  <QuietButton
                    onClick={() => {
                      if (startInEdit && onClose) {
                        onClose();
                        return;
                      }
                      setDraft(draftOf(proposal));
                      setRefusal(null);
                      setEditing(false);
                    }}
                    disabled={saving}
                  >
                    Cancel
                  </QuietButton>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={openMoreOptions}
                    disabled={saving}
                    className="font-normal text-muted-foreground hover:text-foreground"
                  >
                    More options
                  </Button>
                </>
              ) : (
                <>
                  <QuietButton onClick={() => setEditing(true)} disabled={saving}>
                    Edit
                  </QuietButton>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={notNow}
                    disabled={saving}
                    className="font-normal text-muted-foreground hover:text-foreground"
                  >
                    Not now
                  </Button>
                </>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </footer>
    </motion.section>
  );
}

/** Every routine one reply drafted, in the order it drafted them. */
export function RoutineProposalList({ activity }: { activity: readonly ClientActivityEvent[] | undefined }) {
  const proposals = (activity ?? []).flatMap((evt) => (evt.routineProposal ? [evt.routineProposal] : []));
  if (proposals.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {proposals.map((proposal) => (
        <RoutineProposalCard key={proposal.key} proposal={proposal} />
      ))}
    </div>
  );
}

function ScheduledLine({ schedule }: { schedule: ClientWorkSchedule }) {
  const trigger = schedule.triggers.find((t) => t.enabled) ?? schedule.triggers[0];
  const when = trigger ? describeTimeTrigger(trigger.kind, trigger.config) : null;
  const next = schedule.nextRunAt ? runWhen(schedule.nextRunAt) : null;
  if (!schedule.enabled) return <>Paused</>;
  return (
    <>
      {when}
      {next && (
        <span className="text-muted-foreground">
          {" "}
          · next <span className="tabular-nums">{next}</span>
        </span>
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[6.5rem_1fr] sm:gap-3">
      <dt className="font-mono text-micro text-muted-foreground sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-ui leading-relaxed text-foreground">{children}</dd>
    </div>
  );
}
