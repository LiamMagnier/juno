import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chipLabelLadder, chipMarkedName, chipShortName, pickChipLabel, wordTrims, type ChipLabel } from "../src/lib/model-chip-label";
import { nextSpeedTier, speedTierAction } from "../src/components/chat/reasoning-slider";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the short name drops only the family word a lab mark already says", () => {
  assert.equal(chipShortName("Claude Opus 5.5"), "Opus 5.5");
  assert.equal(chipShortName("Gemini 3.5 Flash-Lite"), "3.5 Flash-Lite");
  assert.equal(chipShortName("GPT-6.1 Sol"), "GPT-6.1 Sol");
  assert.equal(chipShortName("Kimi K3.1 Pro"), "Kimi K3.1 Pro");
});

test("word trims cut at word boundaries, with a tight ellipsis and no dangling punctuation", () => {
  assert.deepEqual(wordTrims("Muse Spark 1.3 Contributor"), ["Muse Spark 1.3…", "Muse Spark…", "Muse…"]);
  assert.deepEqual(wordTrims("Grok 4.20 (Reasoning)"), ["Grok 4.20…", "Grok…"]);
  // A trim that leaves only a number says nothing.
  assert.deepEqual(wordTrims("3.5 Flash-Lite"), []);
  assert.deepEqual(wordTrims("Auto"), []);
  for (const trim of wordTrims("Kimi K2.7 Code High-Speed")) {
    assert.match(trim, /\S…$/, `"${trim}" ends on a word, never on a space`);
    assert.doesNotMatch(trim, /\s…/);
  }
});

test("the ladder steps down: mark, short name, no mark, the mark's own prefix, no effort, then whole-word trims", () => {
  const phone = chipLabelLadder("GPT-6.1 Sol", { phone: true, effort: true });
  assert.deepEqual(phone, [
    { mark: true, text: "GPT-6.1 Sol", effort: true },
    { mark: false, text: "GPT-6.1 Sol", effort: true },
    // The OpenAI mark says "GPT": the whole name, a dozen pixels narrower.
    { mark: true, text: "6.1 Sol", effort: true },
    { mark: false, text: "GPT-6.1 Sol", effort: false },
    { mark: true, text: "6.1 Sol", effort: false },
    { mark: false, text: "GPT-6.1…", effort: false },
  ]);
  // A name with nothing the mark says has no such rung.
  assert.equal(chipLabelLadder("Kimi K3.1 Pro", { phone: true, effort: true }).filter((l) => l.mark).length, 1);
  assert.equal(chipMarkedName("GPT-5.6 Sol"), "5.6 Sol");
  assert.equal(chipMarkedName("Claude Opus 5.5"), "Opus 5.5");
  assert.equal(chipMarkedName("GPT Image 2"), "GPT Image 2", "only a version follows the prefix that goes");
  // A wide screen starts on the full name and tries the short one before the mark goes.
  const desktop = chipLabelLadder("Claude Opus 5.5", { phone: false, effort: false });
  assert.deepEqual(desktop.slice(0, 3), [
    { mark: true, text: "Claude Opus 5.5", effort: false },
    { mark: true, text: "Opus 5.5", effort: false },
    { mark: false, text: "Opus 5.5", effort: false },
  ]);
  // Without an effort label there is no "drop the effort" rung.
  assert.equal(
    chipLabelLadder("Kimi K3.1 Pro", { phone: true, effort: false }).filter((l) => l.text === "Kimi K3.1 Pro").length,
    2,
  );
  // Every trimmed rung has already given up the effort and the mark.
  for (const rung of chipLabelLadder("Muse Spark 1.3 Contributor", { phone: true, effort: true })) {
    if (rung.text.endsWith("…")) assert.deepEqual([rung.mark, rung.effort], [false, false]);
  }
});

test("with Pro after the name, the name is never trimmed: the mark stands alone before it does", () => {
  const ladder = chipLabelLadder("GPT-5.6 Sol", { phone: true, effort: true, suffix: true });
  for (const rung of ladder) assert.doesNotMatch(rung.text, /…$/, `"${rung.text}" is not followed by "Pro" cut short`);
  assert.deepEqual(ladder[ladder.length - 1], { mark: true, text: "", effort: false });
  assert.deepEqual(ladder[ladder.length - 2], { mark: true, text: "5.6 Sol", effort: false });
  // Without Pro the trims are still there.
  assert.ok(chipLabelLadder("GPT-5.6 Sol", { phone: true, effort: true }).some((l) => l.text === "GPT-5.6…"));
  // The chip asks for it with Pro on, and drops the space before "Pro" when the name has stepped out.
  const selector = read("src/components/chat/model-selector.tsx");
  assert.match(selector, /chipLabelLadder\(name, \{ phone, effort: !!effortLabel, suffix: pro \}\)/);
  assert.match(selector, /fit && fit\.text === "" \? "Pro" : " Pro"/);
});

test("the chip prints the first rung that fits, else the tightest", () => {
  const ladder: ChipLabel[] = chipLabelLadder("Muse Spark 1.3 Contributor", { phone: true, effort: true });
  const width = (l: ChipLabel) => l.text.length * 7 + (l.mark ? 20 : 0) + (l.effort ? 60 : 0);
  assert.equal(pickChipLabel(ladder, (l) => width(l) <= 1000), 0);
  const at = pickChipLabel(ladder, (l) => width(l) <= 110);
  assert.equal(ladder[at].text, "Muse Spark 1.3…");
  assert.equal(pickChipLabel(ladder, () => false), ladder.length - 1);
});

test("the speed control's tooltip names the next step and its price", () => {
  const prices = { fast: 2, ultra: 6 };
  assert.equal(speedTierAction("off", nextSpeedTier("off", { fast: true, ultra: true }), prices), "Turn on Fast · 2× price");
  assert.equal(speedTierAction("fast", nextSpeedTier("fast", { fast: true, ultra: true }), prices), "Switch to Ultra fast · 6× price");
  assert.equal(speedTierAction("ultra", nextSpeedTier("ultra", { fast: true, ultra: true }), prices), "Turn off Ultra fast");
  assert.equal(speedTierAction("fast", nextSpeedTier("fast", { fast: true, ultra: false }), prices), "Turn off Fast");
  assert.equal(speedTierAction("off", nextSpeedTier("off", { fast: false, ultra: true }), prices), "Turn on Ultra fast · 6× price");
});

test("the panel's speed toggle is named for the setting, not for its current state", () => {
  const slider = read("src/components/chat/reasoning-slider.tsx");
  assert.match(slider, /aria-label=\{speedTier === "ultra" \? "Ultra fast mode" : "Fast mode"\}/);
  assert.doesNotMatch(slider, /aria-label=\{speedTierLabel\(speedTier/);
  // Reset uses the product's tooltip and names the rung it returns to.
  assert.doesNotMatch(slider, /title="Reset to the model's default"/);
  assert.match(slider, /Reset to default \(\$\{defaultLabel\}\)/);
  assert.match(slider, /aria-label=\{`Change model, currently \$\{panel\.modelName\}`\}/);
});

test("paid modes reach the closed chip from what the request will run with", () => {
  const composer = read("src/components/chat/composer.tsx");
  assert.match(composer, /const chipSpeed: SpeedTier =\s*ultraFast && ultraFastRate != null \? "ultra" : fastMode && canFastMode \? "fast" : "off";/);
  assert.match(composer, /const chipPro = proMode && canProMode;/);
  assert.match(composer, /speed=\{chipSpeed\}\s*pro=\{chipPro\}/);
  const selector = read("src/components/chat/model-selector.tsx");
  assert.match(selector, /<SpeedGlyph/);
  assert.match(selector, /modes\.map\(\(mode\) => `, \$\{mode\}`\)/, "the accessible name says the paid modes");
});

test("the chip sits in a flex slot, so its own min-w-0 holds and it cannot spill under the mic", () => {
  const composer = read("src/components/chat/composer.tsx");
  assert.match(composer, /<div className=\{cn\("flex min-w-0", controlsLocked && "pointer-events-none"\)\}>\s*<ModelSelector/);
  assert.match(read("src/components/ui/composer-shell.tsx"), /data-composer-row=""/);
});

test("a catalogue chunk that fails to load stays inside the popover, with a retry", () => {
  const selector = read("src/components/chat/model-selector.tsx");
  assert.doesNotMatch(selector, /from "next\/dynamic"/, "React.lazy remembers a failure and throws it to the route");
  assert.match(selector, /catalogueRequest = null;\s*throw error;/, "a failed import is forgotten, so a retry refetches");
  assert.match(selector, /class CatalogueBoundary extends React\.Component/);
  assert.match(selector, /<CatalogueUnavailable/);
  assert.doesNotMatch(selector, /import\s+\{[^}]*\}\s+from\s+"@\/components\/chat\/model-catalogue"/, "no static import undoes the split");
});

test("the catalogue opens past models that hold the selection, and lights the first search result", () => {
  const catalogue = read("src/components/chat/model-catalogue.tsx");
  assert.match(catalogue, /legacyToggles\.get\(g\.key \|\| g\.label\) \?\? g\.legacy\.some\(\(m\) => m\.id === value\)/);
  assert.match(catalogue, /if \(legacyOpen\(g\)\) for \(const m of g\.legacy\) push\(`\$\{g\.key\}legacy:`, m\);/);
  // The cursor may rest on a "Past models" switch too (an option row of its own).
  assert.match(catalogue, /const cursor = cursorKey && \(byKey\.has\(cursorKey\) \|\| toggles\.has\(cursorKey\)\) \? cursorKey : q \? \(order\[0\] \?\? null\) : null;/);
  // Phone rows: the facts behind an ⓘ, a retiring model's warning on the row.
  assert.match(catalogue, /sheet=\{\{ onBack: closeInfo, backRef: infoBackRef \}\}/);
  assert.match(catalogue, /retiring && <span className="text-caption text-warning sm:hidden">/);
  assert.doesNotMatch(catalogue, /<dt>In \/ MTok<\/dt>/, "the cost is said once");
  assert.doesNotMatch(catalogue, /caps\.join\(" · "\)/);
});

test("the + menu's trigger is the outer one, so the button reports the menu's state", () => {
  const plus = read("src/components/chat/composer-plus-menu.tsx");
  assert.match(plus, /<DropdownMenuTrigger asChild>\s*<TooltipTrigger asChild>/);
  assert.match(plus, /<Tooltip open=\{tipOpen && !open\} onOpenChange=\{setTipOpen\}>/);
});
