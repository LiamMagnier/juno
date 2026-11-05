/**
 * A person's agent controls from the web Agents tree (REA backlog 10):
 * src/lib/code-v2/agent-control.ts behind POST /api/code/v2/link/[deviceId]/agents.
 * Ownership, the pair, rate limits, bounds, idempotency and the audit row, with
 * the relay and the stores injected; then the relay rule that keeps these
 * commands off the generic link route.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_CONTROL_RATE_LIMIT,
  agentControlCommand,
  handleAgentControl,
  parseAgentControl,
  type AgentControlAuditDetail,
  type AgentControlDeps,
  type StoredAgentControl,
} from "@/lib/code-v2/agent-control";
import { DeviceLink, LINK_AGENT_CONTROL_COMMANDS, linkRelays } from "@/lib/code-v2/env-link-hub";
import { parseLinkRequest } from "@/lib/code-v2/device-link";
import type { ClientCommand } from "@/lib/code-v2/contracts";
import type { LinkReply, LinkRpcOptions } from "@/lib/code-v2/env-link-hub";
import { readFileSync } from "node:fs";

/** The compliance log's key allowlist, read from its source (audit.ts is server-only). */
const auditAllowlist = (() => {
  const source = readFileSync(new URL("../src/lib/work/audit.ts", import.meta.url), "utf8");
  const block = /ALLOWED_AUDIT_KEYS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? "";
  return new Set([...block.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]!));
})();

interface Harness {
  deps: AgentControlDeps;
  relayed: { command: ClientCommand; options: LinkRpcOptions }[];
  audits: { userId: string; detail: AgentControlAuditDetail }[];
  limits: Map<string, number>;
  reply: (command: ClientCommand) => LinkReply;
}

function harness(over: Partial<AgentControlDeps> = {}): Harness {
  const h: Harness = {
    relayed: [],
    audits: [],
    limits: new Map(),
    reply: (command) => ({ responses: [{ type: "response", id: command.id, ok: true, result: { accepted: true, message: "Agent w1 pauses after its current step." } }] }),
    deps: undefined as unknown as AgentControlDeps,
  };
  let n = 0;
  h.deps = {
    rateLimit: async (key, limit) => {
      const used = (h.limits.get(key) ?? 0) + 1;
      h.limits.set(key, used);
      return used <= limit;
    },
    findDevice: async (userId, id) => (userId === "owner" && id === "mac1" ? { id: "mac1", name: "Studio Mac" } : null),
    checkPair: async () => null,
    // The audit log is the replay store: the newest decisive row under the key.
    findPrior: async (userId, key, since) => {
      const row = [...h.audits].reverse().find((a) => a.userId === userId && a.detail.idempotencyKey === key && (a.detail.outcome === "accepted" || a.detail.outcome === "refused"));
      void since;
      return row ? ({ outcome: row.detail.outcome, contentHash: row.detail.contentHash, ...(row.detail.reason ? { reason: row.detail.reason } : {}) } satisfies StoredAgentControl) : null;
    },
    relay: async (_userId, _deviceId, command, options) => {
      h.relayed.push({ command, options });
      return h.reply(command);
    },
    audit: async (userId, detail) => {
      h.audits.push({ userId, detail });
    },
    newCommandId: () => `agent_${++n}`,
    now: () => Date.parse("2026-10-18T12:00:00Z"),
    ...over,
  };
  return h;
}

const key = (s: string) => `key-${s}-0000`;
const run = (h: Harness, body: Record<string, unknown>, userId = "owner", deviceId = "mac1") => handleAgentControl(h.deps, { userId, deviceId, body });

test("parse: actions, ids and bounds", () => {
  assert.equal(parseAgentControl({ sessionId: "s1", action: "pause" }).ok, false, "a request key is required");
  assert.equal(parseAgentControl({ sessionId: "s1", action: "pause", idempotencyKey: "short" }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s1", action: "explode", idempotencyKey: key("a") }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s 1", action: "pause", idempotencyKey: key("a") }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s1", action: "steer", idempotencyKey: key("a") }).ok, false, "steer needs an agent");
  assert.equal(parseAgentControl({ sessionId: "s1", agentId: "w1", action: "steer", text: "   ", idempotencyKey: key("a") }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s1", agentId: "w1", action: "steer", text: "x".repeat(8_001), idempotencyKey: key("a") }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s1", agentId: "w1", action: "top_up", idempotencyKey: key("a") }).ok, false, "an amount is required");
  assert.equal(parseAgentControl({ sessionId: "s1", agentId: "w1", action: "top_up", tokens: 5_000, idempotencyKey: key("a") }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s1", agentId: "w1", action: "top_up", tokens: 400_001, idempotencyKey: key("a") }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s1", agentId: "w1", action: "top_up", tokens: 50_000.5, idempotencyKey: key("a") }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s1", agentId: "w1", action: "top_up", usd: 5, idempotencyKey: key("a") }).ok, false, "agents are topped up in tokens");
  assert.equal(parseAgentControl({ sessionId: "s1", action: "top_up", usd: 25, idempotencyKey: key("a") }).ok, false);
  assert.equal(parseAgentControl({ sessionId: "s1", action: "top_up", tokens: 1_000_000, idempotencyKey: key("a") }).ok, true, "the run takes bigger token top-ups");
  const steer = parseAgentControl({ sessionId: "s1", agentId: "w1", action: "steer", text: "  Only the server route.  ", idempotencyKey: key("a") });
  assert.ok(steer.ok && steer.request.text === "Only the server route.");
});

test("commands: each action maps to its wire command, with the key as the env server's request id", () => {
  const base = { sessionId: "s1", idempotencyKey: key("c") };
  assert.deepEqual(agentControlCommand({ ...base, agentId: "w1", action: "steer", text: "hi" }, "c1"), { id: "c1", type: "agent.message", params: { sessionId: "s1", agentId: "w1", text: "hi", requestId: key("c") } });
  assert.equal(agentControlCommand({ ...base, agentId: "w1", action: "stop" }, "c1").type, "agent.interrupt");
  assert.deepEqual(agentControlCommand({ ...base, action: "stop" }, "c1"), { id: "c1", type: "turn.interrupt", params: { sessionId: "s1" } }, "Stop with no agent stops the run");
  assert.deepEqual(agentControlCommand({ ...base, action: "pause" }, "c1").params, { sessionId: "s1", requestId: key("c") });
  assert.deepEqual(agentControlCommand({ ...base, agentId: "w1", action: "top_up", tokens: 100_000 }, "c1").params, { sessionId: "s1", agentId: "w1", tokens: 100_000, requestId: key("c") });
});

test("ownership: another account's Mac is a 404 and nothing is relayed; a missing pair is refused with its own status", async () => {
  const h = harness();
  const other = await run(h, { sessionId: "s1", agentId: "w1", action: "pause", idempotencyKey: key("own") }, "intruder");
  assert.equal(other.status, 404);
  const wrongMac = await run(h, { sessionId: "s1", agentId: "w1", action: "pause", idempotencyKey: key("own") }, "owner", "mac2");
  assert.equal(wrongMac.status, 404);
  assert.equal(h.relayed.length, 0);

  const unpaired = harness({ checkPair: async () => ({ status: 403, error: "Pair this browser with the Mac first.", code: "not_paired" }) });
  const refused = await run(unpaired, { sessionId: "s1", agentId: "w1", action: "pause", idempotencyKey: key("pair") });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "not_paired");
  assert.equal(unpaired.relayed.length, 0);
});

test("a steer is relayed once through the agent-control door and audited without its words", async () => {
  const h = harness({ });
  h.reply = (command) => ({ responses: [{ type: "response", id: command.id, ok: true, result: { accepted: true, message: "Delivered to running agent w1; it reads it at its next step." } }] });
  const res = await run(h, { sessionId: "s1", agentId: "w1", action: "steer", text: "Secret plan: only touch billing.ts", idempotencyKey: key("steer") });
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, true);
  assert.equal(h.relayed.length, 1);
  assert.equal(h.relayed[0]!.command.type, "agent.message");
  assert.deepEqual(h.relayed[0]!.options, { agentControl: true });
  assert.equal(h.audits.length, 1);
  const detail = h.audits[0]!.detail;
  assert.equal(detail.action, "steer");
  assert.equal(detail.outcome, "accepted");
  assert.equal(detail.target, "w1");
  assert.equal(detail.deviceId, "mac1");
  assert.equal(detail.sessionId, "s1");
  assert.ok(!JSON.stringify(detail).includes("Secret plan"), "the steer text never reaches the log");
  // Every key the handler writes survives the log's allowlist (nothing silently dropped).
  assert.ok(auditAllowlist.size > 20, "read the allowlist");
  for (const k of Object.keys(detail)) assert.ok(auditAllowlist.has(k), `audit key "${k}" is on the log's allowlist`);
});

test("idempotency: a retried key is answered from the log without reaching the Mac; a reused key for another action is refused", async () => {
  const h = harness();
  const body = { sessionId: "s1", agentId: "w1", action: "pause", idempotencyKey: key("idem") };
  const first = await run(h, body);
  const second = await run(h, body);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.replayed, true);
  assert.equal(second.body.accepted, true);
  assert.equal(second.body.message, first.body.message);
  assert.equal(h.relayed.length, 1, "the Mac heard it once");
  assert.equal(h.audits.length, 1);

  const reused = await run(h, { ...body, action: "resume" });
  assert.equal(reused.status, 422);
  assert.equal(h.relayed.length, 1);
});

test("an offline Mac or a timeout is retryable: the retry is relayed again (and the env server dedupes by request id)", async () => {
  const h = harness();
  h.reply = () => ({ offline: true, message: "Your Mac is offline. Open Alevr on it to continue." });
  const body = { sessionId: "s1", agentId: "w1", action: "top_up", tokens: 100_000, idempotencyKey: key("off") };
  const offline = await run(h, body);
  assert.equal(offline.status, 503);
  assert.equal(offline.body.offline, true);
  h.reply = (command) => ({ responses: [{ type: "response", id: command.id, ok: false, error: { code: "not_ready", message: "Your Mac did not answer in time." } }] });
  assert.equal((await run(h, body)).status, 503);
  h.reply = (command) => ({ responses: [{ type: "response", id: command.id, ok: true, result: { accepted: true, message: "Agent w1 can now use up to 500,000 tokens.", tokenBudget: 500_000 } }] });
  const ok = await run(h, body);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tokenBudget, 500_000);
  assert.equal(h.relayed.length, 3);
  for (const r of h.relayed) assert.equal((r.command.params as { requestId?: string }).requestId, key("off"));
  assert.deepEqual(h.audits.map((a) => a.detail.outcome), ["offline", "failed", "accepted"]);
  assert.equal(h.audits[2]!.detail.count, 100_000, "the amount added is on the record");
});

test("an engine refusal is a 200 with accepted:false, audited as a refusal and replayed as one", async () => {
  const h = harness();
  h.reply = (command) => ({ responses: [{ type: "response", id: command.id, ok: true, result: { accepted: false, message: "Agent w1 has already been given 1,200,000 extra tokens; the most is 1,200,000." } }] });
  const body = { sessionId: "s1", agentId: "w1", action: "top_up", tokens: 400_000, idempotencyKey: key("cap") };
  const res = await run(h, body);
  assert.equal(res.status, 200);
  assert.equal(res.body.accepted, false);
  assert.equal(h.audits[0]!.detail.outcome, "refused");
  assert.equal(h.audits[0]!.detail.allowed, false);
  const again = await run(h, body);
  assert.equal(again.body.accepted, false);
  assert.equal(again.body.replayed, true);
  assert.equal(h.relayed.length, 1);

  // A wire error that is not a timeout (the session is gone) is a 409.
  const gone = harness();
  gone.reply = (command) => ({ responses: [{ type: "response", id: command.id, ok: false, error: { code: "not_found", message: "Unknown session." } }] });
  assert.equal((await run(gone, { sessionId: "s9", agentId: "w1", action: "stop", idempotencyKey: key("gone") })).status, 409);
});

test("rate limits: every control has a per-account ceiling, and top-ups a tighter one of their own", async () => {
  const h = harness();
  h.limits.set("code-agent-control:owner", AGENT_CONTROL_RATE_LIMIT.limit);
  const limited = await run(h, { sessionId: "s1", agentId: "w1", action: "pause", idempotencyKey: key("rl") });
  assert.equal(limited.status, 429);
  assert.equal(h.relayed.length, 0);

  const t = harness();
  t.limits.set("code-agent-topup:owner", 20);
  const topLimited = await run(t, { sessionId: "s1", agentId: "w1", action: "top_up", tokens: 100_000, idempotencyKey: key("rl2") });
  assert.equal(topLimited.status, 429);
  assert.equal((await run(t, { sessionId: "s1", agentId: "w1", action: "pause", idempotencyKey: key("rl3") })).status, 200, "other controls still pass");
});

test("the generic link route never relays an agent control; only the agent-control door does", async () => {
  for (const type of LINK_AGENT_CONTROL_COMMANDS) {
    const parsed = parseLinkRequest({ kind: "rpc", command: { id: "c1", type, params: { sessionId: "s1", agentId: "w1" } } });
    assert.ok(!parsed.ok && parsed.status === 403, type);
    assert.equal(linkRelays(type), false);
    assert.equal(linkRelays(type, { agentControl: true }), true);
  }
  assert.equal(linkRelays("env.configure", { agentControl: true }), false, "the door opens nothing else");

  const link = new DeviceLink();
  await link.pull(0);
  const refused = await link.rpc({ id: "c1", type: "agent.pause", params: { sessionId: "s1" } });
  assert.equal(refused.responses?.[0]?.ok, false);
  const relayed = link.rpc({ id: "c2", type: "agent.pause", params: { sessionId: "s1" } }, { agentControl: true });
  const { commands } = await link.pull(0);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]!.type, "agent.pause");
  link.push({ responses: [{ type: "response", id: commands[0]!.id, ok: true, result: { accepted: true } }] });
  assert.equal((await relayed).responses?.[0]?.ok, true);
});
