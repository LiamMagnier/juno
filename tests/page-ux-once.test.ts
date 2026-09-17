/**
 * "Every page says each thing once" — the two shared components that grew a
 * switch for it, pinned so the switch keeps working.
 *
 * `SettingsGroup` may now be untitled: a pane's first group sits directly
 * under the pane header, and Memory used to print the word "Memory" at the
 * h2 rung and again at the eyebrow rung ~90px apart, with two paraphrases of
 * one lede between them. An untitled group must render NO header block at
 * all — not an empty `<h3>` and an `mb-2` of dead space — or the rows shift
 * down by the margin of a heading that is not there.
 *
 * `WorkStatusPill` carries its status sentence as a native tooltip because in
 * a list row the pill is the only word about the state. The task header
 * prints that sentence 8px to the pill's right, so there the tooltip was a
 * third copy that covered the text it repeated; `describe={false}` turns it
 * off at that one call site and nowhere else.
 *
 * `renderToStaticMarkup` under `tsx --test`, as tests/work-report-preview.test.ts
 * does: these are questions about the rendered output, not about props. Both
 * components are hook-free, so they are called as the plain functions they
 * are and the element they return is what gets rendered — `createElement`
 * with a required `children` prop is a call TypeScript's overloads and the
 * `react/no-children-prop` rule cannot both accept.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsGroup } from "@/components/settings/setting-row";
import { WorkStatusPill } from "@/components/work/work-vocabulary";

const SETTING_ROW = path.join(process.cwd(), "src/components/settings/setting-row.tsx");
const SETTINGS_LOADING = path.join(process.cwd(), "src/app/(app)/settings/loading.tsx");

test("an untitled SettingsGroup renders its rows with no header block", () => {
  const html = renderToStaticMarkup(SettingsGroup({ children: createElement("div", { "data-row": "" }, "row") }));
  assert.ok(html.includes('data-row=""'), "the rows still render");
  assert.ok(!html.includes("<h3"), "no empty heading element for a group with no title");
  assert.ok(!html.includes("mb-2"), "no header margin reserved for a heading that is not there");
});

test("a titled SettingsGroup still draws the eyebrow, the lede and the aside", () => {
  const html = renderToStaticMarkup(
    SettingsGroup({
      title: "Connected apps",
      description: "The lede.",
      aside: createElement("span", { "data-aside": "" }),
      children: createElement("div", null, "row"),
    })
  );
  assert.ok(/<h3[^>]*>Connected apps<\/h3>/.test(html));
  assert.ok(html.includes("The lede."));
  assert.ok(html.includes('data-aside=""'));
});

test("a group with only an aside keeps the header row so the aside has somewhere to sit", () => {
  const html = renderToStaticMarkup(
    SettingsGroup({ aside: createElement("span", { "data-aside": "" }), children: createElement("div") })
  );
  assert.ok(html.includes('data-aside=""'));
  assert.ok(!html.includes("<h3"));
});

test("the settings loading page takes its pane header from setting-row.tsx", () => {
  // A source check rather than a render: the Skeleton primitive leans on the
  // automatic JSX runtime, which `tsx --test` does not supply. What matters is
  // the sharing itself — the heading bar takes its height from `text-title`
  // in em, the lede bar is one `text-body` line box (h-6) at the header's own
  // `mt-1`, and loading.tsx no longer holds any of those numbers by hand.
  const settingRow = fs.readFileSync(SETTING_ROW, "utf8");
  const loading = fs.readFileSync(SETTINGS_LOADING, "utf8");

  assert.ok(
    /export function SettingsPaneHeaderSkeleton/.test(settingRow),
    "the pane header's skeleton lives beside the pane header"
  );
  assert.ok(/h-\[1\.25em\] w-32 text-title/.test(settingRow), "heading bar tracks the text-title line box");
  assert.ok(/mt-1 h-6 w-72/.test(settingRow), "lede bar is one text-body line at the header's mt-1");
  assert.ok(/SettingsPaneHeaderSkeleton/.test(loading), "loading.tsx imports the shared skeleton");
  assert.ok(
    !/border-b border-border pb-4/.test(loading),
    "loading.tsx no longer draws the pane header block by hand"
  );
});

test("WorkStatusPill carries its sentence as a tooltip by default", () => {
  const html = renderToStaticMarkup(WorkStatusPill({ status: "running" }));
  assert.ok(/ title="[^"]+"/.test(html), "list rows rely on the tooltip; it must stay on by default");
});

test("WorkStatusPill drops the tooltip when the sentence is printed beside it", () => {
  const html = renderToStaticMarkup(WorkStatusPill({ status: "running", describe: false }));
  assert.ok(!/ title=/.test(html), "describe={false} must remove the title attribute, not blank it");
});
