/**
 * The sidebar and palette polish (screens-final critique, surface
 * "sidebar-nav"): the logic behind the fixes, and the source contracts that
 * keep them from quietly coming back.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { chipRevealScroll, CHIP_REVEAL_MARGIN } from "@/components/app/chip-strip";
import { chordKeys, chordLabel, keyCap } from "@/components/app/key-chord";
import {
  focusSnippet,
  matchMarks,
  SNIPPET_LEAD,
  SNIPPET_LEAD_SLACK,
  SNIPPET_LEAD_WIDE,
  SNIPPET_TAIL,
  SNIPPET_TAIL_WIDE,
} from "@/components/app/palette-text";
import {
  NEEDS_YOU_ROWS,
  needsYouSlice,
  ORBIT_ATTENTION_STATES,
  orbitRowLimit,
  orbitRows,
  parseOpenProjects,
  SHORT_WINDOW_QUERY,
  withProjectOpen,
} from "@/components/app/sidebar-lists";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/* ── Shortcut hints ─────────────────────────────────────────────────────── */

test("shortcut hints keep the glyphs on Apple and spell the keys elsewhere", () => {
  assert.deepEqual(chordKeys("⌘⇧O", "⌘"), ["⌘", "⇧", "O"]);
  assert.deepEqual(chordKeys("Ctrl⇧O", "Ctrl"), ["Ctrl", "Shift", "O"]);
  assert.deepEqual(chordKeys("Ctrl/", "Ctrl"), ["Ctrl", "/"]);
  assert.deepEqual(chordKeys("⌘/", "⌘"), ["⌘", "/"]);
  assert.deepEqual(chordKeys("Esc", "Ctrl"), ["Esc"]);
  assert.deepEqual(chordKeys("⌥⌘I", "Ctrl"), ["Alt", "Ctrl", "I"]);
  assert.equal(chordLabel("⌘⇧S", "⌘"), "⌘⇧S");
  assert.equal(chordLabel("Ctrl⇧S", "Ctrl"), "Ctrl+Shift+S");
});

test("the sidebar and the palette build their hints through the chord helper", () => {
  const sidebar = read("src/components/app/app-sidebar.tsx");
  const palette = read("src/components/app/command-palette.tsx");
  assert.doesNotMatch(sidebar, /<Kbd>\{`\$\{mod\}⇧/, "no raw `${mod}⇧…` keycap left in the sidebar");
  assert.match(sidebar, /chordLabel\(`\$\{mod\}⇧O`, mod\)/);
  assert.match(palette, /chordKeys\(c\.hint, mod\)/);
  assert.doesNotMatch(palette, /function splitKeys/);
  // Off a Mac the palette draws a chord as the sheet and the sidebar do: one "Ctrl+Shift+O" cap.
  assert.match(palette, /isAppleModifier\(mod\) \?\s*\(\s*chordKeys\(c\.hint, mod\)\.map\(\(k, ki\) => <Kbd key=\{ki\}>\{k\}<\/Kbd>\)\s*\) : \(\s*<Kbd>\{chordLabel\(c\.hint, mod\)\}<\/Kbd>/);
});

test("a filter pill picked with the mouse keeps its pill look, with no field ring", () => {
  const palette = read("src/components/app/command-palette.tsx");
  const cls = palette.slice(palette.indexOf("const filterSelectClass"), palette.indexOf("const filters = trimmed"));
  assert.match(cls, /focus-visible:shadow-none/, "the SelectTrigger's 3px halo is cancelled");
  assert.match(cls, /kbd-focus:outline kbd-focus:outline-2 kbd-focus:outline-offset-2 kbd-focus:outline-ring/, "the keyboard still gets the chips' ring");
  assert.match(cls, /focus-visible:border-border focus-visible:bg-foreground\/10/, "a set pill keeps its set edge and fill");
  assert.match(cls, /focus-visible:border-transparent focus-visible:bg-secondary/, "a pill at rest keeps no edge");
});

/* ── Palette text ───────────────────────────────────────────────────────── */

test("a typed query is marked in a title, preferring a word start", () => {
  assert.deepEqual(matchMarks("Pricing page copy", "pric"), [{ start: 0, end: 4 }]);
  assert.deepEqual(matchMarks("Caprice and pricing", "pric"), [{ start: 12, end: 16 }]);
  assert.deepEqual(matchMarks("Caprice", "pric"), [{ start: 2, end: 6 }]);
  assert.deepEqual(matchMarks("Caprice", "pric", { wordStartOnly: true }), []);
  assert.deepEqual(matchMarks("Anything", "  "), []);
  assert.deepEqual(matchMarks("Résumé review", "rés"), [{ start: 0, end: 3 }]);
});

test("a snippet is cut so its first match is near the start of the line", () => {
  const lead = "…we talked about a partial index on (user_id, updated_at) before the ";
  const text = `${lead}sync worker runs, and the rest of the plan after that point`;
  const start = lead.length;
  const out = focusSnippet({ text, marks: [{ start, end: start + 4 }] });
  const [mark] = out.marks;
  assert.equal(out.text.slice(mark.start, mark.end), "sync", "the mark still covers the match");
  assert.ok(mark.start <= SNIPPET_LEAD + SNIPPET_LEAD_SLACK + 1, `the match starts within the lead (at ${mark.start})`);
  assert.ok(out.text.startsWith("…"), "the cut is marked");
  assert.doesNotMatch(out.text, /^…\s/, "no space after the leading ellipsis");
  assert.match(out.text.slice(1), /^\S/, "it starts on a word, not inside one");
  const word = out.text.slice(1).split(" ")[0];
  assert.ok(text.includes(` ${word} `), `"${word}" is a whole word of the source`);
});

test("a phone snippet never opens inside a token or on punctuation", () => {
  // The verifier's case: by spaces "updated_at)" is a word, but it is the
  // tail of "(user_id, updated_at)". The cut steps back to keep it whole.
  const text = "…we settled on a partial index on (user_id, updated_at) keeps the sync query under 5 ms for the hot path";
  const at = text.indexOf("sync");
  const out = focusSnippet({ text, marks: [{ start: at, end: at + 4 }] });
  assert.ok(out.text.startsWith("…(user_id, updated_at) keeps the sync"), out.text);
  assert.equal(out.text.slice(out.marks[0].start, out.marks[0].end), "sync");
  // The tail gives the lead its extra characters back: still about two phone lines.
  assert.ok(out.text.length <= 1 + SNIPPET_LEAD + 4 + SNIPPET_TAIL + 2, `${out.text.length} characters`);

  // A cut that would open on a comma or a closing bracket moves to a clean word.
  const commas = "the plan was simple, really: a reindex, then a vacuum, and finally, sync the replicas before the morning traffic";
  const c = commas.indexOf("sync");
  const cut = focusSnippet({ text: commas, marks: [{ start: c, end: c + 4 }] });
  assert.match(cut.text, /^…[\p{L}\p{N}(]/u, cut.text);
  assert.equal(cut.text.slice(cut.marks[0].start, cut.marks[0].end), "sync");

  // A bracket opened too far back for the slack: the match opens the line
  // rather than a fragment of the group.
  const group = "one (two three four five six seven eight nine ten eleven twelve) sync tail";
  const g = group.indexOf("sync");
  assert.equal(focusSnippet({ text: group, marks: [{ start: g, end: g + 4 }] }).text, "…sync tail");

  // A clean start at the target is kept exactly as before.
  const plain = `${"word ".repeat(12)}sync and more`;
  const p = plain.indexOf("sync");
  const kept = focusSnippet({ text: plain, marks: [{ start: p, end: p + 4 }] });
  assert.ok(kept.marks[0].start <= SNIPPET_LEAD + 1, `${kept.marks[0].start}`);
});

test("a snippet's tail is cut at a word, with no space before the ellipsis", () => {
  const text = `sync ${"word ".repeat(30)}end`;
  const out = focusSnippet({ text, marks: [{ start: 0, end: 4 }] });
  assert.ok(out.text.endsWith("…"));
  assert.doesNotMatch(out.text, /\s…$/);
  assert.ok(out.text.length <= 4 + 48 + 2);
  assert.deepEqual(out.marks, [{ start: 0, end: 4 }]);
});

test("a short snippet is left alone, apart from the space beside an ellipsis", () => {
  const near = { text: "the sync worker", marks: [{ start: 4, end: 8 }] };
  assert.deepEqual(focusSnippet(near), near);
  const spaced = focusSnippet({ text: "… the sync worker …", marks: [{ start: 6, end: 10 }] });
  assert.equal(spaced.text, "…the sync worker…");
  assert.equal(spaced.text.slice(spaced.marks[0].start, spaced.marks[0].end), "sync");
});

test("marks past the kept text are dropped rather than pointing outside it", () => {
  const text = `sync ${"word ".repeat(30)}sync`;
  const out = focusSnippet({ text, marks: [{ start: 0, end: 4 }, { start: text.length - 4, end: text.length }] });
  assert.equal(out.marks.length, 1);
  for (const m of out.marks) assert.ok(m.end <= out.text.length);
});

/* ── Sidebar lists ──────────────────────────────────────────────────────── */

test("Needs you draws three rows and a count past them, never a lone '1 more'", () => {
  assert.equal(NEEDS_YOU_ROWS, 3);
  assert.deepEqual(needsYouSlice(0, false), { shown: 0, more: 0 });
  assert.deepEqual(needsYouSlice(3, false), { shown: 3, more: 0 });
  assert.deepEqual(needsYouSlice(4, false), { shown: 4, more: 0 }, "one extra ask is drawn, not summarised");
  assert.deepEqual(needsYouSlice(5, false), { shown: 3, more: 2 });
  assert.deepEqual(needsYouSlice(9, false), { shown: 3, more: 6 });
  assert.deepEqual(needsYouSlice(9, true), { shown: 9, more: 0 });
});

test("unfolded projects are remembered as a clean list of ids", () => {
  assert.deepEqual(parseOpenProjects(null), []);
  assert.deepEqual(parseOpenProjects("not json"), []);
  assert.deepEqual(parseOpenProjects('{"a":1}'), []);
  assert.deepEqual(parseOpenProjects('["p1", 2, "", "p2"]'), ["p1", "p2"]);
  assert.deepEqual(withProjectOpen(["p1"], "p2", true), ["p1", "p2"]);
  assert.deepEqual(withProjectOpen(["p1", "p2"], "p1", false), ["p2"]);
  assert.deepEqual(withProjectOpen(["p1", "p1"], "p1", true), ["p1"], "no duplicates");
  assert.deepEqual(withProjectOpen(["gone", "p1"], "p2", true, ["p1", "p2"]), ["p1", "p2"], "unpinned ids are dropped");
});

/* ── Source contracts ───────────────────────────────────────────────────── */

test("sidebar titles fade instead of ending in an ellipsis", () => {
  const sidebar = read("src/components/app/app-sidebar.tsx");
  const css = read("src/components/app/sidebar-column.css");
  assert.match(sidebar, /import "@\/components\/app\/sidebar-column\.css"/);
  assert.match(sidebar, /const TITLE_FADE = "title-fade text-clip"/);
  assert.equal((sidebar.match(/textClassName=\{TITLE_FADE\}/g) ?? []).length, 2, "chat rows and project rows");
  assert.match(css, /\.title-fade \{[^}]*text-overflow: clip/);
  // Only a title that is cut carries the mask (a scroll timeline is only
  // active while the text overflows its box).
  assert.match(css, /animation-timeline: scroll\(self inline\)/);
});

test("the Code column's rows fade the way the Chat rows do", () => {
  const code = read("src/components/app/code-work-list.tsx");
  // It is drawn outside the sidebar too (the Code workspace), so it brings the rule.
  assert.match(code, /import "@\/components\/app\/sidebar-column\.css"/);
  assert.doesNotMatch(code, /\btruncate\b/, "no ellipsis anywhere in the list");
  assert.match(code, /"title-fade min-w-0 flex-1 text-nav"/, "the row title");
  assert.match(code, /className="title-fade title-fade-hug min-w-0 shrink">\{t\.project\}/, "the project");
  assert.match(code, /className="title-fade min-w-0 flex-1">\{where\}/, "the branch or pull request");
});

test("a label as wide as its text is masked only where a cut can be told", () => {
  /*
   * Without scroll timelines (Firefox) every `.title-fade` carries the mask.
   * A label that fills its slot only fades empty space unless it runs to the
   * edge, but a label sized to its own text ends on its last letter, so the
   * Code list's project names and its "All projects" filter were faded at
   * the end even when they fit. Those labels are `title-fade-hug`: no mask
   * outside `@supports (animation-timeline: scroll())`, and inside it the
   * scroll-driven fade that appears only while the text is cut.
   */
  const css = read("src/components/app/sidebar-column.css");
  const code = read("src/components/app/code-work-list.tsx");
  const supportsAt = css.indexOf("@supports (animation-timeline: scroll())");
  assert.ok(supportsAt > 0, "the scroll-timeline branch exists");
  const fallback = css.slice(0, supportsAt);
  const supported = css.slice(supportsAt);
  const hug = fallback.match(/\.title-fade\.title-fade-hug,\s*\.title-fade\.title-fade-hug:dir\(rtl\) \{([^}]*)\}/);
  assert.ok(hug, "the hug rule sits in the fallback, before the @supports branch, for both directions");
  assert.match(hug[1], /-webkit-mask-image: none;/);
  assert.match(hug[1], /(?<!-webkit-)mask-image: none;/);
  assert.doesNotMatch(hug[1], /linear-gradient/, "no always-on fade on a hugging label");
  // The supported branch still fades every `.title-fade`, hugging or not,
  // through the animation (which outranks the hug rule's `none` while active).
  assert.match(supported, /\.title-fade,\s*\.title-fade:dir\(rtl\) \{[^}]*animation: title-fade-when-cut linear both;[^}]*animation-timeline: scroll\(self inline\);/);
  assert.doesNotMatch(supported, /title-fade-hug/, "nothing in the supported branch undoes the cut fade for a hugging label");

  // Both text-width labels in the Code list hug; the slot-filling ones do not.
  assert.match(code, /className="title-fade title-fade-hug min-w-0 shrink">\{t\.project\}/, "the row's project name");
  assert.match(code, /className="shell-annot title-fade title-fade-hug min-w-0">\{project \?\? "All projects"\}/, "the All projects filter");
  for (const fill of [/"title-fade min-w-0 flex-1 text-nav"/, /className="title-fade min-w-0 flex-1">\{where\}/]) {
    assert.match(code, fill, "a label that fills its slot keeps the plain fade");
  }
  // Every `title-fade` class list in the file either fills its slot or hugs.
  const classLists = [...code.matchAll(/(?:className="|cn\(")([^"]*)"/g)].map((m) => m[1]).filter((cls) => /\btitle-fade\b/.test(cls));
  assert.equal(classLists.length, 4, "the row title, the project, the branch and the filter");
  for (const cls of classLists) {
    assert.ok(/(^|\s)(flex-1|title-fade-hug)(\s|$)/.test(cls), `a text-width label without title-fade-hug: "${cls}"`);
  }
});

test("the phone drawer's rungs sit on the ground's hue, in DRAWER_CLASS alone", () => {
  const shell = read("src/components/app/app-shell.tsx");
  const sidebar = read("src/components/app/app-sidebar.tsx");
  const drawer = shell.match(/export const DRAWER_CLASS =\s*"([^"]+)"/)?.[1] ?? "";
  for (const rung of ["sidebar-accent", "sidebar-border", "sidebar-hover", "sidebar-selected"]) {
    assert.match(drawer, new RegExp(`dark:\\[--${rung}:225_5%_\\d+%\\]`), `${rung} on hue 225`);
  }
  assert.doesNotMatch(drawer, /:48_/, "no warm-palette hue left");
  assert.doesNotMatch(sidebar, /\[\[data-swipe-panel\]_&\]/, "the sidebar no longer overrides the drawer's rungs");
  assert.match(shell, /<AppSidebar product=\{product\} drawer \/>/, "the drawer mount says it is the drawer");
});

test("the drawer scrolls as one list; the docked panel keeps its destinations put", () => {
  const sidebar = read("src/components/app/app-sidebar.tsx");
  assert.match(sidebar, /const wholeColumn = drawer && !collapsed;/);
  assert.match(sidebar, /\{!wholeColumn && navBlock\}/);
  assert.match(sidebar, /\{wholeColumn && navBlock\}/);
});

test("the Orbit heading carries no glyph", () => {
  const sidebar = read("src/components/app/app-sidebar.tsx");
  assert.doesNotMatch(sidebar, /<JunoOrbit/);
});

test("the search filters keep when and where in view, outside the chip scroller", () => {
  const palette = read("src/components/app/command-palette.tsx");
  assert.match(palette, /className="chip-scroller no-scrollbar[^"]*overflow-x-auto"/);
  assert.match(palette, /aria-label="Filter by date"/);
  assert.doesNotMatch(palette, /SEARCH_WINDOWS\.map\(\(w\) => \(\s*<FilterChip/, "dates are a Select, not chips");
  // Cut to the match on a phone row only; a wide row keeps the server's window.
  assert.match(palette, /narrow\s*\?\s*focusSnippet\(hit\.snippet\)\s*:\s*focusSnippet\(hit\.snippet, SNIPPET_LEAD_WIDE, SNIPPET_TAIL_WIDE\)/);
  assert.match(palette, /const narrow = useMediaQuery\(PHONE_QUERY\)/);
  assert.match(palette, /line-clamp-2 text-ui/);
});

/* ── Round 2 (verifier findings) ────────────────────────────────────────── */

test("a pressed chip is brought into the strip from layout offsets", () => {
  // The verifier's case: "Tasks" pressed, the field emptied, a new query typed.
  // The strip remounts at scrollLeft 0, 397px wide, 660px of chips, Tasks last.
  const tasks = { chipLeft: 604, chipWidth: 56, clientWidth: 397, scrollWidth: 660 };
  assert.equal(chipRevealScroll({ ...tasks, scrollLeft: 0 }), 263, "the last chip scrolls the strip to its end");
  // Measured while the Selects were still empty, the strip was 514px wide and
  // the scroll it got (146) was right for that width only. Re-run at the
  // settled width (the ResizeObserver), the same chip is brought in again.
  assert.equal(chipRevealScroll({ ...tasks, clientWidth: 514, scrollLeft: 0 }), 146);
  assert.equal(chipRevealScroll({ ...tasks, scrollLeft: 146 }), 263);
  assert.equal(chipRevealScroll({ ...tasks, scrollLeft: 263 }), null, "already in view: nothing moves");
  // A chip in the middle clears the 32px edge fade on the side it came from.
  const mid = { chipLeft: 300, chipWidth: 60, clientWidth: 200, scrollWidth: 800 };
  assert.equal(chipRevealScroll({ ...mid, scrollLeft: 0 }), 300 + 60 + CHIP_REVEAL_MARGIN - 200);
  assert.equal(chipRevealScroll({ ...mid, scrollLeft: 500 }), 300 - CHIP_REVEAL_MARGIN);
  // The first chip takes the strip back to its start.
  assert.equal(chipRevealScroll({ chipLeft: 0, chipWidth: 85, clientWidth: 397, scrollWidth: 660, scrollLeft: 263 }), 0);
});

test("the strip re-reveals its pressed chip whenever it changes width", () => {
  const palette = read("src/components/app/command-palette.tsx");
  assert.match(palette, /chipRevealScroll\(\{\s*chipLeft: chip\.offsetLeft/);
  assert.match(palette, /new ResizeObserver\(revealPressedChip\)/);
  // A Select handing focus back briefly widens the strip and the browser
  // clamps its scroll; the frame after either Select closes re-reveals.
  assert.equal((palette.match(/onCloseAutoFocus=\{afterFilterClose\}/g) ?? []).length, 2, "both Selects");
  assert.match(palette, /requestAnimationFrame\(revealPressedChip\)/);
  assert.doesNotMatch(palette, /strip\.scrollLeft [-+]= /, "no client-rect deltas");
  assert.match(palette, /className="chip-scroller no-scrollbar relative /, "the strip is its chips' offset parent");
});

test("shortcut keys are glyphs on a Mac and words everywhere else", () => {
  assert.equal(keyCap("⇧", "⌘"), "⇧");
  assert.equal(keyCap("↵", "⌘"), "↵");
  assert.equal(keyCap("⇧", "Ctrl"), "Shift");
  assert.equal(keyCap("↵", "Ctrl"), "Enter");
  assert.equal(keyCap("⌥", "Ctrl"), "Alt");
  assert.equal(keyCap("Ctrl", "Ctrl"), "Ctrl");
  assert.equal(keyCap("↑", "Ctrl"), "↑", "arrows are arrows everywhere");
  assert.equal(keyCap("Esc", "Ctrl"), "Esc");
  assert.deepEqual(chordKeys("Ctrl↵", "Ctrl"), ["Ctrl", "Enter"]);
  const palette = read("src/components/app/command-palette.tsx");
  assert.match(
    palette,
    /<Kbd>\{s\.keys\.map\(\(k\) => keyCap\(k, mod\)\)\.join\("\+"\)\}<\/Kbd>/,
    "off a Mac, the shortcuts sheet spells each chord as one Ctrl+Shift+O cap"
  );
  assert.match(palette, /const appleKeys = isAppleModifier\(mod\);/);
  assert.doesNotMatch(palette, /sm:columns-2/, "two explicit columns, not a balancer that drops the gap");
});

test("a desktop snippet keeps the server's whole window", () => {
  const text = "…we settled on a partial index on (user_id, updated_at) keeps the sync query under 5 ms for the hot path";
  const start = text.indexOf("sync");
  const snippet = { text, marks: [{ start, end: start + 4 }] };
  assert.equal(SNIPPET_LEAD_WIDE, 64);
  assert.deepEqual(focusSnippet(snippet, SNIPPET_LEAD_WIDE, SNIPPET_TAIL_WIDE), snippet, "nothing cut on a wide row");
  assert.ok(focusSnippet(snippet).text.length < text.length, "a phone row is still cut to the match");
});

test("the command menu's no-match note says it once", () => {
  const palette = read("src/components/app/command-palette.tsx");
  assert.match(palette, /No chats or commands match “\{typed\}”\./);
  assert.doesNotMatch(palette, /<p[^>]*>Enter searches inside your messages and files\.<\/p>/);
});

test("Orbit lists three agents, two on a short window, and counts the rest", () => {
  assert.equal(orbitRowLimit(false), 3);
  assert.equal(orbitRowLimit(true), 2);
  assert.equal(SHORT_WINDOW_QUERY, "(max-height: 57.5rem)");
  const sidebar = read("src/components/app/app-sidebar.tsx");
  assert.match(sidebar, /orbitRows\(working, finished, orbitLimit\)/);
  assert.match(sidebar, /orbitCount > orbitLimit &&/);
  assert.doesNotMatch(sidebar, /ORBIT_LIVE_LIMIT/);
});

test("the Orbit cap never hides a blocked agent behind the count", () => {
  const a = (id: string, state: string) => ({ id, state });
  const atWork = [a("otto", "working"), a("rhea", "thinking"), a("ines", "blocked")];
  const finished = [a("mira", "done")];
  // The short-window cap of two: the blocked agent leads, then the order given.
  assert.deepEqual(orbitRows(atWork, finished, 2).rows.map((r) => r.id), ["ines", "otto"]);
  assert.equal(orbitRows(atWork, finished, 2).count, 4);
  assert.deepEqual(orbitRows(atWork, finished, 3).rows.map((r) => r.id), ["ines", "otto", "rhea"]);
  // Several blocked agents keep their own order; the finished come last.
  const two = [a("w1", "working"), a("b1", "blocked"), a("l1", "listening"), a("b2", "blocked")];
  assert.deepEqual(orbitRows(two, finished, 10).rows.map((r) => r.id), ["b1", "b2", "w1", "l1", "mira"]);
  assert.deepEqual(orbitRows([], finished, 2), { rows: finished, count: 1 });
  assert.deepEqual(orbitRows(atWork, finished, 0).rows, []);
  assert.ok(ORBIT_ATTENTION_STATES.has("blocked"));
  assert.ok(!ORBIT_ATTENTION_STATES.has("working"));
});

test("the column's section breaks are one 16px step", () => {
  const sidebar = read("src/components/app/app-sidebar.tsx");
  const section = read("src/components/app/sidebar-section.tsx");
  assert.match(section, /className="group\/section mt-4 first:mt-0"/);
  assert.match(sidebar, /className="group\/section mt-4 first:mt-0"/, "Orbit's own heading");
  assert.match(sidebar, /className="px-2 pt-4"/);
  assert.doesNotMatch(sidebar + section, /\bmt-5 first:mt-0/);
});

test("the well's top band holds solid for 18px", () => {
  const css = read("src/components/app/sidebar-column.css");
  assert.match(css, /var\(--background\)\)\) 1\.125rem,/);
});

test("the header skeleton can draw a three-line phone lede", () => {
  const header = read("src/components/app/app-page-header.tsx");
  assert.match(header, /phoneLedeLines = 2,/);
  assert.match(header, /\{phoneLedeLines === 3 && <Skeleton className="h-5 w-1\/2 rounded-xs @\[40rem\]\/page:hidden" \/>\}/);
});

test("a button action puts the skeleton's lede under the heading row, as the header does", () => {
  const header = read("src/components/app/app-page-header.tsx");
  assert.match(header, /actions\?: boolean \| "button";/);
  // The button is the real one's box: 44px on touch, 6px down from 40rem.
  assert.match(header, /actions === "button" && "coarse:h-11 @\[40rem\]\/page:mt-1\.5"/);
  // Its lede follows the row; any other action leaves the lede in the heading's column.
  assert.match(header, /\{actions !== "button" && ledeBars\}\s*<\/div>/);
  assert.match(header, /<\/div>\s*\{actions === "button" && ledeBars\}\s*<\/div>/);
});

test("every Needs you ask keeps the kebab's slot on a touch screen, an agent's included", () => {
  const sidebar = read("src/components/app/app-sidebar.tsx");
  const row = sidebar.slice(sidebar.indexOf("function AttentionRow("), sidebar.indexOf("function NavRow("));
  // Unconditional, so an agent's ask (no menu) ends where the chats' asks do.
  assert.match(row, /"flex min-w-0 flex-1 items-center gap-2\.5 pl-2 pr-2\.5 coarse:py-1 coarse:pr-11",\s*ROW_LINK_FOCUS\s*\)/);
  assert.doesNotMatch(row, /conversation && "coarse:pr-11"/);
});

test("the account identicon is drawn in the second ink, lighter than the name", () => {
  const menu = read("src/components/app/user-menu.tsx");
  assert.match(menu, /<DotIdenticon seed=\{user\.id\} className=\{cn\("shrink-0 text-muted-foreground", className\)\} \/>/);
  // DotIdenticon's own `text-primary` comes first in its cn(), so tailwind-merge keeps ours.
  assert.match(read("src/components/signature/dot-matrix.tsx"), /className=\{cn\("text-primary", className\)\}/);
});

test("the Projects route skeleton is drawn to the Projects header", () => {
  const loading = read("src/app/(app)/projects/loading.tsx");
  // Measured: the lede is 48px at 1280 and 72px on a phone; "New project" is a default Button.
  assert.match(loading, /<AppPageHeaderSkeleton headingWidth="w-56" ledeLines=\{2\} phoneLedeLines=\{3\} actions="button" \/>/);
});
