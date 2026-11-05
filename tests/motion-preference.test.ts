import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { framerReducedMotion, motionPrefAt, resolveReducedMotion, type MotionPref } from "@/lib/motion-preference";
import { UI_PREFS_BOOT_SCRIPT } from "@/lib/ui-prefs";

/*
 * G45: one answer to "is motion reduced?", with three choices.
 * System follows the OS, Reduced always reduces, Full never does.
 */

test("the rule: Reduced reduces, Full does not, System follows the OS", () => {
  const table: Array<[MotionPref, boolean, boolean]> = [
    ["system", false, false],
    ["system", true, true],
    ["reduced", false, true],
    ["reduced", true, true],
    ["full", false, false],
    ["full", true, false],
  ];
  for (const [pref, os, expected] of table) assert.equal(resolveReducedMotion(pref, os), expected, `${pref} with OS ${os}`);
});

test("framer-motion follows the same choice", () => {
  assert.equal(framerReducedMotion("system"), "user");
  assert.equal(framerReducedMotion("reduced"), "always");
  assert.equal(framerReducedMotion("full"), "never");
});

/** The smallest Element that `closest("[data-motion]")` can walk. */
function el(attrs: Record<string, string>, parent: FakeEl | null = null): FakeEl {
  return new FakeEl(attrs, parent);
}
class FakeEl {
  constructor(private attrs: Record<string, string>, private parent: FakeEl | null) {}
  getAttribute(name: string) {
    return this.attrs[name] ?? null;
  }
  closest(selector: string): FakeEl | null {
    assert.equal(selector, "[data-motion]");
    if ("data-motion" in this.attrs) return this;
    return this.parent ? this.parent.closest(selector) : null;
  }
}
const asElement = (node: FakeEl) => node as unknown as Element;

test("both spellings of reduced are honoured, and the nearest data-motion wins", () => {
  const html = el({});
  assert.equal(motionPrefAt(asElement(el({}, html))), "system");
  // The app writes "reduced"; the galleries used to write "reduce".
  assert.equal(motionPrefAt(asElement(el({}, el({ "data-motion": "reduced" })))), "reduced");
  assert.equal(motionPrefAt(asElement(el({}, el({ "data-motion": "reduce" })))), "reduced");
  assert.equal(motionPrefAt(asElement(el({}, el({ "data-motion": "full" })))), "full");
  // A gallery root inside a Full app still simulates Reduced for its subtree.
  const app = el({ "data-motion": "full" });
  assert.equal(motionPrefAt(asElement(el({}, el({ "data-motion": "reduced" }, app)))), "reduced");
  assert.equal(motionPrefAt(null), "system");
});

test("the boot script mirrors Full and Reduced onto <html> before first paint", () => {
  const run = (stored: unknown) => {
    const attrs: Record<string, string> = {};
    const document = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
    const localStorage = { getItem: () => JSON.stringify(stored) };
    new Function("document", "localStorage", UI_PREFS_BOOT_SCRIPT)(document, localStorage);
    return attrs["data-motion"];
  };
  assert.equal(run({ motion: "full" }), "full");
  assert.equal(run({ motion: "reduced" }), "reduced");
  assert.equal(run({ motion: "system" }), undefined);
});

test("Settings offers System, Reduced and Full", () => {
  const source = readFileSync(path.join(process.cwd(), "src/components/settings/sections/general.tsx"), "utf8");
  for (const value of ["system", "reduced", "full"]) assert.match(source, new RegExp(`value: "${value}", label: "`));
  assert.match(readFileSync(path.join(process.cwd(), "src/lib/ui-prefs.ts"), "utf8"), /pick\("motion", \["system", "reduced", "full"\]\)/);
});

test("Tailwind's duration and easing utilities read the motion tokens", async () => {
  const { default: config } = await import("../tailwind.config");
  const extend = config.theme?.extend ?? {};
  const durations = extend.transitionDuration as Record<string, string>;
  const easings = extend.transitionTimingFunction as Record<string, string>;
  // DEFAULT is the bare `transition*` utilities' length: the fast rung, not
  // Tailwind's stock 150ms, which sits off the ladder.
  const durationToken = (key: string) => (key === "DEFAULT" ? "fast" : key);
  assert.equal(durations.DEFAULT, "var(--dur-fast, 120ms)", "a bare `transition-colors` runs 150ms again");
  for (const [key, value] of Object.entries(durations)) assert.match(value, new RegExp(`^var\\(--dur-${durationToken(key)}, \\d+ms\\)$`), key);
  for (const [key, value] of Object.entries(easings)) {
    const token = key === "DEFAULT" || key === "out" ? "out-soft" : key;
    assert.match(value, new RegExp(`^var\\(--ease-${token}, cubic-bezier\\(`), key);
  }
  // The fallback is the token's own value, so a page without globals.css moves the same way.
  const globals = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
  for (const [key, value] of Object.entries(durations)) {
    const fallback = /, (\d+ms)\)$/.exec(value)![1];
    assert.ok(globals.includes(`--dur-${durationToken(key)}: ${fallback};`), `--dur-${key} fallback ${fallback}`);
  }
});
