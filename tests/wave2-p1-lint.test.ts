import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

import { ESLint, RuleTester } from "eslint";

/**
 * The wave 2 lint (spec §9 "Lint", P1 scope 10): every rule has a failing
 * and a passing fixture, a file listed in an enforce file errors, and an
 * unlisted file only warns.
 */

const require = createRequire(import.meta.url);
const tsParser = require("@typescript-eslint/parser");
const REPO = process.cwd();

type Wave2 = typeof import("../eslint-rules/wave2.mjs");
type Enforce = typeof import("../eslint-rules/enforce.mjs");
const load = async () => ({
  wave2: (await import(resolve(REPO, "eslint-rules/wave2.mjs"))) as Wave2,
  enforce: (await import(resolve(REPO, "eslint-rules/enforce.mjs"))) as Enforce,
});

/** A stylesheet as the css processor hands it to the rules. */
const css = (text: string) => text.split("\n").map((line) => `//${line}`).join("\n");

RuleTester.describe = (name, fn) => test(name, () => fn());
RuleTester.it = (name, fn) => fn();
RuleTester.itOnly = RuleTester.it;

const tester = new RuleTester({
  languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } }, ecmaVersion: 2022, sourceType: "module" },
});

test("off-ladder-duration", async () => {
  const { wave2 } = await load();
  tester.run("off-ladder-duration", wave2.rules["off-ladder-duration"] as never, {
    valid: [
      { code: `const a = "transition-opacity duration-fast ease-out-soft delay-[var(--delay-show)]";`, filename: "src/a.tsx" },
      { code: `const t = { transition: { duration: 0.22, ease: [0.33, 1, 0.68, 1] } };`, filename: "src/a.tsx" },
      { code: `const t = { duration: DURATION.base / 1000, ease: "easeOut" };`, filename: "src/a.tsx" },
      { code: `const s = { transition: "opacity var(--dur-base) var(--ease-out-soft)" };`, filename: "src/a.tsx" },
      { code: `const audio = { duration: 250, title: "Track" };`, filename: "src/a.tsx" },
      { code: `el.animate(frames, { duration: 220, easing: "ease-out" });`, filename: "src/a.tsx" },
      { code: css(".a { transition: opacity var(--dur-fast) var(--ease-in) calc(var(--dur-fast) / 2); animation: x var(--loop) infinite; }"), filename: "src/a.css/0.js" },
    ],
    invalid: [
      { code: `const a = "transition-opacity duration-300";`, filename: "src/a.tsx", errors: [{ messageId: "literal" }] },
      { code: `const a = "duration-[250ms] delay-[80ms]";`, filename: "src/a.tsx", errors: [{ messageId: "literal" }, { messageId: "literal" }] },
      { code: `const t = { transition: { duration: 0.25 } };`, filename: "src/a.tsx", errors: [{ messageId: "literal" }] },
      { code: `const t = { type: "spring", duration: 0.42, bounce: 0 };`, filename: "src/a.tsx", errors: [{ messageId: "literal" }] },
      { code: `const s = { transition: "opacity 250ms ease" };`, filename: "src/a.tsx", errors: [{ messageId: "literal" }] },
      { code: `el.animate(frames, { duration: 300 });`, filename: "src/a.tsx", errors: [{ messageId: "literal" }] },
      { code: css(".a {\n  transition: opacity 320ms ease;\n}"), filename: "src/a.css/0.js", errors: [{ messageId: "literal", line: 2 }] },
    ],
  });
});

test("no-text-token-opacity", async () => {
  const { wave2 } = await load();
  tester.run("no-text-token-opacity", wave2.rules["no-text-token-opacity"] as never, {
    valid: [
      { code: `const a = "text-muted-foreground disabled:opacity-50 text-sm/6 text-white/80 bg-foreground/10";`, filename: "src/a.tsx" },
    ],
    invalid: [
      { code: `const a = "text-foreground/60";`, filename: "src/a.tsx", errors: [{ messageId: "opacity" }] },
      { code: `const a = "hover:text-muted-foreground/[0.7]";`, filename: "src/a.tsx", errors: [{ messageId: "opacity" }] },
    ],
  });
});

test("transcript-chrome-type", async () => {
  const { wave2 } = await load();
  tester.run("transcript-chrome-type", wave2.rules["transcript-chrome-type"] as never, {
    valid: [
      { code: `const a = "text-ui text-label text-reading";`, filename: resolve(REPO, "src/components/chat/message-item.tsx") },
      { code: `const a = "text-caption text-[11px]";`, filename: resolve(REPO, "src/components/library/tile.tsx") },
      { code: `const a = "text-kbd";`, filename: resolve(REPO, "src/components/ui/kbd.tsx") },
    ],
    invalid: [
      { code: `const a = "text-caption";`, filename: resolve(REPO, "src/components/chat/message-item.tsx"), errors: [{ messageId: "rung" }] },
      { code: `const a = "sm:text-[11px] text-micro";`, filename: resolve(REPO, "src/components/app/app-sidebar.tsx"), errors: [{ messageId: "rung" }, { messageId: "rung" }] },
      { code: `const a = "text-kbd";`, filename: resolve(REPO, "src/components/library/tile.tsx"), errors: [{ messageId: "kbd" }] },
    ],
  });
});

test("no-blur-entrance", async () => {
  const { wave2 } = await load();
  tester.run("no-blur-entrance", wave2.rules["no-blur-entrance"] as never, {
    valid: [
      { code: `const v = { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, filter: "blur(0px)" } };`, filename: "src/a.tsx" },
      { code: `const lightbox = { filter: "blur(8px)" };`, filename: "src/a.tsx" },
      { code: css("@keyframes a { from { opacity: 0; } to { opacity: 1; } }\n.x { filter: blur(4px); }"), filename: "src/a.css/0.js" },
    ],
    invalid: [
      { code: `const v = { initial: { opacity: 0, filter: "blur(4px)" } };`, filename: "src/a.tsx", errors: [{ messageId: "blur" }] },
      { code: `const k = { filter: ["blur(6px)", "blur(0px)"] };`, filename: "src/a.tsx", errors: [{ messageId: "blur" }] },
      // Behind a conditional (the settings "Saved" word did this) or a default.
      { code: `const w = { initial: reduce ? { opacity: 0 } : { opacity: 0, x: -4, filter: "blur(2px)" } };`, filename: "src/a.tsx", errors: [{ messageId: "blur" }] },
      { code: `const w = { initial: custom || { opacity: 0, filter: "blur(3px)" } };`, filename: "src/a.tsx", errors: [{ messageId: "blur" }] },
      { code: css("@keyframes turn-in {\n  from { opacity: 0; filter: blur(4px); }\n  to { opacity: 1; }\n}"), filename: "src/a.css/0.js", errors: [{ messageId: "blur", line: 2 }] },
    ],
  });
});

test("no-backdrop-filter", async () => {
  const { wave2 } = await load();
  tester.run("no-backdrop-filter", wave2.rules["no-backdrop-filter"] as never, {
    valid: [
      { code: `const a = "bg-popover backdrop:bg-scrim";`, filename: resolve(REPO, "src/components/app/header.tsx") },
      { code: `const a = "backdrop-blur-md";`, filename: resolve(REPO, "src/components/landing/hero.tsx") },
      { code: `const a = "media-scrim backdrop-blur-sm";`, filename: resolve(REPO, "src/components/chat/lightbox.tsx") },
      { code: css(".media-scrim { backdrop-filter: blur(2px); }\n.a { backdrop-filter: none; }"), filename: resolve(REPO, "src/components/chat/x.css/0.js") },
    ],
    invalid: [
      { code: `const a = "sticky top-0 backdrop-blur-md bg-background/80";`, filename: resolve(REPO, "src/components/app/header.tsx"), errors: [{ messageId: "backdrop" }] },
      { code: `const s = { backdropFilter: "blur(12px)" };`, filename: resolve(REPO, "src/components/app/header.tsx"), errors: [{ messageId: "backdrop" }] },
      { code: css(".bar {\n  -webkit-backdrop-filter: blur(8px);\n}"), filename: resolve(REPO, "src/components/chat/x.css/0.js"), errors: [{ messageId: "backdrop", line: 2 }] },
    ],
  });
});

test("guarded-motion-overrides", async () => {
  const { wave2 } = await load();
  tester.run("guarded-motion-overrides", wave2.rules["guarded-motion-overrides"] as never, {
    valid: [
      { code: `const a = "motion-safe:[--motion-scale-from:0.97] data-[state=open]:animate-pop-in";`, filename: "src/a.tsx" },
      { code: css("@media (prefers-reduced-motion: no-preference) { .p { --motion-scale-from: 0.97; } }\n@media (prefers-reduced-motion: reduce) { :root { --motion-shift: 0; } }"), filename: "src/a.css/0.js" },
    ],
    invalid: [
      { code: `const a = "[--motion-scale-from:0.97] animate-pop-in";`, filename: "src/a.tsx", errors: [{ messageId: "unguarded" }] },
      { code: `const s = { "--motion-shift": 1 };`, filename: "src/a.tsx", errors: [{ messageId: "unguarded" }] },
      { code: css(".palette {\n  --motion-scale-from: 0.97;\n}"), filename: "src/a.css/0.js", errors: [{ messageId: "unguarded", line: 2 }] },
    ],
  });
});

test("no-raw-presence-hex", async () => {
  const { wave2 } = await load();
  tester.run("no-raw-presence-hex", wave2.rules["no-raw-presence-hex"] as never, {
    valid: [
      { code: `const c = SCRIPT_COLOR.presence.light;`, filename: resolve(REPO, "src/components/a.tsx") },
      { code: `export const SCRIPT_COLOR = { presence: { light: "#2d49c9" } };`, filename: resolve(REPO, "src/lib/design/tokens.generated.ts") },
      { code: css(".voice-glow { --voice-glow-alevr: #2d49c9; }"), filename: resolve(REPO, "src/app/globals.css/0.js") },
    ],
    invalid: [
      { code: `const c = "#2D49C9";`, filename: resolve(REPO, "src/components/a.tsx"), errors: [{ messageId: "hex" }] },
      { code: css(".x { --dots: #97a6e6; }"), filename: resolve(REPO, "src/components/home/x.css/0.js"), errors: [{ messageId: "hex" }] },
    ],
  });
});

test("no-muted-on-fill", async () => {
  const { wave2 } = await load();
  tester.run("no-muted-on-fill", wave2.rules["no-muted-on-fill"] as never, {
    valid: [
      { code: `const a = "bg-selected text-muted-on-fill";`, filename: "src/a.tsx" },
      { code: `const a = "text-muted-foreground hover:bg-selected hover:text-foreground";`, filename: "src/a.tsx" },
    ],
    invalid: [
      { code: `const a = "bg-selected text-muted-foreground";`, filename: "src/a.tsx", errors: [{ messageId: "fill" }] },
      { code: `const a = "aria-selected:bg-sidebar-selected aria-selected:text-muted-foreground";`, filename: "src/a.tsx", errors: [{ messageId: "fill" }] },
    ],
  });
});

test("a file listed in an enforce file errors; an unlisted file only warns", async () => {
  const { wave2 } = await load();
  const eslint = new ESLint({
    cwd: REPO,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ["**/*.{ts,tsx}"], languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } } },
      ...wave2.wave2Configs({ enforce: { web: ["src/p1-fixture/enforced.tsx", "src/p1-fixture/enforced.css"] } }),
    ],
  });
  const bad = `export const a = "duration-300 backdrop-blur-md text-foreground/60";`;
  const severities = async (text: string, filePath: string) =>
    (await eslint.lintText(text, { filePath: resolve(REPO, filePath) }))[0].messages.map((m) => `${m.ruleId}:${m.severity}`).sort();
  assert.deepEqual(await severities(bad, "src/p1-fixture/enforced.tsx"), [
    "wave2/no-backdrop-filter:2", "wave2/no-text-token-opacity:2", "wave2/off-ladder-duration:2",
  ]);
  assert.deepEqual(await severities(bad, "src/p1-fixture/loose.tsx"), [
    "wave2/no-backdrop-filter:1", "wave2/no-text-token-opacity:1", "wave2/off-ladder-duration:1",
  ]);
  // Stylesheets go through the processor, keep their line numbers, and follow the same split.
  const sheet = ".a {\n  transition: opacity 250ms ease;\n  backdrop-filter: blur(4px);\n}\n";
  const enforcedCss = (await eslint.lintText(sheet, { filePath: resolve(REPO, "src/p1-fixture/enforced.css") }))[0].messages;
  assert.deepEqual(enforcedCss.map((m) => [m.ruleId, m.severity, m.line]), [["wave2/off-ladder-duration", 2, 2], ["wave2/no-backdrop-filter", 2, 3]]);
  const looseCss = (await eslint.lintText(sheet, { filePath: resolve(REPO, "src/p1-fixture/loose.css") }))[0].messages;
  assert.deepEqual(looseCss.map((m) => m.severity), [1, 1]);
});

test("enforce files are loaded at startup and their globs match like ESLint's", async () => {
  const { enforce } = await load();
  const loaded = enforce.loadEnforce(REPO);
  assert.ok(loaded.packages.some((p) => p.package === "p1"), "eslint-rules/enforce/p1.json is not loaded");
  assert.ok(loaded.web.includes("src/app/globals.css"));
  assert.ok(loaded.native.some((glob) => glob.includes("Generated")));
  assert.ok(enforce.matchesAny("src/lib/strings/index.ts", ["src/lib/strings/**"]));
  assert.ok(enforce.matchesAny("native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift", ["native/macOS/JunoDesktop/App/Generated/**"]));
  assert.ok(!enforce.matchesAny("src/lib/stringsx/index.ts", ["src/lib/strings/**"]));
  assert.ok(enforce.matchesAny("src/components/chat/composer-plus.tsx", ["src/components/chat/composer*.tsx"]));
  assert.ok(enforce.matchesAny("src/a/b.tsx", ["src/**/*.{ts,tsx}"]));
});

test("P1's own files are clean under the rules they enforce", async () => {
  // The real config, so the enforce files and the processor are exercised as CI runs them.
  const eslint = new ESLint({ cwd: REPO });
  const results = await eslint.lintFiles([
    "src/app/globals.css",
    "src/lib/strings/index.ts",
    "src/lib/strings/shell.generated.ts",
    "src/lib/accents.ts",
    "src/lib/brand/names.ts",
    "src/lib/design/tokens.generated.ts",
  ]);
  const problems = results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => `${r.filePath}:${m.line} ${m.ruleId} ${m.message}`));
  assert.deepEqual(problems, []);
});
