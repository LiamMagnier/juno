import assert from "node:assert/strict";
import test, { mock } from "node:test";

let currentUser: { id: string } | null = { id: "owner" };
const calls: Array<{ operation: string; args: unknown }> = [];
let updated = 1;
const prisma = { actionApprovalGrant: {
  findMany: async (args: unknown) => { calls.push({ operation: "list", args }); return []; },
  updateMany: async (args: unknown) => { calls.push({ operation: "revoke", args }); return { count: updated }; },
} };
const canMockModules = typeof (mock as { module?: unknown }).module === "function";
const routeTest = canMockModules ? test : test.skip;
if (canMockModules) {
  mock.module("@/lib/prisma", { namedExports: { prisma } });
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => currentUser } });
}
routeTest("standing approvals list is account-owned and excludes revoked grants", async () => {
  currentUser = { id: "owner" }; calls.length = 0;
  const { GET } = await import("@/app/api/approvals/grants/route");
  const response = await GET();
  assert.equal(response.status, 200);
  const args = calls[0].args as { where: unknown; select: Record<string, unknown> };
  assert.deepEqual(args.where, { userId: "owner", revokedAt: null });
  assert.equal(args.select.sourceReceiptId, undefined);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});
routeTest("an unauthenticated list does not query grants", async () => {
  currentUser = null; calls.length = 0;
  const { GET } = await import("@/app/api/approvals/grants/route");
  assert.equal((await GET()).status, 401);
  assert.equal(calls.length, 0);
});
routeTest("revocation scopes the update to the signed-in owner", async () => {
  currentUser = { id: "owner" }; calls.length = 0; updated = 1;
  const { DELETE } = await import("@/app/api/approvals/grants/[id]/route");
  const response = await DELETE(new Request("http://test/api/approvals/grants/g1", { method: "DELETE" }), { params: Promise.resolve({ id: "g1" }) });
  assert.equal(response.status, 200);
  const args = calls[0].args as { where: unknown; data: { revokedAt: Date } };
  assert.deepEqual(args.where, { id: "g1", userId: "owner", revokedAt: null });
  assert.ok(args.data.revokedAt instanceof Date);
});
routeTest("foreign, missing and already revoked ids do not report a successful revoke", async () => {
  currentUser = { id: "owner" }; updated = 0;
  const { DELETE } = await import("@/app/api/approvals/grants/[id]/route");
  const response = await DELETE(new Request("http://test/api/approvals/grants/foreign", { method: "DELETE" }), { params: Promise.resolve({ id: "foreign" }) });
  assert.equal(response.status, 404);
});
