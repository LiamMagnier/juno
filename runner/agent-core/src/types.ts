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
}

/** Events streamed from the agent loop to whichever surface is attached. */
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
  | { type: 'tool_started'; callId: string; name: string; input: unknown; risk: RiskLevel }
  | {
      type: 'tool_finished';
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: 'tool_denied'; callId: string; name: string; reason: string }
  | { type: 'approval_requested'; request: ApprovalRequest }
  | { type: 'approval_resolved'; callId: string; decision: ApprovalDecision }
  | { type: 'files_changed'; turnIndex: number; paths: string[] }
  | { type: 'mode_changed'; mode: PermissionMode }
  | { type: 'turn_finished'; turnIndex: number; stopReason: string; usage: Usage }
  | { type: 'error'; message: string };

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
