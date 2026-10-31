import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import tailwindConfig from "../tailwind.config";

/**
 * Every `animate-*` class in the product names an animation that exists.
 *
 * WHY. Tailwind emits nothing for an `animate-*` utility whose key is not in
 * the theme, and an animation that does not exist is not an error anywhere:
 * no build warning, no console message, no failing type. When `turn-in` was
 * retired from the map (spec C1), the user's bubble and the assistant turn
 * both kept `motion-safe:animate-turn-in`, the class compiled to nothing, and
 * a sent message cut in with no entrance at all for as long as nobody looked.
 * This walks the source the way Tailwind's content glob does and fails on any
 * name the map, Tailwind core or tailwindcss-animate cannot resolve.
 */

const ROOT = process.cwd();
const animation = (tailwindConfig.theme?.extend?.animation ?? {}) as Record<string, string>;
/** Tailwind core (`spin`, `ping`, `pulse`, `bounce`, `none`) and tailwindcss-animate (`in`, `out`). */
const BUILT_IN = new Set(["spin", "ping", "pulse", "bounce", "none", "in", "out"]);
/** Hand-written `.animate-<name>` rules in globals.css (inside a Tailwind layer, so variants apply). */
const HAND_WRITTEN = new Set(
  [...readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8").matchAll(/^\s*\.animate-([a-z0-9-]+)\s*[{,]/gm)].map((m) => m[1])
);

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(relative, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".generated.ts")) out.push(relative);
  }
  return out;
}

test("every animate-* class in src/ resolves to a compiled animation", () => {
  const unknown: string[] = [];
  for (const file of sources("src")) {
    const text = readFileSync(path.join(ROOT, file), "utf8");
    // A class token: start of string, a space, a quote, a backtick or a variant colon before it.
    for (const match of text.matchAll(/(?:^|[\s"'`:])animate-([a-z0-9-]+)(?=[\s"'`]|$)/gm)) {
      const name = match[1];
      if (!(name in animation) && !BUILT_IN.has(name) && !HAND_WRITTEN.has(name)) unknown.push(`${file}: animate-${name}`);
    }
  }
  assert.deepEqual(unknown, [], "these animate-* classes compile to nothing");
});

test("the sent bubble rises in; the assistant root does not animate (spec C1)", () => {
  const item = readFileSync(path.join(ROOT, "src/components/chat/message-item.tsx"), "utf8");
  assert.match(item, /cn\("group flex flex-col items-end", animateIn && "animate-rise-user"\)/);
  assert.match(item, /className="group flex scroll-mt-24 flex-col gap-2"/, "the assistant root animates again");
  assert.doesNotMatch(item, /animate-turn-in/);
  // The edit bubble's fade is Tier A (opacity only): it plays under reduced motion too.
  assert.match(item, /<div className="w-full animate-fade-in">/);
});
