import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BRIM,
  BROW,
  CROWN,
  CROWN_EDGE,
  IncognitoGlyph,
  LENS_FILL,
  LENSES,
  incognitoGestureFor,
  incognitoLine,
} from "@/components/chat/incognito-glyph";
import { shellString } from "@/lib/strings";
import { appearanceTables, asColor, contrastRatio, parseBlocks, resolveColor } from "../scripts/generate-design-tokens";

/*
 * Incognito's mark, its one gesture and its room (the incognito rework):
 * a hat and shades drawn on the house grid with a filled "on" cut, a gesture
 * that plays on a change and never on arrival, motion that stays on the
 * ladder and stops travelling under reduced motion, a dimmed ground that
 * still meets AA, a toggle that stays put as the way out, and a page that
 * says only what the mode does.
 */

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const CSS = read("src/components/chat/incognito.css").replace(/\/\*[\s\S]*?\*\//g, "");
const VIEW = read("src/components/chat/chat-view.tsx");
const TOGGLE = read("src/components/chat/private-chat-toggle.tsx");
const EMPTY = read("src/components/chat/empty-state.tsx");

/* ——— A small path reader: enough of SVG's grammar for the mark ——————————— */

type Point = [number, number];

/** Points that bound a path: ends, cubic control points (a cubic lies in their hull) and samples along arcs. */
function pathPoints(d: string): Point[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const points: Point[] = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case "M":
      case "L": {
        x = ox + num();
        y = oy + num();
        if (cmd.toUpperCase() === "M") [sx, sy] = [x, y];
        points.push([x, y]);
        if (cmd === "M") cmd = "L";
        if (cmd === "m") cmd = "l";
        break;
      }
      case "H":
        x = (rel ? x : 0) + num();
        points.push([x, y]);
        break;
      case "V":
        y = (rel ? y : 0) + num();
        points.push([x, y]);
        break;
      case "C": {
        for (let k = 0; k < 3; k++) points.push([ox + num(), oy + num()]);
        [x, y] = points[points.length - 1];
        break;
      }
      case "A": {
        const r = num();
        num(); // ry: the mark only draws circular arcs
        num(); // rotation
        const large = num();
        const sweep = num();
        const ex = ox + num();
        const ey = oy + num();
        // Endpoint to centre for a circle (SVG 1.1 F.6.5), then sample.
        const mx = (x - ex) / 2;
        const my = (y - ey) / 2;
        const sign = large === sweep ? -1 : 1;
        const k = sign * Math.sqrt(Math.max(0, (r * r - mx * mx - my * my) / (mx * mx + my * my)));
        const cx = k * my + (x + ex) / 2;
        const cy = -k * mx + (y + ey) / 2;
        const a0 = Math.atan2(y - cy, x - cx);
        let a1 = Math.atan2(ey - cy, ex - cx);
        if (sweep && a1 < a0) a1 += 2 * Math.PI;
        if (!sweep && a1 > a0) a1 -= 2 * Math.PI;
        for (let s = 1; s <= 32; s++) {
          const a = a0 + ((a1 - a0) * s) / 32;
          points.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
        [x, y] = [ex, ey];
        break;
      }
      case "Z":
        [x, y] = [sx, sy];
        break;
      default:
        throw new Error(`the mark uses an unread command: ${cmd}`);
    }
  }
  return points;
}

/* ——— The drawing ——————————————————————————————————————————————————————— */

test("the mark draws inside the 18-unit live area, centred on y = 12", () => {
  const all = [CROWN, CROWN_EDGE, BRIM, LENSES, LENS_FILL, BROW].flatMap(pathPoints);
  const xs = all.map(([px]) => px);
  const ys = all.map(([, py]) => py);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  assert.ok(minX >= 3 - 1e-6 && maxX <= 21 + 1e-6, `x spans ${minX}–${maxX}`);
  assert.ok(minY >= 3 - 1e-6 && maxY <= 21 + 1e-6, `y spans ${minY}–${maxY}`);
  assert.equal(maxX - minX, 18, "the brim takes the live area's full width");
  // The crown's control points sit a hair above the curve, so this centre is
  // a touch high of the true one: within half a unit either way.
  assert.ok(Math.abs((minY + maxY) / 2 - 12) <= 0.5, `optical centre at ${(minY + maxY) / 2}`);
});

test("the shades are flat across the brow, so the mark never reads as reading glasses", () => {
  // One bar across both lenses at the top, two bowls hung from it: no ring.
  assert.equal(BROW, "M4.75 15h14.5");
  assert.doesNotMatch(LENSES + LENS_FILL, /circle|a\d+(?:\.\d+)? \d+(?:\.\d+)? 0 1 /, "no full or large-arc ring");
  const lensBottom = Math.max(...pathPoints(LENSES).map(([, py]) => py));
  assert.ok(Math.abs(lensBottom - 19) < 0.05, `lenses end at ${lensBottom}, inside the live area`);
});

test("fill means on: the on cut floods the crown and the lenses, the off cut is line only", () => {
  const on = renderToStaticMarkup(createElement(IncognitoGlyph, { on: true }));
  const off = renderToStaticMarkup(createElement(IncognitoGlyph, { on: false }));
  assert.match(on, /data-on=""/);
  assert.doesNotMatch(off, /data-on=/);
  assert.equal(on.match(/class="im-fill"[^>]*opacity="1"/g)?.length, 2, "crown and lenses filled");
  assert.equal(off.match(/class="im-fill"[^>]*opacity="0"/g)?.length, 2, "nothing filled at rest");
  // Same drawing, same line, either way: the cuts differ in mass, not shape.
  assert.equal(on.replace(/ data-on=""|opacity="1"/g, ""), off.replace(/opacity="0"/g, ""));
});

test("at interface sizes it draws the family's one 1.5px line (signature.css §12)", () => {
  const markup = renderToStaticMarkup(createElement(IncognitoGlyph, { size: 18 }));
  assert.match(markup, /class="icon ag incognito-mark/);
  assert.match(markup, /width="18" height="18" viewBox="0 0 24 24"/);
  assert.match(markup, /stroke-linecap="round" stroke-linejoin="round"/);
  for (const px of [16, 18, 20, 24]) assert.ok(Math.abs((incognitoLine(px) * px) / 24 - 1.5) < 0.01, `${px}px`);
  // The greeting's larger mark grows its line with it, as the set's empty-state glyphs do.
  assert.ok((incognitoLine(32) * 32) / 24 > 2);
});

/* ——— The gesture ———————————————————————————————————————————————————————— */

test("a gesture plays on a change and never on arrival", () => {
  assert.equal(incognitoGestureFor(false, false, null), null, "arriving off: still");
  assert.equal(incognitoGestureFor(true, true, null), null, "arriving on: still");
  assert.equal(incognitoGestureFor(false, true, null), "on");
  assert.equal(incognitoGestureFor(true, false, "on"), "off");
  assert.equal(incognitoGestureFor(false, true, "off"), "on");
  assert.equal(incognitoGestureFor(true, true, "on"), "on", "a re-render keeps the gesture it has");
  // The toggle derives it during render, so it starts in the frame the fill changes.
  assert.match(TOGGLE, /if \(seen !== active\) \{\s*setGesture\(\(current\) => incognitoGestureFor\(seen, active, current\)\);/);
  assert.match(TOGGLE, /<IncognitoGlyph on=\{active\} size=\{18\} gesture=\{gesture\} \/>/);
});

test("the motion is one short gesture on the ladder: transform and opacity only, 160–360ms", () => {
  const keyframes = [...CSS.matchAll(/@keyframes ([\w-]+) \{([\s\S]*?)\n\}/g)];
  assert.deepEqual(keyframes.map((k) => k[1]).sort(), ["incognito-glasses-on", "incognito-hat-off", "incognito-hat-on", "incognito-word-in"]);
  for (const [, name, body] of keyframes) {
    const props = new Set([...body.matchAll(/([a-z-]+):/g)].map((m) => m[1]));
    for (const p of props) assert.ok(["transform", "opacity", "animation-timing-function"].includes(p), `${name} animates ${p}`);
  }
  const durations = [...CSS.matchAll(/animation: incognito-[\w-]+ (\d+)ms/g)].map((m) => Number(m[1]));
  assert.ok(durations.length >= 5);
  for (const ms of durations) assert.ok(ms >= 160 && ms <= 360, `${ms}ms`);
  // Strong ease-out on the way in; the toggle's word uses the same curve.
  assert.match(CSS, /\[data-gesture="on"\] \.im-hat \{\s*animation: incognito-hat-on 320ms var\(--ease-out-expo\) both;/);
  assert.match(TOGGLE, /motion-safe:animate-\[incognito-word-in_220ms_var\(--ease-out-expo\)_both\] motion-reduce:animate-fade-in/);
});

test("reduced motion keeps the fade and the colour, and stops the travel", () => {
  const reduced = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(reduced, /\.incognito-mark\[data-gesture\] :is\(\.im-hat, \.im-glasses\),\s*:root\[data-private-mode\] \.incognito-greet \.incognito-mark :is\(\.im-hat, \.im-glasses\) \{\s*animation: none;/);
  // The fill's fade and the ground's colour sit outside that block.
  assert.match(CSS.slice(0, CSS.indexOf("@media")), /\.incognito-mark \.im-fill \{\s*transition: opacity/);
  assert.match(CSS, /\.juno-content-panel\[data-product="chat"\] \{\s*transition: background-color var\(--dur-slow, 360ms\)/);
  // The greeting's rise is travel: it goes too.
  assert.match(VIEW, /transition-\[opacity,transform\] ease-out-soft motion-reduce:transform-none/);
});

/* ——— The room ——————————————————————————————————————————————————————————— */

test("the incognito ground is a step down in both themes and keeps body and muted text at AA", () => {
  const tables = appearanceTables(parseBlocks(read("src/app/globals.css")));
  const ground = (selector: string) => {
    const block = CSS.slice(CSS.indexOf(selector));
    const value = /--background: ([^;]+);/.exec(block)?.[1];
    assert.ok(value, `${selector} sets a ground`);
    const colour = asColor(value!);
    assert.ok(colour, value);
    return colour!;
  };
  const cases = [
    { theme: "light" as const, selector: ':root:not(.dark)[data-private-mode] .juno-content-panel[data-product="chat"]' },
    { theme: "dark" as const, selector: ':root.dark[data-private-mode] .juno-content-panel[data-product="chat"]' },
  ];
  for (const { theme, selector } of cases) {
    const g = ground(selector);
    for (const ink of ["foreground", "muted-foreground"]) {
      const r = contrastRatio(resolveColor(tables[theme], ink)!, g);
      assert.ok(r >= 4.5, `${theme}: --${ink} on the incognito ground is ${r.toFixed(2)}`);
    }
    // Deliberately different from the page it replaces, not a rounding error:
    // four points of lightness in the dark theme (10% to 6%), six in light.
    const page = resolveColor(tables[theme], theme === "light" ? "card" : "background")!;
    const moved = contrastRatio(page, g);
    assert.ok(moved >= (theme === "light" ? 1.12 : 1.08), `${theme}: the ground moves ${moved.toFixed(2)}:1`);
  }
  // The bubble's own tone is the light ground's, so it lifts to paper there.
  assert.match(CSS, /:root:not\(\.dark\)\[data-private-mode\][^{]*\{[^}]*--user-bubble: 0 0% 100%;/);
});

test("the toggle stays where it was pressed and is the way out", () => {
  // The header band (and the toggle in it) is kept in incognito; only a
  // forked branch trades it for the band.
  assert.match(VIEW, /\{topActionsSlotOwner && !forkedFrom && \(\s*<ThreadHeader/);
  assert.doesNotMatch(VIEW, /privateMode \? "pointer-events-none opacity-0" : "pointer-events-auto opacity-100"/);
  // On a phone, where the header band is not drawn, the band names the mode
  // and closes it; from md up the toggle does both.
  assert.match(VIEW, /!forkedFrom && "md:hidden"/);
  assert.match(VIEW, /<IncognitoGlyph on size=\{18\} \/>\s*Incognito chat/);
  assert.match(TOGGLE, /const label = active \? "Leave incognito" : "Turn on incognito";/);
  assert.match(TOGGLE, /aria-pressed=\{active\}/);
  assert.match(TOGGLE, /"hit-44 relative inline-flex h-9/, "44px under a finger");
  // The pill names the mode; width never tweens (D27).
  assert.match(TOGGLE, /\? "bg-foreground pl-3\.5 pr-2\.5 text-background hover:bg-foreground\/90"/);
  assert.doesNotMatch(TOGGLE, /transition-\[[^\]]*(?:width|padding)/);
});

test("the room changes as one: the greetings hand over and the composer holds still", () => {
  // The leaving headline goes on the exit rung; the arriving one waits for it.
  assert.match(VIEW, /\? "pointer-events-none opacity-0 duration-exit"\s*: "opacity-100 duration-slow \[transition-delay:120ms\]"/);
  assert.match(VIEW, /\? "translate-y-0 opacity-100 duration-slow \[transition-delay:120ms\]"\s*: "pointer-events-none translate-y-1\.5 opacity-0 duration-exit"/);
  // `delay-[…]` is claimed by both Tailwind and tailwindcss-animate, and the
  // ambiguous class compiles to nothing.
  assert.doesNotMatch(VIEW, /\bdelay-\[\d/);
  // The tray steps out in incognito; its place is held so the composer does not drop.
  assert.match(VIEW, /privateMode && "pb-\[46px\]"/);
  // Plain incognito is flat on its ground; only a branch is framed.
  assert.match(VIEW, /forkedFrom\s*\/\/[^\n]*\n[^\n]*\n[^\n]*\n\s*\? "m-2 rounded-popover border/);
});

test("the page says only what incognito does", () => {
  const greeting = EMPTY.slice(EMPTY.indexOf("export function PrivateGreeting"));
  assert.match(greeting, /\{shellString\("incognito\.name"\)\}/);
  assert.match(greeting, /\{shellString\("incognito\.promise"\)\}/);
  assert.match(greeting, /font-serif text-display/, "the house serif, the greeting's rung");
  assert.equal(shellString("incognito.name"), "Incognito chat");
  // No history row and no memory, read or written (lib/chat/turn/private-turn.ts).
  // Nothing about training: a chosen model's provider may train on prompts
  // (`trainsOnPrompts`), and that clause waits on the owner (S8).
  const promise = shellString("incognito.promise");
  assert.equal(promise, "This chat won’t appear in your history and won’t be added to memory.");
  assert.doesNotMatch(promise + greeting.replace(/\/\*[\s\S]*?\*\//g, ""), /\btrain(?:ed|ing)? (?:models|on)\b|isn’t used to train/);
  const turn = read("src/lib/chat/turn/private-turn.ts");
  assert.match(turn, /memories: \[\],\s*memoryEnabled: false,/);
});
