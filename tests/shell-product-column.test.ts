import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { productOf } from "@/components/app/product-switch";

const SIDEBAR = readFileSync(new URL("../src/components/app/app-sidebar.tsx", import.meta.url), "utf8");
const USER_MENU = readFileSync(new URL("../src/components/app/user-menu.tsx", import.meta.url), "utf8");

/** Source with comments removed, so an assertion about code cannot pass or
 *  fail on the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/*
 * Which column the shell draws, and whether the one new control in it can be
 * pressed with a thumb.
 *
 * `product` decides the whole left column — its destinations and which
 * conversations its folds hold — so a wrong answer here is not a mis-lit
 * segment, it is Library, Projects and every chat row disappearing from a page
 * that has nothing to do with Code.
 */

test("the path alone decides every route that is not a conversation", () => {
  assert.equal(productOf("/chat", null), "chat");
  assert.equal(productOf("/library", null), "chat");
  assert.equal(productOf("/code", null), "code");
  assert.equal(productOf("/code/pulls", null), "code");
  assert.equal(productOf(null, null), "chat");
});

test("a Code session's kind is the tiebreak while you are inside it", () => {
  // The path says "chat" for the entire time somebody is in a Code session,
  // because /chat/<id> is where CodeSessionView is served.
  assert.equal(productOf("/chat/abc", "code"), "code");
  assert.equal(productOf("/chat/abc", "chat"), "chat");
  assert.equal(productOf("/chat/abc", null), "chat");
});

test("the kind does not follow you out of the conversation", () => {
  /*
   * `activeConversationId` is set when a conversation view mounts and is never
   * cleared on unmount, so after opening one Code session its kind is still
   * sitting in the store on every later route. Unanchored, that stale kind
   * swapped the entire column — this is the regression, and it is the same one
   * the mobile title fixed for itself with `inConversation`.
   */
  for (const path of [
    "/library",
    "/projects",
    "/design",
    "/a/abc",
    "/settings",
    "/memory",
    "/tasks",
    "/connections",
    "/artifacts",
    "/chat",
  ]) {
    assert.equal(productOf(path, "code"), "chat", `${path} must keep Chat's column`);
  }
});

/** The source of one top-level function in the sidebar, up to the next one. */
function sidebarFunction(name: string): string {
  const start = SIDEBAR.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `app-sidebar.tsx defines ${name}`);
  const next = SIDEBAR.indexOf("\nfunction ", start + 1);
  return SIDEBAR.slice(start, next < 0 ? undefined : next);
}

/** Every string literal that contains `needle`, so a class list is checked
 *  as a class list and not matched against a comment beside it. */
function literalsWith(source: string, needle: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"/g)].map((m) => m[1]).filter((s) => s.includes(needle));
}

test("the Needs you toggle is a full touch target in the phone drawer", () => {
  /*
   * The sidebar IS the phone drawer (AppShell renders AppSidebar inside
   * SheetContent), and this fold's header is a control, not a label. It wears
   * a section heading's 28px geometry on a fine pointer; under a thumb it has
   * to grow to the 44px every other row in the drawer guarantees.
   *
   * Read from the toggle's own class list. The old assertion searched the
   * whole element's source, so it passed on the text "h-6" in a comment while
   * the class had long been h-7.
   */
  const [toggle] = literalsWith(sidebarFunction("NeedsYouFold"), "coarse:h-11");
  assert.ok(toggle, "the toggle declares a coarse-pointer height");
  const classes = toggle.split(/\s+/);
  assert.ok(classes.includes("h-7"), "at rest it has a section heading's height");
  assert.ok(classes.includes("coarse:h-11"), "a coarse pointer gets the panel's 44px target");
});

test("More holds only what earns no row of its own", () => {
  /*
   * The owner's request: Permissions out of More. Its Macs moved to Settings
   * (Devices) and the /permissions routes stay for the palette and old links.
   * Connections is reachable from Settings and the composer's "+", and Pull
   * requests became a top-level Code row, so neither may drift back in.
   */
  const more = sidebarFunction("MoreFlyout");
  const hrefs = [...more.matchAll(/href: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(hrefs, ["/connections", "/assistants", "/skills", "/automations"]);
  assert.ok(!more.includes('"/permissions"'), "Permissions is not in More");
  assert.ok(more.includes("Archived chats") && more.includes("Archived sessions"), "Archived stays in both products");

  const codeStart = SIDEBAR.indexOf("Code's three destinations");
  const code = SIDEBAR.slice(codeStart, SIDEBAR.indexOf("] as const)", codeStart));
  assert.ok(code.includes('href: "/code/pulls"'), "Pull requests is a top-level Code row");
});

test("bringing the open chat into view scrolls the list and nothing around it", () => {
  /*
   * `scrollIntoView` scrolls every clipping ancestor on both axes, and the
   * shell's <aside> clips a column laid out at full width while its own width
   * unfolds from the rail. Expanding the panel with the open chat below the
   * fold scrolled the frame 8px sideways, and the whole column lurched left
   * mid-fold. Only the list's own viewport may move.
   */
  const sidebar = withoutComments(SIDEBAR);
  assert.ok(!sidebar.includes(".scrollIntoView("), "no scrollIntoView in the sidebar");
  assert.match(sidebar, /root\.scrollTo\(\{/, "the list viewport scrolls itself");
});

test("Recent keeps paging after its sentinel is remounted", () => {
  /*
   * Needs you hides Recent and shows it again, which mounts a new sentinel.
   * The observer read a ref once, in an effect keyed to `[mounted, collapsed]`,
   * so it went on watching the detached node and the list stopped at the page
   * it had. The node is state now, and the observer follows it.
   */
  const sidebar = withoutComments(SIDEBAR);
  assert.match(sidebar, /ref=\{setSentinel\}/, "the sentinel is a callback ref");
  assert.match(sidebar, /io\.observe\(sentinel\);\s*return \(\) => io\.disconnect\(\);\s*\}, \[sentinel\]\);/);
  assert.ok(!sidebar.includes("sentinelRef"), "no ref read once in an effect");
});

test("everything that leaves the panel from a menu closes the phone drawer", () => {
  /*
   * The drawer's open state lives in the provider above the routes, so a page
   * reached from a menu inside it opened underneath a drawer that stayed open.
   * More's rows already closed it; the account menu's rows and an archived
   * chat opened from its dialog did not.
   */
  const menu = withoutComments(USER_MENU);
  // Each row from its tag to its label, which every row carries.
  const rows = [...menu.matchAll(/<MenuRow\b[\s\S]*?label="[^"]*"/g)].map((m) => m[0]);
  assert.ok(rows.length >= 4, "the account menu draws its rows with MenuRow");
  for (const row of rows) {
    assert.match(row, /onSelect=\{(leave|\(\) => \{\s*leave\(\);)/, `row closes the drawer: ${row.slice(0, 80)}`);
  }
  assert.match(menu, /<DropdownMenuItem asChild onSelect=\{onSelect\}>/, "a link row runs its onSelect too");
  assert.match(menu, /const leave = \(\) => setSidebarOpen\(false\);/);

  const archived = sidebarFunction("ArchivedChatsDialog");
  assert.match(withoutComments(archived), /onOpenChange\(false\);\s*onNavigate\(\);\s*router\.push/);
});
