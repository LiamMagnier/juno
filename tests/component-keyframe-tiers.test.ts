import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

/**
 * Every travelling keyframe in a component stylesheet has a reduced-motion
 * tier (spec §4.7), the way globals.css's tier table holds its own.
 *
 * tests/wave2-p1-tier-table.test.ts covers globals.css and the Tailwind map,
 * and nothing covered the ~120 keyframes in the 30 component sheets. Some of
 * them slid and scaled exactly as far for a reader who had asked the OS (or
 * Settings › Motion) for less: the live blueprint's rows and leaves, the
 * generated picture's zoom, Code's badge. A keyframe that moves (translate,
 * scale or rotate) must do one of three things:
 *
 *   B   read --motion-shift / --motion-scale-from, so the preference leaves
 *       its fade and takes its travel;
 *   -   play only inside `@media (prefers-reduced-motion: no-preference)`;
 *   C   be replaced or stopped for its element by a reduced-motion rule in the
 *       same sheet (a loop, or a choreography swapped wholesale for a fade).
 *
 * The PostCSS twin (postcss/motion-preference.cjs) compiles each of those
 * media blocks for the in-app setting too, so one rule serves both.
 */

const ROOT = process.cwd();
const require = createRequire(path.join(ROOT, "package.json"));
const postcss = require("postcss") as typeof import("postcss");

/** Transforms that are where an element RESTS, not travel (named, with the reason in the sheet). */
const RESTING: Record<string, string> = {
  // generation.css: the blurred layer is oversized so its soft edge never shows.
  "gen-blur-in": "scale(1.15)",
};

function sheets(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) sheets(relative, out);
    else if (entry.name.endsWith(".css")) out.push(relative);
  }
  return out;
}

const transforms = (body: string) => [...body.matchAll(/\b(?:transform|translate|scale|rotate)\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());

/** Moves nothing: identity terms, and the centring a positioned element carries. */
function isIdentity(value: string): boolean {
  return (
    value
      .replace(/\btranslate[XYZ]?\(\s*-?50%(\s*,\s*-?50%)?\s*\)/g, "")
      .replace(/\btranslate(?:3d|[XYZ])?\(\s*0(?:px)?(?:\s*,\s*0(?:px)?)*\s*\)/g, "")
      .replace(/\bscale[XY]?\(\s*1\s*\)/g, "")
      .replace(/\brotate\(\s*0(?:deg)?\s*\)/g, "")
      .replace(/\bnone\b/g, "")
      .replace(/^0(?:deg)?$/, "")
      .replace(/^1$/, "")
      .trim() === ""
  );
}

type Node = import("postcss").Node;
function inMedia(node: Node, pattern: RegExp): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && (parent as import("postcss").AtRule).name === "media" && pattern.test((parent as import("postcss").AtRule).params)) return true;
  }
  return false;
}
const NO_PREFERENCE = /prefers-reduced-motion\s*:\s*no-preference/;
const REDUCE = /prefers-reduced-motion\s*(?::\s*reduce\s*)?\)/;

test("every travelling component keyframe is tiered for reduced motion", () => {
  const untiered: string[] = [];
  let checked = 0;
  for (const file of sheets("src/components")) {
    const tree = postcss.parse(readFileSync(path.join(ROOT, file), "utf8"));
    const frames = new Map<string, string>();
    tree.walkAtRules(/keyframes$/, (rule) => {
      frames.set(rule.params, rule.toString());
    });
    // Selectors a reduced-motion rule in this sheet re-animates or stops.
    const replaced: string[] = [];
    tree.walkDecls(/^animation(?:-name)?$/, (decl) => {
      if (inMedia(decl, REDUCE) && decl.parent?.type === "rule") replaced.push(...(decl.parent as import("postcss").Rule).selectors);
    });
    for (const [name, body] of frames) {
      const raw = transforms(body).filter((t) => !isIdentity(t) && !/var\(--motion-(?:shift|scale-from)/.test(t) && RESTING[name] !== t);
      if (!raw.length) continue;
      checked += 1;
      const usage = new RegExp(`(^|[\\s,])${name}([\\s,]|$)`);
      tree.walkDecls(/^animation(?:-name)?$/, (decl) => {
        if (!usage.test(decl.value) || inMedia(decl, NO_PREFERENCE) || inMedia(decl, REDUCE)) return;
        const selectors = decl.parent?.type === "rule" ? (decl.parent as import("postcss").Rule).selectors : [];
        const covered = selectors.every((s) => replaced.some((r) => s === r || s.startsWith(r)));
        if (!covered) untiered.push(`${file}: @keyframes ${name} on ${selectors.join(", ")} (${raw.join("; ")})`);
      });
    }
  }
  assert.ok(checked > 20, `expected to check the component sheets' travelling keyframes, checked ${checked}`);
  assert.deepEqual(untiered, [], "these keyframes keep their full travel under reduced motion");
});

test("the keyframes the audit found unguarded now read --motion-shift", () => {
  const blueprint = readFileSync(path.join(ROOT, "src/components/canvas/live-blueprint.css"), "utf8");
  assert.match(blueprint, /@keyframes bp-snap \{\s*from \{ opacity: 0; transform: translateY\(calc\(6px \* var\(--motion-shift, 1\)\)\); \}/);
  assert.match(blueprint, /@keyframes bp-pop \{\s*from \{ opacity: 0; transform: scale\(calc\(1 - 0\.06 \* var\(--motion-shift, 1\)\)\); \}/);
  const generation = readFileSync(path.join(ROOT, "src/components/chat/generation.css"), "utf8");
  assert.match(generation, /@keyframes gen-settle \{ from \{ transform: scale\(calc\(1 \+ 0\.025 \* var\(--motion-shift, 1\)\)\); \}/);
  // A progress fill is state (Tier A): reduced motion no longer cuts it.
  assert.doesNotMatch(generation, /\.gen-progress__fill \{ transition: none; \}/);
  const code = readFileSync(path.join(ROOT, "src/components/code/v2/code-v2.css"), "utf8");
  assert.match(code, /@keyframes cv2-badge-in \{ from \{ opacity: 0; transform: scale\(calc\(1 - 0\.4 \* var\(--motion-shift, 1\)\)\); \}/);
});
