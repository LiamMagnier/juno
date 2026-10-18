import assert from "node:assert/strict";
import test, { mock } from "node:test";

/*
 * The /api/runs routes themselves: authentication first, the rate limit, input
 * validation, and that the signed-in account (never a body field) is who the
 * rules run for. The rules are tested in runs-remote-control.test.ts.
 *
 * `mock.module` needs --experimental-test-module-mocks; plain `npm test` runs
 * without it, so the suite skips there rather than failing.
 */
const canMockModules = typeof (mock as { module?: unknown }).module === "function";

if (!canMockModules) {
  test("runs routes suite needs --experimental-test-module-mocks", { skip: true }, () => {});
} else {
  let signedIn: { id: string } | null = null;
  let limited = false;
  const seen: Array<{ name: string; userId: string; actor: string; ref: unknown }> = [];

  mock.module("@/lib/code-remote", {
    namedExports: {
      requireUser: async () =>
        signedIn
          ? { user: signedIn, error: null }
          : { user: null, error: Response.json({ error: "Unauthorized" }, { status: 401 }) },
    },
  });
  mock.module("@/lib/code-session-command-route", {
    namedExports: {
      sessionCommandRateLimit: async () => (limited ? Response.json({ error: "rate_limited" }, { status: 429 }) : null),
    },
  });
  mock.module("@/lib/runs/remote-control-prisma", {
    namedExports: {
      remoteActorFor: async () => "ios",
      loadLiveRuns: async (userId: string) => [{ key: `work:${userId}-run` }],
      prismaRunControlDeps: () => ({
        findCodeSession: async () => null,
        findWorkRun: async (userId: string, runId: string) => {
          seen.push({ name: "findWorkRun", userId, actor: "", ref: runId });
          return userId === "owner" ? { id: runId, sessionId: "ws", status: "cancelled", hostId: null } : null;
        },
        findWorkApproval: async () => null,
      }),
    },
  });

  // Loaded lazily, after the mocks, and through functions: the test files are
  // compiled as CommonJS, where a top-level await is not available.
  const stop = async (req: Request) => (await import("../src/app/api/runs/stop/route")).POST(req);
  const approval = async (req: Request) => (await import("../src/app/api/runs/approval/route")).POST(req);
  const live = async (req: Request) => (await import("../src/app/api/runs/live/route")).GET(req);

  const post = (body: unknown) =>
    new Request("http://localhost/api/runs/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("every runs route refuses a caller who is not signed in", async () => {
    signedIn = null;
    assert.equal((await stop(post({ run: { kind: "work", runId: "r" } }))).status, 401);
    assert.equal((await approval(post({ run: { kind: "work", runId: "r" }, approvalId: "a", approve: true }))).status, 401);
    assert.equal((await live(new Request("http://localhost/api/runs/live", { headers: { accept: "application/json" } }))).status, 401);
  });

  test("the rate limit answers before any run is read", async () => {
    signedIn = { id: "owner" };
    limited = true;
    seen.length = 0;
    assert.equal((await stop(post({ run: { kind: "work", runId: "r" } }))).status, 429);
    assert.equal(seen.length, 0);
    limited = false;
  });

  test("a malformed body is a 400", async () => {
    signedIn = { id: "owner" };
    assert.equal((await stop(post({ run: { kind: "work" } }))).status, 400);
    assert.equal((await approval(post({ run: { kind: "code", deviceId: "d" }, approvalId: "a", approve: true }))).status, 400);
  });

  test("the rules run for the signed-in account, so a stranger's run is a 404", async () => {
    signedIn = { id: "stranger" };
    const refused = await stop(post({ run: { kind: "work", runId: "run-1" } }));
    assert.equal(refused.status, 404);
    signedIn = { id: "owner" };
    const owned = await stop(post({ run: { kind: "work", runId: "run-1" } }));
    assert.equal(owned.status, 200);
    assert.equal((await owned.json()).outcome, "already_stopped");
    assert.deepEqual(seen.map((s) => s.userId), ["stranger", "owner"]);
  });

  test("the live snapshot is the signed-in account's", async () => {
    signedIn = { id: "owner" };
    const response = await live(new Request("http://localhost/api/runs/live", { headers: { accept: "application/json" } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual((await response.json()).runs, [{ key: "work:owner-run" }]);
  });
}
