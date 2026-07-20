import type { ToolSpec } from '../types.js';

export interface ToolContext {
  cwd: string;
  /** Child-process environment override (scrubbed env for untrusted runs). */
  env?: NodeJS.ProcessEnv;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
}

export interface ToolDefinition {
  spec: ToolSpec;
  /** Coarse action class used by the permission engine. */
  kind: 'read' | 'edit' | 'command';
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
  /** Absolute paths this call will mutate — snapshotted for checkpoints before execution. */
  mutatedPaths?(input: Record<string, unknown>, ctx: ToolContext): string[];
  /** One-line human-readable summary shown in approval prompts. */
  summarize(input: Record<string, unknown>): string;
}
