/**
 * The one shape the v2 workspace renders from. The real route builds it from
 * the env-server session (or the legacy CodeTask path, via the adapter); the
 * /dev/code-v2 gallery builds it from fixtures. Components never fetch.
 */
import type {
  ApprovalDecision,
  InteractionMode,
  ModelSelection,
  ProviderInstance,
  RoleRouting,
  RuntimeMode,
  SessionState,
  SessionUsage,
  TurnItem,
} from "@/lib/code-v2/contracts";
import type { QueueRow } from "@/lib/code-v2/composer";
import type { DockTab } from "@/lib/code-v2/dock";
import type { DiffFile, HunkDecision } from "@/lib/code-v2/diff";
import type { DetailLevel } from "@/lib/code-v2/turns";
import type { ThreadSummary } from "@/lib/code-v2/thread-sections";
import type { ByokKeyRecord } from "@/lib/code-v2/byok-client";

export interface TerminalSession {
  id: string;
  title: string;
  /** Agent-run commands are read-only; the user's shell is writable. */
  readOnly: boolean;
  output: string;
  /** Characters dropped from the front of `output` (see terminal-stream.ts). */
  offset?: number;
  exited?: boolean;
}

export interface DeviceInfo {
  id: string;
  name: string;
  online: boolean;
  /** ISO-8601 of the last heartbeat. */
  lastSeenAt?: string;
}

export interface WorkspaceThread {
  id: string;
  title: string;
  repo: string;
  branch?: string;
  cwd?: string;
}

export interface WorkspaceActions {
  send(text: string): void | Promise<unknown>;
  queue(text: string): void;
  steer(text: string): void | Promise<unknown>;
  stop(): void;
  respond(requestId: string, decision: ApprovalDecision, answers?: Record<string, string[]>): void | Promise<unknown>;
  setSelection(selection: ModelSelection): void;
  setRouting(routing: RoleRouting): void;
  setRuntimeMode(mode: RuntimeMode): void;
  setInteractionMode(mode: InteractionMode): void;
  editQueued(id: string, text: string): void;
  removeQueued(id: string): void;
  moveQueued(id: string, to: number): void;
  steerQueued(id: string): void;
  compact?(): void;
  rollback?(checkpointId: string): void;
  /**
   * A hunk decision. `file` is the parsed file the hunk belongs to (the host
   * builds the patch from it). Resolving `false` means the host could not
   * apply it, and the dock takes the decision back.
   */
  decideHunk?(path: string, hunkId: string, decision: HunkDecision | null, file?: DiffFile): void | Promise<boolean | void>;
  /** Cancels a scheduled resume (resume at reset). */
  cancelResume?(): void;
  commit?(): void;
  messageAgent?(agentId: string, text: string): void;
  stopAgent?(agentId: string): void;
  keepCandidate?(agentId: string): void;
  approvePlan?(itemId: string, approve: boolean): void;
  /** Schedules the next turn for when the limit resets (`at`: the reset the composer shows). */
  resumeAtReset?(at?: string): void | Promise<unknown>;
  openConnections?(): void;
  openThread?(id: string): void;
  newThread?(): void;
  terminalInput?(terminalId: string, data: string): void;
  terminalResize?(terminalId: string, cols: number, rows: number): void;
  closeTerminal?(terminalId: string): void;
  openTerminal?(command?: string): void;
  renameThread?(title: string): void;
}

export interface WorkspaceModel {
  thread: WorkspaceThread;
  items: TurnItem[];
  state: SessionState;
  resumeAt?: string;
  /** A turn the env server starts by itself when the limit resets. */
  scheduledResume?: { id: string; at: string } | null;
  stateMessage?: string;
  usage?: SessionUsage;
  queue: QueueRow[];
  instances: ProviderInstance[];
  selection: ModelSelection;
  routing: RoleRouting;
  runtimeMode: RuntimeMode;
  interactionMode: InteractionMode;
  /** Files of the workspace for @mentions and the Files tab (relative paths). */
  files?: string[];
  fileContents?: Record<string, string>;
  terminals?: TerminalSession[];
  previewUrl?: string;
  device?: DeviceInfo | null;
  /** Feature flags (providers.antigravity). */
  flags?: Record<string, boolean>;
  byokKeys?: ByokKeyRecord[];
  /** Sidebar threads (gallery / standalone chrome). */
  threads?: ThreadSummary[];
  /** Hunk decisions already made, by hunk id. */
  hunkDecisions?: Record<string, HunkDecision>;
  /** True while the session is resolving (Send disabled). */
  starting?: string | null;
  /** Shown when the web cannot reach the device. */
  offline?: boolean;
  /** Read-only child thread (a subagent opened in full view). */
  child?: { label: string; model: string; parentTitle: string } | null;
  actions: WorkspaceActions;
}

export interface WorkspaceUiState {
  dockTab?: DockTab;
  dockOpen?: boolean;
  dockExpanded?: boolean;
  detailLevel?: DetailLevel;
  /** Open popover for stills: model | traits | tier | orchestrate | mode | gauge | slash | mention | palette. */
  popover?: string | null;
  selectedAgentId?: string | null;
  reducedMotion?: boolean;
}
