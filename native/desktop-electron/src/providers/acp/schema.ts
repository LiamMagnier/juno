/**
 * Agent Client Protocol — wire schemas.
 *
 * TARGET: ACP **protocol version 1** (the integer sent as `protocolVersion` in
 * `initialize`). Derived from the generated types and `schema/schema.json`
 * shipped inside the official TypeScript SDK, `@agentclientprotocol/sdk@1.3.0`
 * (`dist/schema/types.gen.d.ts`, `PROTOCOL_VERSION = 1`), cross-checked against
 * https://agentclientprotocol.com/protocol/overview. The SDK also ships an
 * *unstable* `schema/v2/schema.unstable.json`; Juno deliberately targets v1,
 * because v1 is what every agent in the public registry currently speaks.
 *
 * These schemas are not a re-typing of the SDK for its own sake. Everything on
 * this wire arrives from a separate OS process that Juno did not write and, per
 * THREAT_MODEL.md, must treat as hostile. TypeScript types are erased at
 * runtime; these are not. Nothing reaches the adapter unvalidated.
 *
 * Two deliberate choices:
 *
 *   - **Loose objects, not strict.** ACP agents ship ahead of the spec and add
 *     fields (and every object carries an open `_meta`). Stripping unknown keys
 *     would silently discard data an agent considers meaningful; rejecting them
 *     would break Juno against a newer agent. Unknown keys pass through.
 *   - **Only what Juno sends or reads.** ACP v1 also defines `nes/*` (next-edit
 *     suggestions), `document/did*` text-sync, `providers/*` and MCP proxying.
 *     Juno neither sends nor consumes those, so they are not modelled — an
 *     inbound request for one gets a clean "method not found" rather than a
 *     half-implemented handler.
 */

import { z } from 'zod';

/** The `protocolVersion` integer Juno negotiates. */
export const ACP_PROTOCOL_VERSION = 1;

/** Provenance marker, so a future reader can re-derive these. */
export const ACP_SCHEMA_SOURCE = '@agentclientprotocol/sdk@1.3.0 (schema/schema.json, PROTOCOL_VERSION=1)';

/* -------------------------------------------------------------------------- */
/* Method names — verbatim from the SDK's AGENT_METHODS / CLIENT_METHODS       */
/* -------------------------------------------------------------------------- */

/** Client -> agent. Juno sends these. */
export const AGENT_METHODS = {
  initialize: 'initialize',
  authenticate: 'authenticate',
  sessionNew: 'session/new',
  sessionLoad: 'session/load',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionSetMode: 'session/set_mode',
  sessionSetConfigOption: 'session/set_config_option',
  sessionList: 'session/list',
  sessionResume: 'session/resume',
  sessionFork: 'session/fork',
  sessionClose: 'session/close',
  sessionDelete: 'session/delete',
  logout: 'logout',
} as const;

/** Agent -> client. Juno answers these. */
export const CLIENT_METHODS = {
  sessionUpdate: 'session/update',
  sessionRequestPermission: 'session/request_permission',
  fsReadTextFile: 'fs/read_text_file',
  fsWriteTextFile: 'fs/write_text_file',
  terminalCreate: 'terminal/create',
  terminalOutput: 'terminal/output',
  terminalRelease: 'terminal/release',
  terminalWaitForExit: 'terminal/wait_for_exit',
  terminalKill: 'terminal/kill',
  elicitationCreate: 'elicitation/create',
  elicitationComplete: 'elicitation/complete',
} as const;

/** Transport-level, either direction. */
export const PROTOCOL_METHODS = { cancelRequest: '$/cancel_request' } as const;

/* -------------------------------------------------------------------------- */
/* JSON-RPC 2.0 envelope                                                       */
/* -------------------------------------------------------------------------- */

export const JsonRpcIdSchema = z.union([z.string(), z.number()]);

export const JsonRpcErrorSchema = z.looseObject({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

/**
 * ACP's documented error codes. Standard JSON-RPC plus `-32800` (request
 * cancelled), `-32000` (auth required) and `-32002` (resource not found).
 * Kept as data rather than a Zod enum: `ErrorCode` in the schema widens to
 * `number`, and an agent inventing a code must not fail validation.
 */
export const ACP_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  requestCancelled: -32800,
  authRequired: -32000,
  resourceNotFound: -32002,
} as const;

const jsonrpc = z.literal('2.0');

/** A request from the agent that Juno must answer. */
export const JsonRpcRequestSchema = z.looseObject({
  jsonrpc,
  id: JsonRpcIdSchema,
  method: z.string(),
  params: z.unknown().optional(),
});

/** A notification from the agent. No reply, ever — replying is a protocol bug. */
export const JsonRpcNotificationSchema = z.looseObject({
  jsonrpc,
  method: z.string(),
  params: z.unknown().optional(),
});

export const JsonRpcSuccessSchema = z.looseObject({
  jsonrpc,
  id: JsonRpcIdSchema,
  result: z.unknown(),
});

export const JsonRpcFailureSchema = z.looseObject({
  jsonrpc,
  id: JsonRpcIdSchema.nullable(),
  error: JsonRpcErrorSchema,
});

/**
 * Any inbound frame.
 *
 * Order matters. A response carries `id` + `result`/`error`; a request carries
 * `id` + `method`; a notification carries `method` and no `id`. The success and
 * failure shapes are tried first so that a frame with both an `id` and a
 * `result` is never mistaken for a request by a loose matcher.
 */
export const JsonRpcInboundSchema = z.union([
  JsonRpcFailureSchema,
  JsonRpcSuccessSchema,
  JsonRpcRequestSchema,
  JsonRpcNotificationSchema,
]);

export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;
export type JsonRpcInbound = z.infer<typeof JsonRpcInboundSchema>;

export type InboundFrame =
  | { readonly kind: 'request'; readonly id: JsonRpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: 'notification'; readonly method: string; readonly params: unknown }
  | { readonly kind: 'result'; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly kind: 'error'; readonly id: JsonRpcId | null; readonly error: JsonRpcError };

/**
 * Classify a validated frame. Split out from the schema because JSON-RPC's
 * discrimination is structural (presence of `id`/`method`/`result`), not a tag,
 * and expressing that as a Zod transform makes the failure messages unreadable.
 */
export function classifyInbound(
  raw: unknown,
): { ok: true; frame: InboundFrame } | { ok: false; error: string } {
  const parsed = JsonRpcInboundSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const value = parsed.data as Record<string, unknown>;

  if ('error' in value && value['error'] !== undefined) {
    const failure = JsonRpcFailureSchema.parse(value);
    return { ok: true, frame: { kind: 'error', id: failure.id, error: failure.error } };
  }
  if ('result' in value) {
    const success = JsonRpcSuccessSchema.parse(value);
    return { ok: true, frame: { kind: 'result', id: success.id, result: success.result } };
  }
  if (typeof value['method'] === 'string') {
    const method = value['method'];
    const params = value['params'];
    const id = value['id'];
    if (id === undefined || id === null) {
      return { ok: true, frame: { kind: 'notification', method, params } };
    }
    if (typeof id === 'string' || typeof id === 'number') {
      return { ok: true, frame: { kind: 'request', id, method, params } };
    }
  }
  return { ok: false, error: 'frame is neither a request, notification, result nor error' };
}

/* -------------------------------------------------------------------------- */
/* Shared leaves                                                               */
/* -------------------------------------------------------------------------- */

/** Every ACP object carries this open extension slot. */
const meta = z.record(z.string(), z.unknown()).nullish();

export const SessionIdSchema = z.string();
export const ToolCallIdSchema = z.string();
export const SessionModeIdSchema = z.string();

export const AnnotationsSchema = z.looseObject({
  audience: z.array(z.enum(['assistant', 'user'])).nullish(),
  lastModified: z.string().nullish(),
  priority: z.number().nullish(),
  _meta: meta,
});

export const TextResourceContentsSchema = z.looseObject({
  uri: z.string(),
  text: z.string(),
  mimeType: z.string().nullish(),
  _meta: meta,
});

export const BlobResourceContentsSchema = z.looseObject({
  uri: z.string(),
  blob: z.string(),
  mimeType: z.string().nullish(),
  _meta: meta,
});

/** `type`-tagged. Mirrors MCP's content model, which ACP reuses wholesale. */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('text'),
    text: z.string(),
    annotations: AnnotationsSchema.nullish(),
    _meta: meta,
  }),
  z.looseObject({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
    uri: z.string().nullish(),
    annotations: AnnotationsSchema.nullish(),
    _meta: meta,
  }),
  z.looseObject({
    type: z.literal('audio'),
    data: z.string(),
    mimeType: z.string(),
    annotations: AnnotationsSchema.nullish(),
    _meta: meta,
  }),
  z.looseObject({
    type: z.literal('resource_link'),
    uri: z.string(),
    name: z.string(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    mimeType: z.string().nullish(),
    size: z.number().nullish(),
    annotations: AnnotationsSchema.nullish(),
    _meta: meta,
  }),
  z.looseObject({
    type: z.literal('resource'),
    resource: z.union([TextResourceContentsSchema, BlobResourceContentsSchema]),
    annotations: AnnotationsSchema.nullish(),
    _meta: meta,
  }),
]);

export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/* -------------------------------------------------------------------------- */
/* initialize                                                                  */
/* -------------------------------------------------------------------------- */

export const ImplementationSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  title: z.string().nullish(),
  _meta: meta,
});

export const PromptCapabilitiesSchema = z.looseObject({
  image: z.boolean().optional(),
  audio: z.boolean().optional(),
  embeddedContext: z.boolean().optional(),
  _meta: meta,
});

export const McpCapabilitiesSchema = z.looseObject({
  http: z.boolean().optional(),
  sse: z.boolean().optional(),
  acp: z.boolean().optional(),
  _meta: meta,
});

/**
 * ACP marks optional session features by the *presence* of an (otherwise empty)
 * capability object, not by a boolean. `resume: {}` means supported;
 * `resume: null` or absent means not. Modelled faithfully so the capability
 * derivation can say "negotiated" honestly.
 */
const featureFlag = z.looseObject({ _meta: meta }).nullish();

export const SessionCapabilitiesSchema = z.looseObject({
  list: featureFlag,
  delete: featureFlag,
  additionalDirectories: featureFlag,
  fork: featureFlag,
  resume: featureFlag,
  close: featureFlag,
  _meta: meta,
});

export const AgentAuthCapabilitiesSchema = z.looseObject({
  logout: featureFlag,
  _meta: meta,
});

export const AgentCapabilitiesSchema = z.looseObject({
  loadSession: z.boolean().optional(),
  promptCapabilities: PromptCapabilitiesSchema.optional(),
  mcpCapabilities: McpCapabilitiesSchema.optional(),
  sessionCapabilities: SessionCapabilitiesSchema.optional(),
  auth: AgentAuthCapabilitiesSchema.optional(),
  providers: featureFlag,
  nes: z.unknown().nullish(),
  positionEncoding: z.string().nullish(),
  _meta: meta,
});

export const AuthEnvVarSchema = z.looseObject({
  name: z.string(),
  label: z.string().nullish(),
  secret: z.boolean().optional(),
  optional: z.boolean().optional(),
  _meta: meta,
});

/**
 * `env_var` and `terminal` are tagged; the bare agent-driven method is not.
 * A plain union rather than a discriminated one, because the untagged variant
 * has no discriminator to key on.
 */
export const AuthMethodSchema = z.union([
  z.looseObject({
    type: z.literal('env_var'),
    id: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    vars: z.array(AuthEnvVarSchema),
    link: z.string().nullish(),
    _meta: meta,
  }),
  z.looseObject({
    type: z.literal('terminal'),
    id: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    _meta: meta,
  }),
  z.looseObject({
    id: z.string(),
    name: z.string(),
    description: z.string().nullish(),
    _meta: meta,
  }),
]);

export const InitializeResponseSchema = z.looseObject({
  protocolVersion: z.number(),
  agentCapabilities: AgentCapabilitiesSchema.optional(),
  authMethods: z.array(AuthMethodSchema).optional(),
  agentInfo: ImplementationSchema.nullish(),
  _meta: meta,
});

export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;
export type InitializeResponse = z.infer<typeof InitializeResponseSchema>;
export type AuthMethod = z.infer<typeof AuthMethodSchema>;

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                           */
/* -------------------------------------------------------------------------- */

export const SessionModeSchema = z.looseObject({
  id: SessionModeIdSchema,
  name: z.string(),
  description: z.string().nullish(),
  _meta: meta,
});

export const SessionModeStateSchema = z.looseObject({
  currentModeId: SessionModeIdSchema,
  availableModes: z.array(SessionModeSchema),
  _meta: meta,
});

/**
 * Config options are a two-part shape in the schema: a `type`-tagged select or
 * boolean intersected with common `id`/`name` fields. Modelled loosely here —
 * Juno reads `id` and the current value to recover a model name, and passes the
 * rest through to the UI untouched.
 */
export const SessionConfigOptionSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  description: z.string().nullish(),
  category: z.string().nullish(),
  currentValue: z.unknown().optional(),
  value: z.unknown().optional(),
  options: z.unknown().optional(),
  _meta: meta,
});

export const NewSessionResponseSchema = z.looseObject({
  sessionId: SessionIdSchema,
  modes: SessionModeStateSchema.nullish(),
  configOptions: z.array(SessionConfigOptionSchema).nullish(),
  _meta: meta,
});

export const LoadSessionResponseSchema = z.looseObject({
  modes: SessionModeStateSchema.nullish(),
  configOptions: z.array(SessionConfigOptionSchema).nullish(),
  _meta: meta,
});

export const SessionInfoSchema = z.looseObject({
  sessionId: SessionIdSchema,
  cwd: z.string(),
  additionalDirectories: z.array(z.string()).optional(),
  title: z.string().nullish(),
  updatedAt: z.string().nullish(),
  _meta: meta,
});

export const ListSessionsResponseSchema = z.looseObject({
  sessions: z.array(SessionInfoSchema),
  nextCursor: z.string().nullish(),
  _meta: meta,
});

/** ACP's own stop reasons. Note `end_turn`, not `completed`. */
export const StopReasonSchema = z.enum([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

export const UsageSchema = z.looseObject({
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  thoughtTokens: z.number().nullish(),
  cachedReadTokens: z.number().nullish(),
  cachedWriteTokens: z.number().nullish(),
  _meta: meta,
});

export const PromptResponseSchema = z.looseObject({
  stopReason: StopReasonSchema,
  usage: UsageSchema.nullish(),
  _meta: meta,
});

export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;
export type LoadSessionResponse = z.infer<typeof LoadSessionResponseSchema>;
export type StopReason = z.infer<typeof StopReasonSchema>;
export type PromptResponse = z.infer<typeof PromptResponseSchema>;
export type NewSessionResponse = z.infer<typeof NewSessionResponseSchema>;
export type SessionModeState = z.infer<typeof SessionModeStateSchema>;
export type SessionConfigOption = z.infer<typeof SessionConfigOptionSchema>;

/** Empty-object responses — validated anyway so a garbage reply is caught. */
export const EmptyResponseSchema = z.looseObject({ _meta: meta });

/* -------------------------------------------------------------------------- */
/* Tool calls                                                                  */
/* -------------------------------------------------------------------------- */

export const ToolCallStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'failed']);

export const ToolKindSchema = z.enum([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

export const ToolCallLocationSchema = z.looseObject({
  path: z.string(),
  line: z.number().nullish(),
  _meta: meta,
});

export const DiffSchema = z.looseObject({
  path: z.string(),
  oldText: z.string().nullish(),
  newText: z.string(),
  _meta: meta,
});

export const ToolCallContentSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('content'), content: ContentBlockSchema, _meta: meta }),
  z.looseObject({ type: z.literal('diff') }).extend(DiffSchema.shape),
  z.looseObject({ type: z.literal('terminal'), terminalId: z.string(), _meta: meta }),
]);

/** Full announcement of a new call. `toolCallId` + `title` are the only required fields. */
export const ToolCallSchema = z.looseObject({
  toolCallId: ToolCallIdSchema,
  title: z.string(),
  name: z.string().nullish(),
  kind: ToolKindSchema.optional(),
  status: ToolCallStatusSchema.optional(),
  content: z.array(ToolCallContentSchema).optional(),
  locations: z.array(ToolCallLocationSchema).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  _meta: meta,
});

/** A patch against an existing call. Everything but the id is optional. */
export const ToolCallUpdateSchema = z.looseObject({
  toolCallId: ToolCallIdSchema,
  title: z.string().nullish(),
  name: z.string().nullish(),
  kind: ToolKindSchema.nullish(),
  status: ToolCallStatusSchema.nullish(),
  content: z.array(ToolCallContentSchema).nullish(),
  locations: z.array(ToolCallLocationSchema).nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  _meta: meta,
});

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ToolCallUpdate = z.infer<typeof ToolCallUpdateSchema>;
export type ToolKind = z.infer<typeof ToolKindSchema>;
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>;
export type ToolCallContent = z.infer<typeof ToolCallContentSchema>;

/* -------------------------------------------------------------------------- */
/* Plans, commands, usage                                                      */
/* -------------------------------------------------------------------------- */

export const PlanEntrySchema = z.looseObject({
  content: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  status: z.enum(['pending', 'in_progress', 'completed']),
  _meta: meta,
});

export const PlanSchema = z.looseObject({ entries: z.array(PlanEntrySchema), _meta: meta });

export const AvailableCommandSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  input: z.unknown().nullish(),
  _meta: meta,
});

export type Plan = z.infer<typeof PlanSchema>;
export type AvailableCommand = z.infer<typeof AvailableCommandSchema>;

/* -------------------------------------------------------------------------- */
/* session/update — the streaming channel                                      */
/* -------------------------------------------------------------------------- */

const contentChunk = { content: ContentBlockSchema, messageId: z.string().nullish(), _meta: meta };

/**
 * Discriminated on `sessionUpdate`. Note the schema flattens each payload type
 * into the variant object (an intersection), so `tool_call` updates carry
 * `toolCallId`/`title`/… at the top level rather than nested under a key.
 */
export const SessionUpdateSchema = z.discriminatedUnion('sessionUpdate', [
  z.looseObject({ sessionUpdate: z.literal('user_message_chunk'), ...contentChunk }),
  z.looseObject({ sessionUpdate: z.literal('agent_message_chunk'), ...contentChunk }),
  z.looseObject({ sessionUpdate: z.literal('agent_thought_chunk'), ...contentChunk }),
  z.looseObject({ sessionUpdate: z.literal('tool_call') }).extend(ToolCallSchema.shape),
  z.looseObject({ sessionUpdate: z.literal('tool_call_update') }).extend(ToolCallUpdateSchema.shape),
  z.looseObject({ sessionUpdate: z.literal('plan') }).extend(PlanSchema.shape),
  z.looseObject({ sessionUpdate: z.literal('plan_update'), plan: z.unknown(), _meta: meta }),
  z.looseObject({ sessionUpdate: z.literal('plan_removed'), planId: z.string(), _meta: meta }),
  z.looseObject({
    sessionUpdate: z.literal('available_commands_update'),
    availableCommands: z.array(AvailableCommandSchema),
    _meta: meta,
  }),
  z.looseObject({
    sessionUpdate: z.literal('current_mode_update'),
    currentModeId: SessionModeIdSchema,
    _meta: meta,
  }),
  z.looseObject({
    sessionUpdate: z.literal('config_option_update'),
    configOptions: z.array(SessionConfigOptionSchema),
    _meta: meta,
  }),
  z.looseObject({
    sessionUpdate: z.literal('session_info_update'),
    title: z.string().nullish(),
    updatedAt: z.string().nullish(),
    _meta: meta,
  }),
  /**
   * NOT token counts. `used`/`size` describe how much of the context window is
   * consumed. Conflating this with `Usage` would put a context measurement into
   * a token-billing field; see docs/PROVIDERS.md.
   */
  z.looseObject({
    sessionUpdate: z.literal('usage_update'),
    used: z.number(),
    size: z.number(),
    cost: z.looseObject({ amount: z.number(), currency: z.string(), _meta: meta }).nullish(),
    _meta: meta,
  }),
]);

export const SessionNotificationSchema = z.looseObject({
  sessionId: SessionIdSchema,
  update: SessionUpdateSchema,
  _meta: meta,
});

export type SessionUpdate = z.infer<typeof SessionUpdateSchema>;
export type SessionNotification = z.infer<typeof SessionNotificationSchema>;

/* -------------------------------------------------------------------------- */
/* Permission requests (agent -> client)                                       */
/* -------------------------------------------------------------------------- */

export const PermissionOptionKindSchema = z.enum([
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
]);

export const PermissionOptionSchema = z.looseObject({
  optionId: z.string(),
  name: z.string(),
  kind: PermissionOptionKindSchema,
  _meta: meta,
});

export const RequestPermissionRequestSchema = z.looseObject({
  sessionId: SessionIdSchema,
  toolCall: ToolCallUpdateSchema,
  options: z.array(PermissionOptionSchema),
  _meta: meta,
});

export type PermissionOption = z.infer<typeof PermissionOptionSchema>;
export type PermissionOptionKind = z.infer<typeof PermissionOptionKindSchema>;
export type RequestPermissionRequest = z.infer<typeof RequestPermissionRequestSchema>;

/** `{outcome: 'cancelled'}` or `{outcome: 'selected', optionId}`. */
export type RequestPermissionOutcome =
  | { readonly outcome: 'cancelled' }
  | { readonly outcome: 'selected'; readonly optionId: string };

/* -------------------------------------------------------------------------- */
/* Filesystem requests (agent -> client)                                       */
/* -------------------------------------------------------------------------- */

export const ReadTextFileRequestSchema = z.looseObject({
  sessionId: SessionIdSchema,
  path: z.string(),
  line: z.number().nullish(),
  limit: z.number().nullish(),
  _meta: meta,
});

export const WriteTextFileRequestSchema = z.looseObject({
  sessionId: SessionIdSchema,
  path: z.string(),
  content: z.string(),
  _meta: meta,
});

export type ReadTextFileRequest = z.infer<typeof ReadTextFileRequestSchema>;
export type WriteTextFileRequest = z.infer<typeof WriteTextFileRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Outbound request payloads                                                   */
/* -------------------------------------------------------------------------- */

/**
 * ACP's stdio MCP server shape. The `command`/`args` split is the protocol's,
 * and Juno preserves it end to end — an MCP server is never described to an
 * agent as a single shell string, because the agent would have to re-split it.
 */
export interface McpServerStdio {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

export interface InitializeParams {
  readonly protocolVersion: number;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly clientCapabilities: {
    readonly fs: { readonly readTextFile: boolean; readonly writeTextFile: boolean };
    readonly terminal: boolean;
  };
}

export interface NewSessionParams {
  readonly cwd: string;
  readonly mcpServers: readonly McpServerStdio[];
  readonly additionalDirectories?: readonly string[];
}

export interface PromptParams {
  readonly sessionId: string;
  readonly prompt: readonly ContentBlock[];
}
