"use client";

import * as React from "react";
import { toast } from "sonner";
import { readChatStream } from "@/lib/chat-stream";
import { resolveModel } from "@/lib/models";
import {
  isPreflightClarificationResult,
  type PendingPreflightClarification,
  type PreflightClarificationAnswer,
  type PreflightClarificationContext,
} from "@/lib/preflight-clarification";
import type {
  ClientArtifact,
  ClientAttachment,
  ClientMessage,
  ClientQuota,
  GenerateEditPayload,
  GenerationStatus,
  ReasoningEffort,
  TitleSource,
} from "@/types/chat";

export type ChatMessage = ClientMessage & {
  streaming?: boolean;
  pending?: boolean;
  error?: boolean;
};

export type SendResult = { accepted: boolean; clarificationPending?: boolean };

export type ImageEditInput = { prompt: string; model: string; edit: GenerateEditPayload };

let tempCounter = 0;
const tempId = () => `temp-${Date.now()}-${tempCounter++}`;

// Poll a dropped stream for as long as the server's own generation window
// (chat route maxDuration = 800s) plus a persistence margin — the answer can
// legitimately land at any point inside it. Keep in sync with the route.
const RECOVERY_WINDOW_MS = 800_000 + 60_000;

interface UseChatOptions {
  conversationId: string | null;
  initialMessages: ClientMessage[];
  initialArtifacts: ClientArtifact[];
  model: string;
  projectId?: string;
  voiceMode?: boolean;
  canvasEnabled?: boolean;
  webSearch?: boolean;
  reasoningEffort?: ReasoningEffort;
  connectors?: string[];
  privateMode?: boolean;
  onMeta?: (meta: { conversationId: string; title: string; titleSource: TitleSource; isNew: boolean }) => void;
  onTitle?: (conversationId: string, title: string, titleSource?: TitleSource) => void;
  onQuota?: (quota: ClientQuota) => void;
  onArtifactsUpdated?: (artifacts: ClientArtifact[], newlyCreated: ClientArtifact[]) => void;
  onMemoryUpdated?: () => void;
  onDone?: (
    assistant: ClientMessage,
    meta?: { finishReason?: ClientMessage["finishReason"]; title?: string; projectId?: string | null; projectName?: string | null }
  ) => void;
}

export function useChat(opts: UseChatOptions) {
  const [messages, setMessages] = React.useState<ChatMessage[]>(opts.initialMessages);
  const [artifacts, setArtifacts] = React.useState<ClientArtifact[]>(opts.initialArtifacts);
  const [status, setStatus] = React.useState<GenerationStatus>("idle");
  const [pendingClarification, setPendingClarification] = React.useState<PendingPreflightClarification | null>(null);
  const convoIdRef = React.useRef<string | null>(opts.conversationId);
  const abortRef = React.useRef<AbortController | null>(null);
  const generationIdRef = React.useRef<string | null>(null);
  const assistantIdRef = React.useRef<string | null>(null);
  const stopRequestedRef = React.useRef(false);
  const stopFallbackRef = React.useRef<number | null>(null);
  // Increments on every generation; an in-flight background recovery from a
  // dropped stream aborts itself when the user has already moved on.
  const generationSeqRef = React.useRef(0);
  // Live snapshot of the message list, for the recovery poll's id matching.
  const messagesRef = React.useRef<ChatMessage[]>(opts.initialMessages);
  React.useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  // Server message ids removed from local state (regenerate pops the stale
  // assistant answer, but the server keeps that row until the new one lands) —
  // drop recovery must treat them as already seen, never as the fresh answer.
  const locallyRemovedIdsRef = React.useRef<Set<string>>(new Set());

  // Reset when switching conversation.
  React.useEffect(() => {
    convoIdRef.current = opts.conversationId;
    generationSeqRef.current++; // cancel any in-flight drop recovery
    locallyRemovedIdsRef.current = new Set();
    setMessages(opts.initialMessages);
    setArtifacts(opts.initialArtifacts);
    setStatus("idle");
    setPendingClarification(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.conversationId]);

  const mergeArtifacts = React.useCallback(
    (incoming: ClientArtifact[]) => {
      if (incoming.length === 0) return;
      setArtifacts((prev) => {
        const map = new Map(prev.map((a) => [a.identifier, a]));
        for (const a of incoming) map.set(a.identifier, a);
        return Array.from(map.values());
      });
    },
    []
  );

  /**
   * The server deliberately detaches generation from the request: when the SSE
   * connection drops (flaky network, proxy timeout, long thinking with no
   * bytes), the answer is still generated and persisted. So instead of showing
   * an instant error, poll the conversation until the persisted assistant
   * message appears and swap it in — only giving up after the server's own
   * generation window has passed.
   */
  const recoverDroppedStream = React.useCallback(
    async (assistantTempId: string, userMessageId: string | null, seq: number) => {
      const convoId = convoIdRef.current;
      if (!convoId) return;
      // The recovered answer is whichever ASSISTANT message we have never seen —
      // matching by id (not timestamps) is immune to client/server clock skew.
      // Locally-removed ids count as seen: on regenerate the stale answer still
      // exists server-side until the new one replaces it.
      const knownIds = new Set([...messagesRef.current.map((m) => m.id), ...locallyRemovedIdsRef.current]);
      // Terminal stamps must write content too: an empty bubble renders its
      // content in the error box, so a content-less error shows an empty box.
      const stampTerminalError = (errorText: string) =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? {
                  ...m,
                  streaming: false,
                  error: true,
                  progress: null,
                  finishReason: "network_error" as const,
                  errorMessage: errorText,
                  content: m.content || errorText,
                }
              : m
          )
        );

      const deadline = Date.now() + RECOVERY_WINDOW_MS;
      let attempt = 0;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, attempt < 8 ? 5000 : 15000));
        attempt++;
        if (generationSeqRef.current !== seq) {
          // The user moved on (new send, switch, reset) — close out the bubble
          // instead of leaving it promising an answer that will never arrive.
          stampTerminalError("Recovery stopped because a newer message took over. Reload if the original answer is missing.");
          return;
        }
        try {
          const res = await fetch(`/api/conversations/${convoId}`);
          if (!res.ok) continue;
          const payload = (await res.json()) as { messages?: ClientMessage[]; artifacts?: ClientArtifact[] };
          const msgs = payload.messages ?? [];
          const afterIdx = userMessageId ? msgs.findIndex((m) => m.id === userMessageId) : -1;
          const recovered = msgs.find(
            (m, i) =>
              m.role === "ASSISTANT" &&
              !knownIds.has(m.id) &&
              (afterIdx < 0 || i > afterIdx) &&
              // Media generations persist with empty content + an attachment.
              (m.content || m.reasoning || (m.attachments?.length ?? 0) > 0)
          );
          if (!recovered) continue;
          if (generationSeqRef.current !== seq) return;
          let replaced = false;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== assistantTempId) return m;
              replaced = true;
              return { ...recovered, streaming: false };
            })
          );
          if (replaced) {
            if (Array.isArray(payload.artifacts)) mergeArtifacts(payload.artifacts);
            // Fire the same completion side effects as a normal done chunk so
            // new-chat URL handoff, sidebar refresh, and auto-title still run.
            opts.onDone?.(recovered, { finishReason: recovered.finishReason ?? undefined });
            toast.success("Reconnected — Juno's answer came through.");
          }
          return;
        } catch {
          // transient poll failure — keep waiting
        }
      }
      if (generationSeqRef.current !== seq) return;
      stampTerminalError("The connection dropped and the response never finished. Use Continue or regenerate.");
    },
    [mergeArtifacts, opts]
  );

  const runGeneration = React.useCallback(
    async (body: Record<string, unknown>, assistantTempId: string, path = "/api/chat") => {
      const controller = new AbortController();
      const generationId = crypto.randomUUID();
      abortRef.current = controller;
      generationIdRef.current = generationId;
      assistantIdRef.current = assistantTempId;
      stopRequestedRef.current = false;
      setStatus("submitting");
      const seq = ++generationSeqRef.current;
      let sawTerminal = false;
      let metaUserMessageId: string | null = null;
      let metaArrived = false;

      // Mark the bubble as awaiting background recovery and start polling for
      // the answer the server is (very likely) still writing. No finishReason
      // yet — that would surface a "Continue" button on a bubble that is still
      // promising the original answer; terminal states set it later.
      const beginDropRecovery = () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? {
                  ...m,
                  streaming: false,
                  progress: null,
                  errorMessage: "Connection interrupted — Juno keeps working in the background. The answer will appear here when it's ready.",
                }
              : m
          )
        );
        toast.info("Connection dropped — Juno keeps working. Recovering the answer…");
        void recoverDroppedStream(assistantTempId, metaUserMessageId, seq);
      };

      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, generationId }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error ?? "Something went wrong.");
        }

        await readChatStream(res.body, (chunk) => {
          switch (chunk.type) {
            case "meta": {
              metaArrived = true;
              metaUserMessageId = chunk.userMessageId ?? null;
              const isNew = convoIdRef.current === null;
              if (!opts.privateMode) convoIdRef.current = chunk.conversationId;
              if (chunk.userMessageId) {
                setMessages((prev) =>
                  prev.map((m) => (m.pending && m.role === "USER" ? { ...m, id: chunk.userMessageId!, pending: false } : m))
                );
              } else if (opts.privateMode) {
                setMessages((prev) => prev.map((m) => (m.pending && m.role === "USER" ? { ...m, pending: false } : m)));
              }
              if (!opts.privateMode)
                opts.onMeta?.({
                  conversationId: chunk.conversationId,
                  title: chunk.title,
                  titleSource: chunk.titleSource ?? "default",
                  isNew,
                });
              break;
            }
            case "title": {
              // Auto-generated title arrived mid/post-stream — update the sidebar live.
              if (!opts.privateMode) opts.onTitle?.(chunk.conversationId, chunk.title, chunk.titleSource);
              break;
            }
            case "activity": {
              setStatus((cur) => (cur === "submitting" ? "thinking" : cur));
              if (chunk.event.kind === "reasoning") setStatus((cur) => (cur === "writing" ? cur : "thinking"));
              if (chunk.event.kind === "write") setStatus("writing");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? {
                        ...m,
                        activity: [...(m.activity ?? []).filter((event) => event.id !== chunk.event.id), chunk.event],
                      }
                    : m
                )
              );
              break;
            }
            case "sources": {
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantTempId ? { ...m, sources: chunk.sources } : m))
              );
              break;
            }
            case "reasoning": {
              setStatus((cur) => (cur === "writing" ? cur : "thinking"));
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantTempId ? { ...m, reasoning: (m.reasoning ?? "") + chunk.text } : m))
              );
              break;
            }
            case "delta": {
              setStatus("writing");
              setMessages((prev) =>
                prev.map((m) => (m.id === assistantTempId ? { ...m, content: m.content + chunk.text } : m))
              );
              break;
            }
            case "progress": {
              // Live /api/generate stage; modality was stamped when the generation started.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? { ...m, progress: { modality: m.progress?.modality ?? "image", stage: chunk.stage, pct: chunk.pct } }
                    : m
                )
              );
              break;
            }
            case "done": {
              sawTerminal = true;
              if (stopFallbackRef.current != null) {
                window.clearTimeout(stopFallbackRef.current);
                stopFallbackRef.current = null;
              }
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? { ...chunk.message, finishReason: chunk.finishReason ?? chunk.message.finishReason, streaming: false }
                    : m
                )
              );
              mergeArtifacts(chunk.artifacts);
              if (chunk.artifacts.length) opts.onArtifactsUpdated?.(chunk.artifacts, chunk.artifacts);
              opts.onQuota?.(chunk.quota);
              if (chunk.memoryUpdated) opts.onMemoryUpdated?.();
              opts.onDone?.(chunk.message, {
                finishReason: chunk.finishReason ?? chunk.message.finishReason,
                title: chunk.title,
                projectId: chunk.projectId,
                projectName: chunk.projectName,
              });
              break;
            }
            case "error": {
              sawTerminal = true;
              setStatus("error");
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantTempId
                    ? {
                        ...m,
                        streaming: false,
                        error: true,
                        progress: null,
                        finishReason: chunk.finishReason ?? "error",
                        ...(chunk.preservePartial && (m.content || m.reasoning)
                          ? { errorMessage: chunk.message }
                          : { content: chunk.message, errorMessage: chunk.message }),
                      }
                    : m
                )
              );
              if (chunk.quota) opts.onQuota?.(chunk.quota);
              toast.error(chunk.message);
              break;
            }
          }
        });

        // Stream ended without a done/error frame — the platform killed the
        // function or a proxy dropped the SSE mid-generation. Don't leave the
        // bubble spinning forever: recover the persisted answer if possible.
        if (!sawTerminal && !controller.signal.aborted) {
          if (metaArrived && !opts.privateMode && convoIdRef.current) {
            beginDropRecovery();
          } else {
            setStatus("error");
            const dropMessage = "The connection dropped before the response finished. Please try again.";
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantTempId
                  ? {
                      ...m,
                      streaming: false,
                      error: true,
                      progress: null,
                      finishReason: "network_error",
                      errorMessage: dropMessage,
                      content: m.content || dropMessage,
                    }
                  : m
              )
            );
            toast.error("The connection dropped before the response finished.");
          }
        }
      } catch (err) {
        if (controller.signal.aborted) {
          // Keep whatever streamed; just unmark streaming.
          const stopped = stopRequestedRef.current;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantTempId
                ? { ...m, streaming: false, progress: null, finishReason: stopped ? "user_stopped" : m.finishReason }
                : m
            )
          );
        } else if (metaArrived && !opts.privateMode && convoIdRef.current) {
          // The request died mid-stream but generation already started server-
          // side — it survives client disconnects, so recover instead of erroring.
          beginDropRecovery();
        } else {
          const message = err instanceof Error ? err.message : "Something went wrong.";
          setStatus("error");
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantTempId
                ? { ...m, streaming: false, error: true, progress: null, finishReason: "error", errorMessage: message, content: m.content || message }
                : m
            )
          );
          toast.error(message);
        }
      } finally {
        if (stopFallbackRef.current != null) {
          window.clearTimeout(stopFallbackRef.current);
          stopFallbackRef.current = null;
        }
        setStatus((cur) => (cur === "error" ? "error" : "idle"));
        abortRef.current = null;
        generationIdRef.current = null;
        assistantIdRef.current = null;
        stopRequestedRef.current = false;
      }
    },
    [mergeArtifacts, opts, recoverDroppedStream]
  );

  const startGeneration = React.useCallback(
    (input: {
      text: string;
      attachments?: ClientAttachment[];
      preflightClarification?: PreflightClarificationContext;
    }): SendResult => {
      const trimmed = input.text.trim();
      const attachments = input.attachments ?? [];
      // Image/video models run through the generation endpoint, not the chat stream.
      const modality = resolveModel(opts.model)?.modality ?? "chat";
      const userMsg: ChatMessage = {
        id: tempId(),
        role: "USER",
        content: trimmed,
        createdAt: new Date().toISOString(),
        attachments,
        pending: true,
      };
      const assistantTempId = tempId();
      const assistantMsg: ChatMessage = {
        id: assistantTempId,
        role: "ASSISTANT",
        content: "",
        createdAt: new Date().toISOString(),
        attachments: [],
        activity: [],
        streaming: true,
        // Media generations show their placeholder before the first SSE frame lands.
        progress: modality === "chat" || opts.privateMode ? null : { modality, stage: "queued" },
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      if (opts.privateMode && modality !== "chat") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantTempId
              ? { ...m, streaming: false, error: true, progress: null, content: "Private chat only supports text chat right now because generated media is stored." }
              : m.pending && m.role === "USER"
                ? { ...m, pending: false }
                : m
          )
        );
        toast.error("Private chat only supports text chat right now.");
        setStatus("idle");
        return { accepted: true };
      }
      if (modality !== "chat") {
        void runGeneration(
          { conversationId: convoIdRef.current ?? undefined, prompt: trimmed, model: opts.model },
          assistantTempId,
          "/api/generate"
        );
        return { accepted: true };
      }

      void runGeneration(
        {
          conversationId: opts.privateMode ? undefined : convoIdRef.current ?? undefined,
          // Only relevant when creating a brand-new conversation inside a project.
          projectId: opts.privateMode || convoIdRef.current ? undefined : opts.projectId,
          message: trimmed,
          attachmentIds: attachments.map((a) => a.id),
          model: opts.model,
          voiceMode: opts.voiceMode,
          canvasEnabled: opts.privateMode ? false : opts.canvasEnabled,
          webSearch: opts.webSearch,
          reasoningEffort: opts.reasoningEffort,
          connectors: opts.connectors,
          preflightClarification: input.preflightClarification,
          privateMode: opts.privateMode,
          privateHistory: opts.privateMode
            ? [...messages, userMsg]
                .filter((m) => !m.error && (m.role === "USER" || m.role === "ASSISTANT"))
                .map((m) => ({ role: m.role, content: m.content }))
            : undefined,
        },
        assistantTempId
      );
      return { accepted: true };
    },
    [
      runGeneration,
      opts.model,
      opts.voiceMode,
      opts.canvasEnabled,
      opts.webSearch,
      opts.reasoningEffort,
      opts.connectors,
      opts.projectId,
      opts.privateMode,
      messages,
    ]
  );

  const send = React.useCallback(
    async (text: string, attachments: ClientAttachment[] = []): Promise<SendResult> => {
      if ((status !== "idle" && status !== "error") || pendingClarification) return { accepted: false };
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return { accepted: false };

      const modality = resolveModel(opts.model)?.modality ?? "chat";
      if (modality !== "chat" || !trimmed) {
        return startGeneration({ text: trimmed, attachments });
      }

      setStatus("checking");
      // The preflight clarification check must never block sending: if it hangs
      // or errors, we time out and fall through to actually answering. Without
      // this abort the composer could sit in "Checking…" forever on a stalled
      // request (e.g. a slow/unreachable server), locking the user out of chat.
      const clarifyController = new AbortController();
      const clarifyTimeout = setTimeout(() => clarifyController.abort(), 6000);
      try {
        const res = await fetch("/api/chat/clarify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversationId: opts.privateMode ? null : convoIdRef.current,
            message: trimmed,
            hasAttachments: attachments.length > 0,
            privateMode: opts.privateMode,
          }),
          signal: clarifyController.signal,
        });
        const data = await res.json().catch(() => null);
        if (res.ok && isPreflightClarificationResult(data) && data.needsClarification) {
          setPendingClarification({
            id: crypto.randomUUID(),
            originalUserMessage: trimmed,
            attachments,
            result: data,
          });
          setStatus("idle");
          return { accepted: false, clarificationPending: true };
        }
      } catch {
        // If the preflight check fails or times out, keep the product moving and answer.
      } finally {
        clearTimeout(clarifyTimeout);
      }

      return startGeneration({ text: trimmed, attachments });
    },
    [opts.model, opts.privateMode, pendingClarification, startGeneration, status]
  );

  // Region-based image edit — same /api/generate transport (quota, meta, progress,
  // done/error handling all come from runGeneration). The edit prompt becomes the
  // new user message; the result arrives like any other generation.
  const sendImageEdit = React.useCallback(
    (input: ImageEditInput): SendResult => {
      if ((status !== "idle" && status !== "error") || pendingClarification) return { accepted: false };
      const trimmed = input.prompt.trim();
      if (!trimmed) return { accepted: false };
      if (opts.privateMode) {
        toast.error("Image editing isn't available in private chat.");
        return { accepted: false };
      }
      const userMsg: ChatMessage = {
        id: tempId(),
        role: "USER",
        content: trimmed,
        createdAt: new Date().toISOString(),
        attachments: [],
        pending: true,
      };
      const assistantTempId = tempId();
      const assistantMsg: ChatMessage = {
        id: assistantTempId,
        role: "ASSISTANT",
        content: "",
        createdAt: new Date().toISOString(),
        attachments: [],
        activity: [],
        streaming: true,
        progress: { modality: "image", stage: "queued" },
      };
      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      void runGeneration(
        { conversationId: convoIdRef.current ?? undefined, prompt: trimmed, model: input.model, edit: input.edit },
        assistantTempId,
        "/api/generate"
      );
      return { accepted: true };
    },
    [status, pendingClarification, runGeneration, opts.privateMode]
  );

  const resolvePendingClarification = React.useCallback(
    async (answers: PreflightClarificationAnswer[], skipped = false): Promise<SendResult> => {
      if ((status !== "idle" && status !== "error") || !pendingClarification) return { accepted: false };
      const pending = pendingClarification;
      setPendingClarification(null);
      const context: PreflightClarificationContext = {
        originalUserMessage: pending.originalUserMessage,
        answers: skipped
          ? [
              {
                questionId: "skipped",
                question: "Pre-answer clarification",
                source: "skip",
                value: "Skipped clarification",
              },
            ]
          : answers,
        skipped,
      };
      return startGeneration({
        text: pending.originalUserMessage,
        attachments: pending.attachments,
        preflightClarification: context,
      });
    },
    [pendingClarification, startGeneration, status]
  );

  const cancelPendingClarification = React.useCallback(() => {
    setPendingClarification(null);
    setStatus("idle");
  }, []);

  const regenerate = React.useCallback(async () => {
    if (status !== "idle" && status !== "error") return;
    if (!convoIdRef.current) return;
    // Drop the trailing assistant message locally and add a fresh placeholder.
    // Remember the dropped ids: the server keeps the stale row until the new
    // answer succeeds, so drop recovery must not mistake it for a fresh answer.
    const assistantTempId = tempId();
    setMessages((prev) => {
      const copy = [...prev];
      while (copy.length && copy[copy.length - 1].role === "ASSISTANT") {
        locallyRemovedIdsRef.current.add(copy[copy.length - 1].id);
        copy.pop();
      }
      return [
        ...copy,
        { id: assistantTempId, role: "ASSISTANT", content: "", createdAt: new Date().toISOString(), attachments: [], activity: [], streaming: true },
      ];
    });
    await runGeneration(
      {
        conversationId: convoIdRef.current,
        regenerate: true,
        model: opts.model,
        voiceMode: opts.voiceMode,
        canvasEnabled: opts.canvasEnabled,
        reasoningEffort: opts.reasoningEffort,
        connectors: opts.connectors,
      },
      assistantTempId
    );
  }, [status, runGeneration, opts.model, opts.voiceMode, opts.canvasEnabled, opts.reasoningEffort, opts.connectors]);

  const editAndResend = React.useCallback(
    async (messageId: string, newContent: string) => {
      if (status !== "idle" && status !== "error") return;
      const res = await fetch(`/api/messages/${messageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: newContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Could not edit the message.");
        return;
      }
      // Truncate locally to the edited message, update its content.
      const assistantTempId = tempId();
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        const kept = prev.slice(0, idx + 1).map((m) => (m.id === messageId ? { ...m, content: newContent } : m));
        return [
          ...kept,
          { id: assistantTempId, role: "ASSISTANT", content: "", createdAt: new Date().toISOString(), attachments: [], activity: [], streaming: true },
        ];
      });
      await runGeneration(
        {
          conversationId: convoIdRef.current ?? undefined,
          regenerate: true,
          model: opts.model,
          canvasEnabled: opts.canvasEnabled,
          reasoningEffort: opts.reasoningEffort,
          connectors: opts.connectors,
        },
        assistantTempId
      );
    },
    [status, runGeneration, opts.model, opts.canvasEnabled, opts.reasoningEffort, opts.connectors]
  );

  const stop = React.useCallback(() => {
    if (!abortRef.current) return;
    stopRequestedRef.current = true;
    setStatus("stopping");

    const generationId = generationIdRef.current;
    const controller = abortRef.current;
    const assistantId = assistantIdRef.current;

    if (generationId) {
      fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ generationId }),
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (!data?.cancelled && !controller.signal.aborted) controller.abort();
        })
        .catch(() => {
          if (!controller.signal.aborted) controller.abort();
        });
    } else {
      controller.abort();
    }

    if (stopFallbackRef.current != null) window.clearTimeout(stopFallbackRef.current);
    stopFallbackRef.current = window.setTimeout(() => {
      if (!controller.signal.aborted) controller.abort();
      if (assistantId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, streaming: false, finishReason: "user_stopped" } : m))
        );
      }
      setStatus("idle");
    }, 5000);
  }, []);

  // Reset to a fresh "new chat" without remounting (used after the shallow-URL flow).
  const reset = React.useCallback(() => {
    abortRef.current?.abort();
    generationSeqRef.current++; // cancel any in-flight drop recovery
    locallyRemovedIdsRef.current = new Set();
    if (stopFallbackRef.current != null) {
      window.clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
    }
    convoIdRef.current = null;
    generationIdRef.current = null;
    assistantIdRef.current = null;
    stopRequestedRef.current = false;
    setMessages([]);
    setArtifacts([]);
    setStatus("idle");
    setPendingClarification(null);
  }, []);

  const setFeedback = React.useCallback((messageId: string, feedback: "UP" | "DOWN" | null) => {
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback } : m)));
    fetch(`/api/messages/${messageId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    }).catch(() => {});
  }, []);

  const continueResponse = React.useCallback(() => {
    return send("Continue from where you left off.");
  }, [send]);

  return {
    messages,
    artifacts,
    status,
    pendingClarification,
    isBusy: status === "checking" || status === "submitting" || status === "thinking" || status === "writing" || status === "stopping",
    send,
    sendImageEdit,
    resolvePendingClarification,
    cancelPendingClarification,
    continueResponse,
    regenerate,
    editAndResend,
    stop,
    reset,
    setFeedback,
    setArtifacts,
    setMessages,
  };
}
