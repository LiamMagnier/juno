#!/usr/bin/env node
/**
 * Alevr Code v2 contract check (SPEC docs/code-v2/SPEC.md §6, lane "seam").
 *
 * The TypeScript file src/lib/code-v2/contracts.ts is the source of truth.
 * This script fails when anything derived from it drifts:
 *   1. runner/agent-core/src/contracts/code-v2.ts must be byte-identical
 *      (agent-core builds standalone, so it carries its own copy).
 *   2. contracts/code/alevr-code-v2.schema.json must equal the schema built
 *      below from the contract's value arrays.
 *   3. Every fixture in contracts/code/fixtures/*.json must validate against
 *      that schema, and every `kind`/`type` in them must be a known value.
 *   4. Every Swift enum in CodeV2Contracts.swift marked
 *      `// contract: <VALUE_ARRAY>` must list exactly those raw values, and
 *      the Swift alias table must equal CODE_MODEL_ALIASES.
 *
 *   node scripts/check-code-v2-contracts.mjs          check (exit 1 on drift)
 *   node scripts/check-code-v2-contracts.mjs --write  rewrite the runner copy and the schema
 *
 * Needs Node ≥ 22.18 (loads the .ts contract with built-in type stripping).
 */
import { readFile, writeFile, readdir, mkdir, mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv from "ajv";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(root, "src/lib/code-v2/contracts.ts");
const RUNNER_COPY = join(root, "runner/agent-core/src/contracts/code-v2.ts");
// The env server (runner/env-server) builds standalone too and carries its own byte-identical copy.
const ENV_SERVER_COPY = join(root, "runner/env-server/src/contracts/code-v2.ts");
const SCHEMA = join(root, "contracts/code/alevr-code-v2.schema.json");
const FIXTURES = join(root, "contracts/code/fixtures");
const SWIFT = join(root, "native/Packages/JunoCode/Sources/JunoCodeCore/CodeV2Contracts.swift");

const write = process.argv.includes("--write");
// Imported through a temporary .mts copy so Node treats it as an ES module
// without a "type" field in the repository's package.json.
const tmp = await mkdtemp(join(tmpdir(), "code-v2-contracts-"));
await copyFile(SOURCE, join(tmp, "contracts.mts"));
const C = await import(pathToFileURL(join(tmp, "contracts.mts")).href).finally(() => rm(tmp, { recursive: true, force: true }));

// ── Schema builder ──────────────────────────────────────────────────────────

const ref = (name) => ({ $ref: `#/definitions/${name}` });
const str = { type: "string" };
const nonEmpty = { type: "string", minLength: 1 };
const int = { type: "integer", minimum: 0 };
const num = { type: "number", minimum: 0 };
const bool = { type: "boolean" };
const iso = { type: "string", minLength: 10 };
const arr = (items) => ({ type: "array", items });
const en = (values) => ({ type: "string", enum: [...values] });
const strMap = (values) => ({ type: "object", additionalProperties: values });

/** Object with required (r) and optional (o) properties; extra keys allowed for forward compatibility. */
function obj(r, o = {}) {
  const schema = { type: "object", properties: { ...r, ...o } };
  const required = Object.keys(r);
  if (required.length) schema.required = required;
  return schema;
}

function itemSchema(kind, r, o = {}) {
  return obj(
    { id: nonEmpty, kind: { const: kind }, createdAt: iso, ...r },
    { turnId: str, ...o },
  );
}

function buildSchema() {
  const status = ref("ItemStatus");
  const definitions = {
    ProviderKind: en(C.PROVIDER_KIND_VALUES),
    ProviderStatus: en(C.PROVIDER_STATUS_VALUES),
    EffortLevel: en(C.EFFORT_LEVEL_VALUES),
    RuntimeMode: en(C.RUNTIME_MODE_VALUES),
    InteractionMode: en(C.INTERACTION_MODE_VALUES),
    RolePreset: en(C.ROLE_PRESET_VALUES),
    AgentRole: en(C.AGENT_ROLE_VALUES),
    TurnItemKind: en(C.TURN_ITEM_KIND_VALUES),
    ItemStatus: en(C.ITEM_STATUS_VALUES),
    ApprovalDecision: en(C.APPROVAL_DECISION_VALUES),
    StepStatus: en(C.STEP_STATUS_VALUES),
    ComputerActionKind: en(C.COMPUTER_ACTION_VALUES),
    SubagentStatus: en(C.SUBAGENT_STATUS_VALUES),
    TeamPhase: en(C.TEAM_PHASE_VALUES),
    SessionState: en(C.SESSION_STATE_VALUES),
    ClientCommandType: en(C.CLIENT_COMMAND_TYPE_VALUES),
    ServerEventType: en(C.SERVER_EVENT_TYPE_VALUES),
    TurnOutcome: en(C.TURN_OUTCOME_VALUES),
    WireErrorCode: en(C.WIRE_ERROR_CODE_VALUES),
    ByokProvider: en(C.BYOK_PROVIDER_VALUES),
    ProviderSetupAction: en(C.PROVIDER_SETUP_ACTION_VALUES),
    ProviderInstallPhase: en(C.PROVIDER_INSTALL_PHASE_VALUES),
    ProviderAuthPhase: en(C.PROVIDER_AUTH_PHASE_VALUES),
    ProviderInstallAction: en(C.PROVIDER_INSTALL_ACTION_VALUES),
    ProviderAuthAction: en(C.PROVIDER_AUTH_ACTION_VALUES),
    // skills lane (additive)
    SkillSource: en(C.SKILL_SOURCE_VALUES),
    SkillOrigin: en(C.SKILL_ORIGIN_VALUES),
    SkillActivation: obj(
      { name: nonEmpty, source: { $ref: "#/definitions/SkillSource" } },
      { path: nonEmpty, instructions: str, title: str, once: bool },
    ),
    LocalSkillSummary: obj(
      { name: nonEmpty, description: str, source: en(["project", "user", "plugin"]), origin: { $ref: "#/definitions/SkillOrigin" }, path: nonEmpty },
      { plugin: nonEmpty },
    ),
    ProviderInstallState: obj(
      { phase: ref("ProviderInstallPhase") },
      { operationId: nonEmpty, downloadedBytes: int, totalBytes: int, version: str, installedVersion: str, message: str },
    ),
    ProviderAuthState: obj(
      { phase: ref("ProviderAuthPhase") },
      { flowId: nonEmpty, authorizationUrl: { type: "string", pattern: "^https://" }, expiresAt: iso, message: str, method: str },
    ),

    UsageWindow: obj({ id: nonEmpty, label: nonEmpty }, { usedPct: { type: "number", minimum: 0, maximum: 100 }, resetsAt: iso }),
    ProviderAccount: obj({}, { email: str, plan: str, tokenSource: str }),
    ProviderCapabilities: obj({
      steering: bool,
      queue: bool,
      interrupt: bool,
      resume: bool,
      fork: bool,
      rollback: bool,
      planMode: bool,
      approvals: arr(ref("RuntimeMode")),
      subagents: bool,
      computerUse: bool,
      contextTiers: bool,
      effortLevels: arr(ref("EffortLevel")),
      images: bool,
      mcpInjection: bool,
    }),
    ContextTier: obj(
      { tokens: { type: "integer", minimum: 1 }, label: nonEmpty, inputPerMTok: num, outputPerMTok: num },
      { cachedInputPerMTok: num, note: str, unverified: bool },
    ),
    ProviderModel: obj(
      { id: nonEmpty, label: nonEmpty },
      {
        contextTiers: arr(ref("ContextTier")),
        effortLevels: arr(ref("EffortLevel")),
        defaultEffort: ref("EffortLevel"),
        supportsFast: bool,
        isDefault: bool,
      },
    ),
    ProviderInstance: obj(
      { id: nonEmpty, kind: ref("ProviderKind"), label: nonEmpty, status: ref("ProviderStatus") },
      {
        binaryPath: str,
        configDir: str,
        env: strMap(str),
        launchArgs: arr(str),
        acpCommand: { type: "array", items: str, minItems: 1 },
        account: ref("ProviderAccount"),
        statusMessage: str,
        version: str,
        limits: arr(ref("UsageWindow")),
        capabilities: ref("ProviderCapabilities"),
        models: arr(ref("ProviderModel")),
        checkedAt: iso,
        install: ref("ProviderInstallState"),
        auth: ref("ProviderAuthState"),
      },
    ),

    ModelSelection: obj(
      { instanceId: nonEmpty, model: nonEmpty },
      { effort: ref("EffortLevel"), contextTokens: { type: "integer", minimum: 1 }, fast: bool },
    ),
    RunBudget: obj({}, { maxTokens: { type: "integer", minimum: 1 }, maxUsd: { type: "number", exclusiveMinimum: 0 } }),
    RoleRouting: obj(
      { orchestrator: ref("ModelSelection"), preset: ref("RolePreset") },
      {
        architect: ref("ModelSelection"),
        workers: arr(ref("ModelSelection")),
        reviewer: ref("ModelSelection"),
        explorer: ref("ModelSelection"),
        compaction: ref("ModelSelection"),
        budget: ref("RunBudget"),
      },
    ),

    Attachment: obj({ name: nonEmpty, mediaType: nonEmpty, ref: nonEmpty }),
    UserInput: obj(
      { text: str },
      { attachments: arr(ref("Attachment")), conversation: ref("ConversationDelivery"), skills: arr(ref("SkillActivation")) },
    ),
    TokenCount: obj({ input: int, output: int }, { cachedInput: int }),
    PlanStep: obj({ text: str, status: ref("StepStatus") }),
    FileChangeEntry: obj(
      { path: nonEmpty, change: en(["add", "modify", "delete", "rename"]) },
      { previousPath: str, diff: str, additions: int, deletions: int },
    ),

    UserMessageItem: itemSchema(
      "user_message",
      { text: str },
      { attachments: arr(ref("Attachment")), delivery: en(["send", "steer", "queue"]), skills: arr(nonEmpty) },
    ),
    AssistantMessageItem: itemSchema("assistant_message", { text: str, streaming: bool }, { agentId: str }),
    ReasoningItem: itemSchema("reasoning", { text: str, streaming: bool }, { summary: bool }),
    PlanItem: itemSchema("plan", { text: str }, { steps: arr(ref("PlanStep")), awaitingApproval: bool }),
    TodoListItem: itemSchema("todo_list", { todos: arr(obj({ text: str, status: ref("StepStatus") }, { id: str })) }),
    UserInputRequestItem: itemSchema(
      "user_input_request",
      {
        requestId: nonEmpty,
        questions: arr(obj({ id: nonEmpty, prompt: nonEmpty }, { options: arr(str), multiSelect: bool })),
        status: en(["pending", "answered", "cancelled"]),
      },
      { answers: strMap(arr(str)) },
    ),
    FileChangeItem: itemSchema("file_change", { callId: nonEmpty, changes: arr(ref("FileChangeEntry")), status }),
    CommandExecutionItem: itemSchema(
      "command_execution",
      { callId: nonEmpty, command: nonEmpty, status },
      { cwd: str, output: str, exitCode: { type: "integer" }, durationMs: int, background: bool },
    ),
    SearchItem: itemSchema("search", { callId: nonEmpty, query: str, status }, { scope: en(["files", "content", "symbols"]), matches: int }),
    WebSearchItem: itemSchema("web_search", { callId: nonEmpty, query: str, status }, { results: arr(obj({ title: str, url: nonEmpty })) }),
    ApprovalRequestItem: itemSchema(
      "approval_request",
      {
        callId: nonEmpty,
        requestId: nonEmpty,
        action: en(["command", "file_change", "permissions", "tool", "computer"]),
        summary: nonEmpty,
        status: en(["pending", "resolved", "expired"]),
      },
      { justification: str, detail: str, options: arr(ref("ApprovalDecision")), decision: ref("ApprovalDecision"), agentId: str, agentLabel: str },
    ),
    CheckpointItem: itemSchema(
      "checkpoint",
      { checkpointId: nonEmpty, turnOrdinal: int },
      { ref: str, filesChanged: int, additions: int, deletions: int },
    ),
    InterruptItem: itemSchema("interrupt", { reason: en(["user", "limit", "budget", "error"]) }, { message: str, resumeAt: iso }),
    SystemNoticeItem: itemSchema("system_notice", { level: en(["info", "warning"]), text: nonEmpty }, { code: str }),
    ErrorItem: itemSchema("error", { message: nonEmpty }, { code: str, retryable: bool }),
    CompactionItem: itemSchema(
      "compaction",
      { beforeTokens: int, afterTokens: int },
      { strategy: en(["prune", "offload", "summarize"]), summary: str },
    ),
    HandoffItem: itemSchema("handoff", { to: ref("ModelSelection") }, { from: ref("ModelSelection"), reason: str }),
    SubagentItem: itemSchema(
      "subagent",
      { agentId: nonEmpty, role: ref("AgentRole"), model: ref("ModelSelection"), status: ref("SubagentStatus") },
      { task: str, closingText: str, tokens: ref("TokenCount"), phase: ref("TeamPhase") },
    ),
    ComputerActionItem: itemSchema(
      "computer_action",
      { callId: nonEmpty, action: ref("ComputerActionKind"), status },
      {
        target: str,
        screenshotRef: str,
        app: str,
        summary: str,
        point: obj({ x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } }),
        frameSize: obj({ width: { type: "integer", minimum: 1 }, height: { type: "integer", minimum: 1 } }),
        error: str,
        durationMs: num,
      },
    ),
    ConversationMessageItem: itemSchema(
      "conversation_message",
      {
        direction: en(C.CONVERSATION_MESSAGE_DIRECTION_VALUES),
        peerRef: nonEmpty,
        peerTitle: str,
        peerProduct: en(["chat", "code"]),
        text: str,
        hop: { type: "integer", minimum: 0 },
      },
      { chainId: nonEmpty, linkId: nonEmpty, status: en(["delivered", "queued", "failed"]) },
    ),
  };

  const itemNames = C.TURN_ITEM_KIND_VALUES.map(
    (kind) => kind.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("") + "Item",
  );
  for (const name of itemNames) {
    if (!definitions[name]) throw new Error(`schema builder has no definition for ${name}`);
  }
  definitions.TurnItem = { oneOf: itemNames.map(ref) };

  // Computer use (SPEC §3.12).
  definitions.ComputerCoordinateSpace = en(C.COMPUTER_COORDINATE_SPACE_VALUES);
  const coord = { type: "number" };
  definitions.ComputerToolArgs = obj(
    { action: ref("ComputerActionKind") },
    {
      app: str,
      x: coord,
      y: coord,
      to_x: coord,
      to_y: coord,
      element: { type: "string", pattern: "^e[0-9]{1,4}$" },
      query: str,
      text: str,
      direction: en(["up", "down", "left", "right"]),
      amount: { type: "integer", minimum: 1, maximum: 30 },
      seconds: { type: "number", minimum: 0, maximum: 30 },
      region: { type: "array", items: coord, minItems: 4, maxItems: 4 },
      path: { type: "array", items: nonEmpty, minItems: 1, maxItems: 6 },
      coordinate_space: ref("ComputerCoordinateSpace"),
    },
  );
  definitions.DesktopLockRecord = obj(
    {
      holderId: nonEmpty,
      kind: en(["code_session", "work_task", "env_server"]),
      title: str,
      pid: { type: "integer", minimum: 1 },
      acquiredAt: iso,
      heartbeatAt: iso,
    },
    { app: str },
  );
  definitions.ComputerBridgeRequest = obj(
    { id: nonEmpty, type: en(["computer.call", "computer.status", "computer.release"]), token: nonEmpty, sessionId: nonEmpty },
    { title: str, runtimeMode: ref("RuntimeMode"), callId: nonEmpty, args: ref("ComputerToolArgs") },
  );
  definitions.ComputerBridgeResponse = obj(
    { id: nonEmpty, ok: bool, text: str },
    {
      image: obj({ mediaType: nonEmpty, data: nonEmpty }),
      item: ref("ComputerActionItem"),
      missingPermissions: arr(str),
      holder: ref("DesktopLockRecord"),
      endsTurn: bool,
    },
  );

  definitions.SessionUsage = obj(
    { inputTokens: int, outputTokens: int },
    { cachedInputTokens: int, contextTokens: int, contextWindow: int, costUsd: num },
  );
  definitions.ProviderSetupStep = obj(
    { action: ref("ProviderSetupAction"), command: nonEmpty, label: nonEmpty },
    { note: str, url: str },
  );
  definitions.SessionSummary = obj(
    { id: nonEmpty, cwd: nonEmpty, state: ref("SessionState"), selection: ref("ModelSelection"), updatedAt: iso, lastSequence: int },
    { title: str, parentSessionId: nonEmpty },
  );
  definitions.QueuedInput = obj({ id: nonEmpty, input: ref("UserInput"), queuedAt: iso });
  definitions.ScheduledResume = obj({ id: nonEmpty, at: iso, createdAt: iso }, { input: ref("UserInput") });
  definitions.SessionSnapshot = obj(
    {
      id: nonEmpty,
      cwd: nonEmpty,
      selection: ref("ModelSelection"),
      runtimeMode: ref("RuntimeMode"),
      interactionMode: ref("InteractionMode"),
      state: ref("SessionState"),
      items: arr(ref("TurnItem")),
      queue: arr(ref("QueuedInput")),
    },
    {
      title: str,
      routing: ref("RoleRouting"),
      activeTurnId: str,
      resumeAt: iso,
      usage: ref("SessionUsage"),
      worktree: obj({ path: nonEmpty, branch: nonEmpty, repoRoot: nonEmpty }),
      scheduledResume: ref("ScheduledResume"),
      crossMessages: en(["on", "off"]),
      skills: arr(ref("SkillActivation")),
    },
  );

  // Client commands.
  const sid = { sessionId: nonEmpty };
  const params = {
    "session.open": obj(
      { cwd: nonEmpty },
      { sessionId: nonEmpty, selection: ref("ModelSelection"), afterSequence: int, worktree: bool },
    ),
    "turn.start": obj(
      {
        ...sid,
        input: ref("UserInput"),
        selection: ref("ModelSelection"),
        runtimeMode: ref("RuntimeMode"),
        interactionMode: ref("InteractionMode"),
      },
      { routing: ref("RoleRouting") },
    ),
    "turn.steer": obj({ ...sid, turnId: nonEmpty, input: ref("UserInput") }),
    "turn.queue": obj({ ...sid, input: ref("UserInput") }),
    "turn.interrupt": obj(sid, { turnId: nonEmpty }),
    "approval.respond": obj(
      { ...sid, requestId: nonEmpty, decision: ref("ApprovalDecision") },
      { updatedInput: { type: "object" }, answers: strMap(arr(str)) },
    ),
    "checkpoint.rollback": obj({ ...sid, checkpointId: nonEmpty }),
    "provider.probe": obj({ instanceId: nonEmpty }),
    "provider.list": obj({}),
    "terminal.open": obj(
      { cwd: nonEmpty, cols: { type: "integer", minimum: 1 }, rows: { type: "integer", minimum: 1 } },
      { terminalId: nonEmpty, command: str },
    ),
    "terminal.write": obj({ terminalId: nonEmpty, data: str }),
    "terminal.resize": obj({ terminalId: nonEmpty, cols: { type: "integer", minimum: 1 }, rows: { type: "integer", minimum: 1 } }),
    "terminal.close": obj({ terminalId: nonEmpty }),
    "checkpoint.diff": obj(sid, { checkpointId: nonEmpty }),
    "provider.setup": obj({ instanceId: nonEmpty, action: ref("ProviderSetupAction") }),
    "session.list": obj({}, { cwd: nonEmpty, query: str, limit: { type: "integer", minimum: 1 } }),
    "session.close": obj(sid),
    "env.configure": obj(
      {},
      {
        backend: obj(
          { baseUrl: nonEmpty, authorization: nonEmpty },
          {
            models: arr(
              obj(
                { provider: nonEmpty, kind: en(["anthropic", "openai"]), model: nonEmpty, label: nonEmpty, available: bool },
                { providerName: str, contextWindow: int, api: en(["chat", "responses"]) },
              ),
            ),
            deviceId: nonEmpty,
            crossMessages: bool,
          },
        ),
        byok: arr(obj({ provider: nonEmpty, apiKey: nonEmpty }, { baseUrl: str })),
      },
    ),
    "checkpoint.applyPatch": obj({ ...sid, patch: nonEmpty }, { reverse: bool, checkOnly: bool }),
    "turn.schedule": obj(sid, { at: iso, input: ref("UserInput") }),
    "turn.unschedule": obj(sid, { scheduleId: nonEmpty }),
    "provider.install": obj({ instanceId: nonEmpty, action: ref("ProviderInstallAction") }, { operationId: nonEmpty }),
    "provider.auth": obj(
      { instanceId: nonEmpty, action: ref("ProviderAuthAction") },
      { flowId: nonEmpty, callbackUrl: { type: "string", minLength: 1, maxLength: 16384 } },
    ),
  };
  params["conversation.deliver"] = obj({
    ...sid,
    message: ref("ConversationDelivery"),
  });
  definitions.ConversationDelivery = obj(
    {
      fromRef: nonEmpty,
      fromTitle: str,
      fromProduct: en(["chat", "code"]),
      text: nonEmpty,
      hop: { type: "integer", minimum: 0 },
      chainId: nonEmpty,
    },
    { linkId: nonEmpty, notifyWhenIdle: bool, notice: bool },
  );
  params["conversation.read"] = obj(sid, { lastN: { type: "integer", minimum: 1 } });
  params["conversation.toggle"] = obj({ ...sid, enabled: { type: ["boolean", "null"] } });
  params["skills.list"] = obj({}, { cwd: nonEmpty, sessionId: nonEmpty });
  // remote lane (docs/code-v2/REMOTE-CONTROL.md)
  definitions.FsEntryKind = en(C.FS_ENTRY_KIND_VALUES);
  definitions.RemoteCaptureTarget = en(C.REMOTE_CAPTURE_TARGET_VALUES);
  params["fs.list"] = obj({ path: nonEmpty }, { files: bool, showHidden: bool });
  params["git.status"] = obj({}, { sessionId: nonEmpty, cwd: nonEmpty });
  params["git.commit"] = obj({ ...sid, message: nonEmpty });
  params["git.push"] = obj(sid);
  params["git.pr"] = obj({ ...sid, title: nonEmpty }, { body: str, draft: bool, base: nonEmpty });
  params["host.info"] = obj({});
  params["host.capture"] = obj({ target: ref("RemoteCaptureTarget") });
  for (const t of C.CLIENT_COMMAND_TYPE_VALUES) if (!params[t]) throw new Error(`no params schema for ${t}`);
  definitions.ClientCommand = {
    oneOf: C.CLIENT_COMMAND_TYPE_VALUES.map((t) => obj({ id: nonEmpty, type: { const: t }, params: params[t] })),
  };

  definitions.ServerResponse = {
    oneOf: [
      obj({ type: { const: "response" }, id: nonEmpty, ok: { const: true } }, { result: {} }),
      obj({
        type: { const: "response" },
        id: nonEmpty,
        ok: { const: false },
        error: obj({ code: ref("WireErrorCode"), message: str }),
      }),
    ],
  };

  const payloads = {
    "session.snapshot": { snapshotSequence: int, session: ref("SessionSnapshot") },
    "session.state": [{ state: ref("SessionState") }, { resumeAt: iso, message: str }],
    "turn.started": { turnId: nonEmpty, selection: ref("ModelSelection") },
    "turn.completed": [{ turnId: nonEmpty, outcome: ref("TurnOutcome") }, { usage: ref("SessionUsage") }],
    "item.added": { item: ref("TurnItem") },
    "item.updated": { item: ref("TurnItem") },
    "item.delta": { itemId: nonEmpty, field: en(["text", "output"]), append: str },
    "queue.updated": { queue: arr(ref("QueuedInput")) },
    "usage.updated": { usage: ref("SessionUsage") },
    "provider.updated": { instance: ref("ProviderInstance") },
    "terminal.output": { terminalId: nonEmpty, data: str },
    "terminal.exited": [{ terminalId: nonEmpty }, { exitCode: { type: "integer" } }],
    "session.scheduled": [{}, { scheduledResume: ref("ScheduledResume") }],
  };
  for (const t of C.SERVER_EVENT_TYPE_VALUES) if (!payloads[t]) throw new Error(`no payload schema for ${t}`);
  definitions.ServerEvent = {
    oneOf: C.SERVER_EVENT_TYPE_VALUES.map((t) => {
      const [r, o] = Array.isArray(payloads[t]) ? payloads[t] : [payloads[t], {}];
      return obj({ type: { const: t }, ...r }, o);
    }),
  };
  definitions.ServerEventEnvelope = obj(
    { type: { const: "event" }, stream: en(["session", "global"]), sequence: int, at: iso, event: ref("ServerEvent") },
    { sessionId: nonEmpty },
  );
  definitions.ServerMessage = { oneOf: [ref("ServerResponse"), ref("ServerEventEnvelope")] };

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://alevr.com/contracts/code/alevr-code-v2.schema.json",
    title: "Alevr Code v2 contracts",
    description:
      "GENERATED by scripts/check-code-v2-contracts.mjs --write from src/lib/code-v2/contracts.ts. Do not edit. " +
      `Protocol ${C.CODE_V2_PROTOCOL.name} ${C.CODE_V2_PROTOCOL.major}.${C.CODE_V2_PROTOCOL.minor}.`,
    definitions,
    modelAliases: { ...C.CODE_MODEL_ALIASES },
  };
}

// ── Checks ──────────────────────────────────────────────────────────────────

const failures = [];
const fail = (msg) => failures.push(msg);

// 1. Runner copy.
const source = await readFile(SOURCE, "utf8");
if (write) {
  await mkdir(dirname(RUNNER_COPY), { recursive: true });
  await writeFile(RUNNER_COPY, source);
} else {
  const copy = await readFile(RUNNER_COPY, "utf8").catch(() => null);
  if (copy !== source) fail(`${RUNNER_COPY} differs from ${SOURCE} (run with --write)`);
}
if (write) {
  await mkdir(dirname(ENV_SERVER_COPY), { recursive: true });
  await writeFile(ENV_SERVER_COPY, source);
} else {
  const copy = await readFile(ENV_SERVER_COPY, "utf8").catch(() => null);
  if (copy !== source) fail(`${ENV_SERVER_COPY} differs from ${SOURCE} (run with --write)`);
}

// 2. Schema.
const schema = buildSchema();
const schemaText = JSON.stringify(schema, null, 2) + "\n";
if (write) {
  await mkdir(dirname(SCHEMA), { recursive: true });
  await writeFile(SCHEMA, schemaText);
} else {
  const onDisk = await readFile(SCHEMA, "utf8").catch(() => null);
  if (onDisk !== schemaText) fail(`${SCHEMA} is stale (run with --write)`);
}

// 3. Fixtures. Each file is {"$def": "<definition>", "cases": [...]}.
const ajv = new Ajv({ allErrors: true });
ajv.addSchema(schema, "code-v2");
const fixtureFiles = (await readdir(FIXTURES).catch(() => [])).filter((f) => f.endsWith(".json")).sort();
if (fixtureFiles.length === 0) fail(`no fixtures in ${FIXTURES}`);
const seenKinds = new Set();
const seenCommands = new Set();
const seenEvents = new Set();
for (const file of fixtureFiles) {
  const fixture = JSON.parse(await readFile(join(FIXTURES, file), "utf8"));
  const def = fixture.$def;
  if (!def || !schema.definitions[def]) {
    fail(`${file}: "$def" must name a schema definition (got ${JSON.stringify(def)})`);
    continue;
  }
  if (!Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    fail(`${file}: "cases" must be a non-empty array`);
    continue;
  }
  if (fixture.aliases !== undefined &&
    JSON.stringify(Object.entries(fixture.aliases).sort()) !== JSON.stringify(Object.entries(C.CODE_MODEL_ALIASES).sort())) {
    fail(`${file}: "aliases" differ from CODE_MODEL_ALIASES`);
  }
  const validate = ajv.getSchema(`code-v2#/definitions/${def}`);
  fixture.cases.forEach((value, i) => {
    if (!validate(value)) fail(`${file}[${i}] is not a valid ${def}: ${ajv.errorsText(validate.errors)}`);
  });
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (typeof v.kind === "string" && C.isTurnItemKind(v.kind) && typeof v.createdAt === "string") seenKinds.add(v.kind);
    if (typeof v.type === "string" && v.params) seenCommands.add(v.type);
    if (v.type === "event" && v.event) seenEvents.add(v.event.type);
    Object.values(v).forEach(walk);
  };
  walk(fixture.cases);
}
for (const k of C.TURN_ITEM_KIND_VALUES) if (!seenKinds.has(k)) fail(`no fixture covers turn item "${k}"`);
for (const t of C.CLIENT_COMMAND_TYPE_VALUES) if (!seenCommands.has(t)) fail(`no fixture covers command "${t}"`);
for (const t of C.SERVER_EVENT_TYPE_VALUES) if (!seenEvents.has(t)) fail(`no fixture covers event "${t}"`);

// 3b. The snapshot + cursor rule (classifyEvent): a snapshot older than the
// cursor never applies (it would roll the thread back).
const snap = (n) => ({ sequence: n, event: { type: "session.snapshot", snapshotSequence: n, session: {} } });
const delta = (n) => ({ sequence: n, event: { type: "item.delta", itemId: "i", field: "text", append: "x" } });
const classifyCases = [
  [null, snap(4), "apply"],
  [7, snap(7), "apply"],
  [7, snap(9), "apply"],
  [7, snap(3), "duplicate"],
  [7, delta(8), "apply"],
  [7, delta(7), "duplicate"],
  [7, delta(9), "gap"],
  [null, delta(1), "gap"],
];
for (const [cursor, envelope, expected] of classifyCases) {
  const got = C.classifyEvent(cursor, envelope);
  if (got !== expected) fail(`classifyEvent(${cursor}, ${envelope.event.type}@${envelope.sequence}) is ${got}, expected ${expected}`);
}

// 4. Swift mirror.
const swift = await readFile(SWIFT, "utf8").catch(() => null);
if (swift === null) {
  fail(`${SWIFT} is missing`);
} else {
  const marker = /\/\/ contract: ([A-Z_]+_VALUES)\n[^{]*\{([\s\S]*?)\n\s*\}/g;
  const checked = new Set();
  for (const [, name, body] of swift.matchAll(marker)) {
    checked.add(name);
    const expected = C[name];
    if (!Array.isArray(expected)) {
      fail(`Swift marks unknown contract array ${name}`);
      continue;
    }
    const raw = [...body.matchAll(/^\s*case\s+`?(\w+)`?(?:\s*=\s*"([^"]*)")?\s*$/gm)].map(([, c, r]) => r ?? c);
    if (JSON.stringify(raw) !== JSON.stringify([...expected])) {
      fail(`Swift ${name} is ${JSON.stringify(raw)}, contract is ${JSON.stringify([...expected])}`);
    }
  }
  for (const name of Object.keys(C).filter((k) => k.endsWith("_VALUES"))) {
    if (!checked.has(name)) fail(`Swift CodeV2Contracts.swift has no enum marked "// contract: ${name}"`);
  }
  // The Swift classify must carry the same stale-snapshot rule.
  const classify = swift.match(/\/\/ contract: classifyEvent\n([\s\S]*?)\n {4}\}/);
  if (!classify) fail("Swift has no function marked // contract: classifyEvent");
  else if (!/snapshotSequence[^\n]*<\s*cursor|sequence[^\n]*<\s*cursor/.test(classify[1]) || !/\.duplicate/.test(classify[1])) {
    fail("Swift classify does not refuse a snapshot older than the cursor");
  }
  // Every RoleRouting role the schema knows (the Architect included) must be a
  // property of the Swift RoleRouting, or a Mac client drops it on decode.
  const routingStruct = swift.match(/public struct RoleRouting: [^{]*\{([\s\S]*?)\n {8}public init/);
  if (!routingStruct) {
    fail("Swift has no struct RoleRouting");
  } else {
    const props = new Set([...routingStruct[1].matchAll(/public var (\w+):/g)].map(([, n]) => n));
    for (const key of Object.keys(schema.definitions.RoleRouting.properties)) {
      if (!props.has(key)) fail(`Swift RoleRouting has no "${key}" (the contract's RoleRouting does)`);
    }
  }
  const subagentStruct = swift.match(/public struct Subagent: [^{]*\{([\s\S]*?)\n {8}public struct Candidate/);
  if (!subagentStruct || !/public var phase: TeamPhase\?/.test(subagentStruct[1])) fail('Swift Subagent has no "phase: TeamPhase?"');
  const aliasBlock = swift.match(/\/\/ contract: CODE_MODEL_ALIASES\n[^\[]*\[([\s\S]*?)\n\s*\]/);
  if (!aliasBlock) {
    fail("Swift has no table marked // contract: CODE_MODEL_ALIASES");
  } else {
    const pairs = Object.fromEntries([...aliasBlock[1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map(([, k, v]) => [k, v]));
    if (JSON.stringify(Object.entries(pairs).sort()) !== JSON.stringify(Object.entries(C.CODE_MODEL_ALIASES).sort())) {
      fail(`Swift model aliases ${JSON.stringify(pairs)} differ from CODE_MODEL_ALIASES`);
    }
  }
}

if (failures.length) {
  console.error(`code-v2 contracts: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `code-v2 contracts ${write ? "written" : "in sync"}: runner copy, schema (${Object.keys(schema.definitions).length} definitions), ` +
    `${fixtureFiles.length} fixture files, Swift mirror.`,
);
