/** Shared types for the Juno agent core. Every surface consumes these. */

import type { ModelSelection, RuntimeMode } from './contracts/code-v2.js';

export type PermissionMode = 'plan' | 'ask' | 'auto-edit' | 'full';

export type RiskLevel = 'safe' | 'edit' | 'command' | 'sensitive';

export type ApprovalDecision = 'allow' | 'allow_always' | 'deny';

export interface Usage {
  /**
   * Every input token the request consumed, cached or not.
   *
   * Inclusive on purpose, which is OpenAI's convention and not Anthropic's
   * (whose `input_tokens` counts only the uncached tail): the token ceilings,
   * the context meter and the billing floor all read this one number, and a
   * cached prefix is still context the model read. The two fields below break
   * it down for anything that prices a cache read differently.
   */
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, how many were read from the provider's prompt cache. */
  cacheReadTokens?: number;
  /** Of `inputTokens`, how many were written to the prompt cache. */
  cacheWriteTokens?: number;
}

/** Provider-neutral chat message format. Adapters translate to vendor wire formats. */
export type UserContent =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  /** Ephemeral vision input. Session persistence replaces this with a marker. */
  | { type: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string };

/**
 * A reasoning block a provider signed or sealed, kept so it can be sent back
 * byte for byte.
 *
 * Anthropic binds each thinking block to the conversation before it with a
 * signature, and a model continuing a tool loop reads its own earlier
 * reasoning only when those blocks come back unchanged and in the order they
 * streamed. OpenAI's Responses API does the same with an encrypted `reasoning`
 * item. `model` is the model that wrote the block: a signature means nothing to
 * any other model, so a block is replayed only to the one that produced it and
 * dropped when the run moves to another.
 */
export type ReasoningContent =
  | { type: 'thinking'; thinking: string; signature: string; model?: string }
  | { type: 'redacted_thinking'; data: string; model?: string }
  | { type: 'reasoning'; id: string; encryptedContent: string; summary: string[]; model?: string };

export type AssistantContent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | ReasoningContent;

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
  /** The model's one-line reason for the call (SPEC §3.7). */
  justification?: string;
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
  | { type: 'thinking_delta'; text: string }
  | { type: 'thinking_message'; text: string }
  | { type: 'tool_started'; callId: string; name: string; input: unknown; risk: RiskLevel; agentId?: string }
  | {
      type: 'tool_finished';
      callId: string;
      name: string;
      output: string;
      isError: boolean;
      durationMs: number;
      /** Process exit status, when the tool ran one — see ToolResult.exitCode. */
      exitCode?: number;
      /** The command outlived its timeout and continues as this background job. */
      backgroundJobId?: string;
      agentId?: string;
    }
  | { type: 'tool_denied'; callId: string; name: string; reason: string; agentId?: string }
  | { type: 'approval_requested'; request: ApprovalRequest }
  | { type: 'approval_resolved'; callId: string; decision: ApprovalDecision; agentId?: string }
  | { type: 'files_changed'; turnIndex: number; paths: string[] }
  /**
   * The older steps of the conversation were folded into a summary to keep it
   * inside the model's context window (see compaction.ts). `summary` says who
   * wrote it: the model, or the structural notes when the model's attempt
   * failed, which `failure` explains.
   */
  | {
      type: 'context_compacted';
      reason: 'threshold' | 'overflow' | 'manual';
      summary: 'model' | 'structural';
      /** Which layer brought the context down, in layered mode. */
      strategy?: 'prune' | 'offload' | 'summarize';
      failure?: string;
      removedMessages: number;
      tokensBefore: number;
      tokensAfter: number;
    }
  | { type: 'mode_changed'; mode: PermissionMode }
  | {
      type: 'turn_finished';
      turnIndex: number;
      stopReason: string;
      usage: Usage;
      /** Aggregated child-agent usage for the turn (absent when none ran). */
      subagentUsage?: Usage;
    }
  | {
      type: 'error';
      message: string;
      /** What kind of failure it was (`failureCodeOf` in loop.ts), when the
       *  engine knows: a plan limit and a tool crash want different words. */
      code?: string;
    }
  | { type: 'subagent_update'; agent: SubagentSnapshot }
  /** Progress of a workflow tool run (harness/workflow.ts). */
  | {
      type: 'workflow_update';
      workflowId: string;
      callId: string;
      name: string;
      status: 'running' | 'completed' | 'failed' | 'budget';
      progress?:
        | { type: 'phase'; title: string }
        | { type: 'log'; message: string }
        | { type: 'agent_start'; seq: number; label: string; phase?: string }
        | { type: 'agent_end'; seq: number; label: string; phase?: string; outcome: 'completed' | 'failed'; tokens: number };
      budget?: { tokens: number; costUsd: number; maxTokens?: number; maxUsd?: number; exhausted: boolean; reason?: string };
    }
  /** A best-of-N run changed: candidates finished, compared, picked or discarded. */
  | { type: 'best_of_n'; run: BestOfNSnapshot }
  /** Text a person sent: started a turn, steered into the running one, or queued behind it. */
  | { type: 'user_input'; id: string; text: string; delivery: 'send' | 'steer' | 'queue' }
  /** The held-input lane changed (SPEC §3.6). */
  | { type: 'queue_updated'; queue: { id: string; text: string; queuedAt: string }[] }
  /** The auto mode's reviewer ruled on a call a person would otherwise have been asked about. */
  | {
      type: 'auto_review';
      callId: string;
      toolName: string;
      risk: 'low' | 'medium' | 'high';
      decision: 'allow' | 'deny';
      reason?: string;
      /** Set when the reviewer could not answer and the call was denied for that (fail-closed). */
      failure?: string;
      agentId?: string;
    }
  /** The session's runtime mode (sandbox × approval preset) changed. */
  | { type: 'runtime_mode_changed'; mode: RuntimeMode }
  /** A guard refused or annotated a call (read-before-edit, repeat-call). */
  | { type: 'guard'; callId: string; name: string; guard: 'read_before_edit' | 'repeat_call'; message: string; agentId?: string };

/** Structural mirror of subagents.ts BestOfNRun (loose here, like SubagentSnapshot). */
export interface BestOfNSnapshot {
  id: string;
  title: string;
  prompt: string;
  status: string;
  candidates: Array<{
    agentId: string;
    selection: ModelSelection;
    model: string;
    status: string;
    summary?: string;
    error?: string;
    branch?: string;
    filesChanged: string[];
    additions: number;
    deletions: number;
    tokens: number;
  }>;
  review?: { recommended?: string; ranking: string[]; notes: string; model: string };
  pickedAgentId?: string;
}

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
  /** Contract role (worker / reviewer / explorer). */
  contractRole?: string;
  /** The provider instance and model the child actually runs on. */
  selection?: ModelSelection;
  provider?: string;
  source?: string;
  mode?: string;
  continuable?: boolean;
  runs?: number;
  task?: string;
  structured?: unknown;
  routeNote?: string;
}

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  mode: PermissionMode;
  /** The Code v2 runtime mode, when the session was given one (read-only…full, incl. auto). */
  runtimeMode?: RuntimeMode;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}
