import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

import postcss from "postcss";

import { ACCENTS } from "../src/lib/accents";
import { appearanceTables, declsFor, hex, parseBlocks, resolveColor } from "../scripts/generate-design-tokens";

/**
 * P1's globals.css behaviours (spec §3, §4, package scope 1–8): the role
 * tokens and their values, the high-contrast twins the postcss compiler
 * makes, and the global CSS rules the package owns.
 */

const require = createRequire(import.meta.url);
const preference = require(resolve(process.cwd(), "postcss/motion-preference.cjs"));
const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
const blocks = parseBlocks(css);
const tables = appearanceTables(blocks);
const root = tables.light;
const dark = declsFor(blocks, ".dark");
const compile = (source: string) => postcss([preference]).process(source, { from: undefined }).css;

test("the wave 2 colour roles carry the spec's values (§3.1)", () => {
  const expect: Array<[string, string, string]> = [
    ["muted-foreground-on-fill", "217.5 4% 38.8%", "222.9 4.1% 66.5%"],
    ["ink-tertiary", "220 4% 62%", "222 3% 42%"],
    ["user-bubble-hover", "210 6% 90.2%", "225 5% 19.5%"],
    ["signal", "24 80% 46%", "28 95% 70%"],
    ["signal-ink", "22 78% 40%", "28 95% 72%"],
    ["presence-wash", "var(--presence) / 0.10", "var(--presence) / 0.16"],
    ["signal-wash", "var(--signal) / 0.14", "var(--signal) / 0.18"],
  ];
  for (const [name, light, darkValue] of expect) {
    assert.equal(root.get(name), light, `light --${name}`);
    assert.equal(dark.get(name), darkValue, `dark --${name}`);
  }
  assert.equal(root.get("destructive"), "356 72% 42%");
  // --input and --attention keep their values. --hairline and --scrim were
  // unchanged at S2; the approved Graphite direction (2026-10-31,
  // docs/design/direction-2026-11/DIRECTION.md §2.1) moved them into the cool
  // graphite family and to the measured 30 / 50 scrim.
  assert.equal(root.get("input"), "214.286 2.979% 53.922%");
  assert.equal(root.get("attention"), "34.161 91.946% 29.216%");
  assert.equal(root.get("hairline"), "216 9% 11% / 0.07");
  assert.equal(root.get("scrim"), "216 12% 6% / 0.30");
  assert.equal(dark.get("hairline"), "220 7% 92% / 0.08");
  assert.equal(dark.get("scrim"), "0 0% 0% / 0.50");
});

test("status consumers read role tokens, so a needs-you decision (S1) is one mapping", () => {
  assert.equal(root.get("status-running"), "var(--presence)");
  assert.equal(root.get("status-needs-you"), "var(--signal)");
  assert.equal(root.get("status-needs-you-ink"), "var(--signal-ink)");
  assert.equal(root.get("status-ready"), "var(--foreground)");
  assert.equal(root.get("status-blocked"), "var(--destructive)");
  // They resolve per appearance, including high contrast.
  assert.equal(hex(resolveColor(tables.hcLight, "status-running")!), "#1f38a8");
  assert.equal(hex(resolveColor(tables.hcDark, "status-running")!), "#b4c0f0");
  assert.equal(hex(resolveColor(tables.hcLight, "status-needs-you-ink")!), "#933c10");
  assert.equal(hex(resolveColor(tables.hcDark, "status-blocked")!), "#faa8ad");
});

test("the composer inks moved into globals.css with composer.css's exact values", () => {
  const composer = readFileSync(resolve(process.cwd(), "src/components/chat/composer.css"), "utf8");
  const composerBlocks = parseBlocks(composer);
  for (const name of ["cmp-ink-2", "cmp-well", "cmp-well-2", "cmp-well-3"]) {
    const old = declsFor(composerBlocks, ":root").get(name);
    // P5 deletes the old copies; until then they must agree.
    if (old !== undefined) assert.equal(root.get(name), old, `light --${name}`);
    const oldDark = declsFor(composerBlocks, ".dark").get(name);
    if (oldDark !== undefined) assert.equal(dark.get(name), oldDark, `dark --${name}`);
    assert.ok(root.get(name), `--${name} is not in globals.css`);
  }
});

test("the high-contrast appearance (§3.2)", () => {
  const hc = declsFor(blocks, ":root", "@media (prefers-contrast: more)");
  const hcDark = declsFor(blocks, ".dark", "@media (prefers-contrast: more)");
  assert.equal(hc.get("muted-foreground"), "217 5% 28%");
  assert.equal(hcDark.get("muted-foreground"), "223 5% 80%");
  assert.equal(hex(resolveColor(tables.hcLight, "presence")!), "#1f38a8");
  assert.equal(hex(resolveColor(tables.hcDark, "presence")!), "#b4c0f0");
  assert.equal(hc.get("signal-ink"), "20 80% 32%");
  assert.equal(hcDark.get("signal-ink"), "26 100% 80%");
  assert.equal(hc.get("destructive"), "356 75% 34%");
  assert.equal(hcDark.get("destructive"), "356 90% 82%");
  assert.equal(hcDark.get("border"), "225 4% 52%");
  for (const block of [hc, hcDark]) {
    assert.equal(block.get("ring-width"), "3px");
    assert.equal(block.get("tone-edge"), "var(--foreground) / 0.32");
    // The hairline becomes a solid line: the border's own value, no alpha.
    assert.equal(block.get("hairline"), block.get("border"));
  }
  assert.equal(root.get("ring-width"), "2px");
  assert.match(stripped, /:focus-visible \{\s*outline: var\(--ring-width, 2px\) solid hsl\(var\(--ring\)\);\s*outline-offset: 2px;/);
  assert.match(stripped, /@media \(forced-colors: active\) \{[\s\S]*:focus-visible \{ outline-color: Highlight; \}/);
});

test("high contrast follows the OS unless turned off in the app, and the in-app toggle turns it on anywhere", () => {
  const out = compile(css);
  // The OS block no longer applies under data-contrast=standard.
  assert.match(out, /@media \(prefers-contrast: more\)\s*\{\s*:root:where\(:not\(\[data-contrast="standard"\], \[data-contrast="standard"\] \*\)\) \{/);
  // The in-app twin: :root becomes the attribute (same specificity), .dark is scoped.
  assert.match(out, /\n\s*\[data-contrast="more"\] \{\s*--muted-foreground: 217 5% 28%;/);
  assert.match(out, /\.dark:where\(\[data-contrast="more"\], \[data-contrast="more"\] \*\) \{\s*--muted-foreground: 223 5% 80%;/);
  // Component contrast rules ride along.
  assert.match(out, /\.composer-surface:where\(\[data-contrast="more"\], \[data-contrast="more"\] \*\) \{ border-color/);
});

test("the contrast compiler: twins, keyframes and a query naming both preferences", () => {
  const out = compile("@media (prefers-contrast: more) { .a { color: red } @keyframes k { from { opacity: 0 } } }");
  assert.match(out, /@media \(prefers-contrast: more\) \{ \.a:where\(:not\(\[data-contrast="standard"\], \[data-contrast="standard"\] \*\)\) \{ color: red \}/);
  assert.match(out, /\.a:where\(\[data-contrast="more"\], \[data-contrast="more"\] \*\) \{ color: red \}/);
  assert.equal(out.match(/@keyframes k/g)?.length, 1, "keyframes are global by name and never copied into a twin");
  const both = compile("@media (prefers-reduced-motion: reduce) and (prefers-contrast: more) { .x { color: red } }");
  // Four combinations, each exactly once, and the compiler terminates.
  for (const scope of [
    '.x:where(:not([data-motion="full"], [data-motion="full"] *)):where(:not([data-contrast="standard"], [data-contrast="standard"] *))',
    '.x:where(:not([data-motion="full"], [data-motion="full"] *)):where([data-contrast="more"], [data-contrast="more"] *)',
    '.x:where([data-motion^="reduce"], [data-motion^="reduce"] *):where(:not([data-contrast="standard"], [data-contrast="standard"] *))',
    '.x:where([data-motion^="reduce"], [data-motion^="reduce"] *):where([data-contrast="more"], [data-contrast="more"] *)',
  ]) {
    assert.equal(both.split(scope).length - 1, 1, scope);
  }
  // Other contrast values are left exactly as written.
  assert.equal(compile("@media (prefers-contrast: less) { .y { color: red } }"), "@media (prefers-contrast: less) { .y { color: red } }");
  assert.deepEqual(preference.parseContrastQuery("(min-width: 640px) and (prefers-contrast: more)"), [{ contrast: "more", rest: ["(min-width: 640px)"] }]);
});

test("Cobalt: the accent stored as ultramarine is hsl(205 78% 36%), labelled, and every accent has a label", () => {
  const light = declsFor(blocks, ':root[data-accent="ultramarine"]');
  assert.equal(light.get("primary"), "205 78% 36%");
  const cobalt = ACCENTS.find((a) => a.id === "ultramarine");
  assert.equal(cobalt?.label, "Cobalt");
  assert.equal(cobalt?.color, "hsl(205 78% 36%)");
  for (const a of ACCENTS) assert.ok(a.label && /^[A-Z][a-z]+$/.test(a.label), `${a.id} has no human label`);
  assert.equal(ACCENTS.find((a) => a.id === "coral")?.label, "Graphite");
});

test("shell, gesture and timing tokens are declared with the spec's values (§3.12, §4.2)", () => {
  const expect: Record<string, string> = {
    "sidebar-min": "224px", "sidebar-default": "260px", "sidebar-max": "352px",
    "drawer-width": "min(80vw, 380px)", "drawer-parallax": "0.22", "drawer-dim": "0.12",
    "edge-zone": "24px", "gesture-slop": "8px",
    "gesture-dismiss-velocity": "0.5", "gesture-dismiss-fraction": "0.3",
    "gesture-open-velocity": "0.3", "gesture-open-fraction": "0.4",
    "rubber-band-limit": "64px", "rubber-band-c": "0.55",
    "settle-min": "140ms", "settle-max": "300ms", "snap-zone": "16px", "header-h": "48px",
    "transcript-fade": "32px", "galaxy-max-animating": "3", "stagger-row": "30ms", "stagger-tile": "45ms",
    "stagger-onboarding": "60ms", "stagger-max": "4", "dock-panes-max": "3", "dock-pane-evict": "600000ms",
    // 2026-10-29: the shared token now matches the shipped app's 200/400
    // hover intent instead of a 500/300 table bypassed by provider overrides.
    "delay-show": "200ms", "delay-tooltip": "200ms", "delay-tooltip-skip": "400ms", "delay-hairline": "300ms",
    "delay-action-row": "180ms", "delay-greeting": "60ms", "delay-insert-flush": "300ms",
    "hold-phase": "600ms", "hold-skeleton": "400ms", "hold-check": "120ms", "hold-reasoning": "1000ms",
    "hold-arm": "500ms", "hold-needs-you-max": "2000ms", "hold-insert-max": "10000ms", "hold-composer-idle": "2000ms",
    "loop-breathe": "1.8s", "loop-galaxy": "2.4s", "loop-galaxy-calm": "4.8s",
    "stream-band": "280ms", "stream-tail-max": "250ms", "stream-rate-min": "20", "stream-rate-max": "800", "stream-drain-tick": "50ms",
    "radius-bubble": "12px", "radius-bubble-tuck": "8px",
    "dur-press": "70ms", "dur-fast": "120ms", "dur-exit": "160ms", "dur-base": "220ms", "dur-slow": "360ms", "dur-emphasis": "560ms",
    "ease-spring": "cubic-bezier(0.22, 1, 0.36, 1)",
  };
  for (const [name, value] of Object.entries(expect)) assert.equal(root.get(name), value, `--${name}`);
  assert.equal(dark.get("drawer-dim"), "0.30");
  // Transcript widths are unchanged (D13).
  assert.equal(root.get("transcript-max"), "48rem");
  assert.equal(declsFor(blocks, 'html[data-transcript-width="narrow"]').get("transcript-max"), "40rem");
  assert.equal(declsFor(blocks, 'html[data-transcript-width="wide"]').get("transcript-max"), "62rem");
});

test("the measure: prose fills the column, and only at wide are reading blocks capped at 75ch", () => {
  assert.match(stripped, /\.prose-juno \{[^}]*max-inline-size: none;/);
  assert.match(stripped, /html\[data-transcript-width="wide"\] \.prose-juno :is\(p, li, blockquote, h1, h2, h3, h4\) \{ max-inline-size: 75ch; \}/);
  assert.doesNotMatch(stripped, /\.prose-juno \{[^}]*max-inline-size: 75ch/);
});

test("code-block headers stick and wide tables keep their first column, without mask-image", () => {
  assert.match(stripped, /\.aicss-cb \{\s*overflow: clip;/);
  assert.match(stripped, /\.aicss-cb-head \{\s*position: sticky;\s*top: 0;\s*z-index: 1;\s*background: hsl\(var\(--secondary\)\);/);
  const table = /\.prose-juno :where\(div:has\(> table\)\) \{([^}]*)\}/.exec(stripped)?.[1] ?? "";
  assert.match(table, /local/);
  assert.match(table, /scroll;/);
  assert.doesNotMatch(table, /mask-image/);
  assert.match(stripped, /:is\(th, td\):first-child \{\s*position: sticky;\s*inset-inline-start: 0;/);
});

test("streamed writing: the first band starts at 35% ink and .stream-lite drops the halo", () => {
  assert.match(stripped, /::highlight\(stream-f0\) \{ color: hsl\(var\(--foreground\) \/ 0\.35\);/);
  assert.match(stripped, /\.stream-lite ::highlight\(stream-f0\)[^{]*\{ text-shadow: none; \}/);
});

test("view transitions: the root swaps instantly, thread is 120 out and 160 in, canvas 360 open and 220 close", () => {
  assert.match(stripped, /html\[data-vt\]::view-transition-old\(root\),\s*html\[data-vt\]::view-transition-new\(root\) \{\s*animation: none;/);
  assert.match(stripped, /html\[data-vt="thread"\]::view-transition-old\(app-page\) \{\s*animation: vt-page-out var\(--dur-fast\) var\(--ease-in\) both;/);
  assert.match(stripped, /html\[data-vt="thread"\]::view-transition-new\(app-page\) \{\s*animation: vt-page-in var\(--dur-exit\) var\(--ease-out-soft\) both;/);
  assert.match(stripped, /html\[data-vt="canvas"\]::view-transition-group\(canvas-panel\) \{\s*animation-duration: var\(--dur-slow\);\s*animation-timing-function: var\(--ease-out-expo\);/);
  assert.match(stripped, /html\[data-vt="canvas"\]\[data-vt-dir="close"\]::view-transition-group\(canvas-panel\) \{\s*animation-duration: var\(--dur-base\);\s*animation-timing-function: var\(--ease-in\);/);
  assert.doesNotMatch(stripped, /@view-transition\b/);
  // Reduced motion: no group geometry, a 160 crossfade, compiled into the in-app twin.
  const out = compile(css);
  assert.match(out, /html\[data-vt\]:where\(\[data-motion\^="reduce"\], \[data-motion\^="reduce"\] \*\)::view-transition-group\(\*\) \{ animation: none; \}/);
});

test("no backdrop-filter in globals.css product rules (D15)", () => {
  assert.doesNotMatch(stripped, /backdrop-filter\s*:/);
});

test("scroll-edge bands fade from their own surface, not the page, where the ground is not the page", () => {
  // The bands are opaque gradients now (no backdrop blur), so a band on the
  // sidebar or a popover that faded from --background would paint a stripe.
  const groundOf = (selector: string) => {
    const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{[^}]*--scroll-fade-ground: var\\(--([a-z-]+)\\)`);
    return re.exec(stripped)?.[1];
  };
  assert.equal(groundOf(".app-sidebar-frame"), "sidebar");
  assert.equal(groundOf(".surface-float"), "popover");
  assert.equal(groundOf(".overlay-glass"), "popover");
  assert.match(stripped, /\.scroll-fade-edge\[data-edge="top"\] \{[^}]*hsl\(var\(--scroll-fade-ground, var\(--background\)\)\)/);
});

test("type rungs a fontSize cannot finish, and the corner-shape enhancement", () => {
  assert.match(stripped, /:where\(\.text-label, \.text-kbd\) \{\s*font-family: var\(--font-mono\)[^;]*;\s*font-variant-numeric: tabular-nums;/);
  assert.match(stripped, /@media \(max-width: 639\.98px\) \{\s*\.text-page-title\.text-page-title \{ font-size: 1\.75rem; \}/);
  assert.match(stripped, /@supports \(corner-shape: superellipse\(1\.5\)\) \{\s*:where\(\.rounded-composer, \.rounded-card, \.rounded-panel/);
});
