import assert from "node:assert/strict";
import test, { mock } from "node:test";

/*
 * The device link route (POST /api/code/v2/link/[deviceId]) with remote
 * control: owning the Mac is not enough, a remote command needs a live pair
 * for THIS phone (its native sign-in) or THIS browser (its cookie), and a pair
 * revoked while a long-poll waits stops that poll from delivering.
 */

let currentUser: { id: string } | null = { id: "owner" };
let deviceSessionId: string | null = "phone-session";
let pairRevokedAfterPoll = false;
const pairs: Array<{ id: string; userId: string; codeDeviceId: string; deviceSessionId: string | null; browserKeyHash: string | null; revokedAt: Date | null; lastUsedAt: Date }> = [];
const hubCalls: string[] = [];

const matches = (where: Record<string, unknown>, row: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (v === null ? row[k] === null : typeof v === "object" ? true : row[k] === v));

const prisma = {
  codeDevice: {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      where.userId === "owner" && where.id === "mac1" ? { id: "mac1", name: "Studio Mac" } : null,
  },
  nativeDeviceSession: {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      where.userId === "owner" && (where.id === "phone-session" || where.id === "other-phone") ? { name: "iPhone", platform: "ios" } : null,
  },
  devicePair: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      assert.equal(where.userId, "owner", "every pair lookup is scoped to the signed-in account");
      return pairs.find((p) => matches(where, p)) ?? null;
    },
    updateMany: async () => ({ count: 1 }),
  },
};

const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;
if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma, prismaUnguarded: prisma } });
  mock.module("@/lib/session", {
    namedExports: {
      getCurrentUser: async () => currentUser,
      getCurrentDeviceSessionId: async () => deviceSessionId,
    },
  });
  mock.module("@/lib/code-v2/env-link-select", {
    namedExports: {
      linkHub: () => ({
        link: () => ({
          rpc: async (command: { id: string }) => {
            hubCalls.push(`rpc:${command.id}`);
            return { responses: [{ type: "response", id: command.id, ok: true, result: {} }] };
          },
          poll: async () => {
            hubCalls.push("poll");
            if (pairRevokedAfterPoll) for (const p of pairs) p.revokedAt = new Date();
            return { events: [{ type: "event", stream: "global", sequence: 1, at: "2026-10-10T00:00:00Z", event: { type: "terminal.output", terminalId: "t", data: "secret" } }] };
          },
        }),
      }),
    },
  });
}

const rpc = (headers: Record<string, string> = { authorization: "Bearer native" }) =>
  new Request("https://alevr.example/api/code/v2/link/mac1", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ kind: "rpc", command: { id: "c1", type: "session.list", params: {} } }),
  });
const params = { params: Promise.resolve({ deviceId: "mac1" }) };

routeTest("a signed-in phone without a pair is refused before anything reaches the Mac", async () => {
  pairs.length = 0;
  hubCalls.length = 0;
  const { POST } = await import("@/app/api/code/v2/link/[deviceId]/route");
  const response = await POST(rpc(), params);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "not_paired");
  assert.match(body.message, /Control this Mac remotely/);
  assert.deepEqual(hubCalls, []);
});

routeTest("the paired phone gets through; another phone on the same account does not", async () => {
  pairs.length = 0;
  hubCalls.length = 0;
  pairs.push({ id: "p1", userId: "owner", codeDeviceId: "mac1", deviceSessionId: "phone-session", browserKeyHash: null, revokedAt: null, lastUsedAt: new Date() });
  const { POST } = await import("@/app/api/code/v2/link/[deviceId]/route");
  deviceSessionId = "phone-session";
  assert.equal((await POST(rpc(), params)).status, 200);
  deviceSessionId = "other-phone";
  assert.equal((await POST(rpc(), params)).status, 403);
  assert.deepEqual(hubCalls, ["rpc:c1"]);
  deviceSessionId = "phone-session";
});

routeTest("a browser needs its own pairing cookie", async () => {
  pairs.length = 0;
  hubCalls.length = 0;
  const { sha256 } = await import("@/lib/code-v2/device-pairing");
  const key = "k".repeat(43);
  pairs.push({ id: "p2", userId: "owner", codeDeviceId: "mac1", deviceSessionId: null, browserKeyHash: sha256(key), revokedAt: null, lastUsedAt: new Date() });
  const { POST } = await import("@/app/api/code/v2/link/[deviceId]/route");
  assert.equal((await POST(rpc({}), params)).status, 403, "no cookie");
  assert.equal((await POST(rpc({ cookie: `alevr_remote=${"z".repeat(43)}` }), params)).status, 403, "someone else's cookie");
  assert.equal((await POST(rpc({ cookie: `alevr_remote=${key}` }), params)).status, 200);
});

routeTest("a pair revoked while a poll waits: the poll's events are not delivered", async () => {
  pairs.length = 0;
  hubCalls.length = 0;
  pairs.push({ id: "p3", userId: "owner", codeDeviceId: "mac1", deviceSessionId: "phone-session", browserKeyHash: null, revokedAt: null, lastUsedAt: new Date() });
  pairRevokedAfterPoll = true;
  const { POST } = await import("@/app/api/code/v2/link/[deviceId]/route");
  const poll = new Request("https://alevr.example/api/code/v2/link/mac1", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer native" },
    body: JSON.stringify({ kind: "poll", cursors: {}, globalCursor: -1 }),
  });
  const response = await POST(poll, params);
  pairRevokedAfterPoll = false;
  assert.equal(response.status, 403);
  assert.doesNotMatch(await response.text(), /secret/);
});

routeTest("signed out: 401, and another account's Mac is a 404", async () => {
  const { POST } = await import("@/app/api/code/v2/link/[deviceId]/route");
  currentUser = null;
  assert.equal((await POST(rpc(), params)).status, 401);
  currentUser = { id: "owner" };
  assert.equal((await POST(rpc(), { params: Promise.resolve({ deviceId: "macX" }) })).status, 404);
});
