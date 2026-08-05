import test from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_CONFIRM_ACTIONS,
  WORK_RISK_LEVELS,
  WORK_UNATTENDED_POLICIES,
  type HostCapabilityView,
  type WorkRiskLevel,
  type WorkUnattendedPolicy,
} from "@/lib/work/domain";
import {
  DEFAULT_USER_CONCURRENCY_CAP,
  MAX_CATCH_UP_RUNS,
  MISSED_RUN_GRACE_MS,
  daysInMonth,
  decideUnattendedAction,
  nextFireAfter,
  nextFireForTriggers,
  parseCron,
  parseTimeTrigger,
  planMissedRuns,
  planScheduleDispatch,
  resolveWallTime,
  scheduleRunIdempotencyKey,
  serializeSchedule,
  type ScheduleDispatchInput,
  type TimeTriggerSpec,
  type WorkScheduleRow,
  type WorkTriggerRow,
} from "@/lib/work/schedule";

/*
 * The schedule math, pinned against the cases that are only ever discovered in
 * production: the hour in March that does not exist, the hour in October that
 * happens twice, and the 31st of a month with thirty days.
 *
 * The legacy `computeNextRunAt` got the first two nearly right by accident —
 * its guess-and-correct landed on an adjacent instant — and got the third right
 * by refusing to let anyone pick a day after the 28th. Neither is a property a
 * test could state, which is why neither had one.
 *
 * Europe/Paris changes on the last Sunday of March and October: in 2026 that is
 * 29 March (02:00 CET becomes 03:00 CEST) and 25 October (03:00 CEST becomes
 * 02:00 CET). America/New_York changes on 8 March and 1 November 2026, and
 * Australia/Sydney runs the other way round — forward in October, back in April.
 */

const PARIS = "Europe/Paris";
const NEW_YORK = "America/New_York";
const SYDNEY = "Australia/Sydney";

function spec(kind: string, config: Record<string, unknown>, timezone: string): TimeTriggerSpec {
  const parsed = parseTimeTrigger(kind, config, timezone);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.spec;
}

/** The wall clock a fire lands on, as a user in that zone would read it. */
function wall(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(instant);
}

// ---------------------------------------------------------------------------
// Wall-time resolution
// ---------------------------------------------------------------------------

test("an ordinary wall time resolves to exactly one instant", () => {
  const resolved = resolveWallTime({ year: 2026, month: 8, day: 5, hour: 9, minute: 0 }, PARIS);
  assert.equal(resolved.kind, "exact");
  assert.equal(resolved.instant.toISOString(), "2026-08-05T07:00:00.000Z");
});

test("the hour the clocks jump over is reported as a gap and shifted forward by it", () => {
  const resolved = resolveWallTime({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, PARIS);
  assert.equal(resolved.kind, "gap");
  // 02:30 never happens; the fire lands 30 minutes into the hour that replaced
  // it, keeping the minute the user chose rather than snapping to the top.
  assert.equal(resolved.instant.toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(wall(resolved.instant, PARIS), "29/03/2026, 03:30");
});

test("the hour that happens twice is reported as ambiguous and resolves to the first", () => {
  const resolved = resolveWallTime({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, PARIS);
  assert.equal(resolved.kind, "ambiguous");
  if (resolved.kind !== "ambiguous") throw new Error("unreachable");
  assert.equal(resolved.instant.toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(resolved.repeat.toISOString(), "2026-10-25T01:30:00.000Z");
});

test("the same two edges hold in a zone that transitions at a different local hour", () => {
  const gap = resolveWallTime({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NEW_YORK);
  assert.equal(gap.kind, "gap");
  assert.equal(wall(gap.instant, NEW_YORK), "08/03/2026, 03:30");

  const twice = resolveWallTime({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NEW_YORK);
  assert.equal(twice.kind, "ambiguous");
  assert.equal(twice.instant.toISOString(), "2026-11-01T05:30:00.000Z");
});

test("a southern-hemisphere zone transitions in the opposite months and is handled the same way", () => {
  // Sydney springs forward on 4 October 2026 and falls back on 5 April 2026, so
  // a rule keyed on "March means forward" would get both backwards.
  const gap = resolveWallTime({ year: 2026, month: 10, day: 4, hour: 2, minute: 30 }, SYDNEY);
  assert.equal(gap.kind, "gap");
  assert.equal(wall(gap.instant, SYDNEY), "04/10/2026, 03:30");

  const twice = resolveWallTime({ year: 2026, month: 4, day: 5, hour: 2, minute: 30 }, SYDNEY);
  assert.equal(twice.kind, "ambiguous");
});

// ---------------------------------------------------------------------------
// DST and the daily cadence
// ---------------------------------------------------------------------------

test("a daily 09:00 stays 09:00 local across both transitions", () => {
  // The whole reason this module exists. Advancing by 24 hours would put the
  // fire at 08:00 for the summer half of the year, and nobody would report it
  // because it looks deliberate.
  const daily = spec("daily", { hour: 9, minute: 0 }, PARIS);

  const beforeSpring = nextFireAfter(daily, new Date("2026-03-28T12:00:00Z"));
  assert.equal(beforeSpring?.toISOString(), "2026-03-29T07:00:00.000Z");
  assert.equal(wall(beforeSpring!, PARIS), "29/03/2026, 09:00");

  const beforeAutumn = nextFireAfter(daily, new Date("2026-10-24T12:00:00Z"));
  assert.equal(beforeAutumn?.toISOString(), "2026-10-25T08:00:00.000Z");
  assert.equal(wall(beforeAutumn!, PARIS), "25/10/2026, 09:00");
});

test("a daily job scheduled inside the spring gap fires once, just after it", () => {
  const daily = spec("daily", { hour: 2, minute: 30 }, PARIS);
  const first = nextFireAfter(daily, new Date("2026-03-28T23:00:00Z"));
  assert.equal(first?.toISOString(), "2026-03-29T01:30:00.000Z");

  // And the following fire is the next day's, not a second one on the same day.
  const second = nextFireAfter(daily, first!);
  assert.equal(wall(second!, PARIS), "30/03/2026, 02:30");
});

test("a daily job scheduled inside the autumn repeat fires once, not twice", () => {
  const daily = spec("daily", { hour: 2, minute: 30 }, PARIS);
  const first = nextFireAfter(daily, new Date("2026-10-24T23:00:00Z"));
  assert.equal(first?.toISOString(), "2026-10-25T00:30:00.000Z");

  // 2026-10-25T01:30Z is the second 02:30 of that day. Asking for the next fire
  // from the first one must skip straight to the 26th; returning the repeat
  // would send the same report twice an hour apart.
  const second = nextFireAfter(daily, first!);
  assert.equal(second?.toISOString(), "2026-10-26T01:30:00.000Z");
  assert.equal(wall(second!, PARIS), "26/10/2026, 02:30");
});

test("an hourly job neither skips nor doubles an hour across a transition", () => {
  const hourly = spec("hourly", { minute: 30 }, PARIS);
  const fires: string[] = [];
  let cursor = new Date("2026-03-29T00:00:00Z");
  for (let i = 0; i < 4; i++) {
    cursor = nextFireAfter(hourly, cursor)!;
    fires.push(wall(cursor, PARIS));
  }
  // 02:30 does not exist, so its fire lands at 03:30 — and the real 03:30 slot
  // resolves to the same instant, so the hour is covered once rather than twice.
  assert.deepEqual(fires, [
    "29/03/2026, 01:30",
    "29/03/2026, 03:30",
    "29/03/2026, 04:30",
    "29/03/2026, 05:30",
  ]);
});

// ---------------------------------------------------------------------------
// Calendar cadences
// ---------------------------------------------------------------------------

test("weekdays skips Saturday and Sunday", () => {
  const weekdays = spec("weekdays", { hour: 8, minute: 0 }, "UTC");
  // 2026-08-07 is a Friday.
  const afterFriday = nextFireAfter(weekdays, new Date("2026-08-07T08:00:01Z"));
  assert.equal(afterFriday?.toISOString(), "2026-08-10T08:00:00.000Z");
});

test("weekly fires on its weekday only", () => {
  const weekly = spec("weekly", { weekday: 3, hour: 17, minute: 30 }, "UTC");
  const fire = nextFireAfter(weekly, new Date("2026-08-06T00:00:00Z"));
  assert.equal(fire?.toISOString(), "2026-08-12T17:30:00.000Z");
  assert.equal(new Date(fire!).getUTCDay(), 3);
});

test("the 31st lands on the last day of a month that has no 31st", () => {
  const monthly = spec("monthly", { monthday: 31, hour: 9, minute: 0 }, "UTC");
  const fires: string[] = [];
  let cursor = new Date("2026-01-01T00:00:00Z");
  for (let i = 0; i < 5; i++) {
    cursor = nextFireAfter(monthly, cursor)!;
    fires.push(cursor.toISOString());
  }
  assert.deepEqual(fires, [
    "2026-01-31T09:00:00.000Z",
    "2026-02-28T09:00:00.000Z",
    "2026-03-31T09:00:00.000Z",
    "2026-04-30T09:00:00.000Z",
    "2026-05-31T09:00:00.000Z",
  ]);
});

test("the 30th and the 29th clamp the same way, and February takes its real length", () => {
  const thirtieth = spec("monthly", { monthday: 30, hour: 6, minute: 0 }, "UTC");
  assert.equal(
    nextFireAfter(thirtieth, new Date("2026-02-01T00:00:00Z"))?.toISOString(),
    "2026-02-28T06:00:00.000Z"
  );
  const twentyNinth = spec("monthly", { monthday: 29, hour: 6, minute: 0 }, "UTC");
  assert.equal(
    nextFireAfter(twentyNinth, new Date("2028-02-01T00:00:00Z"))?.toISOString(),
    "2028-02-29T06:00:00.000Z"
  );
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
});

test("a yearly 29 February clamps in common years and hits the real day in leap years", () => {
  const yearly = spec("yearly", { month: 2, monthday: 29, hour: 9, minute: 0 }, "UTC");
  const fires: string[] = [];
  let cursor = new Date("2026-01-01T00:00:00Z");
  for (let i = 0; i < 3; i++) {
    cursor = nextFireAfter(yearly, cursor)!;
    fires.push(cursor.toISOString());
  }
  // Skipping three years out of four would be defensible for cron and is not
  // defensible for "every year on the 29th of February" chosen in a date picker.
  assert.deepEqual(fires, [
    "2026-02-28T09:00:00.000Z",
    "2027-02-28T09:00:00.000Z",
    "2028-02-29T09:00:00.000Z",
  ]);
});

test("a one-off fires once and then never again", () => {
  const once = spec("once", { year: 2026, month: 8, day: 10, hour: 7, minute: 0 }, PARIS);
  const fire = nextFireAfter(once, new Date("2026-08-05T00:00:00Z"));
  assert.equal(fire?.toISOString(), "2026-08-10T05:00:00.000Z");
  // Null rather than a far-future date: a caller that invented a next fire for
  // a spent one-off would re-run it for ever.
  assert.equal(nextFireAfter(once, fire!), null);
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------

test("cron fields expand over lists, ranges and steps", () => {
  const fields = parseCron("*/15 9-17 * * 1-5");
  assert.ok(fields);
  assert.deepEqual(fields!.minutes, [0, 15, 30, 45]);
  assert.deepEqual(fields!.hours, [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual(fields!.weekdays, [1, 2, 3, 4, 5]);
  assert.equal(fields!.monthdayRestricted, false);
  assert.equal(fields!.weekdayRestricted, true);

  assert.deepEqual(parseCron("0,30 * * * *")!.minutes, [0, 30]);
  assert.deepEqual(parseCron("0 0-6/2 * * *")!.hours, [0, 2, 4, 6]);
  // A bare number with a step means "from here to the end of the field".
  assert.deepEqual(parseCron("5/15 * * * *")!.minutes, [5, 20, 35, 50]);
});

test("cron accepts either Sunday convention and folds them together", () => {
  assert.deepEqual(parseCron("0 9 * * 7")!.weekdays, [0]);
  assert.deepEqual(parseCron("0 9 * * 0,7")!.weekdays, [0]);
});

test("cron refuses what it cannot represent rather than guessing", () => {
  assert.equal(parseCron("* * * *"), null, "four fields");
  assert.equal(parseCron("* * * * * *"), null, "six fields");
  assert.equal(parseCron("60 * * * *"), null, "minute out of range");
  assert.equal(parseCron("0 24 * * *"), null, "hour out of range");
  assert.equal(parseCron("0 9 * * MON"), null, "weekday names disagree between schedulers");
  assert.equal(parseCron("0 9 * * */0"), null, "zero step");
  assert.equal(parseCron("0 17-9 * * *"), null, "inverted range");
});

test("cron day-of-month and day-of-week combine with OR, as every crontab does", () => {
  // "the 1st of the month and every Monday", not "Mondays that fall on the 1st".
  const cron = spec("cron", { expression: "0 9 1 * 1" }, "UTC");
  const fires: string[] = [];
  let cursor = new Date("2026-08-28T00:00:00Z");
  for (let i = 0; i < 4; i++) {
    cursor = nextFireAfter(cron, cursor)!;
    fires.push(cursor.toISOString().slice(0, 10));
  }
  assert.deepEqual(fires, ["2026-08-31", "2026-09-01", "2026-09-07", "2026-09-14"]);
});

test("a cron 31st skips short months instead of clamping", () => {
  // The opposite of the monthly picker on purpose: an expression copied out of
  // a crontab must fire on the days that crontab fires on.
  const cron = spec("cron", { expression: "0 9 31 * *" }, "UTC");
  const fires: string[] = [];
  let cursor = new Date("2026-01-01T00:00:00Z");
  for (let i = 0; i < 4; i++) {
    cursor = nextFireAfter(cron, cursor)!;
    fires.push(cursor.toISOString().slice(0, 10));
  }
  assert.deepEqual(fires, ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);
});

test("cron is resolved in the schedule's zone, not UTC", () => {
  const cron = spec("cron", { expression: "30 9 * * *" }, NEW_YORK);
  const fire = nextFireAfter(cron, new Date("2026-08-05T00:00:00Z"));
  assert.equal(wall(fire!, NEW_YORK), "05/08/2026, 09:30");
  assert.equal(fire?.toISOString(), "2026-08-05T13:30:00.000Z");
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test("a trigger config is refused with a reason a user can act on", () => {
  const kind = parseTimeTrigger("email_filter", {}, "UTC");
  assert.deepEqual(kind.ok ? null : kind.error, "unknown_kind");

  const zone = parseTimeTrigger("daily", { hour: 9, minute: 0 }, "Mars/Olympus");
  assert.deepEqual(zone.ok ? null : zone.error, "unknown_timezone");

  const shape = parseTimeTrigger("daily", "09:00", "UTC");
  assert.deepEqual(shape.ok ? null : shape.error, "malformed_config");

  const hour = parseTimeTrigger("daily", { minute: 0 }, "UTC");
  assert.deepEqual(hour.ok ? null : hour.error, "malformed_config");

  const weekday = parseTimeTrigger("weekly", { hour: 9, minute: 0 }, "UTC");
  assert.deepEqual(weekday.ok ? null : weekday.error, "malformed_config");

  const cron = parseTimeTrigger("cron", { expression: "not a cron" }, "UTC");
  assert.deepEqual(cron.ok ? null : cron.error, "malformed_cron");

  const impossibleDate = parseTimeTrigger(
    "once",
    { year: 2026, month: 2, day: 30, hour: 9, minute: 0 },
    "UTC"
  );
  assert.deepEqual(impossibleDate.ok ? null : impossibleDate.error, "malformed_config");
});

test("a monthly trigger may name any day of the month, unlike the legacy 1-28 cap", () => {
  assert.equal(parseTimeTrigger("monthly", { monthday: 31, hour: 9, minute: 0 }, "UTC").ok, true);
  assert.equal(parseTimeTrigger("monthly", { monthday: 0, hour: 9, minute: 0 }, "UTC").ok, false);
  assert.equal(parseTimeTrigger("monthly", { monthday: 32, hour: 9, minute: 0 }, "UTC").ok, false);
});

// ---------------------------------------------------------------------------
// Missed runs
// ---------------------------------------------------------------------------

const daily9 = spec("daily", { hour: 9, minute: 0 }, "UTC");

test("a fire that is merely a few seconds late runs under every policy", () => {
  // Without the grace window every fire is a missed fire the moment it is due,
  // and `skip` would mean a schedule that never runs at all.
  for (const policy of ["skip", "run_once", "run_all"] as const) {
    const plan = planMissedRuns({
      spec: daily9,
      dueAt: new Date("2026-08-05T09:00:00Z"),
      now: new Date("2026-08-05T09:00:20Z"),
      policy,
    });
    assert.deepEqual(
      plan.run.map((fire) => fire.toISOString()),
      ["2026-08-05T09:00:00.000Z"],
      policy
    );
    assert.equal(plan.dropped, 0, policy);
    assert.equal(plan.nextRunAt?.toISOString(), "2026-08-06T09:00:00.000Z", policy);
  }
});

test("skip drops everything missed during downtime and moves the schedule on", () => {
  const plan = planMissedRuns({
    spec: daily9,
    dueAt: new Date("2026-08-03T09:00:00Z"),
    now: new Date("2026-08-05T13:00:00Z"),
    policy: "skip",
  });
  assert.equal(plan.missed.length, 3);
  assert.deepEqual(plan.run, []);
  assert.equal(plan.dropped, 3);
  assert.equal(plan.nextRunAt?.toISOString(), "2026-08-06T09:00:00.000Z");
});

test("run_once catches up with the most recent missed fire, not the oldest", () => {
  // Yesterday's report run today reports on today's data whichever fire it is
  // nominally for, so the oldest is the one whose label is furthest from true.
  const plan = planMissedRuns({
    spec: daily9,
    dueAt: new Date("2026-08-03T09:00:00Z"),
    now: new Date("2026-08-05T13:00:00Z"),
    policy: "run_once",
  });
  assert.deepEqual(
    plan.run.map((fire) => fire.toISOString()),
    ["2026-08-05T09:00:00.000Z"]
  );
  assert.equal(plan.dropped, 2);
});

test("run_once adds nothing when the current fire is already going to run", () => {
  const plan = planMissedRuns({
    spec: daily9,
    dueAt: new Date("2026-08-04T09:00:00Z"),
    now: new Date("2026-08-05T09:00:10Z"),
    policy: "run_once",
  });
  assert.equal(plan.run.length, 1, "one run, not the catch-up plus the current one");
  assert.equal(plan.run[0].toISOString(), "2026-08-05T09:00:00.000Z");
  assert.equal(plan.dropped, 1);
});

test("run_all works through the backlog in order", () => {
  const plan = planMissedRuns({
    spec: daily9,
    dueAt: new Date("2026-08-03T09:00:00Z"),
    now: new Date("2026-08-05T13:00:00Z"),
    policy: "run_all",
  });
  assert.deepEqual(
    plan.run.map((fire) => fire.toISOString()),
    ["2026-08-03T09:00:00.000Z", "2026-08-04T09:00:00.000Z", "2026-08-05T09:00:00.000Z"]
  );
  assert.equal(plan.dropped, 0);
});

test("run_all is capped, so a week of downtime cannot cost more than the outage", () => {
  const hourly = spec("hourly", { minute: 0 }, "UTC");
  const plan = planMissedRuns({
    spec: hourly,
    dueAt: new Date("2026-07-29T00:00:00Z"),
    now: new Date("2026-08-05T12:00:00Z"),
    policy: "run_all",
  });
  assert.ok(plan.run.length <= MAX_CATCH_UP_RUNS + 1);
  assert.ok(plan.dropped > 0, "the truncation is reported rather than hidden");
});

test("a schedule that is not yet due owes nothing", () => {
  const plan = planMissedRuns({
    spec: daily9,
    dueAt: new Date("2026-08-06T09:00:00Z"),
    now: new Date("2026-08-05T13:00:00Z"),
    policy: "run_all",
  });
  assert.deepEqual(plan.run, []);
  assert.deepEqual(plan.missed, []);
  assert.equal(plan.nextRunAt?.toISOString(), "2026-08-06T09:00:00.000Z");
});

test("the grace window is the boundary between due and missed", () => {
  const dueAt = new Date("2026-08-05T09:00:00Z");
  const justInside = planMissedRuns({
    spec: daily9,
    dueAt,
    now: new Date(dueAt.getTime() + MISSED_RUN_GRACE_MS - 1_000),
    policy: "skip",
  });
  assert.equal(justInside.run.length, 1);

  const justOutside = planMissedRuns({
    spec: daily9,
    dueAt,
    now: new Date(dueAt.getTime() + MISSED_RUN_GRACE_MS + 1_000),
    policy: "skip",
  });
  assert.equal(justOutside.run.length, 0);
});

// ---------------------------------------------------------------------------
// Unattended policy
// ---------------------------------------------------------------------------

/**
 * The whole table, stated once.
 *
 * Written out rather than generated from the implementation, because a matrix
 * derived from the code under test agrees with it by construction and would
 * keep agreeing with it after somebody adds an auto-approve path.
 */
const UNATTENDED_TABLE: Record<WorkUnattendedPolicy, Record<WorkRiskLevel, string>> = {
  pause_for_approval: {
    safe: "proceed",
    edit: "proceed",
    command: "proceed",
    sensitive: "pause_for_approval",
    irreversible: "pause_for_approval",
  },
  skip_irreversible: {
    safe: "proceed",
    edit: "proceed",
    command: "proceed",
    // Deliberately still a pause: "skip irreversible" says what it covers in
    // its name, and stretching it to sensitive-but-reversible work would widen
    // a permission the user chose by name.
    sensitive: "pause_for_approval",
    irreversible: "skip",
  },
  disallow_irreversible: {
    safe: "proceed",
    edit: "proceed",
    command: "proceed",
    sensitive: "pause_for_approval",
    irreversible: "refuse",
  },
};

test("the unattended policy table is exhaustive over every policy and risk level", () => {
  assert.equal(WORK_UNATTENDED_POLICIES.length, 3, "a new policy needs a row in the table above");
  assert.equal(WORK_RISK_LEVELS.length, 5, "a new risk level needs a column in the table above");

  for (const policy of WORK_UNATTENDED_POLICIES) {
    for (const risk of WORK_RISK_LEVELS) {
      const decision = decideUnattendedAction({ action: "work.file.write", risk, policy });
      assert.equal(decision.outcome, UNATTENDED_TABLE[policy][risk], `${policy} / ${risk}`);
      assert.ok(decision.explanation.length > 0, `${policy} / ${risk} has no explanation`);
    }
  }
});

test("no policy and no risk level produces an approval", () => {
  // The safety property the whole feature rests on: a scheduled run must not
  // acquire authority it would not have had with the user watching.
  const outcomes = new Set<string>();
  for (const policy of WORK_UNATTENDED_POLICIES) {
    for (const risk of WORK_RISK_LEVELS) {
      for (const action of ["work.file.write", "work.browser.click", ...ALWAYS_CONFIRM_ACTIONS]) {
        outcomes.add(decideUnattendedAction({ action, risk, policy }).outcome);
      }
    }
  }
  assert.deepEqual([...outcomes].sort(), ["pause_for_approval", "proceed", "refuse", "skip"]);
});

test("a permanent delete pauses under every policy, including the one that skips", () => {
  for (const policy of WORK_UNATTENDED_POLICIES) {
    for (const action of ["work.file.permanent_delete", "work.file.empty_trash"]) {
      const decision = decideUnattendedAction({ action, risk: "irreversible", policy });
      assert.equal(decision.outcome, "pause_for_approval", `${policy} / ${action}`);
    }
  }
  // And it pauses even when the caller understated the risk, because the action
  // identifier is what a permanent delete is recognised by.
  assert.equal(
    decideUnattendedAction({
      action: "work.file.permanent_delete",
      risk: "safe",
      policy: "skip_irreversible",
    }).outcome,
    "pause_for_approval"
  );
});

const PERMANENT_DELETES = new Set(["work.file.permanent_delete", "work.file.empty_trash"]);

test("every always-confirm action is treated as irreversible whatever risk was claimed", () => {
  for (const action of ALWAYS_CONFIRM_ACTIONS) {
    const decision = decideUnattendedAction({ action, risk: "safe", policy: "disallow_irreversible" });
    assert.equal(decision.outcome, PERMANENT_DELETES.has(action) ? "pause_for_approval" : "refuse", action);
  }
});

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-05T09:00:05Z");

function host(overrides: Partial<HostCapabilityView> = {}): HostCapabilityView {
  return {
    hostId: "host-1",
    displayName: "Liam's MacBook",
    state: "idle",
    enabled: true,
    revoked: false,
    capabilities: ["local_files", "local_apps"],
    ...overrides,
  };
}

function dispatchInput(overrides: Partial<ScheduleDispatchInput> = {}): ScheduleDispatchInput {
  return {
    now: NOW,
    spec: daily9,
    schedule: {
      enabled: true,
      target: "cloud",
      hostId: null,
      nextRunAt: new Date("2026-08-05T09:00:00Z"),
      lockedUntil: null,
      missedRunPolicy: "run_once",
      hostOfflinePolicy: "skip",
      maxConcurrentRuns: 1,
    },
    inFlightForSchedule: 0,
    inFlightForUser: 0,
    userConcurrencyCap: DEFAULT_USER_CONCURRENCY_CAP,
    hosts: [],
    requiredCapabilities: ["web_research"],
    cloudAvailable: true,
    remainingBudgetMicroUsd: 1_000_000,
    ...overrides,
  };
}

test("a due cloud schedule dispatches one run and advances", () => {
  const decision = planScheduleDispatch(dispatchInput());
  assert.equal(decision.outcome, "dispatch");
  if (decision.outcome !== "dispatch") throw new Error("unreachable");
  assert.equal(decision.fireAt.length, 1);
  assert.equal(decision.effectiveTarget, "cloud");
  assert.equal(decision.nextRunAt?.toISOString(), "2026-08-06T09:00:00.000Z");
});

test("a paused schedule and one that is not yet due both report not due", () => {
  assert.equal(planScheduleDispatch(dispatchInput({ schedule: { ...dispatchInput().schedule, enabled: false } })).outcome, "not_due");
  assert.equal(
    planScheduleDispatch(
      dispatchInput({ schedule: { ...dispatchInput().schedule, nextRunAt: new Date("2026-08-06T09:00:00Z") } })
    ).outcome,
    "not_due"
  );
  assert.equal(
    planScheduleDispatch(dispatchInput({ schedule: { ...dispatchInput().schedule, nextRunAt: null } })).outcome,
    "not_due"
  );
});

test("a schedule another scheduler holds is contended, not failed", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      schedule: { ...dispatchInput().schedule, lockedUntil: new Date(NOW.getTime() + 30_000) },
    })
  );
  assert.equal(decision.outcome, "contended");
});

test("concurrency delays rather than skips, and leaves the fire owed", () => {
  // The distinction the legacy scheduler cannot make: a delayed run happens by
  // itself, a skipped one never does, and both look identical if the schedule
  // is advanced either way.
  const perSchedule = planScheduleDispatch(dispatchInput({ inFlightForSchedule: 1 }));
  assert.equal(perSchedule.outcome, "delayed");

  const perUser = planScheduleDispatch(
    dispatchInput({ inFlightForUser: DEFAULT_USER_CONCURRENCY_CAP })
  );
  assert.equal(perUser.outcome, "delayed");
  if (perUser.outcome !== "delayed") throw new Error("unreachable");
  assert.ok(perUser.retryAt.getTime() > NOW.getTime());
});

test("a schedule with room for two runs is not delayed by the first", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      inFlightForSchedule: 1,
      schedule: { ...dispatchInput().schedule, maxConcurrentRuns: 2 },
    })
  );
  assert.equal(decision.outcome, "dispatch");
});

test("an exhausted budget is its own outcome and still advances the schedule", () => {
  const decision = planScheduleDispatch(dispatchInput({ remainingBudgetMicroUsd: 0 }));
  assert.equal(decision.outcome, "budget_blocked");
  if (decision.outcome !== "budget_blocked") throw new Error("unreachable");
  // Advancing matters: holding nextRunAt at a fire the budget will not permit
  // turns every tick into another attempt, and the backlog then all fires at
  // once the moment the budget resets.
  assert.equal(decision.nextRunAt?.toISOString(), "2026-08-06T09:00:00.000Z");
});

test("an unmetered account is never budget-blocked", () => {
  assert.equal(planScheduleDispatch(dispatchInput({ remainingBudgetMicroUsd: null })).outcome, "dispatch");
});

const localSchedule = {
  enabled: true,
  target: "local" as const,
  hostId: "host-1",
  nextRunAt: new Date("2026-08-05T09:00:00Z"),
  lockedUntil: null,
  missedRunPolicy: "run_once" as const,
  hostOfflinePolicy: "skip" as const,
  maxConcurrentRuns: 1,
};

test("a local schedule whose Mac is online dispatches to it", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      schedule: localSchedule,
      hosts: [host()],
      requiredCapabilities: ["local_files"],
    })
  );
  assert.equal(decision.outcome, "dispatch");
  if (decision.outcome !== "dispatch") throw new Error("unreachable");
  assert.equal(decision.effectiveTarget, "local");
  assert.equal(decision.hostId, "host-1");
});

test("hostOfflinePolicy wait holds the fire instead of losing it", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      schedule: { ...localSchedule, hostOfflinePolicy: "wait" },
      hosts: [host({ state: "offline" })],
      requiredCapabilities: ["local_files"],
    })
  );
  assert.equal(decision.outcome, "delayed");
  if (decision.outcome !== "delayed") throw new Error("unreachable");
  assert.match(decision.explanation, /offline/);
  assert.ok(decision.retryAt.getTime() > NOW.getTime());
});

test("hostOfflinePolicy skip moves the schedule on and says so", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      schedule: { ...localSchedule, hostOfflinePolicy: "skip" },
      hosts: [host({ state: "offline" })],
      requiredCapabilities: ["local_files"],
    })
  );
  assert.equal(decision.outcome, "skipped");
  if (decision.outcome !== "skipped") throw new Error("unreachable");
  assert.equal(decision.nextRunAt?.toISOString(), "2026-08-06T09:00:00.000Z");
});

test("hostOfflinePolicy cloud_subset runs the cloud part and records what was dropped", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      schedule: { ...localSchedule, hostOfflinePolicy: "cloud_subset" },
      hosts: [host({ state: "offline" })],
      requiredCapabilities: ["local_files", "web_research"],
    })
  );
  assert.equal(decision.outcome, "dispatch");
  if (decision.outcome !== "dispatch") throw new Error("unreachable");
  assert.equal(decision.effectiveTarget, "cloud");
  assert.ok(decision.degradation.some((entry) => entry.kind === "local_portion_skipped"));
});

test("cloud_subset with nothing the cloud can do is skipped, not dispatched empty", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      schedule: { ...localSchedule, hostOfflinePolicy: "cloud_subset" },
      hosts: [host({ state: "offline" })],
      requiredCapabilities: ["local_files"],
    })
  );
  assert.equal(decision.outcome, "skipped");
});

test("a schedule whose missed runs are all skipped reports skipped, not dispatch", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      now: new Date("2026-08-05T13:00:00Z"),
      schedule: {
        ...dispatchInput().schedule,
        missedRunPolicy: "skip",
        nextRunAt: new Date("2026-08-03T09:00:00Z"),
      },
    })
  );
  assert.equal(decision.outcome, "skipped");
  if (decision.outcome !== "skipped") throw new Error("unreachable");
  assert.equal(decision.dropped, 3);
});

test("a schedule catching up dispatches every owed fire under run_all", () => {
  const decision = planScheduleDispatch(
    dispatchInput({
      now: new Date("2026-08-05T13:00:00Z"),
      schedule: {
        ...dispatchInput().schedule,
        missedRunPolicy: "run_all",
        nextRunAt: new Date("2026-08-03T09:00:00Z"),
      },
    })
  );
  assert.equal(decision.outcome, "dispatch");
  if (decision.outcome !== "dispatch") throw new Error("unreachable");
  assert.equal(decision.fireAt.length, 3);
});

// ---------------------------------------------------------------------------
// Idempotency and serialisation
// ---------------------------------------------------------------------------

test("two schedulers racing on one fire mint the same idempotency key", () => {
  const fire = new Date("2026-08-05T09:00:00Z");
  assert.equal(scheduleRunIdempotencyKey("sch-1", fire), scheduleRunIdempotencyKey("sch-1", new Date(fire)));
  assert.notEqual(
    scheduleRunIdempotencyKey("sch-1", fire),
    scheduleRunIdempotencyKey("sch-1", new Date("2026-08-06T09:00:00Z"))
  );
  assert.notEqual(scheduleRunIdempotencyKey("sch-1", fire), scheduleRunIdempotencyKey("sch-2", fire));
});

function scheduleRow(overrides: Partial<WorkScheduleRow> = {}): WorkScheduleRow {
  return {
    id: "sch-1",
    sessionId: "ses-1",
    name: "Morning brief",
    enabled: true,
    instructions: "Summarise overnight email.",
    instructionsVersion: 2,
    target: "cloud",
    hostId: null,
    timezone: PARIS,
    runConfig: { model: "anthropic:claude" },
    runConfigVersion: 1,
    maxCostMicroUsd: 250_000,
    maxTokens: 0,
    maxRuntimeMs: 0,
    unattendedPolicy: "pause_for_approval",
    hostOfflinePolicy: "skip",
    maxConcurrentRuns: 1,
    notifyPolicy: "on_attention",
    missedRunPolicy: "run_once",
    retryPolicy: {},
    lastRunAt: new Date("2026-08-04T07:00:00Z"),
    nextRunAt: new Date("2026-08-05T07:00:00Z"),
    legacyScheduledTaskId: "task-9",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-08-04T07:00:05Z"),
    ...overrides,
  };
}

function triggerRow(overrides: Partial<WorkTriggerRow> = {}): WorkTriggerRow {
  return {
    id: "trg-1",
    kind: "daily",
    config: { hour: 9, minute: 0 },
    configVersion: 1,
    enabled: true,
    lastEventKey: "thread-abc",
    lastFiredAt: new Date("2026-08-04T07:00:00Z"),
    dedupeWindowSec: 3600,
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-08-04T07:00:00Z"),
    ...overrides,
  };
}

test("the wire shape carries the schedule and withholds the dispatcher's internals", () => {
  const wire = serializeSchedule(scheduleRow(), [triggerRow()]);
  assert.equal(wire.name, "Morning brief");
  assert.equal(wire.nextRunAt, "2026-08-05T07:00:00.000Z");
  assert.equal(wire.budget.maxCostMicroUsd, 250_000);
  assert.equal(wire.legacyScheduledTaskId, "task-9");
  assert.equal(wire.triggers.length, 1);

  const serialised = JSON.stringify(wire);
  // `lockedUntil` says when Juno's own dispatcher can be raced; `lastEventKey`
  // names the specific message a trigger last matched. Neither is a client's.
  assert.equal(serialised.includes("lockedUntil"), false);
  assert.equal(serialised.includes("thread-abc"), false);
});

test("the schedule's next fire is the soonest of its enabled time triggers", () => {
  const triggers = [
    triggerRow({ id: "a", kind: "daily", config: { hour: 18, minute: 0 } }),
    triggerRow({ id: "b", kind: "daily", config: { hour: 7, minute: 30 } }),
    triggerRow({ id: "c", kind: "daily", config: { hour: 6, minute: 0 }, enabled: false }),
    // Event triggers have no next fire, and a config this build cannot parse
    // must not stop the ones it can.
    triggerRow({ id: "d", kind: "email_filter", config: { from: ["billing@"] } }),
    triggerRow({ id: "e", kind: "daily", config: { hour: 99 } }),
  ];
  const next = nextFireForTriggers(triggers, PARIS, new Date("2026-08-05T00:00:00Z"));
  assert.equal(wall(next!, PARIS), "05/08/2026, 07:30");
});

test("a schedule with only event triggers has no next fire", () => {
  const next = nextFireForTriggers(
    [triggerRow({ kind: "email_filter", config: {} })],
    PARIS,
    new Date("2026-08-05T00:00:00Z")
  );
  assert.equal(next, null);
});
