import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  buildWeeks,
  computeStreaks,
  cumulativeSeries,
  formatDays,
  formatDuration,
  formatTokens,
  heatLevel,
  heatThresholds,
  isValidTimeZone,
  monthLabels,
  profileHandle,
  rankModels,
  todayIn,
  weekdayMondayFirst,
  weeklyTotals,
} from "../src/lib/profile-activity";

test("day keys step across month, year and DST boundaries by whole days", () => {
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30"); // EU DST change
  assert.equal(addDays("2026-10-03", -7), "2026-09-26");
  assert.equal(weekdayMondayFirst("2026-10-05"), 0); // a Monday
  assert.equal(weekdayMondayFirst("2026-10-04"), 6); // a Sunday
});

test("today is cut in the reader's zone", () => {
  const instant = new Date("2026-10-03T23:30:00Z");
  assert.equal(todayIn("UTC", instant), "2026-10-03");
  assert.equal(todayIn("Europe/Paris", instant), "2026-10-04");
  assert.equal(todayIn("America/Los_Angeles", instant), "2026-10-03");
  assert.equal(isValidTimeZone("Europe/Paris"), true);
  assert.equal(isValidTimeZone("Not/AZone"), false);
  assert.equal(isValidTimeZone("UTC'; drop table"), false);
  assert.equal(isValidTimeZone(null), false);
});

test("streaks: current may end yesterday, longest is the longest run", () => {
  const today = "2026-10-03";
  assert.deepEqual(computeStreaks([], today), { current: 0, longest: 0 });
  assert.deepEqual(computeStreaks(["2026-10-01", "2026-10-02", "2026-10-03"], today), { current: 3, longest: 3 });
  // Quiet so far today: the run through yesterday still counts.
  assert.deepEqual(computeStreaks(["2026-10-01", "2026-10-02"], today), { current: 2, longest: 2 });
  // A gap of a full day breaks it.
  assert.deepEqual(computeStreaks(["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-10-01"], today), {
    current: 0,
    longest: 4,
  });
  // Duplicates and order do not matter; runs cross month ends.
  assert.deepEqual(computeStreaks(["2026-10-01", "2026-09-30", "2026-09-30", "2026-10-03"], today), { current: 1, longest: 2 });
});

test("the grid is 53 Monday-first weeks ending with today's week, future days empty", () => {
  const today = "2026-10-03"; // a Saturday
  const weeks = buildWeeks([{ date: "2026-10-01", tokens: 500 }], today);
  assert.equal(weeks.length, 53);
  assert.ok(weeks.every((w) => w.length === 7));
  const last = weeks[52];
  assert.equal(last[0]?.date, "2026-09-28");
  assert.equal(last[5]?.date, today);
  assert.equal(last[6], null);
  assert.equal(last[3]?.tokens, 500);
  assert.equal(weeks[0][0]?.date, addDays("2026-09-28", -52 * 7));
});

test("weekly totals sum each column; cumulative carries across quiet days", () => {
  const today = "2026-10-03";
  const days = [
    { date: "2026-09-21", tokens: 10 },
    { date: "2026-09-27", tokens: 5 },
    { date: "2026-09-29", tokens: 7 },
    { date: "2026-10-03", tokens: 3 },
  ];
  const weekly = weeklyTotals(buildWeeks(days, today, 2));
  assert.deepEqual(weekly, [
    { start: "2026-09-21", end: "2026-09-27", tokens: 15 },
    { start: "2026-09-28", end: "2026-10-03", tokens: 10 },
  ]);
  const cum = cumulativeSeries(days, "2026-09-28", today);
  assert.equal(cum.length, 6);
  assert.deepEqual(
    cum.map((p) => p.total),
    [0, 7, 7, 7, 7, 10]
  );
});

test("month labels sit on the column holding the 1st, without crowding the left edge", () => {
  const weeks = buildWeeks([], "2026-10-03");
  const labels = monthLabels(weeks);
  assert.equal(labels[labels.length - 1].label, "Oct");
  assert.equal(labels.filter((l) => l.label === "Oct").length, 2); // last October and this one
  for (let i = 1; i < labels.length; i++) assert.ok(labels[i].col - labels[i - 1].col >= 3);
  const oct = labels[labels.length - 1];
  assert.ok(weeks[oct.col].some((c) => c?.date === "2026-10-01"));
});

test("heat levels are quartiles of active days; quiet days are level 0", () => {
  const values = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 1_000_000];
  const t = heatThresholds(values);
  assert.equal(heatLevel(0, t), 0);
  assert.equal(heatLevel(1, t), 1);
  assert.equal(heatLevel(1_000_000, t), 4);
  // One huge day does not flatten the rest into the faintest step.
  assert.equal(heatLevel(5, t), 3);
  // A single active day reads at full strength.
  assert.equal(heatLevel(42, heatThresholds([0, 42, 0])), 4);
  assert.deepEqual(heatThresholds([0, 0]), [Infinity, Infinity, Infinity]);
});

test("token, duration and day formats", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatTokens(171_500_000), "171.5M");
  assert.equal(formatTokens(71_412_345), "71.4M");
  assert.equal(formatTokens(999_960), "1M");
  assert.equal(formatTokens(1_234_000_000), "1.2B");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(38 * 60_000), "38m");
  assert.equal(formatDuration(98 * 60_000), "1h 38m");
  assert.equal(formatDuration(2 * 3_600_000), "2h");
  assert.equal(formatDuration(28 * 3_600_000), "1d 4h");
  assert.equal(formatDays(1), "1 day");
  assert.equal(formatDays(2), "2 days");
  assert.equal(formatDays(0), "0 days");
});

test("the handle comes from the email's local part, never the domain", () => {
  assert.equal(profileHandle({ name: "Liam", email: "Liam.Magnier+alevr@example.com" }), "liam.magnier");
  assert.equal(profileHandle({ name: "Zoë Durand", email: null }), "zoe.durand");
  assert.equal(profileHandle({ name: null, email: null }), "you");
});

test("models rank by tokens with the tail folded into Other, shares summing to 1", () => {
  const rows = Array.from({ length: 8 }, (_, i) => ({
    model: `anthropic:m${i}`,
    label: `M${i}`,
    provider: "anthropic" as const,
    tokens: (i + 1) * 100,
    requests: 1,
  }));
  const ranked = rankModels([...rows, { model: "x", label: "Zero", provider: null, tokens: 0, requests: 3 }], 4);
  assert.equal(ranked.length, 4);
  assert.deepEqual(
    ranked.map((r) => r.label),
    ["M7", "M6", "M5", "5 other models"]
  );
  assert.ok(Math.abs(ranked.reduce((s, r) => s + r.share, 0) - 1) < 1e-9);
  assert.deepEqual(rankModels([]), []);
  // Exactly `top` rows: nothing is folded.
  assert.equal(rankModels(rows.slice(0, 4), 4).length, 4);
});
