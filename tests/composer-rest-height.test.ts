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

test("the field's rest height is the min-height in its metrics", () => {
  const metrics = /const COMPOSER_FIELD_METRICS =[\s\S]*?"([^"]+)";/.exec(SHELL)?.[1] ?? "";
  const minH = /min-h-\[([\d.]+)rem\]/.exec(metrics);
  assert.ok(minH, "COMPOSER_FIELD_METRICS declares a rem min-height");
  assert.equal(Number(minH![1]) * REM, 52);
});

test("the constant is the field, the controls row and the hairline, added up", () => {
  const metrics = /const COMPOSER_FIELD_METRICS =[\s\S]*?"([^"]+)";/.exec(SHELL)?.[1] ?? "";
  const field = Number(/min-h-\[([\d.]+)rem\]/.exec(metrics)![1]) * REM;

  // The row: `flex flex-nowrap items-center gap-1 px-2.5 pb-2.5 pt-0.5`.
  const row = /className="flex flex-nowrap items-center gap-1 px-2\.5 pb-([\d.]+) pt-([\d.]+)"/.exec(SHELL);
  assert.ok(row, "the controls row keeps its padding in one className");
  const rowPad = spacing(row![1]) + spacing(row![2]);

  // The row's controls: the icon button, the send circle and the chip.
  const icon = /export const composerIconButtonClass =\s*"([^"]+)"/.exec(SHELL)![1];
  const chip = /export const composerChipClass =\s*"([^"]+)"/.exec(SHELL)![1];
  assert.match(icon, /(^|\s)size-8(\s|$)/);
  assert.match(icon, /coarse:size-11/);
  assert.match(chip, /(^|\s)h-8(\s|$)/);
  assert.match(chip, /coarse:h-10/);
  assert.match(SHELL, /composer-primary-action pressable relative grid size-8/);
  assert.match(SHELL, /coarse:size-11",\n\s+className/);
  const tallest = { pointer: 8 * TW, coarse: 11 * TW };

  const edge = 2; // `.composer-surface`: 1px solid, top and bottom

  const declared = /export const COMPOSER_REST_HEIGHT = \{ pointer: (\d+), coarse: (\d+) \}/.exec(SHELL);
  assert.ok(declared, "COMPOSER_REST_HEIGHT is exported");
  assert.equal(Number(declared![1]), field + rowPad + tallest.pointer + edge);
  assert.equal(Number(declared![2]), field + rowPad + tallest.coarse + edge);

  const cls = /export const composerRestHeightClass = "h-\[(\d+)px\] coarse:h-\[(\d+)px\]"/.exec(SHELL);
  assert.ok(cls, "the class form is exported beside the numbers");
  assert.equal(cls![1], declared![1]);
  assert.equal(cls![2], declared![2]);
});

test("both chat skeletons take the composer's height from the shell", () => {
  for (const file of ["src/app/(app)/chat/loading.tsx", "src/app/(app)/chat/[id]/loading.tsx"]) {
    const source = read(file);
    assert.match(source, /composerRestHeightClass/, `${file} draws the composer at the shell's rest height`);
    assert.ok(!/h-\[\d+px\][^"]*rounded-composer/.test(source), `${file} writes no composer height of its own`);
  }
});
