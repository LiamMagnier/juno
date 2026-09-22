/**
 * "Every page says each thing once": the two shared components that grew a
 * switch for it, pinned so the switch keeps working, and the settings row
 * shapes that September 2026's settings rework settled on.
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
import { SettingRow, SettingsGroup } from "@/components/settings/setting-row";
import { resolveSettingsSection, settingsHref } from "@/components/settings/settings-sections";
import { WorkStatusPill } from "@/components/work/work-vocabulary";

const SETTING_ROW = path.join(process.cwd(), "src/components/settings/setting-row.tsx");
const SETTINGS_LOADING = path.join(process.cwd(), "src/app/(app)/settings/loading.tsx");

test("an untitled SettingsGroup renders its rows with no header block", () => {
  const html = renderToStaticMarkup(SettingsGroup({ children: createElement("div", { "data-row": "" }, "row") }));
  assert.ok(html.includes('data-row=""'), "the rows still render");
  assert.ok(!html.includes("<h3"), "no empty heading element for a group with no title");
  assert.ok(!html.includes("mb-2"), "no header margin reserved for a heading that is not there");
});

test("a SettingsGroup whose description resolves to false renders no header block either", () => {
  // `description={cond && "…"}` is how voice.tsx writes an optional
  // description on SettingRow, so a SettingsGroup will get the same shape
  // sooner or later. `hasHeader` used to test `!= null`, which `false`
  // passes, while the render tested truthiness — an empty header `div` with
  // its `mb-2` and nothing inside it, the exact dead space the test above
  // guards against.
  const html = renderToStaticMarkup(
    SettingsGroup({ description: false, children: createElement("div", { "data-row": "" }, "row") })
  );
  assert.ok(html.includes('data-row=""'), "the rows still render");
  assert.ok(!html.includes("mb-2"), "a falsy description reserves no header margin");
});

test("a titled SettingsGroup draws its title, its note and its aside", () => {
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
  // The September 2026 settings rework: a group is named in the interface's
  // own sans, a step above its rows, and its note is quieter than the rows it
  // introduces. It was a 12px mono eyebrow over a 15px note, which read as
  // developer metadata over a louder paragraph.
  const h3 = html.match(/<h3 class="([^"]*)"/)?.[1] ?? "";
  assert.ok(!/font-mono/.test(h3), "the group title is not set in mono");
  assert.ok(/text-body-lg/.test(h3) && /font-semibold/.test(h3), "the group title sits a step above the row labels");
  assert.ok(/<p class="[^"]*text-ui[^"]*">The lede\.<\/p>/.test(html), "the group note is on the text-ui rung");
});

test("a SettingRow names a label with no field as a <div>, and keeps its save status outside the label", () => {
  // A label is often more than words (an "On" badge, a lab's mark). Badge is a
  // <div>, and a <div> inside the <p> the row used to render is invalid HTML
  // that React reports as a hydration error on the Account section.
  const plain = renderToStaticMarkup(
    SettingRow({ label: createElement("span", null, "Two-step verification"), control: createElement("button", null, "Set up") })
  );
  assert.ok(/<div class="[^"]*text-body font-medium/.test(plain), "the label element is a div");
  assert.ok(!/<p class="[^"]*text-body font-medium/.test(plain), "not a p");

  const field = renderToStaticMarkup(
    SettingRow({ label: "Budget alerts", htmlFor: "email-budget", status: "idle", control: createElement("input", { id: "email-budget" }) })
  );
  assert.ok(/<label[^>]*for="email-budget"[^>]*>Budget alerts<\/label>/.test(field), "a field's label points at it");
  assert.ok(/role="status"/.test(field), "the live region is mounted before the first save");
  assert.ok(!/<label[^>]*>[^]*role="status"[^]*<\/label>/.test(field), "the save status is not part of the field's name");
});

test("every settings alias still resolves, and Permissions now opens Devices", () => {
  // Links, the command palette and other surfaces dispatch these; a rename
  // that dropped one would open General instead, silently.
  assert.equal(resolveSettingsSection("profile"), "account");
  assert.equal(resolveSettingsSection("permissions"), "devices");
  assert.equal(resolveSettingsSection("usage"), "billing");
  assert.equal(resolveSettingsSection("plan"), "billing");
  assert.equal(resolveSettingsSection("billing"), "billing");
  assert.equal(resolveSettingsSection("connected-apps"), "connectors");
  assert.equal(resolveSettingsSection("privacy"), "data");
  assert.equal(resolveSettingsSection("nonsense"), "general");
  assert.equal(settingsHref("general"), "/settings");
  assert.equal(settingsHref("devices"), "/settings?section=devices");
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
  // the sharing itself: the heading bar takes its height from `text-title` in
  // em, and loading.tsx holds none of those numbers by hand.
  //
  // The pane header is the section's name and nothing else since the
  // September 2026 rework (its lede was a table of contents for the groups
  // under it), so the skeleton draws no lede bar either.
  const settingRow = fs.readFileSync(SETTING_ROW, "utf8");
  const loading = fs.readFileSync(SETTINGS_LOADING, "utf8");

  assert.ok(
    /export function SettingsPaneHeaderSkeleton/.test(settingRow),
    "the pane header's skeleton lives beside the pane header"
  );
  assert.ok(/h-\[1\.25em\] w-32 text-title/.test(settingRow), "heading bar tracks the text-title line box");
  assert.ok(!/mt-1 h-6 w-72/.test(settingRow), "no lede bar for a header that has no lede");
  assert.ok(/SettingsPaneHeaderSkeleton/.test(loading), "loading.tsx imports the shared skeleton");
  assert.ok(
    !/border-b border-border pb-4/.test(loading),
    "loading.tsx no longer draws the pane header block by hand"
  );
});

test("the settings loading page's header matches the real one: no back row and no lede", () => {
  // `/settings` opens on its name alone. A skeleton that drew the nav row
  // (44px, 56 on touch) or a lede line lifted the whole page when it landed.
  const loading = fs.readFileSync(SETTINGS_LOADING, "utf8");
  const page = fs.readFileSync(path.join(process.cwd(), "src/app/(app)/settings/page.tsx"), "utf8");
  assert.ok(/<AppPageHeader heading="Settings" \/>/.test(page), "the real header is the name alone");
  const skeleton = loading.match(/<AppPageHeaderSkeleton[^>]*\/>/)?.[0] ?? "";
  assert.ok(skeleton, "loading.tsx draws the shared header skeleton");
  assert.ok(/lede=\{false\}/.test(skeleton), "no lede line");
  assert.ok(!/\bnav\b/.test(skeleton), "no back or eyebrow row (nav defaults to off)");
});

test("the settings loading page stands rows on hairlines in for rows on hairlines", () => {
  // The pane has no cards — every section is SettingRows under
  // `divide-y divide-border/60` — but the skeleton used to be four `h-16`
  // cards on `space-y-4`, the outline of a page that was not the one about
  // to replace it. The row placeholder lives beside SettingRow, and takes the
  // row's own line boxes in em so the two cannot drift apart.
  const settingRow = fs.readFileSync(SETTING_ROW, "utf8");
  const loading = fs.readFileSync(SETTINGS_LOADING, "utf8");

  assert.ok(/export function SettingRowSkeleton/.test(settingRow), "the row's skeleton lives beside the row");
  assert.ok(/h-\[1\.6em\] w-40 max-w-full rounded-xs text-body/.test(settingRow), "label bar is one text-body line box");
  assert.ok(
    /mt-0\.5 h-\[1\.5em\] w-64 max-w-full rounded-xs text-ui/.test(settingRow),
    "description bar is one text-ui line box at the row's mt-0.5"
  );
  assert.ok(/SettingRowSkeleton/.test(loading), "loading.tsx uses the shared row skeleton");
  assert.ok(/divide-y divide-border\/60/.test(loading), "the rows are separated by the hairlines the real rows use");
  // The class strings the old card skeletons carried, not the bare tokens:
  // the rail well is a `rounded-card` surface for real, and the docblock
  // names both tokens while explaining why they left.
  assert.ok(!/h-16 w-full rounded-card/.test(loading), "no card placeholders on a pane that draws no cards");
  assert.ok(!/className="space-y-4"/.test(loading), "no card spacing on a pane that draws no cards");
});

test("WorkStatusPill carries its sentence as a tooltip by default", () => {
  const html = renderToStaticMarkup(WorkStatusPill({ status: "running" }));
  assert.ok(/ title="[^"]+"/.test(html), "list rows rely on the tooltip; it must stay on by default");
});

test("WorkStatusPill drops the tooltip when the sentence is printed beside it", () => {
  const html = renderToStaticMarkup(WorkStatusPill({ status: "running", describe: false }));
  assert.ok(!/ title=/.test(html), "describe={false} must remove the title attribute, not blank it");
});

test("Personalization saves a draft still being typed when the section goes away", () => {
  // Escape, ⌘, or a navigation unmounts the section with the field focused,
  // and React never hears that field's blur, so custom instructions typed and
  // then dismissed were dropped without a word. The savers run once more from
  // an unmount cleanup; they return early when nothing changed.
  const source = fs.readFileSync(
    path.join(process.cwd(), "src/components/settings/sections/personalization.tsx"),
    "utf8"
  );
  assert.ok(/flushDrafts\.current = \(\) => \{\s*saveName\(\);\s*saveInstructions\(\);/.test(source));
  assert.ok(/return \(\) => flush\.current\(\);/.test(source), "the flush runs from an unmount cleanup");
});
