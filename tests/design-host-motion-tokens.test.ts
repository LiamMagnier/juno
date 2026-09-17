import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/*
 * The design host's stylesheet carries the website's motion ladder, verbatim.
 *
 * WHY A SOURCE-READING TEST. The Mac's design editor has no globals.css: its
 * tokens are hand-copied into src/components/design/host/editor.css, and the
 * Tailwind build compiles the website's config against the editor's sources.
 * Every `animate-*` utility therefore arrives in the host as
 * `animation: <name> var(--dur-base) var(--ease-out-soft)`, and for as long as
 * the host existed those two custom properties were declared nowhere in that
 * document. A `var()` with no definition and no fallback makes the shorthand
 * invalid at computed-value time, `animation-name` resolves to `none`, and the
 * entrance simply does not run. No console error, no build failure, no type
 * to check — the adjustments panel, the editor frame and the Ask Juno bar
 * hard-cut on the Mac while the identical components eased in on the web, and
 * nothing said so.
 *
 * The same file also forked `.pressable` at 120ms on a hand-written curve —
 * the exact value globals.css rewrote away because a press that takes 120ms
 * to reach scale(0.97) is felt as lag — so the same toolbar button pressed
 * differently on the two platforms.
 *
 * Both are drift between two copies of one truth, and drift is exactly what a
 * reviewer cannot see in a diff that touches only one of them. So this test
 * reads both files: the ladder in editor.css must equal the ladder in
 * globals.css, the reduced-motion overrides must match, `.pressable` must be
 * the same rule, and the built bundle must declare every motion token it
 * consumes.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string) => readFileSync(join(root, relative), "utf8");
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const globals = stripComments(read("src/app/globals.css"));
const editor = stripComments(read("src/components/design/host/editor.css"));

/** Every `--name: value;` declaration in a block, in file order — as a list,
 *  not a map, because a token declared twice (the base value, then the
 *  reduced-motion alias) must keep both so `ladder` can pick the right one. */
function declarations(block: string): Array<[string, string]> {
  return [...block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]);
}

/** The ladder itself: the FIRST concrete (non-`var()`) declaration of every
 *  --dur-* and --ease-* token in the file. In globals.css that is the `:root`
 *  block; the reduced-motion overrides come later and alias one token to
 *  another, so they are skipped by the `var(` test. */
function ladder(css: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of declarations(css)) {
    if (!/^--(dur|ease)-/.test(name) || value.startsWith("var(") || out.has(name)) continue;
    out.set(name, value);
  }
  return out;
}

/** The `:root` block inside the first `@media (prefers-reduced-motion: reduce)`. */
function reducedRoot(css: string): Array<[string, string]> {
  const media = css.indexOf("@media (prefers-reduced-motion: reduce)");
  assert.notEqual(media, -1, "no reduced-motion media block");
  const start = css.indexOf(":root", media);
  assert.notEqual(start, -1, "reduced-motion block has no :root");
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return declarations(css.slice(open + 1, close));
}

/** The body of the first `selector { … }` rule, whitespace-normalised so the
 *  comparison is about the declarations and not the file's indentation. */
function rule(css: string, selector: string): string {
  const pattern = new RegExp(`(?:^|[\\s}])${selector.replace(/[.:]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const match = css.match(pattern);
  assert.ok(match, `no rule for ${selector}`);
  return match[1].replace(/\s+/g, " ").trim();
}

test("editor.css declares the website's motion ladder, value for value", () => {
  const web = ladder(globals);
  const host = ladder(editor);
  assert.ok(web.size >= 15, `expected the six durations and nine easings in globals.css, found ${web.size}`);
  for (const [name, value] of web) {
    assert.equal(host.get(name), value, `${name} differs between globals.css and editor.css`);
  }
  for (const name of host.keys()) {
    assert.ok(web.has(name), `${name} is declared in editor.css but not in globals.css`);
  }
});

test("editor.css runs the same reduced-motion overrides as the website", () => {
  assert.deepEqual(reducedRoot(editor), reducedRoot(globals));
});

test(".pressable is one rule on both platforms, on the ladder", () => {
  assert.equal(rule(editor, ".pressable"), rule(globals, ".pressable"));
  assert.equal(rule(editor, ".pressable:active"), rule(globals, ".pressable:active"));
  assert.doesNotMatch(rule(editor, ".pressable"), /\d+ms|cubic-bezier/, ".pressable must reference tokens, not raw values");
});

test("the built editor stylesheet declares every motion token it consumes", () => {
  const built = read("native/macOS/JunoDesktop/Resources/DesignEditor/editor.css");
  const consumed = new Set([...built.matchAll(/var\((--(?:dur|ease)-[a-z-]+)/g)].map((m) => m[1]));
  assert.ok(consumed.size > 0, "the bundle consumes no motion tokens — did the build change?");
  const declared = new Set(declarations(built).map(([name]) => name));
  for (const name of consumed) {
    assert.ok(declared.has(name), `${name} is used by the built editor.css but never declared in it`);
  }
});
