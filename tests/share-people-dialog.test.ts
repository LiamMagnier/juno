import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SharePersonView } from "@/lib/share-people-core";

(globalThis as { React?: typeof React }).React = React;

/*
 * The Share dialog's half of sharing with specific people: the "Specific
 * people" / "Anyone with the link" choice and where each leads, the people
 * panel's list (rendered to markup), the panel's wiring to its routes (read
 * as source, the way tests/artifact-ownership-units.test.ts reads the link
 * panels), and the wall a people share shows to anyone it is not for.
 *
 * Rules and storage are tests/share-people.test.ts and
 * tests/share-people-store.test.ts.
 */

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

// The public frame pulls a stylesheet, and the two buttons need a browser's
// router and Auth.js: stand-ins that keep only what the markup says.
const Plain = ({ children, href }: { children?: React.ReactNode; href?: string }) =>
  href ? React.createElement("a", { href }, children) : React.createElement("span", null, children);
const stubs: Record<string, unknown> = {
  "next/link": { __esModule: true, default: Plain },
  "@/components/public/public-frame": {
    PublicState: ({ title, description, children }: { title: string; description: string; children?: React.ReactNode }) =>
      React.createElement("main", null, React.createElement("h1", null, title), React.createElement("p", null, description), children),
  },
  "@/components/share/share-switch-account": {
    ShareSwitchAccount: ({ returnTo }: { returnTo: string }) => React.createElement("button", { "data-return": returnTo }, "Use another account"),
  },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
let panel: typeof import("@/components/share/share-people-panel");
let dialog: typeof import("@/components/share/share-dialog");
let restricted: typeof import("@/components/share/share-restricted");
try {
  panel = require("../src/components/share/share-people-panel");
  dialog = require("../src/components/share/share-dialog");
  restricted = require("../src/components/share/share-restricted");
} finally {
  moduleLoader._load = originalLoad;
}

const person = (id: string, email: string): SharePersonView => ({ id, email, addedAt: "2026-10-31T12:00:00.000Z" });

/** The source of one arrow function or method body, from its declaration to the next top-level `const`. */
function body(source: string, start: string): string {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const end = source.indexOf("\n  const ", from + start.length);
  return source.slice(from, end < 0 ? undefined : end);
}

// ─── The choice ───────────────────────────────────────────────────────────────

test("the dialog offers Specific people and Anyone with the link, starting on Specific people", () => {
  const options = dialog.shareAudienceOptions();
  assert.deepEqual(options.map((o) => [o.value, o.label]), [["people", "Specific people"], ["link", "Anyone with the link"]]);
  const source = read("src/components/share/share-dialog.tsx");
  assert.match(source, /const start: ShareAudienceChoice = peopleAllowed \? \(initialAudience \?\? "people"\) : "link";/);
  // Only an entry that names something public by name opens on the link: an artifact's "Publish…".
  const opensOnLink = ["src/components/artifacts/artifact-lifecycle-actions.tsx", "src/components/canvas/canvas-panel.tsx", "src/components/chat/chat-view.tsx", "src/components/app/app-sidebar.tsx", "src/app/(app)/artifacts/page.tsx", "src/components/research/report-export.tsx"].filter((file) => /initialAudience="link"/.test(read(file)));
  assert.deepEqual(opensOnLink, ["src/components/artifacts/artifact-lifecycle-actions.tsx"]);
  assert.match(source, /<SegmentedControl[\s\S]*?ariaLabel="Who can open it"/);
  // Each choice leads to its own panel; the link side is today's link and publish panels, unchanged.
  assert.match(source, /audience === "people" \? \(\s*<SharePeoplePanel key="people" target=\{target\} open=\{open\} \/>/);
  assert.match(source, /<ChatLinkPanel key="link" conversationId=\{conversationId\}/);
  assert.match(source, /<PublishPanel key="link" artifactId=\{artifactId\}/);
  // A conversation whose transcript the server does not hold shares by link only.
  assert.match(source, /const peopleAllowed = !transcript;/);
});

test("the description says what each choice does, for a chat and for an artifact", () => {
  assert.match(dialog.shareDialogDescription("CHAT", "people"), /people you add .* signed in with the address you invite/i);
  assert.match(dialog.shareDialogDescription("ARTIFACT", "people"), /Later edits stay private/);
  assert.match(dialog.shareDialogDescription("CHAT", "link"), /^A link shows the conversation/);
  assert.match(dialog.shareDialogDescription("ARTIFACT", "link"), /^Publishing puts the version you choose on a public page/);
});

// ─── The people panel ─────────────────────────────────────────────────────────

test("the list shows the owner first, then each person with a named Remove", () => {
  const html = renderToStaticMarkup(
    React.createElement(panel.PeopleList, {
      people: [person("r1", "grace@example.test"), person("r2", "alan@example.test")],
      removing: new Set(["r2"]),
      removed: new Set<string>(),
      fresh: new Set(["r1"]),
      onRemove: () => {},
    }),
  );
  assert.match(html, /People with access/);
  assert.ok(html.indexOf(">You<") < html.indexOf("grace@example.test"), "the owner's row comes first");
  assert.match(html, />Owner</);
  assert.match(html, /aria-label="Remove grace@example\.test"/);
  assert.match(html, /aria-label="Remove alan@example\.test"[^>]*disabled/, "a remove in flight cannot be pressed twice");
  assert.match(html, /motion-safe:animate-rise-in/, "a person just added rises in");
  assert.doesNotMatch(html, /Only you can open it/);
  // Nothing about accounts or opens: the address and the day it was added.
  assert.match(html, /Added Oct 31, 2026/);
  assert.doesNotMatch(html, /opened|viewed|has an account|joined/i);
});

test("a removed person's row folds away, and an empty list says only the owner can open it", () => {
  const html = renderToStaticMarkup(
    React.createElement(panel.PeopleList, {
      people: [person("r1", "grace@example.test")],
      removing: new Set<string>(),
      removed: new Set(["r1"]),
      fresh: new Set<string>(),
      onRemove: () => {},
    }),
  );
  assert.doesNotMatch(html, /grace@example\.test/);
  assert.match(html, /Only you can open it until you add someone\./);
});

test("on first paint the panel is checking, and it has asked for nothing yet", () => {
  const html = renderToStaticMarkup(React.createElement(panel.SharePeoplePanel, { target: { conversationId: "c1" }, open: true }));
  assert.match(html, /aria-label="Checking who has access"/);
});

test("opening the panel reads; Invite, Remove and Stop sharing are the only writes, each to its route", () => {
  const source = read("src/components/share/share-people-panel.tsx");
  const load = body(source, "const load = React.useCallback(async () => {");
  assert.match(load, /fetch\(`\/api\/share\/people\?\$\{targetQuery\}`, \{ cache: "no-store" \}\)/);
  assert.doesNotMatch(load, /method:/, "the reader never writes");
  assert.doesNotMatch(source, /useEffect\([^)]*invite/);

  const invite = body(source, "const invite = async");
  assert.match(invite, /parseShareEmails\(draft\)/, "addresses are checked before anything is sent");
  assert.match(invite, /fetch\("\/api\/share\/people", \{\s*method: "POST"/);
  assert.match(invite, /body: JSON\.stringify\(\{ \.\.\.\("conversationId" in target \? \{ kind: "CHAT" \} : \{ kind: "ARTIFACT" \}\), \.\.\.target, emails \}\)/);
  assert.match(invite, /code === "share_taken_down"/);

  const remove = body(source, "const remove = async");
  assert.match(remove, /fetch\(`\/api\/share\/people\/\$\{encodeURIComponent\(person\.id\)\}`, \{ method: "DELETE" \}\)/);

  const stop = body(source, "const stop = async");
  assert.match(stop, /fetch\(`\/api\/share\/\$\{encodeURIComponent\(share\.id\)\}`, \{ method: "DELETE" \}\)/, "Stop sharing is the same revoke as a link");
  assert.match(stop, /setPeople\(\[\]\)/);
});

test("the panel names a bad address under the field, with the same parser the server uses", () => {
  assert.equal(panel.SHARE_PEOPLE_COPY.invalid(["nope"]), "“nope” isn’t an email address.");
  assert.match(panel.SHARE_PEOPLE_COPY.invalid(["a", "b"]), /^These aren’t email addresses: a, b\.$/);
  const source = read("src/components/share/share-people-panel.tsx");
  assert.match(source, /import \{ parseShareEmails, SHARE_PEOPLE_LIMITS, type SharePersonView \} from "@\/lib\/share-people-core";/);
  assert.match(source, /aria-invalid=\{fieldError \? true : undefined\}/);
  assert.match(source, /role="alert"/);
});

// ─── The wall ─────────────────────────────────────────────────────────────────

test("signed out, a people share asks for a sign-in that comes back to the page, and shows nothing of the share", () => {
  const html = renderToStaticMarkup(React.createElement(restricted.ShareRestricted, { state: "sign-in", token: "tok_ABC123" }));
  assert.match(html, /Sign in to open this/);
  assert.match(html, /href="\/sign-in\?callbackUrl=%2Fshare%2Ftok_ABC123"/);
  assert.match(html, /href="\/sign-up\?callbackUrl=%2Fshare%2Ftok_ABC123"/);
});

test("an unconfirmed address is asked to confirm; a wrong account is told so and offered another", () => {
  const verify = renderToStaticMarkup(React.createElement(restricted.ShareRestricted, { state: "verify", token: "t", email: "grace@example.test" }));
  assert.match(verify, /Confirm your email to open this/);
  assert.match(verify, /grace@example\.test is yours/);
  const denied = renderToStaticMarkup(React.createElement(restricted.ShareRestricted, { state: "denied", token: "t", email: "mallory@example.test" }));
  assert.match(denied, /You don’t have access to this/);
  assert.match(denied, /not with mallory@example\.test/);
  assert.match(denied, /data-return="\/share\/t"/, "switching account returns to the page");
});

test("the share page settles who is asking before it reads anything of a people share", () => {
  const page = read("src/app/share/[token]/page.tsx");
  const people = page.slice(page.indexOf("if (await peekPeopleShare(token)) {\n    const people"), page.indexOf("const publication = await findPublicPublication(token);\n  if (!publication) return null;"));
  assert.ok(people.indexOf('access.state !== "granted"') < people.indexOf("sharedArtifactIsTrashed"), "access before the trash check");
  assert.ok(people.indexOf('access.state !== "granted"') < people.indexOf("getSharedChatSnapshot"), "access before the snapshot");
  assert.ok(people.indexOf("getSharedChatSnapshot") < people.indexOf("countShareView"), "a view is counted only once shown");
  // Its metadata names it only to someone who may read it.
  assert.match(page, /if \(people\?\.access\.state !== "granted"\) return RESTRICTED_METADATA;/);
  // View-only for its people: no "Make a copy".
  assert.match(page, /const copyable = !!artifact && !subject\.restricted && sharedTypeCopyable\(artifact\.type\);/);
  // The poster draws a people share's design only for a reader the page would show it to.
  const poster = read("src/app/share/[token]/poster/route.ts");
  assert.match(poster, /people\.access\.state !== "granted"/);
  assert.match(poster, /cacheControl = POSTER_CACHE_REVALIDATE;/);
});
