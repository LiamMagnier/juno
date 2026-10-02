import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { formatDate, formatDuration } from "@/lib/i18n-format";

/*
 * Locale-aware formatting through Intl (SPEC §10.2).
 *
 * WS0 landed it complete except the store-backed `useUiLocale`; these are its
 * duration and date checks in English. WS5 owns this file and adds the cases
 * with and without `Intl.DurationFormat`, the other locales, and the
 * `research-run-clock` cases it inherits.
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
