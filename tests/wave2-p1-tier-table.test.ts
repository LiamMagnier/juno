import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import tailwindConfig from "../tailwind.config";

/**
 * Spec §4.7: every keyframe has a tier in the table in globals.css, checked
 * here. A is kept, B keeps its fade and loses its travel (every transform
 * reads --motion-shift / --motion-scale-from), C stops. And no keyframe
 * blurs (C1: no blur in any entrance).
 */

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** `name` → body, for every @keyframes in globals.css. */
function cssKeyframes(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /@keyframes ([\w-]+)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth && i < stripped.length) {
      if (stripped[i] === "{") depth += 1;
      else if (stripped[i] === "}") depth -= 1;
      i += 1;
    }
    out.set(m[1], (out.get(m[1]) ?? "") + stripped.slice(re.lastIndex, i - 1));
  }
  return out;
}

/** `name` → the keyframe object's text, for every Tailwind keyframe. */
function tailwindKeyframes(): Map<string, string> {
  const frames = (tailwindConfig.theme?.extend?.keyframes ?? {}) as Record<string, unknown>;
  return new Map(Object.entries(frames).map(([name, body]) => [name, JSON.stringify(body)]));
}

function tierTable(): Map<string, { tier: string; note: string }> {
  const begin = css.indexOf("@tier-table:begin");
  const end = css.indexOf("@tier-table:end");
  assert.ok(begin > 0 && end > begin, "globals.css has no tier table");
  const rows = new Map<string, { tier: string; note: string }>();
  for (const line of css.slice(begin, end).split("\n").slice(1)) {
    const m = /^\s*\*\s+([\w-]+)\s+([ABC])\b\s*(.*)$/.exec(line);
    if (!m) continue;
    assert.ok(!rows.has(m[1]), `${m[1]} is in the tier table twice`);
    rows.set(m[1], { tier: m[2], note: m[3] });
  }
  return rows;
}

const all = new Map<string, string>([...tailwindKeyframes(), ...cssKeyframes()]);
const table = tierTable();

test("every keyframe has exactly one tier, and every row names a keyframe that exists", () => {
  const missing = [...all.keys()].filter((name) => !table.has(name)).sort();
  const stale = [...table.keys()].filter((name) => !all.has(name)).sort();
  assert.deepEqual(missing, [], "keyframes with no tier — add them to the table in globals.css");
  assert.deepEqual(stale, [], "tier-table rows whose keyframe is gone — delete them");
});

/** Each transform-like value in a keyframe body. */
function transforms(body: string): string[] {
  return [...body.matchAll(/(?:"|\b)(transform|translate|scale|rotate)"?\s*:\s*"?([^;"}]+)/g)].map((m) => m[2].trim());
}

/** A transform that moves nothing: identity terms, and the centring a positioned element carries. */
function isIdentity(value: string): boolean {
  const rest = value
    .replace(/\btranslate[XYZ]?\(\s*-?50%(\s*,\s*-?50%)?\s*\)/g, "")
    .replace(/\btranslate(?:3d|[XYZ])?\(\s*0(?:px)?(?:\s*,\s*0(?:px)?)*\s*\)/g, "")
    .replace(/\bscale[XY]?\(\s*1\s*\)/g, "")
    .replace(/\brotate\(\s*0(?:deg)?\s*\)/g, "")
    .replace(/\bnone\b/g, "")
    .trim();
  return rest === "";
}

test("tier A keyframes carry no travel", () => {
  for (const [name, { tier }] of table) {
    if (tier !== "A") continue;
    for (const t of transforms(all.get(name)!)) assert.ok(isIdentity(t), `${name} is tier A but moves: ${t}`);
  }
});

test("every transform in a tier B keyframe reads --motion-shift or --motion-scale-from", () => {
  for (const [name, { tier }] of table) {
    if (tier !== "B") continue;
    for (const t of transforms(all.get(name)!)) {
      assert.ok(isIdentity(t) || /var\(--motion-(?:shift|scale-from)/.test(t), `${name} is tier B but its travel ignores the preference: ${t}`);
    }
  }
});

test("no keyframe blurs", () => {
  for (const [name, body] of all) assert.doesNotMatch(body, /blur\(/, `${name} blurs`);
  // The two retired entrances are gone for good.
  assert.ok(!all.has("turn-in"), "turn-in (420ms, blur) is retired");
  assert.ok(!all.has("stream-block-in"), "stream-block-in (blur) is retired");
});

test("the transcript entrances: rise-user (6px, 120) and settle-part (4px, 220), no blur", () => {
  assert.match(all.get("rise-user")!, /translateY\(calc\(6px \* var\(--motion-shift, 1\)\)\)/);
  assert.match(all.get("settle-part")!, /translateY\(calc\(4px \* var\(--motion-shift, 1\)\)\)/);
  const animation = (tailwindConfig.theme?.extend?.animation ?? {}) as Record<string, string>;
  assert.equal(animation["rise-user"], "rise-user var(--dur-fast) var(--ease-out-soft) both");
  assert.equal(animation["settle-part"], "settle-part var(--dur-base) var(--ease-out-soft) both");
  assert.equal(animation["turn-in"], undefined);
  assert.match(css, /\[data-turn-streaming\] \.turn-body > \* \{\s*animation: settle-part var\(--dur-base\)/);
});

test("reduced motion no longer cuts the Tier A fades on the composer, the primary key and the sidebar glyph", () => {
  assert.doesNotMatch(stripped, /\.composer-surface, \.composer-surface::after \{ transition: none; \}/);
  assert.doesNotMatch(stripped, /\.control-primary \{ transition: none; \}/);
  assert.doesNotMatch(stripped, /\.sidebar-motion-icon__glyph \{ transition: none; \}/);
  // The press dip (travel) still goes.
  assert.match(stripped, /\.control-primary:active \{ transform: none; \}/);
});
