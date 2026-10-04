import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/*
 * THE CHAT SKELETONS ARE AS TALL AS THE COMPOSER THEY STAND IN FOR.
 *
 * `COMPOSER_REST_HEIGHT` (src/components/ui/composer-shell.tsx) is a sum of
 * three metrics declared in the same file: the field's min-height, the
 * controls row (its padding plus its tallest control) and the surface's
 * hairline. The chat loading pages draw their composer placeholder from it.
 * The constant is only as good as the sum, so this re-adds the metrics from
 * the source text and fails when one of them moves without the other.
 *
 * Read as text rather than imported: the shell pulls in next/image and
 * framer-motion, and what is being checked is the arithmetic in the source.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const SHELL = read("src/components/ui/composer-shell.tsx");

const REM = 16;
const TW = 4; // one Tailwind spacing step, in px

function spacing(token: string): number {
  return Number(token) * TW;
}

const metrics = () => /const COMPOSER_FIELD_METRICS =[\s\S]*?"([^"]+)";/.exec(SHELL)?.[1] ?? "";
/** The field's min-height in px: the pointer rung, or the `coarse:` one. */
function fieldMinHeight(variant: "pointer" | "coarse"): number {
  const re = variant === "coarse" ? /coarse:min-h-\[([\d.]+)rem\]/ : /(?:^|\s)min-h-\[([\d.]+)rem\]/;
  const hit = re.exec(metrics());
  assert.ok(hit, `COMPOSER_FIELD_METRICS declares a ${variant} rem min-height`);
  return Number(hit![1]) * REM;
}

test("the field's rest height is the min-height in its metrics", () => {
  // A 46px field in the dock (16px over one 26px line, 4px under it: the
  // equal-inset rule, 16px from the top as from the side), 52px under a
  // coarse pointer.
  assert.equal(fieldMinHeight("pointer"), 46);
  assert.equal(fieldMinHeight("coarse"), 52);
});

test("the constant is the field, the controls row and the hairline, added up", () => {
  // The row: `flex flex-nowrap items-center gap-0.5 px-2.5 pb-2.5 pt-1.5`.
  const row = /className="flex flex-nowrap items-center gap-0\.5 px-2\.5 pb-([\d.]+) pt-([\d.]+)(?: shrink-0)?"/.exec(SHELL);
  assert.ok(row, "the controls row keeps its padding in one className");
  const rowPad = spacing(row![1]) + spacing(row![2]);

  // The row's controls: the 32px icon button, the 36px disc and the chip;
  // every one of them 44px under a coarse pointer.
  const icon = /export const composerIconButtonClass =\s*"([^"]+)"/.exec(SHELL)![1];
  const chip = /export const composerChipClass =\s*"([^"]+)"/.exec(SHELL)![1];
  assert.match(icon, /(^|\s)size-8(\s|$)/);
  assert.match(icon, /coarse:size-11/);
  assert.match(chip, /(^|\s)h-8(\s|$)/);
  assert.match(chip, /coarse:h-10/);
  assert.match(SHELL, /composer-primary-action pressable relative grid size-9/);
  assert.match(SHELL, /coarse:size-11",\n\s+className/);
  const tallest = { pointer: 9 * TW, coarse: 11 * TW };

  const edge = 2; // `.composer-surface`: 1px solid, top and bottom

  const declared = /export const COMPOSER_REST_HEIGHT = \{ pointer: (\d+), coarse: (\d+) \}/.exec(SHELL);
  assert.ok(declared, "COMPOSER_REST_HEIGHT is exported");
  assert.equal(Number(declared![1]), fieldMinHeight("pointer") + rowPad + tallest.pointer + edge);
  assert.equal(Number(declared![2]), fieldMinHeight("coarse") + rowPad + tallest.coarse + edge);

  const cls = /export const composerRestHeightClass = "h-\[(\d+)px\] coarse:h-\[(\d+)px\]"/.exec(SHELL);
  assert.ok(cls, "the class form is exported beside the numbers");
  assert.equal(cls![1], declared![1]);
  assert.equal(cls![2], declared![2]);
});

test("the home's rest height is its taller field over the same row and edge", () => {
  const composer = read("src/components/chat/composer.tsx");
  const home = /frame === "landing" && "min-h-\[([\d.]+)rem\]/.exec(composer);
  assert.ok(home, "composer.tsx gives the landing frame's field its min-height");
  const declared = /export const COMPOSER_HOME_REST_HEIGHT = \{ pointer: (\d+), coarse: (\d+) \}/.exec(SHELL);
  assert.ok(declared, "COMPOSER_HOME_REST_HEIGHT is exported");
  const dock = /export const COMPOSER_REST_HEIGHT = \{ pointer: (\d+), coarse: (\d+) \}/.exec(SHELL)!;
  // The same row and edge as the dock; only the field differs (and only for a fine pointer).
  assert.equal(Number(declared![1]) - Number(home![1]) * REM, Number(dock[1]) - fieldMinHeight("pointer"));
  assert.equal(Number(declared![2]), Number(dock[2]));
  const cls = /export const composerHomeRestHeightClass = "h-\[(\d+)px\] coarse:h-\[(\d+)px\]"/.exec(SHELL);
  assert.ok(cls);
  assert.deepEqual([cls![1], cls![2]], [declared![1], declared![2]]);
});

test("both chat skeletons take the composer's height from the shell", () => {
  const cases = [
    ["src/app/(app)/chat/loading.tsx", /composerHomeRestHeightClass/, "the home's rest height"],
    ["src/app/(app)/chat/[id]/loading.tsx", /composerRestHeightClass/, "the dock's rest height"],
  ] as const;
  for (const [file, uses, what] of cases) {
    const source = read(file);
    assert.match(source, uses, `${file} draws the composer at ${what}`);
    assert.ok(!/h-\[\d+px\][^"]*rounded-composer/.test(source), `${file} writes no composer height of its own`);
  }
});

/*
 * THE NEW-CHAT SKELETON IS IN THE LANDING'S FRAME, NOT THE DOCK'S.
 *
 * The composer is one element in two frames (composer.tsx, `frame`): the dock
 * pads itself with a gutter and a bottom inset, the landing takes neither. The
 * skeleton once drew the landing's composer in the dock's frame, so it stood
 * 24px of padding too tall and two gutters too narrow on a phone. And the
 * greeting row is a grid that also holds the incognito greeting, which is the
 * taller of the two, so a row sized to the display line alone came up 47px
 * short. Together the composer landed 38px below its placeholder.
 */
test("the new-chat skeleton stands in the landing frame chat-view draws", () => {
  const skeleton = read("src/app/(app)/chat/loading.tsx");
  const composer = read("src/components/chat/composer.tsx");
  const chatView = read("src/components/chat/chat-view.tsx");

  const landing = /frame === "landing" && "([^"]+)"/.exec(composer);
  assert.ok(landing, "composer.tsx declares the landing frame's classes");
  assert.ok(skeleton.includes(`"${landing![1]}"`), "the skeleton's composer takes the landing frame's classes");

  const dockPad = /frame === "dock" &&[\s\S]*?"(pb-\[calc\(1rem[^"]+)"/.exec(composer);
  assert.ok(dockPad, "composer.tsx declares the dock's bottom inset");
  assert.ok(!skeleton.includes(dockPad![1]), "the skeleton does not pad the landing composer like the dock");

  assert.match(chatView, /<EmptyGreeting \/>[\s\S]*<PrivateGreeting \/>/, "chat-view stacks both greetings in one row");
  assert.match(skeleton, /<PrivateGreeting \/>/, "the skeleton sizes the greeting row by the incognito greeting too");

  // The empty screen is the greeting and the composer alone: no starting-point
  // row under it, and so none in the skeleton either.
  assert.doesNotMatch(chatView, /StarterChips/, "chat-view draws nothing under the composer");
  assert.doesNotMatch(skeleton, /startingGridClass/, "the skeleton draws no starting-point row");
});
