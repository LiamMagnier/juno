/**
 * Every computer route checks access on the server (docs/design/agents-v2/COMPUTERS_2026-10.md
 * §S1.3): enable, wake, reset, view (direct and app link), control heartbeats
 * and the files route refuse an account that may not have a computer, each
 * with its status and sentence; sleep, delete and Hand back never do; and no
 * route answers with a raw error message.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
const stubs = new Map<string, unknown>();
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (stubs.has(request)) return stubs.get(request);
  return origLoad.call(this, request, parent, isMain);
};

let currentUser = "pro_1";
let device: string | null = null;
stubs.set("@/lib/code-remote", { requireUser: async () => ({ user: { id: currentUser }, error: null }) });
stubs.set("@/lib/agents/store", {
  findAgent: async (_userId: string, agentId: string) => ({ id: agentId, name: "Mira" }),
  recordAgentEvent: async () => undefined,
});
stubs.set("@/lib/session", { getCurrentDeviceSessionId: async () => device });
stubs.set("@/lib/rate-limit", { rateLimit: async () => ({ success: true, remaining: 100, resetAt: new Date() }) });

const req = createRequire(import.meta.url);
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const access = req("../src/lib/computer/access") as typeof import("@/lib/computer/access");
const errors = req("../src/lib/computer/errors") as typeof import("@/lib/computer/errors");

type Route = {
  GET?: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  POST?: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
};
const computerRoute = () => req("../src/app/api/agents/[id]/computer/route") as Route;
const viewRoute = () => req("../src/app/api/agents/[id]/computer/view/route") as Route;
const heartbeatRoute = () => req("../src/app/api/agents/[id]/computer/heartbeat/route") as Route;
const filesRoute = () => req("../src/app/api/agents/[id]/computer/files/route") as Route;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function post(route: Route, agentId: string, body: unknown) {
  const res = await route.POST!(
    new Request(`https://alevr.test/api/agents/${agentId}/computer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(agentId),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function get(route: Route, agentId: string, query = "") {
  const res = await route.GET!(new Request(`https://alevr.test/api/agents/${agentId}/computer${query}`), ctx(agentId));
  const type = res.headers.get("content-type") ?? "";
  return { status: res.status, body: type.includes("json") ? ((await res.json()) as Record<string, unknown>) : {} };
}

const PLAN_SENTENCE = "Agent computers come with Pro and above. Upgrade to give Mira a computer.";

describe("computer routes are gated on the server", () => {
  let memDb: ReturnType<typeof store.createInMemoryComputerPersistence>;
  const saved: Record<string, string | undefined> = {};
  const KEYS = ["AGENT_COMPUTER_PROVIDER", "AGENT_COMPUTER_ROLLOUT", "AGENT_COMPUTER_ALLOWLIST", "AUTH_SECRET"];
  const setPlan = (id: string, plan: "FREE" | "LITE" | "PRO" | "MAX") =>
    memDb.accessUsers.set(id, { id, email: null, emailVerified: null, plan });

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-32-bytes-minimum-length!!";
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    delete process.env.AGENT_COMPUTER_ALLOWLIST;
    resetComputerProviderCache();
    access.resetComputerAvailabilityCacheForTest();
    fakeComputerProvider.reset();
    memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    setPlan("pro_1", "PRO");
    setPlan("free_1", "FREE");
    currentUser = "pro_1";
    device = null;
  });
  afterEach(() => {
    store.setComputerStorePersistenceForTest(null);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetComputerProviderCache();
  });

  it("each route refuses a not-entitled account with its status and sentence", async () => {
    currentUser = "free_1";
    for (const action of ["enable", "wake", "reset"]) {
      const res = await post(computerRoute(), "agent_1", { action });
      assert.equal(res.status, 403, action);
      assert.deepEqual(res.body, { error: "plan", message: PLAN_SENTENCE, upgradePlan: "PRO" }, action);
    }
    for (const body of [{ mode: "watch" }, { mode: "control" }, { mode: "control", handoff: true }]) {
      const res = await post(viewRoute(), "agent_1", body);
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.equal(res.body.error, "plan");
      assert.equal("password" in res.body || "token" in res.body || "url" in res.body, false, "no credential, no link");
    }
    const files = await get(filesRoute(), "agent_1", "/files");
    assert.equal(files.status, 403);
    assert.equal(files.body.message, PLAN_SENTENCE);
    assert.equal(memDb.rows.size, 0, "nothing was created");
    assert.equal(fakeComputerProvider.calls.some((c) => c.method === "create" || c.method === "start"), false);

    // Not in the rollout: the early-access sentence, never the upgrade one.
    process.env.AGENT_COMPUTER_ROLLOUT = "allowlist";
    currentUser = "pro_1";
    const notListed = await post(computerRoute(), "agent_1", { action: "enable" });
    assert.equal(notListed.status, 403);
    assert.deepEqual(notListed.body, { error: "not_in_rollout", message: "Computers are in early access and aren’t open to your account." });
    process.env.AGENT_COMPUTER_ALLOWLIST = "pro_1";
    assert.equal((await post(computerRoute(), "agent_1", { action: "enable" })).status, 200, "listed, it works");

    // The plan's cap on computers: a 409 with the sentence.
    const second = await post(computerRoute(), "agent_2", { action: "enable" });
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, {
      error: "enabled_cap",
      message: "Your plan includes 1 agent computer, and all of them are in use. Delete one to give Mira a computer.",
    });

    // The host does not answer: 503.
    fakeComputerProvider.availableResult = { ok: false };
    const down = await post(computerRoute(), "agent_1", { action: "wake" });
    assert.equal(down.status, 503);
    assert.equal(down.body.error, "unavailable");
    fakeComputerProvider.availableResult = { ok: true };

    // The week is used: 409 on wake.
    const now = new Date();
    await memDb.recordUsageInterval({ userId: "pro_1", agentId: "x", startedAt: store.weekStartUtc(now), seconds: 7200, weekStart: store.weekStartUtc(now), runId: null });
    const spent = await post(computerRoute(), "agent_1", { action: "wake" });
    assert.equal(spent.status, 409);
    assert.equal(spent.body.error, "allowance_exhausted");
    assert.match(String(spent.body.message), /this week’s 2 hours\. They can start again on Monday at 00:00 UTC\.$/);

    // No computers on this server at all.
    process.env.AGENT_COMPUTER_PROVIDER = "";
    resetComputerProviderCache();
    const off = await post(computerRoute(), "agent_1", { action: "wake" });
    assert.equal(off.status, 403);
    assert.deepEqual(off.body, { error: "server_off", message: "Computers aren’t available on this server." });
  });

  it("reset on an agent with no computer, from an account at its cap, answers 409 enabled_cap and creates nothing", async () => {
    assert.equal((await post(computerRoute(), "agent_1", { action: "enable" })).status, 200, "Pro: its one computer");
    const mark = fakeComputerProvider.calls.length;
    const res = await post(computerRoute(), "agent_2", { action: "reset" });
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, {
      error: "enabled_cap",
      message: "Your plan includes 1 agent computer, and all of them are in use. Delete one to give Mira a computer.",
    });
    assert.equal(await memDb.findByAgent("pro_1", "agent_2"), null, "no row for the second agent");
    assert.equal(
      fakeComputerProvider.calls.slice(mark).some((c) => c.method === "create" || c.method === "destroy" || c.method === "start"),
      false,
      "no container was made, removed or started",
    );
    assert.ok(memDb.audits.some((a) => a.agentId === "agent_2" && a.kind === "refused" && a.detail.reason === "enabled_cap"));
    // Nor can it be woken: there is nothing to wake.
    assert.notEqual((await post(computerRoute(), "agent_2", { action: "wake" })).status, 200);
    assert.equal([...memDb.rows.values()].filter((r) => r.userId === "pro_1").length, 1, "still one computer");

    // Under the cap a reset still gives an agent its first computer, as it
    // did before, and the audit says one was enabled.
    assert.equal((await post(computerRoute(), "agent_1", { action: "disable" })).status, 200);
    assert.equal((await post(computerRoute(), "agent_2", { action: "reset" })).status, 200);
    assert.ok(await memDb.findByAgent("pro_1", "agent_2"));
    assert.ok(memDb.audits.some((a) => a.agentId === "agent_2" && a.kind === "enabled"));
  });

  it("a watch heartbeat from an account that lost access is refused and keeps nothing awake", async () => {
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    await store.openComputerViewSession("pro_1", "agent_1", "watch");
    assert.equal((await post(heartbeatRoute(), "agent_1", { mode: "watch" })).status, 200, "entitled: the beat is kept");
    const viewedAt = (await memDb.findByAgent("pro_1", "agent_1"))?.lastViewedAt?.getTime();
    setPlan("pro_1", "FREE");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const res = await post(heartbeatRoute(), "agent_1", { mode: "watch" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "plan");
    assert.equal(res.body.message, PLAN_SENTENCE);
    assert.equal((await memDb.findByAgent("pro_1", "agent_1"))?.lastViewedAt?.getTime(), viewedAt, "the view was not refreshed");
  });

  it("with no computers on the server, the files route answers server_off and writes nothing", async () => {
    process.env.AGENT_COMPUTER_PROVIDER = "";
    resetComputerProviderCache();
    for (const query of ["/files", "/files?download=1&path=%2Fhome%2Fagent%2Fwork%2Fa.txt"]) {
      const res = await get(filesRoute(), "agent_1", query);
      assert.equal(res.status, 403);
      assert.deepEqual(res.body, { error: "server_off", message: "Computers aren’t available on this server." });
    }
    assert.equal(memDb.audits.length, 0, "no audit row per request");
  });

  it("with no computers on the server, the view route answers server_off and nothing writes an audit row", async () => {
    process.env.AGENT_COMPUTER_PROVIDER = "";
    resetComputerProviderCache();
    for (const body of [{ mode: "watch" }, { mode: "control" }, { mode: "control", handoff: true }]) {
      const res = await post(viewRoute(), "agent_1", body);
      assert.equal(res.status, 403, JSON.stringify(body));
      assert.deepEqual(res.body, { error: "server_off", message: "Computers aren’t available on this server." });
    }
    // Nor does the store, whoever calls it (a chat tool, a run, the app link).
    await assert.rejects(() => store.openComputerViewSession("pro_1", "agent_1", "watch"), (err: unknown) => (err as { code?: string }).code === "server_off");
    await assert.rejects(() => store.enableComputer("pro_1", "agent_1"), (err: unknown) => (err as { code?: string }).code === "server_off");
    await assert.rejects(() => store.ensureAwake("pro_1", "agent_1", { autoEnable: true }), (err: unknown) => (err as { code?: string }).code === "server_off");
    assert.equal(memDb.audits.length, 0, "no audit row per request");
    assert.equal(memDb.rows.size, 0);
  });

  it("an account that cannot be read is refused for now and keeps its running computer and its take over", async () => {
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    assert.equal((await store.acquireComputerLease("pro_1", "agent_1", "run_1")).acquired, true);
    await store.openComputerViewSession("pro_1", "agent_1", "control");
    const readAccount = memDb.findAccessUser;
    memDb.findAccessUser = async () => {
      throw new Error("connection terminated");
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const unchecked = "Your account couldn’t be checked just now. Try again in a few minutes.";
      // A wake is refused, in words that are true: a 503, not "upgrade".
      const wake = await post(computerRoute(), "agent_1", { action: "wake" });
      assert.equal(wake.status, 503);
      assert.deepEqual(wake.body, { error: "unavailable", message: unchecked });
      const got = await get(computerRoute(), "agent_1");
      assert.deepEqual(got.body.access, { ok: false, reason: "unavailable", message: unchecked, upgradePlan: null });
      // The task's computer is not put to sleep for it, at renewal or at the sweep.
      assert.equal(await store.renewComputerLease("pro_1", "agent_1", "run_1"), true);
      assert.equal(await store.computerUsageBudgetRefusal("pro_1", "agent_1"), null);
      const row = await memDb.findByAgent("pro_1", "agent_1");
      assert.equal(row?.status, "awake");
      assert.equal(row?.lastError, null);
      assert.equal(row?.leaseRunId, "run_1");
      // A control beat is not renewed, but control is not taken away either.
      const until = row?.takeoverUntil?.getTime();
      const beat = await post(heartbeatRoute(), "agent_1", { mode: "control" });
      assert.equal(beat.status, 503);
      assert.equal(beat.body.message, unchecked);
      const after = await memDb.findByAgent("pro_1", "agent_1");
      assert.equal(after?.takeoverUntil?.getTime(), until, "not renewed");
      assert.equal(await store.computerBlockedReason("pro_1", "agent_1"), "The person has taken control of this computer. Nothing was done. Wait for them to hand it back, then carry on from where the screen is.");
      assert.equal(memDb.audits.some((a) => a.kind === "slept" || a.kind === "takeover_handed_back"), false);
    } finally {
      console.error = originalError;
      memDb.findAccessUser = readAccount;
    }
    // Readable again: the beat holds control as before.
    assert.equal((await post(heartbeatRoute(), "agent_1", { mode: "control" })).status, 200);
  });

  it("GET says computer, access and policy", async () => {
    currentUser = "free_1";
    const res = await get(computerRoute(), "agent_1");
    assert.equal(res.status, 200);
    // Today's shape for the apps: a payload while the server has computers
    // (null only when it has none), saying this agent has none.
    assert.equal((res.body.computer as { enabled: boolean }).enabled, false);
    assert.deepEqual(res.body.access, { ok: false, reason: "plan", message: "Computers come with Pro and above.", upgradePlan: "PRO" });
    assert.equal(res.body.policy, "ask");
    process.env.AGENT_COMPUTER_PROVIDER = "";
    resetComputerProviderCache();
    const off = await get(computerRoute(), "agent_1");
    assert.equal(off.body.computer, null, "no computers on this server: null, as the apps expect");
    assert.equal((off.body.access as { reason: string }).reason, "server_off");
  });

  it("hand back is never refused", async () => {
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    await store.openComputerViewSession("pro_1", "agent_1", "control");
    setPlan("pro_1", "FREE"); // the subscription lapsed while they held control
    const res = await post(heartbeatRoute(), "agent_1", { mode: "control", ended: true });
    assert.equal(res.status, 200);
    assert.equal(await store.computerBlockedReason("pro_1", "agent_1"), null, "the agent is no longer blocked");
  });

  it("disable and sleep are never refused", async () => {
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    setPlan("pro_1", "FREE");
    const slept = await post(computerRoute(), "agent_1", { action: "sleep" });
    assert.equal(slept.status, 200);
    assert.equal((await memDb.findByAgent("pro_1", "agent_1"))?.status, "asleep");
    // Lowering the policy is never refused either; raising it is.
    assert.equal((await post(computerRoute(), "agent_1", { action: "policy", policy: "off" })).status, 200);
    const raise = await post(computerRoute(), "agent_1", { action: "policy", policy: "allowed" });
    assert.equal(raise.status, 403);
    assert.equal(raise.body.error, "plan");
    const deleted = await post(computerRoute(), "agent_1", { action: "disable" });
    assert.equal(deleted.status, 200);
    assert.equal(memDb.rows.size, 0);
    assert.equal(deleted.body.policy, "off", "deleting it switches its tasks off it");
  });

  it("enable sets the policy to allowed; the policy action raises and lowers it", async () => {
    const enabled = await post(computerRoute(), "agent_1", { action: "enable" });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.policy, "allowed");
    assert.equal((await post(computerRoute(), "agent_1", { action: "policy", policy: "ask" })).body.policy, "ask");
    assert.ok(memDb.audits.some((a) => a.kind === "policy_changed" && a.detail.policyFrom === "allowed" && a.detail.policyTo === "ask"));
    const bad = await post(computerRoute(), "agent_1", { action: "policy", policy: "always" });
    assert.equal(bad.status, 400);
  });

  it("no route returns a raw error message", async () => {
    const secret = "Error response from daemon: container 3f9a2b1c0d4e is paused at 172.30.0.7 /var/lib/docker/volumes/juno-agent-x";
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    fakeComputerProvider.destroyError = new Error(secret);
    const reset = await post(computerRoute(), "agent_1", { action: "reset" });
    assert.equal(reset.status, 409);
    assert.equal(reset.body.message, errors.COMPUTER_NOT_RESPONDING);
    fakeComputerProvider.destroyError = undefined;

    // The files route, with a provider that fails in an unexpected way.
    const original = fakeComputerProvider.listFiles.bind(fakeComputerProvider);
    fakeComputerProvider.listFiles = async () => {
      throw new Error(secret);
    };
    try {
      const files = await get(filesRoute(), "agent_1", "/files");
      assert.equal(files.status, 400);
      assert.equal(files.body.message, errors.COMPUTER_NOT_RESPONDING);
    } finally {
      fakeComputerProvider.listFiles = original;
    }
    // A computer's own sentence still reaches the person.
    const refused = await get(filesRoute(), "agent_1", "/files?path=%2Fetc");
    assert.equal(refused.status, 400);
    assert.equal(refused.body.message, errors.COMPUTER_PATH_REFUSED);
    for (const body of [reset.body, refused.body]) assert.doesNotMatch(JSON.stringify(body), /3f9a|172\.30|daemon|docker/);
  });

  it("a control heartbeat from an account that lost access closes the takeover through the release path and answers 403", async () => {
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    await store.openComputerViewSession("pro_1", "agent_1", "control");
    const handle = { name: "juno-agent-agent_1", volume: "juno-agent-agent_1" };
    assert.equal(fakeComputerProvider.isFrozen(handle), true);
    // Still entitled: the beat holds control.
    assert.equal((await post(heartbeatRoute(), "agent_1", { mode: "control" })).status, 200);
    setPlan("pro_1", "LITE");
    const mark = fakeComputerProvider.calls.length;
    const res = await post(heartbeatRoute(), "agent_1", { mode: "control" });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "plan");
    assert.equal(res.body.message, PLAN_SENTENCE);
    assert.equal(await store.computerBlockedReason("pro_1", "agent_1"), null, "the take over is closed");
    const methods = fakeComputerProvider.calls.slice(mark).map((c) => c.method).filter((m) => m === "startVnc" || m === "thawAgent");
    assert.deepEqual(methods, ["startVnc", "thawAgent"], "the person's session ended before the agent was thawed");
    assert.ok(memDb.audits.some((a) => a.kind === "takeover_handed_back" && a.detail.via === "access_lost"));
  });

  it("the files route never wakes an asleep computer and refuses an account without access", async () => {
    await store.ensureAwake("pro_1", "agent_1", { autoEnable: true });
    await store.sleepComputer("pro_1", "agent_1");
    const mark = fakeComputerProvider.calls.length;
    const asleep = await get(filesRoute(), "agent_1", "/files");
    assert.equal(asleep.status, 409);
    assert.equal(asleep.body.message, "Wake the computer first to browse its files.");
    assert.equal(fakeComputerProvider.calls.slice(mark).some((c) => c.method === "start" || c.method === "unpause"), false);
    currentUser = "free_1";
    const refused = await get(filesRoute(), "agent_1", "/files?download=1&path=%2Fhome%2Fagent%2Fwork%2Fa.txt");
    assert.equal(refused.status, 403);
  });
});
