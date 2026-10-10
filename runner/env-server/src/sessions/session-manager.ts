/**
 * Sessions: the event-sourced log, the provider runtime behind it, the
 * steer/queue lanes, approvals bound to call ids, limits, checkpoints and
 * worktrees (SPEC §3.1, 3.6, 3.7, 3.8, 3.9).
 *
 * The manager is transport-free: the WebSocket server, the device relay and
 * the MCP subagent tools all drive it through the same methods.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequestItem,
  CheckpointItem,
  ClientCommandParams,
  ClientCommandResults,
  FileChangeEntry,
  InterruptItem,
  ModelSelection,
  ProviderInstance,
  QueuedInput,
  RuntimeMode,
  ScheduledResume,
  SessionSummary,
  SessionUsage,
  TurnItem,
  TurnOutcome,
  UsageWindow,
  UserInput,
  UserInputRequestItem,
} from "../contracts/code-v2.js";
import { SessionLog, type SessionMeta } from "../protocol/session-log.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ApprovalAnswer, McpEndpoint, ProviderSession, TurnResult, TurnSink } from "../providers/types.js";
import { GitCheckpoints, PatchError, normalizeRepoPath } from "../git/checkpoints.js";
import { createWorktree, runWorktreeSetup } from "../git/worktrees.js";
import { AlevrMcpServer, MCP_SERVER_NAME } from "../mcp/alevr-mcp.js";
import { deferred, describeError, newId, nowIso, type Deferred, type Logger } from "../util.js";
import { withTeamBrief } from "../mcp/team-brief.js";

export class WireError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "unsupported" | "not_ready" | "limited" | "conflict" | "internal",
    message: string,
  ) {
    super(message);
  }
}

interface PendingRequest {
  itemId: string;
  kind: "approval" | "input";
  answer: Deferred<ApprovalAnswer>;
}

interface ActiveTurn {
  turnId: string;
  ordinal: number;
  abort: AbortController;
  done: Promise<TurnOutcome>;
  userInterrupted?: boolean;
}

interface LiveSession {
  log: SessionLog;
  provider?: ProviderSession;
  providerInstanceId?: string;
  active?: ActiveTurn;
  pending: Map<string, PendingRequest>;
  known: Set<string>;
  mcpToken?: string;
  /** Bumped by close(): a runtime that finishes starting after a close is stopped, not adopted. */
  generation?: number;
  /** Resolves each time a turn ends (subagent waiters). */
  idleWaiters: (() => void)[];
}

export interface SessionManagerOptions {
  dataDir: string;
  registry: ProviderRegistry;
  mcp: AlevrMcpServer;
  logger: Logger;
  /** Base URL of the env server's own listener, for the MCP endpoint ("http://127.0.0.1:PORT"). */
  baseUrl: () => string;
  coalesceMs?: number;
  checkpoints?: GitCheckpoints;
}

const MODE_ORDER: RuntimeMode[] = ["read-only", "ask", "auto-edit", "auto", "full"];
export function stricterMode(a: RuntimeMode, b: RuntimeMode): RuntimeMode {
  return MODE_ORDER.indexOf(a) <= MODE_ORDER.indexOf(b) ? a : b;
}

export class SessionManager {
  #live = new Map<string, LiveSession>();
  readonly sessionsDir: string;
  readonly checkpoints: GitCheckpoints;
  readonly #o: SessionManagerOptions;
  /** Listeners for "a session finished a turn" (subagents). */
  #turnEnded = new Set<(sessionId: string, outcome: TurnOutcome) => void>();
  /** Listeners for "a session was closed" (per-session tool state, e.g. computer use). */
  #closed = new Set<(sessionId: string) => void | Promise<void>>();
  /** Armed resume-at-reset timers, by session. */
  #scheduleTimers = new Map<string, { id: string; timer: NodeJS.Timeout }>();
  #engineTools: ((sessionId: string) => unknown[]) | undefined;

  constructor(options: SessionManagerOptions) {
    this.#o = options;
    this.sessionsDir = path.join(options.dataDir, "sessions");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.checkpoints = options.checkpoints ?? new GitCheckpoints();
  }

  get registry(): ProviderRegistry {
    return this.#o.registry;
  }

  onSessionClosed(listener: (sessionId: string) => void | Promise<void>): () => void {
    this.#closed.add(listener);
    return () => this.#closed.delete(listener);
  }

  onTurnEnded(listener: (sessionId: string, outcome: TurnOutcome) => void): () => void {
    this.#turnEnded.add(listener);
    return () => this.#turnEnded.delete(listener);
  }

  // ── Lookup ─────────────────────────────────────────────────────────────

  log(sessionId: string): SessionLog {
    return this.#get(sessionId).log;
  }

  has(sessionId: string): boolean {
    if (this.#live.has(sessionId)) return true;
    try {
      return fs.existsSync(path.join(this.sessionsDir, sessionId, "meta.json"));
    } catch {
      return false;
    }
  }

  #get(sessionId: string): LiveSession {
    const live = this.#live.get(sessionId);
    if (live) return live;
    let log: SessionLog | null = null;
    try {
      log = SessionLog.load(this.sessionsDir, sessionId, this.#o.coalesceMs);
    } catch {
      log = null;
    }
    if (!log) throw new WireError("not_found", `No session ${sessionId}.`);
    const session: LiveSession = { log, pending: new Map(), known: new Set(log.snapshot.items.map((i) => i.id)), idleWaiters: [] };
    this.#live.set(sessionId, session);
    // Requests that were waiting when the process stopped can no longer be answered.
    for (const item of log.snapshot.items) {
      if (item.kind === "approval_request" && item.status === "pending") log.emit({ type: "item.updated", item: { ...item, status: "expired" } });
      if (item.kind === "user_input_request" && item.status === "pending") log.emit({ type: "item.updated", item: { ...item, status: "cancelled" } });
    }
    return session;
  }

  // ── Commands ───────────────────────────────────────────────────────────

  async open(params: ClientCommandParams["session.open"] & { parentSessionId?: string; runtimeMode?: RuntimeMode }): Promise<SessionLog> {
    if (params.sessionId && this.has(params.sessionId)) return this.#get(params.sessionId).log;
    // `afterSequence` re-attaches to a session the client already follows; it never creates one
    // (the device-link hub replays with a placeholder cwd).
    if (params.afterSequence !== undefined) throw new WireError("not_found", `No session ${params.sessionId ?? ""}.`.trim());
    const id = params.sessionId ?? newId("s");
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(id)) throw new WireError("bad_request", "Invalid session id.");
    if (!params.cwd || !path.isAbsolute(params.cwd)) throw new WireError("bad_request", "cwd must be an absolute path.");
    if (!fs.existsSync(params.cwd)) throw new WireError("not_found", `${params.cwd} does not exist.`);
    const selection: ModelSelection = params.selection ?? { instanceId: "alevr", model: "anthropic:claude-opus-5-5" };
    let cwd = params.cwd;
    let worktree: SessionMeta["worktree"];
    if (params.worktree) {
      try {
        worktree = await createWorktree(params.cwd, id, this.#o.dataDir);
        cwd = worktree.path;
      } catch (error) {
        throw new WireError("bad_request", describeError(error));
      }
    }
    const meta: SessionMeta = {
      id,
      cwd,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      selection,
      runtimeMode: params.runtimeMode ?? "ask",
      interactionMode: "default",
      turnCount: 0,
      ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
      ...(worktree ? { worktree } : {}),
    };
    const log = SessionLog.create(this.sessionsDir, meta, this.#o.coalesceMs);
    this.#live.set(id, { log, pending: new Map(), known: new Set(), idleWaiters: [] });
    if (worktree) {
      void runWorktreeSetup(worktree.path).then((r) => {
        if (!r.ran) return;
        this.#notice(id, r.ok ? "info" : "warning", r.ok ? "Worktree setup finished." : `Worktree setup failed:\n${r.output.slice(-2000)}`, "worktree_setup");
      });
    }
    return log;
  }

  list(params: ClientCommandParams["session.list"]): SessionSummary[] {
    const ids = new Set([...SessionLog.list(this.sessionsDir), ...this.#live.keys()]);
    const query = params.query?.trim().toLowerCase();
    const out: SessionSummary[] = [];
    for (const id of ids) {
      let log: SessionLog;
      try {
        log = this.#get(id).log;
      } catch {
        continue;
      }
      const meta = log.meta;
      if (params.cwd && meta.cwd !== params.cwd && meta.worktree?.repoRoot !== params.cwd) continue;
      const snap = log.snapshot;
      if (query && !matches(snap.title ?? "", snap.items, query)) continue;
      out.push({
        id,
        cwd: meta.cwd,
        ...(meta.title ? { title: meta.title } : {}),
        state: snap.state,
        selection: snap.selection,
        updatedAt: meta.updatedAt,
        lastSequence: log.sequence,
        ...(meta.parentSessionId ? { parentSessionId: meta.parentSessionId } : {}),
      });
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out.slice(0, params.limit ?? 200);
  }

  startTurn(params: ClientCommandParams["turn.start"]): ClientCommandResults["turn.start"] {
    const live = this.#get(params.sessionId);
    if (live.active) throw new WireError("conflict", "A turn is already running. Steer it or queue the message.");
    const instance = this.#o.registry.get(params.selection.instanceId);
    if (!instance) throw new WireError("not_found", `No provider instance ${params.selection.instanceId}.`);
    const gate = this.#o.registry.isEnabled(instance.id);
    if (!gate.enabled) throw new WireError("not_ready", gate.reason ?? `${instance.label} is not available.`);
    if (instance.status === "not-installed") throw new WireError("not_ready", instance.statusMessage ?? `${instance.label} is not installed.`);
    if (instance.status === "signed-out") throw new WireError("not_ready", instance.statusMessage ?? `Sign in to ${instance.label} first.`);
    const log = live.log;
    log.updateMeta({
      selection: params.selection,
      runtimeMode: params.runtimeMode,
      interactionMode: params.interactionMode,
      ...(params.routing ? { routing: params.routing } : {}),
      ...(log.meta.title ? {} : { title: params.input.conversation ? titleFrom(`From ${params.input.conversation.fromTitle}`) : titleFrom(params.input.text) }),
    });
    // Any new turn supersedes a resume-at-reset waiting for this session.
    if (log.snapshot.scheduledResume) this.#clearSchedule(live);
    const turnId = newId("t");
    const ordinal = log.meta.turnCount + 1;
    this.#addItem(live, inputItem(turnId, params.input, "send"));
    log.emit({ type: "turn.started", turnId, selection: params.selection });
    const abort = new AbortController();
    const done = deferred<TurnOutcome>();
    live.active = { turnId, ordinal, abort, done: done.promise };
    void this.#runTurn(live, instance, params, turnId, ordinal, abort).then(
      (outcome) => done.resolve(outcome),
      (error) => {
        this.#o.logger.error(`turn ${turnId}: ${describeError(error)}`);
        done.resolve("failed");
      },
    );
    return { turnId };
  }

  async steer(params: ClientCommandParams["turn.steer"]): Promise<ClientCommandResults["turn.steer"]> {
    const live = this.#get(params.sessionId);
    const active = live.active;
    if (!active || active.turnId !== params.turnId) {
      // The turn already ended: the instruction becomes the next message.
      this.queue({ sessionId: params.sessionId, input: params.input });
      return { accepted: false };
    }
    const instance = live.providerInstanceId ? this.#o.registry.get(live.providerInstanceId) : undefined;
    const caps = instance ? this.#o.registry.adapterFor(instance.kind)?.capabilities(instance) : undefined;
    if (caps?.steering && live.provider?.steer && (await live.provider.steer(params.input))) {
      this.#addItem(live, inputItem(active.turnId, params.input, "steer"));
      return { accepted: true };
    }
    this.queue({ sessionId: params.sessionId, input: params.input });
    return { accepted: false };
  }

  queue(params: ClientCommandParams["turn.queue"]): ClientCommandResults["turn.queue"] {
    const live = this.#get(params.sessionId);
    const entry: QueuedInput = { id: newId("q"), input: params.input, queuedAt: nowIso() };
    const queue = [...live.log.snapshot.queue, entry];
    live.log.emit({ type: "queue.updated", queue });
    if (!live.active) this.#drainQueue(live);
    return { queuedId: entry.id };
  }

  /** Edits or removes a queued entry (QueueDock). Not on the wire yet; used by the dock via turn.queue semantics. */
  dequeue(sessionId: string, queuedId: string): boolean {
    const live = this.#get(sessionId);
    const queue = live.log.snapshot.queue;
    const next = queue.filter((q) => q.id !== queuedId);
    if (next.length === queue.length) return false;
    live.log.emit({ type: "queue.updated", queue: next });
    return true;
  }

  async interrupt(params: ClientCommandParams["turn.interrupt"]): Promise<void> {
    const live = this.#get(params.sessionId);
    const active = live.active;
    if (!active || (params.turnId && params.turnId !== active.turnId)) return;
    active.userInterrupted = true;
    for (const [requestId] of live.pending) this.#resolvePending(live, requestId, { decision: "cancel" });
    active.abort.abort();
    await live.provider?.interrupt().catch(() => undefined);
  }

  respond(params: ClientCommandParams["approval.respond"]): void {
    const live = this.#get(params.sessionId);
    const pending = live.pending.get(params.requestId);
    if (!pending) throw new WireError("not_found", "That request is no longer waiting.");
    // Fail closed: only a decision the request offered is accepted (a client cannot widen
    // "allow once" into "allow for the session").
    const item = live.log.snapshot.items.find((i) => i.id === pending.itemId);
    const offered: readonly string[] = (item?.kind === "approval_request" ? item.options : undefined) ?? ["accept", "decline", "cancel"];
    if (!offered.includes(params.decision)) throw new WireError("bad_request", `This request does not offer "${String(params.decision)}".`);
    this.#resolvePending(live, params.requestId, {
      decision: params.decision,
      ...(params.updatedInput ? { updatedInput: params.updatedInput } : {}),
      ...(params.answers ? { answers: params.answers } : {}),
    });
  }

  async rollback(params: ClientCommandParams["checkpoint.rollback"]): Promise<ClientCommandResults["checkpoint.rollback"]> {
    const live = this.#get(params.sessionId);
    if (live.active) throw new WireError("conflict", "Stop the running turn before restoring a checkpoint.");
    const item = this.#checkpointItem(live, params.checkpointId);
    const ordinal = item?.turnOrdinal ?? (params.checkpointId === "cp_0" ? 0 : undefined);
    if (ordinal === undefined) throw new WireError("not_found", "No such checkpoint.");
    const cwd = live.log.meta.cwd;
    let restoredFiles = 0;
    let skipped: string[] = [];
    try {
      // Scoped to this session: only files its own turns changed after the checkpoint, inside its
      // folder. Another session's (or the user's) edits in the same repository are never reverted.
      const result = await this.checkpoints.rollback(cwd, live.log.id, ordinal, {
        subtree: cwd,
        latestTurn: live.log.meta.turnCount,
        paths: await this.#touchedPaths(live, item),
      });
      restoredFiles = result.restoredFiles;
      skipped = result.skipped;
    } catch (error) {
      throw new WireError("unsupported", `Files could not be restored: ${describeError(error)}`);
    }
    const rewound = live.provider?.rewindTo ? await live.provider.rewindTo(ordinal).catch(() => false) : false;
    live.log.updateMeta({ turnCount: ordinal, ...(live.provider ? { providerState: { ...live.provider.resumeState(), instanceId: live.providerInstanceId } } : {}) });
    this.#notice(
      live.log.id,
      "info",
      `Restored ${restoredFiles} file${restoredFiles === 1 ? "" : "s"} to ${ordinal === 0 ? "before the first turn" : `the end of turn ${ordinal}`}.${rewound || !live.provider ? "" : " The agent still remembers the later turns."}${
        skipped.length ? ` Left ${skipped.length} file${skipped.length === 1 ? "" : "s"} alone that changed after this thread's last turn: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}.` : ""
      }`,
      "rollback",
    );
    return { restoredFiles };
  }

  /** Repository-relative paths of the file_change items after a checkpoint (all of them for cp_0). */
  async #touchedPaths(live: LiveSession, checkpoint: CheckpointItem | undefined): Promise<string[]> {
    const cwd = live.log.meta.cwd;
    const root = await this.checkpoints.repoRoot(cwd);
    if (!root) return [];
    const items = live.log.snapshot.items;
    const start = checkpoint ? items.indexOf(checkpoint) + 1 : 0;
    const out = new Set<string>();
    for (const item of items.slice(Math.max(0, start))) {
      if (item.kind !== "file_change") continue;
      for (const change of item.changes) {
        for (const file of [change.path, change.previousPath]) {
          if (!file) continue;
          const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
          const rel = normalizeRepoPath(path.relative(root, abs).split(path.sep).join("/"));
          if (rel) out.add(rel);
        }
      }
    }
    return [...out];
  }

  /**
   * Applies a patch (or its reverse: a rejected hunk) in the session's own folder, all or nothing.
   * Refused while a turn runs, so it never races the agent's own edits.
   */
  async applyPatch(params: ClientCommandParams["checkpoint.applyPatch"]): Promise<ClientCommandResults["checkpoint.applyPatch"]> {
    const live = this.#get(params.sessionId);
    if (typeof params.patch !== "string" || !params.patch.trim()) throw new WireError("bad_request", "patch is required.");
    if (live.active && !params.checkOnly) throw new WireError("conflict", "Stop the running turn before changing its files.");
    let result: ClientCommandResults["checkpoint.applyPatch"];
    try {
      result = await this.checkpoints.applyPatch(live.log.meta.cwd, params.patch, { reverse: params.reverse === true, checkOnly: params.checkOnly === true });
    } catch (error) {
      if (error instanceof PatchError) throw new WireError(error.code, error.message);
      throw new WireError("internal", describeError(error));
    }
    if (result.applied) {
      const n = result.files.length;
      this.#notice(live.log.id, "info", `${params.reverse ? "Reverted" : "Applied"} a change to ${n === 1 ? result.files[0] : `${n} files`}.`, "patch_applied");
    }
    return result;
  }

  // ── Resume at reset ────────────────────────────────────────────────────

  /** Schedules a turn for when the usage window resets (default: the session's resumeAt). Replaces an earlier one. */
  schedule(params: ClientCommandParams["turn.schedule"]): ClientCommandResults["turn.schedule"] {
    const live = this.#get(params.sessionId);
    const when = params.at ?? live.log.snapshot.resumeAt ?? this.#limitResumeAt(live);
    if (!when) throw new WireError("bad_request", "No reset time is known for this session; pass `at`.");
    const at = Date.parse(when);
    if (!Number.isFinite(at)) throw new WireError("bad_request", "`at` must be an ISO-8601 time.");
    if (at - Date.now() > MAX_SCHEDULE_AHEAD_MS) throw new WireError("bad_request", "A resume can be scheduled at most 8 days ahead.");
    if (params.input !== undefined && (typeof params.input !== "object" || typeof params.input.text !== "string")) {
      throw new WireError("bad_request", "input must be {text}.");
    }
    this.#clearTimer(live.log.id);
    const schedule: ScheduledResume = { id: newId("rs"), at: new Date(at).toISOString(), createdAt: nowIso(), ...(params.input ? { input: params.input } : {}) };
    live.log.emit({ type: "session.scheduled", scheduledResume: schedule });
    this.#writeScheduleIndex();
    this.#arm(live.log.id, schedule);
    return { schedule };
  }

  unschedule(params: ClientCommandParams["turn.unschedule"]): ClientCommandResults["turn.unschedule"] {
    const live = this.#get(params.sessionId);
    const current = live.log.snapshot.scheduledResume;
    if (!current || (params.scheduleId && params.scheduleId !== current.id)) return { cancelled: false };
    this.#clearSchedule(live);
    return { cancelled: true };
  }

  /** Re-arms schedules saved before a restart (called once at startup). A schedule already due fires now. */
  restoreSchedules(): number {
    let armed = 0;
    for (const [sessionId, id] of Object.entries(this.#readScheduleIndex())) {
      let live: LiveSession;
      try {
        live = this.#get(sessionId);
      } catch {
        continue;
      }
      const schedule = live.log.snapshot.scheduledResume;
      if (!schedule || schedule.id !== id) continue;
      this.#arm(sessionId, schedule);
      armed++;
    }
    this.#writeScheduleIndex();
    return armed;
  }

  #limitResumeAt(live: LiveSession): string | undefined {
    const items = live.log.snapshot.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === "interrupt" && item.reason === "limit") return item.resumeAt;
      if (item.kind === "user_message") return undefined;
    }
    return undefined;
  }

  #arm(sessionId: string, schedule: ScheduledResume): void {
    this.#clearTimer(sessionId);
    const delay = Math.max(0, Math.min(Date.parse(schedule.at) - Date.now(), MAX_SCHEDULE_AHEAD_MS));
    const timer = setTimeout(() => this.#fire(sessionId, schedule.id), delay);
    timer.unref?.();
    this.#scheduleTimers.set(sessionId, { id: schedule.id, timer });
  }

  #fire(sessionId: string, id: string): void {
    this.#scheduleTimers.delete(sessionId);
    let live: LiveSession;
    try {
      live = this.#get(sessionId);
    } catch {
      return;
    }
    const schedule = live.log.snapshot.scheduledResume;
    if (!schedule || schedule.id !== id) return;
    this.#clearSchedule(live);
    this.#notice(sessionId, "info", "The usage window reset, so the paused turn is starting again.", "resume_at_reset");
    // Through the queue: if a turn is somehow running it waits its turn, and a still-limited
    // provider leaves the message queued with a notice instead of losing it.
    this.queue({ sessionId, input: schedule.input ?? { text: RESUME_TEXT } });
  }

  #clearSchedule(live: LiveSession): void {
    this.#clearTimer(live.log.id);
    if (live.log.snapshot.scheduledResume) live.log.emit({ type: "session.scheduled" });
    this.#writeScheduleIndex();
  }

  #clearTimer(sessionId: string): void {
    const armed = this.#scheduleTimers.get(sessionId);
    if (armed) clearTimeout(armed.timer);
    this.#scheduleTimers.delete(sessionId);
  }

  get #scheduleFile(): string {
    return path.join(this.#o.dataDir, "schedules.json");
  }

  #readScheduleIndex(): Record<string, string> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.#scheduleFile, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return Object.fromEntries(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(e[0])));
    } catch {
      return {};
    }
  }

  /** sessionId → schedule id for every live session with a schedule, merged with sessions not loaded yet. */
  #writeScheduleIndex(): void {
    const index = this.#readScheduleIndex();
    for (const [id, live] of this.#live) {
      const schedule = live.log.snapshot.scheduledResume;
      if (schedule) index[id] = schedule.id;
      else delete index[id];
    }
    const tmp = `${this.#scheduleFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(index), { mode: 0o600 });
      fs.renameSync(tmp, this.#scheduleFile);
    } catch (error) {
      this.#o.logger.warn(`schedules: ${describeError(error)}`);
    }
  }

  async diff(params: ClientCommandParams["checkpoint.diff"]): Promise<ClientCommandResults["checkpoint.diff"]> {
    const live = this.#get(params.sessionId);
    const cwd = live.log.meta.cwd;
    if (!(await this.checkpoints.repoRoot(cwd))) throw new WireError("unsupported", "Diffs need a git repository.");
    const id = live.log.id;
    if (!params.checkpointId) {
      const base = await this.checkpoints.resolve(cwd, id, 0);
      if (!base) return { diff: "", files: [] };
      return this.checkpoints.diff(cwd, base, "worktree");
    }
    const item = this.#checkpointItem(live, params.checkpointId);
    if (!item) throw new WireError("not_found", "No such checkpoint.");
    const to = await this.checkpoints.resolve(cwd, id, item.turnOrdinal);
    const from = item.turnOrdinal > 0 ? await this.checkpoints.resolve(cwd, id, item.turnOrdinal - 1) : undefined;
    if (!to || !from) return { diff: "", files: [] };
    return this.checkpoints.diff(cwd, from, to);
  }

  /**
   * The checkpoint item for an id, refusing one that a later turn replaced: refs are keyed by
   * turn ordinal, so after a restore to turn k the next turn k+1 overwrites the old k+1 ref and
   * the old item would silently restore (or diff) the new turn's files.
   */
  #checkpointItem(live: LiveSession, checkpointId: string): CheckpointItem | undefined {
    const checkpoints = live.log.snapshot.items.filter((i): i is CheckpointItem => i.kind === "checkpoint");
    const item = checkpoints.find((i) => i.checkpointId === checkpointId);
    if (!item) return undefined;
    const newest = checkpoints.filter((i) => i.turnOrdinal === item.turnOrdinal).at(-1);
    if (newest && newest !== item) throw new WireError("conflict", "That checkpoint was replaced after an earlier restore.");
    return item;
  }

  async close(sessionId: string): Promise<void> {
    const live = this.#live.get(sessionId);
    if (!live) return;
    live.generation = (live.generation ?? 0) + 1;
    if (live.active) await this.interrupt({ sessionId });
    await live.provider?.close().catch(() => undefined);
    live.provider = undefined;
    live.providerInstanceId = undefined;
    this.#o.mcp.revokeSession(sessionId);
    live.mcpToken = undefined;
    await Promise.all([...this.#closed].map((l) => Promise.resolve(l(sessionId)).catch(() => undefined)));
  }

  /** Stops every session running on one provider instance (sign-in replaced or signed out). The logs stay. */
  async closeProviderSessions(instanceId: string): Promise<number> {
    const ids = [...this.#live.entries()].filter(([, live]) => live.providerInstanceId === instanceId).map(([id]) => id);
    await Promise.all(ids.map((id) => this.close(id)));
    return ids.length;
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.#scheduleTimers.keys()]) this.#clearTimer(id);
    await Promise.all([...this.#live.keys()].map((id) => this.close(id)));
    for (const live of this.#live.values()) live.log.close();
  }

  /** Resolves when the session has no running turn. */
  waitIdle(sessionId: string, signal?: AbortSignal): Promise<void> {
    const live = this.#get(sessionId);
    if (!live.active && live.log.snapshot.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => resolve();
      live.idleWaiters.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  isRunning(sessionId: string): boolean {
    return !!this.#get(sessionId).active;
  }

  // ── Turn execution ─────────────────────────────────────────────────────

  async #runTurn(
    live: LiveSession,
    instance: ProviderInstance,
    params: ClientCommandParams["turn.start"],
    turnId: string,
    ordinal: number,
    abort: AbortController,
  ): Promise<TurnOutcome> {
    const log = live.log;
    const cwd = log.meta.cwd;
    const generation = live.generation ?? 0;
    let result: TurnResult;
    try {
      if (ordinal === 1 || !(await this.checkpoints.resolve(cwd, log.id, ordinal - 1).catch(() => undefined))) {
        await this.checkpoints.create(cwd, log.id, ordinal - 1).catch((e) => this.#o.logger.debug(`baseline checkpoint: ${describeError(e)}`));
      }
      // Stopped (or the session closed) while the baseline checkpoint was written: start nothing.
      if (abort.signal.aborted || (live.generation ?? 0) !== generation) throw new TurnStoppedEarly();
      const provider = await this.#ensureProvider(live, instance, params.selection, generation);
      const sink = this.#sink(live, instance.id, turnId);
      // Interrupted while the runtime was starting: nothing was sent yet.
      if (abort.signal.aborted) throw new TurnStoppedEarly();
      result = await provider.runTurn({
        sessionId: log.id,
        turnId,
        turnOrdinal: ordinal,
        cwd,
        // Team lane: a vendor agent leads a Plan → Build → Verify team through the Alevr MCP tools.
        input: withTeamBrief(params.input, params.routing, instance.kind, params.interactionMode),
        selection: params.selection,
        ...(params.routing ? { routing: params.routing } : {}),
        runtimeMode: params.runtimeMode,
        interactionMode: params.interactionMode,
        sink,
        signal: abort.signal,
      });
      if (live.provider) log.updateMeta({ providerState: { ...live.provider.resumeState(), instanceId: instance.id } });
    } catch (error) {
      result = error instanceof TurnStoppedEarly ? { outcome: "interrupted" } : { outcome: "failed", message: describeError(error) };
    }
    if (live.active?.userInterrupted && result.outcome === "failed") result = { outcome: "interrupted" };
    // Requests still open when the turn ended can no longer be answered.
    for (const [requestId] of live.pending) this.#resolvePending(live, requestId, { decision: "cancel" }, "expired");

    try {
      const cp = await this.checkpoints.create(cwd, log.id, ordinal);
      if (cp) {
        this.#addItem(live, {
          id: newId("cp"),
          kind: "checkpoint",
          turnId,
          createdAt: nowIso(),
          checkpointId: `cp_${ordinal}_${turnId}`,
          turnOrdinal: ordinal,
          ref: cp.ref,
          filesChanged: cp.filesChanged,
          additions: cp.additions,
          deletions: cp.deletions,
        });
      }
    } catch (error) {
      this.#o.logger.debug(`checkpoint: ${describeError(error)}`);
    }

    if (result.outcome === "limited") {
      const item: InterruptItem = { id: newId("int"), kind: "interrupt", turnId, createdAt: nowIso(), reason: "limit", ...(result.message ? { message: result.message } : {}), ...(result.resumeAt ? { resumeAt: result.resumeAt } : {}) };
      this.#addItem(live, item);
      this.#o.registry.update(instance.id, { status: "limited", statusMessage: result.message ?? `${instance.label} usage limit reached.` });
    } else if (result.outcome === "interrupted") {
      this.#addItem(live, { id: newId("int"), kind: "interrupt", turnId, createdAt: nowIso(), reason: "user" });
    } else if (result.outcome === "failed") {
      this.#addItem(live, { id: newId("err"), kind: "error", turnId, createdAt: nowIso(), message: result.message ?? "The turn failed.", retryable: true });
    } else if (instance.status === "limited") {
      this.#o.registry.update(instance.id, { status: "ready" });
    }
    log.updateMeta({ turnCount: ordinal });
    // The limited state (with its reset time) lands before turn.completed so a
    // client that reacts to the completion already sees when to resume.
    if (result.outcome === "limited") {
      log.emit({ type: "session.state", state: "limited", ...(result.resumeAt ? { resumeAt: result.resumeAt } : {}), message: result.message ?? "Usage limit reached." });
    }
    log.emit({ type: "turn.completed", turnId, outcome: result.outcome, ...(result.usage ? { usage: this.#usageWithWindow(live, result.usage) } : {}) });
    live.active = undefined;
    for (const listener of this.#turnEnded) {
      try {
        listener(log.id, result.outcome);
      } catch {
        /* listener errors never break the session */
      }
    }
    if (result.outcome === "completed") this.#drainQueue(live);
    if (!live.active) {
      for (const w of live.idleWaiters.splice(0)) w();
    }
    return result.outcome;
  }

  #drainQueue(live: LiveSession): void {
    const queue = live.log.snapshot.queue;
    if (live.active || queue.length === 0) return;
    const [next, ...rest] = queue;
    live.log.emit({ type: "queue.updated", queue: rest });
    const meta = live.log.meta;
    try {
      this.startTurn({
        sessionId: live.log.id,
        input: next.input,
        selection: meta.selection,
        ...(meta.routing ? { routing: meta.routing } : {}),
        runtimeMode: meta.runtimeMode,
        interactionMode: meta.interactionMode,
      });
    } catch (error) {
      // Put it back; the user decides what to do once the provider is ready again.
      live.log.emit({ type: "queue.updated", queue: [next, ...rest] });
      this.#notice(live.log.id, "warning", `The queued message is waiting: ${describeError(error)}`, "queue_blocked");
    }
  }

  async #ensureProvider(live: LiveSession, instance: ProviderInstance, selection: ModelSelection, generation = live.generation ?? 0): Promise<ProviderSession> {
    if (live.provider && live.providerInstanceId === instance.id) return live.provider;
    if (live.provider) {
      await live.provider.close().catch(() => undefined);
      live.provider = undefined;
    }
    const adapter = this.#o.registry.adapterFor(instance.kind);
    if (!adapter) throw new WireError("unsupported", `This build has no ${instance.kind} adapter.`);
    const meta = live.log.meta;
    const resumeState = meta.providerState && meta.providerState.instanceId === instance.id ? meta.providerState : undefined;
    let mcp: McpEndpoint | undefined;
    if (adapter.capabilities(instance).mcpInjection) {
      live.mcpToken ??= this.#o.mcp.issueToken({ sessionId: live.log.id, depth: meta.parentSessionId ? 1 : 0 });
      mcp = { name: MCP_SERVER_NAME, url: `${this.#o.baseUrl()}/mcp`, authorization: `Bearer ${live.mcpToken}` };
    }
    const opened = await adapter.openSession(instance, {
      sessionId: live.log.id,
      cwd: meta.cwd,
      selection,
      ...(resumeState ? { resumeState } : {}),
      ...(mcp ? { mcp } : {}),
      ...(!mcp && this.#engineTools ? { extraTools: this.#engineTools(live.log.id) } : {}),
      logger: this.#o.logger,
    });
    if ((live.generation ?? 0) !== generation) {
      await opened.close().catch(() => undefined);
      throw new TurnStoppedEarly();
    }
    live.provider = opened;
    live.providerInstanceId = instance.id;
    return live.provider;
  }

  #sink(live: LiveSession, instanceId: string, turnId: string): TurnSink {
    const log = live.log;
    return {
      item: (item) => this.#addItem(live, item),
      delta: (itemId, field, append) => {
        if (live.known.has(itemId)) log.emit({ type: "item.delta", itemId, field, append });
      },
      usage: (usage) => log.emit({ type: "usage.updated", usage: this.#usageWithWindow(live, usage) }),
      limits: (windows) => this.#mergeLimits(instanceId, windows),
      notice: (level, text, code) => this.#notice(log.id, level, text, code),
      newItemId: (prefix = "i") => newId(prefix),
      now: nowIso,
      requestApproval: (request) => {
        const requestId = request.requestId ?? newId("ap");
        const item: ApprovalRequestItem = {
          id: newId("apr"),
          kind: "approval_request",
          turnId,
          createdAt: nowIso(),
          callId: request.callId,
          requestId,
          action: request.action,
          summary: request.summary,
          ...(request.justification ? { justification: request.justification } : {}),
          ...(request.detail ? { detail: request.detail } : {}),
          options: request.options ?? ["accept", "decline", "cancel"],
          status: "pending",
        };
        return this.#await(live, requestId, item, "approval");
      },
      requestUserInput: (request) => {
        const requestId = request.requestId ?? newId("q");
        const item: UserInputRequestItem = {
          id: newId("uir"),
          kind: "user_input_request",
          turnId,
          createdAt: nowIso(),
          requestId,
          questions: request.questions,
          status: "pending",
        };
        return this.#await(live, requestId, item, "input");
      },
    };
  }

  #await(live: LiveSession, requestId: string, item: ApprovalRequestItem | UserInputRequestItem, kind: "approval" | "input"): Promise<ApprovalAnswer> {
    const answer = deferred<ApprovalAnswer>();
    live.pending.set(requestId, { itemId: item.id, kind, answer });
    this.#addItem(live, item);
    live.log.emit({ type: "session.state", state: "waiting" });
    if (live.active?.abort.signal.aborted) this.#resolvePending(live, requestId, { decision: "cancel" });
    return answer.promise;
  }

  #resolvePending(live: LiveSession, requestId: string, answer: ApprovalAnswer, closedStatus?: "expired"): void {
    const pending = live.pending.get(requestId);
    if (!pending) return;
    live.pending.delete(requestId);
    const item = live.log.snapshot.items.find((i) => i.id === pending.itemId);
    if (item?.kind === "approval_request") {
      live.log.emit({ type: "item.updated", item: { ...item, status: closedStatus ?? "resolved", decision: answer.decision } });
    } else if (item?.kind === "user_input_request") {
      const answered = answer.decision === "accept" || answer.decision === "acceptForSession";
      live.log.emit({ type: "item.updated", item: { ...item, status: answered ? "answered" : "cancelled", ...(answer.answers ? { answers: answer.answers } : {}) } });
    }
    if (live.pending.size === 0 && live.active && !closedStatus) live.log.emit({ type: "session.state", state: "running" });
    pending.answer.resolve(answer);
  }

  #addItem(live: LiveSession, item: TurnItem): void {
    if (live.known.has(item.id)) live.log.emit({ type: "item.updated", item });
    else {
      live.known.add(item.id);
      live.log.emit({ type: "item.added", item });
    }
  }

  #notice(sessionId: string, level: "info" | "warning", text: string, code?: string): void {
    const live = this.#live.get(sessionId);
    if (!live) return;
    this.#addItem(live, { id: newId("n"), kind: "system_notice", turnId: live.active?.turnId, createdAt: nowIso(), level, text, ...(code ? { code } : {}) } as TurnItem);
  }

  /** Adds an item to a session from outside a turn (subagent tracking in the parent). */
  /**
   * Tools the built-in Alevr engine gets on top of its own, per session (the
   * cross-conversation tools). Vendor runtimes get the same tools over MCP.
   */
  setEngineTools(factory: ((sessionId: string) => unknown[]) | undefined): void {
    this.#engineTools = factory;
  }

  upsertItem(sessionId: string, item: TurnItem): void {
    this.#addItem(this.#get(sessionId), item);
  }

  activeTurnId(sessionId: string): string | undefined {
    return this.#get(sessionId).active?.turnId;
  }

  #usageWithWindow(live: LiveSession, usage: SessionUsage): SessionUsage {
    const prev = live.log.snapshot.usage;
    const out: SessionUsage = { ...prev, ...usage };
    if (!out.contextWindow && live.log.meta.selection.contextTokens) out.contextWindow = live.log.meta.selection.contextTokens;
    return out;
  }

  #mergeLimits(instanceId: string, windows: UsageWindow[]): void {
    const current = this.#o.registry.get(instanceId);
    if (!current) return;
    const byId = new Map((current.limits ?? []).map((w) => [w.id, w]));
    for (const w of windows) byId.set(w.id, { ...byId.get(w.id), ...w });
    this.#o.registry.update(instanceId, { limits: [...byId.values()] });
  }
}

const MAX_SCHEDULE_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
const RESUME_TEXT = "Your usage window has reset. Continue where you stopped.";

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line || "New thread";
}

function matches(title: string, items: TurnItem[], query: string): boolean {
  if (title.toLowerCase().includes(query)) return true;
  return items.some((i) => (i.kind === "user_message" || i.kind === "assistant_message") && i.text.toLowerCase().includes(query));
}

/**
 * The item an input becomes: the user's message, or, when it is a message from
 * another of the user's conversations, a conversation_message. Never both: a
 * cross-conversation message must never read as something the user typed.
 */
function inputItem(turnId: string, input: UserInput, delivery: "send" | "steer"): TurnItem {
  const c = input.conversation;
  if (c) {
    return {
      id: newId("cm"),
      kind: "conversation_message",
      turnId,
      createdAt: nowIso(),
      direction: c.notice ? "notice" : "received",
      peerRef: c.fromRef,
      peerTitle: c.fromTitle,
      peerProduct: c.fromProduct,
      text: c.text,
      hop: c.hop,
      chainId: c.chainId,
      ...(c.linkId ? { linkId: c.linkId } : {}),
    };
  }
  return { id: newId("u"), kind: "user_message", turnId, createdAt: nowIso(), text: input.text, ...(input.attachments?.length ? { attachments: input.attachments } : {}), delivery };
}

export type { ApprovalDecision, FileChangeEntry, UserInput };

class TurnStoppedEarly extends Error {}
