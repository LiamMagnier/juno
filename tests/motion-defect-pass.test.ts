import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import tailwindConfig from "../tailwind.config";
import { TIMING_TOKENS, DURATION, EASING } from "../src/lib/design/tokens.generated";
import { TIMING } from "../src/lib/interaction";
import { STAGGER, STAGGER_MAX, staggerDelay, staggerStep, transition, ease } from "../src/lib/motion";
import { menuGlyphInkClass, menuRowClass } from "../src/components/ui/menu-recipe";
import { LIST_ROW_TRANSITION } from "../src/components/app/sidebar-section";
import { MORPH_MS, EXPO } from "../src/components/chat/generation-frame";
import { FLIP_DURATION_MS } from "../src/lib/code-v2/thread-sections";
import { THINKING_TIMING } from "../src/components/brand/thinking-schedule";

/**
 * The motion defect pass (2026-10-31). Each block pins one fix that is
 * objectively broken under any visual direction: dead or overridden CSS,
 * timing tables that contradicted their tokens, reduced-motion rules that cut
 * Tier A fades, and animations that moved layout properties.
 */

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const RUNGS = new Set([70, 120, 160, 220, 360, 560]);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(relative, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".generated.ts")) out.push(relative);
  }
  return out;
}
/** Every string literal on one line of a source file (class strings never span lines). */
const literals = (text: string) => [...text.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)].map((m) => m[2]);

// ——— Highlights: in at once, out over 120 (spec §4.5 rule 6) ———————————————

test("a menu row's highlight lands in 0ms and leaves over the fast rung; its press keeps --dur-press", () => {
  assert.match(menuRowClass, /transition-\[background-color,color,transform\]/);
  assert.match(menuRowClass, /\[transition-duration:var\(--dur-fast\),var\(--dur-fast\),var\(--dur-press\)\]/);
  assert.match(menuRowClass, /data-\[highlighted\]:\[transition-duration:0ms,0ms,var\(--dur-press\)\]/);
  assert.doesNotMatch(menuRowClass, /(^|\s)duration-fast(\s|$)/, "a single duration makes the fill smear in both directions again");
  // The glyph lights with the fill: its transition exists only off the highlight.
  assert.match(menuGlyphInkClass, /\[:where\(&:not\(\[data-highlighted\]\)\)_svg\]:\[transition:color_var\(--dur-fast\)_var\(--ease-out-soft\)\]/);
});

test("a sidebar row's hover fill lands in 0ms and keeps its colour timing under reduced motion", () => {
  assert.equal(LIST_ROW_TRANSITION, "transition-[background-color,color] duration-fast ease-out-soft hover:duration-0");
});

test("hover utilities only match a real pointer (no sticky hover on touch)", () => {
  const future = (tailwindConfig as { future?: { hoverOnlyWhenSupported?: boolean } }).future;
  assert.equal(future?.hoverOnlyWhenSupported, true);
});

test("Tailwind's bare transition utilities run the fast rung, not 150ms", () => {
  const durations = tailwindConfig.theme?.extend?.transitionDuration as Record<string, string>;
  assert.equal(durations.DEFAULT, "var(--dur-fast, 120ms)");
});

// ——— Press: `.pressable` keeps its transform transition ——————————————————

test("no .pressable host replaces the class's transition list with a utility", () => {
  const offenders: string[] = [];
  for (const file of sources("src")) {
    for (const literal of literals(read(file))) {
      const tokens = literal.split(/\s+/);
      if (!tokens.includes("pressable")) continue;
      // A bare (unprefixed) transition utility outranks `.pressable` and drops `transform`.
      const replacing = tokens.filter((t) => /^transition(?:-colors|-opacity|-shadow|-\[[^\]]*\])?$/.test(t) && !/transform/.test(t));
      if (replacing.length) offenders.push(`${file}: ${replacing.join(" ")}`);
    }
  }
  assert.deepEqual(offenders, [], "these press dips snap: drop the transition utility, .pressable already cross-fades colour");
});

// ——— Reduced motion: Tier A colour and opacity are kept (spec §4.7) ——————————

test("no colour- or opacity-only transition is cut under reduced motion", () => {
  const COLOUR = new Set(["color", "background-color", "border-color", "opacity", "box-shadow", "fill", "stroke", "outline-color", "text-decoration-color"]);
  const offenders: string[] = [];
  for (const file of sources("src")) {
    // Dialog, sheet and toast components are the overlays pass's files; their
    // reduced-motion timing is reviewed there, with the overlay recipes.
    if (/(?:^|[/-])(?:dialog|sheet|sonner|toast|drawer)[\w-]*\.tsx$/.test(file)) continue;
    for (const literal of literals(read(file))) {
      const tokens = literal.split(/\s+/);
      if (!tokens.includes("motion-reduce:transition-none")) continue;
      const lists = tokens.filter((t) => /^transition(?:-colors|-opacity|-shadow|-\[[^\]]*\])$/.test(t));
      if (!lists.length) continue;
      const colourOnly = lists.every((t) => {
        if (t === "transition-colors" || t === "transition-opacity" || t === "transition-shadow") return true;
        return t.slice(12, -1).split(",").every((p) => COLOUR.has(p.trim()));
      });
      if (colourOnly) offenders.push(`${file}: ${lists.join(" ")}`);
    }
  }
  assert.deepEqual(offenders, [], "Tier A fades cut by motion-reduce:transition-none");
});

test("the overshoot and the 560 rung are flattened under reduced motion, on the web and in the Mac editor", () => {
  for (const file of ["src/app/globals.css", "src/components/design/host/editor.css"]) {
    const css = read(file);
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    const block = reduced.slice(0, reduced.indexOf("}"));
    assert.match(block, /--ease-out-back: var\(--ease-out-soft\);/, file);
    assert.match(block, /--dur-emphasis: var\(--dur-base\);/, file);
  }
});

test("toasts fade under reduced motion, OS or in-app, instead of cutting", () => {
  const css = read("src/app/globals.css");
  const block = css.slice(css.indexOf("/* Reduced motion: a toast FADES in and out"));
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{\s*\.toaster\[data-sonner-toaster\] \[data-sonner-toast\]\[data-styled="true"\]:not\(\[data-swiping="true"\]\),/);
  assert.match(block, /transition-property: opacity !important;\s*transition-duration: var\(--dur-fast\) !important;/);
  // The close chip's colour hover is kept too (it used to be `transition: none`).
  assert.doesNotMatch(css, /\[data-close-button\] \{\s*transition: none;\s*\}/);
});

test("a progress fill keeps moving under reduced motion", () => {
  assert.doesNotMatch(read("src/components/ui/progress.tsx"), /motion-reduce:transition-none/);
  assert.doesNotMatch(read("src/components/ui/usage-meter.tsx"), /motion-reduce:transition/);
});

// ——— One source for every wait (spec §4.2) —————————————————————————————————

test("interaction.ts reads its delays and holds from the tokens", () => {
  assert.equal(TIMING.showDelay, TIMING_TOKENS.delay.show);
  assert.equal(TIMING.minVisible, TIMING_TOKENS.hold.skeleton);
  assert.equal(TIMING.tooltipDelay, TIMING_TOKENS.delay.tooltip);
  assert.equal(TIMING.tooltipSkip, TIMING_TOKENS.delay.tooltipSkip);
  assert.equal(TIMING.phaseMinHold, TIMING_TOKENS.hold.phase, "a phase word held 1000ms against --hold-phase's 600");
  assert.equal(TIMING.approvalArm, TIMING_TOKENS.hold.arm);
  assert.equal(THINKING_TIMING.showDelay, TIMING.showDelay);
  assert.equal(THINKING_TIMING.minVisible, TIMING.minVisible);
  assert.match(read("src/lib/interaction.ts"), /from "@\/lib\/design\/tokens\.generated"/);
});

test("stagger: the token rungs, and at most four items (spec D17)", () => {
  assert.deepEqual({ ...STAGGER }, { tight: TIMING_TOKENS.stagger.row, base: TIMING_TOKENS.stagger.tile, loose: TIMING_TOKENS.stagger.onboarding });
  assert.equal(STAGGER_MAX, TIMING_TOKENS.stagger.max);
  assert.equal(staggerStep(2), 2);
  assert.equal(staggerStep(9), STAGGER_MAX - 1, "the fifth item onward paints with the fourth");
  assert.deepEqual(staggerDelay(12, "base"), staggerDelay(STAGGER_MAX - 1, "base"));
  // No hand-rolled 40/60/70ms steps left in the sources the audit found.
  for (const file of ["src/components/chat/live-ui/live-ui-intelligent.tsx", "src/components/profile/profile-view.tsx", "src/components/agents/agent-thread-header.tsx", "src/components/agents/agents-home.tsx"]) {
    assert.doesNotMatch(read(file), /animationDelay: `\$\{[^`]*\* (?:30|40|60|70)\}ms`/, file);
  }
  for (const file of ["src/components/app/editorial.css", "src/components/memory/memory.css", "src/components/research/research.css", "src/components/chat/thought-process.css"]) {
    assert.doesNotMatch(read(file), /\* 70ms/, `${file} still steps by a retired 70ms`);
  }
});

test("the skeleton waits --delay-show before it shows, and fades in", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.skeleton \{\s*animation: skeleton-breathe [^;]+;\s*transition: opacity var\(--dur-fast\) var\(--ease-out-soft\) var\(--delay-show\);/);
  assert.match(css, /@starting-style \{\s*\.skeleton \{ opacity: 0; \}\s*\}/);
  // The breathe moved off `opacity` so the inline stagger delay cannot retime the gate.
  assert.match(css, /@keyframes skeleton-breathe \{\s*0%, 100% \{ filter: opacity\(1\); \}\s*50% \{ filter: opacity\(0\.62\); \}/);
});

// ——— The ladder: no off-rung lengths (spec §4.1) ——————————————————————————

test("off-ladder lengths are on rungs now", () => {
  assert.ok(RUNGS.has(MORPH_MS), `the media morph runs ${MORPH_MS}ms`);
  assert.ok(RUNGS.has(FLIP_DURATION_MS), `the Code list FLIP runs ${FLIP_DURATION_MS}ms`);
  assert.equal(EXPO, `cubic-bezier(${EASING.outExpo.join(", ")})`);
  assert.equal(DURATION.exit, 160);
  const flip = read("src/components/app/code-work-list.tsx");
  assert.doesNotMatch(flip, /easing: "ease-out"|cubic-bezier\(0\.32,0\.72,0,1\)/);
  assert.match(read("src/components/chat/memory-updated-notice.tsx"), /const EXIT_MS = DURATION\.exit;/);
  // A press is one curve on every engine: out-soft, like .pressable and JunoMotion.press.
  assert.deepEqual(transition.press, { duration: DURATION.press / 1000, ease: ease.outSoft });
});

test("the settings 'Saved' word enters without a blur (spec C1)", () => {
  assert.doesNotMatch(read("src/components/settings/save-status.tsx"), /blur\(/);
});

// ——— Layout-shifting animations (spec D27) ——————————————————————————————————

test("incognito's frame fades in; its inset does not transition margin", () => {
  const view = read("src/components/chat/chat-view.tsx");
  assert.doesNotMatch(view, /transition-\[margin/);
  assert.match(view, /"flex min-h-0 flex-1 flex-col overflow-hidden transition-\[border-color,background-color,box-shadow\] duration-slow ease-out-soft"/);
});

test("the chat's side panels slide out only when motion is allowed (fade in place under reduced motion)", () => {
  const view = read("src/components/chat/chat-view.tsx");
  // tailwindcss-animate's slide is a hard-coded translate --motion-shift cannot reach.
  assert.doesNotMatch(view, /fade-out slide-out-to-right-4/);
  assert.equal(view.match(/fade-out motion-safe:slide-out-to-right-4/g)?.length, 3);
});

test("the incognito pill does not tween its width or padding", () => {
  const toggle = read("src/components/chat/private-chat-toggle.tsx");
  assert.doesNotMatch(toggle, /transition-\[[^\]]*(?:width|padding)/);
});

test("the composer's attachment row unfolds on grid rows instead of jumping", () => {
  const shell = read("src/components/ui/composer-shell.tsx");
  assert.doesNotMatch(shell, /"[^"\n]*empty:hidden[^"\n]*"/, "the row collapses in one frame again");
  assert.match(shell, /"grid transition-\[grid-template-rows\] duration-base ease-in-out motion-reduce:transition-none",\s*uploads\.length \? "grid-rows-\[1fr\]" : "grid-rows-\[0fr\]"/);
  assert.match(shell, /<div className="min-h-0 overflow-y-clip">/);
});

test("upload progress bars fill on transform, not width", () => {
  for (const file of ["src/components/library/library-items.tsx", "src/components/documents/viewer-ui.tsx"]) {
    const source = read(file);
    assert.doesNotMatch(source, /transition-\[width\]/, file);
    assert.match(source, /transform: `translateX\(-\$\{100 - /, file);
  }
});

test("loops run on the breathe curve, not the in-out token or the keyword", () => {
  for (const file of ["src/components/app/editorial.css", "src/components/memory/memory.css", "src/components/chat/live-ui/live-ui.css", "src/components/chat/thought-process.css"]) {
    const css = read(file);
    for (const m of css.matchAll(/animation: [\w-]+ [^;]*infinite/g)) {
      assert.doesNotMatch(m[0], /\bease-in-out\b|var\(--ease-in-out/, `${file}: ${m[0]}`);
    }
  }
});

test("a tab panel fades in when the reader switches, not on the page's first paint", () => {
  const tabs = read("src/components/ui/tabs.tsx");
  assert.match(tabs, /switched && "data-\[state=active\]:animate-fade-in"/);
  assert.match(tabs, /if \(!switched && current !== opened\) setSwitched\(true\);/);
});
