import assert from "node:assert/strict";
import fs from "node:fs";
// Aliased, because `path` below is this file's own helper for "where does this
// /work URL land" — the noun every test above is about.
import nodePath from "node:path";
import test from "node:test";

import { chatPathForSession, resolveWorkUrl } from "../src/lib/work-url-migration";

/*
 * EVERY /work URL SHAPE THAT EVER EXISTED, AND WHERE IT LANDS.
 *
 * The Work web routes are gone (docs/design/TWO_PRODUCTS.md §2) and the URLs
 * are not. They are in bookmarks, in notification emails Juno itself sent, in
 * search results, and — for `/work/skills` — hard-coded in a shipped macOS
 * build that cannot be corrected retroactively. The one failure this file
 * exists to catch is a 404 on a path that worked yesterday, which is why the
 * cases below are written as the SHAPES rather than as the function's branches:
 * a branch test passes when somebody deletes a case, and a shape test does not.
 *
 * The lookup leg — `/work/<sessionId>` → the conversation that session writes
 * into — is split at the seam: `resolveWorkUrl` says "this is a session id" and
 * `chatPathForSession` says where a resolved session goes. Only the Prisma call
 * between them lives in the route, so everything a person can type is covered
 * here without a database.
 */

const path = (segments: string[] | undefined, query: Record<string, string> = {}) => {
  const target = resolveWorkUrl(segments, query);
  assert.equal(target.kind, "path", `expected /work/${(segments ?? []).join("/")} to be a static redirect`);
  return target.kind === "path" ? target.path : "";
};

test("the inbox lands on the chat index", () => {
  assert.equal(path(undefined), "/chat");
  assert.equal(path([]), "/chat");
});

test("a project filter survives the move, because /chat reads the same parameter", () => {
  assert.equal(path([], { project: "proj-a" }), "/chat?project=proj-a");
});

test("a project id is encoded rather than pasted into the Location header", () => {
  assert.equal(path([], { project: "a b&c" }), "/chat?project=a%20b%26c");
});

test("a repeated parameter takes its first value rather than serialising the array", () => {
  const target = resolveWorkUrl([], { project: ["proj-a", "proj-b"] });
  assert.deepEqual(target, { kind: "path", path: "/chat?project=proj-a" });
});

test("the triage filter is dropped, and dropping it still lands somewhere true", () => {
  // Six of the seven `?show=` states named a pill on a list that no longer
  // exists; the seventh, needs_you, is the fold at the top of the sidebar and is
  // reached by pressing it rather than by a URL. See the module's own note for
  // why the sidebar does not read this parameter.
  for (const state of ["needs_you", "in_progress", "scheduled", "unread", "done", "all", "archived"]) {
    assert.equal(path([], { show: state }), "/chat");
  }
});

test("the three destinations that moved keep their whole shape", () => {
  assert.equal(path(["skills"]), "/skills");
  assert.equal(path(["skills", "new"]), "/skills/new");
  assert.equal(path(["skills", "skl_123"]), "/skills/skl_123");

  assert.equal(path(["schedules"]), "/automations");
  assert.equal(path(["schedules", "new"]), "/automations/new");
  assert.equal(path(["schedules", "sch_123"]), "/automations/sch_123");

  assert.equal(path(["permissions"]), "/permissions");
});

test("the Macs list folds into the permissions hub, and one Mac keeps its page", () => {
  // `/work/hosts` was already a redirect to `/work/permissions`; it is answered
  // directly rather than chained, so a URL in the composer's refusal notes does
  // not cost two round trips.
  assert.equal(path(["hosts"]), "/permissions");
  assert.equal(path(["hosts", "host_123"]), "/permissions/host_123");
});

test("a path segment is re-encoded on the way out", () => {
  // Next hands `params` already percent-decoded, so a segment that arrived
  // encoded would otherwise be emitted raw into a Location header.
  assert.equal(path(["skills", "a b/c"]), "/skills/a%20b%2Fc");
});

test("a single unknown segment is a session id", () => {
  assert.deepEqual(resolveWorkUrl(["cl_sess_1"]), { kind: "session", sessionId: "cl_sess_1" });
});

test("a shape this product never served lands on the front door rather than a 404", () => {
  // Nothing under `/work` was ever three segments deep, so there is no history
  // to honour and nothing to explain. Forwarding the extra segments verbatim
  // would convert a URL that never existed into a 404 on the NEW tree, which is
  // the one outcome this whole module exists to prevent — so everything past
  // the first extra segment is dropped, and the answer is the deepest page the
  // family actually serves: `/skills/skl_123`, not `/skills`. A first segment
  // that names no family has no such page, and gets `/chat`.
  assert.equal(path(["cl_sess_1", "settings"]), "/chat");
  assert.equal(path(["permissions", "anything"]), "/permissions");
  assert.equal(path(["skills", "skl_123", "versions"]), "/skills/skl_123");
  assert.equal(path(["schedules", "sch_123", "runs"]), "/automations/sch_123");
  assert.equal(path(["hosts", "host_123", "grants"]), "/permissions/host_123");
});

test("a resolved session goes to its conversation, and one without goes to the index", () => {
  assert.equal(chatPathForSession("conv-1"), "/chat/conv-1");
  // Null for every session the retired Work composer created — most of the
  // history of an older account — so this is the common path, not an edge.
  assert.equal(chatPathForSession(null), "/chat");
  assert.equal(chatPathForSession(undefined), "/chat");
  assert.equal(chatPathForSession("a b"), "/chat/a%20b");
});

/*
 * AND THE DESTINATION ITSELF, WHICH TYPESCRIPT CANNOT CHECK.
 *
 * `useParams<{ id: string }>()` is an unchecked assertion: it names a shape and
 * Next hands back whatever the FOLDER is called. Rename `[id]` to `[hostId]` —
 * which the move of the Macs page into the Permissions hub did — and the page
 * still compiles, reads `undefined` on every render, fetches
 * `/api/work/hosts/undefined`, takes the 404 and draws "Mac not found" for
 * every Mac, for ever. There is no type error and no failing render, and the
 * only way to find it is to click a row. So the folder's parameter name and the
 * page's are pinned against each other here, beside the map that sends people
 * to them.
 */

const appRoot = nodePath.join(process.cwd(), "src/app/(app)");

/** The folder's own parameter name: `[hostId]` gives `hostId`. */
function segmentName(folder: string): string {
  const match = /^\[(?:\.\.\.)?([^\]]+)\]$/.exec(nodePath.basename(folder));
  assert.ok(match, `${folder} is not a dynamic segment`);
  return match[1];
}

/** Every key the page destructures out of `useParams`. */
function readParams(file: string): string[] {
  const match = /const\s*\{([^}]*)\}\s*=\s*useParams</.exec(fs.readFileSync(file, "utf8"));
  assert.ok(match, `${file} does not destructure useParams`);
  return match[1]
    .split(",")
    .map((part) => part.split(":")[0].trim())
    .filter((part) => part.length > 0);
}

test("every page the map hands an id to reads the parameter its own folder declares", () => {
  // The three families `resolveWorkUrl` can build a deep path for. A fourth
  // wants adding here on the day it is added there.
  for (const folder of ["skills/[id]", "automations/[id]", "permissions/[hostId]"]) {
    const page = nodePath.join(appRoot, folder, "page.tsx");
    assert.ok(fs.existsSync(page), `${folder} is a redirect destination with no page`);
    assert.deepEqual(
      readParams(page),
      [segmentName(folder)],
      `src/app/(app)/${folder}/page.tsx must read "${segmentName(folder)}", the name of its own folder`
    );
  }
});

test("the in-app link to one Mac has the same shape as the redirect to it", () => {
  // Two callers reach that page: `WorkHostRow` from the list, and the
  // `/work/hosts/<id>` leg of this map from a bookmark. A page only one of them
  // can open is the same defect seen from one side.
  const row = fs.readFileSync(
    nodePath.join(process.cwd(), "src/components/work/work-host-row.tsx"),
    "utf8"
  );
  assert.match(row, /href=\{`\/permissions\/\$\{host\.id\}`\}/);
  assert.equal(path(["hosts", "host_123"]), "/permissions/host_123");
});
