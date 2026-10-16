import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTriggerDrafts } from "@/lib/work/triggers";
import { parseTimeTrigger } from "@/lib/work/schedule";
import {
  SCHEDULE_PHRASE_MESSAGES,
  describeTimeTrigger,
  parseSchedulePhrase,
  upcomingFires,
} from "@/lib/work/schedule-phrase";

/*
 * "Every weekday at 8am", read into a trigger the scheduler accepts.
 *
 * The cases are the sentences people actually type into ChatGPT's and Claude's
 * schedulers, and every accepted one is put back through the routes' own
 * trigger validation, because the whole value of the parser is that what it
 * returns is what gets stored.
 */

function read(phrase: string) {
  const result = parseSchedulePhrase(phrase);
  if (!result.ok) throw new Error(`${phrase} → ${result.reason}`);
  return result.schedule;
}

const CASES: ReadonlyArray<[string, string, Record<string, unknown>, boolean]> = [
  ["every weekday at 8am", "weekdays", { hour: 8, minute: 0 }, false],
  ["Every weekday at 8 AM", "weekdays", { hour: 8, minute: 0 }, false],
  ["weekdays at 7:30", "weekdays", { hour: 7, minute: 30 }, false],
  ["Mon-Fri 17:45", "weekdays", { hour: 17, minute: 45 }, false],
  ["monday to friday at 9", "weekdays", { hour: 9, minute: 0 }, false],
  ["every business day at 6pm", "weekdays", { hour: 18, minute: 0 }, false],
  ["every day at noon", "daily", { hour: 12, minute: 0 }, false],
  ["daily at 7:15pm", "daily", { hour: 19, minute: 15 }, false],
  ["every morning", "daily", { hour: 8, minute: 0 }, true],
  ["every evening at 7", "daily", { hour: 19, minute: 0 }, false],
  ["every night at 12", "daily", { hour: 0, minute: 0 }, false],
  ["each day at midnight", "daily", { hour: 0, minute: 0 }, false],
  ["every Monday at 9:30", "weekly", { weekday: 1, hour: 9, minute: 30 }, false],
  ["Fridays at 5pm", "weekly", { weekday: 5, hour: 17, minute: 0 }, false],
  ["every sunday night", "weekly", { weekday: 0, hour: 21, minute: 0 }, true],
  ["weekly on thursday at 10:00", "weekly", { weekday: 4, hour: 10, minute: 0 }, false],
  ["every week", "weekly", { weekday: 1, hour: 9, minute: 0 }, true],
  ["on the 1st of every month at 9am", "monthly", { monthday: 1, hour: 9, minute: 0 }, false],
  ["monthly on the 15th", "monthly", { monthday: 15, hour: 9, minute: 0 }, true],
  ["the last day of every month at 6pm", "monthly", { monthday: 31, hour: 18, minute: 0 }, false],
  ["every year on 14 February", "yearly", { month: 2, monthday: 14, hour: 9, minute: 0 }, true],
  ["every March 3rd at 8am", "yearly", { month: 3, monthday: 3, hour: 8, minute: 0 }, false],
  ["every hour", "hourly", { minute: 0 }, false],
  ["hourly at 15 past", "hourly", { minute: 15 }, false],
  ["every hour at quarter past", "hourly", { minute: 15 }, false],
];

test("the sentences people type become the trigger they mean", () => {
  for (const [phrase, kind, config, assumed] of CASES) {
    const schedule = read(phrase);
    assert.equal(schedule.kind, kind, phrase);
    assert.deepEqual(schedule.config, config, phrase);
    assert.equal(schedule.assumedTime, assumed, `${phrase}: assumed time`);
  }
});

test("several days, weekends and every N hours become cron lines the scheduler reads", () => {
  assert.deepEqual(read("every Monday and Thursday at 9"), { kind: "cron", config: { expression: "0 9 * * 1,4" }, assumedTime: false });
  assert.deepEqual(read("tue, wed and fri at 8:15am"), { kind: "cron", config: { expression: "15 8 * * 2,3,5" }, assumedTime: false });
  assert.deepEqual(read("every weekend at 10am"), { kind: "cron", config: { expression: "0 10 * * 0,6" }, assumedTime: false });
  assert.deepEqual(read("every 2 hours"), { kind: "cron", config: { expression: "0 */2 * * *" }, assumedTime: false });
  // All five working days named one by one is the weekday trigger, and all
  // seven is a daily one: the simplest kind that says it.
  assert.equal(read("monday tuesday wednesday thursday friday at 9").kind, "weekdays");
  assert.equal(read("every day of the week, mon to sun at 9").kind, "daily");
});

test("every accepted phrase is a trigger the routes would store unchanged", () => {
  const phrases = [...CASES.map(([phrase]) => phrase), "every Monday and Thursday at 9", "every weekend at 10am", "every 2 hours"];
  for (const phrase of phrases) {
    const schedule = read(phrase);
    const stored = normalizeTriggerDrafts([{ kind: schedule.kind, config: schedule.config }], "Europe/Paris");
    assert.equal(stored.ok, true, phrase);
    if (!stored.ok) continue;
    assert.deepEqual(stored.drafts[0].config, schedule.config, phrase);
    assert.equal(parseTimeTrigger(schedule.kind, schedule.config, "Europe/Paris").ok, true, phrase);
  }
});

test("a one-off, anything more often than hourly, and cadences it cannot express are refused by name", () => {
  const refused = (phrase: string) => {
    const result = parseSchedulePhrase(phrase);
    assert.equal(result.ok, false, phrase);
    return result.ok ? null : result.reason;
  };
  assert.equal(refused(""), "empty");
  assert.equal(refused("   "), "empty");
  assert.equal(refused("tomorrow at 9am"), "not_recurring");
  assert.equal(refused("at 8pm"), "not_recurring");
  assert.equal(refused("every 15 minutes"), "too_frequent");
  assert.equal(refused("every minute"), "too_frequent");
  assert.equal(refused("every half hour"), "too_frequent");
  // "The first Monday" read as "every Monday" would be four runs a month
  // where one was asked for, so it is refused rather than rounded.
  assert.equal(refused("the first Monday of every month"), "unrecognised");
  assert.equal(refused("every other week"), "unrecognised");
  assert.equal(refused("fortnightly on friday"), "unrecognised");
  assert.equal(refused("every hour between 9 and 5"), "unrecognised");
  assert.equal(refused("whenever you feel like it"), "unrecognised");
  assert.equal(refused("every day at 25:00"), "unrecognised");
  const message = parseSchedulePhrase("every 5 minutes");
  assert.equal(!message.ok && message.message, SCHEDULE_PHRASE_MESSAGES.too_frequent);
});

test("words that only look like days or months are not read as them", () => {
  // "month" is not "mon", "sunrise" is not "sun", and "may" is a verb unless a
  // day number sits beside it.
  assert.equal(read("on the 2nd of each month").kind, "monthly");
  assert.equal(read("every day at 7am if you may").kind, "daily");
  assert.equal(read("every 1 may at 9am").kind, "yearly");
});

test("the summary says back what will happen, including the cron lines a phrase produced", () => {
  assert.equal(describeTimeTrigger("weekdays", { hour: 8, minute: 0 }), "Every weekday at 08:00");
  assert.equal(describeTimeTrigger("weekly", { weekday: 1, hour: 9, minute: 30 }), "Every Monday at 09:30");
  assert.equal(describeTimeTrigger("monthly", { monthday: 1, hour: 9, minute: 0 }), "On the 1st of each month at 09:00");
  assert.equal(describeTimeTrigger("monthly", { monthday: 31, hour: 9, minute: 0 }), "On the last day of each month at 09:00");
  assert.equal(describeTimeTrigger("cron", { expression: "0 9 * * 1,4" }), "Every Monday and Thursday at 09:00");
  assert.equal(describeTimeTrigger("cron", { expression: "0 10 * * 0,6" }), "Every Saturday and Sunday at 10:00");
  assert.equal(describeTimeTrigger("cron", { expression: "0 */2 * * *" }), "Every 2 hours at 00 past");
  assert.equal(describeTimeTrigger("hourly", { minute: 15 }), "Every hour at 15 past");
});

test("the next runs are the scheduler's own next fires, in the routine's zone", () => {
  // Thursday 15 October 2026, 21:00 in Paris.
  const from = new Date("2026-10-15T19:00:00Z");
  const fires = upcomingFires("weekdays", { hour: 8, minute: 0 }, "Europe/Paris", from, 3);
  assert.deepEqual(
    fires.map((d) => d.toISOString()),
    // Friday, then Monday and Tuesday — the weekend is skipped — at 08:00
    // Paris, which is 06:00 UTC before the clocks change on the 25th.
    ["2026-10-16T06:00:00.000Z", "2026-10-19T06:00:00.000Z", "2026-10-20T06:00:00.000Z"]
  );
  // Across the October change 08:00 stays 08:00 on the wall.
  const afterChange = upcomingFires("daily", { hour: 8, minute: 0 }, "Europe/Paris", new Date("2026-10-24T12:00:00Z"), 2);
  assert.deepEqual(afterChange.map((d) => d.toISOString()), ["2026-10-25T07:00:00.000Z", "2026-10-26T07:00:00.000Z"]);
  assert.deepEqual(upcomingFires("weekly", { weekday: 9, hour: 8, minute: 0 }, "Europe/Paris", from), []);
});
