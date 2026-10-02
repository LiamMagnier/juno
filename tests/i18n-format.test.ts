import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RunClock, clockElapsedMs } from "@/components/chat/run/run-clock";
import {
  UiLocaleOverride,
  formatClock,
  formatCurrencyEur,
  formatDate,
  formatDuration,
  formatElapsed,
  formatList,
  formatNumber,
  getUiLocale,
  setUiLocale,
  useUiLocale,
} from "@/lib/i18n-format";

/*
 * Locale-aware formatting through Intl (SPEC §10.2).
 *
 * WS0 landed it complete except the store-backed `useUiLocale`; WS5 owns this
 * file and adds the cases with and without `Intl.DurationFormat`, the other
 * locales, the published UI locale, and the `research-run-clock` cases it
 * inherits: the clock that holds at a gate or a pause and never runs negative
 * is now `RunClock`'s arithmetic (the DTO's `workingMs` already excludes the
 * parked time), and its figure is `formatElapsed`.
 */

test("the formatters stay importable from client components", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/i18n-format.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});

test("durations and dates through Intl", () => {
  assert.equal(formatDuration(12_000, "narrow", "en"), "12s");
  assert.equal(formatDuration(64_400, "narrow", "en"), "1m 4s");
  assert.equal(formatDuration(3_600_000 + 5_000, "narrow", "en"), "1h 5s", "the two largest non-zero units");
  assert.equal(formatDuration(3_725_000, "narrow", "en"), "1h 2m", "never three units");
  assert.equal(formatDuration(0, "narrow", "en"), "0s");
  assert.equal(formatDuration(64_900, "digital", "en"), "1:04", "the live clock floors");
  assert.equal(formatDuration(3_725_000, "digital", "en"), "1:02:05");
  assert.match(formatDuration(64_000, "long", "en"), /1 minute,? 4 seconds/);
  assert.equal(formatDuration(-5, "narrow", "not a locale"), "0s");
  assert.equal(formatDate("2026-09-23T12:00:00Z", "medium", "en", "UTC"), "Sep 23, 2026");
  assert.equal(formatDate("not a date", "medium", "en"), "");
});

test("the same durations without Intl.DurationFormat (older Safari)", () => {
  const intl = Intl as unknown as { DurationFormat?: unknown };
  const saved = intl.DurationFormat;
  delete intl.DurationFormat;
  try {
    assert.equal(formatDuration(12_000, "narrow", "en"), "12s");
    assert.equal(formatDuration(64_400, "narrow", "en"), "1m 4s");
    assert.equal(formatDuration(3_725_000, "narrow", "en"), "1h 2m");
    assert.equal(formatDuration(64_000, "long", "en"), "1 minute, 4 seconds");
    assert.equal(formatDuration(12_000, "narrow", "de"), "12 Sek.");
    assert.equal(formatDuration(0, "narrow", "en"), "0s");
  } finally {
    intl.DurationFormat = saved;
  }
});

test("rounding never prints sixty of a unit", () => {
  // research-UI bug 22: floor minutes + round seconds printed "1m 60s".
  assert.equal(formatDuration(119_600, "narrow", "en"), "2m");
  assert.equal(formatDuration(59_600, "narrow", "en"), "1m");
  assert.equal(formatDuration(3_599_700, "narrow", "en"), "1h");
  assert.equal(formatDuration(119_999, "digital", "en"), "1:59", "digital floors");
});

test("other locales", () => {
  assert.equal(formatDuration(12_000, "narrow", "de"), "12 Sek.");
  assert.equal(formatDuration(64_900, "digital", "ar-EG").length > 0, true);
  assert.equal(formatNumber(1_234.5, "de"), "1.234,5");
  assert.equal(formatNumber(1_234.5, "fr").replace(/\s/g, " "), "1 234,5");
  assert.equal(formatDate("2026-09-23T12:00:00Z", "medium", "de", "UTC"), "23.09.2026");
  assert.equal(formatDate("2026-09-23T12:00:00Z", "short", "en", "Not/AZone"), formatDate("2026-09-23T12:00:00Z", "short", "en"));
  assert.equal(formatClock(new Date("2026-09-23T14:02:00Z"), "en-GB", "UTC"), "14:02");
  assert.equal(formatClock(new Date("2026-09-23T14:02:00Z"), "en-US", "UTC"), "2:02 PM");
  assert.equal(formatClock(new Date("nope"), "en"), "");
  assert.equal(formatList(["a", "b", "c"], "en"), "a, b, and c");
  assert.equal(formatList(["a", "b"], "de"), "a und b");
  assert.equal(formatCurrencyEur(2_500_000, 0.9, "en"), "€2.25");
  assert.equal(formatCurrencyEur(1, 0.9, "en"), "<€0.01", "a real charge never reads as free");
  assert.equal(formatCurrencyEur(0, 0.9, "en"), "€0.00");
});

test("the live elapsed figure: narrow under a minute, digital from one, floored", () => {
  assert.equal(formatElapsed(0, "en"), "0s");
  assert.equal(formatElapsed(3_999, "en"), "3s");
  assert.equal(formatElapsed(59_999, "en"), "59s");
  assert.equal(formatElapsed(60_000, "en"), "1:00");
  assert.equal(formatElapsed(64_900, "en"), "1:04");
  assert.equal(formatElapsed(3_725_000, "en"), "1:02:05");
  assert.equal(formatElapsed(-10, "en"), "0s");
});

test("the UI locale is published once and read everywhere; a gallery can override it", () => {
  function Probe() {
    return React.createElement("span", null, useUiLocale());
  }
  assert.equal(renderToStaticMarkup(React.createElement(Probe)), "<span>en</span>", "English during SSR");
  assert.equal(
    renderToStaticMarkup(React.createElement(UiLocaleOverride.Provider, { value: "de" }, React.createElement(Probe))),
    "<span>de</span>",
  );
  setUiLocale("pt-br");
  try {
    assert.equal(getUiLocale(), "pt-BR", "canonicalised");
  } finally {
    setUiLocale("en");
  }
  setUiLocale("not a locale");
  assert.equal(getUiLocale(), "en");
});

// ── The research-run-clock cases, on the clock that replaces it ───────────────

const T0 = Date.parse("2026-09-17T10:00:00.000Z");
const MIN = 60_000;

test("time parked at a gate is not counted: the clock holds", () => {
  // The DTO's workingMs was 5 minutes when the run parked; overnight changes nothing.
  assert.equal(clockElapsedMs(5 * MIN, null, T0 + 600 * MIN), 5 * MIN);
});

test("a paused run's clock holds, and resumes where it left off", () => {
  assert.equal(clockElapsedMs(4 * MIN, null, T0 + 24 * MIN), 4 * MIN);
  // Resumed at T0 + 24 min: it counts on from four.
  assert.equal(clockElapsedMs(4 * MIN, T0 + 24 * MIN, T0 + 25 * MIN), 5 * MIN);
});

test("a lagging page freezes rather than over-counts", () => {
  // No `since` until the fetched DTO says the run works again.
  assert.equal(clockElapsedMs(2 * MIN, null, T0 + 30 * MIN), 2 * MIN);
});

test("a clock skewed behind the server never goes negative", () => {
  assert.equal(clockElapsedMs(0, T0 + 5_000, T0), 0);
  assert.equal(clockElapsedMs(-5_000, T0, T0 + 1_000), 1_000);
});

test("malformed inputs hold rather than being trusted", () => {
  assert.equal(clockElapsedMs(Number.NaN, T0, T0 + MIN), MIN);
  assert.equal(clockElapsedMs(MIN, Number.NaN, T0), MIN);
  assert.equal(clockElapsedMs(MIN, T0, Number.NaN), MIN);
});

test("the clock leaf renders the held figure on the server, hidden before its threshold", () => {
  const held = renderToStaticMarkup(React.createElement(RunClock, { elapsedMs: 64_000, since: null }));
  assert.match(held, /aria-hidden="true"/);
  assert.match(held, />1:04</);
  assert.doesNotMatch(held, /invisible/);
  const early = renderToStaticMarkup(React.createElement(RunClock, { elapsedMs: 1_000, since: null, showAfterMs: 3_000 }));
  assert.match(early, /invisible/, "kept in place, not unmounted");
});
