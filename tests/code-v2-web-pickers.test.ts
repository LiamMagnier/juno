import { test } from "node:test";
import assert from "node:assert/strict";
import type { ContextTier, ProviderInstance, RoleRouting } from "@/lib/code-v2/contracts";
import { compactionThreshold, estimateDelta, formatTokens, gaugeView, rulerTicks, tierRows, wedgePath, windowLine } from "@/lib/code-v2/tier-view";
import { budgetLine, budgetWarn, estimateRunUsd, orchestrateLabel, parseBudget, withCount, withPreset, withRoleModel } from "@/lib/code-v2/orchestrate";
import { connectionAction, connectionSentence, cycleInstance, displayName, instanceMark, isInstanceVisible, isManagedRuntime, managedProgress, managedSetup, railEntries, statusSentence } from "@/lib/code-v2/providers-view";
import { createByokClient, looksLikeKey, maskKey } from "@/lib/code-v2/byok-client";
import { DOCK_TAB_GLYPHS } from "@/lib/code-v2/dock";
import { SLASH_COMMANDS } from "@/lib/code-v2/composer";
import { describeItem } from "@/lib/code-v2/turns";
import { CATALOG_ALIASES, CATALOG_NAMES } from "@/components/ui/juno-icons/catalog";

const GPT: ContextTier[] = [
  { tokens: 272_000, label: "272K", inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.1 },
  { tokens: 1_050_000, label: "1.05M", inputPerMTok: 4, outputPerMTok: 15, cachedInputPerMTok: 0.2, note: "2× input, 1.5× output above 272K" },
];

test("tier rows: lean, standard and long with prices, deltas and band-priced estimates", () => {
  const rows = tierRows({ tiers: GPT, threadTokens: 184_000 });
  assert.deepEqual(rows.map((r) => r.name), ["Lean", "Standard", "Long"]);
  const [lean, std, long] = rows;
  assert.equal(std.selected, true);
  assert.equal(std.priceLine, "$2.00 in · $10.00 out per million tokens");
  assert.equal(long.deltaLine, "2× input and 1.5× output past 272K.");
  // A 184K prompt on the 1M tier is billed at the standard band.
  assert.equal(long.estimateUsd, std.estimateUsd);
  assert.equal(std.estimateUsd, 0.39);
  assert.equal(lean.compactsNow, true);
  assert.ok(lean.compactsNowLine?.startsWith("Compacts now to about"));
  assert.ok((lean.estimateUsd ?? 1) < (std.estimateUsd ?? 0));
  assert.equal(estimateDelta(lean, std), "−$0.32");
  assert.deepEqual(rulerTicks(rows).map((t) => t.label), ["128K", "272K", "1.05M"]);
  const sub = tierRows({ tiers: GPT, threadTokens: 1000, subscription: true });
  assert.equal(sub[1].priceLine, undefined);
  assert.equal(sub[1].estimateUsd, null);
});

test("compaction threshold follows SPEC §3.5", () => {
  assert.equal(compactionThreshold(1_000_000), 800_000);
  assert.equal(compactionThreshold(272_000), 190_464);
  assert.equal(compactionThreshold(128_000), 64_000);
  assert.equal(formatTokens(1_048_576), "1.05M");
});

test("gauge view warns past 80% of the compaction point", () => {
  const g = gaugeView({ inputTokens: 0, outputTokens: 0, contextTokens: 184_000, contextWindow: 272_000, autoCompactAt: 217_000, costUsd: 1.84 });
  assert.equal(g.warn, true);
  assert.equal(g.usedLabel, "184K of 272K (68%)");
  assert.equal(g.costLine, "This thread so far: $1.84");
  assert.equal(gaugeView({ inputTokens: 0, outputTokens: 0, contextTokens: 10, contextWindow: 100, billing: "subscription" }, "Max plan").costLine, "Counts against your Max plan");
  assert.ok(wedgePath(0.25).startsWith("M8 8 L8 2.5 A5.5 5.5 0 0 1"));
  assert.equal(wedgePath(0), "");
});

const lead = { instanceId: "claude-agent:default", model: "claude-opus-5-5", effort: "high" as const };
const codex = { instanceId: "codex:default", model: "gpt-6.1-sol" };
const alevr = { instanceId: "alevr", model: "deepseek:deepseek-flash" };

test("orchestrate presets, counts and the estimate", () => {
  let r: RoleRouting = { orchestrator: lead, preset: "solo" };
  assert.equal(orchestrateLabel(r), "Solo");
  r = withPreset(r, "lead-workers");
  assert.equal(orchestrateLabel(r), "Lead + 3");
  assert.equal(r.budget?.maxUsd, 4);
  r = withRoleModel(r, "workers", codex);
  r = withCount(r, 9);
  assert.equal(r.workers?.length, 6);
  assert.ok(r.workers?.every((w) => w.instanceId === "codex:default"));
  r = withRoleModel(r, "explorer", alevr);
  const est = estimateRunUsd(r, () => ({ inputPerMTok: 0.15, outputPerMTok: 0.6 }));
  assert.equal(est.subscriptionRoles, true);
  assert.equal(est.usd, 0.01);
  const best = withPreset(r, "best-of-n");
  assert.equal(orchestrateLabel(best), "Best of 4");
  assert.equal(withPreset(best, "solo").workers, undefined);
  assert.equal(parseBudget("$4.50"), 4.5);
  assert.equal(parseBudget(""), undefined);
  assert.equal(parseBudget("-1"), null);
  assert.equal(budgetLine(0.64, 4), "$0.64 of $4.00");
  assert.equal(budgetWarn(3.3, 4), true);
});

const NOW = new Date("2026-10-08T12:00:00");
const instances: ProviderInstance[] = [
  { id: "byok:anthropic", kind: "byok", label: "Anthropic key", status: "ready" },
  { id: "acp:grok", kind: "acp", label: "grok", acpCommand: ["grok", "agent", "stdio"], status: "signed-out" },
  { id: "acp:antigravity", kind: "acp", label: "Antigravity", acpCommand: ["antigravity-acp"], status: "ready" },
  {
    id: "claude-agent:default",
    kind: "claude-agent",
    label: "Claude",
    status: "ready",
    version: "3.4.1",
    account: { email: "maya@okafor.studio", plan: "max" },
    limits: [{ id: "five_hour", label: "5-hour", usedPct: 38, resetsAt: "2026-10-08T16:40:00" }],
  },
  { id: "alevr", kind: "alevr", label: "Alevr", status: "ready" },
  { id: "codex:default", kind: "codex", label: "Codex", status: "signed-out", account: { plan: "pro" }, statusMessage: "Sign-in expired." },
  { id: "acp:dsh", kind: "acp", label: "dsh", acpCommand: ["dsh", "--profile", "acp"], status: "not-installed" },
];

test("provider names, marks and rail order follow the owner rules", () => {
  assert.equal(displayName(instances[3]), "Claude (your subscription)");
  assert.equal(displayName(instances[5]), "ChatGPT (Codex)");
  assert.equal(displayName(instances[1]), "Grok");
  assert.equal(displayName(instances[0]), "Your Anthropic key");
  assert.deepEqual(instanceMark(instances[6]), { type: "lab", provider: "deepseek" });
  assert.equal(isInstanceVisible(instances[2]), true, "Antigravity is a normal provider since 2026-10-09");
  const rail = railEntries(instances, {}, NOW);
  assert.deepEqual(rail.map((e) => e.instance.id), ["alevr", "acp:antigravity", "claude-agent:default", "acp:grok", "codex:default", "byok:anthropic"]);
  assert.deepEqual(rail.map((e) => e.dim), [false, false, false, true, true, false]);
  assert.equal(cycleInstance(rail, "byok:anthropic", 1), "alevr");
  assert.equal(statusSentence(instances[3], NOW), "Runs your own claude on this Mac. Max plan, 5-hour window 38% used, resets 16:40.");
  assert.equal(connectionSentence(instances[3]), "Your own claude CLI, version 3.4.1. Signed in as maya@okafor.studio, Max plan.");
  assert.equal(connectionAction(instances[5]), "sign-in-again");
  assert.equal(connectionAction(instances[6]), "install");
  for (const i of instances) assert.ok(!/claude code/i.test(displayName(i)), "never 'Claude Code'");
  assert.equal(windowLine({ id: "w", label: "Weekly", usedPct: 12.4 }, NOW), "Weekly 12%");
});

test("BYOK client: list tolerates missing routes, add validates, masks keys", async () => {
  const calls: string[] = [];
  const client = createByokClient(async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (!init?.method) return { ok: false, status: 404, json: async () => ({}) };
    if (init.method === "POST") return { ok: true, status: 200, json: async () => ({ key: { provider: "anthropic", label: "Anthropic", keyHint: "4f2a", status: "active", statusDetail: null, lastTestedAt: null, lastUsedAt: null, createdAt: "2026-09-30T00:00:00Z" } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  assert.deepEqual(await client.list(), []);
  assert.equal((await client.add("anthropic", " sk-ant-abc ")).hint, "…4f2a");
  await client.remove("anthropic");
  assert.deepEqual(calls, ["GET /api/provider-keys", "POST /api/provider-keys", "DELETE /api/provider-keys/anthropic"]);
  await assert.rejects(client.add("openai", "  "), /Paste a key/);
  assert.equal(maskKey("sk-ant-api03-abcdefghijklmnop4f2a"), "sk-ant-…4f2a");
  assert.equal(looksLikeKey("anthropic", "sk-proj-0123456789012345678"), false);
});

test("every glyph the v2 libraries name exists in the web icon set", () => {
  const known = new Set<string>([...CATALOG_NAMES, ...Object.keys(CATALOG_ALIASES)]);
  const names = [
    ...Object.values(DOCK_TAB_GLYPHS),
    ...SLASH_COMMANDS.map((c) => c.glyph),
    "loading",
    "needs-you",
    "pause-circle",
    "error-circle",
    "key",
    "terminal",
  ];
  const at = "2026-10-08T10:00:00.000Z";
  const samples = [
    describeItem({ id: "1", kind: "reasoning", text: "", streaming: false, createdAt: at }),
    describeItem({ id: "2", kind: "plan", text: "", createdAt: at }),
    describeItem({ id: "3", kind: "todo_list", todos: [], createdAt: at }),
    describeItem({ id: "4", kind: "file_change", callId: "4", changes: [], status: "completed", createdAt: at }),
    describeItem({ id: "5", kind: "search", callId: "5", query: "", status: "completed", createdAt: at }),
    describeItem({ id: "5b", kind: "search", callId: "5b", query: "", scope: "files", status: "completed", createdAt: at }),
    describeItem({ id: "6", kind: "web_search", callId: "6", query: "", status: "completed", createdAt: at }),
    describeItem({ id: "7", kind: "interrupt", reason: "limit", createdAt: at }),
    describeItem({ id: "8", kind: "interrupt", reason: "user", createdAt: at }),
    describeItem({ id: "9", kind: "error", message: "x", createdAt: at }),
    describeItem({ id: "10", kind: "computer_action", callId: "10", action: "click", status: "completed", createdAt: at }),
    describeItem({ id: "11", kind: "handoff", to: { instanceId: "alevr", model: "m" }, createdAt: at }),
    describeItem({ id: "12", kind: "approval_request", callId: "c", requestId: "r", action: "command", summary: "", status: "resolved", decision: "accept", createdAt: at }),
    describeItem({ id: "13", kind: "approval_request", callId: "c", requestId: "r", action: "command", summary: "", status: "resolved", decision: "decline", createdAt: at }),
    describeItem({ id: "14", kind: "user_input_request", requestId: "r", questions: [], status: "answered", createdAt: at }),
  ];
  for (const s of samples) if (s) names.push(s.glyph);
  for (const n of names) assert.ok(known.has(n), `unknown glyph ${n}`);
});

test("a managed runtime (Antigravity) installs and signs in through the env server, not a terminal", () => {
  const base = { id: "acp:antigravity", kind: "acp", label: "Antigravity", acpCommand: ["antigravity-acp"] } as const;
  const missing = { ...base, status: "not-installed", install: { phase: "idle", version: "1.3.0" } } as ProviderInstance;
  assert.equal(isManagedRuntime(missing), true);
  assert.deepEqual(managedSetup(missing, "install"), { type: "provider.install", params: { instanceId: "acp:antigravity", action: "start" } });
  assert.deepEqual(managedSetup(missing, "login"), { type: "provider.auth", params: { instanceId: "acp:antigravity", action: "start" } });
  assert.equal(managedSetup({ ...base, status: "ready" } as ProviderInstance, "login"), null, "CLI runtimes keep their terminal step");
  assert.equal(managedProgress({ install: { phase: "downloading", downloadedBytes: 50, totalBytes: 200 } }), "Downloading Google's runtime, 25%.");
  assert.match(managedProgress({ auth: { phase: "waiting", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" } }) ?? "", /paste the address/);
  assert.equal(managedProgress({ install: { phase: "succeeded" }, auth: { phase: "idle" } }), null);
  assert.match(connectionSentence(missing), /downloads Google's official runtime/);
  for (const text of [connectionSentence(missing), managedProgress({ auth: { phase: "waiting" } }) ?? ""]) assert.doesNotMatch(text, /\u2014/);
});
