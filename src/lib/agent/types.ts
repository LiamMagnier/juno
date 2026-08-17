/**
 * Juno Unified Agent Runtime — Shared Core Types & Protocols
 *
 * Unifies tool invocation, streaming events, permissions, approvals,
 * and execution environments across Chat, Work, Code, Research, and Voice.
 */

import type { ActionRiskClass, ActionReceiptBinding } from "@/lib/action-approval";

export type AgentMode = "chat" | "work" | "code" | "research" | "voice" | "data";

export type ExecutionEnvironment =
  | "server_sandbox"
  | "local_host"
  | "remote_runner"
  | "cloud_container"
  | "in_browser";

export type ToolCategory =
  | "search"
  | "browser"
  | "computer"
  | "python"
  | "filesystem"
  | "terminal"
  | "connector"
  | "research"
  | "code"
  | "work"
  | "assistant";

export interface ToolParameterSchema {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  enum?: string[];
  items?: ToolParameterSchema;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  default?: unknown;
}

export interface ToolDefinition<TParams = Record<string, unknown>, TResult = unknown> {
  id: string;
  name: string;
  category: ToolCategory;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameterSchema>;
    required?: string[];
  };
  /** Intrinsic risk classification for the Action Approval broker */
  riskClass: ActionRiskClass;
  /** Whether the tool requires explicit confirmation before executing */
  requiresApproval?: boolean;
  /** Human-readable preview format for user confirmation */
  formatPreview?: (params: TParams) => { title: string; detail: string; sensitive?: boolean };
  /** Execute the tool in the given runtime context */
  execute: (params: TParams, context: AgentExecutionContext) => Promise<ToolExecutionResult<TResult>>;
}

export interface AgentExecutionContext {
  userId: string;
  sessionId: string;
  conversationId?: string;
  mode: AgentMode;
  environment: ExecutionEnvironment;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
  /** Optional project or workspace scope */
  projectId?: string;
  /** Optional assistant scope */
  assistantId?: string;
  /** Session scratch / working directory */
  workingDirectory?: string;
  /** Custom environment variables for this execution */
  env?: Record<string, string>;
}

export interface ToolExecutionResult<TData = unknown> {
  success: boolean;
  data?: TData;
  error?: string;
  /** User-facing human summary of the outcome */
  summary?: string;
  /** Structured output artifacts produced during execution (charts, files, tables, diffs) */
  artifacts?: AgentOutputArtifact[];
  /** Execution latency in milliseconds */
  durationMs?: number;
  /** Raw stdout / stderr if applicable */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

export type AgentArtifactType =
  | "file"
  | "table"
  | "chart"
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "diff"
  | "interactive_component";

export interface AgentOutputArtifact {
  id: string;
  type: AgentArtifactType;
  title: string;
  mimeType?: string;
  content?: string;
  data?: unknown;
  downloadUrl?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Standardized Unified Agent Streaming Events
 * Emitted across all modes (Chat, Work, Code, Research)
 */
export type AgentRuntimeEventType =
  | "thinking"
  | "searching"
  | "browsing"
  | "reading_file"
  | "editing_file"
  | "python_execution"
  | "terminal"
  | "connector_call"
  | "computer_action"
  | "subagent_spawned"
  | "subagent_finished"
  | "source_discovered"
  | "artifact_generated"
  | "approval_requested"
  | "approval_resolved"
  | "error"
  | "retry"
  | "fallback"
  | "done";

export interface AgentRuntimeEvent {
  id: string;
  type: AgentRuntimeEventType;
  timestamp: number;
  title: string;
  detail?: string;
  status: "pending" | "running" | "completed" | "failed" | "requires_action";
  /** Tool or subagent identifier */
  source?: string;
  /** Structured payload for the specific event type */
  data?: Record<string, unknown>;
  /** Action approval receipt binding if event requires approval */
  approvalBinding?: ActionReceiptBinding;
  /** Associated artifacts */
  artifacts?: AgentOutputArtifact[];
}

export interface SubagentTaskSpec {
  id: string;
  role: "explorer" | "architect" | "builder" | "reviewer" | "tester" | "designer" | "researcher" | "custom";
  name: string;
  goal: string;
  parentSessionId: string;
  allowedTools?: string[];
  maxTurns?: number;
}
