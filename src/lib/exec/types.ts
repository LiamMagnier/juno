/**
 * Shared types of the hosted execution runtime (run_code / check_run).
 *
 * This file has no imports with side effects and no `server-only`, so the tool
 * specs, the agent-core wiring, the skill lane (L3, `SkillMount`) and the
 * surfaces lane (L4, `ExecRunFacts`) can all depend on it. Design:
 * docs/rework/TOOL_RUNTIME_DESIGN.md §6.3–§6.7.
 */

export type ExecLanguage = "python" | "javascript" | "bash";
export const EXEC_LANGUAGES: readonly ExecLanguage[] = ["python", "javascript", "bash"];

/** Where a run executed. Only `hosted_sandbox` is produced by this runtime. */
export type ExecContextKind = "hosted_sandbox" | "agent_computer" | "task_container" | "local_host";

/** Which product surface started the run; also the sandbox's time limits. */
export type ExecSurface = "chat" | "work" | "voice";

/** The execution host's own run states (deploy/exec-host/juno-exec.py). */
export type HostRunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";

/**
 * A `ToolRun.status`. `outcome_unknown` is said, never guessed: the turn that
 * started the run ended and the host could not say what became of it.
 * `refused` means nothing ran (invalid arguments, sandbox unavailable).
 */
export type ToolRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "outcome_unknown"
  | "refused";

export const TERMINAL_TOOL_RUN_STATUSES: ReadonlySet<ToolRunStatus> = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
  "outcome_unknown",
  "refused",
]);

/** The run_code arguments, as the model sends them (validated in runtime.ts). */
export interface RunCodeArgs {
  language?: ExecLanguage;
  code: string;
  /** Attachment names to place in /work/inputs; default all. */
  files?: string[];
  timeout_seconds?: number;
  reason?: string;
}

export interface CheckRunArgs {
  run_id: string;
  wait_seconds?: number;
  stream?: "stdout" | "stderr";
  offset?: number;
}

/** A file the run may read, already scoped to the conversation or Work run. */
export interface ExecInputFile {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  storageKey: string;
}

/**
 * A skill bundle that may be mounted read-only at /skills/<slug> (L3).
 *
 * The skill lane provides these for the skills a turn armed; this runtime
 * uploads each bundle once per session (the host skips a digest it already
 * has) and mounts it. A mount never widens anything: the sandbox profile (no
 * network) is the turn's whatever the skill asked for.
 */
export interface SkillMount {
  /** Mount name, /^[a-z0-9][a-z0-9-]{0,63}$/: the files appear under /skills/<slug>. */
  slug: string;
  skillVersionId: string;
  /** sha256 (hex) of the bundle tar, checked by the host. */
  bundleDigest: string;
  /** The bundle as a tar (≤ 5 MB): regular files and folders only. */
  openBundle(): Promise<Uint8Array>;
}

/** Live progress while a run executes: the last lines of each stream. */
export interface ExecProgress {
  toolRunId: string;
  status: "queued" | "running";
  stdoutTail: string;
  stderrTail: string;
  stdoutBytes: number;
  stderrBytes: number;
  elapsedMs: number;
  timeoutMs: number;
}

/** A produced file, saved as an attachment (origin "tool_output"). */
export interface ExecOutputFile {
  attachmentId: string;
  name: string;
  mime: string;
  bytes: number;
  kind: "IMAGE" | "FILE";
}

/** The facts of a run, for receipts, history notes and the run detail (L1, L4). */
export interface ExecRunFacts {
  toolRunId: string;
  runId: string | null;
  context: ExecContextKind;
  language: ExecLanguage;
  status: ToolRunStatus;
  exitCode: number | null;
  durationMs: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  files: ExecOutputFile[];
  /** Files the run made that were not kept, with the reason. */
  skippedFiles: Array<{ name: string; bytes: number; reason: string }>;
  finishedLate: boolean;
  skillVersionId: string | null;
}

/** Stable failure codes, mapped onto L1's ToolErrorCode and the capability contract. */
export type ExecErrorCode =
  | "invalid_arguments"
  | "capability_unavailable"
  | "sandbox_error"
  | "outcome_unknown"
  | "not_found"
  | "cancelled"
  | "timed_out"
  | "program_failed";

/** Images handed back to the model in the tool round (shape of `ToolResultImage`). */
export interface ExecImage {
  mimeType: string;
  base64: string;
  label?: string;
}

/**
 * What run_code / check_run return. Shaped like the SPEC's `ToolOutcome`
 * (chat-rework SPEC §3.1) plus `run`, so L1's dispatcher takes it unchanged.
 */
export interface ExecToolOutcome {
  status: "succeeded" | "failed" | "denied" | "expired" | "cancelled" | "outcome_unknown" | "running";
  /** Model-facing. Program output is the model's own program's, so it is not enveloped. */
  text: string;
  /** Panel-facing: the same content. */
  body: string;
  images?: readonly ExecImage[];
  error?: { code: ExecErrorCode };
  durationMs?: number;
  feeMicroUsd?: number;
  run?: ExecRunFacts;
  /** True when this outcome was read back from an earlier identical call. */
  replayed?: boolean;
}

/**
 * Everything the runtime needs from the caller for one call. The chat route,
 * L1's dispatcher and the Work runner each build one.
 */
export interface ExecCallContext {
  surface: ExecSurface;
  userId: string;
  /** The chat generation id or the Work run id: one sandbox workspace each. */
  sessionId: string;
  /** The provider's call id (or Alevr's stable substitute). */
  callId: string;
  conversationId: string | null;
  projectId: string | null;
  workRunId?: string | null;
  /** The turn's signal: Stop or a turn timeout cancels the run on the host. */
  signal?: AbortSignal;
  /** Private turns never execute (outputs would persist). */
  private?: boolean;
  /** Lockdown never executes. */
  lockdown?: boolean;
  /** Whether images may go back to the model (vision models only). */
  vision?: boolean;
  /** Files the run may read. Defaults to the conversation's attachments. */
  inputs?: () => Promise<ExecInputFile[]>;
  /** Skill bundles this turn armed (L3). */
  skills?: readonly SkillMount[];
  onProgress?: (progress: ExecProgress) => void;
}
