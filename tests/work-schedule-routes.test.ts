import test from "node:test";
import assert from "node:assert/strict";
import {
  WORK_TRIGGER_KINDS,
  selectTarget,
  type WorkCapability,
  type WorkTarget,
} from "@/lib/work/domain";
import {
  hostCapabilityView,
  isTimeTriggerKind,
  nextFireForTriggers,
  planScheduleEdit,
  createScheduleSchema,
  patchScheduleSchema,
  runNowSchema,
  type WorkHostRow,
} from "@/lib/work/schedule";
import {
  isEventTriggerKind,
  normalizeTriggerDrafts,
  sameTriggerSet,
  type TriggerDraftInput,
} from "@/lib/work/triggers";
import { refusalForSelection } from "@/app/api/work/protocol";

/*
 * The decisions the schedule routes make, without a database.
 *
 * The routes themselves cannot be imported here: a route module reaches the
 * Prisma client, which imports `server-only`, and that module throws outside a
 * React-server condition. What can be pinned — and is what actually goes wrong —
 * is the composition each handler performs over these pure functions. Three
 * things are worth being sure about, and each of the three is a bug that would
 * be discovered by a user rather than by a stack trace:
 *
 *   Which edits move `nextRunAt`. The legacy scheduled-task PATCH recomputes it
 *   on every write, so a rename during an outage silently eats the overdue run.
 *
 *   Which configuration belongs to which trigger kind. One column holds a cron
 *   expression for one kind and an email filter for another, and the moment a
 *   value crosses between them the scheduler is guessing what it is holding.
 *
 *   Whether a schedule has anywhere to run at all, decided while the user is
 *   still looking at the form rather than at 07:00 every morning afterwards.
 *
 * `tests/work-schedule.test.ts` pins the arithmetic and `tests/work-triggers.test.ts`
 * the matching and deduplication; neither is repeated here.
 */

const PARIS = "Europe/Paris";
/** A fire that came due six hours ago and was never dispatched. */
const OVERDUE = new Date("2026-08-05T07:00:00Z");
const NOW = new Date("2026-08-05T13:00:00Z");
const DEDUPE = 3600;

// ---------------------------------------------------------------------------
// One column, one shape per kind
// ---------------------------------------------------------------------------

test("every trigger kind reaches a parser that knows what it is reading", () => {
  for (const kind of WORK_TRIGGER_KINDS) {
    // Exactly one of the two halves, for every kind in the vocabulary. A kind in
    // neither would be stored with its configuration never validated by
    // anything; a kind in both would be validated by whichever parser the route
    // happened to try first, which is a coin toss written into a switch.
    assert.equal(isTimeTriggerKind(kind) !== isEventTriggerKind(kind), true, kind);
  }
});

test("a configuration meant for another kind never crosses into this one", () => {
  // An email filter offered to a cron trigger is refused outright. There is no
  // expression in it, and defaulting one would schedule the user's work at a
  // time nobody chose.
  assert.equal(
    normalizeTriggerDrafts([{ kind: "cron", config: { from: ["accounts@example.com"] } }], PARIS).ok,
    false
  );

  // A cron expression offered to an email trigger is accepted — a filter with no
  // criteria is a legitimate "every message on this label" — but the expression
  // is dropped rather than carried into the column. That is what stops a later
  // reader finding a crontab line in a field that is supposed to hold a sender.
  const asFilter = normalizeTriggerDrafts(
    [{ kind: "email_filter", config: { expression: "0 9 * * 1-5" } }],
    PARIS
  );
  assert.equal(asFilter.ok, true);
  if (!asFilter.ok) throw new Error("unreachable");
  assert.equal("expression" in asFilter.drafts[0].config, false);
});

test("each clock kind is validated against the fields its own kind needs", () => {
  const accepts = (kind: string, config: Record<string, unknown>) =>
    normalizeTriggerDrafts([{ kind, config }], PARIS).ok;

  // Daily needs an hour; hourly deliberately does not, because "every hour at
  // half past" is the whole of what it means.
  assert.equal(accepts("daily", { minute: 0 }), false);
  assert.equal(accepts("hourly", { minute: 30 }), true);
  // Weekday is 0-6, so the other Sunday convention is refused rather than
  // silently folded onto Monday.
  assert.equal(accepts("weekly", { hour: 9, minute: 0, weekday: 7 }), false);
  assert.equal(accepts("weekly", { hour: 9, minute: 0, weekday: 0 }), true);
  // The 31st is accepted and lands on the last day of a short month, which is
  // what a person picking it from a monthly list means by it.
  assert.equal(accepts("monthly", { hour: 9, minute: 0, monthday: 31 }), true);
  // A one-off has to name a date that exists. Rounding 30 February to the 28th
  // would run the task on a day the user did not choose.
  assert.equal(accepts("once", { year: 2026, month: 2, day: 30, hour: 9, minute: 0 }), false);
  assert.equal(accepts("cron", { expression: "0 9 * * MON" }), false);
  assert.equal(accepts("cron", { expression: "0 9 * * 1" }), true);
});

test("a trigger that has to name something is refused when it names nothing", () => {
  // The only two configurations that can fail on their own terms: both name an
  // external thing, and neither has a meaning without it.
  assert.equal(normalizeTriggerDrafts([{ kind: "connector_event", config: {} }], PARIS).ok, false);
  assert.equal(normalizeTriggerDrafts([{ kind: "folder_change", config: {} }], PARIS).ok, false);
  // Everything else degrades to "anything of this kind", which is a real thing
  // to ask for and must not be refused.
  assert.equal(normalizeTriggerDrafts([{ kind: "email_filter", config: {} }], PARIS).ok, true);
});

test("a clock trigger is validated against the zone it will actually fire in", () => {
  // The route validates the trigger set against the effective timezone rather
  // than the stored one, so a zone the runtime cannot resolve is refused at the
  // edit instead of producing a schedule that never computes a fire.
  assert.equal(normalizeTriggerDrafts([{ kind: "daily", config: { hour: 9, minute: 0 } }], "Mars/Olympus").ok, false);
  assert.equal(normalizeTriggerDrafts([{ kind: "daily", config: { hour: 9, minute: 0 } }], PARIS).ok, true);
});

// ---------------------------------------------------------------------------
// Whether a schedule has anywhere to run
// ---------------------------------------------------------------------------

function host(overrides: Partial<WorkHostRow> = {}): WorkHostRow {
  return {
    id: "host-1",
    displayName: "MacBook",
    enabled: true,
    revokedAt: null,
    allowsFileWork: true,
    allowsBrowser: false,
    allowsComputerUse: false,
    allowsShell: false,
    allowsBackground: true,
    allowedApps: [],
    ...overrides,
  };
}

/**
 * The admission decision the create and patch handlers make, composed from the
 * same two calls they compose it from.
 *
 * The `idle` is the substance. Every Mac is presented to `selectTarget` as awake
 * and free rather than at its current heartbeat, because a nightly schedule is
 * almost always set up on a laptop that is shut — refusing that would refuse
 * nearly every local schedule anyone makes, and "the Mac is away at 07:00" is
 * the question `hostOfflinePolicy` exists to answer. What survives the
 * substitution is everything that will still be true tomorrow morning.
 */
function admits(
  target: WorkTarget,
  hosts: readonly WorkHostRow[],
  required: readonly WorkCapability[]
): boolean {
  return (
    refusalForSelection(
      selectTarget({
        requested: target,
        required,
        hosts: hosts.map((candidate) => hostCapabilityView(candidate, "idle")),
        cloudAvailable: true,
      })
    ) === null
  );
}

test("a local schedule is created for a Mac that is merely asleep", () => {
  assert.equal(admits("local", [host()], ["local_files"]), true);
});

test("a local schedule is refused for a Mac that will never serve it", () => {
  // Revoked and switched off are both decisions the user made about this
  // machine, and neither undoes itself overnight.
  assert.equal(admits("local", [host({ revokedAt: new Date("2026-08-01T00:00:00Z") })], ["local_files"]), false);
  assert.equal(admits("local", [host({ enabled: false })], ["local_files"]), false);
  // Switched on, reachable, and simply never granted the one thing this
  // schedule needs every single time it fires.
  assert.equal(admits("local", [host({ allowsFileWork: false })], ["local_files"]), false);
  assert.equal(admits("local", [], ["local_files"]), false);
});

test("app control is offered only by a Mac with an app actually allowed", () => {
  // An empty allowlist can drive nothing, so a schedule pinned to that Mac would
  // have every step refused at fire time rather than fail here.
  assert.equal(admits("local", [host({ allowedApps: [] })], ["local_apps"]), false);
  assert.equal(admits("local", [host({ allowedApps: ["com.apple.mail"] })], ["local_apps"]), true);
});

test("a cloud schedule needs no Mac at all", () => {
  assert.equal(admits("cloud", [], ["web_research", "deliverables"]), true);
});

test("an automatic schedule is refused only when nothing at all can be done", () => {
  // Entirely local work and no Mac: there is no honest way to start this, and
  // queueing it would render as a spinner nobody ever resolves.
  assert.equal(admits("automatic", [], ["local_files"]), false);
  // With a part the cloud can serve it is admitted and degraded instead: the
  // schedule does what it can and says what it did not.
  assert.equal(admits("automatic", [], ["local_files", "web_research"]), true);
});

// ---------------------------------------------------------------------------
// Which edits move the next fire
// ---------------------------------------------------------------------------

interface StoredTrigger {
  kind: string;
  config: unknown;
  enabled: boolean;
  dedupeWindowSec: number;
}

interface StoredSchedule {
  enabled: boolean;
  timezone: string;
  nextRunAt: Date | null;
  triggers: StoredTrigger[];
}

const DAILY_NINE: StoredTrigger = {
  kind: "daily",
  config: { hour: 9, minute: 0 },
  enabled: true,
  dedupeWindowSec: DEDUPE,
};

const FROM_ACCOUNTS: StoredTrigger = {
  kind: "email_filter",
  config: {
    from: ["accounts@example.com"],
    excludeFrom: [],
    subjectContains: [],
    excludeSubjectContains: [],
    labels: [],
    requireAttachment: false,
  },
  enabled: true,
  dedupeWindowSec: DEDUPE,
};

function stored(overrides: Partial<StoredSchedule> = {}): StoredSchedule {
  return { enabled: true, timezone: PARIS, nextRunAt: OVERDUE, triggers: [DAILY_NINE], ...overrides };
}

interface PatchBody {
  enabled?: boolean;
  timezone?: string;
  triggers?: TriggerDraftInput[];
}

/**
 * The PATCH handler's decision about `nextRunAt`, composed from the same three
 * calls the handler composes it from.
 *
 * Mirrored rather than imported for the reason given at the top of this file.
 * The composition is the part worth pinning: each of these functions is already
 * tested on its own, and the bug this route exists to avoid lives entirely in
 * how they are wired together — specifically in `firingChanged` being derived
 * from the clock triggers rather than from "the body contained a trigger list".
 */
function patchOutcome(before: StoredSchedule, body: PatchBody) {
  const timezone = body.timezone ?? before.timezone;
  const drafts = body.triggers ? normalizeTriggerDrafts(body.triggers, timezone) : null;
  if (drafts && !drafts.ok) throw new Error(`the patch was refused: ${drafts.message}`);
  const submitted = drafts?.ok ? drafts.drafts : null;

  const clock = <T extends { kind: string }>(rows: readonly T[]) =>
    rows.filter((row) => isTimeTriggerKind(row.kind));

  const setChanged = submitted !== null && !sameTriggerSet(before.triggers, submitted);
  const firingChanged = submitted !== null && !sameTriggerSet(clock(before.triggers), clock(submitted));
  const zoneChanged = body.timezone !== undefined && body.timezone !== before.timezone;

  const plan = planScheduleEdit({
    now: NOW,
    currentNextRunAt: before.nextRunAt,
    firingChanged: firingChanged || zoneChanged,
    enabledBefore: before.enabled,
    enabledAfter: body.enabled ?? before.enabled,
    recomputed: nextFireForTriggers(submitted ?? before.triggers, timezone, NOW),
  });
  return { ...plan, setChanged };
}

test("a save that re-sends the schedule unchanged leaves an overdue fire owed", () => {
  // The failure this route exists not to repeat, stated end to end. The editor
  // sends the whole object on save, so a rename arrives carrying the trigger
  // list; the legacy PATCH recomputes on any write and the 09:00 run still owed
  // at 15:00 is silently never made, with nothing anywhere recording that it was
  // dropped.
  const plan = patchOutcome(stored(), { triggers: [{ kind: "daily", config: { hour: 9, minute: 0 } }] });
  assert.equal(plan.write, false);
  assert.equal(plan.setChanged, false);
  assert.equal(plan.nextRunAt?.getTime(), OVERDUE.getTime());
});

test("the same save survives a stored configuration coming back with reordered keys", () => {
  // JSONB does not preserve key order, so the row read back does not stringify
  // to what was written. A comparison that missed this would call every save a
  // change and put the bug above back exactly as it was.
  const plan = patchOutcome(stored({ triggers: [{ ...DAILY_NINE, config: { minute: 0, hour: 9 } }] }), {
    triggers: [{ kind: "daily", config: { hour: 9, minute: 0 } }],
  });
  assert.equal(plan.write, false);
  assert.equal(plan.nextRunAt?.getTime(), OVERDUE.getTime());
});

test("editing an email filter does not move the fire of the clock trigger beside it", () => {
  // A schedule that runs daily at 09:00 and also whenever the accounts mailbox
  // gets something. Widening the sender list changes what starts a run, not when
  // the clock next strikes — and moving `nextRunAt` for it would throw away a
  // morning run that was already overdue.
  const plan = patchOutcome(stored({ triggers: [DAILY_NINE, FROM_ACCOUNTS] }), {
    triggers: [
      { kind: "daily", config: { hour: 9, minute: 0 } },
      { kind: "email_filter", config: { from: ["accounts@example.com", "billing@example.com"] } },
    ],
  });
  assert.equal(plan.nextRunAt?.getTime(), OVERDUE.getTime());
  assert.equal(plan.write, false);
  // The rows are still rewritten, or the edit the user actually made would be
  // accepted with a 200 and quietly discarded.
  assert.equal(plan.setChanged, true);
});

test("changing the hour moves the fire, because that is what the user asked for", () => {
  // 15:00 in Paris when the edit lands, so the new 10:00 fire is tomorrow's.
  const plan = patchOutcome(stored(), { triggers: [{ kind: "daily", config: { hour: 10, minute: 0 } }] });
  assert.equal(plan.write, true);
  assert.equal(plan.nextRunAt?.toISOString(), "2026-08-06T08:00:00.000Z");
});

test("moving a schedule to another zone moves the fire", () => {
  // The zone is invisible in a rendered configuration — "daily at 09:00" reads
  // identically in Paris and in Tokyo and fires eight hours apart — so it has to
  // be compared separately from the triggers.
  const plan = patchOutcome(stored(), { timezone: "Asia/Tokyo" });
  assert.equal(plan.write, true);
  assert.equal(plan.nextRunAt?.toISOString(), "2026-08-06T00:00:00.000Z");
});

test("pausing keeps the overdue fire and resuming deliberately gives it up", () => {
  const paused = patchOutcome(stored(), { enabled: false });
  assert.equal(paused.write, false);
  assert.equal(paused.nextRunAt?.getTime(), OVERDUE.getTime());

  // Resuming starts from now. Pausing is an instruction to stop, so catching up
  // a fire from the middle of a two-week pause would run work the user
  // explicitly suspended — the one case where dropping a fire is the right
  // answer, and it is the user's own answer.
  const resumed = patchOutcome(stored({ enabled: false }), { enabled: true });
  assert.equal(resumed.write, true);
  assert.equal(resumed.nextRunAt?.toISOString(), "2026-08-06T07:00:00.000Z");
});

test("a pause that also retimes the schedule still does not fire in the meantime", () => {
  // Both signals at once: the triggers changed AND the schedule was switched
  // off. Paused wins, so nothing is written and nothing is lost; the recompute
  // happens when it is resumed, which is when it can matter.
  const plan = patchOutcome(stored(), {
    enabled: false,
    triggers: [{ kind: "daily", config: { hour: 10, minute: 0 } }],
  });
  assert.equal(plan.write, false);
  assert.equal(plan.nextRunAt?.getTime(), OVERDUE.getTime());
});

test("replacing the last clock trigger with an event trigger writes no next fire", () => {
  // The schedule now fires on something happening rather than on a clock, so
  // `nextRunAt` has to become null. Leaving the old fire in the column would
  // have the dispatcher run it once more, tomorrow, for a definition the user
  // has replaced.
  const plan = patchOutcome(stored(), {
    triggers: [{ kind: "email_filter", config: { from: ["accounts@example.com"] } }],
  });
  assert.equal(plan.write, true);
  assert.equal(plan.nextRunAt, null);
});

test("adding a clock trigger to an event-only schedule gives it a fire", () => {
  const plan = patchOutcome(stored({ triggers: [FROM_ACCOUNTS], nextRunAt: null }), {
    triggers: [
      { kind: "email_filter", config: { from: ["accounts@example.com"] } },
      { kind: "daily", config: { hour: 9, minute: 0 } },
    ],
  });
  assert.equal(plan.write, true);
  assert.equal(plan.nextRunAt?.toISOString(), "2026-08-06T07:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const CREATE_BODY = {
  name: "Morning brief",
  instructions: "Summarise overnight email.",
  timezone: PARIS,
  target: "cloud",
  triggers: [{ kind: "daily", config: { hour: 9, minute: 0 } }],
};

test("a schedule may not be created without saying where it runs", () => {
  // `target` is required rather than defaulted, for the reason the session
  // schema gives: `automatic` is what lets scheduled work move onto the user's
  // Mac, and a client that has not thought about it should say so rather than
  // inherit an answer from whoever wrote the default.
  const { target: _target, ...withoutTarget } = CREATE_BODY;
  assert.equal(createScheduleSchema.safeParse(withoutTarget).success, false);
  assert.equal(createScheduleSchema.safeParse(CREATE_BODY).success, true);
});

test("a schedule carries the policies it was created with rather than an executor's guess", () => {
  const parsed = createScheduleSchema.safeParse(CREATE_BODY);
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("unreachable");
  // The defaults are the cautious ones on every axis a scheduled run can be
  // wrong about: ask before anything irreversible, do not wander onto a Mac
  // that is not there, do not stampede after an outage, and speak up when it
  // needs a person.
  assert.equal(parsed.data.unattendedPolicy, "pause_for_approval");
  assert.equal(parsed.data.hostOfflinePolicy, "skip");
  assert.equal(parsed.data.missedRunPolicy, "run_once");
  assert.equal(parsed.data.notifyPolicy, "on_attention");
  assert.equal(parsed.data.maxConcurrentRuns, 1);
  assert.equal(parsed.data.enabled, true);
});

test("a capability this build cannot check a host against cannot be asked for", () => {
  // Carried through, an unknown capability would make every target fail to
  // satisfy it and turn a cloud schedule into one that never runs anywhere.
  assert.equal(
    createScheduleSchema.safeParse({ ...CREATE_BODY, requiredCapabilities: ["read_my_mind"] }).success,
    false
  );
  assert.equal(
    createScheduleSchema.safeParse({ ...CREATE_BODY, requiredCapabilities: ["web_research"] }).success,
    true
  );
});

test("a schedule cannot be given more triggers than its next fire is cheap to compute from", () => {
  const many = Array.from({ length: 9 }, () => ({ kind: "daily", config: { hour: 9, minute: 0 } }));
  assert.equal(createScheduleSchema.safeParse({ ...CREATE_BODY, triggers: many }).success, false);
});

test("a patch that says nothing about the triggers leaves them out of the decision", () => {
  // The absence of the key is what the route reads as "do not touch them", so it
  // has to survive parsing rather than arriving as an empty list.
  const parsed = patchScheduleSchema.safeParse({ name: "Renamed" });
  assert.equal(parsed.success, true);
  if (!parsed.success) throw new Error("unreachable");
  assert.equal("triggers" in parsed.data, false);
  // An empty list is refused rather than read as "remove them all": a schedule
  // with no triggers can never fire, and deleting it is how a user says that.
  assert.equal(patchScheduleSchema.safeParse({ triggers: [] }).success, false);
});

test("a Run-now with no body at all is the ordinary case", () => {
  // The button has nothing to say. The route reads a missing or unreadable body
  // as `{}`, so this has to parse.
  assert.equal(runNowSchema.safeParse({}).success, true);
  // A key too short to be unique is refused rather than used: two different
  // manual fires colliding on it would hand the second one the first one's run.
  assert.equal(runNowSchema.safeParse({ idempotencyKey: "abc" }).success, false);
  assert.equal(runNowSchema.safeParse({ idempotencyKey: "run-now-2026-08-05" }).success, true);
});
