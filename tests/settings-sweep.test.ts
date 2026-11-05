/**
 * Settings sweep: what the last screens verification still found.
 *
 *   - Shared-link titles are cut at a word, never clamped mid-word by CSS, and
 *     a narrow pane folds Copy and Revoke into one menu so the title has room.
 *   - The two sound rows keep the play glyph and the switch on the right at
 *     360px (`SettingRow inline`).
 *   - Code's defaults wait in placeholder rows, not under a floating line
 *     while the built-in defaults show and then flip; This browser's pairs too.
 *   - A Mac's facts line wraps whole instead of ending "last see…".
 *   - Subscriptions, once a Mac answers, is a SettingsGroup like its siblings.
 *   - The shortcuts sheet's title shares the close button's midline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { cutAtWord, urlBreakPieces } from "@/components/settings/format";
import { SHARE_TITLE_MAX } from "@/components/share/shared-links-card";
import { ALL_SETTINGS_SECTIONS, SETTINGS_GROUPS, settingsSectionMatches } from "@/components/settings/settings-sections";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

test("a title is cut after a whole word, the ellipsis tight against it", () => {
  const title = "Draft a reply to the landlord about the boiler and the deposit";
  assert.equal(cutAtWord(title, 100), title, "a title that fits is left alone");
  assert.equal(cutAtWord(title, 40), "Draft a reply to the landlord about the…");
  // Never mid-word ("…about th…"), never a space before the dots ("…about …").
  for (let max = 12; max < title.length; max++) {
    const cut = cutAtWord(title, max);
    assert.ok(cut.endsWith("…"), cut);
    const kept = cut.slice(0, -1);
    assert.ok(Array.from(kept).length <= max, `${max}: ${cut}`);
    assert.doesNotMatch(kept, /\s$/, `${max}: space before the ellipsis`);
    assert.ok(title.startsWith(kept), `${max}: ${cut}`);
    assert.ok(title[kept.length] === " " || /[,;:.]/.test(title[kept.length] ?? ""), `${max}: cut mid-word: ${cut}`);
  }
  // A word that ends exactly on the limit is kept whole.
  assert.equal(cutAtWord("one two three", 7), "one two…");
  // Punctuation before the cut goes with the space.
  assert.equal(cutAtWord("Plans, budgets, and the rest of it", 15), "Plans, budgets…");
  // Whitespace is flattened first.
  assert.equal(cutAtWord("  a\n\tb  ", 10), "a b");
});

test("a run with no space to cut at is cut before its last separator, else at the limit by code point", () => {
  // A pasted URL ends on a whole segment, not "…/files#dif…" or "…/sh…".
  const url = "https://github.com/acme/really-long-repository-name/pull/12345/files#diff-abcdef";
  assert.equal(cutAtWord(url, SHARE_TITLE_MAX.narrow), "https://github.com/acme/really-long-repository-name/pull/12345/files…");
  assert.equal(cutAtWord(url, SHARE_TITLE_MAX.wide), url, "the wide pane keeps it whole");
  assert.equal(cutAtWord("https://alevr.com/share/abcdefghijklmnop", 20), "https://alevr.com…");
  // A separator just past the limit still ends a whole segment there.
  assert.equal(cutAtWord("https://alevr.com/share/abc", 23), "https://alevr.com/share…");
  // From past the host on (before that the only separators sit in the first
  // half, and the run is cut by code point, as a hash is).
  for (let max = 20; max < url.length; max++) {
    const kept = cutAtWord(url, max).slice(0, -1);
    assert.ok(Array.from(kept).length <= max, `${max}: ${kept}`);
    assert.ok(url.startsWith(kept), `${max}: ${kept}`);
    // Before a separator (or the scheme's "://" at a tiny limit), never inside a segment.
    assert.match(url.slice(kept.length), /^:?[/#?&=_.-]/, `${max}: cut mid-segment: ${kept}…`);
  }
  // A space late enough still wins: an ordinary title is cut at a word.
  assert.equal(cutAtWord("Notes on the state-of-the-art retrieval pipeline", 30), "Notes on the state-of-the-art…");
  // A run with neither (a hash) is cut at the limit, by code point.
  assert.equal(cutAtWord("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghij…");
  // An emoji is never split into half a surrogate pair.
  assert.equal(cutAtWord("😀😀😀😀😀😀", 3), "😀😀😀…");
});

test("a URL title wraps at its separators, and the link is named by the whole title", () => {
  assert.deepEqual(urlBreakPieces("https://github.com/acme/repo?a=1&b=2#x"), ["https://", "github.com/", "acme/", "repo?", "a=1&", "b=2#", "x"]);
  assert.deepEqual(urlBreakPieces("Plan the offsite"), ["Plan the offsite"], "a title with no separator is one piece");
  assert.equal(urlBreakPieces("https://a.b/c").join(""), "https://a.b/c", "the text is unchanged");
  // Ordinary words keep their separators whole: only URLs and paths break.
  for (const title of ["Q&A prep for the AT&T renewal call", "24/7 support and/or on-call", "Read me: TCP/IP basics"]) {
    assert.deepEqual(urlBreakPieces(title), [title], title);
  }
  const mixed = "Notes on https://docs.example.com/d/abc for Q&A";
  assert.equal(urlBreakPieces(mixed).join(""), mixed, "a title around a URL is unchanged when joined");
  assert.ok(urlBreakPieces(mixed).length > 1, "the URL inside a title still gets break points");
  assert.ok(urlBreakPieces(mixed).at(-1)!.endsWith("for Q&A"), "the words after the URL stay whole");
  const card = read("src/components/share/shared-links-card.tsx");
  assert.match(card, /\{i > 0 \? <wbr \/> : null\}/);
  assert.match(card, /<BreakableTitle text=\{narrowTitle\} \/>/);
  assert.match(card, /<BreakableTitle text=\{wideTitle\} \/>/);
  // The narrow pane's cut ("…about planning the…") is not the link's name.
  assert.match(card, /aria-label=\{narrowTitle === fullTitle \? undefined : fullTitle\}/);
});

test("shared links: no CSS clamp, and Copy and Revoke share one menu on a narrow pane", () => {
  const card = read("src/components/share/shared-links-card.tsx");
  assert.doesNotMatch(card, /line-clamp/, "the title is cut at a word, not clamped");
  assert.match(card, /cutAtWord\(fullTitle, SHARE_TITLE_MAX\.narrow\)/);
  assert.match(card, /hidden shrink-0 items-center gap-3 @\[34rem\]\/pane:flex/, "Copy and Revoke from 34rem");
  assert.match(card, /@\[34rem\]\/pane:hidden"[\s\S]*?<ActionIcons\.more/, "the menu under 34rem");
  assert.match(card, /<DropdownMenuItem variant="destructive" onSelect=\{\(\) => void revoke\(\)\}>/);
});

test("the sound rows keep their controls beside the text on a phone", () => {
  const row = read("src/components/settings/setting-row.tsx");
  assert.match(row, /: inline\s*\? "flex-nowrap"/);
  assert.match(row, /!wide && !inline && "basis-\[13rem\] grow"/);
  for (const [file, label] of [
    ["src/components/settings/sections/preferences.tsx", "Play a sound"],
    ["src/components/settings/sections/voice.tsx", "Voice sounds"],
  ] as const) {
    const src = read(file);
    const at = src.indexOf(`label="${label}"`);
    assert.ok(at > 0, label);
    assert.match(src.slice(at, src.indexOf("control=", at)), /\binline\b/, `${label} is an inline row`);
  }
});

test("Code's defaults and This browser's pairs load in placeholder rows", () => {
  const code = read("src/components/settings/sections/code.tsx");
  assert.doesNotMatch(code, />\s*Loading your Code defaults…/, "no floating loading line");
  // Access, Team, Budget and Work log each wait for the account's answer.
  assert.equal(code.match(/<PendingRows count=/g)?.length, 4);
  assert.match(code, /\{loaded \? \(\s*<RadioRows<RuntimeMode>/);
  assert.match(code, /\{loaded \? \(\s*<RadioRows<RolePreset>/);
  assert.match(code, /\{known \? \(\s*<RadioRows/);
  const remote = read("src/components/settings/sections/remote.tsx");
  assert.doesNotMatch(remote, />Loading paired Macs…</, "no loading line");
  assert.match(remote, /aria-label="Loading the Macs paired with this browser" className="divide-y divide-border\/60">\s*<SettingRowSkeleton \/>/);
});

test("every placeholder group stands its rows on the group's hairlines", () => {
  // PendingRows (Code) drew hairlines between placeholder rows; API keys,
  // Shared links and This browser did not, in the same pane.
  const files = [
    "src/components/settings/sections/code.tsx",
    "src/components/settings/sections/connections.tsx",
    "src/components/settings/sections/remote.tsx",
    "src/components/share/shared-links-card.tsx",
  ];
  let wrappers = 0;
  for (const file of files) {
    const src = read(file);
    for (const m of src.matchAll(/<div role="status" aria-label="Loading[^"]*"([^>]*)>\s*(?:\{rows\}|<SettingRowSkeleton)/g)) {
      wrappers++;
      assert.match(m[1]!, /className="divide-y divide-border\/60"/, `${file}: ${m[0]}`);
    }
  }
  assert.equal(wrappers, 4, "Code, API keys, This browser, Shared links");
});

test("settings search finds a section by the words people type for it", () => {
  const find = (query: string) => ALL_SETTINGS_SECTIONS.filter((s) => settingsSectionMatches(s, query)).map((s) => s.id).sort();
  assert.deepEqual(find("unpair"), ["devices"]);
  assert.deepEqual(find("pair"), ["devices"]);
  assert.deepEqual(find("capabilities"), ["general", "memory"]);
  for (const q of ["invite", "referral", "friend", "reward"]) assert.deepEqual(find(q), ["billing"], q);
  for (const q of ["sound", "sounds", "chime"]) assert.deepEqual(find(q), ["notifications", "voice"], q);
  // "voice" no longer finds Plan & usage through "invoice".
  assert.deepEqual(find("voice"), ["voice"]);
});

test("the settings loading page draws the rail's groups, names and all", () => {
  const loading = read("src/app/(app)/settings/loading.tsx");
  assert.match(loading, /SETTINGS_GROUPS\.map\(\(group\) =>/);
  assert.match(loading, /\{group\.label\}/);
  assert.match(loading, /group\.ids\.map\(\(id\) =>/);
  assert.doesNotMatch(loading, /SETTINGS_SECTIONS\.map/, "not the ten ungrouped rows");
  // The label is the rail's own (settings-rail.tsx groupLabelClass).
  const rail = read("src/components/settings/settings-rail.tsx");
  const label = rail.match(/const groupLabelClass = "([^"]+)"/)?.[1];
  assert.ok(label && loading.includes(`className="${label}"`), label);
  assert.equal(SETTINGS_GROUPS.flatMap((g) => g.ids).length, ALL_SETTINGS_SECTIONS.length);
  // The page's column has no gap of its own (2px a part set each row 5.6px
  // low), the title is ed-h3's 26.4px line, and stacked the rail is the 44px
  // section menu, not a 36px search with a margin under it.
  assert.match(loading, /<div className="flex shrink-0 flex-col border-b border-border\/60 bg-sidebar/);
  assert.match(loading, /h-\[26\.4px\] w-24 rounded-xs/);
  assert.match(loading, /<Skeleton className="h-11 w-full rounded-control md:mb-4 md:h-9" \/>/);
});

test("a Mac's facts wrap whole; its name and workload are never ellipsized", () => {
  const row = read("src/components/work/work-host-row.tsx");
  assert.doesNotMatch(row, /className="[^"]*\btruncate\b/);
  assert.match(row, /-ml-\[3ch\] flex flex-wrap/);
  assert.match(row, /className="whitespace-nowrap"/);
});

test("Subscriptions with a Mac is a SettingsGroup, its caption and note hidden in the panel", () => {
  const src = read("src/components/code/v2/connections-settings.tsx");
  assert.match(src, /<SettingsGroup\s+title="Subscriptions"\s+description=\{`On the web, subscriptions run through \$\{device\.name\}\$\{seen\}\.`\}\s+bare/);
  assert.match(src, /\[&_\.inner>\.cv2-note:first-child\]:hidden/);
  assert.match(src, /\[&_\.cv2-md-list>\.cv2-msect:first-child\]:hidden/);
  const group = read("src/components/settings/setting-row.tsx");
  assert.match(group, /\{bare \? children : <div className=\{SETTINGS_CARD_CLASS\}>\{children\}<\/div>\}/);
});

test("the shortcuts sheet's title row is the close button's box at its inset", () => {
  const src = read("src/components/settings/sections/preferences.tsx");
  // DialogCloseButton: `absolute right-4 top-4`, Pressable icon lg (size-9, coarse:size-11).
  assert.match(src, /px-5 pb-4 pt-4 sm:px-6">\s*\{\/\*[\s\S]*?\*\/\}\s*<div className="flex min-h-9 items-center pr-12 coarse:min-h-11">\s*<DialogTitle>Keyboard shortcuts<\/DialogTitle>/);
  const dialog = read("src/components/ui/dialog.tsx");
  assert.match(dialog, /absolute right-4 top-4/);
  assert.match(read("src/components/ui/pressable.tsx"), /kind: "icon", size: "lg", class: "size-9 coarse:size-11"/);
});
