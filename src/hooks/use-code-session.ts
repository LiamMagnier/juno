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

  React.useEffect(() => {
    setMessages(opts.initialMessages);
    setStatus("idle");
    setPendingApproval(null);
    setActiveTask(null);
    lastSeqRef.current = 0;
    liveRef.current = null;
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
            live.activity.push({
              id: `evt-${event.seq}`,
              kind: "write",
              title: `${str(event.payload, "changeKind") ?? "edit"} ${path}`,
              detail: `+${added} −${removed}`,
              createdAt: event.createdAt,
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
    [opts, streamTask]
  );

  /** Re-attach to a task that was already running when the page loaded. */
  const resume = React.useCallback(
    (task: RemoteTask) => {
      if (TERMINAL.has(task.status)) return;
      lastSeqRef.current = 0;
      liveRef.current = { taskId: task.id, content: "", activity: [], errorMessage: null, bubbleShown: false };
      setActiveTask(task);
      setStatus(task.status === "queued" ? "queued" : task.status === "awaiting_approval" ? "awaiting_approval" : "running");
      void streamTask(task.id);
    },
    [streamTask]
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

  React.useEffect(() => () => abortRef.current?.abort(), []);

  return {
    messages,
    status,
    activeTask,
    pendingApproval,
    responding,
    isBusy: status !== "idle",
    send,
    resume,
    cancel,
    respond,
    setFeedback,
  };
}
