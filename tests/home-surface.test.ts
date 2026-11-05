import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/*
 * The home's finish (screens-final critique, home surface): decoration never
 * runs behind type, the empty phone home does not scroll, opening a starter
 * never moves the composer, incognito is the quietest screen, and the tray
 * never cuts a word.
 */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const EMPTY = read("src/components/chat/empty-state.tsx");
const STARTERS_CSS = read("src/components/chat/home-starters.css");
const STARTERS = read("src/components/chat/home-starters.tsx");
const TRAY = read("src/components/chat/composer-tray.tsx");

const homeField = EMPTY.slice(EMPTY.indexOf("export function HomeField"), EMPTY.indexOf("function PrivateField"));

test("the home field is not drawn on a phone, so the empty phone home cannot scroll", () => {
  // composer.css's phone breakpoint is (max-width: 760px); the field hung half
  // below the foot-anchored composer there, as scrollable overflow.
  assert.match(homeField, /\[@media\(max-width:760px\)\]:hidden/);
});

test("the field stops above the composer's top edge, so it never crosses the greeting", () => {
  // Fully transparent AT the edge (no dot fragments in the band above it),
  // fading in over the 32px the composer covers (chat-surface-sweep.test.ts
  // pins the chips' clearing below it).
  assert.match(EMPTY, /const FIELD_TOP = "calc\(50% - var\(--home-field-lift, 75px\)\)";/);
  assert.match(EMPTY, /`transparent \$\{FIELD_TOP\}`,\s*`#000 calc\(\$\{FIELD_TOP\} \+ 32px\)`/);
  assert.match(homeField, /style=\{FIELD_HORIZON_STYLE\}/, "the horizon masks the drawing");
  assert.match(homeField, /<Construction[^>]*\/>/, "inside the masked layer");
  // The edge follows the composer's own height, so a long draft keeps the headline clear.
  assert.match(homeField, /new ResizeObserver\(sync\)/);
  assert.match(homeField, /setProperty\("--home-field-lift", `\$\{composer\.offsetHeight \/ 2\}px`\)/);
});

test("an open prompt list puts the field away, so no orbit runs through a prompt", () => {
  assert.match(STARTERS, /data-open=\{open \? "" : undefined\}/);
  assert.match(STARTERS_CSS, /\.chat-home:has\(\.home-starters\[data-open\]\) \.chat-home__field \{\s*opacity: 0;\s*\}/);
});

test("on a desktop the prompt list hangs out of the grid's sizing, so the composer never moves", () => {
  const desktop = STARTERS_CSS.slice(STARTERS_CSS.indexOf("@media (min-width: 761px)"));
  assert.match(desktop, /\.home-starters__prompts \{\s*position: absolute;\s*top: calc\(100% \+ 14px\);\s*left: 50%;\s*translate: -50% 0;/);
  // The phone keeps its in-flow, bottom-up list (the composer is anchored at the foot there).
  const phone = STARTERS_CSS.slice(STARTERS_CSS.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /flex-direction: column-reverse;/);
  assert.doesNotMatch(phone, /position: absolute/);
});

test("the phone chip row dissolves into the gutter instead of ending on a sliver", () => {
  const phone = STARTERS_CSS.slice(STARTERS_CSS.indexOf("@media (max-width: 760px)"));
  // At rest the gutter fades; an edge with more past it fades wide (56px), so
  // the chip cut by the screen dissolves rather than showing "Pla" at full ink.
  assert.match(phone, /--chips-fade-start: var\(--page-gutter, 1rem\);\s*--chips-fade-end: var\(--page-gutter, 1rem\);/);
  assert.match(phone, /mask-image: linear-gradient\(\s*to right,\s*transparent,[^;]*#000 var\(--chips-fade-start\),\s*#000 calc\(100% - var\(--chips-fade-end\)\),[^;]*transparent\s*\)/);
  assert.match(phone, /\.home-starters__chips\[data-more-end\] \{\s*--chips-fade-end: 56px;/);
  assert.match(STARTERS, /row\.toggleAttribute\("data-more-end", more\);/);
});

test("incognito draws nothing behind its mark or its copy, and its copy is typeset", () => {
  assert.match(EMPTY, /export function PrivateGreeting\(\{ field = false \}/);
  const greeting = EMPTY.slice(EMPTY.indexOf("export function PrivateGreeting"));
  assert.doesNotMatch(greeting, /&apos;|'t /, "typographic apostrophes, as the greeting beside it");
  assert.match(greeting, /won’t appear in your history, won’t be added to memory, and isn’t used/);
});

test("the tray's project control says Project, never a cut 'Select proj…'", () => {
  const row = TRAY.slice(TRAY.indexOf('<div className="composer-tray" data-disabled'));
  // Under 340px the word steps out and the icon stays (composer.css).
  assert.match(row, /<span className="composer-tray__project-word truncate">\{projectName \?\? "Project"\}<\/span>/);
  assert.doesNotMatch(row, /\?\? "Select project"\}<\/span>/, "the long default label is gone from view");
  // The verb stays in the accessible name; a chosen name gets its whole self in a tooltip.
  assert.match(row, /label=\{projectName \? `Project: \$\{projectName\}` : "Select project"\}/);
  // The tooltip is always there: with no project the word can drop to the icon alone.
  assert.match(row, /<TooltipContent>\{projectName \?\? "Select project"\}<\/TooltipContent>/);
  // The media row's control still opens its panel from the tray's end.
  const media = TRAY.slice(TRAY.indexOf("if (params) {"), TRAY.indexOf('<div className="composer-tray" data-disabled'));
  assert.match(media, /align="end"/);
});
