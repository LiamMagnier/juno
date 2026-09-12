"use client";

import * as React from "react";
import { toast } from "sonner";
import type { ChatMessage } from "@/hooks/use-chat";
import type { ClientActivityEvent, ClientMessage } from "@/types/chat";

/*
 * State for one Juno Code session (a kind:"code" conversation): persisted
 * history + the live remote task running on the user's Mac.
 *
 * Transport, matching the server contract exactly:
 *   POST /api/code/tasks                  { deviceId, workspacePath, workspaceName?, workspaceKey?, title?, prompt, conversationId }
 *                                         → { task, userMessage }
 *   GET  /api/code/tasks/[id]/events?afterSeq=N   (SSE)
 *        { type: "snapshot" | "events", task, events } … { type: "done", task, message }
 *   POST /api/code/tasks/[id]/respond     { requestId, approve }
 *   POST /api/code/tasks/[id]/cancel
 *   POST /api/code/tasks/[id]/steer       { text, requestId } → { status: "queued", userMessage? }
 *        … then a `steer_ack` event from the host marks it delivered.
 */

export type CodeSessionStatus = "idle" | "submitting" | "queued" | "running" | "awaiting_approval" | "stopping";

/**
 * A Code activity row: the chat vocabulary plus the two keys only Juno Code
 * writes. `patch` is a write row's unified diff; `exitCode` is a tool row's
 * process status. Both ride as extra keys rather than widening the shared
 * `ClientActivityEvent` — a chat reader that does not know them sees exactly
 * the row it always saw — and both now survive persistence (see the
 * additive read in src/lib/serializers.ts).
 */
export type CodeActivityEvent = ClientActivityEvent & { patch?: string; exitCode?: number };

/**
 * An instruction sent to a task that is already running, from the press to
 * the host's acknowledgement.
 *
 *   sending    the POST is in flight
 *   queued     the server appended it; the host reads it on its next post
 *   delivered  the host answered `steer_ack` — it is now the next user message
 *   failed     the server refused (a finished run, a cloud run, a network drop)
 *
 * "delivered" comes ONLY from the ack. The control channel is fire-and-forget,
 * so a 2xx from the route proves the row exists and nothing about the host.
 */
export interface CodeSteering {
  requestId: string;
  text: string;
  phase: "sending" | "queued" | "delivered" | "failed";
  message: string | null;
}

/** Live snapshot of one delegated child agent (from "agent" task events). */
export interface CodeAgentState {
  id: string;
  title: string;
  role: string;
  model?: string;
  status: string;
  writes?: boolean;
  currentActivity?: string;
  summary?: string;
  error?: string;
  filesChanged?: string[];
  conflictedFiles?: string[];
  worktreeBranch?: string;
  applied?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * One file the run touched, as the `file_change` event described it.
 *
 * This exists because the hook used to fold `file_change` straight into a
 * display string — `edit src/foo.ts` / `+3 −1` — and keep nothing else, so the
 * numbers had to be recovered by splitting the title back apart downstream and
 * anything the payload carried BESIDES those four fields was dropped on the
 * floor. `patch` is the field that made that unaffordable: a unified diff
 * cannot survive a round trip through a two-word title.
 */
export interface CodeFileChangeEvent {
  path: string;
  changeKind: string;
  added: number;
  removed: number;
  /**
   * Unified diff for this one file, or null when the producer sent none.
   *
   * NULL IS THE NORMAL CASE AND MUST STAY CHEAP. Every device host in the field
   * sends path/changeKind/added/removed and nothing else; only the cloud runner
   * sends hunks today. A reader that treats null as "empty diff" would draw an
   * empty pane over a change that had plenty of content — so null means "no
   * diff was transported", never "nothing changed".
   */
  patch: string | null;
}

/** The three things a host can be asked to do to what a run wrote. Mirrors
 *  `ROLLBACK_VERBS` in src/lib/code-remote.ts, spelled here so this client
 *  module stays free of server imports. */
export type CodeRollbackVerb = "accept_change" | "reject_change" | "undo_change";

/**
 * Whether the host running this task can act on the rollback verbs at all.
 *
 * `announced` starts FALSE and only a `rollback_ready` event from the host sets
 * it. That is the whole design: the control channel is fire-and-forget, so
 * without an announcement the web has no way to distinguish "the host will do
 * this" from "the host has never heard of this verb and silently swallowed it".
 * Rendering rollback controls off anything else — the task being live, the
 * device being online — would put buttons in front of every reader that most
 * hosts will never honour. Same lesson as `CodeDevice.servesQueuedTasks`:
 * presence is not capability.
 */
export interface CodeRollbackSupport {
  announced: boolean;
  /**
   * The workspace-relative paths the host says it holds an undo for, or null
   * when it announced without naming any.
   *
   * Null is NOT "all files": anything a run's bash wrote is outside the
   * checkpoint net and cannot be rolled back, and the host is the only party
   * that knows which files those were. A host that names paths gets controls on
   * exactly those; a host that names none gets them on every changed file, and
   * the ones it cannot honour come back `unsupported` rather than silently
   * appearing to work.
   */
  paths: readonly string[] | null;
}

/** One rollback the reader asked for, from the ask to the host's answer. */
export interface CodeRollbackRequest {
  requestId: string;
  verb: CodeRollbackVerb;
  /** Null for `undo_change`, which acts on a whole turn. */
  path: string | null;
  /**
   * "pending" until the host answers.
   *
   * "unsupported" is the host saying it holds no snapshot for that file — the
   * honest outcome for anything bash wrote — and is deliberately NOT folded
   * into "failed": one means there was never an undo to give, the other means
   * an undo was attempted and broke. "unanswered" is this client giving up
   * waiting; nothing is known about the workspace in that state, which is why
   * the copy for it must not claim either way.
   */
  status: "pending" | "applied" | "unsupported" | "failed" | "unanswered";
  /** Paths the host reported it actually touched. Null until it answers. */
  paths: readonly string[] | null;
  message: string | null;
}

export interface CodePendingApproval {
  requestId: string;
  summary: string;
  /** "neutral" | "destructive" | "outside" — mirrors the Mac host's risk labels. */
  risk: string;
  detail: string | null;
}

/** Where a prompt runs. Device (default) names a registered host + local path;
 *  cloud names a GitHub repo and runs on a dispatched Actions machine. */
export type CodeSendTarget =
  | {
      mode?: "device";
      deviceId: string;
      /** Required — the executing device resolves this local folder. */
      workspacePath: string;
      workspaceName?: string | null;
      /** Stable workspace identity (CodeWorkspace.key), when the session has one. */
      workspaceKey?: string | null;
    }
  | {
      mode: "cloud";
      repo: { owner: string; name: string };
      /** Base branch to run against; the repo's default when omitted. */
      baseRef?: string | null;
      workspaceName?: string | null;
    };

/**
 * Turn the API's machine error codes into calm, human copy (device + cloud).
 *
 * The `default` branch used to return the CODE, so any refusal not listed here
 * was shown to the user verbatim — the device path's most likely one produced a
 * toast reading literally `device_does_not_serve_queued_tasks`. Worse, that
 * route sends a well-written `message` alongside the code and the client threw
 * it away. So: prefer the server's own sentence when there is one, fall back to
 * the table, and never show a code to a person.
 */
function friendlyTaskError(code: string | undefined, message?: string | undefined): string {
  // A server-authored sentence beats anything written here: it can name the
  // machine, the quota, or the file that went missing.
  if (typeof message === "string" && message.trim().length > 0) return message;
  switch (code) {
    case "github_not_connected":
      return "Connect GitHub in Connections to run in the cloud.";
    case "cloud_runner_not_configured":
      return "Cloud runs aren’t enabled on this server yet.";
    case "cloud_dispatch_failed":
      return "Couldn’t start the cloud run. Please try again.";
    case "attachment_claim_failed":
      return "One of the attached files is no longer available. Remove it and try again.";
    case "device_does_not_serve_queued_tasks":
      return "That computer is signed in but isn’t set up to run remote work, so the task would never start.";
    case "device_offline":
      return "That computer is offline. Wake it, or run this in the cloud instead.";
    case "conversationId_required":
      return "This session isn’t saved yet. Reload the page and try again.";
    case "steer_unsupported":
      return "This run can’t take a new instruction mid-run. Wait for it to finish, then send a follow-up.";
    case "task_not_started":
      return "The cloud runner hasn’t started this task yet. Wait for it to start, then send the instruction.";
    case "task_finished":
      return "This run has finished. Send the instruction as a new message instead.";
    default:
      // A sentence from the server that arrived in `error` rather than
      // `message` — anything with a space in it is prose, not a code.
      if (code && /\s/.test(code)) return code;
      return "Could not start the task.";
  }
}

type RemoteTask = { id: string; status: string; conversationId?: string | null; target?: string | null };

/**
 * A refused task creation, with whatever the server persisted before refusing.
 *
 * The cloud path writes the user's turn and a failed ASSISTANT row BEFORE it
 * can learn the dispatch failed, and hands both back on the 502/503. The hook
 * used to delete its optimistic bubble on any non-2xx, so the live view hid
 * two rows that the next reload then showed. Carrying them on the error is
 * what lets the catch keep the transcript honest instead.
 */
class TaskCreateError extends Error {
  readonly userMessage: ClientMessage | null;
  readonly outcomeMessage: ClientMessage | null;
  constructor(message: string, rows: { userMessage?: ClientMessage; outcomeMessage?: ClientMessage }) {
    super(message);
    this.name = "TaskCreateError";
    this.userMessage = rows.userMessage ?? null;
    this.outcomeMessage = rows.outcomeMessage ?? null;
  }
}
type RemoteEvent = { seq: number; kind: string; payload: Record<string, unknown> | null; createdAt: string };
type StreamFrame =
  | { type: "snapshot" | "events"; task: RemoteTask; events: RemoteEvent[] }
  | { type: "done"; task: RemoteTask; message: ClientMessage | null };

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const RECONNECT_BASE_MS = 1_500;
const RECONNECT_MAX_MS = 15_000;

/** Fired when this session's task list meaningfully changes (a task starts, or
 *  reaches a terminal state). The sidebar mounts once in the persistent shell
 *  and cannot see this hook's state, so it listens for this instead of waiting
 *  for its own poll to come round. */
export const CODE_SYNC_EVENT = "juno:code-sync";
const notifyCodeSync = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CODE_SYNC_EVENT));
};

let tempCounter = 0;
const tempId = () => `code-temp-${Date.now()}-${tempCounter++}`;
const LIVE_ID_PREFIX = "code-live-";
const liveId = (taskId: string) => `${LIVE_ID_PREFIX}${taskId}`;
/** True for an optimistic streaming bubble: a client-minted id with no
 *  persisted Message row behind it, so server-side affordances (feedback and
 *  anything else keyed by message id) must not be offered or POSTed for it. */
export const isLiveId = (id: string) => id.startsWith(LIVE_ID_PREFIX);

/**
 * How long a rollback may sit unanswered before the reader is told nobody
 * answered.
 *
 * Generous on purpose. The host only sees a control event when it next posts
 * events, and a host mid-tool-call — a build, a test run — can legitimately go
 * quiet for a while. A short timeout here would report "no answer" over a
 * revert that was about to happen, which is the one wrong thing this state
 * exists to avoid saying.
 */
const ROLLBACK_ANSWER_TIMEOUT_MS = 90_000;

const str = (payload: RemoteEvent["payload"], key: string): string | null => {
  const value = payload?.[key];
  return typeof value === "string" ? value : null;
};
const num = (payload: RemoteEvent["payload"], key: string): number | null => {
  const value = payload?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};
const bool = (payload: RemoteEvent["payload"], key: string): boolean | null => {
  const value = payload?.[key];
  return typeof value === "boolean" ? value : null;
};
/** A string array from a payload, or null. Anything non-string in the array is
 *  dropped rather than rendered as `undefined` beside real paths. */
const strList = (payload: RemoteEvent["payload"], key: string): string[] | null => {
  const value = payload?.[key];
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === "string");
};

/** Minimal SSE reader for the task event stream (data: JSON frames only). */
async function readSseFrames(body: ReadableStream<Uint8Array>, onFrame: (frame: StreamFrame) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!frame.startsWith("data:")) continue; // ": ping" heartbeats
      try {
        onFrame(JSON.parse(frame.slice(5).trim()) as StreamFrame);
      } catch {
        // malformed frame — skip
      }
    }
  }
}

interface UseCodeSessionOptions {
  conversationId: string;
  initialMessages: ClientMessage[];
  /** Bumps the sidebar's lastMessageAt so the session floats up while used. */
  onActivity?: () => void;
}

export function useCodeSession(opts: UseCodeSessionOptions) {
  const [messages, setMessages] = React.useState<ChatMessage[]>(opts.initialMessages);
  const [status, setStatus] = React.useState<CodeSessionStatus>("idle");
  const [pendingApproval, setPendingApproval] = React.useState<CodePendingApproval | null>(null);
  const [activeTask, setActiveTask] = React.useState<RemoteTask | null>(null);
  const [responding, setResponding] = React.useState(false);
  /** Delegated child agents of the live task, newest state per id. */
  const [agents, setAgents] = React.useState<CodeAgentState[]>([]);
  /*
   * Structured file changes for this SESSION, newest state per path.
   *
   * Not reset between prompts, unlike `agents`: the changed-files card
   * summarises what the session has done to the working tree, and a second
   * instruction does not un-write the first one's files. Reset only when the
   * conversation identity changes, below.
   *
   * Kept here rather than folded into the live bubble's activity because the
   * bubble is REPLACED by its persisted row the moment a run settles, and the
   * persisted row cannot carry the patch (see `useSessionFileChanges`). Holding
   * it in session state is what stops the diffs blinking out of existence at
   * exactly the moment somebody wants to read them.
   */
  const [fileChanges, setFileChanges] = React.useState<CodeFileChangeEvent[]>([]);
  /*
   * Rollback lives with the TASK, not with the session, unlike `fileChanges`.
   *
   * A checkpoint store belongs to the host process that is holding the
   * workspace open; when the task ends, that process exits and every undo it
   * was offering goes with it. Carrying the announcement across tasks the way
   * `fileChanges` is carried would leave revert buttons on screen that resolve
   * to nothing, which is precisely the dead control this whole announcement
   * mechanism exists to prevent. Both reset in `resume`/`send`.
   */
  const [rollbackSupport, setRollbackSupport] = React.useState<CodeRollbackSupport>({
    announced: false,
    paths: null,
  });
  const [rollbacks, setRollbacks] = React.useState<CodeRollbackRequest[]>([]);
  /** The newest mid-run instruction and where it has got to; null between them. */
  const [steering, setSteering] = React.useState<CodeSteering | null>(null);

  const abortRef = React.useRef<AbortController | null>(null);
  const lastSeqRef = React.useRef(0);
  // The live assistant turn, folded from stream events. Kept in refs (the SSE
  // read loop parses many frames synchronously) and mirrored into `messages`.
  const liveRef = React.useRef<{
    taskId: string;
    content: string;
    activity: CodeActivityEvent[];
    errorMessage: string | null;
    bubbleShown: boolean;
  } | null>(null);
  const statusRef = React.useRef(status);
  statusRef.current = status;
  /** Answer deadlines, by requestId, so a request that outlives the component
   *  (navigate away mid-revert) does not leave a timer setting state on an
   *  unmounted tree. Cleared together in `resetRollback` and on unmount. */
  const rollbackTimers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const resetRollback = React.useCallback(() => {
    for (const timer of rollbackTimers.current.values()) clearTimeout(timer);
    rollbackTimers.current.clear();
    setRollbackSupport({ announced: false, paths: null });
    setRollbacks([]);
  }, []);

  React.useEffect(() => {
    setMessages(opts.initialMessages);
    setStatus("idle");
    setPendingApproval(null);
    setActiveTask(null);
    setAgents([]);
    setFileChanges([]);
    setRollbackSupport({ announced: false, paths: null });
    setRollbacks([]);
    setSteering(null);
    lastSeqRef.current = 0;
    liveRef.current = null;
    // Session-identity reset, keyed only on conversationId — opts.initialMessages
    // is the snapshot for that session, and depending on it would clear live
    // state whenever the parent re-rendered with a fresh array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.conversationId]);

  const syncLiveBubble = React.useCallback((streaming: boolean) => {
    const live = liveRef.current;
    if (!live || !live.bubbleShown) return;
    const id = liveId(live.taskId);
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id
          ? { ...m, content: live.content, activity: [...live.activity], streaming, errorMessage: live.errorMessage }
          : m
      )
    );
  }, []);

  const showLiveBubble = React.useCallback(() => {
    const live = liveRef.current;
    if (!live || live.bubbleShown) return;
    live.bubbleShown = true;
    const bubble: ChatMessage = {
      id: liveId(live.taskId),
      role: "ASSISTANT",
      content: live.content,
      createdAt: new Date().toISOString(),
      attachments: [],
      activity: [...live.activity],
      streaming: true,
    };
    setMessages((prev) => (prev.some((m) => m.id === bubble.id) ? prev : [...prev, bubble]));
  }, []);

  const applyEvents = React.useCallback(
    (events: RemoteEvent[]) => {
      const live = liveRef.current;
      if (!live) return;
      for (const event of events) {
        if (event.seq <= lastSeqRef.current) continue;
        lastSeqRef.current = event.seq;
        switch (event.kind) {
          case "text": {
            live.content += str(event.payload, "text") ?? "";
            break;
          }
          case "tool": {
            const title = str(event.payload, "summary") ?? str(event.payload, "name");
            // The status as a number, so the inline command card can say a
            // test run failed without parsing its own title.
            const exitCode = num(event.payload, "exitCode");
            if (title)
              live.activity.push({
                id: `evt-${event.seq}`,
                kind: "tool",
                title,
                detail: str(event.payload, "detail") ?? undefined,
                createdAt: event.createdAt,
                ...(exitCode !== null ? { exitCode } : {}),
              });
            break;
          }
          case "file_change": {
            const path = str(event.payload, "path");
            if (!path) break;
            const added = num(event.payload, "added") ?? 0;
            const removed = num(event.payload, "removed") ?? 0;
            const changeKind = str(event.payload, "changeKind") ?? "edit";
            /*
             * TWO SPELLINGS FOR ONE FIELD, AND BOTH ARE LOAD-BEARING.
             *
             * `patch` is the name this payload documents; `diff` is the key the
             * runner that is deployed RIGHT NOW actually writes
             * (scripts/cloud-code-runner.mjs emits `{path, changeKind, added,
             * removed, diff}` from `git diff --cached -- <file>`). Reading only
             * `patch` would have shipped a diff viewer that never once fired,
             * against the single producer in the tree that already sends hunks.
             *
             * Absent stays absent. A host that sends neither key lands here with
             * null and keeps the summary row it has always had.
             */
            const patch = str(event.payload, "patch") ?? str(event.payload, "diff");
            // The diff rides on the transcript row too, so the inline file row
            // can open it — the same key the persisted row carries after reload.
            live.activity.push({
              id: `evt-${event.seq}`,
              kind: "write",
              title: `${changeKind} ${path}`,
              detail: `+${added} −${removed}`,
              createdAt: event.createdAt,
              ...(patch ? { patch } : {}),
            });
            setFileChanges((prev) => {
              const next = { path, changeKind, added, removed, patch: patch || null };
              const index = prev.findIndex((change) => change.path === path);
              if (index === -1) return [...prev, next];
              const merged = [...prev];
              // Last write per path wins on everything EXCEPT the patch, which
              // is kept if the newer event has none: a run that writes a file
              // twice, and whose second event lost its hunks (size cap, a
              // failed `git diff`), must not silently lose the diff it already
              // showed.
              merged[index] = { ...next, patch: next.patch ?? prev[index].patch };
              return merged;
            });
            break;
          }
          case "approval_request": {
            const requestId = str(event.payload, "requestId");
            const summary = str(event.payload, "summary");
            if (requestId && summary) {
              setPendingApproval({
                requestId,
                summary,
                risk: str(event.payload, "risk") ?? "neutral",
                detail: str(event.payload, "detail"),
              });
              live.activity.push({
                id: `evt-${event.seq}`,
                kind: "warning",
                title: "Approval requested",
                detail: summary,
                createdAt: event.createdAt,
              });
            }
            break;
          }
          case "approval_response": {
            const requestId = str(event.payload, "requestId");
            const approve = bool(event.payload, "approve");
            setPendingApproval((cur) => (cur && cur.requestId === requestId ? null : cur));
            if (requestId != null && approve != null) {
              live.activity.push({
                id: `evt-${event.seq}`,
                kind: approve ? "done" : "warning",
                title: approve ? "Approved" : "Denied",
                createdAt: event.createdAt,
              });
            }
            break;
          }
          case "error": {
            live.errorMessage = str(event.payload, "message") ?? live.errorMessage;
            break;
          }
          case "agent": {
            const snapshot = (event.payload?.agent ?? null) as CodeAgentState | null;
            if (snapshot && typeof snapshot.id === "string") {
              setAgents((prev) => {
                const index = prev.findIndex((a) => a.id === snapshot.id);
                if (index === -1) return [...prev, snapshot];
                const next = [...prev];
                next[index] = snapshot;
                return next;
              });
            }
            break;
          }
          case "rollback_ready": {
            // The host declaring it can act on the rollback verbs. Until this
            // lands the controls do not exist — see `CodeRollbackSupport`.
            setRollbackSupport({ announced: true, paths: strList(event.payload, "paths") });
            break;
          }
          case "accept_change":
          case "reject_change":
          case "undo_change": {
            // Echoed back from our own POST (the route appends the verb to this
            // same stream). Logged as an ASK, in the past tense of requesting
            // rather than of doing: the host has not answered yet, and the two
            // must not read alike in a transcript someone reads later.
            const path = str(event.payload, "path");
            live.activity.push({
              id: `evt-${event.seq}`,
              kind: "tool",
              title:
                event.kind === "undo_change"
                  ? "Asked to undo the last turn"
                  : event.kind === "reject_change"
                    ? "Asked to revert a file"
                    : "Asked to keep a file",
              detail: path ?? undefined,
              createdAt: event.createdAt,
            });
            break;
          }
          case "rollback_result": {
            const requestId = str(event.payload, "requestId");
            if (!requestId) break;
            const raw = str(event.payload, "status");
            const status =
              raw === "applied" || raw === "unsupported" || raw === "failed" ? raw : "failed";
            const paths = strList(event.payload, "paths");
            const message = str(event.payload, "message");
            setRollbacks((prev) =>
              prev.map((entry) =>
                // Only a request still waiting is updated. A late duplicate
                // must not reopen one this client already gave up on and
                // reported as unanswered — the reader has moved on, and a row
                // that flips from "no answer" to "done" minutes later is worse
                // than one that stays honest about what was known at the time.
                entry.requestId === requestId && entry.status === "pending"
                  ? { ...entry, status, paths, message }
                  : entry,
              ),
            );
            live.activity.push({
              id: `evt-${event.seq}`,
              kind: status === "applied" ? "done" : "warning",
              title:
                status === "applied"
                  ? paths && paths.length > 0
                    ? `Rolled back ${paths.length === 1 ? paths[0] : `${paths.length} files`}`
                    : "Rolled back"
                  : status === "unsupported"
                    ? "Nothing to roll back"
                    : "Rollback failed",
              detail: message ?? undefined,
              createdAt: event.createdAt,
            });
            break;
          }
          case "steer_ack": {
            // The host took the instruction as its next user message. This is
            // the ONLY thing that moves a steer to "delivered".
            const requestId = str(event.payload, "requestId");
            if (requestId) {
              setSteering((cur) =>
                cur && cur.requestId === requestId && cur.phase !== "failed" ? { ...cur, phase: "delivered" } : cur,
              );
            }
            break;
          }
          default:
            // status/user/done/cancel_request carry no transcript content here.
            // Neither does the `steer` echo of our own POST: the instruction is
            // already in the transcript as the USER row the route returned.
            break;
        }
      }
    },
    []
  );

  const finishTask = React.useCallback(
    (task: RemoteTask, persisted: ClientMessage | null, fallbackError?: string) => {
      const live = liveRef.current;
      const bubbleId = live ? liveId(live.taskId) : null;
      const failed = task.status === "failed";
      const cancelled = task.status === "cancelled";
      // Named for the machine that ran it. "Your Mac" on a cloud run was a
      // sentence about a computer that was never involved.
      const errorText =
        live?.errorMessage ??
        fallbackError ??
        (task.target === "cloud" ? "The cloud run failed." : "The task failed on your Mac.");

      setMessages((prev) => {
        const withoutBubble = bubbleId && persisted ? prev.filter((m) => m.id !== bubbleId) : prev;
        if (persisted) {
          const decorated: ChatMessage = {
            ...persisted,
            streaming: false,
            ...(failed
              ? {
                  error: true,
                  finishReason: "error" as const,
                  errorMessage: errorText,
                  content: persisted.content || errorText,
                }
              : cancelled
                ? { finishReason: "user_stopped" as const }
                : {}),
          };
          return withoutBubble.some((m) => m.id === decorated.id)
            ? withoutBubble.map((m) => (m.id === decorated.id ? decorated : m))
            : [...withoutBubble, decorated];
        }
        // No persisted row came back — settle the live bubble honestly in place.
        if (!bubbleId) return prev;
        return prev.map((m) =>
          m.id === bubbleId
            ? {
                ...m,
                streaming: false,
                ...(failed
                  ? { error: true, finishReason: "error" as const, errorMessage: errorText, content: m.content || errorText }
                  : cancelled
                    ? { finishReason: "user_stopped" as const }
                    : {}),
              }
            : m
        );
      });
      liveRef.current = null;
      setPendingApproval(null);
      setActiveTask(null);
      setStatus("idle");
      // A run that has ended cannot take or acknowledge an instruction.
      setSteering(null);
      // The host holding the checkpoints has exited, so nothing can answer any
      // more and nothing new can be asked. Anything still pending is closed as
      // unanswered rather than left spinning, and the announcement is withdrawn
      // so no control outlives the process that could honour it.
      setRollbacks((prev) =>
        prev.map((entry) => (entry.status === "pending" ? { ...entry, status: "unanswered" as const } : entry)),
      );
      setRollbackSupport({ announced: false, paths: null });
      if (failed && errorText) toast.error(errorText);
      opts.onActivity?.();
      notifyCodeSync(); // terminal: the sidebar's status dot is now stale
    },
    [opts]
  );

  /** Attach to a task's SSE stream, reconnecting from the seq cursor on drops. */
  const streamTask = React.useCallback(
    async (taskId: string) => {
      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;
      let attempt = 0;
      let finished = false;

      const handleFrame = (frame: StreamFrame) => {
        attempt = 0;
        if (frame.type === "done") {
          finished = true;
          finishTask(frame.task, frame.message);
          return;
        }
        applyEvents(frame.events);
        const taskStatus = frame.task.status;
        if (taskStatus === "queued") {
          setStatus((cur) => (cur === "stopping" ? cur : "queued"));
        } else if (!TERMINAL.has(taskStatus)) {
          // Claimed: the run is live — surface the streaming bubble now.
          showLiveBubble();
          setStatus((cur) =>
            cur === "stopping" ? cur : taskStatus === "awaiting_approval" ? "awaiting_approval" : "running"
          );
        }
        setActiveTask(frame.task);
        syncLiveBubble(true);
      };

      while (!controller.signal.aborted && !finished) {
        try {
          const res = await fetch(`/api/code/tasks/${taskId}/events?afterSeq=${lastSeqRef.current}`, {
            signal: controller.signal,
            headers: { Accept: "text/event-stream" },
          });
          if (res.status === 404) {
            // Task deleted underneath the stream — nothing left to follow. The
            // target is unknown here, so the sentence names neither machine.
            finishTask({ id: taskId, status: "failed" }, null, "This task no longer exists, so nothing more can be shown.");
            return;
          }
          if (res.status === 401) return; // signed out — reconnecting can't help
          if (!res.ok || !res.body) throw new Error("stream unavailable");
          await readSseFrames(res.body, handleFrame);
        } catch {
          if (controller.signal.aborted) return;
        }
        if (finished || controller.signal.aborted) return;
        // Stream window elapsed or connection dropped — reconnect from cursor.
        attempt += 1;
        await new Promise((r) => setTimeout(r, Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS)));
      }
    },
    [applyEvents, finishTask, showLiveBubble, syncLiveBubble]
  );

  const send = React.useCallback(
    async (
      text: string,
      target: CodeSendTarget,
      attachments: ClientMessage["attachments"] = [],
      /**
       * What to run it with. Both of these are chosen in the composer and, until
       * now, went nowhere: the create route's schema did not accept them, so
       * they were written onto the Conversation — where they LOOKED durable —
       * and the cloud runner just took the first available model in its
       * catalog. Optional, so a caller that has no preference still gets that
       * fallback rather than a failure.
       */
      choice: { model?: string | null; reasoningEffort?: string | null } = {},
    ): Promise<{ accepted: boolean }> => {
      if (statusRef.current !== "idle") return { accepted: false };
      const trimmed = text.trim();
      const attachmentIds = attachments.map((a) => a.id);
      if (!trimmed && attachmentIds.length === 0) return { accepted: false };

      setStatus("submitting");
      const userTempId = tempId();
      const titleFallback =
        trimmed.slice(0, 60) ||
        (attachments.length === 1 ? "1 attachment" : `${attachments.length} attachments`);
      const userMsg: ChatMessage = {
        id: userTempId,
        role: "USER",
        content: trimmed,
        createdAt: new Date().toISOString(),
        attachments: [...attachments],
        pending: true,
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const body =
          target.mode === "cloud"
            ? {
                target: "cloud" as const,
                repo: target.repo,
                baseRef: target.baseRef || undefined,
                workspaceName: target.workspaceName || undefined,
                title: titleFallback,
                prompt: trimmed,
                attachmentIds: attachmentIds.length ? attachmentIds : undefined,
                conversationId: opts.conversationId,
                model: choice.model || undefined,
                reasoningEffort: choice.reasoningEffort || undefined,
              }
            : {
                deviceId: target.deviceId,
                workspacePath: target.workspacePath,
                workspaceName: target.workspaceName || undefined,
                workspaceKey: target.workspaceKey || undefined,
                title: titleFallback,
                prompt: trimmed,
                attachmentIds: attachmentIds.length ? attachmentIds : undefined,
                conversationId: opts.conversationId,
                model: choice.model || undefined,
                reasoningEffort: choice.reasoningEffort || undefined,
              };
        const res = await fetch("/api/code/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as {
          task?: RemoteTask;
          userMessage?: ClientMessage;
          /** The failed ASSISTANT row the server wrote before refusing (cloud). */
          outcomeMessage?: ClientMessage;
          error?: string;
          /** A server-authored sentence, which beats any code we map here. */
          message?: string;
        };
        if (!res.ok || !data.task) {
          throw new TaskCreateError(friendlyTaskError(data.error, data.message), {
            userMessage: data.userMessage,
            outcomeMessage: data.outcomeMessage,
          });
        }

        const task = data.task;
        setMessages((prev) =>
          prev.map((m) => (m.id === userTempId && data.userMessage ? { ...data.userMessage, pending: false } : m))
        );
        lastSeqRef.current = 0;
        liveRef.current = { taskId: task.id, content: "", activity: [], errorMessage: null, bubbleShown: false };
        setAgents([]);
        resetRollback();
        setSteering(null);
        setActiveTask(task);
        setStatus("queued");
        opts.onActivity?.();
        notifyCodeSync(); // a new task exists — let the sidebar pick it up now
        void streamTask(task.id);
        return { accepted: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not start the task.";
        const persisted = err instanceof TaskCreateError ? err : null;
        setMessages((prev) => {
          /*
           * KEEP WHAT THE SERVER KEPT. A cloud create persists the user's turn
           * and a failed ASSISTANT row before the dispatch can fail, so the
           * honest transcript is the one a reload would show: the turn, then
           * the failure under it. Only when nothing was persisted (a device
           * refusal, a network drop) does the optimistic bubble come off — the
           * text is still in the composer, which never clears on a refusal.
           */
          if (!persisted?.userMessage) return prev.filter((m) => m.id !== userTempId);
          const kept = prev.map((m) =>
            m.id === userTempId ? { ...persisted.userMessage!, pending: false } : m,
          );
          const outcome = persisted.outcomeMessage;
          if (!outcome || kept.some((m) => m.id === outcome.id)) return kept;
          return [
            ...kept,
            {
              ...outcome,
              streaming: false,
              error: true,
              finishReason: "error" as const,
              errorMessage: message,
              content: outcome.content || message,
            },
          ];
        });
        if (persisted?.userMessage) {
          opts.onActivity?.();
          notifyCodeSync(); // a failed task now exists — the run list should know
        }
        setStatus("idle");
        toast.error(message);
        return { accepted: false };
      }
    },
    [opts, resetRollback, streamTask]
  );

  /**
   * Send a new instruction to the task that is running right now.
   *
   * Distinct from `send`, which creates a task: this appends a `steer` control
   * to the live one and the host takes the text as its next user message. The
   * USER row the route persists is placed BEFORE the live bubble, so the
   * transcript reads the way a reload will show it — the run's single
   * ASSISTANT row settles after every instruction it took. A cloud run takes
   * one once it is running; the route refuses a queued one with a sentence,
   * and `canSteer` keeps the composer from offering it before then.
   */
  const steer = React.useCallback(
    async (text: string): Promise<{ accepted: boolean }> => {
      const task = activeTask;
      const trimmed = text.trim();
      if (!task || !trimmed) return { accepted: false };
      if (statusRef.current !== "running" && statusRef.current !== "awaiting_approval") return { accepted: false };
      const requestId = tempId();
      setSteering({ requestId, text: trimmed, phase: "sending", message: null });
      try {
        const res = await fetch(`/api/code/tasks/${task.id}/steer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed, requestId }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          userMessage?: ClientMessage;
          error?: string;
          message?: string;
        };
        if (!res.ok) throw new Error(friendlyTaskError(data.error, data.message));
        const row = data.userMessage;
        if (row) {
          setMessages((prev) => {
            if (prev.some((m) => m.id === row.id)) return prev;
            const bubble = prev.findIndex((m) => m.id === liveId(task.id));
            const entry: ChatMessage = { ...row, pending: false };
            return bubble === -1 ? [...prev, entry] : [...prev.slice(0, bubble), entry, ...prev.slice(bubble)];
          });
        }
        setSteering((cur) => (cur && cur.requestId === requestId ? { ...cur, phase: "queued" } : cur));
        opts.onActivity?.();
        return { accepted: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not send the instruction.";
        setSteering((cur) => (cur && cur.requestId === requestId ? { ...cur, phase: "failed", message } : cur));
        toast.error(message);
        return { accepted: false };
      }
    },
    [activeTask, opts],
  );

  /** Re-attach to a task that was already running when the page loaded. */
  const resume = React.useCallback(
    (task: RemoteTask) => {
      if (TERMINAL.has(task.status)) return;
      lastSeqRef.current = 0;
      liveRef.current = { taskId: task.id, content: "", activity: [], errorMessage: null, bubbleShown: false };
      setAgents([]);
      resetRollback();
      setSteering(null);
      setActiveTask(task);
      setStatus(task.status === "queued" ? "queued" : task.status === "awaiting_approval" ? "awaiting_approval" : "running");
      void streamTask(task.id);
    },
    [resetRollback, streamTask]
  );

  /**
   * How long "Stopping…" may last before the session admits it is not working.
   *
   * Cancelling a RUNNING task is a request, not a kill: the server appends a
   * `cancel_request` event and the host picks it up from its control cursor on
   * its next callback. A host that has already died never reads it, and the
   * session used to sit in `stopping` forever — composer disabled, no timeout,
   * no escalation, no way back except a reload. Thirty seconds is several
   * control round-trips for a live host and a very long time to stare at a
   * disabled composer.
   */
  const CANCEL_ACK_TIMEOUT_MS = 30_000;

  const cancel = React.useCallback(async () => {
    const task = activeTask;
    if (!task || statusRef.current === "stopping") return;
    setStatus("stopping");
    try {
      const res = await fetch(`/api/code/tasks/${task.id}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error();
      // Terminal state (and the persisted outcome) arrives through the stream —
      // when there is still a host to deliver it. If nothing has moved by the
      // time the window is up, say so and hand the controls back rather than
      // leaving the composer disabled against a run that may already be dead.
      window.setTimeout(() => {
        if (statusRef.current !== "stopping") return;
        setStatus("running");
        toast.error(
          "The run has not acknowledged the stop. It may have already ended — reload to see where it got to.",
        );
      }, CANCEL_ACK_TIMEOUT_MS);
    } catch {
      setStatus(task.status === "queued" ? "queued" : "running");
      toast.error("Could not cancel the task. Check your connection and try again.");
    }
  }, [activeTask]);

  const respond = React.useCallback(
    async (requestId: string, approve: boolean) => {
      const task = activeTask;
      if (!task || responding) return;
      setResponding(true);
      try {
        const res = await fetch(`/api/code/tasks/${task.id}/respond`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, approve }),
        });
        if (!res.ok) throw new Error();
        setPendingApproval((cur) => (cur && cur.requestId === requestId ? null : cur));
      } catch {
        toast.error("Could not send your answer. Check your connection and try again.");
      } finally {
        setResponding(false);
      }
    },
    [activeTask, responding]
  );

  /**
   * Ask the host to keep, revert, or undo — and report only what it confirms.
   *
   * The POST enqueues a control event; it does NOT perform the rollback, and
   * this deliberately never sets a status better than "pending" off a 2xx. The
   * one thing that can move a request to "applied" is a `rollback_result` from
   * the host itself, folded in by `applyEvents`. An earlier shape optimistically
   * marked the file reverted on the POST's success and had to be undone: the
   * route's own answer is `{ status: "requested" }` precisely because the
   * machine holding the workspace has not been asked yet.
   */
  const requestRollback = React.useCallback(
    async (verb: CodeRollbackVerb, path: string | null = null) => {
      const task = activeTask;
      if (!task) return;
      const requestId = tempId();
      setRollbacks((prev) => [
        ...prev,
        { requestId, verb, path, status: "pending", paths: null, message: null },
      ]);
      try {
        const res = await fetch(`/api/code/tasks/${task.id}/rollback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ verb, requestId, ...(path ? { path } : {}) }),
        });
        if (!res.ok) {
          // 409 is the run having finished between the render and the click —
          // a race worth its own sentence, because "try again" is wrong advice
          // for it and right for everything else here.
          const message =
            res.status === 409
              ? "This run has finished, so nothing can be rolled back now."
              : "Could not reach your host. Nothing was changed.";
          throw new Error(message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not send the request.";
        setRollbacks((prev) =>
          prev.map((entry) => (entry.requestId === requestId ? { ...entry, status: "failed", message } : entry)),
        );
        toast.error(message);
        return;
      }
      const timer = setTimeout(() => {
        rollbackTimers.current.delete(requestId);
        setRollbacks((prev) =>
          prev.map((entry) =>
            entry.requestId === requestId && entry.status === "pending"
              ? { ...entry, status: "unanswered" }
              : entry,
          ),
        );
      }, ROLLBACK_ANSWER_TIMEOUT_MS);
      rollbackTimers.current.set(requestId, timer);
    },
    [activeTask],
  );

  const setFeedback = React.useCallback((messageId: string, feedback: "UP" | "DOWN" | null) => {
    // A live bubble is a client-side id with no row behind it — POSTing would
    // 404. The view hides feedback for these, so reaching here means a race
    // (the run settled mid-click); drop it rather than fake success.
    if (isLiveId(messageId)) return;
    // Optimistic, but honest: capture the previous value while applying the
    // new one, and roll back with a toast if the API doesn't accept it.
    let previous: "UP" | "DOWN" | null = null;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        previous = m.feedback ?? null;
        return { ...m, feedback };
      })
    );
    const rollback = () => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback: previous } : m)));
      toast.error("Could not save your feedback.");
    };
    fetch(`/api/messages/${messageId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    })
      .then((res) => {
        if (!res.ok) rollback();
      })
      .catch(rollback);
  }, []);

  React.useEffect(() => {
    const timers = rollbackTimers.current;
    return () => {
      abortRef.current?.abort();
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return {
    messages,
    status,
    activeTask,
    pendingApproval,
    agents,
    fileChanges,
    rollbackSupport,
    rollbacks,
    steering,
    responding,
    isBusy: status !== "idle",
    /**
     * Whether the composer may send an instruction INTO the live run: a
     * device run that is running or waiting on an approval, or a cloud run
     * that is running (its driver reads controls between agent steps). A
     * queued cloud task has no runner yet, and the route refuses it.
     */
    canSteer: status === "running" || status === "awaiting_approval",
    send,
    steer,
    resume,
    cancel,
    respond,
    requestRollback,
    setFeedback,
  };
}
