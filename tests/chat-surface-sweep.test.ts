import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TrayMenu } from "@/components/chat/composer-tray";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";

/*
 * The chat surfaces' last screens sweep: the home tray and composer chips,
 * the transcript's trace and receipts, and the model picker.
 */

// The icon set is written for the automatic JSX runtime; tsx compiles classic.
(globalThis as { React?: typeof React }).React = React;

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const h = React.createElement;

test("an open tray menu with a tooltip still says data-state=open, so composer.css draws it open", () => {
  const html = renderToStaticMarkup(
    h(
      TooltipProvider,
      null,
      h(
        Tooltip,
        null,
        h(TrayMenu, {
          panel: "project",
          open: "project",
          onChange: () => {},
          render: () => null,
          label: "Select project",
          tooltip: true,
          children: "Project",
        }),
      ),
    ),
  );
  const button = html.match(/<button[^>]*>/)?.[0] ?? "";
  assert.match(button, /aria-expanded="true"/);
  // composer.css: `.composer-tray__item[data-state="open"]` (fill) and
  // `[data-state="open"] .composer-tray__chevron` (turned chevron).
  assert.match(button, /data-state="open"/, button);
  assert.match(button, /class="composer-tray__item"/);
  assert.match(read("src/components/chat/composer.css"), /\.composer-tray__item\[data-state="open"\] \.composer-tray__chevron/);
});

test("the task-mode chip nests its tooltip inside the menu trigger, as the + button and the tray do", () => {
  const chip = read("src/components/chat/task-mode-chip.tsx");
  assert.match(chip, /<DropdownMenuTrigger asChild disabled=\{disabled\}>\s*<TooltipTrigger asChild>/);
  assert.doesNotMatch(chip, /<TooltipTrigger asChild>\s*<DropdownMenuTrigger/);
});

test("on a 320 phone the tray's Project control steps down to its icon instead of cutting its word", () => {
  const css = read("src/components/chat/composer.css");
  const tray = read("src/components/chat/composer-tray.tsx");
  assert.match(tray, /className="composer-tray__project-word truncate"/);
  assert.match(css, /@media \(max-width: 339px\) \{\s*\.composer-tray__project-word \{\s*display: none;/);
  // The name survives for assistive tech.
  assert.match(tray, /label=\{projectName \? `Project: \$\{projectName\}` : "Select project"\}/);
});

test("wider than 320, the tray's Project word is drawn whole or not at all (measured, not a breakpoint)", () => {
  const css = read("src/components/chat/composer.css");
  const tray = read("src/components/chat/composer-tray.tsx");
  // At 340 to 356px the word was still cut to "Proj…" (the 344px Fold cover
  // screen among them), and the apps' marks or a translation move that line.
  assert.match(css, /\.composer-tray__row\[data-tight\] \.composer-tray__project-word \{\s*display: none;/);
  assert.match(css, /\.composer-tray__row\[data-tight\] \.composer-tray__item--project-row \{\s*padding-inline: 10px 8px;\s*gap: 4px;/);
  // Only the placeholder word, on the home row: a chosen name keeps its ellipsis.
  assert.match(tray, /useWholeProjectWord\(rowRef, !params && !projectName\)/);
  assert.match(tray, /<div ref=\{rowRef\} className="composer-tray__row">/);
  // Measured with the word in every time, so the two states never chase each other.
  assert.match(tray, /const update = \(\) => \{\s*row\.removeAttribute\("data-tight"\);/);
  // In fractional pixels: at 355 and 356px the word was 0.3px too wide, drawn
  // "Proje…", while scrollWidth and clientWidth both read 43.
  assert.match(tray, /text\.selectNodeContents\(word\);\s*if \(text\.getBoundingClientRect\(\)\.width > word\.getBoundingClientRect\(\)\.width\) row\.setAttribute\("data-tight", ""\);/);
  assert.doesNotMatch(tray, /word\.scrollWidth > word\.clientWidth/);
  // The row for the window, its controls for a neighbour that grows, the text for AutoTranslate.
  assert.match(tray, /resize\.observe\(row\);\s*for \(const el of row\.children\) resize\.observe\(el\);/);
  assert.match(tray, /mutate\.observe\(row, \{ childList: true, subtree: true, characterData: true \}\)/);
});

/* ——— The home ——————————————————————————————————————————————————————— */

test("a template starter lands with an open slot, so the caret is not glued to its last word", async () => {
  const { promptsFor, promptText, STARTER_SLOT, HOME_STARTER_COPY } = await import("@/lib/home-starters");
  const use = { lastCodeProject: null };
  const write = promptsFor("write", use);
  const cover = write.find((p) => p.phrase.startsWith("Draft a cover letter"))!;
  assert.equal(cover.awaitsInput, true);
  assert.equal(promptText(cover), "Draft a cover letter for a role I’ll describe: ");
  assert.equal(STARTER_SLOT, ": ");
  // A finished request is sent as written.
  const thanks = write.find((p) => p.phrase.startsWith("Help me write"))!;
  assert.equal(promptText(thanks), thanks.phrase);
  // A translation that already ends on punctuation does not double it.
  assert.equal(promptText(cover, "Rédige une lettre de motivation pour un poste que je décrirai :"), "Rédige une lettre de motivation pour un poste que je décrirai: ");
  // The Code project's own prompt keeps its argument, no slot.
  const code = promptsFor("code", { lastCodeProject: "atlas-web" });
  assert.equal(promptText(code[0]), `${HOME_STARTER_COPY.continueIn} atlas-web`);
  // Every template the set names is still a phrase the chips offer (none went stale).
  const all = (Object.keys(HOME_STARTER_COPY.chips) as (keyof typeof HOME_STARTER_COPY.chips)[]).flatMap((id) => promptsFor(id, use));
  assert.equal(all.filter((p) => p.awaitsInput).length, 8);
});

test("the phone chip row knows which of its edges has more past it", async () => {
  const { rowOverflow } = await import("@/components/chat/row-overflow");
  assert.deepEqual(rowOverflow({ scrollLeft: 0, clientWidth: 358, scrollWidth: 480 }), { past: false, more: true });
  assert.deepEqual(rowOverflow({ scrollLeft: 60, clientWidth: 358, scrollWidth: 480 }), { past: true, more: true });
  assert.deepEqual(rowOverflow({ scrollLeft: 122, clientWidth: 358, scrollWidth: 480 }), { past: true, more: false });
  // Right to left scrolls negative.
  assert.deepEqual(rowOverflow({ scrollLeft: -122, clientWidth: 358, scrollWidth: 480 }), { past: true, more: false });
  assert.deepEqual(rowOverflow({ scrollLeft: 0, clientWidth: 700, scrollWidth: 700 }), { past: false, more: false });
  const css = read("src/components/chat/home-starters.css");
  assert.match(css, /\.home-starters__chips\[data-more-end\] \{\s*--chips-fade-end: 56px;/);
});

test("Escape closes a chip's prompts from the chips too, not only from the list", () => {
  const starters = read("src/components/chat/home-starters.tsx");
  const chips = starters.slice(starters.indexOf('className="home-starters__chips no-scrollbar"') - 200, starters.indexOf("{chips.map("));
  assert.match(chips, /event\.key === "Escape" && open\)\s*\{\s*event\.stopPropagation\(\);\s*closeList\(open\);/);
});

test("the home field is gone at the composer's top edge and clears the starter chips' row", () => {
  const field = read("src/components/chat/empty-state.tsx");
  assert.match(field, /`transparent \$\{FIELD_TOP\}`/, "fully transparent AT the composer's top edge");
  assert.match(field, /`#000 calc\(\$\{FIELD_TOP\} \+ 32px\)`/);
  assert.match(field, /`transparent calc\(\$\{FIELD_BOTTOM\} \+ var\(--home-field-clear-bottom, 64px\) \+ 4px\)`/);
  assert.match(field, /setProperty\("--home-field-clear-bottom"/, "the clearing follows the measured row");
});

test("a short laptop window keeps the empty home inside the panel", () => {
  const css = read("src/components/chat/composer.css");
  const block = css.slice(css.indexOf("@media (max-height: 700px) and (min-width: 761px)"));
  assert.match(block, /\.chat-home__greet \{\s*padding-top: 12px;/);
  assert.match(block, /\.chat-home__field \{\s*height: min\(640px, calc\(100dvh - 24px\)\);/, "the masked field no longer counts as overflow");
  assert.match(read("src/components/chat/home-starters.css"), /@media \(max-height: 700px\) and \(min-width: 761px\) \{\s*\.home-starters__prompts \{\s*top: calc\(100% \+ 8px\);/);
});

test("the composer-landing gallery draws the shipped home: real starters, incognito without a drawing", () => {
  const fixture = read("src/app/dev/composer-landing/fixture.tsx");
  assert.match(fixture, /<HomeStarters composerRef=\{composerRef\} onShownChange=\{setStartersShown\} \/>/);
  assert.match(fixture, /get\("field"\) === "1"/);
});

/* ——— The transcript ——————————————————————————————————————————————————— */

test("a cut-short answer reads as ONE amber row inline, carrying the reason", async () => {
  const { buildRun } = await import("@/components/chat/thought-process-model");
  const { inlineRows, ThoughtInline } = await import("@/components/chat/thought-inline");
  const T0 = Date.parse("2026-10-25T10:00:00.000Z");
  const at = (s: number) => new Date(T0 + s * 1000).toISOString();
  for (const title of ["Response hit the token limit", "Stopped by user", "Stream interrupted"]) {
    const run = buildRun(
      [
        { id: "w", kind: "write", title: "Writing", createdAt: at(2) },
        { id: "x", kind: "warning", title, detail: "detail", createdAt: at(9) },
      ] as never,
      null,
    );
    const rows = inlineRows(run);
    const steps = rows.filter((r) => r.kind === "step");
    assert.equal(steps.length, 1, title);
    const only = steps[0] as Extract<(typeof rows)[number], { kind: "step" }>;
    assert.equal(only.stepKind, "write");
    assert.equal(only.label, "Stopped while writing");
    assert.equal(only.detail, `${title} · detail`);
    const html = renderToStaticMarkup(h(ThoughtInline, { id: "t", run, onOpenFull: () => {}, fullOpen: false }));
    assert.doesNotMatch(html, /text-destructive/, "the panel's warning ink, not red");
    assert.match(html, /text-warning/);
  }
  // A notice that is not the finish stays its own row.
  const other = buildRun(
    [
      { id: "w", kind: "write", title: "Writing", createdAt: at(2) },
      { id: "y", kind: "warning", title: "Linear did not respond", detail: "timeout", createdAt: at(4) },
    ] as never,
    null,
  );
  assert.ok(inlineRows(other).some((r) => r.kind === "step" && r.stepKind === "notice"));
});

test("trace labels, details and source titles wrap at words instead of a CSS ellipsis", () => {
  const panel = read("src/components/chat/thought-process-panel.tsx");
  const row = panel.slice(panel.indexOf("function StepRow("), panel.indexOf("const figure = ("));
  assert.doesNotMatch(row, /\btruncate\b/);
  assert.match(row, /line-clamp-2 min-w-0 break-words text-pretty/);
  assert.match(row, /step\.kind !== "remember" && "line-clamp-3"/);
  const inline = read("src/components/chat/thought-inline.tsx");
  assert.doesNotMatch(inline.slice(inline.indexOf("function InlineRow"), inline.indexOf("function MemoryRow")), /\btruncate\b/);
});

test("the resting strip steps clauses out whole: verb first, then whole clauses, sources last", async () => {
  const { restingLadder } = await import("@/components/chat/activity-timeline");
  const ladder = restingLadder(["Searched the web", "Read 2 sources", "Used GitHub"], 1, 2);
  assert.deepEqual(
    ladder.map((rung) => rung.parts),
    [
      ["Searched the web", "Read 2 sources", "Used GitHub"],
      ["Searched the web", "2 sources", "Used GitHub"],
      ["Searched the web", "2 sources"],
      ["2 sources"],
    ],
  );
  assert.deepEqual(ladder.map((rung) => rung.sources), [1, 1, 1, 0]);
  for (const rung of ladder) for (const part of rung.parts) assert.doesNotMatch(part, /…/);
  // No sources: clauses step out from the end; one clause is the floor.
  assert.deepEqual(restingLadder(["Ran Python", "Used GitHub"], -1, 0).map((r) => r.parts), [["Ran Python", "Used GitHub"], ["Ran Python"]]);
  assert.deepEqual(restingLadder(["Searched the web"], -1, 0).map((r) => r.parts), [["Searched the web"]]);
});

test("a decided approval's receipt keeps each phrase whole and takes focus from the button that went", () => {
  const card = read("src/components/chat/approval-card.tsx");
  assert.match(card, /<span className=\{cn\("whitespace-nowrap", receiptWarn \? "text-warning" : "text-muted-foreground"\)\}>\{receiptOutcome\}<\/span>/);
  assert.match(card, /\{"\\u00a0· "\}/, "the separator stays at the end of the line it follows");
  assert.match(card, /answeredHere\.current = true;/);
  assert.match(card, /if \(!active \|\| active === document\.body\) receiptRef\.current\?\.focus\(\{ preventScroll: true \}\);/);
});

test("a table cell's leading sign sits outside the tabular figures, text unchanged", async () => {
  const { tightLeadingSign } = await import("@/components/chat/markdown");
  const html = renderToStaticMarkup(h("td", null, tightLeadingSign("-25%")));
  assert.equal(html, '<td><span class="[font-variant-numeric:normal]">-</span>25%</td>');
  assert.equal(renderToStaticMarkup(h("td", null, tightLeadingSign("−$3.10"))), '<td><span class="[font-variant-numeric:normal]">−</span>$3.10</td>');
  // Prose and a dash before a word are left alone.
  assert.equal(tightLeadingSign("One-off"), "One-off");
  assert.equal(tightLeadingSign("- note"), "- note");
  const md = read("src/components/chat/markdown.tsx");
  assert.match(md, /max-sm:\[&_td:first-child\]:min-w-\[min\(20ch,48vw\)\]/);
});

test("the trace filter's chosen radio is a solid dot, not the icon family's hollow ring", () => {
  const menu = read("src/components/ui/dropdown-menu.tsx");
  const radio = menu.slice(menu.indexOf("const DropdownMenuRadioItem"), menu.indexOf("DropdownMenuRadioItem.displayName"));
  assert.match(radio, /<span aria-hidden="true" className="size-1\.5 rounded-full bg-current" \/>/);
  assert.doesNotMatch(radio, /<Circle/);
});

/* ——— The model picker ——————————————————————————————————————————————— */

test("a deprecated model's note is written from its date and replacement, like its row", async () => {
  const { retirementNote } = await import("@/components/chat/model-catalogue");
  const names: Record<string, string> = { "openai:gpt-6.1-sol": "GPT-6.1 Sol", "google:nano-banana-2.1": "Nano Banana 2.1" };
  const nameOf = (id: string) => names[id] ?? null;
  assert.equal(
    retirementNote({ status: "deprecated", retiresOn: "2026-12-11", replacedBy: "openai:gpt-6.1-sol" as never, deprecationNote: "Retires Dec 11, 2026. Use GPT-6.1 Sol" }, nameOf),
    "Retires 11 Dec 2026. Use GPT-6.1 Sol",
  );
  // No replacement on file: the note's own "Use …" survives.
  assert.equal(retirementNote({ status: "deprecated", retiresOn: "2026-11-18", deprecationNote: "Retires Nov 18, 2026. Use MiniMax M3" }, nameOf), "Retires 18 Nov 2026. Use MiniMax M3");
  // No date: the note as written.
  assert.equal(
    retirementNote({ status: "deprecated", deprecationNote: "Deprecated by Google. Use Nano Banana 2.1" }, nameOf),
    "Deprecated by Google. Use Nano Banana 2.1",
  );
  assert.equal(retirementNote({ status: "current" }, nameOf), null);
  const catalogue = read("src/components/chat/model-catalogue.tsx");
  assert.doesNotMatch(catalogue, /retiring\.toLowerCase\(\)/, "the row's name says the date as the row does");
  assert.match(catalogue, /caption=\{priced \? "per 1M tokens, in · out" : undefined\}/);
});

test("the listbox holds only options and groups: Past models is an option row, not a <summary>", () => {
  const catalogue = read("src/components/chat/model-catalogue.tsx");
  assert.doesNotMatch(catalogue, /<(summary|details)[\s\n]/);
  const toggle = catalogue.slice(catalogue.indexOf("const renderLegacyToggle"), catalogue.indexOf("const renderRows"));
  assert.match(toggle, /role="option"/);
  assert.match(toggle, /aria-selected=\{false\}/);
  assert.match(toggle, /id=\{rowDomId\(key\)\}/, "aria-activedescendant can point at it");
  assert.match(catalogue, /if \(toggle\) return toggleLegacy\(toggle\);/, "Enter on it from the search field toggles");
  assert.match(catalogue, /className="coarse:size-11"/, "the sheet's star is as tall as its neighbours");
});

test("the catalogue's popovers hand focus back sensibly", async () => {
  const { catalogueCloseFocus } = await import("@/components/chat/catalogue-focus");
  const body = { tag: "body" };
  const chip = { isConnected: true, focused: 0, focus() { this.focused++; } };
  const g = globalThis as { document?: unknown };
  const saved = g.document;
  const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });
  try {
    // Focus already moved on (the catalogue that replaced the card): left there.
    g.document = { activeElement: { tag: "input" }, body };
    let e = event();
    catalogueCloseFocus(e as unknown as Event, { returnFocusTo: { current: chip as never }, interactedOutside: false });
    assert.equal(e.defaultPrevented, true);
    assert.equal(chip.focused, 0);
    // Dropped to the page with no trigger to return to: the chip.
    g.document = { activeElement: body, body };
    e = event();
    catalogueCloseFocus(e as unknown as Event, { returnFocusTo: { current: chip as never }, interactedOutside: false });
    assert.equal(e.defaultPrevented, true);
    assert.equal(chip.focused, 1);
    // Closed by acting elsewhere: not pulled back.
    e = event();
    catalogueCloseFocus(e as unknown as Event, { returnFocusTo: { current: chip as never }, interactedOutside: true });
    assert.equal(e.defaultPrevented, false);
    // A real trigger: Radix's own return.
    e = event();
    catalogueCloseFocus(e as unknown as Event, { interactedOutside: false });
    assert.equal(e.defaultPrevented, false);
  } finally {
    g.document = saved;
  }
  const selector = read("src/components/chat/model-selector.tsx");
  assert.match(selector, /aria-busy=\{busy \|\| undefined\}/);
  assert.doesNotMatch(selector, /disabled=\{busy\}/, "a busy retry keeps the focus it holds");
  assert.match(selector, /returnFocusTo=\{thinking \? chipRef : undefined\}/);
});

test("the Pro switch is named for the setting and its tooltip names the press and its cost", async () => {
  const { proModeAction } = await import("@/components/chat/reasoning-slider");
  assert.equal(proModeAction(false), "Turn on Pro · deeper reasoning, slower, uses more tokens");
  assert.equal(proModeAction(true), "Turn off Pro");
  const slider = read("src/components/chat/reasoning-slider.tsx");
  assert.match(slider, /aria-pressed=\{proMode\}\s*aria-label="Pro mode"/);
  assert.doesNotMatch(slider, /Pro on: deeper reasoning/);
});

test("in the composer the chip's room is the row's, and its name keeps proportional figures", () => {
  const selector = read("src/components/chat/model-selector.tsx");
  assert.match(selector, /inComposer \? "max-w-\[16rem\]" : "max-w-\[11\.5rem\] sm:max-w-\[16rem\]"/);
  assert.match(selector, /className="flex min-w-0 items-baseline normal-nums max-\[359px\]:hidden"/);
});
