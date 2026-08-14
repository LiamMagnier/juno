import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeNextRunAt,
  onceRunInstant,
  type TaskScheduleInput,
} from "@/lib/scheduled-task-cadence";

/*
 * The cadence math, pinned against the cases production discovers for you:
 * the Paris hour in March that does not exist, the hour in October that
 * happens twice, and — new with the ONCE cadence — the property the runner's
 * atomic claim depends on: computeNextRunAt never answers with an instant at
 * or before `from`, even for a one-off whose moment has passed.
 */

function schedule(overrides: Partial<TaskScheduleInput> = {}): TaskScheduleInput {
  return {
    cadence: "DAILY",
    hour: 8,
    minute: 0,
    weekday: null,
    monthday: null,
    onDate: null,
    timezone: "Europe/Paris",
    ...overrides,
  };
}

// A Friday morning, Paris on summer time (UTC+2).
const FROM = new Date("2026-08-14T05:00:00Z");

describe("recurring cadences", () => {
  it("DAILY picks today's slot while it is still ahead", () => {
    const next = computeNextRunAt(schedule(), FROM);
    assert.equal(next.toISOString(), "2026-08-14T06:00:00.000Z"); // 08:00 CEST
  });

  it("WEEKLY lands on the requested weekday, strictly after `from`", () => {
    const next = computeNextRunAt(schedule({ cadence: "WEEKLY", weekday: 1, hour: 9 }), FROM);
    assert.equal(next.toISOString(), "2026-08-17T07:00:00.000Z"); // Mon 09:00 CEST
  });

  it("MONTHLY rolls into next month once this month's day has passed", () => {
    const next = computeNextRunAt(schedule({ cadence: "MONTHLY", monthday: 1 }), FROM);
    assert.equal(next.toISOString(), "2026-09-01T06:00:00.000Z");
  });
});

describe("ONCE cadence", () => {
  it("fires at exactly the named instant while it lies ahead", () => {
    const s = schedule({ cadence: "ONCE", onDate: "2026-08-20", hour: 9, minute: 30 });
    assert.equal(onceRunInstant(s)?.toISOString(), "2026-08-20T07:30:00.000Z"); // CEST
    assert.equal(computeNextRunAt(s, FROM).toISOString(), "2026-08-20T07:30:00.000Z");
  });

  it("resolves through the task's timezone, not the server's", () => {
    // Tokyo has no DST: 09:00 JST is 00:00Z year-round.
    const s = schedule({ cadence: "ONCE", onDate: "2027-01-15", hour: 9, timezone: "Asia/Tokyo" });
    assert.equal(onceRunInstant(s)?.toISOString(), "2027-01-15T00:00:00.000Z");
  });

  it("lands a nonexistent spring-forward time on the adjacent valid instant", () => {
    // Paris, 28 Mar 2027: 02:00 jumps to 03:00 — 02:30 never happens. The
    // guess-and-correct lands on 00:30Z (01:30 CET, the valid instant next
    // door), exactly as it does for the recurring cadences.
    const s = schedule({ cadence: "ONCE", onDate: "2027-03-28", hour: 2, minute: 30 });
    assert.equal(onceRunInstant(s)?.toISOString(), "2027-03-28T00:30:00.000Z");
  });

  it("resolves an ambiguous fall-back time to a single instant", () => {
    // Paris, 25 Oct 2026: 02:30 happens twice. Any one deterministic pick is
    // correct for a schedule; both candidates are 00:30Z (CEST) or 01:30Z (CET).
    const s = schedule({ cadence: "ONCE", onDate: "2026-10-25", hour: 2, minute: 30 });
    const at = onceRunInstant(s)?.toISOString();
    assert.ok(at === "2026-10-25T00:30:00.000Z" || at === "2026-10-25T01:30:00.000Z", String(at));
  });

  it("never answers at or before `from` once the instant has passed", () => {
    // The runner's claim bump writes computeNextRunAt back into nextRunAt to
    // take the task off every worker's due list; a past answer would leave a
    // fired one-off claimable twice. The +24h make-up only ever fires if the
    // process died mid-run, matching a missed recurring slot.
    const s = schedule({ cadence: "ONCE", onDate: "2026-08-10", hour: 8 });
    const next = computeNextRunAt(s, FROM);
    assert.ok(next.getTime() > FROM.getTime());
    assert.equal(next.toISOString(), "2026-08-15T05:00:00.000Z");
  });

  it("rejects dates that don't exist instead of letting Date.UTC roll them over", () => {
    assert.equal(onceRunInstant(schedule({ cadence: "ONCE", onDate: "2027-02-31" })), null);
    assert.equal(onceRunInstant(schedule({ cadence: "ONCE", onDate: "2027-13-01" })), null);
    assert.equal(onceRunInstant(schedule({ cadence: "ONCE", onDate: "someday" })), null);
    assert.equal(onceRunInstant(schedule({ cadence: "ONCE" })), null);
    // Malformed rows still schedule AFTER `from` — a broken one-off must not
    // wedge the worker's due scan into a hot loop.
    const next = computeNextRunAt(schedule({ cadence: "ONCE", onDate: "someday" }), FROM);
    assert.ok(next.getTime() > FROM.getTime());
  });
});
