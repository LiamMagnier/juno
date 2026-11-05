/**
 * Who may have an agent computer (src/lib/computer/access.ts;
 * docs/design/agents-v2/COMPUTERS_2026-10.md §S1.1): the provider switch, the
 * rollout, the allowlist, the plan and its caps, the host, in that order.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, describe, it } from "node:test";

const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const access = req("../src/lib/computer/access") as typeof import("@/lib/computer/access");
const copy = req("../src/lib/computer/access-copy") as typeof import("@/lib/computer/access-copy");
const plans = req("../src/lib/plans") as typeof import("@/lib/plans");
const { fakeComputerProvider } = req("../src/lib/computer/fake") as typeof import("@/lib/computer/fake");
const { resetComputerProviderCache } = req("../src/lib/computer/provider") as typeof import("@/lib/computer/provider");
const store = req("../src/lib/computer/store") as typeof import("@/lib/computer/store");

type Plan = keyof typeof plans.PLANS;
const ALL_PLANS = Object.keys(plans.PLANS) as Plan[];
const user = (plan: Plan, extra: Partial<{ id: string; email: string | null; emailVerified: Date | null }> = {}) => ({
  id: extra.id ?? `user_${plan.toLowerCase()}`,
  email: extra.email ?? null,
  emailVerified: extra.emailVerified ?? null,
  plan,
});
const decide = (env: Record<string, string | undefined>, u: ReturnType<typeof user> | null, providerConfigured = true) =>
  access.decideComputerEntitlement({ providerConfigured, user: u, env: env as unknown as NodeJS.ProcessEnv });

const ENV_KEYS = ["AGENT_COMPUTER_PROVIDER", "COMPUTER_PROVIDER", "AGENT_COMPUTER_ROLLOUT", "AGENT_COMPUTER_ALLOWLIST"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  access.resetComputerAccessWarningsForTest();
  access.resetComputerAvailabilityCacheForTest();
  resetComputerProviderCache();
  fakeComputerProvider.reset();
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  store.setComputerStorePersistenceForTest(null);
  resetComputerProviderCache();
});

describe("the rollout and the allowlist", () => {
  it("rollout defaults to allowlist and an empty allowlist exposes nobody", () => {
    assert.equal(access.computerRollout({} as unknown as NodeJS.ProcessEnv), "allowlist");
    for (const plan of ALL_PLANS) {
      const verdict = decide({}, user(plan));
      assert.equal(verdict.ok, false, plan);
      if (!verdict.ok) {
        assert.equal(verdict.reason, "not_in_rollout", plan);
        assert.equal(verdict.message, "Computers are in early access and aren’t open to your account.");
      }
    }
  });

  it("setting the provider alone exposes nobody", async () => {
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    const memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    memDb.accessUsers.set("owner_1", { id: "owner_1", email: "owner@example.com", emailVerified: new Date(), plan: "OWNER" });
    const verdict = await access.computerAccessFor("owner_1");
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "not_in_rollout");
    // Not even the owner's plan, and nothing was created.
    await assert.rejects(() => store.enableComputer("owner_1", "agent_1"), /early access/);
    assert.equal(memDb.rows.size, 0);
  });

  it("allowlist matches ids exactly and emails case-insensitively", () => {
    const env = { AGENT_COMPUTER_ALLOWLIST: " user_abc , Mira@Example.COM " };
    const verified = new Date("2026-10-01T00:00:00Z");
    assert.equal(access.isAllowlisted({ id: "user_abc", email: null, emailVerified: null }, env as unknown as NodeJS.ProcessEnv), true);
    assert.equal(access.isAllowlisted({ id: "user_ABC", email: null, emailVerified: null }, env as unknown as NodeJS.ProcessEnv), false, "ids are exact");
    assert.equal(access.isAllowlisted({ id: "u2", email: "mira@example.com", emailVerified: verified }, env as unknown as NodeJS.ProcessEnv), true);
    assert.equal(access.isAllowlisted({ id: "u3", email: "MIRA@EXAMPLE.COM", emailVerified: verified }, env as unknown as NodeJS.ProcessEnv), true);
    assert.equal(access.isAllowlisted({ id: "u4", email: "other@example.com", emailVerified: verified }, env as unknown as NodeJS.ProcessEnv), false);
    assert.equal(decide(env, user("PRO", { id: "user_abc" })).ok, true);
  });

  it("an unverified account with a listed email is not_in_rollout", () => {
    const env = { AGENT_COMPUTER_ALLOWLIST: "mira@example.com" };
    const verdict = decide(env, user("MAX", { id: "squatter", email: "mira@example.com", emailVerified: null }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) assert.equal(verdict.reason, "not_in_rollout");
  });

  it("a listed user id matches whether or not the email is verified", () => {
    const env = { AGENT_COMPUTER_ALLOWLIST: "user_42" };
    assert.equal(decide(env, user("PRO", { id: "user_42", email: "x@example.com", emailVerified: null })).ok, true);
    assert.equal(decide(env, user("PRO", { id: "user_42", email: "x@example.com", emailVerified: new Date() })).ok, true);
  });

  it("plans rollout admits Pro and up", () => {
    for (const plan of ALL_PLANS) {
      const verdict = decide({ AGENT_COMPUTER_ROLLOUT: "plans" }, user(plan));
      assert.equal(verdict.ok, plans.PLANS[plan].agents, plan);
    }
  });

  it("Free and Lite are refused with the upgrade sentence under every rollout", () => {
    for (const plan of ["FREE", "LITE"] as const) {
      // Listed under the allowlist, and under plans.
      for (const env of [{ AGENT_COMPUTER_ALLOWLIST: `user_${plan.toLowerCase()}` }, { AGENT_COMPUTER_ROLLOUT: "plans" }]) {
        const verdict = decide(env, user(plan));
        assert.equal(verdict.ok, false);
        if (!verdict.ok) {
          assert.equal(verdict.reason, "plan");
          assert.equal(verdict.upgradePlan, "PRO");
          assert.equal(verdict.message, "Computers come with Pro and above.");
        }
      }
      // Off is off before the plan is asked.
      const off = decide({ AGENT_COMPUTER_ROLLOUT: "off" }, user(plan));
      assert.equal(!off.ok && off.reason, "rollout_off");
    }
    const err = access.computerAccessError({ ok: false, reason: "plan", message: "", upgradePlan: "PRO" }, "Mira");
    assert.equal(err.message, "Agent computers come with Pro and above. Upgrade to give Mira a computer.");
    assert.equal(err.code, "plan");
    assert.equal(err.upgradePlan, "PRO");
  });

  it("an invalid rollout value reads as off", () => {
    assert.equal(access.computerRollout({ AGENT_COMPUTER_ROLLOUT: "everyone" } as unknown as NodeJS.ProcessEnv), "off");
    const verdict = decide({ AGENT_COMPUTER_ROLLOUT: "on", AGENT_COMPUTER_ALLOWLIST: "user_owner" }, user("OWNER"));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.equal(verdict.reason, "rollout_off");
      assert.equal(verdict.message, "Computers are switched off on this server right now.");
    }
  });

  it("no provider is server_off before anything else", () => {
    const verdict = decide({ AGENT_COMPUTER_ROLLOUT: "plans" }, user("OWNER"), false);
    assert.equal(!verdict.ok && verdict.reason, "server_off");
    assert.equal(!verdict.ok && verdict.message, "Computers aren’t available on this server.");
  });
});

describe("caps per plan", () => {
  it("PLAN_AGENT_COMPUTER is non-null exactly where agents is true", () => {
    for (const plan of ALL_PLANS) {
      assert.equal(plans.PLAN_AGENT_COMPUTER[plan] !== null, plans.PLANS[plan].agents, plan);
    }
    assert.equal(plans.cheapestPlanWithAgentComputer(), "PRO");
    // PlanConfig itself is untouched: no plan surface advertises computers.
    for (const plan of ALL_PLANS) {
      assert.equal("agentComputer" in plans.PLANS[plan], false);
      assert.doesNotMatch(plans.PLANS[plan].features.join(" "), /computer/i);
    }
  });

  it("env overrides change caps for entitled plans only", () => {
    const env = { AGENT_COMPUTER_MAX_ENABLED_PRO: "4", AGENT_COMPUTER_WEEKLY_MINUTES_PRO: "45" } as unknown as NodeJS.ProcessEnv;
    assert.deepEqual(access.computerCapsFor("PRO", env), { maxEnabled: 4, weeklyMinutes: 45 });
    assert.deepEqual(access.computerCapsFor("PLUS", env), plans.PLAN_AGENT_COMPUTER.PLUS);
    // Not a whole number: the default stands.
    assert.deepEqual(access.computerCapsFor("PRO", { AGENT_COMPUTER_MAX_ENABLED_PRO: "1.5" } as unknown as NodeJS.ProcessEnv), plans.PLAN_AGENT_COMPUTER.PRO);
    assert.deepEqual(access.computerCapsFor("PRO", { AGENT_COMPUTER_MAX_ENABLED_PRO: "-1" } as unknown as NodeJS.ProcessEnv), plans.PLAN_AGENT_COMPUTER.PRO);
    // 0 means none, and none is the plan refusal.
    const zero = decide({ AGENT_COMPUTER_ROLLOUT: "plans", AGENT_COMPUTER_WEEKLY_MINUTES_PRO: "0" }, user("PRO"));
    assert.equal(!zero.ok && zero.reason, "plan");
  });

  it("the upgrade offered follows the owner's overrides, and is left out when no plan above has a computer", () => {
    // Pro's caps set to 0: a Pro account is never told to upgrade to Pro.
    const proOff = { AGENT_COMPUTER_ROLLOUT: "plans", AGENT_COMPUTER_MAX_ENABLED_PRO: "0" };
    const pro = decide(proOff, user("PRO"));
    assert.equal(pro.ok, false);
    if (!pro.ok) {
      assert.equal(pro.reason, "plan");
      assert.equal(pro.upgradePlan, "PLUS");
      assert.equal(pro.message, "Computers come with Plus and above.");
    }
    const free = decide(proOff, user("FREE"));
    assert.equal(!free.ok && free.upgradePlan, "PLUS", "the cheapest plan that has one after the overrides");

    // A dearer plan left out too: the sentence names only the plan it offers.
    const gap = { ...proOff, AGENT_COMPUTER_WEEKLY_MINUTES_MAX: "0" };
    const gapped = decide(gap, user("FREE"));
    assert.equal(!gapped.ok && gapped.message, "Computers come with Plus.");
    const max = decide(gap, user("MAX"));
    assert.equal(!max.ok && max.upgradePlan, "MAX20", "the first plan above the account's own");
    assert.equal(!max.ok && max.message, "Computers come with Max ×10 and above.");

    // Nothing above has one: the sentence says so, with no upgrade.
    const none = Object.fromEntries(ALL_PLANS.map((plan) => [`AGENT_COMPUTER_MAX_ENABLED_${plan}`, "0"]));
    for (const plan of ["FREE", "PRO", "OWNER"] as const) {
      const verdict = decide({ AGENT_COMPUTER_ROLLOUT: "plans", ...none }, user(plan));
      assert.equal(verdict.ok, false, plan);
      if (!verdict.ok) {
        assert.equal(verdict.reason, "plan");
        assert.equal(verdict.upgradePlan, null, plan);
        assert.equal(verdict.message, "Computers aren’t included in your plan.");
        // The API's sentence is the same, with no "Upgrade to".
        assert.equal(access.computerAccessError(verdict, "Mira").message, "Computers aren’t included in your plan.");
        assert.equal(access.computerAccessError(verdict, "Mira").upgradePlan, null);
      }
    }
  });

  it("an override for FREE or LITE is ignored", () => {
    const env = { AGENT_COMPUTER_MAX_ENABLED_FREE: "5", AGENT_COMPUTER_WEEKLY_MINUTES_LITE: "600", AGENT_COMPUTER_ROLLOUT: "plans" };
    assert.equal(access.computerCapsFor("FREE", env as unknown as NodeJS.ProcessEnv), null);
    assert.equal(access.computerCapsFor("LITE", env as unknown as NodeJS.ProcessEnv), null);
    assert.equal(decide(env, user("FREE")).ok, false);
    assert.equal(decide(env, user("LITE")).ok, false);
  });
});

describe("the host", () => {
  it("a configured provider that is not available gives unavailable, checked after the plan", async () => {
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    const memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    memDb.accessUsers.set("free_1", { id: "free_1", email: null, emailVerified: null, plan: "FREE" });
    memDb.accessUsers.set("pro_1", { id: "pro_1", email: null, emailVerified: null, plan: "PRO" });
    fakeComputerProvider.availableResult = { ok: false, reason: "image missing" };

    const before = fakeComputerProvider.calls.filter((c) => c.method === "available").length;
    const free = await access.computerAccessFor("free_1");
    assert.equal(!free.ok && free.reason, "plan", "a plan that cannot have one is told so, not that the host is down");
    assert.equal(fakeComputerProvider.calls.filter((c) => c.method === "available").length, before, "and never waits on the host");

    const pro = await access.computerAccessFor("pro_1");
    assert.equal(!pro.ok && pro.reason, "unavailable");
    assert.equal(!pro.ok && pro.message, copy.COMPUTER_ACCESS_COPY.unavailable);
    // The sweep's and the lease's form leaves the host out.
    assert.equal((await access.computerAccessFor("pro_1", { checkAvailable: false })).ok, true);

    fakeComputerProvider.availableResult = { ok: true };
    assert.equal((await access.computerAccessFor("pro_1")).ok, true);
  });

  it("an account that cannot be read is refused for now, never told it is not in its plan", async () => {
    process.env.AGENT_COMPUTER_PROVIDER = "fake";
    for (const rollout of ["plans", "allowlist"]) {
      process.env.AGENT_COMPUTER_ROLLOUT = rollout;
      process.env.AGENT_COMPUTER_ALLOWLIST = "pro_1";
      const memDb = store.createInMemoryComputerPersistence();
      store.setComputerStorePersistenceForTest(memDb);
      memDb.findAccessUser = async () => {
        throw new Error("connection terminated");
      };
      const originalError = console.error;
      console.error = () => {};
      try {
        for (const checkAvailable of [true, false]) {
          const verdict = await access.computerAccessFor("pro_1", { checkAvailable });
          assert.deepEqual(
            verdict,
            { ok: false, reason: "unavailable", message: copy.COMPUTER_ACCESS_COPY.accountUnchecked, upgradePlan: null },
            `${rollout}, checkAvailable ${checkAvailable}`,
          );
        }
      } finally {
        console.error = originalError;
      }
    }
    // An account the database does not have is still a verdict (FREE), not a blip.
    process.env.AGENT_COMPUTER_ROLLOUT = "plans";
    const memDb = store.createInMemoryComputerPersistence();
    store.setComputerStorePersistenceForTest(memDb);
    memDb.findAccessUser = async () => null;
    const ghost = await access.computerAccessFor("ghost_1");
    assert.equal(!ghost.ok && ghost.reason, "plan");
  });

  it("the public form carries the sentence and no caps", () => {
    const pub = access.publicComputerAccess({ ok: false, reason: "plan", message: "Computers come with Pro and above.", upgradePlan: "PRO" });
    assert.deepEqual(pub, { ok: false, reason: "plan", message: "Computers come with Pro and above.", upgradePlan: "PRO" });
    assert.deepEqual(access.publicComputerAccess({ ok: true, plan: "PRO", caps: { maxEnabled: 1, weeklyMinutes: 120 } }), {
      ok: true,
      reason: null,
      message: null,
      upgradePlan: null,
    });
  });
});
