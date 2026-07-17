import type { ToolSpec } from '../types.js';

export interface ToolContext {
  cwd: string;
  /**
   * Environment handed to spawned child processes (the bash tool). When unset,
   * children inherit the driver's `process.env` (the desktop default). A caller
   * that runs untrusted agent code — the Cloud Code runner — passes a SCRUBBED
   * env here so agent-authored shell cannot read the driver's secrets out of its
   * own environment. See runner/agent-core/VENDORED.md (divergence #3).
   */
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
