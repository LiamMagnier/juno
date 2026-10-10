import assert from "node:assert/strict";
import test, { mock } from "node:test";

/*
 * GET /api/devices/mac-app: signed in only, and every query scoped to the
 * signed-in account, with the 30-day window and the platform filters.
 */

let currentUser: { id: string } | null = { id: "owner" };
const calls: Array<{ model: string; args: { where: Record<string, unknown> } }> = [];
let rows: Record<string, unknown> = {};
const model = (name: string) => ({
  findFirst: async (args: { where: Record<string, unknown> }) => {
    calls.push({ model: name, args });
    return rows[name] ?? null;
  },
});
const prisma = {
  nativeDeviceSession: model("nativeDeviceSession"),
  codeDevice: model("codeDevice"),
  devicePushToken: model("devicePushToken"),
};
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;
if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma, prismaUnguarded: prisma } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => currentUser } });
}

routeTest("signed out: 401 and no query at all", async () => {
  currentUser = null;
  calls.length = 0;
  const { GET } = await import("@/app/api/devices/mac-app/route");
  const response = await GET();
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

routeTest("every signal is read for the signed-in account only, within 30 days", async () => {
  currentUser = { id: "owner" };
  calls.length = 0;
  rows = {};
  const { GET } = await import("@/app/api/devices/mac-app/route");
  const response = await GET();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), { installed: false, lastSeenAt: null });
  assert.deepEqual(calls.map((c) => c.model).sort(), ["codeDevice", "devicePushToken", "nativeDeviceSession"]);
  const day = 24 * 60 * 60 * 1000;
  for (const call of calls) {
    assert.equal(call.args.where.userId, "owner", call.model);
    const window = (call.args.where.lastSeenAt ?? call.args.where.updatedAt) as { gte: Date };
    const age = Date.now() - window.gte.getTime();
    assert.ok(age > 29 * day && age < 31 * day, `${call.model} window`);
  }
  const session = calls.find((c) => c.model === "nativeDeviceSession")!;
  assert.equal(session.args.where.revokedAt, null);
  const push = calls.find((c) => c.model === "devicePushToken")!;
  assert.equal(push.args.where.active, true);
  assert.equal(push.args.where.platform, "macos");
});

routeTest("a Mac seen through any signal reports installed, with the latest time", async () => {
  currentUser = { id: "owner" };
  calls.length = 0;
  const seen = new Date(Date.now() - 2 * 60 * 60 * 1000);
  rows = { codeDevice: { lastSeenAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) }, nativeDeviceSession: { lastSeenAt: seen } };
  const { GET } = await import("@/app/api/devices/mac-app/route");
  const body = await (await GET()).json();
  assert.deepEqual(body, { installed: true, lastSeenAt: seen.toISOString() });
});
