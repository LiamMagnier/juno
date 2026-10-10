import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChatMessage,
  PermissionMode,
  ToolSpec,
  Usage,
  UserContent,
} from './types.js';
import type { ProviderAdapter } from './providers/types.js';
import { assertContainedPath, editFileTool, globTool, grepTool, readFileTool, writeFileTool } from './tools/fs.js';
import type { ToolContext, ToolDefinition } from './tools/types.js';
import type { ContainerSandboxConfig } from './tools/container-sandbox.js';
import { PermissionEngine, classifyRisk, mayGrantAlways, ruleSubjectFor } from './permissions.js';
import { CheckpointStore, type FileRollback } from './checkpoints.js';
import { SessionStore, junoHome } from './session.js';
import { defaultTools } from './tools/registry.js';
import type { UsageReporter } from './usage.js';
import { addUsage } from './usage.js';
import { compactConversation, failureCodeOf, runAgentLoop, type AgentLoopOptions } from './loop.js';
import type { CompactionInfo, CompactionOptions } from './compaction.js';
import type { ReasoningEffort } from './providers/types.js';
import {
  SubagentManager,
  delegationPromptSection,
  isOrchestrationTool,
  orchestrationToolSpecs,
  type BestOfNRun,
  type SubagentConfig,
  type SubagentPublicState,
} from './subagents.js';
import { decodeComputerScreenshot } from './computer.js';
import type { ContextTier, ModelSelection, RoleRouting, RuntimeMode } from './contracts/code-v2.js';
import { resolveChildRoute, type ProviderResolver } from './harness/routing.js';
import { FileStateGuard, RepeatCallGuard, takeJustification, withJustification } from './harness/guards.js';
import { spillIfLarge } from './harness/spill.js';
import { BackgroundJobs, jobAwareShellTools } from './harness/jobs.js';
import { AutoReviewer, userInstructionsFrom } from './harness/auto-review.js';
import { loadInstructionChain, renderInstructionChain } from './harness/instructions.js';
import { TurnItemProjector, type TurnItemOp } from './harness/turn-items.js';

const MAX_STEPS_PER_TURN = 60;
/** Times a turn re-enters the loop to hand the parent its background children's notices. */
const MAX_NOTICE_CONTINUATIONS = 24;

export interface AgentCallbacks {
  onEvent(event: AgentEvent): void;
  /** Surface-supplied approval UI. Resolves when the user decides. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  /**
   * The same session as Code v2 TurnItems (contracts/code), for surfaces that
   * render the seam's schema. Optional: hosts that read AgentEvents ignore it.
   */
  onTurnItem?(op: TurnItemOp): void;
}

export interface AgentOptions {
  provider: ProviderAdapter;
  cwd: string;
  model?: string;
  mode?: PermissionMode;
  /**
   * The Code v2 runtime mode (sandbox × approval preset). Overrides `mode`:
   * read-only → plan gating, ask, auto-edit, auto (auto-edit gating with the
   * model reviewer answering what would have asked), full.
   */
  runtimeMode?: RuntimeMode;
  tools?: ToolDefinition[];
  callbacks: AgentCallbacks;
  /** When set, each turn reserves + records against the account plan. */
  usageReporter?: UsageReporter;
  /** Child-process environment for tools (scrubbed env for untrusted runs).
   *  Omitted = children inherit process.env, as before. */
  env?: NodeJS.ProcessEnv;
  /**
   * Confines agent-authored commands to a container holding only the task
   * worktree. Absent means they run on the host, which is right for a local
   * session and wrong for the cloud runner.
   */
  containerSandbox?: ContainerSandboxConfig;
  /** Subagent delegation config; `false` disables it (no tools exposed). */
  subagents?: SubagentConfig | false;
  /**
   * How hard to think, when the model can be asked.
   *
   * The website's composer has offered a thinking-effort control on every Code
   * run since Juno Code shipped, the task row stored it, runner-context
   * returned it — and nothing on this side ever read it, so the control chose
   * nothing. This is the field that was missing: it rides every provider
   * request the loop makes (see `AgentLoopOptions.reasoningEffort`), and an
   * adapter whose lab has no such concept drops it silently. Absent means
   * Instant, which is what every run got before.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Whether the reader has approved this project's own settings files, so
   * their allow rules may widen what the agent does without asking.
   *
   * Off unless the host says so. `.juno/settings.json` arrives with a clone:
   * left to widen, a repository's `{"allow":["bash"]}` turned a cloud
   * `auto-edit` run into `full`, and the mode is a control the person who
   * started the run chose. Its ask and deny rules always apply — a repository
   * may make the agent more careful, never less. See permissions.ts.
   */
  trustProjectSettings?: boolean;
  /**
   * The reader's own settings file, whose allow rules apply without approval.
   * Defaults to `$JUNO_HOME/settings.json`; null reads none.
   *
   * A host with no reader on the machine passes null. The cloud runner does:
   * its JUNO_HOME is a directory the environment's setup script can write —
   * and a setup script that runs `npm install` runs the repository's own
   * lifecycle scripts — so reading a "reader's" file there would hand a cloned
   * repository the very widening `trustProjectSettings` withholds.
   */
  userSettingsFile?: string | null;
  /**
   * How the conversation is kept inside the model's context window. On by
   * default, layered (prune → offload → prefix-replay summary, SPEC §3.5);
   * `false` turns it off. See compaction.ts and harness/context.ts.
   */
  compaction?: Pick<CompactionOptions, 'threshold' | 'keepRecentSteps' | 'modelSummary' | 'layered' | 'outputReserve'> | false;
  /** Role routing: which provider instance and model each role runs on (SPEC §3.4). */
  routing?: RoleRouting;
  /** Turns a ModelSelection into an adapter, so children may run on other providers. */
  resolveProvider?: ProviderResolver;
  /** This session's own selection, as the contract names it. */
  selection?: ModelSelection;
  /** The selected context tier (window + price), for the window and the budget. */
  contextTier?: ContextTier;
  /** The `auto` mode's reviewer; defaults to routing.reviewer, else this session's model. */
  reviewer?: { provider: ProviderAdapter; model: string };
  /** Guards (SPEC §3.10). Each defaults to on. */
  guards?: { readBeforeEdit?: boolean; repeatCall?: boolean; justification?: boolean };
  /** Spill tool outputs over 12.5k tokens to a file (default on). */
  spill?: boolean;
  /**
   * Shell commands that outlive their timeout become background jobs instead
   * of being killed (default on when `tools` is not supplied).
   */
  backgroundJobs?: boolean;
  /** Where the global instruction files live; null reads none. Default $JUNO_HOME. */
  globalInstructionsDir?: string | null;
}

/**
 * The system prompt: what cannot change while the session runs.
 *
 * Byte-stable by construction, because it sits in front of the whole
 * conversation and a single changed byte in it makes every later request a
 * prompt-cache miss. The date and the permission mode — which can change mid
 * session — used to be written into it; they are in `buildSessionState` now.
 *
 * Deterministic, so it is rebuilt at every turn for free: the same workspace
 * gives the same bytes and the cache still hits. The inputs that may move are
 * the instruction files (global → project → nested, harness/instructions.ts),
 * and when someone edits one the next turn should read the new one — a cache
 * miss that is the point, not a cost.
 */
function buildSystemPrompt(
  cwd: string,
  delegation: { maxConcurrent: number; maxPerTurn: number } | null,
  globalDir: string | null,
): string {
  const memory = renderInstructionChain(loadInstructionChain(cwd, globalDir), cwd);
  return `You are Alevr Code, an agentic coding assistant working directly in the user's repository.

Environment:
- Working directory: ${cwd}
- Platform: ${process.platform} (${os.release()})
- The current date and permission mode are given in the latest <session_state> block.

Operating rules:
- Use the tools to read code before editing it. Prefer edit_file for surgical changes; write_file only for new files or full rewrites. An edit to a file you have not read, or that changed since you read it, is refused — read it again.
- Project code belongs in the repository files, not in chat. Call write_file / edit_file so the workspace actually changes. Do not paste full file contents as markdown fences when a file write is possible; fence only a short snippet you are not writing.
- Plan first when a change spans several files or the approach is unclear: read the relevant code, then lay out the steps before editing. Skip planning for a one-line fix.
- Verify your work: after making changes, run the project's own checks (build, tests, linter) with bash and fix what fails before finishing. Read your own diff before you say you are done, and say plainly what you could not verify. Never claim something works that you did not see work.
- Web UI work: start the dev server as a background job (bash with run_in_background), wait with bash_output until it prints its local URL (http://localhost:<port>), then check the page there; the app opens its Preview on that address by itself. Stop servers you started with kill_job when you are done.
- iOS or macOS app work: build for the simulator (xcodebuild -sdk iphonesimulator or -destination 'platform=iOS Simulator,name=...'), then install and launch it with xcrun simctl and look at it; the app opens its Simulator pane by itself.
- Keep edits minimal and consistent with the surrounding code style.
- Reasoning stays private. In your user-visible reply give a short summary of what you did (files changed, checks run), never a dump of your internal thinking.
- Tool calls are gated by user permission settings; a denied call means the user declined — adjust your approach rather than retrying the same call. Give changing calls a one-line justification.
${delegation ? delegationPromptSection(delegation) : ''}${memory}`;
}

/** What `buildSystemPrompt` leaves out because it can change mid session. */
function buildSessionState(mode: PermissionMode, runtimeMode: RuntimeMode, now: Date): string {
  const lines = [`Date: ${now.toISOString().slice(0, 10)}`, `Permission mode: ${runtimeMode === 'auto' ? 'auto (a reviewer model approves risky calls)' : mode}`];
  if (mode === 'plan' && runtimeMode !== 'read-only') {
    lines.push(
      'You are in PLAN MODE: only read-only tools are available. Produce a concise numbered implementation plan and wait; do not attempt edits.',
    );
  } else if (runtimeMode === 'read-only') {
    lines.push('Runtime mode: read-only — only read tools are available; you cannot change files or run commands.');
  }
  return lines.join('\n');
}

/** The permission ladder a runtime mode gates with. */
export function permissionModeFor(runtime: RuntimeMode): PermissionMode {
  switch (runtime) {
    case 'read-only':
      return 'plan';
    case 'ask':
      return 'ask';
    case 'auto-edit':
    case 'auto':
      return 'auto-edit';
    case 'full':
      return 'full';
  }
}

/** The runtime mode a legacy permission mode reads as. */
export function runtimeModeOf(mode: PermissionMode): RuntimeMode {
  switch (mode) {
    case 'plan':
      return 'read-only';
    case 'ask':
      return 'ask';
    case 'auto-edit':
      return 'auto-edit';
    case 'full':
      return 'full';
  }
}

/** One input held until the running turn ends (SPEC §3.6). */
export interface HeldInput {
  id: string;
  text: string;
  queuedAt: string;
}

export class AgentSession {
  readonly store: SessionStore;
  readonly cwd: string;
  model: string;
  mode: PermissionMode;
  /** The Code v2 runtime mode; `mode` is the ladder it gates with. */
  runtimeMode: RuntimeMode;
  private provider: ProviderAdapter;
  private tools: ToolDefinition[];
  private toolsByName: Map<string, ToolDefinition>;
  private permissions: PermissionEngine;
  private checkpoints: CheckpointStore;
  private messages: ChatMessage[];
  private callbacks: AgentCallbacks;
  private usageReporter?: UsageReporter;
  private env?: NodeJS.ProcessEnv;
  /** Container confinement for agent-authored commands; absent locally. */
  private readonly containerSandbox?: ContainerSandboxConfig;
  /** Thinking effort for every provider request this session makes. */
  private readonly reasoningEffort?: ReasoningEffort;
  private aborter: AbortController | null = null;
  /** Root-only child-task orchestration. Children run through the manager's
   *  own executor (which hard-rejects orchestration tools), so nesting is
   *  impossible by construction. */
  readonly subagents?: SubagentManager;
  private currentTurnIndex = 0;
  /**
   * Instructions sent while a turn is running, waiting for the next step.
   *
   * Each entry resolves its promise the moment the text leaves the queue —
   * either taken by the loop at a step boundary or drained by the host
   * between turns — which is what lets a host acknowledge "the run has your
   * instruction" only once that is true.
   */
  private queuedUserMessages: { text: string; resolve: () => void }[] = [];
  /** Inputs held for the next turn (the queue lane), editable until they start. */
  private held: HeldInput[] = [];
  private readonly compaction: AgentOptions['compaction'];
  private readonly routing?: RoleRouting;
  private readonly resolveProvider?: ProviderResolver;
  private readonly selection?: ModelSelection;
  private readonly contextTier?: ContextTier;
  private readonly reviewerOverride?: { provider: ProviderAdapter; model: string };
  private readonly guards: { readBeforeEdit: boolean; repeatCall: boolean; justification: boolean };
  private readonly files: FileStateGuard;
  private readonly repeats = new RepeatCallGuard();
  private readonly spillDir: string | null;
  private readonly offloadDir: string;
  readonly jobs: BackgroundJobs | null;
  private readonly globalInstructionsDir: string | null;
  private readonly projector = new TurnItemProjector();
  /** The request shape of the running turn, for forks. */
  private currentSystem = '';
  private currentToolSpecs: ToolSpec[] = [];
  private running = false;

  private constructor(store: SessionStore, opts: AgentOptions) {
    this.store = store;
    this.cwd = store.meta.cwd;
    this.model = store.meta.model;
    this.mode = store.meta.mode;
    this.runtimeMode = store.meta.runtimeMode ?? runtimeModeOf(store.meta.mode);
    this.provider = opts.provider;
    this.jobs = opts.tools === undefined && opts.backgroundJobs !== false ? new BackgroundJobs() : null;
    this.tools =
      opts.tools ??
      (this.jobs
        ? [readFileTool, globTool, grepTool, editFileTool, writeFileTool, ...jobAwareShellTools(this.jobs)]
        : defaultTools());
    this.toolsByName = new Map(this.tools.map((t) => [t.spec.name, t]));
    this.permissions = new PermissionEngine(this.cwd, {
      trustProjectSettings: opts.trustProjectSettings === true,
      ...(opts.userSettingsFile === undefined ? {} : { userSettingsFile: opts.userSettingsFile }),
    });
    this.checkpoints = new CheckpointStore(store.dir);
    this.messages = store.loadMessages();
    this.callbacks = opts.callbacks;
    this.usageReporter = opts.usageReporter;
    this.env = opts.env;
    this.containerSandbox = opts.containerSandbox;
    this.reasoningEffort = opts.reasoningEffort;
    this.compaction = opts.compaction;
    this.routing = opts.routing;
    this.resolveProvider = opts.resolveProvider;
    this.selection = opts.selection;
    this.contextTier = opts.contextTier;
    this.reviewerOverride = opts.reviewer;
    this.guards = {
      readBeforeEdit: opts.guards?.readBeforeEdit ?? true,
      repeatCall: opts.guards?.repeatCall ?? true,
      justification: opts.guards?.justification ?? true,
    };
    this.files = new FileStateGuard(this.cwd);
    this.spillDir = opts.spill === false ? null : path.join(store.dir, 'spill');
    this.offloadDir = path.join(store.dir, 'offload');
    this.globalInstructionsDir = opts.globalInstructionsDir === undefined ? junoHome() : opts.globalInstructionsDir;
    if (opts.subagents !== false) {
      const session = this;
      this.subagents = new SubagentManager(
        {
          get cwd() { return session.cwd; },
          get model() { return session.model; },
          get mode() { return session.mode; },
          get provider() { return session.provider; },
          get tools() { return session.tools; },
          get env() { return session.env; },
          get usageReporter() { return session.usageReporter; },
          get reasoningEffort() { return session.reasoningEffort; },
          get permissionRules() { return session.permissions.ruleSet; },
          get routing() { return session.routing; },
          get resolveProvider() { return session.resolveProvider; },
          get selection() { return session.selection; },
          get tier() { return session.contextTier; },
          get spillDir() { return session.spillDir ?? undefined; },
          forkContext: () => ({
            system: session.currentSystem || session.systemPrompt(true),
            tools: session.currentToolSpecs,
            messages: session.messages,
          }),
          emit: (event) => session.emit(event),
          requestApproval: (request) => session.authorize(request),
          snapshotForUndo: (absPath) => session.checkpoints.snapshot(session.currentTurnIndex, absPath),
        },
        {
          ...(opts.routing?.budget ? { budget: opts.routing.budget } : {}),
          readBeforeEdit: this.guards.readBeforeEdit,
          ...(opts.subagents ?? {}),
        },
      );
    }
  }

  static create(opts: AgentOptions): AgentSession {
    const model = opts.model ?? opts.provider.defaultModel;
    const mode = opts.runtimeMode ? permissionModeFor(opts.runtimeMode) : opts.mode ?? 'ask';
    const store = SessionStore.create({
      cwd: opts.cwd,
      provider: opts.provider.id,
      model,
      mode,
    });
    if (opts.runtimeMode) {
      store.meta.runtimeMode = opts.runtimeMode;
      store.saveMeta();
    }
    const session = new AgentSession(store, opts);
    session.emit({
      type: 'session_started',
      sessionId: store.id,
      cwd: session.cwd,
      provider: opts.provider.id,
      model,
      mode: session.mode,
    });
    return session;
  }

  static resume(id: string, opts: AgentOptions): AgentSession {
    const store = SessionStore.open(id);
    const session = new AgentSession(store, opts);
    if (opts.runtimeMode) session.setRuntimeMode(opts.runtimeMode);
    else if (opts.mode) session.setMode(opts.mode);
    session.emit({
      type: 'session_started',
      sessionId: store.id,
      cwd: session.cwd,
      provider: opts.provider.id,
      model: session.model,
      mode: session.mode,
    });
    return session;
  }

  get sessionId(): string {
    return this.store.id;
  }

  get turnCount(): number {
    return this.store.meta.turnCount;
  }

  /** Whether a turn (or a chain of queued turns) is running. */
  get isRunning(): boolean {
    return this.running;
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
    this.runtimeMode = runtimeModeOf(mode);
    this.store.meta.mode = mode;
    this.store.meta.runtimeMode = this.runtimeMode;
    this.store.saveMeta();
    this.emit({ type: 'mode_changed', mode });
  }

  /** Switch the sandbox × approval preset (SPEC §3.7). */
  setRuntimeMode(runtime: RuntimeMode): void {
    this.runtimeMode = runtime;
    this.mode = permissionModeFor(runtime);
    this.store.meta.mode = this.mode;
    this.store.meta.runtimeMode = runtime;
    this.store.saveMeta();
    this.emit({ type: 'mode_changed', mode: this.mode });
    this.emit({ type: 'runtime_mode_changed', mode: runtime });
  }

  abort(): void {
    this.aborter?.abort();
    // The main Stop kills EVERY child stream, command, and queued task too.
    this.subagents?.cancelAll('Stopped by user');
  }

  /** End of the session: stop children and background jobs. */
  dispose(): void {
    this.abort();
    this.jobs?.killAll();
  }

  private emit(event: AgentEvent): void {
    this.store.appendEvent(event);
    this.callbacks.onEvent(event);
    this.projectItems(event);
  }

  /** Live-only events (deltas) reach the surface and the item projection, not the log. */
  private emitLive(event: AgentEvent): void {
    this.callbacks.onEvent(event);
    this.projectItems(event);
  }

  private projectItems(event: AgentEvent): void {
    if (!this.callbacks.onTurnItem) return;
    for (const op of this.projector.project(event)) this.callbacks.onTurnItem(op);
  }

  /**
   * Seed the transcript with earlier turns of the same conversation.
   *
   * A cloud run is a fresh process on a fresh machine: without this, a
   * follow-up in a conversation reached a model that had never seen the
   * previous instruction or what it answered, and worked on a tree without
   * knowing what it had already changed. The host hands over the persisted
   * user/assistant text (already trimmed to a budget on its side); this
   * writes it into the session store so the first `prompt()` is read as the
   * next turn of that conversation rather than the first turn of a new one.
   * Only meaningful before the first turn — a session that already holds
   * messages refuses, because splicing history into the middle of a
   * transcript would reorder what the model believes happened.
   */
  seedHistory(turns: readonly { role: 'user' | 'assistant'; text: string }[]): void {
    if (this.messages.length > 0) {
      throw new Error('seedHistory: the session already has messages');
    }
    for (const turn of turns) {
      const text = turn.text.trim();
      if (!text) continue;
      if (turn.role === 'user') {
        this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
      } else {
        this.messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
      }
    }
    this.store.saveMessages(this.messages);
  }

  /**
   * Queue text to become part of the next user message.
   *
   * Resolves when the text has left the queue: taken by the running turn at
   * its next step (see `AgentLoopOptions.takeQueuedUserText`), or drained by
   * the host through `takeQueuedUserMessages` once the turn has ended. It is
   * the cloud runner's steering channel — a person's mid-run instruction
   * cannot wait for the turn to finish, because the turn is the thing they
   * are trying to redirect.
   */
  queueUserMessage(text: string): Promise<void> {
    return new Promise((resolve) => {
      this.queuedUserMessages.push({ text, resolve });
    });
  }

  /**
   * The steer lane (⌘↵ while running): the text joins the running turn at its
   * next step. Returns false when nothing is running — the caller sends it as
   * a new turn instead.
   */
  steer(text: string): boolean {
    if (!this.running) return false;
    const id = randomUUID().slice(0, 8);
    this.emit({ type: 'user_input', id, text, delivery: 'steer' });
    void this.queueUserMessage(text);
    return true;
  }

  /**
   * The queue lane (Enter while running): held until the running turn ends,
   * then started as its own turn, in order. Editable until then.
   */
  enqueue(text: string): HeldInput {
    const entry: HeldInput = { id: randomUUID().slice(0, 8), text, queuedAt: new Date().toISOString() };
    this.held.push(entry);
    this.emitQueue();
    return entry;
  }

  queuedInputs(): HeldInput[] {
    return this.held.map((entry) => ({ ...entry }));
  }

  updateQueued(id: string, text: string): boolean {
    const entry = this.held.find((e) => e.id === id);
    if (!entry || !text.trim()) return false;
    entry.text = text;
    this.emitQueue();
    return true;
  }

  removeQueued(id: string): boolean {
    const before = this.held.length;
    this.held = this.held.filter((e) => e.id !== id);
    if (this.held.length === before) return false;
    this.emitQueue();
    return true;
  }

  private emitQueue(): void {
    this.emit({ type: 'queue_updated', queue: this.held.map((e) => ({ id: e.id, text: e.text, queuedAt: e.queuedAt })) });
  }

  /**
   * Send from the composer: a new turn when idle, the queue lane when busy.
   * Resolves when the turn it started (and every queued turn after it) ends;
   * a queued submit resolves at once with the queue entry.
   */
  async submit(text: string): Promise<HeldInput | null> {
    if (this.running) return this.enqueue(text);
    await this.prompt(text);
    return null;
  }

  get hasQueuedUserMessages(): boolean {
    return this.queuedUserMessages.length > 0;
  }

  /**
   * Drain the queue outside a turn — for a host whose turn ended with
   * instructions still waiting, which then starts a new turn with them.
   * Resolves each entry's promise: leaving the queue IS the acknowledgement.
   */
  takeQueuedUserMessages(): string[] {
    const taken = this.queuedUserMessages.splice(0);
    for (const entry of taken) entry.resolve();
    return taken.map((entry) => entry.text);
  }

  /** Steering text plus background children's settlement notices, for the next step. */
  private takeStepInput(): string[] {
    return [...this.takeQueuedUserMessages(), ...(this.subagents?.takeNotices() ?? [])];
  }

  private delegationEnabled(): boolean {
    return Boolean(this.subagents?.enabled) && this.mode !== 'plan';
  }

  private systemPrompt(delegation: boolean): string {
    return buildSystemPrompt(
      this.cwd,
      delegation && this.subagents ? { maxConcurrent: this.subagents.maxConcurrent, maxPerTurn: this.subagents.maxPerTurn } : null,
      this.globalInstructionsDir,
    );
  }

  private toolSpecs(delegation: boolean): ToolSpec[] {
    const describe = (tool: ToolDefinition) => (this.guards.justification ? withJustification(tool) : tool.spec);
    if (this.mode === 'plan') return this.tools.filter((t) => t.kind === 'read').map(describe);
    return [
      ...this.tools.map(describe),
      ...(delegation
        ? orchestrationToolSpecs({
            workflow: this.subagents?.workflowsEnabled !== false,
            bestOfN: this.routing?.preset === 'best-of-n',
          })
        : []),
    ];
  }

  private compactionOptions(): CompactionOptions | null {
    if (this.compaction === false) return null;
    const window = this.contextTier?.tokens ?? this.provider.capabilities(this.model).maxContext;
    return {
      layered: true,
      offloadDir: this.offloadDir,
      ...this.compaction,
      contextWindow: window,
      onCompaction: (info) =>
        this.emit({
          type: 'context_compacted',
          reason: info.reason,
          summary: info.summary,
          ...(info.strategy ? { strategy: info.strategy } : {}),
          ...(info.failure === undefined ? {} : { failure: info.failure }),
          removedMessages: info.removedMessages,
          tokensBefore: info.tokensBefore,
          tokensAfter: info.tokensAfter,
        }),
    };
  }

  /**
   * Compact now (`/compact`): always reaches the summary layer. Null when
   * there is nothing to fold or compaction is off.
   */
  async compact(): Promise<CompactionInfo | null> {
    const options = this.compactionOptions();
    if (!options) return null;
    const delegation = this.delegationEnabled();
    const controller = new AbortController();
    const result = await compactConversation({
      provider: this.provider,
      model: this.model,
      system: this.systemPrompt(delegation),
      tools: this.toolSpecs(delegation),
      messages: this.messages,
      signal: controller.signal,
      options,
      reason: 'manual',
    });
    if (result.outcome === 'unchanged') return null;
    this.store.saveMessages(this.messages);
    if (this.usageReporter && result.usage && (result.usage.inputTokens > 0 || result.usage.outputTokens > 0)) {
      await this.usageReporter.record(this.model, result.usage).catch(() => {});
    }
    return result.info ?? null;
  }

  /**
   * Run one full user turn: stream, execute tools with gating, until end_turn —
   * then hand the parent its background children's notices, and then run any
   * inputs queued behind the turn, in order.
   */
  async prompt(text: string): Promise<void> {
    let next: { text: string; id?: string; delivery: 'send' | 'queue' } | null = { text, delivery: 'send' };
    this.running = true;
    try {
      while (next) {
        const aborted = await this.runTurn(next.text, next.delivery, next.id);
        if (aborted) break;
        const queued = this.held.shift();
        if (queued) this.emitQueue();
        next = queued ? { text: queued.text, id: queued.id, delivery: 'queue' } : null;
      }
    } finally {
      this.running = false;
    }
  }

  /** One turn. True when it was stopped (queued inputs then wait for the person). */
  private async runTurn(text: string, delivery: 'send' | 'queue', inputId?: string): Promise<boolean> {
    if (text.trim() === '/compact') {
      const turnIndex = this.store.meta.turnCount;
      this.emit({ type: 'turn_started', turnIndex });
      const info = await this.compact().catch((err) => {
        this.emit({ type: 'error', message: err instanceof Error ? err.message : String(err), code: 'internal' });
        return null;
      });
      if (!info) this.emit({ type: 'assistant_message', text: 'Nothing to compact yet.' });
      this.store.meta.turnCount = turnIndex + 1;
      this.store.saveMeta();
      this.emit({ type: 'turn_finished', turnIndex, stopReason: 'compacted', usage: { inputTokens: 0, outputTokens: 0 } });
      return false;
    }

    const turnIndex = this.store.meta.turnCount;
    this.currentTurnIndex = turnIndex;
    this.subagents?.beginTurn(turnIndex);
    if (this.store.meta.title === '(new session)') {
      this.store.meta.title = text.slice(0, 60);
    }
    this.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    this.emit({ type: 'turn_started', turnIndex });
    this.emit({ type: 'user_input', id: inputId ?? randomUUID().slice(0, 8), text, delivery });
    this.aborter = new AbortController();
    const signal = this.aborter.signal;

    // Reserve one message from the account plan (backend-connected sessions
    // only). A refused reservation stops the turn before any model call.
    if (this.usageReporter) {
      const reservation = await this.usageReporter.reserve();
      if (!reservation.allowed) {
        this.emit({
          type: 'error',
          message: reservation.message ?? "You've reached your plan's usage limit.",
        });
        this.store.meta.turnCount = turnIndex + 1;
        this.store.saveMeta();
        this.emit({
          type: 'turn_finished',
          turnIndex,
          stopReason: 'quota',
          usage: { inputTokens: 0, outputTokens: 0 },
        });
        return false;
      }
    }

    // Delegation tools are ROOT-ONLY: children run through the manager's own
    // executor, whose tool set never includes them (and which rejects them
    // outright), so recursion is impossible at both levels.
    const delegation = this.delegationEnabled();
    const toolSpecs = this.toolSpecs(delegation);
    const system = this.systemPrompt(delegation);
    this.currentSystem = system;
    this.currentToolSpecs = toolSpecs;
    const compaction = this.compactionOptions();

    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stopReason = 'end_turn';

    const loopOptions: AgentLoopOptions = {
      provider: this.provider,
      model: this.model,
      system,
      sessionState: () => buildSessionState(this.mode, this.runtimeMode, new Date()),
      messages: this.messages,
      tools: toolSpecs,
      signal,
      maxSteps: MAX_STEPS_PER_TURN,
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
      takeQueuedUserText: () => this.takeStepInput(),
      ...(compaction ? { compaction } : {}),
      onAssistantDelta: (delta) => this.emitLive({ type: 'assistant_delta', text: delta }),
      onAssistantMessage: (message) => this.emit({ type: 'assistant_message', text: message }),
      onThinkingDelta: (delta) => this.emitLive({ type: 'thinking_delta', text: delta }),
      onThinkingMessage: (message) => this.emit({ type: 'thinking_message', text: message }),
      executeToolCall: (call) => this.executeToolCall(turnIndex, call, signal),
      onMessagesChanged: () => this.store.saveMessages(this.messages),
    };

    try {
      let result = await runAgentLoop(loopOptions);
      usage = result.usage;
      stopReason = result.stopReason;
      // Background children report back once each. Hand their notices to the
      // parent as the next step of this same turn, until none is left.
      let continuations = 0;
      while (this.subagents && !signal.aborted && stopReason === 'end_turn' && continuations < MAX_NOTICE_CONTINUATIONS) {
        if (!this.subagents.hasPendingNotices) {
          if (!this.subagents.hasActiveBackground()) break;
          await this.subagents.waitForSettlement(signal);
          continue;
        }
        continuations += 1;
        result = await runAgentLoop(loopOptions);
        usage = addUsage(usage, result.usage);
        stopReason = result.stopReason;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'error', message, code: failureCodeOf(err) });
      stopReason = 'error';
    }

    const changed = this.checkpoints.changedPaths(turnIndex);
    if (changed.length > 0) {
      this.emit({ type: 'files_changed', turnIndex, paths: changed });
    }
    // Reconcile the reserved message: record real tokens on a productive turn,
    // or refund the reservation when the turn produced nothing (provider error,
    // abort before output) so a failed turn never silently burns quota.
    if (this.usageReporter) {
      if (usage.inputTokens > 0 || usage.outputTokens > 0) {
        await this.usageReporter.record(this.model, usage).catch(() => {});
      } else {
        await this.usageReporter.refund().catch(() => {});
      }
    }
    // A turn is not over while its children run: drain them so a headless
    // driver (the cloud runner) can never commit/push/exit mid-flight. An
    // abort already cancelled them, so this returns promptly after Stop.
    await this.subagents?.drainActive();
    // Notices the parent will never read now (it stopped): drop them.
    this.subagents?.takeNotices();
    this.store.meta.turnCount = turnIndex + 1;
    this.store.saveMeta();
    const subagentUsage = this.subagents?.turnSubagentUsage;
    this.emit({
      type: 'turn_finished',
      turnIndex,
      stopReason,
      usage,
      ...(subagentUsage && (subagentUsage.inputTokens > 0 || subagentUsage.outputTokens > 0)
        ? { subagentUsage }
        : {}),
    });
    return signal.aborted;
  }

  /**
   * Who answers an approval request: in `auto`, the reviewer model first —
   * allow runs it, deny refuses it (fail closed), and a sensitive call the
   * reviewer allows still goes to the person. Otherwise the person. An
   * approval path that throws is a denial.
   */
  private async authorize(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    if (this.runtimeMode === 'auto') {
      const reviewed = await this.autoReview(request, signal);
      if (reviewed === 'deny') return 'deny';
      if (request.risk !== 'sensitive') return 'allow';
    }
    try {
      return await this.callbacks.requestApproval(request);
    } catch {
      return 'deny';
    }
  }

  private reviewer(): AutoReviewer {
    if (this.reviewerOverride) return new AutoReviewer(this.reviewerOverride.provider, this.reviewerOverride.model);
    const route = resolveChildRoute({
      role: 'reviewer',
      ...(this.routing ? { routing: this.routing } : {}),
      ...(this.resolveProvider ? { resolver: this.resolveProvider } : {}),
      parent: { adapter: this.provider, model: this.model, ...(this.selection ? { selection: this.selection } : {}) },
    });
    return new AutoReviewer(route.adapter, route.model);
  }

  private async autoReview(request: ApprovalRequest, signal?: AbortSignal): Promise<'allow' | 'deny'> {
    const outcome = await this.reviewer().review(
      {
        toolName: request.toolName,
        input: request.input,
        summary: request.summary,
        engineRisk: request.risk,
        ...(request.justification ? { justification: request.justification } : {}),
        userInstructions: userInstructionsFrom(this.messages),
      },
      signal,
    );
    const decision = outcome.decision;
    this.emit({
      type: 'auto_review',
      callId: request.callId,
      toolName: request.toolName,
      risk: decision.risk,
      decision: decision.decision,
      ...(decision.decision === 'deny' && decision.reason ? { reason: decision.reason } : {}),
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      ...(request.agentId ? { agentId: request.agentId } : {}),
    });
    if (this.usageReporter && (outcome.usage.inputTokens > 0 || outcome.usage.outputTokens > 0)) {
      await this.usageReporter.record(this.model, outcome.usage).catch(() => {});
    }
    return decision.decision;
  }

  private async executeToolCall(
    turnIndex: number,
    rawCall: { id: string; name: string; input: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<UserContent | UserContent[]> {
    if (isOrchestrationTool(rawCall.name)) {
      if (!this.subagents) {
        return {
          type: 'tool_result',
          toolCallId: rawCall.id,
          content: 'Subagent delegation is disabled for this session.',
          isError: true,
        };
      }
      const refused = await this.gateOrchestration(rawCall);
      if (refused) return refused;
      return this.subagents.handleToolCall(turnIndex, rawCall, signal) as Promise<{
        type: 'tool_result';
        toolCallId: string;
        content: string;
        isError?: boolean;
      }>;
    }
    const { input, justification } = takeJustification(rawCall.input);
    const call = { ...rawCall, input };
    const tool = this.toolsByName.get(call.name);
    if (!tool) {
      return { type: 'tool_result', toolCallId: call.id, content: `Unknown tool: ${call.name}`, isError: true };
    }
    const reminder = this.guards.repeatCall ? this.repeats.observe(call.name, call.input) : null;
    const { risk, reason } = classifyRisk(tool, call.input);
    const subject = ruleSubjectFor(call.name, call.input, this.cwd);
    const outcome = this.permissions.decide(this.mode, call.name, risk, subject);

    if (outcome === 'deny') {
      const why = this.permissions.denialReason(this.mode, call.name, subject);
      this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: why });
      return { type: 'tool_result', toolCallId: call.id, content: why, isError: true };
    }

    if (outcome === 'ask') {
      const request: ApprovalRequest = {
        callId: call.id,
        toolName: call.name,
        input: call.input,
        risk,
        summary: `${tool.summarize(call.input)}${risk === 'sensitive' ? ` — SENSITIVE (${reason})` : ''}`,
        ...(justification ? { justification } : {}),
      };
      let decision: ApprovalDecision;
      if (this.runtimeMode === 'auto') {
        const reviewed = await this.autoReview(request, signal);
        if (reviewed === 'deny') {
          const msg = 'Denied by the automatic reviewer. Choose a safer approach, or ask the user to switch modes.';
          this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: msg });
          return { type: 'tool_result', toolCallId: call.id, content: msg, isError: true };
        }
        decision = 'allow';
        if (risk === 'sensitive') {
          this.emit({ type: 'approval_requested', request });
          decision = await this.callbacks.requestApproval(request).catch((): ApprovalDecision => 'deny');
          this.emit({ type: 'approval_resolved', callId: call.id, decision });
        }
      } else {
        this.emit({ type: 'approval_requested', request });
        decision = await this.callbacks.requestApproval(request).catch((): ApprovalDecision => 'deny');
        this.emit({ type: 'approval_resolved', callId: call.id, decision });
      }
      if (decision === 'deny') {
        const msg = 'The user declined this action.';
        this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: msg });
        return { type: 'tool_result', toolCallId: call.id, content: msg, isError: true };
      }
      if (decision === 'allow_always' && mayGrantAlways(risk)) {
        this.permissions.grantAlways(call.name, subject);
      }
    }

    if (this.guards.readBeforeEdit) {
      const stale = this.files.check(call.name, call.input);
      if (stale) {
        this.emit({ type: 'guard', callId: call.id, name: call.name, guard: 'read_before_edit', message: stale });
        this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: stale });
        return { type: 'tool_result', toolCallId: call.id, content: stale, isError: true };
      }
    }

    const ctx: ToolContext = {
      cwd: this.cwd,
      env: this.env,
      containerSandbox: this.containerSandbox,
      ...(this.spillDir ? { readOnlyRoots: [this.spillDir, this.offloadDir] } : {}),
    };
    // Contain every path the tool says it will mutate before anything is
    // snapshotted, so a denied call cannot leave a half-written checkpoint. The
    // canonical paths are kept from that same pass: re-resolving them below
    // would be a second trip through the filesystem, and a throw there would
    // escape this handler.
    let mutatedPaths: string[] = [];
    try {
      mutatedPaths = (tool.mutatedPaths?.(call.input, ctx) ?? []).map((abs) =>
        assertContainedPath(ctx, abs),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason });
      return { type: 'tool_result', toolCallId: call.id, content: reason, isError: true };
    }
    for (const abs of mutatedPaths) {
      this.checkpoints.snapshot(turnIndex, abs);
    }

    this.emit({ type: 'tool_started', callId: call.id, name: call.name, input: call.input, risk });
    const started = Date.now();
    let output: string;
    let isError = false;
    let exitCode: number | undefined;
    let backgroundJob: string | undefined;
    try {
      const result = await tool.execute(call.input, ctx);
      output = result.output;
      isError = result.isError ?? false;
      exitCode = result.exitCode;
      backgroundJob = result.background?.jobId;
    } catch (err) {
      output = `Tool crashed: ${err instanceof Error ? err.message : String(err)}`;
      isError = true;
    }
    this.files.record(call.name, call.input, isError);
    const image = !isError && call.name === 'computer_screenshot' ? decodeComputerScreenshot(output) : undefined;
    const eventOutput = image
      ? 'Screenshot captured (ephemeral image omitted from the event log).'
      : output.length > 2000 ? output.slice(0, 2000) + '…' : output;
    this.emit({
      type: 'tool_finished',
      callId: call.id,
      name: call.name,
      output: eventOutput,
      isError,
      durationMs: Date.now() - started,
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(backgroundJob ? { backgroundJobId: backgroundJob } : {}),
    });
    let content = image ? 'Screenshot captured. The image is attached as ephemeral vision input.' : output;
    if (!image && this.spillDir) {
      content = spillIfLarge(content, { dir: this.spillDir, callId: call.id, toolName: call.name }).content;
    }
    if (reminder) {
      this.emit({ type: 'guard', callId: call.id, name: call.name, guard: 'repeat_call', message: reminder.split('\n')[0]! });
      content = `${content}\n\n${reminder}`;
    }
    const result: UserContent = { type: 'tool_result', toolCallId: call.id, content, isError };
    return image ? [result, image] : result;
  }

  /**
   * The rules' word on a delegation, before the manager takes it.
   *
   * Delegation is not a tool the ladder rules on — it reads nothing and writes
   * nothing itself, and every child's own calls and the import of its changes
   * are gated where they happen. But `Agent` and `Task` are rule names a reader
   * can write, and a deny rule for them has to stop a child being started, as
   * it does on the Mac. Null when the call may go ahead.
   */
  private async gateOrchestration(
    call: { id: string; name: string; input: Record<string, unknown> },
  ): Promise<UserContent | null> {
    const outcome = this.permissions.decide(this.mode, call.name, 'safe');
    if (outcome === 'allow') return null;
    if (outcome === 'deny') {
      const reason = this.permissions.denialReason(this.mode, call.name);
      this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason });
      return { type: 'tool_result', toolCallId: call.id, content: reason, isError: true };
    }
    const request: ApprovalRequest = {
      callId: call.id,
      toolName: call.name,
      input: call.input,
      risk: 'safe',
      summary: `Start agents: ${JSON.stringify(call.input).slice(0, 200)}`,
    };
    this.emit({ type: 'approval_requested', request });
    const decision = await this.callbacks.requestApproval(request).catch((): ApprovalDecision => 'deny');
    this.emit({ type: 'approval_resolved', callId: call.id, decision });
    if (decision !== 'deny') return null;
    const msg = 'The user declined this action.';
    this.emit({ type: 'tool_denied', callId: call.id, name: call.name, reason: msg });
    return { type: 'tool_result', toolCallId: call.id, content: msg, isError: true };
  }

  // MARK: Children, for surfaces

  /** Talk to a child directly (continue or steer it), as the parent would. */
  messageAgent(agentId: string, text: string): { ok: boolean; message: string } {
    if (!this.subagents) return { ok: false, message: 'Subagents are disabled.' };
    const result = this.subagents.sendMessage(agentId, text);
    return result.type === 'tool_result' ? { ok: !result.isError, message: result.content } : { ok: false, message: '' };
  }

  interruptAgent(agentId: string): void {
    this.subagents?.interrupt(agentId);
  }

  agents(): SubagentPublicState[] {
    return this.subagents?.states() ?? [];
  }

  /** Best-of-N from the composer: one prompt to every worker model, each in its own worktree. */
  async runBestOfN(prompt: string, selections?: ModelSelection[]): Promise<BestOfNRun> {
    if (!this.subagents) throw new Error('Subagents are disabled for this session.');
    return this.subagents.runBestOfN({ prompt, ...(selections ? { selections } : {}), turnIndex: this.currentTurnIndex });
  }

  /** Apply the person's pick from a best-of-N run (snapshotted, so undo covers it). */
  async applyBestOfN(runId: string, agentId: string): Promise<SubagentPublicState> {
    if (!this.subagents) throw new Error('Subagents are disabled for this session.');
    return this.subagents.applyBestOfN(runId, agentId);
  }

  async discardBestOfN(runId: string): Promise<void> {
    await this.subagents?.discardBestOfN(runId);
  }

  /** Undo everything the previous turn changed on disk. Returns restored paths. */
  undoLastTurn(): string[] {
    const turns = this.checkpoints.turnsWithChanges();
    if (turns.length === 0) return [];
    return this.checkpoints.restoreToBefore(turns[turns.length - 1]);
  }

  /** Rewind the workspace to its state before the given turn. */
  rewindToTurn(turnIndex: number): string[] {
    return this.checkpoints.restoreToBefore(turnIndex);
  }

  /**
   * The one key a checkpoint is stored under, for a path named any of the ways
   * a caller might name it. Null when the path is outside the workspace.
   *
   * `path.resolve(this.cwd, p)` was the obvious implementation and it was
   * wrong: the snapshot writer keys entries by `assertContainedPath`'s CANONICAL
   * path, which realpaths the workspace root, so on any machine whose workspace
   * sits under a symlink the two spellings never met. macOS makes that the
   * default rather than the exception — a run in `/var/folders/…` snapshots
   * `/private/var/folders/…` — so every revert on a temp-dir workspace (which
   * is exactly what the cloud runner clones into) answered `unknown` for files
   * it was holding a perfectly good snapshot of.
   *
   * Sharing the writer's own function is what makes the keys agree by
   * construction rather than by two implementations staying in step. Its throw
   * on an escaping path is a bonus, not the guard: see `revertFile`.
   */
  private checkpointKey(filePath: string): string | null {
    try {
      return assertContainedPath({ cwd: this.cwd }, filePath);
    } catch {
      return null;
    }
  }

  /**
   * Undo what this session did to ONE file, named the way a caller names files:
   * relative to the workspace, or absolute.
   *
   * WHAT ACTUALLY PROTECTS THE DISK IS THE INDEX, not the path check. A path is
   * only ever reverted if the store took a snapshot of it, and snapshots are
   * taken exclusively in `executeToolCall`, after that call's own containment
   * assertion passed. So an uncontained path has no snapshot and comes back
   * `unknown` even if the containment check above were removed entirely — no
   * write, no delete, no lie.
   *
   * `unknown` is also the honest answer for a file bash wrote: bash mutations
   * are outside the snapshot net (see CheckpointStore), so this cannot undo
   * them and must not say it did. Callers have to pass that third outcome
   * through to the reader rather than folding it into a failure — "there is no
   * undo for this file" and "the undo failed" send someone to different places.
   */
  revertFile(filePath: string): FileRollback {
    const key = this.checkpointKey(filePath);
    return key === null ? 'unknown' : this.checkpoints.revertFile(key);
  }

  /** Pin one file's changes so no later undo/rewind reverts it. False when the
   *  store never snapshotted the path — nothing to keep, and saying otherwise
   *  would promise protection from a rewind that was never going to touch it. */
  keepFile(filePath: string): boolean {
    const key = this.checkpointKey(filePath);
    return key === null ? false : this.checkpoints.keepFile(key);
  }

  /**
   * Workspace-relative paths that still have an undo behind them. What a
   * surface may offer a revert control for, and nothing else.
   *
   * Relative to the REALPATHED root for the same reason `checkpointKey` exists:
   * the stored keys are canonical, so relativising them against the raw `cwd`
   * emitted a ladder of `../../..` instead of `src/foo.ts` on every symlinked
   * workspace — paths no surface could match against its own file list.
   */
  rollbackablePaths(): string[] {
    const root = fs.realpathSync(this.cwd);
    return this.checkpoints.snapshottedPaths().map((abs) => path.relative(root, abs));
  }

  diffSinceTurn(turnIndex = 0): string {
    return this.checkpoints.diffSince(turnIndex, this.cwd);
  }
}
