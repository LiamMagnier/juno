import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveModel } from "../src/lib/models";
import { estimateCostUsd, recomputeCostMicroUsd, tokenRate } from "../src/lib/pricing";
import { getModelMetrics } from "../src/lib/model-metrics";
import {
  GEMINI_FLASH_PROMO_ENDS_AT,
  geminiFlashRate,
  isGeminiPromoFlash,
} from "../src/lib/scheduled-prices";

/*
 * Gemini 3.6/3.7/3.8 Flash bill at Google's promotional $0.75/$3.75 through
 * 2026-12-31 and $1.50/$7.50 from 2027-01-01 (ai.google.dev/gemini-api/docs/
 * pricing, read 2026-10-04). Both rate tables must flip at the same instant,
 * and a ledger row must keep the price of the day it was spent.
 */

const SWITCH = Date.UTC(2027, 0, 1, 0, 0, 0, 0);
const LAST_PROMO_MS = SWITCH - 1; // 2026-12-31T23:59:59.999Z
const PROMO_DAY = new Date("2026-10-04T12:00:00Z");
const PRICED_DAY = new Date("2027-03-01T12:00:00Z");
const FLASH = ["3.6", "3.7", "3.8"].map((v) => {
  const m = resolveModel(`google:gemini-${v}-flash`);
  assert.ok(m, v);
  return m;
});

test("the switch is 2027-01-01 00:00 UTC", () => {
  assert.equal(GEMINI_FLASH_PROMO_ENDS_AT, SWITCH);
  assert.equal(new Date(GEMINI_FLASH_PROMO_ENDS_AT).toISOString(), "2027-01-01T00:00:00.000Z");
  assert.deepEqual(geminiFlashRate(LAST_PROMO_MS), { input: 0.75, output: 3.75 });
  assert.deepEqual(geminiFlashRate(SWITCH), { input: 1.5, output: 7.5 });
  assert.deepEqual(geminiFlashRate(new Date(SWITCH)), { input: 1.5, output: 7.5 });
});

test("billing rate: promo before the switch, 2027 rate from it, cache reads at 10%", () => {
  for (const m of FLASH) {
    for (const at of [PROMO_DAY, LAST_PROMO_MS]) {
      const r = tokenRate(m, false, at);
      assert.equal(r.input, 0.75, m.id);
      assert.equal(r.output, 3.75, m.id);
      assert.ok(Math.abs(r.cacheRead - 0.075) < 1e-9, m.id);
    }
    for (const at of [SWITCH, PRICED_DAY]) {
      const r = tokenRate(m, false, at);
      assert.equal(r.input, 1.5, m.id);
      assert.equal(r.output, 7.5, m.id);
      assert.ok(Math.abs(r.cacheRead - 0.15) < 1e-9, m.id);
    }
  }
});

test("catalog metrics flip on the same instant as billing", () => {
  for (const m of FLASH) {
    const before = getModelMetrics(m, LAST_PROMO_MS);
    const after = getModelMetrics(m, SWITCH);
    assert.equal(before.inputUsdPerMTok, 0.75, m.id);
    assert.equal(before.outputUsdPerMTok, 3.75, m.id);
    assert.equal(after.inputUsdPerMTok, 1.5, m.id);
    assert.equal(after.outputUsdPerMTok, 7.5, m.id);
    // Only the price moves: context and grades are untouched.
    assert.equal(after.contextTokens, before.contextTokens);
    assert.equal(after.intelligence, before.intelligence);
    assert.equal(after.speed, before.speed);
    assert.equal(after.source, "official");
  }
});

test("a million in + a million out costs $4.50 in 2026 and $9.00 in 2027", () => {
  const m = FLASH[2];
  const u = { input: 1_000_000, output: 1_000_000 };
  assert.ok(Math.abs(estimateCostUsd(m, u, false, {}, PROMO_DAY) - 4.5) < 1e-9);
  assert.ok(Math.abs(estimateCostUsd(m, u, false, {}, PRICED_DAY) - 9) < 1e-9);
});

test("ledger repair keeps the price of the day the row was spent", () => {
  const resolve = (id: string) => resolveModel(id);
  // A 2026 row recomputed in 2027 must not be repriced (the repair writes up).
  assert.equal(recomputeCostMicroUsd("google:gemini-3.8-flash", 1_000_000, 1_000_000, resolve, PROMO_DAY), 4_500_000);
  assert.equal(recomputeCostMicroUsd("google:gemini-3.8-flash", 1_000_000, 1_000_000, resolve, PRICED_DAY), 9_000_000);
});

test("only the three Flash chat models are on the schedule", () => {
  for (const id of ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash", "models/gemini-3.8-flash-preview-11-2026"]) {
    assert.ok(isGeminiPromoFlash(id), id);
  }
  for (const id of ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3-flash-preview", "gemini-3.1-pro"]) {
    assert.ok(!isGeminiPromoFlash(id), id);
  }
  // Models without a scheduled change price the same on both sides.
  for (const id of ["google:gemini-3.5-flash", "google:gemini-3.1-flash-lite"]) {
    const m = resolveModel(id);
    // A retired model resolves to its replacement (models:sync), which may be
    // on the schedule: only a model still in the catalogue under its own id
    // is checked here.
    if (!m || m.id !== id) continue;
    assert.deepEqual(
      { i: tokenRate(m, false, PROMO_DAY).input, o: tokenRate(m, false, PROMO_DAY).output },
      { i: tokenRate(m, false, PRICED_DAY).input, o: tokenRate(m, false, PRICED_DAY).output },
      id
    );
  }
});
