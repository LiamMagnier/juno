import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Module, { createRequire } from "node:module";
import { resolveModel } from "@/lib/models";
import {
  byokAuthHeaders,
  byokBaseUrl,
  byokSealContext,
  checkKeyShape,
  keyHint,
  keyTestRequest,
  testProviderKey,
  toProviderKeyView,
} from "@/lib/code-v2/byok";
import {
  byokUsageFromMeter,
  checkRequestedTier,
  chooseKeySource,
  parseBillingPreference,
  parseContextTierHeader,
  tierScaledRates,
} from "@/lib/code-v2/agent-routing";
import { catalogModel } from "@/lib/code-v2/code-models";
import { legacyModelFor, routingAvoidsAlevrBilling, validateRoleRouting } from "@/lib/code-v2/role-routing";
import { byokInstanceId, instanceKindOf, type ByokProvider } from "@/lib/code-v2/contracts";
import { PROVIDERS } from "@/lib/providers";

// crypto.ts is server-only; load it the way tests/secrets-crypto.test.ts does.
const mod = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const origLoad = mod._load;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return origLoad.call(this, request, parent, isMain);
};
process.env.AUTH_SECRET ??= "byok-test-secret-32-bytes-minimum-length!!";
const { decryptSecretBound, encryptSecretBound } = createRequire(import.meta.url)("../src/lib/crypto.ts") as typeof import("@/lib/crypto");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-WXYZ";

// ── BYOK crypto ──────────────────────────────────────────────────────────────

test("a sealed key round-trips under its own user and lab only", () => {
  const sealed = encryptSecretBound(KEY, byokSealContext("user_a", "anthropic"));
  assert.ok(!sealed.includes(KEY));
  assert.equal(decryptSecretBound(sealed, byokSealContext("user_a", "anthropic")), KEY);
  assert.throws(() => decryptSecretBound(sealed, byokSealContext("user_b", "anthropic")));
  assert.throws(() => decryptSecretBound(sealed, byokSealContext("user_a", "openai")));
});

test("key shape: trims, refuses what cannot be a key, hints the last four", () => {
  assert.deepEqual(checkKeyShape(`  ${KEY}\n`), { ok: true, key: KEY });
  assert.equal(checkKeyShape("short").ok, false);
  assert.equal(checkKeyShape("sk-abc def ghi jkl mno pqr stu").ok, false);
  assert.equal(checkKeyShape(42).ok, false);
  assert.equal(checkKeyShape("sk-ünïcödé-key-that-is-long-enough").ok, false);
  assert.equal(keyHint(KEY), "WXYZ");
});

test("a list view never carries the key", () => {
  const view = toProviderKeyView({
    provider: "openai",
    keyHint: "WXYZ",
    status: "active",
    statusDetail: null,
    lastTestedAt: null,
    lastUsedAt: null,
    createdAt: new Date("2026-10-08T00:00:00Z"),
  });
  assert.ok(view);
  assert.ok(!JSON.stringify(view).includes("sk-"));
  assert.equal(toProviderKeyView({ provider: "seedance", keyHint: "x", status: "active", statusDetail: null, lastTestedAt: null, lastUsedAt: null, createdAt: new Date() }), null);
});

test("a user's key only ever goes to the lab's public endpoint", () => {
  const before = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = "https://corp-proxy.example.com/v1";
  try {
    assert.equal(byokBaseUrl("openai"), "https://api.openai.com/v1");
  } finally {
    if (before === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = before;
  }
  assert.equal(byokBaseUrl("anthropic"), "https://api.anthropic.com");
  assert.equal(byokBaseUrl("google"), PROVIDERS.google.defaultBaseUrl!.replace(/\/+$/, ""));
  assert.deepEqual(byokAuthHeaders("anthropic", "k"), { "x-api-key": "k", "anthropic-version": "2023-06-01" });
  assert.deepEqual(byokAuthHeaders("xai", "k"), { authorization: "Bearer k" });
  assert.equal(keyTestRequest("anthropic", "k").url, "https://api.anthropic.com/v1/models?limit=1");
  assert.equal(keyTestRequest("deepseek", "k").url, "https://api.deepseek.com/models");
});

test("key test: 2xx valid, 401 invalid without echoing the key, outages unreachable", async () => {
  const respond = (status: number, body = "") => (async () => new Response(body, { status })) as unknown as typeof fetch;
  assert.deepEqual(await testProviderKey("openai", KEY, respond(200, "{}")), { status: "valid" });
  const bad = await testProviderKey(
    "openai",
    KEY,
    respond(401, JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}` } })),
  );
  assert.equal(bad.status, "invalid");
  assert.ok(bad.status === "invalid" && !bad.detail.includes("abcdefghijklmnop"));
  assert.equal((await testProviderKey("openai", KEY, respond(429))).status, "unreachable");
  const thrown = (async () => {
    throw new Error("network");
  }) as unknown as typeof fetch;
  assert.equal((await testProviderKey("openai", KEY, thrown)).status, "unreachable");
});

// ── /api/agent decisions ─────────────────────────────────────────────────────

test("billing preference header", () => {
  assert.equal(parseBillingPreference(null), "auto");
  assert.equal(parseBillingPreference(" BYOK "), "byok");
  assert.equal(parseBillingPreference("free"), null);
});

test("key source: own key when stored, Alevr otherwise, never a silent fallback when byok is demanded", () => {
  assert.deepEqual(chooseKeySource({ preference: "auto", provider: "anthropic", hasUserKey: true }), {
    ok: true,
    source: "byok",
    provider: "anthropic",
  });
  assert.deepEqual(chooseKeySource({ preference: "auto", provider: "anthropic", hasUserKey: false }), { ok: true, source: "alevr" });
  assert.deepEqual(chooseKeySource({ preference: "alevr", provider: "anthropic", hasUserKey: true }), { ok: true, source: "alevr" });
  const missing = chooseKeySource({ preference: "byok", provider: "openai", hasUserKey: false });
  assert.equal(missing.ok, false);
  assert.ok(!missing.ok && missing.status === 409 && missing.body.code === "BYOK_KEY_MISSING");
  const unsupported = chooseKeySource({ preference: "byok", provider: "qwen", hasUserKey: false });
  assert.ok(!unsupported.ok && unsupported.body.code === "BYOK_UNSUPPORTED_PROVIDER");
  assert.deepEqual(chooseKeySource({ preference: "auto", provider: "qwen", hasUserKey: false }), { ok: true, source: "alevr" });
});

test("the proxy route skips ApiSpend and the plan gate only on the user's own key", () => {
  const src = readFileSync(path.join(ROOT, "src/app/api/agent/[...path]/route.ts"), "utf8");
  // The plan gate and the budget/window block are both conditioned on !byok.
  assert.match(src, /if \(!byok && !PLANS\[plan\]\.code && !PLANS\[plan\]\.agents\)/);
  assert.match(src, /if \(plan !== "OWNER" && !byok\) \{\s*const budget/);
  // A BYOK call records analytics and returns before recordSpend.
  const byokBranch = src.indexOf("recordByokUsage(userId");
  const spend = src.indexOf("void recordSpend(");
  assert.ok(byokBranch > 0 && spend > byokBranch);
  assert.match(src.slice(byokBranch, spend), /return;/);
  // The rate limit still applies to everyone but the owner.
  assert.match(src, /rateLimit\(\{ key: `agent:\$\{user\.id\}`/);
  // byok is only true when a key was actually resolved for this user.
  assert.match(src, /const byok = keySource\.source === "byok" && userKey !== null;/);
});

test("context tier header and checks", () => {
  assert.equal(parseContextTierHeader(null), undefined);
  assert.equal(parseContextTierHeader("272000"), 272_000);
  assert.equal(parseContextTierHeader("-5"), null);
  assert.equal(parseContextTierHeader("1e6"), null);
  const sol = resolveModel("openai:gpt-6.1-sol");
  assert.deepEqual(checkRequestedTier({ model: sol, requested: undefined, promptChars: 10 }), {
    ok: true,
    tier: null,
    inputMultiplier: 1,
    outputMultiplier: 1,
  });
  const long = checkRequestedTier({ model: sol, requested: 1_050_000, promptChars: 4_000_000 });
  assert.ok(long.ok && long.inputMultiplier === 2 && long.outputMultiplier === 1.5);
  assert.deepEqual(tierScaledRates({ input: 2, output: 10 }, long as { inputMultiplier: number; outputMultiplier: number }), { input: 4, output: 15 });
  const over = checkRequestedTier({ model: sol, requested: 272_000, promptChars: 272_001 * 4 });
  assert.ok(!over.ok && over.status === 413 && over.body.code === "CONTEXT_TIER_EXCEEDED");
  const wrong = checkRequestedTier({ model: sol, requested: 500_000, promptChars: 10 });
  assert.ok(!wrong.ok && wrong.status === 400 && wrong.body.code === "CONTEXT_TIER_UNAVAILABLE");
  const unknown = checkRequestedTier({ model: null, requested: 272_000, promptChars: 10 });
  assert.ok(!unknown.ok && unknown.body.code === "CONTEXT_TIER_UNKNOWN_MODEL");
  assert.ok(!checkRequestedTier({ model: sol, requested: null, promptChars: 0 }).ok);
});

test("BYOK analytics price at list but are a separate record", () => {
  const opus = resolveModel("anthropic:claude-opus-5-5");
  const u = byokUsageFromMeter(opus, "anthropic", { promptTokens: 1000, completionTokens: 500, cacheRead: 4000, fastMode: false });
  assert.equal(u.inputTokens, 5000);
  assert.equal(u.outputTokens, 500);
  assert.equal(u.cachedTokens, 4000);
  // $4/MTok input, $0.20 cached, $20 output.
  assert.equal(u.estCostMicroUsd, 1000 * 4 + 4000 * 0.2 + 500 * 20);
  const unknown = byokUsageFromMeter(null, "openai", { promptTokens: 100, completionTokens: 10, fastMode: false });
  assert.equal(unknown.estCostMicroUsd, 0);
});

// ── Role routing ─────────────────────────────────────────────────────────────

const ctx = (byok: ByokProvider[] | null = [], target?: "device" | "cloud") => ({
  resolve: catalogModel,
  byokProviders: byok ? new Set(byok) : null,
  target,
});

test("instance ids name their kind", () => {
  assert.equal(instanceKindOf("alevr"), "alevr");
  assert.equal(instanceKindOf(byokInstanceId("openai")), "byok");
  assert.equal(instanceKindOf("byok:seedance"), null);
  assert.equal(instanceKindOf("claude-agent:default"), "claude-agent");
  assert.equal(instanceKindOf("codex:"), null);
  assert.equal(instanceKindOf("vertex:x"), null);
});

test("every contract fixture routing validates", () => {
  const fixture = JSON.parse(readFileSync(path.join(ROOT, "contracts/code/fixtures/role-routing.json"), "utf8")) as { cases: unknown[] };
  for (const c of fixture.cases) {
    const v = validateRoleRouting(c, ctx(null));
    assert.ok(v.ok, JSON.stringify(!v.ok && v.errors));
  }
});

test("routing resolves aliases and checks models against the catalogue", () => {
  const v = validateRoleRouting(
    { preset: "solo", orchestrator: { instanceId: "alevr", model: "opus", effort: "high" }, workers: [{ instanceId: "alevr", model: "x" }], extra: 1 },
    ctx(),
  );
  assert.ok(v.ok);
  assert.equal(v.routing.orchestrator.model, "anthropic:claude-opus-5-5");
  assert.equal(v.routing.workers, undefined, "solo drops workers");
  assert.ok(!("extra" in v.routing));
  const errs = (raw: unknown, c = ctx()) => {
    const r = validateRoleRouting(raw, c);
    return r.ok ? [] : r.errors;
  };
  assert.match(errs({ preset: "solo", orchestrator: { instanceId: "alevr", model: "openai:gpt-9" } })[0], /not in the catalogue/);
  assert.match(errs({ preset: "solo", orchestrator: { instanceId: "alevr", model: "mistral:mistral-medium-latest" } })[0], /can't drive/);
  assert.match(errs({ preset: "solo", orchestrator: { instanceId: "alevr", model: "anthropic:claude-haiku-4-5", effort: "xhigh" } })[0], /effort/);
  assert.match(errs({ preset: "solo", orchestrator: { instanceId: "alevr", model: "anthropic:claude-opus-5-5", contextTokens: 272_000 } })[0], /offers 1M/);
  const fastless = validateRoleRouting({ preset: "solo", orchestrator: { instanceId: "alevr", model: "google:gemini-3.8-flash", fast: true } }, ctx());
  assert.ok(fastless.ok && fastless.routing.orchestrator.fast === undefined && /no fast mode/.test(fastless.warnings[0]));
  assert.equal(catalogModel("juno:auto"), null);
  assert.equal(catalogModel("openai:gpt-9"), null);
  assert.match(errs({ preset: "lead-workers", orchestrator: { instanceId: "alevr", model: "opus" } })[0], /at least one worker/);
  assert.match(
    errs({ preset: "best-of-n", orchestrator: { instanceId: "alevr", model: "opus" }, workers: [{ instanceId: "alevr", model: "sonnet" }] })[0],
    /Best-of-N/,
  );
  assert.match(errs({ preset: "solo", orchestrator: { instanceId: "alevr", model: "opus" }, budget: { maxUsd: -1 } })[0], /maxUsd/);
  assert.match(errs({ preset: "wild", orchestrator: {} })[0], /preset/);
  assert.match(errs({ preset: "solo" })[0], /orchestrator/);
});

test("BYOK selections need a matching lab and a stored key", () => {
  const sel = (instanceId: string, model: string) => ({ preset: "solo", orchestrator: { instanceId, model } });
  assert.ok(validateRoleRouting(sel("byok:openai", "openai:gpt-6.1-sol"), ctx(["openai"])).ok);
  const noKey = validateRoleRouting(sel("byok:openai", "openai:gpt-6.1-sol"), ctx([]));
  assert.ok(!noKey.ok && /no working openai key/.test(noKey.errors[0]));
  const wrongLab = validateRoleRouting(sel("byok:openai", "anthropic:claude-opus-5-5"), ctx(["openai"]));
  assert.ok(!wrongLab.ok && /isn't a openai model/.test(wrongLab.errors[0]));
});

test("local subscriptions are refused for cloud runs only", () => {
  const r = { preset: "solo", orchestrator: { instanceId: "codex:default", model: "gpt-6.1-sol" } };
  assert.ok(validateRoleRouting(r, ctx([], "device")).ok);
  const cloud = validateRoleRouting(r, ctx([], "cloud"));
  assert.ok(!cloud.ok && /runs on your Mac/.test(cloud.errors[0]));
});

test("the Pro gate applies only when some role spends Alevr's keys", () => {
  const own = validateRoleRouting(
    {
      preset: "lead-workers",
      orchestrator: { instanceId: "claude-agent:default", model: "claude-opus-5-5" },
      workers: [{ instanceId: "byok:openai", model: "openai:gpt-6-luna" }],
    },
    ctx(["openai"]),
  );
  assert.ok(own.ok);
  assert.equal(routingAvoidsAlevrBilling(own.routing), true);
  assert.equal(legacyModelFor(own.routing), null);
  const mixed = validateRoleRouting(
    {
      preset: "lead-workers",
      orchestrator: { instanceId: "byok:openai", model: "openai:gpt-6.1-sol" },
      workers: [{ instanceId: "alevr", model: "sonnet" }],
    },
    ctx(["openai"]),
  );
  assert.ok(mixed.ok);
  assert.equal(routingAvoidsAlevrBilling(mixed.routing), false);
  assert.equal(legacyModelFor(mixed.routing), "openai:gpt-6.1-sol");
  assert.equal(routingAvoidsAlevrBilling(null), false);
});

test("the task route gates on the plan only for Alevr-billed routing, and snapshots routing onto tasks", () => {
  const src = readFileSync(path.join(ROOT, "src/app/api/code/tasks/route.ts"), "utf8");
  assert.match(src, /!PLANS\[await getUserPlan\(user\.id\)\]\.code && !routingAvoidsAlevrBilling\(roleRouting\)/);
  assert.equal((src.match(/roleRouting: roleRoutingJson/g) ?? []).length, 2, "both device and cloud creates store it");
  const wire = readFileSync(path.join(ROOT, "src/lib/code-task-wire.ts"), "utf8");
  assert.match(wire, /roleRouting: task\.roleRouting \?\? null/);
  const runner = readFileSync(path.join(ROOT, "src/app/api/code/tasks/[id]/runner-context/route.ts"), "utf8");
  assert.match(runner, /roleRouting: task\.roleRouting \?\? null/);
});
