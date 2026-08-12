/**
 * The agent contract, as the Code surface consumes it.
 *
 * `runner/agent-core/src/types.ts` is the single source of truth. It is
 * re-exported here rather than imported ad hoc across two dozen components, for
 * one reason: this file is the only place in `products/code` that names the
 * agent package, so if the contract moves there is exactly one import to
 * change. The types are not redeclared and not widened.
 *
 * `src/shared/agent-protocol.ts` pins runtime Zod validators to these same
 * types with a compile-time identity assertion, so anything that reaches this
 * surface over `code:event` has already been validated against the shapes
 * below. The renderer does not re-validate; it trusts the boundary that main
 * enforces, and it never trusts the *content* — model output is rendered as
 * React children, never as markup.
 *
 * Every import here is type-only, so nothing from the agent package (which is
 * Node code) reaches the renderer bundle.
 */

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
import type { EventPayload } from '@shared/ipc.js';

export type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  PermissionMode,
  RiskLevel,
  SessionMeta,
  SubagentSnapshot,
  Usage,
};

/**
 * The event exactly as it arrives on `code:event`.
 *
 * This is *not* redundant with `AgentEvent`, and the difference is load-bearing
 * under `exactOptionalPropertyTypes`. The channel payload is inferred from the
 * Zod schema, where `z.string().optional()` widens an optional key to
 * `agentId?: string | undefined`; agent-core declares the narrower
 * `agentId?: string`. The wire type is therefore assignable *from* an
 * `AgentEvent` but not *to* one, so the reducer takes this type at its
 * boundary. Anything narrower would force a cast on every incoming event, which
 * is precisely the kind of cast that later hides a real shape change.
 */
export type WireAgentEvent = EventPayload<'code:event'>['event'];

type WireEventOf<T extends WireAgentEvent['type']> = Extract<WireAgentEvent, { type: T }>;

/**
 * The payloads the UI actually holds, taken from the wire union for the same
 * reason as `WireAgentEvent`. An `ApprovalRequest` or `SubagentSnapshot`
 * constructed against agent-core's types (in a test, say) is assignable to
 * these; the reverse is not, so these are the types on the store and on the
 * component props.
 */
export type WireApprovalRequest = WireEventOf<'approval_requested'>['request'];
export type WireSubagentSnapshot = WireEventOf<'subagent_update'>['agent'];

/**
 * `SubagentSnapshot.status` is a plain `string` on the wire — `types.ts` stays
 * leaf-level and does not import the subagent union into itself. These are the
 * values `subagents.ts` actually emits. Anything else falls through to a
 * neutral presentation rather than being dropped: a status this table has not
 * caught up with must still appear in the UI.
 */
export const SUBAGENT_STATUSES = [
  'queued',
  'preparing',
  'running',
  'waiting_approval',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type KnownSubagentStatus = (typeof SUBAGENT_STATUSES)[number];

export function isKnownSubagentStatus(value: string): value is KnownSubagentStatus {
  return (SUBAGENT_STATUSES as readonly string[]).includes(value);
}

/**
 * `isolation` is likewise a wire-level string. `git_worktree` is the one the UI
 * branches on — it means the subagent's writes are NOT in the user's tree.
 * Anything else is treated as a shared, read-only checkout.
 */
export const GIT_WORKTREE = 'git_worktree';
