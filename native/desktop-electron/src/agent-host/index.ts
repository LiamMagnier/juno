/**
 * Agent host entry point — runs as an Electron `utilityProcess`.
 *
 * This file is the whole boundary. It owns the port, the outbound sequence
 * counter, the inbound replay guard, and the shutdown path; `session-manager.ts`
 * owns the agent sessions and knows nothing about transports. The split matters
 * because it is what lets the manager be tested without Electron, and what
 * keeps "every inbound frame is parsed before it is acted on" a claim you can
 * check by reading one function.
 *
 * Three rules hold throughout:
 *
 *   - Nothing acts on an unparsed frame. `parseHostCommand` runs first, always,
 *     and a frame that fails is answered with `protocol_error` and dropped.
 *   - Nothing logs a payload. Log lines name the command `type` and never its
 *     contents, because `configure` carries a session cookie. Anything derived
 *     from an error string goes through `redactSecrets` on the way out.
 *   - Nothing exits without tearing down. SIGTERM, SIGINT, a `shutdown`
 *     command, a lost port and an uncaught exception all converge on the same
 *     `shutdown()` — running it once, denying every pending approval, and
 *     reaping what agent-core's tools left behind.
 */

import { execFileSync } from 'node:child_process';

import {
  HOST_PROTOCOL_VERSION,
  InboundSequenceGuard,
  clamp,
  describeError,
  parseHostCommand,
  redactSecrets,
  type HostCommand,
  type HostMessage,
  type HostMessageDraft,
  LIMITS,
} from './host-protocol.js';
import { HostCommandError, SessionManager } from './session-manager.js';

/* -------------------------------------------------------------------------- */
/* Tuning                                                                      */
/* -------------------------------------------------------------------------- */

/** How long in-flight turns get to unwind before shutdown stops waiting. */
const DEFAULT_SHUTDOWN_GRACE_MS = 5_000;
/** Unsolicited liveness beat, so main can notice a wedged host without probing. */
const HEARTBEAT_INTERVAL_MS = 5_000;
/** Time allowed for the last messages to drain from the port before exit. */
const PORT_DRAIN_MS = 50;

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The shape of `process.parentPort` this file relies on.
 *
 * Declared structurally rather than imported from `electron` so the host can be
 * exercised with a fake port in a unit test, and so the one place that depends
 * on Electron's runtime is a single narrowing function.
 */
interface ParentPortLike {
  postMessage(message: unknown): void;
  on(channel: 'message', listener: (event: { data: unknown }) => void): void;
  start?: () => void;
}

function resolveParentPort(): ParentPortLike | null {
  const candidate: unknown = (process as unknown as { parentPort?: unknown }).parentPort;
  if (candidate === null || typeof candidate !== 'object') return null;
  const port = candidate as Partial<ParentPortLike>;
  if (typeof port.postMessage !== 'function' || typeof port.on !== 'function') return null;
  return port as ParentPortLike;
}

const resolvedPort = resolveParentPort();
if (!resolvedPort) {
  /* Not an Electron utility process. Fail loudly rather than starting a host
     nothing can talk to — a silently orphaned agent host is exactly the thing
     this design is meant to make impossible. */
  console.error('[agent-host] no parentPort: this entry must run under utilityProcess.fork');
  process.exit(78 /* EX_CONFIG */);
}
/* Re-bound as a non-nullable const so every closure below sees the narrowing
   rather than depending on control-flow analysis reaching into them. */
const parentPort: ParentPortLike = resolvedPort;

const startedAt = Date.now();
let outboundSeq = 0;

/**
 * The only writer to the port.
 *
 * `seq` is stamped here and nowhere else, which is what makes "monotonically
 * increasing" true by construction. A clone failure is caught and reported
 * rather than thrown: `postMessage` rejects values the structured-clone
 * algorithm cannot copy, and an unhandled throw here would take down a host
 * holding live sessions over one bad event.
 */
function send(draft: HostMessageDraft): void {
  outboundSeq += 1;
  const message = { ...draft, seq: outboundSeq } as HostMessage;
  try {
    parentPort.postMessage(message);
  } catch (err) {
    const detail = describeError(err);
    console.error(`[agent-host] failed to post ${draft.type}: ${detail}`);
    if (draft.type !== 'protocol_error') {
      outboundSeq += 1;
      try {
        parentPort.postMessage({
          type: 'protocol_error',
          seq: outboundSeq,
          code: 'internal',
          message: clamp(`could not serialise a ${draft.type} message: ${detail}`, LIMITS.errorChars),
        } satisfies HostMessage);
      } catch {
        /* The port is gone. `port-loss` handling below will take it from here. */
      }
    }
  }
}

function log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
  send({ type: 'log', level, message: clamp(redactSecrets(message), LIMITS.errorChars) });
}

/* -------------------------------------------------------------------------- */
/* Session manager                                                             */
/* -------------------------------------------------------------------------- */

const manager = new SessionManager({ send });
const inbound = new InboundSequenceGuard();

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

parentPort.on('message', (event) => {
  handleFrame(event.data);
});
parentPort.start?.();

function handleFrame(raw: unknown): void {
  const parsed = parseHostCommand(raw);
  if (!parsed.ok) {
    /* No `requestId` is trustworthy on a frame that failed validation, so this
       goes out as a protocol error rather than a command error. */
    send({ type: 'protocol_error', code: 'invalid_request', message: parsed.error });
    return;
  }

  const command = parsed.value;
  if (!inbound.accept(command.seq)) {
    /* A non-advancing seq is a duplicate. Dropping it here is the cheap half of
       approval idempotency; `SessionManager.settleApproval` is the half that
       would still hold if this check were removed. */
    send({
      type: 'protocol_error',
      code: 'stale_seq',
      message: `dropped a ${command.type} frame with seq ${command.seq}; last accepted ${inbound.lastAccepted}`,
    });
    return;
  }

  try {
    dispatch(command);
  } catch (err) {
    const requestId = 'requestId' in command ? command.requestId : undefined;
    const sessionId = 'sessionId' in command ? command.sessionId : undefined;
    if (err instanceof HostCommandError) {
      send({
        type: 'command_error',
        ...(requestId !== undefined ? { requestId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        code: err.code,
        message: clamp(redactSecrets(err.message), LIMITS.errorChars),
      });
      return;
    }
    send({
      type: 'command_error',
      ...(requestId !== undefined ? { requestId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      code: 'internal',
      message: describeError(err),
    });
    console.error(`[agent-host] ${command.type} failed`, err);
  }
}

function dispatch(command: HostCommand): void {
  switch (command.type) {
    case 'configure': {
      manager.configureBackend(command.backend);
      send({ type: 'ack', requestId: command.requestId });
      return;
    }

    case 'start': {
      const meta = manager.start({
        cwd: command.cwd,
        provider: command.provider,
        model: command.model,
        mode: command.mode,
      });
      send({
        type: 'session_started',
        requestId: command.requestId,
        sessionId: meta.id,
        meta,
      });
      return;
    }

    case 'resume': {
      const meta = manager.resume({ sessionId: command.sessionId, mode: command.mode });
      send({
        type: 'session_started',
        requestId: command.requestId,
        sessionId: meta.id,
        meta,
      });
      return;
    }

    case 'prompt': {
      manager.prompt(command.sessionId, command.text);
      /* Acknowledges acceptance, not completion: the turn's progress is the
         event stream, and it may block on an approval that can only arrive
         after this reply. */
      send({ type: 'ack', requestId: command.requestId, sessionId: command.sessionId });
      return;
    }

    case 'approval': {
      const result = manager.resolveApproval(
        command.sessionId,
        command.callId,
        command.decision,
      );
      send({
        type: 'approval_settled',
        requestId: command.requestId,
        sessionId: command.sessionId,
        callId: command.callId,
        outcome: result.outcome,
        decision: result.decision,
      });
      return;
    }

    case 'set_mode': {
      manager.setMode(command.sessionId, command.mode);
      send({ type: 'ack', requestId: command.requestId, sessionId: command.sessionId });
      return;
    }

    case 'undo': {
      const restored = manager.undo(command.sessionId);
      send({
        type: 'undo_result',
        requestId: command.requestId,
        sessionId: command.sessionId,
        restored,
      });
      return;
    }

    case 'diff': {
      const { patch, truncated } = manager.diff(command.sessionId, command.sinceTurn);
      send({
        type: 'diff_result',
        requestId: command.requestId,
        sessionId: command.sessionId,
        patch,
        truncated,
      });
      return;
    }

    case 'list_sessions': {
      send({
        type: 'sessions',
        requestId: command.requestId,
        sessions: manager.listSessions(),
      });
      return;
    }

    case 'abort': {
      manager.abort(command.sessionId);
      send({ type: 'ack', requestId: command.requestId, sessionId: command.sessionId });
      return;
    }

    case 'close_session': {
      manager.closeSession(command.sessionId, 'Closed by the app.');
      send({ type: 'ack', requestId: command.requestId, sessionId: command.sessionId });
      return;
    }

    case 'heartbeat': {
      sendHeartbeat(command.seq);
      return;
    }

    case 'shutdown': {
      void shutdown({
        reason: 'shutdown command',
        graceMs: command.graceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
        requestId: command.requestId,
        exitCode: 0,
      });
      return;
    }

    default: {
      /* Unreachable while the schema and this switch agree; a new command added
         to the schema and not here becomes a compile error on this line. */
      const unreachable: never = command;
      throw new HostCommandError(
        'invalid_request',
        `unhandled command: ${String((unreachable as { type?: unknown }).type)}`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Heartbeat                                                                   */
/* -------------------------------------------------------------------------- */

function sendHeartbeat(respondingToSeq?: number): void {
  send({
    type: 'heartbeat',
    ...(respondingToSeq !== undefined ? { respondingToSeq } : {}),
    uptimeMs: Date.now() - startedAt,
    liveSessions: manager.liveSessionCount,
    runningSessions: manager.runningSessionCount,
    pendingApprovals: manager.pendingApprovalCount,
    droppedEvents: manager.droppedEventCount,
  });
}

const heartbeat = setInterval(() => sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
/* The beat must not be a reason the process stays alive once everything else
   has finished; a host with no work left should be collectable. */
heartbeat.unref();

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                    */
/* -------------------------------------------------------------------------- */

let shutdownStarted: Promise<void> | null = null;

/**
 * Cancel everything, wait bounded, reap, report, exit. Runs at most once.
 *
 * Every termination path lands here, including the ones that are not requests:
 * a signal, a lost port, an uncaught exception. That is deliberate — the
 * failure mode this design is most exposed to is a host that dies while holding
 * live sessions, because agent-core's `bashTool` spawns its children `detached`
 * and they do not die with us.
 */
async function shutdown(opts: {
  reason: string;
  graceMs: number;
  requestId?: string;
  exitCode: number;
}): Promise<void> {
  if (shutdownStarted) return shutdownStarted;

  shutdownStarted = (async () => {
    clearInterval(heartbeat);
    let cancelledSessions = 0;
    let deniedApprovals = 0;
    let forced = false;

    try {
      const result = await manager.shutdown(opts.graceMs);
      cancelledSessions = result.cancelledSessions;
      deniedApprovals = result.deniedApprovals;
      forced = result.forced;
    } catch (err) {
      console.error(`[agent-host] shutdown failed: ${describeError(err)}`);
    }

    const reapedProcessGroups = reapDetachedChildren();

    send({
      type: 'shutdown_complete',
      ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
      cancelledSessions,
      deniedApprovals,
      reapedProcessGroups,
      forced,
    });

    /* Give the port a tick to flush the final message before the process goes
       away; `postMessage` is asynchronous and `process.exit` does not wait. */
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, PORT_DRAIN_MS);
      timer.unref();
    });
    process.exit(opts.exitCode);
  })();

  return shutdownStarted;
}

/**
 * Kill the process groups of any direct children still running.
 *
 * Best effort, and worth being precise about why it is needed at all.
 * agent-core's `bashTool` spawns with `detached: true` so that its own timeout
 * can kill a whole process tree; the side effect is that those children are
 * process-group leaders that outlive us. `ToolContext` carries no `AbortSignal`
 * either, so a command already running cannot be interrupted through
 * agent-core's API — `AgentSession.abort()` stops the model stream and the
 * subagents, not the shell. Waiting out the grace period and then reaping is
 * the only thing this side of the boundary can do about it.
 *
 * The safety condition is `pgid === pid`: a process group led by the child
 * itself, which is exactly what `detached: true` produces. Signalling a group
 * we share would signal us, and on macOS that group can contain the whole
 * Electron app. A child spawned without `detached` is left alone for that
 * reason, and grandchildren that were re-parented after their leader exited are
 * unreachable by any pid-based method.
 */
function reapDetachedChildren(): number {
  if (process.platform === 'win32') return 0;

  let table: string;
  try {
    table = execFileSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid='], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    /* No `ps`, or it timed out. Nothing else to try; main's `kill()` on the
       utility process is the outer backstop. */
    return 0;
  }

  const rows: Array<{ pid: number; ppid: number; pgid: number }> = [];
  let ownPgid = 0;
  for (const line of table.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    if (pid === process.pid) ownPgid = pgid;
    rows.push({ pid, ppid, pgid });
  }

  let reaped = 0;
  for (const row of rows) {
    if (row.ppid !== process.pid) continue;
    if (row.pid <= 1 || row.pid === process.pid) continue;
    /* Only groups the child leads, and never our own. */
    if (row.pgid !== row.pid) continue;
    if (ownPgid !== 0 && row.pgid === ownPgid) continue;
    try {
      process.kill(-row.pgid, 'SIGKILL');
      reaped += 1;
    } catch {
      /* Already gone between the snapshot and the signal. */
    }
  }
  return reaped;
}

/* -------------------------------------------------------------------------- */
/* Signals and last-resort handlers                                            */
/* -------------------------------------------------------------------------- */

/* `utilityProcess.kill()` sends SIGTERM on POSIX, so this is the ordinary path
   when main tears the host down without sending a `shutdown` command first. */
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    void shutdown({ reason: signal, graceMs: DEFAULT_SHUTDOWN_GRACE_MS, exitCode: 0 });
  });
}

/* If main goes away the port closes and stdio ends. Treat that as a terminal
   condition rather than lingering: a host with nobody to report approvals to
   can never get a decision, and every session it holds would block forever. */
process.on('disconnect', () => {
  void shutdown({ reason: 'parent disconnected', graceMs: 1_000, exitCode: 0 });
});

process.on('uncaughtException', (err) => {
  console.error('[agent-host] uncaught exception', err);
  log('error', `uncaught exception: ${describeError(err)}`);
  void shutdown({ reason: 'uncaught exception', graceMs: 1_000, exitCode: 1 });
});

process.on('unhandledRejection', (reason) => {
  console.error('[agent-host] unhandled rejection', reason);
  log('error', `unhandled rejection: ${describeError(reason)}`);
  /* Not fatal on its own — a rejected provider call inside a turn is already
     reported as an `error` event — but it is never expected, so it is loud. */
});

/* -------------------------------------------------------------------------- */
/* Announce                                                                    */
/* -------------------------------------------------------------------------- */

send({ type: 'ready', protocolVersion: HOST_PROTOCOL_VERSION, pid: process.pid });
