import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AGENT_CONFIG_TOOL_LABELS,
  AGENT_CONFIG_TOOL_NAMES,
  AGENT_GOAL_TOOL,
  AGENT_MEMORY_TOOL,
  AGENT_ROUTINE_TOOL,
  CREATE_AGENT_TOOL,
  PAUSED_CONFIG_REFUSAL_MESSAGE,
  UNTRUSTED_CONFIG_REFUSAL_MESSAGE,
  UPDATE_AGENT_TOOL,
  chatAgentConfigToolsEnabled,
  classifyAgentConfigApproval,
  createAgentConfigTools,
  describeAgentPatchChanges,
  isStaleAgentApproval,
  summarizeAgentConfigToolInput,
  type AgentSnapshotForConfig,
} from "@/lib/chat/agent-config-tools";
import { actionPreview, classifyExternalAction } from "@/lib/action-approval";

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), "utf8");

const SNAPSHOT: AgentSnapshotForConfig = {
  id: "agent_scout",
  name: "Scout",
  role: "Research & briefings",
  style: "warm",
  instructions: "Watch primary sources and summarize weekly.",
  approvalMode: "balanced",
  notify: "results",
  proactive: false,
  status: "active",
  model: null,
  reasoningEffort: null,
  connectorIds: ["github"],
  computerEnabled: false,
};

test("tool definitions and gate cover normal chat and agent threads", () => {
  assert.deepEqual(AGENT_CONFIG_TOOL_NAMES, [
    "create_agent",
    "update_agent",
    "agent_goal",
    "agent_routine",
    "agent_memory",
  ]);
  for (const name of AGENT_CONFIG_TOOL_NAMES) {
    assert.ok(AGENT_CONFIG_TOOL_LABELS[name].length > 0);
  }
  assert.equal(CREATE_AGENT_TOOL.function.name, "create_agent");
  assert.equal(UPDATE_AGENT_TOOL.function.name, "update_agent");
  assert.equal(AGENT_GOAL_TOOL.function.name, "agent_goal");
  assert.equal(AGENT_ROUTINE_TOOL.function.name, "agent_routine");
  assert.equal(AGENT_MEMORY_TOOL.function.name, "agent_memory");

  const baseGate = {
    privateMode: false,
    voiceMode: false,
    regenerate: false,
    userMessageId: "msg_123",
    researchActive: false,
    artifactEdit: false,
    conversationKind: "chat",
    agenticTools: true,
    functionToolsReachModel: true,
    skillPermits: true,
    lockdown: false,
  };
  assert.equal(chatAgentConfigToolsEnabled(baseGate), true);
  assert.equal(chatAgentConfigToolsEnabled({ ...baseGate, privateMode: true }), false);
  assert.equal(chatAgentConfigToolsEnabled({ ...baseGate, voiceMode: true }), false);
  assert.equal(chatAgentConfigToolsEnabled({ ...baseGate, lockdown: true }), false);
  assert.equal(chatAgentConfigToolsEnabled({ ...baseGate, userMessageId: null }), false);

  const normalChatTools = createAgentConfigTools({
    user: { id: "u1" },
    conversation: { id: "c1", projectId: null },
    agent: null,
    userMessageId: "m1",
    untrustedContent: false,
    generationId: "g1",
  });
  assert.deepEqual(
    normalChatTools.map((t) => t.tool.function.name),
    ["create_agent", "update_agent"]
  );

  const agentThreadTools = createAgentConfigTools({
    user: { id: "u1" },
    conversation: { id: "c1", projectId: null },
    agent: SNAPSHOT,
    userMessageId: "m1",
    untrustedContent: false,
    generationId: "g1",
  });
  assert.deepEqual(
    agentThreadTools.map((t) => t.tool.function.name),
    ["update_agent", "agent_goal", "agent_routine", "agent_memory", "create_agent"]
  );

  // RULES.md §5: flat schemas only (no nested objects, no additionalProperties, every property has a description)
  for (const def of [CREATE_AGENT_TOOL, UPDATE_AGENT_TOOL, AGENT_GOAL_TOOL, AGENT_ROUTINE_TOOL, AGENT_MEMORY_TOOL]) {
    assert.ok(def.function.name.length <= 64);
    const params = def.function.parameters as Record<string, unknown>;
    assert.equal(params.additionalProperties, undefined, `${def.function.name} must not set additionalProperties`);
    const props = (params.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [propName, propSchema] of Object.entries(props)) {
      assert.notEqual(propSchema.type, "object", `${def.function.name}.${propName} must not be a nested object`);
      assert.ok(
        typeof propSchema.description === "string" && propSchema.description.length > 0,
        `${def.function.name}.${propName} must have a description`
      );
    }
  }
});

test("prompt injection defense: untrustedContentInTurn immediately refuses every config tool", async () => {
  const agentTools = createAgentConfigTools({
    user: { id: "u1" },
    conversation: { id: "c1", projectId: null },
    agent: SNAPSHOT,
    userMessageId: "m1",
    untrustedContent: true,
    generationId: "g1",
  });

  for (const tool of agentTools) {
    const res = await tool.execute({ name: "Injected", action: "add", title: "x", content: "y" });
    assert.equal(res.ok, false, tool.tool.function.name);
    const parsed = JSON.parse(res.text);
    assert.equal(parsed.status, "refused");
    assert.equal(parsed.reason, "untrusted_content_in_turn");
    assert.equal(parsed.message, UNTRUSTED_CONFIG_REFUSAL_MESSAGE);
  }

  const normalTools = createAgentConfigTools({
    user: { id: "u1" },
    conversation: { id: "c1", projectId: null },
    agent: null,
    userMessageId: "m1",
    untrustedContent: true,
    generationId: "g1",
  });
  const createRes = await normalTools[0].execute({ name: "Mole", role: "Exfil" });
  assert.equal(createRes.ok, false);
  assert.equal(JSON.parse(createRes.text).reason, "untrusted_content_in_turn");
});

test("paused agent check: start_task, hand_off_to_teammate and config tools refuse when paused, except resuming self", async () => {
  const { createStartTaskTool } = await import("@/lib/chat/task-tool");
  const { createHandoffTool } = await import("@/lib/chat/handoff-tool");

  const startTaskTool = createStartTaskTool({
    user: { id: "u1" },
    conversation: { id: "c1", projectId: null },
    userMessageId: "m1",
    userRequest: "Run research",
    model: "anthropic:claude-sonnet-4-5",
    skillSlug: null,
    reasoningEffort: undefined,
    attachmentIds: [],
    connectorIds: [],
    untrustedContent: false,
    agent: { id: "agent_scout", approvalMode: "balanced", status: "paused" },
    generationId: "g1",
  });
  const taskRes = await startTaskTool.execute({ title: "Research", goal: "Check competitors" });
  assert.equal(taskRes.ok, false);
  assert.equal(JSON.parse(taskRes.text).reason, "agent_paused");

  const handoffTool = createHandoffTool({
    user: { id: "u1" },
    conversation: { id: "c1", projectId: null },
    fromAgent: { id: "agent_scout", name: "Scout", status: "paused" },
    userMessageId: "m1",
    userRequest: "Pass to Atlas",
    untrustedContent: false,
    generationId: "g1",
  });
  const handoffRes = await handoffTool.execute({
    teammate: "Atlas",
    title: "Inbox check",
    goal: "Review unread threads",
  });
  assert.equal(handoffRes.ok, false);
  assert.equal(JSON.parse(handoffRes.text).reason, "agent_paused");

  // Source check on agent-config-tools: only status === "active" bypasses paused refusal
  const source = read("../src/lib/chat/agent-config-tools.ts");
  assert.match(source, /const isResumingSelf =\s*toolName === UPDATE_AGENT_TOOL_NAME && rawArgs\.status === "active";/);
  assert.match(source, /if \(freshAgent\.status !== "active" && !isResumingSelf\)/);
  assert.ok(PAUSED_CONFIG_REFUSAL_MESSAGE.includes("paused"));
});

test("approval classification: cost and authority changes require approval; benign edits apply immediately", () => {
  // Benign edits do not require approval
  assert.equal(
    classifyAgentConfigApproval("update_agent", { style: "direct", notify: "needs_you" }, SNAPSHOT).requiresApproval,
    false
  );
  assert.equal(
    classifyAgentConfigApproval("update_agent", { status: "paused" }, SNAPSHOT).requiresApproval,
    false
  );
  assert.equal(
    classifyAgentConfigApproval("agent_goal", { action: "add", title: "Watch pricing" }, SNAPSHOT).requiresApproval,
    false
  );
  assert.equal(
    classifyAgentConfigApproval("agent_memory", { action: "remember", content: "Prefers tables" }, SNAPSHOT).requiresApproval,
    false
  );
  assert.equal(
    classifyAgentConfigApproval("agent_routine", { action: "pause", name: "Weekly digest" }, SNAPSHOT).requiresApproval,
    false
  );

  // Adding a routine requires create_routine approval
  const addRoutine = classifyAgentConfigApproval(
    "agent_routine",
    { action: "add", name: "Monday brief", cadence: "weekly", hour: 8, minute: 0 },
    SNAPSHOT,
    "Europe/Paris"
  );
  assert.equal(addRoutine.requiresApproval, true);
  assert.equal(addRoutine.ruleName, "create_routine");
  assert.match(addRoutine.changes[0]?.to ?? "", /08:00 \(Europe\/Paris\)/);

  // Raising autonomy requires raise_autonomy approval
  const raiseAutonomy = classifyAgentConfigApproval(
    "update_agent",
    { approvalMode: "permissive" },
    SNAPSHOT
  );
  assert.equal(raiseAutonomy.requiresApproval, true);
  assert.equal(raiseAutonomy.ruleName, "raise_autonomy");
  assert.deepEqual(raiseAutonomy.changes, [
    { label: "Autonomy", from: "Ask before risky steps", to: "Just do it" },
  ]);

  // Enabling computer requires enable_computer approval
  const enableComputer = classifyAgentConfigApproval(
    "update_agent",
    { computer: { enabled: true } },
    SNAPSHOT
  );
  assert.equal(enableComputer.requiresApproval, true);
  assert.equal(enableComputer.ruleName, "enable_computer");
  assert.deepEqual(enableComputer.changes, [
    { label: "Computer", from: "Off", to: "Enabled" },
  ]);

  // Adding new connectors requires add_connectors approval
  const addConnectors = classifyAgentConfigApproval(
    "update_agent",
    { connectorIds: ["github", "notion"] },
    SNAPSHOT
  );
  assert.equal(addConnectors.requiresApproval, true);
  assert.equal(addConnectors.ruleName, "add_connectors");

  // All juno_agents rules and all 5 tool names classify as external_write in action-approval.ts
  for (const rule of [
    "create_routine",
    "enable_computer",
    "reset_computer",
    "disable_computer",
    "raise_autonomy",
    "add_connectors",
    "change_model",
    ...AGENT_CONFIG_TOOL_NAMES,
  ]) {
    const classified = classifyExternalAction({ connectorId: "juno_agents", toolName: rule, args: { role: "admin", key: "val" } });
    assert.equal(classified.riskClass, "external_write", rule);
  }

  // Stale card detection binds approval to updatedAt
  const t0 = new Date("2026-09-27T08:00:00.000Z");
  const t1 = new Date("2026-09-27T08:00:05.000Z");
  assert.equal(isStaleAgentApproval(t0, t0), false);
  assert.equal(isStaleAgentApproval(t0, t1), true);
});

test("actionPreview and approval-card render structured juno_agents diffs with Deny first and Allow once", () => {
  const preview = actionPreview({
    connectorId: "juno_agents",
    connectorLabel: "Agents",
    toolName: "create_routine",
    riskClass: "external_write",
    args: {
      preview: {
        headline: "Scout wants to add a recurring routine",
        changes: [{ label: "Routine", to: "Every Monday at 08:00 (Europe/Paris)" }],
      },
    },
  });
  assert.equal(preview, "Scout wants to add a recurring routine.");

  const cardSource = read("../src/components/chat/approval-card.tsx");
  assert.match(cardSource, /function isAgentConfig\(/);
  assert.match(cardSource, /approval\.connectorId === "juno_agents"/);
  assert.match(cardSource, /agentConfig \? "Not now" : "Don’t allow"/);
  assert.match(cardSource, /canAllowScope && !agentConfig/);
});

test("describeAgentPatchChanges, summarizeAgentConfigToolInput, serializer whitelist and privacy of note events", () => {
  const diffs = describeAgentPatchChanges(SNAPSHOT, {
    style: "direct",
    notify: "needs_you",
    computer: { enabled: true },
  });
  assert.deepEqual(diffs, [
    { label: "Style", from: "Warm", to: "Direct" },
    { label: "Notifications", from: "When a task finishes or needs you", to: "Only when it needs you" },
    { label: "Computer", from: "Off", to: "Enabled" },
  ]);

  assert.equal(
    summarizeAgentConfigToolInput("create_agent", JSON.stringify({ name: "Ledger" })),
    "Hire Ledger"
  );
  assert.equal(
    summarizeAgentConfigToolInput("agent_memory", JSON.stringify({ action: "remember", content: "secret" })),
    "Remember note"
  );

  // Serializer whitelists agentChange on ClientActivityEvent
  const serializerSource = read("../src/lib/serializers.ts");
  assert.match(serializerSource, /const agentChange = readAgentChange\(record\.agentChange\);/);
  assert.match(serializerSource, /\.\.\.\(agentChange \? \{ agentChange \} : \{\}\),/);

  // Store undo records noteId, never plaintext note content in AgentEvent.detail
  const storeSource = read("../src/lib/agents/store.ts");
  assert.match(storeSource, /before: \{ __entity: "note_created", noteId: note\.id \}/);
  assert.match(storeSource, /before: \{ __entity: "note_deleted", noteId \}/);
});
