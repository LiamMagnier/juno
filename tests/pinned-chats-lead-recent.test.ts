/**
 * Owner decision, 2026-10-26 (docs/rework/INTERACTION_SPEC.md S11): "Pinned
 * chats" stops being its own sidebar section. The pinned chats lead the Recent
 * list, each keeping its pin mark, on the web, the Mac and the iPhone/iPad.
 *
 * The web's order is `pinnedFirst` (sidebar-lists.ts), tested as logic here.
 * The Swift cannot be compiled in this environment, so the Mac and iOS halves
 * are pinned at the source level, the way the other native tests in this
 * folder hold Swift to the web.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { pinnedFirst } from "@/components/app/sidebar-lists";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
/** Source with `//` and block comments removed, so a comment cannot satisfy a check. */
const code = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T12:00:00Z");
const chat = (id: string, hoursAgo: number, pinned = false) => ({
  id,
  pinned,
  lastMessageAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
});
const ids = (list: { id: string }[]) => list.map((c) => c.id);

/* ── The order ──────────────────────────────────────────────────────────── */

test("pinned chats lead, newest first; the rest follow, newest first", () => {
  const list = [chat("a", 1), chat("p-old", 50, true), chat("b", 3), chat("p-new", 30, true), chat("c", 40)];
  assert.deepEqual(ids(pinnedFirst(list)), ["p-new", "p-old", "a", "b", "c"]);
  assert.deepEqual(ids(list), ["a", "p-old", "b", "p-new", "c"], "the input is not reordered in place");
});

test("unpinning drops a row into its place by date, not where it sat", () => {
  // The server sends pinned chats first (`orderBy: [{ pinned: "desc" }, …]`),
  // and Unpin flips the flag in place, so the old row is still at the head of
  // the array. It must land after the newer chats.
  const before = [chat("p", 50, true), chat("a", 1), chat("b", 30), chat("c", 70)];
  assert.deepEqual(ids(pinnedFirst(before)), ["p", "a", "b", "c"]);
  const after = before.map((c) => (c.id === "p" ? { ...c, pinned: false } : c));
  assert.deepEqual(ids(pinnedFirst(after)), ["a", "b", "p", "c"]);
});

test("pinning lifts a row into the head at its own date", () => {
  const list = [chat("p", 50, true), chat("a", 1), chat("b", 30)];
  const pinnedB = list.map((c) => (c.id === "b" ? { ...c, pinned: true } : c));
  assert.deepEqual(ids(pinnedFirst(pinnedB)), ["b", "p", "a"]);
});

test("ties and undated rows keep the order given", () => {
  const same = new Date(NOW).toISOString();
  const list = [
    { id: "x", pinned: false, lastMessageAt: same },
    { id: "y", pinned: false, lastMessageAt: same },
    { id: "u1", pinned: false, lastMessageAt: "" },
    { id: "z", pinned: false, lastMessageAt: new Date(NOW - HOUR).toISOString() },
    { id: "u2", pinned: false, lastMessageAt: null },
  ];
  assert.deepEqual(ids(pinnedFirst(list)), ["x", "y", "z", "u1", "u2"]);
  assert.deepEqual(pinnedFirst([]), []);
});

/* ── The web ────────────────────────────────────────────────────────────── */

test("the web draws one Recent section whose first rows are the pinned chats", () => {
  const path = "src/components/app/app-sidebar.tsx";
  const sidebar = code(path);
  assert.doesNotMatch(read(path), /label="Pinned chats"/, "no Pinned chats section");
  assert.doesNotMatch(sidebar, /sectionCollapsed\.pinned|toggleSection\("pinned"\)|juno:sidebar:starred:collapsed/, "no fold of its own");
  assert.match(sidebar, /import \{[^}]*\bpinnedFirst\b[^}]*\} from "@\/components\/app\/sidebar-lists"/);
  // Needs you still takes its rows out first; everything else is Recent.
  assert.match(sidebar, /const recents = React\.useMemo\(\s*\(\) => pinnedFirst\(live\.filter\(\(c\) => !needsYouIds\.has\(c\.id\)\)\),\s*\[live, needsYouIds\]\s*\);/);
  assert.doesNotMatch(sidebar, /live\.filter\(\(c\) => !c\.pinned/, "pinned chats are not filtered out of Recent");
  // Recent is still the one folding Section, and pages through `visibleRecents`.
  assert.match(sidebar, /<Section\s+label="Recent"\s+isCollapsed=\{sectionCollapsed\.recents\}\s+onToggleCollapse=\{\(\) => toggleSection\("recents"\)\}\s*>\s*\{visibleRecents\.map\(/);
  // Each row keeps its pin mark: the trailing filled pin, on any row that is
  // not listed under a project.
  assert.match(sidebar, /const trailingMark = conversation\.pinned && !nested;/);
  assert.match(sidebar, /\{trailingMark && \(/);
  assert.match(sidebar, /<Pin weight="fill" motion="none" className="size-3 shrink-0 text-muted-foreground" aria-hidden \/>/);
  // The mark is silent, so the row says "Pinned" in words, after the run's
  // words and inside the link, the order the Mac's `rowValue` and the
  // iPhone's accessibility value use. Without the Pinned chats heading this is
  // the only way a screen reader hears that a row is pinned.
  assert.match(
    sidebar,
    // (`code` leaves a JSX comment as an empty `{}`.)
    /\{signal && <StatusDot tone=\{signal\.tone\} label=\{signal\.label\} \/>\}\s*(?:\{\}\s*)*\{trailingMark && <span className="sr-only">Pinned<\/span>\}/
  );
  const link = sidebar.slice(sidebar.indexOf("<Link\n        ref={linkRef}"), sidebar.indexOf("</Link>", sidebar.indexOf("<Link\n        ref={linkRef}")));
  assert.match(link, /<span className="sr-only">Pinned<\/span>/, "the words are part of the row link's name");
  const mac = code("native/macOS/JunoDesktop/App/DesktopChatSidebar.swift");
  assert.match(mac, /\[signal\.map \{ ChatWorkVocabulary\.label\(\$0\.status\) \}, pinned \? "Pinned" : nil\]/, "the Mac says the same word, after the run's");
  // Pin and Unpin stay in the row menu, and flip the flag the order reads.
  assert.match(sidebar, /patch\(\{ pinned: !conversation\.pinned \}\)/);
});

/* ── The Mac ────────────────────────────────────────────────────────────── */

test("the Mac's Chat column has no Pinned chats section and leads Recent with the pins", () => {
  const path = "native/macOS/JunoDesktop/App/DesktopChatSidebar.swift";
  const swift = code(path);
  assert.doesNotMatch(swift, /Heading\.pinned\b/, "no Pinned chats heading");
  assert.doesNotMatch(swift, /pinnedChatsOpen|juno\.sidebar\.pinned\.expanded/, "no fold of its own");
  assert.match(
    swift,
    /static func recent\(\s*from chats: \[NativeConversation\],\s*excluding needsYou: Set<String> = \[\]\s*\) -> \[NativeConversation\] \{\s*pinned\(from: chats, excluding: needsYou\)\s*\+ chats\.filter \{ !\$0\.pinned && !needsYou\.contains\(\$0\.id\) \}\s*\}/,
    "Recent is the pinned chats, then the rest"
  );
  // `chats(from:)` is newest first, so both halves are by date, as on the web.
  assert.match(swift, /\.sorted \{ \$0\.lastMessageAt > \$1\.lastMessageAt \}/);
  // One Recent section in the list, paged, folding like Pinned projects (its
  // pinned head folds with it, as on the web), and the row keeps its pin mark.
  assert.match(
    swift,
    /DesktopSidebarHeadingRow\(JunoShellChatSidebar\.Heading\.recent\.label, action: \{ recentOpen\.toggle\(\) \}\)\s*if recentOpen \{\s*ForEach\(Array\(recent\.prefix\(recentLimit\)\)\)/
  );
  assert.match(swift, /@AppStorage\("juno\.sidebar\.recent\.expanded"\) private var recentOpen = true/);
  assert.match(swift, /\} else if conversation\.pinned \{\s*JunoIconView\(\.pin, size: 12\)/);
  assert.match(swift, /rowValue\(pinned: conversation\.pinned, signal: signal\)/);
  // The rename reveal pages Recent; there is no other section to open.
  assert.match(swift, /private func reveal\(\s*_ id: String,\s*recent: \[NativeConversation\],\s*proxy: ScrollViewProxy\s*\)/);

  const tests = read("native/macOS/JunoDesktop/Tests/DesktopChatShellTests.swift");
  assert.match(tests, /recent\(from: chats\)\.map\(\\\.id\) == \["a", "c", "b", "d"\]/);
  assert.match(tests, /func anUnpinnedChatFallsIntoDateOrder\(\)/);
  assert.match(tests, /#expect\(recent\.map\(\\\.id\) == \["pinned", "today", "yesterday", "old"\]\)/);
});

/* ── iPhone and iPad ────────────────────────────────────────────────────── */

test("the iPhone drawer and the iPad column lead Recent with the pins, marked", () => {
  const path = "native/iOS/JunoMobile/App/JunoMobileDrawer.swift";
  const swift = code(path);
  assert.doesNotMatch(swift, /"Pinned chats"|"sidebar\.pinned"/, "no Pinned section in either layout");
  assert.doesNotMatch(swift, /ForEach\(pinnedChats\)/);
  assert.match(swift, /private var recentChats: \[NativeConversation\] \{\s*pinnedChats \+ groups\s*\.filter \{ \$0\.bucket != \.pinned \}\s*\.flatMap\(\\\.conversations\)\s*\.sorted \{ \$0\.lastMessageAt > \$1\.lastMessageAt \}\s*\}/);
  // Both layouts' Recent rows say whether they are pinned; search results do not.
  assert.equal((swift.match(/conversationRow\(\$0, pinned: \$0\.pinned\)/g) ?? []).length, 2, "drawer and iPad column");
  assert.match(swift, /ForEach\(matchingChats\) \{ conversationRow\(\$0, pinned: false\) \}/);
  assert.match(swift, /JunoMobileConversationRow\(\s*title: conversation\.title,\s*pinned: pinned,/);
  // The mark trails the title, after a pending send, as on the web and the Mac.
  const row = swift.slice(swift.indexOf("struct JunoMobileConversationRow"), swift.indexOf("struct JunoMobileDrawerRow"));
  assert.match(row, /Spacer\(minLength: 0\)\s*if pending \{\s*JunoIconView\(\.refresh, size: 12\)\s*\.junoSecondaryInk\(\)\s*\} else if pinned \{\s*JunoIconView\(\.pin, size: 12\)\s*\.junoSecondaryInk\(\)\s*\.accessibilityHidden\(true\)\s*\}/);
  assert.ok(row.indexOf("JunoIconView(.pin") > row.indexOf("Text(title)"), "the pin comes after the title");
  assert.match(row, /\.accessibilityValue\(pinned \? Text\("Pinned"\) : Text\(verbatim: ""\)\)/);
});
