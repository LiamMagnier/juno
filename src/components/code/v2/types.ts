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
  UserMessageItem,
} from "@/lib/code-v2/contracts";
import type { QueueRow } from "@/lib/code-v2/composer";
import type { AgentControlResult } from "@/lib/code-v2/contracts";
import type { AgentControlInput } from "@/lib/code-v2/agent-control-client";

/** One press in the Agents tree; the session is the workspace's own. */
export type AgentControlRequestInput = Omit<AgentControlInput, "sessionId">;
import type { DockTab } from "@/lib/code-v2/dock";
import type { DiffFile, HunkDecision } from "@/lib/code-v2/diff";
import type { DetailLevel } from "@/lib/code-v2/turns";
import type { ThreadSummary } from "@/lib/code-v2/thread-sections";
import type { ByokKeyRecord } from "@/lib/code-v2/byok-client";
import type { ClientAttachment } from "@/types/chat";
import type { CodeSkillsState } from "./use-code-skills";
import type { LoadOlderRequest } from "@/lib/chat/history-client";

/**
 * A thread opened on its newest page (lib/chat/history-page.ts): `items` are
 * the newest turns, and older ones are read as the reader scrolls up, through
 * the same pager and loader Chat uses (lib/chat/history-client.ts).
 */
export interface PagedHistory {
  hasOlder: boolean;
  loading: boolean;
  /** Resolves to null when nothing could be read. */
  loadOlder(request?: LoadOlderRequest): Promise<unknown>;
}

/**
 * A thread's draft beyond the composer's own state: kept in this tab (a reload
 * or a trip to another thread finds it) and synced to the reader's other
 * devices through the thread-sync row, the way Chat drafts are.
 */
export interface DraftChannel {
  /** This tab's storage key for the draft (lib/chat/context-draft), or null to keep none. */
  key: string | null;
  /**
   * The composer says how to read and replace its text, and how to take back
   * a message whose send failed (words and files); returns the detach.
   */
  attach(io: { read(): { text: string; editing: boolean }; apply(text: string): void; restore?(text: string, attachments: ClientAttachment[]): void }): () => void;
  /** Every edit (debounced by the channel). */
  changed(text: string): void;
  /** A send: the draft is empty everywhere. */
  cleared(): void;
}

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
  /** Pinned in the sidebar (session menu says Unpin). */
  pinned?: boolean;
}

export interface WorkspaceActions {
  /** `attachments`: finished uploads from the composer's row (Chat's pipeline). */
  send(text: string, attachments?: ClientAttachment[]): void | Promise<unknown>;
  queue(text: string, attachments?: ClientAttachment[]): void;
  steer(text: string, attachments?: ClientAttachment[]): void | Promise<unknown>;
  stop(): void;
  respond(requestId: string, decision: ApprovalDecision, answers?: Record<string, string[]>): void | Promise<unknown>;
  setSelection(selection: ModelSelection): void;
  setRouting(routing: RoleRouting): void;
  setRuntimeMode(mode: RuntimeMode): void;
  setInteractionMode(mode: InteractionMode): void;
  /** Both at once, from the composer's mode menu (one write, one remembered default). */
  setModes?(pair: { runtimeMode: RuntimeMode; interactionMode: InteractionMode }): void;
  editQueued(id: string, text: string): void;
  removeQueued(id: string): void;
  moveQueued(id: string, to: number): void;
  steerQueued(id: string): void;
  /** `/compact [instructions]` and "Compact and switch": the engine summarises the oldest turns. */
  compact?(instructions?: string): void;
  /** `/clear`: a fresh thread in the same project (`draft` becomes its draft), without spending a turn. */
  clearThread?(draft?: string): void;
  /** Resolves once the host answered, false when it could not restore the files (Edit and Retry wait for it). */
  rollback?(checkpointId: string): void | Promise<boolean | void>;
  /** Sends a turn's opening message again, with its attachments where the host can (Retry). */
  resend?(message: UserMessageItem): void | Promise<unknown>;
  /** The verdict on a turn's answer, and setting it (null clears). */
  feedbackFor?(turnId: string): "UP" | "DOWN" | null;
  setFeedback?(turnId: string, value: "UP" | "DOWN" | null): void;
  /**
   * A hunk decision. `file` is the parsed file the hunk belongs to (the host
   * builds the patch from it). Resolving `false` means the host could not
   * apply it, and the dock takes the decision back.
   */
  decideHunk?(path: string, hunkId: string, decision: HunkDecision | null, file?: DiffFile): void | Promise<boolean | void>;
  /** Cancels a scheduled resume (resume at reset). */
  cancelResume?(): void;
  commit?(): void;
  messageAgent?(agentId: string, text: string): void | boolean | Promise<boolean | void>;
  stopAgent?(agentId: string): void;
  /**
   * The Agents tree (REA backlog 10): a person's Steer, Stop, Pause, Resume or
   * bounded Top-up of one agent, or of the whole run when `agentId` is
   * absent. Present only where this reader owns the run's Mac; resolves with
   * the engine's answer, rejects when it never got there.
   */
  controlAgent?(input: AgentControlRequestInput): Promise<AgentControlResult>;
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
  /** Session menu (lib: session-actions.tsx): pin, share a read-only link, archive with Undo, delete after a confirm. */
  pinThread?(pinned: boolean): void;
  shareThread?(): void;
  archiveThread?(): void;
  deleteThread?(): void;
}

export interface WorkspaceModel {
  thread: WorkspaceThread;
  items: TurnItem[];
  /** Older turns still to read above `items`. Absent: `items` are the whole session. */
  history?: PagedHistory;
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
  /** This browser holds no remote-control pair with the Mac (docs/code-v2/REMOTE-CONTROL.md). */
  pairingRequired?: { deviceName: string } | null;
  /** Read-only child thread (a subagent opened in full view). */
  child?: { label: string; model: string; parentTitle: string } | null;
  /** skills lane: the Skills chip and `/name` (absent: no Skills chip). */
  skills?: CodeSkillsState;
  /** Where the draft is kept and synced (absent: the composer's state only). */
  draft?: DraftChannel;
  /** Attachments can be uploaded (the deployment has storage). Absent: off. */
  canAttach?: boolean;
  /** The conversation uploads are filed under (null on the landing, before one exists). */
  uploadConversationId?: string | null;
  /** The largest file a turn here can carry (a Mac thread: what the device link fits). */
  attachmentMaxBytes?: number;
  /**
   * The chosen model belongs to a Mac whose provider list has not arrived yet
   * (a subscription picked on the landing). The composer stays writable and
   * shows the choice, and Send waits for the list instead of reading as
   * "Connect".
   */
  selectionPending?: boolean;
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
  /** Open on a Settings pane (connections, orchestration, permissions, keyboard, general). */
  settings?: "general" | "connections" | "orchestration" | "permissions" | "keyboard" | null;
  /** The Alevr plan row in Connections (name, spend this month, cap). */
  alevrPlan?: { name: string; spentUsd?: number; capUsd?: number };
}
