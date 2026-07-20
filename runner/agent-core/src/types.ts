/** Shared types for the Juno agent core. Every surface consumes these. */

export type PermissionMode = 'plan' | 'ask' | 'auto-edit' | 'full';

export type RiskLevel = 'safe' | 'edit' | 'command' | 'sensitive';

export type ApprovalDecision = 'allow' | 'allow_always' | 'deny';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** Provider-neutral chat message format. Adapters translate to vendor wire formats. */
export type UserContent =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean };

export type AssistantContent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown };

export type ChatMessage =
  | { role: 'user'; content: UserContent[] }
  | { role: 'assistant'; content: AssistantContent[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ApprovalRequest {
  callId: string;
  toolName: string;
  input: unknown;
  risk: RiskLevel;
  /** Human-readable line explaining what is being approved, e.g. the shell command. */
  summary: string;
  /** Set when a SUBAGENT (not the root agent) is asking. */
  agentId?: string;
  /** e.g. "builder · Implement auth API" — always show WHO is asking. */
  agentLabel?: string;
}

/** Events streamed from the agent loop to whichever surface is attached.
 *  `agentId` (where present) attributes an event to a SUBAGENT; absent means
 *  the root agent. `subagent_update` carries child lifecycle snapshots (the
 *  payload type lives in subagents.ts — typed as a structural record here to
 *  keep this module dependency-free). */
export type AgentEvent =
  | {
      type: 'session_started';
      sessionId: string;
      cwd: string;
      provider: string;
      model: string;
      mode: PermissionMode;
    }
  | { type: 'turn_started'; turnIndex: number }
  | { type: 'assistant_delta'; text: string }
  | { type: 'assistant_message'; text: string }
  | { type: 'tool_started'; callId: string; name: string; input: unknown; risk: RiskLevel; agentId?: string }
  | {
      type: 'tool_finished';
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
      agentId?: string;
    }
  | { type: 'tool_denied'; callId: string; name: string; reason: string; agentId?: string }
  | { type: 'approval_requested'; request: ApprovalRequest }
  | { type: 'approval_resolved'; callId: string; decision: ApprovalDecision; agentId?: string }
  | { type: 'files_changed'; turnIndex: number; paths: string[] }
  | { type: 'mode_changed'; mode: PermissionMode }
  | {
      type: 'turn_finished';
      turnIndex: number;
      stopReason: string;
      usage: Usage;
      /** Aggregated child-agent usage for the turn (absent when none ran). */
      subagentUsage?: Usage;
    }
  | { type: 'error'; message: string }
  | { type: 'subagent_update'; agent: SubagentSnapshot };

/** Structural mirror of subagents.ts SubagentPublicState (kept loose here so
 *  types.ts stays leaf-level; the manager emits the precisely typed value). */
export interface SubagentSnapshot {
  id: string;
  title: string;
  role: string;
  model: string;
  isolation: string;
  writes: boolean;
  status: string;
  currentActivity: string;
  usage: Usage;
  error?: string;
  summary?: string;
  filesChanged?: string[];
  conflictedFiles?: string[];
  commandsExecuted?: string[];
  warnings?: string[];
  worktreeBranch?: string;
  applied?: boolean;
  startedAt?: string;
  completedAt?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  mode: PermissionMode;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}
