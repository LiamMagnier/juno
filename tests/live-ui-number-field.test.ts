import test from "node:test";
import assert from "node:assert/strict";
import { decimalSeparator, editableNumberString, parseLiveNumber } from "@/lib/live-ui/format";
import { parseLiveUI, stepNumberInput } from "@/lib/live-ui/spec";
import { restoreLiveState, storedLiveState } from "@/components/chat/live-ui/use-live-state";

/* A Live UI view's number field and its locked cards (docs/design/LIVE_UI.md):
   how typed digits are read in the reader's locale, what the arrow keys show
   at a bound, and what a reload keeps of a pick. */

test("a typed number is read the way the reader's locale writes one", () => {
  assert.equal(decimalSeparator("en-US"), ".");
  assert.equal(decimalSeparator("fr-FR"), ",");
  assert.equal(decimalSeparator("de-DE"), ",");

  // en-US: a period is the decimal, a comma groups thousands — today's reading.
  assert.equal(parseLiveNumber("12.5", "en-US"), 12.5);
  assert.equal(parseLiveNumber("12,500", "en-US"), 12500);
  assert.equal(parseLiveNumber("$12,500.75", "en-US"), 12500.75);
  assert.equal(parseLiveNumber("-3.25", "en-US"), -3.25);

  // fr-FR: a comma is the decimal; spaces (including the narrow no-break
  // space Intl itself writes) group thousands.
  assert.equal(parseLiveNumber("12,5", "fr-FR"), 12.5);
  assert.equal(parseLiveNumber("12 500,75", "fr-FR"), 12500.75);
  assert.equal(parseLiveNumber(new Intl.NumberFormat("fr-FR").format(12500.75), "fr-FR"), 12500.75);
  assert.equal(parseLiveNumber("12,5 €", "fr-FR"), 12.5);

  // de-DE: a comma is the decimal, a period groups thousands.
  assert.equal(parseLiveNumber("12,5", "de-DE"), 12.5);
  assert.equal(parseLiveNumber("12.500", "de-DE"), 12500);
  assert.equal(parseLiveNumber("12.500,75", "de-DE"), 12500.75);
  assert.equal(parseLiveNumber(new Intl.NumberFormat("de-DE").format(-1234.5), "de-DE"), -1234.5);

  for (const locale of ["en-US", "fr-FR", "de-DE"]) {
    assert.equal(parseLiveNumber("", locale), null);
    assert.equal(parseLiveNumber("  ", locale), null);
    assert.equal(parseLiveNumber("abc", locale), null);
    // What the field puts in the box on focus reads back as the same value.
    for (const value of [0, 12.5, -0.01, 1234567.25]) {
      assert.equal(parseLiveNumber(editableNumberString(value, locale), locale), value, `${locale} ${value}`);
    }
  }
  assert.equal(editableNumberString(12.5, "fr-FR"), "12,5");
  assert.equal(editableNumberString(12.5, "en-US"), "12.5");
});

test("ArrowUp and ArrowDown at a bound show the clamped value, not the step past it", () => {
  const bounds = { step: 5, min: 0, max: 12 };
  assert.equal(stepNumberInput(10, 1, bounds), 12);
  assert.equal(stepNumberInput(12, 1, bounds), 12);
  assert.equal(stepNumberInput(2, -1, bounds), 0);
  assert.equal(stepNumberInput(5, 1, bounds), 10);
  // Float dust from the step does not reach the box.
  assert.equal(stepNumberInput(0.1, 1, { step: 0.2 }), 0.3);
  assert.equal(stepNumberInput(-4, -1, { step: 1 }), -5);
});

test("a choice or compare pick survives a reload, and older stored state still reads", () => {
  const { spec } = parseLiveUI(
    JSON.stringify({
      ui: [
        { type: "slider", id: "n", label: "N", min: 0, max: 10, value: 2 },
        { type: "choices", question: "Which?", options: ["A", "B"] },
        { type: "section", children: [{ type: "compare", options: [{ name: "X", prompt: "X" }, { name: "Y", prompt: "Y" }] }] },
      ],
    }),
  );
  assert.ok(spec);
  const choiceKey = spec.ui[1].key;
  const section = spec.ui[2];
  assert.equal(section.type, "section");
  if (section.type !== "section") return;
  const compareKey = section.children[0].key;

  // A pick alone is worth storing: the card must stay locked after a reload.
  const stored = storedLiveState({ touched: {}, defaults: { n: 2 }, checks: {}, picks: { [choiceKey]: [1], [compareKey]: [0] }, dirty: false });
  assert.ok(stored);
  const restored = restoreLiveState(JSON.parse(JSON.stringify(stored)), spec);
  assert.deepEqual(restored.picks, { [choiceKey]: [1], [compareKey]: [0] });

  // Nothing touched and nothing picked: nothing stored, as before.
  assert.equal(storedLiveState({ touched: {}, defaults: { n: 2 }, checks: {}, picks: {}, dirty: false }), null);

  // State written before picks existed restores its values and no picks.
  const legacy = restoreLiveState({ v: { n: 7 }, c: {} }, spec);
  assert.deepEqual(legacy.values, { n: 7 });
  assert.deepEqual(legacy.picks, {});

  // A pick for a card or an option that is no longer there is dropped.
  const stale = restoreLiveState({ p: { [choiceKey]: [5], "9.9": [0], [compareKey]: ["x" as unknown as number] } }, spec);
  assert.deepEqual(stale.picks, {});
});
