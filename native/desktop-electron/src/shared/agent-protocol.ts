/**
 * Runtime validation for the Juno agent-core wire protocol.
 *
 * `runner/agent-core/src/types.ts` is the single source of truth for these
 * shapes — it is already shared by the cloud runner, the session relay and the
 * Swift clients. This module does **not** redeclare that contract. It declares
 * Zod validators for it and then asserts, at compile time, that the validators
 * and the source types are identical (see `assertExactly` at the bottom).
 *
 * Why validators at all, when the types are already in TypeScript: the agent
 * host is a separate OS process. Everything crossing that boundary is untrusted
 * input regardless of what the type system believes, and `THREAT_MODEL.md`
 * treats a compromised or buggy agent host as in-scope. Types are erased at
 * runtime; these schemas are not.
 *
 * Why the compile-time assertion: a validator that silently drifts from the
 * contract is worse than no validator, because it fails closed on legitimate
 * traffic and the failure looks like a backend bug. If someone adds an event to
 * agent-core and not here, `npm run typecheck` fails with a type error on the
 * assertion line, not at 3am in production.
 */

import { z } from 'zod';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
  RiskLevel,
  SessionMeta,
  SubagentSnapshot,
  Usage,
} from '@juno/agent-core';

/* -------------------------------------------------------------------------- */
/* Leaf types                                                                  */
/* -------------------------------------------------------------------------- */

export const PermissionModeSchema = z.enum(['plan', 'ask', 'auto-edit', 'full']);

export const RiskLevelSchema = z.enum(['safe', 'edit', 'command', 'sensitive']);

export const ApprovalDecisionSchema = z.enum(['allow', 'allow_always', 'deny']);

export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
});

export const ApprovalRequestSchema = z.object({
  callId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  risk: RiskLevelSchema,
  summary: z.string(),
  agentId: z.string().optional(),
  agentLabel: z.string().optional(),
});

export const SubagentSnapshotSchema = z.object({
  id: z.string(),
  title: z.string(),
  role: z.string(),
  model: z.string(),
  isolation: z.string(),
  writes: z.boolean(),
  status: z.string(),
  currentActivity: z.string(),
  usage: UsageSchema,
  error: z.string().optional(),
  summary: z.string().optional(),
  filesChanged: z.array(z.string()).optional(),
  conflictedFiles: z.array(z.string()).optional(),
  commandsExecuted: z.array(z.string()).optional(),
  warnings: z.array(z.string()).optional(),
  worktreeBranch: z.string().optional(),
  applied: z.boolean().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

export const SessionMetaSchema = z.object({
  id: z.string(),
  title: z.string(),
  cwd: z.string(),
  provider: z.string(),
  model: z.string(),
  mode: PermissionModeSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  turnCount: z.number(),
});

/* -------------------------------------------------------------------------- */
/* The event union                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `AgentEvent`. Ordered exactly as the source union is, so a diff
 * between the two files reads straight down.
 */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_started'),
    sessionId: z.string(),
    cwd: z.string(),
    provider: z.string(),
    model: z.string(),
    mode: PermissionModeSchema,
  }),
  z.object({ type: z.literal('turn_started'), turnIndex: z.number() }),
  z.object({ type: z.literal('assistant_delta'), text: z.string() }),
  z.object({ type: z.literal('assistant_message'), text: z.string() }),
  z.object({
    type: z.literal('tool_started'),
    callId: z.string(),
    name: z.string(),
    input: z.unknown(),
    risk: RiskLevelSchema,
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_finished'),
    callId: z.string(),
    name: z.string(),
    output: z.string(),
    isError: z.boolean(),
    durationMs: z.number(),
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool_denied'),
    callId: z.string(),
    name: z.string(),
    reason: z.string(),
    agentId: z.string().optional(),
  }),
  z.object({ type: z.literal('approval_requested'), request: ApprovalRequestSchema }),
  z.object({
    type: z.literal('approval_resolved'),
    callId: z.string(),
    decision: ApprovalDecisionSchema,
    agentId: z.string().optional(),
  }),
  z.object({
    type: z.literal('files_changed'),
    turnIndex: z.number(),
    paths: z.array(z.string()),
  }),
  z.object({ type: z.literal('mode_changed'), mode: PermissionModeSchema }),
  z.object({
    type: z.literal('turn_finished'),
    turnIndex: z.number(),
    stopReason: z.string(),
    usage: UsageSchema,
    subagentUsage: UsageSchema.optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('subagent_update'), agent: SubagentSnapshotSchema }),
]);

/* -------------------------------------------------------------------------- */
/* Sidecar framing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Client -> sidecar. Transcribed from the protocol comment on
 * `startSidecarServer` (`runner/agent-core/src/server.ts`). Unlike `AgentEvent`
 * these frames have no exported TypeScript type in agent-core, so there is
 * nothing to assert against — the comment is the contract, and
 * `scripts/check-agent-contract.ts` re-reads it to catch silent changes.
 */
export const SidecarCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    cwd: z.string(),
    model: z.string().optional(),
    mode: PermissionModeSchema.optional(),
  }),
  z.object({
    type: z.literal('resume'),
    sessionId: z.string(),
    mode: PermissionModeSchema.optional(),
  }),
  z.object({ type: z.literal('prompt'), text: z.string() }),
  z.object({
    type: z.literal('approval'),
    callId: z.string(),
    decision: ApprovalDecisionSchema,
  }),
  z.object({ type: z.literal('set_mode'), mode: PermissionModeSchema }),
  z.object({ type: z.literal('undo') }),
  z.object({ type: z.literal('diff'), sinceTurn: z.number().optional() }),
  z.object({ type: z.literal('list_sessions') }),
  z.object({ type: z.literal('abort') }),
]);

/** Sidecar -> client. */
export const SidecarMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), event: AgentEventSchema }),
  z.object({ type: z.literal('diff'), patch: z.string() }),
  z.object({ type: z.literal('undo_result'), restored: z.array(z.string()) }),
  z.object({ type: z.literal('sessions'), sessions: z.array(SessionMetaSchema) }),
  z.object({ type: z.literal('protocol_error'), message: z.string() }),
]);

export type SidecarCommand = z.infer<typeof SidecarCommandSchema>;
export type SidecarMessage = z.infer<typeof SidecarMessageSchema>;

/* -------------------------------------------------------------------------- */
/* Drift assertions                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Invariant type equality. The double-conditional-with-a-naked-type-parameter
 * trick is the standard way to compare two types *identically* rather than
 * merely bidirectionally-assignably: `{a: string}` and `{a: string, b?: never}`
 * are mutually assignable but not identical, and that difference is exactly the
 * kind of drift worth catching.
 *
 * **Known blind spot.** This does *not* distinguish `?: T` from
 * `?: T | undefined`. Zod's `.optional()` infers the latter; agent-core declares
 * the former. Under `exactOptionalPropertyTypes` those are different types — but
 * the identity relation this trick compares against ignores the exact-optional
 * modifier, so the assertion reports them identical. The distinction matters
 * here (the protocol uses *absence* of `agentId` to mean "the root agent"), so
 * it is pinned by runtime tests in `tests/unit/agent-protocol.test.ts` rather
 * than by the compiler. Do not read a passing assertion as covering it.
 *
 * A related hazard, worth stating because it already happened once: if the
 * agent-core import resolves to `any` — a missing declaration, a broken path —
 * every assertion below passes **vacuously**. That is why the workspace
 * consumes agent-core as a built package with real declarations, and why the
 * gate was verified by injecting a deliberate drift and watching it fail.
 */
type Exactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * Fails to compile when a schema and the agent-core type it mirrors disagree.
 * Passing a value the compiler cannot produce (`true` where `never` is required)
 * is what turns the mismatch into an error rather than a silent `any`.
 */
function assertExactly<_ extends true>(): void {
  /* type-level only */
}

assertExactly<Exactly<z.infer<typeof PermissionModeSchema>, PermissionMode>>();
assertExactly<Exactly<z.infer<typeof RiskLevelSchema>, RiskLevel>>();
assertExactly<Exactly<z.infer<typeof ApprovalDecisionSchema>, ApprovalDecision>>();
assertExactly<Exactly<z.infer<typeof UsageSchema>, Usage>>();
assertExactly<Exactly<z.infer<typeof ApprovalRequestSchema>, ApprovalRequest>>();
assertExactly<Exactly<z.infer<typeof SubagentSnapshotSchema>, SubagentSnapshot>>();
assertExactly<Exactly<z.infer<typeof SessionMetaSchema>, SessionMeta>>();
assertExactly<Exactly<z.infer<typeof AgentEventSchema>, AgentEvent>>();

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Parse one frame from the sidecar. Returns a discriminated result rather than
 * throwing: a single malformed frame must not tear down a live session, and the
 * caller needs the raw text to log a redacted sample.
 */
export function parseSidecarMessage(
  raw: unknown,
): { ok: true; message: SidecarMessage } | { ok: false; error: string } {
  const result = SidecarMessageSchema.safeParse(raw);
  if (result.success) return { ok: true, message: result.data };
  return { ok: false, error: z.prettifyError(result.error) };
}
