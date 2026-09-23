/**
 * Settings' number and date formatting (src/components/settings/format.ts)
 * must render the same text on the server and in the hydrating browser.
 *
 * `/settings?section=billing` is server-rendered. Formatting in "the default
 * locale" and "local time" meant the Node process's on the server and the
 * reader's in the browser, so a German browser, or a reader in Tokyo, got a
 * hydration failure and the whole pane re-rendered from scratch. The server
 * pass now formats in one fixed locale and zone; the browser switches to the
 * reader's own right after hydration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { formatDate, formatEur, formatEurWhole } from "@/components/settings/format";

const SERVER = { locale: "en-US", timeZone: "UTC" };
// 15:00 UTC on 3 October: already 4 October in Tokyo.
const RENEWAL = Date.UTC(2026, 9, 3, 15, 0, 0);

test("the server format does not depend on the process's time zone", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    const tokyo = formatDate(RENEWAL, SERVER);
    process.env.TZ = "America/Los_Angeles";
    const losAngeles = formatDate(RENEWAL, SERVER);
    assert.equal(tokyo, "Oct 3, 2026");
    assert.equal(losAngeles, tokyo);
  } finally {
    process.env.TZ = original;
  }
});

test("the server format does not depend on the process's locale", () => {
  assert.equal(formatEurWhole(20, SERVER), "€20");
  assert.equal(formatEur(28.94, SERVER), "€28.94");
  assert.equal(formatEur(0.004, SERVER), "<€0.01");
});

test("the reader's own locale is used when one is given", () => {
  assert.equal(formatEur(28.94, { locale: "de-DE" }).replace(/\s/g, " "), "28,94 €");
});

test("every amount and date the Billing section prints goes through the hydration-safe format", () => {
  const billing = fs.readFileSync(path.join(process.cwd(), "src/components/settings/sections/billing.tsx"), "utf8");
  const calls = billing.match(/\bformat(?:Eur|EurWhole|Date|ResetMoment)\([^()]*(?:\([^()]*\)[^()]*)*\)/g) ?? [];
  assert.ok(calls.length >= 5, "the section still formats its amounts and dates here");
  for (const call of calls) {
    assert.ok(/, formatAt\)$/.test(call), `${call} formats without the hydration-safe locale`);
  }
});
