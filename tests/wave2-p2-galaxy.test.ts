import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createGalaxyRegistry } from "@/components/brand/galaxy-registry";
import { DURATION } from "@/lib/design/tokens.generated";
import { galaxyDots, galaxyStillKey, galaxyStillMask, galaxyStillRule, galaxyStillSvg } from "@/components/brand/galaxy-frame";
import { GALAXY_MOTION, GalaxyMark, galaxyRestDim, galaxyStatusFor } from "@/components/brand/galaxy-mark";
import { StatusMark } from "@/components/brand/status-mark";
import { PlanStepGlyph } from "@/components/ui/plan-step-glyph";

/* P2-web-foundations (12), (13), (14): the galaxy cap, its still frame, StatusMark and PlanStepGlyph. */

// The components compile with the classic JSX runtime under tsx.
(globalThis as { React?: typeof React }).React = React;

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

test("the galaxy registry leaves exactly 3 of 6 running marks animating", () => {
  const registry = createGalaxyRegistry(3);
  const granted = new Map<number, boolean>();
  const entries = Array.from({ length: 6 }, (_, i) =>
    registry.register({ wants: true, visible: true, priority: "other" }, (on) => granted.set(i, on)),
  );
  assert.equal(registry.cap, 3);
  assert.equal(registry.animating(), 3);
  assert.deepEqual(
    entries.map((e) => e.granted()),
    [true, true, true, false, false, false],
    "first come, first served among equals",
  );
  // The live line outranks every row; a hovered row outranks the rest.
  entries[5].update({ priority: "live" });
  entries[4].update({ priority: "focus" });
  assert.deepEqual(entries.map((e) => e.granted()), [true, false, false, false, true, true]);
  assert.equal(registry.animating(), 3);
  assert.equal(granted.get(1), false, "a revoked mark was told");
});

test("the galaxy registry pauses offscreen and hidden-tab marks", () => {
  const registry = createGalaxyRegistry(3);
  const a = registry.register({ wants: true, visible: true, priority: "other" }, () => {});
  const b = registry.register({ wants: true, visible: true, priority: "other" }, () => {});
  const c = registry.register({ wants: true, visible: false, priority: "live" }, () => {});
  assert.equal(c.granted(), false, "an offscreen mark never animates, whatever its priority");
  a.update({ visible: false }); // scrolled away, or the tab hid
  assert.equal(a.granted(), false);
  assert.equal(registry.animating(), 1);
  b.update({ wants: false }); // reduced motion, or the work stopped
  assert.equal(registry.animating(), 0);
  c.update({ visible: true });
  assert.equal(c.granted(), true);
  c.release();
  assert.equal(registry.animating(), 0);
});

test("a non-animating galaxy is a still frame with no canvas element", () => {
  const registry = createGalaxyRegistry(3);
  for (const phase of ["working", "thinking", "finished", "waiting", "error", "idle"] as const) {
    const html = renderToStaticMarkup(React.createElement(GalaxyMark, { phase, size: 10, registry }));
    assert.doesNotMatch(html, /<canvas/, `${phase}: no canvas until the mark holds a slot`);
    assert.match(html, /class="alevr-galaxy-still"/, `${phase}: the still frame`);
    assert.match(html, /data-galaxy-still="10-12"/, "the still frame at the static clock");
    assert.doesNotMatch(html, /data-animating/);
    assert.match(html, /\.alevr-galaxy-still\[data-galaxy-still=&quot;10-12&quot;\]|\.alevr-galaxy-still\[data-galaxy-still="10-12"\]/, `${phase}: the still frame's mask rule ships with it`);
  }
  const waiting = renderToStaticMarkup(React.createElement(GalaxyMark, { phase: "waiting", size: 12, registry }));
  assert.doesNotMatch(waiting, /alevr-galaxy-hand/, "waiting is the run line's still frame, not needs you");
  const needsYou = renderToStaticMarkup(React.createElement(GalaxyMark, { phase: "waiting", status: "needsYou", size: 12, registry }));
  assert.match(needsYou, /alevr-galaxy-hand/, "needs you shows the hand");
  const readyQuick = renderToStaticMarkup(React.createElement(GalaxyMark, { phase: "finished", size: 12, watchedMs: 4000, registry }));
  assert.doesNotMatch(readyQuick, /alevr-galaxy-check/, "no check for a run the reader did not watch for 10s");
  const readyWatched = renderToStaticMarkup(React.createElement(GalaxyMark, { phase: "finished", size: 12, watchedMs: 12_000, registry }));
  assert.match(readyWatched, /alevr-galaxy-check/);
  assert.match(readyWatched, /data-watched=""/);
});

test("galaxy phases map onto the status vocabulary, and the motion numbers are the spec's", () => {
  assert.equal(galaxyStatusFor("thinking"), "running");
  assert.equal(galaxyStatusFor("working"), "running");
  assert.equal(galaxyStatusFor("waiting"), "idle");
  assert.equal(galaxyStatusFor("working", "needsYou"), "needsYou", "a named status wins");
  assert.equal(galaxyRestDim("finished", "ready"), 0.6);
  assert.equal(galaxyRestDim("waiting", "idle"), 1);
  assert.equal(galaxyRestDim("error", "blocked"), 1);
  assert.equal(galaxyStatusFor("finished"), "ready");
  assert.equal(galaxyStatusFor("error"), "blocked");
  assert.equal(galaxyStatusFor("idle"), "idle");
  assert.equal(GALAXY_MOTION.enterMs, 360, "entrance moved from 420 to 360 (D2)");
  assert.equal(GALAXY_MOTION.enterMs, DURATION.slow, "on the ladder");
  assert.equal(GALAXY_MOTION.dimMs, DURATION.base);
  assert.equal(GALAXY_MOTION.periodMs, 2400);
  assert.equal(GALAXY_MOTION.calmPeriodMs, 4800);
  assert.equal(GALAXY_MOTION.calmAfterMs, 20_000);
  assert.equal(GALAXY_MOTION.stopTauMs, 350);
  assert.equal(GALAXY_MOTION.dimMs, 220);
  assert.equal(GALAXY_MOTION.settledDim, 0.6);
});

test("the still frame is the canvas frame at the same clock, cached per size and clock", () => {
  const svg = galaxyStillSvg(14, { s: 1.2 });
  assert.equal(galaxyStillSvg(14, { s: 1.2 }), svg, "deterministic and cached");
  const dots = galaxyDots(14, { s: 1.2, dpr: 2 });
  assert.equal((svg.match(/<circle /g) ?? []).length, dots.filter((d) => d.alpha >= 0.04).length, "one circle per visible canvas dot");
  assert.ok(svg.length < 12_000, `a 14px still frame stays small (${svg.length} bytes)`);
  assert.ok(galaxyStillSvg(96).length < 40_000, "a hero still frame stays small");
  assert.notEqual(galaxyStillSvg(14, { s: 3.4 }), svg, "a later clock is a different frame");
  assert.match(galaxyStillMask(10), /^url\("data:image\/svg\+xml,%3Csvg /);
  assert.equal(galaxyStillKey(10, 1.2), "10-12");
  assert.equal(galaxyStillKey(10, 1.23), "10-12", "the clock is quantised to 0.1s");
  assert.match(galaxyStillRule(10), /^\.alevr-galaxy-still\[data-galaxy-still="10-12"\]\{-webkit-mask-image:url\(/);
  // The entrance spirals in from 0.6 of the radius.
  const arrived = galaxyDots(24, { enter: 1 });
  const entering = galaxyDots(24, { enter: 0 });
  const spread = (ds: typeof arrived) => Math.max(...ds.map((d) => Math.hypot(d.x - 12, d.y - 12)));
  assert.ok(spread(entering) < spread(arrived));
});

test("galaxy ink: computed color, re-read on contrast, forced colours and scheme changes; Highlight under forced colours", () => {
  const mark = read("src/components/brand/galaxy-mark.tsx");
  for (const query of ["(prefers-contrast: more)", "(forced-colors: active)", "(prefers-color-scheme: dark)"]) assert.ok(mark.includes(query), query);
  assert.match(mark, /attributeFilter: \["class", "style", "data-contrast"\]/);
  assert.match(mark, /getComputedStyle\(el\)\.color/);
  const css = read("src/components/brand/brand.css");
  assert.match(css, /@media \(forced-colors: active\) \{[^}]*\.alevr-galaxy-mark[\s\S]*?color: Highlight;/);
  // Every ink is a role token (S1 can be reverted by remapping the role).
  assert.match(css, /\.alevr-galaxy-hand \{\s*color: hsl\(var\(--status-needs-you\)\);/);
  assert.match(css, /\[data-status="blocked"\] \.alevr-galaxy-still \{\s*color: hsl\(var\(--status-blocked\)\);/);
  assert.doesNotMatch(css, /#[0-9a-f]{6}\b/i, "no raw hex");
});

test("StatusMark: four states at 10, 12 and 14, a badge, and always a word", () => {
  for (const status of ["running", "needsYou", "ready", "blocked"] as const) {
    for (const size of [10, 12, 14] as const) {
      const html = renderToStaticMarkup(React.createElement(StatusMark, { status, size }));
      assert.match(html, new RegExp(`data-status="${status}"`));
      assert.match(html, new RegExp(`width:${size}px;height:${size}px`));
      assert.match(html, /class="sr-only">(Running|Needs you|Ready|Blocked)</);
    }
  }
  const badge = renderToStaticMarkup(React.createElement(StatusMark, { status: "needsYou", variant: "badge" }));
  assert.match(badge, /data-variant="badge"/);
  assert.match(badge, /data-size="10"/, "a 10px hand");
  assert.match(badge, /class="sr-only">Needs you</);
  const css = read("src/components/brand/brand.css");
  assert.match(css, /\[data-variant="badge"\] \{[^}]*width: 16px;[^}]*height: 16px;[^}]*background: hsl\(var\(--signal-wash\)\);/);
  for (const role of ["running", "needs-you", "ready", "blocked"]) assert.ok(css.includes(`hsl(var(--status-${role}))`), role);
  const shown = renderToStaticMarkup(React.createElement(StatusMark, { status: "ready", showWord: true }));
  assert.match(shown, /class="text-label">Ready</);
});

test("PlanStepGlyph draws all six states", () => {
  for (const state of ["done", "active", "waiting", "failed", "skipped", "pending"] as const) {
    const html = renderToStaticMarkup(React.createElement(PlanStepGlyph, { state }));
    assert.match(html, new RegExp(`data-state="${state}"`));
    assert.match(html, /role="img" aria-label="/);
  }
  assert.match(renderToStaticMarkup(React.createElement(PlanStepGlyph, { state: "pending" })), /stroke-width="1.5"/);
  assert.match(renderToStaticMarkup(React.createElement(PlanStepGlyph, { state: "active" })), /alevr-galaxy-mark/);
});
