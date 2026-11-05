import assert from "node:assert/strict";
import test, { mock } from "node:test";

/*
 * The agent-control route (POST /api/code/v2/link/[deviceId]/agents) wired to
 * its real dependencies' shapes: the session, the Mac's owner, the
 * remote-control pair, the rate limiter, the compliance log as the replay
 * store, and the hub's agent-control door. The decisions themselves are
 * unit-tested in code-v2-agent-control.test.ts; this proves the route feeds
 * them the right facts. Needs --experimental-test-module-mocks (skipped
 * otherwise, like remote-control-routes.test.ts).
 */

let currentUser: { id: string } | null = { id: "owner" };
const deviceSessionId: string | null = "phone-session";
const pairs = [{ id: "p1", userId: "owner", codeDeviceId: "mac1", deviceSessionId: "phone-session", browserKeyHash: null as string | null, revokedAt: null as Date | null, lastUsedAt: new Date() }];
const hubCalls: { type: string; options: unknown; params: unknown }[] = [];
const auditRows: { userId: string; kind: string; actor?: string; severity?: string; detail: Record<string, unknown>; createdAt: Date }[] = [];

const matches = (where: Record<string, unknown>, row: Record<string, unknown>) =>
  Object.entries(where).every(([k, v]) => (v === null ? row[k] === null : typeof v === "object" ? true : row[k] === v));

const prisma = {
  codeDevice: {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      where.userId === "owner" && where.id === "mac1" ? { id: "mac1", name: "Studio Mac" } : null,
  },
  nativeDeviceSession: {
    findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
      where.userId === "owner" && where.id === "phone-session" ? { name: "iPhone", platform: "ios" } : null,
  },
  devicePair: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => pairs.find((p) => matches(where, p)) ?? null,
    updateMany: async () => ({ count: 1 }),
  },
  workAuditEvent: {
    findMany: async ({ where }: { where: { userId: string; kind: string; detail: { path: string[]; equals: string } } }) =>
      auditRows
        .filter((r) => r.userId === where.userId && r.kind === where.kind && r.detail[where.detail.path[0]!] === where.detail.equals)
        .reverse()
        .map((r) => ({ detail: r.detail })),
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
  mock.module("@/lib/rate-limit", { namedExports: { rateLimit: async () => ({ success: true, remaining: 10, resetAt: new Date() }) } });
  mock.module("@/lib/work/audit", {
    namedExports: {
      recordWorkAudit: async (input: { userId: string; kind: string; actor?: string; severity?: string; detail: Record<string, unknown> }) => {
        auditRows.push({ ...input, createdAt: new Date() });
      },
    },
  });
  mock.module("@/lib/code-v2/env-link-select", {
    namedExports: {
      linkHub: () => ({
        link: (userId: string, deviceId: string) => ({
          rpc: async (command: { id: string; type: string; params: unknown }, options: unknown) => {
            assert.equal(userId, "owner");
            assert.equal(deviceId, "mac1");
            hubCalls.push({ type: command.type, options, params: command.params });
            return { responses: [{ type: "response", id: command.id, ok: true, result: { accepted: true, message: "Agent w1 resumed." } }] };
          },
        }),
      }),
    },
  });
}

const post = (body: unknown, deviceId = "mac1") =>
  new Request(`https://alevr.example/api/code/v2/link/${deviceId}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer native" },
    body: JSON.stringify(body),
  });
const params = (deviceId = "mac1") => ({ params: Promise.resolve({ deviceId }) });

routeTest("signed out is a 401 and another account's Mac a 404; nothing reaches the hub", async () => {
  const { POST } = await import("@/app/api/code/v2/link/[deviceId]/agents/route");
  hubCalls.length = 0;
  currentUser = null;
  assert.equal((await POST(post({ sessionId: "s1", agentId: "w1", action: "resume", idempotencyKey: "route-key-1" }), params())).status, 401);
  currentUser = { id: "owner" };
  assert.equal((await POST(post({ sessionId: "s1", agentId: "w1", action: "resume", idempotencyKey: "route-key-1" }, "macX"), params("macX"))).status, 404);
  assert.deepEqual(hubCalls, []);
});

routeTest("the paired owner's control reaches the hub through the agent-control door, once per key, with an audit row", async () => {
  const { POST } = await import("@/app/api/code/v2/link/[deviceId]/agents/route");
  hubCalls.length = 0;
  auditRows.length = 0;
  const body = { sessionId: "s1", agentId: "w1", action: "resume", idempotencyKey: "route-key-2" };
  const first = await POST(post(body), params());
  assert.equal(first.status, 200);
  assert.equal((await first.json()).accepted, true);
  const second = await POST(post(body), params());
  assert.equal((await second.json()).replayed, true);
  assert.equal(hubCalls.length, 1);
  assert.equal(hubCalls[0]!.type, "agent.resume");
  assert.deepEqual(hubCalls[0]!.options, { agentControl: true });
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0]!.kind, "agent_control");
  assert.equal(auditRows[0]!.actor, "ios", "a native bearer is the phone");
  assert.equal(auditRows[0]!.detail.outcome, "accepted");
});

routeTest("an unpaired phone is refused before the hub", async () => {
  const { POST } = await import("@/app/api/code/v2/link/[deviceId]/agents/route");
  hubCalls.length = 0;
  const saved = pairs.splice(0);
  const res = await POST(post({ sessionId: "s1", agentId: "w1", action: "pause", idempotencyKey: "route-key-3" }), params());
  pairs.push(...saved);
  assert.equal(res.status, 403);
  assert.deepEqual(hubCalls, []);
});
