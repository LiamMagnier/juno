import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serializeGrantForRemote, serializeGrantForHost } from "@/lib/work/serializers";

/*
 * The one thing a phone must never learn.
 *
 * A supervising client says "organise the folder you call Downloads" and is
 * never told that it is /Users/liam/Downloads. A path on a remote screen is a
 * path in a screenshot, in a support ticket, and in whatever untrusted page the
 * agent reads next — and it gives away the account name, the directory layout,
 * and usually the real identity of the work.
 *
 * The server keeps two serialisers for one row. This file checks the boundary
 * three ways: that the remote shape omits the paths, that the host shape still
 * carries them, and that no future column can ride out by accident.
 */

const GRANT = {
  id: "grant_1",
  userId: "user_1",
  sessionId: null,
  hostId: "host_1",
  kind: "local_folder",
  displayName: "Downloads",
  localPath: "/Users/liam/Downloads",
  remoteRef: null,
  accessMode: "read_write",
  resolvedRealPath: "/Users/liam/Downloads",
  revokedAt: null,
  lastUsedAt: new Date("2026-08-05T10:00:00.000Z"),
  createdAt: new Date("2026-08-01T10:00:00.000Z"),
  // Deliberately present and deliberately not in either interface: this stands
  // in for the column somebody adds next quarter. A serialiser that spread the
  // row would carry it straight out to a phone.
  volumeBookmark: "YnBsaXN0MDDUAQIDBAUGBw",
} as unknown as Parameters<typeof serializeGrantForHost>[0];

test("the remote shape carries no path of any kind", () => {
  // Through `unknown`: the `?: never` fields that make the boundary work also
  // stop ClientWorkGrant overlapping an index signature, which is the guard
  // doing its job rather than a problem with the cast.
  const remote = serializeGrantForRemote(GRANT) as unknown as Record<string, unknown>;
  const serialised = JSON.stringify(remote);

  assert.equal(remote.localPath, undefined);
  assert.equal(remote.resolvedRealPath, undefined);
  assert.doesNotMatch(
    serialised,
    /\/Users\//,
    `a home directory reached a remote client: ${serialised}`
  );
  assert.doesNotMatch(serialised, /liam/i, "the account name must not be inferable either");
});

test("the remote shape names every field it carries, so a new column cannot ride out", () => {
  const remote = serializeGrantForRemote(GRANT);
  assert.deepEqual(
    Object.keys(remote).sort(),
    ["accessMode", "displayName", "hostId", "id", "kind", "lastUsedAt", "revokedAt"],
    "a field appearing here that nobody added on purpose is the bug this test exists for"
  );
  assert.equal(
    (remote as unknown as Record<string, unknown>).volumeBookmark,
    undefined,
    "an unrelated column on the row must not be forwarded"
  );
});

test("the remote shape still says enough to be useful", () => {
  const remote = serializeGrantForRemote(GRANT);
  assert.equal(remote.displayName, "Downloads", "the user has to recognise which folder this is");
  assert.equal(remote.accessMode, "read_write");
  assert.equal(remote.hostId, "host_1");
  assert.equal(remote.id, "grant_1", "the opaque handle is what a command references");
});

test("the host shape does carry the paths, because the Mac needs them", () => {
  const host = serializeGrantForHost(GRANT);
  assert.equal(host.localPath, "/Users/liam/Downloads");
  assert.equal(host.resolvedRealPath, "/Users/liam/Downloads");
  assert.equal(host.displayName, "Downloads", "and everything the remote shape had");
});

test("dates leave as ISO strings on both shapes", () => {
  assert.equal(serializeGrantForRemote(GRANT).lastUsedAt, "2026-08-05T10:00:00.000Z");
  assert.equal(serializeGrantForHost(GRANT).lastUsedAt, "2026-08-05T10:00:00.000Z");
  assert.equal(serializeGrantForRemote(GRANT).revokedAt, null);
});

test("the client interface forbids the path fields at the type level", () => {
  // The runtime checks above pass just as well against a serialiser that
  // happens to omit the paths today. What stops the host shape being returned
  // from a handler declared to produce the remote one is `?: never` on the
  // interface — excess property checks fire only on fresh object literals, so
  // without it `HostWorkGrant` is structurally assignable to `ClientWorkGrant`
  // and the compiler would say nothing.
  const source = readFileSync(new URL("../src/lib/work/serializers.ts", import.meta.url), "utf8");
  const clientInterface = /export interface ClientWorkGrant \{[\s\S]*?\n\}/.exec(source)?.[0] ?? "";

  assert.ok(clientInterface, "ClientWorkGrant is no longer declared as an interface");
  assert.match(clientInterface, /localPath\?: never;/);
  assert.match(clientInterface, /resolvedRealPath\?: never;/);
});

test("the remote serialiser does not spread the row", () => {
  // Building by construction is the reason the new-column test above can pass.
  // A spread reintroduces the failure without changing any assertion that
  // exercises today's columns.
  const source = readFileSync(new URL("../src/lib/work/serializers.ts", import.meta.url), "utf8");
  const body =
    /export function serializeGrantForRemote\([\s\S]*?\n\}/.exec(source)?.[0] ?? "";

  assert.ok(body, "serializeGrantForRemote is no longer a function declaration");
  assert.doesNotMatch(
    body,
    /\.\.\.grant/,
    "spreading the row means the next column added to WorkFileGrant leaves for a phone"
  );
  assert.doesNotMatch(body, /delete /, "a delete list is a list somebody forgets to update");
});
