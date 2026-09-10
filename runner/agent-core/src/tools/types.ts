import type { ToolSpec } from '../types.js';

export interface ToolContext {
  cwd: string;
  /** Child-process environment override (scrubbed env for untrusted runs). */
  env?: NodeJS.ProcessEnv;
  /**
   * When set, commands run inside a container with only the task worktree
   * mounted — no credentials, no host environment, no network. Absent means
   * the command runs directly on the host, which is correct for a local
   * developer session and not for the cloud runner.
   */
  containerSandbox?: import("./container-sandbox.js").ContainerSandboxConfig;
}

export interface ToolResult {
  output: string;
  isError?: boolean;
  /**
   * The process exit status, for tools that run one.
   *
   * Carried as a number rather than folded into `output` because the web
   * receipt used to have to regex `— ok` / `— failed` out of a display string
   * to say whether a test suite passed, and a string that is also a fact is a
   * fact that breaks the day someone rewords the string. Absent for tools
   * that do not run a process (reads, edits, globs).
   */
  exitCode?: number;
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
