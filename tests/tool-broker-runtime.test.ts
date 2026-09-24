import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  decideAuthorization,
  type ActionPermissionPolicy,
  type ActionPolicySnapshot,
  type ClientActionApproval,
} from "@/lib/action-approval";
import type { ActionAuthorization, AuthorizeActionInput } from "@/lib/action-approval-store";
import { executeToolBatch, type BatchContext, type BatchResult, type ToolCallInput } from "@/lib/tools/dispatch";
import { ToolFeeAccumulator } from "@/lib/tools/metering";
import { JUNO_TOOL_SPECS, junoToolSpec } from "@/lib/tools/registry";
import { toActionRiskClass } from "@/lib/tools/risk";
import type { ChatToolset, ResolvedTool, ToolContext, ToolSpec } from "@/lib/tools/types";
import type { LlmEvent } from "@/types/llm";

/*
 * The broker rule (SPEC §3.3, RC-1, INV-31), driven through the dispatcher
 * with a fake broker port that makes the real decision (`decideAuthorization`,
 * the pure half of `authorizeExternalAction`) over fake policy and grant
 * queries. What it pins: Juno's own reads never wait on a card under the
 * default policy — nor under always-ask — block and lockdown still refuse, a
 * connector's external write still asks, refusals map to their statuses, and
 * the turn's resolved policy saves the policy query.
 */

type Snapshot = ActionPolicySnapshot & { scopeKey: string };

interface Broker {
  port: (request: AuthorizeActionInput) => Promise<ActionAuthorization>;
  queries: { policy: number; grant: number };
  cards: ClientActionApproval[];
}

function fakeBroker(policy: ActionPermissionPolicy, opts: { lockdown?: boolean; answer?: "allow" | "deny" | "expire" } = {}): Broker {
  const queries = { policy: 0, grant: 0 };
  const cards: ClientActionApproval[] = [];
  const port = async (request: AuthorizeActionInput): Promise<ActionAuthorization> => {
    const decided = await decideAuthorization<Snapshot>(
      { ...request, resolvedPolicy: (request.resolvedPolicy as Snapshot | null | undefined) ?? null },
      {
        resolvePolicy: async () => {
          queries.policy += 1;
          return { policy, lockdown: !!opts.lockdown, connectorBlocked: false, connectorId: request.connectorId, scopeKey: "account" };
        },
        findStandingGrant: async () => {
          queries.grant += 1;
          return false;
        },
      },
    );
    if (decided.receiptless) return { kind: "authorized", receiptId: null, riskClass: decided.classification.riskClass };
    if (decided.outcome === "block") return { kind: "refused", receiptId: "r-block", reason: "Blocked by policy.", status: "blocked" };
    if (decided.outcome === "allow") return { kind: "authorized", receiptId: "r-allow", riskClass: decided.classification.riskClass };
    const card = { id: `card-${cards.length + 1}`, toolName: request.toolName, riskClass: decided.classification.riskClass } as ClientActionApproval;
    cards.push(card);
    request.onApprovalRequest?.(card);
    if (opts.answer === "deny") return { kind: "refused", receiptId: card.id, reason: "Denied by user.", status: "denied" };
    if (opts.answer === "expire") return { kind: "refused", receiptId: card.id, reason: "Action expired.", status: "expired" };
    return { kind: "authorized", receiptId: card.id, riskClass: decided.classification.riskClass };
  };
  return { port, queries, cards };
}

function resolvedFromSpec(s: ToolSpec, execute?: ToolSpec["execute"]): ResolvedTool {
  const runnable = execute ? { ...s, execute } : s;
  return {
    name: s.id,
    canonical: s.id,
    origin: "juno",
    title: s.title,
    risk: s.risk,
    parallelSafe: s.parallelSafe,
    timeoutMs: s.timeoutMs,
    dedupe: false,
    present: () => ({}),
    spec: runnable,
    input: s.input,
  };
}

const githubCreateIssue: ResolvedTool = {
  name: "github__create_issue",
  canonical: "mcp",
  origin: "connector",
  title: "Create issue",
  risk: "external",
  parallelSafe: false,
  timeoutMs: 60_000,
  dedupe: false,
  connectorId: "github",
  connectorLabel: "GitHub",
  present: () => ({}),
};

function harness(broker: Broker, opts: { resolvedPolicy?: Snapshot | null } = {}) {
  const ran: string[] = [];
  const junoTools = ["read_document", "web_search", "web_fetch", "search_chats", "inspect_image", "run_code"].map((id) =>
    resolvedFromSpec(junoToolSpec(id)!, async () => {
      ran.push(id);
      return { status: "succeeded", text: "ok", body: "ok" };
    }),
  );
  const byName = new Map([...junoTools, githubCreateIssue].map((t) => [t.name, t]));
  const toolset: ChatToolset = {
    tools: [],
    labelFor: (name) => byName.get(name)?.title ?? name,
    accessFor: () => "unknown",
    // A connector authorises inside execute, as `openMcpToolset` does, with the per-call card.
    execute: async (name, args, signal, callId, opts) => {
      const authorization = await broker.port({
        userId: "u1",
        surface: "chat",
        sessionId: "gen-1",
        connectorId: "github",
        connectorLabel: "GitHub",
        toolName: "create_issue",
        functionName: name,
        args,
        callId: callId ?? "x",
        provenance: { source: "conversation:c1", sourceKind: "model_tool_call", derivedFromUntrusted: true },
        signal,
        onApprovalRequest: opts?.onApprovalRequest,
      });
      if (authorization.kind !== "authorized") return { text: "refused", body: "refused", ok: false, status: "denied", error: { code: "denied" } };
      opts?.onAuthorized?.();
      ran.push(name);
      return { text: "created", body: "created", ok: true };
    },
    close: async () => {},
    resolve: (name) => byName.get(name),
    connectors: [],
  };
  const ctx: BatchContext = {
    toolset,
    toolContext: {
      userId: "u1",
      conversationId: "c1",
      projectId: null,
      generationId: "gen-1",
      private: false,
      plan: "PRO",
      citationsNumbered: false,
      sources: {} as ToolContext["sources"],
      ledger: null,
      taint: { mark: () => {} } as unknown as ToolContext["taint"],
      limits: {} as ToolContext["limits"],
      attachments: async () => [],
    },
    cache: new Map(),
    fees: new ToolFeeAccumulator(),
    nextIsFinal: false,
    seenCallIds: new Set(),
    ports: {
      authorizeExternalAction: broker.port as NonNullable<BatchContext["ports"]["authorizeExternalAction"]>,
      completeExternalAction: async () => {},
      recordToolInvocation: async () => null,
      settleToolInvocation: async () => {},
      resolvedPolicy: (opts.resolvedPolicy ?? null) as BatchContext["ports"]["resolvedPolicy"],
    },
  };
  return { ctx, ran };
}

async function run(ctx: BatchContext, calls: ToolCallInput[]): Promise<{ events: LlmEvent[]; results: BatchResult[] }> {
  const events: LlmEvent[] = [];
  const gen = executeToolBatch(calls, new AbortController().signal, ctx);
  for (;;) {
    const next = await gen.next();
    if (next.done) return { events, results: next.value };
    events.push(next.value);
  }
}

const readCalls = (): ToolCallInput[] => [
  { name: "read_document", callId: "a", round: 0, index: 0, argsText: '{"action":"list"}' },
  { name: "web_search", callId: "b", round: 0, index: 1, argsText: '{"query":"juno"}' },
  { name: "web_fetch", callId: "c", round: 0, index: 2, argsText: '{"url":"https://example.com/"}' },
  { name: "search_chats", callId: "d", round: 0, index: 3, argsText: '{"query":"trip"}' },
  { name: "run_code", callId: "e", round: 0, index: 4, argsText: '{"code":"print(1)"}' },
];

function awaited(events: LlmEvent[]): number {
  return events.filter((ev) => ev.type === "tool" && ev.phase === "status" && ev.status === "awaiting_approval").length;
}

test("the default policy runs Juno's reads with no card and no receipt", async () => {
  const broker = fakeBroker("ask_for_any_change");
  const { ctx, ran } = harness(broker);
  const { events, results } = await run(ctx, readCalls());
  assert.deepEqual(results.map((r) => r.isError), [false, false, false, false, false]);
  assert.equal(awaited(events), 0);
  assert.equal(broker.cards.length, 0);
  assert.deepEqual(ran.sort(), ["read_document", "run_code", "search_chats", "web_fetch", "web_search"]);
});

test("always_ask still allows first-party reads (INV-31)", async () => {
  const broker = fakeBroker("always_ask");
  const { ctx } = harness(broker);
  const { events, results } = await run(ctx, readCalls());
  assert.ok(results.every((r) => !r.isError));
  assert.equal(awaited(events), 0, "Juno's own reads are not 'a connected app'");
});

test("block and lockdown refuse even Juno's reads", async () => {
  for (const broker of [fakeBroker("block"), fakeBroker("ask_for_any_change", { lockdown: true })]) {
    const { ctx, ran } = harness(broker);
    const { results } = await run(ctx, readCalls());
    assert.deepEqual(results.map((r) => r.errorCode), ["blocked", "blocked", "blocked", "blocked", "blocked"]);
    assert.deepEqual(ran, []);
  }
});

test("a connector's external write still asks, and the card maps to its call", async () => {
  const broker = fakeBroker("ask_for_any_change");
  const { ctx } = harness(broker);
  const { events, results } = await run(ctx, [
    { name: "github__create_issue", callId: "w", round: 0, index: 0, argsText: '{"title":"Bug"}' },
  ]);
  assert.equal(results[0].isError, false);
  assert.equal(broker.cards.length, 1);
  const waiting = events.find((ev) => ev.type === "tool" && ev.phase === "status" && ev.status === "awaiting_approval");
  assert.ok(waiting?.type === "tool" && waiting.phase === "status" && waiting.callId === "w" && waiting.approval?.id === "card-1");

  // And always_ask asks for a connected app's read too; only first-party reads skip it.
  const strict = fakeBroker("always_ask");
  const decided = await decideAuthorization(
    { connectorId: "apple-mail", toolName: "read_message" },
    { resolvePolicy: async () => ({ policy: "always_ask" as const, lockdown: false, connectorBlocked: false }), findStandingGrant: async () => false },
  );
  assert.equal(decided.outcome, "ask");
  assert.equal(strict.cards.length, 0);
});

test("refusals map to denied and expired records", async () => {
  for (const [answer, code] of [["deny", "denied"], ["expire", "expired"]] as const) {
    const broker = fakeBroker("ask_for_any_change", { answer });
    const { ctx } = harness(broker);
    // A Juno tool whose rule is not a read would ask; exercise the mapping with an unknown juno_runtime tool name.
    const port = broker.port;
    ctx.ports.authorizeExternalAction = (async (request: AuthorizeActionInput) =>
      port({ ...request, toolName: "browser_agent" })) as NonNullable<BatchContext["ports"]["authorizeExternalAction"]>;
    const { events, results } = await run(ctx, [{ name: "web_fetch", callId: "x", round: 0, index: 0, argsText: '{"url":"https://a.example/"}' }]);
    assert.equal(results[0].errorCode, code);
    assert.equal(awaited(events), 1);
    const result = events.find((ev) => ev.type === "tool" && ev.phase === "result");
    assert.ok(result?.type === "tool" && result.phase === "result" && result.status === code);
  }
});

test("the turn's resolved policy skips the policy query; one for another connector does not", async () => {
  const resolved: Snapshot = { policy: "ask_for_any_change", lockdown: false, connectorBlocked: false, connectorId: "juno_runtime", scopeKey: "account" };
  const withPolicy = fakeBroker("ask_for_any_change");
  await run(harness(withPolicy, { resolvedPolicy: resolved }).ctx, readCalls());
  assert.deepEqual(withPolicy.queries, { policy: 0, grant: 0 }, "a Juno read costs no query at all");

  const without = fakeBroker("ask_for_any_change");
  await run(harness(without).ctx, readCalls());
  assert.equal(without.queries.policy, 5);
  assert.equal(without.queries.grant, 0, "a read never has a standing grant to look up");

  const foreign = await decideAuthorization(
    { connectorId: "github", toolName: "create_issue", resolvedPolicy: { ...resolved } },
    {
      resolvePolicy: async () => ({ policy: "block" as const, lockdown: false, connectorBlocked: false, connectorId: "github", scopeKey: "account" }),
      findStandingGrant: async () => false,
    },
  );
  assert.equal(foreign.outcome, "block", "a policy resolved for juno_runtime is never reused for a connector");
});

test("every broker:juno_runtime spec is an exact read the broker allows under the default policy", async () => {
  for (const spec of JUNO_TOOL_SPECS.filter((s) => s.broker === "juno_runtime")) {
    const decided = await decideAuthorization(
      { connectorId: "juno_runtime", toolName: spec.id },
      { resolvePolicy: async () => ({ policy: "ask_for_any_change" as const, lockdown: false, connectorBlocked: false }), findStandingGrant: async () => false },
    );
    assert.equal(decided.classification.riskClass, toActionRiskClass(spec.risk), spec.id);
    assert.equal(decided.firstParty, true);
    assert.equal(decided.receiptless, true, `${spec.id} should need no receipt`);
  }
});

test("the store decides through decideAuthorization, passes the turn's policy and returns refusal statuses", () => {
  const store = readFileSync(path.join(process.cwd(), "src/lib/action-approval-store.ts"), "utf8");
  assert.match(store, /await decideAuthorization\(request, \{/);
  assert.match(store, /resolvedPolicy\?: ResolvedActionPolicy \| null;/);
  assert.match(store, /status: statusValue\(initial\.status\)/);
  assert.match(store, /status: statusValue\(decided\.status\)/);
  assert.match(store, /toolIdAliasesOf\(canonicalToolId\(toolName\)\)/, "standing grants under an old tool name still count");
  const domain = readFileSync(path.join(process.cwd(), "src/lib/action-approval.ts"), "utf8");
  assert.match(domain, /firstParty = request\.connectorId === JUNO_RUNTIME_CONNECTOR_ID/);
});
