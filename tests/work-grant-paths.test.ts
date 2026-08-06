import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  serializeGrantForRemote,
  serializeGrantForHost,
  serializeCommand,
  serializeCommandForRemote,
  serializeCommandForHost,
} from "@/lib/work/serializers";

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

// ---------------------------------------------------------------------------
// The other way a path escapes: the host's answer to a command.
// ---------------------------------------------------------------------------

const GRANT_COMMAND = {
  id: "cmd_1",
  userId: "user_1",
  hostId: "host_1",
  sessionId: "sess_1",
  runId: null,
  kind: "grant_folder",
  // What the phone sent.
  payload: { displayName: "Downloads", accessMode: "read_write" },
  payloadVersion: 1,
  status: "succeeded",
  // What the Mac answered after the user picked a folder in a file dialog.
  result: {
    grantId: "grant_1",
    displayName: "Downloads",
    accessMode: "read_write",
    localPath: "/Users/liam/Downloads",
    resolvedRealPath: "/Users/liam/Downloads",
  },
  error: null,
  idempotencyKey: "idem_1",
  expiresAt: new Date("2026-08-05T12:05:00.000Z"),
  leaseExpiresAt: null,
  attempts: 1,
  createdAt: new Date("2026-08-05T12:00:00.000Z"),
  claimedAt: new Date("2026-08-05T12:00:01.000Z"),
  completedAt: new Date("2026-08-05T12:00:09.000Z"),
} as unknown as Parameters<typeof serializeCommandForHost>[0];

test("a host's answer to grant_folder does not carry its path back to a phone", () => {
  const remote = serializeCommandForRemote(GRANT_COMMAND);
  const serialised = JSON.stringify(remote);

  assert.doesNotMatch(
    serialised,
    /\/Users\//,
    `the Mac's resolved path travelled back through a command result: ${serialised}`
  );
  assert.deepEqual(remote.result, {
    grantId: "grant_1",
    displayName: "Downloads",
    accessMode: "read_write",
  });
  assert.deepEqual(
    remote.redacted,
    ["localPath", "resolvedRealPath"],
    "withholding is stated, so a surface can say the Mac returned more than this"
  );
});

test("the host shape keeps the answer intact, because the Mac needs it", () => {
  const host = serializeCommandForHost(GRANT_COMMAND);
  assert.equal(
    (host.result as Record<string, unknown>).localPath,
    "/Users/liam/Downloads"
  );
});

/**
 * The claim endpoint answers the Mac with the REMOTE shape, like every route
 * under /api/work — a CI gate forbids a route from reaching for the host shape,
 * because that one passes a `grant_folder` result's resolved path straight
 * through. So the remote allowlist is the only thing standing between a start
 * command and a Mac that can act on it, and when `start` was
 * `["runId", "target"]` every start arrived with its goal stripped and
 * `DesktopWorkRunHost` refused it with `noGoal`.
 *
 * A build that silently narrows this again produces a Mac that claims work and
 * then refuses all of it, which looks like a broken Mac rather than a broken
 * serialiser. Hence a test on the serialised shape rather than on the payload
 * builder, which was already covered and was never what was wrong.
 */
for (const kind of ["start", "resume"] as const) {
  test(`a ${kind} command reaches the Mac with the goal it is supposed to act on`, () => {
    const command = {
      ...(GRANT_COMMAND as unknown as Record<string, unknown>),
      kind,
      payload: {
        runId: "run_1",
        target: "local",
        goal: "Sort every PDF in Downloads by year.",
        model: "anthropic:claude-sonnet-5",
      },
      result: null,
    } as unknown as Parameters<typeof serializeCommandForRemote>[0];

    const remote = serializeCommandForRemote(command);
    const payload = remote.payload as Record<string, unknown>;
    assert.equal(payload.goal, "Sort every PDF in Downloads by year.");
    assert.equal(payload.model, "anthropic:claude-sonnet-5");
  });
}

test("widening start did not open the door the grant path is kept out of", () => {
  const command = {
    ...(GRANT_COMMAND as unknown as Record<string, unknown>),
    kind: "start",
    payload: {
      runId: "run_1",
      target: "local",
      goal: "Tidy Downloads.",
      // A field nobody put on the allowlist, carrying the shape the grant
      // redaction exists for. Widening is per-key on purpose.
      resolvedRealPath: "/Users/liam/Downloads",
    },
    result: null,
  } as unknown as Parameters<typeof serializeCommandForRemote>[0];

  const serialised = JSON.stringify(serializeCommandForRemote(command));
  assert.doesNotMatch(serialised, /\/Users\//, serialised);
});

test("a command kind nobody has classified says nothing rather than everything", () => {
  const unclassified = {
    ...(GRANT_COMMAND as unknown as Record<string, unknown>),
    kind: "ping",
    payload: { secret: "/Users/liam/Documents", hostState: "online" },
    result: { hostState: "online", uptimePath: "/Users/liam" },
  } as unknown as Parameters<typeof serializeCommandForRemote>[0];

  const remote = serializeCommandForRemote(unclassified);
  assert.deepEqual(remote.payload, {}, "ping declares no readable payload keys");
  assert.deepEqual(remote.result, { hostState: "online" });
  assert.ok(remote.redacted.includes("uptimePath"));
});

test("the unqualified serializeCommand is the filtered one", () => {
  const viaDefault = serializeCommand(GRANT_COMMAND);
  assert.doesNotMatch(
    JSON.stringify(viaDefault),
    /\/Users\//,
    "code that did not think about which side of the boundary it is on must get the safe shape"
  );
});
