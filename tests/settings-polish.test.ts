/**
 * Settings polish pass: the logic behind the reworked rows.
 *
 *   - The rail is twelve rows. Appearance and Keyboard are General's groups,
 *     Capabilities is gone (its rows are General's and Memory's), Remote is
 *     Devices' "This browser", and Connections, Agents and Permissions are
 *     one Code section. Every old id still opens where its rows went.
 *   - The shortcuts dialog lists Code's shortcuts (settings/code-shortcuts.ts)
 *     under a Chat/Code switch, in two balanced columns.
 *   - Search keywords only name settings that exist where they point.
 *   - The referral link shows without its scheme, its code kept apart so the
 *     host gives way first; shared links drop this year's year; an avatar's
 *     initials are first and last, not the first two letters.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_KEYBINDINGS } from "@/lib/code-v2/keymap";
import { bindingKeys, codeShortcutGroups, splitShortcutColumns } from "@/components/settings/code-shortcuts";
import {
  ALL_SETTINGS_SECTIONS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  resolveSettingsSection,
  settingsSectionMatches,
} from "@/components/settings/settings-sections";
import { formatAgo, formatRecentDate, initialsFor, splitDisplayLink } from "@/components/settings/format";

test("Code's shortcuts are grouped like Chat's and list every default binding once", () => {
  const groups = codeShortcutGroups("⌘");
  assert.equal(groups[0]?.title, "Everywhere", "both lists open on Everywhere, where the switch sits");
  const listed = groups.flatMap((g) => g.items).length;
  const expected = DEFAULT_KEYBINDINGS.filter((b) => !b.command.startsWith("hunk.accept")).length;
  assert.equal(listed, expected);
  for (const group of groups) assert.ok(group.items.length > 0, `${group.title} is not empty`);
  // The shared Ctrl K is worded as Chat words it.
  assert.ok(groups[0].items.some((i) => i.label === "Command menu"));
});

test("a Code binding prints the keycaps Keyboard prints, per platform", () => {
  assert.deepEqual(bindingKeys("mod+alt+d", "⌘"), ["⌘", "⌥", "D"]);
  assert.deepEqual(bindingKeys("mod+alt+d", "Ctrl"), ["Ctrl", "Alt", "D"]);
  assert.deepEqual(bindingKeys("mod+shift+enter", "Ctrl"), ["Ctrl", "⇧", "↵"]);
  assert.deepEqual(bindingKeys("arrowleft", "⌘"), ["←"]);
});

test("the rail is twelve rows: the contract's ten, Notifications and Code", () => {
  const ids = SETTINGS_GROUPS.flatMap((g) => g.ids) as string[];
  assert.equal(ids.length, 12);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(ids), new Set(ALL_SETTINGS_SECTIONS.map((s) => s.id)));
  // Every section the shell contract carries keeps its row.
  for (const s of SETTINGS_SECTIONS) assert.ok(ids.includes(s.id), s.id);
  assert.deepEqual(SETTINGS_GROUPS.map((g) => g.label), ["Personal", "Integrations", "Coding"]);
  assert.deepEqual(SETTINGS_GROUPS[2].ids, ["code"]);
});

test("every folded section's old id opens the section that now holds it", () => {
  const folded: [string, string][] = [
    ["appearance", "general"],
    ["keyboard", "general"],
    ["code-keyboard", "general"],
    ["capabilities", "general"],
    ["remote", "devices"],
    ["connections", "code"],
    ["code-agent", "code"],
    ["code-permissions", "code"],
  ];
  for (const [old, now] of folded) {
    assert.ok(!ALL_SETTINGS_SECTIONS.some((s) => (s.id as string) === old), `${old} is no longer a row`);
    assert.equal(resolveSettingsSection(old), now, `?section=${old}`);
  }
});

test("search keywords only point at settings that live in that section", () => {
  const find = (q: string) => ALL_SETTINGS_SECTIONS.filter((s) => settingsSectionMatches(s, q)).map((s) => s.id);
  // Follow-up suggestions were removed from the product.
  assert.deepEqual(find("suggestions"), []);
  // Appearance, Reading and Keyboard are General's groups now.
  for (const q of ["send", "dark mode", "accent", "wrap", "shortcuts", "code shortcuts", "language"]) assert.ok(find(q).includes("general"), q);
  // Conversations messaging each other is Memory's; pairing is Devices'.
  assert.ok(find("conversations").includes("memory"));
  for (const q of ["remote", "pair", "iphone", "revoke"]) assert.ok(find(q).includes("devices"), q);
  // Code holds its plans and keys, its access and its team.
  for (const q of ["api key", "byok", "subscription", "permissions", "agents", "budget"]) assert.ok(find(q).includes("code"), q);
});

test("search finds the words people type for a setting, not only the setting's own name", () => {
  const find = (q: string) => ALL_SETTINGS_SECTIONS.filter((s) => settingsSectionMatches(s, q)).map((s) => s.id);
  // A word only matches at a word START, so "pair" never found the Unpair button.
  assert.ok(find("unpair").includes("devices"));
  // The retired section's name lands where its settings went.
  for (const q of ["capabilities"]) {
    assert.ok(find(q).includes("general"), q);
    assert.ok(find(q).includes("memory"), q);
  }
  // Plan & usage › Invite a friend.
  for (const q of ["invite", "referral", "friend", "reward", "invite friend"]) assert.ok(find(q).includes("billing"), q);
  // Both chimes: a reply's (Notifications) and a call's (Voice › Voice sounds).
  for (const q of ["sound", "sounds", "chime"]) {
    assert.ok(find(q).includes("notifications"), q);
    assert.ok(find(q).includes("voice"), q);
  }
  // "voice" still does not find Plan & usage through "invoice" or "invites".
  assert.deepEqual(find("voice"), ["voice"]);
});

test("the shortcuts dialog splits groups into two columns of about the same height", () => {
  const g = (n: number) => ({ items: Array.from({ length: n }, () => 0) });
  // Rows plus a heading each: 7, 3, 5, 6 -> 10 | 11.
  const [left, right] = splitShortcutColumns([g(6), g(2), g(4), g(5)]);
  assert.equal(left.length, 2);
  assert.equal(right.length, 2);
  // One tall group leads alone rather than leave the left column empty.
  const [l2, r2] = splitShortcutColumns([g(20), g(1), g(1)]);
  assert.equal(l2.length, 1);
  assert.equal(r2.length, 2);
  assert.deepEqual(splitShortcutColumns([]), [[], []]);
  // Chat's list and Code's list both land in two non-empty columns.
  for (const groups of [codeShortcutGroups("⌘")]) {
    const [a, b] = splitShortcutColumns(groups);
    assert.ok(a.length > 0 && b.length > 0);
    assert.equal(a.length + b.length, groups.length);
  }
});

test("a link shows without its scheme, its last segment apart", () => {
  assert.deepEqual(splitDisplayLink("https://alevr.com/r/7Q2KM9XA"), { lead: "alevr.com/r/", tail: "7Q2KM9XA" });
  assert.deepEqual(splitDisplayLink("http://localhost:3000/r/ABC/"), { lead: "localhost:3000/r/", tail: "ABC" });
  assert.deepEqual(splitDisplayLink("alevr.com"), { lead: "", tail: "alevr.com" });
});

test("a date this year drops the year; an older one keeps it", () => {
  const at = { locale: "en-US", timeZone: "UTC" };
  const now = Date.UTC(2026, 9, 26, 12);
  assert.equal(formatRecentDate(Date.UTC(2026, 8, 18, 12), now, at), "Sep 18");
  assert.equal(formatRecentDate(Date.UTC(2025, 8, 18, 12), now, at), "Sep 18, 2025");
});

test("last seen reads in words", () => {
  const now = Date.UTC(2026, 9, 26, 12);
  assert.equal(formatAgo(now - 30_000, now), "just now");
  assert.equal(formatAgo(now - 60 * 60_000, now), "1 hour ago");
  assert.equal(formatAgo(now - 3 * 3_600_000, now), "3 hours ago");
  assert.equal(formatAgo(now - 5 * 60_000, now), "5 minutes ago");
  assert.equal(formatAgo(now - 2 * 86_400_000, now), "2 days ago");
});

test("initials are the first and last names' first letters", () => {
  assert.equal(initialsFor("Liam Magnier", null), "LM");
  assert.equal(initialsFor("Liam", "liam@example.com"), "L");
  assert.equal(initialsFor("  anne marie  du pont ", null), "AP");
  assert.equal(initialsFor(null, "zoe@example.com"), "Z");
  assert.equal(initialsFor("", ""), "U");
  assert.equal(initialsFor("Émile Zola", null), "ÉZ");
});
