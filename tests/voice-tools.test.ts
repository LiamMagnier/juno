import Module, { createRequire } from "node:module";
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plan } from "@prisma/client";
import { decideActionPolicy, type ActionRiskClass, type ClientActionApproval } from "@/lib/action-approval";
import type { ActiveConnector, McpToolset } from "@/lib/mcp";
import { chatToolEntitlements } from "@/lib/tools/entitlements";
import { parseClientFeatures } from "@/lib/chat/client-features";
import { toActionRiskClass } from "@/lib/tools/risk";
import { openChatToolset } from "@/lib/tools/toolset";
import { wrapUntrusted } from "@/lib/untrusted-content";
import {
  VOICE_JUNO_TOOL_IDS,
  VOICE_MAX_TOOLS,
  composeVoiceToolset,
  parseVoiceToolsRequest,
  spokenApprovalAllowed,
  voiceConfirmationFor,
  voiceResultText,
  voiceToolCallerOf,
  voiceToolDescriptors,
  voiceToolPlan,
} from "@/lib/voice-tools";
import {
  applySpokenAnswer,
  applyVoiceToolActivity,
  voiceToolStatusWord,
  withdrawSpokenAnswer,
} from "@/lib/voice-tool-activity";

/*
 * Connectors and tools in a voice call (src/lib/voice-tools.ts, the routes in
 * src/app/api/voice/tools, relay/src/tools.ts).
 *
 * Four promises, each tested here on Juno's side (the relay's half is
 * relay/tests/voice-tools.test.ts):
 *
 *   1. A call's tool list IS the chat's policy, narrowed — not a second table.
 *   2. Anything that changes something waits for the person, and anything
 *      that cannot be undone waits for the card, never a spoken yes.
 *   3. Only the relay can list or run a call's tools, under its own audience,
 *      and nothing it can reach answers a card: a spoken yes is sent by the
 *      person's own signed-in client through the chat's decision route.
 *   4. Nothing the relay is sent carries a connector's credential.
 */

const SECRET = "voice-tools-test-secret";
process.env.AUTH_SECRET = SECRET;
const OAUTH = "oauth-secret-must-never-leave-juno";
const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// 1. The list matches the chat's policy
// ---------------------------------------------------------------------------

const PLANS: Plan[] = ["FREE", "LITE", "PRO", "PLUS", "MAX", "OWNER"];

function chatPlanFor(input: Parameters<typeof voiceToolPlan>[0]) {
  return chatToolEntitlements({
    plan: input.plan,
    private: false,
    lockdown: input.lockdown,
    approvalPolicy: input.approvalPolicy,
    voice: false,
    regenerate: false,
    artifactEdit: false,
    researchActive: false,
    researchArmed: false,
    webToggle: true,
    features: parseClientFeatures([]),
    workspace: input.workspace,
    skill: null,
    model: {
      id: "fixture",
      provider: "openai",
      providerModel: "fixture",
      name: "Fixture",
      minPlan: "FREE",
      vision: false,
      reasoning: false,
      agenticTools: true,
      cost: 1,
      modality: "chat",
      webSearch: false,
      tools: { supported: true, nativeSearch: false },
    },
    hasFileAttachment: false,
    hasInspectable: false,
    sandboxConfigured: false,
    keyedSearchEngine: input.alevrSearch,
    alevrSearch: input.alevrSearch,
    saved: input.saved ? { userMessageId: null, conversationKind: "chat" } : null,
    taskTool: false,
    effort: null,
    researchEntitled: false,
    connectorsRequested: input.connectorsRequested,
  });
}

test("a voice call's tools are the chat's grant for the same account, narrowed to the spoken tools", () => {
  const voiceIds = new Set<string>(VOICE_JUNO_TOOL_IDS);
  let cases = 0;
  for (const plan of PLANS) {
    for (const lockdown of [false, true]) {
      for (const approvalPolicy of ["ask_for_any_change", "always_ask", "block"] as const) {
        for (const workspace of [{}, { allowedTools: [] }, { allowedTools: ["webSearch" as const] }, { allowedTools: ["connectors" as const, "memoryRecall" as const] }]) {
          for (const saved of [false, true]) {
            for (const alevrSearch of [false, true]) {
              const input = { plan, lockdown, approvalPolicy, workspace, saved, alevrSearch, connectorsRequested: true };
              const voice = voiceToolPlan(input);
              const chat = chatPlanFor(input);
              assert.deepEqual(voice.juno, chat.juno.filter((id) => voiceIds.has(id)), JSON.stringify(input));
              assert.equal(voice.connectors, chat.connectors, JSON.stringify(input));
              cases += 1;
            }
          }
        }
      }
    }
  }
  assert.ok(cases > 500);
});

test("a paid, saved call gets search, past chats, the clock, the calculator and its apps", () => {
  const plan = voiceToolPlan({
    plan: "PRO",
    lockdown: false,
    approvalPolicy: "ask_for_any_change",
    workspace: {},
    saved: true,
    alevrSearch: true,
    connectorsRequested: true,
  });
  assert.deepEqual(plan.juno, ["web_search", "search_news", "search_chats", "current_time", "calculate"]);
  assert.equal(plan.connectors, true);
});

test("the chat's own limits hold in a call: free plans, Lockdown, a block policy, a workspace, a new chat", () => {
  const base = { plan: "PRO" as Plan, lockdown: false, approvalPolicy: "ask_for_any_change" as const, workspace: {}, saved: true, alevrSearch: true, connectorsRequested: true };
  // Connectors are a paid feature in chat, so in a call too.
  assert.equal(voiceToolPlan({ ...base, plan: "FREE" }).connectors, false);
  assert.equal(voiceToolPlan({ ...base, plan: "FREE" }).juno.includes("web_search"), false);
  // Lockdown leaves only the pure tools.
  assert.deepEqual(voiceToolPlan({ ...base, lockdown: true }), { ...voiceToolPlan({ ...base, lockdown: true }), juno: ["current_time", "calculate"], connectors: false });
  assert.equal(voiceToolPlan({ ...base, approvalPolicy: "block" }).connectors, false);
  assert.equal(voiceToolPlan({ ...base, workspace: { allowedTools: [] } }).connectors, false);
  assert.equal(voiceToolPlan({ ...base, workspace: { allowedTools: [] } }).juno.includes("search_chats"), false);
  // A chat with no row yet has no past to search from.
  assert.equal(voiceToolPlan({ ...base, saved: false }).juno.includes("search_chats"), false);
});

test("a call is never handed code execution, a task, research, page reading or file tools", () => {
  const plan = voiceToolPlan({
    plan: "OWNER",
    lockdown: false,
    approvalPolicy: "ask_for_any_change",
    workspace: {},
    saved: true,
    alevrSearch: true,
    connectorsRequested: true,
  });
  for (const id of ["run_code", "check_run", "start_task", "suggest_research", "web_fetch", "find_in_page", "read_document", "inspect_image"]) {
    assert.equal((plan.juno as string[]).includes(id), false, id);
  }
});

// ---------------------------------------------------------------------------
// 2. Write tools require confirmation
// ---------------------------------------------------------------------------

test("reads need no answer, changes wait for a yes or the card, and the irreversible wait for the card", () => {
  const expected: Record<ActionRiskClass, string> = {
    read_only: "none",
    reversible_write: "voice_or_screen",
    external_write: "voice_or_screen",
    unknown: "voice_or_screen",
    destructive_or_sensitive: "screen",
  };
  for (const [riskClass, confirm] of Object.entries(expected) as Array<[ActionRiskClass, string]>) {
    assert.equal(voiceConfirmationFor(riskClass), confirm, riskClass);
    assert.equal(spokenApprovalAllowed({ riskClass }), confirm !== "screen", riskClass);
    // The descriptor's word agrees with the broker's own rule: everything that
    // is not a read asks under the default policy, so a call asks too.
    const outcome = decideActionPolicy({ policy: "ask_for_any_change", riskClass });
    assert.equal(outcome === "ask", confirm !== "none", riskClass);
  }
});

const CALENDAR: ActiveConnector = {
  id: "gcal",
  label: "Google Calendar",
  mcpUrl: "https://mcp.calendar.example/sse",
  headers: { Authorization: `Bearer ${OAUTH}` },
};

/** A connector's tools as `openMcpToolset` exposes them; the headers stay in the connector. */
function calendarToolset(calls: Array<{ name: string; args: Record<string, unknown> }> = [], approval?: ClientActionApproval): McpToolset {
  const tools = [
    { tool: "list_events", hints: { readOnlyHint: true } },
    { tool: "create_event", hints: undefined },
    { tool: "delete_event", hints: { destructiveHint: true } },
  ];
  return {
    tools: tools.map(({ tool, hints }) => ({
      type: "function" as const,
      function: {
        name: `gcal__${tool}`,
        description: `[Google Calendar] ${tool.replace("_", " ")}`,
        parameters: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { title: { type: "string", description: "Event title" } },
          required: tool === "list_events" ? [] : ["title"],
          additionalProperties: false,
        },
      },
      ...(hints ? { annotations: hints } : {}),
    })),
    labelFor: () => "Google Calendar",
    accessFor: (name) => (name.endsWith("list_events") ? "read" : "write"),
    route: (name) => {
      const entry = tools.find(({ tool }) => `gcal__${tool}` === name);
      return entry
        ? { functionName: name, connectorId: "gcal", connectorLabel: "Google Calendar", toolName: entry.tool, annotations: entry.hints }
        : undefined;
    },
    async execute(name, args, _signal, _callId, opts) {
      calls.push({ name, args });
      if (name !== "gcal__list_events" && approval) opts?.onApprovalRequest?.(approval);
      opts?.onAuthorized?.();
      const body = name === "gcal__list_events" ? "Dentist at 9; standup at 10." : `Created "${String(args.title)}".`;
      return { text: wrapUntrusted(`Google Calendar · ${name}`, body), body, ok: true };
    },
    close: async () => {},
  };
}

async function calendarChatToolset(mcp: McpToolset) {
  return openChatToolset({
    plan: { juno: [], nativeSearch: false, connectors: true, suggestResearch: false, roundBudget: 7, notices: [], citationStyle: "links" },
    connectors: [CALENDAR],
    skipped: [],
    context: { userId: "user_1", conversationId: null, projectId: null },
    mcpContext: { userId: "user_1", surface: "voice", sessionId: "voice:s" },
    nativeTools: [],
    openMcp: async () => mcp,
  });
}

test("every tool a call lists says how it is confirmed, from the broker's classification", async () => {
  const toolset = composeVoiceToolset([], await calendarChatToolset(calendarToolset()));
  const tools = voiceToolDescriptors(toolset);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("gcal__list_events")?.confirm, "none");
  assert.equal(byName.get("gcal__create_event")?.confirm, "voice_or_screen");
  assert.equal(byName.get("gcal__delete_event")?.confirm, "screen");
  assert.match(byName.get("gcal__create_event")!.description, /waits for the person's go-ahead/);
  assert.match(byName.get("gcal__delete_event")!.description, /approve it on their screen/);
  assert.equal(byName.get("gcal__create_event")?.label, "Google Calendar · Create event");
  // Each agrees with the resolved risk the dispatcher and broker act on.
  for (const tool of tools) {
    assert.equal(voiceConfirmationFor(toActionRiskClass(toolset.resolve(tool.name)!.risk)), tool.confirm);
  }
  // Schemas are cut to the subset every voice provider takes.
  assert.equal("$schema" in byName.get("gcal__create_event")!.parameters, false);
});

test("a call carries at most the voice bound of tools, Juno's first, and refuses a name it never offered", async () => {
  const many: McpToolset = {
    ...calendarToolset(),
    tools: Array.from({ length: 50 }, (_, i) => ({
      type: "function" as const,
      function: { name: `gcal__read_${i}`, description: "x", parameters: { type: "object", properties: {} } },
      annotations: { readOnlyHint: true },
    })),
    route: (name) => ({ functionName: name, connectorId: "gcal", connectorLabel: "Google Calendar", toolName: name.slice(6), annotations: { readOnlyHint: true } }),
  };
  const { currentTimeSpec } = await import("@/lib/tools/specs/current-time");
  const toolset = composeVoiceToolset([currentTimeSpec], await calendarChatToolset(many));
  assert.equal(toolset.tools.length, VOICE_MAX_TOOLS);
  assert.equal(toolset.tools[0].function.name, "current_time");
  assert.equal(toolset.resolve("gcal__read_49"), undefined);
});

test("a result is cut for speech without opening its untrusted envelope", () => {
  const long = "x".repeat(20_000);
  const text = voiceResultText({ label: "Google Calendar · List events", text: wrapUntrusted("gcal", long), body: long, status: "succeeded" });
  assert.ok(text.length < 7_000);
  assert.equal(text.match(/JUNO_UNTRUSTED_BEGIN/g)?.length, 1);
  assert.equal(text.match(/JUNO_UNTRUSTED_END/g)?.length, 1);
  assert.match(text, /in a sentence or two of plain speech/);
  assert.match(voiceResultText({ label: "x", text: "The user declined this call.", status: "denied" }), /did not happen/);
});

test("a chip keeps a card only while its call is waiting on the person", () => {
  const approval = { id: "rcpt_1" } as ClientActionApproval;
  let list = applyVoiceToolActivity([], { type: "tool.activity", id: "c1", name: "gcal__create_event", label: "Google Calendar · Create event", status: "running" });
  list = applyVoiceToolActivity(list, { type: "tool.activity", id: "c1", name: "gcal__create_event", label: "Google Calendar · Create event", status: "awaiting_approval", approval, spoken: true });
  assert.equal(list[0].approval, approval);
  assert.equal(list[0].spoken, true);
  list = applyVoiceToolActivity(list, { type: "tool.activity", id: "c1", name: "gcal__create_event", label: "Google Calendar · Create event", status: "succeeded" });
  assert.equal(list.length, 1);
  assert.equal(list[0].approval, null);
});

// ---------------------------------------------------------------------------
// 3. Relay callback auth — the real routes, with the database and the
//    connector transport replaced by fixtures
// ---------------------------------------------------------------------------

function mint(payload: Record<string, unknown>, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
const SESSION = "0f9a2c1e-55aa-4b6e-9c1d-2d3e4f5a6b7c";
const CONVERSATION = "cm1a2b3c4d5e6f7g8h9i0jkl";
const claims = (aud: string, extra: Record<string, unknown> = {}) => ({
  uid: "user_1",
  exp: Math.floor(Date.now() / 1000) + 60,
  aud,
  sid: SESSION,
  cid: CONVERSATION,
  cx: ["gcal"],
  tz: "Europe/Amsterdam",
  ...extra,
});

test("the relay's claims are read only under their own audience, in date, for a session", () => {
  const ok = voiceToolCallerOf(claims("juno.voice.tools"), "juno.voice.tools");
  assert.deepEqual(ok, { userId: "user_1", sessionId: SESSION, conversationId: CONVERSATION, connectorIds: ["gcal"], timeZone: "Europe/Amsterdam" });
  for (const aud of ["juno.voice.spend", "juno.voice.memory", "juno.voice.persona", "juno.voice.decision", undefined]) {
    assert.equal(voiceToolCallerOf(claims("x", { aud }), "juno.voice.tools"), null, String(aud));
  }
  assert.equal(voiceToolCallerOf(claims("juno.voice.tools"), "juno.voice.spend"), null);
  assert.equal(voiceToolCallerOf(claims("juno.voice.tools", { exp: Math.floor(Date.now() / 1000) - 1 }), "juno.voice.tools"), null);
  assert.equal(voiceToolCallerOf(claims("juno.voice.tools", { sid: undefined }), "juno.voice.tools"), null);
  const odd = voiceToolCallerOf(claims("juno.voice.tools", { cid: "../x", cx: ["ok", "bad id", 7], tz: "Not a/zone/at/all/x" }), "juno.voice.tools");
  assert.deepEqual(odd && { cid: odd.conversationId, cx: odd.connectorIds, tz: odd.timeZone }, { cid: null, cx: ["ok"], tz: null });
});

test("tools are asked for by the chat, never assumed, and incognito never asks", () => {
  assert.equal(parseVoiceToolsRequest(new URLSearchParams("")), null);
  assert.equal(parseVoiceToolsRequest(new URLSearchParams("tools=true")), null);
  assert.deepEqual(parseVoiceToolsRequest(new URLSearchParams("tools=1&connectors=gcal,gmail,bad%20id&timeZone=Europe/Amsterdam")), {
    connectorIds: ["gcal", "gmail"],
    timeZone: "Europe/Amsterdam",
  });
  const token = src("src/app/api/voice/relay-token/route.ts");
  // Only while the server has voice tools on (VOICE_TOOLS_ENABLED).
  assert.match(token, /const tools = isVoiceToolsEnabled\(\) \? parseVoiceToolsRequest\(params\) : null;/);
  // The conversation is named only once it is shown to be this person's.
  assert.match(token, /\.\.\.\(conversation \? \{ cid: conversation\.id \} : \{\}\)/);
  assert.match(token, /where: \{ id: conversationId, userId \},\s+select: \{ id: true \},/);
  const chat = src("src/components/chat/chat-view.tsx");
  assert.match(chat, /privateMode\s*\?\s*undefined\s*:\s*\{[^}]*\},\s*conversationId: currentConversationId \?\? null,\s*tools: \{ connectorIds: enabledConnectors \},?\s*\}/);
});

// The fixtures behind the routes.
const decisions: Array<Record<string, unknown>> = [];
const executed: Array<{ name: string; args: Record<string, unknown> }> = [];
const pendingApproval: ClientActionApproval = {
  id: "rcpt_write",
  surface: "voice",
  sessionId: `voice:${SESSION}`,
  conversationId: CONVERSATION,
  connectorId: "gcal",
  connectorLabel: "Google Calendar",
  toolName: "create_event",
  action: "connector.gcal.create_event",
  riskClass: "external_write",
  preview: "Google Calendar wants to create event.",
  detail: { title: "Dentist", accessToken: "[redacted]" },
  receiptDigest: "digest_1",
  status: "pending",
  decision: null,
  canAllowScope: false,
  derivedFromUntrusted: true,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  decidedAt: null,
  completedAt: null,
  createdAt: new Date().toISOString(),
};
const stubs: Record<string, unknown> = {
  "server-only": {},
  "@/lib/prisma": {
    prisma: {
      user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === "user_1" ? { id: "user_1" } : null) },
      settings: { findUnique: async () => ({ lockdownMode: false, actionApprovalPolicy: "ask_for_any_change" }) },
      conversation: {
        findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === CONVERSATION && where.userId === "user_1" ? { id: CONVERSATION, projectId: null, activeConnectors: [] } : null,
      },
      projectWorkspace: { findFirst: async () => null },
    },
  },
  "@/lib/mcp": {
    getActiveConnectors: async (_userId: string, ids: string[]) => (ids.includes("gcal") ? [CALENDAR] : []),
    openMcpToolset: async () => calendarToolset(executed, pendingApproval),
  },
  "@/lib/action-approval-store": {
    authorizeExternalAction: async () => ({ kind: "authorized", receiptId: null, riskClass: "read_only" }),
    completeExternalAction: async () => undefined,
    decideActionApproval: async (input: Record<string, unknown>) => {
      decisions.push(input);
      return { ok: true, approval: pendingApproval, replay: false };
    },
  },
  "@/lib/tool-audit": { recordToolInvocation: async () => null, settleToolInvocation: async () => undefined },
  "@/lib/usage": { getUserPlan: async () => "PRO" },
  "@/lib/spend": { recordSpend: async () => true },
  "@/lib/rate-limit": { rateLimit: async () => ({ success: true, remaining: 10, resetAt: new Date() }) },
  "@/lib/project-collaboration": { checkProjectAccess: async () => ({ allowed: true }) },
  "@/lib/web/search": { chatSearchAvailable: () => false },
};
const moduleLoader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleLoader._load;
moduleLoader._load = function (request, parent, isMain) {
  if (Object.hasOwn(stubs, request)) return stubs[request];
  return originalLoad.call(this, request, parent, isMain);
};
const require = createRequire(import.meta.url);
type Handler = (req: Request) => Promise<Response>;
let toolsRoute: { GET: Handler; POST: Handler };
try {
  toolsRoute = require("../src/app/api/voice/tools/route");
} finally {
  moduleLoader._load = originalLoad;
}

const request = (path: string, token: string | null, body?: unknown) =>
  new Request(`https://juno.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// The route tests below run with the switch on; the first shows it off.
process.env.VOICE_TOOLS_ENABLED = "1";

test("with VOICE_TOOLS_ENABLED off (the default) nothing is listed or run, whatever the token", async () => {
  delete process.env.VOICE_TOOLS_ENABLED;
  try {
    const token = mint(claims("juno.voice.tools"));
    const listed = await toolsRoute.GET(request("/api/voice/tools", token));
    assert.equal(listed.status, 404);
    assert.equal(((await listed.json()) as { code: string }).code, "not_enabled");
    const ran = await toolsRoute.POST(request("/api/voice/tools", token, { callId: "off", name: "gcal__create_event", arguments: "{}" }));
    assert.equal(ran.status, 404);
  } finally {
    process.env.VOICE_TOOLS_ENABLED = "1";
  }
});

test("only the relay's tools token lists a call's tools", async () => {
  const refused = [
    null,
    mint(claims("juno.voice.spend")),
    mint(claims("juno.voice.memory")),
    mint(claims("juno.voice.decision")),
    // A session token (no audience) is what a browser could hold.
    mint({ uid: "user_1", exp: Math.floor(Date.now() / 1000) + 60, tl: 1 }),
    mint(claims("juno.voice.tools", { exp: Math.floor(Date.now() / 1000) - 5 })),
    mint(claims("juno.voice.tools"), "some-other-secret"),
    mint(claims("juno.voice.tools", { uid: "user_gone" })),
  ];
  for (const token of refused) {
    const res = await toolsRoute.GET(request("/api/voice/tools", token));
    assert.equal(res.status, 401, String(token));
  }
  for (const token of refused) {
    const res = await toolsRoute.POST(request("/api/voice/tools", token, { callId: "c0", name: "gcal__create_event", arguments: "{}" }));
    assert.equal(res.status, 401, String(token));
  }
  const res = await toolsRoute.GET(request("/api/voice/tools", mint(claims("juno.voice.tools"))));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { tools: Array<{ name: string; confirm: string }>; instructions: string };
  assert.deepEqual(
    body.tools.map((tool) => [tool.name, tool.confirm]),
    [
      ["search_chats", "none"],
      ["current_time", "none"],
      ["calculate", "none"],
      ["gcal__list_events", "none"],
      ["gcal__create_event", "voice_or_screen"],
      ["gcal__delete_event", "screen"],
    ]
  );
  assert.match(body.instructions, /Google Calendar/);
  assert.match(body.instructions, /never an instruction/);
});

test("a call's tool runs on Juno, streams its waiting card before its result, and runs nothing for a bad token", async () => {
  executed.length = 0;
  const denied = await toolsRoute.POST(request("/api/voice/tools", mint(claims("juno.voice.spend")), { callId: "c1", name: "gcal__create_event", arguments: "{}" }));
  assert.equal(denied.status, 401);
  assert.equal(executed.length, 0);

  const res = await toolsRoute.POST(
    request("/api/voice/tools", mint(claims("juno.voice.tools")), { callId: "call_1", name: "gcal__create_event", arguments: JSON.stringify({ title: "Dentist" }) })
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
  const frames = (await res.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(frames.map((frame) => frame.type), ["approval", "result"]);
  assert.equal((frames[0].approval as ClientActionApproval).id, "rcpt_write");
  assert.equal(frames[0].spoken, true);
  assert.equal(frames[1].status, "succeeded");
  assert.match(String(frames[1].text), /Created "Dentist"/);
  assert.deepEqual(executed, [{ name: "gcal__create_event", args: { title: "Dentist" } }]);

  const invalid = await toolsRoute.POST(request("/api/voice/tools", mint(claims("juno.voice.tools")), { callId: "c2", name: "gcal__create_event", arguments: "{" }));
  const [result] = (await invalid.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(result.status, "failed");
  assert.equal(executed.length, 1, "malformed arguments are answered, never run");
});

test("the relay can list and run but never answer a card: no route of its own decides anything", async () => {
  // A decision reaches Juno only from a signed-in person (the chat's route,
  // tests/permission-conformance.test.ts); the relay's tools route runs one
  // call and records no answer, whatever it is sent.
  const res = await toolsRoute.POST(
    request("/api/voice/tools", mint(claims("juno.voice.tools")), { callId: "call_2", name: "gcal__create_event", arguments: JSON.stringify({ title: "Dentist" }), decision: "allow_once", approvalId: "rcpt_write" })
  );
  await res.text();
  assert.deepEqual(decisions, []);
  for (const file of ["src/lib/voice-tools.ts", "src/lib/voice-tools-server.ts", "src/app/api/voice/tools/route.ts"]) {
    assert.doesNotMatch(src(file), /\bdecideActionApproval\s*\(/, file);
  }
});

test("a spoken answer is sent by the person's own client, through the chat's route, only for a card it shows", () => {
  const card = (riskClass: ClientActionApproval["riskClass"], spoken: boolean) =>
    applyVoiceToolActivity([], {
      type: "tool.activity",
      id: "call_1",
      name: "gcal__create_event",
      label: "Google Calendar · Create event",
      status: "awaiting_approval",
      approval: { ...pendingApproval, riskClass },
      spoken,
    });
  const yes = { type: "tool.spoken" as const, id: "call_1", approvalId: "rcpt_write", decision: "allow_once" as const };

  const answered = applySpokenAnswer(card("external_write", true), yes);
  assert.deepEqual(answered.request, {
    url: "/api/approvals/rcpt_write",
    body: { decision: "allow_once", receiptDigest: "digest_1" },
  });
  assert.equal(answered.list[0].answeredAloud, "allow_once");
  assert.equal(voiceToolStatusWord(answered.list[0]), "Approving");
  // Said twice, answered once.
  assert.equal(applySpokenAnswer(answered.list, yes).request, null);
  // A refused answer brings the card back.
  assert.equal(withdrawSpokenAnswer(answered.list, "call_1")[0].answeredAloud, null);

  // A card that takes no yes aloud is never approved by one; a no still declines it.
  assert.equal(applySpokenAnswer(card("destructive_or_sensitive", false), yes).request, null);
  assert.equal(applySpokenAnswer(card("destructive_or_sensitive", false), { ...yes, decision: "deny" }).request?.body.decision, "deny");
  // Only the approval the card shows, only while it is waiting.
  assert.equal(applySpokenAnswer(card("external_write", true), { ...yes, approvalId: "rcpt_other" }).request, null);
  assert.equal(applySpokenAnswer([], yes).request, null);
  const done = applyVoiceToolActivity(card("external_write", true), { type: "tool.activity", id: "call_1", name: "gcal__create_event", label: "x", status: "succeeded" });
  assert.equal(applySpokenAnswer(done, yes).request, null);

  // The hook posts exactly that request, with the cookie, to the chat's route.
  const hook = src("src/hooks/use-realtime-voice.ts");
  assert.match(hook, /case "tool\.spoken": \{[\s\S]*?applySpokenAnswer\(toolActivityRef\.current, msg\)[\s\S]*?fetch\(request\.url, \{\s+method: "POST",/);
  assert.match(src("src/app/api/approvals/[id]/route.ts"), /getCurrentUser\(\)/);
});

// ---------------------------------------------------------------------------
// 4. No credential in anything the relay is sent
// ---------------------------------------------------------------------------

test("a connector's token never reaches the relay: not in the list, not in a call's stream", async () => {
  const listed = await (await toolsRoute.GET(request("/api/voice/tools", mint(claims("juno.voice.tools"))))).text();
  assert.equal(listed.includes(OAUTH), false);
  assert.equal(listed.includes(CALENDAR.mcpUrl), false);
  assert.equal(/authorization|bearer/i.test(listed), false);

  const streamed = await (
    await toolsRoute.POST(
      request("/api/voice/tools", mint(claims("juno.voice.tools")), { callId: "call_9", name: "gcal__create_event", arguments: JSON.stringify({ title: "Dentist" }) })
    )
  ).text();
  assert.equal(streamed.includes(OAUTH), false);
  assert.equal(streamed.includes(CALENDAR.mcpUrl), false);
  // The approval the card shows has its credential-shaped arguments redacted already.
  assert.match(streamed, /"accessToken":"\[redacted\]"/);

  // And the source keeps it so: descriptors are built from the function list
  // and `resolve` alone, never from an ActiveConnector.
  const lib = src("src/lib/voice-tools.ts");
  const descriptors = lib.slice(lib.indexOf("export function voiceToolDescriptors"), lib.indexOf("export function voiceToolInstructions"));
  assert.equal(/headers|mcpUrl|ActiveConnector/.test(descriptors.replace(/\/\*\*[\s\S]*?\*\//g, "")), false);
});
