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
 */

export type CodeSessionStatus = "idle" | "submitting" | "queued" | "running" | "awaiting_approval" | "stopping";

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

/** Turn the API's machine error codes into calm, human copy (device + cloud). */
function friendlyTaskError(code: string | undefined): string {
  switch (code) {
    case "github_not_connected":
      return "Connect GitHub in Connections to run in the cloud.";
    case "cloud_runner_not_configured":
      return "Cloud runs aren’t enabled on this server yet.";
    case "cloud_dispatch_failed":
      return "Couldn’t start the cloud run. Please try again.";
    case "attachment_claim_failed":
      return "One of the attached files is no longer available. Remove it and try again.";
    default:
      return code ?? "Could not start the task.";
  }
}

type RemoteTask = { id: string; status: string; conversationId?: string | null };
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

  const abortRef = React.useRef<AbortController | null>(null);
  const lastSeqRef = React.useRef(0);
  // The live assistant turn, folded from stream events. Kept in refs (the SSE
  // read loop parses many frames synchronously) and mirrored into `messages`.
  const liveRef = React.useRef<{
    taskId: string;
    content: string;
    activity: ClientActivityEvent[];
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
            if (title)
              live.activity.push({
                id: `evt-${event.seq}`,
                kind: "tool",
                title,
                detail: str(event.payload, "detail") ?? undefined,
                createdAt: event.createdAt,
              });
            break;
          }
          case "file_change": {
            const path = str(event.payload, "path");
            if (!path) break;
            const added = num(event.payload, "added") ?? 0;
            const removed = num(event.payload, "removed") ?? 0;
            const changeKind = str(event.payload, "changeKind") ?? "edit";
            live.activity.push({
              id: `evt-${event.seq}`,
              kind: "write",
              title: `${changeKind} ${path}`,
              detail: `+${added} −${removed}`,
              createdAt: event.createdAt,
            });
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
          default:
            break; // status/user/done/cancel_request carry no transcript content here
        }
      }
    },
    []
  );

  const finishTask = React.useCallback(
    (task: RemoteTask, persisted: ClientMessage | null) => {
      const live = liveRef.current;
      const bubbleId = live ? liveId(live.taskId) : null;
      const failed = task.status === "failed";
      const cancelled = task.status === "cancelled";
      const errorText = live?.errorMessage ?? "The task failed on your Mac.";

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
            // Task deleted underneath the stream — nothing left to follow.
            finishTask({ id: taskId, status: "failed" }, null);
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
              };
        const res = await fetch("/api/code/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as {
          task?: RemoteTask;
          userMessage?: ClientMessage;
          error?: string;
        };
        if (!res.ok || !data.task) throw new Error(friendlyTaskError(data.error));

        const task = data.task;
        setMessages((prev) =>
          prev.map((m) => (m.id === userTempId && data.userMessage ? { ...data.userMessage, pending: false } : m))
        );
        lastSeqRef.current = 0;
        liveRef.current = { taskId: task.id, content: "", activity: [], errorMessage: null, bubbleShown: false };
        setAgents([]);
        resetRollback();
        setActiveTask(task);
        setStatus("queued");
        opts.onActivity?.();
        notifyCodeSync(); // a new task exists — let the sidebar pick it up now
        void streamTask(task.id);
        return { accepted: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not start the task.";
        setMessages((prev) => prev.filter((m) => m.id !== userTempId));
        setStatus("idle");
        toast.error(message);
        return { accepted: false };
      }
    },
    [opts, resetRollback, streamTask]
  );

  /** Re-attach to a task that was already running when the page loaded. */
  const resume = React.useCallback(
    (task: RemoteTask) => {
      if (TERMINAL.has(task.status)) return;
      lastSeqRef.current = 0;
      liveRef.current = { taskId: task.id, content: "", activity: [], errorMessage: null, bubbleShown: false };
      setAgents([]);
      resetRollback();
      setActiveTask(task);
      setStatus(task.status === "queued" ? "queued" : task.status === "awaiting_approval" ? "awaiting_approval" : "running");
      void streamTask(task.id);
    },
    [resetRollback, streamTask]
  );

  const cancel = React.useCallback(async () => {
    const task = activeTask;
    if (!task || statusRef.current === "stopping") return;
    setStatus("stopping");
    try {
      const res = await fetch(`/api/code/tasks/${task.id}/cancel`, { method: "POST" });
      if (!res.ok) throw new Error();
      // Terminal state (and the persisted outcome) arrives through the stream.
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
    responding,
    isBusy: status !== "idle",
    send,
    resume,
    cancel,
    respond,
    requestRollback,
    setFeedback,
  };
}
